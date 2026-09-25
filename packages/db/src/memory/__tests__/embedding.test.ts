// Embedding resolution + the backfill that turns an unindexed store into a
// linked one. An Ollama that answers /api/tags without the embedding model is
// not a provider (every /api/embed call would 404), and facts saved without a
// vector must be indexed later. These pin both halves.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { createDb, getSetting, setSetting, type ClawbooDb } from '../../db'
import {
  DeterministicEmbeddingProvider,
  EmbeddingHttpError,
  OLLAMA_DEFAULT_MODEL,
  LOCAL_FIRST_SETTING,
  REMOTE_EMBEDDING_CONSENT_SETTING,
  isRemoteEmbeddingProvider,
  ollamaHasModel,
  probeEmbeddingProvider,
  resolveEmbeddingProvider,
} from '../embedding'
import {
  EMBED_TEXT_MAX_CHARS,
  EMBED_TEXT_RETRY_CHARS,
  SqliteMemoryStore,
  factEmbeddingText,
  noteEmbeddingProviderServing,
  storeAllowsRemoteEmbedding,
  storeIsLocalFirst,
} from '../store'
import type { EmbeddingProvider } from '../types'

// ─── Resolver ────────────────────────────────────────────────────────────────

const ENV_KEYS = ['OPENAI_API_KEY', 'CLAWBOO_DISABLE_EMBEDDINGS'] as const
let savedEnv: Record<string, string | undefined> = {}

beforeEach(() => {
  // A developer with a key exported in their shell would otherwise run a
  // different branch of the resolver than CI does.
  savedEnv = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]))
  for (const k of ENV_KEYS) delete process.env[k]
})

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k]
    else process.env[k] = savedEnv[k]
  }
  vi.unstubAllGlobals()
})

function stubTags(models: string[] | 'down' | 500, shape: 'name' | 'model' = 'name') {
  const fetchMock = vi.fn(async () => {
    if (models === 'down') throw new TypeError('fetch failed')
    if (models === 500) return new Response('boom', { status: 500 })
    return Response.json({
      models: models.map((m) => (shape === 'name' ? { name: m } : { model: m })),
    })
  })
  vi.stubGlobal('fetch', fetchMock)
  return fetchMock
}

