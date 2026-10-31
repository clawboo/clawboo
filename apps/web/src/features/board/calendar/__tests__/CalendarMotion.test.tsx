// The Board calendar's motion, rendered through the real BoardPanel against msw:
// which cards an agent just moved get marked, the settle after the person moves or
// adds a card, today's ping, where the Today button points, how the lifted card is
// let go, the scroll marks the sticky header and gutter key their shadows on, what
// the range announcer says, and which way a new range slides in.
//
// Fixtures are built from "now", so the suite holds on any day and in any time
// zone. A test that jumps the clock fakes Date: the arrival tests also stop the
// interval polls, so every board read is one the test asked for, and the ping
// tests fake the timers too, running on at the real pace so msw and React keep
// going while a test makes a timer fire now.

import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { http, HttpResponse } from 'msw'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { ThemeProvider } from '@/features/theme/ThemeProvider'
import { ToastContainer } from '@/features/ui/ToastContainer'
import { useFleetStore } from '@/stores/fleet'
import { useTeamStore } from '@/stores/team'
import { useToastStore } from '@/stores/toast'

import { server } from '../../../../__vitest__/mswServer'
import { BoardPanel } from '../../BoardPanel'
import { longDate } from '../calendarFormat'
import { buildRange, dayKey, localeWeekStart, startOfDay } from '../calendarModel'
import { pickView, pollBoard } from '../../__tests__/boardControls'
import { resetBoardStorage } from '../../__tests__/resetBoardStorage'

// dnd-kit's real drag can't run in jsdom, so the real handlers are captured and
// called with hand-built events. Its overlay only draws during a drag dnd-kit
// started itself, so it is swapped for one that draws what the board hands it and
// keeps the drop animation it was given on its latest render.
const dnd = vi.hoisted(() => ({
  onDragStart: undefined as undefined | ((e: unknown) => void),
  onDragOver: undefined as undefined | ((e: unknown) => void),
  onDragEnd: undefined as undefined | ((e: unknown) => void),
  onDragCancel: undefined as undefined | (() => void),
  dropAnimation: undefined as unknown,
}))
vi.mock('@/lib/useVisiblePolling', async (importOriginal) =>
  (await import('../../__tests__/boardControls')).pollingByHand(await importOriginal()),
)

vi.mock('@dnd-kit/core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@dnd-kit/core')>()
  return {
    ...actual,
    DndContext: (props: React.ComponentProps<typeof actual.DndContext>) => {
      dnd.onDragStart = props.onDragStart as (e: unknown) => void
      dnd.onDragOver = props.onDragOver as (e: unknown) => void
      dnd.onDragEnd = props.onDragEnd as (e: unknown) => void
      dnd.onDragCancel = props.onDragCancel as () => void
      return <actual.DndContext {...props} />
    },
    DragOverlay: (props: React.ComponentProps<typeof actual.DragOverlay>) => {
      dnd.dropAnimation = props.dropAnimation
      return <div data-testid="drag-overlay">{props.children}</div>
    },
  }
})

// Where the calendar's range wrapper starts each time it mounts, read from the
// `initial` it hands framer-motion. Every other motion.div renders as it would.
const slides = vi.hoisted(() => ({ grid: [] as Array<{ opacity?: number; x?: number }> }))
vi.mock('framer-motion', async (importOriginal) => {
  const actual = await importOriginal<typeof import('framer-motion')>()
  const { createElement, forwardRef, useState } = await import('react')
  const RealDiv = actual.motion.div
  type DivProps = React.ComponentProps<typeof RealDiv>
  const Div = forwardRef<HTMLDivElement, DivProps>(function RecordingDiv(props, ref) {
    useState(() => {
      const child = props.children as { type?: { name?: string } } | null | undefined
      if (child?.type?.name === 'CalendarGrid') {
        slides.grid.push(props.initial as { opacity?: number; x?: number })
      }
      return null
    })
    return createElement(RealDiv, { ...props, ref })
  })
  const motion = new Proxy(actual.motion, {
    get: (target, key, receiver) => (key === 'div' ? Div : Reflect.get(target, key, receiver)),
  })
  return { ...actual, motion }
})

const SECOND = 1000
const DAY = 86_400_000
/** How the lifted card flies back to its cell when letting go does not move it. */
const RETURN_FLIGHT = { duration: 200, easing: 'cubic-bezier(0.32,0.72,0,1)' }

const ALPHA = {
  id: 'team-1',
  name: 'Alpha',
  icon: '🐙',
  color: '#e94560',
  colorCollectionId: null,
  templateId: null,
  agentCount: 2,
  leaderAgentId: null,
  isArchived: false,
  serverOrchestrated: true,
}

function thisWeek() {
  return buildRange('week', Date.now(), localeWeekStart())
}

/** An instant earlier today (or this very moment just after midnight). */
function earlierToday(): number {
  return Math.max(startOfDay(Date.now()) + 1000, Date.now() - 60_000)
}

/** Serve the board from a list the test can change between reads, and count the reads. */
function serveBoard(tasks: unknown[]): { tasks: unknown[]; reads: number } {
  const board = { tasks, reads: 0 }
  server.use(
    http.get('/api/board', () => {
      board.reads += 1
      return HttpResponse.json({ tasks: board.tasks })
    }),
  )
  return board
}

function renderBoard() {
  return render(
    <ThemeProvider>
      <BoardPanel />
      <ToastContainer />
    </ThemeProvider>,
  )
}

/** Freezes Date where the test sets it and stops the interval polls, so every
 *  board read is one the test asked for. Timeouts run as normal. */
function freezeClock(): void {
  vi.useFakeTimers({ toFake: ['Date', 'setInterval', 'clearInterval'] })
}

/** Fakes Date and the timers, still running at the real pace, so a test can jump
 *  ahead or make a timer fire now. Returns a user driving the same clock. */
function fakeClock() {
  vi.useFakeTimers({
    toFake: ['Date', 'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'],
    shouldAdvanceTime: true,
  })
  return userEvent.setup({ advanceTimers: vi.advanceTimersByTime })
}

async function advance(ms: number): Promise<void> {
  await act(async () => {
    vi.advanceTimersByTime(ms)
  })
}

/** Waits for a toast to say `message`, where a sighted person sees it. */
async function toastSays(message: string): Promise<void> {
  await within(screen.getByRole('region', { name: 'Notifications' })).findByText(message)
}

/** The card showing a task's title. */
function cardFor(title: string, scope: HTMLElement = document.body): HTMLElement {
  const card = within(scope).getByText(title).closest('[data-testid="board-card"]')
  expect(card).not.toBeNull()
  return card as HTMLElement
}

