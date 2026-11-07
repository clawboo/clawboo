// A person's request on the board: one card with its work nested under it, not a flat
// pile. A sub-task that needs a person still shows in Needs you, labelled with its
// request. Through the real panel, so the lanes, the card and Needs you are all read.

import { encodePlanHolder } from '@clawboo/board-core'
import { act, cleanup, render as rtlRender, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { http, HttpResponse } from 'msw'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { ThemeProvider } from '@/features/theme/ThemeProvider'
import { useFleetStore } from '@/stores/fleet'
import { useToastStore } from '@/stores/toast'
import { useViewStore } from '@/stores/view'
import { useTeamStore } from '@/stores/team'

import { server } from '../../../__vitest__/mswServer'
import { BoardPanel } from '../BoardPanel'
import { manualStatusOptions } from '../boardStatus'
import { ReplyReceipt } from '../ReplyReceipt'
import { resetBoardStorage } from './resetBoardStorage'

vi.mock('@/lib/useVisiblePolling', async (importOriginal) =>
  (await import('./boardControls')).pollingByHand(await importOriginal()),
)

// An agent's avatar reads the theme.
const render = (ui: React.ReactElement) => rtlRender(<ThemeProvider>{ui}</ThemeProvider>)

const row = (over: Record<string, unknown>) => ({
  title: 'A task',
  status: 'todo',
  createdAt: Date.now(),
  updatedAt: Date.now(),
  isMainTask: 0,
  ...over,
})

const MAIN = row({
  id: 'm',
  title: 'Build the login page',
  status: 'in_progress',
  identifier: 'CLB-1',
  isMainTask: 1,
  assigneeAgentId: 'lead',
  teamId: 'team-1',
})
const WORK = [
  row({ id: 'a', title: 'Write the form', status: 'done', parentTaskId: 'm', teamId: 'team-1' }),
  row({
    id: 'b',
    title: 'Review the form',
    status: 'in_progress',
    parentTaskId: 'm',
    teamId: 'team-1',
    assigneeAgentId: 'worker',
  }),
]

beforeEach(() => {
  useTeamStore.setState({ teams: [], selectedTeamId: null })
  resetBoardStorage()
  useToastStore.setState({ toasts: [] })
})
afterEach(() => cleanup())

describe('a request on the board', () => {
  it('shows one card, how far its work has got, and the work under it', async () => {
    server.use(http.get('/api/board', () => HttpResponse.json({ tasks: [MAIN, ...WORK] })))
    render(<BoardPanel />)
    const card = await screen.findByTestId('board-card')
    expect(card).toHaveTextContent('Build the login page')
    expect(within(card).getByTestId('board-card-progress')).toHaveTextContent('1 of 2 done')
    // Only the request is a card in a lane.
    expect(screen.getAllByTestId('board-card')).toHaveLength(1)
    const rows = screen.getAllByTestId('main-task-subtask')
    expect(rows.map((r) => r.textContent)).toEqual(['Write the form', 'Review the form'])
  })

  it('folds and opens the work under it, and opens a sub-task from its row', async () => {
    const user = userEvent.setup()
    server.use(
      http.get('/api/board', () => HttpResponse.json({ tasks: [MAIN, ...WORK] })),
      http.get('/api/board/b', () =>
        HttpResponse.json({ task: WORK[1], comments: [], ancestors: [] }),
      ),
    )
    render(<BoardPanel />)
    const toggle = await screen.findByRole('button', { name: '2 sub-tasks' })
    await user.click(toggle)
    expect(screen.queryByTestId('main-task-subtask')).toBeNull()
    await user.click(toggle)
    await user.click(screen.getAllByTestId('main-task-subtask')[1]!)
    expect(await screen.findByTestId('task-detail-drawer')).toHaveTextContent('Review the form')
  })

  it('folds the work of a finished request', async () => {
    const closed = { ...MAIN, status: 'done', completedAt: Date.now() }
    server.use(
      http.get('/api/board', () =>
        HttpResponse.json({ tasks: [closed, { ...WORK[0], completedAt: Date.now() }] }),
      ),
    )
    render(<BoardPanel />)
    await screen.findByRole('button', { name: '1 sub-task' })
    expect(screen.queryByTestId('main-task-subtask')).toBeNull()
  })

  it('a sub-task that needs a person shows in Needs you, labelled with its request', async () => {
    const stuck = row({
      id: 'c',
      title: 'Deploy it',
      status: 'blocked',
      parentTaskId: 'm',
      teamId: 'team-1',
      attention: { reason: 'failed', failedRuns: 1, detail: 'The disk is full' },
    })
    server.use(http.get('/api/board', () => HttpResponse.json({ tasks: [MAIN, ...WORK, stuck] })))
    render(<BoardPanel />)
    await screen.findByTestId('board-card')
    await waitFor(() => expect(screen.getByTestId('needs-you-request')).toBeInTheDocument())
    expect(screen.getByTestId('needs-you-request')).toHaveTextContent('For CLB-1')
    // It is listed under its request as well.
    expect(screen.getAllByTestId('main-task-subtask').map((r) => r.textContent)).toContain(
      'Deploy it',
    )
  })

  it('hides nothing that needs a person: a failure, a plan and the ask about waking, each labelled', async () => {
    const stuck = row({
      id: 'c',
      title: 'Deploy it',
      status: 'blocked',
      parentTaskId: 'm',
      teamId: 'team-1',
      attention: { reason: 'failed', failedRuns: 1, detail: 'The disk is full' },
    })
    const plan = row({
      id: 'p',
      title: 'Plan: run the tests and 1 more',
      status: 'blocked',
      parentTaskId: 'm',
      teamId: 'team-1',
      sourceDelegationId: encodePlanHolder('lead', 'x'),
      attention: { reason: 'question', failedRuns: 0, questionId: 'q1' },
      openQuestion: {
        id: 'q1',
        kind: 'suggest_tasks',
        payload: JSON.stringify({
          prompt: 'Lead proposes a plan of 2 steps.',
          tasks: [
            { title: 'Run the tests', agentId: 'a', agentName: 'A' },
            { title: 'Fix what fails', agentId: 'b', agentName: 'B' },
          ],
          plan: { revision: 1, parentTaskId: 'm', holder: true },
        }),
      },
    })
    const wakes = row({
      id: 'w',
      title: 'Needs a key',
      status: 'blocked',
      parentTaskId: 'm',
      teamId: 'team-1',
      attention: {
        reason: 'agent_wakes',
        failedRuns: 0,
        agentWakes: {
          jobTaskId: 'm',
          kind: 'ask',
          fromAgentId: 'a',
          toAgentId: 'b',
          fromAgentName: 'A',
          toAgentName: 'B',
        },
      },
    })
    server.use(
      http.get('/api/board', () =>
        HttpResponse.json({ tasks: [MAIN, ...WORK, stuck, plan, wakes] }),
      ),
    )
    render(<BoardPanel />)
    await screen.findByTestId('board-card')
    await waitFor(() => expect(screen.getAllByTestId('needs-you-request')).toHaveLength(3))
    for (const label of screen.getAllByTestId('needs-you-request'))
      expect(label).toHaveTextContent('For CLB-1')
    expect(screen.getByText('Lead proposes a plan of 2 steps.')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Accept' })).toBeInTheDocument()
    expect(screen.getByTestId('agent-wakes-card')).toBeInTheDocument()
    expect(screen.getAllByText('Deploy it').length).toBeGreaterThan(0)
    // The request's own card is one card in a lane, and does not stand in for any of them.
    expect(screen.getAllByTestId('board-card')).toHaveLength(1)
  })

  it('offers a parked request no agent or person to give it to', async () => {
    const parked = {
      ...MAIN,
      status: 'blocked',
      attention: { reason: 'blocked', failedRuns: 0, detail: 'The lead could not write it.' },
      teamId: 'team-1',
    }
    server.use(http.get('/api/board', () => HttpResponse.json({ tasks: [parked] })))
    useFleetStore.setState({
      agents: [{ id: 'worker', name: 'Worker', teamId: 'team-1' }] as never,
    })
    render(<BoardPanel />)
    const card = await screen.findByTestId('needs-you-task')
    await userEvent.click(within(card).getByRole('button', { name: /^More for/ }))
    const menu = await screen.findAllByRole('menuitem')
    const names = menu.map((m) => m.textContent ?? '')
    expect(names.some((n) => /Take it yourself/.test(n))).toBe(false)
    expect(names.some((n) => /Worker/.test(n))).toBe(false)
  })

  it('shows a sub-task under a folded request when something asks for it', async () => {
    const closed = { ...MAIN, status: 'done', completedAt: Date.now() }
    const sub = { ...WORK[0], completedAt: Date.now() }
    server.use(
      http.get('/api/board', () => HttpResponse.json({ tasks: [closed, sub] })),
      http.get('/api/board/a', () => HttpResponse.json({ task: sub, comments: [], ancestors: [] })),
    )
    render(<BoardPanel />)
    await screen.findByRole('button', { name: '1 sub-task' })
    expect(screen.queryByTestId('main-task-subtask')).toBeNull()
    act(() => useViewStore.getState().openBoardTask('a'))
    expect(await screen.findByTestId('main-task-subtask')).toHaveTextContent('Write the form')
  })

  it('leaves a board with no requests as it was', async () => {
    server.use(
      http.get('/api/board', () =>
        HttpResponse.json({
          tasks: [
            row({ id: 'x', title: 'Parent' }),
            row({ id: 'y', title: 'Child', parentTaskId: 'x' }),
          ],
        }),
      ),
    )
    render(<BoardPanel />)
    await waitFor(() => expect(screen.getAllByTestId('board-card')).toHaveLength(2))
    expect(screen.queryByTestId('main-task-subtask')).toBeNull()
  })

  it('offers a person only Done and Cancelled on one', () => {
    expect(manualStatusOptions('in_progress', { mainTask: true })).toEqual([
      'in_progress',
      'done',
      'cancelled',
    ])
    expect(manualStatusOptions('blocked', { mainTask: true })).toEqual([
      'blocked',
      'done',
      'cancelled',
    ])
    expect(manualStatusOptions('done', { mainTask: true })).toEqual(['done'])
  })
})

describe('finishing a request', () => {
  it('asks first when work under it is open, and says what happens to it', async () => {
    const { finishNeedFor, finishPromptNeeded } = await import('../finishMove')
    const open = { ...MAIN, waitingOnDetail: { openSubtasks: 2 } }
    const need = finishNeedFor(open as never, 'done', Date.now())
    expect(need.openSubtasks).toBe(2)
    expect(finishPromptNeeded(need)).toBe(true)
    const allIn = { ...MAIN, waitingOnDetail: { openSubtasks: 0 } }
    expect(finishPromptNeeded(finishNeedFor(allIn as never, 'done', Date.now()))).toBe(false)
    // Any other task's waiting detail says nothing about this.
    const plain = { ...MAIN, isMainTask: 0, waitingOnDetail: { openSubtasks: 2 } }
    expect(finishNeedFor(plain as never, 'done', Date.now()).openSubtasks).toBeUndefined()
  })
})

describe('reopening a request', () => {
  it('does not say it went back to To do', async () => {
    server.use(
      http.post('/api/board/m/reopen', () =>
        HttpResponse.json({ ok: true, delivery: { status: 'woke-agent', agentId: 'lead' } }),
      ),
    )
    const user = userEvent.setup()
    render(
      <ReplyReceipt
        delivery={{ status: 'not-delivered', agentId: 'lead', reason: 'finished' }}
        task={{ id: 'm', title: 'Build it', teamId: 'team-1', isMainTask: 1 }}
        body="One more thing"
      />,
    )
    expect(screen.queryByRole('button', { name: /follow-up/ })).toBeNull()
    await user.click(screen.getByRole('button', { name: /Reopen/ }))
    await waitFor(() => expect(useToastStore.getState().toasts.length).toBeGreaterThan(0))
    const said = useToastStore
      .getState()
      .toasts.map((t) => t.message)
      .join()
    expect(said).not.toMatch(/To do/)
    expect(said).toMatch(/lead/)
  })
})
