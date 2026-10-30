// The Board's Find popover on its own: the combobox field and its focus on open,
// the grouped results, the arrows and Home/End, Enter and Shift+Enter, a routine
// always opening, the pointer, Escape and a press outside, the "+N more" footer,
// and the empty and no-match lines. The search is a fake over fixed results, so
// the matching itself is findModel's test, not this one.

import { cleanup, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { ThemeProvider } from '@/features/theme/ThemeProvider'
import type { BoardTask } from '@/lib/boardClient'
import type { RoutineOccurrences } from '@/lib/schedulesClient'

import { axe } from '../../../../__vitest__/axe'
import { FindPopover, type FindPopoverProps } from '../FindPopover'
import {
  FIND_LIMIT,
  type FindResult,
  type FindRoutineResult,
  type FindTaskResult,
} from '../findModel'

function taskResult(
  id: string,
  title: string,
  fields: Partial<Omit<FindTaskResult, 'kind' | 'id' | 'task'>> & {
    assignee?: string
  } = {},
): FindTaskResult {
  const { assignee, ...rest } = fields
  const task = { id, title, status: 'todo', assigneeAgentId: assignee ?? null } as BoardTask
  return {
    kind: 'task',
    id,
    task,
    column: 'todo',
    at: null,
    where: 'here',
    matchedOn: 'title',
    score: 100,
    ...rest,
  }
}

function routineResult(id: string, name: string): FindRoutineResult {
  const routine = { schedule: { id }, windows: [] } as unknown as RoutineOccurrences
  return { kind: 'routine', id, routine, name, score: 80 }
}

const DRAFT = taskResult('t1', 'Draft the launch note', { assignee: 'ada' })
const REVIEW = taskResult('t2', 'Review the launch copy', {
  where: 'before',
  matchedOn: 'agent',
  assignee: 'ada',
})
const NOTES = taskResult('t3', 'Launch notes from the call', {
  where: 'after',
  matchedOn: 'description',
})
const BY_ID = taskResult('t4', 'Pricing page', { matchedOn: 'id' })
const DIGEST = routineResult('clawboo-routine:r1', 'Launch digest')

/** The results in the order the popover draws them: the range, before, after, routines. */
const ALL: FindResult[] = [DRAFT, BY_ID, REVIEW, NOTES, DIGEST]

/** Everything for "launch", nothing for anything else. */
function fakeSearch(query: string): FindResult[] {
  return query.trim().toLowerCase() === 'launch' ? ALL : []
}

let anchor: HTMLButtonElement

beforeEach(() => {
  anchor = document.createElement('button')
  anchor.textContent = 'Find'
  document.body.appendChild(anchor)
  anchor.focus()
})

afterEach(() => {
  cleanup()
  anchor.remove()
})

function renderFind(props: Partial<FindPopoverProps> = {}) {
  const onPick = vi.fn()
  const onClose = vi.fn()
  const element = (more: Partial<FindPopoverProps>) => (
    <ThemeProvider>
      <FindPopover
        anchor={anchor}
        search={fakeSearch}
        scope="week"
        findsRoutines
        columnName={(column) => (column === 'cancelled' ? 'Cancelled' : 'To do')}
        dayLabel={(at) => (at == null ? 'No date' : 'Today')}
        ownerOf={(task) => (task.assigneeAgentId as string | null) ?? null}
        agentName={(id) => (id === 'ada' ? 'Ada' : null)}
        onPick={onPick}
        onClose={onClose}
        {...props}
        {...more}
      />
    </ThemeProvider>
  )
  const { rerender } = render(element({}))
  return {
    onPick,
    onClose,
    rerenderWith: (more: Partial<FindPopoverProps>) => rerender(element(more)),
  }
}

/** The popover's field, once it has taken focus. */
async function field(): Promise<HTMLElement> {
  const input = await screen.findByRole('combobox', {
    name: 'Find a task, an agent or a routine',
  })
  await waitFor(() => expect(input).toHaveFocus())
  return input
}

describe('FindPopover', () => {
  it('opens with the combobox field focused and a hint to type', async () => {
    renderFind()
    const input = await field()
    expect(input).toHaveAttribute('aria-autocomplete', 'list')
    expect(input).toHaveAttribute('aria-expanded', 'false')
    expect(input).not.toHaveAttribute('aria-activedescendant')
    expect(screen.getByText('Type to find a task, an agent or a routine.')).toBeInTheDocument()
    expect(screen.getByText('Enter shows it · Shift+Enter opens it')).toBeInTheDocument()
    expect(screen.queryByRole('listbox')).toBeNull()
  })

  it('groups the results by where they sit, routines last', async () => {
    const user = userEvent.setup()
    renderFind()
    await user.type(await field(), 'launch')

    const listbox = screen.getByRole('listbox')
    expect(screen.getByRole('combobox')).toHaveAttribute('aria-controls', listbox.id)
    expect(screen.getByRole('combobox')).toHaveAttribute('aria-expanded', 'true')
    const groups = within(listbox).getAllByRole('group')
    expect(groups.map((g) => g.getAttribute('aria-label'))).toEqual([
      'In this week',
      'Before this week',
      'After this week',
      'Routines',
    ])
    const onScreen = within(groups[0]!).getAllByRole('option')
    expect(onScreen.map((o) => o.textContent)).toEqual([
      expect.stringContaining('Draft the launch note'),
      expect.stringContaining('Pricing page'),
    ])
    expect(within(groups[3]!).getByRole('option')).toHaveTextContent('Launch digestRoutine')
  })

  it('says why a task matched when it was not on its title', async () => {
    const user = userEvent.setup()
    renderFind()
    await user.type(await field(), 'launch')
    const options = screen.getAllByRole('option')
    expect(options[0]).not.toHaveTextContent('Agent:')
    expect(options[1]).toHaveTextContent('Task id')
    expect(options[2]).toHaveTextContent('Agent: Ada')
    expect(options[3]).toHaveTextContent('In the details')
  })

  it('reads "Tasks" for the first group in the All view', async () => {
    const user = userEvent.setup()
    renderFind({ scope: 'all', search: (q) => (q ? [DRAFT, DIGEST] : []) })
    await user.type(await field(), 'x')
    expect(screen.getByRole('group', { name: 'Tasks' })).toBeInTheDocument()
    expect(screen.getByRole('group', { name: 'Routines' })).toBeInTheDocument()
  })

  it('walks the rows with the arrows, wrapping, and leaves Home and End to the field', async () => {
    const user = userEvent.setup()
    renderFind()
    const input = await field()
    await user.type(input, 'launch')
    const options = screen.getAllByRole('option')
    const activeIs = (i: number) => {
      expect(input).toHaveAttribute('aria-activedescendant', options[i]!.id)
      options.forEach((o, j) => expect(o).toHaveAttribute('aria-selected', String(i === j)))
    }

    activeIs(0)
    await user.keyboard('{ArrowDown}')
    activeIs(1)
    await user.keyboard('{ArrowUp}{ArrowUp}')
    activeIs(options.length - 1)
    await user.keyboard('{ArrowDown}')
    activeIs(0)
    // Home and End move the caret, as in any text field.
    await user.keyboard('{End}')
    activeIs(0)
    await user.keyboard('{ArrowDown}{Home}')
    activeIs(1)
  })

  it('keeps the highlighted result when the list is redrawn under it', async () => {
    const user = userEvent.setup()
    let list = ALL
    const view = renderFind({ search: (q) => (q.trim() ? list : []) })
    const input = await field()
    await user.type(input, 'la')
    await user.keyboard('{ArrowDown}{ArrowDown}')
    const picked = screen.getAllByRole('option')[2]!.textContent
    // A board refresh drops a result above it, shifting every row after it up.
    list = ALL.filter((r) => r !== BY_ID)
    view.rerenderWith({ search: (q) => (q.trim() ? list : []) })
    const active = screen
      .getAllByRole('option')
      .find((o) => o.getAttribute('aria-selected') === 'true')
    expect(active?.textContent).toBe(picked)
  })

  it('says the column of each result, which its dot shows only in colour', async () => {
    const user = userEvent.setup()
    renderFind()
    await user.type(await field(), 'launch')
    expect(screen.getAllByRole('option')[0]).toHaveTextContent(', To do')
  })

  it('ties the keys hint to the field and offers no routines where none can be found', async () => {
    renderFind({ scope: 'all', findsRoutines: false })
    const input = await screen.findByRole('combobox', { name: 'Find a task or an agent' })
    const hint = screen.getByText('Enter shows it · Shift+Enter opens it')
    expect(input).toHaveAttribute('aria-describedby', hint.id)
    expect(screen.getByText('Type to find a task or an agent.')).toBeInTheDocument()
  })

  it('goes back to the first row when the query changes', async () => {
    const user = userEvent.setup()
    renderFind({ search: (q) => (q.trim() ? ALL : []) })
    const input = await field()
    await user.type(input, 'la')
    await user.keyboard('{ArrowDown}{ArrowDown}')
    expect(screen.getAllByRole('option')[2]).toHaveAttribute('aria-selected', 'true')
    await user.type(input, 'u')
    expect(screen.getAllByRole('option')[0]).toHaveAttribute('aria-selected', 'true')
  })

  it('shows a task on Enter and opens it on Shift+Enter', async () => {
    const user = userEvent.setup()
    const { onPick } = renderFind()
    const input = await field()
    await user.type(input, 'launch')

    await user.keyboard('{Enter}')
    expect(onPick).toHaveBeenLastCalledWith(DRAFT, 'reveal')

    await user.keyboard('{ArrowDown}{Shift>}{Enter}{/Shift}')
    expect(onPick).toHaveBeenLastCalledWith(BY_ID, 'open')
    expect(onPick).toHaveBeenCalledTimes(2)
  })

  it('always opens a routine', async () => {
    const user = userEvent.setup()
    const { onPick } = renderFind()
    await user.type(await field(), 'launch')

    // Up from the first row wraps to the last, the routine.
    await user.keyboard('{ArrowUp}{Enter}')
    expect(onPick).toHaveBeenLastCalledWith(DIGEST, 'open')
    await user.keyboard('{Shift>}{Enter}{/Shift}')
    expect(onPick).toHaveBeenLastCalledWith(DIGEST, 'open')
  })

  it('does nothing on Enter with no results', async () => {
    const user = userEvent.setup()
    const { onPick } = renderFind()
    await user.type(await field(), 'nothing{Enter}')
    expect(onPick).not.toHaveBeenCalled()
  })

  it('follows the pointer and picks the row clicked, keeping focus in the field', async () => {
    const user = userEvent.setup()
    const { onPick } = renderFind()
    const input = await field()
    await user.type(input, 'launch')
    const options = screen.getAllByRole('option')

    await user.hover(options[2]!)
    expect(options[2]).toHaveAttribute('aria-selected', 'true')
    expect(input).toHaveAttribute('aria-activedescendant', options[2]!.id)

    await user.click(options[2]!)
    expect(onPick).toHaveBeenLastCalledWith(REVIEW, 'reveal')
    expect(input).toHaveFocus()

    await user.click(options[4]!)
    expect(onPick).toHaveBeenLastCalledWith(DIGEST, 'open')
  })

  it('closes on Escape and on a press outside, but not on a press inside', async () => {
    const user = userEvent.setup()
    const { onClose } = renderFind()
    const input = await field()

    await user.click(input)
    expect(onClose).not.toHaveBeenCalled()
    await user.keyboard('{Escape}')
    expect(onClose).toHaveBeenCalledTimes(1)

    await user.click(document.body)
    expect(onClose).toHaveBeenCalledTimes(2)
  })

  it('lists the first matches and says how many more there are', async () => {
    const user = userEvent.setup()
    const many = Array.from({ length: FIND_LIMIT + 3 }, (_, i) =>
      taskResult(`m${i}`, `Launch step ${i + 1}`),
    )
    renderFind({ search: (q) => (q.trim() ? many : []) })
    await user.type(await field(), 'step')

    expect(screen.getAllByRole('option')).toHaveLength(FIND_LIMIT)
    expect(screen.getByText('+3 more. Keep typing to narrow it.')).toBeInTheDocument()
    expect(screen.getByRole('status')).toHaveTextContent(`${FIND_LIMIT + 3} results`)
  })

  it('says when nothing matches, and clearing goes back to the hint', async () => {
    const user = userEvent.setup()
    renderFind()
    const input = await field()
    await user.type(input, '  zzz ')
    expect(screen.getByText('No matches for “zzz”.')).toBeInTheDocument()
    expect(screen.queryByText(/more\. Keep typing/)).toBeNull()

    await user.click(screen.getByRole('button', { name: 'Clear search' }))
    expect(input).toHaveValue('')
    expect(input).toHaveFocus()
    expect(screen.getByText('Type to find a task, an agent or a routine.')).toBeInTheDocument()
  })

  it('has no axe violations while it lists results', async () => {
    const user = userEvent.setup()
    renderFind()
    await user.type(await field(), 'launch')
    expect(await axe(screen.getByTestId('calendar-find'))).toHaveNoViolations()
  })
})
