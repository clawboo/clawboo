// task_wakes accessors: the saved wake. See the schema comment for the model. A
// wake is written when it happens and folded into the row already waiting for that
// agent and task; the run that starts the task takes it, and it is settled when
// that run ends:
//   • delivered, when the run ended well;
//   • held, on a person's Stop: it starts nothing, and it rides the task's next run;
//   • back to waiting, counted, on any other end, for the pump to send again;
//   • back to waiting, uncounted, when a hard budget cap refused or killed the run,
//     or a pause stopped it: nothing went wrong with the run, and the pump sends the
//     wake on resume.
// Each write is one BEGIN IMMEDIATE transaction, because other processes (the MCP
// stdio bins) write the same database file.

import { randomUUID } from 'node:crypto'

import {
  budgetRefusalOf,
  delegationTargetOf,
  stoppedByPause,
  strongerWakeReason,
  wakeFromPerson,
  type TaskWakeReason,
  type TaskWakeSettlement,
  type WakeSkipReason,
} from '@clawboo/board-core'
import { and, asc, eq, getTableColumns, inArray, isNull, sql } from 'drizzle-orm'

import type { ClawbooDb } from './db'
import { clearAgentWakeChainsTx } from './board/agentWakeState'
import { immediateWrite, withWriteRetry, type BoardTx } from './board/contention'
import { emitBoardLifecycle } from './board/events'
import { readyOrder } from './board/readyOrder'
import { taskComments, taskDeps, tasks, taskWakes, type DbTask, type DbTaskWake } from './schema'

/** A row that waits for a run: not settled, and no run is carrying it. */
const isWaiting = and(isNull(taskWakes.settledAt), isNull(taskWakes.carriedExecId))

/** The comments a wake carries. */
export function wakeCommentIds(row: Pick<DbTaskWake, 'commentIds'>): string[] {
  try {
    const parsed: unknown = JSON.parse(row.commentIds)
    return Array.isArray(parsed) ? parsed.filter((c): c is string => typeof c === 'string') : []
  } catch {
    return []
  }
}

const mergedIds = (a: readonly string[], b: readonly string[]): string =>
  JSON.stringify([...new Set([...a, ...b])])

export interface RecordTaskWakeInput {
  teamId: string | null
  agentId: string
  taskId: string
  reason: TaskWakeReason
  commentIds?: string[]
}

/**
 * Write a wake inside a transaction: a new row, or a merge into the one waiting for
 * this agent and task. A wake a person is behind starts that row afresh: it lifts a
 * Stop's hold and spends its replays, because this is a person asking now, not a
 * failed run coming round again. `startsAfresh` tells the caller no start is on its
 * way for this row yet: it was held, it was replaying, or no person was behind it.
 */
export function recordTaskWakeTx(
  tx: BoardTx,
  input: RecordTaskWakeInput,
  now: number,
): { id: string; merged: boolean; startsAfresh?: boolean } {
  if (wakeFromPerson(input.reason)) clearAgentWakeChainsTx(tx, input.teamId, input.agentId, now)
  const waiting = tx
    .select()
    .from(taskWakes)
    .where(and(eq(taskWakes.agentId, input.agentId), eq(taskWakes.taskId, input.taskId), isWaiting))
    .get() as DbTaskWake | undefined
  if (waiting) {
    const fromPerson = wakeFromPerson(input.reason)
    tx.update(taskWakes)
      .set({
        reason: strongerWakeReason(waiting.reason, input.reason),
        commentIds: mergedIds(wakeCommentIds(waiting), input.commentIds ?? []),
        mergeCount: waiting.mergeCount + 1,
        updatedAt: now,
        ...(fromPerson ? { heldAt: null, replays: 0 } : {}),
      })
      .where(eq(taskWakes.id, waiting.id))
      .run()
    const startsAfresh =
      fromPerson &&
      (waiting.heldAt !== null || waiting.replays > 0 || !wakeFromPerson(waiting.reason))
    return { id: waiting.id, merged: true, ...(startsAfresh ? { startsAfresh: true } : {}) }
  }
  const id = randomUUID()
  tx.insert(taskWakes)
    .values({
      id,
      teamId: input.teamId,
      agentId: input.agentId,
      taskId: input.taskId,
      reason: input.reason,
      commentIds: JSON.stringify(input.commentIds ?? []),
      createdAt: now,
      updatedAt: now,
    })
    .run()
  return { id, merged: false }
}

/** Save a wake, or fold it into the one already waiting. Returns its row id, whether
 *  it folded, and whether that started the row afresh (see `recordTaskWakeTx`). */
