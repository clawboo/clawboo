// MentionDropdown — autocomplete dropdown for @mentions in group chat composer.

import { memo, useEffect, useRef } from 'react'
import { AgentBooAvatar } from '@/components/AgentBooAvatar'

export interface MentionAgent {
  id: string
  name: string
}

interface MentionDropdownProps {
  agents: MentionAgent[]
  selectedIndex: number
  onSelect: (agentName: string) => void
  onClose: () => void
}

export const MentionDropdown = memo(function MentionDropdown({
  agents,
  selectedIndex,
  onSelect,
  onClose,
}: MentionDropdownProps) {
  const listRef = useRef<HTMLDivElement>(null)
  const selectedRef = useRef<HTMLButtonElement>(null)

  // Scroll selected item into view
  useEffect(() => {
    selectedRef.current?.scrollIntoView({ block: 'nearest' })
  }, [selectedIndex])

  // Click-outside to close
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (listRef.current && !listRef.current.contains(e.target as Node)) {
        onClose()
      }
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [onClose])

  if (agents.length === 0) {
    return (
      <div
        ref={listRef}
        style={{
          position: 'absolute',
          bottom: '100%',
          left: 0,
          marginBottom: 4,
          zIndex: 50,
          background: '#111827',
          border: '1px solid rgba(255,255,255,0.1)',
          borderRadius: 8,
          padding: '8px 12px',
          minWidth: 160,
          boxShadow: '0 8px 24px rgba(0,0,0,0.5)',
        }}
      >
        <span className="text-[11px] text-secondary/50">No matching agents</span>
      </div>
    )
  }

  return (
    <div
      ref={listRef}
      style={{
        position: 'absolute',
        bottom: '100%',
        left: 0,
        marginBottom: 4,
        zIndex: 50,
        background: '#111827',
        border: '1px solid rgba(255,255,255,0.1)',
        borderRadius: 8,
        padding: '4px 0',
        minWidth: 180,
        maxHeight: 200,
        overflowY: 'auto',
        boxShadow: '0 8px 24px rgba(0,0,0,0.5)',
      }}
    >
      {agents.map((agent, i) => (
        <button
          key={agent.id}
          ref={i === selectedIndex ? selectedRef : undefined}
          type="button"
          onMouseDown={(e) => {
            e.preventDefault() // prevent textarea blur
            onSelect(agent.name)
          }}
          className="flex w-full items-center gap-2 px-3 py-1.5 text-left transition-colors"
          style={{
            background: i === selectedIndex ? 'rgba(255,255,255,0.08)' : 'transparent',
            fontSize: 12,
            color: '#E8E8E8',
          }}
          onMouseEnter={(e) => {
            if (i !== selectedIndex) {
              ;(e.currentTarget as HTMLButtonElement).style.background = 'rgba(255,255,255,0.04)'
            }
          }}
          onMouseLeave={(e) => {
            if (i !== selectedIndex) {
              ;(e.currentTarget as HTMLButtonElement).style.background = 'transparent'
            }
          }}
        >
          <AgentBooAvatar agentId={agent.id} size={20} />
          <span className="truncate">{agent.name}</span>
        </button>
      ))}
    </div>
  )
})
