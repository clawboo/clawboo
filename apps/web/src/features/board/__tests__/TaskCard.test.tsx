// TaskCard and DraggableCard on their own. The calendar chip's face (who has the
// task, the runtime it runs on, its one status mark or its cost, the subtask, the
// stamp), the attributes and classes the chip's CSS keys on, the undated card,
// and how DraggableCard routes a mouse, a pen, a touch, a key and a click.
//
// DraggableCard runs inside a real DndContext with the board's sensors, so a
// drag here is dnd-kit's own: a pointer press that travels 5px, or Space on the
// grip. Nothing reads the clock but the drop guard, which the pointer tests drive
// with fake timers.

import type { ComponentProps, ReactNode } from 'react'
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import {
  DndContext,
  KeyboardSensor,
  PointerSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
  type DragStartEvent,
} from '@dnd-kit/core'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { ThemeProvider } from '@/features/theme/ThemeProvider'
import type { BoardTask } from '@/lib/boardClient'
import { useFleetStore, type AgentState } from '@/stores/fleet'

import { DraggableCard, TaskCard, type CardStamp } from '../TaskCard'

const ACCENT = 'var(--category-web)'
const ADDED: CardStamp = { label: '9:41 AM', title: 'Added Oct 14, 9:41 AM', finished: false }
const FINISHED: CardStamp = { label: '3:05 PM', title: 'Finished Oct 14, 3:05 PM', finished: true }
const DATED: CardStamp = {
  label: 'Oct 12',
  title: 'Added Oct 12, 9:41 AM',
  finished: false,
  dated: true,
}

const STATE_CLASSES = [
  'calendar-chip--arrived',
  'calendar-chip--settle',
  'calendar-chip--lifted',
  'calendar-chip--source',
]

function makeTask(fields: Record<string, unknown> = {}): BoardTask {
  return { id: 't1', title: 'Draft the launch note', status: 'todo', ...fields } as BoardTask
}

function seedFleet(agents: Array<Partial<AgentState> & { id: string }>): void {
  useFleetStore.setState({ agents: agents as AgentState[], selectedAgentId: null })
}

type CardProps = Partial<ComponentProps<typeof TaskCard>>

/** A calendar chip: a card with a stamp and its column's colour. */
function renderChip(task: BoardTask, props: CardProps = {}): HTMLElement {
  render(
    <ThemeProvider>
      <TaskCard task={task} onClick={() => {}} stamp={ADDED} accent={ACCENT} {...props} />
    </ThemeProvider>,
  )
  return screen.getByTestId('board-card')
}

/** The undated All board's card: no stamp, no colour. */
function renderUndated(task: BoardTask, props: CardProps = {}): HTMLElement {
  render(
    <ThemeProvider>
      <TaskCard task={task} onClick={() => {}} {...props} />
    </ThemeProvider>,
  )
  return screen.getByTestId('board-card')
}

beforeEach(() => seedFleet([]))
afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

