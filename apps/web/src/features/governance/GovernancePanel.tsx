// Governance dashboard. The human-facing surface for the trust controls:
// budgets (spend vs cap, status, resume + raise-cap), the enforced-in-code caps
// (depth / fan-out), the tool/delegation approval queue (shared
// <ToolApprovalQueue/> — same resolve UX as the Approvals panel), and the
// append-only forensic audit log (filterable). Pause-at-cap is AUTOMATIC in the
// executor — the UI only raises caps + resumes. tenantId is surfaced read-only
// (the dormant per-tenant seam).

import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import { motion } from 'framer-motion'

import {
  DollarSign,
  GitFork,
  Layers,
  RefreshCw,
  ScrollText,
  ShieldAlert,
  Wallet,
} from 'lucide-react'

import { ToolApprovalQueue } from '@/features/approvals/ToolApprovalQueue'
import { useToastStore } from '@/stores/toast'
import { GitHubStarButton } from '@/features/promo/GitHubStarButton'
import { EmptyState } from '@/features/shared/EmptyState'
import { FormattedAlert } from '@/features/shared/FormattedAlert'
import { Select } from '@/features/shared/Select'
import { StatusPill, type StatusTone } from '@/features/shared/StatusPill'
import { ENTER_SPRING, listDelay } from '@/lib/motion'
import {
  listAudit,
  listBudgets,
  resumeBudget,
  setBudget,
  type AuditEventType,
  type AuditRow,
  type Budget,
  type BudgetScope,
  type BudgetMode,
} from '@/lib/governanceClient'

const muted = (o: number) => `rgb(var(--foreground-rgb) / ${o})`

const SCOPES: BudgetScope[] = ['agent', 'mission', 'team', 'tenant']
const EVENT_TYPES: AuditEventType[] = [
  'install',
  'approval',
  'tool_call',
  'budget',
  'cap_hit',
  'verification',
  'circuit_break',
]
const SINCE_WINDOWS: { label: string; ms: number | null }[] = [
  { label: 'All', ms: null },
  { label: '1h', ms: 3_600_000 },
  { label: '24h', ms: 86_400_000 },
  { label: '7d', ms: 604_800_000 },
]

// Budget lifecycle → shared StatusPill tone. active → success, soft-capped →
// warning, paused → error. Keep the per-status accent var for the progress bar
// (the pill carries its own palette).
const STATUS_TONE: Record<Budget['status'], string> = {
  active: 'var(--mint)',
  soft_capped: 'var(--amber)',
  paused: 'var(--primary)',
}
const STATUS_PILL: Record<Budget['status'], StatusTone> = {
  active: 'success',
  soft_capped: 'warning',
  paused: 'error',
}

const KICKER = 'mb-2.5 font-mono text-[11px] font-semibold uppercase tracking-wider'
const KICKER_COLOR = muted(0.4)

function SectionKicker({ children }: { children: ReactNode }) {
  return (
    <div className={KICKER} style={{ color: KICKER_COLOR }}>
      {children}
    </div>
  )
}

const inputStyle: React.CSSProperties = {
  fontSize: 12,
  height: 30,
  padding: '0 10px',
  borderRadius: 7,
  border: '1px solid rgb(var(--foreground-rgb) / 0.12)',
  background: muted(0.05),
  color: 'var(--foreground)',
  fontFamily: 'var(--font-body)',
  outline: 'none',
}

// Mint-accented CTA button (set budget / set cap when paused / resume). ≥30px
// tall with a hover lift.
function CtaButton({
  children,
  onClick,
  testId,
}: {
  children: ReactNode
  onClick: () => void | Promise<void>
  testId?: string
}) {
  return (
    <button
      type="button"
      data-testid={testId}
      onClick={() => void onClick()}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        height: 30,
        padding: '0 12px',
        fontSize: 12,
        fontWeight: 600,
        borderRadius: 7,
        border: '1px solid rgb(var(--mint-rgb) / 0.3)',
        background: 'rgb(var(--mint-rgb) / 0.12)',
        color: 'var(--mint)',
        cursor: 'pointer',
        transition: 'background var(--motion-fast), border-color var(--motion-fast)',
      }}
      onMouseEnter={(e) => {
        e.currentTarget.style.background = 'rgb(var(--mint-rgb) / 0.2)'
        e.currentTarget.style.borderColor = 'rgb(var(--mint-rgb) / 0.45)'
      }}
      onMouseLeave={(e) => {
        e.currentTarget.style.background = 'rgb(var(--mint-rgb) / 0.12)'
        e.currentTarget.style.borderColor = 'rgb(var(--mint-rgb) / 0.3)'
      }}
    >
      {children}
    </button>
  )
}