export function recordTaskWake(
  db: ClawbooDb,
  input: RecordTaskWakeInput,
): { id: string; merged: boolean; startsAfresh?: boolean } {
  const result = immediateWrite(db, (tx) => recordTaskWakeTx(tx, input, Date.now()))
  emitBoardLifecycle({
    kind: 'task_wake_recorded',
    taskId: input.taskId,
    teamId: input.teamId,
    reason: input.reason,
  })
  return result
}

/**
 * Save a `dependency_done` wake on each agent-bound dependent that `doneTaskId`
 * moving to done leaves ready, inside that write's own transaction. In the database
 * rather than on the in-process bus, so a done written by an MCP stdio bin saves it
 * too, and a crash right after the write cannot lose it. A dependent bound to no
 * agent stays put: nothing would start it.
 */
export function recordDependencyWakesTx(
  tx: BoardTx,
  doneTaskId: string,
  now: number,
): Array<{ taskId: string; teamId: string | null }> {
  const dependents = tx
    .select({ task: tasks })
    .from(taskDeps)
    .innerJoin(tasks, eq(tasks.id, taskDeps.taskId))
    .where(
      and(
        eq(taskDeps.dependsOnTaskId, doneTaskId),
        eq(tasks.status, 'todo'),
        eq(tasks.dropped, 0),
        sql`NOT EXISTS (SELECT 1 FROM task_deps d JOIN tasks dt ON dt.id = d.depends_on_task_id WHERE d.task_id = ${tasks.id} AND dt.status != 'done')`,
      ),
    )
    .all() as Array<{ task: DbTask }>
  const woken: Array<{ taskId: string; teamId: string | null }> = []
  for (const { task } of dependents) {
    const agentId = delegationTargetOf(task.sourceDelegationId)
    if (!agentId) continue
    recordTaskWakeTx(
      tx,
      { teamId: task.teamId ?? null, agentId, taskId: task.id, reason: 'dependency_done' },
      now,
    )
    woken.push({ taskId: task.id, teamId: task.teamId ?? null })
  }
  return woken
}

/** Rows that wait for a run, in the order their tasks wait in the ready list (see
 *  ./board/readyOrder), then oldest first. A row a Stop held starts nothing, so it is
 *  left out unless asked for. */
export function listWaitingTaskWakes(
  db: ClawbooDb,
  opts: { includeHeld?: boolean; taskId?: string } = {},
): DbTaskWake[] {
  return db
    .select(getTableColumns(taskWakes))
    .from(taskWakes)
    .leftJoin(tasks, eq(tasks.id, taskWakes.taskId))
    .where(
      and(
        isWaiting,
        ...(opts.includeHeld ? [] : [isNull(taskWakes.heldAt)]),
        ...(opts.taskId ? [eq(taskWakes.taskId, opts.taskId)] : []),
      ),
    )
    .orderBy(...readyOrder(Date.now()), asc(taskWakes.createdAt), sql`task_wakes.rowid`)
    .all() as DbTaskWake[]
}

/** Rows a run is carrying. */
export function listTaskWakesCarriedBy(db: ClawbooDb, execId: string): DbTaskWake[] {
  return db
    .select()
    .from(taskWakes)
    .where(and(eq(taskWakes.carriedExecId, execId), isNull(taskWakes.settledAt)))
    .orderBy(asc(taskWakes.createdAt), sql`rowid`)
    .all() as DbTaskWake[]
}

/** Every unsettled row on a team's tasks, carried or not: what a Stop holds. */
export function listUnsettledTaskWakes(db: ClawbooDb, teamId: string): DbTaskWake[] {
  return db
    .select()
    .from(taskWakes)
    .where(and(eq(taskWakes.teamId, teamId), isNull(taskWakes.settledAt)))
    .all() as DbTaskWake[]
}

/** Hand the rows waiting on a task to the run with this execution, inside its
 *  transaction. Whichever agent they were for: the run is who the task has now. A
 *  row a Stop held rides this run too, which is what it was waiting for. */
export function adoptTaskWakesTx(
  tx: BoardTx,
  taskId: string,
  execId: string,
  now: number,
): DbTaskWake[] {
  return tx
    .update(taskWakes)
    .set({ carriedExecId: execId, skipReason: null, updatedAt: now })
    .where(and(eq(taskWakes.taskId, taskId), isWaiting))
    .returning()
    .all() as DbTaskWake[]
}

/** Hand what is waiting on a task to the run going now. A run that opened with
 *  no claim takes its comments when its context renders: rows taken here are ones
 *  it can show, and what comes later waits in a new row. */
export function adoptTaskWakes(db: ClawbooDb, taskId: string, execId: string): DbTaskWake[] {
  return immediateWrite(db, (tx) => adoptTaskWakesTx(tx, taskId, execId, Date.now()))
}

/** Close rows that are still open. The first settlement wins. Returns the ids this
 *  call settled. */
