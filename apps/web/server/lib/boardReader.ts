// Who a request reads and writes the board as, for a person's inbox.
//
// One seam. On an install with no sign-in there is one built-in reader, whose id is
// the built-in person's (`local`, see LOCAL_PERSON), so their read state needs no move.
// Behind a sign-in proxy each verified person is their own reader.

import type { Request } from 'express'

import { parseWaitingOn } from '@clawboo/board-core'
import {
  getTask,
  listTasks,
  markTaskRead,
  readerOfPerson,
  taskReadStates,
  type ClawbooDb,
  type DbTask,
  type TaskActivity,
  type TaskReadState,
} from '@clawboo/db'
import { createLogger } from '@clawboo/logger'

import { actsAsPerson, personOf } from './auth'

const log = createLogger('board-reader')

/** The statuses a chat room's engine can stop a task in, and where it puts them. */
const RUNNING_STATUSES = ['in_progress', 'in_review'] as const
const RELEASED_TO = 'todo'

/** Whose read state this request reads. */
export function readerOf(req: Request): string {
  return readerOfPerson(personOf(req))
}

/**
 * The reader this request writes as, or null when nothing says a person sent it, so
 * its writes count as someone else's and it cannot mark anything read. The same person
 * check as every person write: a speed bump locally, not a boundary. See actsAsPerson.
 */
export function ownWriterOf(req: Request): string | null {
  return actsAsPerson(req) ? readerOf(req) : null
}

/**
 * Run a person's Stop, or anything else that stops a chat room's work.
 *
 * The engine does the releasing and knows nothing about who asked, so its writes look
 * like anyone else's, and each stopped task would come back as "Moved to To do" for the
 * person who pressed Stop. So this says it for them afterwards, from the route: a task
 * that was running in this room, is back in To do, and whose newest change is that move.
 * An agent finishing as the Stop lands, or a late result after it, stays news.
 *
 * This is the seam for how Stop works. The engine is untouched: only `RELEASED_TO`
 * knows where a stopped task goes.
 */
export async function stopAsOwnWrite(
  db: ClawbooDb,
  reader: string | null,
  scope: { teamId: string; roomId: string | null },
  stop: () => Promise<void>,
): Promise<void> {
  if (!reader) return stop()
  const running = RUNNING_STATUSES.flatMap((status) =>
    listTasks(db, { teamId: scope.teamId, roomId: scope.roomId, status }).map((t) => t.id),
  )
  // A task waiting on its sub-tasks has no run, and a Stop ends that wait the same way.
  for (const t of listTasks(db, { teamId: scope.teamId, roomId: scope.roomId, status: 'blocked' }))
    if (parseWaitingOn(t.waitingOn)?.kind === 'subtasks') running.push(t.id)
  await stop()
  markReleasedTasksRead(db, reader, running)
}

/** The tasks a person's pause would release, by the same reading as Stop: what is
 *  running now, of what it covers. */
export function runningTasksCovered(db: ClawbooDb, covers: (task: DbTask) => boolean): string[] {
  return RUNNING_STATUSES.flatMap((status) =>
    listTasks(db, { status })
      .filter(covers)
      .map((t) => t.id),
  )
}

/** Mark read each of these that a person's own act released: back in To do, with that
 *  move as its newest change. Anything else that happened to it stays news. */
export function markReleasedTasksRead(db: ClawbooDb, reader: string, ids: readonly string[]): void {
  try {
    const states = taskReadStates(db, reader)
    for (const id of ids) {
      const activity = states.get(id)?.activity
      if (activity?.kind !== 'status' || getTask(db, id)?.status !== RELEASED_TO) continue
      markTaskRead(db, reader, id, activity.seq)
    }
  } catch (err) {
    // What stopped them is done. At worst the person sees these as unread.
    log.warn({ err }, 'marking the stopped tasks read failed')
  }
}

export interface RowReadState {
  unread: boolean
  /** The task's newest change, or null when it was last changed before the board
   *  kept this record. `activity.seq` is what the page marks read through. */
  activity: TaskActivity | null
}

const NOTHING_NEW: RowReadState = { unread: false, activity: null }

/** The read state of these rows for this request's reader. The board still loads
 *  when this cannot be read: nothing shows as unread until the next read. */
export function withReadState<T extends { id: string }>(
  db: ClawbooDb,
  req: Request,
  rows: readonly T[],
): Array<T & RowReadState> {
  let states: Map<string, TaskReadState>
  try {
    // One row, as when the drawer opens a task, need not read the whole board's.
    states = taskReadStates(db, readerOf(req), rows.length === 1 ? { taskId: rows[0]!.id } : {})
  } catch (err) {
    log.warn({ err }, 'reading the read state failed')
    states = new Map()
  }
  return rows.map((t) => ({ ...t, ...(states.get(t.id) ?? NOTHING_NEW) }))
}
