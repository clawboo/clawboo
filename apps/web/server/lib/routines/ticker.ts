// The Routines ticker — the rebuildable actuator over the durable
// scheduled_runs ledger. The ledger is the source of truth; this module holds
// ZERO durable state: kill the process, restart, and bootResume() reconstructs
// every active Routine from SQLite alone.
//
// Topology: ONE timer armed at min(max(minNextRunAt - now, 0), 60s), .unref()'d,
// or at once while a row is already queued (a Run now). The 60s clamp doubles as
// a periodic rescan that picks up rows written by other processes and recovers
// from laptop sleep; spurious wakes are harmless because dueness is decided in
// SQL (next_run_at <= now). Per fire: due-pass → THE atomic claim (a null claim
// = another ticker won = drop, never retry) → dispatch → record the outcome +
// re-arm from the cron spec. Only the claim pass is serialized: a dispatch still
// in flight never holds up the next due routine.
//
// A HELD ENGINE (see engineHold) claims nothing: due routines stay in the ledger,
// queued or idle, and the timer only rescans. When the hold lifts the ticker
// rescans at once and fires what came due meanwhile.
//
// CATCH-UP. A routine whose time passed while this process was not running (a
// stopped or sleeping computer, a restart) is `idle` with a `next_run_at` in the
// past. The first due-pass queues it and it fires ONCE; its next run is then
// worked out from when that fire finished, so the slots it missed are skipped,
// never replayed. The same holds for a process that was suspended with the
// computer: its timer fires on wake (at most MAX_ARM_DELAY_MS late) and the
// due-pass finds the row due. A due OpenClaw routine waits for the Gateway
// connection rather than failing on it (see gatewayWait).

import {
  claimScheduledRun,
  countScheduledRunsInFlight,
  getSetting,
  listArmedRuns,
  listQueuedRuns,
  markRunRunning,
  minNextRunAt,
  queueDueRuns,
  reconcileScheduledRuns,
  recordRunOutcome,
  requeuePausedFire,
  setSetting,
  type ClawbooDb,
  type DbScheduledRun,
} from '@clawboo/db'
import { isOnceSpec, nextOccurrence } from '@clawboo/scheduler'

import { getRegistry } from '../agentSource'
import { getDb } from '../db'
import { engineHold } from '../engineHold'
import { emitEvent } from '../obs'
import { onPauseLifted } from '../pauseBus'
import { GATEWAY_WAIT_MS, routineNeedsGateway, type GatewayState } from './gatewayWait'
import { routineTimeZone } from './timeZone'
import { dispatchRoutine, routineStartRefusal, type RoutineDispatchOutcome } from './wakeBridge'

const MAX_ARM_DELAY_MS = 60_000

