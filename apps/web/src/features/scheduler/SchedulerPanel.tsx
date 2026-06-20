// Unified Scheduler tab — the merged read/write surface over the
// /api/schedules multiplexer: clawboo Routines (team-task domain) + the OpenClaw
// Gateway cron (runtime-own-life domain). Grouped + badged by `domain`; row
// actions are a PURE function of `manageability` (the UI may never offer an
// action the owner forbids). Create-from-UI: an OpenClaw agent can be scheduled
// for its own life (Gateway cron) OR a team task (Routine); every other runtime
// can be scheduled only for a team task. Run-history + live firing come from the
// record's nextRunAt/lastRunAt/status, refreshed on the same 8s cadence.

import { useCallback, useEffect, useMemo, useState } from 'react'
import { AlertTriangle, Clock, Pause, Play, Plus, RefreshCw, Trash2, X } from 'lucide-react'

import { GitHubStarButton } from '@/features/promo/GitHubStarButton'
import { EmptyState } from '@/features/shared/EmptyState'
import { StatusPill, type StatusTone } from '@/features/shared/StatusPill'
import { listAgents } from '@/lib/agentSourceClient'
import { formatRelative } from '@/lib/formatRelative'
import {
  createSchedule,
  deleteSchedule,
  fetchSchedules,
  pauseSchedule,
  resumeSchedule,
  runScheduleNow,
  type ScheduleRecord,
  type ScheduleSourceReadStatus,
} from '@/lib/schedulesClient'
import { useToastStore } from '@/stores/toast'

import { canScheduleOwnLife, formatScheduleLabel } from './scheduleHelpers'
import { RuntimeGlyph } from '../runtimes/runtimeDepth'
import { RUNTIME_CATALOG, type RuntimeId } from '../runtimes/runtimeCatalog'

const muted = (o: number) => `rgb(var(--foreground-rgb) / ${o})`
const BRANDED = new Set<string>(['clawboo-native', 'claude-code', 'codex', 'hermes'])

// Cron-EXPRESSION presets. A cron expression is the one cronSpec dialect BOTH
// sources accept: the clawboo-routine source parses it via croner; the gateway
// source decodes an unprefixed spec as a cron expression. (The `every:<ms>`
// canonical form is gateway-only, so it can't be the shared dialect.)
const CRON_PRESETS: { label: string; cron: string }[] = [
  { label: 'Every 5 minutes', cron: '*/5 * * * *' },
  { label: 'Every 15 minutes', cron: '*/15 * * * *' },
  { label: 'Every 30 minutes', cron: '*/30 * * * *' },
  { label: 'Every hour', cron: '0 * * * *' },
  { label: 'Every 6 hours', cron: '0 */6 * * *' },
  { label: 'Every 12 hours', cron: '0 */12 * * *' },
  { label: 'Daily · 9am', cron: '0 9 * * *' },
  { label: 'Weekly · Mon 9am', cron: '0 9 * * 1' },
]
const PRESET_LABEL = new Map(CRON_PRESETS.map((p) => [p.cron, p.label]))

function runtimeName(id: string): string {
  if (id === 'openclaw') return 'OpenClaw'
  return BRANDED.has(id) ? RUNTIME_CATALOG[id as RuntimeId].name : id
}

/** Compact human form of the canonical cron spec (handles both source dialects). */
function humanCron(spec: string): string {
  return PRESET_LABEL.get(spec) ?? formatScheduleLabel(spec)
}

function untilLabel(ms: number, now = Date.now()): string {
  const diff = ms - now
  if (diff <= 0) return 'due now'
  const sec = Math.floor(diff / 1000)
  if (sec < 60) return `in ${sec}s`
  const m = Math.floor(sec / 60)
  if (m < 60) return `in ${m}m`
  const h = Math.floor(m / 60)
  if (h < 24) return `in ${h}h`
  return `in ${Math.floor(h / 24)}d`
}

function statusPill(s: ScheduleRecord['status']): { tone: StatusTone; label: string } {
  switch (s) {
    case 'running':
      return { tone: 'working', label: 'running' }
    case 'queued':
      return { tone: 'working', label: 'queued' }
    case 'claimed':
      return { tone: 'working', label: 'claimed' }
    case 'paused':
      return { tone: 'idle', label: 'paused' }
    case 'error':
      return { tone: 'error', label: 'error' }
    default:
      return { tone: 'idle', label: 'idle' }
  }
}