describe('probeEmbeddingProvider', () => {
  it('is ready when Ollama has the embedding model', async () => {
    stubTags([`${OLLAMA_DEFAULT_MODEL}:latest`, 'llama3:8b'])
    const res = await probeEmbeddingProvider()
    expect(res.state).toBe('ready')
    expect(res.provider?.id).toBe(`ollama:${OLLAMA_DEFAULT_MODEL}`)
  })

  it('reports the missing model instead of claiming a working provider', async () => {
    stubTags([])
    const res = await probeEmbeddingProvider()
    expect(res).toEqual({
      state: 'ollama-model-missing',
      provider: null,
      model: OLLAMA_DEFAULT_MODEL,
      baseUrl: 'http://localhost:11434',
    })
    // Reachable without the model: no provider, since every call would 404.
    stubTags([])
    expect(await resolveEmbeddingProvider()).toBeNull()
  })

  it('prefers a working OpenAI key over a model-less Ollama', async () => {
    stubTags([])
    const res = await probeEmbeddingProvider({ openaiApiKey: 'sk-test' })
    expect(res.state).toBe('ready')
    expect(res.provider?.id).toBe('openai:text-embedding-3-small')
  })

  it('still prefers local Ollama when it has the model and a key exists too', async () => {
    stubTags([`${OLLAMA_DEFAULT_MODEL}:latest`])
    const res = await probeEmbeddingProvider({ openaiApiKey: 'sk-test' })
    expect(res.provider?.id).toBe(`ollama:${OLLAMA_DEFAULT_MODEL}`)
  })

  it('reads OPENAI_API_KEY from the environment when no key is passed', async () => {
    stubTags('down')
    process.env['OPENAI_API_KEY'] = 'sk-env'
    expect((await probeEmbeddingProvider()).provider?.id).toBe('openai:text-embedding-3-small')
  })

  it('is none when Ollama is down and there is no key', async () => {
    stubTags('down')
    expect(await probeEmbeddingProvider()).toEqual({ state: 'none', provider: null })
  })

  it('treats a non-2xx /api/tags as unreachable, not as an empty model list', async () => {
    stubTags(500)
    expect((await probeEmbeddingProvider()).state).toBe('none')
  })

  it('honours the disable switch without probing the network', async () => {
    const fetchMock = stubTags([`${OLLAMA_DEFAULT_MODEL}:latest`])
    process.env['CLAWBOO_DISABLE_EMBEDDINGS'] = '1'
    expect(await probeEmbeddingProvider()).toEqual({ state: 'disabled', provider: null })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('keeps embeddings local when remote use is not allowed', async () => {
    stubTags('down')
    expect(await probeEmbeddingProvider({ openaiApiKey: 'sk-test', allowRemote: false })).toEqual({
      state: 'ollama-unreachable',
      provider: null,
      baseUrl: 'http://localhost:11434',
    })
    stubTags([])
    expect(
      (await probeEmbeddingProvider({ openaiApiKey: 'sk-test', allowRemote: false })).state,
    ).toBe('ollama-model-missing')
  })

  it('says when a remote provider serves but a local install is one step away', async () => {
    stubTags([])
    const res = await probeEmbeddingProvider({ openaiApiKey: 'sk-test' })
    expect(res.state).toBe('ready')
    expect(res.state === 'ready' && res.localModelMissing).toEqual({
      model: OLLAMA_DEFAULT_MODEL,
      baseUrl: 'http://localhost:11434',
    })
    stubTags('down')
    const away = await probeEmbeddingProvider({ openaiApiKey: 'sk-test' })
    expect(away.state === 'ready' && away.localModelMissing).toBeUndefined()
  })

  it('reads a tags entry that carries only `model`', async () => {
    stubTags([`${OLLAMA_DEFAULT_MODEL}:latest`], 'model')
    expect((await probeEmbeddingProvider()).state).toBe('ready')
  })

  it('times out a probe whose body never arrives, instead of hanging every caller', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string, init?: RequestInit) => {
        const body = new ReadableStream({
          start(controller) {
            init?.signal?.addEventListener('abort', () =>
              controller.error(new DOMException('aborted', 'AbortError')),
            )
          },
        })
        return new Response(body, { headers: { 'content-type': 'application/json' } })
      }),
    )
    const started = Date.now()
    const res = await probeEmbeddingProvider({ probeTimeoutMs: 30 })
    expect(res.state).toBe('none')
    expect(Date.now() - started).toBeLessThan(1_000)
  })

  it('an explicit provider wins without probing', async () => {
    const fetchMock = stubTags([])
    const provider = new DeterministicEmbeddingProvider()
    expect(await probeEmbeddingProvider({ provider })).toEqual({ state: 'ready', provider })
    expect(fetchMock).not.toHaveBeenCalled()
  })
})

describe('isRemoteEmbeddingProvider', () => {
  it('marks only providers that send text off the machine', () => {
    expect(isRemoteEmbeddingProvider('openai:text-embedding-3-small')).toBe(true)
    expect(isRemoteEmbeddingProvider(`ollama:${OLLAMA_DEFAULT_MODEL}`)).toBe(false)
    expect(isRemoteEmbeddingProvider('deterministic')).toBe(false)
  })
})

