// Drives the board's controls the way a person does: the view button opens a
// menu of views, Display holds the routine runs and Cancelled switches, and the
// board refreshes on its 5s poll (it has no Refresh button). A test that needs a
// read mocks the polling hook with `pollingByHand` and calls `pollBoard()` where
// the timer would fire:
//
//   vi.mock('@/lib/useVisiblePolling', async (importOriginal) =>
//     (await import('./boardControls')).pollingByHand(await importOriginal()),
//   )

import { act, screen } from '@testing-library/react'
import type { UserEvent } from '@testing-library/user-event'

import type * as Polling from '@/lib/useVisiblePolling'

/** The board's read interval. Every other poller (the calendar clock, the
 *  routine runs, the approvals) keeps its real timer. */
const BOARD_POLL_MS = 5000
let boardTick: (() => void) | null = null

/** The polling module with the board's 5s poll handing its tick to the test
 *  instead of starting a timer. A call site always polls at the same interval,
 *  so each one takes the same branch on every render. */
export function pollingByHand(actual: typeof Polling): typeof Polling {
  return {
    ...actual,
    useVisiblePolling: (tick, intervalMs, options = {}) => {
      if (intervalMs !== BOARD_POLL_MS) return actual.useVisiblePolling(tick, intervalMs, options)
      if (options.enabled !== false) boardTick = tick
    },
  }
}

/** Runs the board's 5s poll now, the way its timer would. */
export async function pollBoard(): Promise<void> {
  const tick = boardTick
  if (!tick) throw new Error('No board is polling: render the board first')
  await act(async () => {
    tick()
  })
}

/** Opens the view menu and picks a view by its name. */
export async function pickView(user: UserEvent, name: string): Promise<void> {
  await user.click(screen.getByTestId('board-view'))
  await user.click(await screen.findByRole('menuitemradio', { name }))
}

/** Opens Display and returns its popover. */
export async function openDisplay(user: UserEvent): Promise<HTMLElement> {
  await user.click(screen.getByTestId('board-display'))
  return screen.findByTestId('board-display-popover')
}

/** Flips the routine runs switch in Display, and closes Display again. */
export async function toggleRoutines(user: UserEvent): Promise<void> {
  await openDisplay(user)
  await user.click(screen.getByTestId('board-routines-toggle'))
  await user.keyboard('{Escape}')
}
