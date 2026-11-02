// The ChatGPT-subscription model list. The parsers and the source choice are pure;
// the probe runs a REAL child process (a fake `codex app-server` written as a node
// script and spawned through process.execPath, so it runs on every OS) to cover the
// JSON-RPC handshake, paging, the stderr classification and the reap.

import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import {
  classifyProbeStderr,
  combineCodexModelSources,
  parseAppServerModels,
  parseModelsCache,
  parseUserAgentVersion,
  probeCodexAppServer,
  readCodexModelsCache,
  type AppServerProbe,
} from '../codexModels'

// The two lines codex 0.136 logs when the backend's list uses a reasoning level it
// predates (captured live, 2026-10-22).
const OLD_CLI_STDERR = [
  'ERROR codex_models_manager::cache: failed to load models cache: unknown variant `max`',
  'ERROR codex_models_manager::manager: failed to refresh available models: stream disconnected before completion: failed to decode models response: unknown variant `max`',
].join('\n')

const model = (id: string, extra: Record<string, unknown> = {}) => ({
  id,
  model: id,
  displayName: id.toUpperCase(),
  hidden: false,
  isDefault: false,
  ...extra,
})

describe('parseAppServerModels', () => {
  it('keeps visible models in order, labels them, and reads the marked default', () => {
    expect(
      parseAppServerModels({
        data: [
          model('gpt-6-astra', { isDefault: true }),
          model('gpt-reserve', { hidden: true }),
          model('gpt-5.6-luna', { displayName: '' }),
          model('gpt-6-astra'),
        ],
      }),
    ).toEqual({
      models: [
        { id: 'gpt-6-astra', label: 'GPT-6-ASTRA' },
        { id: 'gpt-5.6-luna', label: 'gpt-5.6-luna' },
      ],
      defaultModel: 'gpt-6-astra',
    })
  })

  it('marks no default when the page marks none, and tolerates junk', () => {
    expect(parseAppServerModels({ data: [model('a')] }).defaultModel).toBeNull()
    expect(parseAppServerModels(null)).toEqual({ models: [], defaultModel: null })
    expect(parseAppServerModels({ data: [null, 3, { hidden: false }] }).models).toEqual([])
  })
})

describe('parseModelsCache', () => {
  it('orders visible models by priority; the first is the default', () => {
    expect(
      parseModelsCache({
        models: [
          { slug: 'gpt-5.6-luna', display_name: 'GPT-5.6-Luna', visibility: 'list', priority: 9 },
          { slug: 'codex-auto-review', visibility: 'hide', priority: 1 },
          { slug: 'gpt-6-astra', display_name: 'GPT-6-Astra', visibility: 'list', priority: 2 },
          { slug: 'no-priority', visibility: 'list' },
        ],
      }),
    ).toEqual({
      models: [
        { id: 'gpt-6-astra', label: 'GPT-6-Astra' },
        { id: 'gpt-5.6-luna', label: 'GPT-5.6-Luna' },
        { id: 'no-priority', label: 'no-priority' },
      ],
      defaultModel: 'gpt-6-astra',
    })
  })

  it('is empty for anything that is not a cache', () => {
    expect(parseModelsCache([])).toEqual({ models: [], defaultModel: null })
    expect(parseModelsCache({ models: 'x' })).toEqual({ models: [], defaultModel: null })
  })
})

describe('parseUserAgentVersion', () => {
  it('reads the CLI version from the initialize userAgent', () => {
    expect(parseUserAgentVersion('clawboo/0.158.0-alpha.2 (Mac OS 26.3.1; arm64) x')).toBe(
      '0.158.0-alpha.2',
    )
    expect(parseUserAgentVersion('clawboo/0.136.0')).toBe('0.136.0')
    expect(parseUserAgentVersion(undefined)).toBeNull()
    expect(parseUserAgentVersion('no-version-here')).toBeNull()
  })
})

describe('classifyProbeStderr', () => {
  it('flags an old CLI that cannot decode the account list', () => {
    expect(classifyProbeStderr(OLD_CLI_STDERR)).toEqual({
      refreshFailed: true,
      decodeFailed: true,
    })
  })

  it('tells an offline refresh failure apart from an old CLI', () => {
    expect(
      classifyProbeStderr('ERROR failed to refresh available models: error sending request'),
    ).toEqual({ refreshFailed: true, decodeFailed: false })
    expect(classifyProbeStderr('')).toEqual({ refreshFailed: false, decodeFailed: false })
  })
})

describe('combineCodexModelSources', () => {
  const live = [{ id: 'gpt-6-astra', label: 'GPT-6-Astra' }]
  const shipped = [{ id: 'gpt-5.5', label: 'GPT-5.5' }]
  const cache = {
    models: [{ id: 'gpt-5.6-luna', label: 'GPT-5.6-Luna' }],
    defaultModel: 'gpt-5.6-luna',
  }
  const probe = (over: Partial<AppServerProbe>): AppServerProbe => ({
    models: live,
    defaultModel: 'gpt-6-astra',
    version: '0.158.0',
    refreshFailed: false,
    decodeFailed: false,
    ...over,
  })

  it('trusts a refreshed CLI answer over the cache', () => {
    expect(combineCodexModelSources(probe({}), cache)).toEqual({
      models: live,
      defaultModel: 'gpt-6-astra',
      source: 'cli',
      updateRequired: false,
      cliVersion: '0.158.0',
    })
  })

  it('never offers an old CLI shipped catalog: cache instead, flagged updateRequired', () => {
    const old = probe({
      models: shipped,
      defaultModel: 'gpt-5.5',
      version: '0.136.0',
      refreshFailed: true,
      decodeFailed: true,
    })
    expect(combineCodexModelSources(old, cache)).toEqual({
      ...cache,
      source: 'cache',
      updateRequired: true,
      cliVersion: '0.136.0',
    })
    expect(combineCodexModelSources(old, null)).toEqual({
      models: [],
      defaultModel: null,
      source: null,
      updateRequired: true,
      cliVersion: '0.136.0',
    })
  })

  it('an offline CLI that reads the current format falls back to its catalog after the cache', () => {
    const offline = probe({ refreshFailed: true })
    expect(combineCodexModelSources(offline, cache).source).toBe('cache')
    expect(combineCodexModelSources(offline, null)).toMatchObject({
      source: 'cli',
      defaultModel: 'gpt-6-astra',
      updateRequired: false,
    })
  })

  it('no CLI: the cache, else nothing', () => {
    expect(combineCodexModelSources(null, cache).source).toBe('cache')
    expect(combineCodexModelSources(null, null)).toEqual({
      models: [],
      defaultModel: null,
      source: null,
      updateRequired: false,
      cliVersion: null,
    })
  })
})

