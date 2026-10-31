// A task, read like a document: its title and who has it, why it waits (when it
// does), the agent's report, the brief, its properties, then the record:
// verification, the workspace, run history, comments, and the live activity
// last. A section folds from its heading, and one with nothing in it is not
// drawn. J and K step to the next and previous task in its column.

import { useCallback, useEffect, useId, useRef, useState, type ReactNode } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import {
  AlertTriangle,
  Check,
  ChevronDown,
  ChevronUp,
  CircleDashed,
  FileQuestion,
  FileText,
  RotateCcw,
  X,
} from 'lucide-react'
import { delegationTargetOf } from '@clawboo/board-core'

import { AgentBooAvatar } from '@/components/AgentBooAvatar'
import {
  boardClient,
  getTaskExecutions,
  getWorkspaceDetail,
  type BoardExecution,
  type ReplyDelivery,
  type TaskDetail,
  type WorkspaceDetail,
} from '@/lib/boardClient'
import { useFleetStore } from '@/stores/fleet'
import { useTeamStore } from '@/stores/team'
import { MD_COMPONENTS } from '@/features/chat/chatComponents'
import { Button, IconButton } from '@/features/shared/Button'
import { EmptyState } from '@/features/shared/EmptyState'
import { Skeleton } from '@/features/shared/Skeleton'
import { ActivityTerminal } from '@/features/obs/ActivityTerminal'
import { WorkspacePanel } from '@/features/workspace/WorkspacePanel'
import { WorkspacePreview } from '@/features/workspace/WorkspacePreview'
import { Modal } from '@/features/shared/Modal'

import { AssignAgentSelect } from './AssignAgentSelect'
import { StatusSelect } from './StatusSelect'
import type { StatusCommit } from './useStatusMutation'
import { runtimeNameOf, taskRuntimeOf, useAgentRuntime } from './TaskCard'
import { ReplyReceipt } from './ReplyReceipt'
import { TaskComments } from './TaskComments'
import { TaskReplyBox } from './TaskReplyBox'
import {
  ATTENTION_META,
  attentionLabel,
  boardColumnOf,
  statusLabel,
  taskAttentionOf,
  type TaskAttention,
} from './boardStatus'
import { timeOnDay } from './calendar/calendarFormat'
import { StatusGlyph, glyphKindOf } from './StatusGlyph'
import { useTaskActions } from './useTaskActions'
import { formatRunCost, runCostOf } from './taskCost'

interface Verdict {
  status?: 'pass' | 'fail' | 'completed_with_debt'
  attempts?: {
    deterministic?: {
      command?: string
      commandSource?: 'configured' | 'scaffold' | 'agent' | 'none'
    }
    critic?: {
      ran?: boolean
      outcome?: 'reviewed' | 'empty' | 'errored'
      findings?: { severity?: string; title?: string }[]
      reviewerRuntime?: string | null
      reviewerModel?: string | null
    }
  }[]
  debtNotes?: string[]
}

/** Where the gate's command came from, in the drawer's words. */
const COMMAND_SOURCE_LABEL: Record<'configured' | 'scaffold' | 'agent', string> = {
  configured: 'set for the team',
  scaffold: 'from the task setup',
  agent: 'written by the agent',
}

/** The reviewer line for a critic that ran: who reviewed, or why no review happened. */
function reviewerLine(
  critic: NonNullable<NonNullable<Verdict['attempts']>[number]['critic']>,
): { text: string; warn: boolean } | null {
  const who = [
    critic.reviewerRuntime && runtimeNameOf(critic.reviewerRuntime),
    critic.reviewerModel,
  ]
    .filter(Boolean)
    .join(' · ')
  if (critic.outcome === 'errored')
    return { text: `Review did not complete${who ? ` (${who})` : ''}`, warn: true }
  if (critic.outcome === 'empty')
    return { text: `Review returned nothing${who ? ` (${who})` : ''}`, warn: true }
  return who ? { text: `Reviewed by ${who}`, warn: false } : null
}

