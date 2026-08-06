// ─── Cap-hit audit wiring ────────────────────────────────────────────────────
// The orchestration engine has fired `onCapHit` since the caps shipped, and the
// Governance dashboard + guides document a cap hit as a `cap_hit` row in the audit
// feed — but nothing was ever wired to the callback, so that trail was never
// written and `eventType=cap_hit` always came back empty. This is the wiring.
//
// A named helper rather than an inline closure so it is unit-testable without
// booting a whole team orchestrator.

import { appendAudit, type ClawbooDb } from '@clawboo/db'
import { createLogger } from '@clawboo/logger'

const log = createLogger('teamchat:cap-hit')

export interface CapHitInfo {
  kind: 'fanout'
  sourceTaskId: string | null
}

/**
 * Record a cap hit in the forensic audit log. BEST-EFFORT and never throws: the
 * engine calls this from inside its spawn loop, so an audit write that failed must
 * not abort a cascade. Same discipline as the room reflections and the board bus —
 * observability never breaks the write path.
 */
export function auditCapHit(db: ClawbooDb, teamId: string, info: CapHitInfo, max: number): void {
  try {
    appendAudit(db, {
      eventType: 'cap_hit',
      teamId,
      taskId: info.sourceTaskId,
      summary: { kind: info.kind, max },
    })
  } catch (err) {
    log.debug({ teamId, kind: info.kind, err }, 'cap-hit audit write failed (ignored)')
  }
}
