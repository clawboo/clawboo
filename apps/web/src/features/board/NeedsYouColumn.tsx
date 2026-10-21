import {
  createContext,
  useContext,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
  type RefObject,
} from 'react'
import {
  AnimatePresence,
  motion,
  useIsPresent,
  useReducedMotion,
  type Transition,
} from 'framer-motion'
import { AlertTriangle, CheckCircle2, ChevronRight, RotateCcw, ShieldAlert } from 'lucide-react'
import { delegationTargetOf } from '@clawboo/board-core'
import { BooAvatar } from '@clawboo/ui'

import { AgentBooAvatar } from '@/components/AgentBooAvatar'
import { InlineApprovalCard } from '@/features/approvals/InlineApprovalCard'
import { ToolApprovalCard } from '@/features/approvals/ToolApprovalCard'
import { usePendingApprovals, type ToolApproval } from '@/features/approvals/usePendingApprovals'
import { Button } from '@/features/shared/Button'
import { StatusPill } from '@/features/shared/StatusPill'
import type { BoardTask } from '@/lib/boardClient'
import type { ApprovalRequest } from '@/stores/approvals'
import { useFleetStore } from '@/stores/fleet'
import { useTeamStore } from '@/stores/team'

import { AssignAgentSelect } from './AssignAgentSelect'
import {
  ATTENTION_META,
  attentionLabel,
  taskAttentionOf,
  type AttentionReason,
  type TaskAttention,
} from './boardStatus'
import { countLabel, dayMonth, longDate, timeLabel } from './calendar/calendarFormat'
import { isSameDay } from './calendar/calendarModel'
import { useTaskActions } from './useTaskActions'

// ─── NeedsYouColumn ────────────────────────────────────────────────────────
// The Board's first column: everything that is waiting on a PERSON to move.
//   • Approvals: an agent wants to run a command, call a risky tool, or make a
//     risky delegation (OpenClaw exec + MCP tool/delegation approvals).
//   • Tasks nothing will move by themselves: a run that failed or timed out, one
//     the user stopped, one verification could not pass, one an agent marked
//     blocked, and one no agent is bound to. Each names why it waits, and
//     offers the action that gets it going again.
//
// Always expanded, like every other column: an empty "Needs you" is good news
// worth seeing, not something to fold away.
//
// Three pieces: `useNeedsYou` gathers the items (one approvals poll for the whole
// board), `NeedsYouItems` draws them, and `NeedsYouLane` is the column the board
// shows before it can draw the calendar: while tasks load, when the read fails,
// and on an empty board. The calendar draws the same items in today's row.

const SECTION_LABEL =
  'font-mono text-[11px] font-semibold uppercase tracking-[0.14em] text-muted-foreground'
// Names the approvals and the tasks apart, so it shows only when both are there.
const GROUP_LABEL = 'flex items-center gap-1.5 px-1 text-[11px] font-semibold text-muted-foreground'

// The calendar chip's actions: quiet words, not buttons in boxes. They stay
// visible, since a card waiting on a person should say what the person can do.
// While an action is out they are aria-disabled rather than disabled, so the
// button keeps focus instead of dropping it to the page.
const QUIET_ACTION =
  'inline-flex h-6 shrink-0 cursor-pointer items-center gap-1 rounded-[4px] px-1.5 text-[11.5px] font-semibold transition-colors hover:bg-amber/12 focus-visible:outline-2 focus-visible:outline-offset-1 aria-disabled:cursor-default aria-disabled:opacity-50 aria-disabled:hover:bg-transparent'
// The same for the lane's buttons.
const BUSY_BUTTON = 'aria-disabled:cursor-default aria-disabled:opacity-45'
// The chip's last line, under an amber hairline (a neutral one in dark mode).
const CHIP_FOOTER =
  'mt-2 flex items-center gap-1.5 border-t border-[color-mix(in_srgb,var(--amber)_14%,transparent)] pt-1.5 text-[11px] text-muted-foreground dark:border-[rgb(255_255_255/0.06)]'
const AMBER_CHIP = { '--chip': 'var(--amber)' } as CSSProperties

// How a card or a group row leaves once it no longer needs the person: it fades
// and its height closes, so what is below slides up instead of jumping.
const LEAVE_EASE = [0.32, 0.72, 0, 1] as const
function leaveTransition(reduced: boolean): Transition {
  return { duration: reduced ? 0 : 0.2, ease: LEAVE_EASE }
}

/** Why a task waits, in Needs you's amber: a warning mark for a run that broke
 *  (failed, timed out), a dot for everything else, then the words. */
function ReasonLabel({ reason, label }: { reason: AttentionReason; label: string }) {
  const broke = reason === 'failed' || reason === 'timed_out'
  return (
    <span className="board-reason inline-flex shrink-0 items-center gap-1 whitespace-nowrap text-[11px] font-semibold leading-4">
      {broke ? (
        <AlertTriangle size={11} strokeWidth={2.4} aria-hidden className="shrink-0" />
      ) : (
        <span aria-hidden className="size-1.5 shrink-0 rounded-full bg-amber" />
      )}
      <span>{label}</span>
    </span>
  )
}