// ─── Row ─────────────────────────────────────────────────────────────────────

function ScheduleRow({ rec, onChanged }: { rec: ScheduleRecord; onChanged: () => void }) {
  const addToast = useToastStore((s) => s.addToast)
  const [busy, setBusy] = useState(false)
  const pill = statusPill(rec.status)
  const writable = rec.manageability !== 'observe-only'
  const paused = rec.status === 'paused'
  // External-write (Gateway cron) uses enable/disable wording; managed uses pause/resume.
  const toggleVerb =
    rec.manageability === 'external-write'
      ? paused
        ? 'Enable'
        : 'Disable'
      : paused
        ? 'Resume'
        : 'Pause'

  async function run(action: () => Promise<{ ok: boolean; error?: string }>, ok: string) {
    setBusy(true)
    const r = await action()
    setBusy(false)
    if (r.ok) {
      addToast({ message: ok, type: 'success' })
      onChanged()
    } else {
      addToast({ message: r.error ?? 'Action failed', type: 'error' })
    }
  }

  return (
    <div
      data-testid={`schedule-row-${rec.id}`}
      className="surface-raised-tier rounded-xl"
      style={{ padding: '11px 13px', display: 'flex', alignItems: 'center', gap: 11 }}
    >
      <RuntimeGlyph id={rec.runtime} size={28} />
      <div style={{ minWidth: 0, flex: 1 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <span
            style={{
              fontSize: 13,
              fontWeight: 600,
              color: 'var(--foreground)',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
            }}
          >
            {rec.label || rec.agentId}
          </span>
          <StatusPill tone={pill.tone} label={pill.label} />
        </div>
        <div style={{ display: 'flex', gap: 8, fontSize: 11, color: muted(0.5), marginTop: 2 }}>
          <span className="font-mono" style={{ color: muted(0.6) }}>
            {humanCron(rec.cronSpec)}
          </span>
          <span>· {rec.nextRunAt ? untilLabel(rec.nextRunAt) : 'not scheduled'}</span>
          {rec.lastRunAt ? <span>· ran {formatRelative(rec.lastRunAt)}</span> : null}
        </div>
        {rec.lastError ? (
          <div style={{ fontSize: 10.5, color: 'var(--primary)', marginTop: 2 }}>
            {rec.lastError}
          </div>
        ) : null}
      </div>

      {writable ? (
        <div style={{ display: 'flex', alignItems: 'center', gap: 4, flexShrink: 0 }}>
          <IconBtn
            testid={`schedule-${rec.id}-toggle`}
            label={toggleVerb}
            disabled={busy}
            onClick={() =>
              void run(
                () => (paused ? resumeSchedule(rec.id) : pauseSchedule(rec.id)),
                `${toggleVerb}d`,
              )
            }
          >
            {paused ? <Play size={13} /> : <Pause size={13} />}
          </IconBtn>
          <IconBtn
            testid={`schedule-${rec.id}-run`}
            label="Run now"
            disabled={busy}
            onClick={() => void run(() => runScheduleNow(rec.id), 'Fired now')}
          >
            <RefreshCw size={13} />
          </IconBtn>
          <IconBtn
            testid={`schedule-${rec.id}-delete`}
            label="Delete"
            danger
            disabled={busy}
            onClick={() => {
              const what =
                rec.domain === 'runtime-own-life'
                  ? "this Gateway cron job? It removes the agent's own scheduled wake on the OpenClaw Gateway."
                  : 'this scheduled routine? It is removed permanently.'
              if (!window.confirm(`Delete ${what}`)) return
              void run(() => deleteSchedule(rec.id), 'Deleted')
            }}
          >
            <Trash2 size={13} />
          </IconBtn>
        </div>
      ) : (
        <span style={{ fontSize: 10, color: muted(0.4), flexShrink: 0 }}>read-only</span>
      )}
    </div>
  )
}

function IconBtn({
  children,
  onClick,
  label,
  disabled,
  danger,
  testid,
}: {
  children: React.ReactNode
  onClick: () => void
  label: string
  disabled?: boolean
  danger?: boolean
  testid?: string
}) {
  return (
    <button
      type="button"
      data-testid={testid}
      aria-label={label}
      title={label}
      disabled={disabled}
      onClick={onClick}
      className="rounded-md p-1.5 transition-colors hover:bg-foreground/[0.06] disabled:opacity-40"
      style={{
        color: danger ? 'var(--primary)' : muted(0.55),
        background: 'transparent',
        border: 'none',
        cursor: 'pointer',
      }}
    >
      {children}
    </button>
  )
}

// ─── Create dialog ───────────────────────────────────────────────────────────

interface DialogAgent {
  id: string
  name: string
  runtime: string
  teamId: string | null
}

type Intent = 'team-task' | 'own-life'

function ScheduleDialog({ onClose, onCreated }: { onClose: () => void; onCreated: () => void }) {
  const addToast = useToastStore((s) => s.addToast)
  const [agents, setAgents] = useState<DialogAgent[]>([])
  const [agentId, setAgentId] = useState('')
  const [intent, setIntent] = useState<Intent>('team-task')
  const [cron, setCron] = useState<string>(CRON_PRESETS[3]!.cron) // hourly
  const [label, setLabel] = useState('')
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    let alive = true
    void (async () => {
      try {
        const { agents: list } = await listAgents()
        if (!alive) return
        const mapped = list.map((a) => ({
          id: a.id,
          name: a.displayName,
          // Keep an unknown runtime UNKNOWN — never default to 'openclaw', which
          // would wrongly offer the Gateway own-life cron for a non-OpenClaw agent.
          runtime: a.runtime ?? '',
          teamId: a.teamId,
        }))
        setAgents(mapped)
        if (mapped[0]) setAgentId(mapped[0].id)
      } catch {
        /* leave empty */
      }
    })()
    return () => {
      alive = false
    }
  }, [])

  const selected = agents.find((a) => a.id === agentId)
  const isOpenClaw = canScheduleOwnLife(selected?.runtime)

  // Non-OpenClaw runtimes can only be scheduled for a team task. Keep intent valid.
  useEffect(() => {
    if (!isOpenClaw && intent === 'own-life') setIntent('team-task')
  }, [isOpenClaw, intent])

  async function submit(): Promise<void> {
    if (!selected) return
    setBusy(true)
    const cronSpec = cron
    const result =
      intent === 'own-life'
        ? await createSchedule({
            source: 'openclaw-gateway-cron',
            domain: 'runtime-own-life',
            agentId: selected.id,
            cronSpec,
            label: label.trim() || 'Scheduled wake',
            payload: { kind: 'agentTurn', message: label.trim() || 'Scheduled wake' },
          })
        : await createSchedule({
            source: 'clawboo-routine',
            domain: 'team-task',
            agentId: selected.id,
            cronSpec,
            label: label.trim() || 'Scheduled task',
            teamId: selected.teamId,
            taskTemplate: { title: label.trim() || 'Scheduled task' },
          })
    setBusy(false)
    if (result.ok) {
      addToast({ message: 'Schedule created', type: 'success' })
      onCreated()
      onClose()
    } else {
      addToast({ message: result.error ?? 'Could not create schedule', type: 'error' })
    }
  }

  return (
    <div
      onClick={onClose}
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 60,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: 24,
        background: 'var(--overlay-scrim, rgb(0 0 0 / 0.5))',
      }}
    >
      <div
        role="dialog"
        aria-label="Create schedule"
        data-testid="schedule-dialog"
        onClick={(e) => e.stopPropagation()}
        className="surface-overlay-tier rounded-xl"
        style={{
          width: 'min(440px, 100%)',
          padding: 18,
          display: 'flex',
          flexDirection: 'column',
          gap: 14,
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <span style={{ fontSize: 14, fontWeight: 600, color: 'var(--foreground)' }}>
            Schedule…
          </span>
          <button
            type="button"
            aria-label="Close"
            onClick={onClose}
            style={{
              border: 'none',
              background: 'transparent',
              color: muted(0.5),
              cursor: 'pointer',
              display: 'flex',
            }}
          >
            <X size={16} />
          </button>
        </div>

        <Field label="Agent">
          <select
            data-testid="schedule-agent"
            value={agentId}
            onChange={(e) => setAgentId(e.target.value)}
            aria-label="Agent"
            className="w-full rounded-lg px-3 py-2 text-[12px] outline-none"
            style={{
              background: 'rgb(var(--foreground-rgb) / 0.04)',
              border: `1px solid ${muted(0.12)}`,
              color: 'var(--foreground)',
            }}
          >
            {agents.length === 0 ? (
              <option key="__none" value="">
                No agents
              </option>
            ) : (
              agents.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.name} · {runtimeName(a.runtime)}
                </option>
              ))
            )}
          </select>
        </Field>

        <Field label="Schedule">
          <div style={{ display: 'flex', gap: 8 }}>
            <IntentChip
              active={intent === 'team-task'}
              onClick={() => setIntent('team-task')}
              title="A team task"
              sub="clawboo Routine"
            />
            <IntentChip
              active={intent === 'own-life'}
              onClick={() => isOpenClaw && setIntent('own-life')}
              disabled={!isOpenClaw}
              title="Its own life"
              sub={isOpenClaw ? 'Gateway cron' : 'OpenClaw only'}
            />
          </div>
          {intent === 'own-life' ? (
            <p style={{ fontSize: 10.5, color: muted(0.5), marginTop: 6, lineHeight: 1.5 }}>
              Writes a Gateway cron job — needs the OpenClaw Gateway connected and this device
              paired.
            </p>
          ) : null}
        </Field>

        <Field label="Runs">
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
            {CRON_PRESETS.map((p) => (
              <button
                key={p.cron}
                type="button"
                onClick={() => setCron(p.cron)}
                className="rounded-md px-2.5 py-1 text-[11px] transition-colors"
                style={{
                  color: cron === p.cron ? 'var(--mint)' : muted(0.6),
                  background:
                    cron === p.cron
                      ? 'rgb(var(--mint-rgb) / 0.12)'
                      : 'rgb(var(--foreground-rgb) / 0.05)',
                  border: 'none',
                  cursor: 'pointer',
                }}
              >
                {p.label}
              </button>
            ))}
          </div>
        </Field>

        <Field label="Label">
          <input
            data-testid="schedule-label"
            value={label}
            onChange={(e) => setLabel(e.target.value)}
            placeholder={intent === 'own-life' ? 'Morning briefing' : 'Nightly cleanup'}
            aria-label="Label"
            className="w-full rounded-lg px-3 py-2 text-[12px] outline-none"
            style={{
              background: 'rgb(var(--foreground-rgb) / 0.04)',
              border: `1px solid ${muted(0.12)}`,
              color: 'var(--foreground)',
            }}
          />
        </Field>

        <button
          type="button"
          data-testid="schedule-submit"
          disabled={busy || !selected}
          onClick={() => void submit()}
          className="rounded-lg px-3 py-2 text-[12px] font-semibold transition-[filter,transform] active:scale-[0.98] disabled:opacity-50"
          style={{
            background: 'var(--primary)',
            color: 'var(--primary-foreground)',
            border: 'none',
            cursor: 'pointer',
          }}
        >
          {busy ? 'Creating…' : 'Create schedule'}
        </button>
      </div>
    </div>
  )
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
      <label
        className="font-mono uppercase"
        style={{ fontSize: 10, letterSpacing: '0.06em', color: muted(0.5) }}
      >
        {label}
      </label>
      {children}
    </div>
  )
}

