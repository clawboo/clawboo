import { describe, it, expect } from 'vitest'
import { buildGraphElements } from '../useGraphData'
import type { AgentState } from '@/stores/fleet'
import type { Team } from '@/stores/team'
import type { BooNodeData, GraphEdge } from '../types'

// ─── Test fixtures ───────────────────────────────────────────────────────────

const makeAgent = (overrides: Partial<AgentState>): AgentState => ({
  id: overrides.id ?? 'a1',
  name: overrides.name ?? 'Agent 1',
  status: 'idle',
  sessionKey: null,
  model: null,
  createdAt: null,
  streamingText: null,
  runId: null,
  lastSeenAt: null,
  teamId: null,
  execConfig: null,
  ...overrides,
})

const makeTeam = (overrides: Partial<Team>): Team => ({
  id: overrides.id ?? 't1',
  name: overrides.name ?? 'Team 1',
  icon: '🛠️',
  color: '#FBBF24',
  templateId: null,
  agentCount: 0,
  leaderAgentId: null,
  isArchived: false,
  ...overrides,
})

const booZero = makeAgent({ id: 'bz', name: 'Boo Zero', teamId: null })

const isPrimary = (edge: GraphEdge): boolean =>
  Boolean((edge.data as { isPrimary?: boolean })?.isPrimary)
const isSynthetic = (edge: GraphEdge): boolean =>
  Boolean((edge.data as { isSynthetic?: boolean })?.isSynthetic)

// ─── Atlas scope tests ───────────────────────────────────────────────────────
//
// Atlas synthesizes an invisible `team-root` junction per team to give
// ELK + the rendering layer a clean two-trunk hierarchy:
//
//   Boo Zero
//      │
//   ───┴───       ← TOP trunk (BZ → team-roots)
//   │     │
//   TR-A  TR-B    ← invisible 1px team-root junctions
//   │     │
//   ┌─┴─┐ ┌─┴─┐   ← per-team sub-trunks (team-root → members)
//   m m m m m m
//
// These tests assert the synthetic-edge shape that produces that hierarchy.
// Team members stay on the SAME hierarchy level as in the team-scoped
// Ghost Graph — the team-root only adds a routing junction, not a visible
// extra "anchor" Boo.

