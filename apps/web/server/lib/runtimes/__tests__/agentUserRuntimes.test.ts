// With agents on their own OS user (CLAWBOO_AGENT_USER), every runtime process
// starts through the agent host and every write into a runtime home or a working
// folder goes through the host's file verbs. These drive the real drivers against
// an in-process host (same protocol, minus the uid switch) and check that the
// work went through it: on code that spawned or wrote locally, the host sees
// nothing and each test fails.
//
// The host here runs as the test's own user, so files still work; its reported
// home is a temp folder, and HOME is sandboxed, so nothing reaches the real
// ~/.codex or ~/.hermes.

import type { ChildProcess } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import type { CodexNativeEvent } from '@clawboo/adapter-codex'
import type { ClaudeNativeEvent } from '@clawboo/adapter-claude-code'
import type { HermesDriver, HermesNativeEvent } from '@clawboo/adapter-hermes'
import type { StartOpts } from '@clawboo/executor'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { RemoteSpawnOptions } from '../../agentUser/client'
import { setActiveAgentHost } from '../../agentUser/state'
import { startInProcessHost, type InProcessHost } from '../../agentUser/__tests__/inProcessHost'
import {
  createClaudeCodeDriver,
  spawnTrackedClaudeProcess,
  type SdkModule,
} from '../claudeCodeDriver'
import { createCodexAppServerDriver } from '../codexAppServerDriver'
import { prepareCodexHome } from '../codexDriver'
import { probeCodexAppServer } from '../codexModels'
import { runHermesAcpCheck } from '../hermesAcpCheck'
import { createHermesAcpDriver } from '../hermesAcpDriver'
import { resolveHermesRun } from '../hermesDriver'
import { detectProvider, provisionHermesHome } from '../hermesHome'
import { listNativeSkills } from '../hermesSkills'
import { createNativeDriver } from '../native/nativeDriver'
import { isHostedAgentProcess } from '../spawner'
import { createSpawnDriver } from '../subprocess'
import { ensureTeamWorkdir } from '../teamWorkdir'
import type { RuntimeRunContext } from '../types'

const posix = process.platform !== 'win32'

interface HostedSpy {
  h: InProcessHost
  /** What each process the host was asked to start looked like. */
  spawns: RemoteSpawnOptions[]
  /** The request ops the host was sent, in order (spawns are not requests). */
  ops: string[]
}

let active: InProcessHost | null = null
let tmp: string
/** The agent user's home, as the host reports it. */
let agentHome: string
/** The operator's home (HOME), where their own ~/.codex and ~/.hermes live. */
let operatorHome: string

async function agentModeOn(): Promise<HostedSpy> {
  vi.stubEnv('CLAWBOO_AGENT_USER', 'clawboo-agent')
  const h = startInProcessHost()
  active = h
  const hello = await h.client.waitForHello()
  setActiveAgentHost({
    client: h.client,
    hello: { ...hello, home: agentHome },
    config: { user: 'clawboo-agent', switch: 'sudo', socket: null },
  })
  const spawns: RemoteSpawnOptions[] = []
  const ops: string[] = []
  const spawn = h.client.spawn.bind(h.client)
  vi.spyOn(h.client, 'spawn').mockImplementation((o) => {
    spawns.push(o)
    return spawn(o)
  })
  const request = h.client.request.bind(h.client)
  vi.spyOn(h.client, 'request').mockImplementation((req, opts) => {
    ops.push(req.op)
    return request(req, opts)
  })
  return { h, spawns, ops }
}

async function until(cond: () => boolean, ms = 5_000): Promise<void> {
  const deadline = Date.now() + ms
  while (!cond() && Date.now() < deadline) await new Promise((r) => setTimeout(r, 10))
  expect(cond()).toBe(true)
}

const closed = (child: ChildProcess): Promise<void> =>
  new Promise((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null) resolve()
    else child.once('close', () => resolve())
  })

beforeEach(() => {
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'agent-user-runtimes-')))
  agentHome = path.join(tmp, 'agent-home')
  operatorHome = path.join(tmp, 'operator')
  fs.mkdirSync(agentHome)
  fs.mkdirSync(operatorHome)
  vi.stubEnv('HOME', operatorHome)
  vi.stubEnv('CODEX_HOME', undefined)
  vi.stubEnv('HERMES_HOME', undefined)
})

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
  setActiveAgentHost(null)
  active?.client.close()
  active = null
  fs.rmSync(tmp, { recursive: true, force: true })
})

