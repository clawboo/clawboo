// BoardTaskCard — the durable board task rendered inline in the group chat.
//
// The load-bearing case is the `blocked` one. The card's lazy report-up fetch
// deliberately fires for `done` / `blocked` / `cancelled`, which is NOT the state
// machine's terminal pair — a failed run is parked on `blocked`, and that is where
// the orchestrator writes the reason comment. These tests pin that, so narrowing
// the gate to `isTerminal` (which reads like a tidy-up) fails loudly instead of
// silently hiding every failure reason from the chat timeline.

import { cleanup, render as rtlRender, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { http, HttpResponse } from 'msw'
import { afterEach, describe, expect, it } from 'vitest'

import { ThemeProvider } from '@/features/theme/ThemeProvider'
import type { BoardTaskView } from '@/stores/board'
import { useFleetStore } from '@/stores/fleet'
import { useViewStore } from '@/stores/view'

import { server } from '../../../__vitest__/mswServer'
import { BoardTaskCard } from '../BoardTaskCard'

afterEach(() => cleanup())

// The card's tint resolution reads the theme (useTeamBooColor → useTheme).
const render = (task: BoardTaskView, teamId?: string) =>
  rtlRender(
    <ThemeProvider>
      <BoardTaskCard task={task} teamId={teamId} />
    </ThemeProvider>,
  )

function task(overrides: Partial<BoardTaskView> = {}): BoardTaskView {
  return {
    id: 't1',
    title: 'Summarise the changelog',
    status: 'todo',
    assigneeAgentId: null,
    parentTaskId: null,
    summary: null,
    createdAt: 1_700_000_000_000,
    updatedAt: 1_700_000_000_000,
    ...overrides,
  }
}

/** Serve one report-up comment for `t1`, counting how often the card asks. */
function reportUp(body: string) {
  const calls = { n: 0 }
  server.use(
    http.get('/api/board/t1', () => {
      calls.n += 1
      return HttpResponse.json({
        task: { id: 't1', title: 'Summarise the changelog' },
        comments: [{ body, authorType: 'agent' }],
        ancestors: [],
      })
    }),
  )
  return calls
}

describe('the lazy report-up fetch', () => {
  it('fetches the FAILURE REASON for a blocked task — the case a terminal-only gate would drop', async () => {
    reportUp('Ran out of context before the summary was written.')
    render(task({ status: 'blocked' }))

    expect(await screen.findByText(/Ran out of context/)).toBeInTheDocument()
    // Labelled "Reason", not "Output" — a blocked task reports why it stopped.
    expect(screen.getByText('Reason')).toBeInTheDocument()
    expect(screen.queryByText('Output')).not.toBeInTheDocument()
  })

  it('reads No result, with the reason, for a task whose agent finished twice with nothing', async () => {
    reportUp('Worker finished twice with no reply and nothing else to show for it.')
    render(
      task({
        status: 'blocked',
        waitingOn: '{"kind":"no_result"}',
        attention: { reason: 'no_result', failedRuns: 0 },
      }),
    )
    expect(screen.getByText('No result')).toBeInTheDocument()
    // The hint until the card has read its reason, which then takes its place.
    expect(screen.getByTestId('board-task-attention')).toHaveTextContent(/finished twice/)
    expect(await screen.findByText(/^Worker finished twice/)).toBeInTheDocument()
  })

  it('reads Waiting, and why, for a task waiting for its turn to try again', () => {
    render(
      task({
        status: 'todo',
        waitingOn: '{"kind":"retry","cause":"rate_limited","attempt":1}',
        attention: null,
      }),
    )
    expect(screen.getByText('Waiting')).toBeInTheDocument()
    expect(screen.getByTestId('board-task-waiting')).toHaveTextContent(
      'Retrying soon: rate limited',
    )
  })

  it('fetches the deliverable for a done task and labels it Output', async () => {
    reportUp('Shipped: 12 entries grouped by area.')
    render(task({ status: 'done' }))

    expect(await screen.findByText(/Shipped: 12 entries/)).toBeInTheDocument()
    expect(screen.getByText('Output')).toBeInTheDocument()
  })

  it('fetches for a cancelled task', async () => {
    reportUp('Cancelled — its blocker can never complete.')
    render(task({ status: 'cancelled' }))

    expect(await screen.findByText(/its blocker can never complete/)).toBeInTheDocument()
  })

  it('does NOT fetch while the task is still in flight', async () => {
    const calls = reportUp('should never be read')
    render(task({ status: 'in_progress' }))

    await screen.findByText('Summarise the changelog')
    await new Promise((r) => setTimeout(r, 50))
    expect(calls.n).toBe(0)
    expect(screen.queryByText(/should never be read/)).not.toBeInTheDocument()
  })

  it('uses the projection summary without a fetch when one is already present', async () => {
    const calls = reportUp('should never be read')
    render(task({ status: 'done', summary: 'Already in the projection.' }))

    expect(await screen.findByText('Already in the projection.')).toBeInTheDocument()
    expect(calls.n).toBe(0)
  })

  it('re-fetches the NEW failure reason after a retry fails again (blocked → in_progress → blocked)', async () => {
    // Each failure writes a fresh reason comment; the card must not pin the first.
    let call = 0
    server.use(
      http.get('/api/board/t1', () => {
        call += 1
        return HttpResponse.json({
          task: { id: 't1', title: 'Summarise the changelog' },
          comments: [
            {
              body:
                call === 1 ? 'First failure: ran out of context.' : 'Second failure: lint errors.',
              authorType: 'system',
            },
          ],
          ancestors: [],
        })
      }),
    )
    const view = render(task({ status: 'blocked' }))
    expect(await screen.findByText(/First failure/)).toBeInTheDocument()

    // The task is re-claimed for another attempt — the stale reason must clear,
    // both so it isn't displayed mid-retry and so the next settle re-fetches.
    view.rerender(
      <ThemeProvider>
        <BoardTaskCard task={task({ status: 'in_progress' })} />
      </ThemeProvider>,
    )
    await waitFor(() => expect(screen.queryByText(/First failure/)).not.toBeInTheDocument())

    // The retry fails too, with a NEW reason comment.
    view.rerender(
      <ThemeProvider>
        <BoardTaskCard task={task({ status: 'blocked' })} />
      </ThemeProvider>,
    )
    expect(await screen.findByText(/Second failure/)).toBeInTheDocument()
    expect(screen.queryByText(/First failure/)).not.toBeInTheDocument()
    expect(call).toBe(2)
  })
})

describe('the status pill', () => {
  it.each([
    ['backlog', 'Backlog'],
    ['todo', 'Queued'],
    ['in_progress', 'Working'],
    ['in_review', 'Verifying'],
    ['blocked', 'Blocked'],
    ['done', 'Done'],
    ['cancelled', 'Cancelled'],
  ])('labels %s as %s', async (status, label) => {
    reportUp('')
    render(task({ status }))
    expect(await screen.findByText(label)).toBeInTheDocument()
  })

  it('says a check that is waiting is waiting', async () => {
    reportUp('')
    render(task({ status: 'in_review', checkHeldSince: 1_700_000_000_000 }))
    expect(await screen.findByText('Waiting to check')).toBeInTheDocument()
    expect(screen.queryByText('Verifying')).not.toBeInTheDocument()
  })

  it('shows an off-list status by its raw name instead of mislabelling it "Queued"', async () => {
    reportUp('')
    render(task({ status: 'archived' }))

    // The board parks unknown statuses in its "Other" column; the chat pill is
    // honest about them for the same reason — claiming "Queued" would be wrong.
    expect(await screen.findByText('archived')).toBeInTheDocument()
    expect(screen.queryByText('Queued')).not.toBeInTheDocument()
  })
})

describe('rendering', () => {
  it('renders the task title and stamps the status on the card', async () => {
    render(task({ status: 'in_review' }))

    expect(await screen.findByText('Summarise the changelog')).toBeInTheDocument()
    await waitFor(() =>
      expect(screen.getByTestId('board-task-card')).toHaveAttribute(
        'data-task-status',
        'in_review',
      ),
    )
  })

  it('shows no output section when the settled task has no comment', async () => {
    server.use(
      http.get('/api/board/t1', () =>
        HttpResponse.json({ task: { id: 't1' }, comments: [], ancestors: [] }),
      ),
    )
    render(task({ status: 'done' }))

    await screen.findByText('Summarise the changelog')
    expect(screen.queryByText('Output')).not.toBeInTheDocument()
  })
})

describe('a task that needs a person', () => {
  it('says why on the pill instead of reading as blocked or queued work', async () => {
    reportUp('')
    render(task({ status: 'blocked', attention: { reason: 'failed', failedRuns: 3 } }))
    expect(await screen.findByText('Failed 3×')).toBeInTheDocument()
    expect(screen.queryByText('Blocked')).not.toBeInTheDocument()
  })

  it('a stopped task no longer passes for queued work, and says what that means', async () => {
    render(task({ status: 'todo', attention: { reason: 'stopped', failedRuns: 0 } }))
    expect(await screen.findByText('Stopped')).toBeInTheDocument()
    expect(screen.queryByText('Queued')).not.toBeInTheDocument()
    expect(screen.getByTestId('board-task-attention')).toHaveTextContent(/will not restart/)
  })
})

describe('the trail (comments + activity)', () => {
  it('is folded away until asked for', async () => {
    render(task({ status: 'in_progress' }))
    await screen.findByText('Summarise the changelog')
    expect(screen.getByTestId('board-task-trail-toggle')).toHaveAttribute('aria-expanded', 'false')
    expect(screen.queryByTestId('board-task-trail')).toBeNull()
  })

  it('opens onto the task’s comments, each attributed the way a person would say it', async () => {
    useFleetStore.setState({ agents: [{ id: 'a1', name: 'Coder', teamId: 'T' }] as never })
    server.use(
      http.get('/api/board/t1', () =>
        HttpResponse.json({
          task: { id: 't1', title: 'Summarise the changelog' },
          comments: [
            { id: 'c1', body: 'Run failed: provider out of credits', authorType: 'system' },
            { id: 'c2', body: 'Retry requested.', authorType: 'user' },
            { id: 'c3', body: 'Here is the summary.', authorType: 'agent', authorAgentId: 'a1' },
          ],
          ancestors: [],
        }),
      ),
    )
    render(task({ status: 'in_progress', assigneeAgentId: 'a1' }))
    await userEvent.click(await screen.findByTestId('board-task-trail-toggle'))
    const trail = await screen.findByTestId('board-task-trail')
    const log = await within(trail).findByTestId('task-comments')
    expect(within(log).getByText('Clawboo')).toBeInTheDocument()
    expect(within(log).getByText('You')).toBeInTheDocument()
    expect(within(log).getByText('Coder')).toBeInTheDocument()
    expect(within(log).getByText(/provider out of credits/)).toBeInTheDocument()
    expect(within(trail).getByRole('tab', { name: 'Comments (3)' })).toHaveAttribute(
      'aria-selected',
      'true',
    )
  })

  it('says when the comments could not load, and Retry reads them again', async () => {
    let available = false
    server.use(
      http.get('/api/board/t1', () =>
        available
          ? HttpResponse.json({
              task: { id: 't1', title: 'Summarise the changelog' },
              comments: [{ id: 'c1', body: 'Retry requested.', authorType: 'user' }],
              ancestors: [],
            })
          : HttpResponse.json({ error: 'unavailable' }, { status: 500 }),
      ),
    )
    render(task({ status: 'in_progress' }))
    await userEvent.click(await screen.findByTestId('board-task-trail-toggle'))
    const error = await screen.findByTestId('board-task-comments-error')
    expect(error).toHaveTextContent('Couldn’t load the comments.')
    expect(screen.queryByText('Loading…')).toBeNull()

    available = true
    await userEvent.click(within(error).getByRole('button', { name: 'Retry' }))
    const log = await screen.findByTestId('task-comments')
    expect(within(log).getByText('Retry requested.')).toBeInTheDocument()
    expect(screen.queryByTestId('board-task-comments-error')).toBeNull()
  })

  it('switches to the live activity feed for the same task', async () => {
    let scoped = ''
    server.use(
      http.get('/api/board/t1', () =>
        HttpResponse.json({ task: { id: 't1' }, comments: [], ancestors: [] }),
      ),
      http.get('/api/obs/events', ({ request }) => {
        scoped = new URL(request.url).searchParams.get('taskId') ?? ''
        return HttpResponse.json({ events: [] })
      }),
    )
    render(task({ status: 'in_progress' }))
    await userEvent.click(await screen.findByTestId('board-task-trail-toggle'))
    await userEvent.click(await screen.findByRole('tab', { name: 'Activity' }))
    await waitFor(() => expect(scoped).toBe('t1'))
  })
})

describe('Open on board', () => {
  it('switches to the Board and asks it to open this task, filtered to its team', async () => {
    useViewStore.setState({ viewMode: { type: 'groupChat', teamId: 'T' }, boardFocus: null })
    render(task({ status: 'in_progress' }), 'T')
    await userEvent.click(await screen.findByTestId('board-task-open'))
    const state = useViewStore.getState()
    expect(state.viewMode).toEqual({ type: 'nav', view: 'board' })
    expect(state.boardFocus).toMatchObject({ taskId: 't1', teamId: 'T' })
  })

  it('names the task by its readable id, and says Task when it has none', () => {
    render(task({ identifier: 'CLB-12' }))
    expect(screen.getByTestId('board-task-id')).toHaveTextContent('CLB-12')
    cleanup()
    render(task())
    expect(screen.getByTestId('board-task-id')).toHaveTextContent('Task')
  })
})

describe('BoardTaskCard: waits and people', () => {
  afterEach(() => cleanup())

  it('says whose it is when the task handed to a person is not yours', async () => {
    reportUp('')
    render(
      task({
        status: 'blocked',
        assigneePersonId: 'p2',
        assigneePerson: JSON.stringify({ id: 'p2', name: 'Priya' }),
        attention: { reason: 'assigned', failedRuns: 0, personId: 'p2' },
      }),
    )
    expect(await screen.findByText('Assigned to Priya')).toBeInTheDocument()
    expect(screen.getByTestId('board-task-attention')).toHaveTextContent(
      'Priya has this. Give it to an agent or mark it done.',
    )
  })

  it('does not say a paused task is waiting on anything', async () => {
    reportUp('')
    render(
      task({
        status: 'blocked',
        attention: null,
        waitingOn: '{"kind":"subtasks"}',
        waitingOnDetail: { openSubtasks: 2 },
        pause: { kind: 'team', id: 'T', name: 'Team' },
      } as never),
    )
    expect(await screen.findByText('Paused')).toBeInTheDocument()
    expect(screen.queryByText('Waiting on 2 sub-tasks')).toBeNull()
  })

  it('a task waiting on sub-tasks says so, with no Blocked pill and no Reason', async () => {
    server.use(
      http.get('/api/board/:id', () =>
        HttpResponse.json({
          task: { id: 'task-1' },
          comments: [{ authorType: 'agent', body: 'Waiting on the parts.' }],
          ancestors: [],
        }),
      ),
    )
    render(
      task({
        status: 'blocked',
        attention: null,
        waitingOn: '{"kind":"subtasks"}',
        waitingOnDetail: { openSubtasks: 2 },
      }),
    )
    expect(screen.getByText('Waiting on 2 sub-tasks')).toBeInTheDocument()
    expect(screen.queryByText('Blocked')).toBeNull()
    await new Promise((r) => setTimeout(r, 30))
    expect(screen.queryByText('Reason')).toBeNull()
  })

  it('shows who has a person’s task, not "Unassigned" and not the old agent', async () => {
    server.use(
      http.get('/api/access/identity', () =>
        HttpResponse.json({ you: { id: 'me', name: 'Me', role: null } }),
      ),
    )
    render(
      task({
        status: 'blocked',
        assigneeAgentId: null,
        assigneePersonId: 'p-priya',
        assigneePerson: '{"id":"p-priya","name":"Priya","role":null}',
        attention: { reason: 'assigned', failedRuns: 0, personId: 'p-priya' },
      }),
    )
    // Someone else's task: the pill and the header name them, once it knows who you are.
    expect(await screen.findByText('Assigned to Priya')).toBeInTheDocument()
    expect(screen.getByText('Priya')).toBeInTheDocument()
    expect(screen.queryByText('Unassigned')).toBeNull()
  })

  it('says You on your own', async () => {
    render(
      task({
        status: 'todo',
        assigneeAgentId: null,
        assigneePersonId: 'local',
        attention: { reason: 'assigned', failedRuns: 0, personId: 'local' },
      }),
    )
    expect(screen.getByText('Assigned to you')).toBeInTheDocument()
    expect(screen.getByText('You')).toBeInTheDocument()
  })
})
