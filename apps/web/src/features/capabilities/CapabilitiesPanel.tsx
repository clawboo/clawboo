// The Capabilities dashboard — the human-facing surface over the unified
// capability inventory (GET /api/capabilities, the SAME stream the Ghost Graph
// reads). Groups every runtime's skills / tools / connectors and renders a
// manageability-gated action set that is a PURE FUNCTION of the tier: the UI can
// never offer an action the owning runtime forbids. The tool-approval
// handshake surfaces inline via the reused ToolApprovalQueue.

import { useCallback, useEffect, useMemo, useState } from 'react'

import { motion } from 'framer-motion'
import { Ban, EyeOff, Lock, Plug, Power, Puzzle, RefreshCw, Wrench } from 'lucide-react'
import type { LucideIcon } from 'lucide-react'

import { ToolApprovalQueue } from '@/features/approvals/ToolApprovalQueue'
import { GitHubStarButton } from '@/features/promo/GitHubStarButton'
import { EmptyState } from '@/features/shared/EmptyState'
import { FormattedAlert } from '@/features/shared/FormattedAlert'
import { Skeleton } from '@/features/shared/Skeleton'
import { Spinner } from '@/features/shared/Spinner'
import { StatusPill, type StatusTone } from '@/features/shared/StatusPill'
import { ENTER_SPRING, listDelay } from '@/lib/motion'
import {
  disableCapability,
  enableCapability,
  fetchCapabilities,
  type CapabilityRecord,
  type SourceReadStatus,
} from '@/lib/capabilitiesClient'
import { useCapabilityFilterStore } from '@/stores/capabilityFilter'
import { useToastStore } from '@/stores/toast'

const muted = (o: number) => `rgb(var(--foreground-rgb) / ${o})`

const RUNTIME_ORDER = ['clawboo-native', 'openclaw', 'claude-code', 'codex', 'hermes', 'human']
const RUNTIME_LABEL: Record<string, string> = {
  'clawboo-native': 'clawboo Native',
  openclaw: 'OpenClaw',
  'claude-code': 'Claude Code',
  codex: 'Codex',
  hermes: 'Hermes',
  human: 'Human',
}
const KIND_ICON: Record<CapabilityRecord['kind'], LucideIcon> = {
  skill: Puzzle,
  tool: Wrench,
  connector: Plug,
}
const KIND_ORDER: CapabilityRecord['kind'][] = ['skill', 'tool', 'connector']

const KICKER =
  'mb-2 font-mono text-[11px] font-semibold uppercase tracking-wider flex items-center gap-2'

// ── The action set is a PURE FUNCTION of the manageability tier ──────────────
interface RowAction {
  label: string
  action: 'enable' | 'disable'
  disabled?: boolean
  hint?: string
}

function actionsFor(rec: CapabilityRecord): RowAction[] {
  // observe-only → no action ("built-in, managed by <runtime>").
  if (rec.manageability === 'observe-only') return []
  // An UNAVAILABLE (greyed, "Unavailable"-pilled) capability — its availability
  // requirement is unmet — offers no actionable Enable/Disable; the action set
  // must read consistently with the greyed presentation (no live button on a
  // row the user can see is unusable).
  if (!rec.available) return []
  // A row the owning source can't actually write (an OpenClaw runtime-of-record
  // connector/plugin whose config.patch is a follow-up) renders NO button — the
  // action set must never offer what the tier forbids (no dead Enable/Disable).
  if (rec.writable === false) return []
  // external-write, auth-blocked → a disabled action carrying the source's hint.
  if (rec.status === 'manageable-but-pending-auth') {
    return [{ label: 'Enable', action: 'enable', disabled: true, hint: rec.hint ?? 'pending auth' }]
  }
  // managed / external-write / runtime-of-record → toggle by current status.
  // NOTE the dashboard's per-row set is intentionally Enable/Disable only: Install
  // lives in the Marketplace and Approve flows through the embedded ToolApprovalQueue
  // below — the managed action set is satisfied across those surfaces, not duplicated here.
  return rec.status === 'disabled'
    ? [{ label: 'Enable', action: 'enable' }]
    : [{ label: 'Disable', action: 'disable' }]
}

// Status → StatusPill tone (the canonical primitive). ready/available → success,
// pending-auth → warning, unavailable/disabled → idle.
function pillFor(rec: CapabilityRecord): { tone: StatusTone; label: string } {
  if (!rec.available) return { tone: 'idle', label: 'Unavailable' }
  if (rec.status === 'manageable-but-pending-auth')
    return { tone: 'warning', label: 'Pending auth' }
  if (rec.status === 'disabled') return { tone: 'idle', label: 'Disabled' }
  return { tone: 'success', label: 'Ready' }
}

