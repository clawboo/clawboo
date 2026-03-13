import { memo, useState } from 'react'
import { Handle, Position } from '@xyflow/react'
import type { NodeProps, Node } from '@xyflow/react'
import { AgentPickerDropdown } from '@/features/marketplace/AgentPickerDropdown'
import { installSkillForAgent } from '../operations/installSkill'
import { useGraphStore } from '../store'
import { useFloatingMotion } from '../useFloatingMotion'
import type { SkillNodeData, SkillCategory } from '../types'

// ─── Category → colour + icon ─────────────────────────────────────────────────

const CATEGORY: Record<SkillCategory, { color: string; icon: string }> = {
  data: { color: '#3B82F6', icon: '📊' },
  comm: { color: '#34D399', icon: '💬' },
  code: { color: '#F97316', icon: '⚡' },
  file: { color: '#FBBF24', icon: '📄' },
  web: { color: '#A855F7', icon: '🌐' },
  other: { color: '#6B7280', icon: '🔧' },
}

const CIRCLE = 38 // circle diameter in px (reduced from 52 — skills feel subordinate to Boo nodes)

// ─── Handle style ─────────────────────────────────────────────────────────────

const handleStyle = {
  background: 'transparent',
  border: '1.5px solid rgba(255,255,255,0.2)',
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

// ─── SkillNode ────────────────────────────────────────────────────────────────

export const SkillNode = memo(function SkillNode({
  id: nodeId,
  data,
  dragging,
}: NodeProps<Node<SkillNodeData, 'skill'>>) {
  const { name, category, description } = data
  const floatRef = useFloatingMotion(nodeId, 'skill', dragging)
  const { color, icon } = CATEGORY[category] ?? CATEGORY.other
  const [showPicker, setShowPicker] = useState(false)

  // Hover cascade — dim when another node is hovered
  const isHighlighted = useGraphStore(
    (s) => s.hoveredNodeId === null || (s.highlightedNodeIds?.has(nodeId) ?? false),
  )

  return (
    <div ref={floatRef}>
      <div
        title={description ?? name}
        className="group"
        style={{
          width: CIRCLE,
          height: CIRCLE,
          position: 'relative',
          overflow: 'visible',
          opacity: isHighlighted ? 1 : 0.22,
          transition: 'opacity 0.2s ease',
        }}
      >
        {/* Filled circle */}
        <div
          style={{
            width: CIRCLE,
            height: CIRCLE,
            borderRadius: '50%',
            background: `${color}18`,
            border: `2px solid ${color}55`,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            boxShadow: `0 0 14px ${color}28, inset 0 1px 0 rgba(255,255,255,0.06)`,
          }}
        >
          <span style={{ fontSize: 16, lineHeight: 1, userSelect: 'none' }}>{icon}</span>
        </div>

        {/* Install button — appears on hover */}
        <button
          onClick={(e) => {
            e.stopPropagation()
            setShowPicker((v) => !v)
          }}
          className="opacity-0 group-hover:opacity-100"
          style={{
            position: 'absolute',
            top: -6,
            right: -14,
            background: '#34D399',
            color: '#0A0E1A',
            border: 'none',
            borderRadius: 4,
            fontSize: 9,
            fontWeight: 700,
            padding: '2px 6px',
            cursor: 'pointer',
            transition: 'opacity 0.15s',
            whiteSpace: 'nowrap',
            letterSpacing: '0.02em',
          }}
        >
          Install →
        </button>

        {/* Agent picker dropdown */}
        {showPicker && (
          <AgentPickerDropdown
            onSelect={(agentId, agentName) => {
              void installSkillForAgent(name, agentId, agentName)
            }}
            onClose={() => setShowPicker(false)}
            style={{ top: CIRCLE + 4, left: '50%', transform: 'translateX(-50%)' }}
          />
        )}

        {/* Name below circle */}
        <div
          style={{
            position: 'absolute',
            top: CIRCLE + 6,
            left: '50%',
            transform: 'translateX(-50%)',
            fontSize: 11,
            fontWeight: 500,
            color: color,
            whiteSpace: 'nowrap',
            maxWidth: 84,
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            textAlign: 'center',
            letterSpacing: '0.02em',
          }}
        >
          {name}
        </div>

        {/* Left handle — target for incoming edges from BooNodes */}
        <Handle
          type="target"
          position={Position.Left}
          style={{ ...handleStyle, borderColor: `${color}55` }}
        />
        {/* Right handle — source for drag-to-install onto BooNodes */}
        <Handle
          type="source"
          id="install"
          position={Position.Right}
          style={{ ...handleStyle, borderColor: `${color}55` }}
        />

        {/* Center handle — invisible, for edge path routing only */}
        <Handle id="center" type="target" position={Position.Left} style={centerHandleStyle} />
      </div>
    </div>
  )
})
