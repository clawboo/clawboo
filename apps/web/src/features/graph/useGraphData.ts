'use client'

import { useEffect, useMemo } from 'react'
import { useFleetStore } from '@/stores/fleet'
import { useConnectionStore } from '@/stores/connection'
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
  const { setAgentFiles, setLoadingFiles, setFilesError, agentFiles } = useGraphStore()

  // Stable string keys for dependency comparison
  const agentStructureKey = agents.map((a) => `${a.id}:${a.name}`).join('|')
  const agentStatusKey = agents.map((a) => `${a.id}:${a.status}`).join('|')

  // Stable agent ID array (recomputed only when structure changes)
  const agentIds = useMemo(
    () => agents.map((a) => a.id),
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
  }, [client, agentStructureKey]) // intentional: string key covers structural changes

  // ── 2. Structural rebuild ────────────────────────────────────────────────────
  const { rawNodes, rawEdges } = useMemo(
    () => buildGraphElements(agents, agentFiles),
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

    const agentMap = new Map(agents.map((a) => [a.id, a]))

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

function buildGraphElements(
  agents: AgentState[],
  agentFiles: Map<string, { toolsMd: string | null; agentsMd: string | null }>,
): { rawNodes: GraphNode[]; rawEdges: GraphEdge[] } {
  const skillMap = new Map<string, SkillNodeData>()
  const resourceMap = new Map<string, ResourceNodeData>()
  const depEdges: GraphEdge[] = []
  const skillEdges: GraphEdge[] = []
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

    // TOOLS.md → SkillNodes + ResourceNodes
    if (files?.toolsMd) {
      const { skills, resources } = parseToolsMd(files.toolsMd)

      for (const skill of skills) {
        if (!skillMap.has(skill.id)) {
          skillMap.set(skill.id, {
            skillId: skill.id,
            name: skill.name,
            category: skill.category,
            description: skill.description,
            agentIds: [],
          })
        }
        skillMap.get(skill.id)!.agentIds.push(agent.id)
      }

      for (const resource of resources) {
        if (!resourceMap.has(resource.id)) {
          resourceMap.set(resource.id, {
            resourceId: resource.id,
            name: resource.name,
            serviceIcon: resource.serviceIcon,
            agentIds: [],
          })
        }
        resourceMap.get(resource.id)!.agentIds.push(agent.id)
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
          target: `boo-${targetId}`,
          data: {},
        })
      }
    }
  }

  // SkillNodes + skill edges
  const skillNodes: GraphNode[] = Array.from(skillMap.values()).map((skill) => ({
    id: `skill-${skill.skillId}`,
    type: 'skill' as const,
    data: skill,
    position: { x: 0, y: 0 },
  }))

  for (const skill of skillMap.values()) {
    for (const agentId of skill.agentIds) {
      skillEdges.push({
        id: `skill-${agentId}-${skill.skillId}`,
        type: 'skill',
        source: `boo-${agentId}`,
        sourceHandle: 'right',
        target: `skill-${skill.skillId}`,
        data: {},
      })
    }
  }

  // ResourceNodes + resource edges
  const resourceNodes: GraphNode[] = Array.from(resourceMap.values()).map((resource) => ({
    id: `resource-${resource.resourceId}`,
    type: 'resource' as const,
    data: resource,
    position: { x: 0, y: 0 },
  }))

  for (const resource of resourceMap.values()) {
    for (const agentId of resource.agentIds) {
      resourceEdges.push({
        id: `resource-${agentId}-${resource.resourceId}`,
        type: 'resource',
        source: `boo-${agentId}`,
        sourceHandle: 'right',
        target: `resource-${resource.resourceId}`,
        data: {},
      })
    }
  }

  return {
    rawNodes: [...booNodes, ...skillNodes, ...resourceNodes],
    rawEdges: [...depEdges, ...skillEdges, ...resourceEdges],
  }
}
