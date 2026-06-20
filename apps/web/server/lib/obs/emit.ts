// The single choke-point for writing an orchestration event. Best-effort by
// discipline: a failed append must never throw on the orchestration hot path.

import { appendEvent, type AppendEventInput, type ClawbooDb } from '@clawboo/db'

export function emitEvent(db: ClawbooDb, input: AppendEventInput): void {
  try {
    appendEvent(db, input)
  } catch {
    /* observability is best-effort — never throw on the orchestration hot path */
  }
}
