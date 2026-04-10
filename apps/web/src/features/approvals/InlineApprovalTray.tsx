import { useMemo } from 'react'
import { AnimatePresence } from 'framer-motion'
import { useApprovalsStore } from '@/stores/approvals'
import { useFleetStore } from '@/stores/fleet'
import { useViewStore } from '@/stores/view'
import { InlineApprovalCard } from './InlineApprovalCard'

// ─── InlineApprovalTray ────────────────────────────────────────────────────
// Renders up to 3 inline approval cards scoped to the current chat context.
// Returns null when empty — zero DOM footprint.

const MAX_INLINE_CARDS = 3

interface InlineApprovalTrayProps {
  agentId?: string // 1:1 chat: filter to this agent only
  teamId?: string // Group chat: filter to agents in this team
}

export function InlineApprovalTray({ agentId, teamId }: InlineApprovalTrayProps) {
  const pendingApprovals = useApprovalsStore((s) => s.pendingApprovals)
  const agents = useFleetStore((s) => s.agents)

  // Build team agent ID set for group chat scoping
  const teamAgentIds = useMemo(() => {
    if (!teamId) return null
    return new Set(agents.filter((a) => a.teamId === teamId).map((a) => a.id))
  }, [agents, teamId])

  const showAgentName = Boolean(teamId)

  const filteredApprovals = useMemo(() => {
    const all = Array.from(pendingApprovals.values())

    let scoped
    if (agentId) {
      // 1:1 chat: only approvals for this agent
      scoped = all.filter((a) => a.agentId === agentId)
    } else if (teamAgentIds) {
      // Group chat: approvals for any team member
      scoped = all.filter((a) => a.agentId && teamAgentIds.has(a.agentId))
    } else {
      // Safety: no scope provided — show nothing
      return []
    }

    return scoped.sort((a, b) => a.createdAtMs - b.createdAtMs)
  }, [pendingApprovals, agentId, teamAgentIds])

  // Nothing to show — zero DOM footprint
  if (filteredApprovals.length === 0) return null

  const visibleApprovals = filteredApprovals.slice(0, MAX_INLINE_CARDS)
  const overflowCount = filteredApprovals.length - MAX_INLINE_CARDS

  return (
    <div
      style={{
        borderTop: '1px solid rgba(251,191,36,0.15)',
        padding: '8px 16px',
        display: 'flex',
        flexDirection: 'column',
        gap: 6,
        flexShrink: 0,
      }}
    >
      <AnimatePresence mode="popLayout">
        {visibleApprovals.map((approval) => (
          <InlineApprovalCard key={approval.id} approval={approval} showAgentName={showAgentName} />
        ))}
      </AnimatePresence>

      {overflowCount > 0 && (
        <button
          onClick={() => useViewStore.getState().navigateTo('approvals')}
          style={{
            background: 'none',
            border: 'none',
            color: 'rgba(251,191,36,0.5)',
            fontSize: 10,
            fontWeight: 500,
            cursor: 'pointer',
            padding: '2px 0',
            textAlign: 'center',
            transition: 'color 0.15s',
          }}
          onMouseEnter={(e) => {
            e.currentTarget.style.color = '#FBBF24'
          }}
          onMouseLeave={(e) => {
            e.currentTarget.style.color = 'rgba(251,191,36,0.5)'
          }}
        >
          +{overflowCount} more — view all
        </button>
      )}
    </div>
  )
}
