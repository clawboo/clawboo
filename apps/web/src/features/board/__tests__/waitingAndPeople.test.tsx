// How the board reads what a task waits on, and whose it is.

import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { http, HttpResponse } from 'msw'

import { collectAlertItems } from '@/features/alerts/alertRules'
import * as confirmStore from '@/stores/confirm'
import { useToastStore } from '@/stores/toast'

import { server } from '../../../__vitest__/mswServer'

const answerTaskQuestion = vi.fn()
vi.mock('@/lib/boardClient', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/boardClient')>()),
  answerTaskQuestion: (...args: unknown[]) => answerTaskQuestion(...args),
}))
const { assignTaskToPerson, createTaskForMe, reopenTask } = await import('@/lib/boardClient')
const { useTaskActions } = await import('../useTaskActions')

const {
  attentionLabel,
  boardColumnOf,
  isMyTask,
  manualStatusOptions,
  otherAssigneeName,
  taskAttentionOf,
  waitingWorkLabel,
} = await import('../boardStatus')
const { QuestionAnswer } = await import('../QuestionAnswer')
const { FilterMenuButton, NO_FILTER, filterCount } = await import('../BoardToolbar')

const QUESTION = { kind: 'question', questionId: 'q1' }

describe('the board reads waiting_on', () => {
  it('a task waiting on other work sits in In progress and is not Needs you', () => {
    for (const waitingOn of [
      JSON.stringify({ kind: 'task', taskId: 't2' }),
      '{"kind":"subtasks"}',
    ]) {
      const task = { status: 'blocked', attention: null, waitingOn }
      expect(taskAttentionOf(task)).toBeNull()
      expect(boardColumnOf(task)).toBe('in_progress')
    }
  })

  it('a blocked task with no such reason still needs a person when no verdict came', () => {
    expect(taskAttentionOf({ status: 'blocked' })?.reason).toBe('blocked')
    expect(boardColumnOf({ status: 'blocked' })).toBe('needs_you')
    expect(
      taskAttentionOf({ status: 'blocked', waitingOn: JSON.stringify(QUESTION) })?.reason,
    ).toBe('blocked')
  })

  it('names what it waits on', () => {
    expect(
      waitingWorkLabel({
        status: 'blocked',
        waitingOn: '{"kind":"task","taskId":"t2"}',
        waitingOnDetail: { taskTitle: 'Schema' },
      }),
    ).toBe('Waiting on “Schema”')
    expect(
      waitingWorkLabel({
        status: 'blocked',
        waitingOn: '{"kind":"subtasks"}',
        waitingOnDetail: { openSubtasks: 3 },
      }),
    ).toBe('Waiting on 3 sub-tasks')
    expect(
      waitingWorkLabel({
        status: 'blocked',
        waitingOn: '{"kind":"subtasks"}',
        waitingOnDetail: { openSubtasks: 1 },
      }),
    ).toBe('Waiting on 1 sub-task')
    expect(waitingWorkLabel({ status: 'todo', waitingOn: '{"kind":"subtasks"}' })).toBeNull()
    expect(waitingWorkLabel({ status: 'blocked', waitingOn: JSON.stringify(QUESTION) })).toBeNull()
  })

  it('carries the new reasons from the server', () => {
    expect(
      taskAttentionOf({
        status: 'blocked',
        attention: { reason: 'question', failedRuns: 0, questionId: 'q1' },
      }),
    ).toEqual({ reason: 'question', failedRuns: 0, questionId: 'q1' })
    expect(
      taskAttentionOf({
        status: 'blocked',
        attention: {
          reason: 'assigned',
          failedRuns: 0,
          personId: 'local',
          handedBack: true,
          detail: 'Look',
        },
      }),
    ).toEqual({
      reason: 'assigned',
      failedRuns: 0,
      personId: 'local',
      handedBack: true,
      detail: 'Look',
    })
  })
})

