// The padding every fitView on the graph uses.
//
// The viewport bar floats over the canvas's bottom-right corner, and a
// symmetric fit put Boos under it: Sage and Rin at the end of a team graph's
// bottom row, Wren in the Radial org chart's lower-right team. These lay out
// the demo fleet with the graph's own builder and layouts, fit it with React
// Flow's own math (getViewportForBounds) at the canvas sizes the app draws, and
// check that every Boo ends above the bar.

import { getViewportForBounds } from '@xyflow/react'
import { describe, expect, it } from 'vitest'

import type { AgentState } from '@/stores/fleet'
import type { Team } from '@/stores/team'

import { graphFitPadding, VIEWPORT_BAR_HEIGHT, VIEWPORT_BAR_INSET } from '../fitPadding'
import type { GraphNode } from '../types'
import { buildGraphElements } from '../useGraphData'
import { computeAtlasRadialLayout, computeElkLayout } from '../useGraphLayout'

// ─── The demo fleet: Boo Zero and three teams, the first name each team's lead ─

const agent = (id: string, teamId: string | null): AgentState =>
  ({
    id,
    name: id,
    status: 'idle',
    sessionKey: null,
    model: null,
    createdAt: null,
    streamingText: null,
    runId: null,
    lastSeenAt: null,
    teamId,
    execConfig: null,
  }) as AgentState

const team = (id: string): Team => ({
  id,
  name: id,
  icon: '🚀',
  color: '#FB923C',
  colorCollectionId: null,
  templateId: null,
  agentCount: 0,
  leaderAgentId: null,
  isArchived: false,
  serverOrchestrated: true,
})

const ROSTER: Record<string, string[]> = {
  growth: ['Ada', 'Rin', 'Milo', 'Kit', 'Sage'],
  support: ['Juno', 'Pax', 'Wren'],
  platform: ['Iris', 'Otto', 'Bex'],
}
const TEAMS = Object.keys(ROSTER).map(team)
const BOO_ZERO = agent('Boo Zero', null)
const membersOf = (teamId: string) => ROSTER[teamId]!.map((name) => agent(name, teamId))

/** A Boo's node box (BOO_FOOTPRINT in nodes/BooNode.tsx), the box the fit frames. */
const BOO_ENVELOPE = 280

/** The nodes and primary edges the layout effect hands a layout. */
function layoutInput(
  rawNodes: GraphNode[],
  rawEdges: ReturnType<typeof buildGraphElements>['rawEdges'],
) {
  return {
    nodes: rawNodes.filter((n) => n.type === 'boo' || n.type === 'team-root'),
    edges: rawEdges.filter(
      (e) => e.type === 'dependency' && (e.data as { isPrimary?: boolean })?.isPrimary !== false,
    ),
  }
}

/** The Growth team's graph, laid out for a card of this size. */
async function teamGraph(card: { w: number; h: number }) {
  const { rawNodes, rawEdges } = buildGraphElements(
    [...membersOf('growth'), BOO_ZERO],
    new Map(),
    TEAMS,
    'Ada',
    BOO_ZERO,
    'growth',
    'team',
  )
  const { nodes, edges } = layoutInput(rawNodes, rawEdges)
  return computeElkLayout(nodes, edges, {}, card.w / card.h)
}

/** The whole fleet as the Radial org chart lays it out. */
async function orgChart() {
  const { rawNodes, rawEdges } = buildGraphElements(
    [...Object.keys(ROSTER).flatMap(membersOf), BOO_ZERO],
    new Map(),
    TEAMS,
    null,
    BOO_ZERO,
    null,
    'atlas',
    new Map(Object.entries(ROSTER).map(([id, names]) => [id, names[0]!])),
    true,
  )
  const { nodes, edges } = layoutInput(rawNodes, rawEdges)
  return computeAtlasRadialLayout(
    nodes,
    edges,
    {},
    TEAMS.map((t) => t.id),
  )
}

/**
 * How far above the viewport bar's top each Boo ends once the camera fits the
 * Boos (pickFittableNodes in GhostGraph.tsx) into a canvas of this size.
 */
