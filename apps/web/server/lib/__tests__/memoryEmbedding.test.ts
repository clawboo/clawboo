// The shared embedding cache: re-probing, provider retirement, local-first
// stickiness, the backfill it kicks, the status line, the server timer, and the
// model install. `fetch` is stubbed throughout, so nothing here depends on an
// Ollama or an OpenAI key on the machine running the suite.

import { chmodSync, existsSync } from 'node:fs'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import {
  DeterministicEmbeddingProvider,
  OLLAMA_DEFAULT_MODEL,
  REEMBED_REQUEST_SETTING,
  LOCAL_FIRST_SETTING,
  SqliteMemoryStore,
  getSetting,
} from '@clawboo/db'
import type { Request, Response } from 'express'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  memoryEmbeddingInstallPOST,
  memoryEmbeddingReindexPOST,
  memoryGraphGET,
  memoryProviderGET,
} from '../../api/memory'
import { getDb, resetDb } from '../db'
import {
  EmbeddingProviderRetiredError,
  PullInProgressError,
  REMOTE_CONSENT_SETTING,
  __backfillIdleForTests,
  __resetEmbeddingForTests,
  __tickForTests,
  getEmbedProvider,
  getEmbeddingResolution,
  getEmbeddingStatus,
  invalidateEmbedProvider,
  kickEmbeddingBackfill,
  onEmbeddingKeysChanged,
  pullEmbeddingModel,
  reindexEmbeddings,
} from '../memoryEmbedding'
import { deleteRuntimeSecret, setRuntimeSecret } from '../secretsVault'

// ─── A fake local Ollama + OpenAI behind a stubbed fetch ─────────────────────

const MODEL_TAG = `${OLLAMA_DEFAULT_MODEL}:latest`
const OLLAMA_ID = `ollama:${OLLAMA_DEFAULT_MODEL}`
const OPENAI_ID = 'openai:text-embedding-3-small'

interface FakeNet {
  models: string[] | 'down'
  embedFails: boolean
  /** Held while set: lets a test change the world mid-probe. */
  tagsGate: Promise<void> | null
  /** Called inside an Ollama embed, before it answers. */
  onOllamaEmbed: (() => void | Promise<void>) | null
  /** Called inside an OpenAI embed, before it answers. */
  onOpenaiEmbed: (() => void | Promise<void>) | null
  pullFrames: string[]
  /** Overrides pullFrames with a hand-built stream. */
  pullStream: ((signal: AbortSignal | undefined) => ReadableStream<Uint8Array>) | null
  calls: { tags: number; embed: number; pull: number; openai: number }
  /** Which bearer token each OpenAI call carried. */
  openaiKeys: string[]
  pullSignal: AbortSignal | undefined
}

const det = new DeterministicEmbeddingProvider()

function installFakeNet(): FakeNet {
  const net: FakeNet = {
    models: [],
    embedFails: false,
    tagsGate: null,
    onOllamaEmbed: null,
    onOpenaiEmbed: null,
    pullFrames: [],
    pullStream: null,
    calls: { tags: 0, embed: 0, pull: 0, openai: 0 },
    openaiKeys: [],
    pullSignal: undefined,
  }
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string | URL, init?: RequestInit) => {
      const url = String(input)
      if (url.endsWith('/api/tags')) {
        net.calls.tags += 1
        // Answer with the world as it was when the request arrived, like a
        // real server that read its model list before a slow reply.
        const models = net.models
        if (net.tagsGate) await net.tagsGate
        if (models === 'down') throw new TypeError('fetch failed')
        return Response.json({ models: models.map((name) => ({ name })) })
      }
      if (url.endsWith('/api/embed')) {
        net.calls.embed += 1
        if (net.onOllamaEmbed) await net.onOllamaEmbed()
        if (net.embedFails) return new Response('model not found', { status: 404 })
        const { input: texts } = JSON.parse(String(init?.body)) as { input: string[] }
        return Response.json({ embeddings: await det.embed(texts) })
      }
      if (url.endsWith('/api/pull')) {
        net.calls.pull += 1
        net.pullSignal = init?.signal ?? undefined
        if (net.pullStream) return new Response(net.pullStream(init?.signal ?? undefined))
        return new Response(net.pullFrames.join('\n') + '\n')
      }
      if (url.includes('api.openai.com')) {
        net.calls.openai += 1
        const auth = new Headers(init?.headers).get('authorization') ?? ''
        net.openaiKeys.push(auth.replace(/^Bearer /, ''))
        if (net.onOpenaiEmbed) await net.onOpenaiEmbed()
        if (auth === 'Bearer sk-revoked') return new Response('invalid key', { status: 401 })
        const { input: texts } = JSON.parse(String(init?.body)) as { input: string[] }
        // Like the real API: one unacceptable input sinks the whole request.
        if (texts.some((t) => t.includes('POISON'))) return new Response('bad', { status: 400 })
        const vecs = await det.embed(texts)
        return Response.json({ data: vecs.map((embedding) => ({ embedding })) })
      }
      throw new Error(`unexpected fetch ${url}`)
    }),
  )
  return net
}

// ─── Sandbox ─────────────────────────────────────────────────────────────────

const ENV = ['CLAWBOO_HOME', 'OPENCLAW_STATE_DIR', 'OPENAI_API_KEY', 'CLAWBOO_DISABLE_EMBEDDINGS']
let home: string
let saved: Record<string, string | undefined>
let net: FakeNet

beforeEach(async () => {
  saved = Object.fromEntries(ENV.map((k) => [k, process.env[k]]))
  home = await mkdtemp(path.join(os.tmpdir(), 'clawboo-embed-'))
  process.env['CLAWBOO_HOME'] = path.join(home, 'clawboo')
  process.env['OPENCLAW_STATE_DIR'] = path.join(home, 'openclaw')
  await mkdir(process.env['OPENCLAW_STATE_DIR'], { recursive: true })
  delete process.env['OPENAI_API_KEY']
  delete process.env['CLAWBOO_DISABLE_EMBEDDINGS']
  __resetEmbeddingForTests()
  net = installFakeNet()
})

afterEach(async () => {
  await __backfillIdleForTests()
  vi.useRealTimers()
  vi.unstubAllGlobals()
  __resetEmbeddingForTests()
  resetDb()
  for (const k of ENV) {
    if (saved[k] === undefined) delete process.env[k]
    else process.env[k] = saved[k]
  }
  await rm(home, { recursive: true, force: true }).catch(() => {})
})

async function seedUnindexed(n: number, prefix = 'f'): Promise<string[]> {
  const bare = new SqliteMemoryStore(getDb())
  const ids: string[] = []
  for (let i = 0; i < n; i++) {
    ids.push((await bare.saveFact({ title: `${prefix}${i}`, content: `deploy note ${i}` })).id)
  }
  return ids
}

