import { memo } from 'react'
import { Handle, Position, useStore } from '@xyflow/react'
import type { Node, NodeProps } from '@xyflow/react'
import { User, Users } from 'lucide-react'
import type { LearningEntry } from '@/lib/memoryClient'
import { computeNodeIntensity, useMemoryGraphStore } from '../store'
import type { MemFactData } from '../types'

// ─── MemoryFactNode: a paper disc that anchors its label ────────────────────
//
// ACHROMATIC BY DEFAULT. The disc is a neutral surface with a hairline edge and
// real elevation; the label carries the meaning. Colour appears ONLY when a
// fact has earned a learning state from teammate feedback, so a tinted node is
// always a signal rather than decoration.
//
// Two things this deliberately does NOT do, both of which read as "demo":
//   • no per-cluster hue: clusters are spatial + labelled (see MemoryHullLayer)
//   • no idle float: a knowledge canvas should sit still and be read
//
// Dim/highlight stays CSS-opacity only, so filters and search never touch the
// node array and the ELK layout stays stable.

const centerHandleStyle: React.CSSProperties = {
  position: 'absolute',
  top: '50%',
  left: '50%',
  transform: 'translate(-50%, -50%)',
  opacity: 0,
  pointerEvents: 'none',
  width: 1,
  height: 1,
  minWidth: 0,
  minHeight: 0,
  border: 'none',
  background: 'transparent',
}

interface DiscSurface {
  borderColor: string
  borderWidth: number
  borderStyle: 'solid' | 'dashed'
  background: string
}

/** The disc's own edge carries learning state: one mark, no second ring. */
export function learningSurface(learning: LearningEntry | null): DiscSurface {
  switch (learning?.status) {
    case 'preferred':
      return {
        borderColor: 'var(--mint)',
        borderWidth: 2,
        borderStyle: 'solid',
        background: 'color-mix(in srgb, var(--mint) 9%, var(--graph-node-bg))',
      }
    case 'contested':
      return {
        borderColor: 'var(--amber)',
        borderWidth: 2,
        borderStyle: 'solid',
        background: 'color-mix(in srgb, var(--amber) 9%, var(--graph-node-bg))',
      }
    case 'tentative':
      return {
        borderColor: 'color-mix(in srgb, var(--mint) 50%, var(--graph-node-border))',
        borderWidth: 1.5,
        borderStyle: 'solid',
        background: 'var(--graph-node-bg)',
      }
    case 'dead_end':
      return {
        borderColor: 'var(--graph-node-border-strong)',
        borderWidth: 1.5,
        borderStyle: 'dashed',
        background: 'var(--graph-node-bg)',
      }
    default:
      return {
        borderColor: 'var(--graph-node-border)',
        borderWidth: 1,
        borderStyle: 'solid',
        background: 'var(--graph-node-bg)',
      }
  }
}

export const MemoryFactNode = memo(function MemoryFactNode({
  id,
  data,
}: NodeProps<Node<MemFactData, 'memFact'>>) {
  const { node, diameter, degreeP75 } = data

  const selected = useMemoryGraphStore((s) => s.selectedNodeId === id)
  const highlighted = useMemoryGraphStore((s) => s.highlightedNodeIds?.has(id) ?? false)
  const intensity = useMemoryGraphStore((s) => computeNodeIntensity(s, node, Date.now()))
  // Zoom rounded to 0.1 so the label-declutter subscription re-renders at
  // bucket boundaries only, not on every wheel tick.
  const zoom = useStore((s) => Math.round(s.transform[2] * 10) / 10)

  const showLabel = node.degree >= degreeP75 || zoom >= 0.9 || selected || highlighted
  const surface = learningSurface(node.learning)
  const ScopeGlyph = node.scope === 'agent' ? User : node.scope === 'team' ? Users : null
  const isDeadEnd = node.learning?.status === 'dead_end'

  // A gap ring: canvas-coloured spacer, then the accent. Reads as a deliberate
  // selection affordance rather than a glow bleeding into the node.
  const ring = selected
    ? '0 0 0 2px var(--canvas), 0 0 0 3.5px var(--primary)'
    : highlighted
      ? '0 0 0 2px var(--canvas), 0 0 0 3px var(--graph-node-border-strong)'
      : null

  return (
    <div
      data-testid={`mem-node-${id}`}
      title={node.title}
      style={{
        width: diameter,
        height: diameter,
        position: 'relative',
        overflow: 'visible',
        opacity: isDeadEnd ? intensity * 0.55 : intensity,
        transition: 'opacity 160ms ease',
      }}
    >
      <div
        style={{
          width: diameter,
          height: diameter,
          borderRadius: '50%',
          background: surface.background,
          borderWidth: surface.borderWidth,
          borderStyle: surface.borderStyle,
          borderColor: surface.borderColor,
          boxShadow: ring ? `${ring}, var(--graph-node-shadow)` : 'var(--graph-node-shadow)',
          transition: 'box-shadow 160ms ease, border-color 160ms ease',
        }}
      />

      {/* Label under the disc, decluttered (hubs / high zoom / selection). The
          scope glyph rides inline so a 14px disc never carries a second mark. */}
      {showLabel && (
        <div
          style={{
            position: 'absolute',
            top: diameter + 7,
            left: '50%',
            transform: 'translateX(-50%)',
            display: 'flex',
            alignItems: 'center',
            gap: 3,
            maxWidth: 148,
            whiteSpace: 'nowrap',
          }}
        >
          {ScopeGlyph && (
            <ScopeGlyph
              size={9}
              strokeWidth={2.25}
              aria-hidden
              style={{ color: 'var(--muted-foreground)', flexShrink: 0 }}
            />
          )}
          <span
            style={{
              fontSize: 11,
              fontWeight: 500,
              letterSpacing: '-0.005em',
              color: selected ? 'var(--foreground)' : 'var(--graph-label)',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
            }}
          >
            {node.title.length > 26 ? `${node.title.slice(0, 26)}…` : node.title}
          </span>
        </div>
      )}

      {/* Invisible center handles: edge routing only. */}
      <Handle id="center" type="source" position={Position.Top} style={centerHandleStyle} />
      <Handle id="center-target" type="target" position={Position.Top} style={centerHandleStyle} />
    </div>
  )
})
