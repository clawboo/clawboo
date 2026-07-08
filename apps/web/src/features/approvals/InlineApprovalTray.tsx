import { useMemo } from 'react'
import { AnimatePresence } from 'framer-motion'

import type { ApprovalRequest } from '@/stores/approvals'
import { useViewStore } from '@/stores/view'
import { InlineApprovalCard } from './InlineApprovalCard'
import { ToolApprovalCard } from './ToolApprovalCard'
import { usePendingApprovals, type ToolApproval } from './usePendingApprovals'

// ─── InlineApprovalTray ────────────────────────────────────────────────────
// Renders pending approvals (BOTH OpenClaw exec AND MCP tool / delegation) right
// above the composer for the current chat — the Claude/ChatGPT pattern where the
// gate appears where it was asked. Scoped to this agent (1:1) or team (group).
// Returns null when empty — zero DOM footprint.

const MAX_INLINE_CARDS = 3

interface InlineApprovalTrayProps {
  agentId?: string // 1:1 chat: filter to this agent only
  teamId?: string // Group chat: filter to agents in this team
}

type TrayItem =
  | { key: string; ts: number; kind: 'exec'; exec: ApprovalRequest }
  | { key: string; ts: number; kind: 'tool'; tool: ToolApproval }

export function InlineApprovalTray({ agentId, teamId }: InlineApprovalTrayProps) {
  const showAgentName = Boolean(teamId)
  // Exec + tool/delegation approvals scoped to this chat. A tool approval not
  // attributable to any agent (agentId null) does not belong to a specific chat, so
  // it stays out of the tray (it still shows on the Board's "Needs approval" column).
  const { exec, tool, total, resolveTool } = usePendingApprovals(
    agentId ? { agentId } : teamId ? { teamId } : {},
  )

  const items = useMemo<TrayItem[]>(() => {
    const merged: TrayItem[] = [
      ...exec.map(
        (a): TrayItem => ({ key: `exec-${a.id}`, ts: a.createdAtMs, kind: 'exec', exec: a }),
      ),
      ...tool.map((a): TrayItem => ({ key: `tool-${a.id}`, ts: a.createdAt, kind: 'tool', tool: a })),
    ]
    return merged.sort((a, b) => a.ts - b.ts)
  }, [exec, tool])

  // Safety: no scope provided → show nothing (never leak every team's approvals).
  if ((!agentId && !teamId) || total === 0) return null

  const visible = items.slice(0, MAX_INLINE_CARDS)
  const overflow = total - visible.length

  return (
    <div className="flex flex-shrink-0 flex-col gap-2 border-t border-border px-4 py-2.5">
      <AnimatePresence mode="popLayout">
        {visible.map((it) =>
          it.kind === 'exec' ? (
            <InlineApprovalCard key={it.key} approval={it.exec} showAgentName={showAgentName} />
          ) : (
            <ToolApprovalCard
              key={it.key}
              approval={it.tool}
              onResolve={resolveTool}
              showAgentName={showAgentName}
              compact
            />
          ),
        )}
      </AnimatePresence>

      {overflow > 0 && (
        <button
          onClick={() => useViewStore.getState().navigateTo('board')}
          className="cursor-pointer rounded-md py-1 text-center text-[10px] font-medium text-foreground/45 transition hover:text-primary"
        >
          +{overflow} more — view on the board
        </button>
      )}
    </div>
  )
}
