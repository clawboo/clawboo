import { readAgentFile } from '@clawboo/control-client'
import { fetchCapabilities, groupAgentCapabilities } from '@/lib/capabilitiesClient'
import type { CapabilityRecord } from '@clawboo/capability-registry'
import { useEffect, useMemo, useState } from 'react'
import { useConnectionStore } from '@/stores/connection'
import { useFleetStore } from '@/stores/fleet'
import { useGraphStore } from '@/features/graph/store'
import { buildGraphElements } from '@/features/graph/useGraphData'
import { useOpenclawDefaultModel } from '@/lib/openclawDefaultModel'
import type { GraphNode, GraphEdge } from '@/features/graph/types'

// ─── useMiniGraphData ────────────────────────────────────────────────────────
//
// Fetches the agent's capability inventory (+ AGENTS.md for routing) and builds
// graph nodes/edges via the shared `buildGraphElements`. State is local — NOT
// stored in useGraphStore to avoid interference with the fleet-wide Ghost Graph.

export function useMiniGraphData(agentId: string): {
  nodes: GraphNode[]
  edges: GraphEdge[]
  isLoading: boolean
} {
  const client = useConnectionStore((s) => s.client)
  const agents = useFleetStore((s) => s.agents)
  const refreshKey = useGraphStore((s) => s.refreshKey)
  // OpenClaw agents keep their model Gateway-side — fall back to the Gateway
  // default so the orbital agrees with the agent-detail selector's "Default (…)".
  const openclawDefaultModel = useOpenclawDefaultModel()

  const [agentFiles, setAgentFiles] = useState<
    Map<string, { capabilities: CapabilityRecord[] | null; agentsMd: string | null }>
  >(new Map())
  const [isLoading, setIsLoading] = useState(true)

  // Find the single agent
  const agent = useMemo(() => agents.find((a) => a.id === agentId) ?? null, [agents, agentId])

  // Fetch the agent's capabilities + AGENTS.md.
  //
  // NOT gated on a Gateway `client` (same as `useGraphData`): both reads are REST,
  // so they must run in NATIVE / thin-client mode where `client === null`.
  useEffect(() => {
    if (!agentId) return

    let cancelled = false
    setIsLoading(true)

    const fetchFiles = async () => {
      const [capView, agentsMd] = await Promise.all([
        // UNFILTERED — the same ONE stream the Atlas + dashboard read. A server
        // `?agentId=` filter drops every `scope:'global'` record (they carry
        // `agentId: null`, and the filter is `r.agentId !== f.agentId`), which is
        // exactly what the inherit-if-empty fan-out needs: an agent with no
        // per-agent caps (codex / OpenClaw / a not-yet-run hermes) would inherit
        // NOTHING and render bare. `groupAgentCapabilities` scopes to this agent
        // client-side, so the filter bought nothing but the bug.
        fetchCapabilities(),
        readAgentFile(agentId, 'AGENTS.md').catch(() => null),
      ])
      if (cancelled) return

      // The agent's runtime feeds the inherit-if-empty fan-out (an agent with no
      // per-agent caps inherits its runtime's shared caps). Read fresh from the
      // store so it can't go stale in this effect's closure.
      const rt = useFleetStore.getState().agents.find((a) => a.id === agentId)?.runtime ?? null
      const capabilities =
        groupAgentCapabilities(capView.records, new Map([[agentId, rt]])).get(agentId) ?? []
      const map = new Map<
        string,
        { capabilities: CapabilityRecord[] | null; agentsMd: string | null }
      >()
      map.set(agentId, { capabilities, agentsMd })
      setAgentFiles(map)
      setIsLoading(false)
    }

    void fetchFiles()
    return () => {
      cancelled = true
    }
    // `client` stays a DEP (not a gate): a null→connected transition re-runs the
    // fetch so an OpenClaw agent's AGENTS.md that 503'd while the Gateway was
    // down is picked up on reconnect.
  }, [client, agentId, refreshKey])

  // Build graph elements for this single agent
  const { nodes, edges } = useMemo(() => {
    if (!agent || agentFiles.size === 0) return { nodes: [], edges: [] }
    // The runtime badge (on the Boo) and the model orbital both show in the
    // MiniGraph too — the single-agent view mirrors the Atlas graph. The trailing
    // args are buildGraphElements' team/scope defaults; only the last
    // (openclawDefaultModel) is non-default here so the OpenClaw model orbital
    // resolves instead of showing "Gateway model".
    const { rawNodes, rawEdges } = buildGraphElements(
      [agent],
      agentFiles,
      [],
      null,
      null,
      null,
      'team',
      null,
      false,
      openclawDefaultModel,
    )
    return { nodes: rawNodes, edges: rawEdges }
  }, [agent, agentFiles, openclawDefaultModel])

  return { nodes, edges, isLoading }
}