function parseVerification(v: unknown): Verdict | null {
  if (!v) return null
  try {
    return typeof v === 'string' ? (JSON.parse(v) as Verdict) : (v as Verdict)
  } catch {
    return null
  }
}

/** A verdict in words, with its mark: a pass in mint, the rest in amber. */
const VERDICT_FACE: Record<
  'pass' | 'fail' | 'completed_with_debt',
  { word: string; mark: ReactNode }
> = {
  pass: { word: 'Passed', mark: <Check size={14} strokeWidth={2} className="text-mint" /> },
  fail: { word: 'Failed', mark: <X size={14} strokeWidth={2} className="text-amber" /> },
  completed_with_debt: {
    word: 'Passed with debt',
    mark: <CircleDashed size={14} strokeWidth={2} className="text-amber" />,
  },
}

/** A run's outcome in words. */
const RUN_WORD: Record<string, string> = {
  queued: 'Queued',
  running: 'Running',
  succeeded: 'Succeeded',
  failed: 'Failed',
  timed_out: 'Timed out',
  cancelled: 'Cancelled',
}

/** A section: a sentence-case heading that folds it, and its content. */
function Section({
  title,
  count,
  testId,
  children,
}: {
  title: string
  count?: number
  testId?: string
  children: ReactNode
}) {
  const [open, setOpen] = useState(true)
  const bodyId = useId()
  return (
    <section className="mt-6" data-testid={testId}>
      <h3 className="m-0">
        <button
          type="button"
          aria-expanded={open}
          aria-controls={bodyId}
          onClick={() => setOpen((o) => !o)}
          className="-ml-1 flex cursor-pointer items-center gap-1 rounded-md px-1 py-0.5 text-xs font-medium text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-2"
        >
          <ChevronDown
            size={14}
            strokeWidth={2}
            aria-hidden
            className={`transition-transform ${open ? '' : '-rotate-90'}`}
          />
          {title}
          {count != null ? (
            <>
              {' '}
              <span className="tabular-nums">{count}</span>
            </>
          ) : null}
        </button>
      </h3>
      {open ? (
        <div id={bodyId} className="mt-2">
          {children}
        </div>
      ) : null}
    </section>
  )
}

/** A property: its name on the left, its value on the right, on a 32px row. */
function PropRow({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="grid min-h-8 grid-cols-[96px_minmax(0,1fr)] items-center gap-3">
      <span className="text-xs text-muted-foreground">{label}</span>
      <span className="min-w-0 break-words text-compact text-foreground">{children}</span>
    </div>
  )
}

/** A small fact under the title: status, agent, team. */
function Pill({ children }: { children: ReactNode }) {
  return (
    <span className="inline-flex h-6 max-w-full items-center gap-1.5 rounded-full border border-border px-2 text-xs text-foreground">
      {children}
    </span>
  )
}

// Code and diffs: the one place the drawer sets type in mono.
const CODE_BOX =
  'max-h-[260px] overflow-y-auto whitespace-pre-wrap break-words rounded-lg border border-border bg-[var(--code-block-bg)] px-3 py-2.5 font-mono text-micro text-foreground'

/** Why the task waits on a person, and every way to get it moving: Retry, a
 *  new agent, or Dismiss. The board's card leads with one of these; here they
 *  are all at hand. */
