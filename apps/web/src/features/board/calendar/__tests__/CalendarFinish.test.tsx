// Finishing a task by hand on the calendar board, rendered through the real
// BoardPanel against msw: which day a Done or Cancelled card goes to (and when the
// board asks), the one message each move posts, when Cancelled unfolds, which
// columns step back during a drag, where the landing outline sits, and what the
// folded Cancelled rail says while a card is over it.
//
// Fixtures are built from "now" and the same range math the panel uses, so the
// suite holds on any day of the week and in any time zone.

import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { http, HttpResponse } from 'msw'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { ConfirmDialog } from '@/features/shared/ConfirmDialog'
import { ThemeProvider } from '@/features/theme/ThemeProvider'
import { useFinishPromptStore } from '@/stores/finishPrompt'
import { useFleetStore } from '@/stores/fleet'
import { useTeamStore } from '@/stores/team'
import { useToastStore } from '@/stores/toast'

import { server } from '../../../../__vitest__/mswServer'
import { BoardPanel } from '../../BoardPanel'
import { FinishPromptDialog } from '../../FinishPromptDialog'
import { shortDate } from '../calendarFormat'
import {
  addDays,
  buildRange,
  dayKey,
  isSameDay,
  localeWeekStart,
  rangeContains,
  startOfDay,
} from '../calendarModel'
import { resetBoardStorage } from '../../__tests__/resetBoardStorage'

// dnd-kit's real drag can't run in jsdom, so the board's handlers are captured
// and called with hand-built events.
const dnd = vi.hoisted(() => ({
  onDragStart: undefined as undefined | ((e: unknown) => void),
  onDragOver: undefined as undefined | ((e: unknown) => void),
  onDragEnd: undefined as undefined | ((e: unknown) => void),
  onDragCancel: undefined as undefined | (() => void),
}))
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
  }
})

const HOUR = 3_600_000
/** How far a column that cannot take the dragged card steps back. */
const DIMMED = '0.45'

function thisWeek() {
  return buildRange('week', Date.now(), localeWeekStart())
}

/** An instant earlier today (or this very moment just after midnight). */
function earlierToday(): number {
  return Math.max(startOfDay(Date.now()) + 1000, Date.now() - 60_000)
}

function todayKey(): string {
  return dayKey(Date.now())
}

/** Ten in the morning yesterday: always on another day, always before now. */
function yesterdayMorning(): number {
  return addDays(Date.now(), -1) + 10 * HOUR
}

/** Nine days back: open work there rides in this week's Earlier row. */
function nineDaysAgo(): number {
  return addDays(Date.now(), -9) + 10 * HOUR
}

type Task = Record<string, unknown> & { id: string; title: string; status: string }
interface PatchBody {
  status: string
  completedAt?: number
  humanOverride?: boolean
}
interface Served {
  board: Task[]
  patches: Array<{ id: string; body: PatchBody }>
}

/**
 * Serve the board, and answer a status PATCH the way the server does: record the
 * body, move the task (and any plan steps cancelled with it), and say which steps
 * went with it. Later reads see the move, so a poll landing mid-test agrees.
 */
function serveBoard(
  tasks: Task[],
  opts: { dependents?: Array<{ id: string; title: string }> } = {},
): Served {
  const served: Served = { board: tasks.map((t) => ({ ...t })), patches: [] }
  server.use(
    http.get('/api/board', () => HttpResponse.json({ tasks: served.board })),
    http.patch('/api/board/:id', async ({ params, request }) => {
      const id = String(params['id'])
      const body = (await request.json()) as PatchBody
      served.patches.push({ id, body })
      const steps = body.status === 'cancelled' ? (opts.dependents ?? []) : []
      const stepIds = new Set(steps.map((s) => s.id))
      served.board = served.board.map((t) => {
        if (stepIds.has(t.id)) return { ...t, status: 'cancelled', completedAt: Date.now() }
        if (t.id !== id) return t
        const finished = body.status === 'done' || body.status === 'cancelled'
        const sdid = typeof t['sourceDelegationId'] === 'string' ? t['sourceDelegationId'] : ''
        return {
          ...t,
          status: body.status,
          ...(finished ? { completedAt: body.completedAt ?? Date.now(), runningSince: null } : {}),
          ...(body.status === 'todo' && !sdid.includes(':agent:')
            ? { attention: { reason: 'unassigned', failedRuns: 0 } }
            : {}),
        }
      })
      return HttpResponse.json({
        ok: true,
        task: served.board.find((t) => t.id === id),
        ...(steps.length > 0 ? { cancelledDependents: steps } : {}),
      })
    }),
  )
  return served
}

