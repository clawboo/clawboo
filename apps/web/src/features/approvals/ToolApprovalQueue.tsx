// ─── Tool / delegation approval queue ─────────────────────────
// The pending tool-call + delegation approvals the user resolves (allow-once /
// always / deny). The broker (and the governance delegation gate) writes a
// pending row to the DB and long-polls for the decision; this is the human side.
// Extracted from MCPToolsSection so BOTH the Approvals panel AND the Governance
// dashboard surface the SAME queue + resolve UX (no duplicate resolve path).
// Renders null when there are no pending approvals (unless `showEmpty` is set),
// so an empty queue adds no chrome.

import { useCallback, useEffect, useState } from 'react'
import { motion } from 'framer-motion'
import { Ban, Check, ShieldCheck, Star } from 'lucide-react'

import { EmptyState } from '@/features/shared/EmptyState'
import { ENTER_SPRING, listDelay } from '@/lib/motion'

interface ToolApproval {
  id: string
  toolName: string
  agentId: string | null
  argsSummary: string | null
  reason: string | null
  createdAt: number
  expiresAt: number
}

type Decision = 'allow_once' | 'allow_always' | 'deny'

const KICKER: React.CSSProperties = {
  fontSize: 11,
  fontWeight: 600,
  letterSpacing: '0.06em',
  textTransform: 'uppercase',
  color: 'rgb(var(--foreground-rgb) / 0.4)',
  fontFamily: 'var(--font-mono)',
  margin: '4px 0',
}

/** Pending approval queue. `showEmpty` renders a "no approvals" line when the
 *  queue is empty (the Governance dashboard wants that; the Approvals panel
 *  appends it to other content, so it stays silent when empty by default). */
export function ToolApprovalQueue({ showEmpty = false }: { showEmpty?: boolean }) {
  const [approvals, setApprovals] = useState<ToolApproval[]>([])

  const refetch = useCallback(async () => {
    try {
      const a = await fetch('/api/tools/approvals?status=pending').then((r) =>
        r.ok ? r.json() : { approvals: [] },
      )
      setApprovals((a as { approvals?: ToolApproval[] }).approvals ?? [])
    } catch {
      /* best-effort */
    }
  }, [])

  useEffect(() => {
    void refetch()
    const id = setInterval(() => void refetch(), 3000)
    return () => clearInterval(id)
  }, [refetch])

  const resolve = useCallback(
    async (id: string, decision: Decision) => {
      await fetch(`/api/tools/approvals/${id}/resolve`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ decision }),
      }).catch(() => {})
      void refetch()
    },
    [refetch],
  )

  if (approvals.length === 0) {
    if (!showEmpty) return null
    return (
      <div
        data-testid="tool-approval-queue"
        style={{ display: 'flex', flexDirection: 'column', gap: 8 }}
      >
        <div style={KICKER}>Approvals</div>
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
    <div
      data-testid="tool-approval-queue"
      style={{ display: 'flex', flexDirection: 'column', gap: 8 }}
    >
      <div style={KICKER}>Approvals · {approvals.length}</div>
      {approvals.map((a, i) => {
        const expiresIn = Math.max(0, Math.round((a.expiresAt - Date.now()) / 1000))
        return (
          <motion.div
            key={a.id}
            data-testid="approval-card"
            initial={{ opacity: 0, y: 4 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ ...ENTER_SPRING, delay: listDelay(i) }}
            className="surface-raised-tier"
            style={{
              border: '1px solid rgb(var(--primary-rgb) / 0.25)',
              borderRadius: 12,
              padding: '12px 14px',
              display: 'flex',
              flexDirection: 'column',
              gap: 8,
            }}
          >
            <div
              style={{
                display: 'flex',
                justifyContent: 'space-between',
                alignItems: 'center',
                gap: 8,
              }}
            >
              <span
                className="font-data"
                style={{
                  fontSize: 12,
                  fontWeight: 600,
                  color: 'var(--primary)',
                }}
              >
                {a.toolName}
              </span>
              <span
                className="font-data"
                style={{ fontSize: 11, color: 'rgb(var(--foreground-rgb) / 0.4)' }}
              >
                expires {expiresIn}s
              </span>
            </div>
            {a.reason && (
              <span
                style={{
                  fontSize: 11.5,
                  color: 'rgb(var(--foreground-rgb) / 0.7)',
                  lineHeight: 1.5,
                }}
              >
                {a.reason}
              </span>
            )}
            {a.argsSummary && (
              <div
                className="font-data"
                style={{
                  background: 'var(--code-block-bg)',
                  borderRadius: 7,
                  padding: '7px 9px',
                  fontSize: 11,
                  color: 'rgb(var(--foreground-rgb) / 0.75)',
                  wordBreak: 'break-all',
                  maxHeight: 64,
                  overflow: 'hidden',
                }}
              >
                {a.argsSummary}
              </div>
            )}
            <div style={{ display: 'flex', gap: 7 }}>
              <ResolveButton
                kind="primary"
                icon={<Check size={14} />}
                onClick={() => void resolve(a.id, 'allow_once')}
              >
                Allow Once
              </ResolveButton>
              <ResolveButton
                kind="amber"
                icon={<Star size={13} />}
                onClick={() => void resolve(a.id, 'allow_always')}
              >
                Always
              </ResolveButton>
              <ResolveButton
                kind="ghost"
                icon={<Ban size={13} />}
                onClick={() => void resolve(a.id, 'deny')}
              >
                Deny
              </ResolveButton>
            </div>
          </motion.div>
        )
      })}
    </div>
  )
}

