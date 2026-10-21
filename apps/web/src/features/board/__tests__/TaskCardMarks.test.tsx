// The marks a calendar chip carries for how the person reads the board: a title
// clamped to one line on finished work from a day gone by, the ink dot on a card
// that changed while the person was away (and the rest that acknowledges it), and
// the stamp's timer for a running task against the check for a finished one.
// TaskCard and DraggableCard on their own; the board decides which cards get
// which mark, and its own tests cover that.
//
// The look timer is driven with fake timers, so a rest is exactly as long as a
// test says. The running stamp is built by calendarStamp from a clock fixed at
// "now", and its expectations with the same formatters the board uses, so the
// suite holds in any locale and time zone.

import type { ComponentProps, ReactNode } from 'react'
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { DndContext } from '@dnd-kit/core'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { ThemeProvider } from '@/features/theme/ThemeProvider'
import type { BoardTask } from '@/lib/boardClient'
import { useFleetStore, type AgentState } from '@/stores/fleet'

import { DraggableCard, TaskCard, type CardStamp } from '../TaskCard'
import { calendarStamp } from '../calendar/CalendarGrid'
import { elapsedLabel, shortDate, timeLabel, timeOnDay } from '../calendar/calendarFormat'
import { resetBoardStorage } from './resetBoardStorage'

const ACCENT = 'var(--category-web)'
const TITLE = 'Draft the launch note and send it round the team'
const ADDED: CardStamp = { label: '9:41 AM', title: 'Added Oct 14, 9:41 AM', finished: false }
const FINISHED: CardStamp = { label: '3:05 PM', title: 'Finished Oct 14, 3:05 PM', finished: true }

/** How long the pointer or focus has to rest on a card to count as a look. */
const LOOK_MS = 600

function makeTask(fields: Record<string, unknown> = {}): BoardTask {
  return { id: 't1', title: TITLE, status: 'todo', ...fields } as BoardTask
}

function seedFleet(agents: Array<Partial<AgentState> & { id: string }>): void {
  useFleetStore.setState({ agents: agents as AgentState[], selectedAgentId: null })
}

type CardProps = Partial<ComponentProps<typeof TaskCard>>

function themed(children: ReactNode) {
  return <ThemeProvider>{children}</ThemeProvider>
}

/** A calendar chip: a card with a stamp and its column's colour. */
function chipElement(task: BoardTask, props: CardProps = {}) {
  return themed(
    <TaskCard task={task} onClick={() => {}} stamp={ADDED} accent={ACCENT} {...props} />,
  )
}

function renderChip(task: BoardTask, props: CardProps = {}) {
  const view = render(chipElement(task, props))
  return { ...view, card: screen.getByTestId('board-card') }
}

/** The card's title line: the first child of the button, whatever the dot adds to it. */
function titleLine(card: HTMLElement): HTMLElement {
  return card.firstElementChild as HTMLElement
}

/** Moves the clock on by `ms`, running whatever timers fall due. */
function wait(ms: number): void {
  act(() => {
    vi.advanceTimersByTime(ms)
  })
}

beforeEach(() => {
  resetBoardStorage()
  seedFleet([])
})
afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

