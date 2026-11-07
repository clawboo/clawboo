// A person's request in the team chat: one card holding how far its work has got and
// each sub-task's own card, so a request with several helpers reads as one thing in the
// timeline. It is the board's main task as the chat shows it.

import { memo } from 'react'
import { Maximize2 } from 'lucide-react'

import { AgentBooAvatar } from '@/components/AgentBooAvatar'
import { ATTENTION_META, attentionLabel, taskAttentionOf } from '@/features/board/boardStatus'
import { progressLabel, type RequestProgress } from '@/features/board/mainTasks'
import { StatusPill, type StatusTone } from '@/features/shared/StatusPill'
import type { BoardTaskView } from '@/stores/board'
import { useViewStore } from '@/stores/view'

import { BoardTaskCard } from './BoardTaskCard'

function pillOf(
  task: BoardTaskView,
  progress: RequestProgress,
): {
  tone: StatusTone
  label: string
} {
  const attention = taskAttentionOf(task)
  if (attention)
    return { tone: ATTENTION_META[attention.reason].tone, label: attentionLabel(attention, null) }
  if (task.status === 'done') return { tone: 'done', label: 'Done' }
  if (task.status === 'cancelled') return { tone: 'error', label: 'Cancelled' }
  return progress.open > 0
    ? { tone: 'working', label: 'Working' }
    : { tone: 'working', label: 'Summing up' }
}

export const RequestCard = memo(function RequestCard({
  task,
  subtasks,
  progress,
  teamId = null,
}: {
  task: BoardTaskView
  subtasks: BoardTaskView[]
  progress: RequestProgress
  teamId?: string | null
}) {
  const { tone, label } = pillOf(task, progress)
  return (
    <div
      className="overflow-hidden rounded-xl border border-border bg-surface"
      data-testid="request-card"
      data-task-status={task.status}
    >
      <div className="flex items-start justify-between gap-3 bg-foreground/[0.015] px-4 pt-3.5 pb-3">
        <div className="flex min-w-0 items-center gap-2.5">
          {task.assigneeAgentId && <AgentBooAvatar agentId={task.assigneeAgentId} size={30} />}
          <div className="flex min-w-0 flex-col gap-1">
            <p className="m-0 line-clamp-2 text-[12.5px] font-medium leading-relaxed text-foreground/85">
              {task.title}
            </p>
            <span className="flex items-center gap-1.5 font-mono text-[10px] uppercase tracking-widest text-muted-foreground">
              <span className="font-semibold" data-testid="request-card-id">
                {task.identifier ?? 'Request'}
              </span>
              <span aria-hidden className="text-foreground/25">
                ·
              </span>
              <span className="tracking-normal normal-case" data-testid="request-card-progress">
                {progressLabel(progress)}
              </span>
            </span>
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-1.5">
          <StatusPill tone={tone} label={label} />
          <button
            type="button"
            onClick={() => useViewStore.getState().openBoardTask(task.id, teamId)}
            aria-label="Open this request on the board"
            title="Open on the board"
            className="flex h-6 w-6 cursor-pointer items-center justify-center rounded-md text-foreground/40 transition hover:bg-foreground/[0.08] hover:text-foreground/75 focus-visible:outline-2 focus-visible:outline-offset-2"
          >
            <Maximize2 size={13} strokeWidth={2} />
          </button>
        </div>
      </div>
      {subtasks.length > 0 ? (
        <div className="flex flex-col gap-2 border-t border-border p-2.5">
          {subtasks.map((sub) => (
            <BoardTaskCard key={sub.id} task={sub} teamId={teamId} />
          ))}
        </div>
      ) : null}
    </div>
  )
})
