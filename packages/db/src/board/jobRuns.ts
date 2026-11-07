// How many runs a job has started by itself.
//
// Every other brake reads one task or one kind of run, so together they did not bound a
// job: a follow-up that hands out more, a wake that brings a teammate in, an update turn
// that hands out the next piece. This is the one count of the whole job, keyed by its top
// (`jobTaskIdOf`: a person's main task, or a top-level task), and written in the same
// transaction as the claim that opens the run, so a restart loses none of it.
//
// What counts is what nobody asked for at the time: wakes, follow-ups, fix rounds, extra
// turns, provider retries, plan steps, update turns and a hand-off from a run. A person's
// own message, Retry, reply and Accept neither count nor get refused.
//
// A count means a run that started. A claim counts in its own write and gives it back if
// the budget gate then refuses the run. An update turn, which has no claim, counts when
// its run has started.
//
// At the limit nothing automatic starts. The work waits where it is, uncounted, and the
// task at the top of the job shows in Needs you (`job_limit`) for as long as something
// could really start. A person's "carry on" adds another `DEFAULT_MAX_JOB_RUNS`. Their
// Stop ends this job's runs and marks it stopped (`stopJob`): nothing under it starts by
// itself and no card is up, until a person starts work in it again, which may bring the
// card back at the next refusal.

import {
  delegationTargetOf,
  ledgerWillAutoFire,
  stoppedByPause,
  type JobLimitCard,
} from '@clawboo/board-core'
import { DEFAULT_MAX_JOB_RUNS } from '@clawboo/governance'
import { and, eq, inArray, isNotNull, isNull, ne, sql } from 'drizzle-orm'

import type { ClawbooDb } from '../db'
import { appendEvent } from '../events/appendEvent'
import { personJson, type PersonRecord } from '../person'
import {
  executionProcesses,
  jobRuns,
  reportUpOutbox,
  taskDeps,
  tasks,
  taskWakes,
  type DbJobRuns,
  type DbTask,
} from '../schema'
import { jobTaskIdOf } from './agentWakeState'
import { immediateWrite, type BoardTx } from './contention'
import { emitBoardLifecycle } from './events'

export const jobRunRowOf = (tx: ClawbooDb | BoardTx, jobTaskId: string): DbJobRuns | undefined =>
  tx.select().from(jobRuns).where(eq(jobRuns.jobTaskId, jobTaskId)).get() as DbJobRuns | undefined

const atLimit = (row: DbJobRuns | undefined): boolean => !!row && row.runs >= row.runLimit

const stoppedJob = (row: DbJobRuns | undefined): boolean => row?.stoppedAt != null

/** Make sure the job has its row. */
function ensureRowTx(tx: BoardTx, jobTaskId: string, now: number): DbJobRuns {
  const teamId =
    tx.select({ teamId: tasks.teamId }).from(tasks).where(eq(tasks.id, jobTaskId)).get()?.teamId ??
    null
  tx.insert(jobRuns)
    .values({
      jobTaskId,
      teamId,
      runs: 0,
      runLimit: DEFAULT_MAX_JOB_RUNS,
      updatedAt: now,
    })
    .onConflictDoNothing()
    .run()
  return jobRunRowOf(tx, jobTaskId) as DbJobRuns
}

/** Mark that something was refused at the limit. True when this write is the first since
 *  the last carry on, so its caller says so once, after its transaction. A job a person
 *  stopped has had its answer: nothing goes up again until they start work in it. */
function markHitTx(tx: BoardTx, row: DbJobRuns, now: number): boolean {
  if (row.limitHitAt !== null || stoppedJob(row)) return false
  tx.update(jobRuns)
    .set({ limitHitAt: now, updatedAt: now })
    .where(eq(jobRuns.jobTaskId, row.jobTaskId))
    .run()
  return true
}

/** What a transaction that may refuse a start reports back: the job, if it was refused,
 *  and whether that is news. */
export interface JobRunRefusal {
  jobTaskId: string
  /** Say so once, after the transaction commits: see {@link announceJobLimit}. */
  firstHit: boolean
}

/** Would one more automatic run of this job be refused? Notes the refusal if so. */
export function refuseAtJobLimitTx(tx: BoardTx, taskId: string, now: number): JobRunRefusal | null {
  const jobTaskId = jobTaskIdOf(tx, taskId)
  const row = jobRunRowOf(tx, jobTaskId)
  if (!atLimit(row)) return null
  return { jobTaskId, firstHit: markHitTx(tx, row as DbJobRuns, now) }
}

