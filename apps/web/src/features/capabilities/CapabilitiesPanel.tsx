// The Capabilities dashboard — the human-facing surface over the unified
// capability inventory (GET /api/capabilities, the SAME stream the Ghost Graph
// reads). Groups every runtime's skills / tools / connectors and renders a
// manageability-gated action set that is a PURE FUNCTION of the tier: the UI can
// never offer an action the owning runtime forbids. The tool-approval
// handshake surfaces inline via the reused ToolApprovalQueue.

import { useCallback, useEffect, useMemo, useState } from 'react'

import { motion } from 'framer-motion'
import { EyeOff, Lock, Plug, Puzzle, RefreshCw, Wrench } from 'lucide-react'
import type { LucideIcon } from 'lucide-react'

import { ToolApprovalQueue } from '@/features/approvals/ToolApprovalQueue'
import { GitHubStarButton } from '@/features/promo/GitHubStarButton'
import { Button } from '@/features/shared/Button'
import { EmptyState } from '@/features/shared/EmptyState'
import { FormattedAlert } from '@/features/shared/FormattedAlert'
import { PanelHeader } from '@/features/shared/PanelHeader'
import { Skeleton } from '@/features/shared/Skeleton'
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

const SECTION_LABEL =
  'flex items-center gap-2 font-mono text-[11px] font-semibold uppercase tracking-[0.14em]'

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
      className="flex items-center gap-3 rounded-xl border border-border bg-surface px-3.5 py-2.5 transition-colors"
      style={{
        boxShadow: 'var(--shadow-raised)',
        opacity: rec.available ? 1 : 0.55,
        filter: rec.available ? undefined : 'grayscale(1)',
      }}
    >
      <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-foreground/[0.05]">
        <KindIcon size={15} strokeWidth={2} className="text-foreground/50" />
      </span>
      <div className="min-w-0 flex-1">
        <div className="truncate text-[13px] font-semibold text-foreground">{rec.name}</div>
        {rec.description && (
          <div className="truncate text-[12px] text-foreground/50">{rec.description}</div>
        )}
      </div>
      <StatusPill tone={pill.tone} label={pill.label} />
      {actions.length === 0 ? (
        <span
          data-testid="capability-observe-only"
          title={`Managed by ${RUNTIME_LABEL[rec.runtime] ?? rec.runtime}`}
          className="flex shrink-0 items-center gap-1.5 text-[11px] text-foreground/40"
        >
          {rec.source === 'runtime-builtin' ? <Lock size={12} /> : <EyeOff size={12} />}
          built-in, managed by {RUNTIME_LABEL[rec.runtime] ?? rec.runtime}
        </span>
      ) : (
        actions.map((a) => {
          // Enable → primary (affirmative). Disable → secondary (a non-confirm
          // action must not wear the brand CTA). Pending-auth Enable stays a
          // disabled secondary carrying the `codex login` hint.
          const affirmative = a.action === 'enable' && !a.disabled
          return (
            <Button
              key={a.action}
              variant={affirmative ? 'primary' : 'secondary'}
              size="sm"
              data-testid="capability-action"
              title={a.hint}
              disabled={a.disabled || busy}
              loading={busy}
              onClick={() => onAction(rec, a.action)}
            >
              {a.label}
              {a.hint && a.disabled ? (
                <span className="font-normal text-foreground/45">
                  {' '}
                  · {a.hint}
                </span>
              ) : null}
            </Button>
          )
        })
      )}
    </div>
  )
}

// Runtime filter pill. A styled button matching the shared Chip aesthetic, but
// carrying the `capability-filter-<runtime>` testid on the CLICKABLE element so
// tests target it directly.
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
      aria-pressed={active}
      className={[
        'inline-flex h-7 cursor-pointer items-center rounded-full border px-3 text-[12.5px] font-medium transition-all duration-150',
        active
          ? ''
          : 'border-border text-foreground/65 hover:border-border-strong hover:text-foreground',
      ].join(' ')}
      style={
        active
          ? {
              borderColor: 'var(--mint)',
              color: 'var(--mint)',
              background: 'color-mix(in srgb, var(--mint) 8%, transparent)',
            }
          : undefined
      }
    >
      {label}
    </button>
  )
}

// Skeleton row shaped like a real capability row, for the loading state.
function SkeletonRow() {
  return (
    <div
      className="flex items-center gap-3 rounded-xl border border-border bg-surface px-3.5 py-2.5"
      style={{ boxShadow: 'var(--shadow-raised)' }}
    >
      <Skeleton width={32} height={32} radius={8} />
      <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 5 }}>
        <Skeleton width="40%" height={11} />
        <Skeleton width="62%" height={9} />
      </div>
      <Skeleton width={64} height={18} radius={999} />
      <Skeleton width={38} height={22} radius={999} />
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
    <div className="flex h-full flex-col bg-background">
      <PanelHeader
        title="Capabilities"
        subtitle="Every runtime's skills, tools, and connectors — one inventory."
        icon={Puzzle}
        size="md"
        border
        actions={
          <>
            <span className="font-data rounded-full bg-foreground/[0.06] px-2.5 py-0.5 text-[11px] font-semibold text-foreground/55">
              {records.length} capabilities · {groups.length} runtimes
            </span>
            <Button variant="secondary" size="sm" onClick={() => void refresh()}>
              <RefreshCw size={14} strokeWidth={2} /> Refresh
            </Button>
            <GitHubStarButton />
          </>
        }
      />

      <div data-testid="capabilities-panel" className="flex-1 overflow-auto px-6 py-5">
        <div className="flex max-w-[820px] flex-col gap-5">
          <ToolApprovalQueue />

          {groups.length > 1 && (
            <div className="flex flex-wrap gap-1.5">
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
                  <Button variant="ghost" size="sm" onClick={() => void refresh()}>
                    Retry
                  </Button>
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
                className="flex flex-col gap-2"
              >
                <div className={`${SECTION_LABEL} text-foreground/45`}>
                  {RUNTIME_LABEL[g.runtime] ?? g.runtime}
                  <span className="font-data font-normal text-foreground/35">
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