describe('buildGraphElements (atlas scope)', () => {
  it('renders only Boo Zero when no teams are deployed', () => {
    const { rawNodes, rawEdges } = buildGraphElements(
      [booZero],
      new Map(),
      [],
      null,
      booZero,
      null,
      'atlas',
      new Map(),
    )

    const booNodes = rawNodes.filter((n) => n.type === 'boo')
    expect(booNodes.length).toBe(1)
    expect((booNodes[0]?.data as BooNodeData).isUniversalLeader).toBe(true)
    // No team-roots, no synthetic edges.
    expect(rawNodes.filter((n) => n.type === 'team-root')).toEqual([])
    expect(rawEdges.filter(isSynthetic)).toEqual([])
  })

  it('synthesizes ONE invisible team-root per team between Boo Zero and members', () => {
    const m1 = makeAgent({ id: 'm1', name: 'Member 1', teamId: 't1' })
    const m2 = makeAgent({ id: 'm2', name: 'Member 2', teamId: 't1' })
    const teams = [makeTeam({ id: 't1', leaderAgentId: null })]
    const leadMap = new Map<string, string | null>([['t1', null]])

    const { rawNodes, rawEdges } = buildGraphElements(
      [m1, m2, booZero],
      new Map(),
      teams,
      null,
      booZero,
      null,
      'atlas',
      leadMap,
    )

    // Team-root node exists, typed as 'team-root'.
    const teamRoots = rawNodes.filter((n) => n.type === 'team-root')
    expect(teamRoots.map((n) => n.id)).toEqual(['team-root-t1'])

    // Synthetic edges form: BZ → team-root + team-root → each member.
    const syntheticIds = rawEdges
      .filter(isSynthetic)
      .map((e) => e.id)
      .sort()
    expect(syntheticIds).toEqual([
      'dep-syn-bz-team-root-t1',
      'dep-syn-team-root-t1-m1',
      'dep-syn-team-root-t1-m2',
    ])
    expect(rawEdges.filter(isSynthetic).every(isPrimary)).toBe(true)
  })

  it('emits NO synthetic edges from BZ directly to any team member in atlas', () => {
    // The whole point of the team-root junction is that BZ never points
    // at a member directly — only at the (invisible) team-root. This
    // guarantees the top trunk under BZ never spans the union of every
    // team's horizontal extent.
    const m1 = makeAgent({ id: 'm1', name: 'Member 1', teamId: 'tA' })
    const m2 = makeAgent({ id: 'm2', name: 'Member 2', teamId: 'tA' })
    const m3 = makeAgent({ id: 'm3', name: 'Member 3', teamId: 'tB' })
    const m4 = makeAgent({ id: 'm4', name: 'Member 4', teamId: 'tB' })
    const teams = [
      makeTeam({ id: 'tA', leaderAgentId: null }),
      makeTeam({ id: 'tB', leaderAgentId: null }),
    ]
    const leadMap = new Map<string, string | null>([
      ['tA', null],
      ['tB', null],
    ])

    const { rawEdges } = buildGraphElements(
      [m1, m2, m3, m4, booZero],
      new Map(),
      teams,
      null,
      booZero,
      null,
      'atlas',
      leadMap,
    )

    // No direct BZ → member edges.
    const bzToMember = rawEdges.filter(
      (e) =>
        e.source === 'boo-bz' &&
        (e.target === 'boo-m1' ||
          e.target === 'boo-m2' ||
          e.target === 'boo-m3' ||
          e.target === 'boo-m4'),
    )
    expect(bzToMember).toEqual([])

    // BZ only connects to the 2 team-roots.
    const bzOut = rawEdges.filter((e) => e.source === 'boo-bz' && isPrimary(e))
    expect(new Set(bzOut.map((e) => e.target))).toEqual(new Set(['team-root-tA', 'team-root-tB']))
  })

  it('fans out to multiple teams via per-team team-root junctions', () => {
    const mA1 = makeAgent({ id: 'mA1', name: 'Member A1', teamId: 'tA' })
    const mA2 = makeAgent({ id: 'mA2', name: 'Member A2', teamId: 'tA' })
    const mB1 = makeAgent({ id: 'mB1', name: 'Member B1', teamId: 'tB' })
    const teams = [
      makeTeam({ id: 'tA', leaderAgentId: null }),
      makeTeam({ id: 'tB', leaderAgentId: null }),
    ]
    const leadMap = new Map<string, string | null>([
      ['tA', null],
      ['tB', null],
    ])

    const { rawNodes, rawEdges } = buildGraphElements(
      [mA1, mA2, mB1, booZero],
      new Map(),
      teams,
      null,
      booZero,
      null,
      'atlas',
      leadMap,
    )

    // Two team-roots present.
    const teamRoots = rawNodes.filter((n) => n.type === 'team-root')
    expect(new Set(teamRoots.map((n) => n.id))).toEqual(new Set(['team-root-tA', 'team-root-tB']))

    // BZ → each team-root (2 edges share BZ as source → ONE shared trunk
    // under BZ when rendered, with corner branches to each team-root).
    const bzPrimaries = rawEdges.filter((e) => e.source === 'boo-bz' && isPrimary(e))
    expect(bzPrimaries.length).toBe(2)
    expect(new Set(bzPrimaries.map((e) => e.target))).toEqual(
      new Set(['team-root-tA', 'team-root-tB']),
    )
    // Trunk-and-branches sibling tracking confirms the top trunk fans to
    // both team-roots from a single source.
    const trunkLeader = bzPrimaries.find(
      (e) => (e.data as { isTrunkLeader?: boolean }).isTrunkLeader,
    )
    expect(trunkLeader).toBeDefined()
    expect(
      new Set((trunkLeader!.data as { siblingTargetIds?: string[] }).siblingTargetIds ?? []),
    ).toEqual(new Set(['team-root-tA', 'team-root-tB']))

    // Each team-root has its own outgoing sub-trunk to its members.
    const trA = rawEdges.filter((e) => e.source === 'team-root-tA' && isPrimary(e))
    const trB = rawEdges.filter((e) => e.source === 'team-root-tB' && isPrimary(e))
    expect(new Set(trA.map((e) => e.target))).toEqual(new Set(['boo-mA1', 'boo-mA2']))
    expect(new Set(trB.map((e) => e.target))).toEqual(new Set(['boo-mB1']))
  })

  it('skips teams with zero members (no team-root, no edges)', () => {
    const m1 = makeAgent({ id: 'm1', name: 'Member 1', teamId: 't1' })
    const teams = [
      makeTeam({ id: 't1', leaderAgentId: null }),
      makeTeam({ id: 't-empty', leaderAgentId: null }),
    ]
    const leadMap = new Map<string, string | null>([
      ['t1', null],
      ['t-empty', null],
    ])

    const { rawNodes, rawEdges } = buildGraphElements(
      [m1, booZero],
      new Map(),
      teams,
      null,
      booZero,
      null,
      'atlas',
      leadMap,
    )

    // Only one team-root (for t1). t-empty is silently skipped.
    const teamRoots = rawNodes.filter((n) => n.type === 'team-root')
    expect(teamRoots.map((n) => n.id)).toEqual(['team-root-t1'])
    // Two synthetic edges: BZ → team-root-t1, team-root-t1 → m1.
    const synthetic = rawEdges.filter(isSynthetic)
    expect(new Set(synthetic.map((e) => e.id))).toEqual(
      new Set(['dep-syn-bz-team-root-t1', 'dep-syn-team-root-t1-m1']),
    )
  })

  it('falls back to a forest when Boo Zero is absent (atlas, 2 teams, no team-roots)', () => {
    // No Boo Zero → no junctions to synthesize. Each team's spanning
    // tree is rooted at its internal lead (independent forest).
    const leadA = makeAgent({ id: 'lead-A', name: 'Lead A', teamId: 'tA' })
    const mA1 = makeAgent({ id: 'mA1', name: 'Member A1', teamId: 'tA' })
    const leadB = makeAgent({ id: 'lead-B', name: 'Lead B', teamId: 'tB' })
    const mB1 = makeAgent({ id: 'mB1', name: 'Member B1', teamId: 'tB' })
    const teams = [
      makeTeam({ id: 'tA', leaderAgentId: 'lead-A' }),
      makeTeam({ id: 'tB', leaderAgentId: 'lead-B' }),
    ]
    const leadMap = new Map<string, string | null>([
      ['tA', 'lead-A'],
      ['tB', 'lead-B'],
    ])
    const agentFiles = new Map<string, { toolsMd: string | null; agentsMd: string | null }>([
      ['lead-A', { toolsMd: null, agentsMd: '- Route to @Member A1 for tasks.' }],
      ['lead-B', { toolsMd: null, agentsMd: '- Route to @Member B1 for tasks.' }],
    ])

    const { rawNodes, rawEdges } = buildGraphElements(
      [leadA, mA1, leadB, mB1],
      agentFiles,
      teams,
      null,
      null, // no Boo Zero
      null,
      'atlas',
      leadMap,
    )

    // No team-roots emitted without Boo Zero.
    expect(rawNodes.filter((n) => n.type === 'team-root')).toEqual([])
    expect(rawEdges.filter(isSynthetic)).toEqual([])
    const primaryRealEdges = rawEdges.filter(
      (e) => e.type === 'dependency' && !isSynthetic(e) && isPrimary(e),
    )
    expect(primaryRealEdges.length).toBe(2)
    expect(primaryRealEdges.some((e) => e.source === 'boo-lead-A' && e.target === 'boo-mA1')).toBe(
      true,
    )
    expect(primaryRealEdges.some((e) => e.source === 'boo-lead-B' && e.target === 'boo-mB1')).toBe(
      true,
    )
  })

  it('keeps cross-team @-mentions as secondary edges (team-root synthetic wins primary slot)', () => {
    // Agent A (team tA) AGENTS.md mentions Agent B (team tB). In atlas
    // B's primary parent must be team-root-tB (the synthetic junction),
    // NOT agent A — so the cross-team mention renders as a secondary edge.
    const agentA = makeAgent({ id: 'lead-A', name: 'Lead A', teamId: 'tA' })
    const agentB = makeAgent({ id: 'lead-B', name: 'Lead B', teamId: 'tB' })
    const teams = [
      makeTeam({ id: 'tA', leaderAgentId: null }),
      makeTeam({ id: 'tB', leaderAgentId: null }),
    ]
    const leadMap = new Map<string, string | null>([
      ['tA', null],
      ['tB', null],
    ])

    const agentFiles = new Map<string, { toolsMd: string | null; agentsMd: string | null }>([
      ['lead-A', { toolsMd: null, agentsMd: '- Route to @Lead B for tasks.' }],
    ])

    const { rawEdges } = buildGraphElements(
      [agentA, agentB, booZero],
      agentFiles,
      teams,
      null,
      booZero,
      null,
      'atlas',
      leadMap,
    )

    const crossTeamRealEdge = rawEdges.find(
      (e) =>
        e.type === 'dependency' &&
        !isSynthetic(e) &&
        e.source === 'boo-lead-A' &&
        e.target === 'boo-lead-B',
    )
    expect(crossTeamRealEdge).toBeDefined()
    expect(isPrimary(crossTeamRealEdge!)).toBe(false)
    const synEdge = rawEdges.find((e) => e.id === 'dep-syn-team-root-tB-lead-B')
    expect(synEdge).toBeDefined()
    expect(isPrimary(synEdge!)).toBe(true)
  })

  it('always marks Boo Zero with isUniversalLeader flag', () => {
    const m1 = makeAgent({ id: 'm1', name: 'Member 1', teamId: 't1' })
    const teams = [makeTeam({ id: 't1', leaderAgentId: null })]
    const leadMap = new Map<string, string | null>([['t1', null]])

    const { rawNodes } = buildGraphElements(
      [m1, booZero],
      new Map(),
      teams,
      null,
      booZero,
      null,
      'atlas',
      leadMap,
    )

    const booZeroNode = rawNodes.find((n) => n.id === 'boo-bz' && n.type === 'boo')
    expect(booZeroNode).toBeDefined()
    expect((booZeroNode!.data as BooNodeData).isUniversalLeader).toBe(true)
  })
})
