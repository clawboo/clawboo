import { memo } from 'react'
import { Handle, Position, useStore } from '@xyflow/react'
import type { Node, NodeProps } from '@xyflow/react'
import { User, Users } from 'lucide-react'
import { useFloatingMotion } from '@/features/graph/useFloatingMotion'
import type { LearningEntry } from '@/lib/memoryClient'
import { computeNodeIntensity, useMemoryGraphStore } from '../store'
import { communityColor, type MemFactData } from '../types'

// ─── MemoryFactNode — a degree-sized community-colored disc ──────────────────
//
// The graph encodings, mapped onto the design system: node size = degree,
// color = community (via --mem-cN so both themes flow through), scope as a
// small glyph badge, a learning-status ring 4px outside the disc, and label
// declutter (labels only for hub nodes, high zoom, or the active selection).
// Dim/highlight is CSS-opacity only — filters and search never touch the node
// array, so the ELK layout stays stable. No Framer Motion layout/layoutId
// (documented AnimatePresence hazard); life comes from the shared float bob.

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

/** Ring stroke per learning status; null = no ring (incl. status:null entries). */
export function learningRingStyle(learning: LearningEntry | null): React.CSSProperties | null {
  switch (learning?.status) {
    case 'preferred':
      return { border: '2.5px solid var(--mint)' }
    case 'tentative':
      return { border: '2px dotted var(--mint)' }
    case 'contested':
      return { border: '2.5px solid var(--amber)' }
    case 'dead_end':
      return { border: '2px dashed rgb(var(--foreground-rgb) / 0.45)' }
    default:
      return null
  }
}

export const MemoryFactNode = memo(function MemoryFactNode({
  id,
  data,
  dragging,
}: NodeProps<Node<MemFactData, 'memFact'>>) {
  const { node, diameter, degreeP75 } = data
  const color = communityColor(node.community)
  const floatRef = useFloatingMotion(id, 'skill', dragging)

  const selected = useMemoryGraphStore((s) => s.selectedNodeId === id)
  const highlighted = useMemoryGraphStore((s) => s.highlightedNodeIds?.has(id) ?? false)
  const intensity = useMemoryGraphStore((s) => computeNodeIntensity(s, node, Date.now()))
  // Zoom rounded to 0.1 so the label-declutter subscription re-renders at
  // bucket boundaries only, not on every wheel tick.
  const zoom = useStore((s) => Math.round(s.transform[2] * 10) / 10)

  const showLabel = node.degree >= degreeP75 || zoom >= 0.9 || selected || highlighted
  const ring = learningRingStyle(node.learning)
  const ScopeGlyph = node.scope === 'agent' ? User : node.scope === 'team' ? Users : null

  return (
    <div ref={floatRef}>
      <div
        data-testid={`mem-node-${id}`}
        title={node.title}
        style={{
          width: diameter,
          height: diameter,
          position: 'relative',
          overflow: 'visible',
          opacity: intensity,
          transition: 'opacity 150ms ease',
        }}
      >
        {/* Learning ring — 4px outside the disc, driven by teammate feedback. */}
        {ring && (
          <div
            aria-hidden
            data-testid={`mem-node-ring-${node.learning?.status ?? ''}`}
            style={{
              position: 'absolute',
              inset: -6,
              borderRadius: '50%',
              pointerEvents: 'none',
              ...ring,
            }}
          />
        )}

        <div
          style={{
            width: diameter,
            height: diameter,
            borderRadius: '50%',
            background: `color-mix(in srgb, ${color} 22%, var(--surface))`,
            border: `1.5px solid color-mix(in srgb, ${color} 55%, var(--border))`,
            boxShadow: selected
              ? `0 0 0 2px color-mix(in srgb, ${color} 65%, transparent)`
              : `0 2px 8px color-mix(in srgb, ${color} 18%, transparent)`,
            transition: 'box-shadow 150ms ease',
          }}
        />

        {/* Scope glyph — a per-node mark (halos are reserved for communities). */}
        {ScopeGlyph && (
          <span
            aria-hidden
            style={{
              position: 'absolute',
              right: -2,
              bottom: -2,
              display: 'inline-flex',
              opacity: 0.6,
              color: 'var(--foreground)',
            }}
          >
            <ScopeGlyph size={10} strokeWidth={2.25} />
          </span>
        )}

        {/* Label under the disc — decluttered (hubs / high zoom / selection). */}
        {showLabel && (
          <div
            className="font-data"
            style={{
              position: 'absolute',
              top: diameter + 6,
              left: '50%',
              transform: 'translateX(-50%)',
              fontSize: 10.5,
              color: 'var(--foreground)',
              whiteSpace: 'nowrap',
              maxWidth: 150,
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              textAlign: 'center',
            }}
          >
            {node.title.length > 26 ? `${node.title.slice(0, 26)}…` : node.title}
          </div>
        )}

        {/* Invisible center handles — edge routing only. */}
        <Handle id="center" type="source" position={Position.Top} style={centerHandleStyle} />
        <Handle
          id="center-target"
          type="target"
          position={Position.Top}
          style={centerHandleStyle}
        />
      </div>
    </div>
  )
})
