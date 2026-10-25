// The Tasks card shows the tasks of the chat it sits beside: the team's own
// group chat lists the tasks with no room (every task from before rooms), and a
// room lists only its own.

import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { ThemeProvider } from '@/features/theme/ThemeProvider'
import { useBoardStore, type BoardTaskView } from '@/stores/board'

import { TeamTasksCard } from '../TeamTasksCard'

function task(id: string, title: string, roomId?: string | null): BoardTaskView {
  return {
    id,
    title,
    status: 'todo',
    assigneeAgentId: null,
    parentTaskId: null,
    summary: null,
    attention: null,
    ...(roomId === undefined ? {} : { roomId }),
    createdAt: 1_700_000_000_000,
    updatedAt: 1_700_000_000_000,
  }
}

function seed(): void {
  const tasks = new Map<string, BoardTaskView>()
  for (const t of [
    task('t-old', 'Old team task'),
    task('t-team', 'Team task', null),
    task('t-design', 'Design task', 'room-design'),
    task('t-launch', 'Launch task', 'room-launch'),
  ])
    tasks.set(t.id, t)
  useBoardStore.setState({
    tasksByTeam: new Map([['T', tasks]]),
    loadedTeams: new Set(['T']),
  })
}

function renderCard(roomId: string | null) {
  return render(
    <ThemeProvider>
      <TeamTasksCard
        teamId="T"
        roomId={roomId}
        maximized={false}
        onToggleMaximize={() => undefined}
        onClose={() => undefined}
      />
    </ThemeProvider>,
  )
}

beforeEach(() => seed())
afterEach(() => {
  cleanup()
  useBoardStore.setState({ tasksByTeam: new Map(), loadedTeams: new Set() })
})

describe('TeamTasksCard and chat rooms', () => {
  it("the team's group chat lists the tasks with no room", () => {
    renderCard(null)
    const titles = screen.getAllByTestId('team-task-row').map((r) => r.textContent ?? '')
    expect(titles.some((t) => t.includes('Old team task'))).toBe(true)
    expect(titles.some((t) => t.includes('Team task'))).toBe(true)
    expect(titles.some((t) => t.includes('Design task'))).toBe(false)
    expect(titles.some((t) => t.includes('Launch task'))).toBe(false)
  })

  it('a room lists only its own tasks', () => {
    renderCard('room-design')
    const titles = screen.getAllByTestId('team-task-row').map((r) => r.textContent ?? '')
    expect(titles).toHaveLength(1)
    expect(titles[0]).toContain('Design task')
  })

  it('a room with no tasks says so', () => {
    renderCard('room-empty')
    expect(screen.queryAllByTestId('team-task-row')).toHaveLength(0)
    expect(screen.getByText('No tasks yet')).toBeTruthy()
  })
})