function IntentChip({
  active,
  onClick,
  title,
  sub,
  disabled,
}: {
  active: boolean
  onClick: () => void
  title: string
  sub: string
  disabled?: boolean
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className="flex-1 rounded-lg px-3 py-2 text-left transition-colors disabled:opacity-40"
      style={{
        border: `1px solid ${active ? 'var(--mint)' : muted(0.12)}`,
        background: active ? 'rgb(var(--mint-rgb) / 0.1)' : 'transparent',
        cursor: disabled ? 'not-allowed' : 'pointer',
      }}
    >
      <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--foreground)' }}>{title}</div>
      <div style={{ fontSize: 10, color: muted(0.5) }}>{sub}</div>
    </button>
  )
}

// ─── Panel ───────────────────────────────────────────────────────────────────

const DOMAIN_META: Record<ScheduleRecord['domain'], { title: string; hint: string }> = {
  'team-task': { title: 'Team work', hint: 'clawboo Routines that fire team tasks.' },
  'runtime-own-life': {
    title: "Runtime's own life",
    hint: "The OpenClaw Gateway's own cron jobs.",
  },
}

export function SchedulerPanel() {
  const [schedules, setSchedules] = useState<ScheduleRecord[]>([])
  const [sources, setSources] = useState<ScheduleSourceReadStatus[]>([])
  const [loaded, setLoaded] = useState(false)
  const [showDialog, setShowDialog] = useState(false)

  const refresh = useCallback(async () => {
    const view = await fetchSchedules()
    setSchedules(view.schedules)
    setSources(view.sources)
    setLoaded(true)
  }, [])

  useEffect(() => {
    void refresh()
    const id = setInterval(() => void refresh(), 8000)
    return () => clearInterval(id)
  }, [refresh])

  const groups = useMemo(
    () => [
      { domain: 'team-task' as const, rows: schedules.filter((s) => s.domain === 'team-task') },
      {
        domain: 'runtime-own-life' as const,
        rows: schedules.filter((s) => s.domain === 'runtime-own-life'),
      },
    ],
    [schedules],
  )

  const degraded = sources.filter((s) => s.degraded)

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
          <Clock size={15} style={{ color: 'var(--mint)' }} />
          <span style={{ fontSize: 13, fontWeight: 600, color: 'var(--foreground)' }}>
            Scheduler
          </span>
          <span
            className="tabular-nums"
            style={{
              fontSize: 10,
              fontFamily: 'var(--font-geist-mono, monospace)',
              color: 'var(--primary)',
              background: 'rgb(var(--primary-rgb) / 0.12)',
              borderRadius: 20,
              padding: '2px 8px',
            }}
          >
            {schedules.length} schedules
          </span>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <button
            type="button"
            data-testid="schedule-create-open"
            onClick={() => setShowDialog(true)}
            className="inline-flex items-center gap-1.5 rounded-lg px-2.5 py-1 text-[11px] font-semibold"
            style={{
              background: 'var(--primary)',
              color: 'var(--primary-foreground)',
              border: 'none',
              cursor: 'pointer',
            }}
          >
            <Plus size={12} /> Schedule
          </button>
          <button
            type="button"
            onClick={() => void refresh()}
            aria-label="Refresh"
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 5,
              fontSize: 11,
              color: muted(0.5),
              background: 'transparent',
              border: 'none',
              cursor: 'pointer',
            }}
          >
            <RefreshCw size={12} /> Refresh
          </button>
          <GitHubStarButton />
        </div>
      </div>

      <div style={{ flex: 1, overflowY: 'auto', padding: '16px 18px' }}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 18, maxWidth: 760 }}>
          {degraded.map((s) => (
            <div
              key={s.sourceId}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 8,
                fontSize: 11.5,
                color: 'var(--amber)',
                background: 'rgb(var(--amber-rgb) / 0.1)',
                borderRadius: 8,
                padding: '8px 12px',
              }}
            >
              <AlertTriangle size={14} />
              {s.sourceId === 'openclaw-gateway-cron'
                ? 'OpenClaw Gateway cron is unavailable (Gateway disconnected) — showing the last-known list.'
                : `${s.sourceId} is degraded${s.reason ? ` (${s.reason})` : ''}.`}
            </div>
          ))}

          {groups.map((g) => (
            <div key={g.domain}>
              <div style={{ marginBottom: 8 }}>
                <span style={{ fontSize: 12, fontWeight: 600, color: 'var(--foreground)' }}>
                  {DOMAIN_META[g.domain].title}
                </span>
                <span style={{ fontSize: 11, color: muted(0.45), marginLeft: 8 }}>
                  {DOMAIN_META[g.domain].hint}
                </span>
              </div>
              {g.rows.length > 0 ? (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                  {g.rows.map((rec) => (
                    <ScheduleRow key={rec.id} rec={rec} onChanged={() => void refresh()} />
                  ))}
                </div>
              ) : (
                <div style={{ fontSize: 11.5, color: muted(0.4), padding: '4px 2px' }}>
                  Nothing scheduled here yet.
                </div>
              )}
            </div>
          ))}

          {loaded && schedules.length === 0 && degraded.length === 0 ? (
            <EmptyState
              icon={Clock}
              title="No schedules yet"
              helper="Schedule a team task or an OpenClaw agent's own cron from the button above."
            />
          ) : null}
        </div>
      </div>

      {showDialog ? (
        <ScheduleDialog onClose={() => setShowDialog(false)} onCreated={() => void refresh()} />
      ) : null}
    </div>
  )
}
