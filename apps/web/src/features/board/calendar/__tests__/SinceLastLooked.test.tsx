// "Since you last looked", rendered through the real BoardPanel against msw: the
// line in the header that says what changed while the person was away, the dot
// on each card that changed, how Show steps through them oldest first, how Mark
// seen, resting on a card and opening it clear the marks, how a missing or broken
// record is read, and that a card the person moved themselves is not news to
// them. A renderHook test of useSeenBoard covers the per-team records directly.
//
// The record is seeded in this browser's storage before the board renders, as if
// the person last looked two hours ago. Fixtures are built from "now", so the
// suite holds on any day and in any time zone.

import {
  act,
  cleanup,
  fireEvent,
  render,
  renderHook,
  screen,
  waitFor,
  within,
} from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { http, HttpResponse } from 'msw'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { ThemeProvider } from '@/features/theme/ThemeProvider'
import { useTeamStore } from '@/stores/team'
import { useToastStore } from '@/stores/toast'

import { server } from '../../../../__vitest__/mswServer'
import { BoardPanel } from '../../BoardPanel'
import { sinceLabel } from '../calendarFormat'
import { startOfDay } from '../calendarModel'
import type { SeenRecord } from '../seenModel'
import { useSeenBoard } from '../useSeenBoard'
import { resetBoardStorage } from '../../__tests__/resetBoardStorage'

const HOUR = 3_600_000
const KEY = 'clawboo.board.seen.'
const CHANGED = 'Changed since you last looked.'

/** An instant earlier today (or this very moment just after midnight). */
function earlierToday(): number {
  return Math.max(startOfDay(Date.now()) + 1000, Date.now() - 60_000)
}