describe('a calendar chip: the runtime', () => {
  it("reads an open task's runtime from its agent, not the engine's stored placeholder", () => {
    // The team engine stores 'openclaw' on a task until its run ends, whatever the
    // agent runs on.
    seedFleet([{ id: 'agent-7', name: 'Coder', runtime: 'codex' }])
    const card = renderChip(
      makeTask({ status: 'in_progress', assigneeAgentId: 'agent-7', assigneeRuntime: 'openclaw' }),
    )
    expect(within(card).getByText('Runtime: Codex')).toHaveClass('sr-only')
    const mark = within(card).getByTitle('Codex')
    // The glyph paints in the chip's muted ink, never the brand colour.
    expect(mark).toHaveClass('text-muted-foreground')
    expect(mark.querySelector('svg')).not.toBeNull()
    expect(card).not.toHaveTextContent(/OpenClaw/)
    expect(within(card).queryByTitle('OpenClaw')).toBeNull()
  })

  it.each([
    ['done', 'claude-code', 'codex', 'Claude Code'],
    ['cancelled', 'hermes', 'codex', 'Hermes'],
  ])(
    'reads a %s task by the runtime its run recorded (%s), not its agent (%s)',
    (status, recorded, agentRuntime, label) => {
      seedFleet([{ id: 'agent-7', name: 'Coder', runtime: agentRuntime }])
      const card = renderChip(
        makeTask({ status, assigneeAgentId: 'agent-7', assigneeRuntime: recorded }),
        { stamp: FINISHED },
      )
      expect(within(card).getByText(`Runtime: ${label}`)).toHaveClass('sr-only')
      expect(within(card).getByTitle(label)).toBeInTheDocument()
      expect(within(card).getAllByText(/^Runtime:/)).toHaveLength(1)
    },
  )

  it("falls back to the agent's runtime when a finished task recorded none", () => {
    seedFleet([{ id: 'agent-7', name: 'Coder', runtime: 'hermes' }])
    const card = renderChip(makeTask({ status: 'done', assigneeAgentId: 'agent-7' }), {
      stamp: FINISHED,
    })
    expect(within(card).getByText('Runtime: Hermes')).toHaveClass('sr-only')
  })

  it('names a runtime the board has no brand for by its id, with no glyph', () => {
    seedFleet([{ id: 'agent-7', name: 'Coder', runtime: 'acme' }])
    const card = renderChip(
      makeTask({ status: 'in_progress', assigneeAgentId: 'agent-7', assigneeRuntime: 'openclaw' }),
    )
    const name = within(card).getByText('acme')
    expect(name).toHaveTextContent('Runtime: acme')
    expect(within(name).getByText('Runtime:')).toHaveClass('sr-only')
    expect(name.querySelector('svg')).toBeNull()
    expect(card).not.toHaveTextContent(/OpenClaw/)
  })

  it('reads the runtime of the agent a waiting task is bound to', () => {
    // A person handed the task to an agent; it waits in To do with no assignee yet.
    seedFleet([{ id: 'agent-9', name: 'Writer', runtime: 'hermes' }])
    const card = renderChip(
      makeTask({ status: 'todo', sourceDelegationId: 'assign:n1:agent:agent-9:origin:human' }),
    )
    expect(within(card).getByText('Runtime: Hermes')).toHaveClass('sr-only')
  })

  it.each([
    ['nobody has an open task', { status: 'todo', assigneeRuntime: 'openclaw' }, []],
    ['nobody has a finished task that recorded none', { status: 'done' }, []],
    [
      "the open task's agent is not in the fleet",
      { status: 'in_progress', assigneeAgentId: 'ghost', assigneeRuntime: 'openclaw' },
      [],
    ],
    [
      "the open task's agent has no runtime",
      { status: 'in_progress', assigneeAgentId: 'agent-7', assigneeRuntime: 'openclaw' },
      [{ id: 'agent-7', name: 'Coder', runtime: null }],
    ],
  ])('claims no runtime when %s', (_case, fields, agents) => {
    seedFleet(agents)
    const card = renderChip(makeTask(fields))
    expect(within(card).queryByText(/^Runtime:/)).toBeNull()
    expect(card).not.toHaveTextContent(/OpenClaw|openclaw/)
  })
})

describe('a calendar chip: who has it', () => {
  it('marks an unassigned chip with a dashed empty circle', () => {
    const card = renderChip(makeTask())
    const empty = within(card).getByTitle('Unassigned')
    expect(within(empty).getByText('Unassigned')).toHaveClass('sr-only')
    expect(empty).toHaveClass('rounded-full')
    expect(empty.getAttribute('style')).toMatch(/dashed/)
    expect(within(card).queryByText(/^Assigned to/)).toBeNull()
  })

  it.each([
    ['its assignee', { status: 'in_progress', assigneeAgentId: 'coder' }],
    [
      'the agent a delegation bound it to',
      { status: 'todo', sourceDelegationId: 'r:deleg:agent:coder:reflectTo:lead' },
    ],
  ])('shows %s by avatar and name', (_case, fields) => {
    seedFleet([{ id: 'coder', name: 'Coder' }])
    const card = renderChip(makeTask(fields))
    expect(within(card).getByText('Assigned to Coder')).toHaveClass('sr-only')
    const who = within(card).getByTitle('Coder')
    expect(who.querySelector('svg, img')).not.toBeNull()
    expect(within(card).queryByTitle('Unassigned')).toBeNull()
    expect(within(card).queryByText('Unassigned')).toBeNull()
  })

  it('names an agent the fleet does not know generically', () => {
    const card = renderChip(makeTask({ status: 'in_progress', assigneeAgentId: 'gone' }))
    expect(within(card).getByText('Assigned to an agent')).toHaveClass('sr-only')
    expect(within(card).queryByTitle('Unassigned')).toBeNull()
  })
})

