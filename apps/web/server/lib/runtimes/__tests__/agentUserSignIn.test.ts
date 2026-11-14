// The agents' own sign-in with agents on their own OS user (CLAWBOO_AGENT_USER):
// the in-app login runs as the agent user, so its login is in that user's own
// ~/.codex and ~/.hermes. A run home is seeded from it and from nothing else: the
// person's own login and Hermes config are never copied into agent space, where
// any agent could read them, and they do not count as connected. A run with
// neither the agents' login nor an API key fails saying so. Driven against an
// in-process host whose reported home is a temp folder; HOME (the person's) is a
// temp folder too. In its own file because `vi.mock` is file-global.

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { RemoteSpawnOptions } from '../../agentUser/client'
import { setActiveAgentHost } from '../../agentUser/state'
import { startInProcessHost, type InProcessHost } from '../../agentUser/__tests__/inProcessHost'

const bins = vi.hoisted(() => ({ map: {} as Record<string, string> }))
vi.mock('../../platform', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../platform')>()),
  resolveRuntimeBin: (name: string) => bins.map[name] ?? null,
}))

const { CODEX_AGENT_SIGN_IN_MESSAGE, createCodexDriver, prepareCodexHome, seedCodexAuth } =
  await import('../codexDriver')
const { invalidateCodexAuthCache, isCodexLoggedIn } = await import('../codexAuth')
const { getCodexModels, invalidateCodexModelsCache } = await import('../codexModels')
const { isHermesCodexAuthPresent } = await import('../hermesAuth')
const { HERMES_AGENT_SIGN_IN_MESSAGE, createHermesDriver, resolveHermesRun } =
  await import('../hermesDriver')
const { provisionHermesHome, seedHermesAuth } = await import('../hermesHome')

const posix = process.platform !== 'win32'

let tmp: string
let agentHome: string
let operatorHome: string
let runHome: string
let active: InProcessHost | null = null
let spawns: RemoteSpawnOptions[] = []
let reads: string[] = []

const codexLogin = (token: string): string =>
  JSON.stringify({ tokens: { access_token: token, refresh_token: 'r' } })
const hermesLogin = (token: string): string =>
  JSON.stringify({ credential_pool: { 'openai-codex': [{ access_token: token }] } })

function put(file: string, body: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, body)
}

beforeEach(async () => {
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'agent-sign-in-')))
  agentHome = path.join(tmp, 'agent')
  operatorHome = path.join(tmp, 'operator')
  runHome = path.join(agentHome, 'runtimes', 'codex', 'a1')
  fs.mkdirSync(runHome, { recursive: true, mode: 0o700 })
  fs.mkdirSync(operatorHome)
  vi.stubEnv('HOME', operatorHome)
  vi.stubEnv('CODEX_HOME', undefined)
  vi.stubEnv('HERMES_HOME', undefined)
  vi.stubEnv('CLAWBOO_AGENT_USER', 'clawboo-agent')
  const h = startInProcessHost()
  active = h
  const hello = await h.client.waitForHello()
  setActiveAgentHost({
    client: h.client,
    hello: { ...hello, home: agentHome },
    config: { user: 'clawboo-agent', switch: 'sudo', socket: null },
  })
  spawns = []
  reads = []
  const spawn = h.client.spawn.bind(h.client)
  vi.spyOn(h.client, 'spawn').mockImplementation((o) => {
    spawns.push(o)
    return spawn(o)
  })
  const request = h.client.request.bind(h.client)
  vi.spyOn(h.client, 'request').mockImplementation((r, opts) => {
    if (r.op === 'fs.read') reads.push(r.path)
    return request(r, opts)
  })
  bins.map = {}
  invalidateCodexModelsCache()
})

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
  setActiveAgentHost(null)
  active?.client.close()
  active = null
  invalidateCodexModelsCache()
  fs.rmSync(tmp, { recursive: true, force: true })
})

