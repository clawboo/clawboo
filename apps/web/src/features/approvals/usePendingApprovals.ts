import { useCallback, useEffect, useMemo, useState } from 'react'

import { useApprovalsStore, type ApprovalRequest } from '@/stores/approvals'
import { useBooZeroStore } from '@/stores/booZero'
import { useFleetStore } from '@/stores/fleet'
import { useReadSequencer } from '@/lib/useReadSequencer'
import { useVisiblePolling } from '@/lib/useVisiblePolling'
import { apiFetch } from '@clawboo/control-client'

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
  /**
   * This class of call may never be remembered, so the card must not offer
   * "Always".
   *
   * Persisted at PROMPT time and carried through, rather than recomputed here.
   * A lethal trifecta or a tainted run is a property of the run that produced
   * this prompt, and the resolve path refuses to mint a rule for one, so an
   * "Always" button on it is a control that quietly does nothing.
   *
   * SQLite has no boolean: the API sends the integer column through as-is.
   */
  neverRemember?: number | boolean | null
  /**
   * The grant this call was attributed to, when the gate found one.
   *
   * Load-bearing for the card, not just for audit: `resolveApproval` refuses to
   * mint a standing rule without it, and it is NULL for every brokered app call
   * because the grant gate does not govern a broker meta-tool. Offering "Always"
   * there would promise something the server then declines to do.
   *
   * Sent by the API today (the route spreads the whole row); it was simply never
   * declared here.
   */
  grantId?: string | null
  /**
   * The SERVER's reading of the tool, and the tool's own description.
   *
   * These are what let the card say something useful about a connector nobody
   * hard-coded knowledge for, which on a general platform is most of them. Only
   * the server may state that a call is read-only, so this is where that claim
   * comes from.
   */
  toolClass?: 'read' | 'write' | 'destructive' | null
  toolSummary?: string | null
  /**
   * Which system is holding the call open.
   *
   * `'exec'` is a shell command held by the OpenClaw Gateway and MIRRORED here so
   * it survives a closed tab. It is not a tool call clawboo brokered, and it must
   * not be rendered as one: `ToolApprovalCard` would describe an `echo` with the
   * stored destructive class and offer a button labelled "Delete it".
   *
   * Older rows predate the column, so an absent value means `'tool'`.
   */
  kind?: 'tool' | 'exec' | null
}

export type ToolDecision = 'allow_once' | 'allow_always' | 'deny'

export interface ApprovalScope {
  /** 1:1 chat: only approvals whose `agentId` matches this agent. */
  agentId?: string
  /** Team scope: approvals for any agent in this team. `null`/undefined = no team filter. */
  teamId?: string | null
  /**
   * Also include approvals not attributable to any agent (`agentId === null`).
   *
   * The Board wants these, and so does an open chat: a run that cannot be
   * attributed still blocks on the answer, and the person able to give it is
   * whoever is on screen. Left out, the gate is invisible everywhere the user
   * actually is.
   */
  includeUnscoped?: boolean
}

// One 3s poll per mounted consumer (mirrors the old ToolApprovalQueue cadence). At most
// one chat OR the Board is the active view at a time, so there is rarely more than one
// live poller; approvals expire in ~30-60s, so a few-second cadence is what keeps the
// queue responsive.
const POLL_MS = 3000

/**
 * Read a mirrored exec approval back into the shape the exec card renders.
 *
 * WHY THE MIRROR IS NOT REDUNDANT with the Gateway socket that also delivers
 * these: the socket store only holds frames this tab was connected for. Open a
 * tab ten minutes into a thirty-minute window and the store is empty while the
 * command is still held, which is the case the whole mirror exists to cover.
 *
 * Fields the mirror does not keep (`host`, `security`, `resolvedPath`) are null
 * rather than invented. The card shows the command, which is the part that
 * decides anything.
 */
