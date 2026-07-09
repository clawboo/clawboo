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

  useEffect(() => {
    selectedRef.current?.scrollIntoView({ block: 'nearest' })
  }, [selectedIndex])

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
        className="absolute bottom-full left-0 z-50 mb-1.5 min-w-[160px] rounded-xl border border-border bg-popover px-3 py-2.5"
        style={{ boxShadow: 'var(--shadow-floating)' }}
      >
        <span className="text-[11px] text-foreground/50">No matching agents</span>
      </div>
    )
  }

  return (
    <div
      ref={listRef}
      className="absolute bottom-full left-0 z-50 mb-1.5 max-h-[220px] min-w-[190px] overflow-y-auto rounded-xl border border-border bg-popover p-1"
      style={{ boxShadow: 'var(--shadow-floating)' }}
    >
      {agents.map((agent, i) => (
        <button
          key={agent.id}
          ref={i === selectedIndex ? selectedRef : undefined}
          type="button"
          onMouseDown={(e) => {
            e.preventDefault()
            onSelect(agent.name)
          }}
          className={[
            'flex w-full cursor-pointer items-center gap-2.5 rounded-lg px-2.5 py-2 text-left text-[12.5px] text-popover-foreground transition',
            i === selectedIndex
              ? 'bg-primary/10 text-primary'
              : 'hover:bg-foreground/[0.05]',
          ].join(' ')}
        >
          <AgentBooAvatar agentId={agent.id} size={22} />
          <span className="truncate font-medium">{agent.name}</span>
        </button>
      ))}
    </div>
  )
})