function Row({
  rec,
  busy,
  onAction,
}: {
  rec: CapabilityRecord
  busy: boolean
  onAction: (rec: CapabilityRecord, action: 'enable' | 'disable') => void
}) {
  const KindIcon = KIND_ICON[rec.kind]
  const actions = actionsFor(rec)
  const pill = pillFor(rec)
  return (
    <div
      data-testid="capability-row"
      className="surface-raised-tier"
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 10,
        // 4px grid: 8px 12px → ~40px row height (meets the touch-target floor).
        padding: '8px 12px',
        borderRadius: 8,
        opacity: rec.available ? 1 : 0.55,
        filter: rec.available ? undefined : 'grayscale(1)',
      }}
    >
      <KindIcon size={14} style={{ color: muted(0.45), flexShrink: 0 }} />
      <div style={{ flex: 1, minWidth: 0 }}>
        <div
          style={{
            fontSize: 12.5,
            fontWeight: 600,
            color: 'var(--foreground)',
            whiteSpace: 'nowrap',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
          }}
        >
          {rec.name}
        </div>
        {rec.description && (
          <div
            style={{
              fontSize: 11,
              color: muted(0.5),
              whiteSpace: 'nowrap',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
            }}
          >
            {rec.description}
          </div>
        )}
      </div>
      <StatusPill tone={pill.tone} label={pill.label} />
      {actions.length === 0 ? (
        <span
          data-testid="capability-observe-only"
          title={`Managed by ${RUNTIME_LABEL[rec.runtime] ?? rec.runtime}`}
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 4,
            fontSize: 11,
            color: muted(0.4),
            flexShrink: 0,
          }}
        >
          {rec.source === 'runtime-builtin' ? <Lock size={11} /> : <EyeOff size={11} />}
          built-in, managed by {RUNTIME_LABEL[rec.runtime] ?? rec.runtime}
        </span>
      ) : (
        actions.map((a) => {
          const isEnable = a.action === 'enable'
          const disabled = a.disabled || busy
          const ActionIcon = isEnable ? Power : Ban
          // Enable → mint accent (affirmative). Disable → NEUTRAL (a non-confirm
          // action must not wear success-green). Pending-auth Enable stays
          // neutral/disabled with the `codex login` hint.
          const affirmative = isEnable && !a.disabled
          return (
            <button
              key={a.action}
              type="button"
              data-testid="capability-action"
              title={a.hint}
              disabled={disabled}
              onClick={() => onAction(rec, a.action)}
              className="capability-action-btn"
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 5,
                fontSize: 11.5,
                fontWeight: 600,
                height: 30,
                padding: '0 11px',
                borderRadius: 7,
                border: `1px solid ${affirmative ? 'rgb(var(--mint-rgb) / 0.3)' : muted(0.12)}`,
                background: affirmative ? 'rgb(var(--mint-rgb) / 0.1)' : muted(0.05),
                color: affirmative ? 'var(--mint)' : muted(0.7),
                cursor: disabled ? 'not-allowed' : 'pointer',
                opacity: disabled ? 0.45 : 1,
                flexShrink: 0,
                transition:
                  'background var(--motion-fast), border-color var(--motion-fast), color var(--motion-fast)',
              }}
              onMouseEnter={(e) => {
                if (disabled) return
                if (affirmative) {
                  e.currentTarget.style.background = 'rgb(var(--mint-rgb) / 0.18)'
                  e.currentTarget.style.borderColor = 'rgb(var(--mint-rgb) / 0.45)'
                } else {
                  e.currentTarget.style.background = muted(0.1)
                  e.currentTarget.style.borderColor = muted(0.2)
                  e.currentTarget.style.color = 'var(--foreground)'
                }
              }}
              onMouseLeave={(e) => {
                if (affirmative) {
                  e.currentTarget.style.background = 'rgb(var(--mint-rgb) / 0.1)'
                  e.currentTarget.style.borderColor = 'rgb(var(--mint-rgb) / 0.3)'
                } else {
                  e.currentTarget.style.background = muted(0.05)
                  e.currentTarget.style.borderColor = muted(0.12)
                  e.currentTarget.style.color = muted(0.7)
                }
              }}
            >
              {busy ? <Spinner size={11} /> : <ActionIcon size={12} />} {a.label}
              {a.hint && a.disabled ? (
                <span style={{ color: muted(0.45), fontWeight: 400 }}> · {a.hint}</span>
              ) : null}
            </button>
          )
        })
      )}
    </div>
  )
}

