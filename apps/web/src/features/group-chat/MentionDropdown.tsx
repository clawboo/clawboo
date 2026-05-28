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
        className="absolute bottom-full left-0 z-50 mb-1 min-w-[160px] rounded-lg border border-border bg-popover px-3 py-2 shadow-lg"
      >
        <span className="text-[11px] text-secondary/50">No matching agents</span>
      </div>
    )
  }

  return (
    <div
      ref={listRef}
      className="absolute bottom-full left-0 z-50 mb-1 max-h-[200px] min-w-[180px] overflow-y-auto rounded-lg border border-border bg-popover py-1 shadow-lg"
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
            'flex w-full items-center gap-2 px-3 py-1.5 text-left text-[12px] text-popover-foreground transition-colors',
            i === selectedIndex ? 'bg-foreground/[0.08]' : 'hover:bg-foreground/[0.04]',
          ].join(' ')}
        >
          <AgentBooAvatar agentId={agent.id} size={20} />
          <span className="truncate">{agent.name}</span>
        </button>
      ))}
    </div>
  )
})