// Outline / secondary button (raise cap). ≥30px tall with a hover lift.
function GhostButton({
  children,
  onClick,
}: {
  children: ReactNode
  onClick: () => void | Promise<void>
}) {
  return (
    <button
      type="button"
      onClick={() => void onClick()}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        height: 30,
        padding: '0 12px',
        fontSize: 12,
        fontWeight: 600,
        borderRadius: 7,
        border: '1px solid rgb(var(--foreground-rgb) / 0.14)',
        background: 'transparent',
        color: muted(0.6),
        cursor: 'pointer',
        transition:
          'background var(--motion-fast), border-color var(--motion-fast), color var(--motion-fast)',
      }}
      onMouseEnter={(e) => {
        e.currentTarget.style.background = muted(0.05)
        e.currentTarget.style.borderColor = muted(0.22)
        e.currentTarget.style.color = 'var(--foreground)'
      }}
      onMouseLeave={(e) => {
        e.currentTarget.style.background = 'transparent'
        e.currentTarget.style.borderColor = muted(0.14)
        e.currentTarget.style.color = muted(0.6)
      }}
    >
      {children}
    </button>
  )
}

function dollars(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`
}

function summarize(raw: string): string {
  try {
    const v = JSON.parse(raw) as unknown
    const s = JSON.stringify(v)
    return s.length > 180 ? `${s.slice(0, 180)}…` : s
  } catch {
    return raw.slice(0, 180)
  }
}

function BudgetRow({ b, onChanged }: { b: Budget; onChanged: () => void }) {
  const [capInput, setCapInput] = useState('')
  const addToast = useToastStore((s) => s.addToast)
  const pct = b.limitUsdCents > 0 ? Math.min(100, (b.spentUsdCents / b.limitUsdCents) * 100) : 0
  return (
    <div
      data-testid="budget-row"
      className="surface-raised-tier"
      style={{
        borderRadius: 10,
        padding: '11px 13px',
        display: 'flex',
        flexDirection: 'column',
        gap: 9,
      }}
    >
      <div
        style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}
      >
        <span style={{ display: 'flex', alignItems: 'center', gap: 7, minWidth: 0 }}>
          <span
            className="font-data"
            style={{
              fontSize: 9,
              fontWeight: 700,
              textTransform: 'uppercase',
              letterSpacing: '0.04em',
              padding: '1px 6px',
              borderRadius: 4,
              color: muted(0.6),
              background: muted(0.06),
            }}
          >
            {b.scope}
          </span>
          <span
            className="font-data"
            style={{
              fontSize: 12,
              color: 'var(--foreground)',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
            }}
          >
            {b.scopeId}
          </span>
          {b.tenantId && (
            <span className="font-data" style={{ fontSize: 11, color: muted(0.4) }}>
              · tenant {b.tenantId}
            </span>
          )}
        </span>
        <span style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <span
            data-testid="budget-mode"
            title={
              b.mode === 'warn'
                ? 'Track-and-warn: never auto-pauses'
                : 'Hard cap: auto-pauses at 100%'
            }
          >
            <StatusPill
              tone={b.mode === 'warn' ? 'warning' : 'error'}
              label={b.mode === 'warn' ? 'warn' : 'cap'}
            />
          </span>
          <span data-testid="budget-status">
            <StatusPill tone={STATUS_PILL[b.status]} label={b.status} />
          </span>
          {b.status === 'active' &&
            b.mode === 'cap' &&
            b.limitUsdCents > 0 &&
            b.spentUsdCents >= b.limitUsdCents && (
              <span
                data-testid="budget-will-repause"
                title="Resumed over its cap — the next recorded spend will re-pause it. Raise the cap to make forward progress."
              >
                <StatusPill tone="warning" label="will re-pause" />
              </span>
            )}
        </span>
      </div>

      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          fontSize: 11,
          color: muted(0.6),
        }}
      >
        <span className="font-data">
          {dollars(b.spentUsdCents)} / {dollars(b.limitUsdCents)}
        </span>
        <span className="font-data" style={{ color: muted(0.4) }}>
          {pct.toFixed(0)}%
        </span>
      </div>
      <div style={{ height: 5, borderRadius: 3, background: muted(0.08), overflow: 'hidden' }}>
        <div style={{ width: `${pct}%`, height: '100%', background: STATUS_TONE[b.status] }} />
      </div>

      <div style={{ display: 'flex', alignItems: 'center', gap: 7 }}>
        <input
          value={capInput}
          onChange={(e) => setCapInput(e.target.value)}
          placeholder="new cap $"
          inputMode="decimal"
          className="font-data"
          style={{ ...inputStyle, width: 96 }}
        />
        <GhostButton
          onClick={async () => {
            const v = Number(capInput)
            if (!Number.isFinite(v) || v < 0) return
            await setBudget({
              scope: b.scope,
              scopeId: b.scopeId,
              limitUsdCents: Math.round(v * 100),
              mode: b.mode, // preserve the row's posture when raising its limit
            })
            setCapInput('')
            onChanged()
          }}
        >
          Set cap
        </GhostButton>
        {b.status === 'paused' && (
          <CtaButton
            testId="budget-resume"
            onClick={async () => {
              const { willRepause } = await resumeBudget(b.scope, b.scopeId)
              if (willRepause) {
                addToast({
                  type: 'error',
                  message:
                    'Resumed, but spend is still at/over the cap — raise the cap to make progress.',
                })
              }
              onChanged()
            }}
          >
            Resume
          </CtaButton>
        )}
      </div>
    </div>
  )
}

// Caps are enforced-in-code constraints — each gets a leading Lucide icon so it
// reads as an authoritative constraint, not a gray placeholder.
const CAP_CHIPS: { Icon: typeof Layers; label: string; value: string }[] = [
  { Icon: Layers, label: 'max spawn depth', value: '2' },
  { Icon: GitFork, label: 'max fan-out', value: '8' },
  { Icon: DollarSign, label: 'per-node cost', value: 'per-run' },
]

function CapChip({ Icon, label, value }: { Icon: typeof Layers; label: string; value: string }) {
  return (
    <span
      className="surface-raised-tier"
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 7,
        padding: '6px 11px',
        borderRadius: 8,
        fontSize: 11,
      }}
    >
      <Icon size={13} strokeWidth={2} style={{ color: muted(0.45), flexShrink: 0 }} />
      <span style={{ color: muted(0.6) }}>{label}</span>
      <span className="font-data" style={{ color: 'var(--foreground)', fontWeight: 600 }}>
        {value}
      </span>
    </span>
  )
}

export function GovernancePanel() {
  const [budgets, setBudgets] = useState<Budget[]>([])
  const [budgetsOk, setBudgetsOk] = useState(true) // false when the budgets load failed → error/retry
  const budgetsLoadedRef = useRef(false) // keeps a poll failure from blanking a good load
  const [audit, setAudit] = useState<AuditRow[]>([])
  const [auditAgent, setAuditAgent] = useState('')
  const [auditType, setAuditType] = useState<AuditEventType | ''>('')
  const [auditSince, setAuditSince] = useState<number | null>(null)

  // New-budget form
  const [newScope, setNewScope] = useState<BudgetScope>('agent')
  const [newScopeId, setNewScopeId] = useState('')
  const [newLimit, setNewLimit] = useState('')
  // Default posture is track-and-warn (a hard cap is the explicit opt-in).
  const [newMode, setNewMode] = useState<BudgetMode>('warn')

  const refreshBudgets = useCallback(async () => {
    const r = await listBudgets()
    if (r.ok) {
      setBudgets(r.budgets)
      setBudgetsOk(true)
    } else if (!budgetsLoadedRef.current) {
      // Initial-load failure → error/retry. A transient poll failure after a
      // good load keeps the last good snapshot (no blank-to-error flicker).
      setBudgets([])
      setBudgetsOk(false)
    }
    budgetsLoadedRef.current = true
  }, [])

  const refreshAudit = useCallback(async () => {
    setAudit(
      await listAudit({
        agentId: auditAgent.trim() || undefined,
        eventType: auditType || undefined,
        since: auditSince ? Date.now() - auditSince : undefined,
        limit: 200,
      }),
    )
  }, [auditAgent, auditType, auditSince])

  useEffect(() => {
    void refreshBudgets()
    const id = setInterval(() => void refreshBudgets(), 5000)
    return () => clearInterval(id)
  }, [refreshBudgets])

  useEffect(() => {
    void refreshAudit()
  }, [refreshAudit])

  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        height: '100%',
        background: 'var(--background)',
      }}
    >
      <div
        style={{
          height: 44,
          flexShrink: 0,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          padding: '0 12px',
          borderBottom: '1px solid rgb(var(--foreground-rgb) / 0.06)',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <ShieldAlert size={15} style={{ color: 'var(--mint)' }} />
          <span
            style={{
              fontSize: 13,
              fontWeight: 600,
              fontFamily: 'var(--font-display)',
              letterSpacing: '-0.01em',
              color: 'var(--foreground)',
            }}
          >
            Governance
          </span>
          <span
            className="font-data"
            style={{
              fontSize: 11,
              color: 'var(--primary)',
              background: 'rgb(var(--primary-rgb) / 0.12)',
              borderRadius: 20,
              padding: '2px 8px',
            }}
          >
            {budgets.length} budgets
          </span>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <button
            type="button"
            onClick={() => {
              void refreshBudgets()
              void refreshAudit()
            }}
            aria-label="Refresh"
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: 6,
              height: 30,
              padding: '0 11px',
              borderRadius: 7,
              fontSize: 12,
              fontWeight: 500,
              color: muted(0.6),
              background: 'transparent',
              border: '1px solid rgb(var(--foreground-rgb) / 0.1)',
              cursor: 'pointer',
              transition:
                'background var(--motion-fast), border-color var(--motion-fast), color var(--motion-fast)',
            }}
            onMouseEnter={(e) => {
              e.currentTarget.style.background = muted(0.05)
              e.currentTarget.style.borderColor = muted(0.2)
              e.currentTarget.style.color = 'var(--foreground)'
            }}
            onMouseLeave={(e) => {
              e.currentTarget.style.background = 'transparent'
              e.currentTarget.style.borderColor = muted(0.1)
              e.currentTarget.style.color = muted(0.6)
            }}
          >
            <RefreshCw size={12} /> Refresh
          </button>
          <GitHubStarButton />
        </div>
      </div>

      <div data-testid="governance-panel" style={{ flex: 1, overflow: 'auto', padding: 16 }}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 24, maxWidth: 760 }}>
          {/* Budgets */}
          <section style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
            <SectionKicker>Budgets</SectionKicker>
            <div style={{ fontSize: 12, color: muted(0.5), lineHeight: 1.55 }}>
              Default posture is <strong>track-and-warn</strong>: nothing pauses your agents out of
              the box. A <strong>warn</strong> budget records spend and warns at 80% / 100% but
              never stops a run; a <strong>cap</strong> budget is the opt-in hard cap — the executor
              auto-pauses the moment a scope crosses 100%. From here you set a budget, raise a cap,
              or resume a paused scope.
            </div>
            {!budgetsOk ? (
              <div data-testid="governance-fetch-error">
                <FormattedAlert tone="error">
                  <span style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    Couldn&apos;t load budgets.
                    <button
                      type="button"
                      onClick={() => void refreshBudgets()}
                      style={{ textDecoration: 'underline', cursor: 'pointer', color: 'inherit' }}
                    >
                      Retry
                    </button>
                  </span>
                </FormattedAlert>
              </div>
            ) : budgets.length === 0 ? (
              <div
                className="surface-raised-tier"
                style={{ borderRadius: 10, padding: '8px 12px' }}
              >
                <EmptyState
                  icon={Wallet}
                  title="No budgets yet"
                  helper="Create one below to set a spend cap or a track-and-warn threshold."
                  paddingTop={20}
                  style={{ paddingBottom: 16 }}
                />
              </div>
            ) : (
              budgets.map((b, i) => (
                <motion.div
                  key={b.id}
                  initial={{ opacity: 0, y: 4 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{ ...ENTER_SPRING, delay: listDelay(i) }}
                >
                  <BudgetRow b={b} onChanged={() => void refreshBudgets()} />
                </motion.div>
              ))
            )}

            {/* Create budget */}
            <div
              className="surface-raised-tier"
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 7,
                flexWrap: 'wrap',
                borderRadius: 10,
                padding: '11px 13px',
              }}
            >
              <Select
                size="sm"
                aria-label="Budget scope"
                value={newScope}
                onChange={(v) => setNewScope(v as BudgetScope)}
                options={SCOPES.map((s) => ({ value: s, label: s }))}
              />
              <input
                value={newScopeId}
                onChange={(e) => setNewScopeId(e.target.value)}
                placeholder="scope id"
                className="font-data"
                style={{ ...inputStyle, width: 150 }}
              />
              <input
                value={newLimit}
                onChange={(e) => setNewLimit(e.target.value)}
                placeholder={newMode === 'warn' ? 'warn at $' : 'cap $'}
                inputMode="decimal"
                className="font-data"
                style={{ ...inputStyle, width: 90 }}
              />
              <Select
                size="sm"
                aria-label="Budget mode"
                data-testid="budget-mode-select"
                value={newMode}
                onChange={(v) => setNewMode(v as BudgetMode)}
                options={[
                  { value: 'warn', label: 'warn only' },
                  { value: 'cap', label: 'hard cap' },
                ]}
              />
              <CtaButton
                testId="budget-create"
                onClick={async () => {
                  const v = Number(newLimit)
                  if (!newScopeId.trim() || !Number.isFinite(v) || v < 0) return
                  await setBudget({
                    scope: newScope,
                    scopeId: newScopeId.trim(),
                    limitUsdCents: Math.round(v * 100),
                    mode: newMode,
                  })
                  setNewScopeId('')
                  setNewLimit('')
                  void refreshBudgets()
                }}
              >
                Set budget
              </CtaButton>
            </div>
          </section>

          {/* Caps (informational — enforced in code) */}
          <section style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
            <SectionKicker>Caps (enforced in code)</SectionKicker>
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
              {CAP_CHIPS.map((c) => (
                <CapChip key={c.label} Icon={c.Icon} label={c.label} value={c.value} />
              ))}
            </div>
            <div style={{ fontSize: 12, color: muted(0.45), lineHeight: 1.55 }}>
              Depth + fan-out + per-node cost caps are enforced in the orchestrator / executor; a
              cap hit is logged to the audit below.
            </div>
          </section>

          {/* Approval queue (shared with the Approvals panel) */}
          <section style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
            <SectionKicker>Approval queue</SectionKicker>
            <div className="surface-raised-tier" style={{ borderRadius: 10, padding: '8px 12px' }}>
              <ToolApprovalQueue showEmpty />
            </div>
          </section>

          {/* Audit log */}
          <section style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
            <SectionKicker>Audit log</SectionKicker>
            <div style={{ display: 'flex', gap: 7, flexWrap: 'wrap', alignItems: 'center' }}>
              <input
                value={auditAgent}
                onChange={(e) => setAuditAgent(e.target.value)}
                placeholder="agent id"
                className="font-data"
                style={{ ...inputStyle, width: 140 }}
              />
              <Select
                size="sm"
                aria-label="Event type"
                value={auditType}
                onChange={(v) => setAuditType(v as AuditEventType | '')}
              >
                <option value="">all events</option>
                {EVENT_TYPES.map((t) => (
                  <option key={t} value={t}>
                    {t}
                  </option>
                ))}
              </Select>
              <div style={{ display: 'flex', gap: 4 }}>
                {SINCE_WINDOWS.map((w) => {
                  const active = auditSince === w.ms
                  return (
                    <button
                      key={w.label}
                      type="button"
                      onClick={() => setAuditSince(w.ms)}
                      className="font-data"
                      style={{
                        height: 30,
                        fontSize: 11,
                        padding: '0 11px',
                        borderRadius: 20,
                        border: `1px solid ${active ? 'rgb(var(--mint-rgb) / 0.4)' : muted(0.12)}`,
                        background: active ? 'rgb(var(--mint-rgb) / 0.12)' : 'transparent',
                        color: active ? 'var(--mint)' : muted(0.55),
                        cursor: 'pointer',
                        transition:
                          'background var(--motion-fast), border-color var(--motion-fast), color var(--motion-fast)',
                      }}
                      onMouseEnter={(e) => {
                        if (active) return
                        e.currentTarget.style.background = muted(0.05)
                        e.currentTarget.style.color = 'var(--foreground)'
                      }}
                      onMouseLeave={(e) => {
                        if (active) return
                        e.currentTarget.style.background = 'transparent'
                        e.currentTarget.style.color = muted(0.55)
                      }}
                    >
                      {w.label}
                    </button>
                  )
                })}
              </div>
            </div>

            <div
              data-testid="governance-audit"
              className="surface-raised-tier"
              style={{
                display: 'flex',
                flexDirection: 'column',
                gap: 4,
                borderRadius: 10,
                padding: audit.length === 0 ? '8px 12px' : 8,
              }}
            >
              {audit.length === 0 ? (
                <EmptyState
                  icon={ScrollText}
                  title="No audit events"
                  helper="Nothing matches this filter yet. Forensic events land here as agents run."
                  paddingTop={20}
                  style={{ paddingBottom: 16 }}
                />
              ) : (
                audit.map((a, i) => (
                  <motion.div
                    key={a.id}
                    data-testid="audit-row"
                    initial={{ opacity: 0, y: 4 }}
                    animate={{ opacity: 1, y: 0 }}
                    transition={{ ...ENTER_SPRING, delay: listDelay(i) }}
                    style={{
                      display: 'flex',
                      gap: 8,
                      alignItems: 'baseline',
                      fontSize: 11,
                      padding: '6px 8px',
                      borderRadius: 7,
                      background: muted(0.03),
                    }}
                  >
                    <span
                      className="font-data"
                      style={{
                        color: muted(0.4),
                        whiteSpace: 'nowrap',
                      }}
                    >
                      {new Date(a.createdAt).toLocaleTimeString()}
                    </span>
                    <span
                      className="font-data"
                      style={{
                        fontSize: 9,
                        fontWeight: 700,
                        textTransform: 'uppercase',
                        letterSpacing: '0.04em',
                        padding: '1px 6px',
                        borderRadius: 4,
                        color: muted(0.7),
                        background: muted(0.07),
                        whiteSpace: 'nowrap',
                      }}
                    >
                      {a.eventType}
                    </span>
                    {a.agentId && (
                      <span
                        className="font-data"
                        style={{
                          color: muted(0.5),
                          whiteSpace: 'nowrap',
                        }}
                      >
                        {a.agentId.slice(0, 10)}
                      </span>
                    )}
                    <span
                      style={{
                        color: muted(0.6),
                        overflow: 'hidden',
                        textOverflow: 'ellipsis',
                        whiteSpace: 'nowrap',
                      }}
                    >
                      {summarize(a.summary)}
                    </span>
                    {a.tenantId && (
                      <span className="font-data" style={{ color: muted(0.35) }}>
                        · {a.tenantId}
                      </span>
                    )}
                  </motion.div>
                ))
              )}
            </div>
          </section>
        </div>
      </div>
    </div>
  )
}