/** Save facts as if an earlier provider with this id had indexed them. */
async function seedIndexedBy(id: string, n: number): Promise<string[]> {
  const store = new SqliteMemoryStore(getDb(), {
    id,
    dimensions: 64,
    embed: (t) => det.embed(t),
  })
  const ids: string[] = []
  for (let i = 0; i < n; i++) {
    ids.push((await store.saveFact({ title: `old${i}`, content: `older note ${i}` })).id)
  }
  return ids
}

function modelOf(id: string): string | null {
  const row = getDb()
    .$client.prepare('SELECT embedding_model AS m FROM memory_facts WHERE id = ?')
    .get(id) as { m: string | null }
  return row.m
}

function unindexedCount(): number {
  const row = getDb()
    .$client.prepare('SELECT COUNT(*) AS n FROM memory_facts WHERE embedding IS NULL')
    .get() as { n: number }
  return row.n
}

// ─── Resolution ──────────────────────────────────────────────────────────────

describe('getEmbeddingResolution', () => {
  it('notices the model being installed without a restart', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(0)
    net.models = []
    expect((await getEmbeddingResolution()).state).toBe('ollama-model-missing')

    net.models = [MODEL_TAG]
    vi.setSystemTime(10_000) // inside the unusable TTL: still the cached answer
    expect((await getEmbeddingResolution()).state).toBe('ollama-model-missing')
    vi.setSystemTime(30_000) // measured from when the probe STARTED
    expect((await getEmbeddingResolution()).state).toBe('ready')
  })

  it('caches a ready provider and re-checks it after ten minutes', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(0)
    net.models = [MODEL_TAG]
    await getEmbedProvider()
    vi.setSystemTime(9 * 60_000)
    await getEmbedProvider()
    expect(net.calls.tags).toBe(1)
    vi.setSystemTime(10 * 60_000)
    await getEmbedProvider()
    expect(net.calls.tags).toBe(2)
  })

  it('keeps handing out the same instance when a re-probe finds the same provider', async () => {
    net.models = [MODEL_TAG]
    const first = await getEmbedProvider()
    invalidateEmbedProvider()
    expect(await getEmbedProvider()).toBe(first)
  })

  it('shares one probe between concurrent callers', async () => {
    net.models = [MODEL_TAG]
    await Promise.all(Array.from({ length: 5 }, () => getEmbeddingResolution()))
    expect(net.calls.tags).toBe(1)
  })

  it('re-probes as soon as an embed call fails, rather than trusting the cache', async () => {
    net.models = [MODEL_TAG]
    const provider = await getEmbedProvider()
    net.models = [] // the model was removed, so the next call 404s
    net.embedFails = true
    await expect(provider!.embed(['x'])).rejects.toThrow(/404/)
    await vi.waitFor(() => expect(net.calls.tags).toBe(2))
    expect((await getEmbeddingResolution()).state).toBe('ollama-model-missing')
    expect(net.calls.tags).toBe(2)
  })

  it('an invalidation while a probe is in flight wins over the older answer', async () => {
    net.models = []
    let release!: () => void
    net.tagsGate = new Promise((r) => (release = r))
    const stale = getEmbeddingResolution() // probing, will see no model
    await vi.waitFor(() => expect(net.calls.tags).toBe(1))
    net.models = [MODEL_TAG] // the install lands mid-probe
    invalidateEmbedProvider()
    net.tagsGate = null
    const fresh = getEmbeddingResolution()
    release()
    expect((await fresh).state).toBe('ready')
    // Even the caller that started first gets the post-invalidation answer.
    expect((await stale).state).toBe('ready')
  })

  it('uses an OpenAI key the user connected in clawboo, not only a shell export', async () => {
    net.models = 'down'
    setRuntimeSecret('OPENAI_API_KEY', 'sk-vault')
    expect((await getEmbedProvider())?.id).toBe(OPENAI_ID)
  })

  it('turned off, it reads neither the key vault nor the store', async () => {
    process.env['CLAWBOO_DISABLE_EMBEDDINGS'] = '1'
    expect(await getEmbeddingResolution()).toEqual({ state: 'disabled', provider: null })
    expect(existsSync(path.join(process.env['CLAWBOO_HOME']!, 'clawboo.db'))).toBe(false)
  })

  it('an Ollama restart does not break anything holding the local provider', async () => {
    net.models = [MODEL_TAG]
    const held = await getEmbedProvider() // e.g. a native run's memory server
    net.models = 'down'
    invalidateEmbedProvider()
    expect((await getEmbeddingResolution()).provider).toBeNull()

    net.models = [MODEL_TAG]
    invalidateEmbedProvider()
    expect(await getEmbedProvider()).toBe(held)
    await expect(held!.embed(['after the restart'])).resolves.toHaveLength(1)
  })

  it("does not borrow OpenClaw's key: that key was given to OpenClaw", async () => {
    net.models = 'down'
    await writeFile(
      path.join(process.env['OPENCLAW_STATE_DIR']!, '.env'),
      'OPENAI_API_KEY=sk-openclaw\n',
    )
    expect(await getEmbeddingResolution()).toEqual({ state: 'none', provider: null })
  })
})

// ─── Keys changing under a running server ────────────────────────────────────

describe('key changes', () => {
  it('a disconnected key stops being used, even by a session that captured it', async () => {
    net.models = 'down'
    setRuntimeSecret('OPENAI_API_KEY', 'sk-a')
    const captured = await getEmbedProvider() // e.g. an open MCP session's provider
    await captured!.embed(['before'])
    expect(net.calls.openai).toBe(1)

    deleteRuntimeSecret('OPENAI_API_KEY')
    onEmbeddingKeysChanged()
    await getEmbeddingResolution()

    await expect(captured!.embed(['after'])).rejects.toBeInstanceOf(EmbeddingProviderRetiredError)
    expect(net.calls.openai).toBe(1) // the call never left the machine
  })

  it('a replaced key replaces the provider instead of reusing the old one', async () => {
    net.models = 'down'
    setRuntimeSecret('OPENAI_API_KEY', 'sk-a')
    const first = await getEmbedProvider()
    setRuntimeSecret('OPENAI_API_KEY', 'sk-b')
    onEmbeddingKeysChanged()
    const second = await getEmbedProvider()
    expect(second).not.toBe(first)
    await second!.embed(['x'])
    expect(net.openaiKeys.at(-1)).toBe('sk-b')
  })
})

// ─── Local first ─────────────────────────────────────────────────────────────