function FilterPill({
  label,
  active,
  onClick,
  testid,
}: {
  label: string
  active: boolean
  onClick: () => void
  testid?: string
}) {
  return (
    <button
      type="button"
      data-testid={testid}
      onClick={onClick}
      className="rounded-full px-3 py-1 text-[11px] font-semibold transition-colors"
      style={{
        color: active ? 'var(--mint)' : muted(0.6),
        background: active ? 'rgb(var(--mint-rgb) / 0.12)' : muted(0.05),
        border: 'none',
        cursor: 'pointer',
      }}
      onMouseEnter={(e) => {
        if (active) return
        e.currentTarget.style.background = muted(0.1)
        e.currentTarget.style.color = muted(0.85)
      }}
      onMouseLeave={(e) => {
        if (active) return
        e.currentTarget.style.background = muted(0.05)
        e.currentTarget.style.color = muted(0.6)
      }}
    >
      {label}
    </button>
  )
}

// Skeleton row shaped like a real capability row, for the loading state.
function SkeletonRow() {
  return (
    <div
      className="surface-raised-tier"
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 10,
        padding: '8px 12px',
        borderRadius: 8,
      }}
    >
      <Skeleton width={14} height={14} radius={4} />
      <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 5 }}>
        <Skeleton width="40%" height={11} />
        <Skeleton width="62%" height={9} />
      </div>
      <Skeleton width={64} height={18} radius={999} />
      <Skeleton width={84} height={30} radius={7} />
    </div>
  )
}