/** The titles of every card marked as an agent's move, sorted. */
function arrivedTitles(): string[] {
  return Array.from(document.querySelectorAll('.calendar-chip--arrived'))
    .map((el) => el.firstElementChild?.textContent ?? '')
    .sort()
}

function todayRow(): HTMLElement {
  return screen.getByTestId(`calendar-day-${dayKey(Date.now())}`)
}

/** Records the moment each ping is drawn, so a ping that came and went between
 *  two looks still counts. */
function watchPings(): { seen: number[]; stop: () => void } {
  const seen: number[] = []
  const observer = new MutationObserver((records) => {
    for (const record of records) {
      for (const node of Array.from(record.addedNodes)) {
        if (!(node instanceof Element)) continue
        if (node.matches('.board-today-ping') || node.querySelector('.board-today-ping')) {
          seen.push(Date.now())
        }
      }
    }
  })
  observer.observe(document.body, { childList: true, subtree: true })
  return { seen, stop: () => observer.disconnect() }
}

function preferReducedMotion(): void {
  vi.spyOn(window, 'matchMedia').mockImplementation(
    (query: string) =>
      ({
        matches: query.includes('prefers-reduced-motion'),
        media: query,
        onchange: null,
        addListener: () => {},
        removeListener: () => {},
        addEventListener: () => {},
        removeEventListener: () => {},
        dispatchEvent: () => false,
      }) as unknown as MediaQueryList,
  )
}

/** Resize observers the board makes, so a test can tell it the grid grew. */
function watchResizes(): { grow: (el: Element) => void } {
  const observers = new Set<{ notify: () => void; targets: Element[] }>()
  class FakeResizeObserver {
    private readonly entry: { notify: () => void; targets: Element[] }
    constructor(callback: ResizeObserverCallback) {
      this.entry = { notify: () => callback([], this as unknown as ResizeObserver), targets: [] }
      observers.add(this.entry)
    }
    observe(el: Element): void {
      this.entry.targets.push(el)
    }
    unobserve(): void {}
    disconnect(): void {
      observers.delete(this.entry)
    }
  }
  vi.stubGlobal('ResizeObserver', FakeResizeObserver)
  return {
    grow: (el) => {
      for (const o of observers) if (o.targets.includes(el)) o.notify()
    },
  }
}

function rect(r: { top: number; bottom: number }): DOMRect {
  return {
    x: 0,
    y: r.top,
    top: r.top,
    bottom: r.bottom,
    left: 0,
    right: 1200,
    width: 1200,
    height: r.bottom - r.top,
    toJSON: () => ({}),
  } as DOMRect
}

/** Gives the board's scroll container a smooth scrollTo and room to scroll, with
 *  today's row 600px down it, as a laid-out browser would. */
function smoothScroller(): HTMLElement {
  const el = scroller()
  Object.defineProperty(el, 'scrollTo', { configurable: true, value: vi.fn() })
  Object.defineProperty(el, 'scrollHeight', { configurable: true, get: () => 5000 })
  Object.defineProperty(el, 'clientHeight', { configurable: true, get: () => 600 })
  vi.spyOn(todayRow(), 'getBoundingClientRect').mockReturnValue(rect({ top: 600, bottom: 680 }))
  return el
}

/** Which way the Today chevron points, in degrees clockwise from straight up. */
function pointing(): number {
  const style = screen.getByTestId('board-today-direction').getAttribute('style') ?? ''
  const turn = /rotate\((-?[\d.]+)deg\)/.exec(style)
  expect(turn).not.toBeNull()
  return ((Number(turn![1]) % 360) + 360) % 360
}

function todayButton(): HTMLElement {
  return screen.getByRole('button', { name: 'Go to today' })
}

function scroller(): HTMLElement {
  const el = screen.getByTestId('board-calendar').closest('.overflow-auto')
  expect(el).not.toBeNull()
  return el as HTMLElement
}

