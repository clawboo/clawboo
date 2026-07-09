import { useEffect, useMemo, useRef, useState } from 'react'
import { AnimatePresence } from 'framer-motion'
import { ChevronLeft, ChevronRight, ShieldAlert } from 'lucide-react'

import { InlineApprovalCard } from '@/features/approvals/InlineApprovalCard'
import { ToolApprovalCard } from '@/features/approvals/ToolApprovalCard'
import { usePendingApprovals, type ToolApproval } from '@/features/approvals/usePendingApprovals'
import type { ApprovalRequest } from '@/stores/approvals'

// ─── ApprovalsColumn ───────────────────────────────────────────────────────
// The Board's "Needs approval" column (first column). Renders pending approvals
// from BOTH systems (OpenClaw exec + MCP tool / delegation), scoped to the board's
// team filter. It COLLAPSES to a thin rail when there's nothing to approve and
// AUTO-EXPANDS when a new approval arrives, so it stays out of the way but surfaces
// time-sensitive gates without a horizontal scroll.

const SECTION_LABEL =
  'font-mono text-[11px] font-semibold uppercase tracking-[0.14em] text-foreground/45'

type Item =
  | { key: string; ts: number; kind: 'exec'; exec: ApprovalRequest }
  | { key: string; ts: number; kind: 'tool'; tool: ToolApproval }

export function ApprovalsColumn({ teamFilter }: { teamFilter: string }) {
  // `all` → no team filter (every pending approval); a team id → that team's agents
  // plus any approval not attributable to an agent (includeUnscoped).
  const { exec, tool, total, resolveTool } = usePendingApprovals({
    teamId: teamFilter === 'all' ? null : teamFilter,
    includeUnscoped: true,
  })

  const items = useMemo<Item[]>(() => {
    const merged: Item[] = [
      ...exec.map((a): Item => ({ key: `exec-${a.id}`, ts: a.createdAtMs, kind: 'exec', exec: a })),
      ...tool.map((a): Item => ({ key: `tool-${a.id}`, ts: a.createdAt, kind: 'tool', tool: a })),
    ]
    return merged.sort((a, b) => a.ts - b.ts)
  }, [exec, tool])

  // Auto-collapse when empty; auto-expand when a new approval arrives (0 → >0), even
  // if the user had collapsed it, so a time-sensitive gate can't be missed.
  const [manualCollapsed, setManualCollapsed] = useState(false)
  const prevTotal = useRef(total)
  useEffect(() => {
    if (prevTotal.current === 0 && total > 0) setManualCollapsed(false)
    prevTotal.current = total
  }, [total])
  const collapsed = total === 0 ? true : manualCollapsed

  if (collapsed) {
    const hasPending = total > 0
    return (
      <button
        type="button"
        data-testid="board-approvals-rail"
        aria-label={hasPending ? `${total} pending approvals, expand` : 'No pending approvals'}
        aria-expanded={false}
        disabled={!hasPending}
        onClick={() => setManualCollapsed(false)}
        className={[
          'flex w-12 shrink-0 flex-col items-center gap-2 self-stretch rounded-2xl border p-2 pt-3 transition-colors',
          hasPending
            ? 'cursor-pointer border-amber/40 bg-amber/[0.06] hover:bg-amber/[0.12]'
            : 'border-border bg-foreground/[0.02]',
        ].join(' ')}
      >
        <ShieldAlert
          size={17}
          strokeWidth={2}
          className={hasPending ? 'text-amber' : 'text-foreground/35'}
        />
        {hasPending && (
          <span className="font-data rounded-full bg-amber/20 px-1.5 py-0.5 text-[10px] font-semibold text-amber">
            {total}
          </span>
        )}
        <span
          className="mt-1 text-[10px] font-semibold uppercase tracking-[0.12em] text-foreground/40"
          style={{ writingMode: 'vertical-rl' }}
        >
          Needs approval
        </span>
        {hasPending && <ChevronRight size={13} className="mt-auto text-foreground/40" />}
      </button>
    )
  }

  return (
    <div
      data-testid="board-column-approvals"
      className="flex max-h-full w-[288px] shrink-0 flex-col gap-2.5 rounded-2xl border border-amber/40 bg-amber/[0.04] p-3"
    >
      <div className="flex items-center justify-between px-1">
        <span className="flex items-center gap-1.5">
          <ShieldAlert size={14} strokeWidth={2} className="text-amber" />
          <span className={SECTION_LABEL}>Needs approval</span>
          <span className="font-data rounded-full bg-amber/20 px-2 py-0.5 text-[10px] font-semibold text-amber">
            {total}
          </span>
        </span>
        <button
          type="button"
          aria-label="Collapse approvals"
          aria-expanded
          onClick={() => setManualCollapsed(true)}
          className="cursor-pointer rounded-md p-0.5 text-foreground/40 transition hover:bg-foreground/[0.06] hover:text-foreground/70"
        >
          <ChevronLeft size={15} strokeWidth={2} />
        </button>
      </div>
      <div className="flex min-h-0 flex-col gap-2.5 overflow-y-auto">
        <AnimatePresence mode="popLayout">
          {items.map((it) =>
            it.kind === 'exec' ? (
              <InlineApprovalCard key={it.key} approval={it.exec} showAgentName />
            ) : (
              <ToolApprovalCard
                key={it.key}
                approval={it.tool}
                onResolve={resolveTool}
                showAgentName
                compact
              />
            ),
          )}
        </AnimatePresence>
      </div>
    </div>
  )
}
