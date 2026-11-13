// The supervised Hermes gateway: started with an allow-listed environment and
// the API server on loopback with a key, healthy only once its API answers with
// that key, restarted with backoff when it exits on its own, stopped with SIGINT
// (Hermes reads a bare SIGTERM as a crash), and never restarted for a config it
// refuses for good.

import { EventEmitter } from 'node:events'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { PassThrough } from 'node:stream'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../../subprocess', () => ({
  registerRuntimeChild: () => undefined,
  unregisterRuntimeChild: () => undefined,
  isSubprocessShutdown: () => false,
}))
vi.mock('../../killTree', () => ({
  killProcessTree: (p: { kill: (s: string) => void }) => p.kill('SIGKILL'),
}))

const { HermesGatewaySupervisor, gatewayEnv } = await import('../gateway')
const { derivedHermesKey } = await import('../profiles')

class FakeProc extends EventEmitter {
  pid = 4242
  exitCode: number | null = null
  signalCode: NodeJS.Signals | null = null
  killed = false
  stdin = null
  stdout = new PassThrough()
  stderr = new PassThrough()
  signals: string[] = []
  /** How long it takes to drain after SIGINT. */
  drainMs = 5
  kill(signal: NodeJS.Signals = 'SIGTERM'): boolean {
    this.signals.push(signal)
    if (signal === 'SIGINT') setTimeout(() => this.exit(0, null), this.drainMs)
    if (signal === 'SIGKILL') setTimeout(() => this.exit(null, 'SIGKILL'), 5)
    return true
  }
  exit(code: number | null, signal: NodeJS.Signals | null): void {
    if (this.exitCode !== null || this.signalCode !== null) return
    this.exitCode = code
    this.signalCode = signal
    this.emit('exit', code, signal)
    this.emit('close', code, signal)
  }
}

const MASTER = 'k'.repeat(64)