describe('a clamped chip', () => {
  it('keeps its title to one line, with the whole title in the tooltip', () => {
    const { card } = renderChip(makeTask({ status: 'done' }), { stamp: FINISHED, clamp: true })
    const line = titleLine(card)
    expect(line).toHaveTextContent(TITLE)
    expect(line).toHaveClass('line-clamp-1')
    expect(line).not.toHaveClass('line-clamp-2')
    expect(card).toHaveAttribute('title', TITLE)
  })

  it('keeps the details row under the clamped title', () => {
    seedFleet([{ id: 'coder', name: 'Coder', runtime: 'codex' }])
    const { card } = renderChip(
      makeTask({ status: 'done', assigneeAgentId: 'coder', assigneeRuntime: 'codex' }),
      { stamp: FINISHED, clamp: true },
    )
    expect(within(card).getByText('Assigned to Coder')).toHaveClass('sr-only')
    expect(within(card).getByText('Runtime: Codex')).toHaveClass('sr-only')
    expect(within(card).getByTestId('board-card-stamp')).toHaveTextContent('3:05 PM')
  })

  it('adds the cost to the tooltip when a status mark takes its place', () => {
    const { card } = renderChip(
      makeTask({
        status: 'in_progress',
        verification: { status: 'pass' },
        runCost: { usd: 0.42, estimated: false },
      }),
      { clamp: true },
    )
    expect(within(card).getByTitle('Verified')).toBeInTheDocument()
    expect(within(card).queryByTestId('board-card-cost')).toBeNull()
    expect(card).toHaveAttribute('title', `${TITLE}\nCost: $0.42`)
  })

  it('writes an estimated cost in the tooltip as an estimate', () => {
    const { card } = renderChip(
      makeTask({ status: 'in_review', runCost: { usd: 0.02, estimated: true } }),
      { clamp: true },
    )
    expect(card).toHaveAttribute('title', `${TITLE}\nCost: ~$0.02 est.`)
  })

  it('leaves a cost on the face out of the tooltip', () => {
    const { card } = renderChip(
      makeTask({ status: 'done', runCost: { usd: 0.42, estimated: false } }),
      { stamp: FINISHED, clamp: true },
    )
    expect(within(card).getByTestId('board-card-cost')).toBeInTheDocument()
    expect(card).toHaveAttribute('title', TITLE)
  })

  it('names an untitled task in the tooltip as the card does', () => {
    const { card } = renderChip(makeTask({ status: 'done', title: undefined }), {
      stamp: FINISHED,
      clamp: true,
    })
    expect(titleLine(card)).toHaveTextContent('(untitled)')
    expect(card).toHaveAttribute('title', '(untitled)')
  })
})

describe('an unclamped chip', () => {
  it('gives its title two lines and the card no tooltip', () => {
    const { card } = renderChip(makeTask({ status: 'done' }), { stamp: FINISHED })
    const line = titleLine(card)
    expect(line).toHaveClass('line-clamp-2')
    expect(line).not.toHaveClass('line-clamp-1')
    expect(card).not.toHaveAttribute('title')
  })

  it('gives the card a tooltip only for a cost a status mark displaced', () => {
    const { card } = renderChip(
      makeTask({
        status: 'in_progress',
        verification: { status: 'fail' },
        runCost: { usd: 0.42, estimated: false },
      }),
    )
    expect(titleLine(card)).toHaveClass('line-clamp-2')
    expect(card).toHaveAttribute('title', 'Cost: $0.42')
  })

  it('treats clamp false as no clamp', () => {
    const { card } = renderChip(makeTask({ status: 'done' }), { stamp: FINISHED, clamp: false })
    expect(titleLine(card)).toHaveClass('line-clamp-2')
    expect(card).not.toHaveAttribute('title')
  })
})

describe('clamp off a chip', () => {
  it('leaves a stamped card with no column colour at two lines and no tooltip', () => {
    render(themed(<TaskCard task={makeTask()} onClick={() => {}} stamp={ADDED} clamp />))
    const card = screen.getByTestId('board-card')
    expect(titleLine(card)).toHaveClass('line-clamp-2')
    expect(titleLine(card)).not.toHaveClass('line-clamp-1')
    expect(card).not.toHaveAttribute('title')
  })

  it('leaves the undated card unclamped', () => {
    render(themed(<TaskCard task={makeTask()} onClick={() => {}} clamp />))
    const card = screen.getByTestId('board-card')
    expect(titleLine(card).className).not.toMatch(/line-clamp/)
    expect(card).not.toHaveAttribute('title')
  })
})