/** Resolve action. `primary` (filled mint) is the emphasized Allow-Once default;
 *  `amber` is the always-allow accent; `ghost` is the de-emphasized destructive
 *  Deny (outline, no fill). All ≥36px tall for a comfortable tap target. */
function ResolveButton({
  kind,
  icon,
  onClick,
  children,
}: {
  kind: 'primary' | 'amber' | 'ghost'
  icon: React.ReactNode
  onClick: () => void
  children: React.ReactNode
}) {
  const base: React.CSSProperties = {
    flex: 1,
    height: 36,
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    borderRadius: 8,
    cursor: 'pointer',
    fontSize: 12,
    fontWeight: 600,
    transition:
      'filter var(--motion-fast), background var(--motion-fast), border-color var(--motion-fast)',
  }
  const palette: Record<'primary' | 'amber' | 'ghost', React.CSSProperties> = {
    primary: {
      background: 'var(--mint)',
      border: '1px solid var(--mint)',
      color: 'var(--primary-foreground)',
    },
    amber: {
      background: 'rgb(var(--amber-rgb) / 0.14)',
      border: '1px solid rgb(var(--amber-rgb) / 0.3)',
      color: 'var(--amber)',
    },
    ghost: {
      background: 'transparent',
      border: '1px solid rgb(var(--foreground-rgb) / 0.14)',
      color: 'rgb(var(--foreground-rgb) / 0.55)',
    },
  }
  return (
    <button
      type="button"
      onClick={onClick}
      style={{ ...base, ...palette[kind] }}
      onMouseEnter={(e) => {
        if (kind === 'ghost') {
          e.currentTarget.style.background = 'rgb(var(--primary-rgb) / 0.1)'
          e.currentTarget.style.borderColor = 'rgb(var(--primary-rgb) / 0.35)'
          e.currentTarget.style.color = 'var(--primary)'
        } else {
          e.currentTarget.style.filter = 'brightness(1.06)'
        }
      }}
      onMouseLeave={(e) => {
        if (kind === 'ghost') {
          e.currentTarget.style.background = 'transparent'
          e.currentTarget.style.borderColor = 'rgb(var(--foreground-rgb) / 0.14)'
          e.currentTarget.style.color = 'rgb(var(--foreground-rgb) / 0.55)'
        } else {
          e.currentTarget.style.filter = 'none'
        }
      }}
      onMouseDown={(e) => {
        e.currentTarget.style.transform = 'scale(0.98)'
      }}
      onMouseUp={(e) => {
        e.currentTarget.style.transform = 'scale(1)'
      }}
    >
      {icon}
      {children}
    </button>
  )
}
