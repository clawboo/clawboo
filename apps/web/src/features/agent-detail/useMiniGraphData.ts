import { useEffect, useMemo, useState } from 'react'
import { useConnectionStore } from '@/stores/connection'
import { useFleetStore } from '@/stores/fleet'
import { useGraphStore } from '@/features/graph/store'
import { buildGraphElements } from '@/features/graph/useGraphData'
import type { GraphNode, GraphEdge } from '@/features/graph/types'

// ─── useMiniGraphData ────────────────────────────────────────────────────────
//
// Fetches TOOLS.md + AGENTS.md for a single agent and builds graph nodes/edges
// using the shared `buildGraphElements` function. State is local — NOT stored
// in useGraphStore to avoid interference with the fleet-wide Ghost Graph.

export function useMiniGraphData(agentId: string): {
  nodes: GraphNode[]
  edges: GraphEdge[]
  isLoading: boolean
} {
  const client = useConnectionStore((s) => s.client)
  const agents = useFleetStore((s) => s.agents)
  const refreshKey = useGraphStore((s) => s.refreshKey)

  const [agentFiles, setAgentFiles] = useState<
    Map<string, { toolsMd: string | null; agentsMd: string | null }>
  >(new Map())
  const [isLoading, setIsLoading] = useState(true)

  // Find the single agent
  const agent = useMemo(() => agents.find((a) => a.id === agentId) ?? null, [agents, agentId])

  // Fetch TOOLS.md + AGENTS.md for this agent
  useEffect(() => {
    if (!client || !agentId) return

    let cancelled = false
    setIsLoading(true)

    const fetchFiles = async () => {
      const [toolsMd, agentsMd] = await Promise.all([
        client.agents.files.read(agentId, 'TOOLS.md').catch(() => null),
        client.agents.files.read(agentId, 'AGENTS.md').catch(() => null),
      ])
      if (cancelled) return

      const map = new Map<string, { toolsMd: string | null; agentsMd: string | null }>()
      map.set(agentId, { toolsMd, agentsMd })
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
    const { rawNodes, rawEdges } = buildGraphElements([agent], agentFiles)
    return { nodes: rawNodes, edges: rawEdges }
  }, [agent, agentFiles])

  return { nodes, edges, isLoading }
}
