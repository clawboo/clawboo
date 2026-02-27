import type { ClassifiedEvent, EventIntent } from '../types'

// ── decideTrustEvent ───────────────────────────────────────────────────────

export function decideTrustEvent(event: ClassifiedEvent): EventIntent[] {
  const agentId = event.agentId
  if (!agentId) {
    return [{ kind: 'ignore', reason: 'approval event missing agentId' }]
  }

  if (event.raw.event === 'exec.approval.pending') {
    return [{ kind: 'approvalPending', plane: 'trust', agentId, payload: event.payload }]
  }

  return [{ kind: 'approvalResolved', plane: 'trust', agentId, payload: event.payload }]
}
