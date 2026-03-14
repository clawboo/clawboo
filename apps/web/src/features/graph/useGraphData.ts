import { useEffect, useMemo } from 'react'
import { useFleetStore } from '@/stores/fleet'
import { useConnectionStore } from '@/stores/connection'
import { useTeamStore } from '@/stores/team'
import { useGraphStore } from './store'
import { parseToolsMd } from './parsers/parseToolsMd'
import { parseAgentsMd } from './parsers/parseAgentsMd'
import type { AgentState } from '@/stores/fleet'
import type { GraphNode, GraphEdge, BooNodeData, SkillNodeData, ResourceNodeData } from './types'

// ─── useGraphData ─────────────────────────────────────────────────────────────
//
// Fetches TOOLS.md + AGENTS.md for each agent and converts them into React Flow
// nodes + edges stored in useGraphStore.
//
// Two separate update paths:
//   1. Structural rebuild — when agents are added/removed or files change.
//   2. Status-only patch  — when an agent's runtime status changes (no layout re-trigger).

export function useGraphData(): void {
  const agents = useFleetStore((s) => s.agents)
  const client = useConnectionStore((s) => s.client)
  const selectedTeamId = useTeamStore((s) => s.selectedTeamId)
  const { setAgentFiles, setLoadingFiles, setFilesError, agentFiles, refreshKey } = useGraphStore()

  // Filter agents by selected team (null = show all)
  const filteredAgents = useMemo(
    () => (selectedTeamId ? agents.filter((a) => a.teamId === selectedTeamId) : agents),
    [agents, selectedTeamId],
  )

  // Stable string keys for dependency comparison
  const agentStructureKey = filteredAgents.map((a) => `${a.id}:${a.name}`).join('|')
  const agentStatusKey = filteredAgents.map((a) => `${a.id}:${a.status}`).join('|')

  // Stable agent ID array (recomputed only when structure changes)
  const agentIds = useMemo(
    () => filteredAgents.map((a) => a.id),
    [agentStructureKey], // intentionally using string key, not full agents array
  )

  // ── 1. File fetching ─────────────────────────────────────────────────────────
  useEffect(() => {
    if (!client || agentIds.length === 0) return

    let cancelled = false
    setLoadingFiles(true)
    setFilesError(null)

    const fetchAll = async () => {
      const tasks = agentIds.flatMap((agentId) => [
        client.agents.files
          .read(agentId, 'TOOLS.md')
          .then((content) => ({ agentId, file: 'toolsMd' as const, content }))
          .catch(() => ({ agentId, file: 'toolsMd' as const, content: null })),
        client.agents.files
          .read(agentId, 'AGENTS.md')
          .then((content) => ({ agentId, file: 'agentsMd' as const, content }))
          .catch(() => ({ agentId, file: 'agentsMd' as const, content: null })),
      ])

      const results = await Promise.all(tasks)
      if (cancelled) return

      for (const { agentId, file, content } of results) {
        setAgentFiles(agentId, { [file]: content })
      }
      setLoadingFiles(false)
    }

    void fetchAll()
    return () => {
      cancelled = true
    }
  }, [client, agentStructureKey, refreshKey]) // intentional: string key covers structural changes; refreshKey for skill install

  // ── 2. Structural rebuild ────────────────────────────────────────────────────
  const { rawNodes, rawEdges } = useMemo(
    () => buildGraphElements(filteredAgents, agentFiles),
    [agentStructureKey, agentFiles], // intentional: string key for agents
  )

  useEffect(() => {
    // Preserve positions already assigned by ELK or user drag
    const { nodes: existingNodes } = useGraphStore.getState()
    const positions = new Map(existingNodes.map((n) => [n.id, n.position]))

    const nodesWithPositions = rawNodes.map((n) => ({
      ...n,
      position: positions.get(n.id) ?? n.position,
    }))

    useGraphStore.getState().setNodes(nodesWithPositions as GraphNode[])
    useGraphStore.getState().setEdges(rawEdges)
  }, [rawNodes, rawEdges])

  // ── 3. Status-only patch ─────────────────────────────────────────────────────
  useEffect(() => {
    const store = useGraphStore.getState()
    if (store.nodes.length === 0) return

    const agentMap = new Map(filteredAgents.map((a) => [a.id, a]))

    const patched = store.nodes.map((node) => {
      if (node.type !== 'boo') return node
      const data = node.data as BooNodeData
      const agent = agentMap.get(data.agentId)
      if (!agent) return node
      return {
        ...node,
        data: {
          ...data,
          status: agent.status ?? 'idle',
          isStreaming: agent.status === 'running',
        } as BooNodeData,
      }
    })

    store.setNodes(patched as GraphNode[])
  }, [agentStatusKey]) // intentional: string key covers status-only changes
}