describe('ollamaHasModel', () => {
  it('matches an untagged reference only against :latest', () => {
    expect(ollamaHasModel(['nomic-embed-text:latest'], 'nomic-embed-text')).toBe(true)
    // A different tag is a different model to /api/embed.
    expect(ollamaHasModel(['nomic-embed-text:v1.5'], 'nomic-embed-text')).toBe(false)
  })

  it('matches a tagged reference exactly', () => {
    expect(ollamaHasModel(['nomic-embed-text:v1.5'], 'nomic-embed-text:v1.5')).toBe(true)
    expect(ollamaHasModel(['nomic-embed-text:latest'], 'nomic-embed-text:v1.5')).toBe(false)
  })

  it('is false for an empty install', () => {
    expect(ollamaHasModel([], 'nomic-embed-text')).toBe(false)
  })
})

// ─── Backfill ────────────────────────────────────────────────────────────────

let db: ClawbooDb

beforeEach(() => {
  db = createDb(':memory:')
})

/** Counts calls and batch sizes so a test can see how the backfill paged. */
class CountingEmbed implements EmbeddingProvider {
  readonly dimensions = 64
  readonly calls: number[] = []
  private readonly inner = new DeterministicEmbeddingProvider()
  constructor(readonly id = 'deterministic') {}
  embed(texts: string[]): Promise<number[][]> {
    this.calls.push(texts.length)
    return this.inner.embed(texts)
  }
}

class FailingEmbed implements EmbeddingProvider {
  readonly id = 'deterministic'
  readonly dimensions = 64
  calls = 0
  embed(): Promise<number[][]> {
    this.calls += 1
    return Promise.reject(new EmbeddingHttpError('Ollama', 404))
  }
}

async function seedUnindexed(n: number): Promise<string[]> {
  const bare = new SqliteMemoryStore(db) // no provider: the save-time failure mode
  const ids: string[] = []
  for (let i = 0; i < n; i++) {
    const f = await bare.saveFact({ title: `fact ${i}`, content: `deploy release note ${i}` })
    ids.push(f.id)
  }
  return ids
}

function rowOf(id: string) {
  return db.$client
    .prepare('SELECT embedding, embedding_model, updated_at FROM memory_facts WHERE id = ?')
    .get(id) as { embedding: Buffer | null; embedding_model: string | null; updated_at: number }
}

