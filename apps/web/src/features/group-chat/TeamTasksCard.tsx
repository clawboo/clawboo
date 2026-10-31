// The team chat's Tasks card: every board task this team has, in sections
// (Needs you, In progress, To do, Done, Cancelled), and a task's detail inside
// the same card: its progress, its comment log, and a composer that comments on
// the task and, through the server, passes the comment on to the agent doing it.
//
// The list reads the live board projection (`useBoardStore`), the store the team
// chat's stream already keeps current, so the card follows the work without a
// fetch of its own. Only the open task's detail (its comments, cost and runtime)
// is read from the board API.

import { useEffect, useMemo, useState, type ReactNode } from 'react'
import { delegationTargetOf } from '@clawboo/board-core'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { ChevronDown, ChevronRight, KanbanSquare, ListChecks } from 'lucide-react'

import { AgentBooAvatar } from '@/components/AgentBooAvatar'
import { InlineApprovalCard } from '@/features/approvals/InlineApprovalCard'
import { ToolApprovalCard } from '@/features/approvals/ToolApprovalCard'
import { usePendingApprovals } from '@/features/approvals/usePendingApprovals'
import { attentionLabel, taskAttentionOf } from '@/features/board/boardStatus'
import { ReplyReceipt } from '@/features/board/ReplyReceipt'
import { TaskComments, type TaskComment } from '@/features/board/TaskComments'
import { formatRunCost, runCostOf } from '@/features/board/taskCost'
import { MD_COMPONENTS } from '@/features/chat/chatComponents'
import { ActivityTerminal } from '@/features/obs/ActivityTerminal'
import { resolveRuntimeMark } from '@/features/runtimes/RuntimeBrand'
import { Button, IconButton } from '@/features/shared/Button'
import { EmptyState } from '@/features/shared/EmptyState'
import { FloatingCard } from '@/features/shared/FloatingCard'
import { StatusPill } from '@/features/shared/StatusPill'
import { boardClient, postTaskComment, type BoardTask, type ReplyDelivery } from '@/lib/boardClient'
import { useBoardStore, type BoardTaskView } from '@/stores/board'
import { useFleetStore } from '@/stores/fleet'
import { useTeamStore } from '@/stores/team'
import { useToastStore } from '@/stores/toast'
import { useViewStore } from '@/stores/view'

import { toneFor } from './BoardTaskCard'
import {
  TASK_SECTIONS,
  groupTeamTasks,
  shortWhen,
  tasksInRoom,
  type TaskSectionId,
} from './teamTasks'

const EMPTY_TASKS = new Map<string, BoardTaskView>()

function useAgentName(agentId: string | null): string | null {
  return useFleetStore((s) =>
    agentId ? (s.agents.find((a) => a.id === agentId)?.name ?? null) : null,
  )
}