/** The board, with the prompt a finishing move asks through and the confirm the
 *  agent-release path uses. Without the prompt, a drop that asks never settles. */
function renderBoard() {
  return render(
    <ThemeProvider>
      <BoardPanel />
      <FinishPromptDialog />
      <ConfirmDialog />
    </ThemeProvider>,
  )
}

async function lift(id: string): Promise<void> {
  await act(async () => {
    dnd.onDragStart?.({ active: { id } })
  })
}

async function hover(over: string | null): Promise<void> {
  await act(async () => {
    dnd.onDragOver?.({ over: over ? { id: over } : null })
  })
}

async function drop(id: string, over: string): Promise<void> {
  await act(async () => {
    dnd.onDragEnd?.({ active: { id }, over: { id: over } })
  })
}

const toasts = () => useToastStore.getState().toasts

/** Exactly one message was posted, and it says this. */
async function toastIs(message: string): Promise<void> {
  await waitFor(() => expect(toasts().map((t) => t.message)).toEqual([message]))
}

/** The cards and the landing outline in a cell, top to bottom: each card by the
 *  title it carries, the outline as 'landing'. */
function cellOrder(cell: HTMLElement, titles: readonly string[]): string[] {
  return Array.from(
    cell.querySelectorAll<HTMLElement>(
      '[data-testid="board-card"], [data-testid="calendar-landing"]',
    ),
  ).map((el) =>
    el.dataset['testid'] === 'calendar-landing'
      ? 'landing'
      : (titles.find((t) => el.textContent?.includes(t)) ?? '?'),
  )
}

function inCell(column: string, rowKey: string): ReturnType<typeof within> {
  return within(screen.getByTestId(`calendar-cell-${column}-${rowKey}`))
}

beforeEach(() => {
  useTeamStore.setState({ teams: [], selectedTeamId: null })
  useToastStore.setState({ toasts: [] })
  useFleetStore.setState({ agents: [] })
  useFinishPromptStore.setState({ open: false, request: null, resolver: null })
  resetBoardStorage()
})
afterEach(() => cleanup())

