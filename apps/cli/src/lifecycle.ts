/**
 * apps/cli/src/lifecycle.ts
 *
 * Finding, starting, and stopping the Clawboo dashboard server.
 *
 * Split out of `index.ts` for two reasons: `index.ts` calls `program.parse()` at
 * module scope (so importing it from a test runs the CLI), and three callers now
 * need the same start/stop primitives — the default launcher, `clawboo restart`,
 * and the version-aware restart the launcher offers when it finds an older
 * server. Nothing here imports chalk/ora/clack: presentation stays in `index.ts`.
 *
 * NOTE ON `__dirname`: tsup emits a single CJS `dist/index.js`, and esbuild does
 * not rewrite `__dirname` per source module, so `path.join(__dirname, 'server.js')`
 * below resolves to `dist/server.js` exactly as it did when this code lived in
 * `index.ts`. That holds only while `apps/cli/tsup.config.ts` bundles one entry
 * with no `splitting`.
 */

import { createConnection } from 'net'
import { exec, fork, spawn } from 'child_process'
import path from 'path'
import fs from 'fs'
import os from 'os'

import { readAccessTokenFile, resolveBasePathOrRoot, resolveClawbooDir } from '@clawboo/config'

import { openServerLog } from './server-log'

import { VERSION } from './version'
import { findListenerPid } from '@clawboo/process-lookup'

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Quick TCP probe to check if a port is accepting connections. */
export function probePort(host: string, port: number, timeoutMs = 2_000): Promise<boolean> {
  return new Promise((resolve) => {
    let sock: ReturnType<typeof createConnection>
    try {
      sock = createConnection({ host, port })
    } catch {
      // e.g. ERR_SOCKET_BAD_PORT from a malformed port. "Unreachable", not a throw:
      // every caller treats this as a boolean and none of them catch.
      resolve(false)
      return
    }
    const timer = setTimeout(() => {
      sock.destroy()
      resolve(false)
    }, timeoutMs)
    sock.on('connect', () => {
      clearTimeout(timer)
      sock.destroy()
      resolve(true)
    })
    sock.on('error', () => {
      clearTimeout(timer)
      resolve(false)
    })
  })
}

/**
 * What answered on a port.
 * - `clawboo`: a Clawboo dashboard we can talk to.
 * - `gated`:   a Clawboo dashboard that 401'd us. It is running behind its
 *              access token and every `/api/*` route needs the cookie, and
 *              this launcher has no token the server accepts. We can
 *              identify it but not use it.
 * - `none`:    closed, unreachable, or something that isn't Clawboo.
 */
export type DashboardProbe = 'clawboo' | 'gated' | 'none'

/** The access gate's cookie name (the default in packages/gateway-proxy/src/access-gate.ts). */
const ACCESS_COOKIE = 'clawboo_access'

/**
 * The address the launcher dials, and puts in the links it opens and prints:
 * the loopback address the server listens on. 127.0.0.1 unless HOST names
 * another loopback address (::1, or another 127.x), which is then all the
 * server listens on. Never `localhost`, which can resolve to ::1 first, where
 * another user's program can listen on the very port the server holds on
 * 127.0.0.1 and imitate the access gate; a HOST of `localhost`, or a wide one
 * such as 0.0.0.0, is dialled at 127.0.0.1.
 */
export function dashboardHost(env: NodeJS.ProcessEnv = process.env): string {
  const host = (env['HOST'] ?? '').trim().replace(/^\[(.*)\]$/, '$1')
  if (host === '::1') return '::1'
  if (/^127(\.\d{1,3}){3}$/.test(host)) return host
  return '127.0.0.1'
}

/** A host as it goes into a URL: an IPv6 literal in brackets. */
function urlHost(host: string): string {
  return host.includes(':') ? `[${host}]` : host
}

/**
 * May the access token go to this port? Only at the dashboard host, and only to
 * the port the server recorded in the private api-port.txt. Any other port
 * answering with the gate's refusal could be another user's program imitating
 * it, so no token reaches it, not even one set in this shell: CLAWBOO_API_PORT
 * stays set while the server is down, when anyone could listen on that port.
 * The desktop app follows the same rule.
 */
function mayReceiveToken(host: string, port: number): boolean {
  return host === dashboardHost() && port === readRuntimePort()
}