describe('SqliteMemoryStore.backfillEmbeddings', () => {
  it('indexes facts saved without a vector, which is what makes similarity appear', async () => {
    await seedUnindexed(3)
    const embed = new CountingEmbed()
    const store = new SqliteMemoryStore(db, embed)
    expect(store.countFactsNeedingEmbedding(embed.id)).toBe(3)
    expect((await store.getMemoryGraph()).similarityAvailable).toBe(false)

    const res = await store.backfillEmbeddings()

    expect(res).toEqual({ embedded: 3, skipped: [], remaining: 0, error: null })
    const graph = await store.getMemoryGraph()
    expect(graph.similarityAvailable).toBe(true)
    expect(graph.edges.some((e) => e.kind === 'similarity')).toBe(true)
  })

  it('never touches updated_at, which drives the graph recency fade', async () => {
    // Seed and index at different times: on the real clock both usually land
    // in the same millisecond, which would hide a `updatedAt: Date.now()`.
    vi.useFakeTimers({ toFake: ['Date'] })
    try {
      vi.setSystemTime(1_000)
      const [id] = await seedUnindexed(1)
      vi.setSystemTime(50_000)
      await new SqliteMemoryStore(db, new CountingEmbed()).backfillEmbeddings()
      const after = rowOf(id!)
      expect(after.embedding).not.toBeNull()
      expect(after.updated_at).toBe(1_000)
    } finally {
      vi.useRealTimers()
    }
  })

  it('re-embeds vectors left behind by a previous provider', async () => {
    const old = new SqliteMemoryStore(db, new CountingEmbed('old-model'))
    const f = await old.saveFact({ title: 't', content: 'c' })
    expect(rowOf(f.id).embedding_model).toBe('old-model')

    const store = new SqliteMemoryStore(db, new CountingEmbed('new-model'))
    expect(store.countFactsNeedingEmbedding('new-model')).toBe(1)
    expect((await store.backfillEmbeddings()).embedded).toBe(1)
    expect(rowOf(f.id).embedding_model).toBe('new-model')
  })

  it('leaves facts that already have a current vector alone', async () => {
    const embed = new CountingEmbed()
    const store = new SqliteMemoryStore(db, embed)
    const current = await store.saveFact({ title: 'already', content: 'indexed' })
    const before = rowOf(current.id).embedding
    await seedUnindexed(2)
    embed.calls.length = 0

    const res = await store.backfillEmbeddings()

    expect(res.embedded).toBe(2)
    expect(embed.calls).toEqual([2]) // the current fact was never re-sent
    expect(rowOf(current.id).embedding?.equals(before!)).toBe(true)
  })

  it('stops at the first provider error rather than spinning on a dead provider', async () => {
    await seedUnindexed(5)
    const embed = new FailingEmbed()
    const res = await new SqliteMemoryStore(db, embed).backfillEmbeddings({ batchSize: 2 })
    expect(res).toEqual({
      embedded: 0,
      skipped: [],
      remaining: 5,
      error: 'Ollama embed failed: 404',
    })
    expect(embed.calls).toBe(1)
  })

  it('stops when the provider answers with the wrong number of vectors', async () => {
    await seedUnindexed(3)
    const short: EmbeddingProvider = {
      id: 'deterministic',
      dimensions: 64,
      embed: () => Promise.resolve([[1, 0, 0]]),
    }
    const res = await new SqliteMemoryStore(db, short).backfillEmbeddings()
    expect(res.embedded).toBe(0)
    expect(res.remaining).toBe(3)
    expect(res.error).toMatch(/1 vectors for 3 facts/)
  })

  it('pages in batches and honours maxFacts', async () => {
    await seedUnindexed(7)
    const embed = new CountingEmbed()
    const store = new SqliteMemoryStore(db, embed)
    const res = await store.backfillEmbeddings({ batchSize: 3, maxFacts: 5 })
    expect(embed.calls).toEqual([3, 2])
    expect(res).toEqual({ embedded: 5, skipped: [], remaining: 2, error: null })
  })

  it('indexes newest facts first', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    try {
      vi.setSystemTime(1_000)
      const [older] = await seedUnindexed(1)
      vi.setSystemTime(2_000)
      const [newer] = await seedUnindexed(1)
      await new SqliteMemoryStore(db, new CountingEmbed()).backfillEmbeddings({ maxFacts: 1 })
      expect(rowOf(newer!).embedding).not.toBeNull()
      expect(rowOf(older!).embedding).toBeNull()
    } finally {
      vi.useRealTimers()
    }
  })

  it('writes nothing once aborted', async () => {
    await seedUnindexed(2)
    const ctrl = new AbortController()
    const aborting: EmbeddingProvider = {
      id: 'deterministic',
      dimensions: 64,
      embed: async (texts) => {
        ctrl.abort()
        return new DeterministicEmbeddingProvider().embed(texts)
      },
    }
    const res = await new SqliteMemoryStore(db, aborting).backfillEmbeddings({
      signal: ctrl.signal,
    })
    expect(res.embedded).toBe(0)
    expect(res.remaining).toBe(2)
  })

  it('reports the missing provider instead of pretending there was no work', async () => {
    await seedUnindexed(1)
    expect(await new SqliteMemoryStore(db).backfillEmbeddings()).toEqual({
      embedded: 0,
      skipped: [],
      remaining: 0,
      error: 'no embedding provider',
    })
  })

  it('caps what is embedded, on save and backfill alike', async () => {
    const huge = 'x'.repeat(EMBED_TEXT_MAX_CHARS * 2)
    expect(factEmbeddingText('t', huge)).toHaveLength(EMBED_TEXT_MAX_CHARS)
    const seen: string[] = []
    const probe: EmbeddingProvider = {
      id: 'deterministic',
      dimensions: 64,
      embed: async (texts) => {
        seen.push(...texts)
        return new DeterministicEmbeddingProvider().embed(texts)
      },
    }
    await new SqliteMemoryStore(db, probe).saveFact({ title: 't', content: huge })
    expect(seen[0]).toHaveLength(EMBED_TEXT_MAX_CHARS)
  })

  it('one fact the provider rejects does not stop every other fact being indexed', async () => {
    await seedUnindexed(9)
    const bare = new SqliteMemoryStore(db)
    const poison = await bare.saveFact({ title: 'poison', content: 'POISON' })
    // Like OpenAI: the whole request 400s when any one input is unacceptable.
    const picky: EmbeddingProvider = {
      id: 'deterministic',
      dimensions: 64,
      embed: async (texts) => {
        if (texts.some((t) => t.includes('POISON'))) throw new EmbeddingHttpError('OpenAI', 400)
        return new DeterministicEmbeddingProvider().embed(texts)
      },
    }
    const res = await new SqliteMemoryStore(db, picky).backfillEmbeddings({ batchSize: 4 })
    expect(res.embedded).toBe(9)
    expect(res.skipped).toEqual([poison.id])
    expect(res.error).toBeNull()
    // The skip is reported, and excluded from the count, so the UI can settle.
    expect(res.remaining).toBe(0)
    expect(rowOf(poison.id).embedding).toBeNull()
  })

  it('stops, rather than skips, when a single-fact retry hits a provider failure', async () => {
    await seedUnindexed(3)
    let calls = 0
    const flaky: EmbeddingProvider = {
      id: 'deterministic',
      dimensions: 64,
      embed: async () => {
        calls += 1
        throw new EmbeddingHttpError('OpenAI', calls === 1 ? 400 : 401)
      },
    }
    const res = await new SqliteMemoryStore(db, flaky).backfillEmbeddings()
    expect(res).toEqual({
      embedded: 0,
      skipped: [],
      remaining: 3,
      error: 'OpenAI embed failed: 401',
    })
  })

  it('reports the vectors it committed when a later write fails', async () => {
    await seedUnindexed(40)
    const last = db.$client
      .prepare('SELECT id FROM memory_facts ORDER BY created_at DESC, id ASC LIMIT 1 OFFSET 39')
      .get() as { id: string }
    db.$client
      .prepare(
        `CREATE TEMP TRIGGER bad_row BEFORE UPDATE OF embedding ON memory_facts
         WHEN new.id = '${last.id}' BEGIN SELECT RAISE(ABORT, 'disk full'); END`,
      )
      .run()
    const res = await new SqliteMemoryStore(db, new CountingEmbed()).backfillEmbeddings({
      batchSize: 16,
    })
    expect(res.embedded).toBe(32)
    expect(res.error).toMatch(/disk full/)
    expect(res.remaining).toBe(8)
  })

  it('treats an empty vector as a skip for that fact, not a stored vector', async () => {
    const ids = await seedUnindexed(2)
    const half: EmbeddingProvider = {
      id: 'deterministic',
      dimensions: 2,
      embed: (texts) => Promise.resolve(texts.map((_, i) => (i === 0 ? [1, 0] : []))),
    }
    const res = await new SqliteMemoryStore(db, half).backfillEmbeddings()
    expect(res.embedded).toBe(1)
    expect(res.skipped).toHaveLength(1)
    expect(ids.map((id) => rowOf(id).embedding === null).filter(Boolean)).toHaveLength(1)
  })

  it("leaves another provider's vectors alone when asked to (the remote policy)", async () => {
    const old = new SqliteMemoryStore(db, new CountingEmbed('ollama:nomic-embed-text'))
    const kept = await old.saveFact({ title: 'kept', content: 'local vector' })
    await seedUnindexed(2)
    const remote = new CountingEmbed('openai:text-embedding-3-small')
    const store = new SqliteMemoryStore(db, remote)

    expect(store.countFactsNeedingEmbedding(remote.id, { includeOtherModels: false })).toBe(2)
    const res = await store.backfillEmbeddings({ reembedOtherModels: false })
    expect(res.embedded).toBe(2)
    expect(rowOf(kept.id).embedding_model).toBe('ollama:nomic-embed-text')
    // The default still converges the whole store, for an explicit reindex.
    expect((await store.backfillEmbeddings()).embedded).toBe(1)
    expect(rowOf(kept.id).embedding_model).toBe(remote.id)
  })

  it('excludes skipped facts from a pass and from the count', async () => {
    const ids = await seedUnindexed(3)
    const embed = new CountingEmbed()
    const store = new SqliteMemoryStore(db, embed)
    expect(store.countFactsNeedingEmbedding(embed.id, { excludeIds: [ids[0]!] })).toBe(2)
    const res = await store.backfillEmbeddings({ skipIds: [ids[0]!] })
    expect(res.embedded).toBe(2)
    expect(rowOf(ids[0]!).embedding).toBeNull()
  })

  it('reads each fact about once across a whole-store pass', async () => {
    await seedUnindexed(70)
    const embed = new CountingEmbed()
    await new SqliteMemoryStore(db, embed).backfillEmbeddings({ batchSize: 32 })
    expect(embed.calls).toEqual([32, 32, 6])
  })

  it('does not overwrite a vector another writer stored mid-pass', async () => {
    const ids = await seedUnindexed(2)
    const racing: EmbeddingProvider = {
      id: 'deterministic',
      dimensions: 64,
      embed: async (texts) => {
        // Another process indexes one of these facts while this batch is out.
        db.$client
          .prepare('UPDATE memory_facts SET embedding = ?, embedding_model = ? WHERE id = ?')
          .run(Buffer.from(new Float32Array([9]).buffer), 'deterministic', ids[0])
        return new DeterministicEmbeddingProvider().embed(texts)
      },
    }
    const res = await new SqliteMemoryStore(db, racing).backfillEmbeddings()
    expect(res.embedded).toBe(1)
    expect(rowOf(ids[0]!).embedding?.byteLength).toBe(4) // the other writer's vector survives
  })

  it('knows which provider family the store has been indexed with', async () => {
    const store = new SqliteMemoryStore(db, new CountingEmbed('ollama:nomic-embed-text'))
    expect(store.hasFactsEmbeddedBy('ollama:')).toBe(false)
    await store.saveFact({ title: 't', content: 'c' })
    expect(store.hasFactsEmbeddedBy('ollama:')).toBe(true)
    expect(store.hasFactsEmbeddedBy('openai:')).toBe(false)
  })

  it('retries a rejected fact with a shorter prefix before skipping it', async () => {
    // Characters stand in for tokens; a script that runs a token per character
    // can pass the provider's limit well under EMBED_TEXT_MAX_CHARS.
    const bare = new SqliteMemoryStore(db)
    const long = await bare.saveFact({ title: 'long', content: '語'.repeat(5000) })
    let calls = 0
    const tokenLimited: EmbeddingProvider = {
      id: 'deterministic',
      dimensions: 64,
      embed: async (texts) => {
        calls += 1
        if (texts.some((t) => t.length > EMBED_TEXT_RETRY_CHARS + 100))
          throw new EmbeddingHttpError('OpenAI', 400)
        return new DeterministicEmbeddingProvider().embed(texts)
      },
    }
    const res = await new SqliteMemoryStore(db, tokenLimited).backfillEmbeddings()
    expect(res).toMatchObject({ embedded: 1, skipped: [], error: null })
    expect(rowOf(long.id).embedding).not.toBeNull()
    // The refused request is not sent a second time: batch, then the prefix.
    expect(calls).toBe(2)
  })

  it('matches a provider family by exact prefix, not by a lookalike', async () => {
    const ids = await seedUnindexed(2)
    const set = db.$client.prepare(
      "UPDATE memory_facts SET embedding = x'00000000', embedding_model = ? WHERE id = ?",
    )
    set.run('ollamax:other', ids[0])
    set.run('ollama;odd', ids[1])
    const store = new SqliteMemoryStore(db)
    expect(store.hasFactsEmbeddedBy('ollama:')).toBe(false)
    set.run('ollama:nomic-embed-text', ids[1])
    expect(store.hasFactsEmbeddedBy('ollama:')).toBe(true)
  })

  it('counts every fact in the store', async () => {
    await seedUnindexed(3)
    expect(new SqliteMemoryStore(db).countFacts()).toBe(3)
  })

  it('pages with index seeks, not a scan per page, on both the local and remote paths', async () => {
    await seedUnindexed(40)
    const prepare = db.$client.prepare.bind(db.$client)
    const sqls: string[] = []
    const spy = vi.spyOn(db.$client, 'prepare').mockImplementation((sql: string) => {
      sqls.push(sql)
      return prepare(sql)
    })
    // The remote path (only facts with no vector), then the local one.
    await new SqliteMemoryStore(db, new CountingEmbed('openai:x')).backfillEmbeddings({
      batchSize: 16,
      reembedOtherModels: false,
    })
    const remoteSqls = sqls.splice(0)
    await new SqliteMemoryStore(db, new CountingEmbed('ollama:x')).backfillEmbeddings({
      batchSize: 16,
    })
    const localSqls = sqls.splice(0)
    new SqliteMemoryStore(db).hasFactsEmbeddedBy('ollama:')
    spy.mockRestore()
    const plan = (sql: string) => {
      const params = Array.from({ length: (sql.match(/\?/g) ?? []).length }, () => 1)
      return (
        db.$client.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...params) as { detail: string }[]
      )
        .map((r) => r.detail)
        .join(' | ')
    }
    const paged = (list: string[]) => list.filter((q) => q.includes('"created_at" <='))
    expect(paged(remoteSqls).length).toBeGreaterThan(0)
    expect(paged(localSqls).length).toBeGreaterThan(0)
    for (const q of [...paged(remoteSqls), ...paged(localSqls)]) {
      expect(plan(q)).toMatch(
        /^SEARCH memory_facts USING (COVERING )?INDEX idx_memory_facts_(created|model_created) \([^)]*created_at</,
      )
    }
    const lookup = sqls.find((q) => q.includes('"embedding_model" >='))!
    expect(plan(lookup)).toMatch(
      /SEARCH memory_facts USING COVERING INDEX idx_memory_facts_model_created/,
    )
  })

  it('keeps full-text search intact: the update trigger re-indexes, never duplicates', async () => {
    await seedUnindexed(3)
    const store = new SqliteMemoryStore(db, new CountingEmbed())
    await store.backfillEmbeddings()
    const hits = await store.searchMemory('release', { mode: 'fts' })
    expect(hits).toHaveLength(3)
    const ftsRows = db.$client.prepare('SELECT COUNT(*) AS n FROM memory_facts_fts').get() as {
      n: number
    }
    expect(ftsRows.n).toBe(3)
  })
})