describe.runIf(posix)('seeding a run home with agents on their own OS user', () => {
  it("seeds Codex from the agent user's own login, read through the host", async () => {
    put(path.join(operatorHome, '.codex', 'auth.json'), codexLogin('person'))
    put(path.join(agentHome, '.codex', 'auth.json'), codexLogin('agents'))
    await seedCodexAuth(runHome)
    expect(fs.readFileSync(path.join(runHome, 'auth.json'), 'utf8')).toBe(codexLogin('agents'))
    expect(reads).toContain(path.join(agentHome, '.codex', 'auth.json'))
  })

  it("never copies the person's own Codex login into agent space", async () => {
    put(path.join(operatorHome, '.codex', 'auth.json'), codexLogin('person'))
    await seedCodexAuth(runHome)
    expect(fs.existsSync(path.join(runHome, 'auth.json'))).toBe(false)
  })

  it("seeds Hermes from the agent user's own login, read through the host", async () => {
    const home = path.join(agentHome, 'runtimes', 'hermes', 'a1')
    fs.mkdirSync(home, { recursive: true, mode: 0o700 })
    put(path.join(operatorHome, '.hermes', 'auth.json'), hermesLogin('person'))
    put(path.join(agentHome, '.hermes', 'auth.json'), hermesLogin('agents'))
    expect(await seedHermesAuth(home)).toBe(true)
    expect(fs.readFileSync(path.join(home, 'auth.json'), 'utf8')).toBe(hermesLogin('agents'))
    expect(reads).toContain(path.join(agentHome, '.hermes', 'auth.json'))
  })

  it("never copies the person's own Hermes login into agent space", async () => {
    const home = path.join(agentHome, 'runtimes', 'hermes', 'a1')
    fs.mkdirSync(home, { recursive: true, mode: 0o700 })
    put(path.join(operatorHome, '.hermes', 'auth.json'), hermesLogin('person'))
    expect(await seedHermesAuth(home)).toBe(false)
    expect(fs.existsSync(path.join(home, 'auth.json'))).toBe(false)
  })

  it("never copies the person's Hermes config (it can hold a provider's api_key)", async () => {
    put(
      path.join(operatorHome, '.hermes', 'config.yaml'),
      'providers:\n  mine:\n    api_key: sk-person-secret\n',
    )
    const home = path.join(agentHome, 'runtimes', 'hermes', 'a1')
    const out = await provisionHermesHome(home, {
      mcpServers: { 'clawboo-tasks': { url: 'http://127.0.0.1:9/api/mcp/tasks' } },
    })
    expect(out.seededConfig).toBe(false)
    expect(fs.readFileSync(path.join(home, 'config.yaml'), 'utf8')).not.toContain(
      'sk-person-secret',
    )
  })

  it('copies no login at all into a run that has an API key', async () => {
    put(path.join(agentHome, '.codex', 'auth.json'), codexLogin('agents'))
    put(path.join(agentHome, '.hermes', 'auth.json'), hermesLogin('agents'))
    await prepareCodexHome({ homeDir: runHome, apiKeyEnv: { OPENAI_API_KEY: 'sk-test' } })
    expect(fs.existsSync(path.join(runHome, 'auth.json'))).toBe(false)
    const home = path.join(agentHome, 'runtimes', 'hermes', 'a1')
    const out = await provisionHermesHome(home, { hasApiKey: true })
    expect(out.seededAuth).toBe(false)
    expect(fs.existsSync(path.join(home, 'auth.json'))).toBe(false)
  })
})

describe.runIf(posix)('a run with neither the agents login nor an API key', () => {
  it('fails a Codex run saying why, even with the person signed in', async () => {
    put(path.join(operatorHome, '.codex', 'auth.json'), codexLogin('person'))
    await expect(prepareCodexHome({ homeDir: runHome })).rejects.toThrow(
      CODEX_AGENT_SIGN_IN_MESSAGE,
    )
    // A reviewer run (a throwaway home) too.
    await expect(prepareCodexHome({})).rejects.toThrow(CODEX_AGENT_SIGN_IN_MESSAGE)
  })

  it('fails a Hermes subscription run saying why, even with the person signed in', async () => {
    put(path.join(operatorHome, '.hermes', 'auth.json'), hermesLogin('person'))
    const home = path.join(agentHome, 'runtimes', 'hermes', 'a1')
    const provisioned = await provisionHermesHome(home)
    for (const providerHint of ['openai-codex', null]) {
      await expect(
        resolveHermesRun(
          { agentId: 'a1', sessionKey: 'agent:a1:team:t1', message: 'go' },
          { providerHint },
          provisioned,
        ),
      ).rejects.toThrow(HERMES_AGENT_SIGN_IN_MESSAGE)
    }
  })

  it("ends each driver's run with that message, and starts nothing", async () => {
    const opts = { agentId: 'a1', sessionKey: 'agent:a1:team:t1', message: 'go' }
    const results: Array<{ type: string; errorMessage?: string }> = []
    const codex = createCodexDriver(opts, { homeDir: runHome })
    codex.onEvent((ev) => results.push(ev as { type: string; errorMessage?: string }))
    await codex.start()
    const hermes = createHermesDriver(opts, {
      homeDir: path.join(agentHome, 'runtimes', 'hermes', 'a1'),
    })
    hermes.onEvent((ev) => results.push(ev as { type: string; errorMessage?: string }))
    await hermes.start()
    const errors = results.filter((e) => e.type === 'result').map((e) => e.errorMessage)
    expect(errors).toEqual([CODEX_AGENT_SIGN_IN_MESSAGE, HERMES_AGENT_SIGN_IN_MESSAGE])
    expect(spawns).toHaveLength(0)
  })

  it.each(['GEMINI_API_KEY', 'GOOGLE_API_KEY'])(
    'lets a Hermes run on an ambient %s go on, and still refuses a Codex pick with no key',
    async (name) => {
      for (const k of ['OPENROUTER_API_KEY', 'ANTHROPIC_API_KEY', 'OPENAI_API_KEY']) {
        vi.stubEnv(k, undefined)
      }
      vi.stubEnv('GEMINI_API_KEY', undefined)
      vi.stubEnv('GOOGLE_API_KEY', undefined)
      const home = path.join(agentHome, 'runtimes', 'hermes', 'a1')
      const provisioned = await provisionHermesHome(home)
      const opts = { agentId: 'a1', sessionKey: 'agent:a1:team:t1', message: 'go' }
      await expect(
        resolveHermesRun(opts, { providerHint: 'openai-codex' }, provisioned),
      ).rejects.toThrow(HERMES_AGENT_SIGN_IN_MESSAGE)

      vi.stubEnv(name, 'g-test-key')
      // Hermes's `auto` picks Gemini from it.
      const run = await resolveHermesRun(opts, {}, provisioned)
      expect(run.providerFlag).toBeNull()
    },
  )

  it('lets a Hermes run with a provider key go on', async () => {
    const home = path.join(agentHome, 'runtimes', 'hermes', 'a1')
    const provisioned = await provisionHermesHome(home, { hasApiKey: true })
    const run = await resolveHermesRun(
      { agentId: 'a1', sessionKey: 'agent:a1:team:t1', message: 'go' },
      { apiKeyEnv: { OPENROUTER_API_KEY: 'sk-or-test' } },
      provisioned,
    )
    expect(run.providerFlag).toBe('openrouter')
  })
})