export function execRequestFromMirror(a: ToolApproval): ApprovalRequest | null {
  let command = a.toolSummary?.trim() ?? ''
  let cwd: string | null = null
  try {
    const args = a.argsSummary ? (JSON.parse(a.argsSummary) as Record<string, unknown>) : null
    if (typeof args?.['command'] === 'string') command = args['command']
    if (typeof args?.['cwd'] === 'string') cwd = args['cwd']
  } catch {
    // `toolSummary` still carries the command; an unreadable args blob is not a
    // reason to drop a card someone has to answer.
  }
  if (!command) return null
  return {
    id: a.id,
    agentId: a.agentId,
    sessionKey: null,
    command,
    cwd,
    host: null,
    security: null,
    ask: null,
    resolvedPath: null,
    createdAtMs: a.createdAt,
    expiresAtMs: a.expiresAt,
    resolving: false,
    error: null,
  }
}

/** The raw, UNSCOPED tool-approval poll + resolve. Used by the Governance dashboard's
 *  queue (which shows everything) and composed by `usePendingApprovals` below. */
export function useToolApprovals(): {
  tool: ToolApproval[]
  resolveTool: (id: string, decision: ToolDecision) => Promise<void>
  refetch: () => Promise<void>
} {
  const [tool, setTool] = useState<ToolApproval[]>([])
  // The 3s poll and `resolveTool`'s optimistic removal write the same list, so reads are
  // sequenced last-write-wins. Without it, a poll already in flight when a decision is
  // made lands afterwards and RESURRECTS the card that was just resolved — a reappearing
  // gate on a time-sensitive prompt, which invites a second click on a decision already
  // sent. See useReadSequencer.
  const reads = useReadSequencer()

  const refetch = useCallback(async () => {
    const read = reads.beginRead()
    try {
      const r = await apiFetch('/api/tools/approvals?status=pending')
      const body = r.ok ? ((await r.json()) as { approvals?: ToolApproval[] }) : { approvals: [] }
      if (!read.isCurrent()) return // predates a resolve, or superseded by a newer read
      setTool(body.approvals ?? [])
    } catch {
      /* best-effort — the next poll reconciles */
    }
  }, [reads])

  useEffect(() => {
    void refetch()
  }, [refetch])

  useVisiblePolling(() => void refetch(), POLL_MS)

  const resolveTool = useCallback(
    async (id: string, decision: ToolDecision) => {
      reads.commitLocalWrite() // any read already in flight still lists this approval
      setTool((prev) => prev.filter((a) => a.id !== id)) // optimistic removal
      try {
        await apiFetch(`/api/tools/approvals/${id}/resolve`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ decision }),
        })
      } catch {
        /* best-effort — the next poll reconciles */
      }
      void refetch()
    },
    [refetch, reads],
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
      // AN UNATTRIBUTABLE APPROVAL BELONGS TO WHOEVER IS LOOKING. A run with no
      // agent identity still raises real gates: an OpenClaw session reaches the
      // tools server over one process-wide URL that cannot carry an agent, so
      // its approvals arrive with `agentId: null`. Excluding them here meant the
      // chat that was WAITING on the answer was the one place it never appeared,
      // and the call sat until it timed out while the agent reported the stall
      // as a service outage.
      if (scope.agentId) {
        return agentId === scope.agentId || (!!scope.includeUnscoped && agentId == null)
      }
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

  // ONE CARD PER COMMAND, AND IT IS THE SHELL CARD.
  //
  // A shell approval can arrive twice: live over the Gateway socket, and again
  // from the server's mirror through the poll. Rendering both put the same
  // command on screen as two cards with different wording, one of them offering
  // "Delete it" over an `echo`. Merging on the id keeps whichever arrived, and
  // the SOCKET entry wins a tie because it carries the fuller request (the
  // session, host and resolved path the mirror does not keep).
  const exec = useMemo(() => {
    const byId = new Map<string, ApprovalRequest>()
    for (const a of pendingExec.values()) byId.set(a.id, a)
    for (const row of toolAll) {
      if (row.kind !== 'exec' || byId.has(row.id)) continue
      const req = execRequestFromMirror(row)
      if (req) byId.set(req.id, req)
    }
    return Array.from(byId.values())
      .filter((a) => matches(a.agentId))
      .sort((a, b) => a.createdAtMs - b.createdAtMs)
  }, [pendingExec, toolAll, matches])

  const tool = useMemo(
    () =>
      toolAll
        .filter((a) => a.kind !== 'exec' && matches(a.agentId))
        .sort((a, b) => a.createdAt - b.createdAt),
    [toolAll, matches],
  )

  return { exec, tool, total: exec.length + tool.length, resolveTool }
}
