// The engine's durable `[Task Update]` outbox for one team chat room, kept in
// report_up_outbox. The engine writes each report-up here as it queues it and
// settles it when the recipient's run that carried it ends; the room's next
// engine replays whatever is still pending, so a restart is a pause for a
// hand-off result rather than its loss. Every call is best-effort: a failed
// write is logged and the report-up still goes out from memory, as before.

import {
  listPendingReportUps,
  markReportUpsReplayed,
  recordReportUp,
  settleReportUps,
  type ClawbooDb,
} from '@clawboo/db'
import { createLogger } from '@clawboo/logger'
import type { ReportUp, ReportUpOutbox } from '@clawboo/team-orchestration'

const log = createLogger('report-up-outbox')

const optionalString = (v: unknown): boolean => v === undefined || typeof v === 'string'

/** A stored payload read back as the engine's item, or null when it is not one. */
function parseReportUp(payload: string): ReportUp | null {
  let v: unknown
  try {
    v = JSON.parse(payload)
  } catch {
    return null
  }
  if (typeof v !== 'object' || v === null) return null
  const o = v as Record<string, unknown>
  if (o['toAgentId'] !== null && typeof o['toAgentId'] !== 'string') return null
  if (typeof o['by'] !== 'string' || typeof o['summary'] !== 'string') return null
  for (const key of ['title', 'outcome', 'taskId', 'forTaskId'])
    if (!optionalString(o[key])) return null
  return o as unknown as ReportUp
}

export function createReportUpOutbox(
  db: ClawbooDb,
  teamId: string,
  roomId: string | null,
): ReportUpOutbox {
  return {
    record(item) {
      try {
        return recordReportUp(db, {
          teamId,
          roomId,
          recipientAgentId: item.toAgentId,
          taskId: item.taskId ?? null,
          payload: JSON.stringify(item),
        })
      } catch (err) {
        log.error({ err, teamId, roomId }, 'report-up outbox write failed')
        return null
      }
    },
    pending() {
      try {
        const out: Array<{ id: string; item: ReportUp; replays: number }> = []
        for (const row of listPendingReportUps(db, teamId, roomId)) {
          const item = parseReportUp(row.payload)
          if (item) {
            out.push({ id: row.id, item, replays: row.replays })
            continue
          }
          // Unreadable: settle it, or the boot scan would keep waking the room.
          log.error({ teamId, roomId, id: row.id }, 'unreadable report-up dropped')
          settleReportUps(db, [row.id], 'gave_up')
        }
        return out
      } catch (err) {
        log.error({ err, teamId, roomId }, 'report-up outbox read failed')
        return []
      }
    },
    markReplayed(ids) {
      try {
        markReportUpsReplayed(db, ids)
        return true
      } catch (err) {
        log.error({ err, teamId, roomId }, 'report-up replay count failed')
        return false
      }
    },
    settle(ids, how) {
      try {
        settleReportUps(db, ids, how)
        return true
      } catch (err) {
        log.error({ err, teamId, roomId, how }, 'report-up settle failed')
        return false
      }
    },
  }
}