describe('readCodexModelsCache', () => {
  let dir: string
  beforeAll(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), 'clawboo-codex-cache-'))
  })
  afterAll(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  it('reads the CLI cache, and is null when absent or unreadable', async () => {
    expect(await readCodexModelsCache(dir)).toBeNull()
    await writeFile(path.join(dir, 'models_cache.json'), '{not json')
    expect(await readCodexModelsCache(dir)).toBeNull()
    await writeFile(
      path.join(dir, 'models_cache.json'),
      JSON.stringify({ models: [{ slug: 'gpt-6-sol', visibility: 'list', priority: 4 }] }),
    )
    expect(await readCodexModelsCache(dir)).toEqual({
      models: [{ id: 'gpt-6-sol', label: 'gpt-6-sol' }],
      defaultModel: 'gpt-6-sol',
    })
  })
})

// A fake `codex app-server`: answers initialize, then serves `model/list` in pages
// of one model. FAKE_MODE switches the misbehaviours under test.
const FAKE_SERVER = `
const mode = process.env.FAKE_MODE || 'ok'
const pages = [
  [{ id: 'gpt-6-astra', model: 'gpt-6-astra', displayName: 'GPT-6-Astra', hidden: false, isDefault: false }],
  [{ id: 'gpt-6-sol', model: 'gpt-6-sol', displayName: 'GPT-6-Sol', hidden: false, isDefault: true }],
]
if (mode === 'old') process.stderr.write(${JSON.stringify(OLD_CLI_STDERR)} + '\\n')
if (mode === 'exit') process.exit(3)
let buf = ''
process.stdin.on('data', (d) => {
  buf += d
  let i
  while ((i = buf.indexOf('\\n')) >= 0) {
    const msg = JSON.parse(buf.slice(0, i))
    buf = buf.slice(i + 1)
    const reply = (o) => process.stdout.write(JSON.stringify(o) + '\\n')
    if (msg.method === 'initialize') {
      reply({ id: msg.id, result: { userAgent: 'clawboo/0.163.0 (test)' } })
      reply({ method: 'remoteControl/status/changed', params: {} })
    } else if (msg.method === 'model/list') {
      if (mode === 'hang') continue
      if (mode === 'error') { reply({ id: msg.id, error: { code: -32600, message: 'nope' } }); continue }
      const page = msg.params.cursor === 'p2' ? 1 : 0
      reply({ id: msg.id, result: { data: pages[page], nextCursor: page === 0 ? 'p2' : null } })
    }
  }
})
`

describe('probeCodexAppServer', () => {
  let dir: string
  let script: string
  beforeAll(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), 'clawboo-fake-codex-'))
    script = path.join(dir, 'fake-app-server.cjs')
    await writeFile(script, FAKE_SERVER)
  })
  afterAll(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  const run = (mode: string, timeoutMs?: number) =>
    probeCodexAppServer(
      { command: process.execPath, args: [script] },
      { ...process.env, FAKE_MODE: mode },
      timeoutMs,
    )

  it('pages through model/list and keeps the marked default', async () => {
    expect(await run('ok')).toEqual({
      models: [
        { id: 'gpt-6-astra', label: 'GPT-6-Astra' },
        { id: 'gpt-6-sol', label: 'GPT-6-Sol' },
      ],
      defaultModel: 'gpt-6-sol',
      version: '0.163.0',
      refreshFailed: false,
      decodeFailed: false,
    })
  })

  it('reports an old CLI from its stderr log', async () => {
    expect(await run('old')).toMatchObject({ refreshFailed: true, decodeFailed: true })
  })

  it('is null on an error reply, an early exit, or a hang', async () => {
    expect(await run('error')).toBeNull()
    expect(await run('exit')).toBeNull()
    expect(await run('hang', 500)).toBeNull()
  })

  it('is null when the binary does not exist', async () => {
    expect(
      await probeCodexAppServer(
        { command: path.join(dir, 'no-such-codex'), args: ['app-server'] },
        process.env,
      ),
    ).toBeNull()
  })

  // Last in the file: the shutdown sweep marks the registry as shutting down.
  it('is reaped by the server shutdown sweep, so a probe never outlives the server', async () => {
    const { killLiveSubprocesses } = await import('../subprocess')
    const pending = run('hang', 10_000)
    await new Promise((r) => setTimeout(r, 300))
    expect(killLiveSubprocesses()).toBeGreaterThanOrEqual(1)
    // The killed CLI ends the probe at once, well before its own 10 s limit.
    const started = Date.now()
    expect(await pending).toBeNull()
    expect(Date.now() - started).toBeLessThan(5_000)
  })
})