/** One automatic run started. Inside the write that starts it. */
export function countJobRunTx(tx: BoardTx, taskId: string, now: number): void {
  const row = ensureRowTx(tx, jobTaskIdOf(tx, taskId), now)
  tx.update(jobRuns)
    .set({ runs: row.runs + 1, updatedAt: now })
    .where(eq(jobRuns.jobTaskId, row.jobTaskId))
    .run()
}

/**
 * A person accepted a plan: starting its steps is their answer, not the job carrying on by
 * itself. So the job has room for them, inside the write that accepts it, and the steps
 * still count, one by one, as they start.
 */
export function roomForAcceptedStepsTx(
  tx: BoardTx,
  taskId: string,
  steps: number,
  now: number,
): void {
  personStartedJobTx(tx, taskId, now)
  const row = ensureRowTx(tx, jobTaskIdOf(tx, taskId), now)
  if (row.runLimit - row.runs >= steps) return
  tx.update(jobRuns)
    .set({ runLimit: row.runs + steps, limitHitAt: null, updatedAt: now })
    .where(eq(jobRuns.jobTaskId, row.jobTaskId))
    .run()
}

/**
 * Tell whoever is looking that a job stopped at its limit: its own event, which is what
 * browser alerts follow, and the bus, which is what open boards read. Best-effort: the
 * refusal stands, and the board shows the card at its next read.
 */
export function announceJobLimit(db: ClawbooDb, jobTaskId: string): void {
  const row = jobRunRowOf(db, jobTaskId)
  const task = db.select().from(tasks).where(eq(tasks.id, jobTaskId)).get() as DbTask | undefined
  if (!row || !task) return
  emitBoardLifecycle({
    kind: 'status_changed',
    taskId: task.id,
    teamId: task.teamId ?? null,
    status: task.status,
  })
  try {
    appendEvent(db, {
      kind: 'job_limit_reached',
      taskId: task.id,
      teamId: task.teamId,
      data: { runs: row.runs, limit: row.runLimit },
    })
  } catch {
    // Best-effort, as above.
  }
}

/**
 * Count a run that has started and opened no claim: an update turn, or a fix cycle that
 * holds its task. Asking comes first (`jobRunRefused`), and this does not refuse: the run
 * is going, and the count stays true. A person's run never comes here.
 */
export function noteJobRun(db: ClawbooDb, taskId: string): void {
  const now = Date.now()
  immediateWrite(db, (tx) => countJobRunTx(tx, taskId, now))
}

/**
 * This run took one from its job and the budget gate then refused it, so it never
 * started. It goes back, once, in one write with the mark that says it was taken.
 */
export function giveBackJobRun(db: ClawbooDb, execId: string): void {
  const now = Date.now()
  immediateWrite(db, (tx) => {
    const taken = tx
      .update(executionProcesses)
      .set({ jobCounted: 0 })
      .where(and(eq(executionProcesses.id, execId), eq(executionProcesses.jobCounted, 1)))
      .returning({ taskId: executionProcesses.taskId })
      .get()
    if (!taken) return
    const row = jobRunRowOf(tx, jobTaskIdOf(tx, taken.taskId))
    if (!row) return
    tx.update(jobRuns)
      .set({ runs: Math.max(0, row.runs - 1), updatedAt: now })
      .where(eq(jobRuns.jobTaskId, row.jobTaskId))
      .run()
  })
}

/**
 * Would an automatic start of this task be refused now? For a pump, before it writes
 * anything else. The refusal is noted here too: this is often the first thing to find it.
 */
export function jobRunRefused(db: ClawbooDb, taskId: string): boolean {
  const jobTaskId = jobTaskIdOf(db, taskId)
  const row = jobRunRowOf(db, jobTaskId)
  if (!atLimit(row)) return false
  if (row?.limitHitAt === null && !stoppedJob(row)) {
    const now = Date.now()
    const first = immediateWrite(db, (tx) => {
      const fresh = jobRunRowOf(tx, jobTaskId)
      return fresh && atLimit(fresh) ? markHitTx(tx, fresh, now) : false
    })
    if (first) announceJobLimit(db, jobTaskId)
  }
  return true
}

