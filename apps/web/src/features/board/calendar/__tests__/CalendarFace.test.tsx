// The calendar board's face, rendered through the real BoardPanel against msw:
// the counts in the column heads, the day gutter and its tooltips, the corner,
// the Earlier and gap rows, the routine run strips and their popover, the
// Routines switch, the range title, the states a card shows, the date picker's
// month paging, and the task count in the header.
//
// Fixtures are built from "now" and the same range math the panel uses, so the
// suite holds on any day of the week and in any time zone. Routine runs are
// served on today's window, so they always land on today's row.

import { cleanup, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { http, HttpResponse } from 'msw'
import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from 'vitest'

import type { ScheduleRecord } from '@clawboo/scheduler'

import { ThemeProvider } from '@/features/theme/ThemeProvider'
import { useTeamStore } from '@/stores/team'
import { useToastStore } from '@/stores/toast'

import { server } from '../../../../__vitest__/mswServer'
import { BoardPanel } from '../../BoardPanel'
import { dayMonth, isoWeek, longDate, monthShort, timeLabel, weekdayShort } from '../calendarFormat'
import {
  addDays,
  buildRange,
  dayKey,
  localeWeekStart,
  rangeContains,
  startOfDay,
  startOfMonth,
  startOfWeek,
} from '../calendarModel'
import { resetBoardStorage } from '../../__tests__/resetBoardStorage'

const HOUR = 3_600_000
const LEGEND = 'Open work sits on the day it was added, finished work on the day it finished.'

function thisWeek() {
  return buildRange('week', Date.now(), localeWeekStart())
}

/** An instant earlier today (or this very moment just after midnight). */
function earlierToday(): number {
  return Math.max(startOfDay(Date.now()) + 1000, Date.now() - 60_000)
}

/** The local midnight a `YYYY-MM-DD` day key names. */
function fromKey(key: string): number {
  const [y, m, d] = key.split('-').map(Number)
  return new Date(y!, m! - 1, d!).getTime()
}

/** The last day number of the month holding `ms`. */
function lastDateOf(ms: number): number {
  const d = new Date(ms)
  return new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate()
}

/** The same day number a month after `ms`, or that month's last day. */
function sameDayNextMonth(ms: number): number {
  const d = new Date(ms)
  const next = new Date(d.getFullYear(), d.getMonth() + 1, 1).getTime()
  return new Date(
    d.getFullYear(),
    d.getMonth() + 1,
    Math.min(d.getDate(), lastDateOf(next)),
  ).getTime()
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

/** A routine's runs today: how many, whether the server capped the count, and
 *  how many minutes after the first run time the first of them comes. */
interface TodayRuns {
  routine: ScheduleRecord
  count: number
  more?: boolean
  offsetMin?: number
}

/**
 * Serve the board and, for each routine given, its runs in today's window. The
 * first run time is an hour from now; bucketing goes by window, so the runs sit
 * on today's row whatever the hour. Returns that first run time.
 */
function serve(tasks: unknown[], runs: TodayRuns[] = []): { firstRunAt: number } {
  const firstRunAt = Date.now() + HOUR
  server.use(
    http.get('/api/board', () => HttpResponse.json({ tasks })),
    http.get('/api/schedules/occurrences', ({ request }) => {
      const bounds = (new URL(request.url).searchParams.get('bounds') ?? '').split(',').map(Number)
      const now = Date.now()
      return HttpResponse.json({
        now,
        routines: runs.map((r) => ({
          schedule: { ...r.routine, nextRunAt: firstRunAt },
          windows: bounds.slice(0, -1).map((start, i) => {
            const end = bounds[i + 1]!
            if (!(start <= now && now < end)) return { count: 0, more: false, times: [] }
            const first = firstRunAt + (r.offsetMin ?? 0) * 60_000
            return {
              count: r.count,
              more: r.more ?? false,
              times: Array.from({ length: Math.min(r.count, 8) }, (_, k) => first + k * 60_000),
            }
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
  return { firstRunAt }
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

/** A status column's sticky head: the first child of its column. */
function columnHead(id: string): HTMLElement {
  return screen.getByTestId(`board-column-${id}`).firstElementChild as HTMLElement
}

/** The date button in the gutter for the day holding `ms`. */
function dateButton(ms: number): HTMLElement {
  return within(screen.getByTestId(`calendar-day-${dayKey(ms)}`)).getByRole('button', {
    name: /^Highlight /,
  })
}

type User = ReturnType<typeof userEvent.setup>

/** Open every seam of quiet days on screen, so each day has a row of its own. */
async function openAllFolds(user: User): Promise<void> {
  for (let i = 0; i < 40; i++) {
    const closed = document.querySelector<HTMLElement>('[data-fold-toggle][aria-expanded="false"]')
    if (!closed) return
    await user.click(closed)
  }
}

/** The days a seam's handle holds, from its `from..to` key. */
function foldDays(handle: HTMLElement): [number, number] {
  const [from, to] = handle.dataset['foldToggle']!.split('..').map(fromKey)
  return [from!, to!]
}

/** The card on the calendar showing a title. */
function cardFor(title: string): HTMLElement {
  return within(screen.getByTestId('board-calendar'))
    .getByText(title)
    .closest('[data-testid="board-card"]') as HTMLElement
}

beforeEach(() => {
  useTeamStore.setState({ teams: [], selectedTeamId: null })
  useToastStore.setState({ toasts: [] })
  resetBoardStorage()
})
afterEach(() => cleanup())

describe('the column heads', () => {
  it('count each column as a bare numeral, and an empty column not at all', async () => {
    serve(
      [{ id: 't1', title: 'Draft the launch note', status: 'todo', createdAt: earlierToday() }],
      [{ routine: ROUTINE, count: 24 }],
    )
    renderBoard()
    await screen.findByTestId('calendar-routine-run')

    const todo = columnHead('todo')
    expect(todo).toHaveTextContent(/^To do1$/)
    const count = todo.querySelector('.board-roll')
    expect(count).toHaveTextContent(/^1$/)
    expect(count?.previousElementSibling).toHaveTextContent(/^To do$/)
    // The run total lives on the Routines switch, not here: no repeat mark, no 24.
    expect(todo.querySelector('svg')).toBeNull()
    expect(todo.textContent).not.toContain('24')
    expect(screen.getByRole('group', { name: 'To do, 1 task' })).toBe(
      screen.getByTestId('board-column-todo'),
    )

    for (const id of ['backlog', 'in_progress', 'done']) {
      const head = columnHead(id)
      expect(head.textContent).not.toMatch(/\d/)
      expect(head.querySelector('.board-roll')).toBeNull()
    }
  })

  it('show no count on Needs you while nothing waits', async () => {
    serve([{ id: 't1', title: 'Any task', status: 'todo', createdAt: earlierToday() }])
    renderBoard()
    await screen.findByTestId('board-calendar')

    const head = columnHead('needs-you')
    expect(head).toHaveTextContent(/^Needs youToday$/)
    expect(head.querySelector('.board-roll')).toBeNull()
    expect(head.querySelector('svg')).toHaveClass('text-muted-foreground')
    expect(head.querySelector('svg')).not.toHaveClass('text-amber')
  })

  it('count what waits on Needs you in an amber pill, apart from the status columns', async () => {
    const old = startOfDay(Date.now()) - 20 * 24 * HOUR
    serve([{ id: 'f1', title: 'Broken run', status: 'blocked', createdAt: old, updatedAt: old }])
    renderBoard()
    await screen.findByTestId('board-calendar')

    const head = columnHead('needs-you')
    expect(head).toHaveTextContent(/^Needs you1Today$/)
    const count = head.querySelector('.board-roll')
    expect(count).toHaveTextContent(/^1$/)
    expect(count?.parentElement).toHaveClass('bg-amber/20')
    expect(head.querySelector('svg')).toHaveClass('text-amber')
    // A stuck task is counted where it waits, not in a status column.
    expect(columnHead('backlog').textContent).not.toMatch(/\d/)
  })
})

describe('the day gutter', () => {
  it('names today, its load and what a click does in the date’s tooltip', async () => {
    serve(
      [{ id: 't1', title: 'Any task', status: 'todo', createdAt: earlierToday() }],
      [{ routine: ROUTINE, count: 1 }],
    )
    const user = userEvent.setup()
    renderBoard()
    await screen.findByTestId('calendar-routine-run')

    const today = Date.now()
    const date = dateButton(today)
    expect(date).toHaveAccessibleName(`Highlight ${longDate(today)}, today`)
    expect(date).toHaveAttribute(
      'title',
      `${longDate(today)}, today. 1 task, 1 run. Click to highlight the day.`,
    )

    await user.click(date)
    expect(date).toHaveAttribute('aria-pressed', 'true')
    expect(date).toHaveAttribute(
      'title',
      `${longDate(today)}, today. 1 task, 1 run. Click to clear the highlight.`,
    )
    // The tooltip changes; the name a screen reader hears does not.
    expect(date).toHaveAccessibleName(`Highlight ${longDate(today)}, today`)
  })

  it('counts many runs in the tooltip', async () => {
    serve(
      [{ id: 't1', title: 'Any task', status: 'todo', createdAt: earlierToday() }],
      [{ routine: ROUTINE, count: 24 }],
    )
    renderBoard()
    await screen.findByTestId('calendar-routine-run')
    expect(dateButton(Date.now())).toHaveAttribute(
      'title',
      `${longDate(Date.now())}, today. 1 task, 24 runs. Click to highlight the day.`,
    )
  })

  it('says yesterday and tomorrow, and only the date for a quiet day further off', async () => {
    serve([{ id: 't1', title: 'Any task', status: 'todo', createdAt: earlierToday() }])
    const user = userEvent.setup()
    renderBoard()
    await screen.findByTestId('board-calendar')
    await openAllFolds(user)

    const now = Date.now()
    const week = thisWeek()
    const near = new Set([-1, 0, 1].map((n) => dayKey(addDays(now, n))))
    const far = week.days.find((d) => !near.has(dayKey(d)))!
    expect(dateButton(far)).toHaveAccessibleName(`Highlight ${longDate(far)}`)
    expect(dateButton(far)).toHaveAttribute(
      'title',
      `${longDate(far)}. Click to highlight the day.`,
    )

    const yesterday = addDays(now, -1)
    if (!rangeContains(week, yesterday)) {
      await user.click(screen.getByRole('button', { name: /^Previous week/ }))
      await openAllFolds(user)
    }
    expect(dateButton(yesterday)).toHaveAttribute(
      'title',
      `${longDate(yesterday)}, yesterday. Click to highlight the day.`,
    )
    expect(dateButton(yesterday)).toHaveAccessibleName(`Highlight ${longDate(yesterday)}`)

    await user.click(screen.getByRole('button', { name: 'Go to today' }))
    const tomorrow = addDays(now, 1)
    if (!rangeContains(week, tomorrow)) {
      await user.click(screen.getByRole('button', { name: /^Next week/ }))
    }
    await openAllFolds(user)
    expect(dateButton(tomorrow)).toHaveAttribute(
      'title',
      `${longDate(tomorrow)}, tomorrow. Click to highlight the day.`,
    )
  })

  it('draws today in the red circle, a picked date in ink, and past dates muted', async () => {
    serve([{ id: 't1', title: 'Any task', status: 'todo', createdAt: earlierToday() }])
    const user = userEvent.setup()
    renderBoard()
    await screen.findByTestId('board-calendar')
    await openAllFolds(user)

    const now = Date.now()
    const circleOf = (ms: number) =>
      within(screen.getByTestId(`calendar-day-${dayKey(ms)}`)).getByText(
        String(new Date(ms).getDate()),
      )
    expect(circleOf(now)).toHaveClass('bg-primary-solid', 'text-primary-foreground')

    const other = thisWeek().days.find((d) => dayKey(d) !== dayKey(now))!
    expect(circleOf(other)).not.toHaveClass('bg-foreground')
    await user.click(dateButton(other))
    expect(circleOf(other)).toHaveClass('bg-foreground', 'text-background')
    expect(circleOf(now)).not.toHaveClass('bg-foreground')

    // Picking today moves the highlight there; today keeps its red circle.
    await user.click(dateButton(now))
    expect(circleOf(other)).not.toHaveClass('bg-foreground')
    expect(circleOf(now)).toHaveClass('bg-primary-solid')
    expect(circleOf(now)).not.toHaveClass('bg-foreground')

    // Every day of last week is past: no red, the numerals muted.
    await user.click(screen.getByRole('button', { name: /^Previous week/ }))
    await openAllFolds(user)
    for (const day of buildRange('week', addDays(now, -7), localeWeekStart()).days) {
      expect(circleOf(day)).toHaveClass('text-muted-foreground')
      expect(circleOf(day)).not.toHaveClass('bg-primary-solid')
    }
  })

  it('labels the corner with the week number and the legend, and the month in Month view', async () => {
    serve([{ id: 't1', title: 'Any task', status: 'todo', createdAt: earlierToday() }])
    const user = userEvent.setup()
    const { container } = renderBoard()
    await screen.findByTestId('board-calendar')

    const corner = () => container.querySelector(`[title="${LEGEND}"]`) as HTMLElement
    expect(corner()).not.toBeNull()
    expect(corner()).toHaveAttribute('aria-hidden', 'true')
    expect(corner()).toHaveTextContent(new RegExp(`^Week ${isoWeek(thisWeek().days[3]!)}$`))

    await user.click(screen.getByRole('radio', { name: 'Month' }))
    expect(corner()).toHaveTextContent(new RegExp(`^${monthShort(startOfMonth(Date.now()))}$`))
  })

  it('sums open work from before the range in the Earlier row', async () => {
    const old = startOfDay(Date.now()) - 40 * 24 * HOUR
    serve([
      { id: 'o1', title: 'Old backlog idea', status: 'backlog', createdAt: old, updatedAt: old },
      { id: 't1', title: 'Any task', status: 'todo', createdAt: earlierToday() },
    ])
    renderBoard()
    const row = await screen.findByTestId('calendar-row-earlier')
    const start = thisWeek().start

    const toggle = within(row).getByRole('button')
    expect(toggle).toHaveTextContent(/^Earlier$/)
    expect(toggle).toHaveAccessibleName(
      `Earlier: open work added before ${longDate(start)}, 1 parked`,
    )
    // Parked work alone keeps the row folded.
    expect(toggle).toHaveAttribute('aria-expanded', 'false')

    const lines = toggle.nextElementSibling as HTMLElement
    expect(lines).toHaveAttribute('aria-hidden', 'true')
    expect(Array.from(lines.children).map((l) => l.textContent)).toEqual([
      'Before',
      dayMonth(start),
      '1 parked',
    ])
  })

  it('folds empty days in a month into seams that stop at each week edge', async () => {
    serve([{ id: 't1', title: 'Any task', status: 'todo', createdAt: earlierToday() }])
    const user = userEvent.setup()
    renderBoard()
    await screen.findByTestId('board-calendar')
    await user.click(screen.getByRole('radio', { name: 'Month' }))

    const handles = screen
      .getAllByTestId('calendar-row-gap')
      .map((gap) => within(gap).getByRole('button'))
    expect(handles.length).toBeGreaterThan(0)
    expect(screen.getAllByTestId('calendar-seam')).toHaveLength(handles.length)
    const weekStart = localeWeekStart()
    for (const handle of handles) {
      const [from, to] = foldDays(handle)
      // A seam never spans two weeks, so the week lines survive.
      expect(startOfWeek(from, weekStart)).toBe(startOfWeek(to, weekStart))
      expect(from).not.toBe(startOfDay(Date.now()))
    }
  })

  it('names the month under a 1st inside a week, and not under a 1st that opens the range', async () => {
    // A finished task on this month's 1st gives that day a row of its own in Month view.
    const onFirst = Math.min(startOfMonth(Date.now()) + 10 * HOUR, earlierToday())
    serve([
      { id: 't1', title: 'Any task', status: 'todo', createdAt: earlierToday() },
      {
        id: 't2',
        title: 'Shipped on the 1st',
        status: 'done',
        createdAt: onFirst,
        updatedAt: onFirst,
        completedAt: onFirst,
      },
    ])
    const user = userEvent.setup()
    renderBoard()
    await screen.findByTestId('board-calendar')

    // In a month the 1st opens the range, whose title already names the month.
    await user.click(screen.getByRole('radio', { name: 'Month' }))
    const opening = screen.getByTestId(`calendar-day-${dayKey(onFirst)}`)
    expect(opening).not.toHaveTextContent(monthShort(onFirst))

    // The next 1st that does not open its week (two months in a row cannot both).
    await user.click(screen.getByRole('radio', { name: 'Week' }))
    const weekStart = localeWeekStart()
    let first = startOfMonth(addDays(startOfMonth(Date.now()), 40))
    if (startOfWeek(first, weekStart) === first) first = startOfMonth(addDays(first, 40))
    for (let i = 0; i < 20; i++) {
      await openAllFolds(user)
      if (screen.queryByTestId(`calendar-day-${dayKey(first)}`)) break
      await user.click(screen.getByRole('button', { name: /^Next week/ }))
    }

    const row = screen.getByTestId(`calendar-day-${dayKey(first)}`)
    expect(within(row).getByText(monthShort(first))).toBeInTheDocument()
    // Only the 1st carries it: the day before it, in the same week, does not.
    expect(screen.getByTestId(`calendar-day-${dayKey(addDays(first, -1))}`)).not.toHaveTextContent(
      monthShort(addDays(first, -1)),
    )
  })
})

describe('quiet days and today', () => {
  /** The handle's words: "Tue 13" for one day, "15–17" (or "30–Nov 2") for more. */
  function spanLabel(from: number, to: number): string {
    if (from === to) return `${weekdayShort(from)} ${new Date(from).getDate()}`
    const sameMonth = new Date(from).getMonth() === new Date(to).getMonth()
    return `${new Date(from).getDate()}–${sameMonth ? new Date(to).getDate() : dayMonth(to)}`
  }

  /** "Thursday, October 15", or "Thursday, October 15 to Saturday, October 17". */
  function spanName(from: number, to: number): string {
    return from === to ? longDate(from) : `${longDate(from)} to ${longDate(to)}`
  }

  function daysOf(from: number, to: number): number[] {
    const days: number[] = []
    for (let d = from; d <= to; d = addDays(d, 1)) days.push(d)
    return days
  }

  function seamFor(key: string): HTMLElement {
    return screen.getAllByTestId('calendar-seam').find((el) => el.dataset['seam'] === key)!
  }

  it('folds quiet days into a seam that opens from its handle or its line, and folds again', async () => {
    serve([{ id: 't1', title: 'Any task', status: 'todo', createdAt: earlierToday() }])
    const user = userEvent.setup()
    renderBoard()
    await screen.findByTestId('board-calendar')

    const handle = within(screen.getAllByTestId('calendar-row-gap')[0]!).getByRole('button')
    const key = handle.dataset['foldToggle']!
    const [from, to] = foldDays(handle)
    const plural = from === to ? 'the day' : 'the days'
    expect(handle).toHaveAccessibleName(`${spanName(from, to)}, no work. Show ${plural}`)
    expect(handle).toHaveAttribute('aria-expanded', 'false')
    expect(handle).toHaveTextContent(spanLabel(from, to))
    for (const d of daysOf(from, to)) {
      expect(screen.queryByTestId(`calendar-day-${dayKey(d)}`)).toBeNull()
    }

    // Pointing at the line lights its handle too.
    const seam = seamFor(key)
    expect(seam).toHaveAttribute('aria-hidden', 'true')
    await user.hover(seam)
    expect(handle).toHaveAttribute('data-hot')
    await user.unhover(seam)
    expect(handle).not.toHaveAttribute('data-hot')

    // A click anywhere on the line opens the days, and focus lands on the
    // control that folds them again.
    await user.click(seam)
    for (const d of daysOf(from, to)) {
      expect(screen.getByTestId(`calendar-day-${dayKey(d)}`)).toBeInTheDocument()
    }
    const fold = within(screen.getByTestId(`calendar-day-${dayKey(from)}`)).getByRole('button', {
      name: `${spanName(from, to)}, no work. Fold ${plural}`,
    })
    expect(fold).toHaveAttribute('aria-expanded', 'true')
    expect(fold).toHaveFocus()

    await user.click(fold)
    const again = within(screen.getAllByTestId('calendar-row-gap')[0]!).getByRole('button')
    expect(again.dataset['foldToggle']).toBe(key)
    expect(again).toHaveFocus()
    expect(screen.queryByTestId(`calendar-day-${dayKey(from)}`)).toBeNull()

    // The handle opens it from the keyboard.
    await user.keyboard('{Enter}')
    expect(screen.getByTestId(`calendar-day-${dayKey(to)}`)).toBeInTheDocument()
  })

  it('keeps a picked day out of a seam, and the opened days beside it stay open', async () => {
    serve([{ id: 't1', title: 'Any task', status: 'todo', createdAt: earlierToday() }])
    const user = userEvent.setup()
    renderBoard()
    await screen.findByTestId('board-calendar')

    // A week with one busy day always has a seam of two days or more.
    const handle = screen
      .getAllByTestId('calendar-row-gap')
      .map((gap) => within(gap).getByRole('button'))
      .find((h) => {
        const [a, b] = foldDays(h)
        return a !== b
      })!
    const [from, to] = foldDays(handle)
    await user.click(handle)

    await user.click(dateButton(from))
    expect(dateButton(from)).toHaveAttribute('aria-pressed', 'true')
    for (const d of daysOf(from, to)) {
      expect(screen.getByTestId(`calendar-day-${dayKey(d)}`)).toBeInTheDocument()
    }

    // Folding the rest leaves the picked day on its own row.
    const rest = addDays(from, 1)
    await user.click(
      within(screen.getByTestId(`calendar-day-${dayKey(rest)}`)).getByRole('button', {
        name: /, no work\. Fold the days?$/,
      }),
    )
    expect(screen.getByTestId(`calendar-day-${dayKey(from)}`)).toBeInTheDocument()
    expect(screen.queryByTestId(`calendar-day-${dayKey(rest)}`)).toBeNull()
  })

  it('gives a day with only routine runs a thin row, its runs on one line', async () => {
    // Pinned to a Wednesday: the run below is tomorrow, and it is only marked as
    // the next run on a range that also holds today, so tomorrow must fall in
    // this week whichever day the suite runs on (or the locale starts its week).
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date(2026, 9, 21, 9, 0))
    onTestFinished(() => {
      vi.useRealTimers()
    })
    serve([{ id: 't1', title: 'Any task', status: 'todo', createdAt: earlierToday() }])
    const runAt = addDays(startOfDay(Date.now()), 1) + 10 * HOUR
    server.use(
      http.get('/api/schedules/occurrences', ({ request }) => {
        const bounds = (new URL(request.url).searchParams.get('bounds') ?? '')
          .split(',')
          .map(Number)
        return HttpResponse.json({
          now: Date.now(),
          routines: [
            {
              schedule: { ...ROUTINE, nextRunAt: runAt },
              windows: bounds
                .slice(0, -1)
                .map((start, i) =>
                  start <= runAt && runAt < bounds[i + 1]!
                    ? { count: 1, more: false, times: [runAt] }
                    : { count: 0, more: false, times: [] },
                ),
            },
          ],
        })
      }),
      http.get('/api/schedules', () =>
        HttpResponse.json({
          schedules: [ROUTINE],
          sources: [{ sourceId: 'clawboo-routine', ok: true, degraded: false, at: 1 }],
        }),
      ),
    )
    const user = userEvent.setup()
    renderBoard()
    await screen.findByTestId('board-calendar')
    if (!rangeContains(thisWeek(), runAt)) {
      await user.click(screen.getByRole('button', { name: /^Next week/ }))
    }

    const strip = await screen.findByTestId('calendar-routine-run')
    const row = screen.getByTestId(`calendar-day-${dayKey(runAt)}`)
    expect(row).not.toHaveClass('board-today-gutter')
    // One line: the time, then the name.
    expect(strip.children).toHaveLength(1)
    expect(strip).toHaveTextContent(new RegExp(`^${timeLabel(runAt)}\\s*Morning digest$`))
    expect(strip).toHaveAccessibleName(/^Routine, Morning digest, next run, /)
    // Its day is never inside a seam.
    for (const gap of screen.queryAllByTestId('calendar-row-gap')) {
      const [a, b] = foldDays(within(gap).getByRole('button'))
      expect(runAt < a || runAt >= addDays(b, 1)).toBe(true)
    }
  })

  it('lifts today’s row, and only on a range that holds today', async () => {
    serve([{ id: 't1', title: 'Any task', status: 'todo', createdAt: earlierToday() }])
    const user = userEvent.setup()
    renderBoard()
    await screen.findByTestId('board-calendar')

    expect(screen.getByTestId(`calendar-day-${dayKey(Date.now())}`)).toHaveClass(
      'board-today-gutter',
    )
    expect(screen.getByTestId('calendar-today-lift')).toHaveAttribute('aria-hidden', 'true')

    await user.click(screen.getByRole('button', { name: /^Previous week/ }))
    expect(screen.queryByTestId('calendar-today-lift')).toBeNull()
  })
})

describe('the routine run strips', () => {
  it('marks the next run on screen, with the name on its own line and one run uncounted', async () => {
    const { firstRunAt } = serve(
      [{ id: 't1', title: 'Any task', status: 'todo', createdAt: earlierToday() }],
      [
        { routine: ROUTINE, count: 1 },
        { routine: EVENING, count: 1, offsetMin: 60 },
      ],
    )
    renderBoard()
    await waitFor(() => expect(screen.getAllByTestId('calendar-routine-run')).toHaveLength(2))
    const [next, later] = screen.getAllByTestId('calendar-routine-run') as [
      HTMLElement,
      HTMLElement,
    ]

    expect(next).toHaveAttribute('data-next', 'true')
    expect(later).not.toHaveAttribute('data-next')
    expect(next).not.toHaveAttribute('data-open')
    expect(next).toHaveAccessibleName(/^Routine, Morning digest, next run, /)
    expect(later).toHaveAccessibleName(/^Routine, Evening wrap, /)
    expect(later).not.toHaveAccessibleName(/next run/)

    // The name is the first line; the time is on the line under it.
    const [name, detail] = Array.from(next.children) as [HTMLElement, HTMLElement]
    expect(name).toHaveTextContent(/^Morning digest$/)
    // One run that day: the time alone, no count.
    expect(detail.textContent).toBe(timeLabel(firstRunAt))
    const time = detail.querySelector('.font-data') as HTMLElement
    expect(time).toHaveTextContent(timeLabel(firstRunAt))
    // A dot in the column's colour leads the next run's time, and only its.
    const dot = time.previousElementSibling as HTMLElement
    expect(dot.tagName).toBe('SPAN')
    expect(dot).toHaveAttribute('aria-hidden', 'true')
    expect(dot).toHaveClass('rounded-full')
    expect(dot.style.background).toBe('var(--category-data)')
    const laterTime = later.children[1]!.querySelector('.font-data') as HTMLElement
    expect(laterTime.previousElementSibling?.tagName.toLowerCase()).toBe('svg')
  })

  it('shows a strip as open while its popover is, and closed again after Escape', async () => {
    serve(
      [{ id: 't1', title: 'Any task', status: 'todo', createdAt: earlierToday() }],
      [{ routine: ROUTINE, count: 3 }],
    )
    const user = userEvent.setup()
    renderBoard()
    const strip = await screen.findByTestId('calendar-routine-run')
    expect(strip).toHaveAttribute('aria-expanded', 'false')

    await user.click(strip)
    const popover = await screen.findByTestId('calendar-routine-popover')
    expect(strip).toHaveAttribute('aria-expanded', 'true')
    expect(strip).toHaveAttribute('data-open', 'true')
    // It opens below the run and grows from its top corner.
    expect(popover).toHaveClass('board-pop-in')
    expect(popover.style.top).not.toBe('')
    expect(popover.style.getPropertyValue('--pop-origin')).toBe('top left')
    expect(popover.style.getPropertyValue('--pop-dy')).toBe('4px')
    expect(within(popover).getByText('Upcoming runs')).toBeInTheDocument()
    expect(within(popover).getByRole('list', { name: 'Upcoming runs' }).children).toHaveLength(3)

    await user.keyboard('{Escape}')
    await waitFor(() => expect(screen.queryByTestId('calendar-routine-popover')).toBeNull())
    expect(strip).toHaveAttribute('aria-expanded', 'false')
    expect(strip).not.toHaveAttribute('data-open')
  })
})

describe('the Routines switch', () => {
  it('carries the run total as a numeral and in its title, and keeps its name', async () => {
    serve(
      [{ id: 't1', title: 'Any task', status: 'todo', createdAt: earlierToday() }],
      [{ routine: ROUTINE, count: 24 }],
    )
    const user = userEvent.setup()
    renderBoard()
    await screen.findByTestId('calendar-routine-run')

    const toggle = screen.getByRole('button', { name: 'Routines' })
    expect(toggle).toBe(screen.getByTestId('board-routines-toggle'))
    const count = screen.getByTestId('board-routines-count')
    expect(toggle).toContainElement(count)
    expect(count).toHaveTextContent(/^24$/)
    expect(count).toHaveAttribute('aria-hidden', 'true')
    expect(count).toHaveClass('text-foreground')
    expect(toggle).toHaveAttribute('title', 'Hide 24 upcoming routine runs')

    // Off: the runs leave the grid, but the switch still says how many there are.
    await user.click(toggle)
    expect(toggle).toHaveAttribute('aria-pressed', 'false')
    expect(screen.queryByTestId('calendar-routine-run')).toBeNull()
    expect(screen.getByTestId('board-routines-count')).toHaveTextContent(/^24$/)
    expect(screen.getByTestId('board-routines-count')).toHaveClass('text-muted-foreground')
    expect(toggle).toHaveAttribute('title', 'Show 24 upcoming routine runs')
    expect(toggle).toHaveAccessibleName('Routines')

    await user.click(toggle)
    expect(toggle).toHaveAttribute('aria-pressed', 'true')
    expect(await screen.findByTestId('calendar-routine-run')).toBeInTheDocument()
    expect(toggle).toHaveAttribute('title', 'Hide 24 upcoming routine runs')
  })

  it('names a single run in the singular', async () => {
    serve(
      [{ id: 't1', title: 'Any task', status: 'todo', createdAt: earlierToday() }],
      [{ routine: ROUTINE, count: 1 }],
    )
    renderBoard()
    await screen.findByTestId('calendar-routine-run')
    expect(screen.getByTestId('board-routines-count')).toHaveTextContent(/^1$/)
    expect(screen.getByTestId('board-routines-toggle')).toHaveAttribute(
      'title',
      'Hide 1 upcoming routine run',
    )
  })

  it('marks a total the server capped with a plus, on the switch and in the day’s tooltip', async () => {
    serve(
      [{ id: 't1', title: 'Any task', status: 'todo', createdAt: earlierToday() }],
      [{ routine: ROUTINE, count: 24, more: true }],
    )
    renderBoard()
    const strip = await screen.findByTestId('calendar-routine-run')
    expect(screen.getByTestId('board-routines-count')).toHaveTextContent(/^24\+$/)
    expect(screen.getByTestId('board-routines-toggle')).toHaveAttribute(
      'title',
      'Hide 24+ upcoming routine runs',
    )
    expect(within(strip).getByText('24+ runs')).toBeInTheDocument()
    expect(dateButton(Date.now())).toHaveAttribute(
      'title',
      `${longDate(Date.now())}, today. 1 task, 24+ runs. Click to highlight the day.`,
    )
  })

  it('shows no numeral while no run is coming', async () => {
    let answered = false
    serve([{ id: 't1', title: 'Any task', status: 'todo', createdAt: earlierToday() }])
    server.use(
      http.get('/api/schedules/occurrences', () => {
        answered = true
        return HttpResponse.json({ now: Date.now(), routines: [] })
      }),
    )
    renderBoard()
    await screen.findByTestId('board-calendar')
    await waitFor(() => expect(answered).toBe(true))
    expect(screen.queryByTestId('board-routines-count')).toBeNull()
    expect(screen.getByTestId('board-routines-toggle')).toHaveAttribute(
      'title',
      'Hide upcoming routine runs',
    )
    expect(screen.getByTestId('board-routines-toggle')).toHaveAccessibleName('Routines')
  })
})

describe('the range title', () => {
  it('puts a comma between a week’s dates and its year, and none in a month', async () => {
    serve([{ id: 't1', title: 'Any task', status: 'todo', createdAt: earlierToday() }])
    const user = userEvent.setup()
    renderBoard()
    await screen.findByTestId('board-calendar')

    const parts = () =>
      Array.from(screen.getByTestId('board-range-title').children).filter(
        (el) => el.tagName === 'SPAN',
      ) as HTMLElement[]
    const week = thisWeek()
    const first = new Date(week.start)
    const last = new Date(week.days[6]!)
    const md: Intl.DateTimeFormatOptions = { month: 'short', day: 'numeric' }
    if (first.getFullYear() === last.getFullYear()) {
      const end =
        first.getMonth() === last.getMonth()
          ? String(last.getDate())
          : last.toLocaleDateString(undefined, md)
      // "Oct 11 to 17," then "2026", the year in a lighter weight.
      expect(parts().map((p) => p.textContent)).toEqual([
        `${first.toLocaleDateString(undefined, md)} to ${end},`,
        String(first.getFullYear()),
      ])
      expect(parts()[1]).toHaveClass('font-normal', 'text-muted-foreground')
    } else {
      // A week across New Year carries both years in its dates, and no comma after.
      expect(parts()).toHaveLength(1)
      expect(parts()[0]!.textContent).not.toMatch(/,$/)
    }

    // "October" then "2026".
    await user.click(screen.getByRole('radio', { name: 'Month' }))
    expect(parts().map((p) => p.textContent)).toEqual([
      new Date().toLocaleDateString(undefined, { month: 'long' }),
      String(new Date().getFullYear()),
    ])
    expect(screen.getByTestId('board-range-title').textContent).not.toContain(',')
  })
})

describe('the cards in the cells', () => {
  it('marks the card whose drawer is open, and only while it is open', async () => {
    const at = earlierToday()
    const task = { id: 't1', title: 'Draft the launch note', status: 'todo' }
    serve([
      { ...task, createdAt: at },
      { id: 't2', title: 'Second task', status: 'todo', createdAt: at + 1 },
    ])
    serveDrawer(task)
    const user = userEvent.setup()
    renderBoard()
    await screen.findByTestId('board-calendar')
    expect(cardFor('Draft the launch note')).not.toHaveAttribute('data-open')

    await user.click(cardFor('Draft the launch note'))
    await screen.findByTestId('task-detail-drawer')
    expect(cardFor('Draft the launch note')).toHaveAttribute('data-open', 'true')
    expect(cardFor('Second task')).not.toHaveAttribute('data-open')

    await user.keyboard('{Escape}')
    await waitFor(() => expect(screen.queryByTestId('task-detail-drawer')).toBeNull())
    expect(cardFor('Draft the launch note')).not.toHaveAttribute('data-open')
  })

  it('steps finished work on a past day back, and leaves today’s and open work alone', async () => {
    const lastWeekDay = addDays(thisWeek().start, -3) + 10 * HOUR
    const finished = earlierToday()
    serve([
      {
        id: 'a',
        title: 'Shipped last week',
        status: 'done',
        createdAt: lastWeekDay,
        updatedAt: lastWeekDay,
        completedAt: lastWeekDay,
      },
      {
        id: 'b',
        title: 'Started last week',
        status: 'in_progress',
        createdAt: lastWeekDay,
        updatedAt: lastWeekDay,
      },
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
    await screen.findByTestId('board-calendar')
    expect(
      within(screen.getByTestId(`calendar-cell-done-${dayKey(finished)}`)).getByText(
        'Shipped today',
      ),
    ).toBeInTheDocument()
    expect(cardFor('Shipped today')).not.toHaveAttribute('data-past')
    // Open work from before the week rides in Earlier, at rest.
    expect(cardFor('Started last week')).not.toHaveAttribute('data-past')

    await user.click(screen.getByRole('button', { name: /^Previous week/ }))
    await screen.findByText('Shipped last week')
    expect(
      within(screen.getByTestId(`calendar-cell-done-${dayKey(lastWeekDay)}`)).getByText(
        'Shipped last week',
      ),
    ).toBeInTheDocument()
    expect(cardFor('Shipped last week')).toHaveAttribute('data-past', 'true')
    expect(cardFor('Started last week')).not.toHaveAttribute('data-past')
  })
})

describe('the date picker', () => {
  it('pages by keyboard, slides each new month in from its side, and keeps focus on the day', async () => {
    serve([{ id: 't1', title: 'Any task', status: 'todo', createdAt: earlierToday() }])
    const user = userEvent.setup()
    renderBoard()
    await screen.findByTestId('board-calendar')
    await user.click(screen.getByTestId('board-range-title'))
    const picker = await screen.findByTestId('calendar-mini-month')
    const monthName = (ms: number) =>
      new Date(ms).toLocaleDateString(undefined, { month: 'long', year: 'numeric' })
    const tbody = () => picker.querySelector('tbody') as HTMLElement
    const focusedDay = () => document.activeElement?.getAttribute('data-day')

    const today = startOfDay(Date.now())
    await waitFor(() => expect(focusedDay()).toBe(dayKey(today)))
    // Opening slides nothing.
    expect(tbody().className).not.toMatch(/board-month-in/)
    expect(picker).toHaveClass('board-pop-in')

    const ahead = sameDayNextMonth(today)
    await user.keyboard('{PageDown}')
    expect(within(picker).getByRole('heading')).toHaveTextContent(monthName(ahead))
    expect(tbody()).toHaveClass('board-month-in-next')
    await waitFor(() => expect(focusedDay()).toBe(dayKey(ahead)))

    await user.keyboard('{PageUp}')
    expect(within(picker).getByRole('heading')).toHaveTextContent(monthName(today))
    expect(tbody()).toHaveClass('board-month-in-prev')
    // A month step keeps the day number where the month has it.
    const back = new Date(
      new Date(today).getFullYear(),
      new Date(today).getMonth(),
      new Date(ahead).getDate(),
    ).getTime()
    await waitFor(() => expect(focusedDay()).toBe(dayKey(back)))

    // Walk to the month's last day, then one step past it.
    for (let d = new Date(back).getDate(); d < lastDateOf(today); d++) {
      await user.keyboard('{ArrowRight}')
    }
    const last = new Date(
      new Date(today).getFullYear(),
      new Date(today).getMonth(),
      lastDateOf(today),
    )
    await waitFor(() => expect(focusedDay()).toBe(dayKey(last.getTime())))
    expect(tbody()).toHaveClass('board-month-in-prev')

    await user.keyboard('{ArrowRight}')
    const firstNext = addDays(last.getTime(), 1)
    expect(within(picker).getByRole('heading')).toHaveTextContent(monthName(firstNext))
    expect(tbody()).toHaveClass('board-month-in-next')
    await waitFor(() => expect(focusedDay()).toBe(dayKey(firstNext)))
    expect(document.activeElement).toHaveAttribute('tabindex', '0')
  })

  it('keeps focus on the month button that paged it', async () => {
    serve([{ id: 't1', title: 'Any task', status: 'todo', createdAt: earlierToday() }])
    const user = userEvent.setup()
    renderBoard()
    await screen.findByTestId('board-calendar')
    await user.click(screen.getByTestId('board-range-title'))
    const picker = await screen.findByTestId('calendar-mini-month')
    const monthName = (ms: number) =>
      new Date(ms).toLocaleDateString(undefined, { month: 'long', year: 'numeric' })
    const tbody = () => picker.querySelector('tbody') as HTMLElement
    await waitFor(() =>
      expect(document.activeElement).toHaveAttribute('data-day', dayKey(Date.now())),
    )

    const next = within(picker).getByRole('button', { name: 'Next month' })
    await user.click(next)
    const nextMonth = startOfMonth(addDays(startOfMonth(Date.now()), 40))
    expect(within(picker).getByRole('heading')).toHaveTextContent(monthName(nextMonth))
    expect(tbody()).toHaveClass('board-month-in-next')
    expect(next).toHaveFocus()

    const prev = within(picker).getByRole('button', { name: 'Previous month' })
    await user.click(prev)
    expect(within(picker).getByRole('heading')).toHaveTextContent(monthName(Date.now()))
    expect(tbody()).toHaveClass('board-month-in-prev')
    expect(prev).toHaveFocus()
  })
})

describe('the header', () => {
  it('counts the tasks in the column heads in every view, the All view included', async () => {
    serve([
      { id: 't1', title: 'One task', status: 'todo', createdAt: earlierToday() },
      { id: 't2', title: 'Two task', status: 'backlog', createdAt: earlierToday() },
    ])
    const user = userEvent.setup()
    renderBoard()
    await screen.findByTestId('board-calendar')
    const actions = screen.getByRole('button', { name: 'Refresh' }).parentElement as HTMLElement
    for (const view of ['Week', 'Month', 'All', 'Today']) {
      await user.click(screen.getByRole('radio', { name: view }))
      expect(actions.textContent).not.toMatch(/\d+ tasks?/)
      expect(screen.getByTestId('board-column-todo')).toHaveAccessibleName('To do, 1 task')
    }
    // The All view's gutter says how many it holds.
    await user.click(screen.getByRole('radio', { name: 'All' }))
    expect(screen.getByTestId('calendar-row-all')).toHaveTextContent('2 tasks')
  })
})
