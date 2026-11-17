// The Board's goal parts follow the goal a task counts toward (`effectiveGoalId`), not
// only the goal it names itself: inherited work shows its request's goal on its card,
// marked as inherited, and filtering by that goal finds it, while "No goal" leaves
// only work that counts toward no goal at all.

import { cleanup, render as rtlRender, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { http, HttpResponse } from 'msw'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { makeGoalSummary } from '@/__vitest__/homeFixtures'
import { ThemeProvider } from '@/features/theme/ThemeProvider'
import { resetGoalsStore } from '@/stores/goals'
import { useTeamStore } from '@/stores/team'
import { useToastStore } from '@/stores/toast'

import { server } from '../../../__vitest__/mswServer'
import { BoardPanel } from '../BoardPanel'
import { resetBoardStorage } from './resetBoardStorage'

vi.mock('@/lib/useVisiblePolling', async (importOriginal) =>
  (await import('./boardControls')).pollingByHand(await importOriginal()),
)

const T = { timeout: 4000 }
const render = (ui: React.ReactElement) => rtlRender(<ThemeProvider>{ui}</ThemeProvider>)

const row = (over: Record<string, unknown>) => ({
  status: 'todo',
  createdAt: Date.now(),
  updatedAt: Date.now(),
  isMainTask: 0,
  teamId: 'team-1',
  ...over,
})

const TASKS = [
  row({
    id: 'own',
    title: 'Write the copy',
    goalId: 'g1',
    effectiveGoalId: 'g1',
    goalLinkedVia: 'own',
  }),
  row({
    id: 'inherited',
    title: 'Check the links',
    goalId: null,
    effectiveGoalId: 'g1',
    goalLinkedVia: 'parent',
  }),
  row({
    id: 'none',
    title: 'Tidy the folder',
    goalId: null,
    effectiveGoalId: null,
    goalLinkedVia: null,
  }),
]

beforeEach(() => {
  useTeamStore.setState({ teams: [], selectedTeamId: null })
  resetBoardStorage()
  resetGoalsStore()
  useToastStore.setState({ toasts: [] })
  server.use(
    http.get('/api/board', () => HttpResponse.json({ tasks: TASKS })),
    http.get('/api/home/teams/:teamId/goals', () =>
      HttpResponse.json({
        goals: [makeGoalSummary({ id: 'g1', teamId: 'team-1', title: 'Launch the beta' })],
      }),
    ),
  )
})
afterEach(() => cleanup())

const cardTitles = () =>
  screen
    .getAllByTestId('board-card')
    .map((c) =>
      ['Write the copy', 'Check the links', 'Tidy the folder'].find((t) =>
        c.textContent?.includes(t),
      ),
    )

describe("the Board's goal parts", () => {
  it('shows an inherited goal on the card, marked as inherited', async () => {
    render(<BoardPanel />)
    const card = (await screen.findAllByTestId('board-card', {}, T)).find((c) =>
      c.textContent?.includes('Check the links'),
    )!
    const chip = await within(card).findByTestId('task-goal-chip', {}, T)
    expect(chip).toHaveTextContent('Launch the beta')
    expect(chip).toHaveAttribute('data-linked-via', 'parent')
    expect(chip).toHaveAttribute('title', 'Goal: Launch the beta, through its parent task')
  })

  it('finds inherited work under its goal, and No goal means no goal at all', async () => {
    const user = userEvent.setup()
    render(<BoardPanel />)
    await screen.findAllByTestId('task-goal-chip', {}, T)

    await user.click(screen.getByTestId('board-filter'))
    await user.click(await screen.findByRole('menuitemcheckbox', { name: /Launch the beta/ }))
    await waitFor(
      () => expect(cardTitles().sort()).toEqual(['Check the links', 'Write the copy']),
      T,
    )

    // Swap the goal for No goal.
    await user.click(screen.getByRole('menuitemcheckbox', { name: /Launch the beta/ }))
    await user.click(screen.getByRole('menuitemcheckbox', { name: /No goal/ }))
    await waitFor(() => expect(cardTitles()).toEqual(['Tidy the folder']), T)
  })
})