export function settleTaskWakes(db: ClawbooDb, ids: string[], how: TaskWakeSettlement): string[] {
  if (ids.length === 0) return []
  const now = Date.now()
  const won = withWriteRetry(() =>
    db
      .update(taskWakes)
      .set({ settledAt: now, settledHow: how, updatedAt: now })
      .where(and(inArray(taskWakes.id, ids), isNull(taskWakes.settledAt)))
      .returning({ id: taskWakes.id })
      .all(),
  ) as Array<{ id: string }>
  return won.map((r) => r.id)
}

/** A person's Stop: these rows start nothing from now on, and ride the task's next
 *  run instead. A comment from a person lifts it. */
export function holdTaskWakes(db: ClawbooDb, ids: string[]): void {
  if (ids.length === 0) return
  const now = Date.now()
  withWriteRetry(() =>
    db
      .update(taskWakes)
      .set({ heldAt: now, updatedAt: now })
      .where(and(inArray(taskWakes.id, ids), isNull(taskWakes.settledAt)))
      .run(),
  )
}

/** Give a row back to waiting from the run that carried it, folding it into the row
 *  that already waits, if one does (a comment that came during that run). */
function returnToWaitingTx(
  tx: BoardTx,
  row: DbTaskWake,
  changes: { replays: number; heldAt: number | null },
  now: number,
): void {
  const waiting = tx
    .select()
    .from(taskWakes)
    .where(and(eq(taskWakes.agentId, row.agentId), eq(taskWakes.taskId, row.taskId), isWaiting))
    .get() as DbTaskWake | undefined
  if (!waiting) {
    tx.update(taskWakes)
      .set({ carriedExecId: null, updatedAt: now, ...changes })
      .where(eq(taskWakes.id, row.id))
      .run()
    return
  }
  tx.update(taskWakes)
    .set({
      reason: strongerWakeReason(waiting.reason, row.reason),
      commentIds: mergedIds(wakeCommentIds(row), wakeCommentIds(waiting)),
      mergeCount: waiting.mergeCount + row.mergeCount,
      // A person's comment waiting here has not had its first start yet.
      replays: wakeFromPerson(waiting.reason)
        ? waiting.replays
        : Math.max(waiting.replays, changes.replays),
      heldAt: changes.heldAt ?? waiting.heldAt,
      updatedAt: now,
    })
    .where(eq(taskWakes.id, waiting.id))
    .run()
  tx.update(taskWakes)
    .set({ carriedExecId: null, settledAt: now, settledHow: 'merged', updatedAt: now })
    .where(eq(taskWakes.id, row.id))
    .run()
}

/**
 * The run with this execution closed: settle what it carried, in the same
 * transaction. Every path that closes a run goes through here, the sweeps and the
 * task runner included, so a run nothing observed still gives its wakes back.
 */
export function settleWakesOfClosedRunTx(
  tx: BoardTx,
  execId: string,
  outcome: { status: string; errorClass?: string | null; byPerson?: boolean },
  now: number,
): void {
  const carried = tx
    .select()
    .from(taskWakes)
    .where(and(eq(taskWakes.carriedExecId, execId), isNull(taskWakes.settledAt)))
    .all() as DbTaskWake[]
  for (const row of carried) {
    if (outcome.status === 'succeeded') {
      tx.update(taskWakes)
        .set({ settledAt: now, settledHow: 'delivered', updatedAt: now })
        .where(eq(taskWakes.id, row.id))
        .run()
    } else if (stoppedByPause({ status: outcome.status, errorClass: outcome.errorClass })) {
      // A pause is about when work may run, not this task: it goes out on resume.
      returnToWaitingTx(tx, row, { replays: row.replays, heldAt: row.heldAt }, now)
    } else if (outcome.byPerson) {
      // A person's Stop or move: it starts nothing, and rides the next run.
      returnToWaitingTx(tx, row, { replays: row.replays, heldAt: now }, now)
    } else {
      // Any other ending. That includes a budget cap, the circuit breaker and the
      // `cancelled` of a runtime abort, which no person asked for.
      const refused = budgetRefusalOf({ status: outcome.status, errorClass: outcome.errorClass })
      returnToWaitingTx(
        tx,
        row,
        { replays: refused ? row.replays : row.replays + 1, heldAt: row.heldAt },
        now,
      )
    }
  }
}

/** A start of this task was refused before any claim, so no run took what waits on
 *  it and no ledger row says so. Counted like a run that did not finish, so it ends
 *  in a give-up and an alert. A row a Stop held was not what asked for the start. */