function firstLine(text: string): string {
  return (
    text
      .split('\n')
      .map((l) => l.replace(/^[#>*\-\s]+/, '').trim())
      .find((l) => l.length > 0) ?? ''
  )
}

/** The muted line under a task's title: why it waits on you, what it reported,
 *  or simply where it stands. */
function subtitleOf(task: BoardTaskView, assigneeName: string | null): string {
  const attention = taskAttentionOf(task)
  if (attention) {
    const label = attentionLabel(attention)
    return attention.detail ? `${label}: ${attention.detail}` : label
  }
  if (task.summary) return firstLine(task.summary)
  const { label } = toneFor(task)
  return assigneeName ? `${label} · ${assigneeName}` : label
}

// ─── List ────────────────────────────────────────────────────────────────────

function TaskRow({ task, onOpen }: { task: BoardTaskView; onOpen: () => void }) {
  const assigneeName = useAgentName(task.assigneeAgentId)
  return (
    <button
      type="button"
      onClick={onOpen}
      data-testid="team-task-row"
      className="flex w-full cursor-pointer items-center gap-3 rounded-lg px-2.5 py-2 text-left transition-colors duration-150 hover:bg-foreground/[0.04]"
    >
      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="truncate text-[13px] font-medium text-foreground">
          {task.title || 'Untitled task'}
        </span>
        <span className="truncate text-[11.5px] text-muted-foreground">
          {subtitleOf(task, assigneeName)}
        </span>
      </span>
      {task.assigneeAgentId && <AgentBooAvatar agentId={task.assigneeAgentId} size={20} />}
      <time className="font-data w-10 shrink-0 text-right text-[11px] tabular-nums text-muted-foreground">
        {shortWhen(task.updatedAt)}
      </time>
    </button>
  )
}

function SectionHeader({
  label,
  count,
  open,
  onToggle,
}: {
  label: string
  count: number
  open: boolean
  onToggle: () => void
}) {
  return (
    <button
      type="button"
      aria-expanded={open}
      onClick={onToggle}
      className="flex w-full cursor-pointer items-center gap-1.5 rounded-lg bg-foreground/[0.035] px-2.5 py-1.5 text-left transition-colors hover:bg-foreground/[0.06]"
    >
      <ChevronDown
        size={13}
        aria-hidden
        className="shrink-0 text-muted-foreground transition-transform duration-150"
        style={{ rotate: open ? '0deg' : '-90deg' }}
      />
      <span className="text-[12.5px] font-semibold text-foreground">{label}</span>
      <span className="font-data text-[11.5px] tabular-nums text-muted-foreground">{count}</span>
    </button>
  )
}

type TaskApprovals = Pick<ReturnType<typeof usePendingApprovals>, 'exec' | 'tool' | 'resolveTool'>

/** Tasks in sections (Needs you, In progress, ...), with the approvals waiting
 *  on a person under Needs you. `after` is shown below the sections, in the same
 *  scrolling list. */
function TaskSections({
  tasks,
  loaded,
  approvals,
  emptyHelper,
  onOpen,
  after,
}: {
  tasks: BoardTaskView[]
  loaded: boolean
  approvals: TaskApprovals
  emptyHelper: string
  onOpen: (taskId: string) => void
  after?: ReactNode
}) {
  const groups = useMemo(() => groupTeamTasks(tasks), [tasks])
  const { exec, tool, resolveTool } = approvals

  const [open, setOpen] = useState<Record<TaskSectionId, boolean>>(
    () =>
      Object.fromEntries(TASK_SECTIONS.map((s) => [s.id, s.defaultOpen])) as Record<
        TaskSectionId,
        boolean
      >,
  )

  const nothing = loaded && tasks.length === 0 && exec.length + tool.length === 0
  if (nothing && !after) {
    return <EmptyState icon={ListChecks} title="No tasks yet" helper={emptyHelper} />
  }

  return (
    <div className="flex h-full flex-col gap-1.5 overflow-y-auto p-2" data-testid="team-task-list">
      {nothing && <p className="px-2.5 py-1.5 text-[12px] text-muted-foreground">{emptyHelper}</p>}
      {!nothing &&
        TASK_SECTIONS.map((section) => {
          const rows = groups[section.id]
          const isNeedsYou = section.id === 'needs_you'
          const count = rows.length + (isNeedsYou ? exec.length + tool.length : 0)
          // Needs you always shows, so "nothing waits on you" is said, not implied.
          if (count === 0 && !isNeedsYou) return null
          const isOpen = open[section.id]
          return (
            <section key={section.id} data-testid={`team-task-section-${section.id}`}>
              <SectionHeader
                label={section.label}
                count={count}
                open={isOpen}
                onToggle={() => setOpen((o) => ({ ...o, [section.id]: !o[section.id] }))}
              />
              {isOpen && (
                <div className="flex flex-col pt-1">
                  {isNeedsYou && count === 0 && (
                    <p className="px-2.5 py-1.5 text-[12px] text-muted-foreground">
                      Failed, stopped and unassigned tasks, and approvals, wait here.
                    </p>
                  )}
                  {isNeedsYou &&
                    exec.map((a) => (
                      <div key={`exec-${a.id}`} className="px-1 pb-2">
                        <InlineApprovalCard approval={a} showAgentName variant="board" />
                      </div>
                    ))}
                  {isNeedsYou &&
                    tool.map((a) => (
                      <div key={`tool-${a.id}`} className="px-1 pb-2">
                        <ToolApprovalCard approval={a} onResolve={resolveTool} compact />
                      </div>
                    ))}
                  {rows.map((t) => (
                    <TaskRow key={t.id} task={t} onOpen={() => onOpen(t.id)} />
                  ))}
                </div>
              )}
            </section>
          )
        })}
      {after}
    </div>
  )
}

function TaskList({
  teamId,
  roomId,
  onOpen,
}: {
  teamId: string
  roomId: string | null
  onOpen: (taskId: string) => void
}) {
  const teamTasks = useBoardStore((s) => s.tasksByTeam.get(teamId) ?? EMPTY_TASKS)
  const loaded = useBoardStore((s) => s.loadedTeams.has(teamId))
  // This chat's tasks only: the team's own group chat holds the tasks with no
  // room, a room holds its own. The Board still shows every one.
  const tasks = useMemo(() => tasksInRoom(teamTasks.values(), roomId), [teamTasks, roomId])
  const approvals = usePendingApprovals({ teamId, includeUnscoped: true })
  return (
    <TaskSections
      tasks={tasks}
      loaded={loaded}
      approvals={approvals}
      emptyHelper="When the team takes on work from the chat, its tasks show up here."
      onOpen={onOpen}
    />
  )
}

// ─── Detail ──────────────────────────────────────────────────────────────────

function SectionLabel({ children }: { children: string }) {
  return (
    <h4 className="mb-1.5 font-mono text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
      {children}
    </h4>
  )
}

function outputOf(task: BoardTaskView, comments: TaskComment[] | null): string | null {
  if (task.summary) return task.summary
  const settled = task.status === 'done' || task.status === 'blocked' || task.status === 'cancelled'
  if (!settled || !comments) return null
  const last = [...comments]
    .reverse()
    .find(
      (c) =>
        (c.authorType === 'agent' || c.authorType === 'system') &&
        typeof c.body === 'string' &&
        c.body.trim().length > 0,
    )
  return last?.body ?? null
}

/** How a comment reaches a task that is running now, by the agent's runtime.
 *  `live`: into the running turn at its next step. `resume`: the runtime takes no
 *  input mid-run (Hermes), so its run is paused and picked back up with the
 *  comment. Anything else reads its mailbox at its next run. */
const MID_RUN_DELIVERY: Record<string, 'live' | 'resume'> = {
  'clawboo-native': 'live',
  'claude-code': 'live',
  codex: 'live',
  openclaw: 'live',
  hermes: 'resume',
}

/** What sending does for this task, in the person's words. */
function composerHint(
  task: BoardTaskView,
  name: string | null,
  runtime: string | null,
  hasAgent: boolean,
): string {
  if (task.status === 'done' || task.status === 'cancelled')
    return 'This task is finished. You can send your comment as a follow-up task.'
  if (!hasAgent) return 'No agent is on this task yet. Your comment is saved on it.'
  const who = name ?? 'The agent'
  if (task.status === 'in_progress') {
    const delivery = runtime ? MID_RUN_DELIVERY[runtime] : undefined
    if (delivery === 'live') return `${who} gets this now, before its next step.`
    if (delivery === 'resume') return `${who} pauses to read this, then carries on.`
    return `${who} sees this the next time it checks in.`
  }
  if (task.status === 'in_review') return `${who} sees this the next time it runs.`
  if (task.status === 'blocked' || task.status === 'todo')
    return `Sending starts ${name ?? 'the agent'} on this again.`
  return `${who} reads this when the task starts.`
}

function TaskDetail({ task }: { task: BoardTaskView }) {
  const assigneeName = useAgentName(task.assigneeAgentId)
  // The fleet's runtime, not the task row's: the engine records the real runtime
  // only when a run ends. An agent hydrated from the Gateway carries no runtime,
  // which means OpenClaw (as everywhere else in the app); an agent the fleet
  // doesn't know stays null.
  const assigneeRuntime = useFleetStore((s) => {
    const agent = task.assigneeAgentId
      ? s.agents.find((a) => a.id === task.assigneeAgentId)
      : undefined
    return agent ? (agent.runtime ?? 'openclaw') : null
  })
  const addToast = useToastStore((s) => s.addToast)

  const [row, setRow] = useState<BoardTask | null>(null)
  const [comments, setComments] = useState<TaskComment[] | null>(null)
  const [reloadKey, setReloadKey] = useState(0)
  useEffect(() => {
    let cancelled = false
    void boardClient.getTask(task.id).then((detail) => {
      if (cancelled || !detail) return
      setRow(detail.task)
      setComments(detail.comments as TaskComment[])
    })
    return () => {
      cancelled = true
    }
  }, [task.id, task.status, task.updatedAt, reloadKey])

  const [draft, setDraft] = useState('')
  const [sending, setSending] = useState(false)
  // The agent the task belongs to: its assignee, or the agent it is bound to
  // while it waits (a move back to To do clears the assignee, not the binding).
  const boundId =
    task.assigneeAgentId ??
    delegationTargetOf(typeof row?.sourceDelegationId === 'string' ? row.sourceDelegationId : null)
  const boundName = useAgentName(boundId)
  // Where each reply sent from here went, by comment id.
  const [receipts, setReceipts] = useState<Map<string, { delivery: ReplyDelivery; body: string }>>(
    () => new Map(),
  )

  const send = async (): Promise<void> => {
    const body = draft.trim()
    if (!body || sending) return
    setSending(true)
    const res = await postTaskComment(task.id, body)
    setSending(false)
    if (!res.ok) {
      addToast({ type: 'error', message: 'Couldn’t send your comment. Please try again.' })
      return
    }
    setDraft('')
    if (res.commentId && res.delivery) {
      const { commentId, delivery } = res
      setReceipts((m) => new Map(m).set(commentId, { delivery, body }))
    }
    setReloadKey((n) => n + 1)
  }

  const { tone, label } = toneFor(task)
  const runtime = typeof row?.assigneeRuntime === 'string' ? row.assigneeRuntime : null
  const cost = row ? runCostOf(row) : null
  const description = typeof row?.description === 'string' ? row.description.trim() : ''
  const output = outputOf(task, comments)

  return (
    <div className="flex h-full flex-col" data-testid="team-task-detail">
      <div className="min-h-0 flex-1 overflow-y-auto px-4 py-3">
        <h3 className="text-[15px] font-semibold leading-snug tracking-[-0.01em] text-foreground">
          {task.title || 'Untitled task'}
        </h3>
        {description && (
          <p className="mt-1 whitespace-pre-wrap text-[12.5px] leading-relaxed text-muted-foreground">
            {description}
          </p>
        )}
        <div className="mt-2.5 flex flex-wrap items-center gap-x-3 gap-y-1.5 text-[12px] text-muted-foreground">
          <StatusPill tone={tone} label={label} />
          <span className="flex items-center gap-1.5">
            {task.assigneeAgentId && <AgentBooAvatar agentId={task.assigneeAgentId} size={18} />}
            <span className="text-foreground/80">{assigneeName ?? 'Unassigned'}</span>
          </span>
          {runtime && <span>{resolveRuntimeMark(runtime).label}</span>}
          {cost?.usd != null && (
            <span className="font-data tabular-nums">
              {formatRunCost(cost.usd, cost.estimated)}
            </span>
          )}
        </div>

        {output && (
          <div className="mt-4">
            <SectionLabel>{task.status === 'done' ? 'Output' : 'Latest report'}</SectionLabel>
            <div className="text-[12.5px] leading-relaxed text-foreground">
              <ReactMarkdown remarkPlugins={[remarkGfm]} components={MD_COMPONENTS}>
                {output}
              </ReactMarkdown>
            </div>
          </div>
        )}

        <div className="mt-4">
          <SectionLabel>Progress</SectionLabel>
          <ActivityTerminal scope={{ taskId: task.id }} maxHeight={220} hideHeader />
        </div>

        <div className="mt-4">
          <SectionLabel>Comments</SectionLabel>
          {comments ? (
            <TaskComments
              comments={comments}
              compact
              after={(c) => {
                const r = c.id ? receipts.get(c.id) : undefined
                return r ? (
                  <ReplyReceipt
                    delivery={r.delivery}
                    task={{ id: task.id, title: task.title, teamId: row?.teamId ?? null }}
                    body={r.body}
                  />
                ) : null
              }}
            />
          ) : (
            <div className="text-[11.5px] text-muted-foreground">Loading…</div>
          )}
        </div>
      </div>

      <form
        className="shrink-0 border-t border-border p-2.5"
        onSubmit={(e) => {
          e.preventDefault()
          void send()
        }}
      >
        <div className="rounded-xl border border-border bg-background transition-colors focus-within:border-foreground/30">
          <textarea
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
                e.preventDefault()
                void send()
              }
            }}
            rows={2}
            aria-label="Comment or steer this task"
            placeholder="Comment or steer this task…"
            data-testid="team-task-composer"
            className="block w-full resize-none bg-transparent px-3 py-2 text-[13px] text-foreground placeholder:text-muted-foreground focus-visible:outline-none!"
          />
          <div className="flex items-center gap-2 px-2 pb-2">
            <span className="min-w-0 flex-1 truncate px-1 text-[11px] text-muted-foreground">
              {composerHint(task, boundName, assigneeRuntime, boundId != null)}
            </span>
            <Button type="submit" size="sm" variant="primary" disabled={!draft.trim() || sending}>
              Send
            </Button>
          </div>
        </div>
      </form>
    </div>
  )
}