interface TickerLog {
  info: (obj: object, msg: string) => void
  warn: (obj: object, msg: string) => void
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
  /** True while the engine is held. Defaults to the process's engine hold. */
  held?: () => boolean
  /** The OpenClaw Gateway connection a due OpenClaw routine waits for (see
   *  gatewayWait). Unset, nothing waits: the boot wiring passes the server's own. */
  gateway?: GatewayState
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
  const db = deps.db ?? getDb()
  const now = deps.now ?? Date.now
  const dispatch =
    deps.dispatch ??
    ((run: DbScheduledRun) => dispatchRoutine(run, { db, mcpBaseUrl: deps.mcpBaseUrl ?? null }))
  const held = deps.held ?? ((): boolean => engineHold().isHeld())
  const gateway = deps.gateway
  // When each queued fire was first found due and waiting for the Gateway (see
  // gatewayWait). Kept in the settings table too, so a restart continues a wait
  // rather than granting a fresh one: otherwise a host that stops an engine while
  // a fire waits and starts it again for that fire would do so forever, and the
  // fire would neither run nor fail.
  const waitingSince = readGatewayWaits(db)
  let waitsWritten = JSON.stringify(Object.fromEntries(waitingSince))
  const saveGatewayWaits = (): void => {
    const next = JSON.stringify(Object.fromEntries(waitingSince))
    if (next === waitsWritten) return
    try {
      setSetting(db, GATEWAY_WAITS_KEY, next)
      waitsWritten = next
    } catch (err) {
      deps.log.warn({ err }, 'Routines: could not save Gateway waits (they restart on a restart)')
    }
  }
  // The queued rows a claim may take now, and when the first Gateway wait ends.
  // A queued row a pause holds back stays queued, and counts for neither the claim
  // nor the timer: it would spin the timer at a delay of 0. The pause's lift
  // rescans. So does one waiting for the Gateway: the connection rescans, and the
  // timer is armed for the moment its wait runs out.
  const scanQueued = (): { claimable: DbScheduledRun[]; waitEndsAt: number | null } => {
    const nowMs = now()
    const claimable: DbScheduledRun[] = []
    const seen = new Set<string>()
    let waitEndsAt: number | null = null
    for (const run of listQueuedRuns(db)) {
      if (routineStartRefusal(db, run) !== null) continue
      if (gateway && routineNeedsGateway(db, run, gateway)) {
        seen.add(run.id)
        let since = waitingSince.get(run.id)
        if (since === undefined) {
          since = nowMs
          waitingSince.set(run.id, since)
          deps.log.info(
            { scheduledRunId: run.id },
            'Routines: a due OpenClaw routine waits for the Gateway to connect',
          )
        }
        const endsAt = since + GATEWAY_WAIT_MS
        if (nowMs < endsAt) {
          if (waitEndsAt === null || endsAt < waitEndsAt) waitEndsAt = endsAt
          continue
        }
      }
      claimable.push(run)
    }
    // A fire that no longer waits (claimed, connected, gone) starts afresh next time.
    for (const id of waitingSince.keys()) if (!seen.has(id)) waitingSince.delete(id)
    saveGatewayWaits()
    return { claimable, waitEndsAt }
  }
  const claimableRuns = (): DbScheduledRun[] => scanQueued().claimable

  let timer: ReturnType<typeof setTimeout> | null = null
  let running = false
  let stopped = true
  let claiming = false

  const arm = (): void => {
    if (stopped) return
    if (timer) clearTimeout(timer)
    const next = minNextRunAt(db)
    const nowMs = now()
    // A queued row (Run now, or a fire a restart re-queued) is due this instant.
    // minNextRunAt only sees idle rows, so without this a Run now waited out the
    // whole rescan interval. Held, nothing is due: the hold's lift rescans.
    const queued = held() ? null : scanQueued()
    const nextAt =
      queued?.waitEndsAt == null
        ? next
        : next == null
          ? queued.waitEndsAt
          : Math.min(next, queued.waitEndsAt)
    const delay =
      queued === null
        ? MAX_ARM_DELAY_MS
        : queued.claimable.length > 0
          ? 0
          : nextAt == null
            ? MAX_ARM_DELAY_MS
            : Math.min(Math.max(nextAt - nowMs, 0), MAX_ARM_DELAY_MS)
    timer = setTimeout(() => {
      void tick()
    }, delay)
    timer.unref()
  }

