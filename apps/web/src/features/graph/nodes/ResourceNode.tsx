import { memo } from 'react'
import { motion } from 'framer-motion'
import { Handle, Position } from '@xyflow/react'
import type { NodeProps, Node } from '@xyflow/react'
import { useGraphStore } from '../store'
import { usePeacockTransition } from '../usePeacockTransition'
import type { ResourceNodeData } from '../types'

// ─── Handle style ─────────────────────────────────────────────────────────────

const handleStyle = {
  background: 'transparent',
  border: '1.5px solid rgba(251,191,36,0.45)',
  width: 7,
  height: 7,
}

// Invisible center handle style — used for edge path routing only
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

// ─── ResourceNode — amber-tinted card with service icon ───────────────────────

export const ResourceNode = memo(function ResourceNode({
  id: nodeId,
  data,
}: NodeProps<Node<ResourceNodeData, 'resource'>>) {
  const { name, serviceIcon, isVisible } = data

  // Hover cascade — dim when another node is hovered
  const isHighlighted = useGraphStore(
    (s) => s.hoveredNodeId === null || (s.highlightedNodeIds?.has(nodeId) ?? false),
  )

  // Peacock-feather expand / collapse synchronised with the parent Boo's
  // toggle. `usePeacockTransition` returns no-op props when `isVisible` is
  // undefined (MiniGraph context) so the node renders normally there.
  const peacock = usePeacockTransition(nodeId, isVisible)

  return (
    <motion.div
      initial={peacock.initial}
      animate={peacock.animate}
      transition={peacock.transition}
      style={{
        width: 64,
        height: 70,
        position: 'relative',
        overflow: 'visible',
        opacity: isHighlighted ? 1 : 0.22,
        transition: 'opacity 0.2s ease',
        transformOrigin: 'center center',
        pointerEvents: peacock.pointerEvents,
      }}
    >
      <div
        style={{
          width: 64,
          height: 70,
          borderRadius: 14,
          background: 'rgba(251,191,36,0.05)',
          border: '1.5px solid rgba(251,191,36,0.32)',
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          justifyContent: 'center',
          gap: 5,
          boxShadow: '0 0 18px rgba(251,191,36,0.1), inset 0 1px 0 rgba(255,255,255,0.04)',
        }}
      >
        {/* Service icon */}
        <span style={{ fontSize: 26, lineHeight: 1, userSelect: 'none' }}>{serviceIcon}</span>

        {/* Service name */}
        <span
          style={{
            fontSize: 10,
            fontWeight: 600,
            color: 'rgba(251,191,36,0.8)',
            letterSpacing: '0.05em',
            textTransform: 'uppercase',
            whiteSpace: 'nowrap',
            maxWidth: 54,
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            textAlign: 'center',
          }}
        >
          {name}
        </span>
      </div>

      {/* Left handle — vertically centered (default 50% of 70px = 35px) */}
      <Handle type="target" position={Position.Left} style={handleStyle} />

      {/* Center handle — invisible, for edge path routing only */}
      <Handle id="center" type="target" position={Position.Left} style={centerHandleStyle} />
    </motion.div>
  )
})