describe('storeAllowsRemoteEmbedding', () => {
  it('allows a remote provider until the store has a local vector', async () => {
    expect(storeAllowsRemoteEmbedding(db)).toBe(true)
    await new SqliteMemoryStore(db, new CountingEmbed('ollama:nomic-embed-text')).saveFact({
      title: 't',
      content: 'c',
    })
    expect(storeAllowsRemoteEmbedding(db)).toBe(false)
  })

  it("then only on the user's choice, which the dashboard withdraws when Ollama returns", async () => {
    await new SqliteMemoryStore(db, new CountingEmbed('ollama:nomic-embed-text')).saveFact({
      title: 't',
      content: 'c',
    })
    setSetting(db, REMOTE_EMBEDDING_CONSENT_SETTING, '1')
    expect(storeAllowsRemoteEmbedding(db)).toBe(true)
    setSetting(db, REMOTE_EMBEDDING_CONSENT_SETTING, '0')
    expect(storeAllowsRemoteEmbedding(db)).toBe(false)
  })

  it('stays local-first once a local vector was ever written, even after every one is replaced', async () => {
    const store = new SqliteMemoryStore(db, new CountingEmbed('ollama:nomic-embed-text'))
    await store.saveFact({ title: 't', content: 'c' })
    expect(getSetting(db, LOCAL_FIRST_SETTING)).toBe('1')
    // A switch to OpenAI replaces every local vector.
    await new SqliteMemoryStore(db, new CountingEmbed('openai:x')).backfillEmbeddings()
    expect(new SqliteMemoryStore(db).hasFactsEmbeddedBy('ollama:')).toBe(false)
    expect(storeAllowsRemoteEmbedding(db)).toBe(false)
  })

  it('records local-first when the backfill, not a save, writes the first local vector', async () => {
    await seedUnindexed(2)
    await new SqliteMemoryStore(
      db,
      new CountingEmbed('ollama:nomic-embed-text'),
    ).backfillEmbeddings()
    expect(getSetting(db, LOCAL_FIRST_SETTING)).toBe('1')
  })

  it('a remote provider never marks the store local-first', async () => {
    await new SqliteMemoryStore(db, new CountingEmbed('openai:x')).saveFact({
      title: 't',
      content: 'c',
    })
    expect(getSetting(db, LOCAL_FIRST_SETTING)).toBeNull()
    expect(storeAllowsRemoteEmbedding(db)).toBe(true)
  })
})

