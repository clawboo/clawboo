// The supervised Hermes gateway: one long-lived `hermes gateway run` that every
// Clawboo Hermes agent's runs go through, the way OpenClaw's agents live in
// OpenClaw's Gateway.
//
// - Started on demand (a run, the Runtimes card, a jobs read) and at boot when
//   Hermes is installed and Clawboo has Hermes agents, so their own scheduled
//   jobs fire. Restarted with backoff when it exits on its own. Stopped with
//   Clawboo, by its own planned stop (`stopForExit`), not the generic reap that
//   SIGTERMs every other runtime child. Its pid is still in the durable record,
//   so the next boot reaps one a crash left behind.
// - Only the API server is on, on loopback, with a key from the vault. It starts
//   with a short allow-listed environment, never the server's own, so no chat
//   token in the operator's shell can turn a Hermes channel on, and no Clawboo
//   secret reaches Hermes or the commands its agents run.
// - Health is the API listener answering with the key, not the process being
//   alive: Hermes stays up with no listener when its key or port is refused.
// - `--external-supervisor` makes Hermes exit back to Clawboo (code 75) instead
//   of restarting itself detached. A planned stop is SIGINT: Hermes reads a bare
//   SIGTERM as a crash. Its user-wide gateway lock goes in a private folder of
//   the gateway home (`HERMES_GATEWAY_LOCK_DIR`), so a person's own Hermes
//   gateway and this one never decide for each other.

import type { ChildProcess } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import path from 'node:path'

import { createLogger } from '@clawboo/logger'

import { isWindows } from '../../platform'
import { isLoopbackPortFree } from '../../portUtils'
import { getRuntimeSecret, runtimeVaultReadable, setRuntimeSecret } from '../../secretsVault'
import { killProcessTree, killProcessTreeNow } from '../killTree'
import { isAgentPoolMode } from '../../agentUser/config'
import { isAgentUserMode, spawnAgentProcess } from '../spawner'
import { isSubprocessShutdown, recordRuntimeChildPid } from '../subprocess'
import { createHermesClient, type HermesClient } from './client'
import { gatewayPortOwner, type PortOwner } from './portOwner'
import { derivedHermesKey, hermesGatewayHome, provisionGatewayHome } from './profiles'

const log = createLogger('hermes-gateway')

/** The vault slot of the gateway's master key. Every API key Hermes holds is
 *  derived from it, so it is the only one stored. */
export const HERMES_MASTER_KEY_SLOT = 'HERMES_API_SERVER_KEY'

/** Hermes's own default port for its API server. */
export const HERMES_DEFAULT_PORT = 8642
/** How many ports above the preferred one are tried when it is taken. */
const PORT_SCAN = 40

/** How long a start may take to answer on its port. The first start compiles
 *  Hermes's Python files and can take a while on a busy machine. */
const START_TIMEOUT_MS = 120_000
const HEALTH_POLL_MS = 500
/** How long a planned stop waits after SIGINT before killing the tree. Hermes
 *  drains API runs for up to 30 s and forces its own exit by about 60 s. */
const STOP_GRACE_MS = 40_000
/**
 * When Clawboo itself stops, how long the gateway gets after SIGINT before its
 * tree is killed: `CLAWBOO_HERMES_STOP_GRACE_MS`, 5 s by default and never more
 * than 8 s. The cap keeps the whole shutdown (this wait, then up to
 * `EXIT_KILL_WAIT_MS` after the kill) near 9 s, well inside the 15 s an app that
 * runs Clawboo may give a stop. An idle Hermes 0.23.1 stops in about a second:
 * its chat drain is 0 s, and only cron jobs and API runs still going hold it, for
 * up to 30 s (`agent.cron_drain_timeout`), which this cuts short.
 */