describe('whose task it is', () => {
  const me = { id: 'p1' }
  it('mine: my own id, or the built-in person who stands for whoever is here', () => {
    expect(isMyTask({ assigneePersonId: 'p1' }, me)).toBe(true)
    expect(isMyTask({ assigneePersonId: 'local' }, me)).toBe(true)
    expect(isMyTask({ assigneePersonId: 'p2' }, me)).toBe(false)
    expect(isMyTask({ assigneePersonId: null }, me)).toBe(false)
    expect(isMyTask({}, me)).toBe(false)
  })

  it('names someone else, and says "you" otherwise', () => {
    const theirs = { assigneePersonId: 'p2', assigneePerson: '{"id":"p2","name":"Priya"}' }
    expect(otherAssigneeName(theirs, me)).toBe('Priya')
    expect(otherAssigneeName({ assigneePersonId: 'p1' }, me)).toBeNull()
    const a = { reason: 'assigned', failedRuns: 0 } as const
    expect(attentionLabel(a)).toBe('Assigned to you')
    expect(attentionLabel(a, 'Priya')).toBe('Assigned to Priya')
  })

  it('offers Done from any open status on a person’s task only', () => {
    expect(manualStatusOptions('todo', { personAssigned: true })).toContain('done')
    expect(manualStatusOptions('blocked', { personAssigned: true })).toContain('done')
    expect(manualStatusOptions('todo')).not.toContain('done')
    expect(manualStatusOptions('done', { personAssigned: true })).not.toContain('todo')
  })
})

describe('alerts', () => {
  const task = (attention: unknown) => ({ id: 't', title: 'T', status: 'blocked', attention })
  it('announce a question and a hand-back, not a task you took yourself', () => {
    expect(
      collectAlertItems([task({ reason: 'question', failedRuns: 0, questionId: 'q' })], []),
    ).toHaveLength(1)
    expect(
      collectAlertItems([task({ reason: 'assigned', failedRuns: 0, handedBack: true })], []),
    ).toHaveLength(1)
    expect(collectAlertItems([task({ reason: 'assigned', failedRuns: 0 })], [])).toHaveLength(0)
  })
})

describe('QuestionAnswer', () => {
  beforeEach(() => {
    answerTaskQuestion.mockReset()
    answerTaskQuestion.mockResolvedValue({ ok: true })
  })
  const q = (kind: string, payload: object) => ({
    id: 'q1',
    kind,
    payload: JSON.stringify({ prompt: 'Which one?', ...payload }),
  })

  it('answers with an option', async () => {
    const onAnswered = vi.fn()
    render(
      <QuestionAnswer
        question={q('question', { options: ['Red', 'Blue'] })}
        onAnswered={onAnswered}
      />,
    )
    await userEvent.click(screen.getByRole('button', { name: 'Blue' }))
    expect(answerTaskQuestion).toHaveBeenCalledWith('q1', { choice: 'Blue' })
    await waitFor(() => expect(onAnswered).toHaveBeenCalled())
    // No free text was offered.
    expect(screen.queryByLabelText('Your answer')).toBeNull()
  })

  it('takes free text when there are no options, or the agent allows it', async () => {
    render(<QuestionAnswer question={q('question', {})} onAnswered={vi.fn()} />)
    await userEvent.type(screen.getByLabelText('Your answer'), 'Teal')
    await userEvent.click(screen.getByRole('button', { name: 'Send' }))
    expect(answerTaskQuestion).toHaveBeenCalledWith('q1', { text: 'Teal' })
  })

  it('answers a confirmation yes or no', async () => {
    render(<QuestionAnswer question={q('confirm', {})} onAnswered={vi.fn()} />)
    await userEvent.click(screen.getByRole('button', { name: 'No' }))
    expect(answerTaskQuestion).toHaveBeenCalledWith('q1', { confirmed: false })
  })

  it('lets a person edit suggested tasks, then accept or turn them down', async () => {
    render(
      <QuestionAnswer
        question={q('suggest_tasks', { tasks: [{ title: 'One' }, { title: 'Two' }] })}
        onAnswered={vi.fn()}
      />,
    )
    await userEvent.click(screen.getByRole('button', { name: 'Remove “Two”' }))
    const first = screen.getByLabelText('Suggested task 1')
    await userEvent.clear(first)
    await userEvent.type(first, 'One, reworded')
    await userEvent.click(screen.getByRole('button', { name: 'Accept' }))
    expect(answerTaskQuestion).toHaveBeenCalledWith('q1', {
      accepted: true,
      tasks: [{ title: 'One, reworded' }],
    })
  })

  it('says an answer waits for the resume when a pause covers the task', async () => {
    answerTaskQuestion.mockResolvedValue({
      ok: true,
      delivery: { status: 'queued', agentId: 'a1', reason: 'paused' },
    })
    render(<QuestionAnswer question={q('confirm', {})} onAnswered={vi.fn()} />)
    await userEvent.click(screen.getByRole('button', { name: 'Yes' }))
    await waitFor(() =>
      expect(useToastStore.getState().toasts.map((t) => t.message)).toContain(
        'Your answer is saved. The agent gets it after the resume.',
      ),
    )
  })

  it('says why an answer did not land, and refreshes a question that closed', async () => {
    answerTaskQuestion.mockResolvedValue({ ok: false, reason: 'expired' })
    const onAnswered = vi.fn()
    render(<QuestionAnswer question={q('confirm', {})} onAnswered={onAnswered} />)
    await userEvent.click(screen.getByRole('button', { name: 'Yes' }))
    await waitFor(() => expect(onAnswered).toHaveBeenCalled())
  })
})