describe('storeIsLocalFirst', () => {
  it('recognises a store indexed before the flag existed, and records it', async () => {
    await new SqliteMemoryStore(db, new CountingEmbed('ollama:nomic-embed-text')).saveFact({
      title: 't',
      content: 'c',
    })
    db.$client.prepare('DELETE FROM settings WHERE key = ?').run(LOCAL_FIRST_SETTING)
    expect(storeIsLocalFirst(db)).toBe(true)
    expect(getSetting(db, LOCAL_FIRST_SETTING)).toBe('1')
  })

  it('records it before a remote re-embed replaces the last local vector', async () => {
    await new SqliteMemoryStore(db, new CountingEmbed('ollama:nomic-embed-text')).saveFact({
      title: 't',
      content: 'c',
    })
    db.$client.prepare('DELETE FROM settings WHERE key = ?').run(LOCAL_FIRST_SETTING)
    await new SqliteMemoryStore(db, new CountingEmbed('openai:x')).backfillEmbeddings()
    expect(new SqliteMemoryStore(db).hasFactsEmbeddedBy('ollama:')).toBe(false)
    expect(storeIsLocalFirst(db)).toBe(true)
  })

  it('is false for a store that has only ever had remote vectors', async () => {
    await new SqliteMemoryStore(db, new CountingEmbed('openai:x')).saveFact({
      title: 't',
      content: 'c',
    })
    expect(storeIsLocalFirst(db)).toBe(false)
  })
})

describe('noteEmbeddingProviderServing', () => {
  it('withdraws a choice of OpenAI once Ollama serves, in whichever process resolved it', () => {
    setSetting(db, REMOTE_EMBEDDING_CONSENT_SETTING, '1')
    expect(noteEmbeddingProviderServing(db, 'openai:text-embedding-3-small')).toBe(false)
    expect(getSetting(db, REMOTE_EMBEDDING_CONSENT_SETTING)).toBe('1')
    expect(noteEmbeddingProviderServing(db, 'ollama:nomic-embed-text')).toBe(true)
    expect(getSetting(db, REMOTE_EMBEDDING_CONSENT_SETTING)).toBe('0')
    expect(noteEmbeddingProviderServing(db, 'ollama:nomic-embed-text')).toBe(false)
  })
})