describe('local-first', () => {
  it('an Ollama outage never moves a locally indexed store to OpenAI', async () => {
    await seedIndexedBy(OLLAMA_ID, 5)
    setRuntimeSecret('OPENAI_API_KEY', 'sk-vault')
    net.models = 'down'

    const res = await getEmbeddingResolution()
    await __backfillIdleForTests()

    expect(res).toMatchObject({ state: 'ollama-unreachable', provider: null })
    expect(net.calls.openai).toBe(0)
    const status = await getEmbeddingStatus()
    expect(status.remoteAvailable).toBe(true) // so the UI can offer the choice
  })

  it("moving to OpenAI is the user's explicit choice, and then converges the store", async () => {
    const old = await seedIndexedBy(OLLAMA_ID, 3)
    setRuntimeSecret('OPENAI_API_KEY', 'sk-vault')
    net.models = 'down'
    expect((await getEmbeddingResolution()).state).toBe('ollama-unreachable')

    await reindexEmbeddings({ allowRemote: true, reembedAll: true })
    await __backfillIdleForTests()

    expect((await getEmbeddingResolution()).provider?.id).toBe(OPENAI_ID)
    expect(old.map(modelOf)).toEqual([OPENAI_ID, OPENAI_ID, OPENAI_ID])
  })

  it('a remote provider indexes only facts with no vector, never re-uploads indexed ones', async () => {
    const earlier = await seedIndexedBy('deterministic', 2) // another model's vectors
    const fresh = await seedUnindexed(2)
    net.models = 'down'
    setRuntimeSecret('OPENAI_API_KEY', 'sk-vault')

    await getEmbeddingResolution()
    await __backfillIdleForTests()

    expect(fresh.map(modelOf)).toEqual([OPENAI_ID, OPENAI_ID])
    expect(earlier.map(modelOf)).toEqual(['deterministic', 'deterministic'])
    expect((await getEmbeddingStatus()).pending).toBe(0)
  })

  it('a local provider converges the whole store, taking data home from OpenAI', async () => {
    net.models = 'down'
    process.env['OPENAI_API_KEY'] = 'sk-env'
    await getEmbeddingResolution()
    const ids = await seedIndexedBy(OPENAI_ID, 2)

    net.models = [MODEL_TAG] // the model is installed
    invalidateEmbedProvider()
    await getEmbeddingResolution()
    await __backfillIdleForTests()

    expect(ids.map(modelOf)).toEqual([OLLAMA_ID, OLLAMA_ID])
  })

  it('choosing OpenAI answers one outage: once Ollama is back, the next outage asks again', async () => {
    await seedIndexedBy(OLLAMA_ID, 2)
    setRuntimeSecret('OPENAI_API_KEY', 'sk-vault')
    net.models = 'down'
    await getEmbeddingResolution()
    await reindexEmbeddings({ allowRemote: true })
    await __backfillIdleForTests()
    expect((await getEmbeddingResolution()).provider?.id).toBe(OPENAI_ID)

    net.models = [MODEL_TAG] // Ollama is back
    invalidateEmbedProvider()
    expect((await getEmbeddingResolution()).provider?.id).toBe(OLLAMA_ID)
    await __backfillIdleForTests()
    expect(getSetting(getDb(), REMOTE_CONSENT_SETTING)).not.toBe('1')

    const openaiCalls = net.calls.openai
    net.models = 'down' // a later outage
    invalidateEmbedProvider()
    expect((await getEmbeddingResolution()).state).toBe('ollama-unreachable')
    expect((await getEmbeddingStatus()).remoteAvailable).toBe(true)
    expect(net.calls.openai).toBe(openaiCalls)
  })

  it('a choice of OpenAI made after Ollama is already back is withdrawn at once', async () => {
    await seedIndexedBy(OLLAMA_ID, 2)
    setRuntimeSecret('OPENAI_API_KEY', 'sk-vault')
    net.models = [MODEL_TAG] // the server has already seen Ollama return
    await getEmbeddingResolution()
    // A click on a note one poll behind the server.
    await reindexEmbeddings({ allowRemote: true, reembedAll: true })
    await __backfillIdleForTests()
    expect(getSetting(getDb(), REMOTE_CONSENT_SETTING)).not.toBe('1')

    net.models = 'down' // the next outage
    invalidateEmbedProvider()
    expect((await getEmbeddingResolution()).state).toBe('ollama-unreachable')
  })

  it('notices Ollama within a tick while OpenAI stands in, and the choice lapses', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(0)
    await seedIndexedBy(OLLAMA_ID, 2)
    setRuntimeSecret('OPENAI_API_KEY', 'sk-vault')
    net.models = 'down'
    await getEmbeddingResolution()
    await reindexEmbeddings({ allowRemote: true })
    await __backfillIdleForTests()
    expect((await getEmbeddingResolution()).provider?.id).toBe(OPENAI_ID)

    net.models = [MODEL_TAG] // Ollama is started again
    vi.setSystemTime(31_000) // one timer tick, not ten minutes
    await __tickForTests(false)
    expect((await getEmbeddingResolution()).provider?.id).toBe(OLLAMA_ID)
    expect(getSetting(getDb(), REMOTE_CONSENT_SETTING)).not.toBe('1')
  })

  it('once the store was indexed locally, a full switch to OpenAI does not make it cloud-first', async () => {
    const ids = await seedIndexedBy(OLLAMA_ID, 2)
    setRuntimeSecret('OPENAI_API_KEY', 'sk-vault')
    net.models = 'down'
    await getEmbeddingResolution()
    await reindexEmbeddings({ allowRemote: true, reembedAll: true })
    await __backfillIdleForTests()
    expect(ids.map(modelOf)).toEqual([OPENAI_ID, OPENAI_ID])

    // Ollama returns but cannot embed yet, so no local vector is written.
    net.models = [MODEL_TAG]
    net.embedFails = true
    invalidateEmbedProvider()
    await getEmbeddingResolution()
    await __backfillIdleForTests()
    net.embedFails = false

    net.models = 'down'
    invalidateEmbedProvider()
    expect((await getEmbeddingResolution()).state).toBe('ollama-unreachable')
  })

  it('a store indexed before the local-first flag existed stays local-first through a switch', async () => {
    const ids = await seedIndexedBy(OLLAMA_ID, 2)
    // As an existing store looks: local vectors, and no flag yet.
    getDb().$client.prepare('DELETE FROM settings WHERE key = ?').run(LOCAL_FIRST_SETTING)
    setRuntimeSecret('OPENAI_API_KEY', 'sk-vault')
    net.models = 'down'
    await getEmbeddingResolution()
    await reindexEmbeddings({ allowRemote: true, reembedAll: true })
    await __backfillIdleForTests()
    expect(ids.map(modelOf)).toEqual([OPENAI_ID, OPENAI_ID])

    net.models = [MODEL_TAG] // back, but cannot embed yet: no local vector lands
    net.embedFails = true
    invalidateEmbedProvider()
    await getEmbeddingResolution()
    await __backfillIdleForTests()
    net.embedFails = false
    net.models = 'down'
    invalidateEmbedProvider()
    expect((await getEmbeddingResolution()).state).toBe('ollama-unreachable')
  })

  it('disconnecting the key ends the choice and any unfinished switch', async () => {
    const local = await seedIndexedBy(OLLAMA_ID, 70)
    setRuntimeSecret('OPENAI_API_KEY', 'sk-first')
    net.models = 'down'
    await getEmbeddingResolution()
    let calls = 0
    net.onOpenaiEmbed = () => {
      calls += 1
      if (calls === 2) throw new TypeError('fetch failed')
    }
    await reindexEmbeddings({ allowRemote: true, reembedAll: true })
    await __backfillIdleForTests()
    net.onOpenaiEmbed = null

    deleteRuntimeSecret('OPENAI_API_KEY')
    onEmbeddingKeysChanged()
    // Local-first again, and said so: not "no provider".
    expect((await getEmbeddingResolution()).state).toBe('ollama-unreachable')
    expect(getSetting(getDb(), REEMBED_REQUEST_SETTING)).toBe('')

    __resetEmbeddingForTests() // a restart
    const stillLocal = local.filter((id) => modelOf(id) === OLLAMA_ID)
    setRuntimeSecret('OPENAI_API_KEY', 'sk-another-account')
    onEmbeddingKeysChanged()
    expect((await getEmbeddingResolution()).state).toBe('ollama-unreachable')
    await __backfillIdleForTests()
    expect(stillLocal.map(modelOf).every((m) => m === OLLAMA_ID)).toBe(true)
  })

  it('a vault that fails to read once does not count as the key being removed', async () => {
    await seedIndexedBy(OLLAMA_ID, 2)
    setRuntimeSecret('OPENAI_API_KEY', 'sk-vault')
    net.models = 'down'
    await getEmbeddingResolution()
    await reindexEmbeddings({ allowRemote: true })
    await __backfillIdleForTests()
    expect(getSetting(getDb(), REMOTE_CONSENT_SETTING)).toBe('1')

    const vault = path.join(process.env['CLAWBOO_HOME']!, 'secrets', 'runtime-keys.json')
    chmodSync(vault, 0o000) // unreadable for one resolution
    invalidateEmbedProvider()
    await getEmbeddingResolution()
    chmodSync(vault, 0o600)
    expect(getSetting(getDb(), REMOTE_CONSENT_SETTING)).toBe('1')
    invalidateEmbedProvider()
    expect((await getEmbeddingResolution()).provider?.id).toBe(OPENAI_ID)
  })

  it('disconnecting the key ends the choice even when the environment has one too', async () => {
    await seedIndexedBy(OLLAMA_ID, 2)
    process.env['OPENAI_API_KEY'] = 'sk-env'
    setRuntimeSecret('OPENAI_API_KEY', 'sk-vault')
    net.models = 'down'
    await getEmbeddingResolution()
    await reindexEmbeddings({ allowRemote: true })
    await __backfillIdleForTests()
    expect((await getEmbeddingResolution()).provider?.id).toBe(OPENAI_ID)

    deleteRuntimeSecret('OPENAI_API_KEY')
    onEmbeddingKeysChanged({ removed: ['OPENAI_API_KEY'] })
    const res = await getEmbeddingResolution()
    expect(res.state).toBe('ollama-unreachable')
    expect(getSetting(getDb(), REMOTE_CONSENT_SETTING)).toBe('0')
    // The environment's key is still there, so the choice is offered again.
    expect((await getEmbeddingStatus()).remoteAvailable).toBe(true)
  })

  it('counts vectors committed before a later write failed', async () => {
    await seedUnindexed(40)
    // The last fact in the pass's order is in the second batch; its write fails.
    const last = getDb()
      .$client.prepare(
        'SELECT id FROM memory_facts ORDER BY created_at DESC, id ASC LIMIT 1 OFFSET 39',
      )
      .get() as { id: string }
    getDb()
      .$client.prepare(
        `CREATE TEMP TRIGGER bad_row BEFORE UPDATE OF embedding ON memory_facts
         WHEN new.id = '${last.id}' BEGIN SELECT RAISE(ABORT, 'database disk image is malformed'); END`,
      )
      .run()
    net.models = [MODEL_TAG]
    await getEmbeddingResolution()
    await __backfillIdleForTests()
    const status = await getEmbeddingStatus()
    expect(status.vectorsWritten).toBe(32)
    expect(status.lastError).toMatch(/malformed/)
  })

  it('the switch request counts the whole switch from the first answer', async () => {
    await seedIndexedBy(OLLAMA_ID, 40)
    await seedUnindexed(2)
    setRuntimeSecret('OPENAI_API_KEY', 'sk-vault')
    net.models = 'down'
    await getEmbeddingResolution()
    let release!: () => void
    const held = new Promise<void>((r) => (release = r))
    net.onOpenaiEmbed = () => held
    const { res, state } = mockRes()
    await memoryEmbeddingReindexPOST(
      { body: { allowRemote: true, reembedAll: true } } as Request,
      res,
    )
    expect((state.json as { status: { pending: number } }).status.pending).toBe(42)
    net.onOpenaiEmbed = null
    release()
  })

  it('a switch to OpenAI that found no provider does not re-upload the store later', async () => {
    const local = await seedIndexedBy(OLLAMA_ID, 3)
    net.models = 'down'
    await reindexEmbeddings({ allowRemote: true, reembedAll: true }) // no key yet
    await __backfillIdleForTests()

    setRuntimeSecret('OPENAI_API_KEY', 'sk-vault')
    onEmbeddingKeysChanged()
    await getEmbeddingResolution()
    await __backfillIdleForTests()
    expect(local.map(modelOf)).toEqual([OLLAMA_ID, OLLAMA_ID, OLLAMA_ID])
  })

  it('while re-embedding everything, the status counts what is being sent', async () => {
    await seedIndexedBy(OLLAMA_ID, 40)
    await seedUnindexed(2)
    setRuntimeSecret('OPENAI_API_KEY', 'sk-vault')
    net.models = 'down'
    await getEmbeddingResolution()
    expect((await getEmbeddingStatus()).factCount).toBe(42)

    const seen: number[] = []
    net.onOpenaiEmbed = async () => {
      seen.push((await getEmbeddingStatus()).pending ?? -1)
    }
    await reindexEmbeddings({ allowRemote: true, reembedAll: true })
    await __backfillIdleForTests()
    net.onOpenaiEmbed = null
    expect(Math.max(...seen)).toBeGreaterThanOrEqual(40)
    expect((await getEmbeddingStatus()).pending).toBe(0)
  })

  it('offers the local install while a remote provider serves', async () => {
    net.models = [] // Ollama is up, without the model
    setRuntimeSecret('OPENAI_API_KEY', 'sk-vault')
    expect(await getEmbeddingStatus()).toMatchObject({
      state: 'ready',
      remote: true,
      missingModel: OLLAMA_DEFAULT_MODEL,
    })
  })
})

