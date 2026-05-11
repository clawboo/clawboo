import { useEffect, useMemo, useRef } from 'react'
import { useFleetStore } from '@/stores/fleet'
import { useConnectionStore } from '@/stores/connection'
import { useTeamStore } from '@/stores/team'
import { useBooZeroStore } from '@/stores/booZero'
import type { Team } from '@/stores/team'
import { useGraphStore } from './store'
import { parseToolsMd } from './parsers/parseToolsMd'
import { parseAgentsMd } from './parsers/parseAgentsMd'
import { computeSpanningTree } from './computeSpanningTree'
import { resolveTeamInternalLead } from '@/lib/resolveTeamLeader'
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
  // Resolve Boo Zero (universal team leader). When a team is selected AND Boo
  // Zero is present, `buildGraphElements` synthesizes a Boo-Zero node + edges
  // from Boo Zero → genuine internal lead (if any) → members, OR directly to
  // members when there's no internal lead. Boo Zero becomes the spanning-tree
  // root, replacing the old "first team member" fallback.
  const booZeroAgentId = useBooZeroStore((s) => s.booZeroAgentId)
  const booZeroAgent = useMemo(
    () => (booZeroAgentId ? (agents.find((a) => a.id === booZeroAgentId) ?? null) : null),
    [agents, booZeroAgentId],
  )

  const teamInternalLeadId = useMemo(() => {
    if (!selectedTeamId) return null
    const team = teams.find((t) => t.id === selectedTeamId)
    if (!team) return null
    return resolveTeamInternalLead(selectedTeamId, team.leaderAgentId, filteredAgents)
  }, [selectedTeamId, teams, filteredAgents])

  const { rawNodes, rawEdges } = useMemo(
    () =>
      buildGraphElements(
        filteredAgents,
        agentFiles,
        teams,
        teamInternalLeadId,
        booZeroAgent,
        selectedTeamId,
      ),
    [agentStructureKey, agentFiles, teamsMetaKey, teamInternalLeadId, booZeroAgent, selectedTeamId], // intentional: string keys + scalars
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
   * The team-internal lead's agent ID (CTO, Team Lead, etc.) when a genuine
   * leader role is detected. Boo Zero (when present) is the spanning-tree
   * ROOT; the internal lead, if any, sits one layer below as the bridge
   * between Boo Zero and the rest of the team.
   *
   * Pass `null` when no internal lead exists — Boo Zero connects directly
   * to every team member.
   */
  teamInternalLeadId: string | null = null,
  /**
   * Boo Zero — the universal team leader. When present AND a team is
   * selected, we synthesize a Boo-Zero `BooNode` (`isUniversalLeader: true`)
   * plus synthetic dependency edges so the spanning tree roots from Boo Zero.
   * When no team is selected (all-agents view), Boo Zero appears as a
   * regular node (it has `teamId: null`); we just flip the `isUniversalLeader`
   * flag on its existing `BooNodeData`.
   */
  booZeroAgent: AgentState | null = null,
  /**
   * The currently selected team id, or null for the all-agents view. We need
   * this separately from `agents` because the synthetic-edge logic only fires
   * when a team is being shown.
   */
  selectedTeamId: string | null = null,
): { rawNodes: GraphNode[]; rawEdges: GraphEdge[] } {
  const depEdges: GraphEdge[] = []
  const skillNodes: GraphNode[] = []
  const skillEdges: GraphEdge[] = []
  const resourceNodes: GraphNode[] = []
  const resourceEdges: GraphEdge[] = []

  const agentNames = agents.map((a) => a.name)
  const agentNameToId = new Map(agents.map((a) => [a.name.toLowerCase().trim(), a.id]))
  const teamsById = new Map(teams.map((t) => [t.id, t]))

  // BooNodes — one per agent. When a team is selected AND Boo Zero exists,
  // we synthesize a Boo-Zero node here too even though Boo Zero is teamless
  // (filtered out of `agents`). The synthetic Boo Zero gets
  // `isUniversalLeader: true` so the renderer adds the crown badge and the
  // halo layer excludes it from team grouping.
  const agentsAlreadyContainsBooZero = booZeroAgent
    ? agents.some((a) => a.id === booZeroAgent.id)
    : false
  const synthesizeBooZeroNode =
    Boolean(booZeroAgent) && Boolean(selectedTeamId) && !agentsAlreadyContainsBooZero

  const booNodes: GraphNode[] = agents.map((agent) => {
    const team = agent.teamId ? teamsById.get(agent.teamId) : null
    const isUniversalLeader = Boolean(booZeroAgent && agent.id === booZeroAgent.id)
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
        ...(isUniversalLeader ? { isUniversalLeader: true } : {}),
      } satisfies BooNodeData,
      position: { x: 0, y: 0 },
    }
  })

  if (synthesizeBooZeroNode && booZeroAgent) {
    booNodes.push({
      id: `boo-${booZeroAgent.id}`,
      type: 'boo' as const,
      data: {
        agentId: booZeroAgent.id,
        name: booZeroAgent.name,
        status: booZeroAgent.status ?? 'idle',
        model: booZeroAgent.model,
        isStreaming: booZeroAgent.status === 'running',
        // Boo Zero stays `teamId: null` even in a team-selected view — the
        // `TeamHaloLayer` reads `data.teamId` for grouping and intentionally
        // omits Boo Zero from any team hull.
        teamId: null,
        isUniversalLeader: true,
      } satisfies BooNodeData,
      position: { x: 0, y: 0 },
    })
  }

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

  // ── Synthetic Boo-Zero → team edges ─────────────────────────────────────
  // The Plan agent's risk #2: no team agent's AGENTS.md mentions Boo Zero
  // in a form the parser recognizes, so the undirected BFS in
  // `computeSpanningTree` rooted at Boo Zero would return an empty tree
  // (every team member becomes an orphan). We synthesize edges from Boo
  // Zero to the team-internal lead (when present, lead → members cascade
  // naturally through existing AGENTS.md routing) OR directly to every
  // team member.
  //
  // Synthetic edges are tagged `isSynthetic: true` so consumers that scan
  // AGENTS.md routing data (e.g. "Refresh Protocol") can skip them. They
  // route through the same handle topology as regular dependency edges.
  if (booZeroAgent && selectedTeamId) {
    const teamMemberIds = agents.filter((a) => a.teamId === selectedTeamId).map((a) => a.id)
    if (teamInternalLeadId && teamMemberIds.includes(teamInternalLeadId)) {
      // Boo Zero → internal lead. Existing AGENTS.md edges among
      // (lead, members) will fan out via the spanning tree.
      depEdges.push({
        id: `dep-syn-${booZeroAgent.id}-${teamInternalLeadId}`,
        type: 'dependency',
        source: `boo-${booZeroAgent.id}`,
        sourceHandle: 'center',
        target: `boo-${teamInternalLeadId}`,
        targetHandle: 'center-target',
        data: { isSynthetic: true },
      })
      // Also synthesize edges from the lead to each non-lead member so the
      // spanning tree always reaches everyone even if AGENTS.md routing is
      // sparse (defensive — many awesome-openclaw teams have hub-spoke
      // routing already, but synthetic backstops every shape).
      for (const memberId of teamMemberIds) {
        if (memberId === teamInternalLeadId) continue
        depEdges.push({
          id: `dep-syn-${teamInternalLeadId}-${memberId}`,
          type: 'dependency',
          source: `boo-${teamInternalLeadId}`,
          sourceHandle: 'center',
          target: `boo-${memberId}`,
          targetHandle: 'center-target',
          data: { isSynthetic: true },
        })
      }
    } else {
      // No internal lead → Boo Zero connects to every team member directly.
      for (const memberId of teamMemberIds) {
        depEdges.push({
          id: `dep-syn-${booZeroAgent.id}-${memberId}`,
          type: 'dependency',
          source: `boo-${booZeroAgent.id}`,
          sourceHandle: 'center',
          target: `boo-${memberId}`,
          targetHandle: 'center-target',
          data: { isSynthetic: true },
        })
      }
    }
  }

  // ── Spanning tree over dependency edges (org-chart filter) ──────────────
  // BFS from the spanning-tree root. When Boo Zero is present in a
  // team-selected view, Boo Zero is the root. Otherwise we fall back to
  // the team-internal lead. When neither exists (all-agents view), we skip
  // the filter and treat every dependency edge as primary.
  const rootNodeId =
    booZeroAgent && selectedTeamId
      ? `boo-${booZeroAgent.id}`
      : teamInternalLeadId
        ? `boo-${teamInternalLeadId}`
        : null
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

  // Group primary edges by source so each parent's outgoing edges can render
  // a SHARED trunk + branches instead of N overlapping smooth-step paths.
  // Without this, two parallel-looking horizontal lines appear (the
  // "rope" effect) when many siblings share a parent — each edge draws its
  // own vertical from the parent + horizontal at the elbow, and tiny
  // sub-pixel rendering differences between paths show as a doubled line
  // even when the math says they should overlap exactly. The trunk leader
  // draws the shared trunk; followers skip the trunk and draw only their
  // branch (vertical descent to their own child).
  const primaryBySource = new Map<string, GraphEdge[]>()
  for (const edge of depEdges) {
    if (!primaryEdgeIds.has(edge.id)) continue
    const list = primaryBySource.get(edge.source) ?? []
    list.push(edge)
    primaryBySource.set(edge.source, list)
  }
  for (const [, siblings] of primaryBySource) {
    if (siblings.length <= 1) continue // single child — normal smooth-step is fine
    // Sort by edge id so the leader is deterministic across renders.
    siblings.sort((a, b) => a.id.localeCompare(b.id))
    const siblingTargetIds = siblings.map((e) => e.target)
    siblings[0]!.data = {
      ...siblings[0]!.data,
      isTrunkLeader: true,
      siblingTargetIds,
    }
    for (let i = 1; i < siblings.length; i++) {
      siblings[i]!.data = {
        ...siblings[i]!.data,
        isTrunkFollower: true,
        siblingTargetIds,
      }
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