describe.runIf(posix)('createSpawnDriver with agents on their own OS user', () => {
  it('starts the runtime through the agent host, as a process-group leader', async () => {
    const { spawns } = await agentModeOn()
    const results: Array<{ code: number | null; stdout: string }> = []
    const driver = createSpawnDriver<{ code: number | null; stdout: string }>({
      resolve: async () => ({
        command: '/bin/sh',
        args: ['-c', 'printf "%s" "$GRANTED"'],
        cwd: tmp,
        env: { GRANTED: 'key-1' },
      }),
      parseLine: () => [],
      onClose: (code, _signal, stdout) => [{ code, stdout }],
    })
    driver.onEvent((ev) => results.push(ev))
    await driver.start()
    await until(() => results.length > 0)

    expect(spawns).toHaveLength(1)
    expect(spawns[0]).toMatchObject({ command: '/bin/sh', cwd: tmp, group: true })
    expect(spawns[0]?.env['GRANTED']).toBe('key-1')
    expect(results[0]).toEqual({ code: 0, stdout: 'key-1' })
  })

  it('ends the run with a terminal, never a hang, when the agent host is not running', async () => {
    vi.stubEnv('CLAWBOO_AGENT_USER', 'clawboo-agent')
    const results: string[] = []
    const driver = createSpawnDriver<string>({
      resolve: async () => ({ command: '/bin/echo', args: ['x'] }),
      parseLine: () => [],
      onClose: (_code, _signal, _stdout, stderr) => [stderr],
    })
    driver.onEvent((ev) => results.push(ev))
    await driver.start()
    expect(results).toHaveLength(1)
    expect(results[0]).toMatch(/agent host that starts them is not running/)
  })

  it('writes run context through the host, replacing a planted link', async () => {
    const { ops } = await agentModeOn()
    const driver = createSpawnDriver<string>({
      resolve: async () => ({ command: '/bin/sh', args: ['-c', 'sleep 5'], cwd: tmp }),
      parseLine: () => [],
      onClose: () => ['closed'],
    })
    await driver.start()
    const secret = path.join(tmp, 'secret.txt')
    fs.writeFileSync(secret, 'private')
    fs.mkdirSync(path.join(tmp, 'notes'))
    fs.symlinkSync(secret, path.join(tmp, 'notes', 'CONTEXT.md'))

    await driver.writeContext('notes/CONTEXT.md', '# context\n')
    await driver.writeContext('deeper/dir/BRIEF.md', 'brief\n')
    await driver.abort()

    expect(ops).toContain('fs.write')
    expect(ops).toContain('fs.mkdir')
    expect(fs.readFileSync(secret, 'utf8')).toBe('private')
    expect(fs.readFileSync(path.join(tmp, 'notes', 'CONTEXT.md'), 'utf8')).toBe('# context\n')
    expect(fs.readFileSync(path.join(tmp, 'deeper', 'dir', 'BRIEF.md'), 'utf8')).toBe('brief\n')
  })
})

// A codex app-server that runs one turn and reports the CODEX_HOME it was given.
const FAKE_CODEX_APP_SERVER = String.raw`
let buf = ''
const send = (m) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...m }) + '\n')
process.on('SIGTERM', () => process.exit(143))
process.stdin.on('data', (d) => {
  buf += d.toString()
  let nl
  while ((nl = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, nl)
    buf = buf.slice(nl + 1)
    if (!line.trim()) continue
    const m = JSON.parse(line)
    if (m.method === 'initialize') send({ id: m.id, result: { userAgent: 'fake' } })
    else if (m.method === 'thread/start') send({ id: m.id, result: { thread: { id: 'th-1' }, model: 'gpt-fake' } })
    else if (m.method === 'turn/start') {
      send({ id: m.id, result: { turn: { id: 'turn-1', status: 'inProgress', items: [] } } })
      send({ method: 'item/completed', params: { threadId: 'th-1', turnId: 'turn-1', item: { type: 'agentMessage', id: 'm1', text: 'home=' + process.env.CODEX_HOME } } })
      send({ method: 'turn/completed', params: { threadId: 'th-1', turn: { id: 'turn-1', status: 'completed', error: null, items: [] } } })
    }
  }
})
`

