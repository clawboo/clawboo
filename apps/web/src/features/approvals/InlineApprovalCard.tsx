import { motion } from 'framer-motion'
import { useFleetStore } from '@/stores/fleet'
import type { ApprovalRequest } from '@/stores/approvals'
import { useApprovalActions } from './useApprovalActions'

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
        style={{
          background: '#111827',
          border: '1px solid rgba(251,191,36,0.25)',
          borderRadius: 8,
          padding: '10px 12px',
          display: 'flex',
          flexDirection: 'column',
          gap: 8,
        }}
      >
        {/* Row 1: Header */}
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 6,
            justifyContent: 'space-between',
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
            {/* Pulsing amber dot */}
            <motion.div
              animate={{ opacity: [1, 0.3, 1] }}
              transition={{ duration: 1.4, repeat: Infinity }}
              style={{
                width: 7,
                height: 7,
                borderRadius: '50%',
                background: '#FBBF24',
                flexShrink: 0,
              }}
            />
            <span
              style={{
                fontSize: 11,
                fontWeight: 600,
                color: '#FBBF24',
                fontFamily: 'var(--font-cabinet-grotesk, sans-serif)',
              }}
            >
              Exec Approval
            </span>
            {showAgentName && (
              <span
                style={{
                  fontSize: 10,
                  color: 'rgba(232,232,232,0.4)',
                  marginLeft: 2,
                }}
              >
                {agentName}
              </span>
            )}
          </div>
          <span
            style={{
              fontSize: 10,
              color: 'rgba(232,232,232,0.3)',
              letterSpacing: '0.04em',
              flexShrink: 0,
            }}
          >
            expires {expiresIn}s
          </span>
        </div>

        {/* Row 2: Command preview */}
        <div
          style={{
            background: 'rgba(0,0,0,0.32)',
            borderRadius: 5,
            padding: '6px 8px',
            fontFamily: 'var(--font-geist-mono, monospace)',
            fontSize: 11,
            color: '#E8E8E8',
            wordBreak: 'break-all',
            lineHeight: 1.5,
            maxHeight: 36,
            overflow: 'hidden',
          }}
        >
          {approval.command}
        </div>

        {/* Error */}
        {approval.error && (
          <div
            style={{
              fontSize: 10,
              color: '#E94560',
              background: 'rgba(233,69,96,0.08)',
              borderRadius: 4,
              padding: '3px 6px',
            }}
          >
            {approval.error}
          </div>
        )}

        {/* Row 3: Action buttons */}
        <div style={{ display: 'flex', gap: 5 }}>
          <button
            disabled={approval.resolving}
            onClick={() => void handleApproval(approval.id, 'allow-once')}
            style={{
              flex: 1,
              background: approval.resolving ? 'rgba(52,211,153,0.08)' : 'rgba(52,211,153,0.15)',
              border: '1px solid rgba(52,211,153,0.35)',
              borderRadius: 5,
              color: '#34D399',
              cursor: approval.resolving ? 'not-allowed' : 'pointer',
              fontSize: 11,
              fontWeight: 600,
              padding: '5px 0',
              transition: 'all 0.15s',
              opacity: approval.resolving ? 0.5 : 1,
            }}
          >
            Allow Once
          </button>
          <button
            disabled={approval.resolving}
            onClick={() => void handleApproval(approval.id, 'allow-always')}
            style={{
              flex: 1,
              background: approval.resolving ? 'rgba(251,191,36,0.08)' : 'rgba(251,191,36,0.15)',
              border: '1px solid rgba(251,191,36,0.35)',
              borderRadius: 5,
              color: '#FBBF24',
              cursor: approval.resolving ? 'not-allowed' : 'pointer',
              fontSize: 11,
              fontWeight: 600,
              padding: '5px 0',
              transition: 'all 0.15s',
              opacity: approval.resolving ? 0.5 : 1,
            }}
          >
            Always Allow
          </button>
          <button
            disabled={approval.resolving}
            onClick={() => void handleApproval(approval.id, 'deny')}
            style={{
              flex: 1,
              background: approval.resolving ? 'rgba(233,69,96,0.08)' : 'rgba(233,69,96,0.15)',
              border: '1px solid rgba(233,69,96,0.35)',
              borderRadius: 5,
              color: '#E94560',
              cursor: approval.resolving ? 'not-allowed' : 'pointer',
              fontSize: 11,
              fontWeight: 600,
              padding: '5px 0',
              transition: 'all 0.15s',
              opacity: approval.resolving ? 0.5 : 1,
            }}
          >
            Deny
          </button>
        </div>
      </div>
    </motion.div>
  )
}
