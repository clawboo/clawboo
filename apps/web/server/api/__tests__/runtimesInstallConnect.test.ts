// Runtime install / connect / disconnect / status REST. Sandboxes CLAWBOO_HOME
// (clawboo's own dir → fresh DB + secrets vault per test). Mocks the
// `node:child_process` spawn (assert install argv + drive close),
// `../../lib/platform` (control which bins "exist"), and
// `../../lib/executorRunner` (spy the run path for the apiKeyEnv-wiring proof).
// Asserts: npm install argv, the Hermes release install, connect writes the vault and
// NEVER echoes the key, codex's no-op needs-login, disconnect, the status shape +
// connectionState matrix, and that a connected key reaches the run ctx.

import {
  existsSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  mkdirSync,
  writeFileSync,
} from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import type { Request, Response } from 'express'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { resetDb } from '../../lib/db'

// ── Mock platform: control which CLI bins are "installed". ───────────────────
type PyResult = {
  compatible: { bin: string; minor: number; version: string } | null
  found: { bin: string; minor: number; version: string }[]
}
const platformState = vi.hoisted(() => ({
  bins: {} as Record<string, string | null>,
  // Force a specific resolvePython result (e.g. a too-old Xcode Python); when
  // null, resolvePython is derived from `bins` (a python bin => compatible 3.12).
  pythonOverride: null as PyResult | null,
}))
vi.mock('../../lib/platform', () => ({
  isWindows: false,
  resolveShimName: (n: string) => n,
  resolveRuntimeBin: (n: string) => platformState.bins[n] ?? null,
  findExecutable: (n: string) => platformState.bins[n] ?? null,
  resolvePython: (): PyResult => {
    if (platformState.pythonOverride) return platformState.pythonOverride
    const bin =
      platformState.bins['python3.12'] ??
      platformState.bins['python3.11'] ??
      platformState.bins['python3'] ??
      platformState.bins['python'] ??
      null
    if (!bin) return { compatible: null, found: [] }
    const c = { bin, minor: 12, version: '3.12' }
    return { compatible: c, found: [c] }
  },
}))

// ── Mock the Agent SDK binary probe: control whether the SDK's own platform
// binary is "there" (this checkout really has one, so the default is absent). ─
const sdkState = vi.hoisted(() => ({ binary: null as string | null }))
vi.mock('../../lib/runtimes/agentSdkBinary', () => ({
  AGENT_SDK_PACKAGE: '@anthropic-ai/claude-agent-sdk',
  resolveAgentSdkBinary: () => sdkState.binary,
  agentSdkBinaryInInstall: () => sdkState.binary,
  ownAgentSdkDir: () => null,
  agentSdkEntryFile: (dir: string) => dir,
}))

// ── Mock how this server was installed (the real probe reads process.argv). ──
const installMethodState = vi.hoisted(() => ({ method: 'global' as 'global' | 'npx' | 'dev' }))
vi.mock('../../lib/updateCheck', async (orig) => ({
  ...(await orig<typeof import('../../lib/updateCheck')>()),
  detectInstallMethod: () => installMethodState.method,
}))

// ── Mock the Codex login probe (real impl shells out to `codex login status`). ─
const codexAuthState = vi.hoisted(() => ({ loggedIn: false }))
vi.mock('../../lib/runtimes/codexAuth', () => ({
  isCodexLoggedIn: () => Promise.resolve(codexAuthState.loggedIn),
  userCodexHome: () => '/nonexistent',
  userCodexAuthPath: () => '/nonexistent/auth.json',
  invalidateCodexAuthCache: () => {},
}))

// ── Mock the subscription model probe (real impl spawns `codex app-server`). ──
const codexModelsState = vi.hoisted(() => ({
  list: {
    models: [] as { id: string; label: string }[],
    defaultModel: null as string | null,
    source: null as 'cli' | 'cache' | null,
    updateRequired: false,
    cliVersion: null as string | null,
  },
  peeked: false,
  invalidated: 0,
}))
vi.mock('../../lib/runtimes/codexModels', () => ({
  getCodexModels: () => Promise.resolve(codexModelsState.list),
  peekCodexModels: () => (codexModelsState.peeked ? codexModelsState.list : null),
  invalidateCodexModelsCache: () => {
    codexModelsState.invalidated += 1
  },
}))

// ── Mock Clawboo's own Hermes install and its gateway. ──
// `bins['hermes']` stands for Clawboo's install of the pinned release, so the
// connect and status cases read Hermes as installed exactly as before.
const hermesState = vi.hoisted(() => ({
  version: null as string | null,
  installs: 0,
  /** When set, an install waits for this before it finishes. */
  gate: null as Promise<void> | null,
  fail: null as string | null,
  gatewayState: 'stopped' as string,
  restarts: 0,
  keySyncs: 0,
  /** Whether Hermes read as disconnected at each key sync. */
  syncSawDisconnected: [] as boolean[],
  wantedStarts: 0,
}))
vi.mock('../../lib/runtimes/hermes/install', () => ({
  managedHermesCommand: () => platformState.bins['hermes'] ?? null,
  managedHermesVersion: () =>
    platformState.bins['hermes'] ? (hermesState.version ?? '0.23.1') : null,
  managedHermesCurrent: () =>
    Boolean(platformState.bins['hermes']) && (hermesState.version ?? '0.23.1') === '0.23.1',
  installHermesRelease: async (onEvent: (ev: Record<string, unknown>) => void) => {
    hermesState.installs += 1
    onEvent({ type: 'progress', step: 'download', message: 'Downloading Hermes 0.23.1…' })
    if (hermesState.gate) await hermesState.gate
    if (hermesState.fail) {
      throw Object.assign(new Error(hermesState.fail), { code: 'DIGEST_MISMATCH' })
    }
    platformState.bins['hermes'] = '/rt/hermes/v0.23.1/venv/bin/hermes'
    hermesState.version = '0.23.1'
    return { version: '0.23.1', command: platformState.bins['hermes'] }
  },
}))
vi.mock('../../lib/runtimes/hermes', async () => {
  const vault = await import('../../lib/secretsVault')
  return {
    hermesGateway: () => ({
      status: () => ({
        state: hermesState.gatewayState,
        port: hermesState.gatewayState === 'running' ? 8642 : null,
        pid: null,
        startedAt: null,
        restarts: 0,
        lastError: null,
        version: null,
      }),
      restart: async () => {
        hermesState.restarts += 1
      },
    }),
    createHermesRunDriver: () => {
      throw new Error('no Hermes runs in this suite')
    },
    syncHermesProfileKeys: async () => {
      hermesState.keySyncs += 1
      hermesState.syncSawDisconnected.push(vault.isRuntimeDisconnected('hermes'))
    },
    startHermesIfWanted: async () => {
      hermesState.wantedStarts += 1
    },
  }
})

// ── Mock the process spawner: record argv + hand back a controllable child. ──
interface FakeChild {
  killed: boolean
  /** Unset by default, which the install guard reads as a child that has ended.
   *  A test that needs a child still running sets both to null. */
  exitCode?: number | null
  signalCode?: string | null
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
  runtimesCodexModelsGET,
  runtimesConnectPOST,
  runtimesDisconnectPOST,
  runtimesHealthcheckPOST,
  runtimesInstallPOST,
  runtimesListGET,
  runtimesLogoutPOST,
  runtimesRunPOST,
} from '../runtimes'
import {
  hasRuntimeSecret,
  isRuntimeDisconnected,
  setRuntimeDisconnected,
  setRuntimeSecret,
} from '../../lib/secretsVault'
import {
  canRunNativeProvider,
  isNativeOllamaRemoved,
} from '../../lib/runtimes/native/nativeProviderDefaults'
import { stableNodePath } from '../../lib/runtimes/npmRuntimeInstall'
import { INSTALL_RECORD_FILE, launcherFileName } from '../../lib/runtimeFolder'