const OPTS: StartOpts = { agentId: 'a1', sessionKey: 'agent:a1:team:t1', message: 'go' }

describe.runIf(posix)('codex with agents on their own OS user', () => {
  it('runs the app-server through the agent host and writes context through it', async () => {
    const { spawns, ops } = await agentModeOn()
    const script = path.join(tmp, 'fake-app-server.cjs')
    fs.writeFileSync(script, FAKE_CODEX_APP_SERVER)
    const codexHome = path.join(tmp, 'codex-home')
    const driver = createCodexAppServerDriver(
      OPTS,
      { cwd: tmp },
      {
        prepareHome: async () => ({ codexHome, managed: true }),
        fallback: () => {
          throw new Error('fallback not expected')
        },
        command: process.execPath,
        args: [script],
        handshakeTimeoutMs: 5_000,
      },
    )
    const seen: CodexNativeEvent[] = []
    driver.onEvent((ev) => seen.push(ev))
    await driver.start()
    await until(() => seen.some((e) => e.type === 'result'))

    expect(seen.find((e) => e.type === 'result')).toMatchObject({
      ok: true,
      summary: `home=${codexHome}`,
    })
    expect(spawns).toHaveLength(1)
    expect(spawns[0]).toMatchObject({
      command: process.execPath,
      cwd: tmp,
      stdio: ['pipe', 'pipe', 'pipe'],
      group: true,
    })
    expect(spawns[0]?.env['CODEX_HOME']).toBe(codexHome)

    await driver.writeContext('CONTEXT.md', 'ctx\n')
    expect(ops).toContain('fs.write')
    expect(fs.readFileSync(path.join(tmp, 'CONTEXT.md'), 'utf8')).toBe('ctx\n')
  })

  it("probes the account's models through the agent host", async () => {
    const { spawns } = await agentModeOn()
    const probe = await probeCodexAppServer(
      { command: '/bin/sh', args: ['-c', 'exit 0'] },
      { PATH: process.env['PATH'] ?? '/usr/bin:/bin', MARK: 'probe' },
      5_000,
    )
    expect(probe).toBeNull()
    expect(spawns).toHaveLength(1)
    expect(spawns[0]).toMatchObject({ command: '/bin/sh', group: true })
    expect(spawns[0]?.env['MARK']).toBe('probe')
  })

  it('prepares a managed home through the host: made, seeded, checked, configured', async () => {
    const { ops } = await agentModeOn()
    // The agents' own sign-in, made by the in-app login run as the agent user.
    const usable = JSON.stringify({ tokens: { access_token: 'agents-token', refresh_token: 'r' } })
    fs.mkdirSync(path.join(agentHome, '.codex'))
    fs.writeFileSync(path.join(agentHome, '.codex', 'auth.json'), usable)
    const managed = path.join(agentHome, 'runtimes', 'codex', 'a1')

    const out = await prepareCodexHome({ homeDir: managed, mcpBaseUrl: 'http://127.0.0.1:9' })

    expect(out).toEqual({ codexHome: managed, managed: true })
    expect(fs.statSync(managed).mode & 0o777).toBe(0o700)
    expect(fs.readFileSync(path.join(managed, 'auth.json'), 'utf8')).toBe(usable)
    expect(fs.statSync(path.join(managed, 'auth.json')).mode & 0o777).toBe(0o600)
    expect(fs.readFileSync(path.join(managed, 'config.toml'), 'utf8')).toContain(
      '[mcp_servers.clawboo-tasks]',
    )
    for (const op of ['fs.mkdir', 'fs.stat', 'fs.write', 'fs.read']) expect(ops).toContain(op)
  })

  it('makes a throwaway home in agent space, not in the server temp folder', async () => {
    const { ops } = await agentModeOn()
    const { codexHome, managed } = await prepareCodexHome({
      apiKeyEnv: { OPENAI_API_KEY: 'sk-test' },
    })
    expect(managed).toBe(false)
    expect(codexHome.startsWith(path.join(agentHome, 'runtimes', '.throwaway', ''))).toBe(true)
    expect(path.basename(codexHome)).toMatch(/^clawboo-codex-home-[0-9a-f]{16}$/)
    expect(fs.statSync(codexHome).mode & 0o777).toBe(0o700)
    expect(ops).toContain('fs.mkdir')
  })
})

