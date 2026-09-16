import { useMemo } from 'react'
import { useViewport } from '@xyflow/react'
import {
  computeConvexHull,
  hullToPath,
  inflateHull,
  rectToRoundedPath,
} from '@/features/graph/TeamHaloLayer'
import { useMemoryGraphStore } from './store'
import {
  communityColor,
  PROC_HEIGHT,
  PROC_WIDTH,
  type MemFactData,
  type MemFlowNode,
} from './types'

// ─── MemoryHullLayer — community hulls behind the canvas ─────────────────────
//
// Reuses TeamHaloLayer's exported pure hull math (Graham scan + centroid-push
// inflation + rounded-rect degenerate fallback). Groups VISIBLE nodes by
// community; hulls render only for communities with ≥3 visible members, at an
// 8% community-color fill with a 25% stroke and a top label. Pure rendering
// layer — absolute-positioned sibling BEFORE <ReactFlow>, mirroring pan/zoom
// via useViewport(); never touches nodes, edges, or layout.

const HULL_PADDING = 46
const LABEL_OFFSET = 14
const FLATNESS_THRESHOLD = 40

interface RenderedHull {
  community: number
  path: string
  color: string
  label: string
  labelX: number
  labelY: number
}

export function MemoryHullLayer({ nodes }: { nodes: MemFlowNode[] }) {
  const vp = useViewport()
  const communities = useMemoryGraphStore((s) => s.payload?.communities ?? null)

  // Quantized position fingerprint — sub-pixel drag updates don't thrash hulls.
  const positionKey = useMemo(
    () =>
      nodes
        .filter((n) => !n.hidden)
        .map((n) => `${n.id}:${n.position.x | 0}:${n.position.y | 0}`)
        .join('|'),
    [nodes],
  )

  const hulls = useMemo(() => {
    const byCommunity = new Map<number, { x: number; y: number }[]>()
    for (const n of nodes) {
      if (n.hidden) continue
      const community = n.data.node.community
      // Visual centers: fact discs are diameter-square, procedure cards 150×44.
      const half =
        n.type === 'memFact'
          ? (n.data as MemFactData).diameter / 2
          : { w: PROC_WIDTH / 2, h: PROC_HEIGHT / 2 }
      const cx = n.position.x + (typeof half === 'number' ? half : half.w)
      const cy = n.position.y + (typeof half === 'number' ? half : half.h)
      const list = byCommunity.get(community)
      if (list) list.push({ x: cx, y: cy })
      else byCommunity.set(community, [{ x: cx, y: cy }])
    }
    const labelOf = new Map((communities ?? []).map((c) => [c.id, c.label]))
    const out: RenderedHull[] = []
    for (const [community, centers] of byCommunity) {
      if (centers.length < 3) continue
      let minX = Infinity
      let minY = Infinity
      let maxX = -Infinity
      let maxY = -Infinity
      for (const c of centers) {
        if (c.x < minX) minX = c.x
        if (c.y < minY) minY = c.y
        if (c.x > maxX) maxX = c.x
        if (c.y > maxY) maxY = c.y
      }
      const flat = maxX - minX < FLATNESS_THRESHOLD || maxY - minY < FLATNESS_THRESHOLD
      let path: string
      let labelX: number
      let labelY: number
      if (flat) {
        // Degenerate row/column — an inflated hull would be a paper-thin strip.
        const x = minX - HULL_PADDING
        const y = minY - HULL_PADDING
        path = rectToRoundedPath(
          x,
          y,
          maxX - minX + HULL_PADDING * 2,
          maxY - minY + HULL_PADDING * 2,
          HULL_PADDING,
        )
        labelX = (minX + maxX) / 2
        labelY = y - LABEL_OFFSET
      } else {
        const inflated = inflateHull(computeConvexHull(centers), HULL_PADDING)
        path = hullToPath(inflated)
        let topY = Infinity
        let cx = 0
        for (const p of inflated) {
          if (p.y < topY) topY = p.y
          cx += p.x
        }
        labelX = cx / inflated.length
        labelY = topY - LABEL_OFFSET
      }
      out.push({
        community,
        path,
        color: communityColor(community),
        label: labelOf.get(community) ?? '',
        labelX,
        labelY,
      })
    }
    return out
  }, [nodes, positionKey, communities])

  if (hulls.length === 0) return null

  const strokePx = 1 / Math.max(vp.zoom, 0.001)
  const fontPx = 12 / Math.max(vp.zoom, 0.001)

  return (
    <div
      aria-hidden="true"
      style={{ position: 'absolute', inset: 0, pointerEvents: 'none', zIndex: 0 }}
    >
      <svg width="100%" height="100%" style={{ overflow: 'visible' }}>
        <g transform={`translate(${vp.x}, ${vp.y}) scale(${vp.zoom})`}>
          {hulls.map((hull) => (
            <g key={hull.community}>
              <path
                d={hull.path}
                strokeWidth={strokePx}
                strokeLinejoin="round"
                style={{
                  fill: `color-mix(in srgb, ${hull.color} 8%, transparent)`,
                  stroke: `color-mix(in srgb, ${hull.color} 25%, transparent)`,
                }}
              />
              {hull.label && (
                <text
                  x={hull.labelX}
                  y={hull.labelY}
                  fontSize={fontPx}
                  fontWeight={600}
                  textAnchor="middle"
                  className="font-data"
                  style={{ fill: hull.color, letterSpacing: '0.04em' }}
                >
                  {hull.label}
                </text>
              )}
            </g>
          ))}
        </g>
      </svg>
    </div>
  )
}
