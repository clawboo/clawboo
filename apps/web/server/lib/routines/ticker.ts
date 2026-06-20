// The Routines ticker — the rebuildable actuator over the durable
// scheduled_runs ledger. The ledger is the source of truth; this module holds
// ZERO durable state: kill the process, restart, and bootResume() reconstructs
// every active Routine from SQLite alone.
//
// Topology: ONE timer armed at min(max(minNextRunAt - now, 0), 60s), .unref()'d.
// The 60s clamp doubles as a periodic rescan that picks up rows written by
// other processes and recovers from laptop sleep; spurious wakes are harmless
// because dueness is decided in SQL (next_run_at <= now). Per fire: due-pass →
// THE atomic claim (a null claim = another ticker won = drop, never retry) →
// dispatch → record the outcome + re-arm from the cron spec.

import {
  claimScheduledRun,
  createDb,
  listQueuedRuns,
  markRunRunning,
  minNextRunAt,
  queueDueRuns,
  reconcileScheduledRuns,
  recordRunOutcome,
  type ClawbooDb,
  type DbScheduledRun,
} from '@clawboo/db'
import { isOnceSpec, nextOccurrence } from '@clawboo/scheduler'

import { getDbPath } from '../db'
import { emitEvent } from '../obs'
import { dispatchRoutine, type RoutineDispatchOutcome } from './wakeBridge'

const MAX_ARM_DELAY_MS = 60_000

interface TickerLog {
  info: (obj: object, msg: string) => void
  error: (obj: object, msg: string) => void
}

export interface RoutinesTickerDeps {
  /** Defaults to the server DB; tests inject a sandboxed one. */
  db?: ClawbooDb
  /** THE fake-clock seam. Defaults to Date.now. */
  now?: () => number
  /** THE dispatch seam. Defaults to the wake-bridge. */
  dispatch?: (run: DbScheduledRun) => Promise<RoutineDispatchOutcome>
  log: TickerLog
  /** Threaded into the wake-bridge so executor runs can attach clawboo's MCP. */
  mcpBaseUrl?: string | null
}

export interface RoutinesTicker {
  /** Heal orphaned rows (the ledger reconstructs the actuator) + arm. */
  bootResume(): void
  /** One due-pass + fire cycle. Tests drive this directly — no wall-clock. */
  tick(): Promise<{ fired: number }>
  /** Re-arm against the ledger (REST write handlers poke this). */
  requestRescan(): void
  start(): void
  stop(): void
}