export const EXIT_GRACE_DEFAULT_MS = 5_000
export const EXIT_GRACE_MAX_MS = 8_000
/** After the SIGKILL at exit, how long to wait for the process to go. */
const EXIT_KILL_WAIT_MS = 1_000
/** Waits between restarts after unplanned exits, in order; the last repeats. */
const RESTART_BACKOFF_MS = [1_000, 2_000, 5_000, 10_000, 30_000, 60_000]
/** Up this long, a gateway's earlier crashes are forgiven. */
const STABLE_AFTER_MS = 10 * 60_000
/** Exits that no restart can fix: a config Hermes refuses for good (78), an
 *  unreadable config.yaml (2). */
const PERMANENT_EXIT_CODES = new Set([2, 78])
/** Restarts in a row before the supervisor stops trying on its own. */
const MAX_RESTART_ATTEMPTS = 10
/** Health checks in a row, a second apart, a running gateway may fail before
 *  it is replaced: a busy one answers slowly, and replacing it ends every run. */
const HEALTH_TRIES = 3
const HEALTH_TIMEOUT_MS = 5_000
/** Last stderr kept for a failure message. */
const STDERR_TAIL_CHARS = 8_000

export type HermesGatewayState =
  'stopped' | 'starting' | 'running' | 'restarting' | 'failed' | 'not-installed'

export interface HermesGatewayStatus {
  state: HermesGatewayState
  port: number | null
  pid: number | null
  startedAt: number | null
  restarts: number
  /** Why it is not running, in words a person can act on. Never a secret. */
  lastError: string | null
  version: string | null
}

export interface HermesGatewayConnection {
  baseUrl: string
  /** The gateway home: profiles live under it. */
  home: string
  /** The master key every API key is derived from. */
  masterKey: string
  port: number
}

export interface HermesGatewayDeps {
  /** The `hermes` executable of Clawboo's own install, or null when there is none. */
  resolveCommand: () => string | null
  /** Why Clawboo's install is on record but cannot be used, or null. */
  installProblem?: () => string | null
  /** Called with the pid of each gateway started, so an update does not remove
   *  the install folder under it. */
  onStarted?: (pid: number) => void
  /** Run before each start, after the gateway home is written, with the key it
   *  starts with (the profiles' provider keys and own keys are brought up to
   *  date here). */
  beforeStart?: (home: string, masterKey: string) => Promise<void>
  home?: () => string
  /** The port to prefer (default `CLAWBOO_HERMES_GATEWAY_PORT`, else 8642). */
  preferredPort?: () => number
  spawn?: (opts: Parameters<typeof spawnAgentProcess>[0]) => ChildProcess
  fetch?: typeof fetch
  isPortFree?: (port: number) => Promise<boolean>
  /** Who answers on the gateway's port (default `gatewayPortOwner`). */
  portOwner?: (port: number, pid: number) => Promise<PortOwner>
  masterKey?: () => string
  now?: () => number
  startTimeoutMs?: number
  stopGraceMs?: number
  backoffMs?: readonly number[]
}

/** The environment the gateway starts with: an allow list, never the server's
 *  own environment. */