describe('an unseen chip: the dot', () => {
  it('draws an ink dot before the title, named for screen readers', () => {
    const { card } = renderChip(makeTask(), { unseen: true })
    const dot = within(card).getByTestId('board-card-unseen')
    expect(titleLine(card).firstElementChild).toBe(dot)
    expect(dot).toHaveClass('rounded-full', 'bg-foreground')
    // Ink, never the accent red.
    expect(dot).not.toHaveClass('bg-primary')
    expect(within(dot).getByText('Changed since you last looked.')).toHaveClass('sr-only')
    expect(titleLine(card)).toHaveTextContent(TITLE)
  })

  it('draws no dot on a chip the person has seen', () => {
    const { card } = renderChip(makeTask())
    expect(within(card).queryByTestId('board-card-unseen')).toBeNull()
    expect(card).not.toHaveTextContent(/since you last looked/)
  })

  it('keeps the dot out of the tooltip of a clamped chip', () => {
    const { card } = renderChip(makeTask({ status: 'done' }), {
      stamp: FINISHED,
      clamp: true,
      unseen: true,
    })
    expect(within(card).getByTestId('board-card-unseen')).toBeInTheDocument()
    expect(card).toHaveAttribute('title', TITLE)
  })

  it.each([
    ['the undated card', undefined, undefined],
    ['a stamped card with no column colour', ADDED, undefined],
  ])('draws no dot on %s', (_case, stamp, accent) => {
    render(
      themed(
        <TaskCard task={makeTask()} onClick={() => {}} stamp={stamp} accent={accent} unseen />,
      ),
    )
    expect(screen.queryByTestId('board-card-unseen')).toBeNull()
  })

  it('draws the dot without a way to clear it when no onSeen is given', () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const { card } = renderChip(makeTask(), { unseen: true })
    fireEvent.pointerEnter(card)
    wait(LOOK_MS * 2)
    expect(within(card).getByTestId('board-card-unseen')).toBeInTheDocument()
  })
})

describe('an unseen chip: the look', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
  })

  it('counts a pointer that rests 600ms as a look', () => {
    const onSeen = vi.fn()
    const { card } = renderChip(makeTask(), { unseen: true, onSeen })
    fireEvent.pointerEnter(card)
    wait(LOOK_MS - 1)
    expect(onSeen).not.toHaveBeenCalled()
    wait(1)
    expect(onSeen).toHaveBeenCalledTimes(1)
    // One look, however long the pointer stays.
    wait(LOOK_MS * 3)
    expect(onSeen).toHaveBeenCalledTimes(1)
  })

  it('does not count a pointer that leaves at 500ms', () => {
    const onSeen = vi.fn()
    const { card } = renderChip(makeTask(), { unseen: true, onSeen })
    fireEvent.pointerEnter(card)
    wait(500)
    fireEvent.pointerLeave(card)
    wait(LOOK_MS * 3)
    expect(onSeen).not.toHaveBeenCalled()
  })

  it('starts the rest over when the pointer comes back', () => {
    const onSeen = vi.fn()
    const { card } = renderChip(makeTask(), { unseen: true, onSeen })
    fireEvent.pointerEnter(card)
    wait(500)
    fireEvent.pointerLeave(card)
    fireEvent.pointerEnter(card)
    wait(500)
    expect(onSeen).not.toHaveBeenCalled()
    wait(100)
    expect(onSeen).toHaveBeenCalledTimes(1)
  })

  it('counts focus that rests 600ms as a look', () => {
    const onSeen = vi.fn()
    const { card } = renderChip(makeTask(), { unseen: true, onSeen })
    act(() => card.focus())
    expect(card).toHaveFocus()
    wait(LOOK_MS - 1)
    expect(onSeen).not.toHaveBeenCalled()
    wait(1)
    expect(onSeen).toHaveBeenCalledTimes(1)
  })

  it('does not count focus that moves on at 500ms', () => {
    const onSeen = vi.fn()
    const { card } = renderChip(makeTask(), { unseen: true, onSeen })
    act(() => card.focus())
    wait(500)
    act(() => card.blur())
    wait(LOOK_MS * 3)
    expect(onSeen).not.toHaveBeenCalled()
  })

  it('never counts a look on a chip that is not unseen', () => {
    const onSeen = vi.fn()
    const { card } = renderChip(makeTask(), { unseen: false, onSeen })
    fireEvent.pointerEnter(card)
    wait(LOOK_MS * 3)
    act(() => card.focus())
    wait(LOOK_MS * 3)
    expect(onSeen).not.toHaveBeenCalled()
  })

  it('drops a rest that began before the chip was seen another way', () => {
    // Opening the card acknowledges it too; the rest under way must not count twice.
    const onSeen = vi.fn()
    const { card, rerender } = renderChip(makeTask(), { unseen: true, onSeen })
    fireEvent.pointerEnter(card)
    wait(300)
    rerender(chipElement(makeTask(), { unseen: false, onSeen }))
    wait(LOOK_MS * 3)
    expect(onSeen).not.toHaveBeenCalled()
    expect(within(card).queryByTestId('board-card-unseen')).toBeNull()
  })

  it('tells the latest onSeen when a rest ends', () => {
    const first = vi.fn()
    const latest = vi.fn()
    const { card, rerender } = renderChip(makeTask(), { unseen: true, onSeen: first })
    fireEvent.pointerEnter(card)
    wait(300)
    rerender(chipElement(makeTask(), { unseen: true, onSeen: latest }))
    wait(LOOK_MS)
    expect(first).not.toHaveBeenCalled()
    expect(latest).toHaveBeenCalledTimes(1)
  })

  it('drops a rest when the card leaves the board', () => {
    const onSeen = vi.fn()
    const { card, unmount } = renderChip(makeTask(), { unseen: true, onSeen })
    fireEvent.pointerEnter(card)
    wait(300)
    unmount()
    wait(LOOK_MS * 3)
    expect(onSeen).not.toHaveBeenCalled()
  })
})

