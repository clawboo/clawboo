// The routine dialog: one surface to create a routine, read one, and edit it.
//
// A routine goes to a TEAM or to one AGENT. A team routine posts its
// instructions into the team's group chat, where the team's lead (Boo Zero)
// answers or brings in teammates, so everything it does lands in that chat and
// on the team's board. An agent routine is a board task for one agent; its
// result is on the task card, which the team chat shows as well.
//
// Portalled to <body> above the Settings modal (z-70), where this view usually
// lives: the modal's glass container would otherwise clip a fixed overlay to its
// own box.

import { useEffect, useId, useMemo, useState } from 'react'
import type { ReactNode } from 'react'
import { createPortal } from 'react-dom'
import {
  Bot,
  MessageSquare,
  Pause,
  Pencil,
  Play,
  RefreshCw,
  Trash2,
  Users,
  X,
  type LucideIcon,
} from 'lucide-react'

import { Button, IconButton } from '@/features/shared/Button'
import { Chip } from '@/features/shared/Chip'
import { Modal } from '@/features/shared/Modal'
import { SegmentedControl } from '@/features/shared/SegmentedControl'
import { Select, type SelectOption } from '@/features/shared/Select'
import { StatusPill } from '@/features/shared/StatusPill'
import { formatRelative } from '@/lib/formatRelative'
import {
  createSchedule,
  deleteSchedule,
  fetchRoutineRuns,
  pauseSchedule,
  resumeSchedule,
  runScheduleNow,
  updateSchedule,
  type RoutineRun,
  type ScheduleActionResult,
  type ScheduleRecord,
} from '@/lib/schedulesClient'
import { confirm } from '@/stores/confirm'
import { useSettingsModalStore } from '@/stores/settingsModal'
import { useTeamStore } from '@/stores/team'
import { useToastStore } from '@/stores/toast'
import { useViewStore } from '@/stores/view'

import {
  agentsForTeam,
  buildRoutineCreateSpec,
  buildRoutinePatch,
  cronError,
  CRON_PRESETS,
  emptyRoutineForm,
  formatDuration,
  formatWhen,
  humanCron,
  isClawbooRoutine,
  isCronPreset,
  NO_TEAM,
  nextRunPreview,
  routineFormFromRecord,
  routineFormProblem,
  routineKindOf,
  runNowBlocker,
  runPill,
  runtimeDisplayName,
  sortedTeams,
  statusPill,
  targetSummary,
  toggleBlocker,
  untilLabel,
  type RoutineDirectoryAgent,
  type RoutineDirectoryTeam,
  type RoutineFormValues,
} from './routineHelpers'

/** The teams and agents a routine can be pointed at. */
export interface RoutineDirectory {
  teams: RoutineDirectoryTeam[]
  agents: RoutineDirectoryAgent[]
  /** The install's Boo Zero, which leads every team chat when present. */
  booZeroName: string | null
}

const FIELD_LABEL =
  'mb-1.5 block font-mono text-[10px] font-semibold uppercase tracking-[0.14em] text-muted-foreground'
const INPUT_CLASS =
  'w-full rounded-lg border border-border bg-surface px-3 text-[13.5px] text-foreground ' +
  'outline-none transition placeholder:text-foreground/35 ' +
  'focus:border-primary focus:ring-4 focus:ring-primary/15 disabled:opacity-50'
const HINT = 'mt-1.5 text-[11.5px] leading-relaxed text-foreground/50'

// ─── The form ────────────────────────────────────────────────────────────────

