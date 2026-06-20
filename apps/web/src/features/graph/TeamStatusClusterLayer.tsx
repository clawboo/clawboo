import { useMemo } from 'react'
import { useViewport } from '@xyflow/react'
import { useFleetStore } from '@/stores/fleet'
import { useTeamStore } from '@/stores/team'
import { teamStatusBreakdown } from '@/lib/teamStatus'
import type { GraphNode, TeamRootNodeData } from './types'

/**
 * TeamStatusClusterLayer.
 *
 * Renders a compact `● N` aggregate-status pill above every Atlas team-root
 * junction. Inspired by the General Intelligence Cofounder hub screenshot
 * (#4 from the reference set) — gives at-a-glance team activity without
 * forcing the user to count Boos.
 *
 * Architecture mirrors TeamHaloLayer: absolute-positioned SVG sibling, inner
 * `<g>` transformed by `useViewport()` so pan/zoom stays locked to the
 * underlying graph coordinates. No physics, no node-tree mutation.
 *
 * Only rendered when `scope === 'atlas'` — per-team scope doesn't have
 * team-root junctions and the cluster would have no anchor.
 */

interface TeamStatusClusterLayerProps {
  nodes: GraphNode[]
}

interface BucketDefinition {
  key: 'running' | 'error' | 'sleeping' | 'idle'
  color: string
  pulse: boolean
  /** Tooltip word — "3 running", "2 idle", etc. */
  word: string
}

const BUCKETS: readonly BucketDefinition[] = [
  { key: 'running', color: 'var(--mint)', pulse: true, word: 'running' },
  { key: 'error', color: '#ef4444', pulse: false, word: 'error' },
  { key: 'sleeping', color: '#64748b', pulse: false, word: 'sleeping' },
  { key: 'idle', color: 'rgb(var(--foreground-rgb) / 0.45)', pulse: false, word: 'idle' },
] as const

const CLUSTER_Y_OFFSET = 36 // pixels above the team-root anchor
const PILL_HEIGHT = 22
const PILL_PADDING_X = 8
const DOT_RADIUS = 3.5
const DOT_SPACING = 18 // horizontal stride per shown bucket

export function TeamStatusClusterLayer({ nodes }: TeamStatusClusterLayerProps) {
  const vp = useViewport()
  const agents = useFleetStore((s) => s.agents)
  const teams = useTeamStore((s) => s.teams)

  // Stable team-root list — we re-render when any team-root moves or when the
  // fleet status changes. Position-keyed memo avoids sub-pixel drag thrash.
  const teamRoots = useMemo(() => {
    const out: Array<{ id: string; teamId: string; x: number; y: number }> = []
    for (const node of nodes) {
      if (node.type !== 'team-root') continue
      const data = node.data as TeamRootNodeData
      if (!data.teamId) continue
      out.push({
        id: node.id,
        teamId: data.teamId,
        x: node.position.x | 0,
        y: node.position.y | 0,
      })
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
        return { teamRoot: tr, team, breakdown, shown }
      })
      .filter(<T,>(v: T | null): v is T => v !== null)
  }, [teamRoots, teams, agents])

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
        {clusters.map(({ teamRoot, team, breakdown, shown }) => {
          const pillWidth = PILL_PADDING_X * 2 + DOT_SPACING * shown.length
          // Graph-coords → screen-coords via the viewport transform.
          const screenX = vp.x + (teamRoot.x + 0.5) * vp.zoom
          const screenY = vp.y + (teamRoot.y - CLUSTER_Y_OFFSET) * vp.zoom
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
                const dotX = left + PILL_PADDING_X + DOT_SPACING * i + DOT_SPACING / 2 - 6
                const textX = dotX + 6
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
                      {breakdown[bucket.key]}
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
