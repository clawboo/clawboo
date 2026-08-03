// BoardTaskCard — the durable board task rendered inline in the group chat.
//
// The load-bearing case is the `blocked` one. The card's lazy report-up fetch
// deliberately fires for `done` / `blocked` / `cancelled`, which is NOT the state
// machine's terminal pair — a failed run is parked on `blocked`, and that is where
// the orchestrator writes the reason comment. These tests pin that, so narrowing
// the gate to `isTerminal` (which reads like a tidy-up) fails loudly instead of
// silently hiding every failure reason from the chat timeline.

import { cleanup, render as rtlRender, screen, waitFor } from '@testing-library/react'
import { http, HttpResponse } from 'msw'
import { afterEach, describe, expect, it } from 'vitest'

import { ThemeProvider } from '@/features/theme/ThemeProvider'
import type { BoardTaskView } from '@/stores/board'

import { server } from '../../../__vitest__/mswServer'
import { BoardTaskCard } from '../BoardTaskCard'

afterEach(() => cleanup())

// The card's tint resolution reads the theme (useTeamBooColor → useTheme).
const render = (task: BoardTaskView) =>
  rtlRender(
    <ThemeProvider>
      <BoardTaskCard task={task} />
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
})

describe('the status pill', () => {
  it.each([
    ['backlog', 'Queued'],
    ['todo', 'Queued'],
    ['in_progress', 'Working'],
    ['in_review', 'Review'],
    ['blocked', 'Blocked'],
    ['done', 'Done'],
    ['cancelled', 'Cancelled'],
  ])('labels %s as %s', async (status, label) => {
    reportUp('')
    render(task({ status }))
    expect(await screen.findByText(label)).toBeInTheDocument()
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
