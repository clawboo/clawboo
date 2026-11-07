// Who a request reads and writes the board as, for a person's inbox.
//
// One seam. On an install with no sign-in there is one built-in reader. Behind a
// sign-in proxy each verified person is their own reader. A built-in local person,
// when there is one, changes `readerOf` and nothing else.

import type { Request } from 'express'

import {
  getTask,
  listTasks,
  LOCAL_READER,
  markTaskRead,
  taskReadStates,
  type ClawbooDb,
  type TaskActivity,
  type TaskReadState,
} from '@clawboo/db'
import { createLogger } from '@clawboo/logger'

import { personOf } from './auth'
import { isDashboardRequest } from './dashboardRequest'

const log = createLogger('board-reader')

/** The statuses a chat room's engine can stop a task in, and where it puts them. */
const RUNNING_STATUSES = ['in_progress', 'in_review'] as const
const RELEASED_TO = 'todo'

/** Whose read state this request reads. */
export function readerOf(req: Request): string {
  const person = personOf(req)
  return person ? `person:${person.id}` : LOCAL_READER
}

/**
 * The reader this request writes as, or null when nothing says a person sent it, so
 * its writes count as someone else's and it cannot mark anything read. The
 * dashboard's own page is a speed bump, not a boundary: see isDashboardRequest.
 */
export function ownWriterOf(req: Request): string | null {
  return personOf(req) || isDashboardRequest(req) ? readerOf(req) : null
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
  await stop()
  try {
    const states = taskReadStates(db, reader)
    for (const id of running) {
      const activity = states.get(id)?.activity
      if (activity?.kind !== 'status' || getTask(db, id)?.status !== RELEASED_TO) continue
      markTaskRead(db, reader, id, activity.seq)
    }
  } catch (err) {
    // The Stop itself is done. At worst the person sees these as unread.
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
