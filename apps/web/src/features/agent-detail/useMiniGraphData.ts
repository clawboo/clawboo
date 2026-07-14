import { readAgentFile } from '@clawboo/control-client'
import { fetchCapabilities, groupAgentCapabilities } from '@/lib/capabilitiesClient'
import type { CapabilityRecord } from '@clawboo/capability-registry'
import { useEffect, useMemo, useState } from 'react'
import { useConnectionStore } from '@/stores/connection'
import { useFleetStore } from '@/stores/fleet'
import { useGraphStore } from '@/features/graph/store'
import { buildGraphElements } from '@/features/graph/useGraphData'
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

  const [agentFiles, setAgentFiles] = useState<
    Map<string, { capabilities: CapabilityRecord[] | null; agentsMd: string | null }>
  >(new Map())
  const [isLoading, setIsLoading] = useState(true)

  // Find the single agent
  const agent = useMemo(() => agents.find((a) => a.id === agentId) ?? null, [agents, agentId])

  // Fetch the agent's capabilities + AGENTS.md
  useEffect(() => {
    if (!client || !agentId) return

    let cancelled = false
    setIsLoading(true)

    const fetchFiles = async () => {
      const [capView, agentsMd] = await Promise.all([
        fetchCapabilities({ agentId }),
        readAgentFile(agentId, 'AGENTS.md').catch(() => null),
      ])
      if (cancelled) return

      const capabilities = groupAgentCapabilities(capView.records).get(agentId) ?? []
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
  }, [client, agentId, refreshKey])

  // Build graph elements for this single agent
  const { nodes, edges } = useMemo(() => {
    if (!agent || agentFiles.size === 0) return { nodes: [], edges: [] }
    // The runtime badge (on the Boo) and the model orbital both show in the
    // MiniGraph too — the single-agent view mirrors the Atlas graph.
    const { rawNodes, rawEdges } = buildGraphElements([agent], agentFiles)
    return { nodes: rawNodes, edges: rawEdges }
  }, [agent, agentFiles])

  return { nodes, edges, isLoading }
}