describe('a calendar chip: one status mark, else the cost', () => {
  it('shows Verifying first, with no verdict mark and no cost beside it', () => {
    const card = renderChip(
      makeTask({
        status: 'in_review',
        verification: { status: 'fail' },
        runCost: { usd: 0.02, estimated: true },
      }),
    )
    const verifying = within(card).getByText('Verifying')
    expect(verifying).not.toHaveClass('sr-only')
    expect(card.querySelector('.board-pulse-dot')).not.toBeNull()
    expect(within(card).queryByTitle(/Verification failed/)).toBeNull()
    expect(within(card).queryByTestId('board-card-cost')).toBeNull()
    // The cost the mark displaced moves into the card's tooltip.
    expect(card).toHaveAttribute('title', 'Cost: ~$0.02 est.')
  })

  it.each([
    // The verdict comes as an object or as the JSON string the board stores.
    ['debt', JSON.stringify({ status: 'completed_with_debt' }), 'Passed with debt', 'text-amber'],
    ['fail', { status: 'fail' }, 'Verification failed', 'text-amber'],
    ['pass', { status: 'pass' }, 'Verified', 'text-mint'],
  ])(
    'marks a %s verdict with one icon, and moves the cost into the tooltip',
    (_case, verification, label, colour) => {
      const card = renderChip(
        makeTask({
          status: 'in_progress',
          verification,
          runCost: { usd: 0.42, estimated: false },
        }),
      )
      const mark = within(card).getByTitle(label)
      expect(mark).toHaveClass(colour)
      // A verdict that did not pass reads amber, never red.
      expect(mark).not.toHaveClass('text-primary')
      expect(within(mark).getByText(label)).toHaveClass('sr-only')
      expect(mark.querySelector('svg')).not.toBeNull()
      expect(within(card).queryByTestId('board-card-cost')).toBeNull()
      expect(card).toHaveAttribute('title', 'Cost: $0.42')
      expect(within(card).queryByText('Verifying')).toBeNull()
    },
  )

  it("shows no Verified on a Done chip, whose stamp's check already says so", () => {
    const card = renderChip(
      makeTask({
        status: 'done',
        verification: { status: 'pass' },
        runCost: { usd: 0.42, estimated: false },
      }),
      { stamp: FINISHED },
    )
    expect(within(card).queryByTitle('Verified')).toBeNull()
    expect(within(card).queryByText('Verified')).toBeNull()
    // With no mark the cost stays on the face, so the card needs no tooltip.
    expect(within(card).getByTestId('board-card-cost')).toBeInTheDocument()
    expect(card).not.toHaveAttribute('title')
    const stamp = within(card).getByTestId('board-card-stamp')
    expect(stamp.querySelector('svg.text-mint')).not.toBeNull()
  })

  it('shows the cost when nothing else is marked, and gives the card no tooltip', () => {
    const card = renderChip(
      makeTask({ status: 'in_progress', runCost: { usd: 0.02, estimated: true } }),
    )
    const cost = within(card).getByTestId('board-card-cost')
    expect(cost).toHaveClass('font-data')
    expect(cost.querySelector('[aria-hidden]')).toHaveTextContent('~$0.02')
    expect(within(cost).getByText('Cost $0.02, estimated')).toHaveClass('sr-only')
    expect(cost).toHaveAttribute('title', '$0.02, estimated, not a charge the runtime reported')
    expect(card).not.toHaveAttribute('title')
  })

  it('falls back to the cost when the verdict cannot be read', () => {
    const card = renderChip(
      makeTask({
        status: 'in_progress',
        verification: '{not json',
        runCost: { usd: 0.42, estimated: false },
      }),
    )
    expect(within(card).getByTestId('board-card-cost')).toBeInTheDocument()
    expect(within(card).queryByTitle(/Verif|debt/)).toBeNull()
    expect(card).not.toHaveAttribute('title')
  })

  it('shows neither a mark nor a cost when the task has neither', () => {
    const card = renderChip(makeTask({ status: 'in_progress' }))
    expect(within(card).queryByTestId('board-card-cost')).toBeNull()
    expect(within(card).queryByTitle(/Verif|debt/)).toBeNull()
    expect(within(card).queryByText('Verifying')).toBeNull()
    expect(card).not.toHaveAttribute('title')
  })

  it.each([
    ['under review', { status: 'in_review' }],
    ['failed', { status: 'in_progress', verification: { status: 'fail' } }],
    ['with debt', { status: 'in_progress', verification: { status: 'completed_with_debt' } }],
    ['verified', { status: 'in_progress', verification: { status: 'pass' } }],
    ['costed', { status: 'done', runCost: { usd: 0.42, estimated: false } }],
    ['a subtask', { status: 'todo', parentTaskId: 'p1' }],
    ['on an unbranded runtime', { status: 'done', assigneeRuntime: 'acme' }],
  ])('draws no filled or uppercase pill in a chip %s', (_case, fields) => {
    const card = renderChip(makeTask(fields))
    expect(card.querySelector('.uppercase, .font-mono')).toBeNull()
    for (const pill of ['pass', 'fail', 'debt', 'acme']) {
      expect(within(card).queryByText(pill, { selector: '.rounded-full' })).toBeNull()
    }
  })
})

