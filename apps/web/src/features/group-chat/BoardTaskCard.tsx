// Renders a durable BOARD task row inline in the group chat — the surface where a
// delegated teammate's output lives (instead of a duplicate chat message). Driven
// by the projection store (`stores/board.ts`); status flips live as the board
// change-feed updates the projection, and the output is fetched lazily from the
// task's report-up comment. The output is collapsible so a long deliverable
// doesn't swamp the timeline (the full text is always on the board task drawer).
//
// Visual anatomy (matches DelegationCard's tint-identity language):
//   ┌ header band — assignee avatar + name + TASK micro-label, tinted with the
//   │ assignee's team-palette color; time + StatusPill + "Open on board" right
//   ├ brief — the delegated ask, quote-railed in the same tint
//   ├ output — the deliverable, markdown-rendered (MD_COMPONENTS, same pipeline
//   │ as chat turns), clamped with a fade-out mask + Show more when it overflows
//   └ trail: the task's comments and live activity, folded away until asked for,
//     so a failure (or a surprising result) can be traced without leaving chat

import { memo, useEffect, useId, useLayoutEffect, useRef, useState } from 'react'

import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { motion } from 'framer-motion'
import { ChevronDown, History, Maximize2 } from 'lucide-react'
import { resolveBooTint } from '@clawboo/ui'

import { AgentBooAvatar, useTeamBooColor } from '@/components/AgentBooAvatar'
import { TaskComments, type TaskComment } from '@/features/board/TaskComments'
import {
  ATTENTION_META,
  attentionLabel,
  isTaskStatus,
  statusLabel,
  taskAttentionOf,
  type TaskStatus,
} from '@/features/board/boardStatus'
import { formatTimestamp, MD_COMPONENTS } from '@/features/chat/chatComponents'
import { ActivityTerminal } from '@/features/obs/ActivityTerminal'
import { StatusPill, type StatusTone } from '@/features/shared/StatusPill'
import { boardClient } from '@/lib/boardClient'
import type { BoardTaskView } from '@/stores/board'
import { useBooZeroStore } from '@/stores/booZero'
import { useFleetStore } from '@/stores/fleet'
import { useViewStore } from '@/stores/view'

// Compact pill vocabulary for the chat timeline. Deliberately SHORTER than the
// board's STATUS_LABEL ("Working", not "In progress") because this pill sits in a
// narrow card beside an avatar and a timestamp; `todo` and `backlog` both read as
// "Queued" since triage position is board detail, not chat signal.
//
// Typed as a TOTAL Record over the shared TaskStatus union, so adding an eighth
// status to @clawboo/board-core fails the typecheck here instead of silently
// rendering the new status as idle "Queued" work.
const PILL: Record<TaskStatus, { tone: StatusTone; label: string }> = {
  backlog: { tone: 'idle', label: 'Queued' },
  todo: { tone: 'idle', label: 'Queued' },
  in_progress: { tone: 'working', label: 'Working' },
  in_review: { tone: 'working', label: 'Verifying' },
  blocked: { tone: 'error', label: 'Blocked' },
  done: { tone: 'done', label: 'Done' },
  cancelled: { tone: 'error', label: 'Cancelled' },
}

function toneFor(task: BoardTaskView): { tone: StatusTone; label: string } {
  // A task that needs a person says WHY ("Failed", "Stopped", "Unassigned"),
  // rather than reading as queued or plain blocked work.
  const attention = taskAttentionOf(task)
  if (attention)
    return { tone: ATTENTION_META[attention.reason].tone, label: attentionLabel(attention) }
  // An off-list status (the board parks these in its catch-all "Other" column)
  // shows its raw name rather than being mislabelled as queued work.
  return isTaskStatus(task.status)
    ? PILL[task.status]
    : { tone: 'idle', label: statusLabel(task.status) }
}

type TrailTab = 'comments' | 'activity'
const TRAIL_TOGGLE =
  'flex cursor-pointer items-center gap-1 font-mono text-[10px] uppercase tracking-wider text-foreground/50 transition-colors hover:text-foreground/80'

// Collapsed output height (~6 rendered lines at 12.5px / 1.6, with headroom for
// a markdown heading). A short deliverable fits under this and gets no toggle;
// a long one is clamped behind a fade-out mask + expandable.
const OUTPUT_COLLAPSED_MAX_PX = 128