function RoutineForm({
  initial,
  directory,
  preferredTeamId,
  isNew,
  busy,
  submitLabel,
  onSubmit,
  onCancel,
}: {
  initial: RoutineFormValues
  directory: RoutineDirectory
  /** The team a new routine starts on when nothing is chosen yet. */
  preferredTeamId?: string | null
  isNew: boolean
  busy: boolean
  submitLabel: string
  onSubmit: (values: RoutineFormValues) => void
  onCancel: () => void
}) {
  const [values, setValues] = useState<RoutineFormValues>(initial)
  const [custom, setCustom] = useState(() => !isCronPreset(initial.cron))
  const ids = { team: useId(), agent: useId(), name: useId(), what: useId(), cron: useId() }

  const teams = useMemo(() => sortedTeams(directory.teams), [directory.teams])
  const defaultTeamId =
    preferredTeamId && teams.some((t) => t.id === preferredTeamId) ? preferredTeamId : teams[0]?.id
  const hasTeamlessAgents = directory.agents.some((a) => a.teamId == null)
  const teamAgents = useMemo(
    () => agentsForTeam(directory.agents, values.teamId),
    [directory.agents, values.teamId],
  )

  const set = (patch: Partial<RoutineFormValues>): void => setValues((v) => ({ ...v, ...patch }))

  // The directory can arrive after the form opens. Until something is chosen,
  // follow it: the team being looked at (else the first team), and for an agent
  // routine that team's first agent.
  useEffect(() => {
    if (values.teamId) return
    const teamId = defaultTeamId ?? (values.kind === 'agent' && hasTeamlessAgents ? NO_TEAM : '')
    if (!teamId) return
    setValues((v) =>
      v.teamId
        ? v
        : {
            ...v,
            teamId,
            agentId:
              v.kind === 'agent' ? (agentsForTeam(directory.agents, teamId)[0]?.id ?? '') : '',
          },
    )
  }, [defaultTeamId, hasTeamlessAgents, directory.agents, values.teamId, values.kind])
  useEffect(() => {
    if (values.kind !== 'agent' || values.agentId) return
    const first = agentsForTeam(directory.agents, values.teamId)[0]?.id
    if (first) setValues((v) => (v.agentId ? v : { ...v, agentId: first }))
  }, [directory.agents, values.kind, values.teamId, values.agentId])

  const chooseKind = (kind: 'team' | 'agent'): void => {
    if (kind === values.kind) return
    if (kind === 'team') {
      const teamId =
        values.teamId && values.teamId !== NO_TEAM ? values.teamId : (defaultTeamId ?? '')
      set({ kind, teamId })
      return
    }
    const teamId = values.teamId || defaultTeamId || (hasTeamlessAgents ? NO_TEAM : '')
    set({ kind, teamId, agentId: agentsForTeam(directory.agents, teamId)[0]?.id ?? '' })
  }

  const chooseTeam = (teamId: string): void => {
    if (values.kind === 'agent') {
      set({ teamId, agentId: agentsForTeam(directory.agents, teamId)[0]?.id ?? '' })
    } else {
      set({ teamId })
    }
  }

  const teamOptions: SelectOption[] = teams.map((t) => ({
    value: t.id,
    label: `${t.icon} ${t.name}`.trim(),
  }))
  if (values.kind === 'agent' && hasTeamlessAgents)
    teamOptions.push({ value: NO_TEAM, label: 'No team (standalone agents)' })
  if (values.teamId && !teamOptions.some((o) => o.value === values.teamId))
    teamOptions.push({ value: values.teamId, label: 'A team that no longer exists' })
  if (teamOptions.length === 0) teamOptions.push({ value: '', label: 'No teams yet' })

  const agentOptions: SelectOption[] = teamAgents.map((a) => ({
    value: a.id,
    label: `${a.name} · ${runtimeDisplayName(a.runtime)}`,
  }))
  if (values.agentId && !agentOptions.some((o) => o.value === values.agentId))
    agentOptions.push({ value: values.agentId, label: 'An agent that is no longer on this team' })
  if (agentOptions.length === 0) agentOptions.push({ value: '', label: 'No agents on this team' })

  const chosenTeam = teams.find((t) => t.id === values.teamId)
  const teamIsEmpty =
    values.kind === 'team' &&
    !!chosenTeam &&
    agentsForTeam(directory.agents, chosenTeam.id).length === 0

  const checkSchedule = isNew || values.cron.trim() !== initial.cron.trim()
  const problem = routineFormProblem(values, { checkSchedule })
  const scheduleProblem = checkSchedule ? cronError(values.cron) : null
  const next = scheduleProblem ? null : nextRunPreview(values.cron)
  const lead = directory.booZeroName ?? "the team's lead"

  return (
    <form
      className="flex min-h-0 flex-1 flex-col"
      onSubmit={(e) => {
        e.preventDefault()
        if (!problem && !busy) onSubmit(values)
      }}
    >
      <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto px-5 pb-2 pt-1">
        <div>
          <span className={FIELD_LABEL}>Who it is for</span>
          <SegmentedControl<'team' | 'agent'>
            size="sm"
            aria-label="Who the routine is for"
            value={values.kind}
            onChange={chooseKind}
            options={[
              { id: 'team', label: 'A team task', icon: Users },
              { id: 'agent', label: 'An agent task', icon: Bot },
            ]}
          />
          <p className={HINT}>
            {values.kind === 'team'
              ? `Posted to the team's group chat, where ${lead} picks it up and brings in teammates as needed.`
              : 'A task for one agent on its team board. The result shows on the task card, which also appears in the team chat.'}
          </p>
        </div>

        <div className={values.kind === 'agent' ? 'grid grid-cols-2 gap-3' : ''}>
          <div className="min-w-0">
            <label htmlFor={ids.team} className={FIELD_LABEL}>
              Team
            </label>
            <Select
              id={ids.team}
              data-testid="routine-team"
              aria-label="Team"
              value={values.teamId}
              onChange={chooseTeam}
              options={teamOptions}
              disabled={busy || teams.length + (hasTeamlessAgents ? 1 : 0) === 0}
              style={{ width: '100%' }}
            />
          </div>
          {values.kind === 'agent' ? (
            <div className="min-w-0">
              <label htmlFor={ids.agent} className={FIELD_LABEL}>
                Agent
              </label>
              <Select
                id={ids.agent}
                data-testid="routine-agent"
                aria-label="Agent"
                value={values.agentId}
                onChange={(agentId) => set({ agentId })}
                options={agentOptions}
                disabled={busy || teamAgents.length === 0}
                style={{ width: '100%' }}
              />
            </div>
          ) : null}
        </div>
        {teamIsEmpty ? (
          <p className="-mt-2 text-[11.5px] text-[var(--amber)]">
            This team has no members yet, so nobody would pick the routine up.
          </p>
        ) : null}

        <div>
          <label htmlFor={ids.what} className={FIELD_LABEL}>
            What should happen
          </label>
          <textarea
            id={ids.what}
            data-testid="routine-instructions"
            className={`${INPUT_CLASS} resize-y py-2 leading-relaxed`}
            rows={4}
            maxLength={20_000}
            value={values.instructions}
            onChange={(e) => set({ instructions: e.target.value })}
            disabled={busy}
            placeholder={
              values.kind === 'team'
                ? 'Summarize what the team finished yesterday and flag anything that is blocked.'
                : 'Check the support inbox and draft replies to anything urgent.'
            }
          />
        </div>

        <div>
          <label htmlFor={ids.name} className={FIELD_LABEL}>
            Name <span className="normal-case tracking-normal text-foreground/35">(optional)</span>
          </label>
          <input
            id={ids.name}
            data-testid="routine-name"
            className={`${INPUT_CLASS} h-9`}
            maxLength={200}
            value={values.name}
            onChange={(e) => set({ name: e.target.value })}
            disabled={busy}
            placeholder="Morning briefing"
          />
        </div>

        <div>
          <span className={FIELD_LABEL}>Runs</span>
          <div className="flex flex-wrap gap-1.5">
            {CRON_PRESETS.map((p) => (
              <Chip
                key={p.cron}
                size="sm"
                active={!custom && values.cron.trim() === p.cron}
                onClick={() => {
                  setCustom(false)
                  set({ cron: p.cron })
                }}
              >
                {p.label}
              </Chip>
            ))}
            <Chip size="sm" active={custom} onClick={() => setCustom(true)}>
              Custom
            </Chip>
          </div>
          {custom ? (
            <div className="mt-2.5">
              <label htmlFor={ids.cron} className="sr-only">
                Cron expression
              </label>
              <input
                id={ids.cron}
                data-testid="routine-cron"
                className={`${INPUT_CLASS} font-data h-9`}
                value={values.cron}
                onChange={(e) => set({ cron: e.target.value })}
                disabled={busy}
                placeholder="30 8 * * 1-5"
                spellCheck={false}
                autoComplete="off"
              />
              <p className={HINT}>
                Minute, hour, day of month, month, day of week. For example, 30 8 * * 1-5 is 8:30 on
                weekdays.
              </p>
            </div>
          ) : null}
          {scheduleProblem ? (
            <p role="alert" className="mt-1.5 text-[11.5px] text-destructive">
              {scheduleProblem}
            </p>
          ) : next != null ? (
            <p className={HINT} data-testid="routine-next-preview">
              Next run: {formatWhen(next)}
            </p>
          ) : null}
        </div>
      </div>

      <div className="flex items-center justify-end gap-2 border-t border-border px-5 py-3.5">
        {/* What is still missing, said where the disabled button is. A schedule
            problem is already shown under the schedule itself. */}
        {problem && !scheduleProblem ? (
          <span
            data-testid="routine-form-hint"
            className="mr-auto text-[11.5px] text-foreground/50"
          >
            {problem}
          </span>
        ) : null}
        <Button variant="secondary" size="sm" onClick={onCancel} disabled={busy}>
          Cancel
        </Button>
        <Button
          type="submit"
          variant="primary"
          size="sm"
          data-testid="routine-submit"
          loading={busy}
          disabled={!!problem || busy}
        >
          {submitLabel}
        </Button>
      </div>
    </form>
  )
}

