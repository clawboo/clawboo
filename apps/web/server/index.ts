import http from 'node:http'
import path from 'node:path'

import express from 'express'
import cors from 'cors'

import { createAccessGate, createGatewayProxy, createOriginGuard } from '@clawboo/gateway-proxy'
import { loadSettings, resolveBasePath } from '@clawboo/config'
import { createLogger } from '@clawboo/logger'
import {
  listAgentsWithUndeliveredInbox,
  reapOrphanInbox,
  listTeamsWithFireableDelegations,
  reconcileOrphans,
  reconcileStaleInProgress,
  seedBuiltinTools,
} from '@clawboo/db'

import { apiRouter } from './api/index'
import { attachIdentity } from './lib/auth'
import { reapOrphanedConnectors } from './lib/connectors/pidFile'
import { killProcessTreeByPid } from './lib/runtimes/killTree'
import { closeDb, getDb } from './lib/db'
import { killLiveSubprocesses, shutdownLiveSubprocesses } from './lib/runtimes/subprocess'
import { gcTaskWorkspaces } from './lib/worktrees'
import { startMcpSupervisor } from './lib/mcpSupervisor'
import { startApprovalReaper } from './lib/approvalReaper'
import { upgradeFrozenToolsets } from './lib/runtimes/native/agentConfigStore'
import { registerBoardLifecycleSubscribers } from './lib/teamChat/boardLifecycleSubscribers'
import { ensureNativeBooZero } from './lib/teamChat/booZero'
import { getTeamOrchestrator } from './lib/teamChat/teamOrchestrator'
import { startRoutinesTicker } from './lib/routines/ticker'
import { getRegistry } from './lib/agentSource'
import {
  resolveApiPort,
  writeApiPortFile,
  removeApiPortFileIfOwned,
  waitForPortFree,
} from './lib/portUtils'
import { resolveHost, isLoopbackHost, shouldRefuseInsecureBind } from './lib/resolveHost'
import { runBootProbe } from './lib/bootProbe'
import { createBasePathMiddleware } from './lib/basePathMiddleware'
import { mountSpa } from './lib/serveSpa'
import { restoreConnectorsAtBoot } from './api/connectors'
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

  const accessGate = createAccessGate({
    token: process.env['STUDIO_ACCESS_TOKEN'],
    // Scopes the operator cookie to the mount and prefixes the post-exchange
    // redirect, so sharing an origin with another app does not share the cookie.
    basePath,
  })

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
  app.set('case sensitive routing', true)

  // The server-trusted loopback port. Request handlers that hand a callback URL to a
  // spawned runtime (the MCP attach base) read this instead of the client `Host`
  // header — a forged Host must never redirect a runtime's Tasks/Memory/Tools/TeamChat
  // traffic. Mirrors the `http://127.0.0.1:${port}` the boot/ticker callers use.
  app.locals['apiPort'] = port
  // The base-path middleware STRIPS the prefix from `req.url` before routing, so
  // a route that needs to build an absolute-on-this-origin redirect cannot
  // recover it from the request. Publishing the validated value is how a route
  // rebuilds a Location without reaching for the raw `req.originalUrl`.
  app.locals['basePath'] = basePath

  // Base-path strip, BEFORE the origin guard, and nothing may be mounted ahead
  // of it. The guards below decide what to protect with `startsWith('/api/')` and
  // fail OPEN otherwise, so they must only ever see root-form paths; stripping
  // here is what lets them keep their existing checks and cover the prefixed
  // surface too. A pass-through when no prefix is configured.
  app.use(createBasePathMiddleware(basePath))

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

  // Identity middleware — the single SaaS-readiness chokepoint. No-op pass-through
  // today (populates req.tenantId / req.userId with the single implicit tenant, both
  // null); the place a future hosted build verifies the request identity. Runs after
  // the access gate so unauthenticated requests are rejected before identity work.
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
      reqLog[level]({ method: req.method, url, status: res.statusCode, durationMs })
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
      proxy.handleUpgrade(req, socket, head)
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
    const { reconciled } = reconcileOrphans(getDb(), { staleAfterMs })
    if (reconciled > 0) {
      log.info({ reconciled }, 'Board: reconciled orphaned executions on startup')
    }
  } catch (err) {
    log.error({ err }, 'Board: orphan reconciliation failed (non-fatal)')
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

  // ── MCP liveness supervisor ─────────────────────────────────────────────────
  // Pre-warm the in-process MCP servers + health-probe them (rebuild-on-failure
  // with backoff). Best-effort, never blocks boot.
  safeStart('mcp-supervisor', () => startMcpSupervisor({ log }))

  // ── Approval-TTL reaper ─────────────────────────────────────────────────────
  // Expire abandoned pending approvals after the TTL (default 24h) + unblock any
  // linked task. One pass at boot + a singleton unref'd interval.
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
    const sweep = (): void => {
      try {
        const { reconciled } = reconcileStaleInProgress(getDb(), ttlMs)
        if (reconciled > 0) log.info({ reconciled }, 'Board: released stale in_progress tasks')
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
  safeStart('board-dispatch-pump', () => {
    const pumpMs = positiveIntEnv('CLAWBOO_DISPATCH_PUMP_MS', 60_000)
    const mcpBase = `http://127.0.0.1:${port}`
    // The bus subscribers make pushes immediate; this interval is the durable
    // BACKSTOP (and the boot-resume path: the first pass rebuilds every team
    // holding fireable work OR undelivered mail, so a restart is a pause).
    registerBoardLifecycleSubscribers({ mcpBaseUrl: mcpBase })
    const pump = (): void => {
      try {
        const db = getDb()
        const wake = new Set(listTeamsWithFireableDelegations(db))
        // Teams whose agents hold undelivered mailbox rows: waking the team
        // rebuilds its orchestrator; the rows ride the next run's digest (or,
        // for a team that stays idle, wait for the next user turn — waking is
        // about the ORCHESTRATOR being resident again after a restart).
        // Retention first: drop rows for recipients that no longer exist (and
        // stale rows past the cutoff) so the scan below never wakes a ghost.
        reapOrphanInbox(db)
        for (const a of listAgentsWithUndeliveredInbox(db)) if (a.teamId) wake.add(a.teamId)
        for (const teamId of wake) {
          getTeamOrchestrator(teamId, { mcpBaseUrl: mcpBase })
            .pump()
            .catch((err: unknown) => log.error({ err, teamId }, 'Board: dispatch pump failed'))
        }
      } catch (err) {
        log.error({ err }, 'Board: dispatch pump scan failed (non-fatal)')
      }
    }
    // First pass shortly after boot (let the registry / Boo Zero bootstrap land).
    setTimeout(pump, 10_000).unref()
    setInterval(pump, pumpMs).unref()
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

  // ── Listen ────────────────────────────────────────────────────────────────

  server.listen(port, hostname, () => {
    const hostForBrowser = hostname === '0.0.0.0' || hostname === '::' ? 'localhost' : hostname
    // Trailing slash under a mount so the shell's relative assets resolve without
    // relying on the redirect (which is there for hand-typed URLs).
    const browserUrl = `http://${hostForBrowser}:${port}${basePath ? `${basePath}/` : ''}`

    // Publish the chosen port for external tools (CLI, Vite proxy fallback,
    // e2e helpers). Best-effort: if writing fails, downstream consumers can
    // still discover the port via the CLAWBOO_API_PORT env var.
    writeApiPortFile(port)

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
    // first. Reaped BEFORE anything can connect, so the file cleared here is
    // always the previous process's.
    safeStart('connector-reap', () => {
      const report = reapOrphanedConnectors((pid) => killProcessTreeByPid(pid))
      if (report.killed > 0 || report.expired > 0) {
        log.info(report, 'Connectors: reaped children left by a previous run')
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
    safeStart('connector-restore', () => {
      void restoreConnectorsAtBoot(getDb())
        .then(async (restored) => {
          if (restored > 0) log.info({ restored }, 'Connectors: restored previous session')
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
