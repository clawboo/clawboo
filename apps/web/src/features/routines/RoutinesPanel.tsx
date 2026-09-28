// Routines: scheduled work for teams and agents, run by clawboo's own scheduler.
// A TEAM routine posts its instructions into the team's group chat, where the
// team's lead (Boo Zero) takes it from there. An AGENT routine is a board task
// for one agent. OpenClaw agents can also carry cron jobs of their own on the
// Gateway; those get their own section and can be enabled, disabled, run or
// deleted here. Every row opens its detail view, and the actions a row offers
// follow its manageability: the view never offers what the owner forbids.

import { useCallback, useEffect, useMemo, useState } from 'react'
import { createPortal } from 'react-dom'
import {
  AlertTriangle,
  ChevronRight,
  Pause,
  Play,
  Plus,
  RefreshCw,
  Repeat,
  Trash2,
  Users,
} from 'lucide-react'

import { apiFetch, listAgents } from '@clawboo/control-client'
import { TaskDetailDrawer } from '@/features/board/TaskDetailDrawer'
import { GitHubStarButton } from '@/features/promo/GitHubStarButton'
import { Button, IconButton } from '@/features/shared/Button'
import { EmptyState } from '@/features/shared/EmptyState'
import { FormattedAlert } from '@/features/shared/FormattedAlert'
import { PanelHeader } from '@/features/shared/PanelHeader'
import { StatusPill } from '@/features/shared/StatusPill'
import { formatRelative } from '@/lib/formatRelative'
import {
  deleteSchedule,
  fetchSchedules,
  runScheduleNow,
  type ScheduleActionResult,
  type ScheduleRecord,
  type ScheduleSourceReadStatus,
} from '@/lib/schedulesClient'
import { useReadSequencer } from '@/lib/useReadSequencer'
import { useVisiblePolling } from '@/lib/useVisiblePolling'
import { useTeamStore } from '@/stores/team'
import { useToastStore } from '@/stores/toast'

import { RuntimeGlyph } from '../runtimes/runtimeDepth'
import {
  confirmDeleteSchedule,
  RoutineDialog,
  toggleSchedule,
  WithReason,
  type RoutineDialogTarget,
  type RoutineDirectory,
} from './RoutineDialog'
import {
  humanCron,
  isClawbooRoutine,
  routineKindOf,
  runNowBlocker,
  runtimeDisplayName,
  statusPill,
  targetSummary,
  toggleBlocker,
  untilLabel,
} from './routineHelpers'

const EMPTY_DIRECTORY: RoutineDirectory = { teams: [], agents: [], booZeroName: null }

/** The teams and agents a routine can point at. Null when they could not be read. */
async function loadDirectory(): Promise<RoutineDirectory | null> {
  try {
    const [teamsRes, agentList] = await Promise.all([apiFetch('/api/teams'), listAgents()])
    const teamsBody = teamsRes.ok
      ? ((await teamsRes.json()) as {
          teams?: Array<{ id: string; name: string; icon?: string; isArchived?: unknown }>
        })
      : {}
    const teams = (teamsBody.teams ?? [])
      .filter((t) => !t.isArchived)
      .map((t) => ({ id: t.id, name: t.name, icon: t.icon ?? '' }))
    const live = agentList.agents.filter(
      (a) => !a.archivedAt && (a.participantKind as string | undefined) !== 'human',
    )
    const agents = live.map((a) => ({
      id: a.id,
      name: a.displayName,
      // Keep an unknown runtime unknown rather than guessing one.
      runtime: (a.runtime as string | undefined) ?? '',
      teamId: a.teamId ?? null,
    }))
    const booZero = agentList.defaultId ? live.find((a) => a.id === agentList.defaultId) : undefined
    return { teams, agents, booZeroName: booZero?.displayName ?? null }
  } catch {
    return null
  }
}

const byName = (a: ScheduleRecord, b: ScheduleRecord): number =>
  (a.label ?? a.agentName ?? '').localeCompare(b.label ?? b.agentName ?? '') ||
  a.id.localeCompare(b.id)

// ─── Row ─────────────────────────────────────────────────────────────────────