export function CapabilitiesPanel() {
  const [records, setRecords] = useState<CapabilityRecord[]>([])
  const [sources, setSources] = useState<SourceReadStatus[]>([])
  const [loading, setLoading] = useState(true)
  // false when the LAST /api/capabilities fetch failed entirely — so a total
  // failure (which yields zero records + zero sources) reads as an error, not as
  // a genuinely empty inventory ("No capabilities found").
  const [fetchOk, setFetchOk] = useState(true)
  const [busyId, setBusyId] = useState<string | null>(null)
  // null = all runtimes. The diagnostics drawer's "View capabilities" deep-link
  // hands a runtime through useCapabilityFilterStore; we consume it on mount.
  const [runtimeFilter, setRuntimeFilter] = useState<string | null>(null)
  const addToast = useToastStore((s) => s.addToast)

  const refresh = useCallback(async () => {
    const view = await fetchCapabilities()
    setRecords(view.records)
    setSources(view.sources)
    setFetchOk(view.ok)
    setLoading(false)
  }, [])

  useEffect(() => {
    void refresh()
    const pending = useCapabilityFilterStore.getState().consumePendingRuntime()
    if (pending) setRuntimeFilter(pending)
  }, [refresh])

  const onAction = useCallback(
    async (rec: CapabilityRecord, action: 'enable' | 'disable') => {
      setBusyId(rec.id)
      const result =
        action === 'enable' ? await enableCapability(rec.id) : await disableCapability(rec.id)
      setBusyId(null)
      if (result.ok) {
        void refresh()
        return
      }
      // Surface the typed rejection (e.g. a 403 observe-only / 422) instead of a
      // silent no-op; do NOT refresh (nothing changed).
      const detail = result.manageability ? ` (${result.manageability})` : ''
      addToast({
        message: `Could not ${action} ${rec.name}: ${result.error ?? 'unknown error'}${detail}`,
        type: 'error',
      })
    },
    [refresh, addToast],
  )

  // Group by runtime (ordered), then sort each group by kind.
  const groups = useMemo(() => {
    const byRuntime = new Map<string, CapabilityRecord[]>()
    for (const r of records) {
      const arr = byRuntime.get(r.runtime) ?? []
      arr.push(r)
      byRuntime.set(r.runtime, arr)
    }
    const ordered = [...byRuntime.keys()].sort(
      (a, b) => (RUNTIME_ORDER.indexOf(a) + 1 || 99) - (RUNTIME_ORDER.indexOf(b) + 1 || 99),
    )
    return ordered.map((runtime) => ({
      runtime,
      records: (byRuntime.get(runtime) ?? []).sort(
        (a, b) =>
          KIND_ORDER.indexOf(a.kind) - KIND_ORDER.indexOf(b.kind) || a.name.localeCompare(b.name),
      ),
    }))
  }, [records])

  const degraded = sources.filter((s) => !s.ok)
  const visibleGroups = runtimeFilter ? groups.filter((g) => g.runtime === runtimeFilter) : groups

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
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
          <Puzzle size={15} style={{ color: 'var(--mint)' }} />
          <span
            style={{
              fontSize: 13,
              fontWeight: 600,
              fontFamily: 'var(--font-display)',
              letterSpacing: '-0.01em',
              color: 'var(--foreground)',
            }}
          >
            Capabilities
          </span>
          <span
            className="font-data"
            style={{
              fontSize: 10,
              color: 'var(--primary)',
              background: 'rgb(var(--primary-rgb) / 0.12)',
              borderRadius: 20,
              padding: '2px 8px',
            }}
          >
            {records.length} capabilities · {groups.length} runtimes
          </span>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <button
            type="button"
            onClick={() => void refresh()}
            aria-label="Refresh"
            className="capability-refresh-btn"
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: 6,
              height: 30,
              padding: '0 11px',
              borderRadius: 7,
              background: 'transparent',
              border: `1px solid ${muted(0.1)}`,
              color: muted(0.6),
              fontSize: 12,
              fontWeight: 500,
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

      <div data-testid="capabilities-panel" style={{ flex: 1, overflow: 'auto', padding: 16 }}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 18, maxWidth: 820 }}>
          <ToolApprovalQueue />

          {groups.length > 1 && (
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
              <FilterPill
                label="All runtimes"
                active={runtimeFilter === null}
                onClick={() => setRuntimeFilter(null)}
              />
              {groups.map((g) => (
                <FilterPill
                  key={g.runtime}
                  testid={`capability-filter-${g.runtime}`}
                  label={RUNTIME_LABEL[g.runtime] ?? g.runtime}
                  active={runtimeFilter === g.runtime}
                  onClick={() => setRuntimeFilter(g.runtime)}
                />
              ))}
            </div>
          )}

          {degraded.length > 0 && (
            <FormattedAlert tone="warning">
              <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
                {degraded.map((s) => (
                  <div key={s.sourceId}>
                    <span className="font-data" style={{ fontWeight: 600 }}>
                      {s.sourceId}
                    </span>{' '}
                    unavailable ({s.reason ?? 'degraded'}) — showing last-known capabilities
                  </div>
                ))}
              </div>
            </FormattedAlert>
          )}

          {loading ? (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              {Array.from({ length: 5 }).map((_, i) => (
                <SkeletonRow key={i} />
              ))}
            </div>
          ) : !fetchOk ? (
            // The fetch FAILED — show an error + retry, distinct from a genuinely
            // empty inventory (which a total failure would otherwise masquerade as).
            <div data-testid="capabilities-fetch-error">
              <FormattedAlert tone="error">
                <span style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  Couldn’t load the capability inventory.
                  <button
                    type="button"
                    onClick={() => void refresh()}
                    style={{ textDecoration: 'underline', cursor: 'pointer', color: 'inherit' }}
                  >
                    Retry
                  </button>
                </span>
              </FormattedAlert>
            </div>
          ) : visibleGroups.length === 0 ? (
            <EmptyState
              icon={Puzzle}
              title="No capabilities found"
              helper="Connect a runtime or install a skill to populate the inventory."
            />
          ) : (
            visibleGroups.map((g) => (
              <div
                key={g.runtime}
                data-testid={`capability-group-${g.runtime}`}
                style={{ display: 'flex', flexDirection: 'column', gap: 6 }}
              >
                <div className={KICKER} style={{ color: muted(0.55) }}>
                  {RUNTIME_LABEL[g.runtime] ?? g.runtime}
                  <span className="font-data" style={{ color: muted(0.35), fontWeight: 400 }}>
                    ({g.records.length})
                  </span>
                </div>
                {g.records.map((rec, i) => (
                  <motion.div
                    key={rec.id}
                    initial={{ opacity: 0, y: 4 }}
                    animate={{ opacity: 1, y: 0 }}
                    transition={{ ...ENTER_SPRING, delay: listDelay(i) }}
                  >
                    <Row rec={rec} busy={busyId === rec.id} onAction={onAction} />
                  </motion.div>
                ))}
              </div>
            ))
          )}
        </div>
      </div>
    </div>
  )
}
