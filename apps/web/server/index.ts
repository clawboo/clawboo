import http from 'node:http'
import path from 'node:path'

import express from 'express'
import cors from 'cors'

import { createAccessGate, createGatewayProxy } from '@clawboo/gateway-proxy'
import { loadSettings } from '@clawboo/config'
import { createLogger } from '@clawboo/logger'
import { createDb, reconcileOrphans, reconcileStaleInProgress, seedBuiltinTools } from '@clawboo/db'

import { apiRouter } from './api/index'
import { attachIdentity } from './lib/auth'
import { getDbPath } from './lib/db'
import { gcTaskWorkspaces } from './lib/worktrees'
import { startMcpSupervisor } from './lib/mcpSupervisor'
import { startApprovalReaper } from './lib/approvalReaper'
import { ensureNativeBooZero } from './lib/teamChat/booZero'
import { startRoutinesTicker } from './lib/routines/ticker'
import { getRegistry } from './lib/agentSource'
import { resolveApiPort, writeApiPortFile, removeApiPortFile } from './lib/portUtils'
import { resolveHost, isLoopbackHost } from './lib/resolveHost'
import { runBootProbe } from './lib/bootProbe'

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

// ── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  const dev = process.argv.includes('--dev')
  const hostname = resolveHost()

  // Pick the API port up front. In dev mode the orchestrator script picks
  // a port first and exports it as `CLAWBOO_API_PORT` so the Vite proxy
  // and this server agree without a race. In production / CLI / standalone
  // boots we scan for a free port starting at DEFAULT_API_PORT (18790).
  const port = await resolveApiPort({ dev })

  log.info({ dev, hostname, port }, 'Starting Clawboo server')

  // ── Access gate ───────────────────────────────────────────────────────────

  const accessGate = createAccessGate({
    token: process.env['STUDIO_ACCESS_TOKEN'],
  })

  // Defense in depth: a non-loopback bind WITHOUT an access token exposes the
  // dashboard — and every /api/* route — to the local network unauthenticated.
  // We don't auto-generate a token; just warn loudly so the operator opts in.
  if (!isLoopbackHost(hostname) && !accessGate.enabled) {
    log.warn(
      { hostname, port },
      'SECURITY: dashboard bound to a non-loopback interface with NO access token — ' +
        'it is reachable by anyone on your network without authentication. Set ' +
        'STUDIO_ACCESS_TOKEN to require a token, or unset HOST/HOSTNAME to bind loopback only.',
    )
  }

  // ── Gateway proxy ─────────────────────────────────────────────────────────

  const proxy = createGatewayProxy({
    loadUpstreamSettings: async () => {
      const settings = loadSettings(process.env)
      return { url: settings.gatewayUrl, token: settings.gatewayToken }
    },
    allowWs: (req) => {
      if (resolvePathname(req.url) !== '/api/gateway/ws') return false
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

  // CORS: only needed in dev (Vite on :5173 → Express on the dynamic API port)
  if (dev) {
    app.use(cors({ origin: true, credentials: true }))
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
      // Skip high-frequency static asset requests
      if (url.startsWith('/assets/') || url.startsWith('/fonts/')) return
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
    const uiDir = path.resolve(process.env['CLAWBOO_UI_DIR'] || path.join(__dirname, 'ui'))
    app.use(express.static(uiDir))
    // SPA catch-all: any unmatched GET serves index.html so client-side
    // routing works. We use `app.use(handler)` rather than a wildcard pattern
    // (`'/*splat'` / `'/{*splat}'`) — Express 5 + path-to-regexp v8 have
    // subtle matching quirks around the bare `/` path that produced
    // "Cannot GET /". `app.use` with no path matches every
    // request by definition. Restricting to GET keeps non-GET 404s honest.
    app.use((req, res, next) => {
      if (req.method !== 'GET') return next()
      res.sendFile(path.join(uiDir, 'index.html'))
    })
  }

  // ── HTTP server (raw, for WS upgrade handling) ────────────────────────────

  const server = http.createServer(app)

  // ── WebSocket upgrade routing ─────────────────────────────────────────────

  server.on('upgrade', (req, socket, head) => {
    if (resolvePathname(req.url) === '/api/gateway/ws') {
      proxy.handleUpgrade(req, socket, head)
      return
    }
    // No other WS upgrades needed (Vite HMR runs on its own port)
    socket.destroy()
  })

  // ── Durable board: orphan reconciliation ────────────────────────────────────
  // Any execution left 'running' belonged to a process that died with a previous
  // server. Mark them failed + release their tasks so nothing is stuck. The
  // recovery tombstone makes this idempotent (no infinite auto-resume).
  // Best-effort; never blocks boot.
  try {
    const { reconciled } = reconcileOrphans(createDb(getDbPath()))
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
  safeStart('tools-registry-seed', () => seedBuiltinTools(createDb(getDbPath())))

  // ── Default-native Boo Zero ─────────────────────────────────────────────────
  // Ensure a native-first install has its runtime-neutral universal leader — a
  // teamless clawboo-native Boo Zero — so native teams get a real coordinator and the
  // graph reflects it immediately (not only after the first message). Self-gated (a
  // native team member exists + a native key is connected + none is designated); a
  // no-op for a pure-OpenClaw / no-key install. Best-effort; never blocks boot.
  safeStart('native-boo-zero', () => {
    void ensureNativeBooZero(createDb(getDbPath()), getRegistry().nativeSource).catch(
      () => undefined,
    )
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
  // Backstop for an `in_progress` task whose driving client view closed (the
  // in-browser idle watchdog only runs while the team chat is mounted). One pass
  // at boot + a generous-TTL interval so an abandoned/hung delegate doesn't sit
  // forever. TTL is intentionally long (not the client's 8-min watchdog) because
  // `tasks.updatedAt` is frozen at claim time — it is NOT a liveness signal for
  // the in-browser OpenClaw path, which has no server-side exec heartbeat (the
  // executor never writes the tasks row mid-run). So this is purely a "nobody is
  // watching" backstop: a LIVE client's 8-min watchdog (refreshed on every agent
  // event) fails a hung delegate long before this fires, and a re-mounted client's
  // `resume()` re-attaches an orphaned in_progress task and re-runs the watchdog.
  // The only client this sweep must catch is one that is gone and never returns;
  // the TTL is kept well beyond any realistic single delegate turn so a long-but-
  // active run is not falsely swept (and a rare false sweep is now handled
  // gracefully — completeForSession refuses to fake-complete a task released out
  // from under it). 60 min default; tune with CLAWBOO_BOARD_STALE_TTL_MS.
  // Best-effort, unref'd.
  safeStart('board-stale-sweep', () => {
    const ttlMs = Number(process.env['CLAWBOO_BOARD_STALE_TTL_MS']) || 60 * 60_000
    const intervalMs = Number(process.env['CLAWBOO_BOARD_STALE_SWEEP_MS']) || 5 * 60_000
    const sweep = (): void => {
      try {
        const { reconciled } = reconcileStaleInProgress(createDb(getDbPath()), ttlMs)
        if (reconciled > 0) log.info({ reconciled }, 'Board: released stale in_progress tasks')
      } catch (err) {
        log.error({ err }, 'Board: stale-task sweep failed (non-fatal)')
      }
    }
    sweep()
    setInterval(sweep, intervalMs).unref()
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
    const browserUrl = `http://${hostForBrowser}:${port}`

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
  const cleanup = () => {
    removeApiPortFile()
  }
  process.once('SIGINT', () => {
    cleanup()
    process.exit(0)
  })
  process.once('SIGTERM', () => {
    cleanup()
    process.exit(0)
  })
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
