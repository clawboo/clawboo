// The drawer's Plan tab: the task's plan document, any of its revisions, and the answer
// controls when a person is being asked about the revision on show. A plan is text an
// agent wrote, so it renders through the same components as a run's report: an image in
// it stays a link and never loads.

import { useEffect, useState, type ReactNode } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'

import { parseQuestionPayload } from '@clawboo/board-core'

import { MD_COMPONENTS } from '@/features/chat/chatComponents'
import { Skeleton } from '@/features/shared/Skeleton'
import { fetchTaskPlan, type TaskPlan, type TaskPlanRevision } from '@/lib/boardClient'

import { QuestionAnswer, type OpenQuestion } from './QuestionAnswer'

const whoDecided = (raw: string | null): string => {
  try {
    const name = raw ? (JSON.parse(raw) as { name?: unknown }).name : null
    return typeof name === 'string' && name ? name : 'a person'
  } catch {
    return 'a person'
  }
}

/** What became of a revision, or null while nobody has decided. */
function decisionWords(revision: TaskPlanRevision): string | null {
  const who =
    whoDecided(revision.decidedBy).toLowerCase() === 'you' ? 'you' : whoDecided(revision.decidedBy)
  if (revision.decision === 'accepted') return `Accepted by ${who}.`
  if (revision.decision === 'declined') return `Turned down by ${who}.`
  return null
}

export function TaskPlanTab({
  taskId,
  plan,
  question,
  title,
  tabs,
  onChanged,
}: {
  taskId: string
  /** The task's plan as the drawer last read it: the newest revision. */
  plan: TaskPlan
  /** The question open on this task, if it is waiting on one. */
  question: OpenQuestion | null
  /** The drawer's heading, which this tab keeps. */
  title: ReactNode
  tabs: ReactNode
  onChanged: () => void
}) {
  const newest = plan.plan?.revision ?? null
  const [picked, setPicked] = useState<number | null>(null)
  const [read, setRead] = useState<TaskPlan | null>(null)
  const [failed, setFailed] = useState(false)

  useEffect(() => {
    if (picked === null || picked === newest) {
      setRead(null)
      setFailed(false)
      return
    }
    let live = true
    setRead(null)
    setFailed(false)
    void fetchTaskPlan(taskId, picked).then((got) => {
      if (!live) return
      if (got) setRead(got)
      else setFailed(true)
    })
    return () => {
      live = false
    }
  }, [taskId, picked, newest])

  const shownNumber = picked ?? newest
  const shown = shownNumber === newest ? plan.plan : (read?.plan ?? null)
  const asked = question ? parseQuestionPayload(question.payload)?.plan?.revision : undefined
  const decision = shown ? decisionWords(shown) : null

  return (
    <div data-testid="task-plan">
      {title}
      {tabs}
      {plan.revisions.length > 1 ? (
        <div className="mt-3 flex flex-wrap gap-1.5" aria-label="Revisions" role="group">
          {plan.revisions.map((r) => (
            <button
              key={r.revision}
              type="button"
              aria-pressed={r.revision === shownNumber}
              onClick={() => setPicked(r.revision)}
              className={[
                'cursor-pointer rounded-md border px-2 py-0.5 text-xs transition-colors duration-150 focus-visible:outline-2 focus-visible:outline-offset-2',
                r.revision === shownNumber
                  ? 'border-border-strong bg-foreground/[0.04] text-foreground'
                  : 'border-border text-muted-foreground hover:text-foreground',
              ].join(' ')}
            >
              Revision {r.revision}
            </button>
          ))}
        </div>
      ) : null}
      {decision ? (
        <p className="mt-3 mb-0 text-xs text-muted-foreground" data-testid="plan-decision">
          {decision}
        </p>
      ) : null}
      {failed ? (
        <p className="mt-4 text-sm text-muted-foreground">That revision could not be read.</p>
      ) : shown ? (
        <div
          data-testid="task-plan-body"
          className="mt-4 min-w-0 break-words text-sm text-foreground [&>*:first-child]:mt-0"
        >
          <ReactMarkdown remarkPlugins={[remarkGfm]} components={MD_COMPONENTS}>
            {shown.body}
          </ReactMarkdown>
        </div>
      ) : (
        <div className="mt-4 flex flex-col gap-2">
          <Skeleton height={14} />
          <Skeleton width="80%" height={14} />
        </div>
      )}
      {question && asked === shownNumber ? (
        <div className="mt-5 rounded-lg border border-border p-3">
          <QuestionAnswer question={question} onAnswered={onChanged} />
        </div>
      ) : null}
    </div>
  )
}
