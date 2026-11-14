// ─── Routines repository (data-access layer) ────────────────────────────────
// The ONLY place that reads/writes scheduled_runs — the durable team-task
// schedule ledger (the external wake for every runtime class). Reuses the
// board's contention recipe (withWriteRetry / immediateWrite) verbatim; never
// a second strategy. Refusals are returned as DATA (the board's "a 0-row claim
// is data, not an exception" idiom) — typed errors are minted at the server
// layer. The ledger stays cron-math-free: callers precompute `nextRunAt`.

import { randomUUID } from 'node:crypto'

import { and, asc, desc, eq, gt, inArray, isNotNull, lte, ne, sql } from 'drizzle-orm'

import type { ClawbooDb } from '../db'
import { scheduledRuns, settings, tasks, type DbScheduledRun, type DbTask } from '../schema'
import { immediateWrite, withWriteRetry } from '../board/contention'
import { canUserSetRoutineStatus, type ScheduledRunStatus } from './state-machine'

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
        DbTask | undefined
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
      failureStreak: 0,
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
      DbScheduledRun | undefined) ?? null
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

/**
 * A row whose agent or team may start work: not paused (see board/pauses), and not
 * on an archived team. The team is the row's own or its agent's. A row this leaves
 * out stays as it is in the ledger and fires once the pause lifts. The three reads
 * the ticker arms and claims from all carry it: a due row counted by one and not
 * by the others would arm the ticker at a delay of 0, forever.
 */
const MAY_START = sql`NOT EXISTS (
  SELECT 1 FROM pauses p
  WHERE (p.scope_kind = 'agent' AND p.scope_id = scheduled_runs.agent_id)
     OR (p.scope_kind = 'team' AND p.scope_id IN (
          scheduled_runs.team_id,
          (SELECT a.team_id FROM agents a WHERE a.id = scheduled_runs.agent_id)))
) AND NOT EXISTS (
  SELECT 1 FROM teams t
  WHERE t.is_archived = 1 AND t.id IN (
    scheduled_runs.team_id,
    (SELECT a.team_id FROM agents a WHERE a.id = scheduled_runs.agent_id))
)`

/** MIN(next_run_at) over auto-fireable rows — the ticker's arm key. */
export function minNextRunAt(db: ClawbooDb): number | null {
  const row = db
    .select({ nextRunAt: scheduledRuns.nextRunAt })
    .from(scheduledRuns)
    .where(and(eq(scheduledRuns.status, 'idle'), isNotNull(scheduledRuns.nextRunAt), MAY_START))
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
            MAY_START,
          ),
        )
        .returning()
        .all() as DbScheduledRun[],
  )
}

/** Idle rows with a next run that may start (the rows `minNextRunAt` reads),
 *  earliest first. */
export function listArmedRuns(db: ClawbooDb): DbScheduledRun[] {
  return db
    .select()
    .from(scheduledRuns)
    .where(and(eq(scheduledRuns.status, 'idle'), isNotNull(scheduledRuns.nextRunAt), MAY_START))
    .orderBy(asc(scheduledRuns.nextRunAt))
    .all() as DbScheduledRun[]
}

/** Fires under way: claimed, or dispatched and not finished. */
export function countScheduledRunsInFlight(db: ClawbooDb): number {
  const row = db
    .select({ n: sql<number>`count(*)` })
    .from(scheduledRuns)
    .where(inArray(scheduledRuns.status, ['claimed', 'running']))
    .get() as { n: number } | undefined
  return row?.n ?? 0
}

