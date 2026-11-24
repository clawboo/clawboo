// The goal dialog never moves a goal by accident: a parent the person did not
// change is kept, even when that parent is done, dropped or not loaded yet (the
// dialog's goal list holds active goals only, and is empty until the team's Home
// has loaded). A changed parent is sent. The owner is kept the same way, even when
// it is another person, and a save in flight cannot be closed out from under.

import { cleanup, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { http, HttpResponse } from 'msw'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { makeGoal, makeGoalSummary } from '@/__vitest__/homeFixtures'
import { server } from '@/__vitest__/mswServer'
import { resetBoardPerson } from '@/features/board/useBoardPerson'
import { useFleetStore } from '@/stores/fleet'

import { GoalDialog } from '../GoalDialog'

const T = { timeout: 4000 }

let patched: Record<string, unknown> | null = null
let posted: Record<string, unknown> | null = null

beforeEach(() => {
  patched = null
  posted = null
  resetBoardPerson()
  useFleetStore.setState({ agents: [] })
  server.use(
    http.patch('/api/home/teams/:teamId/goals/:goalId', async ({ request }) => {
      patched = (await request.json()) as Record<string, unknown>
      return HttpResponse.json({ goal: makeGoal({ id: 'g-child' }) })
    }),
    http.post('/api/home/teams/:teamId/goals', async ({ request }) => {
      posted = (await request.json()) as Record<string, unknown>
      return HttpResponse.json({ goal: makeGoal({ id: 'g-new' }) })
    }),
  )
})

afterEach(cleanup)

const child = makeGoal({ id: 'g-child', title: 'Write the posts', parentGoalId: 'g-done' })
const doneParent = { id: 'g-done', title: 'Launch the beta' }

describe('editing a goal', () => {
  it('keeps a done parent when only the title changes', async () => {
    const user = userEvent.setup()
    render(
      <GoalDialog
        open
        onClose={() => {}}
        teamId="t1"
        // The parent is done, so it is not among the active goals.
        goals={[makeGoalSummary({ id: 'g-other', title: 'Grow the list' })]}
        editing={child}
        context={{ parent: doneParent, childCount: 0 }}
        onSaved={() => {}}
      />,
    )
    const dialog = await screen.findByTestId('goal-dialog', {}, T)
    expect(within(dialog).getByRole('button', { name: 'Under goal' })).toHaveTextContent(
      'Launch the beta',
    )
    const title = within(dialog).getByTestId('goal-title')
    await user.clear(title)
    await user.type(title, 'Write the launch posts')
    await user.click(within(dialog).getByTestId('goal-save'))
    await waitFor(() => expect(patched).not.toBeNull(), T)
    expect(patched).toMatchObject({ title: 'Write the launch posts' })
    expect(patched).not.toHaveProperty('parentGoalId')
  })

  it("keeps the parent before the team's goals have loaded", async () => {
    const user = userEvent.setup()
    render(
      <GoalDialog
        open
        onClose={() => {}}
        teamId="t1"
        goals={[]}
        editing={child}
        onSaved={() => {}}
      />,
    )
    const dialog = await screen.findByTestId('goal-dialog', {}, T)
    expect(within(dialog).getByRole('button', { name: 'Under goal' })).toHaveTextContent(
      'A goal that is not active',
    )
    await user.click(within(dialog).getByTestId('goal-save'))
    await waitFor(() => expect(patched).not.toBeNull(), T)
    expect(patched).not.toHaveProperty('parentGoalId')
  })

  it('sends a parent the person changed', async () => {
    const user = userEvent.setup()
    render(
      <GoalDialog
        open
        onClose={() => {}}
        teamId="t1"
        goals={[]}
        editing={child}
        context={{ parent: doneParent, childCount: 0 }}
        onSaved={() => {}}
      />,
    )
    const dialog = await screen.findByTestId('goal-dialog', {}, T)
    await user.click(within(dialog).getByRole('button', { name: 'Under goal' }))
    await user.click(await screen.findByRole('option', { name: 'None (a top goal)' }))
    await user.click(within(dialog).getByTestId('goal-save'))
    await waitFor(() => expect(patched).toMatchObject({ parentGoalId: null }), T)
  })
})

describe('a new goal under another', () => {
  it('goes under a done parent it was opened from', async () => {
    const user = userEvent.setup()
    render(
      <GoalDialog
        open
        onClose={() => {}}
        teamId="t1"
        goals={[]}
        editing={null}
        defaultParentId="g-done"
        context={{ parent: doneParent, childCount: 0 }}
        onSaved={() => {}}
      />,
    )
    const dialog = await screen.findByTestId('goal-dialog', {}, T)
    expect(within(dialog).getByRole('button', { name: 'Under goal' })).toHaveTextContent(
      'Launch the beta',
    )
    await user.type(within(dialog).getByTestId('goal-title'), 'Record the demo')
    await user.click(within(dialog).getByTestId('goal-save'))
    await waitFor(
      () => expect(posted).toMatchObject({ title: 'Record the demo', parentGoalId: 'g-done' }),
      T,
    )
  })
})

describe("a goal's owner", () => {
  const alices = makeGoal({
    id: 'g-child',
    title: 'Write the posts',
    owner: { kind: 'person', id: 'alice', name: 'Alice' },
  })

  it('keeps another person as owner when only the title changes', async () => {
    const user = userEvent.setup()
    render(
      <GoalDialog
        open
        onClose={() => {}}
        teamId="t1"
        goals={[]}
        editing={alices}
        onSaved={() => {}}
      />,
    )
    const dialog = await screen.findByTestId('goal-dialog', {}, T)
    expect(within(dialog).getByRole('button', { name: 'Owner' })).toHaveTextContent('Alice')
    const title = within(dialog).getByTestId('goal-title')
    await user.clear(title)
    await user.type(title, 'Write the launch posts')
    await user.click(within(dialog).getByTestId('goal-save'))
    await waitFor(() => expect(patched).not.toBeNull(), T)
    expect(patched).toMatchObject({ title: 'Write the launch posts' })
    expect(patched).not.toHaveProperty('owner')
  })

  it('sends the owner the person picked', async () => {
    const user = userEvent.setup()
    render(
      <GoalDialog
        open
        onClose={() => {}}
        teamId="t1"
        goals={[]}
        editing={alices}
        onSaved={() => {}}
      />,
    )
    const dialog = await screen.findByTestId('goal-dialog', {}, T)
    await user.click(within(dialog).getByRole('button', { name: 'Owner' }))
    await user.click(await screen.findByRole('option', { name: 'You' }))
    await user.click(within(dialog).getByTestId('goal-save'))
    await waitFor(
      () => expect(patched).toMatchObject({ owner: { kind: 'person', id: 'local' } }),
      T,
    )
  })
})

describe('a save in flight', () => {
  it('keeps the dialog open on Escape until the save lands', async () => {
    let release!: () => void
    const gate = new Promise<void>((r) => (release = r))
    server.use(
      http.patch('/api/home/teams/:teamId/goals/:goalId', async () => {
        await gate
        return HttpResponse.json({ goal: makeGoal({ id: 'g-child' }) })
      }),
    )
    const onClose = vi.fn()
    const user = userEvent.setup()
    render(
      <GoalDialog
        open
        onClose={onClose}
        teamId="t1"
        goals={[]}
        editing={child}
        onSaved={() => {}}
      />,
    )
    const dialog = await screen.findByTestId('goal-dialog', {}, T)
    await user.click(within(dialog).getByTestId('goal-save'))
    await user.keyboard('{Escape}')
    expect(onClose).not.toHaveBeenCalled()
    release()
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1), T)
  })
})

describe('a goal with only done or dropped goals under it', () => {
  it('stays a top goal: the count from its page includes them', async () => {
    const user = userEvent.setup()
    render(
      <GoalDialog
        open
        onClose={() => {}}
        teamId="t1"
        // Its one child is done, so it is not among the active goals.
        goals={[makeGoalSummary({ id: 'g-other', title: 'Grow the list' })]}
        editing={makeGoal({ id: 'g-top', title: 'Launch the beta' })}
        context={{ parent: null, childCount: 1 }}
        onSaved={() => {}}
      />,
    )
    const dialog = await screen.findByTestId('goal-dialog', {}, T)
    const parent = within(dialog).getByRole('button', { name: 'Under goal' })
    expect(parent).toBeDisabled()
    expect(dialog).toHaveTextContent('It has goals under it, so it stays a top goal.')
    await user.click(within(dialog).getByTestId('goal-save'))
    await waitFor(() => expect(patched).not.toBeNull(), T)
    expect(patched).not.toHaveProperty('parentGoalId')
  })
})