export type ApprovalItem =
  | { key: string; ts: number; kind: 'exec'; exec: ApprovalRequest }
  | { key: string; ts: number; kind: 'tool'; tool: ToolApproval }

/** Which agent a stuck task belongs to: the one working it, else the one it is
 *  bound to (a released task keeps its binding but loses its assignee). */
function agentOf(task: BoardTask): string | null {
  const assignee = typeof task.assigneeAgentId === 'string' ? task.assigneeAgentId : null
  const sdid = typeof task['sourceDelegationId'] === 'string' ? task['sourceDelegationId'] : null
  return assignee ?? delegationTargetOf(sdid)
}

/** Retry needs somebody to hand the task back to; a task nobody is bound to
 *  needs a person to pick who, so it offers the team's agents instead. */
function canRetryTask(task: BoardTask, attention: TaskAttention): boolean {
  if (attention.reason === 'unassigned') return false
  if (typeof task.teamId !== 'string' || !task.teamId) return false
  const sdid = typeof task['sourceDelegationId'] === 'string' ? task['sourceDelegationId'] : null
  return !!delegationTargetOf(sdid)
}

/** When it started waiting: the task's last change is the move that stranded it. */
function waitingSince(task: BoardTask): number | null {
  return typeof task.updatedAt === 'number' && task.updatedAt > 0 ? task.updatedAt : null
}

function waitingTitle(since: number | null): string | null {
  return since ? `Waiting since ${longDate(since)}, ${timeLabel(since)}` : null
}

// ─── One card per cause ────────────────────────────────────────────────────
// Several tasks that broke the same way (three runs that all hit "model not
// found") are one problem, so the calendar shows them as one card. The cause is
// the reported detail with what changes from run to run (ids, timestamps)
// taken out; tasks with no reported detail stay on cards of their own.

type StuckItem = { task: BoardTask; attention: TaskAttention }

type StuckEntry =
  | ({ kind: 'task'; key: string } & StuckItem)
  | {
      kind: 'group'
      key: string
      reason: AttentionReason
      /** The words the card leads with. */
      cause: string
      items: StuckItem[]
    }

const UUID_RE = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi
const ISO_TIME_RE =
  /\b\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})?/g

const collapse = (text: string) => text.replace(/\s+/g, ' ').trim()

/** A detail with its run-specific parts replaced by an ellipsis, so two runs
 *  that failed the same way read the same. */
function causeOf(detail: string): string {
  return collapse(detail.replace(UUID_RE, '…').replace(ISO_TIME_RE, '…'))
}

function stuckEntries(stuck: StuckItem[], group: boolean): StuckEntry[] {
  const single = (s: StuckItem): StuckEntry => ({ kind: 'task', key: s.task.id, ...s })
  if (!group) return stuck.map(single)
  const keyOf = (s: StuckItem) =>
    s.attention.detail ? `${s.attention.reason}:${causeOf(s.attention.detail)}` : null
  const members = new Map<string, StuckItem[]>()
  for (const s of stuck) {
    const key = keyOf(s)
    if (!key) continue
    const list = members.get(key)
    if (list) list.push(s)
    else members.set(key, [s])
  }
  const out: StuckEntry[] = []
  const placed = new Set<string>()
  for (const s of stuck) {
    const key = keyOf(s)
    const items = key ? members.get(key) : undefined
    if (!key || !items || items.length < 2) {
      out.push(single(s))
      continue
    }
    // The group sits where its first task would have.
    if (placed.has(key)) continue
    placed.add(key)
    const raw = items.map((i) => collapse(i.attention.detail ?? ''))
    const first = raw[0] ?? ''
    // The words as reported when every run said the same thing, else the
    // shared cause with the run-specific parts elided.
    const cause = raw.every((d) => d === first) ? first : causeOf(first)
    out.push({ kind: 'group', key: `group:${key}`, reason: s.attention.reason, cause, items })
  }
  return out
}

/** How many tasks an entry stands for. */
const tasksIn = (e: StuckEntry) => (e.kind === 'group' ? e.items.length : 1)

/** The ids of the tasks an entry stands for. */
const taskIdsOf = (e: StuckEntry) =>
  e.kind === 'group' ? e.items.map((i) => i.task.id) : [e.task.id]

// ─── Keeping the person's place ────────────────────────────────────────────
// A card leaves once it no longer needs the person: they retried, assigned or
// dismissed it, a poll found it moving again, it joined a group (or a group
// split up), or another card pushed it past the cap. If it held keyboard focus,
// focus would fall to the page and the next Tab would start at the top. So as
// a card starts to leave, focus moves on: after the task it was on (from its
// card into the group it joined, or back out), to "+N more" when the task now
// waits behind it, else to the next card, the one before, and last to the cell
// or column that holds them. Focus anywhere else stays where it is, so a poll
// never pulls it away from a person who is somewhere else on the page.

