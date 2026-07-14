// Renders a durable BOARD task row inline in the group chat — the surface where a
// delegated teammate's output lives (instead of a duplicate chat message). Driven
// by the projection store (`stores/board.ts`); status flips live as the board
// change-feed updates the projection, and the output is fetched lazily from the
// task's report-up comment. The output is collapsible so a long deliverable
// doesn't swamp the timeline (the full text is always on the board task drawer).
//
// Visual anatomy (matches DelegationCard's tint-identity language):
//   ┌ header band — assignee avatar + name + TASK micro-label, tinted with the
//   │ assignee's team-palette color; time + StatusPill right-aligned
//   ├ brief — the delegated ask, quote-railed in the same tint
//   └ output — the deliverable, markdown-rendered (MD_COMPONENTS, same pipeline
//     as chat turns), clamped with a fade-out mask + Show more when it overflows

import { memo, useEffect, useLayoutEffect, useRef, useState } from 'react'

import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { motion } from 'framer-motion'
import { ChevronDown } from 'lucide-react'
import { resolveBooTint } from '@clawboo/ui'

import { AgentBooAvatar, useTeamBooColor } from '@/components/AgentBooAvatar'
import { formatTimestamp, MD_COMPONENTS } from '@/features/chat/chatComponents'
import { StatusPill, type StatusTone } from '@/features/shared/StatusPill'
import { boardClient } from '@/lib/boardClient'
import type { BoardTaskView } from '@/stores/board'
import { useBooZeroStore } from '@/stores/booZero'
import { useFleetStore } from '@/stores/fleet'

function toneFor(status: string): { tone: StatusTone; label: string } {
  switch (status) {
    case 'done':
      return { tone: 'done', label: 'Done' }
    case 'in_progress':
      return { tone: 'working', label: 'Working' }
    case 'in_review':
      return { tone: 'warning', label: 'Review' }
    case 'blocked':
      return { tone: 'error', label: 'Blocked' }
    case 'cancelled':
      return { tone: 'error', label: 'Cancelled' }
    default:
      return { tone: 'idle', label: 'Queued' } // todo / backlog
  }
}

// Collapsed output height (~6 rendered lines at 12.5px / 1.6, with headroom for
// a markdown heading). A short deliverable fits under this and gets no toggle;
// a long one is clamped behind a fade-out mask + expandable.
const OUTPUT_COLLAPSED_MAX_PX = 128

export const BoardTaskCard = memo(function BoardTaskCard({ task }: { task: BoardTaskView }) {
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
    teamTint ?? (task.assigneeAgentId ? resolveBooTint(task.assigneeAgentId, isBooZero) : 'var(--mint)')

  // Color is carried by the avatar + the semantic status pill; the tint appears
  // only as a whisper — a small dot by the assignee name. The raw avatar tint is
  // tuned for FILLS (the default 'classic' collection returns theme-independent
  // pastels), so for anything text-adjacent we mix toward --foreground (which
  // flips per theme) to guarantee contrast in both light and dark. color-mix
  // accepts the var(--mint) unassigned fallback too, so no branch is needed.
  const dotTint = `color-mix(in srgb, ${tint} 78%, var(--foreground) 22%)`

  // The report-up output is a board COMMENT, not a task-row field — so a task
  // reloaded after a refresh has `summary: null` in the projection. Fetch it lazily
  // for a terminal task: the agent's deliverable on `done`, or the failure reason
  // on `blocked` / `cancelled` (so an error is visible on the card, not hidden).
  const isTerminal =
    task.status === 'done' || task.status === 'blocked' || task.status === 'cancelled'
  const [output, setOutput] = useState<string | null>(task.summary)
  useEffect(() => {
    if (task.summary) setOutput(task.summary)
  }, [task.summary])
  useEffect(() => {
    if (!isTerminal || output) return
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
  }, [task.id, isTerminal, output])

  const { tone, label } = toneFor(task.status)
  const showOutput = Boolean(output && output.trim().length > 0)

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
            <span className="flex items-center gap-1.5 font-mono text-[10px] uppercase tracking-widest text-foreground/40">
              <span className="font-semibold">Task</span>
              <span aria-hidden className="text-foreground/25">
                ·
              </span>
              <time className="tracking-normal normal-case">{formatTimestamp(task.updatedAt)}</time>
            </span>
          </div>
        </div>
        <StatusPill tone={tone} label={label} />
      </div>

      {/* Body — hairline-separated from the header (card-header / card-body
          structure), the ask as a clean headline, then the deliverable. */}
      <div className="border-t border-border px-4 pb-4 pt-3">
        {/* The brief — the delegated ask, rendered as the card's lead line (no
            quote rail): the scannable "what is this task". */}
        <p className="text-[12.5px] font-medium leading-relaxed tracking-[-0.005em] text-foreground/85">
          {task.title}
        </p>

        {showOutput && (
          <div className="mt-3.5">
            <div className="mb-2 flex items-center gap-2.5">
              <span className="font-mono text-[10px] font-semibold uppercase tracking-widest text-foreground/35">
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
      </div>
    </motion.div>
  )
})