function RowIcon({ rec }: { rec: ScheduleRecord }) {
  if (isClawbooRoutine(rec) && routineKindOf(rec) === 'team') {
    return (
      <span
        aria-hidden
        className="inline-flex h-7 w-7 flex-shrink-0 items-center justify-center rounded-lg"
        style={{ color: 'var(--primary)', background: 'rgb(var(--primary-rgb) / 0.12)' }}
      >
        <Users size={15} strokeWidth={2} />
      </span>
    )
  }
  return <RuntimeGlyph id={rec.runtime} size={28} />
}

function RoutineRow({
  rec,
  onOpen,
  onChanged,
}: {
  rec: ScheduleRecord
  onOpen: () => void
  onChanged: () => void
}) {
  const addToast = useToastStore((s) => s.addToast)
  const [busy, setBusy] = useState(false)
  const pill = statusPill(rec)
  const routine = isClawbooRoutine(rec)
  const writable = rec.manageability !== 'observe-only'
  const toggle = toggleSchedule(rec)
  const toggleBlocked = toggleBlocker(rec)
  const runBlocked = runNowBlocker(rec)
  const toggleLabel = toggleBlocked ? `${toggle.label} (${toggleBlocked})` : toggle.label
  const runLabel = runBlocked ? `Run now (${runBlocked})` : 'Run now'
  const name = rec.label || rec.agentName || rec.agentId

  async function run(action: () => Promise<ScheduleActionResult>, ok: string) {
    setBusy(true)
    const r = await action()
    setBusy(false)
    if (r.ok) {
      addToast({ message: ok, type: 'success' })
      onChanged()
    } else {
      addToast({ message: r.error ?? 'That did not work.', type: 'error' })
    }
  }

  return (
    <div
      data-testid={`schedule-row-${rec.id}`}
      className="flex items-center gap-1 rounded-2xl border border-border bg-surface p-1.5 pr-2.5 transition-colors hover:border-border-strong"
      style={{ boxShadow: 'var(--shadow-raised)' }}
    >
      <button
        type="button"
        data-testid={`schedule-open-${rec.id}`}
        onClick={onOpen}
        className="flex min-w-0 flex-1 cursor-pointer items-center gap-3 rounded-xl p-2.5 text-left transition-colors hover:bg-foreground/[0.03] focus-visible:outline-2 focus-visible:outline-offset-2"
      >
        <RowIcon rec={rec} />
        <span className="min-w-0 flex-1">
          <span className="flex items-center gap-2">
            <span className="overflow-hidden text-ellipsis whitespace-nowrap text-[13.5px] font-semibold text-foreground">
              {name}
            </span>
            <StatusPill tone={pill.tone} label={pill.label} />
          </span>
          <span className="mt-0.5 block overflow-hidden text-ellipsis whitespace-nowrap text-[12px] text-foreground/60">
            {routine
              ? targetSummary(rec)
              : `${rec.agentName ?? rec.agentId} · ${runtimeDisplayName(rec.runtime)}`}
          </span>
          <span className="font-data mt-0.5 flex flex-wrap gap-x-2 text-[11px] text-foreground/50">
            <span className="text-foreground/60">{humanCron(rec.cronSpec)}</span>
            <span>· {rec.nextRunAt ? untilLabel(rec.nextRunAt) : 'not scheduled'}</span>
            {rec.lastRunAt ? <span>· ran {formatRelative(rec.lastRunAt)}</span> : null}
          </span>
          {rec.lastError ? (
            <span className="mt-1 line-clamp-2 block text-[11px] text-destructive">
              {rec.lastError}
            </span>
          ) : null}
        </span>
        <ChevronRight size={15} strokeWidth={2} className="flex-shrink-0 text-foreground/30" />
      </button>

      {writable ? (
        <div className="flex flex-shrink-0 items-center gap-0.5">
          <WithReason reason={toggleBlocked && toggleLabel}>
            <IconButton
              size="sm"
              data-testid={`schedule-${rec.id}-toggle`}
              label={toggleLabel}
              disabled={busy || !!toggleBlocked}
              onClick={() => void run(toggle.run, toggle.done)}
            >
              {toggle.turnsOn ? (
                <Play size={14} strokeWidth={2} />
              ) : (
                <Pause size={14} strokeWidth={2} />
              )}
            </IconButton>
          </WithReason>
          <WithReason reason={runBlocked && runLabel}>
            <IconButton
              size="sm"
              data-testid={`schedule-${rec.id}-run`}
              label={runLabel}
              disabled={busy || !!runBlocked}
              onClick={() => void run(() => runScheduleNow(rec.id), 'Started')}
            >
              <RefreshCw size={14} strokeWidth={2} />
            </IconButton>
          </WithReason>
          <IconButton
            size="sm"
            variant="ghost"
            data-testid={`schedule-${rec.id}-delete`}
            label="Delete"
            disabled={busy}
            className="text-destructive hover:text-destructive"
            onClick={() => {
              void (async () => {
                if (!(await confirmDeleteSchedule(rec))) return
                void run(() => deleteSchedule(rec.id), 'Deleted')
              })()
            }}
          >
            <Trash2 size={14} strokeWidth={2} />
          </IconButton>
        </div>
      ) : (
        <span className="flex-shrink-0 font-mono text-[9.5px] uppercase tracking-[0.14em] text-muted-foreground">
          read-only
        </span>
      )}
    </div>
  )
}

