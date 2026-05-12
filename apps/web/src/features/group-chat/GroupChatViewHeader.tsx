// GroupChatViewHeader — single unified header above the graph + chat split.
// Owns the team identity (icon + name + agent count), the orchestration
// toggle, and the connection-status dot. Replaces the per-panel headers
// in GhostGraphPanel + GroupChatPanel so the team name doesn't render
// twice in the group-chat view.

import { Zap } from 'lucide-react'
import type { Team } from '@/stores/team'

interface GroupChatViewHeaderProps {
  team: Team | null
  agentCount: number
  orchestrationEnabled: boolean
  onToggleOrchestration: () => void
  connectionStatus: string
}

export function GroupChatViewHeader({
  team,
  agentCount,
  orchestrationEnabled,
  onToggleOrchestration,
  connectionStatus,
}: GroupChatViewHeaderProps) {
  return (
    <div className="flex shrink-0 items-center gap-3 border-b border-white/8 px-4 py-3">
      {team && (
        <span
          className="flex h-[30px] w-[30px] shrink-0 items-center justify-center rounded-lg text-[16px]"
          style={{ background: `${team.color}22` }}
        >
          {team.icon}
        </span>
      )}
      <div className="min-w-0 flex-1">
        <h2
          className="truncate text-[14px] font-semibold text-text"
          style={{ fontFamily: 'var(--font-body)' }}
        >
          {team?.name ?? 'Group Chat'}
        </h2>
        <p className="text-[10px] text-secondary/50">
          {agentCount} agent{agentCount !== 1 ? 's' : ''}
        </p>
      </div>
      <button
        type="button"
        title="Team orchestration — auto-relay responses between agents"
        onClick={onToggleOrchestration}
        style={{
          background: 'transparent',
          border: 'none',
          cursor: 'pointer',
          color: orchestrationEnabled ? '#34D399' : 'rgba(232,232,232,0.3)',
          transition: 'color 0.15s',
          padding: 4,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          borderRadius: 4,
          flexShrink: 0,
        }}
      >
        <Zap size={14} />
      </button>
      <span
        className={`h-2 w-2 shrink-0 rounded-full ${connectionStatus === 'connected' ? 'bg-mint' : 'bg-secondary/40'}`}
      />
    </div>
  )
}
