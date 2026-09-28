// Publish a board change to the team's open chat streams with the task's
// needs-you state attached, so a chat card can say "Failed" or "Stopped" the
// moment it happens instead of reading as queued work until the next reload.
//
// Only a change that moves a task's status can change whether it needs a person,
// and only an open stream will read the result, so the DB read is skipped for
// everything else.

import { attentionForTask, type ClawbooDb, type TaskAttention } from '@clawboo/db'
import type { BoardChange } from '@clawboo/team-orchestration'

import { hasBoardChangeSubscribers, publishBoardChange } from './boardChangeBus'

export function publishBoardChangeWithAttention(
  db: ClawbooDb,
  teamId: string,
  change: BoardChange,
): void {
  if (!hasBoardChangeSubscribers(teamId)) return
  if (change.status === undefined) {
    publishBoardChange(teamId, change)
    return
  }
  let attention: TaskAttention | null = null
  try {
    attention = attentionForTask(db, change.id)
  } catch {
    // Best-effort enrichment: the frame still carries the status, and the next
    // board reload corrects the badge.
  }
  publishBoardChange(teamId, { ...change, attention })
}
