'use client'

import { AnimatePresence, motion } from 'framer-motion'
import { useApprovalsStore } from '@/stores/approvals'
import { useFleetStore } from '@/stores/fleet'
import { useApprovalActions } from './useApprovalActions'
import type { ApprovalRequest } from '@/stores/approvals'

// ─── ApprovalCard ─────────────────────────────────────────────────────────────

function ApprovalCard({ approval }: { approval: ApprovalRequest }) {
  const { handleApproval } = useApprovalActions()
  const agents = useFleetStore((s) => s.agents)

  const agent = approval.agentId ? agents.find((a) => a.id === approval.agentId) : null
  const agentName = agent?.name ?? approval.agentId ?? 'Unknown Agent'

  const details: Record<string, string> = {
    command: approval.command,
    ...(approval.cwd ? { cwd: approval.cwd } : {}),
    ...(approval.host ? { host: approval.host } : {}),
    ...(approval.resolvedPath ? { path: approval.resolvedPath } : {}),
    ...(approval.security ? { security: approval.security } : {}),
  }

  const expiresIn = Math.max(0, Math.round((approval.expiresAtMs - Date.now()) / 1000))

  return (
    <motion.div
      layout
      initial={{ opacity: 0, y: -12, scale: 0.97 }}
      animate={{ opacity: 1, y: 0, scale: 1 }}
      exit={{ opacity: 0, x: 40, scale: 0.95 }}
      transition={{ duration: 0.22, ease: 'easeOut' }}
      style={{
        background: '#111827',
        border: '1px solid rgba(251,191,36,0.25)',
        borderRadius: 10,
        padding: '14px 16px',
        display: 'flex',
        flexDirection: 'column',
        gap: 10,
      }}
    >
      {/* Header row */}
      <div
        style={{ display: 'flex', alignItems: 'center', gap: 8, justifyContent: 'space-between' }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          {/* Amber alert dot */}
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
              fontSize: 12,
              fontWeight: 600,
              color: '#FBBF24',
              fontFamily: 'var(--font-cabinet-grotesk, sans-serif)',
            }}
          >
            Exec Approval
          </span>
        </div>
        <span
          style={{
            fontSize: 10,
            color: 'rgba(232,232,232,0.35)',
            letterSpacing: '0.04em',
          }}
        >
          {agentName} · expires {expiresIn}s
        </span>
      </div>

      {/* Command preview */}
      <div
        style={{
          background: 'rgba(0,0,0,0.32)',
          borderRadius: 6,
          padding: '8px 10px',
          fontFamily: 'var(--font-geist-mono, monospace)',
          fontSize: 12,
          color: '#E8E8E8',
          wordBreak: 'break-all',
          lineHeight: 1.5,
        }}
      >
        {approval.command}
      </div>

      {/* Detail rows */}
      {Object.entries(details)
        .filter(([k]) => k !== 'command')
        .map(([key, val]) => (
          <div key={key} style={{ display: 'flex', gap: 6, fontSize: 11 }}>
            <span style={{ color: 'rgba(232,232,232,0.38)', minWidth: 56 }}>{key}</span>
            <span
              style={{
                color: 'rgba(232,232,232,0.7)',
                fontFamily: 'var(--font-geist-mono, monospace)',
                wordBreak: 'break-all',
              }}
            >
              {val}
            </span>
          </div>
        ))}

      {/* Error */}
      {approval.error && (
        <div
          style={{
            fontSize: 11,
            color: '#E94560',
            background: 'rgba(233,69,96,0.08)',
            borderRadius: 4,
            padding: '4px 8px',
          }}
        >
          {approval.error}
        </div>
      )}

      {/* Action buttons */}
      <div style={{ display: 'flex', gap: 6, marginTop: 2 }}>
        <button
          disabled={approval.resolving}
          onClick={() => void handleApproval(approval.id, 'allow-once')}
          style={{
            flex: 1,
            background: approval.resolving ? 'rgba(52,211,153,0.08)' : 'rgba(52,211,153,0.15)',
            border: '1px solid rgba(52,211,153,0.35)',
            borderRadius: 6,
            color: '#34D399',
            cursor: approval.resolving ? 'not-allowed' : 'pointer',
            fontSize: 11,
            fontWeight: 600,
            padding: '6px 0',
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
            borderRadius: 6,
            color: '#FBBF24',
            cursor: approval.resolving ? 'not-allowed' : 'pointer',
            fontSize: 11,
            fontWeight: 600,
            padding: '6px 0',
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
            borderRadius: 6,
            color: '#E94560',
            cursor: approval.resolving ? 'not-allowed' : 'pointer',
            fontSize: 11,
            fontWeight: 600,
            padding: '6px 0',
            transition: 'all 0.15s',
            opacity: approval.resolving ? 0.5 : 1,
          }}
        >
          Deny
        </button>
      </div>
    </motion.div>
  )
}

// ─── ApprovalsPanel ───────────────────────────────────────────────────────────

export function ApprovalsPanel() {
  const pendingApprovals = useApprovalsStore((s) => s.pendingApprovals)
  const approvals = Array.from(pendingApprovals.values()).sort(
    (a, b) => a.createdAtMs - b.createdAtMs,
  )

  return (
    <div
      style={{
        height: '100%',
        display: 'flex',
        flexDirection: 'column',
        overflow: 'hidden',
      }}
    >
      {/* Panel header */}
      <div
        style={{
          padding: '12px 16px 10px',
          borderBottom: '1px solid rgba(255,255,255,0.06)',
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          flexShrink: 0,
        }}
      >
        <span style={{ fontSize: 13, fontWeight: 600, color: '#E8E8E8' }}>Exec Approvals</span>
        {approvals.length > 0 && (
          <span
            style={{
              background: '#FBBF24',
              color: '#0A0E1A',
              fontSize: 10,
              fontWeight: 700,
              borderRadius: 10,
              padding: '1px 6px',
              lineHeight: 1.6,
            }}
          >
            {approvals.length}
          </span>
        )}
      </div>

      {/* Approval list */}
      <div
        style={{
          flex: 1,
          overflowY: 'auto',
          padding: 12,
          display: 'flex',
          flexDirection: 'column',
          gap: 10,
        }}
      >
        <AnimatePresence mode="popLayout">
          {approvals.length === 0 ? (
            <motion.div
              key="empty"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              style={{
                display: 'flex',
                flexDirection: 'column',
                alignItems: 'center',
                justifyContent: 'center',
                height: '100%',
                gap: 8,
                paddingTop: 60,
              }}
            >
              <span style={{ fontSize: 28 }}>✅</span>
              <span
                style={{
                  fontSize: 13,
                  color: 'rgba(232,232,232,0.38)',
                  textAlign: 'center',
                  lineHeight: 1.5,
                }}
              >
                No pending approvals
              </span>
            </motion.div>
          ) : (
            approvals.map((approval) => <ApprovalCard key={approval.id} approval={approval} />)
          )}
        </AnimatePresence>
      </div>
    </div>
  )
}