// ─── Backfill ────────────────────────────────────────────────────────────────

describe('backfill', () => {
  it('indexes the store when a usable provider first appears', async () => {
    await seedUnindexed(3)
    net.models = [MODEL_TAG]
    await getEmbeddingResolution()
    await __backfillIdleForTests()
    expect(unindexedCount()).toBe(0)
  })

  it('does nothing while no provider can serve', async () => {
    await seedUnindexed(2)
    net.models = []
    await getEmbeddingResolution()
    kickEmbeddingBackfill('test')
    await __backfillIdleForTests()
    expect(unindexedCount()).toBe(2)
    expect(net.calls.embed).toBe(0)
  })

  it('a kick during a pass is not lost: a fact saved mid-pass is indexed too', async () => {
    await seedUnindexed(2)
    net.models = [MODEL_TAG]
    let lateId: string | null = null
    net.onOllamaEmbed = () => {
      // An agent saves while the pass is out. Only a direct insert here: its own
      // save-time embed would re-enter this hook.
      net.onOllamaEmbed = null
      lateId = 'late-fact-0000'
      // Newer than anything the pass has read, so only a second pass reaches it.
      const later = Date.now() + 1000
      getDb()
        .$client.prepare(
          `INSERT INTO memory_facts (id, title, content, tags, created_at, updated_at)
           VALUES (?, 'late', 'saved during the pass', '[]', ?, ?)`,
        )
        .run(lateId, later, later)
      kickEmbeddingBackfill('late-save')
    }
    await getEmbeddingResolution()
    await __backfillIdleForTests()
    expect(modelOf(lateId!)).toBe(OLLAMA_ID)
  })

  it('a fact the provider rejects is skipped once and not re-sent', async () => {
    net.models = 'down'
    setRuntimeSecret('OPENAI_API_KEY', 'sk-vault')
    await seedUnindexed(3)
    await new SqliteMemoryStore(getDb()).saveFact({ title: 'bad', content: 'POISON' })

    await getEmbeddingResolution()
    await __backfillIdleForTests()
    expect(await getEmbeddingStatus()).toMatchObject({ pending: 0, skipped: 1, lastError: null })

    const callsBefore = net.calls.openai
    await __tickForTests(true)
    await __backfillIdleForTests()
    expect(net.calls.openai).toBe(callsBefore)
  })

  it('a pass that crashes on write arms the backoff instead of re-paying every poll', async () => {
    net.models = [MODEL_TAG]
    await getEmbeddingResolution()
    await __backfillIdleForTests()
    await seedUnindexed(2)
    getDb()
      .$client.prepare(
        `CREATE TRIGGER no_writes BEFORE UPDATE ON memory_facts
         BEGIN SELECT RAISE(ABORT, 'disk is read-only'); END`,
      )
      .run()

    await getEmbeddingStatus() // kicks one pass, which throws on write
    await __backfillIdleForTests()
    const embedsAfterFailure = net.calls.embed
    const status = await getEmbeddingStatus()
    await getEmbeddingStatus()
    await __backfillIdleForTests()

    expect(net.calls.embed).toBe(embedsAfterFailure)
    expect(status.lastError).toMatch(/read-only/)
    expect(status.indexing).toBe(false)
  })

  it('does not hammer a failing provider, and retries once the backoff lapses', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(0)
    net.models = [MODEL_TAG]
    await getEmbeddingResolution()
    await __backfillIdleForTests()
    await seedUnindexed(1)
    net.embedFails = true

    await getEmbeddingStatus() // kicks one pass, which fails
    await __backfillIdleForTests()
    const afterFailure = net.calls.embed
    await getEmbeddingStatus()
    await __backfillIdleForTests()
    expect(net.calls.embed).toBe(afterFailure)
    expect((await getEmbeddingStatus()).lastError).toMatch(/404/)

    net.embedFails = false
    vi.setSystemTime(61_000)
    await getEmbeddingStatus()
    await __backfillIdleForTests()
    expect(unindexedCount()).toBe(0)
    // A recovered provider stops reporting its old failure.
    expect((await getEmbeddingStatus()).lastError).toBeNull()
  })

  it('replacing the key mid-pass finishes on the new key, without a false error', async () => {
    net.models = 'down'
    setRuntimeSecret('OPENAI_API_KEY', 'sk-a')
    await getEmbeddingResolution()
    await __backfillIdleForTests()
    await seedUnindexed(40)

    const seen: (string | null)[] = []
    let swapped = false
    net.onOpenaiEmbed = async () => {
      if (swapped) {
        seen.push((await getEmbeddingStatus()).lastError)
        return
      }
      swapped = true
      setRuntimeSecret('OPENAI_API_KEY', 'sk-b')
      onEmbeddingKeysChanged()
      await getEmbeddingResolution() // the old provider is retired before the next batch
    }
    kickEmbeddingBackfill('test')
    await __backfillIdleForTests()
    net.onOpenaiEmbed = null

    expect(unindexedCount()).toBe(0)
    expect(await getEmbeddingStatus()).toMatchObject({ pending: 0, lastError: null })
    expect(net.openaiKeys.at(-1)).toBe('sk-b')
    // Not even for a moment does the new key read as failing.
    expect(seen.length).toBeGreaterThan(0)
    expect(seen.every((e) => e === null)).toBe(true)
  })

  it('a key removed mid-pass leaves no false error behind', async () => {
    net.models = 'down'
    setRuntimeSecret('OPENAI_API_KEY', 'sk-a')
    await getEmbeddingResolution()
    await __backfillIdleForTests()
    await seedUnindexed(40)

    net.onOpenaiEmbed = async () => {
      net.onOpenaiEmbed = null
      deleteRuntimeSecret('OPENAI_API_KEY')
      onEmbeddingKeysChanged()
      await getEmbeddingResolution()
    }
    kickEmbeddingBackfill('test')
    await __backfillIdleForTests()

    expect(await getEmbeddingStatus()).toMatchObject({ state: 'none', lastError: null })
  })

  it("a replaced key starts clean: the old key's failure is not reported against it", async () => {
    net.models = 'down'
    setRuntimeSecret('OPENAI_API_KEY', 'sk-revoked')
    const old = await getEmbedProvider()
    await expect(old!.embed(['a search'])).rejects.toThrow(/401/)
    expect((await getEmbeddingStatus()).lastError).toMatch(/401/)

    setRuntimeSecret('OPENAI_API_KEY', 'sk-good')
    onEmbeddingKeysChanged()
    await getEmbeddingResolution()
    expect((await getEmbeddingStatus()).lastError).toBeNull()
  })

  it("an old key's call that fails after the swap is not reported against the new key", async () => {
    net.models = 'down'
    setRuntimeSecret('OPENAI_API_KEY', 'sk-revoked')
    const old = await getEmbedProvider()
    net.onOpenaiEmbed = async () => {
      net.onOpenaiEmbed = null
      setRuntimeSecret('OPENAI_API_KEY', 'sk-good')
      onEmbeddingKeysChanged()
      await getEmbeddingResolution()
    }
    await expect(old!.embed(['a search in flight'])).rejects.toThrow(/401/)
    expect((await getEmbeddingStatus()).lastError).toBeNull()
  })

  it("an old key's call that succeeds after the swap does not hide the new key failing", async () => {
    net.models = 'down'
    setRuntimeSecret('OPENAI_API_KEY', 'sk-good')
    const old = await getEmbedProvider()
    net.onOpenaiEmbed = async () => {
      net.onOpenaiEmbed = null
      setRuntimeSecret('OPENAI_API_KEY', 'sk-revoked')
      onEmbeddingKeysChanged()
      const replacement = await getEmbedProvider()
      await expect(replacement!.embed(['x'])).rejects.toThrow(/401/)
    }
    await expect(old!.embed(['a search in flight'])).resolves.toHaveLength(1)
    expect((await getEmbeddingStatus()).lastError).toMatch(/401/)
  })

  it('fixing a revoked key resumes indexing at once, inside the failure backoff', async () => {
    net.models = 'down'
    setRuntimeSecret('OPENAI_API_KEY', 'sk-revoked')
    await getEmbeddingResolution()
    await __backfillIdleForTests()
    await seedUnindexed(3)
    await getEmbeddingStatus() // one failed pass: the backoff is armed
    await __backfillIdleForTests()
    expect((await getEmbeddingStatus()).lastError).toMatch(/401/)

    setRuntimeSecret('OPENAI_API_KEY', 'sk-good')
    onEmbeddingKeysChanged()
    await getEmbeddingResolution()
    await __backfillIdleForTests()
    expect(unindexedCount()).toBe(0)
    expect((await getEmbeddingStatus()).lastError).toBeNull()
  })

  it('a switch to OpenAI keeps going through a key rotation', async () => {
    const local = await seedIndexedBy(OLLAMA_ID, 3)
    setRuntimeSecret('OPENAI_API_KEY', 'sk-a')
    net.models = 'down'
    await getEmbeddingResolution()
    let rotated = false
    net.onOpenaiEmbed = async () => {
      if (rotated) return
      rotated = true
      setRuntimeSecret('OPENAI_API_KEY', 'sk-b')
      onEmbeddingKeysChanged()
      await getEmbeddingResolution()
    }
    await reindexEmbeddings({ allowRemote: true, reembedAll: true })
    await __backfillIdleForTests()
    expect(local.map(modelOf)).toEqual([OPENAI_ID, OPENAI_ID, OPENAI_ID])
  })

  it('a switch still owed to OpenAI is dropped once Ollama takes over', async () => {
    await seedIndexedBy(OLLAMA_ID, 3)
    setRuntimeSecret('OPENAI_API_KEY', 'sk-vault')
    net.models = 'down'
    await getEmbeddingResolution()
    net.onOpenaiEmbed = () => {
      throw new TypeError('fetch failed') // the switch stops before converting anything
    }
    await reindexEmbeddings({ allowRemote: true, reembedAll: true })
    await __backfillIdleForTests()
    net.onOpenaiEmbed = null
    expect(getSetting(getDb(), REEMBED_REQUEST_SETTING)).toBe(OPENAI_ID)

    net.models = [MODEL_TAG] // Ollama is back before the switch finished
    invalidateEmbedProvider()
    await getEmbeddingResolution()
    await __backfillIdleForTests()
    expect(getSetting(getDb(), REEMBED_REQUEST_SETTING)).toBe('')
  })

  it('a switch that stops partway stays owed, shows as pending, and finishes on Retry', async () => {
    const local = await seedIndexedBy(OLLAMA_ID, 70)
    setRuntimeSecret('OPENAI_API_KEY', 'sk-vault')
    net.models = 'down'
    await getEmbeddingResolution()
    let calls = 0
    net.onOpenaiEmbed = () => {
      calls += 1
      if (calls === 2) throw new TypeError('fetch failed') // the second batch fails
    }
    await reindexEmbeddings({ allowRemote: true, reembedAll: true })
    await __backfillIdleForTests()
    net.onOpenaiEmbed = null

    const stopped = await getEmbeddingStatus()
    expect(stopped.lastError).toMatch(/fetch failed/)
    expect(stopped.pending).toBeGreaterThan(0) // the unconverted facts, not 0
    await reindexEmbeddings({})
    await __backfillIdleForTests()
    expect(local.map(modelOf).every((m) => m === OPENAI_ID)).toBe(true)
    expect((await getEmbeddingStatus()).pending).toBe(0)
    expect(getSetting(getDb(), REEMBED_REQUEST_SETTING)).toBe('')
  })

  it('an unfinished switch survives a restart of the server', async () => {
    await seedIndexedBy(OLLAMA_ID, 70)
    setRuntimeSecret('OPENAI_API_KEY', 'sk-vault')
    net.models = 'down'
    await getEmbeddingResolution()
    let calls = 0
    net.onOpenaiEmbed = () => {
      calls += 1
      if (calls === 2) throw new TypeError('fetch failed')
    }
    await reindexEmbeddings({ allowRemote: true, reembedAll: true })
    await __backfillIdleForTests()
    net.onOpenaiEmbed = null

    __resetEmbeddingForTests() // everything in memory is gone
    await getEmbeddingResolution()
    await __backfillIdleForTests()
    expect(unindexedCount()).toBe(0)
    expect((await getEmbeddingStatus()).pending).toBe(0)
  })

  it('Retry checks the provider, so one that recovered stops reading as failing', async () => {
    net.models = [MODEL_TAG]
    await getEmbeddingResolution()
    await __backfillIdleForTests()
    await seedUnindexed(1)
    await __tickForTests(true)
    await __backfillIdleForTests()
    const provider = await getEmbedProvider()
    net.embedFails = true
    await expect(provider!.embed(['a search'])).rejects.toThrow(/404/)
    expect((await getEmbeddingStatus()).lastError).toMatch(/404/)

    net.embedFails = false
    await reindexEmbeddings({})
    await __backfillIdleForTests()
    await vi.waitFor(async () => expect((await getEmbeddingStatus()).lastError).toBeNull())
  })

  it('Retry keeps reporting a provider that is still failing', async () => {
    net.models = [MODEL_TAG]
    await getEmbeddingResolution()
    await __backfillIdleForTests()
    const provider = await getEmbedProvider()
    net.embedFails = true
    await expect(provider!.embed(['a search'])).rejects.toThrow(/404/)

    const embedsBefore = net.calls.embed
    await reindexEmbeddings({})
    await __backfillIdleForTests()
    await vi.waitFor(() => expect(net.calls.embed).toBeGreaterThan(embedsBefore))
    expect((await getEmbeddingStatus()).lastError).toMatch(/404/)
  })

  it('the server timer indexes facts with nobody looking', async () => {
    net.models = [MODEL_TAG]
    await getEmbeddingResolution()
    await __backfillIdleForTests()
    await seedUnindexed(2) // e.g. saved over an MCP session opened before the model

    await __tickForTests(true)
    await __backfillIdleForTests()
    expect(unindexedCount()).toBe(0)
  })
})