export function listQueuedRuns(db: ClawbooDb): DbScheduledRun[] {
  return db
    .select()
    .from(scheduledRuns)
    .where(and(eq(scheduledRuns.status, 'queued'), MAY_START))
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

/**
 * Failed fires in a row a routine rides out before it stops. Only failures that
 * may pass by themselves count toward it; any other failure stops the routine at
 * once. Three keeps a daily routine alive through a bad morning without letting a
 * failure that never clears re-fire forever.
 */
export const MAX_ROUTINE_TRANSIENT_FAILURES = 3

/** A fire's outcome. `transient` marks a failure that may pass by itself (a rate
 *  limit, a timeout, a provider outage): the routine keeps its schedule for it. */
export type RunOutcome = { ok: true } | { ok: false; error: string; transient?: boolean }

/**
 * Whether a routine keeps its schedule after a failed fire: the failure may pass
 * by itself, there is a next run to arm (a spent once@ has none), and it is not
 * the MAX_ROUTINE_TRANSIENT_FAILURES-th failure in a row. `failureStreak` is the
 * count before this failure.
 */
export function routineSurvivesFailure(input: {
  transient: boolean
  failureStreak: number
  hasNextRun: boolean
}): boolean {
  return (
    input.transient && input.hasNextRun && input.failureStreak + 1 < MAX_ROUTINE_TRANSIENT_FAILURES
  )
}

/**
 * Record a fire's outcome. Success: → idle, lastRunAt stamped, re-armed at
 * `nextRunAt` (null for a spent once@, which self-disables), streak cleared.
 * A failure that may pass (see `routineSurvivesFailure`): → idle and re-armed,
 * with the error kept and the streak counted. Any other failure: → error,
 * disarmed (next_run_at NULL) until a person resumes it, so nothing retries silently.
 * Only a row still `running` takes it: one that moved on while the fire was in
 * flight (healed by another process's boot-resume, or deleted) keeps its state.
 *
 * `nextRunAt` was worked out from `claimedCronSpec`, the schedule the fire was
 * claimed under. An edit that changed the schedule while the fire ran set its
 * own next time from the new one, and that time stands. The check and the write
 * are one transaction, so an edit cannot land between them.
 * Returns the status the row landed in, or null when no running row took it.
 */
export function recordRunOutcome(
  db: ClawbooDb,
  id: string,
  outcome: RunOutcome,
  nextRunAt: number | null,
  now = Date.now(),
  claimedCronSpec?: string,
): 'idle' | 'error' | null {
  return immediateWrite(db, (tx) => {
    const row = tx
      .select({
        status: scheduledRuns.status,
        failureStreak: scheduledRuns.failureStreak,
        cronSpec: scheduledRuns.cronSpec,
        nextRunAt: scheduledRuns.nextRunAt,
      })
      .from(scheduledRuns)
      .where(eq(scheduledRuns.id, id))
      .get()
    if (row?.status !== 'running') return null
    if (claimedCronSpec !== undefined && row.cronSpec !== claimedCronSpec) {
      nextRunAt = row.nextRunAt ?? null
    }
    if (outcome.ok) {
      tx.update(scheduledRuns)
        .set({
          status: 'idle',
          lastRunAt: now,
          lastError: null,
          failureStreak: 0,
          nextRunAt,
          updatedAt: now,
        })
        .where(and(eq(scheduledRuns.id, id), eq(scheduledRuns.status, 'running')))
        .run()
      return 'idle'
    }
    const survives = routineSurvivesFailure({
      transient: outcome.transient === true,
      failureStreak: row.failureStreak,
      hasNextRun: nextRunAt != null,
    })
    tx.update(scheduledRuns)
      .set({
        status: survives ? 'idle' : 'error',
        lastRunAt: now,
        lastError: outcome.error,
        failureStreak: row.failureStreak + 1,
        nextRunAt: survives ? nextRunAt : null,
        updatedAt: now,
      })
      .where(and(eq(scheduledRuns.id, id), eq(scheduledRuns.status, 'running')))
      .run()
    return survives ? 'idle' : 'error'
  })
}

/**
 * A pause stopped this fire, or refused it: it did not happen. The row goes back to
 * waiting exactly as it was, with no last run, no failure and the same next run, so a
 * one-time routine is not spent. It stays out of the ticker's claims until nothing
 * holds it. False when the row has moved on.
 */
export function requeuePausedFire(db: ClawbooDb, id: string, now = Date.now()): boolean {
  return withWriteRetry(() => {
    const rows = db
      .update(scheduledRuns)
      .set({ status: 'queued', updatedAt: now })
      .where(and(eq(scheduledRuns.id, id), eq(scheduledRuns.status, 'running')))
      .returning({ id: scheduledRuns.id })
      .all()
    return rows.length > 0
  })
}

// ─── User-driven transitions (pause / resume / force-fire) ──────────────────

export type SetStatusResult =
  { ok: true; run: DbScheduledRun } | { ok: false; reason: 'not_found' | 'illegal_transition' }

/**
 * pause / resume with the state machine enforced inside BEGIN IMMEDIATE.
 *
 * A pause DISARMS the row: `next_run_at` goes to null, like a parked error row,
 * so nothing reads a paused Routine as having a next run. Resume passes the
 * recomputed value in `opts.nextRunAt`.
 */
export function setScheduledRunStatus(
  db: ClawbooDb,
  id: string,
  to: 'paused' | 'idle',
  opts: { nextRunAt?: number | null } = {},
): SetStatusResult {
  const now = Date.now()
  return immediateWrite(db, (tx) => {
    const row = tx.select().from(scheduledRuns).where(eq(scheduledRuns.id, id)).get() as
      DbScheduledRun | undefined
    if (!row) return { ok: false as const, reason: 'not_found' as const }
    if (!canUserSetRoutineStatus(row.status as ScheduledRunStatus, to)) {
      return { ok: false as const, reason: 'illegal_transition' as const }
    }
    const updated = tx
      .update(scheduledRuns)
      .set({
        status: to,
        updatedAt: now,
        ...(to === 'paused'
          ? { nextRunAt: null }
          : opts.nextRunAt !== undefined
            ? { nextRunAt: opts.nextRunAt }
            : {}),
        ...(to === 'idle' ? { lastError: null, failureStreak: 0 } : {}),
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
  /** Re-point the routine. Validated by the caller ('' = a team routine). */
  agentId?: string
  teamId?: string | null
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
        ...(patch.agentId !== undefined ? { agentId: patch.agentId } : {}),
        ...(patch.teamId !== undefined ? { teamId: patch.teamId } : {}),
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

/**
 * Delete every routine that targets one agent, for when that agent is deleted.
 * Left in place, each one fires on schedule and fails with "agent not found"
 * until someone removes it by hand. A team routine keeps no agent (its
 * `agent_id` is empty), so it is never matched here. Returns the count removed.
 */
export function deleteScheduledRunsForAgent(db: ClawbooDb, agentId: string): number {
  if (!agentId) return 0
  return withWriteRetry(
    () => db.delete(scheduledRuns).where(eq(scheduledRuns.agentId, agentId)).run().changes,
  )
}

/**
 * A team is going, and its agents stay on with no team. An agent routine goes with its
 * agent: it keeps its schedule and files its tasks with no team. A team routine keeps
 * no agent (its `agent_id` is empty), so it is not matched here: it keeps its team's
 * id, and says the team no longer exists when it next fires. Returns the count moved.
 */
export function detachAgentRoutinesFromTeam(
  db: ClawbooDb,
  teamId: string,
  now = Date.now(),
): number {
  return withWriteRetry(
    () =>
      db
        .update(scheduledRuns)
        .set({ teamId: null, updatedAt: now })
        .where(and(eq(scheduledRuns.teamId, teamId), ne(scheduledRuns.agentId, '')))
        .run().changes,
  )
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

// ─── Re-arming after a schedule-wide change ─────────────────────────────────

export interface RearmIdleScheduledRunsOptions {
  /** Default: now. Only runs still ahead of it move. */
  now?: number
  /**
   * A settings row written in the same transaction: the change that moves the
   * routines (the time zone cron is read in) and the moved runs land together or
   * not at all. `value: null` deletes the row.
   */
  setting?: { key: string; value: string | null }
}

/**
 * Recompute the next run of every armed idle routine with `rearm(cronSpec)`, in
 * one BEGIN IMMEDIATE pass. For a change that moves every routine's next fire at
 * once, such as the time zone cron is read in. Only `idle` rows whose next run is
 * still ahead are touched: one already due is the ticker's to fire, a paused or
 * parked row is disarmed and re-arms on resume, and a queued, claimed or running
 * row re-arms from its own outcome. A `rearm` that throws or returns null leaves
 * the row as it was. Returns how many rows moved.
 */
export function rearmIdleScheduledRuns(
  db: ClawbooDb,
  rearm: (cronSpec: string) => number | null,
  opts: RearmIdleScheduledRunsOptions = {},
): number {
  const now = opts.now ?? Date.now()
  return immediateWrite(db, (tx) => {
    if (opts.setting) {
      const { key, value } = opts.setting
      if (value === null) tx.delete(settings).where(eq(settings.key, key)).run()
      else
        tx.insert(settings)
          .values({ key, value, updatedAt: now })
          .onConflictDoUpdate({ target: settings.key, set: { value, updatedAt: now } })
          .run()
    }
    const rows = tx
      .select()
      .from(scheduledRuns)
      .where(and(eq(scheduledRuns.status, 'idle'), gt(scheduledRuns.nextRunAt, now)))
      .all() as DbScheduledRun[]
    let moved = 0
    for (const row of rows) {
      let nextRunAt: number | null
      try {
        nextRunAt = rearm(row.cronSpec)
      } catch {
        nextRunAt = null
      }
      if (nextRunAt == null || nextRunAt === row.nextRunAt) continue
      tx.update(scheduledRuns)
        .set({ nextRunAt, updatedAt: now })
        .where(and(eq(scheduledRuns.id, row.id), eq(scheduledRuns.status, 'idle')))
        .run()
      moved += 1
    }
    return moved
  })
}