  // Dispatch one claimed fire and record its outcome. Runs CONCURRENTLY with the
  // other due fires (a slow fire must not head-of-line-block the others nor defer
  // the next arm()). Same-identity overlap is prevented one layer down: the
  // per-home dispatch mutex in the executor runner, the per-agent connected mutex
  // for OpenClaw, and the team chat's delivery queue for a team routine;
  // cross-identity fires are independent.
  const dispatchAndRecord = async (claimed: DbScheduledRun): Promise<void> => {
    let outcome: RoutineDispatchOutcome
    try {
      outcome = await dispatch(claimed)
    } catch (err) {
      outcome = { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
    const completedAt = now()
    // A pause stopped or refused it: it did not happen. Not a run, not a failure, and
    // a one-time routine is not spent. It waits for the resume.
    if (outcome.paused) {
      if (requeuePausedFire(db, claimed.id, completedAt)) {
        emitEvent(db, {
          kind: 'routine_paused',
          agentId: claimed.agentId || null,
          teamId: claimed.teamId,
          taskId: outcome.taskId ?? null,
          tenantId: claimed.tenantId,
          data: {
            scheduledRunId: claimed.id,
            taskId: outcome.taskId ?? null,
            message: outcome.error ?? 'A pause stopped it.',
          },
        })
      }
      arm()
      return
    }
    let nextAt: number | null = null
    // A failure that may pass keeps the schedule, so it needs the next time too.
    // Not for a one-time routine: "Run now" can fire one before its time, and
    // its only time is then still ahead, but any failure stops it.
    if (outcome.ok || (outcome.transient && !isOnceSpec(claimed.cronSpec))) {
      try {
        nextAt = nextOccurrence(claimed.cronSpec, completedAt, routineTimeZone(db))
      } catch {
        nextAt = null
      }
    }
    const landed = recordRunOutcome(
      db,
      claimed.id,
      outcome.ok
        ? { ok: true }
        : {
            ok: false,
            error: outcome.error ?? 'dispatch failed',
            transient: outcome.transient === true,
          },
      nextAt,
      completedAt,
      claimed.cronSpec,
    )
    if (outcome.ok) {
      emitEvent(db, {
        kind: 'routine_completed',
        agentId: claimed.agentId || null,
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
      // `landed` is null when the row had moved on while the fire was in flight
      // (another process healed it, or it was deleted): its state was kept.
      const stopped = landed === 'error'
      emitEvent(db, {
        kind: 'routine_error',
        agentId: claimed.agentId || null,
        teamId: claimed.teamId,
        taskId: outcome.taskId ?? null,
        tenantId: claimed.tenantId,
        data: {
          scheduledRunId: claimed.id,
          message: outcome.error ?? 'dispatch failed',
          ...(outcome.errorClass ? { errorClass: outcome.errorClass } : {}),
          ...(landed ? { stopped } : {}),
        },
      })
      if (!landed) {
        deps.log.warn(
          { scheduledRunId: claimed.id, error: outcome.error, errorClass: outcome.errorClass },
          'Routines: fire failed after the routine had moved on, so its state was kept',
        )
      } else if (stopped) {
        deps.log.error(
          { scheduledRunId: claimed.id, error: outcome.error, errorClass: outcome.errorClass },
          'Routines: fire failed, so the routine is parked in error until resumed',
        )
      } else {
        deps.log.warn(
          { scheduledRunId: claimed.id, error: outcome.error, errorClass: outcome.errorClass },
          'Routines: fire failed, and the failure may pass, so the routine stays scheduled',
        )
      }
    }
    // The outcome set this routine's next run, which may be sooner than the
    // timer armed while it was in flight.
    arm()
  }

  const tick = async (): Promise<{ fired: number }> => {
    // Claims are serialized: a claim pass re-entered mid-pass would double-scan.
    // The atomic claim makes that harmless, but one pass at a time keeps the
    // `routine_fired` log in order.
    if (claiming) return { fired: 0 }
    // Held: claim nothing. A due row stays as it is in the ledger and fires once
    // the hold lifts, so a stop or an update never starts a routine it would kill.
    if (held()) {
      arm()
      return { fired: 0 }
    }
    claiming = true
    const claimedRuns: DbScheduledRun[] = []
    try {
      const nowMs = now()
      queueDueRuns(db, nowMs)
      // Claim phase (sequential — preserves the atomic-claim race semantics +
      // ordered `routine_fired` logs). A lost claim = another ticker won → drop.
      for (const queued of claimableRuns()) {
        const claimed = claimScheduledRun(db, queued.id, nowMs)
        if (!claimed) continue
        emitEvent(db, {
          kind: 'routine_fired',
          agentId: claimed.agentId || null,
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
    } finally {
      claiming = false
      // Re-arm BEFORE dispatching. A dispatch can run for minutes (an agent
      // routine is a whole task run), and the next due routine must not wait for
      // it. Each fire's row stays `running` until its outcome lands, so no pass
      // can claim it twice.
      arm()
    }
    // Dispatch phase, concurrent: the wall-clock is the slowest single fire, not
    // the sum. allSettled so one failing fire never aborts the others. Each fire
    // records its own outcome and re-arms as it lands.
    await Promise.allSettled(claimedRuns.map((claimed) => dispatchAndRecord(claimed)))
    return { fired: claimedRuns.length }
  }

  return {
    bootResume(): void {
      try {
        const zone = routineTimeZone(db)
        const healed = reconcileScheduledRuns(db, now(), (spec, fromMs) => {
          // A once@ orphaned mid-dispatch is NEVER re-armed: its outcome is
          // unknown, and re-firing risks double-materializing a one-shot.
          if (isOnceSpec(spec)) return null
          try {
            return nextOccurrence(spec, fromMs, zone)
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
  const ticker = createRoutinesTicker({
    log: opts.log,
    mcpBaseUrl: opts.mcpBaseUrl,
    gateway: serverGateway(),
  })
  singleton = ticker
  ticker.bootResume()
  ticker.start()
  void ticker.tick()
  const stopFollowingHold = engineHold().onResume(() => ticker.requestRescan())
  const stopFollowingPauses = onPauseLifted(() => ticker.requestRescan())
  // A due OpenClaw routine waits for the Gateway; it fires as soon as it connects.
  const stopFollowingGateway = getRegistry().source.onConnectionChange((connection) => {
    if (connection === 'connected') ticker.requestRescan()
  })

  const stop = (): void => {
    stopFollowingHold()
    stopFollowingPauses()
    stopFollowingGateway()
    ticker.stop()
    singleton = null
  }
  process.once('SIGTERM', stop)
  process.once('SIGINT', stop)
}

export function getRoutinesTicker(): RoutinesTicker | null {
  return singleton
}

/** Where the ticker keeps when each fire started waiting for the Gateway. */
export const GATEWAY_WAITS_KEY = 'routines.gatewayWaitsSince'

function readGatewayWaits(db: ClawbooDb): Map<string, number> {
  const waits = new Map<string, number>()
  try {
    const parsed: unknown = JSON.parse(getSetting(db, GATEWAY_WAITS_KEY) ?? '{}')
    if (parsed && typeof parsed === 'object') {
      for (const [id, since] of Object.entries(parsed as Record<string, unknown>)) {
        if (typeof since === 'number' && Number.isFinite(since)) waits.set(id, since)
      }
    }
  } catch {
    // An unreadable record only means the waits start again.
  }
  return waits
}

/** The server's own Gateway connection, as a due OpenClaw routine waits on it. */
export function serverGateway(): GatewayState {
  return {
    configured: () => getRegistry().source.isConfigured(),
    connected: () => getRegistry().source.isConnected(),
  }
}

// ─── When the next routine is due ────────────────────────────────────────────

export interface RoutinesDue {
  /**
   * The earliest time a routine is due, epoch ms. A routine already due (its time
   * passed while nothing fired it, or a Run now) reads as its due time or `nowMs`,
   * whichever is earlier: at or before now means due now. Null when no routine
   * has a next run.
   */
  at: number | null
  /** Routines with a next run that may start: armed, or due and not yet fired. */
  count: number
  /** Fires under way: waiting for the Gateway, claimed, or dispatched and not finished. */
  inFlight: number
}

/**
 * When the next routine is due, read with the ticker's own rules, so it never
 * names a time the ticker would not fire at. Counted: an idle routine with a next
 * run, and a queued one (due now). Left out: a paused routine, one parked after a
 * failure, a spent one-time routine, one on an archived team, and one a pause holds
 * back (it fires when a person lifts the pause). A routine waiting for the Gateway
 * counts as due now, and as a fire under way when `gateway` is given. An engine
 * hold is not read: it lives in memory, and the
 * process a host stops and starts again holds nothing.
 */
export function routinesDue(
  db: ClawbooDb,
  nowMs: number,
  gateway: GatewayState | null = null,
): RoutinesDue {
  let at: number | null = null
  let count = 0
  let waiting = 0
  const consider = (time: number): void => {
    count += 1
    if (at === null || time < at) at = time
  }
  for (const run of listQueuedRuns(db)) {
    if (routineStartRefusal(db, run) !== null) continue
    consider(Math.min(run.nextRunAt ?? nowMs, nowMs))
    // Waiting for the Gateway: it has begun, and runs or fails within the wait.
    if (gateway && routineNeedsGateway(db, run, gateway)) waiting += 1
  }
  for (const run of listArmedRuns(db)) {
    if (run.nextRunAt == null || routineStartRefusal(db, run) !== null) continue
    consider(run.nextRunAt)
  }
  return { at, count, inFlight: countScheduledRunsInFlight(db) + waiting }
}