beforeEach(() => {
  useTeamStore.setState({ teams: [], selectedTeamId: null })
  useFleetStore.setState({ agents: [] })
  useToastStore.setState({ toasts: [] })
  resetBoardStorage()
  dnd.dropAnimation = undefined
  slides.grid = []
})
afterEach(() => {
  cleanup()
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe('cards an agent just moved', () => {
  it('marks the cards an agent moved or added, and only those, then puts the mark out', async () => {
    freezeClock()
    const at = earlierToday()
    const board = serveBoard([
      { id: 'a', title: 'Moved by an agent', status: 'todo', createdAt: at },
      { id: 'c', title: 'Left alone', status: 'todo', createdAt: at + 1 },
    ])
    renderBoard()
    await screen.findByTestId('board-calendar')
    // The first read has nothing to compare with.
    expect(arrivedTitles()).toEqual([])

    board.tasks = [
      { id: 'a', title: 'Moved by an agent', status: 'in_progress', createdAt: at },
      { id: 'c', title: 'Left alone', status: 'todo', createdAt: at + 1 },
      { id: 'b', title: 'Brand new', status: 'todo', createdAt: at + 2 },
    ]
    await pollBoard()
    await screen.findByText('Brand new')
    expect(arrivedTitles()).toEqual(['Brand new', 'Moved by an agent'])
    const today = dayKey(at)
    expect(
      cardFor('Moved by an agent', screen.getByTestId(`calendar-cell-in_progress-${today}`)),
    ).toHaveClass('calendar-chip--arrived')
    expect(cardFor('Left alone')).not.toHaveClass('calendar-chip--arrived')

    // The mark plays once, then the card is drawn at rest.
    await waitFor(() => expect(arrivedTitles()).toEqual([]), { timeout: 3000 })
  })

  it('marks at most six at once, and leaves out a card that went to Needs you', async () => {
    freezeClock()
    const at = earlierToday()
    const moved = Array.from({ length: 8 }, (_, i) => `m${i + 1}`)
    const board = serveBoard([
      { id: 'n', title: 'Now needs a person', status: 'todo', createdAt: at },
      ...moved.map((id, i) => ({ id, title: `Task ${id}`, status: 'todo', createdAt: at + i + 1 })),
    ])
    renderBoard()
    await screen.findByTestId('board-calendar')

    // Read order decides which six: the Needs you card comes first and must not
    // use up a place. Three cells take the eight, so every card is on screen.
    const to = ['in_progress', 'in_progress', 'in_progress', 'backlog', 'backlog', 'backlog']
    board.tasks = [
      { id: 'n', title: 'Now needs a person', status: 'blocked', createdAt: at, updatedAt: at },
      ...moved.map((id, i) =>
        i < 6
          ? { id, title: `Task ${id}`, status: to[i], createdAt: at + i + 1 }
          : { id, title: `Task ${id}`, status: 'done', createdAt: at + i + 1, completedAt: at },
      ),
    ]
    await pollBoard()
    await within(screen.getByTestId('calendar-needs-you-today')).findByText('Now needs a person')

    expect(
      screen.getAllByTestId('board-card').filter((c) => /Task m/.test(c.textContent ?? '')),
    ).toHaveLength(8)
    expect(arrivedTitles()).toEqual([
      'Task m1',
      'Task m2',
      'Task m3',
      'Task m4',
      'Task m5',
      'Task m6',
    ])
    expect(cardFor('Task m7')).not.toHaveClass('calendar-chip--arrived')
    expect(cardFor('Task m8')).not.toHaveClass('calendar-chip--arrived')
  })

  it('marks nothing on the read after the person moved a card, until the quiet spell is over', async () => {
    freezeClock()
    const at = earlierToday()
    const board = serveBoard([
      { id: 'a', title: 'Work in hand', status: 'in_progress', createdAt: at },
    ])
    server.use(
      http.patch('/api/board/a', () =>
        HttpResponse.json({ ok: true, task: { id: 'a', status: 'done' } }),
      ),
    )
    renderBoard()
    await screen.findByTestId('board-calendar')

    await act(async () => {
      dnd.onDragEnd?.({ active: { id: 'a' }, over: { id: 'done' } })
    })
    await toastSays('Marked done.')
    // The server now has the person's move, and a task an agent added meanwhile.
    board.tasks = [
      { id: 'a', title: 'Work in hand', status: 'done', createdAt: at, completedAt: Date.now() },
      { id: 'z', title: 'Added meanwhile', status: 'todo', createdAt: at + 1 },
    ]
    await pollBoard()
    await screen.findByText('Added meanwhile')
    expect(arrivedTitles()).toEqual([])

    // Seven seconds on, an agent's move is news again.
    vi.setSystemTime(Date.now() + 7 * SECOND)
    board.tasks = [
      { id: 'a', title: 'Work in hand', status: 'done', createdAt: at, completedAt: at },
      { id: 'z', title: 'Added meanwhile', status: 'in_progress', createdAt: at + 1 },
    ]
    await pollBoard()
    await waitFor(() => expect(arrivedTitles()).toEqual(['Added meanwhile']))
  })

  it('marks nothing on a read that lands while the person’s move is still being saved', async () => {
    freezeClock()
    const at = earlierToday()
    const board = serveBoard([
      { id: 'a', title: 'Work in hand', status: 'in_progress', createdAt: at },
    ])
    let answer: (() => void) | undefined
    server.use(
      http.patch('/api/board/a', async () => {
        await new Promise<void>((resolve) => {
          answer = resolve
        })
        return HttpResponse.json({ ok: true, task: { id: 'a', status: 'done' } })
      }),
    )
    renderBoard()
    await screen.findByTestId('board-calendar')

    await act(async () => {
      dnd.onDragEnd?.({ active: { id: 'a' }, over: { id: 'done' } })
    })
    // The server has the move before it answers, and an agent added a task too.
    board.tasks = [
      { id: 'a', title: 'Work in hand', status: 'done', createdAt: at, completedAt: at },
      { id: 'z', title: 'Added meanwhile', status: 'todo', createdAt: at + 1 },
    ]
    await pollBoard()
    await screen.findByText('Added meanwhile')
    expect(arrivedTitles()).toEqual([])

    expect(answer).toBeDefined()
    answer!()
    await toastSays('Marked done.')
    expect(arrivedTitles()).toEqual([])
  })

  it('marks nothing on the read after the person acted on a Needs you task', async () => {
    useFleetStore.setState({ agents: [{ id: 'coder', name: 'Coder', teamId: 'team-1' }] as never })
    freezeClock()
    const user = userEvent.setup()
    const at = earlierToday()
    const failed = {
      id: 'f',
      title: 'Failed run',
      status: 'todo',
      createdAt: at,
      updatedAt: at,
      teamId: 'team-1',
      sourceDelegationId: 'assign:n1:agent:coder:origin:human',
      assigneeAgentId: 'coder',
    }
    const board = serveBoard([
      { ...failed, attention: { reason: 'failed', failedRuns: 1, detail: 'Model not found' } },
    ])
    server.use(
      http.post('/api/board/f/retry', () => {
        board.tasks = [{ ...failed, attention: null }]
        return HttpResponse.json({ ok: true })
      }),
    )
    renderBoard()
    const needsYou = await screen.findByTestId('calendar-needs-you-today')
    await within(needsYou).findByText('Failed run')

    await user.click(within(needsYou).getByRole('button', { name: 'Retry' }))
    const todo = screen.getByTestId(`calendar-cell-todo-${dayKey(at)}`)
    await waitFor(() => expect(within(todo).getByText('Failed run')).toBeInTheDocument())
    expect(arrivedTitles()).toEqual([])

    // Once the quiet spell is over, the agent picking it up is marked.
    vi.setSystemTime(Date.now() + 7 * SECOND)
    board.tasks = [{ ...failed, status: 'in_progress', attention: null }]
    await pollBoard()
    await waitFor(() => expect(arrivedTitles()).toEqual(['Failed run']))
  })

  it('marks nothing on a read that comes long after the one before, as after a hidden tab', async () => {
    freezeClock()
    const at = earlierToday()
    const board = serveBoard([{ id: 'a', title: 'Task a', status: 'todo', createdAt: at }])
    renderBoard()
    await screen.findByTestId('board-calendar')

    vi.setSystemTime(Date.now() + 16 * SECOND)
    board.tasks = [
      { id: 'a', title: 'Task a', status: 'in_progress', createdAt: at },
      { id: 'b', title: 'Task b', status: 'todo', createdAt: at + 1 },
    ]
    await pollBoard()
    await screen.findByText('Task b')
    expect(arrivedTitles()).toEqual([])

    // The next read compares with that late one, so an agent's next move shows.
    board.tasks = [
      { id: 'a', title: 'Task a', status: 'in_progress', createdAt: at },
      { id: 'b', title: 'Task b', status: 'in_progress', createdAt: at + 1 },
    ]
    await pollBoard()
    await waitFor(() => expect(arrivedTitles()).toEqual(['Task b']))
  })

  it('marks nothing on the first read for another team', async () => {
    useTeamStore.setState({ teams: [ALPHA], selectedTeamId: 'team-1' })
    freezeClock()
    const user = userEvent.setup()
    const at = earlierToday()
    const alpha = { id: 'a', title: 'Alpha work', status: 'todo', createdAt: at }
    let other = { id: 'o', title: 'Beta work', status: 'todo', createdAt: at + 1 }
    server.use(
      http.get('/api/board', ({ request }) =>
        HttpResponse.json({
          tasks: new URL(request.url).searchParams.get('teamId') ? [alpha] : [alpha, other],
        }),
      ),
    )
    renderBoard()
    await screen.findByText('Alpha work')

    // All teams shows another team's task the Alpha read never had: it is new to
    // this view, not news.
    await user.click(screen.getByLabelText('Filter by team'))
    await user.click(await screen.findByRole('option', { name: 'All teams' }))
    await screen.findByText('Beta work')
    expect(arrivedTitles()).toEqual([])

    other = { ...other, status: 'in_progress' }
    await pollBoard()
    await waitFor(() => expect(arrivedTitles()).toEqual(['Beta work']))
  })

  it('marks nothing on the first read after the range changed', async () => {
    freezeClock()
    const user = userEvent.setup()
    const at = earlierToday()
    const board = serveBoard([{ id: 'a', title: 'Task a', status: 'todo', createdAt: at }])
    renderBoard()
    await screen.findByTestId('board-calendar')

    await user.click(screen.getByRole('button', { name: /^Next week/ }))
    board.tasks = [{ id: 'a', title: 'Task a', status: 'in_progress', createdAt: at }]
    await pollBoard()
    // Open work from today rides in Earlier on a later week.
    const earlier = screen.getByTestId('calendar-cell-in_progress-earlier')
    await waitFor(() => expect(within(earlier).getByText('Task a')).toBeInTheDocument())
    expect(arrivedTitles()).toEqual([])

    board.tasks = [
      { id: 'a', title: 'Task a', status: 'in_progress', createdAt: at },
      { id: 'b', title: 'Task b', status: 'todo', createdAt: at + 1 },
    ]
    await pollBoard()
    await waitFor(() => expect(arrivedTitles()).toEqual(['Task b']))
  })
})

describe('the settle after the person sets a card down', () => {
  it('settles a dragged card in its new cell, briefly', async () => {
    const at = earlierToday()
    serveBoard([{ id: 'a', title: 'Work in hand', status: 'in_progress', createdAt: at }])
    // The server answers only once the settle has played.
    let answer: (() => void) | undefined
    server.use(
      http.patch('/api/board/a', async () => {
        await new Promise<void>((resolve) => {
          answer = resolve
        })
        return HttpResponse.json({ ok: true, task: { id: 'a', status: 'done' } })
      }),
    )
    renderBoard()
    await screen.findByTestId('board-calendar')

    await act(async () => {
      dnd.onDragEnd?.({ active: { id: 'a' }, over: { id: 'done' } })
    })
    const done = screen.getByTestId(`calendar-cell-done-${dayKey(Date.now())}`)
    expect(cardFor('Work in hand', done)).toHaveClass('calendar-chip--settle')

    await waitFor(() => expect(cardFor('Work in hand')).not.toHaveClass('calendar-chip--settle'))
    // The server's answer commits the move without settling it a second time.
    await waitFor(() => expect(answer).toBeDefined())
    answer!()
    await toastSays('Marked done.')
    expect(cardFor('Work in hand')).not.toHaveClass('calendar-chip--settle')
    expect(cardFor('Work in hand')).not.toHaveClass('calendar-chip--arrived')
  })

  it('settles a task the person adds, and the read that follows does not mark it as an agent’s', async () => {
    useTeamStore.setState({ teams: [ALPHA], selectedTeamId: null })
    useFleetStore.setState({ agents: [{ id: 'coder', name: 'Coder', teamId: 'team-1' }] as never })
    const user = userEvent.setup()
    const at = earlierToday()
    const board = serveBoard([{ id: 't1', title: 'Existing', status: 'todo', createdAt: at }])
    server.use(
      http.post('/api/board', async ({ request }) => {
        const body = (await request.json()) as Record<string, unknown>
        const task = {
          id: 'new1',
          title: body['title'],
          status: 'todo',
          teamId: 'team-1',
          assigneeAgentId: 'coder',
          createdAt: Date.now(),
        }
        // The server's copy carries a recorded cost, so the read that follows
        // can be told apart from the copy the board shows at once.
        board.tasks = [...board.tasks, { ...task, runCost: { usd: 0.42, estimated: false } }]
        return HttpResponse.json({ task })
      }),
    )
    renderBoard()
    await screen.findByText('Existing')

    await user.click(screen.getByRole('button', { name: /New task/i }))
    const dialog = await screen.findByTestId('new-task-dialog')
    await user.click(within(dialog).getByLabelText('Agent'))
    await user.click(await screen.findByRole('option', { name: 'Coder' }))
    await user.type(within(dialog).getByLabelText('Task'), 'Draft the changelog')
    await user.click(within(dialog).getByRole('button', { name: /Send to Coder/i }))

    await screen.findByText('Draft the changelog')
    expect(cardFor('Draft the changelog')).toHaveClass('calendar-chip--settle')
    await waitFor(() =>
      expect(within(cardFor('Draft the changelog')).getByTestId('board-card-cost')).toBeTruthy(),
    )
    expect(arrivedTitles()).toEqual([])

    await waitFor(() =>
      expect(cardFor('Draft the changelog')).not.toHaveClass('calendar-chip--settle'),
    )
  })

  it('settles a card moved from its drawer', async () => {
    const at = earlierToday()
    let status = 'todo'
    serveBoard([{ id: 't1', title: 'Ship it', status: 'todo', createdAt: at }])
    server.use(
      http.get('/api/board/t1', () =>
        HttpResponse.json({
          task: { id: 't1', title: 'Ship it', status, createdAt: at },
          comments: [],
          ancestors: [],
        }),
      ),
      http.get('/api/board/t1/executions', () => HttpResponse.json({ executions: [] })),
      http.get('/api/board/t1/workspace/detail', () => HttpResponse.json({ ok: false })),
      http.get('/api/obs/events', () => HttpResponse.json({ events: [] })),
      http.patch('/api/board/t1', async ({ request }) => {
        status = ((await request.json()) as { status: string }).status
        return HttpResponse.json({ ok: true, task: { id: 't1', status } })
      }),
    )
    const user = userEvent.setup()
    renderBoard()
    await screen.findByTestId('board-calendar')

    await user.click(cardFor('Ship it'))
    await screen.findByTestId('task-detail-drawer')
    await user.click(screen.getByTestId('task-status-select'))
    await user.click(await screen.findByRole('option', { name: 'Backlog' }))

    const backlog = screen.getByTestId(`calendar-cell-backlog-${dayKey(at)}`)
    await waitFor(() => expect(within(backlog).getByText('Ship it')).toBeInTheDocument())
    expect(cardFor('Ship it', backlog)).toHaveClass('calendar-chip--settle')
    await waitFor(() =>
      expect(cardFor('Ship it', backlog)).not.toHaveClass('calendar-chip--settle'),
    )
  })
})

describe('the Today ping', () => {
  it('pings today’s date when Today or T is pressed, and puts it out once it has played', async () => {
    const user = fakeClock()
    serveBoard([{ id: 't1', title: 'Any task', status: 'todo', createdAt: earlierToday() }])
    renderBoard()
    await screen.findByTestId('board-calendar')
    const pings = watchPings()

    await user.click(todayButton())
    const ping = todayRow().querySelector('.board-today-ping')
    expect(ping).not.toBeNull()
    expect(ping).toHaveAttribute('aria-hidden')
    // It rings today's date circle, the one with the day's numeral in it.
    expect(ping!.parentElement).toHaveClass('rounded-full')
    expect(ping!.parentElement).toHaveTextContent(new RegExp(`^${new Date().getDate()}$`))

    await advance(700)
    expect(document.querySelector('.board-today-ping')).toBeNull()

    // T plays it again (focus is on the board, on the Today button), and a second
    // press before it has finished starts it over.
    await user.keyboard('t')
    expect(todayRow().querySelector('.board-today-ping')).not.toBeNull()
    await user.keyboard('t')
    expect(pings.seen).toHaveLength(3)
    expect(document.querySelectorAll('.board-today-ping')).toHaveLength(1)
    await advance(700)
    expect(document.querySelector('.board-today-ping')).toBeNull()

    // Once it has played, the grid drawn again for this week does not replay it.
    await user.click(screen.getByRole('button', { name: /^Next week/ }))
    await user.click(screen.getByRole('button', { name: /^Previous week/ }))
    expect(todayRow()).toBeInTheDocument()
    expect(pings.seen).toHaveLength(3)
    pings.stop()
  })

  it('pings at once when the grid is still too short to bring today’s row to the top, and only once', async () => {
    const sizes = watchResizes()
    const user = fakeClock()
    serveBoard([{ id: 't1', title: 'Any task', status: 'todo', createdAt: earlierToday() }])
    renderBoard()
    const grid = await screen.findByTestId('board-calendar')
    // Today's row sits further down than the grid can scroll yet.
    vi.spyOn(todayRow(), 'getBoundingClientRect').mockReturnValue(rect({ top: 2000, bottom: 2080 }))
    const pings = watchPings()
    await user.click(todayButton())
    expect(todayRow().querySelector('.board-today-ping')).not.toBeNull()

    // The board keeps steering towards the row as the grid grows, without
    // pinging again.
    await act(async () => {
      sizes.grow(grid)
    })
    await advance(1000)
    expect(pings.seen).toHaveLength(1)
    pings.stop()
  })

  it('waits for a smooth scroll to today’s row to end before it pings', async () => {
    const user = fakeClock()
    serveBoard([{ id: 't1', title: 'Any task', status: 'todo', createdAt: earlierToday() }])
    renderBoard()
    await screen.findByTestId('board-calendar')
    const el = smoothScroller()
    const pings = watchPings()

    const pressedAt = Date.now()
    await user.click(todayButton())
    expect(el.scrollTo).toHaveBeenCalledWith({ top: 548, behavior: 'smooth' })
    const endedAt = Date.now()
    await act(async () => {
      el.dispatchEvent(new Event('scrollend'))
    })
    expect(todayRow().querySelector('.board-today-ping')).not.toBeNull()
    expect(pings.seen).toHaveLength(1)
    // Drawn when the scroll ended (or at the latest by its fallback), not on the press.
    expect(pings.seen[0]!).toBeGreaterThanOrEqual(Math.min(endedAt, pressedAt + 700))
    pings.stop()
  })

  it('pings anyway when a smooth scroll never says it ended', async () => {
    const user = fakeClock()
    serveBoard([{ id: 't1', title: 'Any task', status: 'todo', createdAt: earlierToday() }])
    renderBoard()
    await screen.findByTestId('board-calendar')
    smoothScroller()
    const pings = watchPings()

    const pressedAt = Date.now()
    await user.click(todayButton())
    await advance(700)
    expect(todayRow().querySelector('.board-today-ping')).not.toBeNull()
    expect(pings.seen).toHaveLength(1)
    expect(pings.seen[0]! - pressedAt).toBeGreaterThanOrEqual(700)
    pings.stop()
  })

  it('waits for a new range to slide in before it pings', async () => {
    const user = fakeClock()
    serveBoard([{ id: 't1', title: 'Any task', status: 'todo', createdAt: earlierToday() }])
    renderBoard()
    await screen.findByTestId('board-calendar')
    await user.click(screen.getByRole('button', { name: /^Next week/ }))
    const pings = watchPings()

    const pressedAt = Date.now()
    await user.click(todayButton())
    await advance(300)
    expect(todayRow().querySelector('.board-today-ping')).not.toBeNull()
    expect(pings.seen).toHaveLength(1)
    // Not before the week has slid in.
    expect(pings.seen[0]! - pressedAt).toBeGreaterThanOrEqual(240)
    pings.stop()
  })

  it('never pings on load, on a read, on the arrows or from the date picker', async () => {
    const user = fakeClock()
    const pings = watchPings()
    const board = serveBoard([
      { id: 't1', title: 'Any task', status: 'todo', createdAt: earlierToday() },
    ])
    renderBoard()
    await screen.findByTestId('board-calendar')
    await advance(1000)

    await pollBoard()
    await advance(1000)
    // The board's own five-second read.
    const reads = board.reads
    await pollBoard()
    await waitFor(() => expect(board.reads).toBeGreaterThan(reads))
    await advance(1000)

    await user.click(screen.getByRole('button', { name: /^Next week/ }))
    await advance(1000)
    await user.click(screen.getByRole('button', { name: /^Previous week/ }))
    await advance(1000)

    await user.click(screen.getByTestId('board-range-title'))
    const picker = await screen.findByTestId('calendar-mini-month')
    await user.click(
      within(picker).getByRole('button', {
        name: new RegExp(`^${longDate(Date.now()).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`),
      }),
    )
    expect(todayRow()).toHaveAttribute('data-selected', 'true')
    await advance(1000)
    expect(pings.seen).toEqual([])

    // The watch does see a ping when there is one.
    await user.click(todayButton())
    expect(pings.seen).toHaveLength(1)
    pings.stop()
  })

  it('never pings when the day turns over at midnight', async () => {
    const user = fakeClock()
    const week = thisWeek()
    vi.setSystemTime(week.end - 5 * SECOND)
    serveBoard([{ id: 't1', title: 'Any task', status: 'todo', createdAt: week.end - 60_000 }])
    renderBoard()
    await screen.findByTestId('board-calendar')
    const pings = watchPings()

    vi.setSystemTime(week.end + 5 * SECOND)
    await advance(31 * SECOND)
    await waitFor(() =>
      expect(screen.getByTestId(`calendar-day-${dayKey(week.end)}`)).toHaveAttribute(
        'data-today',
        'true',
      ),
    )
    await advance(1000)
    expect(pings.seen).toEqual([])

    await user.click(todayButton())
    expect(
      screen.getByTestId(`calendar-day-${dayKey(week.end)}`).querySelector('.board-today-ping'),
    ).not.toBeNull()
    pings.stop()
  })

  it('does not ping while no grid is showing, nor when one appears later', async () => {
    const user = fakeClock()
    const board = serveBoard([])
    renderBoard()
    await screen.findByTestId('board-empty')
    const pings = watchPings()

    // The empty board keeps its toolbar, so Today can be pressed.
    await user.click(todayButton())
    await advance(1000)
    board.tasks = [{ id: 't1', title: 'First task', status: 'todo', createdAt: earlierToday() }]
    await pollBoard()
    await screen.findByTestId('board-calendar')
    await advance(1000)

    // Nor in the undated view, which has no today.
    await pickView(user, 'Kanban')
    await user.keyboard('t')
    await advance(1000)
    await pickView(user, 'Week')
    await screen.findByTestId('board-calendar')
    await advance(1000)
    expect(pings.seen).toEqual([])
    pings.stop()
  })

  it('still draws the ping under reduced motion, where the stylesheet keeps it still', async () => {
    const user = fakeClock()
    serveBoard([{ id: 't1', title: 'Any task', status: 'todo', createdAt: earlierToday() }])
    renderBoard()
    await screen.findByTestId('board-calendar')
    preferReducedMotion()
    await user.click(todayButton())
    expect(todayRow().querySelector('.board-today-ping')).not.toBeNull()
  })
})

describe('where the Today button points', () => {
  it('points the way to today from another week, and keeps its name', async () => {
    serveBoard([{ id: 't1', title: 'Any task', status: 'todo', createdAt: earlierToday() }])
    const user = userEvent.setup()
    renderBoard()
    await screen.findByTestId('board-calendar')
    const arrow = () => screen.getByTestId('board-today-direction')

    // Today's row is on screen: nothing to point at.
    expect(arrow()).not.toHaveAttribute('data-direction')
    expect(arrow()).toHaveClass('opacity-0')
    expect(todayButton()).toHaveAttribute('title', 'Go to today (T)')

    await user.click(screen.getByRole('button', { name: /^Next week/ }))
    expect(arrow()).toHaveAttribute('data-direction', 'left')
    expect(arrow()).toHaveClass('opacity-100')
    expect(pointing()).toBe(270)
    expect(todayButton()).toHaveAttribute('title', 'Today is earlier (T)')
    expect(todayButton()).toHaveAccessibleName('Go to today')

    await user.click(screen.getByRole('button', { name: /^Previous week/ }))
    await user.click(screen.getByRole('button', { name: /^Previous week/ }))
    expect(arrow()).toHaveAttribute('data-direction', 'right')
    expect(pointing()).toBe(90)
    expect(todayButton()).toHaveAttribute('title', 'Today is later (T)')
    expect(todayButton()).toHaveAccessibleName('Go to today')

    await user.click(todayButton())
    expect(arrow()).not.toHaveAttribute('data-direction')
    expect(arrow()).toHaveClass('opacity-0')

    // The undated view has no Today button; back in a week, it points again.
    await user.click(screen.getByRole('button', { name: /^Next week/ }))
    await pickView(user, 'Kanban')
    expect(screen.queryByTestId('board-today-direction')).toBeNull()
    await pickView(user, 'Week')
    expect(arrow()).toHaveAttribute('data-direction', 'left')
  })

  it('points up or down to today’s row once it has scrolled out of sight', async () => {
    serveBoard([{ id: 't1', title: 'Any task', status: 'todo', createdAt: earlierToday() }])
    renderBoard()
    await screen.findByTestId('board-calendar')
    const arrow = () => screen.getByTestId('board-today-direction')
    const el = scroller()
    vi.spyOn(el, 'getBoundingClientRect').mockReturnValue(rect({ top: 100, bottom: 700 }))
    const row = vi
      .spyOn(todayRow(), 'getBoundingClientRect')
      .mockReturnValue(rect({ top: -200, bottom: -120 }))

    fireEvent.scroll(el)
    expect(arrow()).toHaveAttribute('data-direction', 'up')
    expect(pointing()).toBe(0)
    expect(todayButton()).toHaveAttribute('title', 'Today is above (T)')

    row.mockReturnValue(rect({ top: 900, bottom: 980 }))
    fireEvent.scroll(el)
    expect(arrow()).toHaveAttribute('data-direction', 'down')
    expect(pointing()).toBe(180)
    expect(todayButton()).toHaveAttribute('title', 'Today is below (T)')
    expect(todayButton()).toHaveAccessibleName('Go to today')

    row.mockReturnValue(rect({ top: 200, bottom: 280 }))
    fireEvent.scroll(el)
    expect(arrow()).not.toHaveAttribute('data-direction')
    expect(arrow()).toHaveClass('opacity-0')
    expect(todayButton()).toHaveAttribute('title', 'Go to today (T)')
  })
})

describe('how the lifted card is let go', () => {
  /** Lift a card, hold it over a column, and report the drop animation the
   *  overlay was handed, then put the card back. */
  async function dropAnimationOver(id: string, over: string | null): Promise<unknown> {
    await act(async () => {
      dnd.onDragStart?.({ active: { id } })
    })
    await act(async () => {
      dnd.onDragOver?.({ over: over ? { id: over } : null })
    })
    const chosen = dnd.dropAnimation
    await act(async () => {
      dnd.onDragCancel?.()
    })
    return chosen
  }

  it('lifts a chip as wide as the card it came from', async () => {
    serveBoard([
      { id: 'a', title: 'Work in hand', status: 'in_progress', createdAt: earlierToday() },
    ])
    renderBoard()
    await screen.findByTestId('board-calendar')
    const overlay = screen.getByTestId('drag-overlay')
    expect(overlay).toBeEmptyDOMElement()

    await act(async () => {
      dnd.onDragStart?.({ active: { id: 'a', rect: { current: { initial: { width: 210 } } } } })
    })
    const lifted = within(overlay).getByTestId('board-card')
    expect(lifted).toHaveTextContent('Work in hand')
    expect(lifted).toHaveClass('calendar-chip', 'calendar-chip--lifted')
    expect(lifted.parentElement).toHaveStyle({ width: '210px' })
    await act(async () => {
      dnd.onDragCancel?.()
    })
    expect(overlay).toBeEmptyDOMElement()

    // No rect on the event: the card in its cell is measured instead.
    const source = screen.getByTestId('board-card')
    const measured = vi.spyOn(source, 'getBoundingClientRect').mockReturnValue({
      ...rect({ top: 0, bottom: 60 }),
      width: 198,
    } as DOMRect)
    await act(async () => {
      dnd.onDragStart?.({ active: { id: 'a' } })
    })
    expect(within(overlay).getByTestId('board-card').parentElement).toHaveStyle({ width: '198px' })
    await act(async () => {
      dnd.onDragCancel?.()
    })

    // Nothing to measure at all: about a card's width at a column's narrowest.
    measured.mockRestore()
    await act(async () => {
      dnd.onDragStart?.({ active: { id: 'a' } })
    })
    expect(within(overlay).getByTestId('board-card').parentElement).toHaveStyle({ width: '200px' })
  })

  it('lets a card that moves at once land in place, and flies anything else back', async () => {
    useFleetStore.setState({ agents: [{ id: 'coder', name: 'Coder' }] as never })
    const at = earlierToday()
    serveBoard([
      { id: 'a', title: 'Plain', status: 'in_progress', createdAt: at },
      { id: 'b', title: 'Not started', status: 'todo', createdAt: at },
      {
        id: 'c',
        title: 'Someone on it',
        status: 'in_progress',
        createdAt: at,
        assigneeAgentId: 'coder',
      },
      {
        id: 'd',
        title: 'Failed checks',
        status: 'in_progress',
        createdAt: at,
        verification: '{"status":"fail"}',
      },
      {
        id: 'e',
        title: 'Passed checks',
        status: 'in_progress',
        createdAt: at,
        verification: { status: 'pass' },
      },
      {
        id: 'f',
        title: 'Passed with debt',
        status: 'in_progress',
        createdAt: at,
        verification: '{"status":"completed_with_debt"}',
      },
    ])
    renderBoard()
    await screen.findByTestId('board-calendar')

    // Over a legal column, with nothing to confirm: no flight.
    expect(await dropAnimationOver('a', 'done')).toBeNull()
    expect(await dropAnimationOver('a', 'todo')).toBeNull()
    expect(await dropAnimationOver('e', 'done')).toBeNull()
    // Its own column, nowhere, an illegal column: it goes back.
    expect(await dropAnimationOver('a', 'in_progress')).toEqual(RETURN_FLIGHT)
    expect(await dropAnimationOver('a', null)).toEqual(RETURN_FLIGHT)
    expect(await dropAnimationOver('b', 'done')).toEqual(RETURN_FLIGHT)
    // A move that asks first: unassigning its agent, or finishing it over a verdict
    // that did not pass. The card waits in its cell under the question.
    expect(await dropAnimationOver('c', 'todo')).toEqual(RETURN_FLIGHT)
    expect(await dropAnimationOver('d', 'done')).toEqual(RETURN_FLIGHT)
    expect(await dropAnimationOver('f', 'done')).toEqual(RETURN_FLIGHT)
  })

  it('keeps the answer worked out during the drag for the render that ends it', async () => {
    const at = earlierToday()
    serveBoard([{ id: 'a', title: 'Work in hand', status: 'in_progress', createdAt: at }])
    server.use(
      http.patch('/api/board/a', () =>
        HttpResponse.json({ ok: true, task: { id: 'a', status: 'done' } }),
      ),
    )
    renderBoard()
    await screen.findByTestId('board-calendar')

    // Let go over its own column: by the end of the drag the board has cleared
    // the drag, and the card still flies home.
    await act(async () => {
      dnd.onDragStart?.({ active: { id: 'a' } })
    })
    await act(async () => {
      dnd.onDragOver?.({ over: { id: 'in_progress' } })
    })
    await act(async () => {
      dnd.onDragEnd?.({ active: { id: 'a' }, over: { id: 'in_progress' } })
    })
    expect(screen.getByTestId('drag-overlay')).toBeEmptyDOMElement()
    expect(dnd.dropAnimation).toEqual(RETURN_FLIGHT)

    // Let go over Done: the card is already in its new cell, so nothing flies.
    await act(async () => {
      dnd.onDragStart?.({ active: { id: 'a' } })
    })
    await act(async () => {
      dnd.onDragOver?.({ over: { id: 'done' } })
    })
    await act(async () => {
      dnd.onDragEnd?.({ active: { id: 'a' }, over: { id: 'done' } })
    })
    expect(dnd.dropAnimation).toBeNull()
    await toastSays('Marked done.')
    expect(dnd.dropAnimation).toBeNull()
    expect(
      within(screen.getByTestId(`calendar-cell-done-${dayKey(Date.now())}`)).getByText(
        'Work in hand',
      ),
    ).toBeInTheDocument()
  })

  it('flies the card back when the drag is cancelled, even over a column it could take', async () => {
    serveBoard([
      { id: 'a', title: 'Work in hand', status: 'in_progress', createdAt: earlierToday() },
    ])
    renderBoard()
    await screen.findByTestId('board-calendar')
    await act(async () => {
      dnd.onDragStart?.({ active: { id: 'a' } })
    })
    await act(async () => {
      dnd.onDragOver?.({ over: { id: 'done' } })
    })
    expect(dnd.dropAnimation).toBeNull()
    await act(async () => {
      dnd.onDragCancel?.()
    })
    expect(dnd.dropAnimation).toEqual(RETURN_FLIGHT)
  })

  it('never flies the card under reduced motion', async () => {
    serveBoard([
      { id: 'a', title: 'Work in hand', status: 'in_progress', createdAt: earlierToday() },
    ])
    renderBoard()
    await screen.findByTestId('board-calendar')
    preferReducedMotion()
    expect(await dropAnimationOver('a', 'in_progress')).toBeNull()
    // dropAnimationOver ends on a cancel, which keeps it still too.
    expect(dnd.dropAnimation).toBeNull()
  })
})

describe('the sticky header and gutter', () => {
  it('marks the scroll container once it has scrolled, on each axis', async () => {
    serveBoard([{ id: 't1', title: 'Any task', status: 'todo', createdAt: earlierToday() }])
    renderBoard()
    await screen.findByTestId('board-calendar')
    const el = scroller()
    expect(el).not.toHaveAttribute('data-scrolled-y')
    expect(el).not.toHaveAttribute('data-scrolled-x')

    el.scrollTop = 120
    fireEvent.scroll(el)
    expect(el).toHaveAttribute('data-scrolled-y')
    expect(el).not.toHaveAttribute('data-scrolled-x')
    el.scrollTop = 0
    fireEvent.scroll(el)
    expect(el).not.toHaveAttribute('data-scrolled-y')

    el.scrollLeft = 80
    fireEvent.scroll(el)
    expect(el).toHaveAttribute('data-scrolled-x')
    expect(el).not.toHaveAttribute('data-scrolled-y')
    el.scrollLeft = 0
    fireEvent.scroll(el)
    expect(el).not.toHaveAttribute('data-scrolled-x')
  })

  it('gives every sticky header and the day gutter the classes their shadows hang on', async () => {
    serveBoard([{ id: 't1', title: 'Any task', status: 'todo', createdAt: earlierToday() }])
    const user = userEvent.setup()
    renderBoard()
    const grid = await screen.findByTestId('board-calendar')

    const gutter = todayRow().parentElement!
    expect(gutter).toHaveClass('board-gutter', 'sticky')
    expect(gutter.firstElementChild).toHaveClass('board-col-head')
    expect(gutter.firstElementChild).toHaveAttribute(
      'title',
      'Open work sits on the day it was added, finished work on the day it finished.',
    )
    expect(screen.getByTestId('board-column-needs-you').firstElementChild).toHaveClass(
      'board-col-head',
    )
    for (const id of ['backlog', 'todo', 'in_progress', 'done', 'cancelled']) {
      expect(screen.getByTestId(`board-column-${id}`).firstElementChild).toHaveClass(
        'board-col-head',
      )
    }
    // Those seven are the only ones: no cell carries a header's shadow.
    expect(grid.querySelectorAll('.board-col-head')).toHaveLength(7)
    expect(screen.getByTestId('board-calendar-toolbar').parentElement).toHaveClass(
      'board-ink-focus',
    )

    // Folded to a rail on another week, Needs you keeps its header's class.
    await user.click(screen.getByRole('button', { name: /^Next week/ }))
    expect(screen.getByTestId('board-needs-you-rail')).toBeInTheDocument()
    expect(screen.getByTestId('board-column-needs-you').firstElementChild).toHaveClass(
      'board-col-head',
    )
  })
})

describe('the range announcer', () => {
  it('says how many tasks a new range shows, the Earlier row included, and not on a read', async () => {
    const board = serveBoard([
      { id: 't1', title: 'Today’s task', status: 'todo', createdAt: earlierToday() },
      { id: 'o1', title: 'Old idea', status: 'todo', createdAt: startOfDay(Date.now()) - 20 * DAY },
    ])
    const user = userEvent.setup()
    renderBoard()
    await screen.findByTestId('board-calendar')
    const announcer = screen.getByTestId('board-calendar-announcer')
    // Opening the board is not a range change.
    expect(announcer).toBeEmptyDOMElement()

    await user.click(screen.getByRole('button', { name: /^Next week/ }))
    // Open work from before a later week rides in its Earlier row, and counts.
    expect(announcer.textContent).toMatch(/^Next week, .+\. 2 tasks\.$/)
    const said = announcer.textContent

    board.tasks = [
      ...board.tasks,
      { id: 't2', title: 'Second task', status: 'todo', createdAt: earlierToday() },
    ]
    await pollBoard()
    expect(
      await within(screen.getByTestId('calendar-cell-todo-earlier')).findByText('Second task'),
    ).toBeInTheDocument()
    expect(announcer.textContent).toBe(said)

    await user.click(screen.getByRole('button', { name: /^Previous week/ }))
    expect(announcer.textContent).toMatch(/^This week, .+\. 3 tasks\.$/)
    // A past week shows only its own days: the old idea is not counted there.
    await user.click(screen.getByRole('button', { name: /^Previous week/ }))
    expect(screen.queryByTestId('calendar-row-earlier')).toBeNull()
    expect(announcer.textContent).toMatch(/^Last week, .+\. 0 tasks\.$/)

    await pickView(user, 'Kanban')
    expect(announcer).toHaveTextContent(/^All tasks, newest first\.$/)
  })
})

describe('the range slide', () => {
  it('slides a new range in from the side it came from, and only fades a new team filter in', async () => {
    useTeamStore.setState({ teams: [ALPHA], selectedTeamId: null })
    serveBoard([{ id: 't1', title: 'Any task', status: 'todo', createdAt: earlierToday() }])
    const user = userEvent.setup()
    renderBoard()
    await screen.findByTestId('board-calendar')
    expect(slides.grid).toEqual([{ opacity: 0, x: 0 }])

    await user.click(screen.getByRole('button', { name: /^Next week/ }))
    expect(slides.grid.at(-1)).toEqual({ opacity: 0, x: 16 })
    await user.click(screen.getByRole('button', { name: /^Previous week/ }))
    expect(slides.grid.at(-1)).toEqual({ opacity: 0, x: -16 })

    // The same week for another team redraws in place, without sliding sideways.
    const before = slides.grid.length
    await user.click(screen.getByLabelText('Filter by team'))
    await user.click(await screen.findByRole('option', { name: /Alpha/ }))
    await screen.findByTestId('board-calendar')
    await screen.findByText('Any task')
    const redraws = slides.grid.slice(before)
    expect(redraws.length).toBeGreaterThan(0)
    expect(redraws).toEqual(redraws.map(() => ({ opacity: 0, x: 0 })))

    // Paging under the new filter slides again.
    await user.click(screen.getByRole('button', { name: /^Next week/ }))
    expect(slides.grid.at(-1)).toEqual({ opacity: 0, x: 16 })
  })
})
