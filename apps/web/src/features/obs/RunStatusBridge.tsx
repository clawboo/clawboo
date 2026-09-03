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

import { useEffect, useRef } from 'react'

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

  // How far this bridge has folded, and for whom.
  //
  // The tail is a WINDOW, not a history. A completed execution stays in it long
  // after the run ended, so re-folding the whole window on every frame keeps
  // re-asserting `idle` for that agent. Once a CHAT run has marked the same
  // agent running, the next unrelated event resets it to idle underneath a live
  // run, which is the exact clobber `deriveRunStatus` documents itself as
  // avoiding (it only manages it for agents the window is SILENT about).
  //
  // So only NEW evidence may move an agent already folded. An agent never folded
  // still gets the whole window once, because the fleet routinely hydrates after
  // the backfill lands and that agent's `execution_started` may exist only back
  // there. That is the race the `agentIdKey` dependency exists to fix, and it
  // has to keep working.
  const appliedSeq = useRef(0)
  const folded = useRef<Set<string>>(new Set())

  useEffect(() => {
    if (events.length === 0 || agentIdKey === '') return

    const { agents } = useFleetStore.getState()
    const maxSeq = events[events.length - 1]?.seq ?? appliedSeq.current
    const derived = deriveRunStatus(events.filter((e) => e.seq > appliedSeq.current))

    const unseen = agents.filter((a) => !folded.current.has(a.id))
    if (unseen.length > 0) {
      const fromWindow = deriveRunStatus(events)
      for (const a of unseen) {
        const status = fromWindow.get(a.id)
        // Fresh evidence outranks the backfill for the same agent.
        if (status !== undefined && !derived.has(a.id)) derived.set(a.id, status)
      }
    }
    for (const a of agents) folded.current.add(a.id)
    appliedSeq.current = Math.max(appliedSeq.current, maxSeq)

    if (derived.size > 0) {
      // Read once, patch only what actually changed. `updateAgentStatus` replaces
      // the agents array, so patching unconditionally would re-render every
      // subscriber on each event frame.
      const { agents: live, updateAgentStatus } = useFleetStore.getState()
      for (const [agentId, status] of derived) {
        const current = live.find((a) => a.id === agentId)
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
