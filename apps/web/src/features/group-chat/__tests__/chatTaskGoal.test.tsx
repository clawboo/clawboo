// A task linked to a goal shows the goal's chip in team chat too: on its row in the
// chat's Tasks card and on its inline card in the conversation. The goal picked for
// new requests is cleared once the team's goals are read without it.

import { cleanup, render, screen, waitFor, within } from '@testing-library/react'
import { http, HttpResponse } from 'msw'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { makeGoalSummary } from '@/__vitest__/homeFixtures'
import { server } from '@/__vitest__/mswServer'
import { ThemeProvider } from '@/features/theme/ThemeProvider'
import { useBoardStore, type BoardTaskView } from '@/stores/board'
import { resetGoalsStore } from '@/stores/goals'

import { BoardTaskCard } from '../BoardTaskCard'
import { RequestGoalPicker } from '../RequestGoalPicker'
import { TeamTasksCard } from '../TeamTasksCard'

const T = { timeout: 4000 }

function task(over: Partial<BoardTaskView> = {}): BoardTaskView {
  return {
    id: 'task-1',
    title: 'Write the landing page',
    status: 'todo',
    assigneeAgentId: null,
    parentTaskId: null,
    summary: null,
    attention: null,
    createdAt: 1_700_000_000_000,
    updatedAt: 1_700_000_000_000,
    ...over,
  }
}

beforeEach(() => {
  resetGoalsStore()
  server.use(
    http.get('/api/home/teams/:teamId/goals', () =>
      HttpResponse.json({
        goals: [makeGoalSummary({ id: 'g1', teamId: 'T', title: 'Launch the beta' })],
      }),
    ),
  )
})

afterEach(() => {
  cleanup()
  useBoardStore.setState({ tasksByTeam: new Map(), loadedTeams: new Set() })
})

describe("a task's goal in team chat", () => {
  it("shows on the task's row in the Tasks card", async () => {
    useBoardStore.setState({
      tasksByTeam: new Map([['T', new Map([['task-1', task({ goalId: 'g1' })]])]]),
      loadedTeams: new Set(['T']),
    })
    render(
      <ThemeProvider>
        <TeamTasksCard
          teamId="T"
          roomId={null}
          maximized={false}
          onToggleMaximize={() => undefined}
          onClose={() => undefined}
        />
      </ThemeProvider>,
    )
    const row = await screen.findByTestId('team-task-row', {}, T)
    expect(await within(row).findByTestId('task-goal-chip', {}, T)).toHaveTextContent(
      'Launch the beta',
    )
  })

  it("shows on the task's inline card", async () => {
    render(
      <ThemeProvider>
        <BoardTaskCard task={task({ goalId: 'g1' })} teamId="T" />
      </ThemeProvider>,
    )
    expect(await screen.findByTestId('task-goal-chip', {}, T)).toHaveTextContent('Launch the beta')
  })

  it('shows the goal a task inherits from its request, marked as inherited', async () => {
    render(
      <ThemeProvider>
        <BoardTaskCard
          task={task({ goalId: null, effectiveGoalId: 'g1', goalLinkedVia: 'request' })}
          teamId="T"
        />
      </ThemeProvider>,
    )
    const chip = await screen.findByTestId('task-goal-chip', {}, T)
    expect(chip).toHaveTextContent('Launch the beta')
    expect(chip).toHaveAttribute('data-linked-via', 'request')
  })

  it('shows nothing for a task with no goal', async () => {
    render(
      <ThemeProvider>
        <BoardTaskCard task={task()} teamId="T" />
      </ThemeProvider>,
    )
    await screen.findByText('Write the landing page', {}, T)
    expect(screen.queryByTestId('task-goal-chip')).toBeNull()
  })
})

describe('the goal for new requests', () => {
  it('clears a picked goal the read list no longer has, but not while it loads', async () => {
    let release!: () => void
    const gate = new Promise<void>((r) => (release = r))
    server.use(
      http.get('/api/home/teams/:teamId/goals', async () => {
        await gate
        return HttpResponse.json({
          goals: [makeGoalSummary({ id: 'g1', teamId: 'T', title: 'Launch the beta' })],
        })
      }),
    )
    const onChange = vi.fn()
    render(<RequestGoalPicker teamId="T" goalId="g-done" onChange={onChange} />)
    await new Promise((r) => setTimeout(r, 30))
    expect(onChange).not.toHaveBeenCalled()
    release()
    await waitFor(() => expect(onChange).toHaveBeenCalledWith(null), T)
    expect(onChange).toHaveBeenCalledTimes(1)
  })

  it('keeps a picked goal the team still has', async () => {
    const onChange = vi.fn()
    render(<RequestGoalPicker teamId="T" goalId="g1" onChange={onChange} />)
    expect(await screen.findByTestId('request-goal-picker', {}, T)).toHaveTextContent(
      'Launch the beta',
    )
    expect(onChange).not.toHaveBeenCalled()
  })

  it('keeps a picked goal when the goals read fails, and a later mount reads again', async () => {
    let reads = 0
    server.use(
      http.get('/api/home/teams/:teamId/goals', () => {
        reads += 1
        return HttpResponse.json({ error: 'boom' }, { status: 503 })
      }),
    )
    const onChange = vi.fn()
    const { unmount } = render(<RequestGoalPicker teamId="T" goalId="g1" onChange={onChange} />)
    await waitFor(() => expect(reads).toBe(1), T)
    await new Promise((r) => setTimeout(r, 30))
    expect(onChange).not.toHaveBeenCalled()
    unmount()
    render(<RequestGoalPicker teamId="T" goalId="g1" onChange={onChange} />)
    await waitFor(() => expect(reads).toBe(2), T)
    await new Promise((r) => setTimeout(r, 30))
    expect(onChange).not.toHaveBeenCalled()
  })
})
