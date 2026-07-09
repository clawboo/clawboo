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
import { Button } from '@/features/shared/Button'
import { Chip } from '@/features/shared/Chip'
import { EmptyState } from '@/features/shared/EmptyState'
import { FormattedAlert } from '@/features/shared/FormattedAlert'
import { PanelHeader } from '@/features/shared/PanelHeader'
import { SegmentedControl } from '@/features/shared/SegmentedControl'
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

// Per-audit-event-type tone. Security/enforcement events carry warning/error
// accents so the log scans; routine events stay neutral.
const AUDIT_TONE: Record<AuditEventType, StatusTone> = {
  install: 'idle',
  approval: 'idle',
  tool_call: 'idle',
  budget: 'warning',
  cap_hit: 'warning',
  verification: 'success',
  circuit_break: 'error',
}

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

const SECTION_LABEL = 'font-mono text-[11px] font-semibold uppercase tracking-[0.14em]'

function SectionKicker({ children }: { children: ReactNode }) {
  return (
    <div className={`${SECTION_LABEL} text-foreground/45`}>{children}</div>
  )
}

// Card shell — the shared premium surface (rounded-2xl, hairline border, raised
// shadow) used for every governance card.
const cardStyle: React.CSSProperties = { boxShadow: 'var(--shadow-raised)' }