const ENTRY = '[data-needs-you-entry]'
const RESTORE = '[data-focus-restore-id]'
const HOME = '[data-testid="calendar-needs-you-today"], [data-needs-you-home]'
const FOCUSABLE =
  'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'

/** The tasks that still wait but sit behind "+N more". */
const HiddenTasksContext = createContext<ReadonlySet<string>>(new Set())

const restoreIdOf = (el: HTMLElement) => el.dataset['focusRestoreId'] ?? ''

/** The element holding focus, when it is inside `root`. */
function focusedIn(root: HTMLElement | null): HTMLElement | null {
  const active = document.activeElement
  return root && active instanceof HTMLElement && root.contains(active) ? active : null
}

/** The tasks focus was with: the one it sat on, else every one in the node. */
function taskIdsIn(node: HTMLElement, active: HTMLElement): string[] {
  const own = active.closest<HTMLElement>(RESTORE)
  if (own && node.contains(own)) return [restoreIdOf(own)]
  return Array.from(node.querySelectorAll<HTMLElement>(RESTORE), restoreIdOf)
}

/** Where focus goes when `node` leaves, short of the cell or column itself. */
function nextFocus(
  node: HTMLElement,
  ids: string[],
  hidden: ReadonlySet<string>,
): HTMLElement | null {
  const list = node.closest('[data-testid="needs-you-tasks"]')
  if (list) {
    const staying = Array.from(list.querySelectorAll<HTMLElement>(RESTORE)).filter(
      (el) => !el.closest('[data-leaving]'),
    )
    for (const id of ids) {
      const same = staying.find((el) => restoreIdOf(el) === id)
      if (same) return same
    }
    if (ids.some((id) => hidden.has(id))) {
      const more = list.parentElement?.querySelector<HTMLElement>('[data-needs-you-more]')
      if (more) return more
    }
  }
  // The next card, else the one before. A group's row looks among its own rows
  // first, then beside its group.
  for (
    let at: HTMLElement | null = node;
    at;
    at = at.parentElement?.closest<HTMLElement>(ENTRY) ?? null
  ) {
    for (const step of ['nextElementSibling', 'previousElementSibling'] as const) {
      for (let sib = at[step]; sib; sib = sib[step]) {
        if (!sib.matches(ENTRY) || sib.hasAttribute('data-leaving')) continue
        const first =
          sib.querySelector<HTMLElement>(RESTORE) ?? sib.querySelector<HTMLElement>(FOCUSABLE)
        if (first) return first
      }
    }
  }
  return null
}

/** Moves focus on from `node` when it holds focus. `hidden` is null when the
 *  node is taken away outright with the whole list around it (the last
 *  approval's list goes with it), so nothing beside it stays: focus goes to a
 *  task still waiting, else the cell or column. */
function handOffFocus(node: HTMLElement, hidden: ReadonlySet<string> | null) {
  const active = focusedIn(node)
  if (!active) return
  const home = node.closest<HTMLElement>(HOME)
  const stillWaiting = home
    ? Array.from(home.querySelectorAll<HTMLElement>(RESTORE)).find(
        (el) => !node.contains(el) && !el.closest('[data-leaving]'),
      )
    : undefined
  const target =
    (hidden ? nextFocus(node, taskIdsIn(node, active), hidden) : null) ?? stillWaiting ?? home
  target?.focus({ preventScroll: true })
}

/** Hands focus on as the card `ref` holds starts to leave, and if it is removed
 *  without a leaving animation. Returns whether the card is staying. */
function useFocusHandOff(ref: RefObject<HTMLElement | null>): boolean {
  const present = useIsPresent()
  const hidden = useContext(HiddenTasksContext)
  // A layout effect, so focus has moved before the person sees a frame of it on
  // a card that is fading out.
  useLayoutEffect(() => {
    if (!present && ref.current) handOffFocus(ref.current, hidden)
  }, [present, hidden, ref])
  useLayoutEffect(() => {
    const node = ref.current
    return () => {
      if (node) handOffFocus(node, null)
    }
  }, [ref])
  return present
}

/** Puts focus back on the button the person pressed when the action left it
 *  nowhere: on the page (Safari does not focus a button on click, so the
 *  confirmation has nothing to hand back), on a node that has gone, or still in
 *  the confirmation, whose promise can settle before it has closed. */
function returnFocus(trigger: HTMLElement | null) {
  if (!trigger?.isConnected) return
  const active = document.activeElement
  const lost =
    !active ||
    active === document.body ||
    !active.isConnected ||
    active.closest('[role="alertdialog"]') !== null
  if (lost) trigger.focus({ preventScroll: true })
}