/** Serve the board from a list the test can change between reads. */
function serve(tasks: unknown[]): { tasks: unknown[] } {
  const board = { tasks }
  server.use(
    http.get('/api/board', () => HttpResponse.json({ tasks: board.tasks })),
    http.get('/api/teams', () =>
      HttpResponse.json({ teams: [{ id: 'team-1', name: 'Alpha', icon: 'A' }] }),
    ),
    http.get('/api/schedules', () =>
      HttpResponse.json({
        schedules: [],
        sources: [{ sourceId: 'clawboo-routine', ok: true, degraded: false, at: 1 }],
      }),
    ),
  )
  return board
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

/** The titles of every card carrying an unseen dot, sorted. */
function dottedTitles(): string[] {
  return screen
    .queryAllByTestId('board-card-unseen')
    .map((dot) => dot.parentElement?.textContent?.replace(CHANGED, '').trim() ?? '')
    .sort()
}

/** Store a record for a team filter, as a board read on another visit would have. */
function seed(team: string, rec: Omit<SeenRecord, 'v'>): void {
  window.localStorage.setItem(KEY + team, JSON.stringify({ v: 1, ...rec }))
}

/** The record stored for a team filter. */
function stored(team: string): SeenRecord | null {
  const raw = window.localStorage.getItem(KEY + team)
  return raw === null ? null : (JSON.parse(raw) as SeenRecord)
}

const TITLES = {
  a: 'Ship the release notes',
  b: 'Wire the billing page',
  c: 'Draft the launch post',
  d: 'Rotate the deploy key',
  e: 'Tidy the backlog',
}

/**
 * Two hours ago the person saw a in progress, b and e in To do and d in
 * progress, and c did not exist. Since then a finished, b started, d got stuck
 * (so it waits in Needs you) and c was added; e has not moved. Everything sits
 * on today's row. The changes went in a, b, c, d order, by `updatedAt`.
 */
function awayBoard(): { since: number } {
  const at = earlierToday()
  const now = Date.now()
  serve([
    { id: 'e', title: TITLES.e, status: 'todo', createdAt: at, updatedAt: now - 4 * HOUR },
    { id: 'c', title: TITLES.c, status: 'todo', createdAt: at, updatedAt: now - HOUR },
    { id: 'b', title: TITLES.b, status: 'in_progress', createdAt: at, updatedAt: now - 2 * HOUR },
    {
      id: 'a',
      title: TITLES.a,
      status: 'done',
      createdAt: at,
      completedAt: at,
      updatedAt: now - 3 * HOUR,
    },
    { id: 'd', title: TITLES.d, status: 'blocked', createdAt: at, updatedAt: now - HOUR / 2 },
  ])
  const since = now - 2 * HOUR
  seed('all', {
    at: since,
    watching: false,
    columns: { a: 'in_progress', b: 'todo', d: 'in_progress', e: 'todo' },
    pending: null,
  })
  return { since }
}

/** The words of the since line, without its Show and Mark seen actions. */
function sinceWords(): string | null | undefined {
  return screen.getByTestId('board-since').firstElementChild?.textContent
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

describe('since you last looked', () => {
  it('says what changed while the person was away, from the time they last looked', async () => {
    const { since } = awayBoard()
    renderBoard()

    await screen.findByTestId('board-since')
    expect(sinceWords()).toBe(
      `Since ${sinceLabel(since, Date.now())}: 1 done, 1 started, 1 needs you, 1 new`,
    )
    const line = screen.getByTestId('board-since')
    expect(within(line).getByRole('button', { name: 'Show' })).toBeInTheDocument()
    expect(within(line).getByRole('button', { name: 'Mark seen' })).toBeInTheDocument()
    // The line takes the place of the hint about who moves the cards.
    expect(screen.queryByTestId('board-agent-hint')).toBeNull()
  })

  it('puts a dot on each card that changed, and a screen reader hears it', async () => {
    awayBoard()
    renderBoard()
    await screen.findByTestId('board-since')

    expect(dottedTitles()).toEqual([TITLES.a, TITLES.b, TITLES.c].sort())
    // The words come first in the card's name, ahead of its title.
    for (const title of [TITLES.a, TITLES.b, TITLES.c]) {
      expect(cardFor(title)).toHaveAccessibleName(
        new RegExp(`^Changed since you last looked\\.\\s*${title}`),
      )
    }
    // A card that has not moved since carries nothing.
    expect(within(cardFor(TITLES.e)).queryByTestId('board-card-unseen')).toBeNull()
    expect(cardFor(TITLES.e)).not.toHaveAccessibleName(/Changed since you last looked/)
  })

  it('counts a card that moved into Needs you without putting a dot on it', async () => {
    awayBoard()
    renderBoard()
    await screen.findByTestId('board-since')

    expect(sinceWords()).toContain('1 needs you')
    const needsYou = screen.getByTestId('calendar-needs-you-today')
    expect(within(needsYou).getByText(TITLES.d)).toBeInTheDocument()
    expect(within(needsYou).queryByTestId('board-card-unseen')).toBeNull()
    expect(dottedTitles()).not.toContain(TITLES.d)
  })

  it('steps through the changes oldest first with Show, then goes to Needs you', async () => {
    const { since } = awayBoard()
    const user = userEvent.setup()
    renderBoard()
    await screen.findByTestId('board-since')
    const show = () => user.click(screen.getByRole('button', { name: 'Show' }))

    // a changed first, so Show brings it into view, focused, and takes its dot off.
    await show()
    await waitFor(() => expect(cardFor(TITLES.a)).toHaveFocus())
    expect(dottedTitles()).toEqual([TITLES.b, TITLES.c].sort())
    expect(sinceWords()).toBe(
      `Since ${sinceLabel(since, Date.now())}: 1 started, 1 needs you, 1 new`,
    )

    await show()
    await waitFor(() => expect(cardFor(TITLES.b)).toHaveFocus())
    expect(dottedTitles()).toEqual([TITLES.c])

    await show()
    await waitFor(() => expect(cardFor(TITLES.c)).toHaveFocus())
    expect(dottedTitles()).toEqual([])
    // What moved into Needs you is still counted.
    expect(sinceWords()).toBe(`Since ${sinceLabel(since, Date.now())}: 1 needs you`)

    // With no dotted card left, Show goes to Needs you, and that was the last change.
    await show()
    await waitFor(() => expect(screen.getByTestId('calendar-needs-you-today')).toHaveFocus())
    expect(screen.queryByTestId('board-since')).toBeNull()
    expect(screen.getByTestId('board-agent-hint')).toBeInTheDocument()
  })

  it('clears the line and every dot with Mark seen, and the agent hint returns', async () => {
    awayBoard()
    const user = userEvent.setup()
    renderBoard()
    await screen.findByTestId('board-since')
    expect(dottedTitles()).toHaveLength(3)

    await user.click(screen.getByRole('button', { name: 'Mark seen' }))

    expect(screen.queryByTestId('board-since')).toBeNull()
    expect(dottedTitles()).toEqual([])
    expect(screen.getByTestId('board-agent-hint')).toHaveTextContent(
      'Agents create and move work here.',
    )
    expect(stored('all')?.pending).toBeNull()
    // The line went with the button in it, so focus moves to the range title
    // rather than falling to the page, and a screen reader hears what happened.
    await waitFor(() => expect(screen.getByTestId('board-range-title')).toHaveFocus())
    expect(screen.getByTestId('board-calendar-announcer')).toHaveTextContent(
      'Everything marked seen.',
    )
  })

  it('clears a dot once the pointer rests on the card for a moment, not on a pass', async () => {
    awayBoard()
    renderBoard()
    await screen.findByTestId('board-since')
    // The look timer is a timeout; only it is faked, after the board has loaded.
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const card = cardFor(TITLES.c)
    const advance = (ms: number) =>
      act(() => {
        vi.advanceTimersByTime(ms)
      })

    // Passing over it on the way somewhere else does not count.
    fireEvent.pointerEnter(card)
    advance(300)
    fireEvent.pointerLeave(card)
    advance(600)
    expect(within(cardFor(TITLES.c)).getByTestId('board-card-unseen')).toBeInTheDocument()

    // Half the rest is not enough either.
    fireEvent.pointerEnter(card)
    advance(300)
    expect(within(cardFor(TITLES.c)).getByTestId('board-card-unseen')).toBeInTheDocument()

    // The full 600ms is a look.
    advance(300)
    expect(within(cardFor(TITLES.c)).queryByTestId('board-card-unseen')).toBeNull()
    expect(dottedTitles()).toEqual([TITLES.a, TITLES.b].sort())
    expect(stored('all')?.pending?.items).not.toHaveProperty('c')
  })

  it('clears a dot when the card is opened', async () => {
    awayBoard()
    serveDrawer({ id: 'b', title: TITLES.b, status: 'in_progress' })
    renderBoard()
    await screen.findByTestId('board-since')

    // A click with no rest before it, so only opening can have cleared the dot.
    fireEvent.click(cardFor(TITLES.b))
    expect(within(cardFor(TITLES.b)).queryByTestId('board-card-unseen')).toBeNull()
    expect(dottedTitles()).toEqual([TITLES.a, TITLES.c].sort())
    await screen.findByTestId('task-detail-drawer')
  })
})

describe('reading the record', () => {
  const TASKS = () => [
    { id: 't1', title: 'Wire the widget', status: 'todo', createdAt: earlierToday() },
    { id: 't2', title: 'Review the copy', status: 'in_progress', createdAt: earlierToday() },
  ]

  it('marks nothing on the first look, when no record is stored', async () => {
    serve(TASKS())
    renderBoard()
    await screen.findByTestId('board-calendar')

    expect(screen.getByTestId('board-agent-hint')).toBeInTheDocument()
    expect(screen.queryByTestId('board-since')).toBeNull()
    expect(dottedTitles()).toEqual([])
    // The look is remembered, for next time.
    await waitFor(() =>
      expect(stored('all')).toMatchObject({
        v: 1,
        columns: { t1: 'todo', t2: 'in_progress' },
        pending: null,
      }),
    )
  })

  it.each([
    ['is not JSON', '{"v":1,"at":'],
    [
      'is another version',
      JSON.stringify({ v: 2, at: 1, watching: false, columns: {}, pending: null }),
    ],
    [
      'has a column that is not a word',
      JSON.stringify({ v: 1, at: 1, watching: false, columns: { t1: 3 }, pending: null }),
    ],
    [
      'has a change of no known kind',
      JSON.stringify({
        v: 1,
        at: 1,
        watching: false,
        columns: {},
        pending: { since: 1, items: { t1: 'exploded' } },
      }),
    ],
  ])('ignores a record that %s, and starts again from this look', async (_, raw) => {
    window.localStorage.setItem(`${KEY}all`, raw)
    serve(TASKS())
    renderBoard()
    await screen.findByTestId('board-calendar')

    expect(screen.getByTestId('board-agent-hint')).toBeInTheDocument()
    expect(dottedTitles()).toEqual([])
    await waitFor(() =>
      expect(stored('all')).toMatchObject({
        v: 1,
        columns: { t1: 'todo', t2: 'in_progress' },
        pending: null,
      }),
    )
  })

  it('does not count a card the person moved themselves on the next read taken while away', async () => {
    // No polls, so every read is one the test asks for.
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] })
    const at = earlierToday()
    const board = serve([
      { id: 'm', title: 'Move this one myself', status: 'todo', createdAt: at },
      { id: 'n', title: 'An agent finishes this', status: 'todo', createdAt: at },
    ])
    const find = (id: string) =>
      (board.tasks as Array<{ id: string; status: string }>).find((t) => t.id === id)!
    server.use(
      http.get('/api/board/m', () =>
        HttpResponse.json({ task: { ...find('m') }, comments: [], ancestors: [] }),
      ),
      http.get('/api/board/m/executions', () => HttpResponse.json({ executions: [] })),
      http.get('/api/board/m/workspace/detail', () => HttpResponse.json({ ok: false })),
      http.get('/api/obs/events', () => HttpResponse.json({ events: [] })),
      http.patch('/api/board/m', async ({ request }) => {
        const { status } = (await request.json()) as { status: string }
        find('m').status = status // the server advances
        return HttpResponse.json({ ok: true, task: { id: 'm', status } })
      }),
    )
    seed('all', {
      at: Date.now() - 2 * HOUR,
      watching: false,
      columns: { m: 'todo', n: 'todo' },
      pending: null,
    })
    const user = userEvent.setup()
    renderBoard()
    await screen.findByTestId('board-calendar')
    expect(screen.getByTestId('board-agent-hint')).toBeInTheDocument()

    await user.click(cardFor('Move this one myself'))
    await screen.findByTestId('task-detail-drawer')
    await user.click(screen.getByTestId('task-status-select'))
    const option = await screen.findByRole('option', { name: 'Backlog' })

    // From here the person is away: the page has lost focus, and an agent
    // finishes the other card meanwhile.
    vi.spyOn(document, 'hasFocus').mockReturnValue(false)
    Object.assign(find('n'), { status: 'done', completedAt: at })
    await user.click(option)
    await waitFor(() =>
      expect(
        within(screen.getByTestId('board-column-backlog')).getByText('Move this one myself'),
      ).toBeInTheDocument(),
    )
    await user.keyboard('{Escape}')
    await waitFor(() => expect(screen.queryByTestId('task-detail-drawer')).toBeNull())

    await user.click(screen.getByRole('button', { name: 'Refresh' }))
    await screen.findByTestId('board-since')

    // The agent's change is news; the person's own move is not.
    const since = stored('all')!.pending!.since
    expect(sinceWords()).toBe(`Since ${sinceLabel(since, Date.now())}: 1 done`)
    expect(stored('all')?.pending?.items).toEqual({ n: 'done' })
    expect(dottedTitles()).toEqual(['An agent finishes this'])
    expect(within(cardFor('Move this one myself')).queryByTestId('board-card-unseen')).toBeNull()
  })
})

