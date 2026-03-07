'use client'

import { memo, useState } from 'react'
import { Handle, Position } from '@xyflow/react'
import type { NodeProps, Node } from '@xyflow/react'
import { useConnectionStore } from '@/stores/connection'
import { useToastStore } from '@/stores/toast'
import { mutationQueue } from '@/lib/mutationQueue'
import { AgentPickerDropdown } from '@/features/marketplace/AgentPickerDropdown'
import { useGraphStore } from '../store'
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

const CIRCLE = 52 // circle diameter in px

// ─── Handle style ─────────────────────────────────────────────────────────────

const handleStyle = {
  background: 'transparent',
  border: '1.5px solid rgba(255,255,255,0.2)',
  width: 7,
  height: 7,
}

// ─── Install skill for agent ──────────────────────────────────────────────────

async function installSkillForAgent(skillName: string, agentId: string, agentName: string) {
  const client = useConnectionStore.getState().client
  if (!client) return

  try {
    const currentTools = await client.agents.files.read(agentId, 'TOOLS.md')

    if (currentTools.includes(skillName)) {
      useToastStore.getState().addToast({
        message: `${skillName} already installed on ${agentName}`,
        type: 'info',
      })
      return
    }

    const newTools = currentTools.trimEnd() + '\n- ' + skillName + '\n'
    await mutationQueue.enqueue(agentId, () =>
      client.agents.files.set(agentId, 'TOOLS.md', newTools),
    )

    useGraphStore.getState().triggerRefresh()

    useToastStore.getState().addToast({
      message: `Installed "${skillName}" on ${agentName}`,
      type: 'success',
    })
  } catch (err) {
    useToastStore.getState().addToast({
      message: `Failed to install skill: ${err instanceof Error ? err.message : 'unknown'}`,
      type: 'error',
    })
  }
}

// ─── SkillNode ────────────────────────────────────────────────────────────────

export const SkillNode = memo(function SkillNode({
  data,
}: NodeProps<Node<SkillNodeData, 'skill'>>) {
  const { name, category, description } = data
  const { color, icon } = CATEGORY[category] ?? CATEGORY.other
  const [showPicker, setShowPicker] = useState(false)

  return (
    // Node root: exactly the circle bounding box.
    // Name label overflows below via absolute positioning.
    <div
      title={description ?? name}
      className="group"
      style={{
        width: CIRCLE,
        height: CIRCLE,
        position: 'relative',
        overflow: 'visible',
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
        <span style={{ fontSize: 22, lineHeight: 1, userSelect: 'none' }}>{icon}</span>
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
          top: -8,
          right: -16,
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

      {/* Left handle — vertically centered in circle (default 50% = HALF) */}
      <Handle
        type="target"
        position={Position.Left}
        style={{ ...handleStyle, borderColor: `${color}55` }}
      />
    </div>
  )
})