describe('finishing a card by hand', () => {
  it('asks which day a card from an earlier day finished, and puts it on the day picked', async () => {
    const added = yesterdayMorning()
    const served = serveBoard([
      { id: 'p', title: 'Draft the brief', status: 'in_progress', createdAt: added },
    ])
    const user = userEvent.setup()
    renderBoard()
    await screen.findByTestId('board-calendar')
    // Yesterday is in last week when today starts the week.
    if (!rangeContains(thisWeek(), added)) {
      await user.click(screen.getByRole('button', { name: /^Previous week/ }))
    }
    const day = dayKey(added)
    expect(inCell('in_progress', day).getByText('Draft the brief')).toBeInTheDocument()

    await drop('p', 'done')
    const prompt = await screen.findByTestId('finish-prompt')
    expect(prompt).toHaveAttribute('data-to', 'done')
    // Today is the default; the day it sits on is the second choice.
    expect(within(prompt).getByTestId('finish-day-today')).toHaveAttribute('aria-checked', 'true')
    const sits = within(prompt).getByTestId('finish-day-sits')
    expect(sits).toHaveTextContent(shortDate(added))
    expect(sits).toHaveTextContent('The day it’s on now')
    // Nothing is sent, and the card stays put, while the question is open.
    expect(served.patches).toEqual([])
    expect(inCell('in_progress', day).getByText('Draft the brief')).toBeInTheDocument()

    await user.click(sits)
    expect(sits).toHaveAttribute('aria-checked', 'true')
    await user.click(within(prompt).getByTestId('finish-ok'))

    await waitFor(() => expect(served.patches).toHaveLength(1))
    const { body } = served.patches[0]!
    expect(body.status).toBe('done')
    expect(body.humanOverride).toBeUndefined()
    // Finished on the day it sits on: the same local date.
    expect(typeof body.completedAt).toBe('number')
    expect(isSameDay(body.completedAt!, added)).toBe(true)

    await waitFor(() =>
      expect(inCell('done', day).getByText('Draft the brief')).toBeInTheDocument(),
    )
    expect(inCell('in_progress', day).queryByText('Draft the brief')).toBeNull()
    // The day is on screen, so the message just says where it went.
    await toastIs(`Marked done on ${shortDate(body.completedAt!)}.`)
    expect(toasts()[0]!.type).toBe('success')
    expect(toasts()[0]!.action).toBeUndefined()
  })

  it('sends no completedAt when the person keeps today, and the card lands on today', async () => {
    const served = serveBoard([
      { id: 'o', title: 'Old errand', status: 'in_progress', createdAt: nineDaysAgo() },
    ])
    const user = userEvent.setup()
    renderBoard()
    // Open work from before the week rides in Earlier, on a day of its own.
    expect(await screen.findByText('Old errand')).toBeInTheDocument()
    expect(inCell('in_progress', 'earlier').getByText('Old errand')).toBeInTheDocument()

    await drop('o', 'done')
    const prompt = await screen.findByTestId('finish-prompt')
    await user.click(within(prompt).getByTestId('finish-ok'))

    await waitFor(() => expect(served.patches).toEqual([{ id: 'o', body: { status: 'done' } }]))
    await waitFor(() =>
      expect(inCell('done', todayKey()).getByText('Old errand')).toBeInTheDocument(),
    )
    await toastIs('Marked done.')
    expect(toasts()[0]!.type).toBe('success')
  })

  it('offers another day from a small calendar, and finishes the card on it', async () => {
    const now = Date.now()
    const added = addDays(now, -3) + HOUR
    const yesterday = addDays(now, -1)
    const served = serveBoard([
      { id: 'w', title: 'Week-old chore', status: 'in_progress', createdAt: added },
    ])
    const user = userEvent.setup()
    renderBoard()
    await screen.findByTestId('board-calendar')
    // The All view shows the card whatever day of the week it is.
    await user.click(screen.getByRole('radio', { name: 'All' }))
    expect(inCell('in_progress', 'all').getByText('Week-old chore')).toBeInTheDocument()

    await drop('w', 'done')
    const prompt = await screen.findByTestId('finish-prompt')
    expect(within(prompt).queryByTestId('finish-day-picker')).toBeNull()
    await user.click(within(prompt).getByTestId('finish-day-other'))
    const picker = within(prompt).getByTestId('finish-day-picker')
    // Only the days in the task's life, and not today or its own day, which have
    // choices of their own.
    const button = (day: number) =>
      picker.querySelector<HTMLButtonElement>(`button[data-day="${dayKey(day)}"]`)
    expect(button(addDays(now, -5))).toBeDisabled()
    expect(button(now)).toBeDisabled()
    await user.click(button(yesterday)!)
    expect(within(prompt).getByTestId('finish-day-other')).toHaveTextContent(shortDate(yesterday))
    await user.click(within(prompt).getByTestId('finish-ok'))

    await waitFor(() => expect(served.patches).toHaveLength(1))
    const at = served.patches[0]!.body.completedAt!
    expect(dayKey(at)).toBe(dayKey(yesterday))
    await waitFor(() =>
      expect(inCell('done', 'all').getByText('Week-old chore')).toBeInTheDocument(),
    )
    // The All view shows every day, so the card is in sight.
    await toastIs(`Marked done on ${shortDate(at)}.`)
    expect(toasts()[0]!.type).toBe('success')
  })

  it('sends nothing and leaves the card in its cell when the person backs out', async () => {
    const served = serveBoard([
      { id: 'o', title: 'Old errand', status: 'in_progress', createdAt: nineDaysAgo() },
    ])
    const user = userEvent.setup()
    renderBoard()
    await screen.findByText('Old errand')

    await drop('o', 'done')
    const prompt = await screen.findByTestId('finish-prompt')
    await user.click(within(prompt).getByTestId('finish-cancel'))
    await waitFor(() => expect(screen.queryByTestId('finish-prompt')).toBeNull())

    expect(served.patches).toEqual([])
    expect(inCell('in_progress', 'earlier').getByText('Old errand')).toBeInTheDocument()
    expect(screen.getByTestId(`calendar-cell-done-${todayKey()}`)).not.toHaveTextContent(
      'Old errand',
    )
    expect(toasts()).toEqual([])
  })

  it('moves a card from today to Done at once, with nothing to ask', async () => {
    const served = serveBoard([
      { id: 't', title: 'Quick fix', status: 'in_progress', createdAt: earlierToday() },
    ])
    renderBoard()
    await screen.findByText('Quick fix')

    await drop('t', 'done')
    await waitFor(() => expect(served.patches).toEqual([{ id: 't', body: { status: 'done' } }]))
    expect(screen.queryByTestId('finish-prompt')).toBeNull()
    await waitFor(() =>
      expect(inCell('done', todayKey()).getByText('Quick fix')).toBeInTheDocument(),
    )
    // One message from the board, not the shared hook's old "Status updated".
    await toastIs('Marked done.')
  })

  it('asks before finishing a card an agent is still running, even from today', async () => {
    useFleetStore.setState({ agents: [{ id: 'ada', name: 'Ada' }] as never })
    const served = serveBoard([
      {
        id: 'r',
        title: 'Live run',
        status: 'in_progress',
        createdAt: earlierToday(),
        assigneeAgentId: 'ada',
        runningSince: earlierToday(),
      },
    ])
    const user = userEvent.setup()
    renderBoard()
    await screen.findByText('Live run')

    await drop('r', 'done')
    const prompt = await screen.findByTestId('finish-prompt')
    expect(prompt).toHaveTextContent('Mark “Live run” done')
    expect(prompt).toHaveTextContent('Ada is still working on it. This stops that run.')
    // The card is on today, so there is no day to pick.
    expect(within(prompt).queryByTestId('finish-day-options')).toBeNull()
    expect(served.patches).toEqual([])

    await user.click(within(prompt).getByTestId('finish-ok'))
    await waitFor(() => expect(served.patches).toEqual([{ id: 'r', body: { status: 'done' } }]))
    await toastIs('Marked done.')
  })

  it('asks to override a failed check before the card moves, then sends the override', async () => {
    const served = serveBoard([
      {
        id: 'f',
        title: 'Shaky change',
        status: 'in_progress',
        createdAt: earlierToday(),
        verification: JSON.stringify({ status: 'fail' }),
      },
    ])
    const user = userEvent.setup()
    renderBoard()
    await screen.findByText('Shaky change')

    await drop('f', 'done')
    const prompt = await screen.findByTestId('finish-prompt')
    expect(within(prompt).getByRole('heading')).toHaveTextContent('Complete “Shaky change” anyway?')
    expect(prompt).toHaveTextContent('Its check didn’t pass.')
    expect(within(prompt).getByTestId('finish-ok')).toHaveTextContent('Complete anyway')
    // Asked before anything moves: no PATCH, and the card is still where it was.
    expect(served.patches).toEqual([])
    expect(inCell('in_progress', todayKey()).getByText('Shaky change')).toBeInTheDocument()
    expect(screen.getByTestId(`calendar-cell-done-${todayKey()}`)).not.toHaveTextContent(
      'Shaky change',
    )

    await user.click(within(prompt).getByTestId('finish-ok'))
    // One write, carrying the audited override; the server is never refused first.
    await waitFor(() =>
      expect(served.patches).toEqual([{ id: 'f', body: { status: 'done', humanOverride: true } }]),
    )
    await waitFor(() =>
      expect(inCell('done', todayKey()).getByText('Shaky change')).toBeInTheDocument(),
    )
    await toastIs('Marked done.')
  })
})

