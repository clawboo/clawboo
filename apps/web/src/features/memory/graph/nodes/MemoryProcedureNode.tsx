import { memo } from 'react'
import { Handle, Position } from '@xyflow/react'
import type { Node, NodeProps } from '@xyflow/react'
import { ListOrdered, User, Users } from 'lucide-react'
import { computeNodeIntensity, useMemoryGraphStore } from '../store'
import { PROC_HEIGHT, PROC_WIDTH, type MemProcData } from '../types'

// ─── MemoryProcedureNode: a paper card (shape distinguishes the tier) ───────
//
// SHAPE, not colour, separates a procedure from a fact: facts are discs, these
// are cards. Same achromatic surface + hairline edge as MemoryFactNode, so the
// two tiers read as one family. The `v{n}` badge carries version depth;
// collapsed history lives in the inspector.

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
}: NodeProps<Node<MemProcData, 'memProc'>>) {
  const { node } = data

  const selected = useMemoryGraphStore((s) => s.selectedNodeId === id)
  const highlighted = useMemoryGraphStore((s) => s.highlightedNodeIds?.has(id) ?? false)
  const intensity = useMemoryGraphStore((s) => computeNodeIntensity(s, node, Date.now()))

  const extraVersions = (node.versionCount ?? 1) - 1
  const ScopeGlyph = node.scope === 'agent' ? User : node.scope === 'team' ? Users : null

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
        width: PROC_WIDTH,
        height: PROC_HEIGHT,
        position: 'relative',
        display: 'flex',
        alignItems: 'center',
        gap: 7,
        padding: '0 10px',
        borderRadius: 10,
        background: 'var(--graph-node-bg)',
        border: '1px solid var(--graph-node-border)',
        boxShadow: ring ? `${ring}, var(--graph-node-shadow)` : 'var(--graph-node-shadow)',
        opacity: intensity,
        transition: 'opacity 160ms ease, box-shadow 160ms ease',
      }}
    >
      <ListOrdered
        size={13}
        strokeWidth={2}
        aria-hidden
        style={{ color: 'var(--muted-foreground)', flexShrink: 0 }}
      />
      <span
        style={{
          flex: 1,
          minWidth: 0,
          fontSize: 11.5,
          fontWeight: 550,
          letterSpacing: '-0.005em',
          color: 'var(--foreground)',
          whiteSpace: 'nowrap',
          overflow: 'hidden',
          textOverflow: 'ellipsis',
        }}
      >
        {node.title}
      </span>
      {ScopeGlyph && (
        <ScopeGlyph
          size={9}
          strokeWidth={2.25}
          aria-hidden
          style={{ color: 'var(--muted-foreground)', flexShrink: 0 }}
        />
      )}
      <span
        className="font-data"
        style={{
          fontSize: 10,
          color: 'var(--muted-foreground)',
          flexShrink: 0,
          fontVariantNumeric: 'tabular-nums',
        }}
      >
        v{node.version ?? 1}
        {extraVersions > 0 ? ` +${extraVersions}` : ''}
      </span>

      <Handle id="center" type="source" position={Position.Top} style={centerHandleStyle} />
      <Handle id="center-target" type="target" position={Position.Top} style={centerHandleStyle} />
    </div>
  )
})
