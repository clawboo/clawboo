// ─── Routines repository (data-access layer) ────────────────────────────────
// The ONLY place that reads/writes scheduled_runs — the durable team-task
// schedule ledger (the external wake for every runtime class). Reuses the
// board's contention recipe (withWriteRetry / immediateWrite) verbatim; never
// a second strategy. Refusals are returned as DATA (the board's "a 0-row claim
// is data, not an exception" idiom) — typed errors are minted at the server
// layer. The ledger stays cron-math-free: callers precompute `nextRunAt`.

import { randomUUID } from 'node:crypto'

import { and, asc, desc, eq, inArray, isNotNull, lte } from 'drizzle-orm'

import type { ClawbooDb } from '../db'
import { scheduledRuns, tasks, type DbScheduledRun, type DbTask } from '../schema'
import { immediateWrite, withWriteRetry } from '../board/contention'
import { canRoutineTransition, type ScheduledRunStatus } from './state-machine'

export interface RoutineScope {
  tenantId?: string | null
}

// ─── Registration (+ the one-TEAM-TASK-firing-owner de-dup guard) ───────────

export interface RegisterScheduledRunInput {
  agentId: string
  teamId?: string | null
  /** A croner cron expression or 'once@<iso>'. Validated by the caller. */
  cronSpec: string
  /** TaskTemplate JSON string. Validated by the caller. */
  taskTemplate: string
  /**
   * Bind to an EXISTING team task — the ownership-guard site. When set, the
   * task's `scheduledBy` must be 'manual' or already this owner; it is stamped
   * with the owner on success.
   */
  teamTaskId?: string | null
  /** The firing owner of record. Default 'clawboo' (this engine). */
  scheduledBy?: string
  /** Precomputed first fire time (nextOccurrence at the caller). */
  nextRunAt: number | null
  tenantId?: string | null
}

export type RegisterScheduledRunResult =
  | { ok: true; run: DbScheduledRun }
  | { ok: false; reason: 'ownership_conflict'; existingOwner: string }
  | { ok: false; reason: 'task_not_found' }

/**
 * Register a Routine. DOMAIN-SCOPED de-dup guard: only the team-task domain
 * (the board's `tasks.scheduledBy`) is inspected — a runtime's own-life cron
 * is a different domain and is never read here. Runs inside BEGIN IMMEDIATE so
 * two concurrent registrations against the same task serialize.
 */
export function registerScheduledRun(
  db: ClawbooDb,
  input: RegisterScheduledRunInput,
): RegisterScheduledRunResult {
  const now = Date.now()
  const owner = input.scheduledBy ?? 'clawboo'
  return immediateWrite(db, (tx) => {
    if (input.teamTaskId) {
      const task = tx.select().from(tasks).where(eq(tasks.id, input.teamTaskId)).get() as
        | DbTask
        | undefined
      if (!task) return { ok: false as const, reason: 'task_not_found' as const }
      if (task.scheduledBy !== 'manual' && task.scheduledBy !== owner) {
        return {
          ok: false as const,
          reason: 'ownership_conflict' as const,
          existingOwner: task.scheduledBy,
        }
      }
      tx.update(tasks)
        .set({ scheduledBy: owner, updatedAt: now })
        .where(eq(tasks.id, input.teamTaskId))
        .run()
    }
    const row: DbScheduledRun = {
      id: randomUUID(),
      agentId: input.agentId,
      teamId: input.teamId ?? null,
      cronSpec: input.cronSpec,
      taskTemplate: input.taskTemplate,
      status: 'idle',
      lastRunAt: null,
      nextRunAt: input.nextRunAt,
      scheduledBy: owner,
      lastError: null,
      tenantId: input.tenantId ?? null,
      createdAt: now,
      updatedAt: now,
    }
    tx.insert(scheduledRuns).values(row).run()
    return { ok: true as const, run: row }
  })
}

// ─── Reads ───────────────────────────────────────────────────────────────────

export function getScheduledRun(db: ClawbooDb, id: string): DbScheduledRun | null {
  return (
    (db.select().from(scheduledRuns).where(eq(scheduledRuns.id, id)).get() as
      | DbScheduledRun
      | undefined) ?? null
  )
}

export interface ListScheduledRunsFilter extends RoutineScope {
  agentId?: string
  teamId?: string
}

export function listScheduledRuns(
  db: ClawbooDb,
  filter: ListScheduledRunsFilter = {},
): DbScheduledRun[] {
  const conds = []
  if (filter.agentId) conds.push(eq(scheduledRuns.agentId, filter.agentId))
  if (filter.teamId) conds.push(eq(scheduledRuns.teamId, filter.teamId))
  if (filter.tenantId) conds.push(eq(scheduledRuns.tenantId, filter.tenantId))
  return db
    .select()
    .from(scheduledRuns)
    .where(conds.length ? and(...conds) : undefined)
    .orderBy(desc(scheduledRuns.updatedAt))
    .all() as DbScheduledRun[]
}

