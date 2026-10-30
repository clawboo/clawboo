// Find on the Board, rendered through the real BoardPanel against msw: the
// magnifier and the / key that open it, the results a query lists (by title and
// by agent name), Enter revealing a card wherever it sits (another week, or out of
// the Today view), Shift+Enter opening a task, a routine opening its dialog, and
// Escape handing focus back to the button.
//
// Fixtures are built from "now" and the same range math the panel uses, so the
// suite holds on any day of the week and in any time zone. Routine runs are
// served on today's window, so they always land on today's row.

import { cleanup, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { http, HttpResponse } from 'msw'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import type { ScheduleRecord } from '@clawboo/scheduler'

import { ThemeProvider } from '@/features/theme/ThemeProvider'
import { useFleetStore } from '@/stores/fleet'
import { useTeamStore } from '@/stores/team'
import { useToastStore } from '@/stores/toast'

import { server } from '../../../../__vitest__/mswServer'
import { BoardPanel } from '../../BoardPanel'
import { addDays, buildRange, dayKey, localeWeekStart, startOfDay } from '../calendarModel'
import { pickView } from '../../__tests__/boardControls'
import { resetBoardStorage } from '../../__tests__/resetBoardStorage'

const HOUR = 3_600_000

function thisWeek() {
  return buildRange('week', Date.now(), localeWeekStart())
}

/** An instant earlier today (or this very moment just after midnight). */
function earlierToday(): number {
  return Math.max(startOfDay(Date.now()) + 1000, Date.now() - 60_000)
}

const ROUTINE: ScheduleRecord = {
  id: 'clawboo-routine:r1',
  sourceScheduleId: 'r1',
  runtime: 'clawboo-native',
  owner: 'clawboo',
  source: 'clawboo-routine',
  agentId: '',
  target: 'team',
  teamId: 'team-1',
  teamName: 'Alpha',
  agentName: 'Boo Zero',
  label: 'Morning digest',
  description: 'Summarise what happened overnight.',
  cronSpec: '0 9 * * 1-5',
  nextRunAt: null,
  status: 'idle',
  manageability: 'managed',
  domain: 'team-task',
  tenantId: null,
}

/**
 * Serve the board and, when `runs` is set, that many runs of one routine in
 * today's window, the first an hour from now. Bucketing goes by window, so the
 * runs sit on today's row whatever the hour.
 */
function serve(tasks: unknown[], runs = 0): void {
  const firstRunAt = Date.now() + HOUR
  server.use(
    http.get('/api/board', () => HttpResponse.json({ tasks })),
    http.get('/api/schedules/occurrences', ({ request }) => {
      const bounds = (new URL(request.url).searchParams.get('bounds') ?? '').split(',').map(Number)
      const now = Date.now()
      return HttpResponse.json({
        now,
        routines:
          runs > 0
            ? [
                {
                  schedule: { ...ROUTINE, nextRunAt: firstRunAt },
                  windows: bounds.slice(0, -1).map((start, i) => {
                    const end = bounds[i + 1]!
                    if (!(start <= now && now < end)) return { count: 0, more: false, times: [] }
                    return {
                      count: runs,
                      more: false,
                      times: Array.from({ length: runs }, (_, k) => firstRunAt + k * 60_000),
                    }
                  }),
                },
              ]
            : [],
      })
    }),
    http.get('/api/teams', () =>
      HttpResponse.json({ teams: [{ id: 'team-1', name: 'Alpha', icon: 'A' }] }),
    ),
    http.get('/api/schedules', () =>
      HttpResponse.json({
        schedules: runs > 0 ? [ROUTINE] : [],
        sources: [{ sourceId: 'clawboo-routine', ok: true, degraded: false, at: 1 }],
      }),
    ),
    http.get('/api/schedules/:id/runs', () => HttpResponse.json({ runs: [] })),
  )
}

/** The drawer's reads for one task, so a card can be opened. */
function serveDrawer(task: { id: string; title: string; status: string }): void {
  server.use(
    http.get(`/api/board/${task.id}`, () =>
      HttpResponse.json({ task, comments: [], ancestors: [] }),
    ),
    http.get(`/api/board/${task.id}/executions`, () => HttpResponse.json({ executions: [] })),
    http.get(`/api/board/${task.id}/workspace/detail`, () => HttpResponse.json({ ok: false })),
    http.get('/api/obs/events', () => HttpResponse.json({ events: [] })),
  )
}

/** The board, with a button beside it that is not part of the board. */
function renderBoard() {
  return render(
    <ThemeProvider>
      <button type="button">Elsewhere on the page</button>
      <BoardPanel />
    </ThemeProvider>,
  )
}

type User = ReturnType<typeof userEvent.setup>

/** The card on the calendar showing a title. */
function cardFor(title: string): HTMLElement {
  return within(screen.getByTestId('board-calendar'))
    .getByText(title)
    .closest('[data-testid="board-card"]') as HTMLElement
}

/** The toolbar's magnifier. */
function findButton(): HTMLElement {
  return screen.getByTestId('board-find')
}

/** Find's field, once it has taken focus. */
async function field(): Promise<HTMLElement> {
  const input = await screen.findByRole('combobox', {
    name: 'Find a task, an agent or a routine',
  })
  await waitFor(() => expect(input).toHaveFocus())
  return input
}

/** Open Find from its button and type a query into it. */
async function findFor(user: User, query: string): Promise<HTMLElement> {
  await user.click(findButton())
  const input = await field()
  await user.type(input, query)
  return screen.getByRole('listbox', { name: 'Results' })
}

beforeEach(() => {
  useTeamStore.setState({ teams: [], selectedTeamId: null })
  useToastStore.setState({ toasts: [] })
  useFleetStore.setState({ agents: [] })
  resetBoardStorage()
})
afterEach(() => cleanup())

describe('opening Find', () => {
  it('opens from the magnifier and closes again on a second press', async () => {
    serve([{ id: 't1', title: 'Any task', status: 'todo', createdAt: earlierToday() }])
    const user = userEvent.setup()
    renderBoard()
    await screen.findByTestId('board-calendar')
    expect(findButton()).toHaveAttribute('aria-expanded', 'false')
    expect(screen.queryByTestId('calendar-find')).toBeNull()

    await user.click(findButton())
    const popover = await screen.findByTestId('calendar-find')
    expect(popover).toHaveAccessibleName('Find on the board')
    await field()
    expect(findButton()).toHaveAttribute('aria-expanded', 'true')

    await user.click(findButton())
    await waitFor(() => expect(screen.queryByTestId('calendar-find')).toBeNull())
    expect(findButton()).toHaveAttribute('aria-expanded', 'false')
  })

  it('opens on / while focus is on the board, and not while it is elsewhere', async () => {
    serve([{ id: 't1', title: 'Any task', status: 'todo', createdAt: earlierToday() }])
    const user = userEvent.setup()
    renderBoard()
    await screen.findByTestId('board-calendar')

    // Focus outside the board leaves / to the page.
    screen.getByRole('button', { name: 'Elsewhere on the page' }).focus()
    await user.keyboard('/')
    expect(screen.queryByTestId('calendar-find')).toBeNull()
    expect(findButton()).toHaveAttribute('aria-expanded', 'false')

    // On a toolbar control, / is the board's.
    screen.getByTestId('board-range-title').focus()
    await user.keyboard('/')
    expect(await screen.findByTestId('calendar-find')).toBeInTheDocument()
    const input = await field()
    // The key opened Find; it was not typed into the field.
    expect(input).toHaveValue('')
    expect(findButton()).toHaveAttribute('aria-expanded', 'true')
  })

  it('closes on Escape and hands focus back to the magnifier', async () => {
    serve([{ id: 't1', title: 'Any task', status: 'todo', createdAt: earlierToday() }])
    const user = userEvent.setup()
    renderBoard()
    await screen.findByTestId('board-calendar')

    await user.click(findButton())
    await field()
    await user.keyboard('{Escape}')
    await waitFor(() => expect(screen.queryByTestId('calendar-find')).toBeNull())
    expect(findButton()).toHaveFocus()
    expect(findButton()).toHaveAttribute('aria-expanded', 'false')
  })

  it('hands focus back to the control the person was on after opening on /', async () => {
    serve([{ id: 't1', title: 'Any task', status: 'todo', createdAt: earlierToday() }])
    const user = userEvent.setup()
    renderBoard()
    await screen.findByTestId('board-calendar')

    const title = screen.getByTestId('board-range-title')
    title.focus()
    await user.keyboard('/')
    await field()
    await user.keyboard('{Escape}')
    await waitFor(() => expect(screen.queryByTestId('calendar-find')).toBeNull())
    // A keyboard user opened it from where they were, so that is where they land.
    expect(title).toHaveFocus()
    expect(findButton()).toHaveAttribute('aria-expanded', 'false')
  })
})

describe('the results', () => {
  it('lists a task for part of its title, and leaves out the rest', async () => {
    serve([
      { id: 't1', title: 'Draft the launch note', status: 'todo', createdAt: earlierToday() },
      { id: 't2', title: 'Pay the invoices', status: 'todo', createdAt: earlierToday() - 1000 },
    ])
    const user = userEvent.setup()
    renderBoard()
    await screen.findByTestId('board-calendar')

    const listbox = await findFor(user, 'launc')
    const options = within(listbox).getAllByRole('option')
    expect(options).toHaveLength(1)
    expect(options[0]).toHaveTextContent('Draft the launch note')
    // Today's card is on screen, so it sits in the first group.
    expect(within(listbox).getByRole('group', { name: 'In this week' })).toContainElement(
      options[0]!,
    )
    expect(within(listbox).queryByText('Pay the invoices')).toBeNull()
  })

  it('finds a task by the name of the agent working it', async () => {
    useFleetStore.setState({
      agents: [
        { id: 'ada', name: 'Ada Lovelace', teamId: 'team-1' },
        { id: 'bob', name: 'Bob Builder', teamId: 'team-1' },
      ] as never,
    })
    serve([
      {
        id: 't1',
        title: 'Write the brief',
        status: 'todo',
        assigneeAgentId: 'ada',
        createdAt: earlierToday(),
      },
      {
        id: 't2',
        title: 'Check the numbers',
        status: 'todo',
        assigneeAgentId: 'bob',
        createdAt: earlierToday() - 1000,
      },
    ])
    const user = userEvent.setup()
    renderBoard()
    await screen.findByTestId('board-calendar')

    const listbox = await findFor(user, 'lovelace')
    const options = within(listbox).getAllByRole('option')
    expect(options).toHaveLength(1)
    expect(options[0]).toHaveTextContent('Write the brief')
    // The row says why it matched, since the title does not hold the word.
    expect(options[0]).toHaveTextContent('Agent: Ada Lovelace')
    expect(within(listbox).queryByText('Check the numbers')).toBeNull()
  })

  it('opens a routine in its dialog', async () => {
    serve([{ id: 't1', title: 'Any task', status: 'todo', createdAt: earlierToday() }], 2)
    const user = userEvent.setup()
    renderBoard()
    // The routine's runs are read before Find can list it.
    await screen.findAllByTestId('calendar-routine-run')

    const listbox = await findFor(user, 'digest')
    const routines = within(listbox).getByRole('group', { name: 'Routines' })
    expect(within(routines).getByRole('option')).toHaveTextContent('Morning digestRoutine')

    // A routine opens on Enter, there being no card to show.
    await user.keyboard('{Enter}')
    expect(await screen.findByRole('dialog', { name: /Morning digest/ })).toBeInTheDocument()
    expect(screen.queryByTestId('calendar-find')).toBeNull()
  })
})

describe('picking a task', () => {
  it('shows the card on Enter: Find closes, and the card takes focus and flashes', async () => {
    serve([
      { id: 't1', title: 'Draft the launch note', status: 'todo', createdAt: earlierToday() },
      { id: 't2', title: 'Pay the invoices', status: 'todo', createdAt: earlierToday() - 1000 },
    ])
    const user = userEvent.setup()
    renderBoard()
    await screen.findByTestId('board-calendar')
    expect(cardFor('Draft the launch note')).not.toHaveClass('calendar-chip--arrived')

    await findFor(user, 'launch')
    await user.keyboard('{Enter}')
    await waitFor(() => expect(screen.queryByTestId('calendar-find')).toBeNull())
    await waitFor(() => expect(cardFor('Draft the launch note')).toHaveFocus())
    expect(cardFor('Draft the launch note')).toHaveClass('calendar-chip--arrived')
    expect(cardFor('Pay the invoices')).not.toHaveClass('calendar-chip--arrived')
    // Showing a card does not open it.
    expect(screen.queryByTestId('task-detail-drawer')).toBeNull()
    expect(findButton()).toHaveAttribute('aria-expanded', 'false')
  })

  it('moves to the week a task sits on when it is in another week', async () => {
    const day = addDays(thisWeek().start, -10) + 10 * HOUR
    serve([
      { id: 't1', title: 'Any task', status: 'todo', createdAt: earlierToday() },
      {
        id: 'old',
        title: 'Shipped the pricing page',
        status: 'done',
        createdAt: day,
        updatedAt: day,
        completedAt: day,
      },
    ])
    const user = userEvent.setup()
    renderBoard()
    await screen.findByTestId('board-calendar')
    const calendar = () => within(screen.getByTestId('board-calendar'))
    expect(calendar().queryByText('Shipped the pricing page')).toBeNull()

    const listbox = await findFor(user, 'pricing')
    // Finished in a week before this one, so it is listed as earlier.
    expect(within(listbox).getByRole('group', { name: 'Before this week' })).toHaveTextContent(
      'Shipped the pricing page',
    )
    await user.keyboard('{Enter}')

    await waitFor(() => expect(cardFor('Shipped the pricing page')).toHaveFocus())
    expect(screen.getByTestId(`calendar-cell-done-${dayKey(day)}`)).toContainElement(
      cardFor('Shipped the pricing page'),
    )
    expect(cardFor('Shipped the pricing page')).toHaveClass('calendar-chip--arrived')
    // The week shown is that one: today is not in it.
    expect(screen.getByTestId('board-calendar')).toHaveAttribute('data-mode', 'week')
    expect(screen.queryByTestId(`calendar-day-${dayKey(Date.now())}`)).toBeNull()
    expect(calendar().queryByText('Any task')).toBeNull()
  })

  it('leaves the Today view for the week of a task from another day', async () => {
    const yesterday = addDays(Date.now(), -1) + 10 * HOUR
    serve([
      { id: 't1', title: 'Any task', status: 'todo', createdAt: earlierToday() },
      {
        id: 'y',
        title: 'Filed the expense report',
        status: 'done',
        createdAt: yesterday,
        updatedAt: yesterday,
        completedAt: yesterday,
      },
    ])
    const user = userEvent.setup()
    renderBoard()
    await screen.findByTestId('board-calendar')
    await pickView(user, 'Today')
    expect(screen.getByTestId('board-calendar')).toHaveAttribute('data-mode', 'day')
    // Finished work from another day is not on the Today view.
    expect(
      within(screen.getByTestId('board-calendar')).queryByText('Filed the expense report'),
    ).toBeNull()

    await findFor(user, 'expense')
    await user.keyboard('{Enter}')

    await waitFor(() =>
      expect(screen.getByTestId('board-calendar')).toHaveAttribute('data-mode', 'week'),
    )
    expect(screen.getByTestId('board-view')).toHaveAttribute('aria-label', 'View: Week')
    await waitFor(() => expect(cardFor('Filed the expense report')).toHaveFocus())
    expect(screen.getByTestId(`calendar-cell-done-${dayKey(yesterday)}`)).toContainElement(
      cardFor('Filed the expense report'),
    )
    expect(cardFor('Filed the expense report')).toHaveClass('calendar-chip--arrived')
  })

  it('opens the task on Shift+Enter', async () => {
    const task = { id: 't1', title: 'Draft the launch note', status: 'todo' }
    serve([
      { ...task, createdAt: earlierToday() },
      { id: 't2', title: 'Pay the invoices', status: 'todo', createdAt: earlierToday() - 1000 },
    ])
    serveDrawer(task)
    const user = userEvent.setup()
    renderBoard()
    await screen.findByTestId('board-calendar')

    await findFor(user, 'launch')
    await user.keyboard('{Shift>}{Enter}{/Shift}')
    const drawer = await screen.findByTestId('task-detail-drawer')
    expect(within(drawer).getAllByText('Draft the launch note').length).toBeGreaterThan(0)
    expect(screen.queryByTestId('calendar-find')).toBeNull()
    expect(cardFor('Draft the launch note')).toHaveAttribute('data-open', 'true')
    expect(cardFor('Pay the invoices')).not.toHaveAttribute('data-open')
  })
})