// ─── Card ────────────────────────────────────────────────────────────────────

export function TeamTasksCard({
  teamId,
  roomId = null,
  maximized = false,
  onToggleMaximize,
  onClose,
}: {
  teamId: string
  /** One of the team's chat rooms; null = the team's own group chat. */
  roomId?: string | null
  maximized?: boolean
  onToggleMaximize?: () => void
  onClose?: () => void
}) {
  const [openTaskId, setOpenTaskId] = useState<string | null>(null)
  const openTask = useBoardStore((s) =>
    openTaskId ? (s.tasksByTeam.get(teamId)?.get(openTaskId) ?? null) : null,
  )
  // The projection is kept current by the team chat's stream; load it once here
  // in case this card mounts before the chat has.
  const loaded = useBoardStore((s) => s.loadedTeams.has(teamId))
  useEffect(() => {
    if (!loaded)
      void useBoardStore
        .getState()
        .load(teamId)
        .catch(() => undefined)
  }, [loaded, teamId])

  // A different team, or a task that left the projection, falls back to the list.
  useEffect(() => setOpenTaskId(null), [teamId, roomId])
  const back = (): void => setOpenTaskId(null)

  const title = openTask ? (
    <span className="flex min-w-0 items-center gap-1">
      <button
        type="button"
        onClick={back}
        className="shrink-0 cursor-pointer rounded px-0.5 text-muted-foreground transition-colors hover:text-foreground"
        data-testid="team-tasks-back"
      >
        Tasks
      </button>
      <ChevronRight size={12} aria-hidden className="shrink-0 text-muted-foreground" />
      <span className="truncate">{openTask.title || 'Untitled task'}</span>
    </span>
  ) : (
    'Tasks'
  )

  const openOnBoard = openTask ? (
    <IconButton
      size="sm"
      label="Open on Board"
      onClick={() => useViewStore.getState().openBoardTask(openTask.id, teamId)}
      className="h-6 w-6 text-muted-foreground"
    >
      <KanbanSquare size={13} />
    </IconButton>
  ) : null
  const body = (
    <div
      className="h-full"
      onKeyDown={(e) => {
        // Escape inside an open task goes back to the list. preventDefault keeps
        // it from also reaching the app-level Escape handling.
        if (e.key === 'Escape' && openTask && !e.defaultPrevented) {
          e.preventDefault()
          back()
        }
      }}
    >
      {openTask ? (
        <TaskDetail key={openTask.id} task={openTask} />
      ) : (
        <TaskList teamId={teamId} roomId={roomId} onOpen={setOpenTaskId} />
      )}
    </div>
  )

  return (
    <FloatingCard
      title={title}
      icon={ListChecks}
      testId="team-card-tasks"
      closeLabel="Close tasks"
      actions={openOnBoard}
      maximized={maximized}
      onToggleMaximize={onToggleMaximize}
      onClose={onClose}
    >
      {body}
    </FloatingCard>
  )
}

