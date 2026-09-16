import { memo } from 'react'
import { Handle, Position } from '@xyflow/react'
import type { Node, NodeProps } from '@xyflow/react'
import { ListOrdered, User, Users } from 'lucide-react'
import { useFloatingMotion } from '@/features/graph/useFloatingMotion'
import { computeNodeIntensity, useMemoryGraphStore } from '../store'
import { communityColor, PROC_HEIGHT, PROC_WIDTH, type MemProcData } from '../types'

// ─── MemoryProcedureNode — a rounded card (shape distinguishes the tier) ─────
//
// Procedures render as 150×44 cards (vs the fact discs), with a community-
// colored left border and a `v{n}` mono badge; collapsed version history lives
// in the inspector. Same dim conventions as MemoryFactNode.

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

export const MemoryProcedureNode = memo(function MemoryProcedureNode({
  id,
  data,
  dragging,
}: NodeProps<Node<MemProcData, 'memProc'>>) {
  const { node } = data
  const color = communityColor(node.community)
  const floatRef = useFloatingMotion(id, 'skill', dragging)

  const selected = useMemoryGraphStore((s) => s.selectedNodeId === id)
  const intensity = useMemoryGraphStore((s) => computeNodeIntensity(s, node, Date.now()))

  const extraVersions = (node.versionCount ?? 1) - 1
  const ScopeGlyph = node.scope === 'agent' ? User : node.scope === 'team' ? Users : null

  return (
    <div ref={floatRef}>
      <div
        data-testid={`mem-node-${id}`}
        title={node.title}
        style={{
          width: PROC_WIDTH,
          height: PROC_HEIGHT,
          position: 'relative',
          display: 'flex',
          alignItems: 'center',
          gap: 7,
          padding: '0 10px',
          borderRadius: 10,
          background: 'var(--surface)',
          border: '1px solid var(--border-strong)',
          borderLeft: `3px solid ${color}`,
          boxShadow: selected
            ? `0 0 0 2px color-mix(in srgb, ${color} 65%, transparent)`
            : 'var(--shadow-raised)',
          opacity: intensity,
          transition: 'opacity 150ms ease, box-shadow 150ms ease',
        }}
      >
        <ListOrdered size={14} strokeWidth={2} aria-hidden style={{ color, flexShrink: 0 }} />
        <span
          style={{
            flex: 1,
            minWidth: 0,
            fontSize: 11.5,
            fontWeight: 600,
            color: 'var(--foreground)',
            whiteSpace: 'nowrap',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
          }}
        >
          {node.title}
        </span>
        <span
          className="font-data"
          style={{ fontSize: 10, color: 'rgb(var(--foreground-rgb) / 0.5)', flexShrink: 0 }}
        >
          v{node.version ?? 1}
          {extraVersions > 0 ? ` +${extraVersions}` : ''}
        </span>

        {ScopeGlyph && (
          <span
            aria-hidden
            style={{
              position: 'absolute',
              right: 3,
              bottom: 2,
              display: 'inline-flex',
              opacity: 0.6,
              color: 'var(--foreground)',
            }}
          >
            <ScopeGlyph size={10} strokeWidth={2.25} />
          </span>
        )}

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
