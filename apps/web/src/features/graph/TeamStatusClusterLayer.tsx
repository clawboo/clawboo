import { useMemo } from 'react'
import { useStore, useViewport } from '@xyflow/react'
import { useFleetStore } from '@/stores/fleet'
import { useTeamStore } from '@/stores/team'
import { teamStatusBreakdown } from '@/lib/teamStatus'
import { centreOf, segmentsFrom } from './looseNodes'
import {
  TEAM_BADGE_MIN_SCREEN,
  TEAM_BADGE_RING,
  TEAM_BADGE_SIZE,
  teamBadgeScreenSize,
} from './nodes/TeamBadge'
import { keepoutsFrom, placePills, sideBox, type KeepoutNode } from './teamPillPlacement'
import type { TeamRootNodeData } from './types'
import { selectZoomStep } from './useMinScreenSize'

/**
 * TeamStatusClusterLayer.
 *
 * Renders a compact `● N` aggregate-status pill beside every Atlas team-root
 * junction. Inspired by the General Intelligence Cofounder hub screenshot
 * (#4 from the reference set) — gives at-a-glance team activity without
 * forcing the user to count Boos.
 *
 * WHICH SIDE is worked out per team (see teamPillPlacement.ts): right of the
 * badge unless a line, a Boo, another badge or another pill is there. Straight
 * above is where the line from Boo Zero comes in, so it is tried near last.
 *
 * Architecture mirrors TeamHaloLayer: absolute-positioned SVG sibling, inner
 * `<g>` transformed by `useViewport()` so pan/zoom stays locked to the
 * underlying graph coordinates. No physics, no node-tree mutation.
 *
 * Only rendered when `scope === 'atlas'` — per-team scope doesn't have
 * team-root junctions and the cluster would have no anchor.
 */

interface TeamStatusClusterLayerProps {
  /** Everything the canvas draws, so the pills can keep clear of all of it. */
  nodes: readonly KeepoutNode[]
  /** The edges as drawn, closed rings marked, for the lines to keep off. */
  edges: readonly {
    source: string
    target: string
    type?: string
    hidden?: boolean
    data?: unknown
  }[]
}

interface BucketDefinition {
  key: 'running' | 'error' | 'sleeping' | 'idle'
  color: string
  pulse: boolean
  /** Tooltip word — "3 running", "2 idle", etc. */
  word: string
}

// `pulse` is "this is moving or wants you", not "this is good news". Only the
// running bucket used to animate, so a team with three errors sat perfectly still
// while a team with one healthy agent throbbed for attention.
const BUCKETS: readonly BucketDefinition[] = [
  { key: 'running', color: 'var(--mint)', pulse: true, word: 'running' },
  { key: 'error', color: 'var(--destructive)', pulse: true, word: 'error' },
  { key: 'sleeping', color: 'var(--secondary)', pulse: false, word: 'sleeping' },
  { key: 'idle', color: 'rgb(var(--foreground-rgb) / 0.45)', pulse: false, word: 'idle' },
] as const

// SCREEN pixels, not graph units. The pill's SIZE is screen-fixed (see the note
// below), so a distance measured in graph units drifted away from the team at
// every zoom except 1. Its distance from the badge is screen space too, so the
// pill keeps its place beside the badge whatever the zoom.
const PILL_HEIGHT = 22
/** Clear air between the team's junction badge and its pill. */
const BADGE_GAP = 6
/** Below this zoom the badge holds its floor size; above it, it grows. */
const BADGE_FLOOR_ZOOM = TEAM_BADGE_MIN_SCREEN / TEAM_BADGE_SIZE
const PILL_PADDING_X = 9
const DOT_RADIUS = 3.5
const DOT_GAP = 7 // dot to its text
const SEGMENT_GAP = 12 // one bucket to the next
const CHAR_W = 6.2 // 11px mono, close enough to lay out without measuring

/** Width of one "● 4 running" segment. */
function segmentWidth(count: number, word: string): number {
  return DOT_RADIUS * 2 + DOT_GAP + (String(count).length + 1 + word.length) * CHAR_W
}