function clearanceAboveBar(laidOut: GraphNode[], canvas: { w: number; h: number }, padding = 0.04) {
  const boos = laidOut.filter((n) => n.type === 'boo')
  const xs = boos.map((n) => n.position.x)
  const ys = boos.map((n) => n.position.y)
  const bounds = {
    x: Math.min(...xs),
    y: Math.min(...ys),
    width: Math.max(...xs) - Math.min(...xs) + BOO_ENVELOPE,
    height: Math.max(...ys) - Math.min(...ys) + BOO_ENVELOPE,
  }
  // The canvas's minZoom and the fit's own maxZoom.
  const vp = getViewportForBounds(
    bounds,
    canvas.w,
    canvas.h,
    0.15,
    1.5,
    graphFitPadding(padding, canvas.h),
  )
  const barTop = canvas.h - VIEWPORT_BAR_INSET - VIEWPORT_BAR_HEIGHT
  return Object.fromEntries(
    boos.map((n) => [n.id, barTop - (vp.y + (n.position.y + BOO_ENVELOPE) * vp.zoom)]),
  )
}

const everyBooClears = (gaps: Record<string, number>) =>
  Object.entries(gaps).filter(([, gap]) => gap < 0)

// Canvas sizes measured in the app: the Team graph card at its default split
// in a 1600x845 and a 1600x880 window, and the org chart in a 1600x845 and a
// 1064x806 window.
const TEAM_CARD_845 = { w: 612, h: 414 }
const TEAM_CARD_880 = { w: 612, h: 433 }
const ORG_CHART_845 = { w: 1304, h: 801 }
const ORG_CHART_1064 = { w: 768, h: 762 }

describe('graphFitPadding', () => {
  it('reserves the viewport bar at the bottom of a tight fit', () => {
    expect(graphFitPadding(0.04, 414)).toEqual({ x: 0.04, top: 0.04, bottom: '62px' })
  })

  it('keeps a loose fit symmetric once its own margin clears the bar', () => {
    // 0.2 of a 1200px canvas is 100px a side, more than the bar needs.
    expect(graphFitPadding(0.2, 1200)).toEqual({ x: 0.2, top: 0.2, bottom: '100px' })
  })

  it.each([
    ['at its default size in a 1600x845 window', TEAM_CARD_845, TEAM_CARD_845],
    ['made 110px shorter after the layout', TEAM_CARD_845, { w: 612, h: 304 }],
    ['at its default size in a 1600x880 window', TEAM_CARD_880, TEAM_CARD_880],
    ['made 143px shorter after the layout', TEAM_CARD_880, { w: 612, h: 290 }],
  ])(
    'keeps every Boo in the Team graph card above the bar %s',
    async (_label, layoutCard, fitCard) => {
      const gaps = clearanceAboveBar(await teamGraph(layoutCard), fitCard)
      expect(everyBooClears(gaps)).toEqual([])
    },
  )

  it('keeps the Team graph above the bar on Fit to view', async () => {
    const gaps = clearanceAboveBar(await teamGraph(TEAM_CARD_845), TEAM_CARD_845, 0.2)
    expect(everyBooClears(gaps)).toEqual([])
  })

  // Only Radial: the Tree chart is a wide row that the fit sizes by its width,
  // so it ends well above the bar with or without the reserved band.
  it.each([
    ['in a 1600x845 window', ORG_CHART_845],
    ['in a 1064x806 window', ORG_CHART_1064],
    // The window sizes the org chart is checked at, less the sidebar and header.
    ['in a 1360x850 window', { w: 1064, h: 806 }],
    ['in a 1408x880 window', { w: 1112, h: 836 }],
    ['in a 1440x900 window', { w: 1144, h: 856 }],
    ['in a 1920x1080 window', { w: 1624, h: 1036 }],
  ])('keeps every Boo on the Radial org chart above the bar %s', async (_label, canvas) => {
    const laidOut = await orgChart()
    expect(everyBooClears(clearanceAboveBar(laidOut, canvas))).toEqual([])
    // Fit to view's looser fit too.
    expect(everyBooClears(clearanceAboveBar(laidOut, canvas, 0.2))).toEqual([])
  })
})
