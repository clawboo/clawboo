// Unified Scheduler tab — the merged read/write surface over the
// /api/schedules multiplexer: clawboo Routines (team-task domain) + the OpenClaw
// Gateway cron (runtime-own-life domain). Grouped + badged by `domain`; row
// actions are a PURE function of `manageability` (the UI may never offer an
// action the owner forbids). Create-from-UI: an OpenClaw agent can be scheduled
// for its own life (Gateway cron) OR a team task (Routine); every other runtime
// can be scheduled only for a team task. Run-history + live firing come from the
// record's nextRunAt/lastRunAt/status, refreshed on the same 8s cadence.

import { useCallback, useEffect, useMemo, useState } from 'react'
import { createPortal } from 'react-dom'
import { AlertTriangle, Clock, Pause, Play, Plus, RefreshCw, Trash2, X } from 'lucide-react'

import { GitHubStarButton } from '@/features/promo/GitHubStarButton'
import { Button, IconButton } from '@/features/shared/Button'
import { Chip } from '@/features/shared/Chip'
import { EmptyState } from '@/features/shared/EmptyState'
import { FormattedAlert } from '@/features/shared/FormattedAlert'
import { PanelHeader } from '@/features/shared/PanelHeader'
import { Select } from '@/features/shared/Select'
import { StatusPill, type StatusTone } from '@/features/shared/StatusPill'
import { listAgents } from '@clawboo/control-client'
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
import { confirm } from '@/stores/confirm'