describe('a calendar chip: the compact cost', () => {
  it.each([
    [0.004, false, '<$0.01', 'Cost $0.0040', '$0.0040, the cost the runtime reported'],
    [
      0.004,
      true,
      '<$0.01',
      'Cost $0.0040, estimated',
      '$0.0040, estimated, not a charge the runtime reported',
    ],
    [0.42, false, '$0.42', 'Cost $0.42', '$0.42, the cost the runtime reported'],
    [
      0.02,
      true,
      '~$0.02',
      'Cost $0.02, estimated',
      '$0.02, estimated, not a charge the runtime reported',
    ],
    [0, false, '$0.000', 'Cost $0.000', '$0.000, the cost the runtime reported'],
  ])('shows $%s (estimated: %s) as %s', (usd, estimated, shown, spoken, title) => {
    const card = renderChip(makeTask({ status: 'done', runCost: { usd, estimated } }), {
      stamp: FINISHED,
    })
    const cost = within(card).getByTestId('board-card-cost')
    expect(cost.querySelector('[aria-hidden]')?.textContent).toBe(shown)
    expect(cost.querySelector('.sr-only')?.textContent).toBe(spoken)
    expect(cost).toHaveAttribute('title', title)
    // A chip has no room for the undated card's "est." suffix.
    expect(cost).not.toHaveTextContent(/est\./)
  })

  it('keeps the exact figure and the "est." suffix on the undated card', () => {
    const card = renderUndated(
      makeTask({ status: 'done', runCost: { usd: 0.004, estimated: true } }),
    )
    const cost = within(card).getByTestId('board-card-cost')
    expect(cost).toHaveTextContent('~$0.0040 est.')
    expect(cost).toHaveAttribute('title', 'Estimated, not a charge the runtime reported')
    expect(card).not.toHaveTextContent('<$0.01')
  })
})

describe('a calendar chip: a subtask', () => {
  it('marks a subtask with an arrow named for screen readers, not the word "sub"', () => {
    const card = renderChip(makeTask({ status: 'todo', parentTaskId: 'p1' }))
    const mark = within(card).getByTitle('Subtask')
    expect(within(mark).getByText('Subtask')).toHaveClass('sr-only')
    expect(mark.querySelector('svg')).not.toBeNull()
    expect(within(card).queryByText('sub')).toBeNull()
    expect(card).not.toHaveTextContent(/\bsub\b/)
  })

  it('folds the subtask into a verdict mark', () => {
    const card = renderChip(
      makeTask({ status: 'in_progress', parentTaskId: 'p1', verification: { status: 'fail' } }),
    )
    const mark = within(card).getByTitle('Verification failed. Subtask')
    expect(within(mark).getByText('Verification failed. Subtask')).toHaveClass('sr-only')
    expect(within(card).queryByTitle('Subtask')).toBeNull()
    expect(within(card).getAllByText(/Subtask/)).toHaveLength(1)
  })

  it('folds the subtask into Verifying', () => {
    const card = renderChip(makeTask({ status: 'in_review', parentTaskId: 'p1' }))
    const mark = within(card).getByTitle('Verifying. Subtask')
    expect(within(mark).getByText('Verifying')).toBeInTheDocument()
    expect(within(mark).getByText('. Subtask')).toHaveClass('sr-only')
    expect(within(card).queryByTitle('Subtask')).toBeNull()
  })

  it('folds the subtask into the cost', () => {
    const card = renderChip(
      makeTask({ status: 'done', parentTaskId: 'p1', runCost: { usd: 0.42, estimated: false } }),
      { stamp: FINISHED },
    )
    const cost = within(card).getByTestId('board-card-cost')
    expect(cost).toHaveAttribute('title', '$0.42, the cost the runtime reported. Subtask')
    expect(cost.querySelector('.sr-only')?.textContent).toBe('Cost $0.42. Subtask')
    expect(within(card).queryByTitle('Subtask')).toBeNull()
  })

  it('keeps the visible "sub" on the undated card', () => {
    const card = renderUndated(makeTask({ status: 'todo', parentTaskId: 'p1' }))
    expect(within(card).getByText('sub')).not.toHaveClass('sr-only')
  })
})

