// A task linked to a goal shows the goal's chip in team chat too: on its row in the
// chat's Tasks card and on its inline card in the conversation.

import { cleanup, render, screen, within } from '@testing-library/react'
import { http, HttpResponse } from 'msw'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { makeGoalSummary } from '@/__vitest__/homeFixtures'
import { server } from '@/__vitest__/mswServer'
import { ThemeProvider } from '@/features/theme/ThemeProvider'
import { useBoardStore, type BoardTaskView } from '@/stores/board'
import { resetGoalsStore } from '@/stores/goals'

import { BoardTaskCard } from '../BoardTaskCard'
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