/**
 * The access token this launcher holds, resolved the way the server resolves its
 * own, so a server this launcher starts (which inherits this environment) has
 * the same one:
 * - `STUDIO_ACCESS_TOKEN`, trimmed the way the gate trims it, when set;
 * - nothing when it is set blank, which runs the server with no gate;
 * - otherwise the per-install token in `<CLAWBOO_HOME>/access-token`, which the
 *   server (or the desktop app) wrote. Read only: the launcher never creates it.
 */
export function launcherAccessToken(env: NodeJS.ProcessEnv = process.env): string | null {
  const fromEnv = env['STUDIO_ACCESS_TOKEN']
  if (fromEnv !== undefined) return fromEnv.trim() || null
  return readAccessTokenFile({ env })
}

interface JsonReply {
  status: number
  ok: boolean
  body: unknown
}

type Method = 'GET' | 'POST'

/** One request to a JSON route. Null when the request fails or the answer is not JSON. */
async function getJson(
  url: string,
  timeoutMs: number,
  headers: Record<string, string>,
  method: Method = 'GET',
): Promise<JsonReply | null> {
  try {
    const res = await fetch(url, { method, signal: AbortSignal.timeout(timeoutMs), headers })
    const ct = res.headers.get('content-type') ?? ''
    if (!ct.includes('application/json')) return null
    return { status: res.status, ok: res.ok, body: await res.json() }
  } catch {
    return null
  }
}

/**
 * Call a JSON route on a local dashboard. When the access gate refuses the plain
 * request and this launcher holds a token, ask once more with the token as the
 * gate's cookie. The token is sent only to a port that has just answered with
 * the gate's own refusal, so another service listening in the port window
 * (Gateway helper ports, a Chrome debugging port) never receives it, and only
 * to the port `mayReceiveToken` allows.
 */
async function getDashboardJson(
  host: string,
  port: number,
  route: string,
  timeoutMs: number,
  headers: Record<string, string> = {},
  method: Method = 'GET',
): Promise<JsonReply | null> {
  const url = `http://${urlHost(host)}:${port}${route}`
  const first = await getJson(url, timeoutMs, headers, method)
  if (first === null || first.status !== 401 || !isAccessGateError(first.body)) return first
  if (!mayReceiveToken(host, port)) return first
  const token = launcherAccessToken()
  if (token === null) return first
  const cookie = { ...headers, Cookie: `${ACCESS_COOKIE}=${token}` }
  const second = await getJson(url, timeoutMs, cookie, method)
  return second ?? first
}

/**
 * Verify a port is hosting Clawboo's dashboard (not some other service that
 * happens to be TCP-listening on the same port). Cheap TCP-probe first to
 * skip closed ports, then an HTTP GET /api/settings that validates a
 * Clawboo-shaped JSON response. Critical because Clawboo's auto-fallback
 * range (18790-18809) overlaps with the OpenClaw Gateway's auxiliary ports
 * (18791-18792) AND with things like Chrome's --remote-debugging-port
 * (commonly 18800). A naive TCP probe accepts any of those as "Clawboo",
 * routes the browser there, and the user sees an unrelated 401 / empty
 * page / DevTools UI.
 *
 * A 401 is reported separately rather than folded into "not Clawboo": the
 * access gate answers with a Clawboo-specific JSON error, which identifies the
 * server even though it won't serve us. Without that distinction the launcher
 * concludes nothing is running and forks a SECOND server on a token-gated
 * install — every run leaking another orphan.
 *
 * When this launcher holds the server's `STUDIO_ACCESS_TOKEN`, the gated server
 * is asked again with it (see `getDashboardJson`) and counts as `clawboo`. That
 * is what lets the launcher see a token-gated server it has just started.
 */