describe('cancelling a card by hand', () => {
  it('always asks, even from today, and unfolds Cancelled to show it with the step it took along', async () => {
    const at = earlierToday()
    const served = serveBoard(
      [
        { id: 'c', title: 'Plan the launch', status: 'in_progress', createdAt: at },
        { id: 's1', title: 'Write the post', status: 'todo', createdAt: at + 1 },
      ],
      { dependents: [{ id: 's1', title: 'Write the post' }] },
    )
    const user = userEvent.setup()
    renderBoard()
    await screen.findByText('Plan the launch')
    expect(screen.getByTestId('board-cancelled-rail')).toBeInTheDocument()

    await drop('c', 'cancelled')
    const prompt = await screen.findByTestId('finish-prompt')
    expect(prompt).toHaveAttribute('data-to', 'cancelled')
    expect(within(prompt).getByRole('heading')).toHaveTextContent('Cancel “Plan the launch”?')
    expect(prompt).toHaveTextContent('It moves to Cancelled and will not run again.')
    expect(within(prompt).queryByTestId('finish-day-options')).toBeNull()
    expect(within(prompt).getByTestId('finish-ok')).toHaveTextContent('Cancel task')
    expect(served.patches).toEqual([])

    await user.click(within(prompt).getByTestId('finish-ok'))
    await waitFor(() =>
      expect(served.patches).toEqual([{ id: 'c', body: { status: 'cancelled' } }]),
    )
    await toastIs('Cancelled. One later step waiting on it was cancelled too.')
    expect(toasts()[0]!.type).toBe('success')
    // The day it went to is on screen, so the column opens to show it.
    await waitFor(() => expect(screen.queryByTestId('board-cancelled-rail')).toBeNull())
    const cancelled = inCell('cancelled', todayKey())
    expect(cancelled.getByText('Plan the launch')).toBeInTheDocument()
    // The step that waited on it is drawn cancelled too, without waiting for a read.
    expect(cancelled.getByText('Write the post')).toBeInTheDocument()
    expect(inCell('todo', todayKey()).queryByText('Write the post')).toBeNull()
  })

  it('counts every step cancelled with it', async () => {
    const at = earlierToday()
    serveBoard(
      [
        { id: 'c', title: 'Plan the launch', status: 'in_progress', createdAt: at },
        { id: 's1', title: 'Write the post', status: 'todo', createdAt: at + 1 },
        { id: 's2', title: 'Schedule the post', status: 'backlog', createdAt: at + 2 },
      ],
      {
        dependents: [
          { id: 's1', title: 'Write the post' },
          { id: 's2', title: 'Schedule the post' },
        ],
      },
    )
    const user = userEvent.setup()
    renderBoard()
    await screen.findByText('Plan the launch')

    await drop('c', 'cancelled')
    await user.click(within(await screen.findByTestId('finish-prompt')).getByTestId('finish-ok'))
    await toastIs('Cancelled. 2 later steps waiting on it were cancelled too.')
    await waitFor(() =>
      expect(inCell('cancelled', todayKey()).getByText('Schedule the post')).toBeInTheDocument(),
    )
    expect(inCell('cancelled', todayKey()).getByText('Write the post')).toBeInTheDocument()
    expect(inCell('backlog', todayKey()).queryByText('Schedule the post')).toBeNull()
  })

  it('leaves Cancelled folded when the card lands outside the week shown, and offers the way there', async () => {
    const lastWeekDay = addDays(thisWeek().start, -3) + 10 * HOUR
    const served = serveBoard([
      { id: 'a', title: 'Old work', status: 'in_progress', createdAt: lastWeekDay },
    ])
    const user = userEvent.setup()
    renderBoard()
    await screen.findByTestId('board-calendar')
    await user.click(screen.getByRole('button', { name: /^Previous week/ }))
    await screen.findByText('Old work')

    await drop('a', 'cancelled')
    const prompt = await screen.findByTestId('finish-prompt')
    expect(within(prompt).getByTestId('finish-day-today')).toHaveAttribute('aria-checked', 'true')
    await user.click(within(prompt).getByTestId('finish-ok'))
    await waitFor(() =>
      expect(served.patches).toEqual([{ id: 'a', body: { status: 'cancelled' } }]),
    )

    // It went to today, which last week does not show: the column stays folded,
    // and the message carries the way to it.
    await toastIs('Cancelled.')
    const toast = toasts()[0]!
    expect(toast.type).toBe('info')
    expect(toast.action?.label).toBe('Show')
    expect(screen.getByTestId('board-cancelled-rail')).toBeInTheDocument()
    expect(screen.queryByText('Old work')).toBeNull()

    // Show goes to this week and opens the column on the card.
    await act(async () => {
      toast.action!.onAction()
    })
    await waitFor(() =>
      expect(inCell('cancelled', todayKey()).getByText('Old work')).toBeInTheDocument(),
    )
    expect(screen.queryByTestId('board-cancelled-rail')).toBeNull()
  })

  it('unfolds Cancelled for a cancel in the All view', async () => {
    serveBoard([{ id: 'c', title: 'Spare idea', status: 'todo', createdAt: earlierToday() }])
    const user = userEvent.setup()
    renderBoard()
    await screen.findByTestId('board-calendar')
    await user.click(screen.getByRole('radio', { name: 'All' }))
    expect(screen.getByTestId('board-cancelled-rail')).toBeInTheDocument()

    await drop('c', 'cancelled')
    await user.click(within(await screen.findByTestId('finish-prompt')).getByTestId('finish-ok'))
    await toastIs('Cancelled.')
    expect(toasts()[0]!.type).toBe('success')
    await waitFor(() => expect(screen.queryByTestId('board-cancelled-rail')).toBeNull())
    expect(inCell('cancelled', 'all').getByText('Spare idea')).toBeInTheDocument()
  })
})

