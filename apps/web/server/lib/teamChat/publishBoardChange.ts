// Publish a board change to the team's open chat streams with the task's
// needs-you state and chat room attached, so a chat card can say "Failed" or
// "Stopped" the moment it happens instead of reading as queued work until the
// next reload, and each room's chat and Tasks card show only their own tasks.
//
// Only an open stream will read the result, so the DB reads are skipped when
// nobody is listening. Only a change that moves a task's status can change
// whether it needs a person, so the attention read is skipped for everything
// else; the room is one primary-key read.

import { attentionForTask, getTask, type ClawbooDb, type TaskAttention } from '@clawboo/db'
import type { BoardChange } from '@clawboo/team-orchestration'

import { hasBoardChangeSubscribers, publishBoardChange } from './boardChangeBus'

/** A board change as the chat stream sends it: the engine's change plus the
 *  task's chat room (null = the team's default room). */
export type RoomedBoardChange = BoardChange & { roomId?: string | null }

export function publishBoardChangeWithAttention(
  db: ClawbooDb,
  teamId: string,
  change: BoardChange,
): void {
  if (!hasBoardChangeSubscribers(teamId)) return
  let roomId: string | null | undefined
  try {
    roomId = getTask(db, change.id)?.roomId ?? null
  } catch {
    // Best-effort: without it the client keeps the room it already knew.
  }
  const roomed: RoomedBoardChange = roomId === undefined ? change : { ...change, roomId }
  if (change.status === undefined) {
    publishBoardChange(teamId, roomed)
    return
  }
  let attention: TaskAttention | null = null
  try {
    attention = attentionForTask(db, change.id)
  } catch {
    // Best-effort enrichment: the frame still carries the status, and the next
    // board reload corrects the badge.
  }
  publishBoardChange(teamId, { ...roomed, attention })
}
