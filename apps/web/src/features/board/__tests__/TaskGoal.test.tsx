// A task's goal on the Board: the chip on a card names the goal, the drawer's
// picker saves a change (and puts the old goal back when the save fails), and the
// Filter menu lists the goals on the tasks in view.

import { act, cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { http, HttpResponse } from 'msw'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { makeGoalSummary } from '@/__vitest__/homeFixtures'
import { server } from '@/__vitest__/mswServer'
import { effectiveGoalIdOf, goalIdOf, goalLinkOf, resetGoalsStore } from '@/stores/goals'
import { useToastStore } from '@/stores/toast'
import { useViewStore } from '@/stores/view'

import { FilterMenuButton, NO_FILTER, NO_GOAL_KEY, filterCount } from '../BoardToolbar'
import { GoalChip, TaskGoalSelect } from '../TaskGoal'

const T = { timeout: 4000 }

beforeEach(() => {
  resetGoalsStore()
  useToastStore.setState({ toasts: [] })
  server.use(
    http.get('/api/home/teams/:teamId/goals', () =>
      HttpResponse.json({
        goals: [
          makeGoalSummary({ id: 'g1', teamId: 't1', title: 'Launch the beta' }),
          makeGoalSummary({ id: 'g2', teamId: 't1', title: 'Grow the list' }),
          makeGoalSummary({ id: 'g3', teamId: 't1', title: 'Old one', status: 'done' }),
        ],
      }),
    ),
  )
})

afterEach(cleanup)

describe('the goal chip', () => {
  it("names the task's goal once the team's goals are read", async () => {
    render(<GoalChip goalId="g1" teamId="t1" />)
    expect(await screen.findByTestId('task-goal-chip', {}, T)).toHaveTextContent('Launch the beta')
  })

  it('shows nothing for a goal no longer active', async () => {
    render(<GoalChip goalId="g3" teamId="t1" />)
    await waitFor(() => expect(screen.queryByTestId('task-goal-chip')).toBeNull(), T)
  })

  it('marks a goal the task inherits, and says how', async () => {
    render(<GoalChip goalId="g1" teamId="t1" linkedVia="request" />)
    const chip = await screen.findByTestId('task-goal-chip', {}, T)
    expect(chip).toHaveAttribute('title', 'Goal: Launch the beta, through its request')
    expect(chip.className).toContain('border-dashed')
    expect(chip).toHaveTextContent('(goal, through its request)')
  })

  it('reads a goal id off a board row', () => {
    expect(goalIdOf({ id: 'x', goalId: 'g1' })).toBe('g1')
    expect(goalIdOf({ id: 'x', goalId: null })).toBeNull()
    expect(goalIdOf({ id: 'x' })).toBeNull()
    // The goal it counts toward, falling back to its own on an older server's row.
    expect(effectiveGoalIdOf({ id: 'x', goalId: null, effectiveGoalId: 'g1' })).toBe('g1')
    expect(effectiveGoalIdOf({ id: 'x', goalId: 'g2' })).toBe('g2')
    expect(effectiveGoalIdOf({ id: 'x', goalId: 'g2', effectiveGoalId: null })).toBeNull()
    expect(goalLinkOf({ goalLinkedVia: 'parent' })).toBe('parent')
    expect(goalLinkOf({ goalLinkedVia: 'direct' })).toBeNull()
  })
})

describe("the drawer's goal picker", () => {
  it('saves a goal picked from the active ones, and opens it on Home', async () => {
    let body: unknown = null
    server.use(
      http.patch('/api/board/:taskId', async ({ request }) => {
        body = await request.json()
        return HttpResponse.json({ ok: true })
      }),
    )
    const onChange = vi.fn()
    const onSaved = vi.fn()
    const user = userEvent.setup()
    const { rerender } = render(
      <TaskGoalSelect
        taskId="task-1"
        teamId="t1"
        goalId={null}
        onChange={onChange}
        onSaved={onSaved}
      />,
    )
    await user.click(await screen.findByTestId('task-goal-select', {}, T))
    const options = (await screen.findAllByRole('option')).map((o) => o.textContent)
    expect(options).toEqual(['No goal', 'Launch the beta', 'Grow the list'])
    await user.click(screen.getByRole('option', { name: 'Grow the list' }))
    expect(onChange).toHaveBeenCalledWith({
      goalId: 'g2',
      effectiveGoalId: 'g2',
      goalLinkedVia: 'own',
    })
    await waitFor(() => expect(body).toEqual({ goalId: 'g2' }), T)
    await waitFor(() => expect(onSaved).toHaveBeenCalled(), T)

    rerender(<TaskGoalSelect taskId="task-1" teamId="t1" goalId="g2" onChange={onChange} />)
    await user.click(screen.getByRole('button', { name: 'Open' }))
    expect(useViewStore.getState().viewMode).toEqual({ type: 'nav', view: 'home' })
    expect(useViewStore.getState().homeFocus).toMatchObject({ teamId: 't1', goalId: 'g2' })
  })

  it("shows the request's goal first for a task that inherits it, and No goal takes it off", async () => {
    let body: unknown = null
    server.use(
      http.patch('/api/board/:taskId', async ({ request }) => {
        body = await request.json()
        return HttpResponse.json({ ok: true })
      }),
    )
    const onChange = vi.fn()
    const user = userEvent.setup()
    render(
      <TaskGoalSelect
        taskId="task-1"
        teamId="t1"
        goalId={null}
        inherited={{ goalId: 'g1', via: 'request' }}
        onChange={onChange}
      />,
    )
    const select = await screen.findByTestId('task-goal-select', {}, T)
    await waitFor(() => expect(select).toHaveTextContent('Launch the beta, through its request'), T)
    await user.click(select)
    await user.click(await screen.findByRole('option', { name: 'No goal' }))
    await waitFor(() => expect(body).toEqual({ goalId: null }), T)
    expect(onChange).toHaveBeenCalledWith({
      goalId: null,
      effectiveGoalId: null,
      goalLinkedVia: null,
    })
  })

  it('puts the old goal back when the save fails', async () => {
    server.use(
      http.patch('/api/board/:taskId', () => HttpResponse.json({ error: 'boom' }, { status: 500 })),
    )
    const onChange = vi.fn()
    const user = userEvent.setup()
    render(<TaskGoalSelect taskId="task-1" teamId="t1" goalId="g1" onChange={onChange} />)
    await user.click(await screen.findByTestId('task-goal-select', {}, T))
    await user.click(await screen.findByRole('option', { name: 'No goal' }))
    await waitFor(
      () =>
        expect(onChange).toHaveBeenLastCalledWith({
          goalId: 'g1',
          effectiveGoalId: 'g1',
          goalLinkedVia: 'own',
        }),
      T,
    )
    expect(useToastStore.getState().toasts[0]?.message).toMatch(/Couldn’t change the goal/)
  })

  it('says so when the team has no goals yet', async () => {
    server.use(http.get('/api/home/teams/:teamId/goals', () => HttpResponse.json({ goals: [] })))
    render(<TaskGoalSelect taskId="task-1" teamId="t1" goalId={null} onChange={() => {}} />)
    expect(await screen.findByTestId('task-goal-none', {}, T)).toHaveTextContent(
      'No goals on this team yet',
    )
  })
})

describe('the goal filter', () => {
  it('lists the goals in view with No goal, and counts toward the filter', async () => {
    const onChange = vi.fn()
    const user = userEvent.setup()
    render(
      <FilterMenuButton
        agents={[]}
        goals={[{ id: 'g1', title: 'Launch the beta' }]}
        filter={NO_FILTER}
        onChange={onChange}
      />,
    )
    await user.click(screen.getByTestId('board-filter'))
    const menu = await screen.findByTestId('board-filter-menu', {}, T)
    expect(menu).toHaveTextContent('Goals')
    await act(async () => {
      await user.click(screen.getByRole('menuitemcheckbox', { name: /Launch the beta/ }))
    })
    const next = onChange.mock.calls[0]![0]
    expect([...next.goals]).toEqual(['g1'])
    expect(filterCount(next)).toBe(1)
    expect(filterCount({ ...NO_FILTER, goals: new Set(['g1', NO_GOAL_KEY]) })).toBe(2)
  })
})
