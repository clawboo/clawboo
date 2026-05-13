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
import type {
  GraphNode,
  GraphEdge,
  BooNodeData,
  SkillNodeData,
  ResourceNodeData,
  TeamRootNodeData,
  GhostGraphScope,
} from './types'

// ─── useGraphData ─────────────────────────────────────────────────────────────
//
// Fetches TOOLS.md + AGENTS.md for each agent and converts them into React Flow
// nodes + edges stored in useGraphStore.
//
// Two separate update paths:
//   1. Structural rebuild — when agents are added/removed or files change.
//   2. Status-only patch  — when an agent's runtime status changes (no layout re-trigger).
//
// `scope` controls the data source:
//   - `'team'` (default): filter by `selectedTeamId`; Boo Zero is synthesized
//     into the canvas with cross-team edges for the selected team only.
//   - `'atlas'`: ignore `selectedTeamId`; include all agents and synthesize
//     Boo Zero with edges fanning out to every team's internal lead.
//
// **Singleton safety**: `useGraphStore` and this hook are singletons. The
// only consumer (`GhostGraph`) is mounted inside `ContentArea`'s
// `<AnimatePresence mode="wait">`, which guarantees at most one
// `GhostGraphPanel` is mounted at any time — so the singleton-state
// assumption holds even with two scopes in the codebase.