export function TeamStatusClusterLayer({ nodes, edges }: TeamStatusClusterLayerProps) {
  const vp = useViewport()
  // The placement moves only when the zoom crosses a step, never on a pan.
  const zoom = useStore(selectZoomStep)
  const agents = useFleetStore((s) => s.agents)
  const teams = useTeamStore((s) => s.teams)

  // Each team's junction: the point its badge is centred on, in graph units.
  const teamRoots = useMemo(() => {
    const out: Array<{ id: string; teamId: string; x: number; y: number }> = []
    for (const node of nodes) {
      if (node.type !== 'team-root') continue
      const data = node.data as TeamRootNodeData
      if (!data.teamId) continue
      out.push({ id: node.id, teamId: data.teamId, ...centreOf(node) })
    }
    return out
  }, [nodes])

  const clusters = useMemo(() => {
    const teamLookup = new Map(teams.map((t) => [t.id, t]))
    return teamRoots
      .map((tr) => {
        const team = teamLookup.get(tr.teamId)
        if (!team) return null
        const members = agents.filter((a) => a.teamId === tr.teamId)
        if (members.length === 0) return null
        const breakdown = teamStatusBreakdown(members)
        // Only show buckets with N > 0. Always show at least the running
        // bucket so the cluster never collapses to invisible mid-activity.
        const shown = BUCKETS.filter((b) => breakdown[b.key] > 0)
        if (shown.length === 0) return null
        const widths = shown.map((b) => segmentWidth(breakdown[b.key], b.word))
        const pillWidth =
          PILL_PADDING_X * 2 +
          widths.reduce((a, w) => a + w, 0) +
          SEGMENT_GAP * Math.max(0, shown.length - 1)
        return { teamRoot: tr, team, breakdown, shown, widths, pillWidth }
      })
      .filter(<T,>(v: T | null): v is T => v !== null)
  }, [teamRoots, teams, agents])

  // The lines as drawn, in graph units: they only change when the graph does.
  const segments = useMemo(() => segmentsFrom(nodes, edges), [nodes, edges])

  // Where each pill sits, as an offset from its junction in screen pixels.
  //
  // THE SIDE IS CHOSEN AT NO MORE THAN THE BADGE'S FLOOR ZOOM. Past it the badge
  // grows while the pill does not, so zooming in only ever opens more room
  // around every side: lines are rays from the junction or run further off,
  // and everything else moves apart. Choosing there keeps a pill on one side
  // however far in you zoom, instead of hopping each time another side clears.
  const offsets = useMemo(() => {
    // The badge's radius on screen at a zoom; its ring counts.
    const badgeRadius = (z: number): number => teamBadgeScreenSize(z) * (0.5 + TEAM_BADGE_RING)
    const at = Math.min(zoom, BADGE_FLOOR_ZOOM)
    const placed = placePills(
      clusters.map(({ teamRoot, pillWidth }) => ({
        id: teamRoot.id,
        x: teamRoot.x * at,
        y: teamRoot.y * at,
        width: pillWidth,
      })),
      {
        badgeRadius: badgeRadius(at),
        gap: BADGE_GAP,
        height: PILL_HEIGHT,
        segments: segments.map((s) => ({
          x1: s.x1 * at,
          y1: s.y1 * at,
          x2: s.x2 * at,
          y2: s.y2 * at,
        })),
        keepouts: keepoutsFrom(nodes, at, badgeRadius(at)),
      },
    )
    const clear = badgeRadius(zoom) + BADGE_GAP
    const out = new Map<string, { dx: number; dy: number }>()
    for (const { teamRoot, pillWidth } of clusters) {
      const p = placed.get(teamRoot.id)
      if (!p) continue
      const box = sideBox(p.side, 0, 0, pillWidth / 2, PILL_HEIGHT / 2, clear)
      out.set(teamRoot.id, { dx: box.cx, dy: box.cy })
    }
    return out
  }, [clusters, segments, nodes, zoom])

  if (clusters.length === 0) return null

  // Render clusters in SCREEN space so they're a constant visual size
  // regardless of canvas zoom. Only the POSITION is computed from
  // graph-coords; dimensions stay in screen pixels. Necessary because the
  // Atlas fits 17+ Boos in one view → fitView zoom drops to ~0.20, which
  // would shrink a 22 px pill to ~4 px if rendered inside the standard
  // transform group.
  return (
    <div
      aria-hidden="true"
      style={{
        position: 'absolute',
        top: 0,
        left: 0,
        right: 0,
        bottom: 0,
        pointerEvents: 'none',
        zIndex: 5,
      }}
    >
      <svg width="100%" height="100%" style={{ overflow: 'visible' }}>
        {clusters.map(({ teamRoot, team, breakdown, shown, widths, pillWidth }) => {
          const offset = offsets.get(teamRoot.id) ?? { dx: 0, dy: 0 }
          // Graph-coords → screen-coords via the viewport transform, then over to
          // the pill's side of the badge.
          const screenX = vp.x + teamRoot.x * vp.zoom + offset.dx
          const screenY = vp.y + teamRoot.y * vp.zoom + offset.dy
          const left = -pillWidth / 2
          const top = -PILL_HEIGHT / 2
          return (
            <g
              key={teamRoot.id}
              transform={`translate(${screenX}, ${screenY})`}
              aria-label={`${team.name} — ${breakdown.running} running, ${breakdown.idle} idle, ${breakdown.sleeping} sleeping, ${breakdown.error} error`}
            >
              {/* Pill background — subtle dark capsule that reads against
                  both light and dark canvas backdrops. */}
              <rect
                x={left}
                y={top}
                width={pillWidth}
                height={PILL_HEIGHT}
                rx={PILL_HEIGHT / 2}
                ry={PILL_HEIGHT / 2}
                fill="rgb(var(--canvas-rgb) / 0.85)"
                stroke="rgb(var(--foreground-rgb) / 0.18)"
                strokeWidth={1}
                style={{ paintOrder: 'stroke' }}
              />
              {/* Per-bucket dots + counts */}
              {shown.map((bucket, i) => {
                const offset = widths.slice(0, i).reduce((a, w) => a + w + SEGMENT_GAP, 0)
                const dotX = left + PILL_PADDING_X + offset + DOT_RADIUS
                const textX = dotX + DOT_RADIUS + DOT_GAP
                return (
                  <g key={bucket.key}>
                    <circle
                      cx={dotX}
                      cy={0}
                      r={DOT_RADIUS}
                      fill={bucket.color}
                      style={
                        bucket.pulse
                          ? { animation: 'clawboo-cluster-dot-pulse 1.4s ease-in-out infinite' }
                          : undefined
                      }
                    />
                    <text
                      x={textX}
                      y={1}
                      fontSize={11}
                      fontWeight={600}
                      textAnchor="start"
                      dominantBaseline="middle"
                      fill="rgb(var(--foreground-rgb) / 0.85)"
                      style={{
                        fontFamily: 'var(--font-mono)',
                        fontVariantNumeric: 'tabular-nums',
                      }}
                    >
                      {breakdown[bucket.key]} {bucket.word}
                    </text>
                  </g>
                )
              })}
            </g>
          )
        })}
      </svg>
    </div>
  )
}
