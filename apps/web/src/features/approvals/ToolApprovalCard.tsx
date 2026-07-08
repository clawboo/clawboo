import { motion } from 'framer-motion'
import { Ban, Check, Star } from 'lucide-react'

import { Button } from '@/features/shared/Button'
import { StatusPill } from '@/features/shared/StatusPill'
import { useFleetStore } from '@/stores/fleet'
import type { ToolApproval, ToolDecision } from './usePendingApprovals'

// ─── ToolApprovalCard ──────────────────────────────────────────────────────
// A pending MCP tool-call / delegation approval, rendered identically wherever it
// surfaces: the Board's "Needs approval" column, the in-chat tray, and the
// Governance dashboard's queue. Resolve is injected so the card stays presentational.

interface ToolApprovalCardProps {
  approval: ToolApproval
  onResolve: (id: string, decision: ToolDecision) => void
  /** Show the requesting agent's name (group chat / board — multiple agents). */
  showAgentName?: boolean
  /** Tighter padding + smaller radius for the in-chat tray. */
  compact?: boolean
}

export function ToolApprovalCard({
  approval,
  onResolve,
  showAgentName = false,
  compact = false,
}: ToolApprovalCardProps) {
  const agents = useFleetStore((s) => s.agents)
  const agentName = approval.agentId
    ? (agents.find((a) => a.id === approval.agentId)?.name ?? approval.agentId)
    : null
  const expiresIn = Math.max(0, Math.round((approval.expiresAt - Date.now()) / 1000))
  // A `delegate` tool call is a delegation gate; everything else is a tool call.
  const isDelegation = /(?:^|[._])delegate(?:[._]|$)/i.test(approval.toolName)

  return (
    <motion.div
      data-testid="approval-card"
      layout
      initial={{ opacity: 0, y: 4 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: -4 }}
      transition={{ duration: 0.2, ease: 'easeOut' }}
      className={
        compact
          ? 'flex flex-col gap-2 rounded-xl border border-border bg-surface p-3'
          : 'flex flex-col gap-2 rounded-2xl border border-border bg-surface p-4'
      }
      style={{ boxShadow: 'var(--shadow-raised)' }}
    >
      <div className="flex items-center justify-between gap-2">
        <span className="flex items-center gap-2">
          <StatusPill tone="warning" pulse label={isDelegation ? 'Delegation' : 'Tool'} />
          <span className="font-data text-[12px] font-semibold text-foreground">
            {approval.toolName}
          </span>
        </span>
        <span className="font-data text-[10px] text-foreground/40">
          {showAgentName && agentName ? `${agentName} · ` : ''}expires {expiresIn}s
        </span>
      </div>

      {approval.reason && (
        <span className="text-[11px] leading-relaxed text-foreground/70">{approval.reason}</span>
      )}

      {approval.argsSummary && (
        <div
          className="font-data rounded-lg px-2.5 py-2 text-[11px] text-foreground/75"
          style={{
            background: 'var(--code-block-bg)',
            wordBreak: 'break-all',
            maxHeight: compact ? 44 : 64,
            overflow: 'hidden',
          }}
        >
          {approval.argsSummary}
        </div>
      )}

      <div className="grid grid-cols-3 gap-1.5">
        <Button
          variant="primary"
          size="sm"
          fullWidth
          onClick={() => onResolve(approval.id, 'allow_once')}
        >
          <Check size={13} strokeWidth={2} />
          Allow Once
        </Button>
        <Button
          variant="secondary"
          size="sm"
          fullWidth
          onClick={() => onResolve(approval.id, 'allow_always')}
        >
          <Star size={12} strokeWidth={2} />
          Always
        </Button>
        <Button
          variant="danger"
          size="sm"
          fullWidth
          onClick={() => onResolve(approval.id, 'deny')}
        >
          <Ban size={12} strokeWidth={2} />
          Deny
        </Button>
      </div>
    </motion.div>
  )
}
