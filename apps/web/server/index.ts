// MUST stay the first import: it moves a server started in a deleted working
// directory into one that exists, before express (via depd) calls process.cwd().
import './lib/cwdGuard'

import http from 'node:http'
import path from 'node:path'

import express from 'express'
import cors from 'cors'

import {
  createAccessGate,
  createGatewayProxy,
  createOriginGuard,
  isRuntimeControlRequest,
} from '@clawboo/gateway-proxy'
import { loadSettings, resolveBasePath } from '@clawboo/config'
import { createLogger } from '@clawboo/logger'
import {
  listAgentsWithUndeliveredInbox,
  moveArchivedRoomTasks,
  reapOrphanInbox,
  listRoomsWithFireableDelegations,
  releaseFinishedSubtaskWaits,
  listRoomsWithIdleMainTasks,
  seedBuiltinTools,
  setDashboardPorts,
} from '@clawboo/db'

import { apiRouter } from './api/index'
import { carriesAttachToken, redactAttachCredentials } from './api/mcp'
import { attachIdentity } from './lib/auth'
import { reapOrphanedConnectors } from './lib/connectors/pidFile'
import { setDashboardPort } from './lib/connectors/dashboardGuard'
import { killProcessTreeByPid } from './lib/runtimes/killTree'
import { reapOrphanedRuntimeChildren, startRuntimePidRecord } from './lib/runtimes/runtimePidFile'
import { closeDb, getDb } from './lib/db'
import { killLiveSubprocesses, shutdownLiveSubprocesses } from './lib/runtimes/subprocess'
import { gcTaskWorkspaces } from './lib/worktrees'
import { startMcpSupervisor } from './lib/mcpSupervisor'
import { startApprovalReaper } from './lib/approvalReaper'
import { startMemoryEmbedding } from './lib/memoryEmbedding'
import { createStaleTaskSweep, reapOrphanedRuns, sweepStaleRuns } from './lib/staleTaskSweep'
import { upgradeFrozenToolsets } from './lib/runtimes/native/agentConfigStore'
import { registerBoardLifecycleSubscribers } from './lib/teamChat/boardLifecycleSubscribers'
import { pumpChatReportUps, startChatReportUps } from './lib/agentChat/chatHandOffs'
import { pumpTaskWakes, pumpTaskWakesByRoom, type TaskWakePumpDeps } from './lib/teamChat/taskWakes'
import { ensureNativeBooZero } from './lib/teamChat/booZero'
import { queueGatewayAborts } from './lib/teamChat/gatewayRunAborts'
import { sweepTaskSessionPointers } from './lib/teamChat/taskSessionPointers'
import {
  getTeamOrchestrator,
  roomCanRun,
  orchestratorKey,
  roomsWithUnheldChecks,
  roomsWithUnheldReportUps,
  taskForLiveSession,
  writeTeamAlert,
} from './lib/teamChat/teamOrchestrator'
import { taskForRoutineSession } from './lib/routines/openclawDispatch'
import { startRoutinesTicker } from './lib/routines/ticker'
import { engineHeld, engineHold } from './lib/engineHold'
import { onPauseLifted } from './lib/pauseBus'
import { isRunnerRerunWaiting, pumpRunnerReruns } from './lib/runnerRerun'
import { runnerTargetOf } from './lib/runnerRoute'
import { startTask } from './lib/startBoardTask'
import { runsOnTaskRunner } from './lib/runnerRoute'
import { and, desc, eq } from 'drizzle-orm'
import { getRegistry } from './lib/agentSource'
import { startExecApprovalSurface } from './lib/agentSource/execApprovalSurface'
import { startSessionActivityWatcher } from './lib/agentSource/sessionActivityWatcher'
import {
  resolveApiPort,
  writeApiPortFile,
  getApiPortFilePath,
  removeApiPortFileIfOwned,
  waitForPortFree,
} from './lib/portUtils'
import { resolveHost, isLoopbackHost, shouldRefuseInsecureBind } from './lib/resolveHost'
import { resolveBootAccessToken } from './lib/bootAccessToken'
import { runBootProbe } from './lib/bootProbe'
import { sweepLeftoverBudgetHolds } from './lib/budgetHold'
import { createBasePathMiddleware } from './lib/basePathMiddleware'
import { initOperatorSettings, OperatorSettingsError } from './lib/operatorSettings'
import { createProxyExposureWarning } from './lib/proxyExposureWarning'
import {
  loadProxyIdentityConfig,
  proxyIdentityFileWarning,
  type ProxyIdentityConfig,
} from './lib/proxyIdentity/config'
import { createProxyIdentityLane } from './lib/proxyIdentity/lane'
import { createAssertionVerifier } from './lib/proxyIdentity/verifier'
import { agents, costRecords } from '@clawboo/db'
import { ensureBrowserGrantsForAllAgents } from './lib/connectors/browserGrants'
import { restoreScreenshots } from './lib/screenshotBus'
import { mountSpa } from './lib/serveSpa'
import { ensureBrowserConnectedAtBoot, restoreConnectorsAtBoot } from './api/connectors'
import { refreshConnectedApps } from './lib/connectors/composio'
import { BROKERED_TOOLKITS } from '@clawboo/connector-catalog'

/** A duration env var, defaulted and BOUNDED to a positive integer. The bare
 *  `Number(...) || fallback` pattern rejects 0/''/NaN but accepts a negative,
 *  so one mistyped value became either an instant mass-reap (negative TTL) or a
 *  1ms hot timer loop (negative interval clamped by setInterval). */
function positiveIntEnv(name: string, fallback: number): number {
  // Bounded ABOVE too: Node clamps a timer delay past 2^31-1 ms down to 1ms, so
  // an oversized value would become the exact hot loop this helper exists to
  // prevent. ~24.8 days is beyond any sane duration here; take the fallback.
  const MAX_TIMER_MS = 2_147_483_647
  const n = Number(process.env[name])
  return Number.isFinite(n) && n >= 1 && n <= MAX_TIMER_MS ? Math.floor(n) : fallback
}

// ── Loggers ─────────────────────────────────────────────────────────────────

const log = createLogger('server')
const reqLog = createLogger('http')

// ── Graceful degradation ──────────────────────────────────────────────────────
// Run a subsystem's synchronous start step, catching any throw so one failed
// subsystem degrades (logged + surfaced in the boot probe / System Health) instead
// of crashing the whole server. Async subsystems keep their own `.catch`.
const safeStart = (name: string, fn: () => void): void => {
  try {
    fn()
  } catch (err) {
    log.error({ err, subsystem: name }, `${name} failed to start (degrading)`)
  }
}

// ── Helpers ──────────────────────────────────────────────────────────────────

