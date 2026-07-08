// AgentChips — horizontal row of avatar chips for quick @mention tagging.

import { memo } from 'react'
import { AgentBooAvatar } from '@/components/AgentBooAvatar'

interface AgentChipsProps {
  agents: { id: string; name: string }[]
  onTag: (agentName: string) => void
}

export const AgentChips = memo(function AgentChips({ agents, onTag }: AgentChipsProps) {
  if (agents.length === 0) return null

  return (
    <div
      className="flex items-center gap-1.5 overflow-x-auto px-4 py-2.5"
      style={{ scrollbarWidth: 'none' }}
    >
      <span className="shrink-0 font-mono text-[10px] uppercase tracking-[0.14em] text-foreground/45">
        Tag
      </span>
      {agents.map((agent) => (
        <button
          key={agent.id}
          type="button"
          onClick={() => onTag(agent.name)}
          className="flex shrink-0 cursor-pointer items-center gap-1.5 rounded-full border border-border bg-surface py-1 pl-1 pr-2.5 text-foreground/80 transition hover:border-border-strong hover:bg-foreground/[0.03] hover:text-foreground"
          title={`Tag @${agent.name}`}
        >
          <AgentBooAvatar agentId={agent.id} size={18} />
          <span className="max-w-[80px] truncate text-[11px] font-medium">
            {agent.name.split(' ')[0]}
          </span>
        </button>
      ))}
    </div>
  )
})