function NeedsYouTaskCard({
  task,
  attention,
  showTeam,
  onOpen,
  onChanged,
  compact = false,
}: {
  task: BoardTask
  attention: TaskAttention
  showTeam: boolean
  onOpen: () => void
  onChanged: () => void
  /** The calendar's chip: amber, tighter, one line of detail. */
  compact?: boolean
}) {
  const { retry, dismiss } = useTaskActions()
  // One action at a time: a second press while the first is still out would
  // only be refused.
  const [busy, setBusy] = useState(false)
  const rootRef = useRef<HTMLDivElement>(null)
  const detailId = useId()
  const agentId = agentOf(task)
  const agentName = useFleetStore((s) =>
    agentId ? (s.agents.find((a) => a.id === agentId)?.name ?? null) : null,
  )
  const teamName = useTeamStore((s) =>
    showTeam && task.teamId ? (s.teams.find((t) => t.id === task.teamId)?.name ?? null) : null,
  )
  const meta = ATTENTION_META[attention.reason]
  const teamId = typeof task.teamId === 'string' ? task.teamId : null
  const bound = delegationTargetOf(
    typeof task['sourceDelegationId'] === 'string' ? task['sourceDelegationId'] : null,
  )
  const unassigned = attention.reason === 'unassigned'
  const since = waitingSince(task)
  const canRetry = canRetryTask(task, attention)
  const canAssign = !!teamId && !bound
  const detail = attention.detail ?? meta.hint
  const sinceTitle = waitingTitle(since)

  // Focus stays on the pressed button until the board's next read takes the
  // card away, and the card hands it on as it leaves.
  const act = (action: (taskId: string) => Promise<boolean>) => {
    if (busy) return
    const trigger = focusedIn(rootRef.current)
    setBusy(true)
    void action(task.id)
      .then((ok) => {
        returnFocus(trigger)
        if (ok) onChanged()
      })
      .finally(() => setBusy(false))
  }

  const agentLine = (
    <>
      {agentId && <AgentBooAvatar agentId={agentId} size={16} />}
      <span className="truncate">
        {agentName ?? (unassigned ? 'No agent' : 'Unknown agent')}
        {teamName ? ` · ${teamName}` : ''}
      </span>
    </>
  )
  const assignSelect =
    canAssign && teamId ? (
      <AssignAgentSelect taskId={task.id} teamId={teamId} onAssigned={onChanged} />
    ) : null
  const titleText = (
    <span
      className={[
        'font-semibold text-foreground',
        compact ? 'line-clamp-2 text-[12.5px]' : 'text-[13px]',
      ].join(' ')}
      style={{ lineHeight: compact ? '17px' : 1.35, letterSpacing: '-0.01em' }}
    >
      {task.title ?? '(untitled)'}
    </span>
  )

  // The calendar's chip: amber like its column, the title across the full width,
  // then one line that leads with why it waits. Who it belongs to and what the
  // person can do share the last line, under a hairline. When it started
  // waiting is the line's tooltip, and part of the button's description.
  if (compact) {
    const who = agentId ? agentLine : teamName ? <span className="truncate">{teamName}</span> : null
    return (
      <div
        ref={rootRef}
        data-testid="needs-you-task"
        data-attention={attention.reason}
        className="calendar-chip rounded-lg py-2 pl-3 pr-2"
        style={AMBER_CHIP}
      >
        <button
          type="button"
          onClick={onOpen}
          data-focus-restore-id={task.id}
          className="block w-full cursor-pointer text-left"
          aria-label={`Open “${task.title ?? 'task'}”`}
          aria-describedby={detailId}
        >
          {titleText}
          <span
            id={detailId}
            data-testid={sinceTitle ? 'needs-you-since' : undefined}
            title={sinceTitle ?? undefined}
            className="mt-1 flex min-w-0 items-center gap-1.5 text-[11px] leading-4 text-muted-foreground"
          >
            <ReasonLabel reason={attention.reason} label={attentionLabel(attention)} />
            <span className="sr-only">. </span>
            <span className="min-w-0 truncate" title={detail}>
              {detail}
            </span>
            {sinceTitle ? <span className="sr-only">. {sinceTitle}.</span> : null}
          </span>
        </button>
        <div className={CHIP_FOOTER}>
          {who ? <span className="flex min-w-0 flex-1 items-center gap-1.5">{who}</span> : null}
          <span className="ml-auto flex shrink-0 items-center gap-0.5">
            {canRetry && (
              <button
                type="button"
                className={`${QUIET_ACTION} text-foreground`}
                aria-disabled={busy || undefined}
                onClick={() => act(retry)}
              >
                <RotateCcw size={12} strokeWidth={2.2} aria-hidden />
                Retry
              </button>
            )}
            {assignSelect}
            <button
              type="button"
              className={`${QUIET_ACTION} text-muted-foreground hover:text-foreground`}
              aria-disabled={busy || undefined}
              onClick={() => act(dismiss)}
            >
              Dismiss
            </button>
          </span>
        </div>
      </div>
    )
  }

  return (
    <div
      ref={rootRef}
      data-testid="needs-you-task"
      data-attention={attention.reason}
      className="rounded-2xl border border-border bg-surface p-3.5"
      style={{ boxShadow: 'var(--shadow-raised)' }}
    >
      <button
        type="button"
        onClick={onOpen}
        data-focus-restore-id={task.id}
        className="block w-full cursor-pointer text-left"
        aria-label={`Open “${task.title ?? 'task'}”`}
      >
        <div className="flex items-start justify-between gap-2">
          {titleText}
          <StatusPill
            tone={meta.tone}
            label={attentionLabel(attention)}
            className="shrink-0 whitespace-nowrap"
          />
        </div>
        <div className="mt-2 flex min-w-0 items-center gap-1.5 text-[11px] text-muted-foreground">
          {agentLine}
          {since && sinceTitle ? (
            <span
              data-testid="needs-you-since"
              title={sinceTitle}
              className="font-data ml-auto shrink-0 tabular-nums"
            >
              {isSameDay(since, Date.now()) ? timeLabel(since) : dayMonth(since)}
            </span>
          ) : null}
        </div>
        <p className="mt-2 line-clamp-3 text-[11.5px] leading-relaxed text-foreground/65">
          {detail}
        </p>
      </button>
      <div className="mt-3 flex flex-wrap items-center gap-1.5">
        {canRetry && (
          <Button
            size="sm"
            variant="secondary"
            className={BUSY_BUTTON}
            aria-disabled={busy || undefined}
            onClick={() => act(retry)}
          >
            <RotateCcw size={13} strokeWidth={2.2} aria-hidden />
            Retry
          </Button>
        )}
        {assignSelect}
        <Button
          size="sm"
          variant="ghost"
          className={BUSY_BUTTON}
          aria-disabled={busy || undefined}
          onClick={() => act(dismiss)}
        >
          Dismiss
        </Button>
      </div>
    </div>
  )
}

