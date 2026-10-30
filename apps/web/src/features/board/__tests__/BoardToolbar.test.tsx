// The board's header and toolbar: Filter narrows the board to some agents, the
// tasks nobody has, or the work running now; the agents-working chip is the
// quick way to the last; Display hides the cost and the time on every card; C
// opens New task; and a spinner shows only when a background read runs long.

import { cleanup, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { delay, http, HttpResponse } from 'msw'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { ThemeProvider } from '@/features/theme/ThemeProvider'
import { useFleetStore } from '@/stores/fleet'
import { useTeamStore } from '@/stores/team'

import { server } from '../../../__vitest__/mswServer'
import { BoardPanel } from '../BoardPanel'
import { openDisplay, pollBoard } from './boardControls'
import { resetBoardStorage } from './resetBoardStorage'

vi.mock('@/lib/useVisiblePolling', async (importOriginal) =>
  (await import('./boardControls')).pollingByHand(await importOriginal()),
)

const HOUR = 60 * 60 * 1000
const earlier = () => Date.now() - HOUR

const TASKS = () => [
  {
    id: 'a',
    title: 'Coder work',
    status: 'in_progress',
    assigneeAgentId: 'coder',
    createdAt: earlier(),
    runCost: { usd: 0.42, estimated: false },
    runningSince: Date.now() - 5 * 60 * 1000,
  },
  {
    id: 'b',
    title: 'Writer work',
    status: 'in_progress',
    assigneeAgentId: 'writer',
    createdAt: earlier(),
  },
  { id: 'c', title: 'Loose idea', status: 'backlog', createdAt: earlier() },
]

function serve(tasks: Record<string, unknown>[] = TASKS()) {
  server.use(http.get('/api/board', () => HttpResponse.json({ tasks })))
}

function renderBoard() {
  render(
    <ThemeProvider>
      <BoardPanel />
    </ThemeProvider>,
  )
}

/** The titles on the board, in no particular order. */
function shownTitles(): string[] {
  return screen
    .queryAllByTestId('board-card')
    .map((c) => ['Coder work', 'Writer work', 'Loose idea'].find((t) => c.textContent?.includes(t)))
    .filter((t): t is string => !!t)
    .sort()
}

beforeEach(() => {
  resetBoardStorage()
  useTeamStore.setState({ teams: [], selectedTeamId: null })
  useFleetStore.setState({
    agents: [
      { id: 'coder', name: 'Coder', teamId: 'team-1' },
      { id: 'writer', name: 'Writer', teamId: 'team-1' },
    ] as never,
  })
})
afterEach(() => cleanup())

describe('Filter', () => {
  it('narrows the board to the agents picked, counts itself, and clears', async () => {
    serve()
    const user = userEvent.setup()
    renderBoard()
    await screen.findByText('Writer work')
    expect(shownTitles()).toEqual(['Coder work', 'Loose idea', 'Writer work'])

    await user.click(screen.getByTestId('board-filter'))
    const menu = await screen.findByRole('menu', { name: 'Filter the board' })
    await user.click(within(menu).getByRole('menuitemcheckbox', { name: 'Coder' }))
    expect(shownTitles()).toEqual(['Coder work'])
    expect(screen.getByTestId('board-filter')).toHaveAccessibleName('Filter, 1 on')

    // A filter menu stays open for the next pick: the tasks nobody has.
    await user.click(within(menu).getByRole('menuitemcheckbox', { name: 'No agent' }))
    expect(shownTitles()).toEqual(['Coder work', 'Loose idea'])
    expect(within(menu).getByRole('menuitemcheckbox', { name: 'Coder' })).toHaveAttribute(
      'aria-checked',
      'true',
    )

    await user.click(within(menu).getByRole('menuitem', { name: 'Clear filters' }))
    expect(shownTitles()).toEqual(['Coder work', 'Loose idea', 'Writer work'])
    expect(screen.getByTestId('board-filter')).toHaveAccessibleName('Filter')
    expect(screen.queryByRole('menu', { name: 'Filter the board' })).toBeNull()
  })

  it('shows only the running work from the agents-working chip, and all of it again', async () => {
    serve()
    const user = userEvent.setup()
    renderBoard()
    await screen.findByText('Writer work')

    const chip = screen.getByTestId('board-agents-working')
    expect(chip).toHaveTextContent('1 agent working')
    await user.click(chip)
    expect(chip).toHaveAttribute('aria-pressed', 'true')
    expect(shownTitles()).toEqual(['Coder work'])

    await user.click(chip)
    expect(chip).toHaveAttribute('aria-pressed', 'false')
    expect(shownTitles()).toEqual(['Coder work', 'Loose idea', 'Writer work'])
  })

  it('says when the filters hide every task, and clears them from there', async () => {
    serve(TASKS().filter((t) => t.id !== 'c'))
    const user = userEvent.setup()
    renderBoard()
    await screen.findByText('Writer work')
    expect(screen.queryByTestId('board-filtered-empty')).toBeNull()

    await user.click(screen.getByTestId('board-filter'))
    const menu = await screen.findByRole('menu', { name: 'Filter the board' })
    await user.click(within(menu).getByRole('menuitemcheckbox', { name: 'No agent' }))
    await user.keyboard('{Escape}')
    const notice = await screen.findByTestId('board-filtered-empty')
    expect(notice).toHaveTextContent('No tasks match these filters')
    expect(shownTitles()).toEqual([])

    await user.click(within(notice).getByRole('button', { name: 'Clear filters' }))
    expect(screen.queryByTestId('board-filtered-empty')).toBeNull()
    expect(shownTitles()).toEqual(['Coder work', 'Writer work'])
  })

  it('shows no agents-working chip while nobody is working', async () => {
    serve(TASKS().map((t) => ({ ...t, runningSince: undefined })))
    renderBoard()
    await screen.findByText('Writer work')
    expect(screen.queryByTestId('board-agents-working')).toBeNull()
  })
})

describe('Display', () => {
  it('hides the cost and the time on every card, and remembers it', async () => {
    serve()
    const user = userEvent.setup()
    renderBoard()
    const card = (await screen.findByText('Coder work')).closest(
      '[data-testid="board-card"]',
    ) as HTMLElement
    expect(within(card).getByTestId('board-card-cost')).toBeInTheDocument()
    expect(within(card).getByTestId('board-card-stamp')).toBeInTheDocument()

    const display = await openDisplay(user)
    await user.click(within(display).getByRole('button', { name: 'Cost' }))
    await user.click(within(display).getByRole('button', { name: 'Time' }))
    expect(within(display).getByRole('button', { name: 'Cost' })).toHaveAttribute(
      'aria-pressed',
      'false',
    )
    expect(within(card).queryByTestId('board-card-cost')).toBeNull()
    expect(within(card).queryByTestId('board-card-stamp')).toBeNull()
    expect(JSON.parse(window.localStorage.getItem('clawboo.board.calendar')!)).toMatchObject({
      cardCost: false,
      cardTime: false,
    })
  })

  it('opens the Cancelled column from its switch', async () => {
    serve()
    const user = userEvent.setup()
    renderBoard()
    await screen.findByText('Writer work')
    expect(screen.getByTestId('board-cancelled-rail')).toBeInTheDocument()
    const display = await openDisplay(user)
    await user.click(within(display).getByRole('switch', { name: 'Cancelled column' }))
    expect(screen.queryByTestId('board-cancelled-rail')).toBeNull()
  })
})

describe('the header', () => {
  it('opens New task with C while the board has focus, and not while typing', async () => {
    serve()
    const user = userEvent.setup()
    renderBoard()
    await screen.findByText('Writer work')

    // Typing a c into Find's field is a letter, not the shortcut.
    screen.getByTestId('board-view').focus()
    await user.keyboard('/')
    await user.keyboard('c')
    expect(screen.getByRole('combobox')).toHaveValue('c')
    expect(screen.queryByTestId('new-task-dialog')).toBeNull()
    await user.keyboard('{Escape}')

    screen.getByTestId('board-view').focus()
    await user.keyboard('c')
    expect(await screen.findByTestId('new-task-dialog')).toBeInTheDocument()
  })

  it('opens Find with Cmd+K or Ctrl+K, even from a field', async () => {
    serve()
    const user = userEvent.setup()
    renderBoard()
    await screen.findByText('Writer work')
    expect(screen.getByTestId('board-find')).toHaveAttribute(
      'aria-keyshortcuts',
      '/ Meta+K Control+K',
    )

    await user.keyboard('{Meta>}k{/Meta}')
    expect(await screen.findByRole('combobox')).toHaveFocus()
    await user.keyboard('{Escape}')
    await waitFor(() => expect(screen.queryByRole('combobox')).toBeNull())

    await user.keyboard('{Control>}k{/Control}')
    expect(await screen.findByRole('combobox')).toBeInTheDocument()
  })

  it('says what an empty Kanban lane holds, in its own words', async () => {
    resetBoardStorage({ view: 'all' })
    serve()
    renderBoard()
    await screen.findByText('Writer work')
    const lines = screen.getAllByTestId('board-lane-empty').map((l) => l.textContent)
    // Backlog and In progress have work; To do and Done do not.
    expect(lines).toEqual(['Nothing waiting to start', 'Nothing finished yet'])
  })

  it('shows a spinner only when a background read runs long', async () => {
    serve()
    renderBoard()
    await screen.findByText('Writer work')
    const spinner = screen.getByTestId('board-refreshing')
    expect(spinner.querySelector('svg')).toBeNull()

    // A slow read: nothing for the first 300ms, then the spinner, then nothing again.
    server.use(
      http.get('/api/board', async () => {
        await delay(900)
        return HttpResponse.json({ tasks: TASKS() })
      }),
    )
    await pollBoard()
    expect(spinner.querySelector('svg')).toBeNull()
    await waitFor(() => expect(spinner.querySelector('svg')).not.toBeNull(), { timeout: 2000 })
    await waitFor(() => expect(spinner.querySelector('svg')).toBeNull(), { timeout: 3000 })
  })
})
