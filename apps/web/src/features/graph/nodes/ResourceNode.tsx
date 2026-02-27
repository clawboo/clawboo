'use client'

import { memo } from 'react'
import { Handle, Position } from '@xyflow/react'
import type { NodeProps, Node } from '@xyflow/react'
import type { ResourceNodeData } from '../types'

// ─── Handle style ─────────────────────────────────────────────────────────────

const handleStyle = {
  background: 'transparent',
  border: '1.5px solid rgba(251,191,36,0.45)',
  width: 7,
  height: 7,
}

// ─── ResourceNode — amber-tinted card with service icon ───────────────────────

export const ResourceNode = memo(function ResourceNode({
  data,
}: NodeProps<Node<ResourceNodeData, 'resource'>>) {
  const { name, serviceIcon } = data

  return (
    // Node root: 64×70 card. Overflow visible for potential future labels.
    <div
      style={{
        width: 64,
        height: 70,
        position: 'relative',
        overflow: 'visible',
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
    </div>
  )
})
