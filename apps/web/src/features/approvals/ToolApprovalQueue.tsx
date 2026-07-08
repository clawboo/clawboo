// ─── Tool / delegation approval queue ─────────────────────────
// The pending tool-call + delegation approvals the user resolves (allow-once /
// always / deny). The broker (and the governance delegation gate) writes a
// pending row to the DB and long-polls for the decision; this is the human side.
// Renders every pending tool approval (UNSCOPED) — the Governance dashboard's
// "review everything" surface. The in-chat tray + the Board's "Needs approval"
// column render the SAME `ToolApprovalCard`, scoped, via `usePendingApprovals`.
// Renders null when there are no pending approvals (unless `showEmpty` is set).

import { ShieldCheck } from 'lucide-react'

import { EmptyState } from '@/features/shared/EmptyState'
import { ToolApprovalCard } from './ToolApprovalCard'
import { useToolApprovals } from './usePendingApprovals'

const KICKER = 'font-mono text-[11px] uppercase tracking-[0.14em] text-foreground/45'

/** Pending approval queue. `showEmpty` renders a "no approvals" line when the
 *  queue is empty (the Governance dashboard wants that; a caller that appends it
 *  to other content leaves it silent when empty by default). */
export function ToolApprovalQueue({ showEmpty = false }: { showEmpty?: boolean }) {
  const { tool: approvals, resolveTool } = useToolApprovals()

  if (approvals.length === 0) {
    if (!showEmpty) return null
    return (
      <div data-testid="tool-approval-queue" className="flex flex-col gap-2">
        <div className={KICKER}>Approvals</div>
        <EmptyState
          icon={ShieldCheck}
          tone="mint"
          title="No pending approvals"
          helper="Tool-call and delegation requests will queue here for you to allow or deny."
          paddingTop={28}
        />
      </div>
    )
  }

  return (
    <div data-testid="tool-approval-queue" className="flex flex-col gap-2">
      <div className={KICKER}>Approvals · {approvals.length}</div>
      {approvals.map((a) => (
        <ToolApprovalCard key={a.id} approval={a} onResolve={resolveTool} showAgentName />
      ))}
    </div>
  )
}
