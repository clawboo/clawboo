// GroupChatViewHeader — single unified header above the graph + chat split.
// Owns the team identity (icon + name + agent count) only. The orchestration
// toggle was removed because team chat without auto-relay defeats the
// purpose of a team chat — relay + delegation routing is always on. The
// connection-status dot was removed because the composer's disabled state
// (`"Gateway not connected…"` placeholder) + the `GatewayBootstrap` overlay
// already surface connection state more visibly.

import type { Team } from '@/stores/team'

interface GroupChatViewHeaderProps {
  team: Team | null
  agentCount: number
}

export function GroupChatViewHeader({ team, agentCount }: GroupChatViewHeaderProps) {
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
    </div>
  )
}
