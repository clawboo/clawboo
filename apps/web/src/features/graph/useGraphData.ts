import { useEffect, useMemo, useRef } from 'react'
import { useFleetStore } from '@/stores/fleet'
import { useConnectionStore } from '@/stores/connection'
import { useTeamStore } from '@/stores/team'
import type { Team } from '@/stores/team'
import { useGraphStore } from './store'
import { parseToolsMd } from './parsers/parseToolsMd'
import { parseAgentsMd } from './parsers/parseAgentsMd'
import { computeSpanningTree } from './computeSpanningTree'
import { resolveTeamLeader } from '@/lib/resolveTeamLeader'
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
  const teams = useTeamStore((s) => s.teams)
  const { setAgentFiles, setLoadingFiles, setFilesError, agentFiles, refreshKey } = useGraphStore()

  // Filter agents by selected team (null = show all)
  const filteredAgents = useMemo(
    () => (selectedTeamId ? agents.filter((a) => a.teamId === selectedTeamId) : agents),
    [agents, selectedTeamId],
  )

  // Stable string key for team metadata — drives structural rebuild when a
  // team is renamed/recolored mid-session so BooNodeData.teamName/Color/Emoji
  // stay in sync without over-rebuilding on unrelated team store changes.
  const teamsMetaKey = useMemo(
    () => teams.map((t) => `${t.id}:${t.name}:${t.color}:${t.icon}`).join('|'),
    [teams],
  )

  // ── 0. Reset layout on team switch ──────────────────────────────────────────
  const prevTeamIdRef = useRef(selectedTeamId)
  useEffect(() => {
    if (prevTeamIdRef.current === selectedTeamId) return
    prevTeamIdRef.current = selectedTeamId
    const store = useGraphStore.getState()
    store.resetLayout()
    store.setNodes([])
    store.setEdges([])
    useGraphStore.setState({ agentFiles: new Map() })
  }, [selectedTeamId])

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
  // Resolve the active team's leader → spanning-tree root for the dependency
  // graph. When no team is selected (showing all agents), we pass null and
  // `buildGraphElements` skips the spanning-tree filter (all edges treated
  // as primary, fall back to the full graph view).
  const resolvedLeaderAgentId = useMemo(() => {
    if (!selectedTeamId) return null
    const team = teams.find((t) => t.id === selectedTeamId)
    if (!team) return null
    return resolveTeamLeader(selectedTeamId, team.leaderAgentId, filteredAgents)
  }, [selectedTeamId, teams, filteredAgents])

  const { rawNodes, rawEdges } = useMemo(
    () => buildGraphElements(filteredAgents, agentFiles, teams, resolvedLeaderAgentId),
    [agentStructureKey, agentFiles, teamsMetaKey, resolvedLeaderAgentId], // intentional: string keys
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
  teams: Team[] = [],
  /**
   * The team leader's agent ID — used as the spanning-tree root over
   * dependency edges. Each Boo gets ONE primary parent (the BFS edge that
   * first reached it); all other dependency edges are tagged secondary
   * and rendered hover-only.
   *
   * Pass `null` to skip the spanning-tree filter — every dependency edge
   * is treated as primary. Used when no team is selected (showing all
   * agents) or when the leader can't be resolved.
   */
  leaderAgentId: string | null = null,
): { rawNodes: GraphNode[]; rawEdges: GraphEdge[] } {
  const depEdges: GraphEdge[] = []
  const skillNodes: GraphNode[] = []
  const skillEdges: GraphEdge[] = []
  const resourceNodes: GraphNode[] = []
  const resourceEdges: GraphEdge[] = []

  const agentNames = agents.map((a) => a.name)
  const agentNameToId = new Map(agents.map((a) => [a.name.toLowerCase().trim(), a.id]))
  const teamsById = new Map(teams.map((t) => [t.id, t]))

  // BooNodes — one per agent
  const booNodes: GraphNode[] = agents.map((agent) => {
    const team = agent.teamId ? teamsById.get(agent.teamId) : null
    return {
      id: `boo-${agent.id}`,
      type: 'boo' as const,
      data: {
        agentId: agent.id,
        name: agent.name,
        status: agent.status ?? 'idle',
        model: agent.model,
        isStreaming: agent.status === 'running',
        teamId: agent.teamId ?? null,
        ...(team && {
          teamName: team.name,
          teamColor: team.color,
          teamEmoji: team.icon,
        }),
      } satisfies BooNodeData,
      position: { x: 0, y: 0 },
    }
  })

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

  // ── Spanning tree over dependency edges (org-chart filter) ──────────────
  // BFS from the team leader to determine each Boo's "primary parent." All
  // other dependency edges are tagged `isPrimary: false` so the renderer
  // can hide them by default and reveal on hover. ELK only sees primary
  // edges, which produces clean top-down rank structure.
  //
  // When `leaderAgentId` is null (no team selected) we skip the filter
  // and treat every dependency edge as primary — fall back to full graph.
  const rootNodeId = leaderAgentId ? `boo-${leaderAgentId}` : null
  const treeResult = rootNodeId
    ? computeSpanningTree(
        depEdges.map((e) => ({ id: e.id, source: e.source, target: e.target })),
        rootNodeId,
      )
    : {
        primaryEdgeIds: new Set(depEdges.map((e) => e.id)),
        parentMap: new Map<string, string>(),
        reachableNodeIds: new Set<string>(),
      }
  const { primaryEdgeIds, parentMap } = treeResult

  // For ELK to lay out the leader at the TOP under `layered DOWN`, every
  // primary edge must flow parent → child (source = parent, target = child).
  // The original AGENTS.md routing data may flow the other way (e.g. a
  // teammate having "@LeaderName" routes points UP toward the leader). We
  // rewrite source/target on primary edges where the BFS parent is the
  // edge's TARGET in the original data — flipping them so ELK reads them
  // as descending from leader. Secondary edges keep their original
  // direction (their arrow shows actual delegation).
  //
  // IMPORTANT: BooNode's `'center'` is a source-type handle and
  // `'center-target'` is a target-type handle (see `nodes/BooNode.tsx`).
  // When we flip the edge, the handles must STAY CANONICAL — source side
  // always uses `'center'`, target side always uses `'center-target'`.
  // Swapping the handle names produces the inverse type mismatch and
  // React Flow rejects the edge ("Couldn't create edge for source handle
  // id: 'center-target'"), causing the edge to silently vanish.
  for (const edge of depEdges) {
    const isPrimary = primaryEdgeIds.has(edge.id)
    edge.data = { ...edge.data, isPrimary }
    if (!isPrimary) continue
    if (parentMap.get(edge.target) === edge.source) continue
    if (parentMap.get(edge.source) === edge.target) {
      const oldSource = edge.source
      edge.source = edge.target
      edge.target = oldSource
      // Keep handles canonical — don't swap them with source/target.
      edge.sourceHandle = 'center'
      edge.targetHandle = 'center-target'
    }
  }

  // Compute edge counts per boo node for degree-aware sizing.
  // Use ONLY primary dependency edges + skill/resource edges so degree
  // counts reflect what the user actually sees at rest. (Hidden secondary
  // dependency edges shouldn't inflate Boo size.)
  const visibleDepEdges = depEdges.filter((e) => primaryEdgeIds.has(e.id))
  const allEdges = [...depEdges, ...skillEdges, ...resourceEdges]
  const edgeCountSources: GraphEdge[] = [...visibleDepEdges, ...skillEdges, ...resourceEdges]
  const edgeCounts = new Map<string, number>()
  for (const edge of edgeCountSources) {
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