describe.runIf(posix)('codex home writes with agent isolation off', () => {
  it('never writes the seed through a link planted at auth.json', async () => {
    vi.stubEnv('CLAWBOO_AGENT_USER', '')
    const usable = JSON.stringify({ tokens: { access_token: 'user-token', refresh_token: 'r' } })
    fs.mkdirSync(path.join(operatorHome, '.codex'))
    fs.writeFileSync(path.join(operatorHome, '.codex', 'auth.json'), usable)
    const managed = path.join(tmp, 'managed')
    fs.mkdirSync(managed, { mode: 0o700 })
    const secret = path.join(tmp, 'clawboo.db')
    fs.writeFileSync(secret, 'database')
    fs.symlinkSync(secret, path.join(managed, 'auth.json'))

    await prepareCodexHome({ homeDir: managed })

    expect(fs.readFileSync(secret, 'utf8')).toBe('database')
    expect(fs.lstatSync(path.join(managed, 'auth.json')).isSymbolicLink()).toBe(false)
    expect(fs.readFileSync(path.join(managed, 'auth.json'), 'utf8')).toBe(usable)
  })
})

describe.runIf(posix)('hermes with agents on their own OS user', () => {
  it('provisions the home through the host and never follows a planted link', async () => {
    const { ops } = await agentModeOn()
    // The agents' own sign-in, made by the in-app login run as the agent user.
    const agentsAuth = JSON.stringify({
      providers: { 'openai-codex': { tokens: { access_token: 'a', refresh_token: 'r' } } },
    })
    fs.mkdirSync(path.join(agentHome, '.hermes'))
    fs.writeFileSync(path.join(agentHome, '.hermes', 'auth.json'), agentsAuth)
    const home = path.join(agentHome, 'runtimes', 'hermes', 'a1')
    fs.mkdirSync(home, { recursive: true, mode: 0o700 })
    fs.writeFileSync(path.join(home, 'config.yaml'), 'model:\n  provider: openrouter\n')
    const secret = path.join(tmp, 'master.key')
    fs.writeFileSync(secret, 'vault key')
    fs.symlinkSync(secret, path.join(home, 'auth.json'))
    fs.writeFileSync(path.join(home, 'mcp.json'), '{}')

    const out = await provisionHermesHome(home, {
      mcpServers: { 'clawboo-tasks': { url: 'http://127.0.0.1:9/api/mcp/tasks' } },
    })

    expect(out).toMatchObject({ created: false, seededConfig: false, seededAuth: true })
    expect(fs.readFileSync(secret, 'utf8')).toBe('vault key')
    expect(fs.readFileSync(path.join(home, 'auth.json'), 'utf8')).toBe(agentsAuth)
    expect(fs.existsSync(path.join(home, 'mcp.json'))).toBe(false)
    const config = fs.readFileSync(path.join(home, 'config.yaml'), 'utf8')
    expect(config).toContain('clawboo-tasks:')
    expect(fs.statSync(path.join(home, 'config.yaml')).mode & 0o777).toBe(0o600)
    for (const op of ['fs.stat', 'fs.mkdir', 'fs.read', 'fs.write', 'fs.rm']) {
      expect(ops).toContain(op)
    }

    ops.length = 0
    expect(await detectProvider(home)).toBe('openrouter')
    expect(ops).toEqual(['fs.read'])
  })

  it("reads the managed home's subscription login through the host", async () => {
    const { ops } = await agentModeOn()
    const home = path.join(agentHome, 'runtimes', 'hermes', 'a1')
    fs.mkdirSync(home, { recursive: true, mode: 0o700 })
    fs.writeFileSync(
      path.join(home, 'auth.json'),
      JSON.stringify({ credential_pool: { 'openai-codex': [{ access_token: 'a' }] } }),
    )
    const run = await resolveHermesRun(
      OPTS,
      { providerHint: 'openai-codex', model: 'gpt-x' },
      { home, created: false, seededConfig: false, seededAuth: false },
    )
    expect(run.pickedProvider).toBe('openai-codex')
    expect(ops).toContain('fs.read')
  })

  it('lists native skills through the host', async () => {
    const { ops } = await agentModeOn()
    const home = path.join(agentHome, 'runtimes', 'hermes', 'a1')
    fs.mkdirSync(path.join(home, 'skills', 'web-scraper'), { recursive: true })
    fs.writeFileSync(path.join(home, 'skills', 'summarize.md'), '# skill')
    expect(await listNativeSkills(home)).toEqual(['summarize', 'web-scraper'])
    expect(ops).toEqual(['fs.list'])
  })

  it('starts hermes acp through the host, in a throwaway home in agent space', async () => {
    const { spawns } = await agentModeOn()
    const quietHandlers: Array<(ev: HermesNativeEvent) => void> = []
    const quiet: HermesDriver = {
      async start() {
        for (const h of quietHandlers) h({ type: 'result', ok: true, summary: 'quiet ran' })
      },
      onEvent(h) {
        quietHandlers.push(h)
        return () => undefined
      },
      async abort() {},
      async setModel() {},
      async writeContext() {},
    }
    const driver = createHermesAcpDriver(
      OPTS,
      { cwd: tmp, apiKeyEnv: { OPENROUTER_API_KEY: 'sk-or-test' } },
      {
        fallback: () => quiet,
        // No ACP here: the handshake fails and the run falls back.
        command: '/bin/sh',
        args: ['-c', 'exit 3'],
        handshakeTimeoutMs: 5_000,
      },
    )
    const seen: HermesNativeEvent[] = []
    driver.onEvent((ev) => seen.push(ev))
    await driver.start()
    await until(() => seen.some((e) => e.type === 'result'))

    expect(spawns).toHaveLength(1)
    expect(spawns[0]).toMatchObject({ command: '/bin/sh', cwd: tmp, group: true })
    const home = spawns[0]?.env['HERMES_HOME'] ?? ''
    expect(home.startsWith(path.join(agentHome, 'runtimes', '.throwaway', ''))).toBe(true)
    // The throwaway home (it holds a copy of the sign-in) goes with the ACP attempt.
    await until(() => !fs.existsSync(home))
  })

  it('runs the ACP check through the host, in a throwaway home it removes', async () => {
    const { spawns, ops } = await agentModeOn()
    const answer = await runHermesAcpCheck({
      command: '/bin/sh',
      args: ['-c', 'echo "Hermes ACP check OK"'],
      timeoutMs: 5_000,
    })
    expect(answer).toBe(true)
    expect(spawns).toHaveLength(1)
    expect(spawns[0]).toMatchObject({ command: '/bin/sh', group: true })
    const home = spawns[0]?.env['HERMES_HOME'] ?? ''
    expect(home.startsWith(path.join(agentHome, 'runtimes', '.throwaway', ''))).toBe(true)
    expect(fs.existsSync(home)).toBe(false)
    expect(ops).toEqual(expect.arrayContaining(['fs.mkdir', 'fs.rm']))
  })
})