/** MIN(next_run_at) over auto-fireable rows — the ticker's arm key. */
export function minNextRunAt(db: ClawbooDb): number | null {
  const row = db
    .select({ nextRunAt: scheduledRuns.nextRunAt })
    .from(scheduledRuns)
    .where(and(eq(scheduledRuns.status, 'idle'), isNotNull(scheduledRuns.nextRunAt)))
    .orderBy(asc(scheduledRuns.nextRunAt))
    .limit(1)
    .get() as { nextRunAt: number | null } | undefined
  return row?.nextRunAt ?? null
}

// ─── The fire path: due-pass → atomic claim → running → outcome ─────────────

/** idle → queued for every row whose next_run_at has arrived. Paused rows are
 *  excluded by the status guard — paused NEVER auto-fires. */
export function queueDueRuns(db: ClawbooDb, now: number): DbScheduledRun[] {
  return withWriteRetry(
    () =>
      db
        .update(scheduledRuns)
        .set({ status: 'queued', updatedAt: now })
        .where(
          and(
            eq(scheduledRuns.status, 'idle'),
            isNotNull(scheduledRuns.nextRunAt),
            lte(scheduledRuns.nextRunAt, now),
          ),
        )
        .returning()
        .all() as DbScheduledRun[],
  )
}

export function listQueuedRuns(db: ClawbooDb): DbScheduledRun[] {
  return db
    .select()
    .from(scheduledRuns)
    .where(eq(scheduledRuns.status, 'queued'))
    .orderBy(asc(scheduledRuns.nextRunAt))
    .all() as DbScheduledRun[]
}

/**
 * THE atomic claim: `UPDATE … WHERE status='queued' RETURNING`. A null return
 * means another ticker already claimed the row — that is DATA (drop it, never
 * retry; the "never retry a 409" rule). Transient lock errors ARE retried inside.
 */
export function claimScheduledRun(
  db: ClawbooDb,
  id: string,
  now = Date.now(),
): DbScheduledRun | null {
  return withWriteRetry(() => {
    const rows = db
      .update(scheduledRuns)
      .set({ status: 'claimed', updatedAt: now })
      .where(and(eq(scheduledRuns.id, id), eq(scheduledRuns.status, 'queued')))
      .returning()
      .all() as DbScheduledRun[]
    return rows[0] ?? null
  })
}

/** claimed → running (dispatch in flight). SQL-guarded; false = wrong state. */
export function markRunRunning(db: ClawbooDb, id: string, now = Date.now()): boolean {
  return withWriteRetry(() => {
    const rows = db
      .update(scheduledRuns)
      .set({ status: 'running', updatedAt: now })
      .where(and(eq(scheduledRuns.id, id), eq(scheduledRuns.status, 'claimed')))
      .returning()
      .all() as DbScheduledRun[]
    return rows.length > 0
  })
}

export type RunOutcome = { ok: true } | { ok: false; error: string }

/**
 * Record a fire's outcome. Success: → idle, lastRunAt stamped, re-armed at
 * `nextRunAt` (null for a spent once@ — self-disabled). Failure: → error,
 * disarmed (next_run_at NULL) until a human resumes — no silent retry-burn.
 */
export function recordRunOutcome(
  db: ClawbooDb,
  id: string,
  outcome: RunOutcome,
  nextRunAt: number | null,
  now = Date.now(),
): void {
  withWriteRetry(() =>
    db
      .update(scheduledRuns)
      .set(
        outcome.ok
          ? { status: 'idle', lastRunAt: now, lastError: null, nextRunAt, updatedAt: now }
          : {
              status: 'error',
              lastRunAt: now,
              lastError: outcome.error,
              nextRunAt: null,
              updatedAt: now,
            },
      )
      .where(eq(scheduledRuns.id, id))
      .run(),
  )
}

// ─── User-driven transitions (pause / resume / force-fire) ──────────────────

export type SetStatusResult =
  | { ok: true; run: DbScheduledRun }
  | { ok: false; reason: 'not_found' | 'illegal_transition' }