/** Who the grouped tasks belong to: up to four faces, overlapped. */
function AgentStack({ agentIds }: { agentIds: string[] }) {
  const shown = agentIds.slice(0, 4)
  const names = useFleetStore((s) =>
    agentIds.map((id) => s.agents.find((a) => a.id === id)?.name ?? 'Unknown agent').join(', '),
  )
  if (shown.length === 0) return null
  return (
    <span className="ml-auto flex shrink-0 items-center pl-1" title={names}>
      {shown.map((id, i) => (
        <span
          key={id}
          aria-hidden
          className="inline-flex size-4 items-center justify-center rounded-full bg-surface"
          style={{ marginLeft: i === 0 ? 0 : -5, boxShadow: '0 0 0 2px var(--surface)' }}
        >
          <AgentBooAvatar agentId={id} size={16} />
        </span>
      ))}
      <span className="sr-only">. {names}</span>
    </span>
  )
}

/** One task inside a group card: its title, and the way into its drawer. */
function GroupRow({ task, attention, onOpen }: StuckItem & { onOpen: () => void }) {
  const sinceId = useId()
  const title = task.title ?? '(untitled)'
  const sinceTitle = waitingTitle(waitingSince(task))
  return (
    <button
      type="button"
      onClick={onOpen}
      data-testid="needs-you-task"
      data-attention={attention.reason}
      data-focus-restore-id={task.id}
      aria-label={`Open “${task.title ?? 'task'}”`}
      aria-describedby={sinceTitle ? sinceId : undefined}
      title={sinceTitle ? `${title}\n${sinceTitle}` : title}
      className="group/row flex h-6 w-full min-w-0 cursor-pointer items-center gap-1 rounded-[4px] px-1.5 text-left text-[12px] font-medium text-foreground transition-colors hover:bg-amber/10 focus-visible:outline-2 focus-visible:outline-offset-1"
    >
      <span className="min-w-0 flex-1 truncate">{title}</span>
      <ChevronRight
        size={12}
        strokeWidth={2.2}
        aria-hidden
        className="shrink-0 text-muted-foreground opacity-0 transition-opacity group-hover/row:opacity-100 group-focus-visible/row:opacity-100"
      />
      {sinceTitle ? (
        <span id={sinceId} className="sr-only">
          {sinceTitle}
        </span>
      ) : null}
    </button>
  )
}

/** Several tasks stuck on the same cause, on one card: the cause, why they wait
 *  and how many, a row per task, and one Retry all / Dismiss all. */