const resolvePathname = (url: string | undefined): string => {
  const raw = typeof url === 'string' ? url : ''
  const idx = raw.indexOf('?')
  return (idx === -1 ? raw : raw.slice(0, idx)) || '/'
}

const GATEWAY_WS_PATH = '/api/gateway/ws'

/**
 * The Gateway proxy route, in either spelling. WS upgrades bypass the Express
 * middleware stack, so the base-path strip never runs on them: a browser served
 * under `/clawboo` connects to `/clawboo/api/gateway/ws`, while the loopback
 * control plane still uses the root path. Exact matches only, so no other path
 * can reach the proxy.
 */
const isGatewayWsPath = (pathname: string, basePath: string): boolean =>
  pathname === GATEWAY_WS_PATH || (basePath !== '' && pathname === `${basePath}${GATEWAY_WS_PATH}`)

/** Parse a comma-separated env var into a trimmed, non-empty list. */
const parseCsvEnv = (raw: string | undefined): string[] =>
  String(raw ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)

// ── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  const dev = process.argv.includes('--dev')
  const hostname = resolveHost()

  // The URL prefix the whole app is served under ('' = the origin root, the
  // default). Refuse to start on a malformed value rather than silently serving
  // at the root: an operator who set it has a proxy pointing here, and a quiet
  // fallback would look like a broken deployment instead of a bad setting.
  const basePathResult = resolveBasePath(process.env)
  if (!basePathResult.ok) {
    log.error(
      { value: process.env['CLAWBOO_BASE_PATH'] },
      `SECURITY/CONFIG: CLAWBOO_BASE_PATH is invalid (${basePathResult.reason}). ` +
        'Use a path like /clawboo, or unset it to serve at the root.',
    )
    process.exit(1)
  }
  const basePath = basePathResult.basePath

  // Settings an administrator pinned, in the operator file or the matching
  // environment variables. Refuse to start on anything that cannot be trusted:
  // carrying on would quietly drop pins they rely on, such as a disabled
  // self-update.
  // The proxy identity lane is among them, and refuses the same way when it is
  // on but has no key, issuer or audience it can trust.
  let proxyIdentityConfig: ProxyIdentityConfig | null = null
  try {
    const operator = initOperatorSettings(process.env)
    const pinned = Object.entries(operator.pins).map(([key, pin]) => `${key} (${pin.source})`)
    if (pinned.length > 0) {
      log.info({ file: operator.file, pinned }, 'Operator settings: pinned by the administrator')
    }
    proxyIdentityConfig = loadProxyIdentityConfig()
  } catch (err) {
    if (!(err instanceof OperatorSettingsError)) throw err
    log.error(`CONFIG: refusing to start. ${err.message}`)
    process.exit(1)
  }

  // If we were launched as a self-restart successor by an in-app update, the
  // exiting parent still holds the API port for a brief moment. Wait for it to
  // free before resolveApiPort — which throws on an explicit-but-taken
  // CLAWBOO_API_PORT — so the successor rebinds the SAME port the browser is
  // already pointed at. A missing/invalid value is a no-op (the common path).
  const awaitPortRaw = Number(process.env['CLAWBOO_AWAIT_PORT'])
  if (Number.isInteger(awaitPortRaw) && awaitPortRaw > 0 && awaitPortRaw <= 65535) {
    log.info({ port: awaitPortRaw }, 'Self-restart: waiting for the previous port to free')
    await waitForPortFree(awaitPortRaw, 15_000)
  }

  // Pick the API port up front. In dev mode the orchestrator script picks
  // a port first and exports it as `CLAWBOO_API_PORT` so the Vite proxy
  // and this server agree without a race. In production / CLI / standalone
  // boots we scan for a free port starting at DEFAULT_API_PORT (18790).
  const port = await resolveApiPort({ dev })

  log.info({ dev, hostname, port }, 'Starting Clawboo server')

  // ── Access gate ───────────────────────────────────────────────────────────

  // STUDIO_ACCESS_TOKEN when set (blank turns the gate off), else the per-install
  // token in <CLAWBOO_HOME>/access-token, shared with the desktop app and created
  // on the first start. Fail-closed: a token the gate cannot use, or a token file
  // that cannot be trusted, stops the boot on every bind, with or without
  // CLAWBOO_ALLOW_INSECURE (see bootAccessToken). The token is never logged, and
  // one read from the file never reaches a child: children get the environment.
  const bootToken = resolveBootAccessToken(process.env)
  if (!bootToken.ok) {
    log.error({ hostname, port }, bootToken.message)
    process.exit(1)
  }
  log.info({ source: bootToken.source }, 'Access gate token source')

  const accessGate = createAccessGate({
    token: bootToken.token,
    // Scopes the operator cookie to the mount and prefixes the post-exchange
    // redirect, so sharing an origin with another app does not share the cookie.
    basePath,
    // A spawned runtime's MCP client carries no cookie; it presents the attach
    // token this server minted into its URL. Admitted by that credential, never
    // by source address alone, because a same-host reverse proxy delivers every
    // remote request from loopback.
    authorizeRuntime: carriesAttachToken,
  })

  // ── Proxy identity lane ───────────────────────────────────────────────────
  // Off unless an administrator turned it on. Beside the access gate, not in
  // place of it: a request still needs the access token while the gate is on.
  // A spawned runtime's own control-plane calls are judged by the gate's own
  // test, so the lane exempts exactly what the gate admits without a cookie.
  const proxyIdentity = proxyIdentityConfig
    ? createProxyIdentityLane(proxyIdentityConfig, createAssertionVerifier(proxyIdentityConfig), {
        isRuntimeRequest: (req) => isRuntimeControlRequest(req, carriesAttachToken),
        // The reason only: the token never reaches a log.
        onRefuse: ({ reason, method, path }) =>
          log.warn({ reason, method, path }, 'Proxy identity: refused a request'),
      })
    : null
  if (proxyIdentityConfig) {
    log.info(
      {
        mode: proxyIdentityConfig.mode,
        binding: proxyIdentityConfig.binding,
        keys: proxyIdentityConfig.keys.source,
        header: proxyIdentityConfig.header,
      },
      'Proxy identity lane on',
    )
    if (proxyIdentityConfig.mode === 'on') {
      log.info(
        'Proxy identity: a request without a token still gets in with the access token, and ' +
          'what it does is recorded with no name. Set it to required to refuse such requests.',
      )
    }
    const fileWarning = proxyIdentityFileWarning()
    if (fileWarning) log.warn(fileWarning)
  }

  // ── Same-origin guard (CSWSH / DNS-rebinding / cross-site CSRF) ────────────
  // Always-on Origin + Host + Sec-Fetch-Site allowlist, independent of the token
  // gate. Closes Cross-Site WebSocket Hijacking (a malicious page opening
  // /api/gateway/ws to ride the server-injected upstream token) and cross-site
  // /api/* access on a default loopback install with zero config. The env
  // allowlists only WIDEN the set; they never disable enforcement.
  const allowedOrigins = parseCsvEnv(process.env['CLAWBOO_ALLOWED_ORIGINS'])
  const originGuard = createOriginGuard({
    port,
    bindHost: hostname,
    dev,
    allowedOrigins,
    allowedHosts: parseCsvEnv(process.env['CLAWBOO_ALLOWED_HOSTS']),
  })

  // Fail-closed: refuse to run a network-exposed dashboard with NO access token.
  // The origin guard is NOT auth against a non-browser LAN client (Host/Origin are
  // forgeable off-browser), so an unauthenticated wide bind leaves every /api/*
  // route — and the fleet — open to anyone who can reach this host. The default
  // loopback bind never trips this (shouldRefuseInsecureBind is false for loopback),
  // so the zero-friction CLI / dev / test flows are untouched; a deliberate wide
  // bind must set a token, or opt into the insecure posture explicitly.
  const allowInsecure = process.env['CLAWBOO_ALLOW_INSECURE'] === '1'
  if (shouldRefuseInsecureBind({ hostname, gateEnabled: accessGate.enabled, allowInsecure })) {
    log.error(
      { hostname, port },
      `SECURITY: refusing to start — bound to a non-loopback interface (HOST=${hostname}) ` +
        'with NO access token, so the dashboard and every /api/* route would be reachable ' +
        'UNAUTHENTICATED by anyone who can reach this host. Fix one of: set ' +
        'STUDIO_ACCESS_TOKEN=<random> to require a token; unset HOST to bind loopback only; ' +
        'or set CLAWBOO_ALLOW_INSECURE=1 to run unauthenticated on purpose.',
    )
    process.exit(1)
  }
  if (!isLoopbackHost(hostname) && !accessGate.enabled) {
    // Reached only when CLAWBOO_ALLOW_INSECURE=1 — the operator explicitly opted in.
    log.warn(
      { hostname, port },
      'SECURITY: non-loopback bind with NO access token and CLAWBOO_ALLOW_INSECURE=1 — the ' +
        'dashboard and every /api/* route are reachable UNAUTHENTICATED by anyone on your ' +
        'network. You opted in; set STUDIO_ACCESS_TOKEN to close the hole.',
    )
  }

  // A non-loopback bind with no configured origins: LAN/remote origins are blocked
  // by the same-origin guard (loopback stays allowed) until the operator enumerates
  // them. Warn so a headless/LAN operator knows the one env var to set.
  if (!isLoopbackHost(hostname) && allowedOrigins.length === 0) {
    log.warn(
      { hostname, port },
      'SECURITY: non-loopback bind with no CLAWBOO_ALLOWED_ORIGINS — the same-origin ' +
        'guard will block LAN/remote browser origins (loopback still works). Set ' +
        'CLAWBOO_ALLOWED_ORIGINS (comma-separated, e.g. https://dash.example.com) to allow them.',
    )
  }

  // ── Gateway proxy ─────────────────────────────────────────────────────────

  const proxy = createGatewayProxy({
    loadUpstreamSettings: async () => {
      const settings = loadSettings(process.env)
      return { url: settings.gatewayUrl, token: settings.gatewayToken }
    },
    allowWs: (req) => {
      if (!isGatewayWsPath(resolvePathname(req.url), basePath)) return false
      // Same-origin guard first (CSWSH), then the optional token gate.
      if (!originGuard.allowUpgrade(req)) return false
      if (!accessGate.allowUpgrade(req)) return false
      return true
    },
    log: (msg, meta) => log.info(meta ?? {}, msg),
    logError: (msg, err) => log.error({ err }, msg),
  })

  // ── Express app ───────────────────────────────────────────────────────────

  const app = express()

  // Match route casing exactly so Express's matcher and the access gate agree:
  // without this, `/API/settings` resolves to the `/api/settings` handler, and any
  // gate that keyed off a different normalization could be evaded. Every route and
  // client in this repo is lowercase, so this changes nothing for real traffic.
  // This covers routes on the app itself; `apiRouter` sets the same option on its
  // own constructor, because a Router does not inherit it.
  app.set('case sensitive routing', true)

  // The server-trusted loopback port. Request handlers that hand a callback URL to a
  // spawned runtime (the MCP attach base) read this instead of the client `Host`
  // header — a forged Host must never redirect a runtime's Tasks/Memory/Tools/TeamChat
  // traffic. Mirrors the `http://127.0.0.1:${port}` the boot/ticker callers use.
  app.locals['apiPort'] = port
  // Agents' browsers are launched with this port's loopback origins and the
  // bind address blocked, and the broker refuses connector calls that name
  // them: the dashboard has no access check on loopback (see
  // lib/connectors/dashboardGuard.ts).
  setDashboardPort(port, hostname)
  setDashboardPorts([port], [hostname])
  // The base-path middleware STRIPS the prefix from `req.url` before routing, so
  // a route that needs to build an absolute-on-this-origin redirect cannot
  // recover it from the request. Publishing the validated value is how a route
  // rebuilds a Location without reaching for the raw `req.originalUrl`.
  app.locals['basePath'] = basePath
  // POST /api/access/launch-code mints its one-time sign-in codes from this gate.
  app.locals['accessGate'] = accessGate

  // Base-path strip, BEFORE the origin guard, and nothing may be mounted ahead
  // of it. The guards below protect a request whose path is under `/api/` and
  // fail OPEN otherwise, so they must only ever see root-form paths; stripping
  // here is what lets them keep their existing checks and cover the prefixed
  // surface too. A pass-through when no prefix is configured.
  app.use(createBasePathMiddleware(basePath))

  // Behind a reverse proxy with no access token, every /api/* route is open to
  // whoever can reach the proxy, and the loopback bind hides it from the boot
  // checks above. Say so on the first forwarded request. Observes only; ahead of
  // the origin guard so a request it 403s still counts.
  const warnProxyExposure = createProxyExposureWarning({
    // A required identity lane guards every /api/ route as the gate would.
    gateEnabled: accessGate.enabled || proxyIdentity?.mode === 'required',
    warn: (message) => log.warn({ port }, message),
  })
  app.use((req, _res, next) => {
    warnProxyExposure(req)
    next()
  })

  // Same-origin guard — FIRST, before body parsing / CORS / the access gate, so a
  // cross-origin (CSWSH/rebinding/CSRF) /api/* request is 403'd before any work.
  app.use((req, res, next) => {
    if (originGuard.checkHttp(req, res)) return
    next()
  })

  // CORS: only needed in dev (Vite on :5173 → Express on the dynamic API port).
  // Reflect ONLY allowlisted origins (never `origin: true`) so a foreign page can't
  // be granted credentialed cross-origin reads.
  if (dev) {
    app.use(
      cors({
        origin: (origin, cb) => cb(null, originGuard.isAllowedOrigin(origin)),
        credentials: true,
      }),
    )
  }

  // JSON body parser — must be before API routes
  app.use(express.json({ limit: '2mb' }))

  // Access gate middleware
  app.use((req, res, next) => {
    if (accessGate.handleHttp(req, res)) return
    next()
  })

  // Proxy identity lane: checks the sign-in proxy's signed token and sets
  // req.person. After the access gate, so a request without the access token
  // is refused before any token is looked at.
  if (proxyIdentity) app.use(proxyIdentity.http)

  // Identity middleware. A pass-through: it sets req.tenantId and req.userId
  // (the verified person's id, else null). Runs after the access gate and the
  // identity lane, so unauthenticated requests are rejected before it.
  app.use(attachIdentity)

  // Per-request logging
  app.use((req, res, next) => {
    const start = Date.now()
    res.on('finish', () => {
      const url = req.originalUrl ?? req.url
      // Skip high-frequency static asset requests. `originalUrl` keeps the mount
      // prefix, so the test allows for it.
      const rel = basePath && url.startsWith(basePath) ? url.slice(basePath.length) : url
      if (rel.startsWith('/assets/') || rel.startsWith('/fonts/')) return
      const durationMs = Date.now() - start
      const level = res.statusCode >= 500 ? 'error' : res.statusCode >= 400 ? 'warn' : 'info'
      reqLog[level]({
        method: req.method,
        url: redactAttachCredentials(url),
        status: res.statusCode,
        durationMs,
      })
    })
    next()
  })

  // API routes
  app.use(apiRouter)

  // Production: serve Vite build output as static SPA
  if (!dev) {
    // Requests arrive with the prefix already stripped; `basePath` is passed only
    // so the served shell can advertise its own mount point.
    mountSpa(app, process.env['CLAWBOO_UI_DIR'] || path.join(__dirname, 'ui'), basePath)
  }

  // ── HTTP server (raw, for WS upgrade handling) ────────────────────────────

  const server = http.createServer(app)

  // ── WebSocket upgrade routing ─────────────────────────────────────────────

  server.on('upgrade', (req, socket, head) => {
    // The raw upgrade handler runs OUTSIDE Express, so the base-path middleware
    // never sees these and the prefix is still present. Accept both spellings:
    // the prefixed one a browser under the mount sends, and the root one the
    // loopback control plane uses.
    if (isGatewayWsPath(resolvePathname(req.url), basePath)) {
      // Same-origin guard on the WS upgrade (CSWSH). Reply 403 before handing off
      // so a rejected handshake gets a real response, not a bare socket teardown.
      // `socket.end(...)` flushes the response bytes before the FIN.
      if (!originGuard.allowUpgrade(req)) {
        socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\nContent-Length: 0\r\n\r\n')
        return
      }
      if (!proxyIdentity) {
        proxy.handleUpgrade(req, socket, head)
        return
      }
      // The identity lane checks the token before the handshake goes on. The
      // check is async (a key may need fetching), and the HTTP server has
      // already let go of this socket, so a client that resets it meanwhile
      // must not raise an unhandled error.
      const dropOnError = () => socket.destroy()
      socket.on('error', dropOnError)
      void proxyIdentity.checkUpgrade(req).then((decision) => {
        socket.off('error', dropOnError)
        if (socket.destroyed) return
        if (!decision.ok) {
          socket.end('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\nContent-Length: 0\r\n\r\n')
          return
        }
        proxy.handleUpgrade(req, socket, head)
      })
      return
    }
    // No other WS upgrades needed (Vite HMR runs on its own port)
    socket.destroy()
  })

  // ── SQLite: open the process-wide connection + bootstrap the schema ─────────
  // The server holds ONE connection for its whole lifetime (see lib/db.ts). Doing
  // it here, before anything queries, makes the 88-statement DDL bootstrap a
  // single deterministic boot step rather than a side effect of whichever request
  // or background ticker happens to fire first. Best-effort: a failure here means
  // the DB is unusable, which the boot probe reports as a FATAL `databaseIntegrity`
  // / `databaseSchema` check on /api/health — the designed reporting channel — so
  // we log and keep serving rather than exiting.
  try {
    getDb()
  } catch (err) {
    log.error({ err }, 'SQLite: could not open/bootstrap the database — see /api/health')
  }

  // ── Orphaned runtime children ───────────────────────────────────────────────
  // An agent run outlives an engine that dies hard: a crash, a force-quit from
  // the desktop app or an update restart runs no shutdown hook, and most runtime
  // children are their own process group, so they keep running. Reconciliation
  // below would then hand their tasks to new runs while the old ones still edit
  // the same worktrees. So the children of every engine that is gone are killed
  // FIRST, and only then does this engine start recording its own (nothing has
  // been able to spawn one yet). An engine still running on this state dir keeps
  // its runs.
  safeStart('runtime-reap', () => {
    const report = reapOrphanedRuntimeChildren()
    if (report.killed > 0 || report.expired > 0) {
      log.info(report, 'Runtimes: reaped agent processes left by a previous engine')
    }
    if (report.unverified > 0) {
      log.warn(
        report,
        'Runtimes: left processes from a previous engine running; this host could not confirm they are ours',
      )
    }
  })
  safeStart('runtime-pid-record', () => startRuntimePidRecord())

  // ── Durable board: orphan reconciliation ────────────────────────────────────
  // Liveness-aware: only a `running` execution that has STOPPED heartbeating
  // (task updatedAt stale past the shared TTL) is reaped — a still-beating run
  // belongs to a live process (a second clawboo on this state dir, or the old
  // server's drains during a fast dev restart) and must not be murdered at boot.
  // A run that truly died with the previous server either is already stale here
  // or goes stale within the TTL, where the interval sweep below releases it.
  // The recovery tombstone keeps the reap idempotent. Best-effort; never blocks
  // boot. Shares CLAWBOO_BOARD_STALE_TTL_MS with the sweep.
  try {
    const staleAfterMs = positiveIntEnv('CLAWBOO_BOARD_STALE_TTL_MS', 3 * 60_000)
    const reconciled = reapOrphanedRuns(getDb(), staleAfterMs)
    if (reconciled > 0) {
      log.info({ reconciled }, 'Board: reconciled orphaned executions on startup')
    }
  } catch (err) {
    log.error({ err }, 'Board: orphan reconciliation failed (non-fatal)')
  }

  // ── Budget holds no run can settle any more ────────────────────────────────
  // A run holds its estimated cost on its budgets until it ends (see budgetHold).
  // Holds left by a server that stopped without ending its runs (a crash, a force
  // quit, a restart mid-run) would block parallel runs on those budgets for good,
  // so they go here, before this server starts a run. A sweep that fails is tried
  // again on a timer. Best-effort; never blocks boot.
  try {
    sweepLeftoverBudgetHolds(getDb())
  } catch (err) {
    log.error({ err }, 'Budgets: sweeping leftover holds failed (non-fatal)')
  }

  // ── Archived rooms: their unfinished tasks belong to the team's own chat ────
  // Archiving a room moves its unfinished tasks to the team's group chat, still
  // stopped (see moveArchivedRoomTasks). Rooms archived before that existed still
  // hold theirs, where no engine can see them; this pass moves them. After the
  // orphan reconciliation, so a task it just released is marked stopped rather
  // than started by the pump below. Idempotent; best-effort; never blocks boot.
  try {
    const db = getDb()
    const { moved, closedRuns } = moveArchivedRoomTasks(db, {
      skip: (t) => runsOnTaskRunner(db, t),
    })
    if (moved.length > 0) {
      log.info({ moved: moved.length }, 'Board: moved unfinished tasks out of archived rooms')
    }
    // No engine stopped those runs, so an OpenClaw one may still be going in the
    // Gateway, which is not connected yet at this point. They wait for it.
    queueGatewayAborts(db, closedRuns)
  } catch (err) {
    log.error({ err }, 'Board: moving tasks out of archived rooms failed (non-fatal)')
  }

  // ── Task resume pointers nothing will read again ───────────────────────────
  // A task's own events clear its pointers as it finishes, is cancelled or is
  // given to someone else. This catches what they could not: a task an MCP stdio
  // server finished from another process, or one that finished while this server
  // was down. Best-effort; never blocks boot.
  try {
    const swept = sweepTaskSessionPointers(getDb())
    if (swept > 0) log.info({ swept }, 'Board: dropped task resume pointers nothing will resume')
  } catch (err) {
    log.error({ err }, 'Board: sweeping task resume pointers failed (non-fatal)')
  }

  // ── Worktrees: GC stale worktrees on startup ────────────────────────────────
  // Reap aged / over-count worktrees whose tasks aren't locked (in_progress /
  // in_review). Commit-before-drop means no uncommitted work is lost. Best-
  // effort; never blocks boot.
  void gcTaskWorkspaces()
    .then(({ reaped, failed }) => {
      if (reaped.length > 0 || failed.length > 0) {
        log.info(
          { reaped: reaped.length, failed: failed.length },
          'Worktrees: startup GC swept stale worktrees',
        )
      }
    })
    .catch((err: unknown) => log.error({ err }, 'Worktrees: startup GC failed (non-fatal)'))

  // ── Tools broker: seed the registry ─────────────────────────────────────────
  // Insert a tool_registry row for every builtin brokered tool so the enabled /
  // provenance / availability columns exist. Without this the table is empty and
  // disabling a brokered tool is a silent no-op (setToolEnabled UPDATEs zero rows,
  // isToolEnabled falls back to true). Idempotent — a re-seed preserves a prior
  // user disable. Best-effort; never blocks boot.
  safeStart('tools-registry-seed', () => seedBuiltinTools(getDb()))

  // ── Coordination-toolset repair (one-shot) ──────────────────────────────────
  // Agents created before the coordination overhaul were frozen with
  // `{tasks:false, teamchat:false}`, which switched off the whole coordination
  // plane: the peer-inbox pull became a no-op and a leader couldn't read its own
  // board. New agents ship the right surface, but `ensureSchema` only reconciles
  // COLUMNS — nothing rewrites a frozen row's data — so repair them once, here.
  // Guarded by a settings flag, so a user who later turns these tools off keeps
  // them off.
  safeStart('coordination-toolset-upgrade', () => {
    const repaired = upgradeFrozenToolsets(getDb())
    if (repaired > 0) log.info({ repaired }, 'repaired coordination toolset on existing agents')
  })

  // ── Default-native Boo Zero ─────────────────────────────────────────────────
  // Ensure a native-first install has its runtime-neutral universal leader — a
  // teamless clawboo-native Boo Zero — so native teams get a real coordinator and the
  // graph reflects it immediately (not only after the first message). Self-gated (a
  // native team member exists + a native key is connected + none is designated); a
  // no-op for a pure-OpenClaw / no-key install. Best-effort; never blocks boot.
  safeStart('native-boo-zero', () => {
    void ensureNativeBooZero(getDb(), getRegistry().nativeSource).catch(() => undefined)
  })

  // ── Browser grants ──────────────────────────────────────────────────────────
  // Every agent gets the browser connectors, including the ones no create-time
  // hook can reach: the onboarding seed, Boo Zero, and the rows the OpenClaw sync
  // mints for agents that already existed in the operator's Gateway. Insert-only,
  // so a browser an operator revoked stays revoked across restarts, and running
  // it on every boot needs no migration flag. Best-effort; never blocks boot.
  safeStart('browser-grants', () => {
    const db = getDb()
    ensureBrowserGrantsForAllAgents(
      db,
      db
        .select({ id: agents.id })
        .from(agents)
        .all()
        .map((r) => r.id),
    )
  })

  // ── MCP liveness supervisor ─────────────────────────────────────────────────
  // Pre-warm the in-process MCP servers + health-probe them (rebuild-on-failure
  // with backoff). Best-effort, never blocks boot.
  safeStart('mcp-supervisor', () => startMcpSupervisor({ log }))
  // Probe the embedding provider now, and index any facts it has no vector
  // for, rather than on whichever request happens to arrive first.
  safeStart('memory-embedding', () => startMemoryEmbedding())

  // ── Approval-TTL reaper ─────────────────────────────────────────────────────
  // Expire abandoned pending approvals after the TTL (default 24h). One pass at
  // boot + a singleton unref'd interval.
  safeStart('approval-reaper', () => startApprovalReaper({ log }))

  // ── Board stale-task sweep ──────────────────────────────────────────────────
  // Liveness is now PROVEN, not inferred: EVERY drain that claims a task
  // heartbeats the row. There are three — the executor runner, the team
  // orchestrator's serverDeliver, and the routines dispatcher — and a fourth
  // must beat too or its live work gets swept here. `startTaskHeartbeat` bumps
  // `tasks.updatedAt` every TASK_HEARTBEAT_MS (30s) on a TIMER, not on event
  // traffic, so a working-but-silent run keeps proving itself, and it beats once
  // immediately so worktree acquisition can't read as stale. That turns this
  // sweep from an
  // hour-scale guess into a minutes-scale fact: an `in_progress` task whose
  // updatedAt is older than the TTL has had NO observing drain for several beat
  // intervals — its process died or its drain wedged — so releasing it to `todo`
  // is safe, and a run that keeps beating is never falsely swept, however long
  // it works. (A rare late completion is preserved: completeForSession refuses
  // the fake-complete and parks the result as a task comment.) 3 min default
  // (6 missed beats); tune with CLAWBOO_BOARD_STALE_TTL_MS. Best-effort, unref'd.
  safeStart('board-stale-sweep', () => {
    // KEEP THIS BELOW `DELEGATION_IDLE_TIMEOUT_MS` (8 min). The sweep is what
    // publishes `task_released`, which is what detaches a stale session from the
    // engine (see boardLifecycleSubscribers). If the TTL is tuned past the idle
    // watchdog, the watchdog reaches a phantom session FIRST, fails the task to
    // `blocked` and cancel-chains its dependents — the exact permanent stall the
    // detach exists to prevent. A guard test pins the relationship.
    const ttlMs = positiveIntEnv('CLAWBOO_BOARD_STALE_TTL_MS', 3 * 60_000)
    const intervalMs = positiveIntEnv('CLAWBOO_BOARD_STALE_SWEEP_MS', 60_000)
    // A pass right after the machine wakes must not read every live run's
    // pre-sleep beat as stale; the pass allows for the slept time.
    const pass = createStaleTaskSweep({
      ttlMs,
      intervalMs,
      reconcile: (olderThanMs) => sweepStaleRuns(getDb(), olderThanMs),
    })
    const sweep = (): void => {
      try {
        const reconciled = pass()
        if (reconciled > 0) log.info({ reconciled }, 'Board: moved tasks whose runs went silent')
      } catch (err) {
        log.error({ err }, 'Board: stale-task sweep failed (non-fatal)')
      }
    }
    sweep()
    setInterval(sweep, intervalMs).unref()
  })

  // ── Board dispatch pump ─────────────────────────────────────────────────────
  // "todo means WILL run": delegation-derived work (an `:agent:`-marked task —
  // deferred, plan-step, or released by the stale sweep / orphan reap) no longer
  // waits for a user message to rebuild its team's engine. The pump scans for
  // teams holding fireable delegations and pumps each team orchestrator —
  // lazily (re)building it, which also makes a server restart a PAUSE for
  // in-flight cascades instead of amnesia (`resume()` re-attaches + fires).
  // What actually runs is decided by the ENGINE's fire policy (deps satisfied;
  // a user-Stopped task — `cancelled` last execution — is never auto-refired;
  // MAX_AUTO_FIRES caps a permafailing one), and the atomic claim-409 arbitrates
  // any race with a live engine. Human/board-created cards WITHOUT the marker
  // stay manual by design. Best-effort, unref'd.
  //
  // A held engine (see engineHold) skips the pass: claiming tasks it cannot start
  // would only leave them `in_progress` across the stop it is waiting for. When
  // the hold lifts, a pass runs at once, and so it does when a pause lifts. Paused
  // work needs no check here: the scans leave it out, and the claim refuses it.
  safeStart('board-dispatch-pump', () => {
    const pumpMs = positiveIntEnv('CLAWBOO_DISPATCH_PUMP_MS', 60_000)
    const mcpBase = `http://127.0.0.1:${port}`
    // The bus subscribers make pushes immediate; this interval is the durable
    // BACKSTOP (and the boot-resume path: the first pass rebuilds every team
    // holding fireable work OR undelivered mail, so a restart is a pause).
    /** The wake pump's hands: start a task for a person, or pump a room's engine. */
    const wakeDeps = (
      pumpRoom: (teamId: string, roomId: string | null) => void,
    ): TaskWakePumpDeps => ({
      held: engineHeld,
      startForPerson: (task) => {
        // One already on its way keeps its place in the queue for a run slot.
        if (isRunnerRerunWaiting(task.id)) return
        startTask(getDb(), task.id, task.teamId, runnerTargetOf(getDb(), task), mcpBase)
      },
      startByItself: (task) => {
        if (isRunnerRerunWaiting(task.id)) return
        startTask(getDb(), task.id, task.teamId, runnerTargetOf(getDb(), task), mcpBase, {
          automatic: true,
        })
      },
      pumpRoom,
      alert: (alert) => writeTeamAlert(getDb(), alert),
    })
    const pumpRoomNow = (teamId: string, roomId: string | null): void => {
      if (!roomCanRun(getDb(), teamId, roomId)) return
      getTeamOrchestrator(teamId, { mcpBaseUrl: mcpBase, roomId })
        .pump()
        .catch((err: unknown) => log.error({ err, teamId, roomId }, 'Board: wake pump failed'))
    }
    registerBoardLifecycleSubscribers({
      mcpBaseUrl: mcpBase,
      pumpWakes: () => {
        try {
          pumpTaskWakesByRoom(getDb(), wakeDeps, pumpRoomNow)
          // A woken task the runner runs goes through the runner's own pump.
          if (!engineHeld()) pumpRunnerReruns(getDb(), mcpBase)
        } catch (err) {
          log.error({ err }, 'Board: wake pump scan failed (non-fatal)')
        }
      },
    })
    const pump = (): void => {
      if (engineHeld()) {
        // Nothing starts. Each waiting wake still says why it waits.
        try {
          pumpTaskWakes(
            getDb(),
            wakeDeps(() => undefined),
          )
        } catch (err) {
          log.error({ err }, 'Board: wake pump scan failed (non-fatal)')
        }
        return
      }
      try {
        const db = getDb()
        // Tasks the task runner ran re-fire through the runner, not team chat
        // (team chat's ready list skips them; see lib/runnerRerun).
        pumpRunnerReruns(db, mcpBase)
        // Results of work handed off from a one-to-one chat go back to that chat.
        pumpChatReportUps(db, { mcpBaseUrl: mcpBase })
        // One orchestrator per team chat room, so the scan names the room too
        // (null = the team's own group chat).
        const wake = new Map<string, { teamId: string; roomId: string | null }>()
        // A task waiting on sub-tasks that have nothing more to report goes back to the
        // queue here, before the scan: this is what a restart leans on.
        releaseFinishedSubtaskWaits(db)
        for (const r of listRoomsWithFireableDelegations(db))
          wake.set(orchestratorKey(r.teamId, r.roomId), r)
        // Saved wakes. The room is read now, at fire time: archiving a room moves its
        // tasks. Ones a person is behind start at once; the rest go through the room's
        // engine and its fire policy.
        pumpTaskWakes(
          db,
          wakeDeps((teamId, roomId) =>
            wake.set(orchestratorKey(teamId, roomId), { teamId, roomId }),
          ),
        )
        // Teams whose agents hold undelivered mailbox rows: waking the team
        // rebuilds its orchestrator; the rows ride the next run's digest (or,
        // for a team that stays idle, wait for the next user turn — waking is
        // about the ORCHESTRATOR being resident again after a restart).
        // Retention first: drop rows for recipients that no longer exist (and
        // stale rows past the cutoff) so the scan below never wakes a ghost.
        reapOrphanInbox(db)
        for (const a of listAgentsWithUndeliveredInbox(db))
          if (a.teamId) wake.set(orchestratorKey(a.teamId), { teamId: a.teamId, roomId: null })
        // Rooms whose `[Task Update]`s a restart or an eviction left pending:
        // building the room's engine sends them again.
        for (const r of roomsWithUnheldReportUps(db))
          wake.set(orchestratorKey(r.teamId, r.roomId), r)
        // Rooms with a person's request whose work has closed and nobody told its lead.
        for (const r of listRoomsWithIdleMainTasks(db))
          wake.set(orchestratorKey(r.teamId, r.roomId), r)
        // Rooms whose team-chat work check a restart cut short: building the
        // room's engine hands those tasks to a person.
        for (const r of roomsWithUnheldChecks(db)) wake.set(orchestratorKey(r.teamId, r.roomId), r)
        for (const { teamId, roomId } of wake.values()) {
          // Nothing wakes an archived or deleted team, whatever it left behind.
          if (!roomCanRun(db, teamId, roomId)) continue
          getTeamOrchestrator(teamId, { mcpBaseUrl: mcpBase, roomId })
            .pump()
            .catch((err: unknown) =>
              log.error({ err, teamId, roomId }, 'Board: dispatch pump failed'),
            )
        }
      } catch (err) {
        log.error({ err }, 'Board: dispatch pump scan failed (non-fatal)')
      }
    }
    startChatReportUps(getDb, { mcpBaseUrl: mcpBase })
    // First pass shortly after boot (let the registry / Boo Zero bootstrap land).
    setTimeout(pump, 10_000).unref()
    setInterval(pump, pumpMs).unref()
    engineHold().onResume(pump)
    onPauseLifted(pump)
  })

  // ── Agent registry (AgentSource) ────────────────────────────────────────────
  // Open the server-side Gateway connection + sync the OpenClaw agents INTO
  // SQLite (the registry-of-record). Best-effort: gated on settings being present,
  // retries with backoff, degrades to SQLite-only reads when the Gateway is down.
  void getRegistry()
    // Pass the resolved server base URL so the source can register clawboo's
    // shared Memory/Tasks MCP servers in the Gateway config after connect.
    .start({ log, mcpBaseUrl: `http://127.0.0.1:${port}` })
    .catch((err: unknown) => log.error({ err }, 'Agent registry: startup failed (non-fatal)'))

  // Log what OpenClaw agents do when nobody asked them to: their own cron, an
  // incoming WhatsApp or Telegram message, someone at OpenClaw's own terminal.
  // Those runs are addressed to no clawboo connection, so they were absent from
  // the activity feed rather than merely thin. Started after the registry because
  // it hangs off that source's connection, and idempotent on reconnect.
  // Somewhere an exec approval can be asked that is not a browser tab. Started
  // BEFORE the capability is declared (see execApprovalSurface): a declared
  // capability with no handler turns a fast refusal into a silent 30-minute hang.
  safeStart('openclaw-exec-approvals', () => {
    const db = getDb()
    startExecApprovalSurface(
      getRegistry().source,
      (sourceAgentId) => {
        const row = db
          .select({ id: agents.id })
          .from(agents)
          .where(eq(agents.sourceAgentId, sourceAgentId))
          .get()
        return row?.id ?? null
      },
      (sessionKey) => taskForLiveSession(sessionKey) ?? taskForRoutineSession(sessionKey),
    )
  })

  safeStart('openclaw-session-activity', () => {
    const db = getDb()
    startSessionActivityWatcher(
      getRegistry().source,
      (sourceAgentId) => {
        // OpenClaw's agent id maps to clawboo's ROW id, which is what the feed and
        // the panel are keyed on. They are equal on every row today, so resolving
        // properly costs nothing now and is the difference between a correct feed
        // and a misattributed one the first time an agent is re-imported.
        const row = db
          .select({ id: agents.id })
          .from(agents)
          .where(eq(agents.sourceAgentId, sourceAgentId))
          .get()
        return row?.id ?? null
      },
      // What this agent was last billed for, so a restart mid-conversation
      // resumes rather than charging the turn in flight a second time.
      (agentId, sessionKey) => {
        const row = db
          .select({
            model: costRecords.model,
            inputTokens: costRecords.inputTokens,
            outputTokens: costRecords.outputTokens,
          })
          .from(costRecords)
          // BOTH keys. An agent can hold several conversations, and the newest
          // row for the agent may belong to a different one; seeding this
          // session with that cumulative snapshot makes the next turn bill the
          // difference between two unrelated numbers. Rows written before
          // `session_key` existed carry null and simply never match, which
          // degrades to not seeding rather than to seeding wrongly.
          .where(and(eq(costRecords.agentId, agentId), eq(costRecords.sessionKey, sessionKey)))
          .orderBy(desc(costRecords.createdAt))
          .get()
        return row ? { ...row } : null
      },
    )
  })

  // ── Listen ────────────────────────────────────────────────────────────────

  server.listen(port, hostname, () => {
    const hostForBrowser = hostname === '0.0.0.0' || hostname === '::' ? 'localhost' : hostname
    // Trailing slash under a mount so the shell's relative assets resolve without
    // relying on the redirect (which is there for hand-typed URLs).
    const browserUrl = `http://${hostForBrowser}:${port}${basePath ? `${basePath}/` : ''}`

    // Publish the chosen port for external tools (CLI, Vite proxy fallback,
    // e2e helpers). Best-effort: if writing fails, downstream consumers can
    // still discover the port via the CLAWBOO_API_PORT env var. Said out loud,
    // since the clawboo command sends the access token only to this file's port.
    if (!writeApiPortFile(port)) {
      log.warn(
        { port, file: getApiPortFilePath() },
        'Could not write the port file. The clawboo command finds this server through it ' +
          'and sends its access token only to the port it names, so it cannot sign in to ' +
          'this server until the file can be written.',
      )
    }

    log.info({ url: browserUrl }, `Clawboo ready — open in browser: ${browserUrl}`)

    // ── Routines ticker ───────────────────────────────────────────────────────
    // The durable scheduled_runs ledger is the source of truth; the ticker is a
    // rebuildable actuator: boot-resume heals orphaned rows, then arms from
    // next_run_at. Started inside the listen callback because dispatched runs
    // attach clawboo's MCP at the resolved port.
    safeStart('routines-ticker', () =>
      startRoutinesTicker({ log, mcpBaseUrl: `http://127.0.0.1:${port}` }),
    )

    // ── Orphaned connector children ───────────────────────────────────────────
    // A connector child outlives a HARD stop: a crash or a SIGKILL runs no
    // shutdown hook, and the child is a real process nobody is left holding. On
    // the next boot clawboo would spawn a second one and never learn about the
    // first. Reaped BEFORE anything can connect, so the records reaped here are
    // always the previous process's.
    safeStart('connector-reap', () => {
      const report = reapOrphanedConnectors((pid) => killProcessTreeByPid(pid))
      if (report.killed > 0 || report.expired > 0) {
        log.info(report, 'Connectors: reaped children left by a previous run')
      }
      if (report.unverified > 0) {
        log.warn(
          report,
          'Connectors: left processes from a previous run running; this host could not show they are ours',
        )
      }
    })

    // ── Connector restore ─────────────────────────────────────────────────────
    // A connector lives in memory, so every restart used to drop every one of
    // them and the operator had to reconnect the same servers by hand every
    // time. The credentials, tokens and launch arguments were durable all along;
    // only the session was not. Reconnects exactly what the operator left running
    // (see `desiredState`), never one they switched off.
    //
    // AFTER THE REAP, so a child left by a previous process is killed before a
    // new one is spawned, and NOT awaited: a cold `npx` install can take the
    // better part of a minute and the server must be serving long before that.
    // Frames BEFORE anything can serve a read. A restart used to wipe every
    // captured screen, so the browser panel said "Nothing captured yet" for a
    // Boo that had browsed all afternoon.
    safeStart('frame-restore', () => {
      const frames = restoreScreenshots()
      if (frames > 0) log.info({ frames }, 'Browser: restored frames captured before the restart')
    })

    safeStart('connector-restore', () => {
      void restoreConnectorsAtBoot(getDb())
        .then(async (restored) => {
          if (restored > 0) log.info({ restored }, 'Connectors: restored previous session')
          // AFTER the restore, so a browser the operator already connected comes
          // back through the sweep and this sees a row and stands down. Only a
          // machine that has never had one gets a browser started for it.
          const browsers = await ensureBrowserConnectedAtBoot(getDb())
          if (browsers > 0) {
            log.info({ browsers }, 'Connectors: started a browser so every agent has one')
          }
          // WARM THE BROKER'S APP LIST TOO. The graph draws a node per connected
          // app from a cache that nothing filled at boot, so the apps an
          // operator had granted stayed invisible until something happened to
          // open the marketplace. Failure is silent: it is a cache.
          await refreshConnectedApps(BROKERED_TOOLKITS).catch(() => undefined)
        })
        .catch(() => undefined)
    })

    // ── Boot probe ────────────────────────────────────────────────────────────
    // Snapshot the resolved state (state dir, vault, db, port) + every subsystem's
    // health on a single surface (/api/health → System Health view). Fatal checks
    // are logged loudly but the server keeps serving — a fresh-install user fixes
    // them from the diagnostics surface (or resets ~/.clawboo). Best-effort.
    void runBootProbe({ port })
      .then((report) => {
        const summary = {
          degraded: report.degraded,
          fatal: report.fatal,
          checks: report.checks.length,
        }
        if (report.fatal.length > 0) {
          log.error(summary, 'Boot probe: FATAL checks failed — see System Health (/api/health)')
        } else if (report.degraded.length > 0) {
          log.warn(summary, 'Boot probe: running degraded — see System Health (/api/health)')
        } else {
          log.info(summary, 'Boot probe: all checks passed')
        }
      })
      .catch((err: unknown) => log.error({ err }, 'Boot probe failed (non-fatal)'))
  })

  // Best-effort cleanup of the runtime port file on graceful shutdown so
  // stale entries don't mislead the CLI on the next launch. We don't rely
  // on this for correctness (the file is just a hint — the CLI probes the
  // port before opening the browser).
  //
  // `closeDb()` also checkpoints the SQLite WAL so a naive single-file copy
  // of `clawboo.db` captures all recent committed writes without the WAL
  // sidecars. This is defense-in-depth only — the WAL is crash-safe and
  // recovered on the next open — so a checkpoint failure is logged and
  // never blocks shutdown or changes the exit code.
  //
  // This runs TWICE by construction: the signal handlers below call it and then
  // call `process.exit(0)`, which fires the `'exit'` hook that calls it again.
  // `closeDb()` is idempotent, and the flag keeps the port-file removal and the
  // log from repeating.
  let shutDown = false
  const cleanup = (): void => {
    if (shutDown) return
    shutDown = true
    // Reap spawned runtime children BEFORE we go. They are detached process-group
    // leaders and are deliberately never unref'd, so they outlive this process —
    // still spending against the provider while boot-time reconciliation hands
    // their task to another runner (two live runs on one worktree).
    try {
      const reaped = killLiveSubprocesses()
      if (reaped > 0) log.info({ reaped }, 'Terminated running runtime subprocesses on shutdown')
    } catch (err) {
      log.warn({ err }, 'Failed to terminate runtime subprocesses on shutdown (non-fatal)')
    }
    // Only if the file still names OUR port: a second instance (auto-scan
    // fallback, or a restart successor that has already rebound) may have
    // rewritten it, and deleting that would strand a server that is still up.
    removeApiPortFileIfOwned(port)
    try {
      closeDb()
    } catch (err) {
      log.warn({ err }, 'WAL checkpoint on shutdown failed (non-fatal)')
    }
  }
  // A signal shutdown WAITS for the children to actually die before exiting.
  // `cleanup()`'s reap only sends SIGTERM; killTree then schedules a SIGKILL
  // escalation on a timer, and `process.exit(0)` would kill that timer with the
  // process — so a child ignoring SIGTERM used to outlive the server. The wait is
  // bounded (SHUTDOWN_WAIT_MS) so a hung child can never block the exit, and it
  // never throws.
  const gracefulExit = async (): Promise<void> => {
    try {
      const { signalled, exited } = await shutdownLiveSubprocesses()
      if (signalled > 0) {
        log.info({ signalled, exited }, 'Terminated running runtime subprocesses on shutdown')
      }
    } catch (err) {
      log.warn({ err }, 'Failed to terminate runtime subprocesses on shutdown (non-fatal)')
    }
    cleanup()
  }
  process.once('SIGINT', () => {
    void gracefulExit().finally(() => process.exit(0))
  })
  process.once('SIGTERM', () => {
    void gracefulExit().finally(() => process.exit(0))
  })
  // Last-resort synchronous path (a `process.exit` from anywhere else): it cannot
  // await, so it falls back to signalling without waiting.
  process.once('exit', cleanup)

  // Defensive graceful degradation: a background subsystem that rejects without a
  // local handler should NOT crash the whole server. Log it (redacted by the pino
  // formatter) and keep serving; the failure surfaces in the boot probe.
  process.on('unhandledRejection', (reason) => {
    log.error({ err: reason }, 'Unhandled promise rejection (server continues)')
  })
}

main().catch((err: unknown) => {
  log.error({ err }, 'Server startup failed')
  process.exitCode = 1
})