describe('HermesGatewaySupervisor', () => {
  let home: string
  let procs: FakeProc[]
  let spawned: { command: string; args: readonly string[]; env: Record<string, string> }[]
  let healthy: boolean
  /** Health checks to fail before answering again. */
  let healthFailures: number
  let healthCalls: number

  beforeEach(async () => {
    home = await mkdtemp(path.join(os.tmpdir(), 'clawboo-hermes-gw-'))
    procs = []
    spawned = []
    healthy = true
    healthFailures = 0
    healthCalls = 0
  })
  afterEach(async () => {
    await rm(home, { recursive: true, force: true })
  })

  const fetchStub: typeof fetch = async (input, init) => {
    const url = String(input)
    if (!healthy || procs.at(-1)?.exitCode !== null) throw new TypeError('fetch failed')
    if (url.endsWith('/health')) {
      healthCalls += 1
      if (healthFailures > 0) {
        healthFailures -= 1
        throw new DOMException('The operation timed out.', 'TimeoutError')
      }
      return new Response(JSON.stringify({ status: 'ok', version: '0.23.1' }))
    }
    const auth = new Headers(init?.headers).get('authorization')
    if (auth !== `Bearer ${derivedHermesKey(MASTER, '_root')}`) {
      return new Response(JSON.stringify({ error: 'Invalid API key' }), { status: 401 })
    }
    return new Response(JSON.stringify({ jobs: [] }))
  }

  const make = (over: Record<string, unknown> = {}) =>
    new HermesGatewaySupervisor({
      resolveCommand: () => '/opt/runtimes/hermes/v0.23.1/venv/bin/hermes',
      home: () => home,
      preferredPort: () => 18642,
      isPortFree: async (p) => p !== 18642,
      masterKey: () => MASTER,
      fetch: fetchStub,
      spawn: (opts) => {
        spawned.push({
          command: opts.command,
          args: opts.args,
          env: opts.env as Record<string, string>,
        })
        const p = new FakeProc()
        procs.push(p)
        return p as never
      },
      startTimeoutMs: 2_000,
      stopGraceMs: 200,
      backoffMs: [20, 40],
      ...over,
    })

  it('starts `hermes gateway run` under the supervisor with a scrubbed environment', async () => {
    const before = { ...process.env }
    process.env['TELEGRAM_BOT_TOKEN'] = 'should-not-pass'
    process.env['CLAWBOO_SECRETS_MASTER_KEY'] = 'nope'
    process.env['OPENROUTER_API_KEY'] = 'nor-this'
    try {
      const gw = make()
      const conn = await gw.ensureRunning()
      expect(conn).toMatchObject({ baseUrl: 'http://127.0.0.1:18643', home, port: 18643 })
      expect(spawned[0]!.args).toEqual(['gateway', 'run', '--external-supervisor', '-v'])
      const env = spawned[0]!.env
      expect(env['HERMES_HOME']).toBe(home)
      expect(env['HERMES_GATEWAY_LOCK_DIR']).toBe(path.join(home, '.clawboo-locks'))
      expect(env['TELEGRAM_BOT_TOKEN']).toBeUndefined()
      expect(env['CLAWBOO_SECRETS_MASTER_KEY']).toBeUndefined()
      expect(env['OPENROUTER_API_KEY']).toBeUndefined()
      expect(env['HERMES_YOLO_MODE']).toBeUndefined()
      expect(env['PATH']!.split(path.delimiter)[0]).toBe('/opt/runtimes/hermes/v0.23.1/venv/bin')
      // The key goes in the home's .env, never on the command line.
      const dotenv = await readFile(path.join(home, '.env'), 'utf8')
      expect(dotenv).toContain(`API_SERVER_KEY="${derivedHermesKey(MASTER, '_root')}"`)
      expect(dotenv).toContain('API_SERVER_PORT="18643"')
      expect(spawned[0]!.args.join(' ')).not.toContain(derivedHermesKey(MASTER, '_root'))
      expect(gw.status()).toMatchObject({ state: 'running', port: 18643, version: '0.23.1' })
    } finally {
      process.env = before
    }
  })

  it('joins one start for many callers', async () => {
    const gw = make()
    const [a, b] = await Promise.all([gw.ensureRunning(), gw.ensureRunning()])
    expect(a).toEqual(b)
    expect(spawned).toHaveLength(1)
  })

  it('is not healthy until the API answers: a listener that never comes fails the start', async () => {
    healthy = false
    const gw = make({ startTimeoutMs: 300 })
    await expect(gw.ensureRunning()).rejects.toThrow(/did not answer on its port/)
    expect(gw.status().state).toBe('failed')
    expect(procs[0]!.signals.length).toBeGreaterThan(0)
  })

  it('restarts after an exit it did not ask for, with backoff', async () => {
    const gw = make()
    await gw.ensureRunning()
    procs[0]!.exit(1, null)
    expect(gw.status().state).toBe('restarting')
    await vi.waitFor(() => expect(gw.status().state).toBe('running'), { timeout: 2_000 })
    expect(spawned).toHaveLength(2)
    expect(gw.status().restarts).toBe(1)
  })

  it('replaces a gateway that is alive but no longer answers, draining it first', async () => {
    const gw = make()
    await gw.ensureRunning()
    healthy = false
    const pending = gw.ensureRunning()
    // The hung one is stopped and a new one started; it answers again.
    await vi.waitFor(() => expect(spawned).toHaveLength(2), { timeout: 6_000 })
    healthy = true
    await expect(pending).resolves.toMatchObject({ port: 18643 })
    expect(procs[0]!.signals[0]).toBe('SIGINT')
  }, 10_000)

  it('keeps a busy gateway that answers a health check late', async () => {
    const gw = make()
    await gw.ensureRunning()
    const calls = healthCalls
    healthFailures = 1
    await expect(gw.ensureRunning()).resolves.toMatchObject({ port: 18643 })
    expect(healthCalls - calls).toBe(2)
    expect(spawned).toHaveLength(1)
    expect(procs[0]!.signals).toEqual([])
  })

  it('a start asked for while a stop drains waits for it, and keeps the new gateway', async () => {
    const gw = make()
    await gw.ensureRunning()
    procs[0]!.drainMs = 150
    const stopping = gw.stop()
    const next = gw.ensureRunning()
    await stopping
    await expect(next).resolves.toMatchObject({ port: 18643 })
    expect(spawned).toHaveLength(2)
    expect(gw.status()).toMatchObject({ state: 'running', pid: 4242 })
    expect(procs[1]!.signals).toEqual([])
    // The new one is the one stopped next, not lost.
    await gw.stop()
    expect(procs[1]!.signals[0]).toBe('SIGINT')
  })

  it('a stop during a start stops the gateway that start brings up', async () => {
    const gw = make()
    const starting = gw.ensureRunning()
    const stopped = gw.stop()
    await starting.catch(() => undefined)
    await stopped
    expect(gw.status().state).toBe('stopped')
    expect(procs[0]!.signals[0]).toBe('SIGINT')
    procs[0]!.exit(1, null)
    await new Promise((r) => setTimeout(r, 100))
    expect(spawned).toHaveLength(1)
  })

  it('does not keep restarting when a restart is refused for its config (exit 78)', async () => {
    const gw = make({
      spawn: (opts: { command: string; args: readonly string[]; env: Record<string, string> }) => {
        spawned.push({
          command: opts.command,
          args: opts.args,
          env: opts.env as Record<string, string>,
        })
        const p = new FakeProc()
        procs.push(p)
        // Every gateway after the first refuses its config at once.
        if (procs.length > 1) setTimeout(() => p.exit(78, null), 1)
        return p as never
      },
    })
    await gw.ensureRunning()
    procs[0]!.exit(1, null)
    await vi.waitFor(() => expect(spawned).toHaveLength(2), { timeout: 2_000 })
    await vi.waitFor(() => expect(gw.status().state).toBe('failed'), { timeout: 2_000 })
    await new Promise((r) => setTimeout(r, 200))
    expect(spawned).toHaveLength(2)
  })

  it('does not restart a config Hermes refuses for good (exit 78)', async () => {
    const gw = make()
    await gw.ensureRunning()
    procs[0]!.exit(78, null)
    expect(gw.status().state).toBe('failed')
    await new Promise((r) => setTimeout(r, 100))
    expect(spawned).toHaveLength(1)
  })

  it('stops with SIGINT and does not restart after a planned stop', async () => {
    const gw = make()
    await gw.ensureRunning()
    await gw.stop()
    expect(procs[0]!.signals[0]).toBe('SIGINT')
    expect(gw.status().state).toBe('stopped')
    await new Promise((r) => setTimeout(r, 100))
    expect(spawned).toHaveLength(1)
  })

  it('marks the running install in use, so an update keeps its folder', async () => {
    const pids: number[] = []
    const gw = make({ onStarted: (pid: number) => pids.push(pid) })
    await gw.ensureRunning()
    expect(pids).toEqual([4242])
  })

  it('says why an install on record cannot be used', async () => {
    const gw = make({ resolveCommand: () => null, installProblem: () => 'its Python is gone.' })
    await expect(gw.ensureRunning()).rejects.toThrow(/cannot be used: its Python is gone\./)
  })

  it('reads installed again once an install appears after a failed start', async () => {
    let command: string | null = null
    const gw = make({ resolveCommand: () => command })
    await expect(gw.ensureRunning()).rejects.toThrow(/not installed by Clawboo/)
    expect(gw.status().state).toBe('not-installed')
    command = '/opt/runtimes/hermes/v0.23.1/venv/bin/hermes'
    expect(gw.status().state).toBe('stopped')
  })

  it('reports not-installed without Clawboo’s own install', async () => {
    const gw = make({ resolveCommand: () => null })
    expect(gw.status().state).toBe('not-installed')
    await expect(gw.ensureRunning()).rejects.toThrow(/not installed by Clawboo/)
    expect(spawned).toHaveLength(0)
  })
})

