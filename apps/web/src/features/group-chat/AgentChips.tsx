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
      className="flex items-center gap-1.5 overflow-x-auto border-t border-white/8 px-4 py-2"
      style={{ scrollbarWidth: 'none' }}
    >
      <span className="shrink-0 text-[10px] text-secondary/40">Tag:</span>
      {agents.map((agent) => (
        <button
          key={agent.id}
          type="button"
          onClick={() => onTag(agent.name)}
          className="flex shrink-0 items-center gap-1.5 rounded-full bg-white/6 px-2 py-1 transition-colors hover:bg-white/10"
          title={`Tag @${agent.name}`}
        >
          <AgentBooAvatar agentId={agent.id} size={18} />
          <span className="max-w-[80px] truncate text-[11px] text-text/80">
            {agent.name.split(' ')[0]}
          </span>
        </button>
      ))}
    </div>
  )
})