describe('a calendar chip: the stamp', () => {
  it('sets a time in mono and a date in Inter, at the end of the row', () => {
    const card = renderChip(makeTask())
    const time = within(card).getByTestId('board-card-stamp')
    expect(time).toHaveClass('font-data', 'ml-auto')
    expect(time).toHaveAttribute('title', 'Added Oct 14, 9:41 AM')
    expect(time).toHaveTextContent('9:41 AM')
    expect(within(time).getByText(', Added Oct 14, 9:41 AM')).toHaveClass('sr-only')
    cleanup()

    const dated = within(renderChip(makeTask(), { stamp: DATED })).getByTestId('board-card-stamp')
    expect(dated).not.toHaveClass('font-data')
    expect(dated).toHaveClass('ml-auto', 'tabular-nums')
    expect(dated).toHaveTextContent('Oct 12')
  })

  it('carries a mint check when the task finished, and none while it is open', () => {
    const open = within(renderChip(makeTask())).getByTestId('board-card-stamp')
    expect(open.querySelector('svg')).toBeNull()
    cleanup()

    const finished = within(
      renderChip(makeTask({ status: 'done' }), { stamp: FINISHED }),
    ).getByTestId('board-card-stamp')
    expect(finished.querySelector('svg.text-mint')).not.toBeNull()
  })
})

describe('a calendar chip: its state', () => {
  it('is a chip in its column colour, with the tooltip ids the board relies on', () => {
    const card = renderChip(makeTask())
    expect(card).toHaveClass('calendar-chip')
    expect(card.style.getPropertyValue('--chip')).toBe(ACCENT)
    expect(card).toHaveAttribute('data-focus-restore-id', 't1')
    // The chip's CSS owns its transitions.
    expect(card.className).not.toMatch(/transition|duration-/)
    for (const cls of STATE_CLASSES) expect(card).not.toHaveClass(cls)
    expect(card).not.toHaveAttribute('data-open')
    expect(card).not.toHaveAttribute('data-past')
  })

  it('says its drawer is open and that it finished on an earlier day', () => {
    const card = renderChip(makeTask({ status: 'done' }), {
      stamp: FINISHED,
      open: true,
      past: true,
    })
    expect(card).toHaveAttribute('data-open', 'true')
    expect(card).toHaveAttribute('data-past', 'true')
  })

  it.each([
    ['arrived', 'calendar-chip--arrived', true],
    ['settle', 'calendar-chip--settle', true],
    ['lifted', 'calendar-chip--lifted', false],
    ['dragging', 'calendar-chip--source', false],
  ])('takes %s as %s', (prop, cls, lifts) => {
    const card = renderChip(makeTask(), { [prop]: true })
    expect(card).toHaveClass(cls)
    for (const other of STATE_CLASSES.filter((c) => c !== cls)) expect(card).not.toHaveClass(other)
    // A card in the hand, or the copy it left behind, stays put under the pointer.
    if (lifts) expect(card).toHaveClass('hover:-translate-y-px')
    else expect(card).not.toHaveClass('hover:-translate-y-px')
  })

  it('lifts on hover at rest', () => {
    expect(renderChip(makeTask())).toHaveClass('hover:-translate-y-px')
  })

  it('stops the title short of the drag grip on a chip only', () => {
    const chip = renderChip(makeTask())
    expect(within(chip).getByText('Draft the launch note').style.paddingRight).toBe('18px')
    cleanup()
    const card = renderUndated(makeTask())
    expect(within(card).getByText('Draft the launch note').style.paddingRight).toBe('')
  })

  it('strikes through a cancelled chip, and names an untitled one', () => {
    const card = renderChip(makeTask({ status: 'cancelled', title: undefined }), {
      stamp: FINISHED,
    })
    expect(within(card).getByText('(untitled)')).toHaveClass('line-through')
  })

  it.each([
    ['the undated card', undefined, undefined],
    ['a stamped card with no column colour', ADDED, undefined],
  ])('keeps chip state off %s, whatever it is passed', (_case, stamp, accent) => {
    render(
      <ThemeProvider>
        <TaskCard
          task={makeTask({ status: 'done' })}
          onClick={() => {}}
          stamp={stamp}
          accent={accent}
          open
          past
          arrived
          settle
          lifted
          dragging
        />
      </ThemeProvider>,
    )
    const card = screen.getByTestId('board-card')
    expect(card).not.toHaveAttribute('data-open')
    expect(card).not.toHaveAttribute('data-past')
    expect(card).not.toHaveClass('calendar-chip')
    for (const cls of STATE_CLASSES) expect(card).not.toHaveClass(cls)
    expect(card).toHaveClass('border-border', 'hover:-translate-y-px')
  })
})

