// The calendar's card faces, rendered through the real BoardPanel against msw:
// the stamp a running task shows and how it ticks with the calendar clock, the
// stamp of one that is not running, finished work from a day gone by kept to one
// line, the order of a cell that holds both a task and a routine run, and which
// run strips are drawn in full and which on one line.
//
// Fixtures are built from "now" and the same range math the panel uses, so the
// suite holds on any day of the week and in any time zone. The routine tests set
// the clock to a Wednesday noon, so the days either side of today are always in
// the week on screen, whichever weekday the locale starts it on.

import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { http, HttpResponse } from 'msw'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { ScheduleRecord } from '@clawboo/scheduler'

import { ThemeProvider } from '@/features/theme/ThemeProvider'
import { useTeamStore } from '@/stores/team'
import { useToastStore } from '@/stores/toast'

import { server } from '../../../../__vitest__/mswServer'
import { BoardPanel } from '../../BoardPanel'
import { elapsedLabel, longDate, shortDate, timeLabel, timeOnDay } from '../calendarFormat'
import {
  addDays,
  buildRange,
  dayKey,
  localeWeekStart,
  rangeContains,
  startOfDay,
} from '../calendarModel'
import { resetBoardStorage } from '../../__tests__/resetBoardStorage'

const MINUTE = 60_000
const HOUR = 3_600_000

function thisWeek() {
  return buildRange('week', Date.now(), localeWeekStart())
}

/** An instant earlier today (or this very moment just after midnight). */
function earlierToday(): number {
  return Math.max(startOfDay(Date.now()) + 1000, Date.now() - MINUTE)
}

/** Noon on the next Wednesday, today included. */
function wednesdayNoon(): number {
  const d = new Date(startOfDay(Date.now()))
  while (d.getDay() !== 3) d.setDate(d.getDate() + 1)
  d.setHours(12, 0, 0, 0)
  return d.getTime()
}

/** Freezes Date where the test sets it and stops the interval polls, so every
 *  board read is one the test asked for. Timeouts run as normal. */
function freezeClock(): void {
  vi.useFakeTimers({ toFake: ['Date', 'setInterval', 'clearInterval'] })
}