function NeedsYouGroupCard({
  entry,
  onOpenTask,
  onChanged,
  reduced,
}: {
  entry: Extract<StuckEntry, { kind: 'group' }>
  onOpenTask: (taskId: string) => void
  onChanged: () => void
  reduced: boolean
}) {
  const { retryMany, dismissMany } = useTaskActions()
  const [busy, setBusy] = useState(false)
  const rootRef = useRef<HTMLDivElement>(null)
  const headlineId = useId()
  const { items, reason, cause } = entry
  const n = items.length
  const ids = items.map((i) => i.task.id)
  const agentIds = [...new Set(items.map((i) => agentOf(i.task)).filter((id) => id !== null))]
  const canRetryAll = items.every((i) => canRetryTask(i.task, i.attention))
  const label = `${ATTENTION_META[reason].label} · ${countLabel(n, 'task')}`

  // As on a single card: focus stays on the pressed button, and the group hands
  // it on as it leaves (to a task that stays, or the next card).
  const act = (action: (taskIds: readonly string[]) => Promise<number>) => {
    if (busy) return
    const trigger = focusedIn(rootRef.current)
    setBusy(true)
    void action(ids)
      .then((done) => {
        returnFocus(trigger)
        if (done > 0) onChanged()
      })
      .finally(() => setBusy(false))
  }

  return (
    <div
      ref={rootRef}
      role="group"
      aria-labelledby={headlineId}
      data-testid="needs-you-group"
      data-attention={reason}
      className="calendar-chip rounded-lg py-2 pl-3 pr-2"
      style={AMBER_CHIP}
    >
      <p
        id={headlineId}
        title={cause}
        className="line-clamp-2 text-[12px] font-semibold text-foreground"
        style={{ lineHeight: '16px', letterSpacing: '-0.01em' }}
      >
        {cause}
      </p>
      <div className="mt-1 flex min-w-0 items-center gap-1.5">
        <ReasonLabel reason={reason} label={label} />
        <AgentStack agentIds={agentIds} />
      </div>
      <ul className="-mx-1.5 mt-1.5 flex flex-col" aria-label={countLabel(n, 'task')}>
        <AnimatePresence>
          {items.map(({ task, attention }) => (
            <Leaving key={task.id} as="li" reduced={reduced}>
              <GroupRow task={task} attention={attention} onOpen={() => onOpenTask(task.id)} />
            </Leaving>
          ))}
        </AnimatePresence>
      </ul>
      <div className={CHIP_FOOTER}>
        <span className="ml-auto flex shrink-0 items-center gap-0.5">
          {canRetryAll && (
            <button
              type="button"
              aria-label={`Retry all ${countLabel(n, 'task')}`}
              className={`${QUIET_ACTION} text-foreground`}
              aria-disabled={busy || undefined}
              onClick={() => act(retryMany)}
            >
              <RotateCcw size={12} strokeWidth={2.2} aria-hidden />
              Retry all
            </button>
          )}
          <button
            type="button"
            aria-label={`Dismiss all ${countLabel(n, 'task')}`}
            className={`${QUIET_ACTION} text-muted-foreground hover:text-foreground`}
            aria-disabled={busy || undefined}
            onClick={() => act(dismissMany)}
          >
            Dismiss all
          </button>
        </span>
      </div>
    </div>
  )
}

/** A card, a group, or a group's row. Only its leaving animates: it fades while
 *  its height closes, clipped so nothing spills over what slides up. The gap
 *  below a card is its own padding, so the gap closes with it. As it starts to
 *  leave it hands focus on, if it holds it. */
function Leaving({
  as = 'div',
  gap = 0,
  reduced,
  children,
}: {
  as?: 'div' | 'li'
  gap?: number
  reduced: boolean
  children: ReactNode
}) {
  const ref = useRef<HTMLElement>(null)
  const present = useFocusHandOff(ref)
  // Clips only while leaving: at rest the chip's shadow and its focus rings
  // reach past the box.
  const motionProps = {
    style: { paddingBottom: gap || undefined, overflow: present ? undefined : 'hidden' },
    exit: {
      opacity: 0,
      height: 0,
      ...(gap ? { paddingBottom: 0 } : {}),
      transition: leaveTransition(reduced),
    },
  } as const
  const leaving = present ? undefined : ''
  return as === 'li' ? (
    <motion.li
      ref={ref as RefObject<HTMLLIElement | null>}
      data-needs-you-entry=""
      data-leaving={leaving}
      {...motionProps}
    >
      {children}
    </motion.li>
  ) : (
    <motion.div
      ref={ref as RefObject<HTMLDivElement | null>}
      data-needs-you-entry=""
      data-leaving={leaving}
      {...motionProps}
    >
      {children}
    </motion.div>
  )
}

/** An approval's place in its list. The card animates itself; this only hands
 *  focus on when the approval is answered and its card goes. */
function ApprovalSlot({ children }: { children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null)
  const present = useFocusHandOff(ref)
  return (
    <div ref={ref} data-needs-you-entry="" data-leaving={present ? undefined : ''}>
      {children}
    </div>
  )
}

export interface NeedsYouModel {
  /** Pending approvals, oldest first: the longest wait is the most urgent. */
  approvals: ApprovalItem[]
  /** Tasks nothing will move by itself, with the reason each one waits. */
  stuck: { task: BoardTask; attention: TaskAttention }[]
  total: number
  resolveTool: ReturnType<typeof usePendingApprovals>['resolveTool']
}

