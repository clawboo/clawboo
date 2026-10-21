// The Board's calendar, rendered through the real BoardPanel against msw: cards on
// the day they were added or finished, upcoming routine runs in To do on their
// days, the Earlier row, range navigation, the Month and All views, the keyboard,
// cell overflow, where a dragged card lands, and an axe sweep.
//
// Fixtures are built from "now" and the same range math the panel uses, so the
// suite holds on any day of the week and in any time zone.

import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { http, HttpResponse } from 'msw'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { ScheduleRecord } from '@clawboo/scheduler'

import { ThemeProvider } from '@/features/theme/ThemeProvider'
import { useTeamStore } from '@/stores/team'
import { useToastStore } from '@/stores/toast'

import { axe } from '../../../../__vitest__/axe'
import { server } from '../../../../__vitest__/mswServer'
import { BoardPanel } from '../../BoardPanel'
import { FinishPromptDialog } from '../../FinishPromptDialog'
import {
  addDays,
  buildRange,
  dayKey,
  isSameDay,
  localeWeekStart,
  rangeBounds,
  startOfDay,
} from '../calendarModel'
import { resetBoardStorage } from '../../__tests__/resetBoardStorage'

const dnd = vi.hoisted(() => ({
  onDragStart: undefined as undefined | ((e: unknown) => void),
  onDragOver: undefined as undefined | ((e: unknown) => void),
  onDragEnd: undefined as undefined | ((e: unknown) => void),
}))
vi.mock('@dnd-kit/core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@dnd-kit/core')>()
  return {
    ...actual,
    DndContext: (props: React.ComponentProps<typeof actual.DndContext>) => {
      dnd.onDragStart = props.onDragStart as (e: unknown) => void
      dnd.onDragOver = props.onDragOver as (e: unknown) => void
      dnd.onDragEnd = props.onDragEnd as (e: unknown) => void
      return <actual.DndContext {...props} />
    },
  }
})

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

/** Serve the board, and one routine run on the first window still ahead. */
function serve(
  tasks: unknown[],
  opts: { runs?: boolean; runsPerDay?: number } = {},
): { runDayKey: () => string | null } {
  let runDay: string | null = null
  server.use(
    http.get('/api/board', () => HttpResponse.json({ tasks })),
    http.get('/api/schedules/occurrences', ({ request }) => {
      if (opts.runs === false) return HttpResponse.json({ now: Date.now(), routines: [] })
      const bounds = (new URL(request.url).searchParams.get('bounds') ?? '').split(',').map(Number)
      const now = Date.now()
      const windows = bounds.slice(0, -1).map((start, i) => {
        const end = bounds[i + 1]!
        const t = Math.max(start + 9 * HOUR, now + 60_000)
        if (runDay !== null || t >= end) return { count: 0, more: false, times: [] }
        runDay = dayKey(start)
        const n = opts.runsPerDay ?? 1
        return {
          count: n,
          more: false,
          times: Array.from({ length: Math.min(n, 8) }, (_, k) => t + k * 60_000),
        }
      })
      const routine = { ...ROUTINE, nextRunAt: windows.find((w) => w.count)?.times[0] ?? null }
      runDay = runDay ?? null
      return HttpResponse.json({
        now,
        routines: windows.some((w) => w.count) ? [{ schedule: routine, windows }] : [],
      })
    }),
    http.get('/api/teams', () =>
      HttpResponse.json({ teams: [{ id: 'team-1', name: 'Alpha', icon: 'A' }] }),
    ),
    http.get('/api/schedules', () =>
      HttpResponse.json({
        schedules: [ROUTINE],
        sources: [{ sourceId: 'clawboo-routine', ok: true, degraded: false, at: 1 }],
      }),
    ),
    http.get('/api/schedules/:id/runs', () => HttpResponse.json({ runs: [] })),
  )
  return { runDayKey: () => runDay }
}

beforeEach(() => {
  useTeamStore.setState({ teams: [], selectedTeamId: null })
  useToastStore.setState({ toasts: [] })
  resetBoardStorage()
})
afterEach(() => cleanup())