describe('the message a move posts', () => {
  it('names the column for an open move', async () => {
    const served = serveBoard([
      { id: 't', title: 'Later maybe', status: 'todo', createdAt: earlierToday() },
    ])
    renderBoard()
    await screen.findByText('Later maybe')

    await drop('t', 'backlog')
    await waitFor(() => expect(served.patches).toEqual([{ id: 't', body: { status: 'backlog' } }]))
    await toastIs('Moved to Backlog.')
    expect(toasts()[0]!.type).toBe('success')
    expect(inCell('backlog', todayKey()).getByText('Later maybe')).toBeInTheDocument()
  })

  it('says a To do with no agent waits in Needs you, shows where it lands, and draws it there', async () => {
    const served = serveBoard([
      {
        id: 'u',
        title: 'Nobody’s job',
        status: 'backlog',
        createdAt: earlierToday(),
        // Delegated, but bound to no agent: nothing will pick it up in To do.
        sourceDelegationId: 'd1:reflectTo:lead',
      },
    ])
    renderBoard()
    await screen.findByText('Nobody’s job')
    const needsYou = screen.getByTestId('board-column-needs-you')
    expect(needsYou).toHaveStyle({ opacity: '1' })

    await lift('u')
    await hover('todo')
    // The outline is in today's Needs you cell, not in To do.
    const today = screen.getByTestId('calendar-needs-you-today')
    expect(within(today).getByTestId('calendar-landing')).toHaveTextContent('Needs an agent')
    expect(screen.getAllByTestId('calendar-landing')).toHaveLength(1)
    // That is where the card goes, so Needs you does not step back.
    expect(needsYou).toHaveStyle({ opacity: '1' })

    await drop('u', 'todo')
    await waitFor(() => expect(served.patches).toEqual([{ id: 'u', body: { status: 'todo' } }]))
    await toastIs('Moved to To do. No agent is set to pick it up, so it waits in Needs you.')
    expect(toasts()[0]!.type).toBe('success')
    // Drawn in Needs you right away, and not in To do or Backlog.
    expect(
      within(screen.getByTestId('calendar-needs-you-today')).getByText('Nobody’s job'),
    ).toBeInTheDocument()
    expect(inCell('todo', todayKey()).queryByText('Nobody’s job')).toBeNull()
    expect(inCell('backlog', todayKey()).queryByText('Nobody’s job')).toBeNull()
  })
})