export function createRoutinesTicker(deps: RoutinesTickerDeps): RoutinesTicker {
  const db = deps.db ?? createDb(getDbPath())
  const now = deps.now ?? Date.now
  const dispatch =
    deps.dispatch ??
    ((run: DbScheduledRun) => dispatchRoutine(run, { db, mcpBaseUrl: deps.mcpBaseUrl ?? null }))

  let timer: ReturnType<typeof setTimeout> | null = null
  let running = false
  let stopped = true
  let ticking = false

  const arm = (): void => {
    if (stopped) return
    if (timer) clearTimeout(timer)
    const next = minNextRunAt(db)
    const nowMs = now()
    const delay =
      next == null ? MAX_ARM_DELAY_MS : Math.min(Math.max(next - nowMs, 0), MAX_ARM_DELAY_MS)
    timer = setTimeout(() => {
      void tick()
    }, delay)
    timer.unref()
  }

  // Dispatch one claimed fire and record its outcome. Runs CONCURRENTLY with the
  // other due fires this tick (a slow connected/OpenClaw fire — bounded only by
  // its 10-min watchdog — must not head-of-line-block the others nor defer the
  // next arm()). Same-identity overlap is prevented one layer down by the
  // per-home dispatch mutex in the executor runner; cross-identity fires are
  // independent.
  const dispatchAndRecord = async (claimed: DbScheduledRun): Promise<void> => {
    let outcome: RoutineDispatchOutcome
    try {
      outcome = await dispatch(claimed)
    } catch (err) {
      outcome = { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
    const completedAt = now()
    let nextAt: number | null = null
    if (outcome.ok) {
      try {
        nextAt = nextOccurrence(claimed.cronSpec, completedAt)
      } catch {
        nextAt = null
      }
    }
    recordRunOutcome(
      db,
      claimed.id,
      outcome.ok ? { ok: true } : { ok: false, error: outcome.error ?? 'dispatch failed' },
      nextAt,
      completedAt,
    )
    if (outcome.ok) {
      emitEvent(db, {
        kind: 'routine_completed',
        agentId: claimed.agentId,
        teamId: claimed.teamId,
        taskId: outcome.taskId ?? null,
        tenantId: claimed.tenantId,
        data: {
          scheduledRunId: claimed.id,
          taskId: outcome.taskId ?? null,
          status: 'idle',
          nextRunAt: nextAt,
        },
      })
    } else {
      emitEvent(db, {
        kind: 'routine_error',
        agentId: claimed.agentId,
        teamId: claimed.teamId,
        taskId: outcome.taskId ?? null,
        tenantId: claimed.tenantId,
        data: { scheduledRunId: claimed.id, message: outcome.error ?? 'dispatch failed' },
      })
      deps.log.error(
        { scheduledRunId: claimed.id, error: outcome.error },
        'Routines: fire failed — routine parked in error until resumed',
      )
    }
  }

  const tick = async (): Promise<{ fired: number }> => {
    // A tick re-entered while a fire is in flight would double-scan; the claim
    // makes that harmless, but serializing keeps the logs sane.
    if (ticking) return { fired: 0 }
    ticking = true
    try {
      const nowMs = now()
      queueDueRuns(db, nowMs)
      // Claim phase (sequential — preserves the atomic-claim race semantics +
      // ordered `routine_fired` logs). A lost claim = another ticker won → drop.
      const claimedRuns: DbScheduledRun[] = []
      for (const queued of listQueuedRuns(db)) {
        const claimed = claimScheduledRun(db, queued.id, nowMs)
        if (!claimed) continue
        emitEvent(db, {
          kind: 'routine_fired',
          agentId: claimed.agentId,
          teamId: claimed.teamId,
          tenantId: claimed.tenantId,
          data: {
            scheduledRunId: claimed.id,
            cronSpec: claimed.cronSpec,
            scheduledBy: claimed.scheduledBy,
          },
        })
        markRunRunning(db, claimed.id, nowMs)
        claimedRuns.push(claimed)
      }
      // Dispatch phase (concurrent — wall-clock is the slowest single fire, not
      // the sum). allSettled so one failing fire never aborts the others.
      await Promise.allSettled(claimedRuns.map((claimed) => dispatchAndRecord(claimed)))
      return { fired: claimedRuns.length }
    } finally {
      ticking = false
      arm()
    }
  }

  return {
    bootResume(): void {
      try {
        const healed = reconcileScheduledRuns(db, now(), (spec, fromMs) => {
          // A once@ orphaned mid-dispatch is NEVER re-armed: its outcome is
          // unknown, and re-firing risks double-materializing a one-shot.
          if (isOnceSpec(spec)) return null
          try {
            return nextOccurrence(spec, fromMs)
          } catch {
            return null
          }
        })
        if (healed.requeued > 0 || healed.rearmed > 0 || healed.errored > 0) {
          deps.log.info(healed, 'Routines: boot-resume healed orphaned scheduled runs')
        }
      } catch (err) {
        deps.log.error({ err }, 'Routines: boot-resume reconciliation failed (non-fatal)')
      }
    },
    tick,
    requestRescan(): void {
      if (!stopped) arm()
    },
    start(): void {
      if (running) return
      running = true
      stopped = false
      arm()
    },
    stop(): void {
      stopped = true
      running = false
      if (timer) clearTimeout(timer)
      timer = null
    },
  }
}

// ─── Module singleton (boot wiring) ──────────────────────────────────────────

let singleton: RoutinesTicker | null = null

/** Boot the Routines ticker: boot-resume + an immediate due-pass + arm.
 *  Idempotent; `.unref()`'d timers never hold the process open. */
export function startRoutinesTicker(opts: { log: TickerLog; mcpBaseUrl: string | null }): void {
  if (singleton) return
  const ticker = createRoutinesTicker({ log: opts.log, mcpBaseUrl: opts.mcpBaseUrl })
  singleton = ticker
  ticker.bootResume()
  ticker.start()
  void ticker.tick()

  const stop = (): void => {
    ticker.stop()
    singleton = null
  }
  process.once('SIGTERM', stop)
  process.once('SIGINT', stop)
}

export function getRoutinesTicker(): RoutinesTicker | null {
  return singleton
}