function Section({
  title,
  hint,
  rows,
  onOpen,
  onChanged,
  testId,
}: {
  title: string
  hint: string
  rows: ScheduleRecord[]
  onOpen: (id: string) => void
  onChanged: () => void
  testId: string
}) {
  return (
    <section data-testid={testId}>
      <div className="mb-2.5 flex flex-wrap items-baseline gap-x-2.5 gap-y-0.5">
        <h2 className="font-mono text-[11px] font-semibold uppercase tracking-[0.14em] text-muted-foreground">
          {title}
        </h2>
        <span className="text-[11.5px] text-foreground/45">{hint}</span>
      </div>
      {rows.length > 0 ? (
        <div className="flex flex-col gap-2.5">
          {rows.map((rec) => (
            <RoutineRow
              key={rec.id}
              rec={rec}
              onOpen={() => onOpen(rec.id)}
              onChanged={onChanged}
            />
          ))}
        </div>
      ) : (
        <p className="px-0.5 py-1 text-[12px] text-foreground/40">None yet.</p>
      )}
    </section>
  )
}

// ─── Panel ───────────────────────────────────────────────────────────────────

export function RoutinesPanel() {
  const [schedules, setSchedules] = useState<ScheduleRecord[]>([])
  const [sources, setSources] = useState<ScheduleSourceReadStatus[]>([])
  const [loaded, setLoaded] = useState(false)
  const [directory, setDirectory] = useState<RoutineDirectory>(EMPTY_DIRECTORY)
  const [dialog, setDialog] = useState<RoutineDialogTarget | null>(null)
  const [openTaskId, setOpenTaskId] = useState<string | null>(null)
  const selectedTeamId = useTeamStore((s) => s.selectedTeamId)

  const reads = useReadSequencer()

  const refresh = useCallback(async () => {
    // Every row action and the dialog reconcile through this read, and the
    // Refresh button races the 8s poll. Sequenced last-write-wins so a read
    // issued before a toggle can't land after it and show the pre-toggle state.
    // A read that failed outright keeps the list as it was: clearing it would
    // also close a routine that is open in the dialog.
    const read = reads.beginRead()
    const view = await fetchSchedules()
    if (read.isCurrent() && view.ok) {
      setSchedules(view.schedules)
      setSources(view.sources)
    }
    if (read.isNewestRead()) setLoaded(true)
  }, [reads])

  const refreshDirectory = useCallback(async () => {
    const next = await loadDirectory()
    if (next) setDirectory(next)
  }, [])

  useEffect(() => {
    void refresh()
    void refreshDirectory()
  }, [refresh, refreshDirectory])

  useVisiblePolling(() => void refresh(), 8000)

  const { teamRows, agentRows, gatewayRows } = useMemo(() => {
    const routines = schedules.filter(isClawbooRoutine)
    return {
      teamRows: routines.filter((s) => routineKindOf(s) === 'team').sort(byName),
      agentRows: routines.filter((s) => routineKindOf(s) === 'agent').sort(byName),
      gatewayRows: schedules.filter((s) => !isClawbooRoutine(s)).sort(byName),
    }
  }, [schedules])

  const routineCount = teamRows.length + agentRows.length
  const gatewayStatus = sources.find((s) => s.sourceId === 'openclaw-gateway-cron')
  const hasOpenClawAgents = directory.agents.some((a) => a.runtime === 'openclaw')
  // The Gateway being down is only news to someone who uses OpenClaw.
  const showGatewayNotice =
    !!gatewayStatus?.degraded && (gatewayRows.length > 0 || hasOpenClawAgents)
  const otherDegraded = sources.filter((s) => s.degraded && s.sourceId !== 'openclaw-gateway-cron')

  const viewed =
    dialog?.mode === 'view' ? (schedules.find((s) => s.id === dialog.id) ?? null) : null
  const closeDialog = useCallback(() => setDialog(null), [])

  const openCreate = (): void => {
    void refreshDirectory()
    setDialog({ mode: 'create' })
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
      <PanelHeader
        title="Routines"
        subtitle="Recurring work for your teams and agents"
        icon={Repeat}
        size="md"
        border
        actions={
          <>
            <span className="font-data rounded-full bg-foreground/[0.06] px-2.5 py-0.5 text-[11px] font-semibold text-foreground/55">
              {routineCount} {routineCount === 1 ? 'routine' : 'routines'}
            </span>
            <Button
              variant="primary"
              size="sm"
              data-testid="routine-create-open"
              onClick={openCreate}
            >
              <Plus size={14} strokeWidth={2} /> New routine
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
          {otherDegraded.map((s) => (
            <FormattedAlert key={s.sourceId} tone="warning" icon={AlertTriangle}>
              {`Routines could not be read${s.reason ? ` (${s.reason})` : ''}.`}
            </FormattedAlert>
          ))}

          {loaded && routineCount === 0 && gatewayRows.length === 0 ? (
            <EmptyState
              icon={Repeat}
              title="No routines yet"
              helper="A team routine posts to a team's chat on a schedule, and Boo Zero takes it from there. An agent routine gives one agent a task. Start one with New routine."
            />
          ) : (
            <>
              <Section
                testId="routines-team"
                title="Team routines"
                hint="Posted to the team chat, where Boo Zero takes it from there."
                rows={teamRows}
                onOpen={(id) => setDialog({ mode: 'view', id })}
                onChanged={() => void refresh()}
              />
              <Section
                testId="routines-agent"
                title="Agent routines"
                hint="A task for one agent, with its result on the task card."
                rows={agentRows}
                onOpen={(id) => setDialog({ mode: 'view', id })}
                onChanged={() => void refresh()}
              />
            </>
          )}

          {showGatewayNotice ? (
            <FormattedAlert tone="warning" icon={AlertTriangle}>
              {gatewayStatus?.reason === 'stale_cache'
                ? 'The OpenClaw Gateway is not connected, so its own cron jobs below are the last list it sent.'
                : 'The OpenClaw Gateway is not connected, so its own cron jobs are hidden until it reconnects.'}
            </FormattedAlert>
          ) : null}

          {gatewayRows.length > 0 ? (
            <Section
              testId="routines-gateway"
              title="OpenClaw's own cron jobs"
              hint="Scheduled on the OpenClaw Gateway for its agents."
              rows={gatewayRows}
              onOpen={(id) => setDialog({ mode: 'view', id })}
              onChanged={() => void refresh()}
            />
          ) : null}
        </div>
      </div>

      {dialog ? (
        <RoutineDialog
          key={dialog.mode === 'view' ? dialog.id : 'create'}
          target={dialog}
          record={viewed}
          directory={directory}
          preferredTeamId={selectedTeamId}
          onClose={closeDialog}
          onChanged={() => void refresh()}
          onOpenTask={setOpenTaskId}
        />
      ) : null}

      {openTaskId
        ? createPortal(
            // Above the routine dialog (80), below the confirm dialog (90) that a
            // status change in the drawer can raise.
            <TaskDetailDrawer taskId={openTaskId} layer={85} onClose={() => setOpenTaskId(null)} />,
            document.body,
          )
        : null}
    </div>
  )
}