// ─── The detail view ─────────────────────────────────────────────────────────

function DetailRow({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="grid grid-cols-[112px_minmax(0,1fr)] gap-3 py-2">
      <span className="pt-0.5 font-mono text-[10px] font-semibold uppercase tracking-[0.14em] text-muted-foreground">
        {label}
      </span>
      <div className="min-w-0 text-[13px] leading-relaxed text-foreground">{children}</div>
    </div>
  )
}

/**
 * A disabled button takes no pointer events, so the reason it is disabled rides
 * a wrapper that does. Always rendered, so the button never remounts (and never
 * drops focus) when the reason comes and goes.
 */
export function WithReason({ reason, children }: { reason: string | null; children: ReactNode }) {
  return (
    <span className="inline-flex" title={reason ?? undefined}>
      {children}
    </span>
  )
}

function ActionButton({
  icon: Icon,
  label,
  onClick,
  disabled,
  testId,
  danger,
}: {
  icon: LucideIcon
  label: string
  onClick: () => void
  disabled?: boolean
  testId: string
  danger?: boolean
}) {
  return (
    <Button
      variant={danger ? 'ghost' : 'secondary'}
      size="sm"
      onClick={onClick}
      disabled={disabled}
      data-testid={testId}
      className={danger ? 'text-destructive hover:text-destructive' : ''}
    >
      <Icon size={13} strokeWidth={2} />
      {label}
    </Button>
  )
}