export function gatewayEnv(opts: {
  home: string
  command: string
  base?: NodeJS.ProcessEnv
  /** Agents run as their own OS user (`isAgentUserMode`). */
  agentUser?: boolean
}): Record<string, string> {
  const base = opts.base ?? process.env
  const env: Record<string, string> = {}
  // Who the process is. When agents run as their own OS user, the agent host
  // sets these to that user's, so the server's own are not passed.
  const identity = opts.agentUser ? [] : ['HOME', 'USER', 'LOGNAME', 'SHELL', 'TMPDIR']
  const keep = [
    ...identity,
    'TZ',
    'LANG',
    'TERM',
    'SystemRoot',
    'SYSTEMROOT',
    'windir',
    'COMSPEC',
    'PATHEXT',
    'USERPROFILE',
    'APPDATA',
    'LOCALAPPDATA',
    'TEMP',
    'TMP',
    'HTTP_PROXY',
    'HTTPS_PROXY',
    'NO_PROXY',
    'http_proxy',
    'https_proxy',
    'no_proxy',
    'SSL_CERT_FILE',
    'SSL_CERT_DIR',
    'REQUESTS_CA_BUNDLE',
    'NODE_EXTRA_CA_CERTS',
  ]
  for (const name of keep) {
    const v = base[name]
    if (typeof v === 'string' && v !== '') env[name] = v
  }
  for (const [name, v] of Object.entries(base)) {
    if (name.startsWith('LC_') && typeof v === 'string') env[name] = v
  }
  // The venv's own bin first, so the tools Hermes starts find its Python.
  env['PATH'] = [path.dirname(opts.command), base['PATH'] ?? '']
    .filter(Boolean)
    .join(path.delimiter)
  // With a proxy set, Clawboo's own MCP servers on loopback must never go
  // through it.
  if (
    ['HTTPS_PROXY', 'https_proxy', 'HTTP_PROXY', 'http_proxy', 'ALL_PROXY', 'all_proxy'].some(
      (k) => env[k] || base[k],
    )
  ) {
    for (const name of ['ALL_PROXY', 'all_proxy']) {
      const v = base[name]
      if (typeof v === 'string' && v !== '') env[name] = v
    }
    const listed = (env['NO_PROXY'] ?? env['no_proxy'] ?? '')
      .split(',')
      .map((h) => h.trim())
      .filter(Boolean)
    const noProxy = [...new Set([...listed, '127.0.0.1', 'localhost', '::1'])].join(',')
    env['NO_PROXY'] = noProxy
    env['no_proxy'] = noProxy
  }
  env['HERMES_HOME'] = opts.home
  env['HERMES_GATEWAY_LOCK_DIR'] = path.join(opts.home, '.clawboo-locks')
  env['PYTHONUNBUFFERED'] = '1'
  return env
}

/** The vault's master key, minted once. Throws when the vault cannot hold it. */
function vaultMasterKey(): string {
  const existing = getRuntimeSecret(HERMES_MASTER_KEY_SLOT)
  if (existing && existing.length >= 32) return existing
  // Minting writes the vault. One that is there but cannot be read would be
  // replaced by the Hermes key alone, and every other saved key lost with it.
  if (!runtimeVaultReadable()) {
    throw new Error(
      "Clawboo's key vault cannot be read, so the Hermes gateway key was not made and the vault was left as it is. Check secrets/runtime-keys.json in Clawboo's data folder.",
    )
  }
  const minted = randomBytes(32).toString('hex')
  setRuntimeSecret(HERMES_MASTER_KEY_SLOT, minted)
  const stored = getRuntimeSecret(HERMES_MASTER_KEY_SLOT)
  if (stored !== minted) throw new Error('the key vault could not store the Hermes gateway key')
  return minted
}

function preferredPortFromEnv(): number {
  const raw = Number(process.env['CLAWBOO_HERMES_GATEWAY_PORT'])
  return Number.isInteger(raw) && raw > 0 && raw < 65536 ? raw : HERMES_DEFAULT_PORT
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

/** Whether `p` settles within `ms`. The timer is cleared when it does, so a
 *  settled wait holds the event loop open no longer. */
function settlesWithin(p: Promise<void>, ms: number): Promise<boolean> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(false), ms)
    void p.then(() => {
      clearTimeout(timer)
      resolve(true)
    })
  })
}

/**
 * See out a gateway that already has its stop signal: up to `graceMs` for it
 * to exit, then SIGKILL to its tree and up to `EXIT_KILL_WAIT_MS` more; what
 * is left in its process group is killed either way.
 */
async function seeOutForExit(proc: ChildProcess, graceMs: number): Promise<void> {
  if (proc.exitCode !== null || proc.signalCode !== null) return
  const exited = new Promise<void>((resolve) => proc.once('exit', () => resolve()))
  const done = await settlesWithin(exited, graceMs)
  killProcessTreeNow(proc)
  if (!done) await settlesWithin(exited, EXIT_KILL_WAIT_MS)
}

/**
 * `CLAWBOO_HERMES_STOP_GRACE_MS`, read for a stop of the server: milliseconds,
 * 0 to `EXIT_GRACE_MAX_MS`. Larger values are cut to the cap; anything that is
 * not a number of 0 or more means the default.
 */
