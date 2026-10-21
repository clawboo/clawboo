// FinishPromptDialog: what a person sees when they move a task to Done or
// Cancelled by hand. Driven imperatively through askFinish(), as the board's drag
// and the task drawer drive it, and resolves the day picked or null.
//
// Every request carries its own clock, so the suite fixes "now" on a Wednesday
// rather than faking timers. Date labels come from the same formatters the
// dialog uses, so the names hold in any locale and time zone.

import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it } from 'vitest'

import { axe } from '@/__vitest__/axe'
import {
  askFinish,
  useFinishPromptStore,
  type FinishChoice,
  type FinishPromptRequest,
} from '@/stores/finishPrompt'

import { longDate, shortDate } from '../calendar/calendarFormat'
import { startOfDay } from '../calendar/calendarModel'
import { FinishPromptDialog } from '../FinishPromptDialog'

const at = (y: number, mo: number, d: number, h = 0, mi = 0): number =>
  new Date(y, mo, d, h, mi).getTime()

// Wednesday 14 October 2026, mid-afternoon; the task was added the Saturday before.
const NOW = at(2026, 9, 14, 15, 20)
const TODAY = startOfDay(NOW)
const ADDED = at(2026, 9, 10, 9)
const SITS = at(2026, 9, 10)

function request(over: Partial<FinishPromptRequest> = {}): FinishPromptRequest {
  return {
    to: 'done',
    title: 'Write the brief',
    sitsOn: SITS,
    createdAt: ADDED,
    runningAgent: null,
    failedCheck: false,
    now: NOW,
    weekStartsOn: 0,
    ...over,
  }
}

/** Open the prompt; `result()` reads what it resolved (undefined while open). */
async function open(over: Partial<FinishPromptRequest> = {}) {
  let resolved: FinishChoice | null | undefined
  act(() => {
    void askFinish(request(over)).then((v) => (resolved = v))
  })
  const dialog = await screen.findByTestId('finish-prompt')
  return { dialog, result: () => resolved }
}

/** The picker's button for the local day holding `ms`. */
function dayButton(ms: number, today = false): HTMLElement {
  const picker = screen.getByTestId('finish-day-picker')
  return within(picker).getByRole('button', { name: `${longDate(ms)}${today ? ', today' : ''}` })
}

afterEach(() => {
  // Back out of any prompt still open so its promise can't reach the next test.
  if (useFinishPromptStore.getState().open) act(() => useFinishPromptStore.getState().settle(null))
  cleanup()
})

describe('FinishPromptDialog days', () => {
  it('renders nothing until askFinish() is called', () => {
    const { container } = render(<FinishPromptDialog />)
    expect(container).toBeEmptyDOMElement()
  })

  it('offers today, the day the card sits on and another day, with today picked', async () => {
    render(<FinishPromptDialog />)
    const { result } = await open()
    const group = screen.getByRole('radiogroup', { name: 'Finished on' })
    const radios = within(group).getAllByRole('radio')
    expect(radios.map((r) => r.getAttribute('data-option'))).toEqual(['today', 'sits', 'other'])
    expect(screen.getByTestId('finish-day-today')).toHaveAttribute('aria-checked', 'true')
    expect(screen.getByTestId('finish-day-today')).toHaveTextContent(shortDate(TODAY))
    expect(screen.getByTestId('finish-day-sits')).toHaveAttribute('aria-checked', 'false')
    expect(screen.getByTestId('finish-day-sits')).toHaveTextContent(shortDate(SITS))
    expect(screen.queryByTestId('finish-day-picker')).not.toBeInTheDocument()

    await userEvent.click(screen.getByTestId('finish-ok'))
    await waitFor(() => expect(result()).toEqual({ day: TODAY }))
  })

  it('resolves the day the card sits on when that is picked', async () => {
    render(<FinishPromptDialog />)
    const { result } = await open()
    await userEvent.click(screen.getByTestId('finish-day-sits'))
    expect(screen.getByTestId('finish-day-sits')).toHaveAttribute('aria-checked', 'true')
    expect(screen.getByTestId('finish-day-today')).toHaveAttribute('aria-checked', 'false')
    await userEvent.click(screen.getByTestId('finish-ok'))
    await waitFor(() => expect(result()).toEqual({ day: SITS }))
  })

  it('moves between the days with the arrow keys, one tab stop for the group', async () => {
    const user = userEvent.setup()
    render(<FinishPromptDialog />)
    await open()
    const today = screen.getByTestId('finish-day-today')
    const sits = screen.getByTestId('finish-day-sits')
    const other = screen.getByTestId('finish-day-other')
    expect([today.tabIndex, sits.tabIndex, other.tabIndex]).toEqual([0, -1, -1])

    act(() => today.focus())
    await user.keyboard('{ArrowDown}')
    expect(sits).toHaveFocus()
    expect(sits).toHaveAttribute('aria-checked', 'true')
    expect([today.tabIndex, sits.tabIndex, other.tabIndex]).toEqual([-1, 0, -1])

    await user.keyboard('{ArrowRight}')
    expect(other).toHaveFocus()
    expect(other).toHaveAttribute('aria-checked', 'true')

    // It wraps at both ends.
    await user.keyboard('{ArrowDown}')
    expect(today).toHaveFocus()
    expect(today).toHaveAttribute('aria-checked', 'true')
    await user.keyboard('{ArrowUp}')
    expect(other).toHaveFocus()
    await user.keyboard('{ArrowLeft}')
    expect(sits).toHaveFocus()
    expect(sits).toHaveAttribute('aria-checked', 'true')
  })

  it('offers only today and the card’s day when the card sits on yesterday', async () => {
    render(<FinishPromptDialog />)
    const yesterday = at(2026, 9, 13)
    await open({ sitsOn: yesterday, createdAt: at(2026, 9, 13, 11) })
    const group = screen.getByTestId('finish-day-options')
    expect(within(group).getAllByRole('radio')).toHaveLength(2)
    expect(screen.queryByTestId('finish-day-other')).not.toBeInTheDocument()
  })

  it('shows no days at all when the card already sits on today', async () => {
    render(<FinishPromptDialog />)
    const { result } = await open({ to: 'cancelled', sitsOn: null, createdAt: at(2026, 9, 14, 9) })
    expect(screen.queryByTestId('finish-day-options')).not.toBeInTheDocument()
    expect(screen.queryByRole('radio')).not.toBeInTheDocument()
    await userEvent.click(screen.getByTestId('finish-ok'))
    await waitFor(() => expect(result()).toEqual({ day: TODAY }))
  })
})