export const BoardTaskCard = memo(function BoardTaskCard({
  task,
  teamId = null,
}: {
  task: BoardTaskView
  /** The team whose chat shows this card. "Open on board" switches the board's team
   *  filter to it only when a filter set to another team would hide the task. */
  teamId?: string | null
}) {
  const assigneeName = useFleetStore((s) =>
    task.assigneeAgentId
      ? (s.agents.find((a) => a.id === task.assigneeAgentId)?.name ?? null)
      : null,
  )

  // Tint identity — the exact color the assignee's avatar paints with (team
  // palette → hashed boo tint), so the card visually belongs to its Boo. The
  // unassigned fallback is a CSS var, which is why alphas below use color-mix
  // instead of hex-suffix concatenation.
  const booZeroAgentId = useBooZeroStore((s) => s.booZeroAgentId)
  const isBooZero = task.assigneeAgentId !== null && task.assigneeAgentId === booZeroAgentId
  const teamTint = useTeamBooColor(task.assigneeAgentId ?? '', isBooZero)
  const tint =
    teamTint ??
    (task.assigneeAgentId ? resolveBooTint(task.assigneeAgentId, isBooZero) : 'var(--mint)')

  // Color is carried by the avatar + the semantic status pill; the tint appears
  // only as a whisper — a small dot by the assignee name. The raw avatar tint is
  // tuned for FILLS (the default 'classic' collection returns theme-independent
  // pastels), so for anything text-adjacent we mix toward --foreground (which
  // flips per theme) to guarantee contrast in both light and dark. color-mix
  // accepts the var(--mint) unassigned fallback too, so no branch is needed.
  const dotTint = `color-mix(in srgb, ${tint} 78%, var(--foreground) 22%)`

  // The report-up output is a board COMMENT, not a task-row field — so a task
  // reloaded after a refresh has `summary: null` in the projection. Fetch it lazily
  // once the task has settled somewhere that carries one: the agent's deliverable
  // on `done`, or the failure reason on `blocked` / `cancelled`.
  //
  // This is deliberately NOT the state machine's `isTerminal` (`done`/`cancelled`),
  // and must not be "corrected" to it. A failed run is parked on **`blocked`**, and
  // that is exactly where the orchestrator writes the reason comment — see
  // packages/team-orchestration/src/boardOrchestration.ts (`updateStatus(taskId,
  // 'blocked')` immediately followed by `addComment(...)`). Narrowing this to the
  // terminal pair would hide every failure reason from the chat card, which is the
  // opposite of the point: an error should be visible here, not buried in the drawer.
  const hasSettledOutput =
    task.status === 'done' || task.status === 'blocked' || task.status === 'cancelled'
  const [output, setOutput] = useState<string | null>(task.summary)
  useEffect(() => {
    if (task.summary) {
      setOutput(task.summary)
    } else if (!hasSettledOutput) {
      // Leaving a settled status invalidates a previously-fetched report-up:
      // `blocked → in_progress → blocked` is a legal retry path and each failure
      // writes a NEW reason comment, so a kept `output` would both display the
      // stale reason mid-retry and block the re-fetch when the task settles again.
      setOutput(null)
    }
  }, [task.summary, hasSettledOutput])
  useEffect(() => {
    if (!hasSettledOutput || output) return
    let cancelled = false
    void boardClient.getTask(task.id).then((detail) => {
      if (cancelled || !detail) return
      const comments = detail.comments as Array<{ body?: unknown; authorType?: unknown }>
      const last = [...comments]
        .reverse()
        .find(
          (c) =>
            (c.authorType === 'agent' || c.authorType === 'system') &&
            typeof c.body === 'string' &&
            c.body.trim().length > 0,
        )
      if (last && typeof last.body === 'string') setOutput(last.body)
    })
    return () => {
      cancelled = true
    }
  }, [task.id, hasSettledOutput, output])

  const { tone, label } = toneFor(task)
  const attention = taskAttentionOf(task)
  const showOutput = Boolean(output && output.trim().length > 0)

  // The trail: the task's comment log and its live activity, folded away until
  // asked for. The comments are re-read whenever the card's status moves while
  // it is open, so a retry or a failure lands in the log as it happens. The
  // activity feed subscribes only while its tab is showing.
  const trailId = useId()
  const [trailOpen, setTrailOpen] = useState(false)
  const [trailTab, setTrailTab] = useState<TrailTab>('comments')
  const [comments, setComments] = useState<TaskComment[] | null>(null)
  // A read that failed is not one still pending: it says so and offers Retry,
  // which reads again, rather than showing "Loading…" for good.
  const [commentsFailed, setCommentsFailed] = useState(false)
  const [commentsAttempt, setCommentsAttempt] = useState(0)
  useEffect(() => {
    if (!trailOpen) return
    let cancelled = false
    void boardClient
      .getTask(task.id)
      .catch(() => null)
      .then((detail) => {
        if (cancelled) return
        if (detail) {
          setComments(detail.comments as TaskComment[])
          setCommentsFailed(false)
        } else {
          setCommentsFailed(true)
        }
      })
    return () => {
      cancelled = true
    }
  }, [trailOpen, task.id, task.status, task.updatedAt, commentsAttempt])
  const retryComments = (): void => {
    setCommentsFailed(false)
    setCommentsAttempt((n) => n + 1)
  }
  const openOnBoard = (): void => useViewStore.getState().openBoardTask(task.id, teamId)

  // Collapsible output — measure the rendered height so the "Show more" toggle only
  // appears when there is actually something hidden below the fold.
  const [expanded, setExpanded] = useState(false)
  const [overflows, setOverflows] = useState(false)
  const outRef = useRef<HTMLDivElement | null>(null)
  useLayoutEffect(() => {
    const el = outRef.current
    if (!el || !showOutput) {
      setOverflows(false)
      return
    }
    setOverflows(el.scrollHeight > OUTPUT_COLLAPSED_MAX_PX + 4)
  }, [output, showOutput])

  const collapsed = !expanded && overflows

  return (
    <motion.div
      initial={{ opacity: 0, y: 6 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.28, ease: [0.22, 0.61, 0.36, 1] }}
      className="group max-w-[70ch] overflow-hidden rounded-2xl border border-border bg-surface shadow-tier-raised transition-[box-shadow,border-color] duration-200 hover:border-border-strong hover:shadow-tier-floating"
      data-testid="board-task-card"
      data-task-status={task.status}
    >
      {/* Header — clean identity row on a faint header shelf, no tinted wash.
          Color is carried only by the avatar and the status pill; the name gets
          a small tint dot. Avatar 30px matches the timeline's author headers. */}
      <div className="flex items-start justify-between gap-3 bg-foreground/[0.015] px-4 pt-3.5 pb-3">
        <div className="flex min-w-0 items-center gap-2.5">
          {task.assigneeAgentId && <AgentBooAvatar agentId={task.assigneeAgentId} size={30} />}
          <div className="flex min-w-0 flex-col gap-1">
            <span className="flex min-w-0 items-center gap-1.5">
              <span
                aria-hidden
                className="h-1.5 w-1.5 shrink-0 rounded-full"
                style={{ background: dotTint }}
              />
              <span className="truncate font-mono text-[11.5px] font-semibold text-foreground">
                {assigneeName ?? 'Unassigned'}
              </span>
            </span>
            <span className="flex items-center gap-1.5 font-mono text-[10px] uppercase tracking-widest text-muted-foreground">
              <span className="font-semibold">Task</span>
              <span aria-hidden className="text-foreground/25">
                ·
              </span>
              <time className="tracking-normal normal-case">{formatTimestamp(task.updatedAt)}</time>
            </span>
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-1.5">
          <StatusPill tone={tone} label={label} />
          <button
            type="button"
            onClick={openOnBoard}
            aria-label="Open this task on the board"
            title="Open on the board"
            data-testid="board-task-open"
            className="flex h-6 w-6 cursor-pointer items-center justify-center rounded-md text-foreground/40 transition hover:bg-foreground/[0.08] hover:text-foreground/75 focus-visible:outline-2 focus-visible:outline-offset-2"
          >
            <Maximize2 size={13} strokeWidth={2} />
          </button>
        </div>
      </div>

      {/* Body — hairline-separated from the header (card-header / card-body
          structure), the ask as a clean headline, then the deliverable. */}
      <div className="border-t border-border px-4 pb-4 pt-3">
        {/* The brief — the delegated ask, rendered as the card's lead line (no
            quote rail): the scannable "what is this task". */}
        <p className="text-[12.5px] font-medium leading-relaxed tracking-[-0.005em] text-foreground/85">
          {task.title}
        </p>

        {/* Why a stuck task needs a person, when no reason comment is shown below. */}
        {attention && !showOutput && (
          <p
            className="mt-2 text-[12px] leading-relaxed text-foreground/60"
            data-testid="board-task-attention"
          >
            {attention.detail ?? ATTENTION_META[attention.reason].hint}
          </p>
        )}

        {showOutput && (
          <div className="mt-3.5">
            <div className="mb-2 flex items-center gap-2.5">
              <span className="font-mono text-[10px] font-semibold uppercase tracking-widest text-muted-foreground">
                {task.status === 'done' ? 'Output' : 'Reason'}
              </span>
              <div className="h-px flex-1 bg-border" />
            </div>
            <div
              ref={outRef}
              className="break-words text-[12.5px] leading-relaxed text-foreground/80"
              style={{
                maxHeight: expanded ? undefined : OUTPUT_COLLAPSED_MAX_PX,
                overflow: 'hidden',
                // Fade the clamped text out instead of hard-cutting mid-line.
                maskImage: collapsed
                  ? 'linear-gradient(180deg, #000 62%, transparent 100%)'
                  : undefined,
                WebkitMaskImage: collapsed
                  ? 'linear-gradient(180deg, #000 62%, transparent 100%)'
                  : undefined,
              }}
            >
              <ReactMarkdown remarkPlugins={[remarkGfm]} components={MD_COMPONENTS}>
                {output!}
              </ReactMarkdown>
            </div>
            {overflows && (
              <button
                type="button"
                onClick={() => setExpanded((v) => !v)}
                className="mt-1.5 flex cursor-pointer items-center gap-1 font-mono text-[10px] uppercase tracking-wider text-mint/80 transition-colors hover:text-mint"
              >
                {expanded ? 'Show less' : 'Show more'}
                <ChevronDown
                  size={12}
                  className={`transition-transform ${expanded ? 'rotate-180' : ''}`}
                />
              </button>
            )}
          </div>
        )}

        <div className="mt-3.5 flex items-center justify-between gap-3">
          <button
            type="button"
            onClick={() => setTrailOpen((v) => !v)}
            aria-expanded={trailOpen}
            aria-controls={trailId}
            data-testid="board-task-trail-toggle"
            className={TRAIL_TOGGLE}
          >
            <History size={12} strokeWidth={2} />
            Comments &amp; activity
            <ChevronDown
              size={12}
              className={`transition-transform ${trailOpen ? 'rotate-180' : ''}`}
            />
          </button>
          {attention && (
            <button
              type="button"
              onClick={openOnBoard}
              className="cursor-pointer font-mono text-[10px] uppercase tracking-wider text-primary/80 transition-colors hover:text-primary"
            >
              Resolve on board
            </button>
          )}
        </div>

        {trailOpen && (
          <div id={trailId} className="mt-2.5" data-testid="board-task-trail">
            <div role="tablist" aria-label="Task trail" className="mb-2.5 flex items-center gap-1">
              {(
                [
                  ['comments', comments ? `Comments (${comments.length})` : 'Comments'],
                  ['activity', 'Activity'],
                ] as const
              ).map(([id, text]) => (
                <button
                  key={id}
                  type="button"
                  role="tab"
                  aria-selected={trailTab === id}
                  onClick={() => setTrailTab(id)}
                  className={[
                    'cursor-pointer rounded-md px-2 py-1 text-[11px] font-medium transition-colors',
                    trailTab === id
                      ? 'bg-foreground/[0.07] text-foreground'
                      : 'text-foreground/50 hover:text-foreground/80',
                  ].join(' ')}
                >
                  {text}
                </button>
              ))}
            </div>
            {trailTab === 'comments' ? (
              comments === null ? (
                commentsFailed ? (
                  <div
                    className="flex items-center gap-2 text-[11.5px] text-muted-foreground"
                    data-testid="board-task-comments-error"
                  >
                    Couldn’t load the comments.
                    <button
                      type="button"
                      onClick={retryComments}
                      className="cursor-pointer font-mono text-[10px] uppercase tracking-wider text-primary/80 transition-colors hover:text-primary"
                    >
                      Retry
                    </button>
                  </div>
                ) : (
                  <div className="text-[11.5px] text-muted-foreground">Loading…</div>
                )
              ) : (
                <div className="max-h-[260px] overflow-y-auto pr-1">
                  <TaskComments comments={comments} compact />
                </div>
              )
            ) : (
              <ActivityTerminal scope={{ taskId: task.id }} maxHeight={220} hideHeader />
            )}
          </div>
        )}
      </div>
    </motion.div>
  )
})