export function hermesExitGraceMs(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env['CLAWBOO_HERMES_STOP_GRACE_MS']?.trim()
  if (!raw) return EXIT_GRACE_DEFAULT_MS
  const ms = Number(raw)
  if (!Number.isFinite(ms) || ms < 0) return EXIT_GRACE_DEFAULT_MS
  return Math.min(Math.round(ms), EXIT_GRACE_MAX_MS)
}

/** How a stop at server exit ended. */
export type HermesExitOutcome =
  /** No gateway process was running. */
  | 'not-running'
  /** It exited after SIGINT, within the grace. */
  | 'stopped'
  /** The grace ran out, and it exited after its tree was killed. */
  | 'killed'
  /** Killed, and still not gone when the wait after the kill ran out. */
  | 'still-running'

export class HermesGatewaySupervisor {
  private proc: ChildProcess | null = null
  private state: HermesGatewayState = 'stopped'
  private port: number | null = null
  private startedAt: number | null = null
  private restarts = 0
  private crashes = 0
  private lastError: string | null = null
  private version: string | null = null
  private stderrTail = ''
  private starting: Promise<HermesGatewayConnection> | null = null
  private stopping = false
  /** Set once the server has begun to exit: no gateway starts after it. */
  private exiting = false
  /** Gateways a failed start let go of while they still ran: they have had
   *  killProcessTree's SIGTERM, and its SIGKILL is a timer that ends with this
   *  process, so the exit stop sees them out too. Each leaves on its exit. */
  private readonly leaving = new Set<ChildProcess>()
  private stopInFlight: Promise<void> | null = null
  private restartTimer: ReturnType<typeof setTimeout> | null = null
  private masterKey: string | null = null
  /** How the last gateway process exited, for a restart that fails to start. */
  private lastExitCode: number | null = null
  /** Said once: the owner of the gateway's port could not be read. */
  private ownerUnknownWarned = false

  constructor(private readonly deps: HermesGatewayDeps) {}

  status(): HermesGatewayStatus {
    const installed = this.deps.resolveCommand() !== null
    // "Not installed" is read fresh: an install since the last start clears it.
    const state =
      this.state === 'not-installed' || this.state === 'stopped'
        ? installed
          ? 'stopped'
          : 'not-installed'
        : this.state
    return {
      state,
      port: this.port,
      pid: this.state === 'running' ? (this.proc?.pid ?? null) : null,
      startedAt: this.state === 'running' ? this.startedAt : null,
      restarts: this.restarts,
      lastError: this.lastError,
      version: this.version,
    }
  }

  /** The gateway when it is running now, without a check or a start: for reads,
   *  which never start it. */
  runningConnection(): HermesGatewayConnection | null {
    if (this.state !== 'running' || !this.proc || this.port === null || !this.masterKey) return null
    return this.connection()
  }

  /** The running gateway, started first when it is not. Joins a start already
   *  under way, and waits out a stop. Rejects with a readable reason when it
   *  cannot start. */
  async ensureRunning(): Promise<HermesGatewayConnection> {
    if (this.stopInFlight) await this.stopInFlight
    if (this.starting) return this.starting
    if (this.state === 'running' && this.proc && this.port !== null && this.masterKey) {
      // A process that is alive but no longer answers is replaced, not trusted.
      const proc = this.proc
      const answered = await this.answers()
      // A stop, an exit or another start while the check was out: the answer
      // was about a gateway that is no longer the one to hand out.
      if (this.stopInFlight || this.starting || this.proc !== proc || this.state !== 'running') {
        return this.ensureRunning()
      }
      if (answered) return this.connection()
      log.warn({ pid: proc.pid }, 'hermes gateway stopped answering; restarting it')
      await this.stop()
      // Another caller may have started its replacement while this one waited:
      // join that start rather than begin a second.
      return this.ensureRunning()
    }
    if (this.restartTimer) {
      clearTimeout(this.restartTimer)
      this.restartTimer = null
    }
    this.stopping = false
    const run = this.start().finally(() => {
      if (this.starting === run) this.starting = null
    })
    this.starting = run
    return run
  }