/** pause / resume with the state machine enforced inside BEGIN IMMEDIATE. */
export function setScheduledRunStatus(
  db: ClawbooDb,
  id: string,
  to: 'paused' | 'idle',
  opts: { nextRunAt?: number | null } = {},
): SetStatusResult {
  const now = Date.now()
  return immediateWrite(db, (tx) => {
    const row = tx.select().from(scheduledRuns).where(eq(scheduledRuns.id, id)).get() as
      | DbScheduledRun
      | undefined
    if (!row) return { ok: false as const, reason: 'not_found' as const }
    if (!canRoutineTransition(row.status as ScheduledRunStatus, to)) {
      return { ok: false as const, reason: 'illegal_transition' as const }
    }
    const updated = tx
      .update(scheduledRuns)
      .set({
        status: to,
        updatedAt: now,
        ...(opts.nextRunAt !== undefined ? { nextRunAt: opts.nextRunAt } : {}),
        ...(to === 'idle' ? { lastError: null } : {}),
      })
      .where(eq(scheduledRuns.id, id))
      .returning()
      .all() as DbScheduledRun[]
    return { ok: true as const, run: updated[0]! }
  })
}

/** Force-fire now: idle → queued immediately (the `run` write action). */
export function queueRunNow(db: ClawbooDb, id: string, now = Date.now()): boolean {
  return withWriteRetry(() => {
    const rows = db
      .update(scheduledRuns)
      .set({ status: 'queued', updatedAt: now })
      .where(and(eq(scheduledRuns.id, id), eq(scheduledRuns.status, 'idle')))
      .returning()
      .all() as DbScheduledRun[]
    return rows.length > 0
  })
}

export interface UpdateScheduledRunPatch {
  cronSpec?: string
  taskTemplate?: string
  /** Recomputed by the caller when cronSpec changes. */
  nextRunAt?: number | null
}

export function updateScheduledRun(
  db: ClawbooDb,
  id: string,
  patch: UpdateScheduledRunPatch,
): DbScheduledRun | null {
  const now = Date.now()
  return withWriteRetry(() => {
    const rows = db
      .update(scheduledRuns)
      .set({
        ...(patch.cronSpec !== undefined ? { cronSpec: patch.cronSpec } : {}),
        ...(patch.taskTemplate !== undefined ? { taskTemplate: patch.taskTemplate } : {}),
        ...(patch.nextRunAt !== undefined ? { nextRunAt: patch.nextRunAt } : {}),
        updatedAt: now,
      })
      .where(eq(scheduledRuns.id, id))
      .returning()
      .all() as DbScheduledRun[]
    return rows[0] ?? null
  })
}

export function deleteScheduledRun(db: ClawbooDb, id: string): void {
  withWriteRetry(() => db.delete(scheduledRuns).where(eq(scheduledRuns.id, id)).run())
}

// ─── Boot-resume healing ─────────────────────────────────────────────────────

/**
 * Heal rows orphaned by a crashed/restarted server (the ledger is the source
 * of truth; the ticker is a rebuildable actuator). One BEGIN IMMEDIATE pass:
 * - queued / claimed orphans (the fire never started): reset to `queued` —
 *   they were due; fire now. The atomic claim + the board task claim dedupe.
 * - running orphans (dispatch possibly half-done; the board side is healed by
 *   the existing board `reconcileOrphans`): recurring → `idle` + re-armed via
 *   `rearm(cronSpec, now)`; a once@ → `error` (never risk double-materializing
 *   a one-shot).
 * - idle rows: untouched (a past-due next_run_at fires on the next due-pass).
 */
export function reconcileScheduledRuns(
  db: ClawbooDb,
  now: number,
  rearm: (cronSpec: string, fromMs: number) => number | null,
): { requeued: number; rearmed: number; errored: number } {
  return immediateWrite(db, (tx) => {
    const requeued = tx
      .update(scheduledRuns)
      .set({ status: 'queued', updatedAt: now })
      .where(inArray(scheduledRuns.status, ['claimed']))
      .returning()
      .all() as DbScheduledRun[]

    const running = tx
      .select()
      .from(scheduledRuns)
      .where(eq(scheduledRuns.status, 'running'))
      .all() as DbScheduledRun[]
    let rearmed = 0
    let errored = 0
    for (const row of running) {
      let nextRunAt: number | null = null
      try {
        nextRunAt = rearm(row.cronSpec, now)
      } catch {
        nextRunAt = null
      }
      if (nextRunAt != null) {
        tx.update(scheduledRuns)
          .set({
            status: 'idle',
            nextRunAt,
            lastError: 'orphaned mid-dispatch (restart)',
            updatedAt: now,
          })
          .where(eq(scheduledRuns.id, row.id))
          .run()
        rearmed += 1
      } else {
        tx.update(scheduledRuns)
          .set({
            status: 'error',
            nextRunAt: null,
            lastError: 'orphaned mid-dispatch (restart)',
            updatedAt: now,
          })
          .where(eq(scheduledRuns.id, row.id))
          .run()
        errored += 1
      }
    }
    return { requeued: requeued.length, rearmed, errored }
  })
}
