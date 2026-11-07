// A person's Stop on a job's card (see ./jobRuns). Apart from it because it writes runs,
// and the board's repository reads the job's count.

import { delegationTargetOf, parseWaitingOn, waitsToStartByItself } from '@clawboo/board-core'
import { and, eq, inArray, isNull } from 'drizzle-orm'

import type { ClawbooDb } from '../db'
import { personJson, type PersonRecord } from '../person'
import { jobRuns, reportUpOutbox, tasks, taskWakes, type DbTask } from '../schema'
import { immediateWrite } from './contention'
import { emitBoardLifecycle } from './events'
import { jobCardStands, jobRunRowOf, pumpCouldStart, tasksOfJob } from './jobRuns'
import {
  completeExecutionProcess,
  createExecutionProcess,
  setTaskWaitingOn,
  updateStatus,
} from './repository'

export type StopJobResult = { ok: true; taskIds: string[] } | { ok: false; reason: 'no_card' }

/**
 * A person pressed Stop on a job's card. For this job alone, in one write:
 *  - it is marked stopped, so nothing under it starts by itself and the card is down;
 *  - what was on its way (saved wakes, task updates, a one-to-one chat's among them) is
 *    held, and rides the next run of whoever it was for;
 *  - each To do task the pump would have started reads as a person's Stop, with its Retry,
 *    and so does a task an agent is bound to that was waiting on its own sub-tasks. A
 *    plan's later steps stay behind their blocker, so a Retry of that one carries the plan
 *    on. A task with no agent goes on saying it has none.
 * The caller stops the runs going on `taskIds`.
 */
export function stopJob(db: ClawbooDb, jobTaskId: string, person: PersonRecord): StopJobResult {
  const now = Date.now()
  const result = immediateWrite(db, (tx): StopJobResult => {
    const row = jobRunRowOf(tx, jobTaskId)
    if (!row || !jobCardStands(tx, row)) return { ok: false, reason: 'no_card' }
    tx.update(jobRuns)
      .set({ stoppedAt: now, stoppedBy: personJson(person), limitHitAt: null, updatedAt: now })
      .where(eq(jobRuns.jobTaskId, jobTaskId))
      .run()
    const ids = tasksOfJob(tx, jobTaskId)
    tx.update(taskWakes)
      .set({ heldAt: now, updatedAt: now })
      .where(
        and(
          inArray(taskWakes.taskId, ids),
          isNull(taskWakes.settledAt),
          isNull(taskWakes.carriedExecId),
          isNull(taskWakes.heldAt),
        ),
      )
      .run()
    tx.update(reportUpOutbox)
      .set({ heldAt: now })
      .where(
        and(
          inArray(reportUpOutbox.taskId, ids),
          isNull(reportUpOutbox.settledAt),
          isNull(reportUpOutbox.heldAt),
        ),
      )
      .run()
    const open = tx
      .select()
      .from(tasks)
      .where(
        and(
          inArray(tasks.id, ids),
          inArray(tasks.status, ['todo', 'blocked']),
          eq(tasks.dropped, 0),
        ),
      )
      .all() as DbTask[]
    for (const task of open) {
      const wait = parseWaitingOn(task.waitingOn)
      if (task.status === 'blocked') {
        if (wait?.kind !== 'subtasks' || !delegationTargetOf(task.sourceDelegationId)) continue
        if (!updateStatus(db, task.id, 'todo').ok) continue
      } else if (!pumpCouldStart(tx, task)) continue
      // The mark a person's Stop leaves, which the fire policy and Needs you both read.
      const stop = createExecutionProcess(db, {
        taskId: task.id,
        executorType: 'openclaw',
        engineRun: true,
      })
      completeExecutionProcess(db, stop.id, { status: 'cancelled', byPerson: true })
      if (waitsToStartByItself(wait)) setTaskWaitingOn(db, task.id, null)
    }
    return { ok: true, taskIds: ids }
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