/** Freezes the clock at a Wednesday noon. */
function freezeAtWednesdayNoon(): number {
  const at = wednesdayNoon()
  freezeClock()
  vi.setSystemTime(at)
  return at
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

const EVENING: ScheduleRecord = {
  ...ROUTINE,
  id: 'clawboo-routine:r2',
  sourceScheduleId: 'r2',
  label: 'Evening wrap',
}

/** A routine and the instants it runs at. */
interface RunsAt {
  routine: ScheduleRecord
  at: number[]
}

/**
 * Serve the board and, for each routine given, its runs: each window the panel
 * asks for gets the runs that fall inside it, so a run lands on its own day.
 */
function serve(tasks: unknown[], runs: RunsAt[] = []): void {
  server.use(
    http.get('/api/board', () => HttpResponse.json({ tasks })),
    http.get('/api/schedules/occurrences', ({ request }) => {
      const bounds = (new URL(request.url).searchParams.get('bounds') ?? '').split(',').map(Number)
      return HttpResponse.json({
        now: Date.now(),
        routines: runs.map((r) => ({
          schedule: { ...r.routine, nextRunAt: Math.min(...r.at) },
          windows: bounds.slice(0, -1).map((start, i) => {
            const end = bounds[i + 1]!
            const times = r.at.filter((t) => start <= t && t < end)
            return { count: times.length, more: false, times }
          }),
        })),
      })
    }),
    http.get('/api/teams', () =>
      HttpResponse.json({ teams: [{ id: 'team-1', name: 'Alpha', icon: 'A' }] }),
    ),
    http.get('/api/schedules', () =>
      HttpResponse.json({
        schedules: runs.map((r) => r.routine),
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

function renderBoard() {
  return render(
    <ThemeProvider>
      <BoardPanel />
    </ThemeProvider>,
  )
}

/** The card on the calendar showing a title. */
function cardFor(title: string): HTMLElement {
  return within(screen.getByTestId('board-calendar'))
    .getByText(title)
    .closest('[data-testid="board-card"]') as HTMLElement
}

/** A card's title line: the first child of the card. */
function titleOf(card: HTMLElement): HTMLElement {
  return card.firstElementChild as HTMLElement
}

/** The date button in the gutter for the day holding `ms`. */
function dateButton(ms: number): HTMLElement {
  return within(screen.getByTestId(`calendar-day-${dayKey(ms)}`)).getByRole('button', {
    name: `Highlight ${longDate(ms)}`,
  })
}

/** The To do cell on the day holding `ms`. */
function todoCell(ms: number): HTMLElement {
  return screen.getByTestId(`calendar-cell-todo-${dayKey(ms)}`)
}

/** The run strip of one routine inside a cell. */
function stripIn(cell: HTMLElement, routine: ScheduleRecord): HTMLElement {
  const strip = cell.querySelector<HTMLElement>(`[data-routine-id="${routine.id}"]`)
  expect(strip).not.toBeNull()
  return strip!
}

/** A strip drawn in full: the name on its own line, the time on the line under it. */
function expectFull(strip: HTMLElement, name: string): void {
  expect(strip.children).toHaveLength(2)
  expect(strip.children[0]).toHaveTextContent(new RegExp(`^${name}$`))
  expect(strip).toHaveClass('py-1.5')
  expect(strip).not.toHaveClass('py-[3px]')
}

/** A string matched literally inside a RegExp. */
function literal(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** A strip drawn on one line: the time, then the name. */
function expectLine(strip: HTMLElement, at: number, name: string): void {
  expect(strip.children).toHaveLength(1)
  expect(strip).toHaveTextContent(new RegExp(`^${literal(timeLabel(at))}\\s*${name}$`))
  expect(strip).toHaveClass('py-[3px]')
  expect(strip).not.toHaveClass('py-1.5')
}

beforeEach(() => {
  useTeamStore.setState({ teams: [], selectedTeamId: null })
  useToastStore.setState({ toasts: [] })
  resetBoardStorage()
})
afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

describe('the stamp on a running task', () => {
  it('shows how long the run has gone, with a timer, and when it started in the title', async () => {
    const now = freezeAtWednesdayNoon()
    const added = now - 40 * MINUTE
    const since = now - 14 * MINUTE - 10_000
    serve([
      {
        id: 'r',
        title: 'Write the release notes',
        status: 'in_progress',
        createdAt: added,
        runningSince: since,
      },
    ])
    renderBoard()
    await screen.findByText('Write the release notes')

    const stamp = within(cardFor('Write the release notes')).getByTestId('board-card-stamp')
    const title = `Running since ${timeOnDay(since, now)}. Added ${shortDate(added)} at ${timeLabel(added)}`
    expect(stamp).toHaveAttribute('title', title)
    expect(stamp.getAttribute('title')).toMatch(/^Running since /)
    // A small live dot leads the elapsed time; a screen reader hears the whole sentence.
    expect(stamp.querySelector('span.bg-mint')).toHaveAttribute('aria-hidden', 'true')
    expect(stamp.querySelector('svg')).toBeNull()
    expect(stamp.textContent).toBe(`${elapsedLabel(now - since)}, ${title}`)
    expect(elapsedLabel(now - since)).toBe('14m')
  })

  it('ticks with the calendar clock', async () => {
    const now = freezeAtWednesdayNoon()
    const since = now - 14 * MINUTE - 10_000
    serve([
      {
        id: 'r',
        title: 'Write the release notes',
        status: 'in_progress',
        createdAt: now - 40 * MINUTE,
        runningSince: since,
      },
    ])
    renderBoard()
    await screen.findByText('Write the release notes')
    const stamp = () => within(cardFor('Write the release notes')).getByTestId('board-card-stamp')
    expect(stamp().textContent).toMatch(/^14m, /)

    // A minute on, the clock's 30 second poll has moved the stamp on with it.
    await act(async () => {
      vi.advanceTimersByTime(60_000)
    })
    await waitFor(() => expect(stamp().textContent).toMatch(/^15m, /))

    // Past the hour it counts hours and minutes.
    vi.setSystemTime(since + 61 * MINUTE + 5_000)
    await act(async () => {
      vi.advanceTimersByTime(30_000)
    })
    const label = elapsedLabel(Date.now() - since)
    expect(label).toBe('1h 1m')
    await waitFor(() => expect(stamp().textContent).toMatch(new RegExp(`^${label}, `)))
    expect(stamp().getAttribute('title')).toMatch(/^Running since /)
  })

  it('shows the time it was added while it has no run start, or is not in progress', async () => {
    const now = freezeAtWednesdayNoon()
    const added = now - 40 * MINUTE
    const queued = now - 20 * MINUTE
    serve([
      { id: 'a', title: 'Waiting on its run', status: 'in_progress', createdAt: added },
      // A run start on a task that is not in progress is stale, and not shown.
      {
        id: 'b',
        title: 'Back in the queue',
        status: 'todo',
        createdAt: queued,
        runningSince: now - 5 * MINUTE,
      },
    ])
    renderBoard()
    await screen.findByText('Waiting on its run')

    for (const [name, at] of [
      ['Waiting on its run', added],
      ['Back in the queue', queued],
    ] as const) {
      const stamp = within(cardFor(name)).getByTestId('board-card-stamp')
      const title = `Added ${shortDate(at)} at ${timeLabel(at)}`
      expect(stamp).toHaveAttribute('title', title)
      expect(stamp.textContent).toBe(`${timeLabel(at)}, ${title}`)
      expect(stamp.querySelector('svg')).toBeNull()
    }
  })
})

const LONG = 'Ship the quarterly report to every regional office and archive the old drafts'

describe('finished work from a day gone by', () => {
  it('keeps to one line with the whole title in the tooltip, and today’s work does not', async () => {
    const yesterday = addDays(startOfDay(Date.now()), -1) + 10 * HOUR
    const finished = earlierToday()
    serve([
      {
        id: 'a',
        title: LONG,
        status: 'done',
        createdAt: yesterday,
        updatedAt: yesterday,
        completedAt: yesterday,
      },
      { id: 'b', title: 'Still going from yesterday', status: 'in_progress', createdAt: yesterday },
      {
        id: 'c',
        title: 'Shipped today',
        status: 'done',
        createdAt: finished,
        updatedAt: finished,
        completedAt: finished,
      },
    ])
    const user = userEvent.setup()
    renderBoard()
    await screen.findByText('Shipped today')

    // Today's finished work keeps its two lines and needs no tooltip.
    const today = cardFor('Shipped today')
    expect(titleOf(today)).toHaveClass('line-clamp-2')
    expect(titleOf(today)).not.toHaveClass('line-clamp-1')
    expect(today).not.toHaveAttribute('title')

    if (!rangeContains(thisWeek(), yesterday)) {
      await user.click(screen.getByRole('button', { name: /^Previous week/ }))
    }
    await screen.findByText(LONG)
    expect(
      within(screen.getByTestId(`calendar-cell-done-${dayKey(yesterday)}`)).getByText(LONG),
    ).toBeInTheDocument()
    const past = cardFor(LONG)
    expect(past).toHaveAttribute('data-past', 'true')
    expect(titleOf(past)).toHaveClass('line-clamp-1')
    expect(titleOf(past)).not.toHaveClass('line-clamp-2')
    expect(past).toHaveAttribute('title', LONG)

    // Work still open on a past day is not finished, so it keeps both lines.
    const open = cardFor('Still going from yesterday')
    expect(titleOf(open)).toHaveClass('line-clamp-2')
    expect(open).not.toHaveAttribute('title')
  })

  it('shows the whole title while its drawer is open, and one line again once it closes', async () => {
    const yesterday = addDays(startOfDay(Date.now()), -1) + 10 * HOUR
    const task = {
      id: 'a',
      title: LONG,
      status: 'done',
      createdAt: yesterday,
      updatedAt: yesterday,
      completedAt: yesterday,
    }
    serve([task, { id: 't', title: 'Any task', status: 'todo', createdAt: earlierToday() }])
    serveDrawer(task)
    const user = userEvent.setup()
    renderBoard()
    await screen.findByText('Any task')
    if (!rangeContains(thisWeek(), yesterday)) {
      await user.click(screen.getByRole('button', { name: /^Previous week/ }))
    }
    await screen.findByText(LONG)
    expect(titleOf(cardFor(LONG))).toHaveClass('line-clamp-1')

    await user.click(cardFor(LONG))
    await screen.findByTestId('task-detail-drawer')
    const opened = cardFor(LONG)
    expect(opened).toHaveAttribute('data-open', 'true')
    expect(titleOf(opened)).toHaveClass('line-clamp-2')
    expect(titleOf(opened)).not.toHaveClass('line-clamp-1')
    expect(opened).not.toHaveAttribute('title')

    await user.keyboard('{Escape}')
    await waitFor(() => expect(screen.queryByTestId('task-detail-drawer')).toBeNull())
    const closed = cardFor(LONG)
    expect(closed).not.toHaveAttribute('data-open')
    expect(titleOf(closed)).toHaveClass('line-clamp-1')
    expect(closed).toHaveAttribute('title', LONG)
  })
})

describe('a cell with both tasks and routine runs', () => {
  it('draws the day’s tasks before its runs', async () => {
    const now = freezeAtWednesdayNoon()
    serve(
      [
        { id: 'a', title: 'Draft the launch note', status: 'todo', createdAt: now - HOUR },
        { id: 'b', title: 'Book the venue', status: 'todo', createdAt: now - 30 * MINUTE },
      ],
      [
        { routine: ROUTINE, at: [now + HOUR] },
        { routine: EVENING, at: [now + 5 * HOUR] },
      ],
    )
    renderBoard()
    await waitFor(() => expect(screen.getAllByTestId('calendar-routine-run')).toHaveLength(2))

    const cell = todoCell(now)
    const order = Array.from(
      cell.querySelectorAll<HTMLElement>(
        '[data-testid="board-card"], [data-testid="calendar-routine-run"]',
      ),
    ).map((el) => el.dataset['testid'])
    expect(order).toEqual([
      'board-card',
      'board-card',
      'calendar-routine-run',
      'calendar-routine-run',
    ])
    const card = cardFor('Book the venue')
    const strip = stripIn(cell, ROUTINE)
    expect(card.compareDocumentPosition(strip) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  })
})

describe('which run strips are drawn in full', () => {
  it('draws today’s runs in full and a later day’s run on one line, picked or not', async () => {
    const now = freezeAtWednesdayNoon()
    const friday = addDays(startOfDay(now), 2) + 10 * HOUR
    serve(
      [{ id: 't', title: 'Any task', status: 'todo', createdAt: now - HOUR }],
      [
        { routine: ROUTINE, at: [now + HOUR, friday] },
        { routine: EVENING, at: [now + 5 * HOUR] },
      ],
    )
    const user = userEvent.setup()
    renderBoard()
    await waitFor(() => expect(screen.getAllByTestId('calendar-routine-run')).toHaveLength(3))

    // Today: the next run and a later one are both drawn in full.
    const next = stripIn(todoCell(now), ROUTINE)
    expect(next).toHaveAttribute('data-next', 'true')
    expectFull(next, 'Morning digest')
    const later = stripIn(todoCell(now), EVENING)
    expect(later).not.toHaveAttribute('data-next')
    expectFull(later, 'Evening wrap')

    // Friday holds nothing but the run, so its row is thin and the run one line.
    const row = screen.getByTestId(`calendar-day-${dayKey(friday)}`)
    expect(row).toHaveClass('min-h-9')
    expectLine(stripIn(todoCell(friday), ROUTINE), friday, 'Morning digest')

    // Picked, the row is full, and the run is still one line: not today, not next.
    await user.click(dateButton(friday))
    await waitFor(() =>
      expect(screen.getByTestId(`calendar-day-${dayKey(friday)}`)).toHaveAttribute(
        'data-selected',
        'true',
      ),
    )
    expect(screen.getByTestId(`calendar-day-${dayKey(friday)}`)).not.toHaveClass('min-h-9')
    const picked = stripIn(todoCell(friday), ROUTINE)
    expect(picked).not.toHaveAttribute('data-next')
    expectLine(picked, friday, 'Morning digest')
  })

  it('draws the next run in full on a full row, and on one line on a thin one', async () => {
    const now = freezeAtWednesdayNoon()
    // Nothing runs today, so the next run is tomorrow's.
    const thursday = addDays(startOfDay(now), 1) + 10 * HOUR
    const friday = addDays(startOfDay(now), 2) + 10 * HOUR
    serve(
      [{ id: 't', title: 'Any task', status: 'todo', createdAt: now - HOUR }],
      [
        { routine: ROUTINE, at: [thursday] },
        { routine: EVENING, at: [friday] },
      ],
    )
    const user = userEvent.setup()
    renderBoard()
    await waitFor(() => expect(screen.getAllByTestId('calendar-routine-run')).toHaveLength(2))

    // A thin row always draws its runs on one line, the next run included.
    const thin = stripIn(todoCell(thursday), ROUTINE)
    expect(thin).toHaveAttribute('data-next', 'true')
    expect(screen.getByTestId(`calendar-day-${dayKey(thursday)}`)).toHaveClass('min-h-9')
    expectLine(thin, thursday, 'Morning digest')

    // Picked, Thursday's row is full and the next run gets the full strip.
    await user.click(dateButton(thursday))
    await waitFor(() =>
      expect(screen.getByTestId(`calendar-day-${dayKey(thursday)}`)).not.toHaveClass('min-h-9'),
    )
    const full = stripIn(todoCell(thursday), ROUTINE)
    expect(full).toHaveAttribute('data-next', 'true')
    expectFull(full, 'Morning digest')
    expect(full.children[1]).toHaveTextContent(timeLabel(thursday))
    // Friday's run is neither today’s nor the next, and stays one line.
    const other = stripIn(todoCell(friday), EVENING)
    expect(other).not.toHaveAttribute('data-next')
    expectLine(other, friday, 'Evening wrap')
  })
})

describe('a routine that is running now', () => {
  it('marks the run it may still skip and firms up the next certain run instead', async () => {
    const now = freezeAtWednesdayNoon()
    const thursday = addDays(startOfDay(now), 1) + 10 * HOUR
    const friday = addDays(startOfDay(now), 2) + 10 * HOUR
    const running: ScheduleRecord = { ...ROUTINE, status: 'running' }
    serve(
      [{ id: 't', title: 'Any task', status: 'todo', createdAt: now - HOUR }],
      [{ routine: running, at: [thursday, friday] }],
    )
    const user = userEvent.setup()
    renderBoard()
    await waitFor(() => expect(screen.getAllByTestId('calendar-routine-run')).toHaveLength(2))

    // Thursday's run happens only if the current fire has finished by then, so it
    // says so and is not drawn as the next run.
    const maybe = stripIn(todoCell(thursday), running)
    expect(maybe).toHaveAttribute('data-conditional', 'true')
    expect(maybe).not.toHaveAttribute('data-next')
    expect(maybe).toHaveAttribute(
      'title',
      'A run is running now, so this one happens only if that run has finished by then.',
    )
    expect(maybe.getAttribute('aria-label')).toContain('happens only if that run has finished')

    // Friday's run is not in question, and it is the next one.
    const sure = stripIn(todoCell(friday), running)
    expect(sure).not.toHaveAttribute('data-conditional')
    expect(sure).toHaveAttribute('data-next', 'true')

    // The popover says the same.
    await user.click(maybe)
    const popover = await screen.findByTestId('calendar-routine-popover')
    expect(within(popover).getByTestId('calendar-routine-in-flight')).toHaveTextContent(
      'A run is running now. The first time below happens only if that run has finished by then; if not, it is skipped.',
    )
  })

  it('leads with a later run the same day when the first may be skipped', async () => {
    const now = freezeAtWednesdayNoon()
    const maybeAt = now + 2 * HOUR
    const sureAt = now + 4 * HOUR
    const tomorrow = addDays(startOfDay(now), 1) + 10 * HOUR
    const running: ScheduleRecord = { ...ROUTINE, status: 'running' }
    serve(
      [{ id: 't', title: 'Any task', status: 'todo', createdAt: now - HOUR }],
      [{ routine: running, at: [maybeAt, sureAt, tomorrow] }],
    )
    renderBoard()
    await waitFor(() => expect(screen.getAllByTestId('calendar-routine-run')).toHaveLength(2))

    // Today's second run is certain, so it is the next run: the strip shows its
    // time and names the earlier one as the run in question.
    const today = stripIn(todoCell(now), running)
    expect(today).toHaveAttribute('data-next', 'true')
    expect(today).toHaveAttribute('data-conditional', 'true')
    expect(today).toHaveTextContent(timeLabel(sureAt))
    expect(today).toHaveAttribute(
      'title',
      `A run is running now, so the one at ${timeLabel(maybeAt)} happens only if that run has finished by then.`,
    )
    expect(today.getAttribute('aria-label')).toContain(
      `next run at ${timeLabel(sureAt)}, 2 runs from ${timeLabel(maybeAt)}`,
    )
    expect(stripIn(todoCell(tomorrow), running)).not.toHaveAttribute('data-next')
  })

  it('judges a run against the runs still on the calendar once the first has passed', async () => {
    const now = freezeAtWednesdayNoon()
    // The projection still holds a run that has passed while the fire runs on;
    // the calendar drops it, so the next run is now the one the fire may skip.
    const passed = now - 30 * MINUTE
    const nextAt = now + 3 * HOUR
    const tomorrow = addDays(startOfDay(now), 1) + 10 * HOUR
    const running: ScheduleRecord = { ...ROUTINE, status: 'running' }
    serve(
      [{ id: 't', title: 'Any task', status: 'todo', createdAt: now - HOUR }],
      [{ routine: running, at: [passed, nextAt, tomorrow] }],
    )
    renderBoard()
    await waitFor(() => expect(screen.getAllByTestId('calendar-routine-run')).toHaveLength(2))

    const today = stripIn(todoCell(now), running)
    expect(today).toHaveTextContent(timeLabel(nextAt))
    expect(today).toHaveAttribute('data-conditional', 'true')
    expect(today).not.toHaveAttribute('data-next')
    expect(stripIn(todoCell(tomorrow), running)).toHaveAttribute('data-next', 'true')
  })

  it('says nothing of the kind for a routine that is waiting for its time', async () => {
    const now = freezeAtWednesdayNoon()
    const thursday = addDays(startOfDay(now), 1) + 10 * HOUR
    serve(
      [{ id: 't', title: 'Any task', status: 'todo', createdAt: now - HOUR }],
      [{ routine: ROUTINE, at: [thursday] }],
    )
    const user = userEvent.setup()
    renderBoard()
    await waitFor(() => expect(screen.getAllByTestId('calendar-routine-run')).toHaveLength(1))
    const strip = stripIn(todoCell(thursday), ROUTINE)
    expect(strip).not.toHaveAttribute('data-conditional')
    expect(strip).not.toHaveAttribute('title')
    await user.click(strip)
    const popover = await screen.findByTestId('calendar-routine-popover')
    expect(within(popover).queryByTestId('calendar-routine-in-flight')).toBeNull()
  })
})