describe('gatewayEnv', () => {
  it('passes only an allow list from the base environment', () => {
    const env = gatewayEnv({
      home: '/h',
      command: '/v/bin/hermes',
      base: {
        PATH: '/usr/bin',
        HOME: '/Users/me',
        LANG: 'en_US.UTF-8',
        LC_ALL: 'C',
        HTTPS_PROXY: 'http://proxy:1',
        DISCORD_BOT_TOKEN: 'x',
        GITHUB_TOKEN: 'y',
        API_SERVER_KEY: 'z',
      },
    })
    expect(env).toMatchObject({
      HOME: '/Users/me',
      LANG: 'en_US.UTF-8',
      LC_ALL: 'C',
      HTTPS_PROXY: 'http://proxy:1',
      HERMES_HOME: '/h',
    })
    expect(env['PATH']).toBe(['/v/bin', '/usr/bin'].join(path.delimiter))
    for (const k of ['DISCORD_BOT_TOKEN', 'GITHUB_TOKEN', 'API_SERVER_KEY'])
      expect(env[k]).toBeUndefined()
  })

  it('keeps loopback off the proxy, so Clawboo’s own MCP servers are reached directly', () => {
    const env = gatewayEnv({
      home: '/h',
      command: '/v/bin/hermes',
      base: { PATH: '/usr/bin', HTTPS_PROXY: 'http://proxy:3128', NO_PROXY: 'corp.internal' },
    })
    expect(env['HTTPS_PROXY']).toBe('http://proxy:3128')
    expect(env['NO_PROXY']!.split(',')).toEqual(['corp.internal', '127.0.0.1', 'localhost', '::1'])
    expect(env['no_proxy']).toBe(env['NO_PROXY'])
    expect(
      gatewayEnv({ home: '/h', command: '/v/bin/hermes', base: { PATH: '/usr/bin' } })['NO_PROXY'],
    ).toBeUndefined()
  })

  it("leaves the user's identity to the agent host when agents run as their own user", () => {
    const env = gatewayEnv({
      home: '/h',
      command: '/v/bin/hermes',
      base: { PATH: '/usr/bin', HOME: '/Users/me', USER: 'me', TMPDIR: '/tmp/me' },
      agentUser: true,
    })
    expect(env['HOME']).toBeUndefined()
    expect(env['USER']).toBeUndefined()
    expect(env['TMPDIR']).toBeUndefined()
    expect(env['HERMES_HOME']).toBe('/h')
  })
})
