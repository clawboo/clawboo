// The event-sourced live overlay for the Ghost Graph (the "moderate" graph-over-
// event-log wiring). Polls the projected graph + fleet-health and exposes
// per-agent status/cost + agent→agent delegation edges, so the team graph's LIVE
// layer is sourced from the append-only event log (it can't drift). The
// STRUCTURAL roster derivation (useGraphData.ts + @mention org chart) is
// untouched — this only augments.

import { useEffect, useState } from 'react'

export type ObsAgentStatus = 'working' | 'idle' | 'stalled' | 'zombie'

export interface ObsOverlay {
  status: Map<string, ObsAgentStatus>
  cost: Map<string, number>
  delegations: { source: string; target: string }[]
}

const EMPTY: ObsOverlay = { status: new Map(), cost: new Map(), delegations: [] }

export function useObsGraphOverlay(teamId: string | null): ObsOverlay {
  const [overlay, setOverlay] = useState<ObsOverlay>(EMPTY)

  useEffect(() => {
    let alive = true
    const load = async (): Promise<void> => {
      try {
        const q = teamId ? `?teamId=${encodeURIComponent(teamId)}` : ''
        const [hRes, gRes] = await Promise.all([
          fetch(`/api/obs/health${q}`),
          fetch(`/api/obs/graph${q}`),
        ])
        if (!alive || !hRes.ok || !gRes.ok) return
        const h = (await hRes.json()) as {
          agents: { agentId: string; status: ObsAgentStatus; costUsd: number }[]
        }
        const g = (await gRes.json()) as { agentEdges: { source: string; target: string }[] }
        const status = new Map<string, ObsAgentStatus>()
        const cost = new Map<string, number>()
        for (const a of h.agents) {
          status.set(a.agentId, a.status)
          cost.set(a.agentId, a.costUsd)
        }
        setOverlay({
          status,
          cost,
          delegations: g.agentEdges.map((e) => ({ source: e.source, target: e.target })),
        })
      } catch {
        /* best-effort */
      }
    }
    void load()
    const id = setInterval(() => void load(), 5000)
    return () => {
      alive = false
      clearInterval(id)
    }
  }, [teamId])

  return overlay
}