describe('the columns during a drag', () => {
  it('dims In progress for a card from any other column, and lights nothing there', async () => {
    serveBoard([{ id: 't', title: 'Queued', status: 'todo', createdAt: earlierToday() }])
    renderBoard()
    await screen.findByText('Queued')
    const inProgress = screen.getByTestId('board-column-in_progress')
    expect(inProgress).toHaveStyle({ opacity: '1' })

    await lift('t')
    await hover('in_progress')
    // To do → In progress is a legal status change, but a person moving it there
    // starts no run, so the column takes nothing.
    expect(inProgress).toHaveStyle({ opacity: DIMMED })
    expect(inProgress.style.boxShadow).toBe('')
    expect(screen.queryByTestId('calendar-landing')).toBeNull()
    // A column it can go to stays at full strength.
    expect(screen.getByTestId('board-column-backlog')).toHaveStyle({ opacity: '1' })
  })

  it('does not light the card’s own column, even with the pointer over it', async () => {
    serveBoard([{ id: 'a', title: 'In hand', status: 'in_progress', createdAt: earlierToday() }])
    renderBoard()
    await screen.findByText('In hand')
    const own = screen.getByTestId('board-column-in_progress')
    const done = screen.getByTestId('board-column-done')

    await lift('a')
    await hover('in_progress')
    expect(own.style.boxShadow).toBe('')
    expect(own).toHaveStyle({ opacity: '1' })
    expect(screen.queryByTestId('calendar-landing')).toBeNull()

    // A column it can go to does light up.
    await hover('done')
    expect(done.style.boxShadow).toMatch(/^inset /)
    expect(own.style.boxShadow).toBe('')
  })

  it('steps Needs you back during any drag that does not land there', async () => {
    serveBoard([{ id: 'a', title: 'In hand', status: 'in_progress', createdAt: earlierToday() }])
    renderBoard()
    await screen.findByText('In hand')
    const needsYou = screen.getByTestId('board-column-needs-you')
    expect(needsYou).toHaveStyle({ opacity: '1' })

    await lift('a')
    expect(needsYou).toHaveStyle({ opacity: DIMMED })
    await hover('done')
    expect(needsYou).toHaveStyle({ opacity: DIMMED })
    await act(async () => {
      dnd.onDragCancel?.()
    })
    expect(needsYou).toHaveStyle({ opacity: '1' })
  })
})

