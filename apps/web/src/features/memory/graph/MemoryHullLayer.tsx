import { useMemo } from 'react'
import { useViewport } from '@xyflow/react'
import { rectToRoundedPath } from '@/features/graph/TeamHaloLayer'
import { useMemoryGraphStore } from './store'
import { PROC_HEIGHT, PROC_WIDTH, type MemFactData, type MemFlowNode } from './types'

// ─── MemoryHullLayer: cluster containers behind the canvas ──────────────────
//
// A cluster is a ROUNDED CONTAINER with a hairline dashed edge and a small
// uppercase label, not an organic hull in a cluster colour.
//
// Two deliberate changes from the first pass, both about looking considered:
//   • a convex hull of 3–4 points renders as an arbitrary triangle/wedge, which
//     reads as a random shape rather than a designed region. A rounded rect is
//     the same information with an intentional silhouette.
//   • the fill/stroke are achromatic, so clusters group without competing with
//     the learning-state colour that nodes actually use to mean something.
//
// Pure rendering layer: an absolute-positioned sibling BEFORE <ReactFlow>,
// mirroring pan/zoom via useViewport(); never touches nodes, edges, or layout.

const PADDING = 40
const CORNER = 20
const LABEL_INSET = 12

interface RenderedCluster {
  community: number
  path: string
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

  const clusters = useMemo(() => {
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
    const out: RenderedCluster[] = []
    for (const [community, centers] of byCommunity) {
      // A lone node is its own label already; a container around it is noise.
      if (centers.length < 2) continue
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
      const x = minX - PADDING
      const y = minY - PADDING
      out.push({
        community,
        path: rectToRoundedPath(x, y, maxX - minX + PADDING * 2, maxY - minY + PADDING * 2, CORNER),
        label: labelOf.get(community) ?? '',
        labelX: x + LABEL_INSET,
        labelY: y + LABEL_INSET + 2,
      })
    }
    return out
  }, [nodes, positionKey, communities])

  if (clusters.length === 0) return null

  // Counter-scale so the hairline and label hold their size through zoom.
  const inv = 1 / Math.max(vp.zoom, 0.001)
  const strokePx = inv
  const fontPx = 9.5 * inv

  return (
    <div
      aria-hidden="true"
      style={{ position: 'absolute', inset: 0, pointerEvents: 'none', zIndex: 0 }}
    >
      <svg width="100%" height="100%" style={{ overflow: 'visible' }}>
        <g transform={`translate(${vp.x}, ${vp.y}) scale(${vp.zoom})`}>
          {clusters.map((cluster) => (
            <g key={cluster.community}>
              <path
                d={cluster.path}
                strokeWidth={strokePx}
                strokeLinejoin="round"
                strokeDasharray={`${4 * inv} ${4 * inv}`}
                style={{
                  fill: 'var(--graph-cluster-bg)',
                  stroke: 'var(--graph-cluster-border)',
                }}
              />
              {cluster.label && (
                <text
                  x={cluster.labelX}
                  y={cluster.labelY}
                  fontSize={fontPx}
                  fontWeight={600}
                  dominantBaseline="hanging"
                  className="font-data"
                  style={{
                    fill: 'var(--graph-cluster-label)',
                    letterSpacing: `${0.1 * inv}em`,
                    textTransform: 'uppercase',
                  }}
                >
                  {cluster.label}
                </text>
              )}
            </g>
          ))}
        </g>
      </svg>
    </div>
  )
}