// ─── Build graph elements (pure function) ────────────────────────────────────

export function buildGraphElements(
  agents: AgentState[],
  agentFiles: Map<string, { toolsMd: string | null; agentsMd: string | null }>,
): { rawNodes: GraphNode[]; rawEdges: GraphEdge[] } {
  const depEdges: GraphEdge[] = []
  const skillNodes: GraphNode[] = []
  const skillEdges: GraphEdge[] = []
  const resourceNodes: GraphNode[] = []
  const resourceEdges: GraphEdge[] = []

  const agentNames = agents.map((a) => a.name)
  const agentNameToId = new Map(agents.map((a) => [a.name.toLowerCase().trim(), a.id]))

  // BooNodes — one per agent
  const booNodes: GraphNode[] = agents.map((agent) => ({
    id: `boo-${agent.id}`,
    type: 'boo' as const,
    data: {
      agentId: agent.id,
      name: agent.name,
      status: agent.status ?? 'idle',
      model: agent.model,
      isStreaming: agent.status === 'running',
    } satisfies BooNodeData,
    position: { x: 0, y: 0 },
  }))

  for (const agent of agents) {
    const files = agentFiles.get(agent.id)

    // TOOLS.md → per-agent SkillNodes + ResourceNodes
    if (files?.toolsMd) {
      const { skills, resources } = parseToolsMd(files.toolsMd)

      for (const skill of skills) {
        const nodeId = `skill-${agent.id}-${skill.id}`
        skillNodes.push({
          id: nodeId,
          type: 'skill' as const,
          data: {
            skillId: skill.id,
            name: skill.name,
            category: skill.category,
            description: skill.description,
            agentIds: [agent.id],
          } satisfies SkillNodeData,
          position: { x: 0, y: 0 },
        })
        skillEdges.push({
          id: `skilledge-${agent.id}-${skill.id}`,
          type: 'skill',
          source: `boo-${agent.id}`,
          sourceHandle: 'center',
          target: nodeId,
          targetHandle: 'center',
          data: {},
        })
      }

      for (const resource of resources) {
        const nodeId = `resource-${agent.id}-${resource.id}`
        resourceNodes.push({
          id: nodeId,
          type: 'resource' as const,
          data: {
            resourceId: resource.id,
            name: resource.name,
            serviceIcon: resource.serviceIcon,
            agentIds: [agent.id],
          } satisfies ResourceNodeData,
          position: { x: 0, y: 0 },
        })
        resourceEdges.push({
          id: `resourceedge-${agent.id}-${resource.id}`,
          type: 'resource',
          source: `boo-${agent.id}`,
          sourceHandle: 'center',
          target: nodeId,
          targetHandle: 'center',
          data: {},
        })
      }
    }

    // AGENTS.md → DependencyEdges (Boo → Boo)
    if (files?.agentsMd) {
      const bindings = parseAgentsMd(files.agentsMd, agentNames)
      const depSeen = new Set<string>()

      for (const binding of bindings) {
        const targetId = agentNameToId.get(binding.targetAgentName.toLowerCase().trim())
        if (!targetId || targetId === agent.id) continue
        const key = `${agent.id}:${targetId}`
        if (depSeen.has(key)) continue
        depSeen.add(key)
        depEdges.push({
          id: `dep-${agent.id}-${targetId}`,
          type: 'dependency',
          source: `boo-${agent.id}`,
          sourceHandle: 'center',
          target: `boo-${targetId}`,
          targetHandle: 'center-target',
          data: {},
        })
      }
    }
  }

  // Compute edge counts per boo node for degree-aware sizing
  const allEdges = [...depEdges, ...skillEdges, ...resourceEdges]
  const edgeCounts = new Map<string, number>()
  for (const edge of allEdges) {
    edgeCounts.set(edge.source, (edgeCounts.get(edge.source) ?? 0) + 1)
    edgeCounts.set(edge.target, (edgeCounts.get(edge.target) ?? 0) + 1)
  }
  for (const node of booNodes) {
    ;(node.data as BooNodeData).edgeCount = edgeCounts.get(node.id) ?? 0
  }

  return {
    rawNodes: [...booNodes, ...skillNodes, ...resourceNodes],
    rawEdges: allEdges,
  }
}