describe('where the landing outline sits', () => {
  it('says what a finishing move does, from today and from another day', async () => {
    // Bound to an agent, so back in To do each waits there rather than in Needs you.
    const bound = 'd1:agent:ada:reflectTo:lead'
    serveBoard([
      {
        id: 'a',
        title: 'Today’s work',
        status: 'in_progress',
        createdAt: earlierToday(),
        sourceDelegationId: bound,
      },
      {
        id: 'o',
        title: 'Old errand',
        status: 'in_progress',
        createdAt: nineDaysAgo(),
        sourceDelegationId: bound,
      },
    ])
    const user = userEvent.setup()
    renderBoard()
    await screen.findByText('Old errand')
    // Open Cancelled, so its cell can carry the outline.
    await user.click(screen.getByTestId('board-cancelled-rail'))
    const landing = (column: string) =>
      within(screen.getByTestId(`calendar-cell-${column}-${todayKey()}`)).getByTestId(
        'calendar-landing',
      )

    await lift('a')
    await hover('done')
    expect(landing('done')).toHaveTextContent('Done today')
    await hover('cancelled')
    expect(landing('cancelled')).toHaveTextContent('Cancelled today')
    await hover('todo')
    expect(landing('todo')).toHaveTextContent('Moves here')
    await act(async () => {
      dnd.onDragCancel?.()
    })

    // A card that sits on another day lands on today too, until the day is picked.
    await lift('o')
    await hover('done')
    expect(landing('done')).toHaveTextContent('Done, pick the day')
    await hover('cancelled')
    expect(landing('cancelled')).toHaveTextContent('Cancel, pick the day')
    // An open move keeps its day: the Earlier row it came from.
    await hover('todo')
    expect(
      within(screen.getByTestId('calendar-cell-todo-earlier')).getByTestId('calendar-landing'),
    ).toHaveTextContent('Moves here')
  })

  it('captions the folded Cancelled rail while a card is over it', async () => {
    serveBoard([
      { id: 'a', title: 'Today’s work', status: 'in_progress', createdAt: earlierToday() },
      { id: 'o', title: 'Old errand', status: 'in_progress', createdAt: nineDaysAgo() },
    ])
    renderBoard()
    await screen.findByText('Old errand')
    const rail = screen.getByTestId('board-cancelled-rail')
    expect(screen.queryByTestId('board-cancelled-rail-caption')).toBeNull()

    await lift('a')
    await hover('done')
    expect(screen.queryByTestId('board-cancelled-rail-caption')).toBeNull()
    await hover('cancelled')
    expect(within(rail).getByTestId('board-cancelled-rail-caption')).toHaveTextContent(
      'Cancelled today',
    )
    await act(async () => {
      dnd.onDragCancel?.()
    })
    expect(screen.queryByTestId('board-cancelled-rail-caption')).toBeNull()

    await lift('o')
    await hover('cancelled')
    expect(within(rail).getByTestId('board-cancelled-rail-caption')).toHaveTextContent(
      'Cancel, pick the day',
    )
  })

  it('sits among a day’s cards oldest first, where the card will go', async () => {
    const base = startOfDay(Date.now())
    serveBoard([
      { id: 'e', title: 'Early one', status: 'todo', createdAt: base + 1000 },
      { id: 'l', title: 'Late one', status: 'todo', createdAt: base + 3000 },
      {
        id: 'm',
        title: 'Middle one',
        status: 'backlog',
        createdAt: base + 2000,
        // Bound to an agent, so in To do it waits there for that agent.
        sourceDelegationId: 'd1:agent:ada:reflectTo:lead',
      },
    ])
    renderBoard()
    await screen.findByText('Middle one')

    await lift('m')
    await hover('todo')
    const cell = screen.getByTestId(`calendar-cell-todo-${todayKey()}`)
    expect(cellOrder(cell, ['Early one', 'Late one'])).toEqual(['Early one', 'landing', 'Late one'])
  })

  it('sits among the All row’s cards newest first, where the card will go', async () => {
    const now = Date.now()
    serveBoard([
      { id: 'n', title: 'Newest card', status: 'todo', createdAt: earlierToday() },
      { id: 'r', title: 'Recent card', status: 'todo', createdAt: addDays(now, -2) + HOUR },
      { id: 'o', title: 'Oldest card', status: 'todo', createdAt: addDays(now, -5) + HOUR },
      {
        id: 'x',
        title: 'Moving card',
        status: 'backlog',
        createdAt: addDays(now, -3) + HOUR,
        sourceDelegationId: 'd1:agent:ada:reflectTo:lead',
      },
    ])
    const user = userEvent.setup()
    renderBoard()
    await screen.findByTestId('board-calendar')
    await user.click(screen.getByRole('radio', { name: 'All' }))
    const cell = screen.getByTestId('calendar-cell-todo-all')
    const titles = ['Newest card', 'Recent card', 'Oldest card']
    expect(cellOrder(cell, titles)).toEqual(titles)

    await lift('x')
    await hover('todo')
    // Added three days back: after the two newer cards, before the older one.
    expect(cellOrder(cell, titles)).toEqual([
      'Newest card',
      'Recent card',
      'landing',
      'Oldest card',
    ])
  })
})

