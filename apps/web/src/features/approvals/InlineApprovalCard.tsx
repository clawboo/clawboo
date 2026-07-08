import { motion } from 'framer-motion'
import { useFleetStore } from '@/stores/fleet'
import type { ApprovalRequest } from '@/stores/approvals'
import { useApprovalActions } from './useApprovalActions'
import { Button } from '@/features/shared/Button'
import { StatusPill } from '@/features/shared/StatusPill'

// ─── InlineApprovalCard ────────────────────────────────────────────────────
// Compact approval card for embedding directly in the chat column.
// Shares the same hook + store as the full ApprovalsPanel — actions sync both UIs.

interface InlineApprovalCardProps {
  approval: ApprovalRequest
  showAgentName?: boolean
}

export function InlineApprovalCard({ approval, showAgentName = false }: InlineApprovalCardProps) {
  const { handleApproval } = useApprovalActions()
  const agents = useFleetStore((s) => s.agents)

  const agent = approval.agentId ? agents.find((a) => a.id === approval.agentId) : null
  const agentName = agent?.name ?? approval.agentId ?? 'Unknown Agent'

  const expiresIn = Math.max(0, Math.round((approval.expiresAtMs - Date.now()) / 1000))

  return (
    <motion.div
      layout
      initial={{ opacity: 0, height: 0 }}
      animate={{ opacity: 1, height: 'auto' }}
      exit={{ opacity: 0, height: 0, marginBottom: 0 }}
      transition={{ duration: 0.2, ease: 'easeOut' }}
      style={{ overflow: 'hidden' }}
    >
      <div
        className="flex flex-col gap-2 rounded-xl border border-border bg-surface p-3"
        style={{ boxShadow: 'var(--shadow-raised)' }}
      >
        {/* Row 1: Header */}
        <div className="flex items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            <StatusPill tone="warning" pulse label="Exec Approval" />
            {showAgentName && <span className="text-[10px] text-foreground/40">{agentName}</span>}
          </div>
          <span className="font-data text-[10px] text-foreground/30">expires {expiresIn}s</span>
        </div>

        {/* Row 2: Command preview */}
        <div
          className="font-data rounded-lg px-2 py-1.5 text-[11px] leading-relaxed text-foreground"
          style={{
            background: 'var(--code-block-bg)',
            wordBreak: 'break-all',
            maxHeight: 36,
            overflow: 'hidden',
          }}
        >
          {approval.command}
        </div>

        {/* Error */}
        {approval.error && (
          <div
            className="rounded-md px-1.5 py-1 text-[10px]"
            style={{
              color: 'var(--destructive)',
              background: 'color-mix(in srgb, var(--destructive) 8%, transparent)',
            }}
          >
            {approval.error}
          </div>
        )}

        {/* Row 3: Action buttons — grid so all three split evenly even in a narrow
            card (the in-chat tray + the Board's "Needs approval" column). */}
        <div className="grid grid-cols-3 gap-1.5">
          <Button
            variant="primary"
            size="sm"
            fullWidth
            disabled={approval.resolving}
            loading={approval.resolving}
            onClick={() => void handleApproval(approval.id, 'allow-once')}
          >
            Allow Once
          </Button>
          <Button
            variant="secondary"
            size="sm"
            fullWidth
            disabled={approval.resolving}
            onClick={() => void handleApproval(approval.id, 'allow-always')}
          >
            Always
          </Button>
          <Button
            variant="danger"
            size="sm"
            fullWidth
            disabled={approval.resolving}
            onClick={() => void handleApproval(approval.id, 'deny')}
          >
            Deny
          </Button>
        </div>
      </div>
    </motion.div>
  )
}