function RunsList({
  record,
  onOpenTask,
}: {
  record: ScheduleRecord
  onOpenTask: (taskId: string) => void
}) {
  const [runs, setRuns] = useState<RoutineRun[] | null | undefined>(undefined)
  const kind = routineKindOf(record)
  // Re-read whenever the routine moves (a fire starts or lands), so the list
  // follows the 8s refresh of the view behind it.
  const { id, status, lastRunAt } = record
  useEffect(() => {
    let alive = true
    void fetchRoutineRuns(id).then((r) => {
      if (alive) setRuns(r)
    })
    return () => {
      alive = false
    }
  }, [id, status, lastRunAt])

  if (runs === undefined) {
    return <p className="text-[12px] text-foreground/45">Loading runs...</p>
  }
  if (runs === null) {
    return <p className="text-[12px] text-foreground/45">Could not load the run history.</p>
  }
  if (runs.length === 0) {
    return <p className="text-[12px] text-foreground/45">It has not run yet.</p>
  }
  return (
    <ul data-testid="routine-runs" className="flex flex-col">
      {runs.map((run) => {
        const pill = runPill(run.status, kind)
        return (
          <li
            key={`${run.firedAt}-${run.taskId ?? ''}`}
            className="flex items-start gap-3 border-t border-border py-2.5 first:border-t-0"
          >
            <div className="w-[92px] flex-shrink-0 pt-0.5">
              <StatusPill tone={pill.tone} label={pill.label} />
            </div>
            <div className="min-w-0 flex-1">
              <div className="text-[12.5px] text-foreground/80">
                <time title={formatWhen(run.firedAt)}>{formatRelative(run.firedAt)}</time>
                {run.finishedAt != null ? (
                  <span className="text-foreground/45">
                    {' '}
                    · took {formatDuration(run.finishedAt - run.firedAt)}
                  </span>
                ) : null}
              </div>
              {run.task ? (
                <div className="mt-0.5 truncate text-[11.5px] text-foreground/55">
                  {run.task.title} · {run.task.status.replace('_', ' ')}
                </div>
              ) : kind === 'team' && run.status === 'succeeded' ? (
                <div className="mt-0.5 text-[11.5px] text-foreground/55">
                  Posted to the team chat.
                </div>
              ) : null}
              {run.error ? (
                <div className="mt-0.5 break-words text-[11.5px] text-destructive">{run.error}</div>
              ) : null}
            </div>
            {run.task ? (
              <Button
                variant="ghost"
                size="sm"
                onClick={() => onOpenTask(run.task!.id)}
                data-testid={`routine-run-task-${run.task.id}`}
              >
                View task
              </Button>
            ) : null}
          </li>
        )
      })}
    </ul>
  )
}