describe('the undated card', () => {
  it('shows a runtime pill only when the task has a runtime', () => {
    const unassigned = renderUndated(makeTask({ status: 'todo', assigneeRuntime: 'openclaw' }))
    expect(unassigned).not.toHaveTextContent(/openclaw/i)
    expect(unassigned.querySelector('.uppercase')).toBeNull()
    cleanup()

    seedFleet([{ id: 'agent-7', name: 'Coder', runtime: 'codex' }])
    const open = renderUndated(
      makeTask({ status: 'in_progress', assigneeAgentId: 'agent-7', assigneeRuntime: 'openclaw' }),
    )
    expect(within(open).getByText('codex')).toHaveClass('uppercase')
    expect(open).not.toHaveTextContent(/openclaw/i)
  })

  it('keeps its Verifying and verdict pills', () => {
    const card = renderUndated(makeTask({ status: 'in_review', verification: { status: 'fail' } }))
    expect(within(card).getByText('Verifying')).toHaveClass('uppercase')
    expect(within(card).getByText('fail')).toHaveClass('uppercase')
  })
})

// ── DraggableCard ──

function DndHarness({
  children,
  onDragStart,
  onDragEnd,
}: {
  children: ReactNode
  onDragStart: (e: DragStartEvent) => void
  onDragEnd: (e: DragEndEvent) => void
}) {
  // The board's sensors: a 5px pointer drag, and Space on the grip.
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
    useSensor(KeyboardSensor),
  )
  return (
    <DndContext sensors={sensors} onDragStart={onDragStart} onDragEnd={onDragEnd}>
      {children}
    </DndContext>
  )
}

type DraggableProps = Partial<ComponentProps<typeof DraggableCard>>

function renderDraggable(props: DraggableProps = {}) {
  const onOpen = vi.fn()
  const onDragStart = vi.fn<(e: DragStartEvent) => void>()
  const onDragEnd = vi.fn<(e: DragEndEvent) => void>()
  render(
    <ThemeProvider>
      <DndHarness onDragStart={onDragStart} onDragEnd={onDragEnd}>
        <DraggableCard
          task={makeTask({ status: 'in_review' })}
          disabled={false}
          onOpen={onOpen}
          stamp={ADDED}
          accent={ACCENT}
          {...props}
        />
      </DndHarness>
    </ThemeProvider>,
  )
  return {
    card: screen.getByTestId('board-card'),
    grip: screen.queryByRole('button', { name: /^Drag to move/ }),
    onOpen,
    onDragStart,
    onDragEnd,
  }
}

const AT = { clientX: 10, clientY: 10, pointerId: 1, isPrimary: true }

