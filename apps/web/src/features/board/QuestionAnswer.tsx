// A question an agent asked, and the controls that answer it: the same on a Needs you
// card and in the task drawer. The kinds: a question with options or free text, a yes
// or no, and a proposed list of tasks the person reads whole, edits, accepts or turns down. The
// answer starts the task again, so a press is final: a refusal (the task moved on, or
// someone else answered first) is said plainly and the board's next read tidies up.

import { useState, type ReactNode } from 'react'
import { Check, Plus, X } from 'lucide-react'

import {
  HAND_OFF_TITLE_CHARS,
  parseQuestionPayload,
  QUESTION_ANSWER_MAX_CHARS,
  type SuggestedTask,
} from '@clawboo/board-core'

import { Button } from '@/features/shared/Button'
import { answerTaskQuestion, type QuestionAnswerInput } from '@/lib/boardClient'
import { notePersonCheck, PERSON_CHECK_REFUSED } from '@/lib/personCheckNotice'
import { useToastStore } from '@/stores/toast'

import { notDeliveredWhy } from './boardStatus'

/** The fields of a `task_questions` row this reads (a board row's `openQuestion`). */
export interface OpenQuestion {
  id: string
  kind: string
  payload: unknown
}

const REFUSED: Record<string, string> = {
  too_many_steps: 'A plan can have 25 steps at most. Remove some, then accept it.',
  no_room: 'Those tasks do not all fit under this task. Remove some, then accept it.',
  too_deep: 'This task is already as deep as tasks go, so its plan cannot start under it.',
  expired: 'That question has closed: the task moved on without it.',
  answered: 'Someone has already answered that.',
  cancelled: 'That question has closed.',
  not_found: 'That question is gone.',
  invalid_answer: 'That answer does not fit the question.',
}

/** Option text can run to 200 characters, so unlike a `Button` it wraps. */
const OPTION_BUTTON =
  'max-w-full cursor-pointer break-words rounded-lg border border-border bg-surface px-3 py-1.5 text-left text-compact font-medium text-foreground shadow-[var(--shadow-raised)] transition-[background-color,border-color] duration-150 hover:border-border-strong hover:bg-foreground/[0.02] focus-visible:outline-2 focus-visible:outline-offset-2 disabled:pointer-events-none disabled:opacity-45'

export function QuestionAnswer(props: { question: OpenQuestion; onAnswered: () => void }) {
  // Keyed by the question: a newer one replacing it starts from its own list and an
  // empty answer box, never from what was typed for the old one.
  return <QuestionControls key={props.question.id} {...props} />
}

/** A step with these words: the title is their start, and the rest, if any, goes with it. */
function withWords(step: SuggestedTask, words: string): SuggestedTask {
  const { description: _old, ...rest } = step
  const title = words.slice(0, HAND_OFF_TITLE_CHARS)
  return { ...rest, title, ...(words !== title ? { description: words } : {}) }
}