  /** A client for the gateway's own (root) routes. */
  rootClient(conn: HermesGatewayConnection): HermesClient {
    return createHermesClient(
      { baseUrl: conn.baseUrl, profile: null, key: derivedHermesKey(conn.masterKey, '_root') },
      { fetch: this.deps.fetch },
    )
  }

  /** A client for one profile's routes, with that profile's key. */
  profileClient(conn: HermesGatewayConnection, profile: string): HermesClient {
    return createHermesClient(
      { baseUrl: conn.baseUrl, profile, key: derivedHermesKey(conn.masterKey, profile) },
      { fetch: this.deps.fetch },
    )
  }

  /** Whether the running gateway answers its health check, giving a busy one
   *  a few tries. */
  private async answers(): Promise<boolean> {
    const client = createHermesClient(
      { baseUrl: `http://127.0.0.1:${this.port}`, profile: null, key: '' },
      { fetch: this.deps.fetch },
    )
    for (let i = 0; i < HEALTH_TRIES; i++) {
      try {
        await client.health(HEALTH_TIMEOUT_MS)
        return true
      } catch {
        if (i + 1 < HEALTH_TRIES) await sleep(1_000)
      }
    }
    return false
  }

  /** Stop it (a person's Restart or Disconnect, a gateway that stopped
   *  answering, or the server going away). A start under way finishes first and
   *  is then stopped; a second stop joins the first. */
  async stop(): Promise<void> {
    if (this.stopInFlight) return this.stopInFlight
    const run = this.stopNow().finally(() => {
      if (this.stopInFlight === run) this.stopInFlight = null
    })
    this.stopInFlight = run
    return run
  }

  private async stopNow(): Promise<void> {
    this.stopping = true
    if (this.restartTimer) {
      clearTimeout(this.restartTimer)
      this.restartTimer = null
    }
    if (this.starting) await this.starting.catch(() => undefined)
    const proc = this.proc
    if (!proc || proc.exitCode !== null || proc.signalCode !== null) {
      if (this.proc === proc) this.proc = null
      this.state = 'stopped'
      return
    }
    const exited = new Promise<void>((resolve) => proc.once('exit', () => resolve()))
    try {
      proc.kill('SIGINT')
    } catch {
      // Gone already.
    }
    const grace = this.deps.stopGraceMs ?? STOP_GRACE_MS
    const timedOut = await Promise.race([exited.then(() => false), sleep(grace).then(() => true)])
    // Not once the server exits: its stop has this gateway now (SIGINT, its
    // grace, then SIGKILL), and killProcessTree's SIGTERM reads to Hermes as a
    // crash.
    if (timedOut && !this.exiting) {
      killProcessTree(proc)
      await Promise.race([exited, sleep(5_000)])
    }
    if (this.proc === proc) this.proc = null
    this.state = 'stopped'
  }

  /**
   * The server is exiting. SIGINT the gateway process alone (not its tree:
   * Hermes stops its own tools and MCP servers in its planned stop), wait up to
   * `graceMs` for it to exit, then SIGKILL its tree and wait up to
   * `EXIT_KILL_WAIT_MS`. Never a SIGTERM, which Hermes reads as a crash. Once it
   * has exited, whatever is left in its process group is killed too, as the
   * generic reap did, so nothing it started outlives the server.
   *
   * Unlike `stop()` it never waits for a start under way, which can take two
   * minutes: a gateway already spawned is stopped now, and one not yet spawned
   * never is (`exiting`). With no gateway process (and none `leaving`) it
   * returns at once.
   *
   * On Windows Node has no SIGINT to send (it ends the process at once and
   * leaves its children), so the tree is killed there as before.
   *
   * A gateway a failed start let go of while it still ran (`leaving`) already
   * has its SIGTERM; it gets the same grace and SIGKILL, at the same time.
   */
  async stopForExit(graceMs: number): Promise<HermesExitOutcome> {
    this.exiting = true
    this.stopping = true
    if (this.restartTimer) {
      clearTimeout(this.restartTimer)
      this.restartTimer = null
    }
    const leftovers = Promise.all([...this.leaving].map((p) => seeOutForExit(p, graceMs)))
    const outcome = await this.stopCurrentForExit(graceMs)
    await leftovers
    return outcome
  }

