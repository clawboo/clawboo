// One agent's tasks, as the Details card's "Tasks & Routines" tab shows them:
// only the tasks assigned to that agent, in the room Tasks card's sections, and
// a task opens in place with a way back.

import { useState } from 'react'
import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { http, HttpResponse } from 'msw'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { server } from '@/__vitest__/mswServer'
import { ThemeProvider } from '@/features/theme/ThemeProvider'
import { useBoardStore, type BoardTaskView } from '@/stores/board'
import { useFleetStore, type AgentState } from '@/stores/fleet'

import { AgentTasks } from '../TeamTasksCard'

function task(id: string, title: string, assigneeAgentId: string | null): BoardTaskView {
  return {
    id,
    title,
    status: 'todo',
    assigneeAgentId,
    parentTaskId: null,
    summary: null,
    attention: null,
    createdAt: 1_700_000_000_000,
    updatedAt: 1_700_000_000_000,
  }
}

function agent(id: string, teamId: string | null): AgentState {
  return {
    id,
    name: id,
    status: 'idle',
    sessionKey: null,
    model: null,
    createdAt: null,
    streamingText: null,
    runId: null,
    lastSeenAt: null,
    teamId,
    execConfig: null,
  }
}

beforeEach(() => {
  server.use(
    http.get('/api/obs/events', () => HttpResponse.json({ events: [] })),
    http.get('/api/board/:taskId', ({ params }) =>
      HttpResponse.json({ task: { id: params['taskId'] }, comments: [], ancestors: [] }),
    ),
  )
  useFleetStore.setState({ agents: [agent('ada', 'T'), agent('bea', 'T')] })
  const tasks = new Map<string, BoardTaskView>()
  for (const t of [task('t1', 'Write the brief', 'ada'), task('t2', 'Review copy', 'bea')])
    tasks.set(t.id, t)
  useBoardStore.setState({ tasksByTeam: new Map([['T', tasks]]), loadedTeams: new Set(['T']) })
})
afterEach(() => {
  cleanup()
  useBoardStore.setState({ tasksByTeam: new Map(), loadedTeams: new Set() })
})

function Harness() {
  const [open, setOpen] = useState<string | null>(null)
  return (
    <ThemeProvider>
      <AgentTasks agentId="ada" title="Tasks & Routines" openTaskId={open} onOpenTask={setOpen} />
    </ThemeProvider>
  )
}

describe('AgentTasks', () => {
  it("lists only the agent's own tasks and opens one in place", async () => {
    render(<Harness />)
    const rows = screen.getAllByTestId('team-task-row').map((r) => r.textContent ?? '')
    expect(rows).toHaveLength(1)
    expect(rows[0]).toContain('Write the brief')

    await userEvent.click(screen.getByTestId('team-task-row'))
    expect(screen.getByTestId('agent-tasks-back')).toHaveTextContent('Tasks & Routines')
    await userEvent.click(screen.getByTestId('agent-tasks-back'))
    expect(screen.getAllByTestId('team-task-row')).toHaveLength(1)
  })
})