describe('a chip stamp: running and finished', () => {
  const NOW = Date.now()
  const ADDED_AT = NOW - 3 * 60 * 60_000
  const SINCE = NOW - 25 * 60_000

  it('shows how long a running task has gone, with a timer and no check', () => {
    const task = makeTask({ status: 'in_progress', createdAt: ADDED_AT, runningSince: SINCE })
    const stamp = calendarStamp(task, 'day', NOW)!
    expect(stamp.running).toBe(true)
    const { card } = renderChip(task, { stamp })
    const shown = within(card).getByTestId('board-card-stamp')
    expect(shown.querySelector('svg.lucide-timer')).not.toBeNull()
    expect(shown.querySelector('svg.lucide-circle-check')).toBeNull()
    expect(shown.querySelector('svg.text-mint')).toBeNull()
    expect(shown).toHaveTextContent(elapsedLabel(NOW - SINCE))
    // A length of time, like a clock time, is set in mono.
    expect(shown).toHaveClass('font-data')
    const title = `Running since ${timeOnDay(SINCE, NOW)}. Added ${shortDate(ADDED_AT)} at ${timeLabel(ADDED_AT)}`
    expect(shown).toHaveAttribute('title', title)
    expect(within(shown).getByText(`, ${title}`)).toHaveClass('sr-only')
  })

  it('draws the timer for a hand-built running stamp too', () => {
    const stamp: CardStamp = {
      label: '2h 5m',
      title: 'Running since 9:00 AM',
      finished: false,
      running: true,
    }
    const shown = within(
      renderChip(makeTask({ status: 'in_progress' }), { stamp }).card,
    ).getByTestId('board-card-stamp')
    expect(shown.querySelectorAll('svg')).toHaveLength(1)
    expect(shown.querySelector('svg.lucide-timer')).not.toBeNull()
    expect(shown).toHaveTextContent('2h 5m')
  })

  it('carries a mint check on a finished stamp, and no timer', () => {
    const shown = within(
      renderChip(makeTask({ status: 'done' }), { stamp: FINISHED }).card,
    ).getByTestId('board-card-stamp')
    expect(shown.querySelectorAll('svg')).toHaveLength(1)
    expect(shown.querySelector('svg.lucide-circle-check')).toHaveClass('text-mint')
    expect(shown.querySelector('svg.lucide-timer')).toBeNull()
  })

  it('stamps a finished task as finished even when it still carries a run start', () => {
    const task = makeTask({ status: 'done', completedAt: NOW - 60_000, runningSince: SINCE })
    const stamp = calendarStamp(task, 'day', NOW)!
    expect(stamp.running).toBeUndefined()
    const shown = within(renderChip(task, { stamp }).card).getByTestId('board-card-stamp')
    expect(shown.querySelector('svg.lucide-circle-check')).toHaveClass('text-mint')
    expect(shown.querySelector('svg.lucide-timer')).toBeNull()
    expect(shown).toHaveTextContent(timeLabel(NOW - 60_000))
  })

  it('draws neither mark on an open task that is not running', () => {
    const task = makeTask({ status: 'todo', createdAt: ADDED_AT })
    const shown = within(
      renderChip(task, { stamp: calendarStamp(task, 'day', NOW)! }).card,
    ).getByTestId('board-card-stamp')
    expect(shown.querySelector('svg')).toBeNull()
    expect(shown).toHaveTextContent(timeLabel(ADDED_AT))
  })
})