function RoutineDetails({
  record,
  busy,
  onEdit,
  onToggle,
  onRun,
  onDelete,
  onOpenTask,
  onOpenTeamChat,
}: {
  record: ScheduleRecord
  busy: boolean
  onEdit: () => void
  onToggle: () => void
  onRun: () => void
  onDelete: () => void
  onOpenTask: (taskId: string) => void
  onOpenTeamChat: (teamId: string) => void
}) {
  const routine = isClawbooRoutine(record)
  const kind = routineKindOf(record)
  const writable = record.manageability !== 'observe-only'
  const toggle = toggleSchedule(record)
  const toggleBlocked = toggleBlocker(record)
  const runBlocked = runNowBlocker(record)

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="min-h-0 flex-1 overflow-y-auto px-5 pb-4">
        {record.status === 'error' && routine ? (
          <div
            role="status"
            className="mb-3 rounded-xl border px-3.5 py-2.5 text-[12.5px] leading-relaxed"
            style={{
              borderColor: 'rgb(var(--primary-rgb) / 0.3)',
              background: 'rgb(var(--primary-rgb) / 0.06)',
            }}
          >
            <span className="font-semibold text-foreground">Stopped after a failed run.</span>{' '}
            <span className="text-foreground/70">
              It will not run again until you resume it.
              {record.lastError ? ` The error was: ${record.lastError}` : ''}
            </span>
          </div>
        ) : null}

        <DetailRow label={routine ? 'Sends to' : 'Agent'}>
          <div className="flex flex-wrap items-center gap-2">
            <span>
              {routine
                ? targetSummary(record)
                : `${record.agentName ?? record.agentId} · ${runtimeDisplayName(record.runtime)}`}
            </span>
            {routine && kind === 'team' && record.teamId && record.teamName ? (
              <Button
                variant="ghost"
                size="sm"
                data-testid="routine-open-chat"
                onClick={() => onOpenTeamChat(record.teamId!)}
              >
                <MessageSquare size={13} strokeWidth={2} />
                Open team chat
              </Button>
            ) : null}
          </div>
          {routine && kind === 'agent' ? (
            <p className="mt-0.5 text-[11.5px] text-foreground/50">
              Runs on {runtimeDisplayName(record.runtime)}. Each run is a task on the board.
            </p>
          ) : null}
          {!routine ? (
            <p className="mt-0.5 text-[11.5px] text-foreground/50">
              This job belongs to the OpenClaw Gateway and runs in the agent&apos;s own sessions
              there, not in a team chat.
            </p>
          ) : null}
        </DetailRow>

        {routine ? (
          <DetailRow label="What happens">
            {record.description ? (
              <p className="whitespace-pre-wrap break-words">{record.description}</p>
            ) : (
              <p className="text-foreground/55">
                No instructions. Each run sends the name: &ldquo;{record.label}&rdquo;.
              </p>
            )}
          </DetailRow>
        ) : null}

        <DetailRow label="Schedule">
          <span>{humanCron(record.cronSpec)}</span>
          <span className="text-foreground/50">
            {record.nextRunAt != null
              ? ` · next ${untilLabel(record.nextRunAt)} (${formatWhen(record.nextRunAt)})`
              : record.status === 'paused'
                ? ' · paused'
                : ' · not scheduled'}
          </span>
        </DetailRow>

        <DetailRow label="Last run">
          {record.lastRunAt != null ? (
            <span title={formatWhen(record.lastRunAt)}>{formatRelative(record.lastRunAt)}</span>
          ) : (
            <span className="text-foreground/50">Never</span>
          )}
          {!routine && record.lastError ? (
            <p className="mt-0.5 break-words text-[11.5px] text-destructive">{record.lastError}</p>
          ) : null}
        </DetailRow>

        {routine ? (
          <div className="mt-3">
            <div className="mb-1 font-mono text-[10px] font-semibold uppercase tracking-[0.14em] text-muted-foreground">
              Recent runs
            </div>
            <RunsList record={record} onOpenTask={onOpenTask} />
          </div>
        ) : null}
      </div>

      {writable ? (
        <div className="flex flex-wrap items-center gap-2 border-t border-border px-5 py-3.5">
          {routine ? (
            <ActionButton
              icon={Pencil}
              label="Edit"
              testId="routine-edit"
              onClick={onEdit}
              disabled={busy}
            />
          ) : null}
          <WithReason reason={toggleBlocked && `${toggle.label} (${toggleBlocked})`}>
            <ActionButton
              icon={toggle.turnsOn ? Play : Pause}
              label={toggle.label}
              testId="routine-toggle"
              onClick={onToggle}
              disabled={busy || !!toggleBlocked}
            />
          </WithReason>
          <WithReason reason={runBlocked && `Run now (${runBlocked})`}>
            <ActionButton
              icon={RefreshCw}
              label="Run now"
              testId="routine-run"
              onClick={onRun}
              disabled={busy || !!runBlocked}
            />
          </WithReason>
          <div className="flex-1" />
          <ActionButton
            icon={Trash2}
            label="Delete"
            testId="routine-delete"
            onClick={onDelete}
            disabled={busy}
            danger
          />
        </div>
      ) : (
        <div className="border-t border-border px-5 py-3.5 text-[12px] text-foreground/50">
          Read-only: this schedule is managed elsewhere.
        </div>
      )}
    </div>
  )
}