const inputClass =
  'rounded-xl border border-border bg-surface px-3 py-2 text-[13px] text-foreground outline-none transition focus:border-primary focus:ring-4 focus:ring-primary/15 placeholder:text-foreground/30'

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
      className="flex flex-col gap-3 rounded-2xl border border-border bg-surface p-4"
      style={cardStyle}
    >
      <div className="flex items-center justify-between gap-2">
        <span className="flex min-w-0 items-center gap-2">
          <span className="font-data rounded-full bg-foreground/[0.06] px-2 py-0.5 text-[10px] font-bold uppercase tracking-[0.04em] text-foreground/60">
            {b.scope}
          </span>
          <span
            className="font-data truncate text-[13px] text-foreground"
            title={b.scopeId}
          >
            {b.scopeId}
          </span>
          {b.tenantId && (
            <span className="font-data text-[11px] text-foreground/40">
              · tenant {b.tenantId}
            </span>
          )}
        </span>
        <span className="flex items-center gap-1.5">
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

      <div className="flex items-baseline justify-between">
        <span className="font-data text-[14px] font-semibold text-foreground">
          {dollars(b.spentUsdCents)}{' '}
          <span className="text-[12px] font-normal text-foreground/45">
            / {dollars(b.limitUsdCents)}
          </span>
        </span>
        <span className="font-data text-[12px] text-foreground/50">
          {pct.toFixed(0)}%
        </span>
      </div>
      <div
        className="overflow-hidden rounded-full bg-foreground/[0.08]"
        style={{ height: 6 }}
      >
        <div style={{ width: `${pct}%`, height: '100%', background: STATUS_TONE[b.status] }} />
      </div>

      <div className="flex items-center gap-2">
        <input
          value={capInput}
          onChange={(e) => setCapInput(e.target.value)}
          placeholder="new cap $"
          inputMode="decimal"
          className={`font-data ${inputClass}`}
          style={{ width: 108 }}
        />
        <Button
          variant="secondary"
          size="sm"
          onClick={() => {
            void (async () => {
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
            })()
          }}
        >
          Set cap
        </Button>
        {b.status === 'paused' && (
          <Button
            variant="primary"
            size="sm"
            data-testid="budget-resume"
            onClick={() => {
              void (async () => {
                const { willRepause } = await resumeBudget(b.scope, b.scopeId)
                if (willRepause) {
                  addToast({
                    type: 'error',
                    message:
                      'Resumed, but spend is still at/over the cap — raise the cap to make progress.',
                  })
                }
                onChanged()
              })()
            }}
          >
            Resume
          </Button>
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
      className="inline-flex items-center gap-2 rounded-xl border border-border bg-surface px-3 py-2 text-[12px]"
      style={cardStyle}
    >
      <Icon size={14} strokeWidth={2} className="text-foreground/45" style={{ flexShrink: 0 }} />
      <span className="text-foreground/60">{label}</span>
      <span className="font-data font-semibold text-foreground">{value}</span>
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
    <div className="flex h-full flex-col bg-background">
      <PanelHeader
        title="Governance"
        subtitle="Budgets, enforced caps, approvals, and the forensic audit log."
        icon={ShieldAlert}
        size="md"
        border
        actions={
          <>
            <span className="font-data rounded-full bg-foreground/[0.06] px-2.5 py-0.5 text-[11px] font-semibold text-foreground/55">
              {budgets.length} budgets
            </span>
            <Button
              variant="secondary"
              size="sm"
              onClick={() => {
                void refreshBudgets()
                void refreshAudit()
              }}
            >
              <RefreshCw size={14} strokeWidth={2} /> Refresh
            </Button>
            <GitHubStarButton />
          </>
        }
      />

      <div data-testid="governance-panel" className="flex-1 overflow-auto px-6 py-5">
        <div className="flex max-w-[760px] flex-col gap-8">
          {/* Budgets */}
          <section className="flex flex-col gap-3">
            <SectionKicker>Budgets</SectionKicker>
            <div className="text-[13px] leading-relaxed text-foreground/55">
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
                    <Button variant="ghost" size="sm" onClick={() => void refreshBudgets()}>
                      Retry
                    </Button>
                  </span>
                </FormattedAlert>
              </div>
            ) : budgets.length === 0 ? (
              <div
                className="rounded-2xl border border-border bg-surface"
                style={cardStyle}
              >
                <EmptyState
                  icon={Wallet}
                  title="No budgets yet"
                  helper="Create one below to set a spend cap or a track-and-warn threshold."
                  paddingTop={24}
                  style={{ paddingBottom: 20 }}
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
              className="flex flex-wrap items-center gap-2 rounded-2xl border border-border bg-surface p-4"
              style={cardStyle}
            >
              <Select
                size="md"
                aria-label="Budget scope"
                value={newScope}
                onChange={(v) => setNewScope(v as BudgetScope)}
                options={SCOPES.map((s) => ({ value: s, label: s }))}
              />
              <input
                value={newScopeId}
                onChange={(e) => setNewScopeId(e.target.value)}
                placeholder="scope id"
                className={`font-data ${inputClass}`}
                style={{ width: 160 }}
              />
              <input
                value={newLimit}
                onChange={(e) => setNewLimit(e.target.value)}
                placeholder={newMode === 'warn' ? 'warn at $' : 'cap $'}
                inputMode="decimal"
                className={`font-data ${inputClass}`}
                style={{ width: 96 }}
              />
              <div data-testid="budget-mode-select">
                <SegmentedControl
                  size="sm"
                  aria-label="Budget mode"
                  options={[
                    { id: 'warn', label: 'warn only' },
                    { id: 'cap', label: 'hard cap' },
                  ]}
                  value={newMode}
                  onChange={(v) => setNewMode(v as BudgetMode)}
                />
              </div>
              <Button
                variant="primary"
                size="md"
                data-testid="budget-create"
                onClick={() => {
                  void (async () => {
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
                  })()
                }}
              >
                Set budget
              </Button>
            </div>
          </section>

          {/* Caps (informational — enforced in code) */}
          <section className="flex flex-col gap-3">
            <SectionKicker>Caps (enforced in code)</SectionKicker>
            <div className="flex flex-wrap gap-2">
              {CAP_CHIPS.map((c) => (
                <CapChip key={c.label} Icon={c.Icon} label={c.label} value={c.value} />
              ))}
            </div>
            <div className="text-[13px] leading-relaxed text-foreground/45">
              Depth + fan-out + per-node cost caps are enforced in the orchestrator / executor; a
              cap hit is logged to the audit below.
            </div>
          </section>

          {/* Approval queue (shared with the Approvals panel) */}
          <section className="flex flex-col gap-3">
            <SectionKicker>Approval queue</SectionKicker>
            <div
              className="rounded-2xl border border-border bg-surface p-2"
              style={cardStyle}
            >
              <ToolApprovalQueue showEmpty />
            </div>
          </section>

          {/* Audit log */}
          <section className="flex flex-col gap-3">
            <SectionKicker>Audit log</SectionKicker>
            <div className="flex flex-wrap items-center gap-2">
              <input
                value={auditAgent}
                onChange={(e) => setAuditAgent(e.target.value)}
                placeholder="agent id"
                className={`font-data ${inputClass}`}
                style={{ width: 150 }}
              />
              <Select
                size="md"
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
              <div className="flex gap-1.5">
                {SINCE_WINDOWS.map((w) => (
                  <Chip
                    key={w.label}
                    size="sm"
                    active={auditSince === w.ms}
                    accent="var(--mint)"
                    onClick={() => setAuditSince(w.ms)}
                    className="font-data"
                  >
                    {w.label}
                  </Chip>
                ))}
              </div>
            </div>

            <div
              data-testid="governance-audit"
              className="flex flex-col gap-1 rounded-2xl border border-border bg-surface p-2"
              style={cardStyle}
            >
              {audit.length === 0 ? (
                <EmptyState
                  icon={ScrollText}
                  title="No audit events"
                  helper="Nothing matches this filter yet. Forensic events land here as agents run."
                  paddingTop={24}
                  style={{ paddingBottom: 20 }}
                />
              ) : (
                audit.map((a, i) => (
                  <motion.div
                    key={a.id}
                    data-testid="audit-row"
                    initial={{ opacity: 0, y: 4 }}
                    animate={{ opacity: 1, y: 0 }}
                    transition={{ ...ENTER_SPRING, delay: listDelay(i) }}
                    className="flex items-baseline gap-2 rounded-lg px-2 py-1.5 text-[12px] transition-colors hover:bg-foreground/[0.03]"
                  >
                    <span className="font-data whitespace-nowrap text-foreground/40">
                      {new Date(a.createdAt).toLocaleTimeString()}
                    </span>
                    <StatusPill tone={AUDIT_TONE[a.eventType]} label={a.eventType} />
                    {a.agentId && (
                      <span className="font-data whitespace-nowrap text-foreground/50">
                        {a.agentId.slice(0, 10)}
                      </span>
                    )}
                    <span className="truncate text-foreground/60">
                      {summarize(a.summary)}
                    </span>
                    {a.tenantId && (
                      <span className="font-data whitespace-nowrap text-foreground/35">
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
