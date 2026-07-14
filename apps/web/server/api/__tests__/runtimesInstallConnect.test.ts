// Runtime install / connect / disconnect / status REST. Sandboxes CLAWBOO_HOME
// (clawboo's own dir → fresh DB + secrets vault per test). Mocks the
// `node:child_process` spawn (assert install argv + drive close),
// `../../lib/platform` (control which bins "exist"), and
// `../../lib/executorRunner` (spy the run path for the apiKeyEnv-wiring proof).
// Asserts: npm/pip install argv + PEP-668 retry, connect writes the vault and
// NEVER echoes the key, codex's no-op needs-login, disconnect, the status shape +
// connectionState matrix, and that a connected key reaches the run ctx.

import { mkdtempSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import type { Request, Response } from 'express'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// ── Mock platform: control which CLI bins are "installed". ───────────────────
const platformState = vi.hoisted(() => ({ bins: {} as Record<string, string | null> }))
vi.mock('../../lib/platform', () => ({
  isWindows: false,
  resolveShimName: (n: string) => n,
  resolveRuntimeBin: (n: string) => platformState.bins[n] ?? null,
  findExecutable: (n: string) => platformState.bins[n] ?? null,
}))

// ── Mock the Codex login probe (real impl shells out to `codex login status`). ─
const codexAuthState = vi.hoisted(() => ({ loggedIn: false }))
vi.mock('../../lib/runtimes/codexAuth', () => ({
  isCodexLoggedIn: () => Promise.resolve(codexAuthState.loggedIn),
  userCodexHome: () => '/nonexistent',
  userCodexAuthPath: () => '/nonexistent/auth.json',
  invalidateCodexAuthCache: () => {},
}))

// ── Mock the process spawner: record argv + hand back a controllable child. ──
interface FakeChild {
  killed: boolean
  kill: () => void
  stdout: { on: (e: string, h: (c: Buffer) => void) => void }
  stderr: { on: (e: string, h: (c: Buffer) => void) => void }
  on: (e: string, h: (...a: unknown[]) => void) => FakeChild
  emitClose: (code: number) => void
  emitStderr: (text: string) => void
}
const spawnState = vi.hoisted(() => ({
  calls: [] as { cmd: string; args: string[] }[],
  children: [] as unknown[],
}))
vi.mock('node:child_process', () => {
  const makeChild = (): FakeChild => {
    const onClose: ((code: number) => void)[] = []
    const onErr: ((c: Buffer) => void)[] = []
    const child: FakeChild = {
      killed: false,
      kill() {
        this.killed = true
      },
      stdout: { on: () => {} },
      stderr: {
        on: (e, h) => {
          if (e === 'data') onErr.push(h)
        },
      },
      on(e, h) {
        if (e === 'close') onClose.push(h as (code: number) => void)
        return this
      },
      emitClose(code) {
        for (const h of onClose) h(code)
      },
      emitStderr(text) {
        for (const h of onErr) h(Buffer.from(text))
      },
    }
    return child
  }
  return {
    spawn: (cmd: string, args: string[]) => {
      spawnState.calls.push({ cmd, args })
      const child = makeChild()
      spawnState.children.push(child)
      return child
    },
  }
})

// ── Spy the executor runner (apiKeyEnv-wiring proof). ────────────────────────
const runnerState = vi.hoisted(() => ({ lastInput: null as Record<string, unknown> | null }))
vi.mock('../../lib/executorRunner', () => ({
  runTaskOnRuntime: vi.fn(async (input: Record<string, unknown>) => {
    runnerState.lastInput = input
    return { ok: true, taskId: input['taskId'] }
  }),
}))

import {
  runtimesConnectPOST,
  runtimesDisconnectPOST,
  runtimesHealthcheckPOST,
  runtimesInstallPOST,
  runtimesListGET,
  runtimesRunPOST,
} from '../runtimes'
import { hasRuntimeSecret } from '../../lib/secretsVault'

interface Mock {
  res: Response
  statusCode: () => number
  body: () => unknown
  events: () => Record<string, unknown>[]
  ended: Promise<void>
}
function mockRes(): Mock {
  let code = 200
  let payload: unknown
  const events: Record<string, unknown>[] = []
  let resolveEnd!: () => void
  const ended = new Promise<void>((r) => (resolveEnd = r))
  const res = {
    status(c: number) {
      code = c
      return this
    },
    json(b: unknown) {
      payload = b
      resolveEnd()
      return this
    },
    setHeader() {
      return this
    },
    flushHeaders() {},
    write(s: string) {
      const m = s.match(/^data: (.*)\n\n$/s)
      if (m) events.push(JSON.parse(m[1]) as Record<string, unknown>)
      return true
    },
    end() {
      resolveEnd()
    },
    on() {
      return this
    },
  } as unknown as Response
  return { res, statusCode: () => code, body: () => payload, events: () => events, ended }
}
const req = (over: Partial<Request> = {}): Request =>
  ({
    params: {},
    query: {},
    body: {},
    get: () => 'localhost:18790',
    protocol: 'http',
    ...over,
  }) as unknown as Request

describe('runtimes install/connect REST', () => {
  let home: string
  let stateDir: string
  const prev: Record<string, string | undefined> = {}
  const SAVED = [
    'CLAWBOO_HOME',
    'OPENCLAW_STATE_DIR',
    'ANTHROPIC_API_KEY',
    'OPENROUTER_API_KEY',
    'OPENAI_API_KEY',
    'GROQ_API_KEY',
  ] as const

  beforeEach(() => {
    for (const k of SAVED) prev[k] = process.env[k]
    delete process.env['ANTHROPIC_API_KEY']
    delete process.env['OPENROUTER_API_KEY']
    delete process.env['OPENAI_API_KEY']
    delete process.env['GROQ_API_KEY']
    home = mkdtempSync(path.join(os.tmpdir(), 'clawboo-rt-rest-'))
    // Isolate the OpenClaw state dir too, so the resolveRuntimeKey `.env`
    // fallback can't read the dev box's real ~/.openclaw/.env provider keys.
    stateDir = mkdtempSync(path.join(os.tmpdir(), 'clawboo-rt-state-'))
    process.env['CLAWBOO_HOME'] = home
    process.env['OPENCLAW_STATE_DIR'] = stateDir
    platformState.bins = {}
    spawnState.calls = []
    spawnState.children = []
    runnerState.lastInput = null
    codexAuthState.loggedIn = false
  })
  afterEach(() => {
    for (const k of SAVED) {
      if (prev[k] === undefined) delete process.env[k]
      else process.env[k] = prev[k]
    }
    rmSync(home, { recursive: true, force: true })
    rmSync(stateDir, { recursive: true, force: true })
  })

  it('404s an unknown runtime id', () => {
    const m = mockRes()
    runtimesConnectPOST(req({ params: { id: 'nope' }, body: {} }), m.res)
    expect(m.statusCode()).toBe(404)
  })

  // ── supply chain: every installable runtime pins a version ───────────────────
  it('every non-builtin runtime descriptor pins its package version (no bare-latest)', async () => {
    const { RUNTIME_DESCRIPTORS } = await import('../../lib/runtimes/descriptor')
    for (const d of Object.values(RUNTIME_DESCRIPTORS)) {
      if (d.builtIn || d.pkg == null) continue
      // npm `name@<spec>` or pip `name<spec>` / `name==spec` — never a bare name.
      expect(d.pkg, `${d.id} pkg must be version-pinned`).toMatch(/(@[\^~]?\d|[<>=!~]=?\d)/)
    }
  })

  // ── install (npm) ──────────────────────────────────────────────────────────
  it('installs an npm runtime: spawns `npm install -g <pkg>`, completes', async () => {
    platformState.bins['npm'] = '/usr/bin/npm'
    platformState.bins['claude'] = '/usr/bin/claude' // present post-install
    const m = mockRes()
    runtimesInstallPOST(req({ params: { id: 'claude-code' } }), m.res)
    expect(spawnState.calls[0]).toEqual({
      cmd: 'npm',
      args: ['install', '-g', '@anthropic-ai/claude-code@2'],
    })
    ;(spawnState.children[0] as FakeChild).emitClose(0)
    await m.ended
    expect(m.events().some((e) => e['type'] === 'complete' && e['success'] === true)).toBe(true)
  })

  it('install reports NPM_MISSING when npm is absent (no spawn)', async () => {
    const m = mockRes()
    runtimesInstallPOST(req({ params: { id: 'codex' } }), m.res)
    await m.ended
    expect(m.events().some((e) => e['code'] === 'NPM_MISSING')).toBe(true)
    expect(spawnState.calls.length).toBe(0)
  })

  // ── install (pip / hermes) ──────────────────────────────────────────────────
  it('installs hermes via pipx when available', async () => {
    platformState.bins['pipx'] = '/usr/bin/pipx'
    platformState.bins['hermes'] = '/home/u/.local/bin/hermes'
    const m = mockRes()
    runtimesInstallPOST(req({ params: { id: 'hermes' } }), m.res)
    expect(spawnState.calls[0]).toEqual({
      cmd: '/usr/bin/pipx',
      args: ['install', 'hermes-agent[anthropic]<1'],
    })
    ;(spawnState.children[0] as FakeChild).emitClose(0)
    await m.ended
    expect(m.events().some((e) => e['type'] === 'complete' && e['success'] === true)).toBe(true)
  })

  it('hermes pip path retries with --break-system-packages on a PEP-668 env', async () => {
    platformState.bins['python3'] = '/usr/bin/python3' // no pipx; python present
    platformState.bins['hermes'] = '/home/u/.local/bin/hermes'
    const m = mockRes()
    runtimesInstallPOST(req({ params: { id: 'hermes' } }), m.res)
    expect(spawnState.calls[0]).toEqual({
      cmd: '/usr/bin/python3',
      args: ['-m', 'pip', 'install', '--user', 'hermes-agent[anthropic]<1'],
    })
    const first = spawnState.children[0] as FakeChild
    first.emitStderr('error: externally-managed-environment')
    first.emitClose(1)
    expect(spawnState.calls[1]).toEqual({
      cmd: '/usr/bin/python3',
      args: ['-m', 'pip', 'install', '--user', '--break-system-packages', 'hermes-agent[anthropic]<1'],
    })
    ;(spawnState.children[1] as FakeChild).emitClose(0)
    await m.ended
    expect(m.events().some((e) => e['type'] === 'complete' && e['success'] === true)).toBe(true)
  })

  it('hermes install reports PYTHON_MISSING when neither pipx nor python exist', async () => {
    const m = mockRes()
    runtimesInstallPOST(req({ params: { id: 'hermes' } }), m.res)
    await m.ended
    expect(m.events().some((e) => e['code'] === 'PYTHON_MISSING')).toBe(true)
    expect(spawnState.calls.length).toBe(0)
  })

  // ── connect / disconnect ────────────────────────────────────────────────────
  it('connect writes the vault and NEVER echoes the key', () => {
    platformState.bins['claude'] = '/usr/bin/claude'
    const m = mockRes()
    runtimesConnectPOST(
      req({ params: { id: 'claude-code' }, body: { apiKey: 'sk-ant-SECRET-NEVER-ECHOED' } }),
      m.res,
    )
    expect(m.statusCode()).toBe(200)
    expect(hasRuntimeSecret('ANTHROPIC_API_KEY')).toBe(true)
    expect((m.body() as { connectionState: string }).connectionState).toBe('ready')
    expect(JSON.stringify(m.body())).not.toContain('sk-ant-SECRET-NEVER-ECHOED')
  })

  it('connect 400s an empty api key for an api-key runtime', () => {
    const m = mockRes()
    runtimesConnectPOST(req({ params: { id: 'hermes' }, body: {} }), m.res)
    expect(m.statusCode()).toBe(400)
  })

  it('codex connect is a key-less no-op returning needs-login + the login command', async () => {
    platformState.bins['codex'] = '/usr/bin/codex'
    const m = mockRes()
    await runtimesConnectPOST(req({ params: { id: 'codex' }, body: {} }), m.res)
    expect(m.statusCode()).toBe(200)
    const body = m.body() as { connectionState: string; loginCommand: string }
    expect(body.connectionState).toBe('needs-login')
    expect(body.loginCommand).toBe('codex login')
  })

  it('codex REUSES an existing terminal login → ready (GET + connect)', async () => {
    platformState.bins['codex'] = '/usr/bin/codex'
    codexAuthState.loggedIn = true // `codex login` already run in the terminal

    // GET reflects the detected login.
    const list = mockRes()
    await runtimesListGET(req(), list.res)
    const codex = (list.body() as { runtimes: Record<string, unknown>[] }).runtimes.find(
      (r) => r['id'] === 'codex',
    )!
    expect(codex['loggedIn']).toBe(true)
    expect(codex['connectionState']).toBe('ready')

    // Connect reports 'ready' too (no re-login prompt).
    const c = mockRes()
    await runtimesConnectPOST(req({ params: { id: 'codex' }, body: {} }), c.res)
    expect((c.body() as { connectionState: string }).connectionState).toBe('ready')
  })

  it('disconnect clears the credential', () => {
    platformState.bins['hermes'] = '/home/u/.local/bin/hermes'
    runtimesConnectPOST(
      req({ params: { id: 'hermes' }, body: { apiKey: 'sk-or-x' } }),
      mockRes().res,
    )
    expect(hasRuntimeSecret('OPENROUTER_API_KEY')).toBe(true)
    const m = mockRes()
    runtimesDisconnectPOST(req({ params: { id: 'hermes' } }), m.res)
    expect(m.statusCode()).toBe(200)
    expect(hasRuntimeSecret('OPENROUTER_API_KEY')).toBe(false)
    expect((m.body() as { connectionState: string }).connectionState).toBe('needs-auth')
  })

  // ── GET status enrichment + connectionState matrix ──────────────────────────
  it('GET /api/runtimes lists all runtimes with install/auth status', async () => {
    platformState.bins['hermes'] = '/home/u/.local/bin/hermes' // installed, no key
    const m = mockRes()
    await runtimesListGET(req(), m.res)
    const data = m.body() as { runtimes: Record<string, unknown>[] }
    const hermes = data.runtimes.find((r) => r['id'] === 'hermes')!
    expect(hermes).toHaveProperty('participantKind')
    expect(hermes).toHaveProperty('capabilities')
    expect(hermes).toHaveProperty('health')
    expect(hermes['installed']).toBe(true)
    expect(hermes['authKind']).toBe('api-key')
    expect(hermes['envVar']).toBe('OPENROUTER_API_KEY')
    expect(hermes['hasCredential']).toBe(false)
    expect(hermes['connectionState']).toBe('needs-auth')
  })

  it('Hermes REUSES a connected Anthropic key (no second prompt)', async () => {
    // A native / Claude Code connect stores the Anthropic key in the shared vault.
    runtimesConnectPOST(
      req({ params: { id: 'claude-code' }, body: { apiKey: 'sk-ant-shared' } }),
      mockRes().res,
    )
    platformState.bins['hermes'] = '/home/u/.local/bin/hermes'
    const m = mockRes()
    await runtimesListGET(req(), m.res)
    const hermes = (m.body() as { runtimes: Record<string, unknown>[] }).runtimes.find(
      (r) => r['id'] === 'hermes',
    )!
    // Hermes routes across providers, so the already-connected Anthropic key
    // satisfies its credential check → 'ready', not a re-prompt.
    expect(hermes['hasCredential']).toBe(true)
    expect(hermes['connectionState']).toBe('ready')

    // …and the run path injects that reused key into the spawned Hermes env.
    const m2 = mockRes()
    await runtimesRunPOST(req({ params: { id: 'hermes' }, body: { taskId: 't-reuse' } }), m2.res)
    expect(
      (runnerState.lastInput?.['apiKeyEnv'] as Record<string, string>)?.['ANTHROPIC_API_KEY'],
    ).toBe('sk-ant-shared')
  })

  it('connectionState matrix: not-installed / needs-login(codex) reflected', async () => {
    let m = mockRes()
    await runtimesListGET(req(), m.res)
    let codex = (m.body() as { runtimes: Record<string, unknown>[] }).runtimes.find(
      (r) => r['id'] === 'codex',
    )!
    expect(codex['connectionState']).toBe('not-installed')
    platformState.bins['codex'] = '/usr/bin/codex'
    m = mockRes()
    await runtimesListGET(req(), m.res)
    codex = (m.body() as { runtimes: Record<string, unknown>[] }).runtimes.find(
      (r) => r['id'] === 'codex',
    )!
    expect(codex['connectionState']).toBe('needs-login')
  })

  // ── apiKeyEnv wiring into the run path ──────────────────────────────────────
  it('run path injects the connected key into apiKeyEnv (hermes); codex stays empty', async () => {
    platformState.bins['hermes'] = '/home/u/.local/bin/hermes'
    runtimesConnectPOST(
      req({ params: { id: 'hermes' }, body: { apiKey: 'or-runpath-key' } }),
      mockRes().res,
    )
    const m1 = mockRes()
    await runtimesRunPOST(req({ params: { id: 'hermes' }, body: { taskId: 't1' } }), m1.res)
    expect(
      (runnerState.lastInput?.['apiKeyEnv'] as Record<string, string>)?.['OPENROUTER_API_KEY'],
    ).toBe('or-runpath-key')

    runnerState.lastInput = null
    const m2 = mockRes()
    await runtimesRunPOST(req({ params: { id: 'codex' }, body: { taskId: 't2' } }), m2.res)
    expect(runnerState.lastInput?.['apiKeyEnv']).toBeUndefined()
  })

  // ── host-header injection: the runtime's MCP base URL must be loopback ───────
  it('builds mcpBaseUrl from the server port, ignoring a forged Host header', async () => {
    platformState.bins['hermes'] = '/home/u/.local/bin/hermes'
    runnerState.lastInput = null
    const m = mockRes()
    await runtimesRunPOST(
      req({
        params: { id: 'hermes' },
        body: { taskId: 'th' },
        get: (() => 'attacker.example:1234') as unknown as Request['get'],
        protocol: 'http',
        app: { locals: { apiPort: 18790 } } as unknown as Request['app'],
      }),
      m.res,
    )
    expect(runnerState.lastInput?.['mcpBaseUrl']).toBe('http://127.0.0.1:18790')
  })

  it('mcpBaseUrl is null (attach nothing) when the server port is unknown', async () => {
    platformState.bins['hermes'] = '/home/u/.local/bin/hermes'
    runnerState.lastInput = null
    const m = mockRes()
    await runtimesRunPOST(
      req({
        params: { id: 'hermes' },
        body: { taskId: 'th2' },
        get: (() => 'attacker.example') as unknown as Request['get'],
      }),
      m.res,
    )
    expect(runnerState.lastInput?.['mcpBaseUrl']).toBeNull()
  })

  // ── clawboo-native (built-in) ────────────────────────────────────────────────
  it('GET /api/runtimes includes the built-in native row (installed, no binary, runtimeClass native)', async () => {
    const m = mockRes()
    await runtimesListGET(req(), m.res)
    const data = m.body() as {
      runtimes: Record<string, unknown>[]
      available: Record<string, unknown>[]
    }
    const native = data.runtimes.find((r) => r['id'] === 'clawboo-native')!
    expect(native['installed']).toBe(true)
    expect(native['binPath']).toBeNull()
    expect(native['builtIn']).toBe(true)
    expect(native['authKind']).toBe('api-key')
    expect((native['capabilities'] as Record<string, unknown>)['runtimeClass']).toBe('native')
    // No key in the sandboxed vault — connected only once a key is pasted.
    expect(native['connectionState']).toBe('needs-auth')
    expect(data.available.some((d) => d['id'] === 'clawboo-native')).toBe(true)
  })

  it('native connect with a pasted key flips connectionState to ready (key never echoed)', () => {
    const m = mockRes()
    runtimesConnectPOST(
      req({ params: { id: 'clawboo-native' }, body: { apiKey: 'sk-ant-native' } }),
      m.res,
    )
    expect(hasRuntimeSecret('ANTHROPIC_API_KEY')).toBe(true)
    expect((m.body() as { connectionState: string }).connectionState).toBe('ready')
    expect(JSON.stringify(m.body())).not.toContain('sk-ant-native')
  })

  it('an OPENAI key alone also satisfies the native credential check (altEnvVars)', async () => {
    process.env['OPENAI_API_KEY'] = 'sk-openai-alt'
    const m = mockRes()
    await runtimesListGET(req(), m.res)
    const native = (m.body() as { runtimes: Record<string, unknown>[] }).runtimes.find(
      (r) => r['id'] === 'clawboo-native',
    )!
    expect(native['hasCredential']).toBe(true)
    expect(native['connectionState']).toBe('ready')
  })

  it('native connect with an extra provider (Groq) stores its OWN vault slot + is recognized', () => {
    runtimesConnectPOST(
      req({ params: { id: 'clawboo-native' }, body: { apiKey: 'gsk-groq', provider: 'groq' } }),
      mockRes().res,
    )
    // The key lands in the Groq slot — never the default Anthropic slot.
    expect(hasRuntimeSecret('GROQ_API_KEY')).toBe(true)
    expect(hasRuntimeSecret('ANTHROPIC_API_KEY')).toBe(false)
  })

  it('a Groq key alone satisfies the native credential check (expanded altEnvVars)', async () => {
    process.env['GROQ_API_KEY'] = 'gsk-alt'
    const m = mockRes()
    await runtimesListGET(req(), m.res)
    const native = (m.body() as { runtimes: Record<string, unknown>[] }).runtimes.find(
      (r) => r['id'] === 'clawboo-native',
    )!
    expect(native['hasCredential']).toBe(true)
    expect(native['connectionState']).toBe('ready')
  })

  // onboarding-reload-002: a BARE process.env var counts for hasCredential but NOT
  // hasVaultCredential — the onboarding native-skip decision reads the vault-only
  // signal so an ambient shell var doesn't masquerade as a deliberately-completed
  // connect (which would skip the wizard into native mode on a fresh box).
  it('hasVaultCredential is false for a bare process.env var, true after a deliberate connect', async () => {
    process.env['ANTHROPIC_API_KEY'] = 'sk-ambient-shell-var'
    let m = mockRes()
    await runtimesListGET(req(), m.res)
    let native = (m.body() as { runtimes: Record<string, unknown>[] }).runtimes.find(
      (r) => r['id'] === 'clawboo-native',
    )!
    expect(native['hasCredential']).toBe(true) // resolveRuntimeKey honors the shell var
    expect(native['hasVaultCredential']).toBe(false) // but it was never deliberately connected

    // A deliberate connect writes the encrypted vault → hasVaultCredential flips true.
    runtimesConnectPOST(
      req({ params: { id: 'clawboo-native' }, body: { apiKey: 'sk-vault-connected' } }),
      mockRes().res,
    )
    m = mockRes()
    await runtimesListGET(req(), m.res)
    native = (m.body() as { runtimes: Record<string, unknown>[] }).runtimes.find(
      (r) => r['id'] === 'clawboo-native',
    )!
    expect(native['hasVaultCredential']).toBe(true)
  })

  it('native install is a clean 400 (built in, nothing to install, no SSE)', () => {
    const m = mockRes()
    runtimesInstallPOST(req({ params: { id: 'clawboo-native' } }), m.res)
    expect(m.statusCode()).toBe(400)
    expect(spawnState.calls.length).toBe(0)
    expect(m.events()).toHaveLength(0)
  })

  it('native run path injects every resolvable provider key (envVar + altEnvVars)', async () => {
    runtimesConnectPOST(
      req({ params: { id: 'clawboo-native' }, body: { apiKey: 'sk-ant-run' } }),
      mockRes().res,
    )
    process.env['OPENAI_API_KEY'] = 'sk-oai-run'
    const m = mockRes()
    await runtimesRunPOST(req({ params: { id: 'clawboo-native' }, body: { taskId: 't9' } }), m.res)
    const env = runnerState.lastInput?.['apiKeyEnv'] as Record<string, string>
    expect(env['ANTHROPIC_API_KEY']).toBe('sk-ant-run')
    expect(env['OPENAI_API_KEY']).toBe('sk-oai-run')
  })

  // ── provider-aware native connect ────────────────────────────────────────────
  it('native connect routes the key to the chosen provider env var (not always ANTHROPIC)', () => {
    runtimesConnectPOST(
      req({
        params: { id: 'clawboo-native' },
        body: { apiKey: 'sk-openai-x', provider: 'openai' },
      }),
      mockRes().res,
    )
    expect(hasRuntimeSecret('OPENAI_API_KEY')).toBe(true)
    expect(hasRuntimeSecret('ANTHROPIC_API_KEY')).toBe(false)
  })

  it('native connect with OpenRouter routes to OPENROUTER_API_KEY', () => {
    runtimesConnectPOST(
      req({
        params: { id: 'clawboo-native' },
        body: { apiKey: 'sk-or-x', provider: 'openrouter' },
      }),
      mockRes().res,
    )
    expect(hasRuntimeSecret('OPENROUTER_API_KEY')).toBe(true)
    expect(hasRuntimeSecret('ANTHROPIC_API_KEY')).toBe(false)
  })

  it('native connect with ollama is a keyless no-op (stores nothing, still ok)', () => {
    const m = mockRes()
    runtimesConnectPOST(
      req({ params: { id: 'clawboo-native' }, body: { provider: 'ollama' } }),
      m.res,
    )
    expect((m.body() as { ok?: boolean }).ok).toBe(true)
    expect(hasRuntimeSecret('OLLAMA_BASE_URL')).toBe(false)
    expect(hasRuntimeSecret('ANTHROPIC_API_KEY')).toBe(false)
  })

  // ── native healthcheck — one authenticated GET, never persists the key ──
  it('native healthcheck reports ok on a 200 and never stores the key', async () => {
    const fetchMock = vi.fn(async () => new Response(null, { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)
    const m = mockRes()
    await runtimesHealthcheckPOST(
      req({
        params: { id: 'clawboo-native' },
        body: { provider: 'anthropic', apiKey: 'sk-probe' },
      }),
      m.res,
    )
    expect((m.body() as { ok?: boolean }).ok).toBe(true)
    expect(hasRuntimeSecret('ANTHROPIC_API_KEY')).toBe(false) // probe never persists
    expect(JSON.stringify(m.body())).not.toContain('sk-probe')
    vi.unstubAllGlobals()
  })

  it('native healthcheck reports a friendly failure on a 401', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(null, { status: 401 })),
    )
    const m = mockRes()
    await runtimesHealthcheckPOST(
      req({ params: { id: 'clawboo-native' }, body: { provider: 'anthropic', apiKey: 'bad' } }),
      m.res,
    )
    const body = m.body() as { ok?: boolean; error?: string }
    expect(body.ok).toBe(false)
    expect(body.error).toMatch(/invalid/i)
    vi.unstubAllGlobals()
  })

  it('healthcheck rejects a non-native runtime + an unknown provider', async () => {
    const m1 = mockRes()
    await runtimesHealthcheckPOST(
      req({ params: { id: 'hermes' }, body: { provider: 'anthropic', apiKey: 'x' } }),
      m1.res,
    )
    expect(m1.statusCode()).toBe(400)
    const m2 = mockRes()
    await runtimesHealthcheckPOST(
      req({ params: { id: 'clawboo-native' }, body: { provider: 'nope', apiKey: 'x' } }),
      m2.res,
    )
    expect(m2.statusCode()).toBe(400)
  })
})