// ─── The dialog ──────────────────────────────────────────────────────────────

export type RoutineDialogTarget = { mode: 'create' } | { mode: 'view'; id: string }

/** The shared action runner: toast the outcome, then refresh the list. */
async function act(
  action: () => Promise<ScheduleActionResult>,
  success: string,
  onChanged: () => void,
): Promise<boolean> {
  const addToast = useToastStore.getState().addToast
  const result = await action()
  if (result.ok) {
    addToast({ message: success, type: 'success' })
    onChanged()
    return true
  }
  addToast({ message: result.error ?? 'That did not work.', type: 'error' })
  return false
}

export function confirmDeleteSchedule(record: ScheduleRecord): Promise<boolean> {
  const routine = isClawbooRoutine(record)
  return confirm({
    title: routine ? 'Delete this routine?' : 'Delete this Gateway cron job?',
    message: routine
      ? 'It stops running and is removed. Tasks and messages it already produced stay.'
      : "It removes the agent's own scheduled job from the OpenClaw Gateway.",
    confirmLabel: 'Delete',
    tone: 'danger',
  })
}

/**
 * The on/off action a row offers. A Gateway job is enabled or disabled. A
 * routine is paused, or resumed from paused, and a routine stopped by a failed
 * run is resumed too: that is what re-arms it.
 */
export function toggleSchedule(record: ScheduleRecord): {
  run: () => Promise<ScheduleActionResult>
  /** The button's label. */
  label: string
  /** The toast once it worked. */
  done: string
  /** Whether it turns the schedule back on (a play icon) or off (pause). */
  turnsOn: boolean
} {
  if (record.manageability === 'external-write') {
    return record.status === 'paused'
      ? { run: () => resumeSchedule(record.id), label: 'Enable', done: 'Enabled', turnsOn: true }
      : { run: () => pauseSchedule(record.id), label: 'Disable', done: 'Disabled', turnsOn: false }
  }
  return record.status === 'paused' || record.status === 'error'
    ? { run: () => resumeSchedule(record.id), label: 'Resume', done: 'Resumed', turnsOn: true }
    : { run: () => pauseSchedule(record.id), label: 'Pause', done: 'Paused', turnsOn: false }
}