  private async stopCurrentForExit(graceMs: number): Promise<HermesExitOutcome> {
    const proc = this.proc
    if (!proc || proc.exitCode !== null || proc.signalCode !== null) {
      this.state = 'stopped'
      return 'not-running'
    }
    const exited = new Promise<void>((resolve) => proc.once('exit', () => resolve()))
    if (isWindows) {
      killProcessTreeNow(proc)
      return (await settlesWithin(exited, EXIT_KILL_WAIT_MS)) ? 'killed' : 'still-running'
    }
    try {
      proc.kill('SIGINT')
    } catch {
      // Gone already: the wait below settles at once.
    }
    if (await settlesWithin(exited, graceMs)) {
      killProcessTreeNow(proc)
      return 'stopped'
    }
    log.warn({ pid: proc.pid, graceMs }, 'hermes gateway did not stop in time; killing it')
    // The SIGKILL fallback, sent at once: the grace was the wait.
    killProcessTreeNow(proc)
    return (await settlesWithin(exited, EXIT_KILL_WAIT_MS)) ? 'killed' : 'still-running'
  }

  /**
   * The synchronous last resort (a `process.exit` from anywhere but the stop):
   * nothing can wait, so the gateway only gets its SIGINT and finishes its
   * planned stop on its own, and one a failed start let go of gets its SIGKILL
   * now. A no-op once they have exited.
   */
  signalForExit(): void {
    this.exiting = true
    this.stopping = true
    if (this.restartTimer) {
      clearTimeout(this.restartTimer)
      this.restartTimer = null
    }
    // These have had their SIGTERM, and the SIGKILL after it is a timer that
    // ends with this process.
    for (const leftover of this.leaving) killProcessTreeNow(leftover)
    const proc = this.proc
    if (!proc || proc.exitCode !== null || proc.signalCode !== null) return
    try {
      if (isWindows) killProcessTreeNow(proc)
      else proc.kill('SIGINT')
    } catch {
      // Gone already.
    }
  }

  async restart(): Promise<HermesGatewayConnection> {
    await this.stop()
    this.crashes = 0
    return this.ensureRunning()
  }

  private connection(): HermesGatewayConnection {
    return {
      baseUrl: `http://127.0.0.1:${this.port}`,
      home: this.home(),
      masterKey: this.masterKey!,
      port: this.port!,
    }
  }

  private home(): string {
    return (this.deps.home ?? hermesGatewayHome)()
  }

  private async pickPort(): Promise<number> {
    const preferred = (this.deps.preferredPort ?? preferredPortFromEnv)()
    const free = this.deps.isPortFree ?? isLoopbackPortFree
    // The port this gateway used last is its own to take again.
    const candidates = [
      ...(this.port !== null ? [this.port] : []),
      ...Array.from({ length: PORT_SCAN }, (_, i) => preferred + i),
    ]
    for (const port of candidates) {
      if (port > 65535) break
      if (await free(port)) return port
    }
    throw new Error(
      `No free port for the Hermes gateway from ${preferred} to ${preferred + PORT_SCAN - 1}. Set CLAWBOO_HERMES_GATEWAY_PORT to a free port and try again.`,
    )
  }