import { canScheduleOwnLife, formatScheduleLabel } from './scheduleHelpers'
import { RuntimeGlyph } from '../runtimes/runtimeDepth'
import { RUNTIME_CATALOG, type RuntimeId } from '../runtimes/runtimeCatalog'

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
      className="flex items-center gap-3 rounded-2xl border border-border bg-surface p-4 transition-colors hover:border-border-strong"
      style={{ boxShadow: 'var(--shadow-raised)' }}
    >
      <RuntimeGlyph id={rec.runtime} size={28} />
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="overflow-hidden text-ellipsis whitespace-nowrap text-[13.5px] font-semibold text-foreground">
            {rec.label || rec.agentId}
          </span>
          <StatusPill tone={pill.tone} label={pill.label} />
        </div>
        <div className="font-data mt-0.5 flex gap-2 text-[11px] text-foreground/50">
          <span className="text-foreground/60">{humanCron(rec.cronSpec)}</span>
          <span>· {rec.nextRunAt ? untilLabel(rec.nextRunAt) : 'not scheduled'}</span>
          {rec.lastRunAt ? <span>· ran {formatRelative(rec.lastRunAt)}</span> : null}
        </div>
        {rec.lastError ? (
          <div className="mt-1 text-[10.5px] text-destructive">{rec.lastError}</div>
        ) : null}
      </div>

      {writable ? (
        <div className="flex flex-shrink-0 items-center gap-0.5">
          <IconButton
            size="sm"
            data-testid={`schedule-${rec.id}-toggle`}
            label={toggleVerb}
            disabled={busy}
            onClick={() =>
              void run(
                () => (paused ? resumeSchedule(rec.id) : pauseSchedule(rec.id)),
                `${toggleVerb}d`,
              )
            }
          >
            {paused ? <Play size={14} strokeWidth={2} /> : <Pause size={14} strokeWidth={2} />}
          </IconButton>
          <IconButton
            size="sm"
            data-testid={`schedule-${rec.id}-run`}
            label="Run now"
            disabled={busy}
            onClick={() => void run(() => runScheduleNow(rec.id), 'Fired now')}
          >
            <RefreshCw size={14} strokeWidth={2} />
          </IconButton>
          <IconButton
            size="sm"
            variant="ghost"
            data-testid={`schedule-${rec.id}-delete`}
            label="Delete"
            disabled={busy}
            className="text-destructive hover:text-destructive"
            onClick={() => {
              const ownLife = rec.domain === 'runtime-own-life'
              void (async () => {
                if (
                  !(await confirm({
                    title: ownLife ? 'Delete this Gateway cron job?' : 'Delete this scheduled routine?',
                    message: ownLife
                      ? "It removes the agent's own scheduled wake on the OpenClaw Gateway."
                      : 'It is removed permanently.',
                    confirmLabel: 'Delete',
                    tone: 'danger',
                  }))
                )
                  return
                void run(() => deleteSchedule(rec.id), 'Deleted')
              })()
            }}
          >
            <Trash2 size={14} strokeWidth={2} />
          </IconButton>
        </div>
      ) : (
        <span className="flex-shrink-0 font-mono text-[9.5px] uppercase tracking-[0.14em] text-foreground/40">
          read-only
        </span>
      )}
    </div>
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

  // Close on Escape — capture phase so it beats the app-shell Esc handler
  // (which would otherwise close the parent Settings modal instead of this
  // dialog when the Scheduler panel is opened from Settings).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation()
        onClose()
      }
    }
    document.addEventListener('keydown', onKey, true)
    return () => document.removeEventListener('keydown', onKey, true)
  }, [onClose])

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

  // Portalled to <body> so the fixed scrim/dialog resolve against the viewport
  // (not clipped when the Scheduler panel is rendered inside the Settings
  // modal's glass container). z above the settings scrim (z-70).
  return createPortal(
    <div
      onClick={onClose}
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 80,
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
        className="rounded-2xl border border-border bg-surface"
        style={{
          width: 'min(440px, 100%)',
          padding: 22,
          display: 'flex',
          flexDirection: 'column',
          gap: 16,
          boxShadow: 'var(--shadow-overlay)',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <span
            className="font-display"
            style={{
              fontSize: 16,
              fontWeight: 700,
              letterSpacing: '-0.01em',
              color: 'var(--foreground)',
            }}
          >
            New schedule
          </span>
          <IconButton size="sm" variant="ghost" label="Close" onClick={onClose}>
            <X size={16} strokeWidth={2} />
          </IconButton>
        </div>

        <Field label="Agent">
          <Select
            data-testid="schedule-agent"
            value={agentId}
            onChange={(value) => setAgentId(value)}
            aria-label="Agent"
            className="w-full"
            options={
              agents.length === 0
                ? [{ value: '', label: 'No agents' }]
                : agents.map((a) => ({
                    value: a.id,
                    label: `${a.name} · ${runtimeName(a.runtime)}`,
                  }))
            }
          />
        </Field>

        <Field label="Schedule">
          {/* Two-option toggle styled like a segmented control. The own-life
              option is genuinely DISABLED for non-OpenClaw runtimes (an invalid
              choice must read as disabled, not be clickable-but-ignored). */}
          <div
            role="group"
            aria-label="Schedule intent"
            className="inline-flex items-center gap-1 rounded-xl border border-border bg-foreground/[0.03] p-1"
          >
            {(
              [
                { id: 'team-task', label: 'A team task' },
                { id: 'own-life', label: 'Its own life' },
              ] as const
            ).map((opt) => {
              const active = intent === opt.id
              const disabled = opt.id === 'own-life' && !isOpenClaw
              return (
                <button
                  key={opt.id}
                  type="button"
                  disabled={disabled}
                  onClick={() => setIntent(opt.id)}
                  className={[
                    'inline-flex h-8 items-center rounded-lg px-3 text-[12.5px] font-medium transition-all duration-150',
                    disabled ? 'cursor-not-allowed opacity-40' : 'cursor-pointer',
                    active
                      ? 'bg-surface text-foreground shadow-[var(--shadow-raised)]'
                      : 'text-foreground/55 hover:text-foreground/80',
                  ].join(' ')}
                >
                  {opt.label}
                  {disabled ? ' · OpenClaw only' : ''}
                </button>
              )
            })}
          </div>
          <p className="mt-2 text-[11px] leading-relaxed text-foreground/50">
            {intent === 'own-life'
              ? 'Writes a Gateway cron job — needs the OpenClaw Gateway connected and this device paired.'
              : intent === 'team-task'
                ? 'Fires a clawboo Routine as a team task.'
                : null}
          </p>
        </Field>

        <Field label="Runs">
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
            {CRON_PRESETS.map((p) => (
              <Chip
                key={p.cron}
                active={cron === p.cron}
                onClick={() => setCron(p.cron)}
                size="sm"
              >
                {p.label}
              </Chip>
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
            className="w-full rounded-xl border border-border bg-surface px-4 py-2.5 text-[13px] text-foreground outline-none transition placeholder:text-foreground/30 focus:border-primary focus:ring-4 focus:ring-primary/15"
          />
        </Field>

        <Button
          variant="primary"
          fullWidth
          data-testid="schedule-submit"
          disabled={busy || !selected}
          loading={busy}
          onClick={() => void submit()}
        >
          {busy ? 'Creating…' : 'Create schedule'}
        </Button>
      </div>
    </div>,
    document.body,
  )
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 7 }}>
      <label className="font-mono text-[10px] font-semibold uppercase tracking-[0.14em] text-foreground/45">
        {label}
      </label>
      {children}
    </div>
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
      <PanelHeader
        title="Scheduler"
        subtitle="Team-task routines + runtime cron, one surface"
        icon={Clock}
        size="md"
        border
        actions={
          <>
            <span className="font-data rounded-full bg-foreground/[0.06] px-2.5 py-0.5 text-[11px] font-semibold text-foreground/55">
              {schedules.length} schedules
            </span>
            <Button
              variant="primary"
              size="sm"
              data-testid="schedule-create-open"
              onClick={() => setShowDialog(true)}
            >
              <Plus size={14} strokeWidth={2} /> Schedule
            </Button>
            <Button variant="secondary" size="sm" onClick={() => void refresh()}>
              <RefreshCw size={13} strokeWidth={2} /> Refresh
            </Button>
            <GitHubStarButton />
          </>
        }
      />

      <div style={{ flex: 1, overflowY: 'auto', padding: '20px 24px' }}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 24, maxWidth: 780 }}>
          {degraded.map((s) => (
            <FormattedAlert key={s.sourceId} tone="warning" icon={AlertTriangle}>
              {s.sourceId === 'openclaw-gateway-cron'
                ? 'OpenClaw Gateway cron is unavailable (Gateway disconnected) — showing the last-known list.'
                : `${s.sourceId} is degraded${s.reason ? ` (${s.reason})` : ''}.`}
            </FormattedAlert>
          ))}

          {groups.map((g) => (
            <div key={g.domain}>
              <div style={{ marginBottom: 12 }}>
                <span className="font-mono text-[11px] font-semibold uppercase tracking-[0.14em] text-foreground/45">
                  {DOMAIN_META[g.domain].title}
                </span>
                <span style={{ marginLeft: 10 }} className="text-[11.5px] text-foreground/40">
                  {DOMAIN_META[g.domain].hint}
                </span>
              </div>
              {g.rows.length > 0 ? (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                  {g.rows.map((rec) => (
                    <ScheduleRow key={rec.id} rec={rec} onChanged={() => void refresh()} />
                  ))}
                </div>
              ) : (
                <div className="px-0.5 py-1 text-[12px] text-foreground/40">
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