export function RoutineDialog({
  target,
  record,
  directory,
  preferredTeamId,
  onClose,
  onChanged,
  onOpenTask,
}: {
  target: RoutineDialogTarget
  /** The routine being viewed, as last read. Null while viewing means it is gone. */
  record: ScheduleRecord | null
  directory: RoutineDirectory
  /** A new routine starts on this team (the one being looked at), when it exists. */
  preferredTeamId?: string | null
  onClose: () => void
  onChanged: () => void
  onOpenTask: (taskId: string) => void
}) {
  const headingId = useId()
  // What the form starts from, captured once when it opens: the list behind this
  // dialog refreshes every few seconds, and that must not reset what is being
  // typed. Null while reading an existing routine.
  const [seed, setSeed] = useState<RoutineFormValues | null>(() =>
    target.mode === 'create' ? emptyRoutineForm(directory.teams, preferredTeamId) : null,
  )
  const editing = seed !== null
  const [busy, setBusy] = useState(false)

  // Deleted elsewhere (or by the delete below): nothing left to show.
  const gone = target.mode === 'view' && record === null
  useEffect(() => {
    if (gone) onClose()
  }, [gone, onClose])

  const run = async (action: () => Promise<ScheduleActionResult>, done: string) => {
    setBusy(true)
    const ok = await act(action, done, onChanged)
    setBusy(false)
    return ok
  }

  const openTeamChat = (teamId: string): void => {
    useSettingsModalStore.getState().close()
    useTeamStore.getState().selectTeam(teamId)
    useViewStore.getState().openGroupChat(teamId)
    onClose()
  }

  const title =
    target.mode === 'create'
      ? 'New routine'
      : editing
        ? 'Edit routine'
        : (record?.label ?? record?.agentName ?? 'Routine')
  const pill = record && !editing ? statusPill(record) : null

  let body: ReactNode = null
  if (target.mode === 'create' && seed) {
    body = (
      <RoutineForm
        initial={seed}
        directory={directory}
        preferredTeamId={preferredTeamId}
        isNew
        busy={busy}
        submitLabel="Create routine"
        onCancel={onClose}
        onSubmit={(values) => {
          void run(() => createSchedule(buildRoutineCreateSpec(values)), 'Routine created').then(
            (ok) => {
              if (ok) onClose()
            },
          )
        }}
      />
    )
  } else if (record && seed) {
    body = (
      <RoutineForm
        initial={seed}
        directory={directory}
        isNew={false}
        busy={busy}
        submitLabel="Save changes"
        onCancel={() => setSeed(null)}
        onSubmit={(values) => {
          const patch = buildRoutinePatch(seed, values)
          if (!patch) {
            setSeed(null)
            return
          }
          void run(() => updateSchedule(record.id, patch), 'Routine saved').then((ok) => {
            if (ok) setSeed(null)
          })
        }}
      />
    )
  } else if (record) {
    const toggle = toggleSchedule(record)
    body = (
      <RoutineDetails
        record={record}
        busy={busy}
        onEdit={() => setSeed(routineFormFromRecord(record))}
        onToggle={() => void run(toggle.run, toggle.done)}
        onRun={() => void run(() => runScheduleNow(record.id), 'Started')}
        onDelete={() => {
          void (async () => {
            if (!(await confirmDeleteSchedule(record))) return
            const ok = await run(() => deleteSchedule(record.id), 'Deleted')
            if (ok) onClose()
          })()
        }}
        onOpenTask={onOpenTask}
        onOpenTeamChat={openTeamChat}
      />
    )
  }

  if (gone) return null

  return createPortal(
    <Modal
      open
      layer={80}
      // Edit, Save and Cancel each swap out the button that had focus: move it back
      // into the dialog instead of leaving it on <body>.
      focusKey={editing}
      labelledBy={headingId}
      onClose={onClose}
      dismissible={!busy}
      data-testid="routine-dialog"
      panelClassName="surface-overlay-tier flex max-h-[88vh] w-full max-w-[560px] flex-col overflow-hidden rounded-2xl"
    >
      <div className="flex items-start justify-between gap-3 px-5 pb-3 pt-5">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <h2
              id={headingId}
              className="truncate text-[15px] font-semibold text-foreground"
              style={{ letterSpacing: '-0.01em' }}
            >
              {title}
            </h2>
            {pill ? <StatusPill tone={pill.tone} label={pill.label} /> : null}
          </div>
          {target.mode === 'create' ? (
            <p className="mt-1 text-[12.5px] leading-relaxed text-foreground/55">
              Recurring work for a team or one agent, on a schedule.
            </p>
          ) : null}
        </div>
        <IconButton size="sm" variant="ghost" label="Close" onClick={onClose} disabled={busy}>
          <X size={16} strokeWidth={2} />
        </IconButton>
      </div>
      {body}
    </Modal>,
    document.body,
  )
}