describe.runIf(posix)('what counts as signed in with agents on their own OS user', () => {
  it("counts only the agents' own Codex login, never the person's", async () => {
    // The person's own `codex login status` says they are signed in.
    const bin = path.join(tmp, 'codex')
    fs.writeFileSync(bin, '#!/bin/sh\necho "Logged in using ChatGPT"\n', { mode: 0o755 })
    bins.map['codex'] = bin
    invalidateCodexAuthCache()
    expect(await isCodexLoggedIn()).toBe(false)
    put(path.join(agentHome, '.codex', 'auth.json'), codexLogin('agents'))
    invalidateCodexAuthCache()
    expect(await isCodexLoggedIn()).toBe(true)
    invalidateCodexAuthCache()
  })

  it("never counts the person's own Hermes login", () => {
    put(path.join(operatorHome, '.hermes', 'auth.json'), hermesLogin('person'))
    expect(isHermesCodexAuthPresent()).toBe(false)
  })
})

// A `codex app-server` that answers `initialize` and one `model/list` page; any
// other subcommand (`login status`) exits at once.
const FAKE_CODEX = String.raw`
if (process.argv[2] !== 'app-server') process.exit(0)
let buf = ''
const send = (m) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...m }) + '\n')
process.stdin.on('data', (d) => {
  buf += d.toString()
  let nl
  while ((nl = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, nl)
    buf = buf.slice(nl + 1)
    if (!line.trim()) continue
    const m = JSON.parse(line)
    if (m.method === 'initialize') send({ id: m.id, result: { userAgent: 'codex_cli_rs/0.200.0' } })
    else if (m.method === 'model/list') send({ id: m.id, result: { data: [{ model: 'gpt-agents', displayName: 'Agents model', isDefault: true }] } })
  }
})
`

function fakeCodex(): void {
  const script = path.join(tmp, 'fake-codex.cjs')
  fs.writeFileSync(script, FAKE_CODEX)
  const bin = path.join(tmp, 'codex')
  fs.writeFileSync(bin, `#!/bin/sh\nexec "${process.execPath}" "${script}" "$@"\n`, {
    mode: 0o755,
  })
  bins.map['codex'] = bin
}

const cache = (slug: string): string =>
  JSON.stringify({ models: [{ slug, display_name: slug, priority: 1 }] })

describe.runIf(posix)('the Codex model list with agents on their own OS user', () => {
  it("probes as the agent user in the agents' own Codex home", async () => {
    fakeCodex()
    put(path.join(agentHome, '.codex', 'auth.json'), codexLogin('agents'))
    const list = await getCodexModels()
    expect(spawns).toHaveLength(1)
    expect(spawns[0]?.env['CODEX_HOME']).toBe(path.join(agentHome, '.codex'))
    expect(list).toMatchObject({ source: 'cli', defaultModel: 'gpt-agents' })
  })

  it("reads the agents' own cache, never the person's", async () => {
    put(path.join(operatorHome, '.codex', 'models_cache.json'), cache('gpt-person'))
    put(path.join(agentHome, '.codex', 'models_cache.json'), cache('gpt-agents-cached'))
    expect(await getCodexModels()).toMatchObject({
      source: 'cache',
      defaultModel: 'gpt-agents-cached',
    })
    expect(reads).toContain(path.join(agentHome, '.codex', 'models_cache.json'))

    fs.rmSync(path.join(agentHome, '.codex', 'models_cache.json'))
    invalidateCodexModelsCache()
    expect(await getCodexModels()).toMatchObject({ source: null, models: [] })
    // Nothing ran: the agents hold no login to probe with.
    expect(spawns).toHaveLength(0)
  })
})