function NeedsYouBanner({
  taskId,
  teamId,
  attention,
  bound,
  onChanged,
}: {
  taskId: string
  teamId: string | null
  attention: TaskAttention
  /** The agent the task is bound to, if any. */
  bound: string | null
  onChanged: () => void
}) {
  // Retry hands it back to its agent; with no agent bound, someone has to be
  // picked. A bound task can also be handed to someone else.
  const canRetry = attention.reason !== 'unassigned' && !!teamId && !!bound
  const { retry, dismiss } = useTaskActions()
  const meta = ATTENTION_META[attention.reason]
  const broke = attention.reason === 'failed' || attention.reason === 'timed_out'
  return (
    <div
      data-testid="task-needs-you"
      data-attention={attention.reason}
      className="mt-4 rounded-xl border border-border bg-foreground/[0.025] p-3"
    >
      <div className="flex items-center gap-1.5 text-xs">
        <StatusGlyph kind="needs_you" />
        <span className="font-semibold text-foreground">Needs you</span>
        <span className="board-reason inline-flex items-center gap-1 font-medium">
          {broke ? <AlertTriangle size={12} strokeWidth={2} aria-hidden /> : null}
          {attentionLabel(attention)}
        </span>
      </div>
      <p className="mt-1.5 whitespace-pre-wrap break-words text-compact text-foreground">
        {attention.detail ?? meta.hint}
      </p>
      <div className="mt-3 flex flex-wrap items-center gap-2">
        {canRetry && (
          <Button
            size="sm"
            variant="secondary"
            onClick={() => void retry(taskId).then((ok) => ok && onChanged())}
          >
            <RotateCcw size={14} strokeWidth={2} />
            Retry
          </Button>
        )}
        {teamId && (
          <AssignAgentSelect
            taskId={taskId}
            teamId={teamId}
            onAssigned={onChanged}
            label={bound ? 'Give to someone else…' : 'Assign to…'}
          />
        )}
        <Button
          size="sm"
          variant="ghost"
          onClick={() => void dismiss(taskId).then((ok) => ok && onChanged())}
        >
          Dismiss
        </Button>
      </div>
    </div>
  )
}

/** Where the open task sits among the tasks of its column, for J and K. */
export interface DrawerPosition {
  index: number
  total: number
  prev: string | null
  next: string | null
}