describe('the Mine filter', () => {
  it('counts as a filter, and offers itself in the menu', async () => {
    expect(filterCount({ ...NO_FILTER, mine: true })).toBe(1)
    expect(filterCount(NO_FILTER)).toBe(0)
    const onChange = vi.fn()
    render(<FilterMenuButton agents={[]} filter={NO_FILTER} onChange={onChange} />)
    await userEvent.click(screen.getByRole('button', { name: /Filter/ }))
    await userEvent.click(await screen.findByRole('menuitemcheckbox', { name: /Mine/ }))
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ mine: true }))
  })
})

describe('QuestionAnswer: what the person sees', () => {
  beforeEach(() => {
    answerTaskQuestion.mockReset()
    answerTaskQuestion.mockResolvedValue({ ok: true })
    useToastStore.setState({ toasts: [] })
  })
  const q = (id: string, kind: string, payload: object) => ({
    id,
    kind,
    payload: JSON.stringify({ prompt: 'Which one?', ...payload }),
  })

  it('wraps a long option instead of running out of the card', () => {
    const long = 'Rewrite the whole onboarding flow for developers and keep the old one '.repeat(2)
    render(
      <QuestionAnswer question={q('q1', 'question', { options: [long] })} onAnswered={vi.fn()} />,
    )
    const button = screen.getByRole('button', { name: long.trim() })
    expect(button.className).not.toContain('whitespace-nowrap')
    expect(button.className).not.toContain('shrink-0')
    expect(button.className).toContain('break-words')
    expect(button.className).toContain('max-w-full')
  })

  it('a newer question brings its own list, not the older one’s edits', async () => {
    const { rerender } = render(
      <QuestionAnswer
        question={q('q1', 'suggest_tasks', { tasks: [{ title: 'Old one' }] })}
        onAnswered={vi.fn()}
      />,
    )
    rerender(
      <QuestionAnswer
        question={q('q2', 'suggest_tasks', { tasks: [{ title: 'New one' }] })}
        onAnswered={vi.fn()}
      />,
    )
    expect(screen.getByLabelText('Suggested task 1')).toHaveValue('New one')
    await userEvent.click(screen.getByRole('button', { name: 'Accept' }))
    expect(answerTaskQuestion).toHaveBeenCalledWith('q2', {
      accepted: true,
      tasks: [{ title: 'New one' }],
    })
  })

  it('says so when the answer is saved but reached no one', async () => {
    answerTaskQuestion.mockResolvedValue({
      ok: true,
      delivery: { status: 'not-delivered', agentId: 'a1', reason: 'room_archived' },
    })
    const onAnswered = vi.fn()
    render(<QuestionAnswer question={q('q1', 'confirm', {})} onAnswered={onAnswered} />)
    await userEvent.click(screen.getByRole('button', { name: 'Yes' }))
    await waitFor(() => expect(onAnswered).toHaveBeenCalled())
    const toast = useToastStore.getState().toasts.at(-1)
    expect(toast?.message).toMatch(/answer is saved/i)
    expect(toast?.message).toMatch(/chat room was archived/i)
  })

  it('a delivered answer says nothing extra', async () => {
    answerTaskQuestion.mockResolvedValue({
      ok: true,
      delivery: { status: 'woke-agent', agentId: 'a1' },
    })
    render(<QuestionAnswer question={q('q1', 'confirm', {})} onAnswered={vi.fn()} />)
    await userEvent.click(screen.getByRole('button', { name: 'Yes' }))
    await new Promise((r) => setTimeout(r, 10))
    expect(useToastStore.getState().toasts).toHaveLength(0)
  })
})