describe('FinishPromptDialog picking another day', () => {
  it('opens a month bounded from the day the task was added to yesterday', async () => {
    render(<FinishPromptDialog />)
    await open()
    await userEvent.click(screen.getByTestId('finish-day-other'))
    expect(screen.getByTestId('finish-day-picker')).toBeInTheDocument()

    // Before the task existed: not pickable.
    expect(dayButton(at(2026, 9, 9))).toBeDisabled()
    expect(dayButton(at(2026, 8, 30))).toBeDisabled()
    // From the day it was added through yesterday: pickable.
    for (const d of [10, 11, 12, 13]) expect(dayButton(at(2026, 9, d))).toBeEnabled()
    // Today has its own option; later days have not happened.
    expect(dayButton(TODAY, true)).toBeDisabled()
    expect(dayButton(at(2026, 9, 15))).toBeDisabled()
    // The whole range is this month, so neither month button can move.
    expect(screen.getByRole('button', { name: 'Previous month' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Next month' })).toBeDisabled()
  })

  it('resolves the day clicked in the month', async () => {
    render(<FinishPromptDialog />)
    const { result } = await open()
    await userEvent.click(screen.getByTestId('finish-day-other'))
    const picked = at(2026, 9, 12)
    await userEvent.click(dayButton(picked))
    expect(screen.getByTestId('finish-day-other')).toHaveTextContent(shortDate(picked))
    expect(result()).toBeUndefined()
    await userEvent.click(screen.getByTestId('finish-ok'))
    await waitFor(() => expect(result()).toEqual({ day: picked }))
  })

  it('picks with Enter inside the month without confirming the prompt', async () => {
    const user = userEvent.setup()
    render(<FinishPromptDialog />)
    const { result } = await open()
    await user.click(screen.getByTestId('finish-day-other'))
    // The month starts on the day after the card's own day.
    const start = dayButton(at(2026, 9, 11))
    expect(start.tabIndex).toBe(0)
    act(() => start.focus())

    await user.keyboard('{ArrowRight}')
    const next = dayButton(at(2026, 9, 12))
    await waitFor(() => expect(next).toHaveFocus())
    await user.keyboard('{Enter}')

    expect(result()).toBeUndefined()
    expect(screen.getByTestId('finish-prompt')).toBeInTheDocument()
    expect(screen.getByTestId('finish-day-other')).toHaveTextContent(shortDate(at(2026, 9, 12)))

    // A week on is past yesterday, so the arrow stops at yesterday.
    await user.keyboard('{ArrowDown}')
    await waitFor(() => expect(dayButton(at(2026, 9, 13))).toHaveFocus())

    await user.click(screen.getByTestId('finish-ok'))
    await waitFor(() => expect(result()).toEqual({ day: at(2026, 9, 13) }))
  })
})

describe('FinishPromptDialog wording', () => {
  it('says a cancel cannot be undone', async () => {
    render(<FinishPromptDialog />)
    await open({ to: 'cancelled', title: 'Ship it' })
    expect(screen.getByRole('alertdialog', { name: 'Cancel “Ship it”?' })).toBeInTheDocument()
    expect(screen.getByText('It moves to Cancelled and will not run again.')).toBeInTheDocument()
    expect(screen.getByTestId('finish-ok')).toHaveTextContent('Cancel task')
    expect(screen.getByRole('radiogroup', { name: 'Put it on' })).toBeInTheDocument()
  })

  it('names the agent whose run the move stops', async () => {
    render(<FinishPromptDialog />)
    await open({ runningAgent: 'Ada' })
    expect(
      screen.getByRole('alertdialog', { name: 'Mark “Write the brief” done' }),
    ).toBeInTheDocument()
    expect(screen.getByText('Ada is still working on it. This stops that run.')).toBeInTheDocument()
    expect(screen.getByTestId('finish-ok')).toHaveTextContent('Mark done')
  })

  it('asks before completing over a failed check', async () => {
    render(<FinishPromptDialog />)
    await open({ failedCheck: true, title: 'Fix login' })
    expect(
      screen.getByRole('alertdialog', { name: 'Complete “Fix login” anyway?' }),
    ).toBeInTheDocument()
    expect(
      screen.getByText('Its check didn’t pass. Completing it anyway is recorded in the audit log.'),
    ).toBeInTheDocument()
    expect(screen.getByTestId('finish-ok')).toHaveTextContent('Complete anyway')
  })

  it('reads a cancel as a cancel even when the check failed', async () => {
    render(<FinishPromptDialog />)
    await open({ to: 'cancelled', failedCheck: true, title: 'Fix login' })
    expect(screen.getByRole('alertdialog', { name: 'Cancel “Fix login”?' })).toBeInTheDocument()
    expect(screen.queryByText(/Its check didn’t pass/)).not.toBeInTheDocument()
    expect(screen.getByTestId('finish-ok')).toHaveTextContent('Cancel task')
  })

  it('names an untitled task as this task', async () => {
    render(<FinishPromptDialog />)
    await open({ to: 'cancelled', title: '   ', sitsOn: null })
    expect(screen.getByRole('alertdialog', { name: 'Cancel “this task”?' })).toBeInTheDocument()
  })
})

describe('FinishPromptDialog keys and focus', () => {
  it('moves focus to the confirm button when it opens', async () => {
    render(<FinishPromptDialog />)
    await open()
    await waitFor(() => expect(screen.getByTestId('finish-ok')).toHaveFocus())
  })

  it('backs out on Escape', async () => {
    const user = userEvent.setup()
    render(<FinishPromptDialog />)
    const { result } = await open()
    await waitFor(() => expect(screen.getByTestId('finish-ok')).toHaveFocus())
    await user.keyboard('{Escape}')
    await waitFor(() => expect(result()).toBeNull())
  })

  it('backs out on Keep it', async () => {
    render(<FinishPromptDialog />)
    const { result } = await open()
    expect(screen.getByTestId('finish-cancel')).toHaveTextContent('Keep it')
    await userEvent.click(screen.getByTestId('finish-cancel'))
    await waitFor(() => expect(result()).toBeNull())
  })

  it('backs out on a press on the scrim', async () => {
    render(<FinishPromptDialog />)
    const { dialog, result } = await open()
    fireEvent.mouseDown(dialog.parentElement as HTMLElement)
    await waitFor(() => expect(result()).toBeNull())
  })

  it('confirms the picked day on Enter', async () => {
    const user = userEvent.setup()
    render(<FinishPromptDialog />)
    const { result } = await open()
    const today = screen.getByTestId('finish-day-today')
    act(() => today.focus())
    await user.keyboard('{ArrowDown}')
    expect(screen.getByTestId('finish-day-sits')).toHaveFocus()
    await user.keyboard('{Enter}')
    await waitFor(() => expect(result()).toEqual({ day: SITS }))
  })

  it('backs out of a prompt still open when a new one is asked', async () => {
    render(<FinishPromptDialog />)
    const first = await open({ title: 'First' })
    const second = await open({ title: 'Second', to: 'cancelled' })
    await waitFor(() => expect(first.result()).toBeNull())
    expect(second.result()).toBeUndefined()
    expect(screen.getByRole('alertdialog', { name: 'Cancel “Second”?' })).toBeInTheDocument()
  })

  it('has no axe violations with the month open', async () => {
    const { container } = render(<FinishPromptDialog />)
    await open({ runningAgent: 'Ada' })
    await userEvent.click(screen.getByTestId('finish-day-other'))
    expect(await axe(container)).toHaveNoViolations()
  })
})