export function countRefusedWakeStart(db: ClawbooDb, taskId: string): void {
  const now = Date.now()
  withWriteRetry(() =>
    db
      .update(taskWakes)
      .set({ replays: sql`${taskWakes.replays} + 1`, updatedAt: now })
      .where(and(eq(taskWakes.taskId, taskId), isWaiting, isNull(taskWakes.heldAt)))
      .run(),
  )
}

/** Record why the pump left a row waiting. True when the reason changed, which is
 *  when a caller reports it: one wait is one event, however many passes it spans. */
export function noteTaskWakeSkip(db: ClawbooDb, id: string, reason: WakeSkipReason): boolean {
  const changed = withWriteRetry(() =>
    db
      .update(taskWakes)
      .set({ skipReason: reason })
      .where(
        and(
          eq(taskWakes.id, id),
          isNull(taskWakes.settledAt),
          sql`(${taskWakes.skipReason} IS NULL OR ${taskWakes.skipReason} != ${reason})`,
        ),
      )
      .returning({ id: taskWakes.id })
      .all(),
  ) as Array<{ id: string }>
  return changed.length > 0
}

/**
 * These comments reached the run going now, live, whole. They leave what is waiting
 * and the run carries them, so they settle with it: delivered when it ends well, and
 * back to waiting on any other end, because a run that dies may have saved nothing of
 * what it heard. Each is marked as steered, which keeps a session resumed from a run
 * that did end after this moment from being shown it again. With no run stamped on
 * the task, nothing could carry them, so they stay waiting.
 */
export function markWakeCommentsHeard(
  db: ClawbooDb,
  taskId: string,
  commentIds: readonly string[],
): void {
  if (commentIds.length === 0) return
  const heard = new Set(commentIds)
  const now = Date.now()
  immediateWrite(db, (tx) => {
    tx.update(taskComments)
      .set({ steeredAt: now })
      .where(inArray(taskComments.id, [...heard]))
      .run()
    const execId = tx
      .select({ execId: tasks.runExecutionId })
      .from(tasks)
      .where(eq(tasks.id, taskId))
      .get()?.execId
    if (!execId) return
    const rows = tx
      .select()
      .from(taskWakes)
      .where(and(eq(taskWakes.taskId, taskId), isWaiting))
      .all() as DbTaskWake[]
    for (const row of rows) {
      const before = wakeCommentIds(row)
      const taken = before.filter((id) => heard.has(id))
      if (taken.length === 0) continue
      const left = before.filter((id) => !heard.has(id))
      if (left.length === 0) {
        tx.update(taskWakes)
          .set({ carriedExecId: execId, skipReason: null, updatedAt: now })
          .where(eq(taskWakes.id, row.id))
          .run()
        continue
      }
      tx.update(taskWakes)
        .set({ commentIds: JSON.stringify(left), updatedAt: now })
        .where(eq(taskWakes.id, row.id))
        .run()
      tx.insert(taskWakes)
        .values({
          id: randomUUID(),
          teamId: row.teamId,
          agentId: row.agentId,
          taskId: row.taskId,
          reason: row.reason,
          commentIds: JSON.stringify(taken),
          mergeCount: taken.length,
          replays: row.replays,
          carriedExecId: execId,
          createdAt: now,
          updatedAt: now,
        })
        .run()
    }
  })
}

/** Which of these comments are still waiting on the task, so a steer that was
 *  batched sends only what no run has taken since. */
export function waitingCommentIds(db: ClawbooDb, taskId: string): Set<string> {
  return new Set(listWaitingTaskWakes(db, { includeHeld: true, taskId }).flatMap(wakeCommentIds))
}

/** A settled row is kept this long, for debugging, then deleted. */
export const TASK_WAKE_SETTLED_RETENTION_MS = 7 * 24 * 60 * 60_000
/** A waiting row older than this is deleted: its comment is on the card anyway. */
export const TASK_WAKE_PENDING_MAX_AGE_MS = 30 * 24 * 60 * 60_000

/** Retention: settled rows past their week, open rows past their month, and rows
 *  whose task or team no longer exists, so the scan never wakes a ghost. A deleted
 *  team leaves its task rows behind, and nothing should run for them. */
export function reapTaskWakes(db: ClawbooDb, at = Date.now()): number {
  const settledCutoff = at - TASK_WAKE_SETTLED_RETENTION_MS
  const pendingCutoff = at - TASK_WAKE_PENDING_MAX_AGE_MS
  const result = withWriteRetry(() =>
    db.run(
      sql`DELETE FROM task_wakes WHERE (settled_at IS NOT NULL AND settled_at < ${settledCutoff}) OR (settled_at IS NULL AND (created_at < ${pendingCutoff} OR task_id NOT IN (SELECT id FROM tasks) OR (team_id IS NOT NULL AND team_id NOT IN (SELECT id FROM teams))))`,
    ),
  )
  return Number((result as { changes?: number }).changes ?? 0)
}