describe('the calendar board', () => {
  it('opens on this week, with today marked and open work on the day it was added', async () => {
    const added = earlierToday()
    serve([
      {
        id: 't1',
        title: 'Draft the launch note',
        status: 'todo',
        createdAt: added,
        updatedAt: added,
      },
    ])
    render(<BoardPanel />)

    const grid = await screen.findByTestId('board-calendar')
    expect(grid).toHaveAttribute('data-mode', 'week')
    const today = dayKey(Date.now())
    const todayHeader = within(grid).getByTestId(`calendar-day-${today}`)
    expect(todayHeader).toHaveAttribute('data-today', 'true')
    // A screen reader hears the day in each cell's own name, today's included.
    expect(
      within(grid).getByRole('group', { name: /^To do on .+, today: 1 task/ }),
    ).toBeInTheDocument()
    expect(screen.getByText('This week')).toBeInTheDocument()

    const cell = within(grid).getByTestId(`calendar-cell-todo-${today}`)
    expect(within(cell).getByText('Draft the launch note')).toBeInTheDocument()
    // The card is stamped with when it was added.
    expect(within(cell).getByTestId('board-card-stamp')).toHaveAttribute(
      'title',
      expect.stringMatching(/^Added /),
    )
  })

  it('keeps a card on its added day when it moves on, and puts finished work on its finishing day', async () => {
    const week = thisWeek()
    const firstDay = week.days[0]!
    const added = firstDay + 10 * HOUR
    const finished = earlierToday()
    serve([
      {
        id: 'a',
        title: 'Started work',
        status: 'in_progress',
        createdAt: added,
        updatedAt: finished,
      },
      {
        id: 'b',
        title: 'Shipped work',
        status: 'done',
        createdAt: added,
        updatedAt: finished,
        completedAt: finished,
      },
    ])
    render(<BoardPanel />)
    const grid = await screen.findByTestId('board-calendar')
    const addedKey = dayKey(added)
    expect(
      within(within(grid).getByTestId(`calendar-cell-in_progress-${addedKey}`)).getByText(
        'Started work',
      ),
    ).toBeInTheDocument()
    expect(
      within(within(grid).getByTestId(`calendar-cell-done-${dayKey(finished)}`)).getByText(
        'Shipped work',
      ),
    ).toBeInTheDocument()
  })

  it('collects open work from before the range in an Earlier row, and leaves old finished work out', async () => {
    const old = startOfDay(Date.now()) - 40 * 24 * HOUR
    serve([
      { id: 'o1', title: 'Old backlog idea', status: 'backlog', createdAt: old, updatedAt: old },
      {
        id: 'o2',
        title: 'Old shipped thing',
        status: 'done',
        createdAt: old,
        updatedAt: old,
        completedAt: old,
      },
    ])
    const user = userEvent.setup()
    render(<BoardPanel />)
    const grid = await screen.findByTestId('board-calendar')
    const row = within(grid).getByTestId('calendar-row-earlier')
    // Only parked work: the row stays folded and says what it holds.
    const toggle = within(row).getByRole('button', { name: /^Earlier: / })
    expect(toggle).toHaveAttribute('aria-expanded', 'false')
    expect(within(row).getByText('1 parked')).toBeInTheDocument()
    expect(screen.queryByText('Old backlog idea')).toBeNull()
    expect(screen.queryByText('Old shipped thing')).toBeNull()

    // It opens, and the choice holds when the board is opened again.
    await user.click(toggle)
    expect(
      within(within(grid).getByTestId('calendar-cell-backlog-earlier')).getByText(
        'Old backlog idea',
      ),
    ).toBeInTheDocument()
    cleanup()
    render(<BoardPanel />)
    expect(await screen.findByText('Old backlog idea')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: /^Earlier: / }))
    expect(screen.queryByText('Old backlog idea')).toBeNull()
  })

  it('opens Earlier by itself when it holds work that is running or waiting to start', async () => {
    const old = startOfDay(Date.now()) - 9 * 24 * HOUR
    serve([
      { id: 'o1', title: 'Old backlog idea', status: 'backlog', createdAt: old },
      { id: 'o2', title: 'Still to do', status: 'todo', createdAt: old },
      { id: 'o3', title: 'Still going', status: 'in_progress', createdAt: old },
    ])
    render(<BoardPanel />)
    const row = await screen.findByTestId('calendar-row-earlier')
    expect(within(row).getByRole('button', { name: /^Earlier: / })).toHaveAttribute(
      'aria-expanded',
      'true',
    )
    // Furthest along first.
    expect(
      within(row)
        .getAllByTestId('calendar-earlier-part')
        .map((p) => p.textContent),
    ).toEqual(['1 running', '1 to do', '1 parked'])
    expect(screen.getByText('Still going')).toBeInTheDocument()
  })

  it('keeps Earlier open after the person moves its last waiting card to Backlog', async () => {
    const old = startOfDay(Date.now()) - 9 * 24 * HOUR
    serve(
      [
        { id: 'o1', title: 'Old backlog idea', status: 'backlog', createdAt: old },
        { id: 'o2', title: 'Still to do', status: 'todo', createdAt: old },
      ],
      { runs: false },
    )
    server.use(
      http.patch('/api/board/o2', () =>
        HttpResponse.json({ ok: true, task: { id: 'o2', status: 'backlog' } }),
      ),
    )
    render(<BoardPanel />)
    const toggle = () =>
      within(screen.getByTestId('calendar-row-earlier')).getByRole('button', {
        name: /^Earlier: /,
      })
    await screen.findByText('Still to do')
    expect(toggle()).toHaveAttribute('aria-expanded', 'true')
    await act(async () => {
      dnd.onDragEnd?.({ active: { id: 'o2' }, over: { id: 'backlog' } })
    })
    // Everything in it is parked now, which would fold it by itself; the person
    // just set the card down there, so it stays in sight.
    await waitFor(() =>
      expect(screen.getByTestId('calendar-cell-backlog-earlier')).toHaveTextContent('Still to do'),
    )
    expect(toggle()).toHaveAttribute('aria-expanded', 'true')
  })

  it('draws an upcoming routine run in To do on its day, tagged as a routine', async () => {
    const { runDayKey } = serve([
      { id: 't1', title: 'Any task', status: 'todo', createdAt: earlierToday() },
    ])
    render(<BoardPanel />)
    const strip = await screen.findByTestId('calendar-routine-run')
    const key = runDayKey()
    expect(key).not.toBeNull()
    expect(screen.getByTestId(`calendar-cell-todo-${key}`)).toContainElement(strip)
    // A projection, drawn as a hatched outline; its name says what it is.
    expect(strip).toHaveClass('calendar-run')
    expect(strip).toHaveAttribute('aria-expanded', 'false')
    expect(within(strip).getByText('Morning digest')).toBeInTheDocument()
    expect(strip).toHaveAccessibleName(
      /^Routine, Morning digest, next run, .*Upcoming\. It posts to the team chat when it runs\.$/,
    )
    // It is a projection, not a card: it cannot be dragged.
    expect(within(strip).queryByRole('button', { name: /Drag to move/ })).toBeNull()
  })

  it('opens a routine run’s details, and from there the routine itself', async () => {
    serve([{ id: 't1', title: 'Any task', status: 'todo', createdAt: earlierToday() }])
    const user = userEvent.setup()
    render(<BoardPanel />)
    await user.click(await screen.findByTestId('calendar-routine-run'))

    const popover = await screen.findByTestId('calendar-routine-popover')
    expect(within(popover).getByText('Morning digest')).toBeInTheDocument()
    expect(within(popover).getByText(/^Weekdays at /)).toBeInTheDocument()
    expect(within(popover).getByText('Alpha team chat · Boo Zero leads')).toBeInTheDocument()
    expect(
      within(popover).getByText(
        'When it runs, it posts to the Alpha team chat, and Boo Zero takes it from there.',
      ),
    ).toBeInTheDocument()

    await user.click(within(popover).getByRole('button', { name: 'Open routine' }))
    expect(await screen.findByRole('dialog', { name: /Morning digest/ })).toBeInTheDocument()
    expect(screen.queryByTestId('calendar-routine-popover')).toBeNull()
  })

  it('closes a run’s popover with Escape', async () => {
    serve([{ id: 't1', title: 'Any task', status: 'todo', createdAt: earlierToday() }])
    const user = userEvent.setup()
    render(<BoardPanel />)
    await user.click(await screen.findByTestId('calendar-routine-run'))
    await screen.findByTestId('calendar-routine-popover')
    await user.keyboard('{Escape}')
    await waitFor(() => expect(screen.queryByTestId('calendar-routine-popover')).toBeNull())
  })

  it('collapses many runs in a day into one strip with a count', async () => {
    serve([{ id: 't1', title: 'Any task', status: 'todo', createdAt: earlierToday() }], {
      runsPerDay: 24,
    })
    render(<BoardPanel />)
    const strip = await screen.findByTestId('calendar-routine-run')
    expect(within(strip).getByText('24 runs')).toBeInTheDocument()
  })

  it('hides and shows routine runs with the Routines switch, and remembers the choice', async () => {
    serve([{ id: 't1', title: 'Any task', status: 'todo', createdAt: earlierToday() }])
    const user = userEvent.setup()
    render(<BoardPanel />)
    await screen.findByTestId('calendar-routine-run')
    const toggle = screen.getByTestId('board-routines-toggle')
    expect(toggle).toHaveAttribute('aria-pressed', 'true')
    await user.click(toggle)
    expect(screen.queryByTestId('calendar-routine-run')).toBeNull()
    expect(JSON.parse(window.localStorage.getItem('clawboo.board.calendar')!)).toMatchObject({
      showRoutines: false,
    })
  })

  it('pages to the next week and back to today', async () => {
    const added = earlierToday()
    serve([{ id: 't1', title: 'Today’s task', status: 'todo', createdAt: added }], { runs: false })
    const user = userEvent.setup()
    render(<BoardPanel />)
    const before = await screen.findByTestId('board-range-title')
    const title = before.textContent

    await user.click(screen.getByRole('button', { name: /^Next week/ }))
    expect(screen.getByTestId('board-range-title').textContent).not.toBe(title)
    expect(screen.getByText('Next week')).toBeInTheDocument()
    // Today's open task is still in play, so it rides in Earlier on a later week.
    expect(screen.getByTestId('calendar-cell-todo-earlier')).toHaveTextContent('Today’s task')
    expect(screen.getByTestId('board-calendar-announcer')).toHaveTextContent(/^Next week, /)

    await user.click(screen.getByRole('button', { name: 'Go to today' }))
    expect(screen.getByTestId('board-range-title').textContent).toBe(title)
  })

  it('switches to Month and to the undated All view, and remembers the view', async () => {
    serve([{ id: 't1', title: 'Any task', status: 'todo', createdAt: earlierToday() }], {
      runs: false,
    })
    const user = userEvent.setup()
    render(<BoardPanel />)
    await screen.findByTestId('board-calendar')

    await user.click(screen.getByRole('radio', { name: 'Month' }))
    expect(screen.getByTestId('board-calendar')).toHaveAttribute('data-mode', 'month')
    expect(screen.getByText('This month')).toBeInTheDocument()

    // All is the same board with one row instead of days.
    await user.click(screen.getByRole('radio', { name: 'All' }))
    expect(screen.getByTestId('board-calendar')).toHaveAttribute('data-mode', 'all')
    expect(screen.getByText('All tasks')).toBeInTheDocument()
    expect(
      within(screen.getByTestId('calendar-cell-todo-all')).getByText('Any task'),
    ).toBeInTheDocument()
    expect(screen.getByTestId('board-card')).toHaveClass('calendar-chip')
    expect(JSON.parse(window.localStorage.getItem('clawboo.board.calendar')!)).toMatchObject({
      mode: 'all',
    })
  })

  it('answers the keyboard: M month, W week, the arrows page, T today', async () => {
    serve([{ id: 't1', title: 'Any task', status: 'todo', createdAt: earlierToday() }], {
      runs: false,
    })
    const user = userEvent.setup()
    render(<BoardPanel />)
    await screen.findByTestId('board-calendar')
    const title = screen.getByTestId('board-range-title').textContent
    // The keys belong to the board while it has focus.
    screen.getByTestId('board-range-title').focus()

    await user.keyboard('m')
    expect(screen.getByTestId('board-calendar')).toHaveAttribute('data-mode', 'month')
    await user.keyboard('w')
    expect(screen.getByTestId('board-calendar')).toHaveAttribute('data-mode', 'week')
    await user.keyboard('{ArrowRight}')
    expect(screen.getByTestId('board-range-title').textContent).not.toBe(title)
    await user.keyboard('t')
    expect(screen.getByTestId('board-range-title').textContent).toBe(title)
  })

  it('leaves the keys alone when focus is somewhere else', async () => {
    serve([{ id: 't1', title: 'Any task', status: 'todo', createdAt: earlierToday() }], {
      runs: false,
    })
    const user = userEvent.setup()
    render(
      <>
        <button type="button">Elsewhere</button>
        <BoardPanel />
      </>,
    )
    await screen.findByTestId('board-calendar')
    screen.getByRole('button', { name: 'Elsewhere' }).focus()
    await user.keyboard('m')
    expect(screen.getByTestId('board-calendar')).toHaveAttribute('data-mode', 'week')
  })

  it('ignores the shortcuts while a dialog is open', async () => {
    serve([{ id: 't1', title: 'Any task', status: 'todo', createdAt: earlierToday() }], {
      runs: false,
    })
    const user = userEvent.setup()
    render(<BoardPanel />)
    await screen.findByTestId('board-calendar')
    await user.click(screen.getByTestId('board-range-title'))
    await screen.findByTestId('calendar-mini-month')
    await user.keyboard('m')
    expect(screen.getByTestId('board-calendar')).toHaveAttribute('data-mode', 'week')
  })

  it('jumps to the week of a day picked in the date picker', async () => {
    serve([{ id: 't1', title: 'Any task', status: 'todo', createdAt: earlierToday() }], {
      runs: false,
    })
    const user = userEvent.setup()
    render(<BoardPanel />)
    await screen.findByTestId('board-calendar')
    await user.click(screen.getByTestId('board-range-title'))
    const picker = await screen.findByTestId('calendar-mini-month')
    const target = addDays(Date.now(), 14)
    // The picker opens on this month; step forward when the target is in the next.
    if (new Date(target).getMonth() !== new Date().getMonth()) {
      await user.click(within(picker).getByRole('button', { name: 'Next month' }))
    }
    await user.click(
      within(picker).getByRole('button', {
        name: new RegExp(
          `^${new Date(target).toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' })}`,
        ),
      }),
    )
    expect(screen.queryByTestId('calendar-mini-month')).toBeNull()
    expect(screen.getByTestId(`calendar-day-${dayKey(target)}`)).toBeInTheDocument()
    // A picked date lights its row.
    expect(screen.getByTestId(`calendar-day-${dayKey(target)}`)).toHaveAttribute(
      'data-selected',
      'true',
    )
    expect(screen.getByTestId(`calendar-cell-todo-${dayKey(target)}`)).toHaveAttribute(
      'data-selected',
      'true',
    )
  })

  it('lights a day’s row only when its date is picked, and puts it out again', async () => {
    serve([{ id: 't1', title: 'Any task', status: 'todo', createdAt: earlierToday() }], {
      runs: false,
    })
    const user = userEvent.setup()
    render(<BoardPanel />)
    const grid = await screen.findByTestId('board-calendar')
    const today = dayKey(Date.now())
    // The columns lead: no row is lit to begin with, today's included.
    expect(grid.querySelector('[data-selected]')).toBeNull()

    const date = within(grid).getByRole('button', { name: /^Highlight .+, today$/ })
    expect(date).toHaveAttribute('aria-pressed', 'false')
    await user.click(date)
    expect(date).toHaveAttribute('aria-pressed', 'true')
    expect(within(grid).getByTestId(`calendar-day-${today}`)).toHaveAttribute(
      'data-selected',
      'true',
    )
    expect(within(grid).getByTestId(`calendar-cell-done-${today}`)).toHaveAttribute(
      'data-selected',
      'true',
    )

    // Pressing the date again puts it out.
    await user.click(date)
    expect(date).toHaveAttribute('aria-pressed', 'false')
    expect(grid.querySelector('[data-selected]')).toBeNull()

    // So does Escape.
    await user.click(date)
    await user.keyboard('{Escape}')
    expect(date).toHaveAttribute('aria-pressed', 'false')

    // And paging away from it: coming back finds it out.
    await user.click(date)
    await user.click(screen.getByRole('button', { name: /^Next week/ }))
    await user.click(screen.getByRole('button', { name: 'Go to today' }))
    expect(screen.getByTestId('board-calendar').querySelector('[data-selected]')).toBeNull()
  })

  it('shows three cards in a cell, then the rest on request', async () => {
    const added = earlierToday()
    serve(
      Array.from({ length: 5 }, (_, i) => ({
        id: `t${i}`,
        title: `Task ${i}`,
        status: 'todo',
        createdAt: added + i,
      })),
      { runs: false },
    )
    const user = userEvent.setup()
    render(<BoardPanel />)
    const cell = await screen.findByTestId(`calendar-cell-todo-${dayKey(Date.now())}`)
    expect(within(cell).getAllByTestId('board-card')).toHaveLength(3)
    // The newest stay in sight; the earliest wait behind "+2 more".
    expect(within(cell).getByText('Task 4')).toBeInTheDocument()
    expect(within(cell).queryByText('Task 0')).toBeNull()
    await user.click(within(cell).getByRole('button', { name: '+2 more' }))
    expect(within(cell).getAllByTestId('board-card')).toHaveLength(5)
    await user.click(within(cell).getByRole('button', { name: 'Show less' }))
    expect(within(cell).getAllByTestId('board-card')).toHaveLength(3)
  })

  it('folds Cancelled into a rail that keeps its count, and opens it', async () => {
    const at = earlierToday()
    serve(
      [{ id: 'c1', title: 'Dropped idea', status: 'cancelled', createdAt: at, completedAt: at }],
      { runs: false },
    )
    const user = userEvent.setup()
    render(<BoardPanel />)
    const rail = await screen.findByTestId('board-cancelled-rail')
    expect(rail).toHaveAccessibleName('Cancelled, 1 task. Show the column.')
    expect(screen.queryByText('Dropped idea')).toBeNull()
    rail.focus()
    await user.keyboard('{Enter}')
    expect(await screen.findByText('Dropped idea')).toBeInTheDocument()
    // The button pressed is gone; focus moves to the one that folds it again.
    const fold = screen.getByRole('button', { name: 'Fold the Cancelled column' })
    await waitFor(() => expect(fold).toHaveFocus())
    await user.keyboard('{Enter}')
    await waitFor(() => expect(screen.getByTestId('board-cancelled-rail')).toHaveFocus())
  })

  it('shows where a dragged card will land: its own row, or today for finished work', async () => {
    // A card added on another day asks which day it finished, so its outline says so.
    const week = thisWeek()
    const added = Math.min(week.days[0]! + 10 * HOUR, Date.now() - 1000)
    serve(
      [
        {
          id: 'a',
          title: 'Work in hand',
          status: 'in_progress',
          createdAt: added,
          updatedAt: added,
          // Bound to an agent, so back in To do it waits there for that agent.
          sourceDelegationId: 'd1:agent:ada:reflectTo:lead',
        },
      ],
      { runs: false },
    )
    render(
      <ThemeProvider>
        <BoardPanel />
      </ThemeProvider>,
    )
    await screen.findByTestId('board-calendar')
    await act(async () => {
      dnd.onDragStart?.({ active: { id: 'a' } })
    })
    await act(async () => {
      dnd.onDragOver?.({ over: { id: 'done' } })
    })
    expect(
      within(screen.getByTestId(`calendar-cell-done-${dayKey(Date.now())}`)).getByTestId(
        'calendar-landing',
      ),
    ).toHaveTextContent(isSameDay(added, Date.now()) ? 'Done today' : 'Done, pick the day')
    await act(async () => {
      dnd.onDragOver?.({ over: { id: 'todo' } })
    })
    expect(
      within(screen.getByTestId(`calendar-cell-todo-${dayKey(added)}`)).getByTestId(
        'calendar-landing',
      ),
    ).toHaveTextContent('Moves here')
  })

  it('says where finished work went when it lands outside the shown week', async () => {
    const lastWeekDay = addDays(thisWeek().start, -3) + 10 * HOUR
    serve(
      [
        {
          id: 'a',
          title: 'Old work',
          status: 'in_progress',
          createdAt: lastWeekDay,
          updatedAt: lastWeekDay,
        },
      ],
      { runs: false },
    )
    server.use(
      http.patch('/api/board/a', () =>
        HttpResponse.json({ ok: true, task: { id: 'a', status: 'done' } }),
      ),
    )
    const user = userEvent.setup()
    render(
      <>
        <BoardPanel />
        <FinishPromptDialog />
      </>,
    )
    await screen.findByTestId('board-calendar')
    await user.click(screen.getByRole('button', { name: /^Previous week/ }))
    await screen.findByText('Old work')
    await act(async () => {
      dnd.onDragEnd?.({ active: { id: 'a' }, over: { id: 'done' } })
    })
    // It sits on a day last week, so the person picks the day; Today is the default.
    const prompt = await screen.findByTestId('finish-prompt')
    expect(within(prompt).getByTestId('finish-day-today')).toHaveAttribute('aria-checked', 'true')
    await user.click(within(prompt).getByTestId('finish-ok'))
    // One message, with the way to where it went, which this week does not show.
    await waitFor(() =>
      expect(useToastStore.getState().toasts.map((t) => t.message)).toEqual(['Marked done.']),
    )
    const toast = useToastStore.getState().toasts[0]!
    expect(toast.action?.label).toBe('Show')
  })

  it('puts Needs you in today’s row, and leads back to it from another week', async () => {
    const old = startOfDay(Date.now()) - 20 * 24 * HOUR
    serve([{ id: 'f1', title: 'Broken run', status: 'blocked', createdAt: old, updatedAt: old }], {
      runs: false,
    })
    const user = userEvent.setup()
    render(<BoardPanel />)
    await screen.findByTestId('board-calendar')
    const today = screen.getByTestId('calendar-needs-you-today')
    expect(today).toHaveAccessibleName('Needs you today: 1 item')
    expect(within(today).getByText('Broken run')).toBeInTheDocument()
    // It waits now, so it sits in today's row, not in a row of its own day.
    expect(screen.queryByTestId('calendar-cell-backlog-earlier')).toBeNull()

    await user.click(screen.getByRole('button', { name: /^Next week/ }))
    expect(screen.queryByTestId('calendar-needs-you-today')).toBeNull()
    // The toolbar offers the way back, and so does the folded column.
    expect(screen.getByTestId('board-needs-you-chip')).not.toHaveAttribute('aria-hidden')
    const rail = screen.getByTestId('board-needs-you-rail')
    expect(rail).toHaveAccessibleName('Needs you, 1 item. Go to today.')
    await user.click(rail)
    const back = await screen.findByTestId('calendar-needs-you-today')
    expect(within(back).getByText('Broken run')).toBeInTheDocument()
    await waitFor(() => expect(back).toHaveFocus())
  })

  it('follows today into the next week when the board is left open past midnight', async () => {
    // Only the clock and the polling interval are faked: msw and React keep their
    // real timers.
    vi.useFakeTimers({ toFake: ['Date', 'setInterval', 'clearInterval'] })
    try {
      const week = thisWeek()
      // One second before the last midnight of this week.
      vi.setSystemTime(week.end - 1000)
      serve([], { runs: false })
      server.use(
        http.get('/api/board', () =>
          HttpResponse.json({
            tasks: [{ id: 't1', title: 'Any task', status: 'todo', createdAt: week.end - 60_000 }],
          }),
        ),
      )
      render(<BoardPanel />)
      await screen.findByTestId('board-calendar')
      expect(screen.getByTestId(`calendar-day-${dayKey(week.end - 1000)}`)).toBeInTheDocument()

      vi.setSystemTime(week.end + 5000)
      await act(async () => {
        vi.advanceTimersByTime(31_000)
      })
      await waitFor(() =>
        expect(screen.getByTestId(`calendar-day-${dayKey(week.end)}`)).toHaveAttribute(
          'data-today',
          'true',
        ),
      )
      expect(screen.getByText('This week')).toBeInTheDocument()
    } finally {
      vi.useRealTimers()
    }
  })

  it('has no axe violations in the week view', async () => {
    serve([
      { id: 't1', title: 'A task', status: 'todo', createdAt: earlierToday() },
      {
        id: 't2',
        title: 'Done task',
        status: 'done',
        createdAt: earlierToday(),
        completedAt: earlierToday(),
      },
    ])
    const { container } = render(<BoardPanel />)
    await screen.findByTestId('calendar-routine-run')
    expect(await axe(container)).toHaveNoViolations()
  })

  it('asks for the routine runs of exactly the days on screen', async () => {
    let asked: number[] = []
    serve([{ id: 't1', title: 'Any task', status: 'todo', createdAt: earlierToday() }])
    server.use(
      http.get('/api/schedules/occurrences', ({ request }) => {
        asked = (new URL(request.url).searchParams.get('bounds') ?? '').split(',').map(Number)
        return HttpResponse.json({ now: Date.now(), routines: [] })
      }),
    )
    render(<BoardPanel />)
    await screen.findByTestId('board-calendar')
    await waitFor(() => expect(asked).toEqual(rangeBounds(thisWeek())))
  })
})
