// In-process MCP liveness supervisor. clawboo is an MCP HOST — the
// three servers run in-process over Streamable HTTP, backed by the shared SQLite
// DB — so there is no long-lived MCP child process to respawn. "Supervision" here
// is: pre-warm the servers at boot (the first attach is fast + init errors surface
// in the log), then periodically health-probe each server with an in-memory
// tools/list round-trip. On failure → rebuild the cached HTTP singleton (which
// re-resolves the embedding provider) with capped exponential backoff so a wedged
// dependency can't thrash. Best-effort, gated, idempotent, `.unref()`'d.

import { createDb, type ClawbooDb } from '@clawboo/db'
import {
  createMemoryServer,
  createTasksServer,
  createTeamChatServer,
  createToolsServer,
  MCP_SERVER_NAMES,
  probeServer,
  type McpServerName,
} from '@clawboo/mcp'

import { prewarmMcp, resetMcpHandlers } from '../api/mcp'
import { getDbPath } from './db'

interface SupervisorLog {
  info: (obj: object, msg: string) => void
  warn: (obj: object, msg: string) => void
  error: (obj: object, msg: string) => void
}

const DEFAULT_PROBE_MS = 60_000
const BACKOFF_BASE_MS = 30_000
const BACKOFF_CAP_MS = 5 * 60_000

function envMs(name: string, fallback: number): number {
  const raw = process.env[name]
  const n = raw ? Number(raw) : NaN
  return Number.isFinite(n) && n > 0 ? n : fallback
}

function buildProbeServer(db: ClawbooDb, name: McpServerName) {
  if (name === 'tasks') return createTasksServer(db)
  if (name === 'memory') return createMemoryServer(db, null) // FTS-only is fine for a liveness probe
  if (name === 'teamchat') return createTeamChatServer(db) // unbound is fine for a liveness probe
  return createToolsServer(db)
}

/** A single in-memory MCP round-trip against a fresh server (tools/list); resolves
 *  to the tool count, throws on any failure. Reuses ONE db handle across probes to
 *  avoid per-probe handle leaks. */
export async function probeMcpServer(db: ClawbooDb, name: McpServerName): Promise<number> {
  return probeServer(buildProbeServer(db, name))
}

interface ServerState {
  failures: number
  nextProbeAt: number
}

let started = false
let timer: ReturnType<typeof setInterval> | null = null

export function startMcpSupervisor(opts: { log: SupervisorLog }): void {
  if (started) return
  started = true

  // Pre-warm: build the servers + kick the embedding resolve. Init errors surface.
  try {
    prewarmMcp()
    opts.log.info({}, 'MCP supervisor: pre-warmed servers')
  } catch (err) {
    opts.log.error({ err }, 'MCP supervisor: pre-warm failed (non-fatal)')
  }

  const db = createDb(getDbPath()) // one handle, reused across probes
  // Derived from MCP_SERVER_NAMES so a new server can't be forgotten here.
  const state = Object.fromEntries(
    MCP_SERVER_NAMES.map((n) => [n, { failures: 0, nextProbeAt: 0 }]),
  ) as Record<McpServerName, ServerState>
  const probeMs = envMs('CLAWBOO_MCP_PROBE_MS', DEFAULT_PROBE_MS)

  const tick = (): void => {
    const now = Date.now()
    void Promise.all(
      MCP_SERVER_NAMES.map(async (name) => {
        const s = state[name]
        if (now < s.nextProbeAt) return // in backoff
        try {
          await probeMcpServer(db, name)
          if (s.failures > 0) opts.log.info({ server: name }, 'MCP supervisor: server recovered')
          s.failures = 0
          s.nextProbeAt = 0
        } catch (err) {
          s.failures += 1
          const backoff = Math.min(BACKOFF_CAP_MS, BACKOFF_BASE_MS * 2 ** (s.failures - 1))
          s.nextProbeAt = now + backoff
          opts.log.warn(
            { server: name, failures: s.failures, backoffMs: backoff, err },
            'MCP supervisor: probe failed — rebuilding',
          )
          try {
            resetMcpHandlers()
            prewarmMcp()
          } catch {
            /* best-effort rebuild */
          }
        }
      }),
    ).catch(() => {})
  }

  timer = setInterval(tick, probeMs)
  timer.unref()

  const stop = (): void => {
    if (timer) clearInterval(timer)
    timer = null
  }
  process.once('SIGTERM', stop)
  process.once('SIGINT', stop)
}
