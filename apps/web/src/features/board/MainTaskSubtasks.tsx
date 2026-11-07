// The work filed under a person's request, shown under its card: one small row per
// sub-task, in the card's own neutral look, with colour only in the status mark. Open
// while the request is, folded once it is finished. A row opens that sub-task's drawer.

import { useContext, useState } from 'react'
import { ChevronRight } from 'lucide-react'

import { AgentBooAvatar } from '@/components/AgentBooAvatar'
import type { BoardTask } from '@/lib/boardClient'

import { boardColumnOf } from './boardStatus'
import { isFinishedStatus } from './calendar/calendarModel'
import { isMainTask, RequestNestingContext } from './mainTasks'
import { glyphKindOf, StatusGlyph } from './StatusGlyph'
import { taskOwnerOf } from './TaskCard'

export function MainTaskSubtasks({ task }: { task: BoardTask }) {
  const context = useContext(RequestNestingContext)
  const [choice, setChoice] = useState<boolean | null>(null)
  if (!context || !isMainTask(task)) return null
  const subtasks = context.nesting.subtasksOf(task.id)
  if (subtasks.length === 0) return null
  const shownOnRequest = context.unfoldedId === task.id
  const open = shownOnRequest || (choice ?? !isFinishedStatus(task.status))
  return (
    <div data-testid="main-task-subtasks" className="-mt-1 flex min-w-0 flex-col pl-1">
      <button
        type="button"
        aria-expanded={open}
        onClick={() => {
          if (shownOnRequest) context.onFolded?.()
          setChoice(!open)
        }}
        className="flex w-fit cursor-pointer items-center gap-1 rounded-md px-1.5 py-0.5 text-xs text-muted-foreground transition-colors hover:bg-foreground/[0.06] hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-2"
      >
        <ChevronRight
          size={12}
          strokeWidth={2}
          aria-hidden
          className="shrink-0 transition-transform duration-150"
          style={{ rotate: open ? '90deg' : '0deg' }}
        />
        {subtasks.length} {subtasks.length === 1 ? 'sub-task' : 'sub-tasks'}
      </button>
      {open ? (
        <ul className="m-0 ml-3 flex list-none flex-col border-l border-border p-0 pl-1.5">
          {subtasks.map((sub) => (
            <SubtaskRow key={sub.id} task={sub} onOpen={() => context.onOpen(sub.id)} />
          ))}
        </ul>
      ) : null}
    </div>
  )
}

function SubtaskRow({ task, onOpen }: { task: BoardTask; onOpen: () => void }) {
  const owner = taskOwnerOf(task)
  const title = task.title ?? '(untitled)'
  return (
    <li className="min-w-0">
      <button
        type="button"
        onClick={onOpen}
        data-testid="main-task-subtask"
        data-focus-restore-id={task.id}
        aria-label={`Open “${title}”`}
        title={title}
        className="flex h-7 w-full min-w-0 cursor-pointer items-center gap-1.5 rounded-md px-1.5 text-left text-xs text-foreground transition-colors hover:bg-foreground/[0.05] focus-visible:outline-2 focus-visible:outline-offset-1"
      >
        <StatusGlyph kind={glyphKindOf(boardColumnOf(task))} />
        <span
          className={[
            'min-w-0 flex-1 truncate',
            task.status === 'cancelled'
              ? 'text-muted-foreground line-through decoration-foreground/30'
              : '',
          ].join(' ')}
        >
          {title}
        </span>
        {owner ? <AgentBooAvatar agentId={owner} size={14} /> : null}
      </button>
    </li>
  )
}