export function TaskDetailDrawer({
  taskId,
  onClose,
  onStatusCommitted,
  layer = 60,
  onChanged,
  position,
  onOpenTask,
}: {
  taskId: string
  onClose: () => void
  /** Fires after a status change commits (success only), so the parent board can move
   *  the card to its new column immediately instead of waiting for the next ~5s
   *  reconciliation poll (#98). Mirrors the drawer's own optimistic `setDetail`. */
  onStatusCommitted?: (taskId: string, newStatus: string, commit: StatusCommit) => void
  /** Stacking layer. Raise it when opening the drawer over another overlay. */
  layer?: number
  /** A needs-you action (retry, assign, dismiss) changed the task; the board should
   *  refresh. The drawer reloads itself. */
  onChanged?: () => void
  /** The open task's place in its column, when the board can step through it. */
  position?: DrawerPosition | null
  /** Opens another task in this drawer: the next or previous one, or the parent. */
  onOpenTask?: (taskId: string) => void
}) {
  const [detail, setDetail] = useState<TaskDetail | null>(null)
  const [executions, setExecutions] = useState<BoardExecution[]>([])
  const [workspace, setWorkspace] = useState<WorkspaceDetail | null>(null)
  // The task the shown detail belongs to. Until the open task's own detail
  // arrives (on open, or after J or K) the drawer shows its skeleton, never the
  // last task's content under the new one's id.
  const [loadedFor, setLoadedFor] = useState<string | null>(null)
  // Where each reply the person sent from here went, by comment id.
  const [receipts, setReceipts] = useState<Map<string, { delivery: ReplyDelivery; body: string }>>(
    () => new Map(),
  )
  const contentRef = useRef<HTMLDivElement>(null)
  // The task open now. A reply or a status write for a task the drawer has
  // stepped away from (J or K mid-flight) must not land on the one it shows.
  const openTaskRef = useRef(taskId)
  openTaskRef.current = taskId

  const load = useCallback(
    async (live: () => boolean = () => true) => {
      const [d, ex, ws] = await Promise.all([
        boardClient.getTask(taskId),
        getTaskExecutions(taskId),
        getWorkspaceDetail(taskId),
      ])
      // A quick J or K can land an older task's reply after a newer one's.
      if (!live() || openTaskRef.current !== taskId) return
      setDetail(d)
      setExecutions(ex)
      setWorkspace(ws)
      setLoadedFor(taskId)
    },
    [taskId],
  )

  useEffect(() => {
    let live = true
    void load(() => live)
    return () => {
      live = false
    }
  }, [load])

  // J and K step through the column without closing, while focus is anywhere in
  // the drawer but a field or an open menu.
  useEffect(() => {
    if (!onOpenTask || !position) return
    function onKey(e: KeyboardEvent) {
      if (e.defaultPrevented || e.metaKey || e.ctrlKey || e.altKey || e.isComposing) return
      const t = e.target
      if (!(t instanceof HTMLElement) || !contentRef.current?.contains(t)) return
      // A field, a list or menu, or the button of one that is open (its list
      // types ahead on the same keys).
      if (
        t.isContentEditable ||
        t.closest(
          'input, textarea, select, [role="listbox"], [role="menu"], [aria-haspopup][aria-expanded="true"]',
        )
      )
        return
      const to =
        e.key === 'j' || e.key === 'J'
          ? position!.next
          : e.key === 'k' || e.key === 'K'
            ? position!.prev
            : null
      if (!to) return
      e.preventDefault()
      onOpenTask!(to)
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [onOpenTask, position])

  // Dialog semantics, focus trap, Escape and focus-return all come from Modal.
  const headingId = useId()

  const task = detail?.task
  const verdict = parseVerification(task?.['verification'])
  const runCost = task ? runCostOf(task) : null
  const comments = (detail?.comments ?? []) as {
    id?: string
    body?: string
    authorType?: string
    authorAgentId?: string | null
    createdAt?: number
  }[]
  // The delegated agent's deliverable is its report-up comment(s), shown once as
  // the report, rendered as the markdown it is written in. The Comments section
  // below keeps the rest of the log.
  //
  // This is also the ONLY place a board reply lands: a boo's task work stays on the
  // task rather than arriving unprompted in the person's 1:1 chat (see the native
  // driver). Naming the boo is what makes that read as a teammate reporting back
  // instead of an anonymous block of output.
  const agentOutputs = comments.filter(
    (c) => c.authorType === 'agent' && typeof c.body === 'string' && c.body.trim().length > 0,
  )
  const otherComments = comments.filter((c) => !agentOutputs.includes(c))
  const assigneeId = (task?.['assigneeAgentId'] as string | null | undefined) ?? null
  // The agent the task is bound to (kept while it waits in To do or needs you,
  // when there is no live assignee).
  const sdid =
    typeof task?.['sourceDelegationId'] === 'string' ? (task['sourceDelegationId'] as string) : null
  const boundId = delegationTargetOf(sdid)
  const reporterId = agentOutputs.find((c) => c.authorAgentId)?.authorAgentId ?? assigneeId
  const reporterName = useFleetStore(
    (st) => st.agents.find((a) => a.id === reporterId)?.name ?? null,
  )
  const ownerId = assigneeId ?? boundId
  const ownerName = useFleetStore((st) =>
    ownerId ? (st.agents.find((a) => a.id === ownerId)?.name ?? null) : null,
  )
  const ownerRuntime = useAgentRuntime(ownerId)
  const taskRuntime = task ? taskRuntimeOf(task, ownerRuntime) : null
  const teamId = typeof task?.teamId === 'string' ? task.teamId : null
  const teamName = useTeamStore((st) =>
    teamId ? (st.teams.find((t) => t.id === teamId)?.name ?? null) : null,
  )
  const outputTitle = reporterName ? `${reporterName}'s report` : 'Report'
  const attention = task ? taskAttentionOf(task) : null
  // What the person asked for, when it says more than the title does.
  const brief =
    typeof task?.description === 'string' &&
    task.description.trim() &&
    task.description.trim() !== (task.title ?? '').trim()
      ? task.description.trim()
      : null
  // The task this one was split from, and the top of the chain when that is
  // further up. The server sends the whole chain, in no order.
  const ancestors = (detail?.ancestors ?? []) as {
    id: string
    title?: unknown
    parent_task_id?: unknown
  }[]
  const parentId = typeof task?.['parentTaskId'] === 'string' ? task['parentTaskId'] : null
  const parent = parentId ? (ancestors.find((a) => a.id === parentId) ?? { id: parentId }) : null
  const root = ancestors.find((a) => a.parent_task_id == null && a.id !== parentId) ?? null
  const titleOf = (a: { id: string; title?: unknown }): string =>
    typeof a.title === 'string' && a.title.trim() ? a.title : `Task ${a.id.slice(0, 8)}`
  const createdAt = typeof task?.createdAt === 'number' ? task.createdAt : null
  const completedAt = typeof task?.['completedAt'] === 'number' ? task['completedAt'] : null
  const now = Date.now()
  const refreshAfterAction = (): void => {
    void load()
    onChanged?.()
  }

  return (
    <Modal
      open
      variant="drawer"
      layer={layer}
      labelledBy={headingId}
      onClose={onClose}
      data-testid="task-detail-drawer"
      panelClassName="flex flex-col overflow-hidden border-l border-border bg-surface shadow-[var(--shadow-overlay)]"
      panelStyle={{
        width: 'min(520px, 92vw)',
        borderTopLeftRadius: 12,
        borderBottomLeftRadius: 12,
      }}
    >
      <div ref={contentRef} className="flex min-h-0 flex-1 flex-col">
        <div className="flex h-12 shrink-0 items-center gap-1 px-3">
          {position && onOpenTask ? (
            <>
              <IconButton
                variant="ghost"
                size="sm"
                label="Previous task"
                title="Previous task (K)"
                aria-keyshortcuts="k"
                disabled={!position.prev}
                onClick={() => position.prev && onOpenTask(position.prev)}
              >
                <ChevronUp size={16} strokeWidth={2} />
              </IconButton>
              <IconButton
                variant="ghost"
                size="sm"
                label="Next task"
                title="Next task (J)"
                aria-keyshortcuts="j"
                disabled={!position.next}
                onClick={() => position.next && onOpenTask(position.next)}
              >
                <ChevronDown size={16} strokeWidth={2} />
              </IconButton>
              <span
                className="ml-1 text-xs tabular-nums text-muted-foreground"
                data-testid="task-position"
              >
                {position.index + 1} of {position.total}
              </span>
            </>
          ) : null}
          <span className="flex-1" />
          <IconButton variant="ghost" size="sm" label="Close" onClick={onClose}>
            <X size={16} strokeWidth={2} />
          </IconButton>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto px-6 pt-2 pb-10">
          {loadedFor !== taskId ? (
            <div className="flex flex-col gap-3" data-testid="task-detail-loading">
              <Skeleton width="70%" height={22} />
              <div className="flex gap-2">
                <Skeleton width={84} height={24} />
                <Skeleton width={96} height={24} />
              </div>
              <Skeleton height={14} />
              <Skeleton width="80%" height={14} />
            </div>
          ) : !task ? (
            <>
              <h2 id={headingId} className="sr-only">
                Task
              </h2>
              <EmptyState
                icon={FileQuestion}
                title="Task not found"
                helper="This task may have been dropped or is no longer on the board."
              />
            </>
          ) : (
            <>
              <h2
                id={headingId}
                className="m-0 break-words text-xl font-semibold tracking-tight text-foreground"
              >
                {task.title || 'Untitled task'}
              </h2>
              <div className="mt-3 flex flex-wrap items-center gap-1.5">
                <Pill>
                  <StatusGlyph kind={glyphKindOf(boardColumnOf(task))} />
                  {attention ? 'Needs you' : statusLabel(task.status)}
                </Pill>
                {ownerId ? (
                  <Pill>
                    <AgentBooAvatar agentId={ownerId} size={16} />
                    <span className="truncate">{ownerName ?? ownerId}</span>
                  </Pill>
                ) : null}
                {teamId ? (
                  <Pill>
                    <span className="truncate">{teamName ?? teamId}</span>
                  </Pill>
                ) : null}
              </div>

              {attention && (
                <NeedsYouBanner
                  taskId={task.id}
                  teamId={teamId}
                  attention={attention}
                  bound={boundId}
                  onChanged={refreshAfterAction}
                />
              )}

              {agentOutputs.length > 0 && (
                <Section title={outputTitle} testId="task-report">
                  <div className="flex flex-col gap-3">
                    {agentOutputs.map((c, i) => (
                      <div
                        key={c.id ?? i}
                        className="min-w-0 break-words text-sm text-foreground [&>*:first-child]:mt-0 [&>*:last-child]:mb-0"
                      >
                        <ReactMarkdown remarkPlugins={[remarkGfm]} components={MD_COMPONENTS}>
                          {c.body}
                        </ReactMarkdown>
                      </div>
                    ))}
                  </div>
                </Section>
              )}

              {brief && (
                <Section title="Brief">
                  <div
                    className="whitespace-pre-wrap break-words text-sm text-foreground"
                    data-testid="task-brief"
                  >
                    {brief}
                  </div>
                </Section>
              )}

              <Section title="Properties">
                <div className="flex flex-col">
                  <PropRow label="Status">
                    <StatusSelect
                      key={task.id}
                      taskId={task.id}
                      status={task.status}
                      assigneeAgentId={task.assigneeAgentId}
                      task={task}
                      // The board says where the card went; the drawer opened from
                      // anywhere else keeps the plain success message.
                      quiet={onStatusCommitted != null}
                      onChange={(next, commit) => {
                        setDetail((d) =>
                          d && d.task.id === taskId
                            ? {
                                ...d,
                                // Mirror the server: a →todo release clears the assignee,
                                // runtime, and verification verdict (repository.ts, the
                                // cross-runtime rebind boundary). Without this the agent
                                // reads stale, a prior verdict lingers, and the release
                                // confirm would re-fire on the next move.
                                task: {
                                  ...d.task,
                                  status: next,
                                  ...(next === 'todo'
                                    ? {
                                        assigneeAgentId: null,
                                        assigneeRuntime: null,
                                        verification: null,
                                      }
                                    : {}),
                                  ...(commit.completedAt !== undefined
                                    ? { completedAt: commit.completedAt, runningSince: null }
                                    : {}),
                                },
                              }
                            : d,
                        )
                        // Reflect the move on the board at once (#98). onChange fires only
                        // on a committed change, so this never moves a card for a failed one.
                        onStatusCommitted?.(taskId, next, commit)
                      }}
                    />
                  </PropRow>
                  <PropRow label="Runtime">
                    {taskRuntime
                      ? runtimeNameOf(taskRuntime)
                      : ownerId
                        ? 'Unknown'
                        : 'Not assigned'}
                  </PropRow>
                  <PropRow label="Cost">
                    <span className="tabular-nums">
                      {runCost?.usd != null
                        ? formatRunCost(runCost.usd, runCost.estimated, {
                            precise: true,
                            local: runCost.local,
                          })
                        : 'None recorded'}
                    </span>
                  </PropRow>
                  {createdAt != null ? (
                    <PropRow label="Added">
                      <span className="tabular-nums">{timeOnDay(createdAt, now)}</span>
                    </PropRow>
                  ) : null}
                  {completedAt != null ? (
                    <PropRow label="Finished">
                      <span className="tabular-nums">{timeOnDay(completedAt, now)}</span>
                    </PropRow>
                  ) : null}
                  {parent ? (
                    <PropRow label="Parent">
                      {onOpenTask ? (
                        <button
                          type="button"
                          onClick={() => onOpenTask(parent.id)}
                          className="max-w-full cursor-pointer truncate text-left text-foreground underline decoration-border underline-offset-2 hover:decoration-foreground"
                        >
                          {titleOf(parent)}
                        </button>
                      ) : (
                        titleOf(parent)
                      )}
                    </PropRow>
                  ) : null}
                  {root ? <PropRow label="Part of">{titleOf(root)}</PropRow> : null}
                </div>
              </Section>

              {verdict && (
                <Section title="Verification" testId="task-verification">
                  {(() => {
                    const last = verdict.attempts?.[verdict.attempts.length - 1]
                    const face = verdict.status ? VERDICT_FACE[verdict.status] : null
                    // The check the gate ran and who chose it: a command the agent
                    // wrote in its own worktree is flagged, since the builder then
                    // picked what it is judged by.
                    const det = last?.deterministic
                    const source = det?.commandSource
                    // Who reviewed: a same-model review's independence is
                    // context-level only (fresh session, detached worktree), so the
                    // reviewer model and runtime are shown for the bias caveat. A
                    // review that failed or came back empty says so instead.
                    const line = last?.critic ? reviewerLine(last.critic) : null
                    return (
                      <div className="flex flex-col gap-1.5 text-compact">
                        <div
                          className="flex items-center gap-1.5 font-medium text-foreground"
                          data-testid="task-verdict"
                        >
                          {face?.mark}
                          {face?.word ?? 'Not judged'}
                        </div>
                        {det?.command && source !== 'none' ? (
                          <div className="text-xs text-muted-foreground">
                            Check: <code className="font-mono">{det.command}</code>
                            {source ? (
                              <span className={source === 'agent' ? 'text-amber' : undefined}>
                                {` · ${COMMAND_SOURCE_LABEL[source]}`}
                              </span>
                            ) : null}
                          </div>
                        ) : null}
                        {line ? (
                          <div
                            className={`text-xs ${line.warn ? 'text-amber' : 'text-muted-foreground'}`}
                          >
                            {line.text}
                          </div>
                        ) : null}
                        {(verdict.debtNotes ?? []).length > 0 && (
                          <ul className="board-reason list-disc pl-4 text-xs">
                            {verdict.debtNotes!.map((d, i) => (
                              <li key={i}>{d}</li>
                            ))}
                          </ul>
                        )}
                        {(last?.critic?.findings ?? []).map((fnd, i) => (
                          <div key={i} className="text-xs text-foreground">
                            <span className="font-medium">{fnd.severity}</span>: {fnd.title}
                          </div>
                        ))}
                      </div>
                    )
                  })()}
                </Section>
              )}

              {workspace?.ok && workspace.workspace ? (
                <Section title="Workspace" testId="task-workspace">
                  <div className="flex flex-col">
                    <PropRow label="Branch">
                      <span className="font-mono text-xs">
                        {workspace.workspace.branch ?? 'None'}
                      </span>
                    </PropRow>
                    <PropRow label="Worktree">
                      <span className="font-mono text-xs">
                        {workspace.workspace.worktreePath ?? 'None'}
                      </span>
                    </PropRow>
                    {workspace.diffStat ? (
                      <PropRow label="Changes">
                        <span className="tabular-nums">
                          {workspace.diffStat.filesChanged} files, +{workspace.diffStat.insertions}{' '}
                          −{workspace.diffStat.deletions}
                        </span>
                      </PropRow>
                    ) : null}
                  </div>
                  {Object.entries(workspace.sorFiles ?? {}).length > 0 && (
                    <div className="mt-3">
                      <div className="mb-1 text-xs text-muted-foreground">
                        System-of-record files
                      </div>
                      {Object.entries(workspace.sorFiles ?? {}).map(([name, content]) => (
                        <details key={name} className="mb-1">
                          <summary className="inline-flex cursor-pointer items-center gap-1 font-mono text-xs text-muted-foreground">
                            <FileText size={12} aria-hidden />
                            {name}
                          </summary>
                          <div className={`mt-1 ${CODE_BOX}`}>{content}</div>
                        </details>
                      ))}
                    </div>
                  )}
                  {workspace.diff ? (
                    <div className="mt-3">
                      <div className="mb-1 text-xs text-muted-foreground">Diff</div>
                      <div className={CODE_BOX}>{workspace.diff}</div>
                    </div>
                  ) : null}
                  {/* The live view of the same worktree: file tree, git status
                      badges, per-file diff, and what the agent is touching right
                      now. Pinned to THIS task so the panel's agent-wide picker
                      cannot navigate the reader off the task they opened. Needs
                      an assignee, because the tree is resolved from the agent's
                      workspace list. */}
                  {task.assigneeAgentId ? (
                    <div className="mt-3 h-[380px]">
                      <WorkspacePanel agentId={task.assigneeAgentId} pinnedTaskId={task.id} />
                    </div>
                  ) : null}
                  {/* The rendered result, beside the diff that produced it. Needs
                      no assignee: it reads the task's worktree directly. */}
                  <WorkspacePreview taskId={task.id} />
                </Section>
              ) : null}

              {executions.length > 0 && (
                <Section title="Run history" count={executions.length} testId="task-runs">
                  <ol className="flex flex-col">
                    {executions.map((ex) => {
                      // `runtime` names what actually ran: the team engine types
                      // every fire 'openclaw', whichever runtime the agent uses.
                      const ran = ex.runtime ?? ex.executorType ?? null
                      return (
                        <li
                          key={ex.id}
                          className="border-t border-border py-2 text-xs first:border-t-0 first:pt-0"
                        >
                          <span className="font-medium text-foreground">
                            {ran ? runtimeNameOf(ran) : 'Run'}
                          </span>{' '}
                          <span className="text-muted-foreground">
                            {RUN_WORD[ex.status ?? ''] ?? ex.status ?? ''}
                          </span>
                          {typeof ex.createdAt === 'number' && (
                            <span className="tabular-nums text-muted-foreground">
                              {' '}
                              · {timeOnDay(ex.createdAt, now)}
                            </span>
                          )}
                          {typeof ex.costUsd === 'number' && (
                            <span className="tabular-nums text-muted-foreground">
                              {' '}
                              ·{' '}
                              {formatRunCost(
                                ex.costUsd,
                                ex.costSource !== 'reported' && ex.costSource !== 'local',
                                { precise: true, local: ex.costSource === 'local' },
                              )}
                            </span>
                          )}
                          {(ex.inputTokens != null || ex.outputTokens != null) && (
                            <span className="tabular-nums text-muted-foreground">
                              {' '}
                              · {ex.inputTokens ?? 0} in, {ex.outputTokens ?? 0} out
                            </span>
                          )}
                          {ex.error && (
                            <div className="mt-1 whitespace-pre-wrap break-words text-xs text-muted-foreground">
                              {ex.error}
                            </div>
                          )}
                        </li>
                      )
                    })}
                  </ol>
                </Section>
              )}

              <Section
                title="Comments"
                count={otherComments.length > 0 ? otherComments.length : undefined}
                testId="task-comments-section"
              >
                {otherComments.length > 0 ? (
                  <TaskComments
                    comments={otherComments}
                    after={(c) => {
                      const r = c.id ? receipts.get(c.id) : undefined
                      return r ? (
                        <ReplyReceipt
                          delivery={r.delivery}
                          task={task}
                          body={r.body}
                          onFollowUp={() => onChanged?.()}
                        />
                      ) : null
                    }}
                  />
                ) : null}
                <TaskReplyBox
                  taskId={task.id}
                  status={task.status}
                  agentName={ownerId ? (ownerName ?? ownerId) : null}
                  onSent={({ commentId, delivery, body }) => {
                    if (commentId && delivery) {
                      setReceipts((m) => new Map(m).set(commentId, { delivery, body }))
                    }
                    refreshAfterAction()
                  }}
                />
              </Section>

              <div className="mt-8 border-t border-border" />
              <Section title="Activity" testId="task-activity">
                <ActivityTerminal scope={{ taskId }} maxHeight={260} hideHeader />
              </Section>
            </>
          )}
        </div>
      </div>
    </Modal>
  )
}