/** Did a person stop this task's job at its limit, with no one starting it since? */
export function jobRunStopped(db: ClawbooDb, taskId: string): boolean {
  return stoppedJob(jobRunRowOf(db, jobTaskIdOf(db, taskId)))
}

/** Where a job stands. A job that has started nothing by itself has no row yet. */
export function jobRunState(
  db: ClawbooDb,
  taskId: string,
): { jobTaskId: string; runs: number; limit: number; hitAt: number | null } {
  const jobTaskId = jobTaskIdOf(db, taskId)
  const row = jobRunRowOf(db, jobTaskId)
  return {
    jobTaskId,
    runs: row?.runs ?? 0,
    limit: row?.runLimit ?? DEFAULT_MAX_JOB_RUNS,
    hitAt: row?.limitHitAt ?? null,
  }
}

/** The job's top and every task under it. */
export function tasksOfJob(tx: ClawbooDb | BoardTx, jobTaskId: string): string[] {
  return (
    tx.all(
      sql`
        WITH RECURSIVE below(id) AS (
          SELECT ${jobTaskId}
          UNION
          SELECT t.id FROM tasks t JOIN below b ON t.parent_task_id = b.id WHERE t.dropped = 0
        )
        SELECT id FROM below
      `,
    ) as Array<{ id: string }>
  ).map((r) => r.id)
}

/** Could the pump start this To do task by itself, its turn having come? Not one with no
 *  agent, one a person holds, or a plan step whose blocker is still open. */
export function pumpCouldStart(tx: ClawbooDb | BoardTx, task: DbTask): boolean {
  if (task.assigneePersonId !== null || task.isMainTask === 1) return false
  const blocked = tx
    .select({ id: taskDeps.dependsOnTaskId })
    .from(taskDeps)
    .innerJoin(tasks, eq(tasks.id, taskDeps.dependsOnTaskId))
    .where(and(eq(taskDeps.taskId, task.id), ne(tasks.status, 'done')))
    .get()
  if (blocked) return false
  const execs = tx
    .select()
    .from(executionProcesses)
    .where(eq(executionProcesses.taskId, task.id))
    .orderBy(executionProcesses.createdAt)
    .all()
  // A task the runner runs names its agent in what it saved, when a pause stopped it.
  const bound =
    delegationTargetOf(task.sourceDelegationId) !== null ||
    (task.runnerInputs != null && stoppedByPause(execs.at(-1)))
  return bound && ledgerWillAutoFire(execs)
}

/** Is anything under this job really waiting on the limit? A task the pump would start,
 *  a saved wake or a report on its way. What a Stop held, or a person parked, is not, and
 *  nor is what could not start anyway: a card about those would have no answer. */
function jobWorkWaits(tx: ClawbooDb | BoardTx, jobTaskId: string): boolean {
  const ids = tasksOfJob(tx, jobTaskId)
  if (ids.length === 0) return false
  const wake = tx
    .select({ id: taskWakes.id })
    .from(taskWakes)
    .where(
      and(
        inArray(taskWakes.taskId, ids),
        isNull(taskWakes.settledAt),
        isNull(taskWakes.carriedExecId),
        isNull(taskWakes.heldAt),
      ),
    )
    .get()
  if (wake) return true
  const report = tx
    .select({ id: reportUpOutbox.id })
    .from(reportUpOutbox)
    .where(
      and(
        inArray(reportUpOutbox.taskId, ids),
        isNull(reportUpOutbox.settledAt),
        isNull(reportUpOutbox.heldAt),
      ),
    )
    .get()
  if (report) return true
  const queued = tx
    .select()
    .from(tasks)
    .where(and(inArray(tasks.id, ids), eq(tasks.status, 'todo'), eq(tasks.dropped, 0)))
    .all() as DbTask[]
  return queued.some((task) => pumpCouldStart(tx, task))
}

/** Is this job's card up? Refused at its limit, not stopped, and work really waiting. */
export const jobCardStands = (tx: ClawbooDb | BoardTx, row: DbJobRuns): boolean =>
  row.limitHitAt !== null && !stoppedJob(row) && atLimit(row) && jobWorkWaits(tx, row.jobTaskId)

