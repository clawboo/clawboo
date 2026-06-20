// Renders a durable BOARD task row inline in the group chat (the chat-fused
// board, flag-on only). Driven by the projection store (`stores/board.ts`) — a
// distinct data model from the transcript-linkage `DelegationCard` — so the card
// survives a refresh (re-loaded from REST). Status flips live as the board
// change-feed updates the projection.

import { memo, useEffect, useState } from 'react'

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
      return { tone: 'idle', label: 'Blocked' }
    case 'cancelled':
      return { tone: 'error', label: 'Cancelled' }
    default:
      return { tone: 'idle', label: 'Queued' } // todo / backlog
  }
}

export const BoardTaskCard = memo(function BoardTaskCard({ task }: { task: BoardTaskView }) {
  const assigneeName = useFleetStore((s) =>
    task.assigneeAgentId
      ? (s.agents.find((a) => a.id === task.assigneeAgentId)?.name ?? null)
      : null,
  )

  // The report-up summary is a board COMMENT, not a task-row field — so a task
  // reloaded after a refresh has `summary: null` in the projection. Fetch it
  // lazily for completed tasks (cheap: only done cards missing a summary).
  const [summary, setSummary] = useState<string | null>(task.summary)
  useEffect(() => {
    if (task.summary) setSummary(task.summary)
  }, [task.summary])
  useEffect(() => {
    if (task.status !== 'done' || summary) return
    let cancelled = false
    void boardClient.getTask(task.id).then((detail) => {
      if (cancelled || !detail) return
      const comments = detail.comments as Array<{ body?: unknown; authorType?: unknown }>
      const last = [...comments]
        .reverse()
        .find((c) => c.authorType === 'agent' && typeof c.body === 'string')
      if (last && typeof last.body === 'string') setSummary(last.body)
    })
    return () => {
      cancelled = true
    }
  }, [task.id, task.status, summary])

  const { tone, label } = toneFor(task.status)

  return (
    <div
      className="surface-raised-tier rounded-xl px-3 py-2.5"
      style={{ border: '1px solid rgb(var(--mint-rgb) / 0.18)' }}
      data-testid="board-task-card"
      data-task-status={task.status}
    >
      <div className="flex items-center gap-2">
        <span className="font-mono text-[9px] font-semibold uppercase tracking-wider text-mint">
          Board task
        </span>
        <StatusPill tone={tone} label={label} />
        <div className="ml-auto flex items-center gap-1.5">
          {task.assigneeAgentId && <AgentBooAvatar agentId={task.assigneeAgentId} size={18} />}
          {assigneeName && <span className="text-[11px] text-secondary">{assigneeName}</span>}
        </div>
      </div>
      <p className="mt-1.5 text-[13px] text-text" style={{ fontFamily: 'var(--font-body)' }}>
        {task.title}
      </p>
      {summary && task.status === 'done' && (
        <p
          className="mt-1.5 text-[11.5px] leading-relaxed text-secondary"
          style={{
            display: '-webkit-box',
            WebkitLineClamp: 3,
            WebkitBoxOrient: 'vertical',
            overflow: 'hidden',
          }}
        >
          {summary}
        </p>
      )}
    </div>
  )
})