describe('the board client carries what the server says', () => {
  beforeEach(() => vi.unstubAllGlobals())

  it('assign to me, New task for me and Reopen each say the words the routes read', async () => {
    const calls: Array<[string, unknown]> = []
    server.use(
      http.post('/api/board/t1/assign-person', async ({ request }) => {
        calls.push(['assign', await request.json()])
        return HttpResponse.json({ ok: true })
      }),
      http.post('/api/board', async ({ request }) => {
        calls.push(['create', await request.json()])
        return HttpResponse.json({ task: { id: 'new', title: 'x' } })
      }),
      http.post('/api/board/t1/reopen', async ({ request }) => {
        calls.push(['reopen', await request.json()])
        return HttpResponse.json({
          ok: true,
          delivery: { status: 'not-delivered', agentId: null, reason: 'unassigned' },
        })
      }),
    )
    expect((await assignTaskToPerson('t1')).ok).toBe(true)
    const made = await createTaskForMe({ title: 'x', teamId: 'T' })
    expect(made.ok).toBe(true)
    const reopened = await reopenTask('t1', 'Go again')
    expect(reopened).toEqual({
      ok: true,
      delivery: { status: 'not-delivered', agentId: null, reason: 'unassigned' },
    })
    expect(calls).toEqual([
      ['assign', {}],
      ['create', { title: 'x', teamId: 'T', assignToMe: true }],
      ['reopen', { comment: 'Go again' }],
    ])
  })

  it('New task for me reports why the server refused', async () => {
    server.use(
      http.post('/api/board', () =>
        HttpResponse.json({ error: 'dashboard_only' }, { status: 403 }),
      ),
    )
    expect(await createTaskForMe({ title: 'x', teamId: 'T' })).toEqual({
      ok: false,
      reason: 'dashboard_only',
    })
  })
})

describe('useTaskActions: people', () => {
  beforeEach(() => useToastStore.setState({ toasts: [] }))

  function actions() {
    let got: ReturnType<typeof useTaskActions> | null = null
    function Probe() {
      got = useTaskActions()
      return null
    }
    render(<Probe />)
    return got as unknown as ReturnType<typeof useTaskActions>
  }

  it('says what to reopen first when the step depends on one that was cancelled', async () => {
    server.use(
      http.post('/api/board/t1/reopen', () =>
        HttpResponse.json({ ok: false, error: 'blocker_cancelled' }, { status: 409 }),
      ),
    )
    const { reopen } = actions()
    await expect(reopen('t1')).resolves.toBe(false)
    expect(useToastStore.getState().toasts.at(-1)?.message).toMatch(/Reopen that task first/)
  })

  it('says why a plain-http dashboard cannot take a task, instead of "try again"', async () => {
    server.use(
      http.post('/api/board/t1/assign-person', () =>
        HttpResponse.json({ ok: false, error: 'dashboard_only' }, { status: 403 }),
      ),
    )
    expect(await actions().assignToMe('t1')).toBe(false)
    const message = useToastStore.getState().toasts.at(-1)?.message ?? ''
    expect(message).not.toMatch(/try again/i)
    expect(message).toMatch(/localhost|https/i)
  })

  it('says when a Reopen’s note reached no one, rather than that all is well', async () => {
    server.use(
      http.post('/api/board/t1/reopen', () =>
        HttpResponse.json({
          ok: true,
          delivery: { status: 'not-delivered', agentId: 'a1', reason: 'no_team' },
        }),
      ),
    )
    expect(await actions().reopen('t1', 'Go again')).toBe(true)
    const toast = useToastStore.getState().toasts.at(-1)
    expect(toast?.message).toMatch(/team was deleted/i)
    expect(toast?.type).not.toBe('success')
  })

  it('says a Reopen starts after the resume when a pause covers the task', async () => {
    server.use(
      http.post('/api/board/t1/reopen', () =>
        HttpResponse.json({
          ok: true,
          delivery: { status: 'queued', agentId: 'a1', reason: 'paused' },
        }),
      ),
    )
    expect(await actions().reopen('t1', 'Go again')).toBe(true)
    expect(useToastStore.getState().toasts.at(-1)).toMatchObject({
      type: 'info',
      message: 'Reopened. It’s back in To do, and starts after the resume.',
    })
  })

  it('offers the override when a check holds a person’s Done', async () => {
    const bodies: unknown[] = []
    server.use(
      http.patch('/api/board/t1', async ({ request }) => {
        const body = (await request.json()) as { humanOverride?: boolean }
        bodies.push(body)
        return body.humanOverride
          ? HttpResponse.json({ ok: true })
          : HttpResponse.json({ ok: false, error: 'verification_required' }, { status: 409 })
      }),
    )
    const answer = vi.spyOn(confirmStore, 'confirm').mockResolvedValue(true)
    expect(await actions().markDone('t1')).toBe(true)
    expect(answer).toHaveBeenCalled()
    expect(bodies).toEqual([{ status: 'done' }, { status: 'done', humanOverride: true }])
    answer.mockRestore()
  })
})
