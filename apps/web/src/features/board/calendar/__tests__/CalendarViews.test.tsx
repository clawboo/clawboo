// The Board's Today and All views, rendered through the real BoardPanel against
// msw. Today is today alone: its own segment, no paging, the long date as its
// title, every card in a cell, the D key, and a date picker that opens a week.
// All is the calendar with one row: every task newest first, Needs you inside
// that row, no routine runs, and the same columns and Cancelled rail as a week.
//
// Fixtures are built from "now" and the same range math the panel uses, so the
// suite holds on any day of the week and in any time zone. Dates and times are
// built with the same Intl formatters the panel uses.

import { cleanup, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { http, HttpResponse } from 'msw'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import type { ScheduleRecord } from '@clawboo/scheduler'

import { ThemeProvider } from '@/features/theme/ThemeProvider'
import { useTeamStore } from '@/stores/team'
import { useToastStore } from '@/stores/toast'

import { server } from '../../../../__vitest__/mswServer'
import { BoardPanel } from '../../BoardPanel'
import { dayMonth, longDate, shortDate, timeLabel } from '../calendarFormat'
import { addDays, dayKey, startOfDay } from '../calendarModel'
import { resetBoardStorage } from '../../__tests__/resetBoardStorage'

const HOUR = 3_600_000
const DAY = 24 * HOUR
const PREFS_KEY = 'clawboo.board.calendar'

/** `s` as a literal inside a regular expression. */
function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
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
 * runs sit on today's row whatever the hour. Returns how often the runs were read.
 */
function serve(tasks: unknown[], runs = 0): { runReads: () => number } {
  let runReads = 0
  const firstRunAt = Date.now() + HOUR
  server.use(
    http.get('/api/board', () => HttpResponse.json({ tasks })),
    http.get('/api/schedules/occurrences', ({ request }) => {
      runReads += 1
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
  return { runReads: () => runReads }
}

function renderBoard() {
  return render(
    <ThemeProvider>
      <BoardPanel />
    </ThemeProvider>,
  )
}

/** A status column's sticky head: the first child of its column. */
function columnHead(id: string): HTMLElement {
  return screen.getByTestId(`board-column-${id}`).firstElementChild as HTMLElement
}

/** The card on the calendar showing a title. */
function cardFor(title: string): HTMLElement {
  return within(screen.getByTestId('board-calendar'))
    .getByText(title)
    .closest('[data-testid="board-card"]') as HTMLElement
}

/** The titles of the cards in a cell, top to bottom. */
function titlesIn(cell: HTMLElement, titles: readonly string[]): string[] {
  return within(cell)
    .getAllByTestId('board-card')
    .map((card) => titles.find((t) => card.textContent?.includes(t)) ?? '?')
}

/** The view switch's segments, in order. */
function viewSegments(): HTMLElement[] {
  return within(screen.getByRole('radiogroup', { name: 'Board view' })).getAllByRole('radio')
}

/** The range title's two parts: the dates, and the year beside them. */
function titleParts(): string[] {
  return Array.from(screen.getByTestId('board-range-title').children)
    .filter((el) => el.tagName === 'SPAN')
    .map((el) => el.textContent ?? '')
}

/** The panel header above the time bar: the title, its subtitle and the actions. */
function panelHeader(): HTMLElement {
  return screen.getByRole('heading', { name: 'Board', level: 1 }).parentElement!.parentElement!
    .parentElement!
}

/** The view the board stored for this browser. */
function storedMode(): unknown {
  const raw = window.localStorage.getItem(PREFS_KEY)
  return raw ? (JSON.parse(raw) as { mode?: unknown }).mode : undefined
}

/** Every day row on screen, by its day key. */
function dayRowKeys(): string[] {
  return Array.from(
    screen
      .getByTestId('board-calendar')
      .querySelectorAll<HTMLElement>('[data-testid^="calendar-day-"]'),
  ).map((el) => el.dataset['testid']!.slice('calendar-day-'.length))
}

beforeEach(() => {
  useTeamStore.setState({ teams: [], selectedTeamId: null })
  useToastStore.setState({ toasts: [] })
  resetBoardStorage()
})
afterEach(() => cleanup())

describe('the Today view', () => {
  it('comes first in the view switch, with Week chosen by default', async () => {
    serve([{ id: 't1', title: 'Any task', status: 'todo', createdAt: earlierToday() }])
    renderBoard()
    await screen.findByTestId('board-calendar')

    expect(viewSegments().map((r) => r.textContent)).toEqual(['Today', 'Week', 'Month', 'All'])
    expect(viewSegments().map((r) => r.getAttribute('aria-checked'))).toEqual([
      'false',
      'true',
      'false',
      'false',
    ])
    expect(screen.getByTestId('board-calendar')).toHaveAttribute('data-mode', 'week')
  })

  it('shows only today, with the open work from before it in Earlier', async () => {
    const today = Date.now()
    const yesterday = addDays(today, -1) + 10 * HOUR
    const lastMonth = addDays(today, -20) + 10 * HOUR
    serve([
      { id: 'a', title: 'Due today', status: 'todo', createdAt: earlierToday() },
      { id: 'b', title: 'Waiting from last month', status: 'todo', createdAt: lastMonth },
      {
        id: 'c',
        title: 'Shipped yesterday',
        status: 'done',
        createdAt: yesterday,
        updatedAt: yesterday,
        completedAt: yesterday,
      },
    ])
    const user = userEvent.setup()
    renderBoard()
    await screen.findByTestId('board-calendar')

    await user.click(screen.getByRole('radio', { name: 'Today' }))
    expect(screen.getByTestId('board-calendar')).toHaveAttribute('data-mode', 'day')
    expect(screen.getByRole('radio', { name: 'Today' })).toHaveAttribute('aria-checked', 'true')
    // One day row, today's; nothing folds and nothing else is drawn.
    expect(dayRowKeys()).toEqual([dayKey(today)])
    expect(screen.queryByTestId('calendar-row-gap')).toBeNull()
    expect(screen.queryByTestId('calendar-seam')).toBeNull()
    expect(
      within(screen.getByTestId(`calendar-cell-todo-${dayKey(today)}`)).getByText('Due today'),
    ).toBeInTheDocument()
    // Open work from before today rides in Earlier, open since it waits to start.
    expect(screen.getByTestId('calendar-row-earlier')).toHaveTextContent('1 to do')
    expect(
      within(screen.getByTestId('calendar-cell-todo-earlier')).getByText('Waiting from last month'),
    ).toBeInTheDocument()
    // Finished work from another day is history the Today view does not show.
    expect(screen.queryByText('Shipped yesterday')).toBeNull()
    // Needs you sits in today's row, not on a rail.
    expect(screen.getByTestId('calendar-needs-you-today')).toBeInTheDocument()
    expect(screen.queryByTestId('board-needs-you-rail')).toBeNull()
  })

  it('has nothing to page through, and names the day in full', async () => {
    serve([{ id: 't1', title: 'Any task', status: 'todo', createdAt: earlierToday() }])
    const user = userEvent.setup()
    renderBoard()
    await screen.findByTestId('board-calendar')
    // A week pages back and forth, and comes home with Today.
    expect(screen.getByRole('button', { name: /^Previous week/ })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /^Next week/ })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Go to today' })).toBeInTheDocument()

    await user.click(screen.getByRole('radio', { name: 'Today' }))
    expect(screen.queryByRole('button', { name: /^Previous/ })).toBeNull()
    expect(screen.queryByRole('button', { name: /^Next/ })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Go to today' })).toBeNull()
    // "Wednesday, Oct 14," then "2026", the weekday in full.
    const now = new Date()
    expect(titleParts()).toEqual([
      `${now.toLocaleDateString(undefined, { weekday: 'long', month: 'short', day: 'numeric' })},`,
      String(now.getFullYear()),
    ])
    expect(titleParts()[0]).toContain(now.toLocaleDateString(undefined, { weekday: 'long' }))
  })

  it('shows every card in a cell, where a week shows three and the rest on request', async () => {
    const added = earlierToday()
    serve(
      Array.from({ length: 5 }, (_, i) => ({
        id: `t${i}`,
        title: `Task ${i}`,
        status: 'todo',
        createdAt: added + i,
      })),
    )
    const user = userEvent.setup()
    renderBoard()
    const cell = () => screen.getByTestId(`calendar-cell-todo-${dayKey(Date.now())}`)
    await screen.findByTestId('board-calendar')
    expect(within(cell()).getAllByTestId('board-card')).toHaveLength(3)
    expect(within(cell()).getByRole('button', { name: '+2 more' })).toBeInTheDocument()

    await user.click(screen.getByRole('radio', { name: 'Today' }))
    expect(within(cell()).getAllByTestId('board-card')).toHaveLength(5)
    expect(within(cell()).queryByRole('button', { name: /more$/ })).toBeNull()
    expect(within(cell()).queryByRole('button', { name: 'Show less' })).toBeNull()
  })

  it('opens on D and goes back to the week on W, while the board has focus', async () => {
    serve([{ id: 't1', title: 'Any task', status: 'todo', createdAt: earlierToday() }])
    const user = userEvent.setup()
    renderBoard()
    await screen.findByTestId('board-calendar')
    screen.getByTestId('board-range-title').focus()

    await user.keyboard('d')
    expect(screen.getByTestId('board-calendar')).toHaveAttribute('data-mode', 'day')
    expect(screen.getByRole('radio', { name: 'Today' })).toHaveAttribute('aria-checked', 'true')
    expect(dayRowKeys()).toEqual([dayKey(Date.now())])

    await user.keyboard('w')
    expect(screen.getByTestId('board-calendar')).toHaveAttribute('data-mode', 'week')
    expect(screen.getByRole('radio', { name: 'Week' })).toHaveAttribute('aria-checked', 'true')
    expect(dayRowKeys()).toContain(dayKey(Date.now()))
  })

  it('opens the week of a date picked in the date picker, with that date lit', async () => {
    serve([{ id: 't1', title: 'Any task', status: 'todo', createdAt: earlierToday() }])
    const user = userEvent.setup()
    renderBoard()
    await screen.findByTestId('board-calendar')
    await user.click(screen.getByRole('radio', { name: 'Today' }))
    expect(screen.getByTestId('board-calendar')).toHaveAttribute('data-mode', 'day')

    await user.click(screen.getByTestId('board-range-title'))
    const picker = await screen.findByTestId('calendar-mini-month')
    const target = addDays(Date.now(), 14)
    // The picker opens on this month; step forward when the target is in the next.
    if (new Date(target).getMonth() !== new Date().getMonth()) {
      await user.click(within(picker).getByRole('button', { name: 'Next month' }))
    }
    await user.click(
      within(picker).getByRole('button', { name: new RegExp(`^${longDate(target)}`) }),
    )
    expect(screen.queryByTestId('calendar-mini-month')).toBeNull()
    expect(screen.getByTestId('board-calendar')).toHaveAttribute('data-mode', 'week')
    expect(screen.getByRole('radio', { name: 'Week' })).toHaveAttribute('aria-checked', 'true')
    expect(storedMode()).toBe('week')
    // The week shown is the picked date's, two weeks on, so today is not in it.
    expect(screen.getByTestId(`calendar-day-${dayKey(target)}`)).toHaveAttribute(
      'data-selected',
      'true',
    )
    expect(dayRowKeys()).not.toContain(dayKey(Date.now()))
  })

  it('is remembered in this browser, and the board opens on it next time', async () => {
    serve([{ id: 't1', title: 'Any task', status: 'todo', createdAt: earlierToday() }])
    const user = userEvent.setup()
    renderBoard()
    await screen.findByTestId('board-calendar')
    expect(storedMode()).not.toBe('day')

    await user.click(screen.getByRole('radio', { name: 'Today' }))
    expect(storedMode()).toBe('day')

    cleanup()
    renderBoard()
    await screen.findByTestId('board-calendar')
    expect(screen.getByTestId('board-calendar')).toHaveAttribute('data-mode', 'day')
    expect(screen.getByRole('radio', { name: 'Today' })).toHaveAttribute('aria-checked', 'true')
    expect(dayRowKeys()).toEqual([dayKey(Date.now())])
  })
})

describe('the All view', () => {
  it('draws every task in one row, whose gutter counts them, newest first', async () => {
    const now = Date.now()
    serve([
      { id: 'a', title: 'Fresh idea', status: 'todo', createdAt: earlierToday() },
      { id: 'b', title: 'Parked plan', status: 'backlog', createdAt: addDays(now, -9) + HOUR },
      { id: 'c', title: 'Old chore', status: 'todo', createdAt: addDays(now, -40) + HOUR },
      { id: 'd', title: 'Working now', status: 'in_progress', createdAt: addDays(now, -2) },
      {
        id: 'e',
        title: 'Shipped long ago',
        status: 'done',
        createdAt: addDays(now, -60),
        completedAt: addDays(now, -50),
      },
    ])
    const user = userEvent.setup()
    renderBoard()
    await screen.findByTestId('board-calendar')

    await user.click(screen.getByRole('radio', { name: 'All' }))
    expect(screen.getByTestId('board-calendar')).toHaveAttribute('data-mode', 'all')
    expect(screen.getByRole('radio', { name: 'All' })).toHaveAttribute('aria-checked', 'true')
    expect(storedMode()).toBe('all')
    // One row and no days: no Earlier, no seams, nothing dated.
    expect(dayRowKeys()).toEqual([])
    expect(screen.queryByTestId('calendar-row-earlier')).toBeNull()
    expect(screen.queryByTestId('calendar-row-gap')).toBeNull()
    const row = screen.getByTestId('calendar-row-all')
    expect(row).toHaveTextContent('5 tasks')
    expect(row).toHaveTextContent('newest first')
    expect(screen.getByTestId('board-calendar-toolbar')).toHaveTextContent('All tasks')
    // Every card is in the one row, history included.
    for (const [col, title] of [
      ['todo', 'Fresh idea'],
      ['todo', 'Old chore'],
      ['backlog', 'Parked plan'],
      ['in_progress', 'Working now'],
      ['done', 'Shipped long ago'],
    ]) {
      expect(
        within(screen.getByTestId(`calendar-cell-${col}-all`)).getByText(title!),
      ).toBeInTheDocument()
    }
    // The same columns as a week, with their heads and counts.
    for (const id of ['needs-you', 'backlog', 'todo', 'in_progress', 'done', 'cancelled']) {
      expect(screen.getByTestId(`board-column-${id}`)).toBeInTheDocument()
    }
    expect(screen.getByTestId('board-column-todo')).toHaveAccessibleName('To do, 2 tasks')
    expect(columnHead('todo')).toHaveTextContent(/^To do2$/)
  })

  it('stacks the cards in a cell newest first, as calendar chips', async () => {
    const now = Date.now()
    const titles = ['Newest', 'Middle', 'Oldest'] as const
    serve([
      { id: 'o', title: 'Oldest', status: 'todo', createdAt: addDays(now, -30) + HOUR },
      { id: 'n', title: 'Newest', status: 'todo', createdAt: earlierToday() },
      { id: 'm', title: 'Middle', status: 'todo', createdAt: addDays(now, -3) + HOUR },
    ])
    const user = userEvent.setup()
    renderBoard()
    await screen.findByTestId('board-calendar')
    await user.click(screen.getByRole('radio', { name: 'All' }))

    const cell = screen.getByTestId('calendar-cell-todo-all')
    expect(titlesIn(cell, titles)).toEqual(['Newest', 'Middle', 'Oldest'])
    for (const card of within(cell).getAllByTestId('board-card')) {
      expect(card).toHaveClass('calendar-chip')
    }
    // No cap: a single row has the room to show everything.
    expect(within(cell).queryByRole('button', { name: /more$/ })).toBeNull()
  })

  it('stamps a card from today with its time and an older one with its date', async () => {
    const today = earlierToday()
    const older = addDays(Date.now(), -12) + 9 * HOUR + 30 * 60_000
    serve([
      { id: 'a', title: 'Added today', status: 'todo', createdAt: today },
      { id: 'b', title: 'Added before', status: 'todo', createdAt: older },
    ])
    const user = userEvent.setup()
    renderBoard()
    await screen.findByTestId('board-calendar')
    await user.click(screen.getByRole('radio', { name: 'All' }))

    const stampOf = (title: string) => within(cardFor(title)).getByTestId('board-card-stamp')
    expect(stampOf('Added today').textContent).toMatch(
      new RegExp(`^${escapeRe(timeLabel(today))},`),
    )
    expect(stampOf('Added before').textContent).toMatch(
      new RegExp(`^${escapeRe(dayMonth(older))},`),
    )
    // The weekday and time ride in the stamp's title either way.
    expect(stampOf('Added before')).toHaveAttribute(
      'title',
      `Added ${shortDate(older)} at ${timeLabel(older)}`,
    )
    expect(stampOf('Added today')).toHaveAttribute(
      'title',
      `Added ${shortDate(today)} at ${timeLabel(today)}`,
    )
  })

  it('keeps Needs you in its one row, where a past week folds it to a rail', async () => {
    const old = startOfDay(Date.now()) - 20 * DAY
    serve([
      { id: 'f1', title: 'Broken run', status: 'blocked', createdAt: old, updatedAt: old },
      { id: 't1', title: 'Any task', status: 'todo', createdAt: earlierToday() },
    ])
    const user = userEvent.setup()
    renderBoard()
    await screen.findByTestId('board-calendar')
    // A week without today has no row for Needs you, so it folds to a rail.
    await user.click(screen.getByRole('button', { name: /^Previous week/ }))
    expect(screen.getByTestId('board-needs-you-rail')).toBeInTheDocument()
    expect(screen.queryByTestId('calendar-needs-you-today')).toBeNull()

    await user.click(screen.getByRole('radio', { name: 'All' }))
    expect(screen.queryByTestId('board-needs-you-rail')).toBeNull()
    const home = screen.getByTestId('calendar-needs-you-today')
    expect(home).toHaveAccessibleName('Needs you: 1 item')
    expect(within(home).getByText('Broken run')).toBeInTheDocument()
    // The column is the All row's, not today's, so its head says nothing of today.
    expect(columnHead('needs-you')).not.toHaveTextContent('Today')
    expect(columnHead('needs-you')).toHaveTextContent(/^Needs you1$/)
    // What waits on a person is not a card in a status column.
    expect(screen.getByTestId('calendar-row-all')).toHaveTextContent('1 task')
    for (const id of ['backlog', 'todo', 'in_progress', 'done']) {
      expect(within(screen.getByTestId(`board-column-${id}`)).queryByText('Broken run')).toBeNull()
    }
  })

  it('draws no routine runs, and has no Routines switch', async () => {
    serve([{ id: 't1', title: 'Any task', status: 'todo', createdAt: earlierToday() }], 2)
    const user = userEvent.setup()
    renderBoard()
    // A week draws today's runs in To do.
    expect(await screen.findByTestId('calendar-routine-run')).toBeInTheDocument()
    expect(screen.getByTestId('board-routines-toggle')).toBeInTheDocument()

    await user.click(screen.getByRole('radio', { name: 'All' }))
    expect(screen.queryByTestId('calendar-routine-run')).toBeNull()
    expect(screen.queryByTestId('board-routines-toggle')).toBeNull()
    expect(
      within(screen.getByTestId('calendar-cell-todo-all')).getByText('Any task'),
    ).toBeInTheDocument()
  })

  it('reads no routine runs when the board opens on it', async () => {
    window.localStorage.setItem(PREFS_KEY, JSON.stringify({ mode: 'all' }))
    const board = serve(
      [{ id: 't1', title: 'Any task', status: 'todo', createdAt: earlierToday() }],
      2,
    )
    renderBoard()
    await screen.findByTestId('calendar-row-all')
    expect(await screen.findByText('Any task')).toBeInTheDocument()
    expect(screen.queryByTestId('calendar-routine-run')).toBeNull()
    expect(board.runReads()).toBe(0)
  })

  it('shows no task count in the header, leaving it to the column heads and the gutter', async () => {
    serve([
      { id: 't1', title: 'One task', status: 'todo', createdAt: earlierToday() },
      { id: 't2', title: 'Two task', status: 'todo', createdAt: earlierToday() - 1000 },
      { id: 't3', title: 'Three task', status: 'backlog', createdAt: earlierToday() },
    ])
    const user = userEvent.setup()
    renderBoard()
    await screen.findByTestId('board-calendar')
    await user.click(screen.getByRole('radio', { name: 'All' }))

    expect(panelHeader().textContent).not.toMatch(/\d+ tasks?/)
    expect(screen.getByTestId('board-calendar-toolbar').textContent).not.toMatch(/\d+ tasks?/)
    expect(screen.getByTestId('board-column-todo')).toHaveAccessibleName('To do, 2 tasks')
    expect(screen.getByTestId('board-column-backlog')).toHaveAccessibleName('Backlog, 1 task')
    expect(screen.getByTestId('calendar-row-all')).toHaveTextContent('3 tasks')
  })

  it('folds Cancelled into a rail that opens into the row and folds again', async () => {
    const at = earlierToday()
    const long = addDays(Date.now(), -30) + HOUR
    serve([
      { id: 't1', title: 'Any task', status: 'todo', createdAt: at },
      { id: 'c1', title: 'Dropped idea', status: 'cancelled', createdAt: long, completedAt: at },
      {
        id: 'c2',
        title: 'Dropped long ago',
        status: 'cancelled',
        createdAt: long,
        completedAt: long,
      },
    ])
    const user = userEvent.setup()
    renderBoard()
    await screen.findByTestId('board-calendar')
    await user.click(screen.getByRole('radio', { name: 'All' }))

    const rail = screen.getByTestId('board-cancelled-rail')
    expect(rail).toHaveAccessibleName('Cancelled, 2 tasks. Show the column.')
    expect(screen.queryByText('Dropped idea')).toBeNull()
    // Folded, its cards are not on screen, so the gutter does not count them.
    expect(screen.getByTestId('calendar-row-all')).toHaveTextContent('1 task')

    await user.click(rail)
    const cell = await screen.findByTestId('calendar-cell-cancelled-all')
    expect(titlesIn(cell, ['Dropped idea', 'Dropped long ago'])).toEqual([
      'Dropped idea',
      'Dropped long ago',
    ])
    expect(screen.queryByTestId('board-cancelled-rail')).toBeNull()
    expect(screen.getByTestId('calendar-row-all')).toHaveTextContent('3 tasks')
    expect(JSON.parse(window.localStorage.getItem(PREFS_KEY)!)).toMatchObject({
      mode: 'all',
      cancelledOpen: true,
    })

    const fold = screen.getByRole('button', { name: 'Fold the Cancelled column' })
    await waitFor(() => expect(fold).toHaveFocus())
    await user.click(fold)
    expect(screen.getByTestId('board-cancelled-rail')).toBeInTheDocument()
    expect(screen.queryByText('Dropped idea')).toBeNull()
  })
})