/** The job limit's card on each of these tasks, keyed by task id: only a task that heads a
 *  job stopped at its limit with work waiting. */
export function jobLimitCardsForTasks(
  db: ClawbooDb,
  rows: ReadonlyArray<Pick<DbTask, 'id'>>,
): Map<string, JobLimitCard> {
  const out = new Map<string, JobLimitCard>()
  const hit = db.select().from(jobRuns).where(isNotNull(jobRuns.limitHitAt)).all() as DbJobRuns[]
  if (hit.length === 0) return out
  const wanted = new Set(rows.map((t) => t.id))
  for (const row of hit) {
    if (!wanted.has(row.jobTaskId) || !jobCardStands(db, row)) continue
    out.set(row.jobTaskId, { jobTaskId: row.jobTaskId, runs: row.runs, limit: row.runLimit })
  }
  return out
}

/** The jobs a person has to answer now, as task ids. Any status: a finished task can head
 *  work still going. */
export function jobLimitedTaskIds(db: ClawbooDb): string[] {
  const hit = db.select().from(jobRuns).where(isNotNull(jobRuns.limitHitAt)).all() as DbJobRuns[]
  return hit.filter((row) => jobCardStands(db, row)).map((row) => row.jobTaskId)
}

export type CarryOnResult =
  { ok: true; jobTaskId: string; runs: number; limit: number } | { ok: false; reason: 'no_card' }

/** A person said to carry on: another `DEFAULT_MAX_JOB_RUNS` runs from where it stands. A
 *  card nothing is waiting on answers nothing, so a second press or a stale page changes
 *  nothing. */
export function carryOnJob(db: ClawbooDb, jobTaskId: string, person: PersonRecord): CarryOnResult {
  const now = Date.now()
  const result = immediateWrite(db, (tx): CarryOnResult => {
    const row = jobRunRowOf(tx, jobTaskId)
    if (!row || !jobCardStands(tx, row)) return { ok: false, reason: 'no_card' }
    const limit = row.runs + DEFAULT_MAX_JOB_RUNS
    tx.update(jobRuns)
      .set({
        runLimit: limit,
        limitHitAt: null,
        carriedOnBy: personJson(person),
        carriedOnAt: now,
        stoppedAt: null,
        stoppedBy: null,
        updatedAt: now,
      })
      .where(eq(jobRuns.jobTaskId, jobTaskId))
      .run()
    return { ok: true, jobTaskId, runs: row.runs, limit }
  })
  if (result.ok) {
    const task = db.select().from(tasks).where(eq(tasks.id, jobTaskId)).get() as DbTask | undefined
    if (task)
      emitBoardLifecycle({
        kind: 'status_changed',
        taskId: task.id,
        teamId: task.teamId ?? null,
        status: task.status,
      })
  }
  return result
}

/** A person started work in this job: their Retry, their words on it, an answer, or a
 *  plan they accepted. It is no longer stopped. It is still at its limit, so the next
 *  thing that would start by itself is refused, and the card comes back to ask. */
export function personStartedJobTx(tx: ClawbooDb | BoardTx, taskId: string, now: number): void {
  const row = jobRunRowOf(tx, jobTaskIdOf(tx, taskId))
  if (!stoppedJob(row)) return
  tx.update(jobRuns)
    .set({ stoppedAt: null, stoppedBy: null, updatedAt: now })
    .where(eq(jobRuns.jobTaskId, (row as DbJobRuns).jobTaskId))
    .run()
}

export function personStartedJob(db: ClawbooDb, taskId: string): void {
  const now = Date.now()
  immediateWrite(db, (tx) => personStartedJobTx(tx as BoardTx, taskId, now))
}

/** Which of these tasks are held back by a person's Stop on their job, for a card to say
 *  so. Only tasks in a stopped job are read, and those are few. */
export function jobStoppedTaskIds(
  db: ClawbooDb,
  rows: ReadonlyArray<Pick<DbTask, 'id'>>,
): Set<string> {
  const stopped = db
    .select({ id: jobRuns.jobTaskId })
    .from(jobRuns)
    .where(isNotNull(jobRuns.stoppedAt))
    .all()
  if (stopped.length === 0) return new Set()
  const under = new Set(stopped.flatMap((r) => tasksOfJob(db, r.id)))
  return new Set(rows.filter((t) => under.has(t.id)).map((t) => t.id))
}