// ─── Status ──────────────────────────────────────────────────────────────────

describe('getEmbeddingStatus', () => {
  it('counts vectors written, so a view can tell exactly when links can appear', async () => {
    await seedUnindexed(3)
    net.models = [MODEL_TAG]
    expect((await getEmbeddingStatus()).vectorsWritten).toBe(0)
    await __backfillIdleForTests()
    expect((await getEmbeddingStatus()).vectorsWritten).toBe(3)
  })

  it('reports whether the store is local-first', async () => {
    net.models = 'down'
    expect((await getEmbeddingStatus()).localFirst).toBe(false)
    await seedIndexedBy(OLLAMA_ID, 1)
    expect((await getEmbeddingStatus()).localFirst).toBe(true)
  })

  it('the graph marks facts the provider turned down, so they are not mistaken for pending', async () => {
    net.models = 'down'
    setRuntimeSecret('OPENAI_API_KEY', 'sk-vault')
    const bad = await new SqliteMemoryStore(getDb()).saveFact({ title: 'bad', content: 'POISON' })
    await seedUnindexed(1)
    await getEmbeddingResolution()
    await __backfillIdleForTests()
    const { res, state } = mockRes()
    await memoryGraphGET({ query: {} } as unknown as Request, res)
    const nodes = (state.json as { graph: { nodes: { id: string; embedSkipped?: boolean }[] } })
      .graph.nodes
    expect(nodes.find((n) => n.id === bad.id)?.embedSkipped).toBe(true)
    expect(nodes.filter((n) => n.embedSkipped)).toHaveLength(1)
  })

  it('names the missing model and offers no provider', async () => {
    await seedUnindexed(2)
    net.models = []
    expect(await getEmbeddingStatus()).toEqual({
      state: 'ollama-model-missing',
      provider: null,
      remote: false,
      missingModel: OLLAMA_DEFAULT_MODEL,
      remoteAvailable: false,
      pending: null,
      factCount: 2,
      localFirst: false,
      vectorsWritten: 0,
      skipped: 0,
      indexing: false,
      installing: false,
      lastError: null,
    })
  })

  it('reports pending facts and indexes them when asked', async () => {
    net.models = [MODEL_TAG]
    await getEmbeddingResolution()
    await __backfillIdleForTests()
    await seedUnindexed(2)

    const status = await getEmbeddingStatus()
    expect(status.state).toBe('ready')
    expect(status.provider?.id).toBe(OLLAMA_ID)
    expect(status.pending).toBe(2)

    await __backfillIdleForTests()
    expect((await getEmbeddingStatus()).pending).toBe(0)
  })
})

