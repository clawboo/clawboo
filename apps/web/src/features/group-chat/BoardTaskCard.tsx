// Renders a durable BOARD task row inline in the group chat — the surface where a
// delegated teammate's output lives (instead of a duplicate chat message). Driven
// by the projection store (`stores/board.ts`); status flips live as the board
// change-feed updates the projection, and the output is fetched lazily from the
// task's report-up comment. The output is collapsible so a long deliverable
// doesn't swamp the timeline (the full text is always on the board task drawer).

import { memo, useEffect, useLayoutEffect, useRef, useState } from 'react'

import { ChevronDown } from 'lucide-react'

import { AgentBooAvatar } from '@/components/AgentBooAvatar'
import { StatusPill, type StatusTone } from '@/features/shared/StatusPill'
import { boardClient } from '@/lib/boardClient'
import type { BoardTaskView } from '@/stores/board'
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

// Collapsed output height (~5 lines at 12.5px / 1.6). A short deliverable (a
// 1-line poem) fits under this and gets no toggle; a long one is clamped + expandable.
const OUTPUT_COLLAPSED_MAX_PX = 104

export const BoardTaskCard = memo(function BoardTaskCard({ task }: { task: BoardTaskView }) {
  const assigneeName = useFleetStore((s) =>
    task.assigneeAgentId
      ? (s.agents.find((a) => a.id === task.assigneeAgentId)?.name ?? null)
      : null,
  )

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

  return (
    <div
      className="rounded-2xl border border-border bg-surface p-3.5"
      style={{ boxShadow: 'var(--shadow-raised)' }}
      data-testid="board-task-card"
      data-task-status={task.status}
    >
      <div className="flex items-center gap-2">
        {task.assigneeAgentId && <AgentBooAvatar agentId={task.assigneeAgentId} size={22} />}
        <span className="truncate text-[12px] font-semibold text-foreground/85">
          {assigneeName ?? 'Unassigned'}
        </span>
        <span className="font-mono text-[9px] uppercase tracking-[0.16em] text-foreground/30">
          · task
        </span>
        <div className="ml-auto">
          <StatusPill tone={tone} label={label} />
        </div>
      </div>

      <p
        className="mt-1.5 text-[12px] leading-snug text-foreground/55"
        style={{ fontFamily: 'var(--font-body)' }}
      >
        {task.title}
      </p>

      {showOutput && (
        <div className="mt-2.5 border-t border-border/50 pt-2.5">
          <div
            ref={outRef}
            className="whitespace-pre-wrap break-words text-[12.5px] leading-relaxed text-foreground/80"
            style={{
              fontFamily: 'var(--font-body)',
              maxHeight: expanded ? undefined : OUTPUT_COLLAPSED_MAX_PX,
              overflow: 'hidden',
            }}
          >
            {output}
          </div>
          {overflows && (
            <button
              type="button"
              onClick={() => setExpanded((v) => !v)}
              className="mt-1.5 flex items-center gap-1 font-mono text-[10px] uppercase tracking-wider text-mint/80 transition-colors hover:text-mint"
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
  )
})