  private async start(): Promise<HermesGatewayConnection> {
    if (isAgentPoolMode()) {
      // One gateway runs every Hermes agent's tools, so it would be one user
      // for all of them; with a user per agent it does not start (yet).
      this.state = 'failed'
      this.lastError =
        'Hermes runs one gateway for every Hermes agent, which is not available while each agent runs as its own user (CLAWBOO_AGENT_USERS).'
      throw new Error(this.lastError)
    }
    const command = this.deps.resolveCommand()
    if (!command) {
      this.state = 'not-installed'
      const problem = this.deps.installProblem?.() ?? null
      this.lastError = problem
        ? `Clawboo's Hermes cannot be used: ${problem} Install it again from Settings > Runtimes.`
        : 'Hermes is not installed by Clawboo. Install it from Settings > Runtimes.'
      throw new Error(this.lastError)
    }
    this.state = 'starting'
    try {
      this.masterKey = (this.deps.masterKey ?? vaultMasterKey)()
      const port = await this.pickPort()
      const home = this.home()
      await provisionGatewayHome({ home, port, key: derivedHermesKey(this.masterKey, '_root') })
      await this.deps.beforeStart?.(home, this.masterKey)
      this.port = port
      this.spawnGateway(command, home)
      await this.waitReady()
      this.state = 'running'
      this.startedAt = (this.deps.now ?? Date.now)()
      this.lastError = null
      log.info({ port, pid: this.proc?.pid }, 'hermes gateway running')
      return this.connection()
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err)
      this.lastError = reason
      this.state = 'failed'
      const proc = this.proc
      this.proc = null
      // Not while the server exits: its stop already has this gateway (SIGINT,
      // the grace, then SIGKILL), and killProcessTree's SIGTERM would read to
      // Hermes as a crash. A start that times out during that grace gets here.
      if (!this.exiting && proc && proc.exitCode === null && proc.signalCode === null) {
        this.leaving.add(proc)
        proc.once('exit', () => this.leaving.delete(proc))
        killProcessTree(proc)
      }
      log.warn({ reason }, 'hermes gateway did not start')
      throw new Error(reason)
    }
  }

  private spawnGateway(command: string, home: string): void {
    // The server is going: a gateway spawned now would outlive it.
    if (this.exiting || isSubprocessShutdown()) throw new Error('Clawboo is stopping.')
    this.stderrTail = ''
    const spawn = this.deps.spawn ?? spawnAgentProcess
    const proc = spawn({
      kind: 'gateway',
      command,
      args: ['gateway', 'run', '--external-supervisor', '-v'],
      cwd: home,
      env: gatewayEnv({ home, command, agentUser: isAgentUserMode() }),
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: true,
      windowsHide: true,
    })
    this.proc = proc
    this.lastExitCode = null
    // In the durable pid record, so the next boot reaps a gateway a crash left
    // behind, but NOT in the generic shutdown reap, which SIGTERMs its whole
    // tree first: Hermes reads that as a crash. `stopForExit` stops it instead.
    recordRuntimeChildPid(proc)
    if (proc.pid) {
      try {
        this.deps.onStarted?.(proc.pid)
      } catch {
        // Best effort: an update may then prune a folder still in use.
      }
    }
    const keep = (chunk: Buffer | string): void => {
      this.stderrTail = (this.stderrTail + chunk.toString()).slice(-STDERR_TAIL_CHARS)
    }
    proc.stdout?.on('data', keep)
    proc.stderr?.on('data', keep)
    proc.on('error', (err) => {
      this.lastError = `Hermes could not be started: ${err.message}`
    })
    proc.once('exit', (code, signal) => {
      if (this.proc !== proc) return
      this.lastExitCode = code
      this.proc = null
      this.onExit(code, signal)
    })
  }

  /** The gateway answered on its port with its key. */
  private async waitReady(): Promise<void> {
    const deadline = (this.deps.now ?? Date.now)() + (this.deps.startTimeoutMs ?? START_TIMEOUT_MS)
    const root = createHermesClient(
      {
        baseUrl: `http://127.0.0.1:${this.port}`,
        profile: null,
        key: derivedHermesKey(this.masterKey!, '_root'),
      },
      { fetch: this.deps.fetch },
    )
    const alive = (proc: ChildProcess | null): proc is ChildProcess =>
      proc !== null && this.proc === proc && proc.exitCode === null && proc.signalCode === null
    for (;;) {
      const proc = this.proc
      if (!alive(proc)) {
        throw new Error(this.failureReason('Hermes stopped while starting'))
      }
      let health: { status: string; version?: string } | null = null
      try {
        health = await root.health()
      } catch {
        // Not listening yet.
      }
      // Something answers, and the process is still the one Clawboo started (if
      // not, the loop's first check says so).
      if (health?.status === 'ok' && alive(proc)) {
        // The key goes only to that process: another program that took the
        // port first would get every key.
        const owner = await (this.deps.portOwner ?? gatewayPortOwner)(this.port!, proc.pid!)
        if (owner === 'other') {
          throw new Error(
            `Another program answers on port ${this.port}, so the Hermes gateway's key was not sent to it. Set CLAWBOO_HERMES_GATEWAY_PORT to a free port, or stop that program, and try again.`,
          )
        }
        if (owner === 'unknown' && !this.ownerUnknownWarned) {
          this.ownerUnknownWarned = true
          log.warn(
            { port: this.port },
            'could not tell which process answers on the Hermes gateway port',
          )
        }
        try {
          // One keyed call proves it takes our key.
          await root.listJobs()
          // It may have exited while that call was out (its exit, during a
          // start, schedules no restart): then this start failed, below.
          if (alive(proc)) {
            this.version = typeof health.version === 'string' ? health.version : null
            return
          }
        } catch {
          // Not ready yet.
        }
      }
      if (!alive(proc)) continue
      if ((this.deps.now ?? Date.now)() >= deadline) {
        throw new Error(this.failureReason('Hermes did not answer on its port'))
      }
      await sleep(HEALTH_POLL_MS)
    }
  }

  /** A failure in words, with the last error line Hermes printed. */
  private failureReason(what: string): string {
    const lines = this.stderrTail
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => /ERROR|Error|error:|refus|in use|Traceback/.test(l))
    const last = lines.at(-1)
    return last ? `${what}: ${last.slice(0, 400)}` : `${what}.`
  }

  private onExit(code: number | null, signal: NodeJS.Signals | null): void {
    const wasRunning = this.state === 'running'
    if (this.stopping || isSubprocessShutdown()) {
      this.state = 'stopped'
      return
    }
    // During a start, the start itself reports the failure.
    if (!wasRunning) return
    const reason = this.failureReason(
      `Hermes stopped${code !== null ? ` with code ${code}` : signal ? ` on ${signal}` : ''}`,
    )
    this.lastError = reason
    if (code !== null && PERMANENT_EXIT_CODES.has(code)) {
      this.state = 'failed'
      log.warn({ code }, 'hermes gateway refused its config; not restarting')
      return
    }
    const now = (this.deps.now ?? Date.now)()
    if (this.startedAt !== null && now - this.startedAt > STABLE_AFTER_MS) this.crashes = 0
    log.warn({ code, signal }, 'hermes gateway exited; restarting')
    this.scheduleRestart()
  }

  /** Try again after the next backoff step. A restart that fails to start tries
   *  again too, up to MAX_RESTART_ATTEMPTS in a row; then the gateway stays
   *  failed until a run or a person's Restart asks for it. */
  private scheduleRestart(): void {
    if (this.crashes >= MAX_RESTART_ATTEMPTS) {
      this.state = 'failed'
      return
    }
    const backoff = this.deps.backoffMs ?? RESTART_BACKOFF_MS
    const wait = backoff[Math.min(this.crashes, backoff.length - 1)]!
    this.crashes += 1
    this.state = 'restarting'
    this.restartTimer = setTimeout(() => {
      this.restartTimer = null
      if (this.stopping || isSubprocessShutdown()) return
      this.restarts += 1
      void this.ensureRunning().catch(() => {
        if (this.stopping || isSubprocessShutdown() || this.state !== 'failed') return
        // Hermes refused its config on this attempt too: trying again would not help.
        if (this.lastExitCode !== null && PERMANENT_EXIT_CODES.has(this.lastExitCode)) {
          log.warn({ code: this.lastExitCode }, 'hermes gateway refused its config; not restarting')
          return
        }
        this.scheduleRestart()
      })
    }, wait)
    this.restartTimer.unref?.()
  }
}