// ── DraggableCard ──

type DraggableProps = Partial<ComponentProps<typeof DraggableCard>>

function renderDraggable(props: DraggableProps = {}) {
  const view = render(
    themed(
      <DndContext>
        <DraggableCard
          task={makeTask({ status: 'done' })}
          disabled={false}
          onOpen={() => {}}
          stamp={FINISHED}
          accent={ACCENT}
          {...props}
        />
      </DndContext>,
    ),
  )
  return { ...view, card: screen.getByTestId('board-card') }
}

describe('DraggableCard: the marks', () => {
  it('passes the clamp through to its chip', () => {
    const { card } = renderDraggable({ clamp: true })
    expect(titleLine(card)).toHaveClass('line-clamp-1')
    expect(card).toHaveAttribute('title', TITLE)
  })

  it('leaves its chip at two lines without the clamp', () => {
    const { card } = renderDraggable()
    expect(titleLine(card)).toHaveClass('line-clamp-2')
    expect(card).not.toHaveAttribute('title')
  })

  it('passes the dot and the look through to its chip', () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const onSeen = vi.fn()
    const { card } = renderDraggable({ unseen: true, onSeen })
    expect(within(card).getByTestId('board-card-unseen')).toBeInTheDocument()
    fireEvent.pointerEnter(card)
    wait(500)
    expect(onSeen).not.toHaveBeenCalled()
    wait(100)
    expect(onSeen).toHaveBeenCalledTimes(1)
  })

  it('counts a look by focus on the card, not on its grip', () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const onSeen = vi.fn()
    renderDraggable({ unseen: true, onSeen })
    const grip = screen.getByRole('button', { name: /^Drag to move/ })
    act(() => grip.focus())
    wait(LOOK_MS * 3)
    expect(onSeen).not.toHaveBeenCalled()
    act(() => screen.getByTestId('board-card').focus())
    wait(LOOK_MS)
    expect(onSeen).toHaveBeenCalledTimes(1)
  })

  it('never counts a look when it is not unseen', () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const onSeen = vi.fn()
    const { card } = renderDraggable({ onSeen })
    expect(within(card).queryByTestId('board-card-unseen')).toBeNull()
    fireEvent.pointerEnter(card)
    wait(LOOK_MS * 3)
    expect(onSeen).not.toHaveBeenCalled()
  })

  it('keeps the dot on a card that cannot be dragged', () => {
    const { card } = renderDraggable({ disabled: true, unseen: true, onSeen: () => {} })
    expect(screen.queryByRole('button', { name: /^Drag to move/ })).toBeNull()
    expect(within(card).getByTestId('board-card-unseen')).toBeInTheDocument()
  })
})