export async function probeDashboard(
  host: string,
  port: number,
  timeoutMs = 1_500,
): Promise<DashboardProbe> {
  // Cheap TCP probe first — skip the HTTP cost on closed ports.
  if (!(await probePort(host, port, Math.min(timeoutMs, 1_000)))) return 'none'
  const reply = await getDashboardJson(host, port, '/api/settings', timeoutMs)
  if (reply === null) return 'none'
  if (reply.status === 401) return isAccessGateError(reply.body) ? 'gated' : 'none'
  if (!reply.ok || !isRecord(reply.body)) return 'none'
  // Clawboo's /api/settings ALWAYS includes these two fields. Gateway's
  // auxiliary ports return plain "Unauthorized"; Chrome's debug returns
  // an array of debugger targets. Neither matches this shape.
  return typeof reply.body['gatewayUrl'] === 'string' && typeof reply.body['hasToken'] === 'boolean'
    ? 'clawboo'
    : 'none'
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

/**
 * Is this 401 body the Clawboo access gate's? It answers
 * `{ error: 'Clawboo access token required. …', gate: 'clawboo-access' }`; older
 * servers send the `error` alone. Requiring both words keeps an unrelated
 * service's JSON 401 from being read as a Clawboo instance.
 */
function isAccessGateError(body: unknown): boolean {
  if (!isRecord(body)) return false
  const message = body['error']
  if (typeof message !== 'string') return false
  const lower = message.toLowerCase()
  return lower.includes('clawboo') && lower.includes('token')
}

/** Convenience wrapper: is this port a Clawboo dashboard we can actually use? */
export async function probeClawbooDashboard(
  host: string,
  port: number,
  timeoutMs = 1_500,
): Promise<boolean> {
  return (await probeDashboard(host, port, timeoutMs)) === 'clawboo'
}

// ─── Opening the browser ──────────────────────────────────────────────────────

/** What a launch-code request found. */
export type LaunchCodeReply =
  /** The server has no access gate: the plain address opens the dashboard. */
  | { gated: false }
  /** A one-time code for `?access_code=`, valid until `expiresAt` (server clock). */
  | { gated: true; code: string; expiresAt: number }

/** A launch code goes into a shell command line, so only this shape is accepted. */
const LAUNCH_CODE_RE = /^[A-Za-z0-9_-]{16,256}$/

/**
 * Ask the dashboard on `port` for a one-time launch code, with this launcher's
 * token as the cookie (after the gate's own refusal, as every call here does).
 * Null when it cannot give one: no token the server accepts, a server that
 * predates launch codes, or an answer that is not one.
 */
export async function mintLaunchCode(
  port: number,
  timeoutMs = 2_000,
): Promise<LaunchCodeReply | null> {
  const reply = await getDashboardJson(
    dashboardHost(),
    port,
    '/api/access/launch-code',
    timeoutMs,
    { Accept: 'application/json' },
    'POST',
  )
  if (reply === null || !reply.ok || !isRecord(reply.body)) return null
  const body = reply.body
  if (body['gated'] === false) return { gated: false }
  const code = body['code']
  const expiresAt = body['expiresAt']
  if (body['gated'] !== true || typeof code !== 'string' || !LAUNCH_CODE_RE.test(code)) return null
  return { gated: true, code, expiresAt: typeof expiresAt === 'number' ? expiresAt : 0 }
}

/**
 * The URL prefix the server is mounted under, for the links we print and open,
 * with the trailing slash the shell's relative assets need. Display only: a
 * malformed value falls back to the root here and the server refuses to start
 * with a precise message, so the CLI never dies on a bad setting.
 */
export function uiPath(): string {
  const base = resolveBasePathOrRoot(process.env)
  return base ? `${base}/` : ''
}

/**
 * The dashboard's address on `port`. With a launch code it is the one-time
 * sign-in link (`?access_code=`); the access token itself never goes in a URL.
 */
export function dashboardUrl(port: number, code?: string): string {
  const base = `http://${urlHost(dashboardHost())}:${port}${uiPath()}`
  if (code === undefined) return base
  const page = base.endsWith('/') ? base : `${base}/`
  return `${page}?access_code=${encodeURIComponent(code)}`
}

/**
 * What opening the dashboard achieved, for the CLI to say:
 * - `signed-in`: the browser opened a one-time sign-in link;
 * - `open`: the server has no gate, so the plain address is enough;
 * - `sign-in-unknown`: the browser opened the plain address because the server
 *   gave no link (a timeout, a 429, or a server older than launch codes), so it
 *   may show the locked screen;
 * - `no-browser`: no browser could be opened.
 */
export type OpenReport = 'signed-in' | 'open' | 'sign-in-unknown' | 'no-browser'

export function openReport(minted: LaunchCodeReply | null, opened: boolean): OpenReport {
  if (!opened) return 'no-browser'
  if (minted === null) return 'sign-in-unknown'
  return minted.gated ? 'signed-in' : 'open'
}

/** Runs a shell command and reports how it ended. A seam for tests. */
export type RunCommand = (command: string, done: (err: Error | null) => void) => void

const runCommand: RunCommand = (command, done) => {
  exec(command, (err) => done(err))
}

/**
 * Open `url` in the default browser. False when that failed: on a server with
 * no desktop, `xdg-open` is missing or has nothing to open with, and the caller
 * should say how to get a link instead of failing silently.
 */
export function openUrlInBrowser(url: string, run: RunCommand = runCommand): Promise<boolean> {
  const command =
    process.platform === 'darwin'
      ? `open "${url}"`
      : process.platform === 'win32'
        ? `start "" "${url}"`
        : `xdg-open "${url}"`
  return new Promise((resolve) => run(command, (err) => resolve(err === null)))
}

// ─── Dashboard port discovery ─────────────────────────────────────────────────
//
// Mirrors `apps/web/server/lib/portUtils.ts` — kept in lockstep:
// - DEFAULT_API_PORT 18790 (one above OpenClaw Gateway 18789)
// - 20-port fallback window (18790-18809)
// - Runtime port file at ~/.clawboo/api-port.txt (CLAWBOO_HOME override)
//
// On every `npx clawboo` launch we figure out where the dashboard is or
// will be, in this priority order:
//   1. CLAWBOO_API_PORT / CLAWBOO_API_URL env var (explicit user override)
//   2. Runtime port file (server already running, wrote its port there)
//   3. Probe DEFAULT_API_PORT, then scan upward 19 more ports
//   4. Fall back to DEFAULT_API_PORT (we'll start a server there)

export const DEFAULT_API_PORT = 18790
export const MAX_PORT_ATTEMPTS = 20

function readPortEnv(name: string): number | null {
  const raw = (process.env[name] ?? '').trim()
  if (!raw) return null
  const port = Number(raw)
  if (!Number.isInteger(port) || port <= 0 || port > 65535) return null
  return port
}

export function getRuntimePortFilePath(): string {
  // Use the SERVER's exact resolver (bundled into this standalone binary by
  // tsup) so the CLI and server agree on the home dir at every edge — a relative
  // CLAWBOO_HOME, an unset HOME, `~` expansion. Re-inlining it drifted at those
  // edges and broke port discovery (the API server writes api-port.txt there).
  return path.join(resolveClawbooDir(), 'api-port.txt')
}

export function readRuntimePort(): number | null {
  try {
    const raw = fs.readFileSync(getRuntimePortFilePath(), 'utf8').trim()
    const port = Number(raw)
    // isInteger, not isFinite: a corrupt file holding `18790.5` would otherwise
    // reach createConnection, which throws ERR_SOCKET_BAD_PORT synchronously.
    if (!Number.isInteger(port) || port <= 0 || port > 65535) return null
    return port
  } catch {
    return null
  }
}

/**
 * Delete the runtime port file. Mirrors `portUtils.removeApiPortFile()`.
 *
 * A server that exits on SIGINT/SIGTERM removes this itself, so on the graceful
 * path this is a no-op. It is load-bearing after a SIGKILL, and on Windows,
 * where `process.kill` is `TerminateProcess` and no shutdown handler ever runs.
 */
export function removeRuntimePortFile(): void {
  try {
    fs.unlinkSync(getRuntimePortFilePath())
  } catch {
    /* already gone */
  }
}

interface PortCandidate {
  port: number
  timeoutMs: number
}

/**
 * The ports to probe, in priority order. An explicit `CLAWBOO_API_PORT` is the
 * whole search space — an explicit choice gets no fallback. Otherwise the
 * runtime file first (the server wrote it on bind), then the standard window,
 * which covers a server started by `pnpm dev` or another launcher that never
 * wrote the file.
 */
function dashboardCandidates(): PortCandidate[] {
  const explicit = readPortEnv('CLAWBOO_API_PORT')
  if (explicit !== null) return [{ port: explicit, timeoutMs: 1_500 }]

  const candidates: PortCandidate[] = []
  const fromFile = readRuntimePort()
  if (fromFile !== null) candidates.push({ port: fromFile, timeoutMs: 1_500 })
  for (let i = 0; i < MAX_PORT_ATTEMPTS; i++) {
    candidates.push({ port: DEFAULT_API_PORT + i, timeoutMs: 800 })
  }
  return candidates
}

export interface DashboardDiscovery {
  /** A Clawboo dashboard we can talk to. */
  port: number | null
  /**
   * A Clawboo dashboard that answered 401. It exists, and we can name it, but
   * this install requires `STUDIO_ACCESS_TOKEN` so we can't use it. Recorded
   * only when no usable dashboard was found first.
   */
  gatedPort: number | null
}

/**
 * Find an already-running Clawboo dashboard in one pass over the search space.
 *
 * Every probe is a TCP check plus a Clawboo-shaped JSON signature check, so
 * unrelated services that happen to listen in 18790-18809 — Gateway aux ports,
 * Chrome --remote-debugging-port, etc. — are skipped rather than mistaken for
 * Clawboo. A token-gated instance is reported separately so callers can say
 * something true about it instead of concluding nothing is running.
 */
export async function discoverDashboard(): Promise<DashboardDiscovery> {
  let gatedPort: number | null = null
  for (const candidate of dashboardCandidates()) {
    const verdict = await probeDashboard(dashboardHost(), candidate.port, candidate.timeoutMs)
    if (verdict === 'clawboo') return { port: candidate.port, gatedPort }
    if (verdict === 'gated' && gatedPort === null) gatedPort = candidate.port
  }
  return { port: null, gatedPort }
}

/** The usable dashboard only. Used by the post-spawn readiness poll. */
export async function findRunningDashboard(): Promise<number | null> {
  return (await discoverDashboard()).port
}

// ─── Monorepo discovery ────────────────────────────────────────────────────────

/**
 * Walk up from __dirname and cwd looking for the Clawboo monorepo root
 * (a package.json with "name": "clawboo").
 */
export function findMonorepoRoot(): string | null {
  // Env override
  if (process.env.CLAWBOO_SERVER_PATH) return process.env.CLAWBOO_SERVER_PATH

  const candidates: string[] = []

  // Walk up from this file's directory
  {
    let dir = __dirname
    for (let i = 0; i < 10; i++) {
      candidates.push(dir)
      const parent = path.dirname(dir)
      if (parent === dir) break
      dir = parent
    }
  }

  // Walk up from cwd, unless the shell is sitting in a directory that has been
  // deleted, in which case there is nothing to walk.
  let dir: string
  try {
    dir = process.cwd()
  } catch {
    dir = __dirname
  }
  for (let i = 0; i < 10; i++) {
    if (!candidates.includes(dir)) candidates.push(dir)
    const parent = path.dirname(dir)
    if (parent === dir) break
    dir = parent
  }

  for (const candidate of candidates) {
    try {
      const pkgPath = path.join(candidate, 'package.json')
      const raw = fs.readFileSync(pkgPath, 'utf-8')
      const pkg = JSON.parse(raw) as { name?: string }
      if (pkg.name === 'clawboo') return candidate
    } catch {
      // not found or not parsable — continue
    }
  }

  return null
}

// ─── Server version ───────────────────────────────────────────────────────────

const SELF_VERSION_TIMEOUT_MS = 2_000

/**
 * Ask a running dashboard which version it is. Returns null on ANY failure, so
 * callers degrade to plain attach rather than blocking the browser on a check
 * that didn't answer.
 *
 * `?local=1` tells the server to skip its npm-registry probe: `computeSelfVersion()`
 * awaits `fetchLatestClawbooVersion()`, which is capped at 5 s and only caches
 * successes, so a cold-cache offline server would sit on this request. Servers
 * that predate the param ignore it and still return `current`; the abort below
 * bounds them.
 *
 * The content-type check is load-bearing, not defensive: a server old enough to
 * lack this route falls through to the production SPA catch-all, which answers
 * 200 with `index.html`. `res.ok` is true there and `res.json()` would throw.
 *
 * On a token-gated server it sends this launcher's token the same way the probe
 * does, so the version check still runs there.
 */
export async function fetchServerVersion(
  port: number,
  timeoutMs = SELF_VERSION_TIMEOUT_MS,
): Promise<string | null> {
  const reply = await getDashboardJson(
    dashboardHost(),
    port,
    '/api/system/self-version?local=1',
    timeoutMs,
    { Accept: 'application/json' },
  )
  if (reply === null || !reply.ok || !isRecord(reply.body)) return null
  const current = reply.body['current']
  return typeof current === 'string' && current.trim() ? current.trim() : null
}

// ─── Server lifecycle ─────────────────────────────────────────────────────────

/**
 * The bundled server's working directory: clawboo's own directory, never the
 * package folder. `npm install -g clawboo@latest` replaces the package folder,
 * so a server started inside it is left in a directory that no longer exists,
 * and every process it starts after that fails: the in-app update's npm exits
 * with code 7, the OpenClaw CLI refuses to run, and the restart into the new
 * version dies while loading.
 */
export function serverWorkingDir(): string {
  try {
    const dir = resolveClawbooDir()
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
    return dir
  } catch {
    return os.homedir()
  }
}

/**
 * Where the user ran `clawboo`, for the server's "near where you started"
 * suggestions. Empty when the shell's directory has been deleted.
 */
export function launchDirEnv(): NodeJS.ProcessEnv {
  try {
    return { CLAWBOO_LAUNCH_DIR: process.cwd() }
  } catch {
    return {}
  }
}

export type LaunchMode = 'bundled' | 'dev'

export interface StartOptions {
  /**
   * Pin the child to this exact port. Sets CLAWBOO_API_PORT (an exact bind that
   * `resolveApiPort` THROWS on if taken) plus CLAWBOO_AWAIT_PORT (wait up to 15 s
   * for the port to free first) — the same handoff recipe as the server's own
   * `selfRestart.ts`. Pass it only after verifying the port is actually free.
   */
  port?: number
  /** Fires once the launch mode is known, BEFORE the child is spawned. */
  onLaunch?: (mode: LaunchMode) => void
  /** Readiness poll attempts, 500 ms apart. Default 90 (~45 s). */
  maxAttempts?: number
}

export type StartOutcome =
  | { status: 'started'; port: number; mode: LaunchMode }
  | { status: 'no-server' }
  | { status: 'timeout'; mode: LaunchMode; monorepoRoot: string | null; logPath: string | null }

/**
 * Start a detached dashboard server and wait for it to answer.
 *
 * Two strategies, in order: the bundled `server.js` sitting next to this CLI
 * entry, then a dev-mode `npx tsx apps/web/server/index.ts` from a located
 * monorepo root. The child is spawned detached and `unref`'d so the CLI can exit
 * while the server keeps running.
 */
export async function startDashboard(opts: StartOptions = {}): Promise<StartOutcome> {
  // The server is detached with `stdio: 'ignore'`, so a boot failure leaves no
  // trace and the launcher can only report an unexplained timeout. Capture the
  // child's output to a rolling log instead; `startAndReport` tails it on timeout.
  // A null log (unwritable home) degrades to the previous ignore-everything path.
  const serverLog = openServerLog(`\n--- clawboo v${VERSION} · pid ${process.pid} ---\n`)
  const childStdio: 'ignore' | ['ignore', number, number] = serverLog
    ? ['ignore', serverLog.fd, serverLog.fd]
    : 'ignore'
  // `fork()` only auto-attaches its required IPC channel for the 'ignore'
  // SHORTHAND; an explicit stdio array must carry 'ipc' itself or fork() throws
  // "Forked processes must have an IPC channel". `spawn()` must NOT have it.
  const forkStdio: 'ignore' | ['ignore', number, number, 'ipc'] = serverLog
    ? ['ignore', serverLog.fd, serverLog.fd, 'ipc']
    : 'ignore'

  // Strategy 1: Bundled mode — server.js sits next to this CLI entry
  const bundledServerPath = path.join(__dirname, 'server.js')

  // Strategy 2: Dev mode — find monorepo root and use tsx
  const monorepoRoot = findMonorepoRoot()
  const devServerPath = monorepoRoot ? path.join(monorepoRoot, 'apps/web/server/index.ts') : null

  const mode: LaunchMode | null = fs.existsSync(bundledServerPath)
    ? 'bundled'
    : devServerPath && fs.existsSync(devServerPath)
      ? 'dev'
      : null

  if (mode === null) return { status: 'no-server' }

  opts.onLaunch?.(mode)

  // Spread LAST so a pinned port beats an inherited CLAWBOO_API_PORT.
  const pinned: NodeJS.ProcessEnv =
    opts.port !== undefined
      ? { CLAWBOO_API_PORT: String(opts.port), CLAWBOO_AWAIT_PORT: String(opts.port) }
      : {}

  if (mode === 'bundled') {
    const child = fork(bundledServerPath, [], {
      cwd: serverWorkingDir(),
      env: {
        ...process.env,
        ...launchDirEnv(),
        NODE_ENV: 'production',
        // The running clawboo version, so the server's self-version check
        // ("update available" chip, and this CLI's own discovery check on the
        // next launch) knows what it is without a disk read.
        CLAWBOO_VERSION: VERSION,
        // Where the bundled MCP stdio bins live (dist/bin next to server.js), so
        // the server's /api/mcp/config emits the right `node <bin>` attach snippet.
        CLAWBOO_MCP_BIN_DIR: path.join(__dirname, 'bin'),
        ...pinned,
      },
      detached: true,
      stdio: forkStdio,
    })
    child.unref()
    // `fork()` ALWAYS attaches an IPC channel, even under `stdio: 'ignore'`, and
    // that channel is ref'd independently of the child handle. `unref()` alone
    // therefore leaves this process alive forever once a server has been forked,
    // so `clawboo` would print its outro and never return the shell prompt. We
    // never speak IPC to the server; unref the channel so the launcher can exit
    // while the detached server keeps running.
    child.channel?.unref()
    child.on('error', () => {})
  } else {
    // On Windows `npx` resolves to `npx.cmd`, which Node 18.20.2+/20.12.2+/22+
    // refuse to spawn without a shell (the CVE-2024-27980 mitigation). The only
    // interpolated value is a path we derived ourselves from the monorepo root,
    // never user input, and it is quoted for the shell that will re-split it.
    const onWindows = process.platform === 'win32'
    const child = onWindows
      ? spawn(`npx tsx "${devServerPath!}"`, {
          cwd: monorepoRoot!,
          env: {
            ...process.env,
            ...launchDirEnv(),
            NODE_ENV: 'production',
            CLAWBOO_VERSION: VERSION,
            ...pinned,
          },
          detached: true,
          stdio: childStdio,
          shell: true,
          windowsHide: true,
        })
      : spawn('npx', ['tsx', devServerPath!], {
          cwd: monorepoRoot!,
          env: {
            ...process.env,
            ...launchDirEnv(),
            NODE_ENV: 'production',
            CLAWBOO_VERSION: VERSION,
            ...pinned,
          },
          detached: true,
          stdio: childStdio,
        })
    // Without a listener a failed spawn emits an unhandled 'error' event, which
    // takes the launcher down with an opaque stack instead of the readiness
    // poll's actionable timeout message. Swallow it and let the poll report.
    child.on('error', () => {})
    child.unref()
  }

  // Poll for the dashboard via port discovery (env / runtime file / scan).
  // Up to 45 seconds. The server typically binds in ~500ms on a warm
  // install, but on Windows the FIRST cold boot of the bundled CJS (1.4 MB
  // + better-sqlite3 native bindings + Express + WS proxy) can take 20-30s
  // due to Windows Defender real-time scanning of the freshly-extracted
  // npm package + Node's first-load module compile. 15s timed out on
  // fresh Windows installs — see v0.1.7 round-2 Windows compat fix.
  //
  // When pinned, probe THAT port directly: `findRunningDashboard()` reads
  // CLAWBOO_API_PORT from OUR env (not the child's) and would otherwise
  // range-scan onto an unrelated instance.
  const maxAttempts = opts.maxAttempts ?? 90
  for (let i = 0; i < maxAttempts; i++) {
    await new Promise((r) => setTimeout(r, 500))
    const found =
      opts.port !== undefined
        ? (await probeClawbooDashboard(dashboardHost(), opts.port, 800))
          ? opts.port
          : null
        : await findRunningDashboard()
    if (found !== null) return { status: 'started', port: found, mode }
  }

  return { status: 'timeout', mode, monorepoRoot, logPath: serverLog?.path ?? null }
}

/** Test seams — every side effect `stopDashboard` performs is injectable. */
export interface StopDeps {
  isClawboo?: (port: number) => Promise<boolean>
  findListenerPid?: (port: number) => number | null
  kill?: (pid: number, signal: NodeJS.Signals) => void
  /** Is anything still accepting connections on the port? */
  probe?: (port: number) => Promise<boolean>
  readPortFile?: () => number | null
  unlinkPortFile?: () => void
  sleep?: (ms: number) => Promise<void>
}

export type StopOutcome =
  | { status: 'stopped'; port: number; pid: number; forced: boolean }
  | { status: 'not-running'; port: number }
  | {
      status: 'could-not-identify'
      port: number
      /**
       * `no-listener` — nothing answered, or the tool to ask is missing.
       * `permission-denied` — the process is another user's.
       * `unsafe-pid` — we DID identify a listener and refused to signal it
       * (init, ourselves, our parent, or a mis-parsed non-positive value).
       */
      reason: 'no-listener' | 'permission-denied' | 'unsafe-pid'
    }
  | { status: 'still-alive'; port: number; pid: number }

const TERM_POLL_MS = 100
/** 4 s. The server's SIGTERM handler opens a fresh SQLite connection to run
 *  `wal_checkpoint(TRUNCATE)`, which is not instant on a large board. */
const TERM_POLL_ATTEMPTS = 40
/** 2 s. After SIGKILL we are only waiting on the OS to release the socket. */
const KILL_POLL_ATTEMPTS = 20

function isErrno(err: unknown, code: string): boolean {
  return Boolean(err && typeof err === 'object' && 'code' in err && err.code === code)
}

/**
 * Stop the dashboard server listening on `port`.
 *
 * The server is spawned detached and `unref`'d, so there is no `ChildProcess`
 * handle to signal and no PID file to read — `api-port.txt` records a port and
 * nothing else. So: prove the port is Clawboo, ask the OS who owns it, SIGTERM,
 * and watch the port rather than the PID.
 *
 * WINDOWS: `process.kill(pid, 'SIGTERM')` maps to TerminateProcess whatever the
 * signal name, so the server never runs its shutdown handler there. Two
 * consequences: the port-file cleanup below is the only cleanup that happens
 * (the SQLite WAL is crash-safe by design and recovers on the next open), and
 * the SIGKILL escalation is effectively dead code. `taskkill /T /F` is
 * deliberately NOT used: `/F` buys nothing over TerminateProcess, and `/T` would
 * reap the server's whole process tree — the user's managed runtime sessions and
 * Gateway — on Windows but not on POSIX.
 */
export async function stopDashboard(port: number, deps: StopDeps = {}): Promise<StopOutcome> {
  const isClawboo =
    deps.isClawboo ?? ((p: number) => probeClawbooDashboard(dashboardHost(), p, 1_500))
  const lookup = deps.findListenerPid ?? findListenerPid
  const kill = deps.kill ?? ((pid: number, signal: NodeJS.Signals) => process.kill(pid, signal))
  const probe = deps.probe ?? ((p: number) => probePort(dashboardHost(), p, 500))
  const readPortFile = deps.readPortFile ?? readRuntimePort
  const unlinkPortFile = deps.unlinkPortFile ?? removeRuntimePortFile
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)))

  const cleanStalePortFile = (): void => {
    // ONLY unlink when the file still names the port we just stopped. A fresh
    // server may already have rewritten it.
    if (readPortFile() === port) unlinkPortFile()
  }

  // 1. IDENTITY. Never resolve a PID for a port we have not proven is Clawboo —
  //    the 18790-18809 window overlaps Gateway aux ports and Chrome's
  //    --remote-debugging-port. (There is an unavoidable few-millisecond TOCTOU
  //    window between this probe and the lookup below; the consequence is
  //    bounded to signalling a process that just took a port Clawboo was on.)
  if (!(await isClawboo(port))) {
    cleanStalePortFile()
    return { status: 'not-running', port }
  }

  // 2. PID. The only route is port → owning process; see processLookup.ts.
  const pid = lookup(port)
  if (pid === null) {
    return { status: 'could-not-identify', port, reason: 'no-listener' }
  }
  // A mis-parsed column can yield a non-positive value; pid 1 is init, and
  // signalling ourselves or our parent would be a self-inflicted wound. These
  // are NOT "nothing found" — a listener was identified and deliberately spared,
  // which is a different thing to tell the user.
  if (!Number.isInteger(pid) || pid <= 1 || pid === process.pid || pid === process.ppid) {
    return { status: 'could-not-identify', port, reason: 'unsafe-pid' }
  }

  // 3. SIGTERM the single PID — never `process.kill(-pid, …)`. The bundled server
  //    is a process-group leader (detached fork), but a `pnpm dev` server is not,
  //    and a negative signal there could take out the user's whole dev session.
  let forced = false
  try {
    kill(pid, 'SIGTERM')
  } catch (err: unknown) {
    if (isErrno(err, 'EPERM')) {
      return { status: 'could-not-identify', port, reason: 'permission-denied' }
    }
    // ESRCH — it died between the lookup and the signal. The port poll below is
    // the authoritative answer either way.
  }

  // 4. Poll the PORT, not the PID. A dead PID can be recycled and would read as
  //    alive forever; a port that stopped answering is unambiguous.
  for (let i = 0; i < TERM_POLL_ATTEMPTS; i++) {
    await sleep(TERM_POLL_MS)
    if (!(await probe(port))) {
      cleanStalePortFile()
      return { status: 'stopped', port, pid, forced }
    }
  }

  // 5. Escalate — but re-resolve first. This is the real recycled-PID guard: only
  //    SIGKILL a PID that is STILL the listener on our port.
  if (lookup(port) !== pid) return { status: 'still-alive', port, pid }
  try {
    kill(pid, 'SIGKILL')
    forced = true
  } catch {
    /* raced to death — the poll below settles it */
  }

  for (let i = 0; i < KILL_POLL_ATTEMPTS; i++) {
    await sleep(TERM_POLL_MS)
    if (!(await probe(port))) {
      cleanStalePortFile()
      return { status: 'stopped', port, pid, forced }
    }
  }

  return { status: 'still-alive', port, pid }
}