function QuestionControls({
  question,
  onAnswered,
}: {
  question: OpenQuestion
  onAnswered: () => void
}) {
  const addToast = useToastStore((s) => s.addToast)
  const payload = parseQuestionPayload(question.payload)
  const [busy, setBusy] = useState(false)
  const [text, setText] = useState('')
  const [tasks, setTasks] = useState<SuggestedTask[]>(payload?.tasks ?? [])
  const [note, setNote] = useState('')

  if (!payload) {
    return <p className="text-xs text-muted-foreground">This question could not be read.</p>
  }

  const send = async (answer: QuestionAnswerInput): Promise<void> => {
    if (busy) return
    setBusy(true)
    const result = await answerTaskQuestion(question.id, answer)
    setBusy(false)
    if (result.ok) {
      if (result.created || result.alreadyOpen) {
        const made = result.created ?? 0
        const open = result.alreadyOpen ? ` ${result.alreadyOpen} already open.` : ''
        addToast({
          type: 'success',
          message: `Plan accepted. ${made === 1 ? '1 task is' : `${made} tasks are`} on the board.${open}`,
        })
      }
      // Saved is not delivered: the agent may not have been started.
      if (result.delivery?.status === 'queued' && result.delivery.reason === 'paused') {
        addToast({
          type: 'info',
          message: 'Your answer is saved. The agent gets it after the resume.',
        })
      }
      if (result.delivery?.status === 'not-delivered') {
        addToast({
          type: 'info',
          message: `Your answer is saved, but it did not reach the agent: ${notDeliveredWhy(result.delivery.reason)}`,
        })
      }
      onAnswered()
      return
    }
    if (result.reason === 'person_only') notePersonCheck(PERSON_CHECK_REFUSED)
    else {
      addToast({
        type: 'error',
        message: REFUSED[result.reason] ?? 'Couldn’t send your answer. Please try again.',
      })
    }
    // A question that closed is not coming back: refresh so the card reflects it.
    if (result.reason === 'expired' || result.reason === 'answered') onAnswered()
  }

  const options = payload.options ?? []
  const freeText = question.kind === 'question' && (options.length === 0 || payload.allowOther)
  let controls: ReactNode = null
  if (question.kind === 'confirm') {
    controls = (
      <div className="flex flex-wrap gap-2">
        <Button
          size="sm"
          variant="secondary"
          disabled={busy}
          onClick={() => void send({ confirmed: true })}
        >
          <Check size={14} strokeWidth={2} aria-hidden />
          Yes
        </Button>
        <Button
          size="sm"
          variant="ghost"
          disabled={busy}
          onClick={() => void send({ confirmed: false })}
        >
          No
        </Button>
      </div>
    )
  } else if (question.kind === 'suggest_tasks') {
    // A step is edited whole. Its title is only ever the start of what runs, so what the
    // person reads here, and leaves here, is what the agent gets.
    const wordsOf = (t: SuggestedTask): string => t.description ?? t.title
    const edit = (i: number, words: string): void =>
      setTasks((prev) => prev.map((t, at) => (at === i ? withWords(t, words) : t)))
    const usable = tasks.filter((t) => wordsOf(t).trim())
    controls = (
      <div className="flex flex-col gap-1.5">
        {tasks.map((t, i) => (
          <div key={i} className="flex min-w-0 flex-col gap-0.5">
            <div className="flex min-w-0 items-start gap-1.5">
              {/* Opens tall enough for its words, and a person can drag it taller: a step
                  has to be read before it is accepted, where `field-sizing` is not there
                  to grow it. */}
              <textarea
                rows={Math.min(8, Math.ceil(wordsOf(t).length / 40) + 1)}
                aria-label={`Suggested task ${i + 1}`}
                maxLength={QUESTION_ANSWER_MAX_CHARS}
                value={wordsOf(t)}
                onChange={(e) => edit(i, e.target.value)}
                className="max-h-48 min-w-0 flex-1 resize-y rounded-md border border-border bg-transparent px-2 py-1 text-xs text-foreground [field-sizing:content] focus-visible:outline-2 focus-visible:outline-offset-2"
              />
              <button
                type="button"
                aria-label={`Remove “${t.title}”`}
                onClick={() => setTasks((prev) => prev.filter((_, at) => at !== i))}
                className="inline-flex size-6 shrink-0 cursor-pointer items-center justify-center rounded-md text-muted-foreground hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-2"
              >
                <X size={12} strokeWidth={2} aria-hidden />
              </button>
            </div>
            {t.agentName ? (
              <span className="truncate pl-2 text-xs text-muted-foreground">{t.agentName}</span>
            ) : null}
          </div>
        ))}
        <button
          type="button"
          onClick={() => setTasks((prev) => [...prev, { title: '' }])}
          className="inline-flex w-fit cursor-pointer items-center gap-1 rounded-md text-xs text-muted-foreground hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-2"
        >
          <Plus size={12} strokeWidth={2} aria-hidden />
          Add a task
        </button>
        <input
          type="text"
          aria-label="A note for the agent"
          placeholder="Anything to add? The agent reads this."
          maxLength={QUESTION_ANSWER_MAX_CHARS}
          value={note}
          onChange={(e) => setNote(e.target.value)}
          className="mt-1 min-w-0 rounded-md border border-border bg-transparent px-2 py-1 text-xs text-foreground focus-visible:outline-2 focus-visible:outline-offset-2"
        />
        <div className="mt-1 flex flex-wrap gap-2">
          <Button
            size="sm"
            variant="secondary"
            disabled={busy || usable.length === 0}
            onClick={() =>
              void send({
                accepted: true,
                tasks: usable.map((t) => withWords(t, wordsOf(t).trim())),
                ...(note.trim() ? { note: note.trim() } : {}),
              })
            }
          >
            <Check size={14} strokeWidth={2} aria-hidden />
            Accept
          </Button>
          <Button
            size="sm"
            variant="ghost"
            disabled={busy}
            onClick={() =>
              void send({ accepted: false, ...(note.trim() ? { note: note.trim() } : {}) })
            }
          >
            Turn down
          </Button>
        </div>
      </div>
    )
  } else if (question.kind === 'question') {
    controls = (
      <div className="flex flex-col gap-2">
        {options.length > 0 ? (
          <div className="flex flex-wrap gap-1.5">
            {options.map((o) => (
              <button
                key={o}
                type="button"
                className={OPTION_BUTTON}
                disabled={busy}
                onClick={() => void send({ choice: o })}
              >
                {o}
              </button>
            ))}
          </div>
        ) : null}
        {freeText ? (
          <form
            className="flex min-w-0 items-center gap-1.5"
            onSubmit={(e) => {
              e.preventDefault()
              const answer = text.trim()
              if (answer) void send({ text: answer })
            }}
          >
            <input
              type="text"
              aria-label="Your answer"
              placeholder="Your answer"
              value={text}
              onChange={(e) => setText(e.target.value)}
              className="min-w-0 flex-1 rounded-md border border-border bg-transparent px-2 py-1 text-xs text-foreground focus-visible:outline-2 focus-visible:outline-offset-2"
            />
            <Button size="sm" variant="secondary" type="submit" disabled={busy || !text.trim()}>
              Send
            </Button>
          </form>
        ) : null}
      </div>
    )
  }

  return (
    <div data-testid="question-answer" data-kind={question.kind} className="flex flex-col gap-2">
      <p className="m-0 whitespace-pre-wrap break-words text-compact text-foreground">
        {payload.prompt}
      </p>
      {controls}
    </div>
  )
}
