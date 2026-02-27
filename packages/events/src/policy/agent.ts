import type { ClassifiedEvent, EventIntent } from '../types'

// ── decideAgentEvent ───────────────────────────────────────────────────────

export function decideAgentEvent(event: ClassifiedEvent): EventIntent[] {
  // heartbeat → also refresh heartbeat latest snapshot
  const includeHeartbeatRefresh = event.raw.event === 'heartbeat'
  return [
    {
      kind: 'scheduleSummaryRefresh',
      plane: 'agent',
      delayMs: 750,
      includeHeartbeatRefresh,
    },
  ]
}