// ─── One agent's tasks ───────────────────────────────────────────────────────

const NO_TEAMS: string[] = []

/** The same list and task detail, for the tasks assigned to one agent (its
 *  team's board; every team's for an agent on no team, such as Boo Zero).
 *  `after` is shown below the task sections, in the same scrolling list. */
export function AgentTasks({
  agentId,
  title,
  after,
  openTaskId,
  onOpenTask,
}: {
  agentId: string
  /** What the back link in an open task reads. */
  title: string
  after?: ReactNode
  openTaskId: string | null
  onOpenTask: (taskId: string | null) => void
}) {
  const agentTeamId = useFleetStore((s) => s.agents.find((a) => a.id === agentId)?.teamId ?? null)
  const teams = useTeamStore((s) => s.teams)
  const teamIdsKey = agentTeamId
    ? agentTeamId
    : teams
        .filter((t) => !t.isArchived)
        .map((t) => t.id)
        .join(',')
  const teamIds = useMemo(() => (teamIdsKey ? teamIdsKey.split(',') : NO_TEAMS), [teamIdsKey])

  const tasksByTeam = useBoardStore((s) => s.tasksByTeam)
  const loadedTeams = useBoardStore((s) => s.loadedTeams)
  const loaded = teamIds.every((id) => loadedTeams.has(id))
  useEffect(() => {
    const board = useBoardStore.getState()
    for (const id of teamIds) {
      if (!board.loadedTeams.has(id)) void board.load(id).catch(() => undefined)
    }
  }, [teamIds])

  // Each task with the team it is on (the Board opens it there).
  const owned = useMemo(() => {
    const out: Array<{ task: BoardTaskView; teamId: string }> = []
    for (const id of teamIds) {
      for (const task of tasksByTeam.get(id)?.values() ?? []) {
        if (task.assigneeAgentId === agentId) out.push({ task, teamId: id })
      }
    }
    return out
  }, [tasksByTeam, teamIds, agentId])
  const tasks = useMemo(() => owned.map((o) => o.task), [owned])
  const open = openTaskId ? (owned.find((o) => o.task.id === openTaskId) ?? null) : null
  const approvals = usePendingApprovals({ agentId })

  if (open) {
    return (
      <div
        className="flex h-full flex-col"
        onKeyDown={(e) => {
          // Escape inside an open task goes back to the list.
          if (e.key === 'Escape' && !e.defaultPrevented) {
            e.preventDefault()
            onOpenTask(null)
          }
        }}
      >
        <div className="flex h-10 shrink-0 items-center gap-2 border-b border-border px-3 text-[12.5px] font-semibold text-foreground">
          <span className="flex min-w-0 flex-1 items-center gap-1">
            <button
              type="button"
              onClick={() => onOpenTask(null)}
              className="shrink-0 cursor-pointer rounded px-0.5 text-muted-foreground transition-colors hover:text-foreground"
              data-testid="agent-tasks-back"
            >
              {title}
            </button>
            <ChevronRight size={12} aria-hidden className="shrink-0 text-muted-foreground" />
            <span className="truncate">{open.task.title || 'Untitled task'}</span>
          </span>
          <IconButton
            size="sm"
            label="Open on Board"
            onClick={() => useViewStore.getState().openBoardTask(open.task.id, open.teamId)}
            className="h-6 w-6 text-muted-foreground"
          >
            <KanbanSquare size={13} />
          </IconButton>
        </div>
        <div className="min-h-0 flex-1">
          <TaskDetail key={open.task.id} task={open.task} />
        </div>
      </div>
    )
  }

  return (
    <TaskSections
      tasks={tasks}
      loaded={loaded}
      approvals={approvals}
      emptyHelper="No tasks assigned to this agent yet."
      onOpen={onOpenTask}
      after={after}
    />
  )
}