// ─── Install ─────────────────────────────────────────────────────────────────

const OK_FRAMES = [
  JSON.stringify({ status: 'pulling manifest' }),
  JSON.stringify({ status: 'pulling 970aa74c0a90', total: 1000, completed: 400 }),
  JSON.stringify({ status: 'pulling 970aa74c0a90', total: 1000, completed: 1000 }),
  JSON.stringify({ status: 'pulling c71d239df917', total: 10, completed: 10 }),
  JSON.stringify({ status: 'verifying sha256 digest' }),
  JSON.stringify({ status: 'success' }),
]

/** A pull stream that hangs until aborted, then errors like a real fetch body. */
function hangingPull(signal: AbortSignal | undefined): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      controller.enqueue(
        new TextEncoder().encode(JSON.stringify({ status: 'pulling manifest' }) + '\n'),
      )
      signal?.addEventListener('abort', () =>
        controller.error(new DOMException('aborted', 'AbortError')),
      )
    },
  })
}

describe('pullEmbeddingModel', () => {
  it('reports what is happening in plain words, following only the model layer', async () => {
    await seedUnindexed(2)
    net.models = []
    await getEmbeddingResolution()
    net.pullFrames = OK_FRAMES
    net.models = [MODEL_TAG]

    const seen: { message: string; total?: number }[] = []
    await pullEmbeddingModel((p) => seen.push(p), new AbortController().signal)
    await __backfillIdleForTests()

    expect(seen.map((p) => p.message)).toEqual([
      'Preparing the download',
      'Downloading',
      'Downloading',
      'Downloading',
      'Verifying',
      'Finishing',
    ])
    // The 10-byte layer after the model carries no bytes, so no 100% to 0% jump.
    expect(seen.map((p) => p.total ?? null)).toEqual([null, 1000, 1000, null, null, null])
    expect((await getEmbeddingResolution()).state).toBe('ready')
    expect(unindexedCount()).toBe(0)
  })

  it('reads a success line split across chunks', async () => {
    net.pullStream = () =>
      new ReadableStream({
        start(controller) {
          const enc = new TextEncoder()
          controller.enqueue(enc.encode('{"status":"pulling manifest"}\n{"sta'))
          controller.enqueue(enc.encode('tus":"success"}'))
          controller.close()
        },
      })
    await expect(
      pullEmbeddingModel(() => {}, new AbortController().signal),
    ).resolves.toBeUndefined()
  })

  it('surfaces an error frame from Ollama', async () => {
    net.pullFrames = [JSON.stringify({ error: 'pull model manifest: file does not exist' })]
    await expect(pullEmbeddingModel(() => {}, new AbortController().signal)).rejects.toThrow(
      /file does not exist/,
    )
  })

  it('treats a stream that ends without success as a failed install', async () => {
    net.pullFrames = [JSON.stringify({ status: 'pulling manifest' })]
    await expect(pullEmbeddingModel(() => {}, new AbortController().signal)).rejects.toThrow(
      /before Ollama reported success/,
    )
  })

  it('refuses a second install while one is running', async () => {
    net.pullFrames = OK_FRAMES
    const first = pullEmbeddingModel(() => {}, new AbortController().signal)
    await expect(pullEmbeddingModel(() => {}, new AbortController().signal)).rejects.toBeInstanceOf(
      PullInProgressError,
    )
    await first
  })

  it('always asks Ollama for the one embedding model, whatever the caller wants', async () => {
    net.pullFrames = OK_FRAMES
    const fetchMock = vi.mocked(globalThis.fetch)
    await pullEmbeddingModel(() => {}, new AbortController().signal)
    const pullCall = fetchMock.mock.calls.find(([u]) => String(u).endsWith('/api/pull'))!
    expect(JSON.parse(String(pullCall[1]?.body))).toEqual({
      model: OLLAMA_DEFAULT_MODEL,
      stream: true,
    })
  })
})