export function useGraphData(scope: GhostGraphScope = 'team'): void {
  const agents = useFleetStore((s) => s.agents)
  const client = useConnectionStore((s) => s.client)
  const selectedTeamId = useTeamStore((s) => s.selectedTeamId)
  const teams = useTeamStore((s) => s.teams)
  const { setAgentFiles, setLoadingFiles, setFilesError, agentFiles, refreshKey } = useGraphStore()

  // In atlas scope we ignore `selectedTeamId` and pull every agent into the
  // canvas. In team scope we filter to the selected team (null = no team
  // currently selected; show all as before).
  const filteredAgents = useMemo(() => {
    if (scope === 'atlas') return agents
    return selectedTeamId ? agents.filter((a) => a.teamId === selectedTeamId) : agents
  }, [agents, selectedTeamId, scope])

  // Resolve Boo Zero (universal team leader). When relevant (team is
  // selected in team-scope, or always in atlas-scope), we include Boo Zero
  // in the agents that drive both file fetching AND graph building — so
  // Boo Zero's own TOOLS.md is fetched and its skill / resource children
  // appear on click (peacock-feather expand). Boo Zero is teamless in the
  // DB (`teamId === null`) so the per-team filter excludes it; this is
  // where we re-include it for graph purposes.
  const booZeroAgentId = useBooZeroStore((s) => s.booZeroAgentId)
  const booZeroAgent = useMemo(
    () => (booZeroAgentId ? (agents.find((a) => a.id === booZeroAgentId) ?? null) : null),
    [agents, booZeroAgentId],
  )

  // "Graph agents" — the agents whose files we fetch and which appear in the
  // built graph. Dedup by id in case Boo Zero is somehow already in filtered
  // (auto-migrate edge case).
  const graphAgents = useMemo(() => {
    if (!booZeroAgent) return filteredAgents
    // Atlas always includes Boo Zero; team scope only includes Boo Zero
    // when a team is actually selected (preserves the pre-atlas behavior
    // for `selectedTeamId === null`, which is otherwise an all-agents
    // peek without the universal-leader synthesis).
    const shouldIncludeBooZero = scope === 'atlas' || Boolean(selectedTeamId)
    if (!shouldIncludeBooZero) return filteredAgents
    const combined = [...filteredAgents, booZeroAgent]
    const seen = new Set<string>()
    const out: typeof combined = []
    for (const a of combined) {
      if (seen.has(a.id)) continue
      seen.add(a.id)
      out.push(a)
    }
    return out
  }, [filteredAgents, booZeroAgent, selectedTeamId, scope])

  // Stable string key for team metadata — drives structural rebuild when a
  // team is renamed/recolored mid-session so BooNodeData.teamName/Color/Emoji
  // stay in sync without over-rebuilding on unrelated team store changes.
  const teamsMetaKey = useMemo(
    () => teams.map((t) => `${t.id}:${t.name}:${t.color}:${t.icon}`).join('|'),
    [teams],
  )

  // ── 0. Reset layout on team OR scope switch ────────────────────────────────
  // We also reset when `scope` changes so an atlas → team-scope transition
  // (or vice-versa) clears stale positions before the next ELK pass.
  // `GhostGraphPanel` does this reset itself as well; this is a defensive
  // duplicate so the hook stays correct even if called from a different
  // panel in the future.
  const prevTeamIdRef = useRef(selectedTeamId)
  const prevScopeRef = useRef(scope)
  useEffect(() => {
    if (prevTeamIdRef.current === selectedTeamId && prevScopeRef.current === scope) return
    prevTeamIdRef.current = selectedTeamId
    prevScopeRef.current = scope
    const store = useGraphStore.getState()
    store.resetLayout()
    store.setNodes([])
    store.setEdges([])
    useGraphStore.setState({ agentFiles: new Map() })
  }, [selectedTeamId, scope])

  // Stable string keys for dependency comparison
  const agentStructureKey = graphAgents.map((a) => `${a.id}:${a.name}`).join('|')
  const agentStatusKey = graphAgents.map((a) => `${a.id}:${a.status}`).join('|')

  // Stable agent ID array (recomputed only when structure changes)
  const agentIds = useMemo(
    () => graphAgents.map((a) => a.id),
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
  // We pass `graphAgents` (filteredAgents + Boo Zero when appropriate) so
  // Boo Zero's BooNode is created naturally by the `agents.map` loop in
  // `buildGraphElements` AND its TOOLS.md gets parsed into skill / resource
  // children. Previously Boo Zero was added as a synthetic node AFTER the
  // skill loop, so clicking Boo Zero showed no skill children — production
  // bug reported by the user. The synthesized edges (Boo Zero → lead → members
  // or Boo Zero → each member) still run for the team-routing concern.
  //
  // Team scope: single team-internal lead for `selectedTeamId`.
  // Atlas scope: a Map of teamId → leadId covering EVERY team that has
  // members. The atlas branch builds the map by running
  // `resolveTeamInternalLead` for each team using the full `agents` list
  // (filteredAgents === agents in atlas), so a team's members are visible
  // even though the team isn't "selected."
  const teamInternalLeadId = useMemo(() => {
    if (scope === 'atlas' || !selectedTeamId) return null
    const team = teams.find((t) => t.id === selectedTeamId)
    if (!team) return null
    return resolveTeamInternalLead(selectedTeamId, team.leaderAgentId, filteredAgents)
  }, [selectedTeamId, teams, filteredAgents, scope])

  const teamInternalLeadByTeamId = useMemo(() => {
    if (scope !== 'atlas') return null
    const map = new Map<string, string | null>()
    for (const team of teams) {
      map.set(team.id, resolveTeamInternalLead(team.id, team.leaderAgentId, agents))
    }
    return map
  }, [teams, agents, scope])

  const { rawNodes, rawEdges } = useMemo(
    () =>
      buildGraphElements(
        graphAgents,
        agentFiles,
        teams,
        teamInternalLeadId,
        booZeroAgent,
        selectedTeamId,
        scope,
        teamInternalLeadByTeamId,
      ),
    [
      agentStructureKey,
      agentFiles,
      teamsMetaKey,
      teamInternalLeadId,
      booZeroAgent,
      selectedTeamId,
      scope,
      teamInternalLeadByTeamId,
    ], // intentional: string keys + scalars + maps
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

    const agentMap = new Map(graphAgents.map((a) => [a.id, a]))

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
   * Team-scope only — the single team-internal lead's agent ID (CTO,
   * Team Lead, etc.) when a genuine leader role is detected for the
   * currently selected team. Boo Zero (when present) is the spanning-tree
   * ROOT; the internal lead, if any, sits one layer below as the bridge
   * between Boo Zero and the rest of the team. Pass `null` when no
   * internal lead exists — Boo Zero connects directly to every team
   * member. **Ignored in atlas scope**; use `teamInternalLeadByTeamId`
   * instead.
   */
  teamInternalLeadId: string | null = null,
  /**
   * Boo Zero — the universal team leader. When present, we synthesize a
   * Boo-Zero `BooNode` (`isUniversalLeader: true`) plus synthetic
   * dependency edges so the spanning tree roots from Boo Zero. Synthesis
   * fires when:
   *   - team scope + a team is selected (existing behavior), OR
   *   - atlas scope (always, when Boo Zero exists).
   */
  booZeroAgent: AgentState | null = null,
  /**
   * The currently selected team id (team scope only). Used to constrain
   * the synthetic-edge logic to the single selected team. **Ignored in
   * atlas scope** — atlas iterates every team in `teams` instead.
   */
  selectedTeamId: string | null = null,
  /**
   * Which view are we rendering? See `GhostGraphScope` for details.
   * `'team'` (default) preserves the historical single-team behavior;
   * `'atlas'` switches to multi-team synthesis and a forest fallback
   * spanning tree when Boo Zero is absent.
   */
  scope: GhostGraphScope = 'team',
  /**
   * Atlas-scope only — Map of teamId → internal lead agent id (or `null`
   * when a team has no detected leader). Required when `scope === 'atlas'`;
   * `null` in team scope.
   */
  teamInternalLeadByTeamId: Map<string, string | null> | null = null,
): { rawNodes: GraphNode[]; rawEdges: GraphEdge[] } {
  const depEdges: GraphEdge[] = []
  const skillNodes: GraphNode[] = []
  const skillEdges: GraphEdge[] = []
  const resourceNodes: GraphNode[] = []
  const resourceEdges: GraphEdge[] = []

  const agentNames = agents.map((a) => a.name)
  const agentNameToId = new Map(agents.map((a) => [a.name.toLowerCase().trim(), a.id]))
  const teamsById = new Map(teams.map((t) => [t.id, t]))

  // BooNodes — one per agent. When Boo Zero exists and is relevant to the
  // current scope, we synthesize a Boo-Zero node here too even though Boo
  // Zero is teamless (filtered out of `agents` in team scope when a team
  // is selected — atlas always passes Boo Zero in already, but we guard
  // here regardless). The synthetic Boo Zero gets `isUniversalLeader: true`
  // so the renderer adds the crown badge and the halo layer excludes it
  // from team grouping.
  const agentsAlreadyContainsBooZero = booZeroAgent
    ? agents.some((a) => a.id === booZeroAgent.id)
    : false
  const booZeroIsRelevantForScope =
    scope === 'atlas' ? Boolean(booZeroAgent) : Boolean(booZeroAgent) && Boolean(selectedTeamId)
  const synthesizeBooZeroNode = booZeroIsRelevantForScope && !agentsAlreadyContainsBooZero

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

  // ── Boo Zero's "Leadership" orbital ─────────────────────────────────────
  //
  // Synthesized for every Boo with `isUniversalLeader: true` (i.e. Boo Zero
  // in both atlas and team-selected scopes). Replaces the old crown badge
  // as the visible leadership signal. Rendered as a normal SkillNode that
  // orbits Boo Zero in the inner ring; `SkillNode` reads the `isLeadership`
  // flag and overrides its color + icon + hides the Install button.
  //
  // Source-of-truth note: this skill is NOT in TOOLS.md — it's a graph-
  // layer attribute. No client-side write to the Gateway, so it survives
  // any future deletion of Boo Zero's tools. The skillId starts with the
  // reserved prefix `clawboo-leadership-` so it can never collide with a
  // marketplace skill or a user-added TOOLS.md entry.
  for (const booNode of booNodes) {
    const data = booNode.data as BooNodeData
    if (!data.isUniversalLeader) continue
    const agentId = data.agentId
    const nodeId = `skill-${agentId}-clawboo-leadership`
    skillNodes.push({
      id: nodeId,
      type: 'skill' as const,
      data: {
        skillId: 'clawboo-leadership',
        name: 'Leadership',
        // `'other'` is a graceful fallback for any code path that
        // doesn't yet branch on `isLeadership` (e.g. legacy filters).
        // The visual overrides in `SkillNode` short-circuit before any
        // category styling kicks in.
        category: 'other',
        description:
          'Universal team leader. This skill is reserved for Boo Zero and cannot be installed on other agents.',
        agentIds: [agentId],
        isLeadership: true,
      } satisfies SkillNodeData,
      position: { x: 0, y: 0 },
    })
    skillEdges.push({
      id: `skilledge-${agentId}-clawboo-leadership`,
      type: 'skill',
      source: `boo-${agentId}`,
      sourceHandle: 'center',
      target: nodeId,
      targetHandle: 'center',
      data: {},
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
  // Without these, the undirected BFS in `computeSpanningTree` rooted at
  // Boo Zero would return an empty tree (no team agent's AGENTS.md
  // mentions Boo Zero in a form the parser recognizes) and every team
  // member would render as an orphan. We synthesize:
  //   - Boo Zero → team-internal lead (when one exists), and
  //   - lead → each non-lead member (defensive — many teams have hub-spoke
  //     AGENTS.md routing already, but the synthetic backstop guarantees
  //     every member is reached by the spanning tree regardless of how
  //     sparse their routing rules are).
  //   - Or, when no internal lead exists, Boo Zero → each member directly.
  //
  // Synthetic edges are tagged `isSynthetic: true` so consumers that scan
  // AGENTS.md routing data (e.g. "Refresh Protocol") can skip them. They
  // route through the same handle topology as regular dependency edges.
  //
  // **Two-phase BFS prep**: synthetic edges are pushed BEFORE the natural
  // AGENTS.md cross-team @mentions could shift them in the array, but
  // both already exist by this point in execution. The actual BFS-order
  // guarantee is enforced down below at the `computeSpanningTree` call
  // site — we partition `depEdges` into synthetic-first / mention-second
  // and concatenate so synthetic edges win adjacency-insertion order in
  // the BFS, preventing a cross-team @mention from stealing primary-edge
  // status from the Boo-Zero → lead synthetic.
  // ── Boo Zero synthetic edges ────────────────────────────────────────────
  // Two distinct shapes here, depending on scope:
  //
  // **Team scope** (group chat): hub-spoke around Boo Zero (or the team
  // lead, when one exists). Every member sits at the same hierarchy level
  // under that hub. Single team on screen → no risk of the cross-team
  // visual conflation we get in atlas, so the layout is unchanged from
  // its long-standing behavior.
  //
  // **Atlas scope** (all teams): we insert an INVISIBLE `team-root` node
  // between Boo Zero and each team's cluster. The resulting hierarchy is:
  //
  //     Boo Zero               ← level 0
  //        │
  //     ┌──┴──┐                 ← TOP trunk (BZ → team-roots)
  //     │     │
  //     TR-A  TR-B              ← level 1 (invisible junctions)
  //     │     │
  //   ┌─┼─┐ ┌─┴─┐                ← per-team sub-trunks
  //   m m m m m m                ← level 2 (team members)
  //
  // Team-root nodes render as a 1px invisible point with anchor handles,
  // so visually the canvas shows ONLY: Boo Zero at top → top trunk → each
  // team's sub-trunk → team members. This matches the user's hand-drawn
  // sketch and keeps every team member at the SAME hierarchy level as
  // they sit at in the team-scoped Ghost Graph (no extra visible level).
  const synthesizeTeamScopeEdges = (bz: AgentState, teamId: string, teamLeadId: string | null) => {
    const teamMemberIds = agents.filter((a) => a.teamId === teamId).map((a) => a.id)
    if (teamMemberIds.length === 0) return // skip empty teams
    if (teamLeadId && teamMemberIds.includes(teamLeadId)) {
      depEdges.push({
        id: `dep-syn-${bz.id}-${teamLeadId}`,
        type: 'dependency',
        source: `boo-${bz.id}`,
        sourceHandle: 'center',
        target: `boo-${teamLeadId}`,
        targetHandle: 'center-target',
        data: { isSynthetic: true },
      })
      for (const memberId of teamMemberIds) {
        if (memberId === teamLeadId) continue
        depEdges.push({
          id: `dep-syn-${teamLeadId}-${memberId}`,
          type: 'dependency',
          source: `boo-${teamLeadId}`,
          sourceHandle: 'center',
          target: `boo-${memberId}`,
          targetHandle: 'center-target',
          data: { isSynthetic: true },
        })
      }
    } else {
      for (const memberId of teamMemberIds) {
        depEdges.push({
          id: `dep-syn-${bz.id}-${memberId}`,
          type: 'dependency',
          source: `boo-${bz.id}`,
          sourceHandle: 'center',
          target: `boo-${memberId}`,
          targetHandle: 'center-target',
          data: { isSynthetic: true },
        })
      }
    }
  }
  const teamRootNodes: GraphNode[] = []
  const synthesizeAtlasTeamRootEdges = (bz: AgentState, teamId: string) => {
    const teamMemberIds = agents.filter((a) => a.teamId === teamId).map((a) => a.id)
    if (teamMemberIds.length === 0) return // skip empty teams
    const teamRootId = `team-root-${teamId}`
    teamRootNodes.push({
      id: teamRootId,
      type: 'team-root' as const,
      data: { teamId } satisfies TeamRootNodeData,
      position: { x: 0, y: 0 },
    })
    // BZ → team-root
    depEdges.push({
      id: `dep-syn-${bz.id}-${teamRootId}`,
      type: 'dependency',
      source: `boo-${bz.id}`,
      sourceHandle: 'center',
      target: teamRootId,
      targetHandle: 'center-target',
      data: { isSynthetic: true },
    })
    // team-root → each member directly. We deliberately do NOT route
    // through a team's "lead" in atlas — the user wanted every team
    // member at the same hierarchy level as siblings (matches the
    // hand-drawn sketch). The team-scoped Ghost Graph still preserves
    // the lead-is-hub structure via `synthesizeTeamScopeEdges`.
    for (const memberId of teamMemberIds) {
      depEdges.push({
        id: `dep-syn-${teamRootId}-${memberId}`,
        type: 'dependency',
        source: teamRootId,
        sourceHandle: 'center',
        target: `boo-${memberId}`,
        targetHandle: 'center-target',
        data: { isSynthetic: true },
      })
    }
  }
  if (booZeroAgent) {
    if (scope === 'atlas') {
      // Atlas: insert an invisible team-root junction per team.
      for (const team of teams) {
        synthesizeAtlasTeamRootEdges(booZeroAgent, team.id)
      }
    } else if (selectedTeamId) {
      // Team scope: single team, no team-root needed.
      synthesizeTeamScopeEdges(booZeroAgent, selectedTeamId, teamInternalLeadId)
    }
  }

  // ── Spanning tree over dependency edges (org-chart filter) ──────────────
  // BFS over the dependency edges to pick ONE primary parent per reachable
  // node (the "primary edge") so the rendered hierarchy reads as an org
  // chart. All other dependency edges become secondary and only render on
  // hover.
  //
  // Two-phase BFS for atlas (and team scope when Boo Zero is present):
  // the BFS adjacency map is built in array order, and `computeSpanningTree`
  // claims the FIRST discovering edge for each node. We sort `depEdges` so
  // synthetic Boo-Zero → team edges come first, then real AGENTS.md edges.
  // This guarantees synthetic edges win the BFS race so a cross-team
  // @mention can't steal a member as its primary parent away from the
  // Boo Zero → team-lead synthetic edge.
  //
  // Forest fallback when Boo Zero is absent (atlas with no Boo Zero, OR
  // team scope without a Boo Zero AND without a team-internal lead): we
  // union per-root BFS results so each disconnected sub-tree gets its
  // own clean primary backbone. In atlas this means one BFS per team's
  // internal lead; in team scope we keep the single-root behavior (or
  // skip the filter when there's no valid root, treating all edges as
  // primary — the historical fallback).
  const orderedDepEdges =
    scope === 'atlas' || booZeroAgent
      ? [
          ...depEdges.filter((e) => (e.data as { isSynthetic?: boolean })?.isSynthetic),
          ...depEdges.filter((e) => !(e.data as { isSynthetic?: boolean })?.isSynthetic),
        ]
      : depEdges
  const spanEdges = orderedDepEdges.map((e) => ({ id: e.id, source: e.source, target: e.target }))

  const treeRoots: string[] = []
  if (booZeroAgent && (scope === 'atlas' || selectedTeamId)) {
    treeRoots.push(`boo-${booZeroAgent.id}`)
  } else if (scope === 'atlas') {
    // Forest fallback — one BFS per team-internal lead (teams without
    // leads contribute no primary edges and their members render as
    // disconnected nodes, which is the right signal).
    if (teamInternalLeadByTeamId) {
      for (const [, leadId] of teamInternalLeadByTeamId) {
        if (leadId) treeRoots.push(`boo-${leadId}`)
      }
    }
  } else if (teamInternalLeadId) {
    treeRoots.push(`boo-${teamInternalLeadId}`)
  }

  let primaryEdgeIds: Set<string>
  let parentMap: Map<string, string>
  if (scope === 'atlas' && booZeroAgent) {
    // **Atlas with Boo Zero: only synthetic edges are primary.**
    // The user explicitly asked for every team Boo to sit at the same
    // hierarchy level (matching their hand-drawn sketch). Including real
    // AGENTS.md routes (member → sub-member) in the spanning tree pulls
    // sub-children down a layer, producing the "two-tier teams with sub-
    // children at level 3" bug. By restricting primary edges to the
    // synthetic backbone (BZ → team-root + team-root → each member),
    // every team Boo gets the SAME primary parent depth (team-root at
    // level 1) regardless of any internal AGENTS.md hierarchy. Real
    // intra-team routes still exist and render as secondary edges on
    // hover, so the routing data isn't lost — just visually quieted.
    primaryEdgeIds = new Set(
      depEdges.filter((e) => (e.data as { isSynthetic?: boolean })?.isSynthetic).map((e) => e.id),
    )
    parentMap = new Map<string, string>()
    // Build parentMap from synthetic edges so the edge-flip logic below
    // recognises the (already-correct) source → target direction and
    // leaves them alone. Without these entries the flip code's
    // `parentMap.get(edge.source) === edge.target` check would
    // false-trigger and silently invert the edges.
    for (const edge of depEdges) {
      if (!primaryEdgeIds.has(edge.id)) continue
      parentMap.set(edge.target, edge.source)
    }
  } else if (treeRoots.length === 0) {
    // No root → treat every dependency edge as primary (historical
    // fallback used by the all-agents-no-team peek).
    primaryEdgeIds = new Set(depEdges.map((e) => e.id))
    parentMap = new Map<string, string>()
  } else {
    primaryEdgeIds = new Set()
    parentMap = new Map<string, string>()
    for (const root of treeRoots) {
      const { primaryEdgeIds: rootIds, parentMap: rootParents } = computeSpanningTree(
        spanEdges,
        root,
      )
      for (const id of rootIds) primaryEdgeIds.add(id)
      for (const [k, v] of rootParents) {
        if (!parentMap.has(k)) parentMap.set(k, v)
      }
    }
  }

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
  //
  // In atlas, Boo Zero's outgoing primary edges all go to team-root
  // junction nodes (one per team) — never to team members directly — so
  // they form ONE clean shared trunk under Boo Zero with one corner
  // branch per team-root. Each team-root's outgoing edges form its own
  // per-team sub-trunk down to the team's members. Grouping by source
  // alone gives both shapes naturally.
  const trunkGroupKey = (edge: GraphEdge): string => edge.source
  const primaryBySource = new Map<string, GraphEdge[]>()
  for (const edge of depEdges) {
    if (!primaryEdgeIds.has(edge.id)) continue
    const key = trunkGroupKey(edge)
    const list = primaryBySource.get(key) ?? []
    list.push(edge)
    primaryBySource.set(key, list)
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
    rawNodes: [...booNodes, ...teamRootNodes, ...skillNodes, ...resourceNodes],
    rawEdges: allEdges,
  }
}
