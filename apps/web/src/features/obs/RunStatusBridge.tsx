// Headless bridge: obs execution events → fleet status, so the graph is alive
// during board runs.
//
// Mounted once at the app root next to `GatewayBootstrap` (the same
// renders-nothing, does-one-global-job shape). It has to be global rather than
// living inside the graph: the fleet store also feeds the left-pane Working/Idle
// badges, and a board run should light those up whether or not Atlas is open.
//
// Cost is one EventSource for the whole app. It carries a small backfill because
// `deriveRunStatus` needs enough window to see the `execution_started` of a run
// that began before this tab did.

import { useEffect } from 'react'

import { useFleetStore } from '@/stores/fleet'
import { useRunActivityStore } from '@/stores/runActivity'

import { deriveAgentActivity } from './deriveAgentActivity'
import { deriveRunStatus } from './deriveRunStatus'
import { useObsStream } from './useObsStream'

/** Enough rows to cover a run in flight without holding a long tail in memory. */
const BACKFILL = 150

/** True when two agent→line maps carry the same pairs. */
function sameLines(a: Map<string, string>, b: Map<string, string>): boolean {
  if (a.size !== b.size) return false
  for (const [k, v] of a) if (b.get(k) !== v) return false
  return true
}

export function RunStatusBridge(): null {
  const { events } = useObsStream({}, { limit: BACKFILL })
  // The fleet loads independently of the event tail, and either can win the
  // race. Without this key the effect runs once against an empty fleet, every
  // `agents.find` misses, and the statuses are never applied — the graph stays
  // dark exactly as if the bridge were not mounted. Keyed on the id SET rather
  // than the array so applying a status (which replaces the array) cannot
  // retrigger it.
  const agentIdKey = useFleetStore((s) =>
    s.agents
      .map((a) => a.id)
      .sort()
      .join(','),
  )

  useEffect(() => {
    if (events.length === 0 || agentIdKey === '') return

    const derived = deriveRunStatus(events)
    if (derived.size > 0) {
      // Read once, patch only what actually changed. `updateAgentStatus` replaces
      // the agents array, so patching unconditionally would re-render every
      // subscriber on each event frame.
      const { agents, updateAgentStatus } = useFleetStore.getState()
      for (const [agentId, status] of derived) {
        const current = agents.find((a) => a.id === agentId)
        if (!current || current.status === status) continue
        updateAgentStatus(agentId, status)
      }
    }

    // Same guard for the activity lines: a new Map identity on every frame would
    // wake every card that reads this store, including for unrelated agents.
    const lines = deriveAgentActivity(events)
    const { byAgent, setAll } = useRunActivityStore.getState()
    if (!sameLines(lines, byAgent)) setAll(lines)
  }, [events, agentIdKey])

  return null
}