describe('useSeenBoard', () => {
  const AT = Date.now() - 2 * HOUR
  const NONE = { done: 0, started: 0, needs_you: 0, new: 0, cancelled: 0, moved: 0 }

  /** All teams sees x, y and z; Alpha holds x and y, Beta holds z. Each record
   *  was taken on another visit and holds changes not looked at yet. */
  function seedTeams(): void {
    seed('all', {
      at: AT,
      watching: false,
      columns: { x: 'done', y: 'in_progress', z: 'todo' },
      pending: { since: AT - HOUR, items: { x: 'done', y: 'started', z: 'new' } },
    })
    seed('team-1', {
      at: AT,
      watching: false,
      columns: { x: 'done', y: 'in_progress' },
      pending: { since: AT - HOUR, items: { x: 'done', y: 'started' } },
    })
    seed('team-2', {
      at: AT,
      watching: false,
      columns: { z: 'todo' },
      pending: { since: AT, items: { z: 'new' } },
    })
  }

  it('reads and writes the record kept for the team filter it is given', () => {
    seedTeams()
    const { result, rerender } = renderHook(({ team }) => useSeenBoard(team), {
      initialProps: { team: 'team-1' },
    })
    expect(result.current.summary).toEqual({
      since: AT - HOUR,
      counts: { ...NONE, done: 1, started: 1 },
      total: 2,
    })
    expect([...result.current.dotted].sort()).toEqual(['x', 'y'])

    // A read for Alpha lands under Alpha's key only. It is the first since the
    // board opened, so y finishing is news even with the page in focus.
    const allBefore = window.localStorage.getItem(`${KEY}all`)
    act(() =>
      result.current.noteBoardRead('team-1', [
        { id: 'x', column: 'done' },
        { id: 'y', column: 'done' },
      ]),
    )
    expect(stored('team-1')?.pending).toEqual({ since: AT - HOUR, items: { x: 'done', y: 'done' } })
    expect(result.current.summary?.counts).toEqual({ ...NONE, done: 2 })
    expect(window.localStorage.getItem(`${KEY}all`)).toBe(allBefore)

    rerender({ team: 'team-2' })
    expect(result.current.summary).toEqual({ since: AT, counts: { ...NONE, new: 1 }, total: 1 })
    expect(result.current.pending).toEqual({ z: 'new' })

    // A team filter with no record marks nothing.
    rerender({ team: 'team-3' })
    expect(result.current.summary).toBeNull()
    expect(result.current.dotted.size).toBe(0)
  })

  it('clears an acknowledged change under every stored team record', () => {
    seedTeams()
    const { result } = renderHook(() => useSeenBoard('team-1'))

    // Beta's record was never read by this board, only stored; it is cleared too.
    act(() => result.current.acknowledge(['x', 'z']))

    expect(stored('all')?.pending).toEqual({ since: AT - HOUR, items: { y: 'started' } })
    expect(stored('team-1')?.pending).toEqual({ since: AT - HOUR, items: { y: 'started' } })
    expect(stored('team-2')?.pending).toBeNull()
    // Looking changes nothing else in a record.
    expect(stored('team-2')).toMatchObject({ at: AT, columns: { z: 'todo' } })
    expect([...result.current.dotted]).toEqual(['y'])
  })

  it('clears its own team with Mark seen, and the same changes under every other team', () => {
    seedTeams()
    const { result } = renderHook(() => useSeenBoard('team-1'))

    act(() => result.current.markAllSeen())

    expect(result.current.summary).toBeNull()
    expect(stored('team-1')?.pending).toBeNull()
    // x and y were Alpha's changes, so All teams has looked at them too; z is
    // Beta's, and is still news there and under All teams.
    expect(stored('all')?.pending).toEqual({ since: AT - HOUR, items: { z: 'new' } })
    expect(stored('team-2')?.pending).toEqual({ since: AT, items: { z: 'new' } })
  })

  it('takes a card read on the board as seen under the views that show it', () => {
    seedTeams()
    const { result } = renderHook(() => useSeenBoard('all'))
    // A read of All teams, where nothing has moved since, tells the hook which
    // team each card belongs to.
    act(() =>
      result.current.noteBoardRead('all', [
        { id: 'x', column: 'done', teamId: 'team-1' },
        { id: 'y', column: 'in_progress', teamId: 'team-1' },
        { id: 'z', column: 'todo', teamId: 'team-2' },
      ]),
    )

    act(() => result.current.acknowledge(['x']))

    // Alpha's record was never read by this board, only stored; it is cleared too.
    expect(stored('all')?.pending?.items).toEqual({ y: 'started', z: 'new' })
    expect(stored('team-1')?.pending?.items).toEqual({ y: 'started' })
    expect(stored('team-2')?.pending?.items).toEqual({ z: 'new' })
    expect([...result.current.dotted].sort()).toEqual(['y', 'z'])
  })
})
