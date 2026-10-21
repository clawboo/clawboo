import { motion } from 'framer-motion'
import { AgentBooAvatar } from '@/components/AgentBooAvatar'
import { useFleetStore } from '@/stores/fleet'
import type { ApprovalRequest } from '@/stores/approvals'
import { useApprovalActions } from './useApprovalActions'
import { Button } from '@/features/shared/Button'
import { StatusPill } from '@/features/shared/StatusPill'

// ─── InlineApprovalCard ────────────────────────────────────────────────────
// Compact approval card for embedding directly in the chat column.
// Shares the same hook + store as the full ApprovalsPanel, so actions sync both UIs.
//
// The `board` variant is the same card on the board's Needs you, where
// red belongs to today's date alone: the reason reads as amber words, Allow Once
// is the one filled (ink) button, and Always and Deny are outlined. Only the look
// changes; every button resolves through the same `handleApproval`.

interface InlineApprovalCardProps {
  approval: ApprovalRequest
  showAgentName?: boolean
  variant?: 'default' | 'board'
}

// The board's buttons fit three across a narrow cell: shorter, tighter, and
// Allow Once takes the room the other two leave.
const BOARD_BUTTON = 'h-7! px-2! text-[12px]!'

export function InlineApprovalCard({
  approval,
  showAgentName = false,
  variant = 'default',
}: InlineApprovalCardProps) {
  const { handleApproval } = useApprovalActions()
  const agents = useFleetStore((s) => s.agents)

  const agent = approval.agentId ? agents.find((a) => a.id === approval.agentId) : null
  const agentName = agent?.name ?? approval.agentId ?? 'Unknown Agent'
  const board = variant === 'board'

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
        {board ? (
          <>
            <div className="flex items-center justify-between gap-2">
              <span className="board-reason inline-flex min-w-0 items-center gap-1.5 text-[11px] font-semibold leading-4">
                <span aria-hidden className="size-1.5 shrink-0 rounded-full bg-amber" />
                <span className="truncate">Wants to run a command</span>
              </span>
              <span className="font-data shrink-0 text-[10px] tabular-nums text-muted-foreground">
                expires {expiresIn}s
              </span>
            </div>
            {showAgentName && (
              <span className="-mt-1 flex min-w-0 items-center gap-1.5 text-[11px] text-muted-foreground">
                {approval.agentId && <AgentBooAvatar agentId={approval.agentId} size={16} />}
                <span className="truncate">{agent?.name ?? 'Unknown agent'}</span>
              </span>
            )}
          </>
        ) : (
          <div className="flex items-center justify-between gap-2">
            <div className="flex items-center gap-2">
              <StatusPill tone="warning" pulse label="Exec Approval" />
              {showAgentName && (
                <span className="text-[10px] text-muted-foreground">{agentName}</span>
              )}
            </div>
            <span className="font-data text-[10px] text-muted-foreground">
              expires {expiresIn}s
            </span>
          </div>
        )}

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

        {/* Row 3: Action buttons. The grid splits all three evenly even in a narrow
            card (the in-chat tray); the board variant lets Allow Once grow
            instead, so the labels fit its cell. */}
        <div className={board ? 'flex gap-1.5' : 'grid grid-cols-3 gap-1.5'}>
          <Button
            variant={board ? 'solid' : 'primary'}
            size="sm"
            fullWidth={!board}
            className={board ? `${BOARD_BUTTON} min-w-0 flex-1` : ''}
            disabled={approval.resolving}
            loading={approval.resolving}
            onClick={() => void handleApproval(approval.id, 'allow-once')}
          >
            Allow Once
          </Button>
          <Button
            variant={board ? 'outline' : 'secondary'}
            size="sm"
            fullWidth={!board}
            className={board ? `${BOARD_BUTTON} border-border-strong!` : ''}
            disabled={approval.resolving}
            onClick={() => void handleApproval(approval.id, 'allow-always')}
          >
            Always
          </Button>
          <Button
            variant={board ? 'outline' : 'danger'}
            size="sm"
            fullWidth={!board}
            className={board ? `${BOARD_BUTTON} border-border-strong!` : ''}
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