describe('finishing from the task drawer', () => {
  it('asks the same question as a drag, and the board puts the card on its day', async () => {
    const added = nineDaysAgo()
    const task = { id: 'o', title: 'Old errand', status: 'in_progress', createdAt: added }
    const served = serveBoard([task])
    server.use(
      http.get('/api/board/o', () =>
        HttpResponse.json({ task: served.board[0], comments: [], ancestors: [] }),
      ),
      http.get('/api/board/o/executions', () => HttpResponse.json({ executions: [] })),
      http.get('/api/board/o/workspace/detail', () => HttpResponse.json({ ok: false })),
      http.get('/api/obs/events', () => HttpResponse.json({ events: [] })),
    )
    const user = userEvent.setup()
    renderBoard()
    await user.click(await screen.findByTestId('board-card'))
    await screen.findByTestId('task-detail-drawer')
    await user.click(await screen.findByTestId('task-status-select'))
    await user.click(await screen.findByRole('option', { name: 'Done' }))

    const prompt = await screen.findByTestId('finish-prompt')
    expect(prompt).toHaveAttribute('data-to', 'done')
    expect(within(prompt).getByTestId('finish-day-today')).toHaveAttribute('aria-checked', 'true')
    expect(within(prompt).getByTestId('finish-day-sits')).toHaveTextContent(shortDate(added))
    expect(served.patches).toEqual([])

    await user.click(within(prompt).getByTestId('finish-day-sits'))
    await user.click(within(prompt).getByTestId('finish-ok'))
    await waitFor(() => expect(served.patches).toHaveLength(1))
    const at = served.patches[0]!.body.completedAt!
    expect(dayKey(at)).toBe(dayKey(added))

    // The board's message, not the drawer's own: the day is outside this week,
    // so it carries the way there.
    await toastIs(`Marked done on ${shortDate(at)}.`)
    expect(toasts()[0]!.type).toBe('info')
    expect(toasts()[0]!.action?.label).toBe('Show')
    expect(screen.queryByText('Status updated to Done')).toBeNull()
  })
})