interface Mock {
  res: Response
  statusCode: () => number
  body: () => unknown
  events: () => Record<string, unknown>[]
  ended: Promise<void>
  /** The client goes away: runs the route's `close` handlers. */
  close: () => void
}
function mockRes(): Mock {
  let code = 200
  let payload: unknown
  const events: Record<string, unknown>[] = []
  const onClose: (() => void)[] = []
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
    on(e: string, h: () => void) {
      if (e === 'close') onClose.push(h)
      return this
    },
  } as unknown as Response
  return {
    res,
    statusCode: () => code,
    body: () => payload,
    events: () => events,
    ended,
    close: () => {
      for (const h of onClose) h()
    },
  }
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
    'OLLAMA_BASE_URL',
    'HERMES_HOME',
    'CLAWBOO_RUNTIMES_DIR',
    'CLAWBOO_WORK_DIR',
  ] as const

  beforeEach(() => {
    for (const k of SAVED) prev[k] = process.env[k]
    // The runtimes and work folders follow CLAWBOO_HOME (`<home>-runtimes`).
    delete process.env['CLAWBOO_RUNTIMES_DIR']
    delete process.env['CLAWBOO_WORK_DIR']
    delete process.env['ANTHROPIC_API_KEY']
    delete process.env['OPENROUTER_API_KEY']
    delete process.env['OPENAI_API_KEY']
    delete process.env['GROQ_API_KEY']
    delete process.env['OLLAMA_BASE_URL']
    home = mkdtempSync(path.join(os.tmpdir(), 'clawboo-rt-rest-'))
    // Isolate the OpenClaw state dir too, so the resolveRuntimeKey `.env`
    // fallback can't read the dev box's real ~/.openclaw/.env provider keys.
    stateDir = mkdtempSync(path.join(os.tmpdir(), 'clawboo-rt-state-'))
    process.env['CLAWBOO_HOME'] = home
    process.env['OPENCLAW_STATE_DIR'] = stateDir
    platformState.bins = {}
    platformState.pythonOverride = null
    sdkState.binary = null
    installMethodState.method = 'global'
    spawnState.calls = []
    spawnState.children = []
    runnerState.lastInput = null
    codexAuthState.loggedIn = false
    hermesState.version = null
    hermesState.installs = 0
    hermesState.gate = null
    hermesState.fail = null
    hermesState.gatewayState = 'stopped'
    hermesState.restarts = 0
    hermesState.keySyncs = 0
    hermesState.syncSawDisconnected = []
    hermesState.wantedStarts = 0
    // Keep the hermes ChatGPT-login probe sandboxed (userHermesHome honours it).
    process.env['HERMES_HOME'] = path.join(home, '.hermes')
  })
  afterEach(() => {
    // Close BEFORE removing the dir: Windows refuses to remove a directory
    // that still holds an open file. The suite never opens the handle itself,
    // the server code under test does. (#140)
    resetDb()
    for (const k of SAVED) {
      if (prev[k] === undefined) delete process.env[k]
      else process.env[k] = prev[k]
    }
    rmSync(home, { recursive: true, force: true })
    rmSync(`${home}-runtimes`, { recursive: true, force: true })
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
      // npm `name@<spec>`, or a release `owner/repo@v<version>`: never a bare name.
      expect(d.pkg, `${d.id} pkg must be version-pinned`).toMatch(/@[\^~]?v?\d/)
    }
  })

  // ── install (npm): into Clawboo's runtimes folder, never `npm install -g` ──
  /** The `--prefix` folder of an npm install call, or null. */
  const prefixOf = (call: { args: string[] } | undefined): string | null => {
    const i = call ? call.args.indexOf('--prefix') : -1
    return i === -1 ? null : (call!.args[i + 1] ?? null)
  }
  /** Do what npm would: put the package (and its commands) in the prefix. */
  const fakeNpmPuts = (
    call: { args: string[] } | undefined,
    name: string,
    bin: Record<string, string> = {},
  ): void => {
    const pkgDir = path.join(prefixOf(call)!, 'node_modules', ...name.split('/'))
    mkdirSync(pkgDir, { recursive: true })
    writeFileSync(
      path.join(pkgDir, 'package.json'),
      JSON.stringify({ name, version: '1.2.3', bin }),
    )
    for (const rel of Object.values(bin)) {
      mkdirSync(path.dirname(path.join(pkgDir, rel)), { recursive: true })
      writeFileSync(path.join(pkgDir, rel), '// cli\n')
    }
  }

  it('installs an npm runtime into its own folder under the runtimes folder, not globally', async () => {
    platformState.bins['codex'] = '/usr/bin/codex' // present post-install
    const m = mockRes()
    runtimesInstallPOST(req({ params: { id: 'codex' } }), m.res)
    const call = spawnState.calls[0]
    expect(call?.args).not.toContain('-g')
    expect(call?.args).toContain('install')
    expect(call?.args[call.args.length - 1]).toBe('@openai/codex@0')
    const prefix = prefixOf(call)
    expect(path.dirname(prefix!)).toBe(path.join(realpathSync.native(home) + '-runtimes', 'codex'))
    fakeNpmPuts(call, '@openai/codex', { codex: 'bin/codex.js' })
    ;(spawnState.children[0] as FakeChild).emitClose(0)
    await m.ended
    expect(m.events().some((e) => e['type'] === 'complete' && e['success'] === true)).toBe(true)
    // Its command (`codex.cmd` on Windows), run by the Node that installed it,
    // by the path that survives an upgrade (Homebrew's opt link for a keg Node).
    const launcher = readFileSync(
      path.join(`${home}-runtimes`, 'bin', launcherFileName('codex')),
      'utf8',
    )
    expect(launcher).toContain(stableNodePath(process.execPath))
    expect(launcher).toContain(
      path.join(prefix!, 'node_modules', '@openai', 'codex', 'bin', 'codex.js'),
    )
  })

  it('a failed npm install leaves nothing behind and says why, with no sudo', async () => {
    const m = mockRes()
    runtimesInstallPOST(req({ params: { id: 'codex' } }), m.res)
    const prefix = prefixOf(spawnState.calls[0])
    const child = spawnState.children[0] as FakeChild
    child.emitStderr('npm error code EACCES\nnpm error syscall mkdir\n')
    child.emitClose(1)
    await m.ended
    const err = m.events().find((e) => e['type'] === 'error')
    expect(err?.['code']).toBe('EACCES')
    expect(
      m
        .events()
        .map((e) => String(e['message'] ?? ''))
        .join(' '),
    ).not.toMatch(/sudo/)
    await vi.waitFor(() => expect(existsSync(prefix!)).toBe(false))
  })

  // ── Claude Code: the Agent SDK and its own binary, never the CLI alone ──────
  const claudeRow = async (): Promise<Record<string, unknown>> => {
    const m = mockRes()
    await runtimesListGET(req(), m.res)
    return (m.body() as { runtimes: Record<string, unknown>[] }).runtimes.find(
      (r) => r['id'] === 'claude-code',
    )!
  }
  const SDK_BIN = '/opt/clawboo/node_modules/@anthropic-ai/claude-agent-sdk-linux-x64/claude'

  it('Claude Code with only the CLI on PATH reads not installed: a run needs the Agent SDK', async () => {
    platformState.bins['claude'] = '/usr/local/bin/claude'
    runtimesConnectPOST(
      req({ params: { id: 'claude-code' }, body: { apiKey: 'sk-ant-cli-only' } }),
      mockRes().res,
    )
    const row = await claudeRow()
    expect(row['installed']).toBe(false)
    expect(row['binPath']).toBeNull()
    expect(row['binSource']).toBeNull()
    // Even with a key: the team builder offers only a runtime that reads ready.
    expect(row['connectionState']).toBe('not-installed')
    expect((row['health'] as { ok: boolean }).ok).toBe(false)
  })

  it('Claude Code with only the Agent SDK’s own binary reads installed, and ready with a key', async () => {
    sdkState.binary = SDK_BIN
    let row = await claudeRow()
    expect(row['installed']).toBe(true)
    expect(row['binPath']).toBe(SDK_BIN)
    expect(row['binSource']).toBe('agent-sdk')
    expect(row['connectionState']).toBe('needs-auth')
    expect(row['health']).toEqual({ ok: true })

    runtimesConnectPOST(
      req({ params: { id: 'claude-code' }, body: { apiKey: 'sk-ant-sdk-only' } }),
      mockRes().res,
    )
    row = await claudeRow()
    expect(row['connectionState']).toBe('ready')
  })

  it('Claude Code with neither the CLI nor the SDK binary reads not installed', async () => {
    const row = await claudeRow()
    expect(row['installed']).toBe(false)
    expect(row['binPath']).toBeNull()
    expect(row['binSource']).toBeNull()
    expect(row['connectionState']).toBe('not-installed')
    expect((row['health'] as { ok: boolean }).ok).toBe(false)
  })

  it('Install fetches no second copy when the Agent SDK’s binary is already there', async () => {
    sdkState.binary = SDK_BIN
    const m = mockRes()
    runtimesInstallPOST(req({ params: { id: 'claude-code' } }), m.res)
    // Finish a spawned install at once, so a regression fails here and fast.
    ;(spawnState.children[0] as FakeChild | undefined)?.emitClose(0)
    await m.ended
    expect(spawnState.calls).toEqual([])
    expect(m.events().some((e) => e['type'] === 'complete' && e['success'] === true)).toBe(true)
  })

  it('Install fetches no CLI when the SDK’s binary is there, even with a CLI on PATH too', async () => {
    platformState.bins['claude'] = '/usr/local/bin/claude'
    sdkState.binary = SDK_BIN
    const m = mockRes()
    runtimesInstallPOST(req({ params: { id: 'claude-code' } }), m.res)
    ;(spawnState.children[0] as FakeChild | undefined)?.emitClose(0)
    await m.ended
    expect(spawnState.calls).toEqual([])
    expect(
      m.events().some((e) => e['type'] === 'output' && String(e['line']).includes(SDK_BIN)),
    ).toBe(true)
  })

  it('Install fetches the Agent SDK a run loads, into the runtimes folder, with no command', async () => {
    const m = mockRes()
    runtimesInstallPOST(req({ params: { id: 'claude-code' } }), m.res)
    const call = spawnState.calls[0]
    expect(call?.args).not.toContain('-g')
    expect(call?.args[call.args.length - 1]).toBe('@anthropic-ai/claude-agent-sdk@0.3')
    // Its platform binary is an optional dependency: never left out.
    expect(call?.args).toContain('--include=optional')
    expect(path.dirname(prefixOf(call)!)).toBe(
      path.join(realpathSync.native(home) + '-runtimes', 'claude-code'),
    )
    fakeNpmPuts(call, '@anthropic-ai/claude-agent-sdk')
    sdkState.binary = SDK_BIN // what the install put in the runtimes folder
    ;(spawnState.children[0] as FakeChild).emitClose(0)
    await m.ended
    const done = m.events().find((e) => e['type'] === 'complete')
    expect(done).toEqual({ type: 'complete', success: true })
  })

  it('an SDK install without its platform binary is not made current, and says why', async () => {
    const m = mockRes()
    runtimesInstallPOST(req({ params: { id: 'claude-code' } }), m.res)
    const prefix = prefixOf(spawnState.calls[0])!
    fakeNpmPuts(spawnState.calls[0], '@anthropic-ai/claude-agent-sdk')
    ;(spawnState.children[0] as FakeChild).emitClose(0)
    await m.ended
    expect(m.events().some((e) => e['type'] === 'complete')).toBe(false)
    const err = m.events().find((e) => e['type'] === 'error')
    expect(err?.['code']).toBe('UNUSABLE')
    expect(String(err?.['message'])).toMatch(/without its own .* binary.*nothing was changed/)
    // Whatever ran Claude Code before still does: no install of it is on record.
    const runtimeDir = path.join(realpathSync.native(home) + '-runtimes', 'claude-code')
    expect(existsSync(path.join(runtimeDir, INSTALL_RECORD_FILE))).toBe(false)
    await vi.waitFor(() => expect(existsSync(prefix)).toBe(false))
  })

  it('installs the SDK from a one-off npx run or a source checkout too', async () => {
    // A run imports it from the runtimes folder, wherever Clawboo itself runs from.
    for (const method of ['npx', 'dev'] as const) {
      installMethodState.method = method
      spawnState.calls = []
      spawnState.children = []
      const m = mockRes()
      runtimesInstallPOST(req({ params: { id: 'claude-code' } }), m.res)
      expect(spawnState.calls, method).toHaveLength(1)
      ;(spawnState.children[0] as FakeChild).emitClose(1)
      await m.ended
      expect(
        m.events().some((e) => e['code'] === 'SDK_NOT_LOADABLE'),
        method,
      ).toBe(false)
    }
  })

  it('installing codex (also how it is updated) drops the cached model probe', async () => {
    platformState.bins['codex'] = '/usr/bin/codex'
    const before = codexModelsState.invalidated
    const m = mockRes()
    runtimesInstallPOST(req({ params: { id: 'codex' } }), m.res)
    fakeNpmPuts(spawnState.calls[0], '@openai/codex', { codex: 'bin/codex.js' })
    ;(spawnState.children[0] as FakeChild).emitClose(0)
    await m.ended
    expect(codexModelsState.invalidated).toBe(before + 1)
  })

  it('refuses an npm install into a runtimes folder inside the data folder (no spawn)', async () => {
    const prevDir = process.env['CLAWBOO_RUNTIMES_DIR']
    process.env['CLAWBOO_RUNTIMES_DIR'] = path.join(home, 'runtimes')
    try {
      const m = mockRes()
      runtimesInstallPOST(req({ params: { id: 'codex' } }), m.res)
      await m.ended
      expect(m.events().find((e) => e['type'] === 'error')?.['code']).toBe('RUNTIMES_DIR_REFUSED')
      expect(spawnState.calls.length).toBe(0)
    } finally {
      if (prevDir === undefined) delete process.env['CLAWBOO_RUNTIMES_DIR']
      else process.env['CLAWBOO_RUNTIMES_DIR'] = prevDir
    }
  })

  // ── install (hermes: the pinned release into Clawboo's own folder) ──────────
  it('installs the pinned Hermes release and reports it installed', async () => {
    const m = mockRes()
    runtimesInstallPOST(req({ params: { id: 'hermes' } }), m.res)
    await m.ended
    expect(hermesState.installs).toBe(1)
    // No pip, no pipx: Clawboo brings its own toolchain.
    expect(spawnState.calls).toHaveLength(0)
    // No gateway was running: one starts if Hermes agents are waiting for it.
    expect(hermesState.wantedStarts).toBe(1)
    expect(hermesState.restarts).toBe(0)
    expect(m.events()).toContainEqual(
      expect.objectContaining({ type: 'progress', step: 'download' }),
    )
    expect(m.events().at(-1)).toMatchObject({ type: 'complete', success: true })
  })

  it('restarts a running Hermes gateway onto the new install', async () => {
    platformState.bins['hermes'] = '/rt/hermes/v0.22.0/venv/bin/hermes'
    hermesState.version = '0.22.0'
    hermesState.gatewayState = 'running'
    const m = mockRes()
    runtimesInstallPOST(req({ params: { id: 'hermes' } }), m.res)
    await m.ended
    expect(hermesState.restarts).toBe(1)
    expect(m.events().at(-1)).toMatchObject({ type: 'complete', success: true })
  })

  it('restarts a gateway still starting on the old install too', async () => {
    hermesState.gatewayState = 'starting'
    const m = mockRes()
    runtimesInstallPOST(req({ params: { id: 'hermes' } }), m.res)
    await m.ended
    expect(hermesState.restarts).toBe(1)
    expect(hermesState.wantedStarts).toBe(0)
  })

  it('a failed Hermes install reports its reason and code', async () => {
    hermesState.fail = 'The download does not match its pinned hash.'
    const m = mockRes()
    runtimesInstallPOST(req({ params: { id: 'hermes' } }), m.res)
    await m.ended
    expect(m.events().at(-1)).toMatchObject({
      type: 'error',
      code: 'DIGEST_MISMATCH',
      message: 'The download does not match its pinned hash.',
    })
  })

  it('refuses a second Hermes install while one is still running, and keeps it going when its client leaves', async () => {
    let release: () => void = () => undefined
    hermesState.gate = new Promise<void>((r) => (release = r))
    const first = mockRes()
    runtimesInstallPOST(req({ params: { id: 'hermes' } }), first.res)
    first.close()
    const second = mockRes()
    runtimesInstallPOST(req({ params: { id: 'hermes' } }), second.res)
    expect(second.events()).toContainEqual(
      expect.objectContaining({ type: 'error', code: 'INSTALL_RUNNING' }),
    )
    release()
    await vi.waitFor(() => expect(platformState.bins['hermes']).toBeTruthy())
    expect(hermesState.installs).toBe(1)
    hermesState.gate = null
    const third = mockRes()
    runtimesInstallPOST(req({ params: { id: 'hermes' } }), third.res)
    await third.ended
    expect(hermesState.installs).toBe(2)
  })

  it('connect writes the vault and NEVER echoes the key', () => {
    sdkState.binary = SDK_BIN // Claude Code is installed
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

  it('codex: a signed-in CLI too old for the plan reads updateRequired on its status', async () => {
    platformState.bins['codex'] = '/usr/bin/codex'
    codexAuthState.loggedIn = true
    const codexStatus = async (): Promise<Record<string, unknown>> => {
      const list = mockRes()
      await runtimesListGET(req(), list.res)
      return (list.body() as { runtimes: Record<string, unknown>[] }).runtimes.find(
        (r) => r['id'] === 'codex',
      )!
    }
    // No probe result yet: nothing claimed either way.
    codexModelsState.peeked = false
    expect('updateRequired' in (await codexStatus())).toBe(false)

    codexModelsState.peeked = true
    codexModelsState.list = {
      models: [],
      defaultModel: null,
      source: null,
      updateRequired: true,
      cliVersion: '0.136.0',
    }
    const codex = await codexStatus()
    expect(codex['updateRequired']).toBe(true)
    expect(codex['cliVersion']).toBe('0.136.0')
    codexModelsState.peeked = false
  })

  describe('Hermes status', () => {
    const hermesStatus = async (): Promise<Record<string, unknown>> => {
      const list = mockRes()
      await runtimesListGET(req(), list.res)
      return (list.body() as { runtimes: Record<string, unknown>[] }).runtimes.find(
        (r) => r['id'] === 'hermes',
      )!
    }

    it("streams and steers live through Clawboo's own install, with its gateway's state", async () => {
      platformState.bins['hermes'] = '/rt/hermes/v0.23.1/venv/bin/hermes'
      hermesState.gatewayState = 'running'
      const hermes = await hermesStatus()
      expect(hermes['installed']).toBe(true)
      expect('updateRequired' in hermes).toBe(false)
      expect(hermes['hermesVersion']).toBe('0.23.1')
      expect(hermes['hermesGateway']).toMatchObject({ state: 'running', port: 8642 })
      expect(hermes['capabilities']).toMatchObject({ streaming: true, steering: 'live' })
      expect('acpMissing' in hermes).toBe(false)
    })

    it('an older install of Clawboo’s own needs an update', async () => {
      platformState.bins['hermes'] = '/rt/hermes/v0.22.0/venv/bin/hermes'
      hermesState.version = '0.22.0'
      expect((await hermesStatus())['updateRequired']).toBe(true)
    })

    it('a not-installed Hermes reads not installed, with no gateway to show running', async () => {
      const hermes = await hermesStatus()
      expect(hermes['installed']).toBe(false)
      expect(hermes['connectionState']).toBe('not-installed')
      expect((hermes['hermesGateway'] as { state: string }).state).toBe('stopped')
    })
  })

  it('GET /api/runtimes/codex/models returns the live list without the source detail', async () => {
    codexModelsState.list = {
      models: [{ id: 'gpt-6-sol', label: 'GPT-6-Sol' }],
      defaultModel: 'gpt-6-sol',
      source: 'cli',
      updateRequired: false,
      cliVersion: '0.163.0',
    }
    const m = mockRes()
    await runtimesCodexModelsGET(req(), m.res)
    expect(m.body()).toEqual({
      models: [{ id: 'gpt-6-sol', label: 'GPT-6-Sol' }],
      defaultModel: 'gpt-6-sol',
      updateRequired: false,
      cliVersion: '0.163.0',
    })
  })

  it('disconnect stops the runtime and keeps a key another runtime also reads', () => {
    platformState.bins['hermes'] = '/home/u/.local/bin/hermes'
    runtimesConnectPOST(
      req({ params: { id: 'hermes' }, body: { apiKey: 'sk-or-x' } }),
      mockRes().res,
    )
    expect(hasRuntimeSecret('OPENROUTER_API_KEY')).toBe(true)
    // A new or replaced key reaches Hermes's profiles at once.
    expect(hermesState.keySyncs).toBe(1)
    const m = mockRes()
    runtimesDisconnectPOST(req({ params: { id: 'hermes' } }), m.res)
    expect(m.statusCode()).toBe(200)
    // Clawboo Native reads OPENROUTER_API_KEY too, so the key stays for it.
    expect(hasRuntimeSecret('OPENROUTER_API_KEY')).toBe(true)
    expect((m.body() as { connectionState: string }).connectionState).toBe('needs-auth')
    expect(m.body()).toMatchObject({
      removed: [],
      kept: [{ envVar: 'OPENROUTER_API_KEY', sharedWith: ['Clawboo Native'] }],
    })
    // Hermes's profiles keep keys for the jobs it runs on its own: they follow.
    expect(hermesState.keySyncs).toBe(2)
  })

  it("a key pasted to reconnect Hermes reaches its profiles as Hermes's, not as a disconnected runtime's", () => {
    platformState.bins['hermes'] = '/home/u/.local/bin/hermes'
    runtimesDisconnectPOST(req({ params: { id: 'hermes' } }), mockRes().res)
    hermesState.syncSawDisconnected = []
    const m = mockRes()
    runtimesConnectPOST(req({ params: { id: 'hermes' }, body: { apiKey: 'sk-or-back' } }), m.res)
    expect((m.body() as { connectionState: string }).connectionState).toBe('ready')
    // Synced after the reconnect, so the profiles get the key, not an empty set.
    expect(hermesState.syncSawDisconnected).toEqual([false])
  })

  it('reconnecting Hermes with a kept key brings that key back to its profiles', () => {
    platformState.bins['hermes'] = '/home/u/.local/bin/hermes'
    setRuntimeSecret('OPENROUTER_API_KEY', 'sk-or-kept')
    runtimesDisconnectPOST(req({ params: { id: 'hermes' } }), mockRes().res)
    hermesState.syncSawDisconnected = []
    const m = mockRes()
    runtimesConnectPOST(req({ params: { id: 'hermes' }, body: {} }), m.res)
    expect(m.statusCode()).toBe(200)
    expect((m.body() as { connectionState: string }).connectionState).toBe('ready')
    expect(hermesState.syncSawDisconnected).toEqual([false])
  })

  it('disconnect deletes an ALT-slot key no other runtime reads (native connected via Groq)', () => {
    // Native's primary slot is ANTHROPIC_API_KEY, but a key connected under a
    // provider lands in an altEnvVars slot: deleting only the primary left the
    // real credential behind and the card "Connected".
    runtimesConnectPOST(
      req({
        params: { id: 'clawboo-native' },
        body: { apiKey: 'gsk-live', provider: 'groq' },
      }),
      mockRes().res,
    )
    expect(hasRuntimeSecret('GROQ_API_KEY')).toBe(true)
    const syncsBefore = hermesState.keySyncs
    const m = mockRes()
    runtimesDisconnectPOST(req({ params: { id: 'clawboo-native' } }), m.res)
    expect(m.statusCode()).toBe(200)
    expect(hasRuntimeSecret('GROQ_API_KEY')).toBe(false)
    // Another runtime's Disconnect takes the key out of Hermes's profiles too.
    expect(hermesState.keySyncs).toBe(syncsBefore + 1)
    expect((m.body() as { connectionState: string }).connectionState).toBe('needs-auth')
    expect(m.body()).toMatchObject({ removed: ['GROQ_API_KEY'], kept: [] })
  })

  it('disconnecting Hermes leaves Clawboo Native and Claude Code their keys', async () => {
    platformState.bins['hermes'] = '/home/u/.local/bin/hermes'
    sdkState.binary = SDK_BIN // Claude Code is installed
    setRuntimeSecret('ANTHROPIC_API_KEY', 'sk-ant-shared')
    setRuntimeSecret('OPENAI_API_KEY', 'sk-openai-shared')
    runtimesDisconnectPOST(req({ params: { id: 'hermes' } }), mockRes().res)

    expect(hasRuntimeSecret('ANTHROPIC_API_KEY')).toBe(true)
    expect(hasRuntimeSecret('OPENAI_API_KEY')).toBe(true)
    const g = mockRes()
    await runtimesListGET(req(), g.res)
    const byId = (id: string) =>
      (g.body() as { runtimes: Record<string, unknown>[] }).runtimes.find((r) => r['id'] === id)!
    expect(byId('hermes')['connectionState']).toBe('needs-auth')
    expect(byId('claude-code')['connectionState']).toBe('ready')
    expect(byId('clawboo-native')['connectionState']).toBe('ready')
  })

  it('the status carries what a Disconnect would delete and keep (saved keys only)', async () => {
    setRuntimeSecret('ANTHROPIC_API_KEY', 'sk-ant-x')
    setRuntimeSecret('GROQ_API_KEY', 'gsk-x')
    const g = mockRes()
    await runtimesListGET(req(), g.res)
    const native = (g.body() as { runtimes: Record<string, unknown>[] }).runtimes.find(
      (r) => r['id'] === 'clawboo-native',
    )!
    expect(native['disconnectPlan']).toEqual({
      removes: ['GROQ_API_KEY'],
      keeps: [{ envVar: 'ANTHROPIC_API_KEY', sharedWith: ['Claude Code', 'Hermes'] }],
    })
    expect(JSON.stringify(native)).not.toContain('sk-ant-x')
  })

  it('a keyless connect naming a provider is refused on a single-provider runtime', () => {
    platformState.bins['hermes'] = '/home/u/.local/bin/hermes'
    setRuntimeSecret('ANTHROPIC_API_KEY', 'sk-ant-other')
    setRuntimeDisconnected('hermes', true)
    const m = mockRes()
    runtimesConnectPOST(req({ params: { id: 'hermes' }, body: { provider: 'openrouter' } }), m.res)
    expect(m.statusCode()).toBe(400)
    expect(isRuntimeDisconnected('hermes')).toBe(true)
  })

  it('a disconnected runtime connects again with the key it kept, without a re-paste', () => {
    sdkState.binary = SDK_BIN // Claude Code is installed
    setRuntimeSecret('ANTHROPIC_API_KEY', 'sk-ant-kept')
    runtimesDisconnectPOST(req({ params: { id: 'claude-code' } }), mockRes().res)
    expect(isRuntimeDisconnected('claude-code')).toBe(true)
    expect(hasRuntimeSecret('ANTHROPIC_API_KEY')).toBe(true)

    const m = mockRes()
    runtimesConnectPOST(req({ params: { id: 'claude-code' }, body: {} }), m.res)
    expect(m.statusCode()).toBe(200)
    expect((m.body() as { connectionState: string }).connectionState).toBe('ready')
    expect(isRuntimeDisconnected('claude-code')).toBe(false)
    expect(JSON.stringify(m.body())).not.toContain('sk-ant-kept')
  })

  it('disconnect suppresses the ambient OpenClaw-.env fallback until reconnect', async () => {
    // The reported bug's second half: the same key also lives in OpenClaw's
    // ~/.openclaw/.env (the deliberate reuse chain), so even a full vault delete
    // left the runtime re-credentialed through the fallback — "nothing happens".
    // An explicit disconnect records a per-runtime override: vault-only until
    // the next connect.
    writeFileSync(path.join(stateDir, '.env'), 'OPENROUTER_API_KEY=sk-or-ambient\n')
    const g0 = mockRes()
    await runtimesListGET(req(), g0.res)
    const native0 = (
      g0.body() as { runtimes: Array<{ id: string; hasCredential: boolean }> }
    ).runtimes.find((r) => r.id === 'clawboo-native')
    expect(native0?.hasCredential).toBe(true) // ambient reuse (auto-connect) works

    runtimesDisconnectPOST(req({ params: { id: 'clawboo-native' } }), mockRes().res)
    const g1 = mockRes()
    await runtimesListGET(req(), g1.res)
    const native1 = (
      g1.body() as { runtimes: Array<{ id: string; hasCredential: boolean }> }
    ).runtimes.find((r) => r.id === 'clawboo-native')
    expect(native1?.hasCredential).toBe(false) // genuinely disconnected

    // Reconnecting lifts the override — ambient reuse applies again.
    runtimesConnectPOST(
      req({ params: { id: 'clawboo-native' }, body: { apiKey: 'sk-new', provider: 'anthropic' } }),
      mockRes().res,
    )
    const g2 = mockRes()
    await runtimesListGET(req(), g2.res)
    const native2 = (
      g2.body() as { runtimes: Array<{ id: string; hasCredential: boolean }> }
    ).runtimes.find((r) => r.id === 'clawboo-native')
    expect(native2?.hasCredential).toBe(true)
  })

  // ── logout (oauth sign-out) ──────────────────────────────────────────────────
  it('logout (codex) runs `codex logout` and reports the re-probed state', async () => {
    platformState.bins['codex'] = '/home/u/.local/bin/codex'
    codexAuthState.loggedIn = false // signed out after the logout
    const m = mockRes()
    const p = runtimesLogoutPOST(req({ params: { id: 'codex' } }), m.res)
    // The spawn runs synchronously in the Promise executor; close the child so
    // the handler's await resolves.
    ;(spawnState.children.at(-1) as FakeChild).emitClose(0)
    await p
    expect(spawnState.calls.at(-1)).toEqual({ cmd: '/home/u/.local/bin/codex', args: ['logout'] })
    expect(m.statusCode()).toBe(200)
    expect((m.body() as { ok: boolean }).ok).toBe(true)
    expect((m.body() as { connectionState: string }).connectionState).toBe('needs-login')
  })

  it('logout 404s for a non-oauth (api-key) runtime — those use /disconnect', async () => {
    platformState.bins['hermes'] = '/home/u/.local/bin/hermes'
    const m = mockRes()
    await runtimesLogoutPOST(req({ params: { id: 'hermes' } }), m.res)
    expect(m.statusCode()).toBe(404)
    // No CLI spawned for a non-oauth runtime.
    expect(spawnState.calls.some((c) => c.args.includes('logout'))).toBe(false)
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

  it('Hermes reads ready from a ChatGPT login (no key): codexAuth folds into hasCredential', async () => {
    platformState.bins['hermes'] = '/home/u/.local/bin/hermes'
    // The user's `hermes auth add openai-codex` store (shape hermes itself
    // reads: providers['openai-codex'].tokens with BOTH tokens non-empty).
    mkdirSync(path.join(home, '.hermes'), { recursive: true })
    writeFileSync(
      path.join(home, '.hermes', 'auth.json'),
      JSON.stringify({
        providers: {
          'openai-codex': { tokens: { access_token: 'at', refresh_token: 'rt' } },
        },
      }),
    )
    const m = mockRes()
    await runtimesListGET(req(), m.res)
    const hermes = (m.body() as { runtimes: Record<string, unknown>[] }).runtimes.find(
      (r) => r['id'] === 'hermes',
    )!
    expect(hermes['codexAuth']).toBe(true)
    expect(hermes['hasCredential']).toBe(true)
    // NOT a vault credential — the onboarding native-skip decision must not
    // mistake an on-disk login for a vault-connected key.
    expect(hermes['hasVaultCredential']).toBe(false)
    expect(hermes['connectionState']).toBe('ready')
    // No other runtime picks up the signal.
    const codex = (m.body() as { runtimes: Record<string, unknown>[] }).runtimes.find(
      (r) => r['id'] === 'codex',
    )!
    expect(codex['codexAuth']).toBe(false)
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

  it('the run route drives the mock runtime only with its flag on', async () => {
    const off = mockRes()
    await runtimesRunPOST(req({ params: { id: 'clawboo-mock' }, body: { taskId: 't-m' } }), off.res)
    expect(off.statusCode()).toBe(404)
    expect(runnerState.lastInput).toBeNull()

    process.env['CLAWBOO_ENABLE_MOCK_RUNTIME'] = '1'
    try {
      const on = mockRes()
      await runtimesRunPOST(
        req({ params: { id: 'clawboo-mock' }, body: { taskId: 't-m' } }),
        on.res,
      )
      expect(on.statusCode()).not.toBe(404)
      expect(runnerState.lastInput?.['taskId']).toBe('t-m')
    } finally {
      delete process.env['CLAWBOO_ENABLE_MOCK_RUNTIME']
    }
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

  it('native connect refuses a provider it cannot drive instead of filing the key as Anthropic', async () => {
    const m = mockRes()
    await runtimesConnectPOST(
      req({ params: { id: 'clawboo-native' }, body: { apiKey: 'mm-key', provider: 'minimax' } }),
      m.res,
    )
    expect(m.statusCode()).toBe(400)
    expect(m.body()).toEqual({ error: "unknown provider 'minimax'" })
    expect(hasRuntimeSecret('ANTHROPIC_API_KEY')).toBe(false)
    expect(hasRuntimeSecret('MINIMAX_API_KEY')).toBe(false)
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

  it('native keyless REUSE: an existing provider key + explicit provider lifts the disconnect override', () => {
    // The Providers hub still holds an OpenRouter key; the runtime was explicitly
    // disconnected. Reconnecting must NOT demand a re-paste — { provider } alone
    // verifies a key resolves and lifts the override.
    setRuntimeSecret('OPENROUTER_API_KEY', 'sk-or-existing')
    setRuntimeDisconnected('clawboo-native', true)
    const m = mockRes()
    runtimesConnectPOST(
      req({ params: { id: 'clawboo-native' }, body: { provider: 'openrouter' } }),
      m.res,
    )
    expect(m.statusCode()).toBe(200)
    expect((m.body() as { connectionState?: string }).connectionState).toBe('ready')
    expect(isRuntimeDisconnected('clawboo-native')).toBe(false)
    expect(JSON.stringify(m.body())).not.toContain('sk-or-existing')
  })

  it('native keyless connect 400s when NO key exists for the chosen provider', () => {
    const m = mockRes()
    runtimesConnectPOST(
      req({ params: { id: 'clawboo-native' }, body: { provider: 'groq' } }),
      m.res,
    )
    expect(m.statusCode()).toBe(400)
    expect(String((m.body() as { error?: string }).error)).toMatch(/groq/i)
  })

  it('native connect with ollama stores no key (vault untouched, still ok)', () => {
    const m = mockRes()
    runtimesConnectPOST(
      req({ params: { id: 'clawboo-native' }, body: { provider: 'ollama' } }),
      m.res,
    )
    expect((m.body() as { ok?: boolean }).ok).toBe(true)
    expect(hasRuntimeSecret('OLLAMA_BASE_URL')).toBe(false)
    expect(hasRuntimeSecret('ANTHROPIC_API_KEY')).toBe(false)
  })

  // ── keyless local Ollama: the choice is the connection ─────────────────────
  async function nativeStatus(): Promise<Record<string, unknown>> {
    const m = mockRes()
    await runtimesListGET(req(), m.res)
    return (m.body() as { runtimes: Record<string, unknown>[] }).runtimes.find(
      (r) => r['id'] === 'clawboo-native',
    )!
  }
  const connectOllama = (): Mock => {
    const m = mockRes()
    runtimesConnectPOST(
      req({ params: { id: 'clawboo-native' }, body: { provider: 'ollama' } }),
      m.res,
    )
    return m
  }
  const disconnectNative = (body: Record<string, unknown> = {}): Mock => {
    const m = mockRes()
    runtimesDisconnectPOST(req({ params: { id: 'clawboo-native' }, body }), m.res)
    return m
  }

  it('picking Ollama readies native with NO key and NO OLLAMA_BASE_URL', async () => {
    const m = connectOllama()
    expect((m.body() as { connectionState?: string }).connectionState).toBe('ready')
    const native = await nativeStatus()
    // The state the 1:1 composer and the team-deploy picker read.
    expect(native['connectionState']).toBe('ready')
    expect(native['ollamaConnected']).toBe(true)
    // Not a credential: nothing resolves, nothing was stored.
    expect(native['hasCredential']).toBe(false)
    expect(native['hasVaultCredential']).toBe(false)
    expect((native['health'] as { ok?: boolean }).ok).toBe(true)
  })

  it('OLLAMA_BASE_URL alone also reads ready (health and connection state agree)', async () => {
    process.env['OLLAMA_BASE_URL'] = 'http://localhost:11434/v1'
    const native = await nativeStatus()
    expect((native['health'] as { ok?: boolean }).ok).toBe(true)
    expect(native['connectionState']).toBe('ready')
  })

  it('the Ollama choice is native-only: other runtimes never read it', async () => {
    connectOllama()
    platformState.bins['hermes'] = '/home/u/.local/bin/hermes'
    const m = mockRes()
    await runtimesListGET(req(), m.res)
    const hermes = (m.body() as { runtimes: Record<string, unknown>[] }).runtimes.find(
      (r) => r['id'] === 'hermes',
    )!
    expect(hermes['ollamaConnected']).toBe(false)
    expect(hermes['connectionState']).toBe('needs-auth')
  })

  it('disconnect { provider: ollama } removes ONLY the Ollama choice; keys stay', async () => {
    setRuntimeSecret('OPENROUTER_API_KEY', 'sk-or-kept')
    connectOllama()
    const m = disconnectNative({ provider: 'ollama' })
    expect(m.statusCode()).toBe(200)
    const native = await nativeStatus()
    expect(native['ollamaConnected']).toBe(false)
    expect(native['connectionState']).toBe('ready') // the OpenRouter key still serves
    expect(hasRuntimeSecret('OPENROUTER_API_KEY')).toBe(true)
    expect(isRuntimeDisconnected('clawboo-native')).toBe(false)
  })

  it('disconnect { provider: ollama } also mutes an ambient OLLAMA_BASE_URL', async () => {
    process.env['OLLAMA_BASE_URL'] = 'http://localhost:11434/v1'
    const m = disconnectNative({ provider: 'ollama' })
    expect((m.body() as { connectionState?: string }).connectionState).toBe('needs-auth')
    expect((await nativeStatus())['ollamaConnected']).toBe(false)
    // Picking it again turns it back on.
    connectOllama()
    expect((await nativeStatus())['ollamaConnected']).toBe(true)
  })

  it('a FULL native disconnect drops a chosen Ollama with the keys', async () => {
    connectOllama()
    const m = disconnectNative()
    expect((m.body() as { connectionState?: string }).connectionState).toBe('needs-auth')
    const native = await nativeStatus()
    expect(native['ollamaConnected']).toBe(false)
    expect((native['health'] as { ok?: boolean }).ok).toBe(false)
  })

  // Disconnect means the same for every provider: Ollama is REMOVED, not just
  // forgotten, so its agents stop and nothing but picking it again turns it back on.
  it('a FULL native disconnect removes Ollama; a later key connect leaves it removed', async () => {
    connectOllama()
    disconnectNative()
    expect(isNativeOllamaRemoved()).toBe(true)
    expect(canRunNativeProvider('ollama')).toBe(false)

    const keyed = mockRes()
    runtimesConnectPOST(
      req({
        params: { id: 'clawboo-native' },
        body: { apiKey: 'sk-ant-new', provider: 'anthropic' },
      }),
      keyed.res,
    )
    expect(isRuntimeDisconnected('clawboo-native')).toBe(false)
    expect((await nativeStatus())['ollamaConnected']).toBe(false)
    expect(isNativeOllamaRemoved()).toBe(true)

    // Only picking Ollama again brings it back.
    connectOllama()
    expect((await nativeStatus())['ollamaConnected']).toBe(true)
    expect(isNativeOllamaRemoved()).toBe(false)
  })

  it('after a FULL disconnect, OLLAMA_BASE_URL alone no longer turns Ollama back on', async () => {
    // Before, the full disconnect only muted the env var while the runtime stayed
    // disconnected: the next key connect lifted that, and Ollama silently came back.
    process.env['OLLAMA_BASE_URL'] = 'http://localhost:11434/v1'
    expect((await nativeStatus())['ollamaConnected']).toBe(true)
    disconnectNative()
    const keyed = mockRes()
    runtimesConnectPOST(
      req({
        params: { id: 'clawboo-native' },
        body: { apiKey: 'sk-ant-new', provider: 'anthropic' },
      }),
      keyed.res,
    )
    expect((await nativeStatus())['ollamaConnected']).toBe(false)
    expect(canRunNativeProvider('ollama')).toBe(false)
  })

  it('a provider-scoped disconnect accepts only native + ollama', () => {
    const wrongProvider = disconnectNative({ provider: 'openrouter' })
    expect(wrongProvider.statusCode()).toBe(400)
    const wrongRuntime = mockRes()
    runtimesDisconnectPOST(
      req({ params: { id: 'hermes' }, body: { provider: 'ollama' } }),
      wrongRuntime.res,
    )
    expect(wrongRuntime.statusCode()).toBe(400)
  })

  it('an unreadable provider is refused, never read as the full disconnect', () => {
    // A full disconnect deletes every native key, so `{ provider: 1 }` falling
    // through to it would wipe keys the caller never meant to touch.
    setRuntimeSecret('ANTHROPIC_API_KEY', 'sk-ant-keep')
    for (const provider of [1, null, '', '   ', { id: 'ollama' }]) {
      const m = disconnectNative({ provider })
      expect(m.statusCode()).toBe(400)
    }
    expect(hasRuntimeSecret('ANTHROPIC_API_KEY')).toBe(true)
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

  it('native healthcheck refuses to FOLLOW a redirect while carrying the key', async () => {
    // The probe sends a live credential to a hard-coded provider endpoint. Node's
    // fetch strips `Authorization` across origins but NOT Anthropic's custom
    // `x-api-key`, so following a 3xx could hand the key to whatever host
    // answered. Assert the option itself, not just the catch: a test that only
    // checked the error path would still pass if `redirect` were dropped.
    // Declare the params so the mock's call tuple is typed — a bare `vi.fn(async
    // () => …)` infers `[]` and indexing `[1]` is a compile error.
    const fetchMock = vi.fn(
      async (_url: string, _init?: RequestInit) => new Response(null, { status: 200 }),
    )
    vi.stubGlobal('fetch', fetchMock)
    const m = mockRes()
    await runtimesHealthcheckPOST(
      req({
        params: { id: 'clawboo-native' },
        body: { provider: 'anthropic', apiKey: 'sk-probe' },
      }),
      m.res,
    )
    expect(fetchMock.mock.calls[0]?.[1]?.redirect).toBe('error')
    vi.unstubAllGlobals()
  })

  it("native healthcheck checks the key at the provider's base URL, behind a gateway", async () => {
    // Behind a gateway the public address may be unreachable, or reject the key,
    // so a check there would read a good key as bad.
    const fetchMock = vi.fn(
      async (_url: string, _init?: RequestInit) => new Response(null, { status: 200 }),
    )
    vi.stubGlobal('fetch', fetchMock)
    vi.stubEnv('ANTHROPIC_BASE_URL', 'https://gw.example.com/anthropic/')
    vi.stubEnv('OPENROUTER_BASE_URL', 'https://gw.example.com/openrouter/v1')
    vi.stubEnv('GROQ_BASE_URL', 'https://gw.example.com/groq/v1')
    for (const provider of ['anthropic', 'openrouter', 'groq']) {
      const m = mockRes()
      await runtimesHealthcheckPOST(
        req({ params: { id: 'clawboo-native' }, body: { provider, apiKey: 'sk-probe' } }),
        m.res,
      )
      expect((m.body() as { ok?: boolean }).ok).toBe(true)
    }
    expect(fetchMock.mock.calls.map((c) => c[0])).toEqual([
      'https://gw.example.com/anthropic/v1/models',
      'https://gw.example.com/openrouter/v1/models',
      'https://gw.example.com/groq/v1/models',
    ])
    vi.unstubAllGlobals()
    vi.unstubAllEnvs()
  })

  it('native healthcheck fails closed (never ok) when the provider redirects', async () => {
    // `redirect: 'error'` makes fetch reject; the handler must degrade to the
    // friendly unreachable message rather than surfacing a 200.
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new TypeError('unexpected redirect')
      }),
    )
    const m = mockRes()
    await runtimesHealthcheckPOST(
      req({
        params: { id: 'clawboo-native' },
        body: { provider: 'anthropic', apiKey: 'sk-probe' },
      }),
      m.res,
    )
    const body = m.body() as { ok?: boolean; error?: string }
    expect(body.ok).toBe(false)
    expect(body.error).toMatch(/could not reach/i)
    expect(JSON.stringify(body)).not.toContain('sk-probe')
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

  it('healthcheck with NO apiKey probes the key already stored for that provider', async () => {
    // The one-click "Use" reconnect never re-pastes the key, so verifying it has to
    // read the saved one. The probe must still leave the vault exactly as it found
    // it and must not echo the key it used.
    setRuntimeSecret('OPENROUTER_API_KEY', 'sk-or-stored')
    const seen: { headers?: HeadersInit } = {}
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string, init: RequestInit) => {
        seen.headers = init.headers
        return new Response(null, { status: 200 })
      }),
    )
    const m = mockRes()
    await runtimesHealthcheckPOST(
      req({ params: { id: 'clawboo-native' }, body: { provider: 'openrouter' } }),
      m.res,
    )
    expect((m.body() as { ok?: boolean }).ok).toBe(true)
    // It really used the stored key…
    expect(JSON.stringify(seen.headers)).toContain('sk-or-stored')
    // …left it in place, and never echoed it.
    expect(hasRuntimeSecret('OPENROUTER_API_KEY')).toBe(true)
    expect(JSON.stringify(m.body())).not.toContain('sk-or-stored')
    vi.unstubAllGlobals()
  })

  it('healthcheck with NO apiKey and no stored key still 400s', async () => {
    const fetchMock = vi.fn(async () => new Response(null, { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)
    const m = mockRes()
    await runtimesHealthcheckPOST(
      req({ params: { id: 'clawboo-native' }, body: { provider: 'openrouter' } }),
      m.res,
    )
    expect(m.statusCode()).toBe(400)
    expect(String((m.body() as { error?: string }).error)).toMatch(/apiKey is required/i)
    expect(fetchMock).not.toHaveBeenCalled() // nothing to probe with — don't call out
    vi.unstubAllGlobals()
  })

  // ── Ollama: reachable is not enough, the chosen model must be pulled ──
  // An Ollama that answers but never pulled the model fails every run with
  // "model not found", which used to pass this check and onboarding with it.
  const ollamaTags = (...names: string[]) =>
    vi.fn(
      async (_url: string, _init?: RequestInit) =>
        new Response(
          JSON.stringify({
            models: names.map((name) => ({
              name,
              details: { family: name.startsWith('nomic') ? 'nomic-bert' : 'llama' },
              capabilities: name.startsWith('nomic') ? ['embedding'] : ['completion', 'tools'],
            })),
          }),
          { status: 200 },
        ),
    )
  const healthcheckOllama = async (body: Record<string, unknown>) => {
    const m = mockRes()
    await runtimesHealthcheckPOST(
      req({ params: { id: 'clawboo-native' }, body: { provider: 'ollama', ...body } }),
      m.res,
    )
    return m.body() as { ok?: boolean; error?: string; missingModel?: string }
  }

  it('ollama healthcheck fails a model the daemon has not pulled, with the pull command', async () => {
    vi.stubGlobal('fetch', ollamaTags('nomic-embed-text:latest'))
    const body = await healthcheckOllama({ model: 'llama3.2' })
    expect(body.ok).toBe(false)
    expect(body.missingModel).toBe('llama3.2')
    expect(body.error).toContain('ollama pull llama3.2')
    vi.unstubAllGlobals()
  })

  it('ollama healthcheck passes a pulled model (untagged reads as :latest)', async () => {
    vi.stubGlobal('fetch', ollamaTags('llama3.2:latest'))
    expect(await healthcheckOllama({ model: 'llama3.2' })).toEqual({ ok: true })
    vi.unstubAllGlobals()
  })

  it('ollama healthcheck with no model still only checks that the daemon answers', async () => {
    vi.stubGlobal('fetch', ollamaTags('nomic-embed-text:latest'))
    expect(await healthcheckOllama({})).toEqual({ ok: true })
    vi.unstubAllGlobals()
  })

  it('ollama healthcheck never reports a model missing from a body that is not a tags list', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('<html>ok</html>', { status: 200 })),
    )
    expect(await healthcheckOllama({ model: 'llama3.2' })).toEqual({ ok: true })
    vi.unstubAllGlobals()
  })

  it('ollama healthcheck probes the native /api/tags behind OLLAMA_BASE_URL', async () => {
    process.env['OLLAMA_BASE_URL'] = 'http://gpu-box:11434/v1/'
    const fetchMock = ollamaTags('llama3.2:latest')
    vi.stubGlobal('fetch', fetchMock)
    await healthcheckOllama({ model: 'llama3.2' })
    expect(fetchMock.mock.calls[0]?.[0]).toBe('http://gpu-box:11434/api/tags')
    vi.unstubAllGlobals()
  })

  it('a keyed provider ignores `model` (its check is about the key)', async () => {
    // Even a body shaped like an empty tags list, which would read as "not pulled".
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify({ models: [] }), { status: 200 })),
    )
    const m = mockRes()
    await runtimesHealthcheckPOST(
      req({
        params: { id: 'clawboo-native' },
        body: { provider: 'anthropic', apiKey: 'sk-probe', model: 'llama3.2' },
      }),
      m.res,
    )
    expect(m.body()).toEqual({ ok: true })
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