// ─── REST ────────────────────────────────────────────────────────────────────

/** Enough of an Express response for JSON and SSE handlers. */
function mockRes() {
  const state = {
    code: 200,
    json: undefined as unknown,
    headers: {} as Record<string, string>,
    chunks: [] as string[],
    ended: false,
    onClose: null as (() => void) | null,
  }
  const res = {
    status(c: number) {
      state.code = c
      return this
    },
    json(b: unknown) {
      state.json = b
      return this
    },
    setHeader(k: string, v: string) {
      state.headers[k.toLowerCase()] = v
    },
    flushHeaders() {},
    write(chunk: string) {
      state.chunks.push(chunk)
      return true
    },
    end() {
      state.ended = true
    },
    on(ev: string, fn: () => void) {
      if (ev === 'close') state.onClose = fn
      return this
    },
    get writableEnded() {
      return state.ended
    },
    destroyed: false,
  }
  const events = () =>
    state.chunks
      .flatMap((c) => c.split('\n\n'))
      .filter((c) => c.startsWith('data: '))
      .map((c) => JSON.parse(c.slice(6)) as { type: string; [k: string]: unknown })
  return { res: res as unknown as Response, state, events }
}

const noReq = {} as Request

describe('memory embedding routes', () => {
  it('GET /api/memory/provider keeps `provider` and adds the reason', async () => {
    net.models = []
    const { res, state } = mockRes()
    await memoryProviderGET(noReq, res)
    const body = state.json as {
      provider: unknown
      status: { state: string; missingModel: string }
    }
    expect(body.provider).toBeNull()
    expect(body.status.state).toBe('ollama-model-missing')
    expect(body.status.missingModel).toBe(OLLAMA_DEFAULT_MODEL)
  })

  it.each<[string, () => void]>([
    [
      'ready',
      () => {
        net.models = [MODEL_TAG]
      },
    ],
    [
      'none',
      () => {
        net.models = 'down'
      },
    ],
    [
      'disabled',
      () => {
        process.env['CLAWBOO_DISABLE_EMBEDDINGS'] = '1'
      },
    ],
  ])('install refuses when %s: there is nothing to install', async (_s, arrange) => {
    arrange()
    const { res, state } = mockRes()
    await memoryEmbeddingInstallPOST(noReq, res)
    expect(state.code).toBe(409)
    expect(net.calls.pull).toBe(0)
  })

  it('install streams progress over SSE and finishes ready', async () => {
    await seedUnindexed(1)
    net.models = []
    await getEmbeddingResolution()
    net.pullFrames = OK_FRAMES
    net.models = [MODEL_TAG]

    const { res, state, events } = mockRes()
    await memoryEmbeddingInstallPOST(noReq, res)
    await __backfillIdleForTests()

    expect(state.headers['content-type']).toBe('text/event-stream')
    const evs = events()
    expect(evs[0]).toMatchObject({ type: 'progress', message: 'Preparing the download' })
    expect(evs.some((e) => e.type === 'progress' && e.total === 1000)).toBe(true)
    const done = evs.at(-1)!
    expect(done.type).toBe('complete')
    expect((done.status as { state: string }).state).toBe('ready')
    expect(state.ended).toBe(true)
    expect(unindexedCount()).toBe(0)
  })

  it('install reports a failed pull as an SSE error, not a hung stream', async () => {
    net.models = []
    await getEmbeddingResolution()
    net.pullFrames = [JSON.stringify({ error: 'no space left on device' })]
    const { res, state, events } = mockRes()
    await memoryEmbeddingInstallPOST(noReq, res)
    const last = events().at(-1)!
    expect(last).toMatchObject({ type: 'error', code: 'PULL_FAILED' })
    expect(String(last.message)).toMatch(/no space left/)
    expect(state.ended).toBe(true)
  })

  it('closing the connection cancels the download at Ollama', async () => {
    net.models = []
    await getEmbeddingResolution()
    net.pullStream = hangingPull
    const { res, state, events } = mockRes()
    const done = memoryEmbeddingInstallPOST(noReq, res)
    await vi.waitFor(() => expect(net.calls.pull).toBe(1))
    state.onClose!()
    await done
    expect(net.pullSignal?.aborted).toBe(true)
    expect(events().at(-1)).toMatchObject({ type: 'error', code: 'CANCELLED' })
  })

  it('a second install while one runs is told it is in progress', async () => {
    net.models = []
    await getEmbeddingResolution()
    net.pullStream = hangingPull
    const a = mockRes()
    const first = memoryEmbeddingInstallPOST(noReq, a.res)
    await vi.waitFor(() => expect(net.calls.pull).toBe(1))
    const b = mockRes()
    await memoryEmbeddingInstallPOST(noReq, b.res)
    expect(b.events().at(-1)).toMatchObject({ type: 'error', code: 'IN_PROGRESS' })
    a.state.onClose!()
    await first
  })

  it('reindex re-probes and indexes, returning at once', async () => {
    net.models = []
    await getEmbeddingResolution()
    await seedUnindexed(2)
    net.models = [MODEL_TAG] // installed outside clawboo, e.g. `ollama pull` in a terminal

    const { res, state } = mockRes()
    await memoryEmbeddingReindexPOST(noReq, res)
    expect(state.code).toBe(202)
    await __backfillIdleForTests()
    expect(unindexedCount()).toBe(0)
  })

  it('reindex answers at once even when the provider is stalled', async () => {
    net.models = [MODEL_TAG]
    await getEmbeddingResolution()
    await __backfillIdleForTests()
    let release!: () => void
    const stalled = new Promise<void>((r) => (release = r))
    net.onOpenaiEmbed = null
    net.onOllamaEmbed = () => stalled
    const { res, state } = mockRes()
    await memoryEmbeddingReindexPOST({ body: {} } as Request, res)
    expect(state.code).toBe(202)
    release()
    net.onOllamaEmbed = null
  })

  it('Retry works inside the failure backoff, with the provider unchanged', async () => {
    net.models = [MODEL_TAG]
    await getEmbeddingResolution()
    await __backfillIdleForTests()
    await seedUnindexed(1)
    net.embedFails = true
    await getEmbeddingStatus() // one failed pass: the backoff is now armed
    await __backfillIdleForTests()
    net.embedFails = false

    const { res } = mockRes()
    await memoryEmbeddingReindexPOST({ body: {} } as Request, res)
    await __backfillIdleForTests()
    expect(unindexedCount()).toBe(0)
  })
})
