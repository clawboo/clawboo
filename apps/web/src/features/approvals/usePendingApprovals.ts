import { useCallback, useEffect, useMemo, useState } from 'react'

import { useApprovalsStore, type ApprovalRequest } from '@/stores/approvals'
import { useBooZeroStore } from '@/stores/booZero'
import { useFleetStore } from '@/stores/fleet'

// A pending MCP tool-call / delegation approval (from GET /api/tools/approvals).
// Distinct from the OpenClaw exec `ApprovalRequest` — different fields + a different
// resolve endpoint — so the two approval systems keep their own card renderers.
export interface ToolApproval {
  id: string
  toolName: string
  agentId: string | null
  argsSummary: string | null
  reason: string | null
  createdAt: number
  expiresAt: number
}

export type ToolDecision = 'allow_once' | 'allow_always' | 'deny'

export interface ApprovalScope {
  /** 1:1 chat: only approvals whose `agentId` matches this agent. */
  agentId?: string
  /** Team scope: approvals for any agent in this team. `null`/undefined = no team filter. */
  teamId?: string | null
  /** Also include approvals not attributable to any agent (`agentId === null`). The Board
   *  wants these (they are still pending work); a chat scoped to an agent/team does not. */
  includeUnscoped?: boolean
}

// One 3s poll per mounted consumer (mirrors the old ToolApprovalQueue cadence). At most
// one chat OR the Board is the active view at a time, so there is rarely more than one
// live poller; approvals expire in ~30-60s, so a few-second cadence is what keeps the
// queue responsive.
const POLL_MS = 3000

/** The raw, UNSCOPED tool-approval poll + resolve. Used by the Governance dashboard's
 *  queue (which shows everything) and composed by `usePendingApprovals` below. */
export function useToolApprovals(): {
  tool: ToolApproval[]
  resolveTool: (id: string, decision: ToolDecision) => Promise<void>
  refetch: () => Promise<void>
} {
  const [tool, setTool] = useState<ToolApproval[]>([])

  const refetch = useCallback(async () => {
    try {
      const r = await fetch('/api/tools/approvals?status=pending')
      const body = r.ok ? ((await r.json()) as { approvals?: ToolApproval[] }) : { approvals: [] }
      setTool(body.approvals ?? [])
    } catch {
      /* best-effort — the next poll reconciles */
    }
  }, [])

  useEffect(() => {
    void refetch()
    const id = setInterval(() => void refetch(), POLL_MS)
    return () => clearInterval(id)
  }, [refetch])

  const resolveTool = useCallback(
    async (id: string, decision: ToolDecision) => {
      setTool((prev) => prev.filter((a) => a.id !== id)) // optimistic removal
      try {
        await fetch(`/api/tools/approvals/${id}/resolve`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ decision }),
        })
      } catch {
        /* best-effort — the next poll reconciles */
      }
      void refetch()
    },
    [refetch],
  )

  return { tool, resolveTool, refetch }
}

/** Scoped pending approvals across BOTH systems (OpenClaw exec + MCP tool/delegation).
 *  `exec` is reactive from the store; `tool` is polled from `/api/tools/approvals`. The
 *  Board column and the in-chat tray both consume this so the two surfaces stay in sync. */
export function usePendingApprovals(scope: ApprovalScope): {
  exec: ApprovalRequest[]
  tool: ToolApproval[]
  total: number
  resolveTool: (id: string, decision: ToolDecision) => Promise<void>
} {
  const pendingExec = useApprovalsStore((s) => s.pendingApprovals)
  const agents = useFleetStore((s) => s.agents)
  const booZeroId = useBooZeroStore((s) => s.booZeroAgentId)
  const { tool: toolAll, resolveTool } = useToolApprovals()

  const teamAgentIds = useMemo(() => {
    if (scope.teamId == null) return null
    return new Set(agents.filter((a) => a.teamId === scope.teamId).map((a) => a.id))
  }, [agents, scope.teamId])

  const matches = useCallback(
    (agentId: string | null): boolean => {
      if (scope.agentId) return agentId === scope.agentId
      if (teamAgentIds) {
        return (
          (agentId != null && teamAgentIds.has(agentId)) ||
          (!!scope.includeUnscoped && agentId == null) ||
          // The universal Boo Zero leader is TEAMLESS (not in `teamAgentIds`), but it
          // leads every team and raises the risky-DELEGATION approval gate on their
          // behalf — so its approvals belong to whichever team is in view (the chat
          // the user is watching / that team's board column), not just the "all" board.
          (booZeroId != null && agentId === booZeroId)
        )
      }
      return true // no agent/team scope → everything (the Board's "All teams")
    },
    [scope.agentId, scope.includeUnscoped, teamAgentIds, booZeroId],
  )

  const exec = useMemo(
    () =>
      Array.from(pendingExec.values())
        .filter((a) => matches(a.agentId))
        .sort((a, b) => a.createdAtMs - b.createdAtMs),
    [pendingExec, matches],
  )
  const tool = useMemo(
    () => toolAll.filter((a) => matches(a.agentId)).sort((a, b) => a.createdAt - b.createdAt),
    [toolAll, matches],
  )

  return { exec, tool, total: exec.length + tool.length, resolveTool }
}