describe.runIf(posix)('Claude Code with agents on their own OS user', () => {
  it('starts the CLI through the host, in the engine group, with stderr drained', async () => {
    const { spawns } = await agentModeOn()
    let stderr = ''
    const child = spawnTrackedClaudeProcess(
      {
        command: '/bin/sh',
        args: ['-c', 'printf out; printf err >&2'],
        cwd: tmp,
        env: { PATH: '/usr/bin:/bin' },
      },
      (chunk) => {
        stderr += chunk
      },
    )
    expect(isHostedAgentProcess(child)).toBe(true)
    let stdout = ''
    child.stdout?.on('data', (d: Buffer) => {
      stdout += d.toString()
    })
    await closed(child)
    expect(stdout).toBe('out')
    expect(stderr).toBe('err')
    expect(spawns[0]).toMatchObject({
      command: '/bin/sh',
      cwd: tmp,
      stdio: ['pipe', 'pipe', 'pipe'],
      group: false,
    })
  })

  it('stops the CLI through the host when the SDK aborts it', async () => {
    const { ops } = await agentModeOn()
    const abort = new AbortController()
    const child = spawnTrackedClaudeProcess(
      {
        command: '/bin/sh',
        args: ['-c', 'sleep 30'],
        env: { PATH: '/usr/bin:/bin' },
        signal: abort.signal,
      },
      () => undefined,
    )
    child.on('error', () => undefined)
    await until(() => typeof child.pid === 'number')
    abort.abort()
    await closed(child)
    expect(ops).toContain('killTree')
  })

  /** A scripted SDK that records the env the driver handed it, then ends the run. */
  function recordingSdk(envs: Array<Record<string, string | undefined>>): SdkModule {
    return {
      query({ options }) {
        envs.push(options?.['env'] as Record<string, string | undefined>)
        let done = false
        return {
          [Symbol.asyncIterator]: () => ({
            async next() {
              if (done) return { done: true, value: undefined }
              done = true
              return { done: false, value: { type: 'result', subtype: 'success', result: 'ok' } }
            },
          }),
        }
      },
    }
  }

  async function runOnce(ctx: RuntimeRunContext): Promise<Record<string, string | undefined>> {
    const envs: Array<Record<string, string | undefined>> = []
    const driver = createClaudeCodeDriver(OPTS, ctx, { loadSdk: async () => recordingSdk(envs) })
    const seen: ClaudeNativeEvent[] = []
    driver.onEvent((ev) => seen.push(ev))
    await driver.start()
    await until(() => seen.some((e) => e.type === 'result'))
    expect(envs).toHaveLength(1)
    return envs[0]!
  }

  it("keeps the CLI's config and sessions in the run's per-agent home", async () => {
    await agentModeOn()
    const home = path.join(agentHome, 'runtimes', 'claude-code', 'a1')
    const env = await runOnce({ homeDir: home })
    expect(env['CLAUDE_CONFIG_DIR']).toBe(home)
  })

  it("leaves the CLI on the operator's own config with the setting off, or with no home", async () => {
    vi.stubEnv('CLAWBOO_AGENT_USER', '')
    vi.stubEnv('CLAUDE_CONFIG_DIR', undefined)
    expect((await runOnce({ homeDir: path.join(tmp, 'h') }))['CLAUDE_CONFIG_DIR']).toBeUndefined()
    await agentModeOn()
    expect((await runOnce({}))['CLAUDE_CONFIG_DIR']).toBeUndefined()
  })

  it('writes run context through the host', async () => {
    const { ops } = await agentModeOn()
    const driver = createClaudeCodeDriver(
      OPTS,
      { cwd: tmp },
      {
        loadSdk: async () => recordingSdk([]),
      },
    )
    await driver.writeContext('CONTEXT.md', 'ctx\n')
    expect(ops).toEqual(['fs.stat', 'fs.write'])
    expect(fs.readFileSync(path.join(tmp, 'CONTEXT.md'), 'utf8')).toBe('ctx\n')
  })
})

describe.runIf(posix)('Clawboo Native with agents on their own OS user', () => {
  it('writes run context through the host', async () => {
    const { ops } = await agentModeOn()
    fs.mkdirSync(path.join(tmp, 'docs'), { mode: 0o700 })
    const driver = createNativeDriver(OPTS, { cwd: tmp })
    await driver.writeContext('docs/CONTEXT.md', 'ctx\n')
    expect(ops).toEqual(['fs.stat', 'fs.write'])
    expect(fs.readFileSync(path.join(tmp, 'docs', 'CONTEXT.md'), 'utf8')).toBe('ctx\n')
    // A folder that was there keeps its mode (a team folder is owner-only).
    expect(fs.statSync(path.join(tmp, 'docs')).mode & 0o777).toBe(0o700)
  })
})

describe.runIf(posix)('team folders with agents on their own OS user', () => {
  it('makes the team folder through the host, owner-only', async () => {
    const { ops } = await agentModeOn()
    const dir = path.join(agentHome, 'work', 'teams', 't1')
    await ensureTeamWorkdir(dir)
    expect(ops).toEqual(['fs.mkdir'])
    expect(fs.statSync(dir).mode & 0o777).toBe(0o700)
  })
})
