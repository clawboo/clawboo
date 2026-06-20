import { useMemo } from 'react'
import { AnimatePresence, motion } from 'framer-motion'
import { CheckCircle2 } from 'lucide-react'
import { useApprovalsStore } from '@/stores/approvals'
import { useFleetStore } from '@/stores/fleet'
import { useTeamStore } from '@/stores/team'
import { useApprovalActions } from './useApprovalActions'
import { MCPToolsSection } from './MCPToolsSection'
import type { ApprovalRequest } from '@/stores/approvals'
import { GitHubStarButton } from '@/features/promo/GitHubStarButton'

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
        background: 'var(--card)',
        border: '1px solid rgb(var(--amber-rgb) / 0.25)',
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
              background: 'var(--amber)',
              flexShrink: 0,
            }}
          />
          <span
            style={{
              fontSize: 12,
              fontWeight: 600,
              color: 'var(--amber)',
              fontFamily: 'var(--font-display)',
              letterSpacing: '-0.01em',
            }}
          >
            Exec Approval
          </span>
        </div>
        <span
          style={{
            fontSize: 10,
            color: 'rgb(var(--foreground-rgb) / 0.35)',
            letterSpacing: '0.04em',
          }}
        >
          {agentName} · expires {expiresIn}s
        </span>
      </div>

      {/* Command preview */}
      <div
        style={{
          background: 'var(--code-block-bg)',
          borderRadius: 6,
          padding: '8px 10px',
          fontFamily: 'var(--font-geist-mono, monospace)',
          fontSize: 12,
          color: 'var(--foreground)',
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
            <span style={{ color: 'rgb(var(--foreground-rgb) / 0.38)', minWidth: 56 }}>{key}</span>
            <span
              style={{
                color: 'rgb(var(--foreground-rgb) / 0.7)',
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
            color: 'var(--primary)',
            background: 'rgb(var(--primary-rgb) / 0.08)',
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
            background: approval.resolving
              ? 'rgb(var(--mint-rgb) / 0.08)'
              : 'rgb(var(--mint-rgb) / 0.15)',
            border: '1px solid rgb(var(--mint-rgb) / 0.35)',
            borderRadius: 6,
            color: 'var(--mint)',
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
            background: approval.resolving
              ? 'rgb(var(--amber-rgb) / 0.08)'
              : 'rgb(var(--amber-rgb) / 0.15)',
            border: '1px solid rgb(var(--amber-rgb) / 0.35)',
            borderRadius: 6,
            color: 'var(--amber)',
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
            background: approval.resolving
              ? 'rgb(var(--primary-rgb) / 0.08)'
              : 'rgb(var(--primary-rgb) / 0.15)',
            border: '1px solid rgb(var(--primary-rgb) / 0.35)',
            borderRadius: 6,
            color: 'var(--primary)',
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
  const selectedTeamId = useTeamStore((s) => s.selectedTeamId)
  const agents = useFleetStore((s) => s.agents)

  // Build set of agent IDs for the selected team (null = show all)
  const teamAgentIds = useMemo(() => {
    if (selectedTeamId === null) return null
    return new Set(agents.filter((a) => a.teamId === selectedTeamId).map((a) => a.id))
  }, [agents, selectedTeamId])

  const approvals = Array.from(pendingApprovals.values())
    .filter((a) => {
      if (teamAgentIds === null) return true
      if (!a.agentId) return true
      return teamAgentIds.has(a.agentId)
    })
    .sort((a, b) => a.createdAtMs - b.createdAtMs)

  return (
    <div
      style={{
        height: '100%',
        display: 'flex',
        flexDirection: 'column',
        overflow: 'hidden',
      }}
    >
      {/* Panel header — same shape as Atlas / Marketplace / Scheduler /
          Cost / System (44 px fixed height, padding 0 12 px, border-b).
          Star pill at right:12 top:6 matches every other view. */}
      <div
        style={{
          height: 44,
          padding: '0 12px',
          borderBottom: '1px solid rgb(var(--foreground-rgb) / 0.06)',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: 8,
          flexShrink: 0,
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <span style={{ fontSize: 13, fontWeight: 600, color: 'var(--foreground)' }}>
            Exec Approvals
          </span>
          {approvals.length > 0 && (
            <span
              style={{
                background: 'var(--amber)',
                color: 'var(--background)',
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
        <GitHubStarButton />
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
                gap: 10,
                paddingTop: 48,
                paddingLeft: 24,
                paddingRight: 24,
              }}
            >
              <div
                style={{
                  display: 'flex',
                  width: 56,
                  height: 56,
                  alignItems: 'center',
                  justifyContent: 'center',
                  borderRadius: 999,
                  background: 'rgb(var(--mint-rgb) / 0.1)',
                  border: '1px solid rgb(var(--mint-rgb) / 0.2)',
                }}
              >
                <CheckCircle2 size={26} strokeWidth={1.75} color="var(--mint)" />
              </div>
              <span
                style={{
                  fontSize: 14,
                  fontWeight: 600,
                  color: 'rgb(var(--foreground-rgb) / 0.65)',
                  textAlign: 'center',
                  fontFamily: 'var(--font-display)',
                  letterSpacing: '-0.01em',
                }}
              >
                No pending approvals
              </span>
              <div
                style={{
                  marginTop: 4,
                  fontSize: 11,
                  color: 'rgb(var(--foreground-rgb) / 0.3)',
                  textAlign: 'center',
                  lineHeight: 1.7,
                  maxWidth: 280,
                }}
              >
                <p style={{ margin: '0 0 8px' }}>To see approvals here:</p>
                <ol
                  style={{
                    margin: 0,
                    paddingLeft: 18,
                    textAlign: 'left',
                  }}
                >
                  <li style={{ marginBottom: 4 }}>
                    Open an agent → Personality tab →{' '}
                    <strong style={{ color: 'rgb(var(--foreground-rgb) / 0.45)' }}>
                      Execution Permissions
                    </strong>
                  </li>
                  <li style={{ marginBottom: 4 }}>
                    Set &quot;Command Execution&quot; to{' '}
                    <strong style={{ color: 'rgb(var(--foreground-rgb) / 0.45)' }}>
                      Always Ask
                    </strong>{' '}
                    or{' '}
                    <strong style={{ color: 'rgb(var(--foreground-rgb) / 0.45)' }}>
                      Ask for Unknown
                    </strong>
                  </li>
                  <li>
                    Ask the agent to run a command (e.g., &quot;List files in this directory&quot;)
                  </li>
                </ol>
                <p
                  style={{
                    margin: '10px 0 0',
                    fontSize: 10,
                    color: 'rgb(var(--foreground-rgb) / 0.22)',
                  }}
                >
                  The agent will pause and ask for your approval before executing.
                </p>
              </div>
            </motion.div>
          ) : (
            approvals.map((approval) => <ApprovalCard key={approval.id} approval={approval} />)
          )}
        </AnimatePresence>

        {/* MCP tool governance — availability + tool-call approvals. */}
        <MCPToolsSection />
      </div>
    </div>
  )
}