export function useNeedsYou(teamFilter: string, tasks: BoardTask[]): NeedsYouModel {
  // `all` → no team filter (every pending approval); a team id → that team's agents
  // plus any approval not attributable to an agent (includeUnscoped).
  const { exec, tool, resolveTool } = usePendingApprovals({
    teamId: teamFilter === 'all' ? null : teamFilter,
    includeUnscoped: true,
  })

  const approvals = useMemo<ApprovalItem[]>(() => {
    const merged: ApprovalItem[] = [
      ...exec.map((a): ApprovalItem => ({
        key: `exec-${a.id}`,
        ts: a.createdAtMs,
        kind: 'exec',
        exec: a,
      })),
      ...tool.map((a): ApprovalItem => ({
        key: `tool-${a.id}`,
        ts: a.createdAt,
        kind: 'tool',
        tool: a,
      })),
    ]
    return merged.sort((a, b) => a.ts - b.ts)
  }, [exec, tool])

  const stuck = useMemo(
    () =>
      tasks
        .map((task) => ({ task, attention: taskAttentionOf(task) }))
        .filter((x): x is { task: BoardTask; attention: TaskAttention } => x.attention !== null),
    [tasks],
  )
  return { approvals, stuck, total: approvals.length + stuck.length, resolveTool }
}

export function NeedsYouItems({
  model,
  teamFilter,
  onOpenTask,
  onTasksChanged,
  layout = 'lane',
  cap,
  show,
}: {
  model: NeedsYouModel
  teamFilter: string
  onOpenTask: (taskId: string) => void
  /** An action on a card changed the board; the host should refresh. */
  onTasksChanged: () => void
  /** `cell` is the calendar's today row: a one-line empty state. */
  layout?: 'lane' | 'cell'
  /** Show this many items, approvals first, and the rest on request. */
  cap?: number
  /** A task being brought into view: past the cap, it opens the rest. */
  show?: string | null
}) {
  const { approvals, stuck, total, resolveTool } = model
  const [expanded, setExpanded] = useState(false)
  const reduced = useReducedMotion() ?? false
  const cell = layout === 'cell'
  // The calendar's chips gather tasks with the same cause onto one card; the
  // lane keeps a card per task.
  const entries = useMemo(() => stuckEntries(stuck, cell), [stuck, cell])
  // The cap counts cards, so a group takes one slot; "+N more" counts tasks, so
  // it adds up with the column's count.
  const limit = cap != null && !expanded ? cap : Infinity
  const shownApprovals = approvals.slice(0, limit)
  const shownEntries = entries.slice(0, Math.max(0, limit - shownApprovals.length))
  const shownTasks = shownEntries.reduce((n, e) => n + tasksIn(e), 0)
  const hidden = total - shownApprovals.length - shownTasks
  const collapsible = cap != null && approvals.length + entries.length > cap
  // The tasks behind "+N more", so a card pushed there hands focus to the button.
  const shownCount = shownEntries.length
  const hiddenIds = useMemo(
    () => new Set(entries.slice(shownCount).flatMap(taskIdsOf)),
    [entries, shownCount],
  )
  // A task being brought into view opens the rest in this same render, not in an
  // effect after it: the board looks for the card as soon as this commits.
  const [shownFor, setShownFor] = useState<string | null>(null)
  if (show && show !== shownFor && hiddenIds.has(show)) {
    setShownFor(show)
    setExpanded(true)
  }
  // Each card's gap is padding under it, so the gap closes with a card that leaves.
  const gap = cell ? 6 : 10
  // A lone group needs no heading: the column's title already says what it is.
  const labelled = approvals.length > 0 && stuck.length > 0

  // The list stays mounted while its last card leaves, so that card can animate
  // out; "Nothing needs you" takes its place once it has gone.
  const hasEntries = shownEntries.length > 0
  const [hadEntries, setHadEntries] = useState(hasEntries)
  const [draining, setDraining] = useState(false)
  if (hadEntries !== hasEntries) {
    setHadEntries(hasEntries)
    if (!hasEntries) setDraining(true)
  }

  if (total === 0 && !draining) {
    return cell ? (
      <div
        data-testid="needs-you-empty"
        className="flex items-center gap-2 px-1 py-1 text-[12px] text-muted-foreground"
      >
        <span aria-hidden className="inline-flex shrink-0">
          <BooAvatar seed="clawboo-all-clear" size={22} eyeShape={3} tint="#34D399" />
        </span>
        Nothing needs you right now
      </div>
    ) : (
      <div
        data-testid="needs-you-empty"
        className="flex flex-col items-center gap-1.5 px-2 py-5 text-center"
      >
        <CheckCircle2 size={18} strokeWidth={2} className="text-mint" />
        <span className="text-[12px] font-medium text-foreground/70">
          Nothing needs you right now
        </span>
        <span className="text-[11px] leading-relaxed text-muted-foreground">
          Approvals, failed runs and stuck tasks show up here.
        </span>
      </div>
    )
  }

  return (
    <HiddenTasksContext.Provider value={hiddenIds}>
      {shownApprovals.length > 0 && (
        <div
          className={['flex flex-col', cell ? 'gap-1.5' : 'gap-2.5'].join(' ')}
          data-testid="needs-you-approvals"
        >
          {labelled && (
            <span className={GROUP_LABEL}>
              Approval pending
              <span className="tabular-nums">{approvals.length}</span>
            </span>
          )}
          {/* On the board the command card takes the board's look: amber words
              and ink buttons, since red there belongs to today's date. The one
              exception is a tool card's Allow on a call that sends or destroys:
              its red is the consent warning, so it stays. */}
          <AnimatePresence mode="popLayout">
            {shownApprovals.map((it) => (
              <ApprovalSlot key={it.key}>
                {it.kind === 'exec' ? (
                  <InlineApprovalCard approval={it.exec} showAgentName variant="board" />
                ) : (
                  <ToolApprovalCard approval={it.tool} onResolve={resolveTool} compact />
                )}
              </ApprovalSlot>
            ))}
          </AnimatePresence>
        </div>
      )}

      {(hasEntries || draining) && (
        <div
          className={['flex flex-col', cell ? 'gap-1.5' : 'gap-2.5'].join(' ')}
          data-testid="needs-you-tasks"
        >
          {labelled && (
            <span className={GROUP_LABEL}>
              Tasks
              <span className="tabular-nums">{stuck.length}</span>
            </span>
          )}
          <div className="flex flex-col" style={{ marginBottom: -gap }}>
            <AnimatePresence onExitComplete={() => setDraining(false)}>
              {shownEntries.map((entry) => (
                <Leaving key={entry.key} gap={gap} reduced={reduced}>
                  {entry.kind === 'group' ? (
                    <NeedsYouGroupCard
                      entry={entry}
                      onOpenTask={onOpenTask}
                      onChanged={onTasksChanged}
                      reduced={reduced}
                    />
                  ) : (
                    <NeedsYouTaskCard
                      task={entry.task}
                      attention={entry.attention}
                      showTeam={teamFilter === 'all'}
                      onOpen={() => onOpenTask(entry.task.id)}
                      onChanged={onTasksChanged}
                      compact={cell}
                    />
                  )}
                </Leaving>
              ))}
            </AnimatePresence>
          </div>
        </div>
      )}

      {hidden > 0 || (expanded && collapsible) ? (
        <button
          type="button"
          onClick={() => setExpanded((e) => !e)}
          aria-expanded={expanded}
          data-needs-you-more=""
          className="self-start cursor-pointer rounded-md px-1.5 py-0.5 text-[12px] font-medium text-foreground transition-colors hover:bg-foreground/[0.06] focus-visible:outline-2 focus-visible:outline-offset-2"
        >
          {expanded ? 'Show less' : `+${hidden} more`}
        </button>
      ) : null}
    </HiddenTasksContext.Provider>
  )
}