/** Presses `el` with a pointer and moves it `dx` px across the page. */
function press(el: Element, pointerType: string, { button = 0, dx = 20 } = {}): void {
  fireEvent.pointerDown(el, { ...AT, pointerType, button })
  fireEvent.pointerMove(document, { ...AT, pointerType, clientX: AT.clientX + dx })
}

/** Lets go, then lets dnd-kit lift the click-swallower it leaves on the document
 *  for 50ms after a drag, so no test inherits it. */
function letGo(): void {
  fireEvent.pointerUp(document, AT)
  act(() => {
    vi.advanceTimersByTime(60)
  })
}

describe('DraggableCard: pointer drags', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] })
  })

  it.each(['mouse', 'pen'])('starts a drag with a %s from anywhere on the card', (pointer) => {
    const { card, onDragStart, onDragEnd, onOpen } = renderDraggable()
    press(card, pointer)
    expect(onDragStart).toHaveBeenCalledTimes(1)
    const active = onDragStart.mock.calls[0]![0].active
    expect(active.id).toBe('t1')
    // The announcements read the card's title, its column and whether it sits on
    // today's row from here.
    expect(active.data.current).toEqual({
      fromStatus: 'in_review',
      fromColumn: 'in_progress',
      title: 'Draft the launch note',
      sitsToday: true,
    })
    // The copy left in its cell is marked, and stops lifting on hover.
    expect(card).toHaveClass('calendar-chip--source')
    expect(card).not.toHaveClass('hover:-translate-y-px')
    expect(card.parentElement!.style.opacity).toBe('1')
    letGo()
    expect(onDragEnd).toHaveBeenCalledTimes(1)
    expect(card).not.toHaveClass('calendar-chip--source')
    expect(onOpen).not.toHaveBeenCalled()
  })

  it('fades the undated card while it is dragged, instead of marking it', () => {
    const { card, onDragStart } = renderDraggable({ stamp: undefined, accent: undefined })
    press(card, 'mouse')
    expect(onDragStart).toHaveBeenCalledTimes(1)
    expect(card.parentElement!.style.opacity).toBe('0.4')
    expect(card).not.toHaveClass('calendar-chip--source')
    letGo()
    expect(card.parentElement!.style.opacity).toBe('1')
  })

  it('leaves a touch on the card body to scroll the board', () => {
    const { card, onDragStart } = renderDraggable()
    press(card, 'touch')
    expect(onDragStart).not.toHaveBeenCalled()
    letGo()
  })

  it('starts no drag from a secondary button', () => {
    const { card, onDragStart } = renderDraggable()
    press(card, 'mouse', { button: 2 })
    expect(onDragStart).not.toHaveBeenCalled()
    letGo()
  })

  it('drags from the grip by touch', () => {
    const { grip, onDragStart } = renderDraggable()
    press(grip!, 'touch')
    expect(onDragStart).toHaveBeenCalledTimes(1)
    letGo()
  })

  it('opens on a press that never travels 5px', () => {
    const { card, onDragStart, onOpen } = renderDraggable()
    press(card, 'mouse', { dx: 3 })
    letGo()
    fireEvent.click(card, { detail: 1 })
    expect(onDragStart).not.toHaveBeenCalled()
    expect(onOpen).toHaveBeenCalledTimes(1)
  })

  it('ignores the click a drop leaves behind, then opens on the next one', () => {
    const { card, grip, onOpen, onDragEnd } = renderDraggable()
    press(card, 'mouse')
    letGo() // 60ms on: dnd-kit's own click guard is gone, the card's is not
    expect(onDragEnd).toHaveBeenCalledTimes(1)
    act(() => {
      vi.advanceTimersByTime(100)
    })
    fireEvent.click(card, { detail: 1 })
    fireEvent.click(grip!, { detail: 1 })
    expect(onOpen).not.toHaveBeenCalled()

    act(() => {
      vi.advanceTimersByTime(150)
    })
    fireEvent.click(card, { detail: 1 })
    expect(onOpen).toHaveBeenCalledTimes(1)
  })

  it('renders no grip and drags nothing when disabled, but still opens', () => {
    const { card, grip, onDragStart, onOpen } = renderDraggable({ disabled: true })
    expect(grip).toBeNull()
    press(card, 'mouse')
    expect(onDragStart).not.toHaveBeenCalled()
    letGo()
    fireEvent.click(card, { detail: 1 })
    expect(onOpen).toHaveBeenCalledTimes(1)
  })
})

