// A task's comment log: the agent's report, the failure reasons Clawboo records,
// and the notes a person leaves by retrying or assigning it. Shared by the board's
// task drawer and the chat task card's trail, so both read the log the same way.
//
// Each entry is attributed the way a person would say it: the agent by name, "You"
// for the person using Clawboo, and "Clawboo" for the notes the orchestrator
// writes itself (a run failing, a result arriving late, a cap being hit).

import { useFleetStore } from '@/stores/fleet'

export interface TaskComment {
  id?: string
  body?: string
  authorType?: string
  authorAgentId?: string | null
  createdAt?: number
}

const timeFormat = new Intl.DateTimeFormat(undefined, {
  month: 'short',
  day: 'numeric',
  hour: 'numeric',
  minute: '2-digit',
})

function useAuthorLabel(): (c: TaskComment) => string {
  const agents = useFleetStore((s) => s.agents)
  return (c) => {
    if (c.authorType === 'user') return 'You'
    if (c.authorType === 'agent') {
      const name = c.authorAgentId ? agents.find((a) => a.id === c.authorAgentId)?.name : null
      return name ?? 'Agent'
    }
    return 'Clawboo'
  }
}

export function TaskComments({
  comments,
  compact = false,
  emptyLabel = 'No comments yet.',
}: {
  comments: TaskComment[]
  /** Tighter type for the chat card, where the log sits inside a narrow card. */
  compact?: boolean
  emptyLabel?: string
}) {
  const authorOf = useAuthorLabel()
  const visible = comments.filter((c) => typeof c.body === 'string' && c.body.trim().length > 0)
  if (visible.length === 0) {
    return <div className="text-[11.5px] text-muted-foreground">{emptyLabel}</div>
  }
  return (
    <ol className="flex flex-col" data-testid="task-comments">
      {visible.map((c, i) => (
        <li
          key={c.id ?? i}
          className={[
            'flex flex-col gap-1 border-t border-border first:border-t-0',
            compact ? 'py-2 first:pt-0' : 'py-2.5 first:pt-0',
          ].join(' ')}
        >
          <div className="flex items-baseline gap-2">
            <span
              className={[
                'font-mono font-semibold uppercase tracking-wider',
                compact ? 'text-[9.5px]' : 'text-[10px]',
                c.authorType === 'system' ? 'text-muted-foreground' : 'text-foreground/75',
              ].join(' ')}
            >
              {authorOf(c)}
            </span>
            {typeof c.createdAt === 'number' && (
              <time className="font-data text-[10px] text-foreground/35">
                {timeFormat.format(new Date(c.createdAt))}
              </time>
            )}
          </div>
          <p
            className={[
              'whitespace-pre-wrap break-words leading-relaxed text-foreground/75',
              compact ? 'text-[11.5px]' : 'text-[12px]',
            ].join(' ')}
          >
            {c.body}
          </p>
        </li>
      ))}
    </ol>
  )
}
