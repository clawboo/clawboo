// A task's comment log: the agent's report, the failure reasons Clawboo records,
// and the notes a person leaves by retrying or assigning it. Shared by the board's
// task drawer and the chat task card's trail, so both read the log the same way.
//
// Each entry is attributed the way a person would say it: the agent by name, "You"
// for the person using Clawboo, and "Clawboo" for the notes the orchestrator
// writes itself (a run failing, a result arriving late, a cap being hit).
//
// An agent writes in markdown, so its entries render as markdown. A person's note
// and Clawboo's own stay plain text: a path like `__init__.py` in a failure
// reason must read as written.

import type { ReactNode } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'

import { MD_COMPONENTS } from '@/features/chat/chatComponents'
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
  after,
}: {
  comments: TaskComment[]
  /** Tighter type for the chat card, where the log sits inside a narrow card. */
  compact?: boolean
  emptyLabel?: string
  /** Drawn under an entry, such as where a reply the person just sent went. */
  after?: (comment: TaskComment) => ReactNode
}) {
  const authorOf = useAuthorLabel()
  const visible = comments.filter((c) => typeof c.body === 'string' && c.body.trim().length > 0)
  if (visible.length === 0) {
    return <div className="text-xs text-muted-foreground">{emptyLabel}</div>
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
                'font-medium',
                compact ? 'text-micro' : 'text-xs',
                c.authorType === 'system' ? 'text-muted-foreground' : 'text-foreground',
              ].join(' ')}
            >
              {authorOf(c)}
            </span>
            {typeof c.createdAt === 'number' && (
              <time
                className={`${compact ? 'text-micro' : 'text-xs'} tabular-nums text-muted-foreground`}
              >
                {timeFormat.format(new Date(c.createdAt))}
              </time>
            )}
          </div>
          {c.authorType === 'agent' ? (
            <div
              className={[
                'min-w-0 break-words text-foreground [&>*:first-child]:mt-0 [&>*:last-child]:mb-0',
                compact ? 'text-xs' : 'text-sm',
              ].join(' ')}
            >
              <ReactMarkdown remarkPlugins={[remarkGfm]} components={MD_COMPONENTS}>
                {c.body}
              </ReactMarkdown>
            </div>
          ) : (
            <p
              className={[
                'whitespace-pre-wrap break-words text-foreground',
                compact ? 'text-xs' : 'text-sm',
              ].join(' ')}
            >
              {c.body}
            </p>
          )}
          {after?.(c)}
        </li>
      ))}
    </ol>
  )
}