describe('DraggableCard: keys, clicks and the grip', () => {
  it('picks the card up with Space on the grip, and never opens it', async () => {
    const user = userEvent.setup()
    const { card, grip, onDragStart, onOpen } = renderDraggable()
    // Tab reaches the card, then its grip: the grip is the keyboard's handle.
    await user.tab()
    expect(card).toHaveFocus()
    await user.tab()
    expect(grip).toHaveFocus()
    await user.keyboard(' ')
    expect(onDragStart).toHaveBeenCalledTimes(1)
    expect(onDragStart.mock.calls[0]![0].active.id).toBe('t1')
    expect(onOpen).not.toHaveBeenCalled()
    await user.keyboard('{Escape}')
  })

  it('does not pick the card up with Space on the card itself', async () => {
    const user = userEvent.setup()
    const { card, onDragStart, onOpen } = renderDraggable()
    fireEvent.keyDown(card, { key: ' ', code: 'Space' })
    expect(onDragStart).not.toHaveBeenCalled()
    // Space on the card is a plain button press: it opens the drawer.
    card.focus()
    await user.keyboard(' ')
    expect(onDragStart).not.toHaveBeenCalled()
    expect(onOpen).toHaveBeenCalledTimes(1)
  })

  it('opens on a pointer click on the grip, but not on the click a key makes', async () => {
    const user = userEvent.setup()
    const { grip, onOpen, onDragStart } = renderDraggable()
    fireEvent.click(grip!, { detail: 0 })
    expect(onOpen).not.toHaveBeenCalled()
    await user.click(grip!)
    expect(onOpen).toHaveBeenCalledTimes(1)
    expect(onDragStart).not.toHaveBeenCalled()
  })

  it('opens on a plain click on the card', async () => {
    const user = userEvent.setup()
    const { card, onOpen, onDragStart } = renderDraggable()
    await user.click(card)
    expect(onOpen).toHaveBeenCalledTimes(1)
    expect(onDragStart).not.toHaveBeenCalled()
  })

  it('gives the drag semantics and touch handling to the grip alone', () => {
    const { card, grip } = renderDraggable()
    expect(grip).toHaveAccessibleName('Drag to move “Draft the launch note” to another column')
    expect(grip).toHaveAttribute('aria-roledescription', 'draggable')
    const describedBy = grip!.getAttribute('aria-describedby')
    expect(describedBy).toBeTruthy()
    expect(document.getElementById(describedBy!)).toHaveTextContent(/space/i)
    expect(grip!.style.touchAction).toBe('none')

    expect(card).not.toHaveAttribute('aria-roledescription')
    expect(card).not.toHaveAttribute('aria-describedby')
    expect(card).not.toHaveAttribute('aria-disabled')
    expect(card.style.touchAction).toBe('')
    expect(card.parentElement!.style.touchAction).toBe('')
  })

  it('shows the grip only to keyboard focus and to screens without hover', () => {
    const { grip } = renderDraggable()
    expect(grip).toHaveClass('opacity-0', 'focus-visible:opacity-100')
    expect(grip).toHaveClass('[@media(hover:none)]:opacity-100')
    expect(grip!.className).not.toMatch(/group-hover/)
    // Hidden from a mouse, the corner it covers shows a pointer, not a grab hand.
    expect(grip).toHaveClass('cursor-pointer', 'focus-visible:cursor-grab')
    expect(grip).not.toHaveClass('cursor-grab')
  })

  it('names the grip of an untitled task', () => {
    const { grip } = renderDraggable({ task: makeTask({ title: undefined }) })
    expect(grip).toHaveAccessibleName('Drag to move “task” to another column')
  })

  it('passes its states through to the chip', () => {
    const { card } = renderDraggable({
      task: makeTask({ status: 'done' }),
      stamp: FINISHED,
      open: true,
      past: true,
      arrived: true,
      settle: true,
    })
    expect(card).toHaveAttribute('data-open', 'true')
    expect(card).toHaveAttribute('data-past', 'true')
    expect(card).toHaveClass('calendar-chip--arrived', 'calendar-chip--settle')
    expect(card).not.toHaveClass('calendar-chip--source')
  })
})