/** The Needs you column the board shows while it cannot draw the calendar. */
export function NeedsYouLane({
  model,
  teamFilter,
  onOpenTask,
  onTasksChanged,
}: {
  model: NeedsYouModel
  teamFilter: string
  onOpenTask: (taskId: string) => void
  onTasksChanged: () => void
}) {
  const { total } = model
  const titleId = useId()
  // Focusable from script only: when the last card leaves holding focus, focus
  // lands on the column instead of the page.
  return (
    <div
      role="group"
      aria-labelledby={titleId}
      tabIndex={-1}
      data-needs-you-home=""
      data-testid="board-column-needs-you"
      className={[
        'flex max-h-full w-[288px] shrink-0 flex-col gap-2.5 rounded-2xl border p-3 transition-colors',
        total > 0 ? 'border-amber/40 bg-amber/[0.04]' : 'border-border bg-foreground/[0.02]',
      ].join(' ')}
    >
      <div className="flex items-center justify-between px-1">
        <span className="flex items-center gap-1.5">
          <ShieldAlert
            size={14}
            strokeWidth={2}
            className={total > 0 ? 'text-amber' : 'text-foreground/35'}
          />
          <span id={titleId} className={SECTION_LABEL}>
            Needs you
          </span>
        </span>
        <span
          className={[
            'font-data rounded-full px-2 py-0.5 text-[10px] font-semibold',
            total > 0 ? 'bg-amber/20 text-amber' : 'bg-foreground/[0.06] text-foreground/50',
          ].join(' ')}
        >
          {total}
        </span>
      </div>

      <div className="flex min-h-0 flex-col gap-2.5 overflow-y-auto">
        <NeedsYouItems
          model={model}
          teamFilter={teamFilter}
          onOpenTask={onOpenTask}
          onTasksChanged={onTasksChanged}
        />
      </div>
    </div>
  )
}

/** The lane with its own data, for a host that has not gathered it. */
export function NeedsYouColumn({
  teamFilter,
  tasks,
  onOpenTask,
  onTasksChanged,
}: {
  teamFilter: string
  /** The board tasks that need a person (the board routes them here). */
  tasks: BoardTask[]
  onOpenTask: (taskId: string) => void
  onTasksChanged: () => void
}) {
  const model = useNeedsYou(teamFilter, tasks)
  return (
    <NeedsYouLane
      model={model}
      teamFilter={teamFilter}
      onOpenTask={onOpenTask}
      onTasksChanged={onTasksChanged}
    />
  )
}
