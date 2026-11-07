// A plan on the board: the drawer's Plan tab, its revisions, and the answer controls a
// waiting plan brings with it. Plans are text an agent wrote, so an image in one must
// not load. The tab fits a phone: it has no fixed width of its own.

import { cleanup, render as rtlRender, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { http, HttpResponse, type JsonBodyType } from 'msw'
import type { ReactElement } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { ThemeProvider } from '@/features/theme/ThemeProvider'
import { useToastStore } from '@/stores/toast'

import { server } from '../../../__vitest__/mswServer'
import { QuestionAnswer } from '../QuestionAnswer'
import { TaskDetailDrawer } from '../TaskDetailDrawer'

const render = (ui: ReactElement) => rtlRender(ui, { wrapper: ThemeProvider })
afterEach(() => cleanup())

const REVISIONS = [
  {
    revision: 2,
    authorAgentId: 'a1',
    questionId: 'q1',
    decision: null,
    decidedBy: null,
    decidedAt: null,
    createdAt: 2,
  },
  {
    revision: 1,
    authorAgentId: 'a1',
    questionId: null,
    decision: 'declined',
    decidedBy: JSON.stringify({ id: 'local', name: 'You' }),
    decidedAt: 1,
    createdAt: 1,
  },
]

function drawerHandlers(
  plan: JsonBodyType,
  task: Record<string, unknown> = { id: 't1', title: 'Ship it', status: 'in_progress' },
) {
  return [
    http.get('/api/board/t1', () => HttpResponse.json({ task, comments: [], ancestors: [] })),
    http.get('/api/board/t1/executions', () => HttpResponse.json({ executions: [] })),
    http.get('/api/board/t1/workspace/detail', () => HttpResponse.json({ workspace: null })),
    http.get('/api/board/t1/plan', ({ request }) => {
      const asked = new URL(request.url).searchParams.get('revision')
      return HttpResponse.json(
        asked === '1'
          ? { plan: { ...REVISIONS[1], body: 'The first idea' }, revisions: REVISIONS }
          : plan,
      )
    }),
  ]
}

const WITH_PLAN = { plan: { ...REVISIONS[0], body: '## The newer idea' }, revisions: REVISIONS }

describe('the Plan tab', () => {
  it('is not there when the task has no plan', async () => {
    server.use(...drawerHandlers({ plan: null, revisions: [] }))
    render(<TaskDetailDrawer taskId="t1" onClose={() => undefined} />)
    await screen.findByRole('heading', { name: 'Ship it' })
    expect(screen.queryByRole('tab', { name: /plan/i })).toBeNull()
  })

  it('shows the newest revision, as a document', async () => {
    server.use(...drawerHandlers(WITH_PLAN))
    render(<TaskDetailDrawer taskId="t1" onClose={() => undefined} />)
    await userEvent.click(await screen.findByRole('tab', { name: /plan/i }))
    expect(await screen.findByRole('heading', { name: 'The newer idea' })).toBeTruthy()
    // Still the same task's drawer, named by its title.
    expect(screen.getByRole('heading', { name: 'Ship it' })).toBeTruthy()
  })

  it('reads an older revision after a newer one, with who decided it', async () => {
    server.use(...drawerHandlers(WITH_PLAN))
    render(<TaskDetailDrawer taskId="t1" onClose={() => undefined} />)
    await userEvent.click(await screen.findByRole('tab', { name: /plan/i }))
    await screen.findByRole('heading', { name: 'The newer idea' })
    await userEvent.click(screen.getByRole('button', { name: /revision 1/i }))
    expect(await screen.findByText('The first idea')).toBeTruthy()
    expect(screen.getByTestId('plan-decision').textContent).toMatch(/turned down by you/i)
  })

  it('an image in a plan does not load', async () => {
    server.use(
      ...drawerHandlers({
        plan: { ...REVISIONS[0], body: '![x](http://evil.example/x.png)' },
        revisions: [REVISIONS[0]],
      }),
    )
    render(<TaskDetailDrawer taskId="t1" onClose={() => undefined} />)
    await userEvent.click(await screen.findByRole('tab', { name: /plan/i }))
    await waitFor(() => expect(screen.getByTestId('task-plan-body').textContent).toBeTruthy())
    expect(screen.getByTestId('task-plan-body').querySelector('img')).toBeNull()
  })

  it('goes back to the details', async () => {
    server.use(...drawerHandlers(WITH_PLAN))
    render(<TaskDetailDrawer taskId="t1" onClose={() => undefined} />)
    await userEvent.click(await screen.findByRole('tab', { name: /plan/i }))
    await screen.findByRole('heading', { name: 'The newer idea' })
    await userEvent.click(screen.getByRole('tab', { name: /details/i }))
    expect(screen.queryByRole('heading', { name: 'The newer idea' })).toBeNull()
    expect(screen.getByTestId('task-comments-section')).toBeTruthy()
  })

  it('offers the answer beside the plan it asks about', async () => {
    const question = {
      id: 'q1',
      kind: 'suggest_tasks',
      payload: {
        prompt: 'Lead proposes a plan.',
        tasks: [{ title: 'Run the tests', agentId: 'a2', agentName: 'Bug Boo' }],
        plan: { revision: 2, parentTaskId: null, holder: true },
      },
    }
    server.use(
      ...drawerHandlers(WITH_PLAN, {
        id: 't1',
        title: 'Ship it',
        status: 'blocked',
        attention: { reason: 'question', failedRuns: 0, questionId: 'q1' },
        openQuestion: question,
      }),
    )
    render(<TaskDetailDrawer taskId="t1" onClose={() => undefined} />)
    await userEvent.click(await screen.findByRole('tab', { name: /plan/i }))
    await screen.findByRole('heading', { name: 'The newer idea' })
    const panel = screen.getByTestId('task-plan')
    expect(within(panel).getByRole('button', { name: 'Accept' })).toBeTruthy()
    // An older revision is not what the question asks about.
    await userEvent.click(within(panel).getByRole('button', { name: /revision 1/i }))
    await screen.findByText('The first idea')
    expect(within(panel).queryByRole('button', { name: 'Accept' })).toBeNull()
  })
})

describe('answering a plan', () => {
  const question = {
    id: 'q1',
    kind: 'suggest_tasks',
    payload: {
      prompt: 'Lead proposes a plan of 2 steps.',
      tasks: [
        { title: 'Run the tests', agentId: 'a2', agentName: 'Bug Boo' },
        { title: 'Fix what fails', agentId: 'a3', agentName: 'Design Boo' },
      ],
      plan: { revision: 1, parentTaskId: null, holder: true },
    },
  }

  const answers: unknown[] = []
  const answering = (body: Record<string, unknown>, status = 200) =>
    server.use(
      http.post('/api/board/questions/q1/answer', async ({ request }) => {
        answers.push(await request.json())
        return HttpResponse.json(body, { status })
      }),
    )

  const longWords = `${'Run the checkout tests. '.repeat(10)}Then delete the staging database.`
  const longStep = {
    id: 'q1',
    kind: 'suggest_tasks',
    payload: {
      prompt: 'Lead proposes a plan of one step.',
      tasks: [
        {
          title: longWords.slice(0, 200),
          description: longWords,
          agentId: 'a2',
          agentName: 'Bug Boo',
        },
      ],
      plan: { revision: 1, parentTaskId: null, holder: true },
    },
  }

  it('shows the whole of a step, not just the start of it', () => {
    render(<QuestionAnswer question={longStep} onAnswered={() => undefined} />)
    expect((screen.getByLabelText('Suggested task 1') as HTMLTextAreaElement).value).toBe(longWords)
  })

  it('what the person edits is what is sent: nothing they took out goes back', async () => {
    answers.length = 0
    answering({ ok: true, created: 1 })
    render(<QuestionAnswer question={longStep} onAnswered={() => undefined} />)
    const field = screen.getByLabelText('Suggested task 1')
    await userEvent.clear(field)
    await userEvent.type(field, 'Only run the tests')
    await userEvent.click(screen.getByRole('button', { name: 'Accept' }))
    await waitFor(() => expect(answers).toHaveLength(1))
    expect(answers[0]).toEqual({
      answer: {
        accepted: true,
        tasks: [{ title: 'Only run the tests', agentId: 'a2', agentName: 'Bug Boo' }],
      },
    })
    expect(JSON.stringify(answers[0])).not.toContain('delete the staging database')
  })

  it('an untouched long step is sent whole', async () => {
    answers.length = 0
    answering({ ok: true, created: 1 })
    render(<QuestionAnswer question={longStep} onAnswered={() => undefined} />)
    await userEvent.click(screen.getByRole('button', { name: 'Accept' }))
    await waitFor(() => expect(answers).toHaveLength(1))
    const sent = answers[0] as { answer: { tasks: Array<{ description?: string }> } }
    expect(sent.answer.tasks[0]?.description).toBe(longWords)
  })

  it('shows who each step goes to', () => {
    render(<QuestionAnswer question={question} onAnswered={() => undefined} />)
    expect(screen.getByText('Bug Boo')).toBeTruthy()
    expect(screen.getByText('Design Boo')).toBeTruthy()
  })

  it('sends who each step goes to, and any note', async () => {
    answers.length = 0
    answering({ ok: true, created: 2 })
    const onAnswered = vi.fn()
    render(<QuestionAnswer question={question} onAnswered={onAnswered} />)
    await userEvent.type(screen.getByLabelText(/note for the agent/i), 'Go on')
    await userEvent.click(screen.getByRole('button', { name: 'Accept' }))
    await waitFor(() => expect(onAnswered).toHaveBeenCalled())
    expect(answers[0]).toEqual({
      answer: {
        accepted: true,
        tasks: [
          { title: 'Run the tests', agentId: 'a2', agentName: 'Bug Boo' },
          { title: 'Fix what fails', agentId: 'a3', agentName: 'Design Boo' },
        ],
        note: 'Go on',
      },
    })
  })

  it('says the tasks are on the board', async () => {
    answering({ ok: true, created: 2 })
    useToastStore.setState({ toasts: [] })
    render(<QuestionAnswer question={question} onAnswered={() => undefined} />)
    await userEvent.click(screen.getByRole('button', { name: 'Accept' }))
    await waitFor(() =>
      expect(
        useToastStore
          .getState()
          .toasts.map((t) => t.message)
          .join(),
      ).toMatch(/2 tasks are on the board/),
    )
  })

  it('turning it down sends the reason', async () => {
    answers.length = 0
    answering({ ok: true, created: 0 })
    render(<QuestionAnswer question={question} onAnswered={() => undefined} />)
    await userEvent.type(screen.getByLabelText(/note for the agent/i), 'Too much at once')
    await userEvent.click(screen.getByRole('button', { name: 'Turn down' }))
    await waitFor(() => expect(answers).toHaveLength(1))
    expect(answers[0]).toEqual({ answer: { accepted: false, note: 'Too much at once' } })
  })

  it('says plainly when a plan has too many steps, and leaves it open', async () => {
    answering({ ok: false, error: 'too_many_steps' }, 400)
    useToastStore.setState({ toasts: [] })
    const onAnswered = vi.fn()
    render(<QuestionAnswer question={question} onAnswered={onAnswered} />)
    await userEvent.click(screen.getByRole('button', { name: 'Accept' }))
    await waitFor(() =>
      expect(
        useToastStore
          .getState()
          .toasts.map((t) => t.message)
          .join(),
      ).toMatch(/25 steps/),
    )
    expect(onAnswered).not.toHaveBeenCalled()
  })
})
