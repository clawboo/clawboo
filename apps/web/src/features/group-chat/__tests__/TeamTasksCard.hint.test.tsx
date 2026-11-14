// The line under a running task's composer says how the agent will get the
// comment. It follows the run on the task when there is one (a Hermes run that
// fell back to stopping and resuming says so), and otherwise what the agent's
// runtime takes right now, from the Runtimes status.

import { act, cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { http, HttpResponse } from 'msw'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { server } from '@/__vitest__/mswServer'
import { ThemeProvider } from '@/features/theme/ThemeProvider'
import { useBoardStore, type BoardTaskView } from '@/stores/board'
import { useFleetStore, type AgentState } from '@/stores/fleet'

import { TeamTasksCard } from '../TeamTasksCard'

type Steering = 'live' | 'interrupt-resume' | 'none' | null

const LIVE = 'Hermy gets this now, before its next step.'
const PAUSES = 'Hermy pauses to read this, then carries on.'

function hermy(): AgentState {
  return {
    id: 'hermy',
    name: 'Hermy',
    status: 'running',
    sessionKey: null,
    model: null,
    createdAt: null,
    streamingText: null,
    runId: null,
    lastSeenAt: null,
    teamId: 'T',
    execConfig: null,
    runtime: 'hermes',
  }
}

let runtimesCalls = 0
let detailCalls = 0

/** The Hermes runtime's steering in /api/runtimes, and the run's on the task. */
function serve(runtime: Steering, run: Steering): void {
  server.use(
    http.get('/api/obs/events', () => HttpResponse.json({ events: [] })),
    http.get('/api/runtimes', () => {
      runtimesCalls += 1
      return HttpResponse.json({
        runtimes: [
          {
            id: 'hermes',
            connectionState: 'ready',
            capabilities: runtime ? { steering: runtime } : {},
          },
        ],
      })
    }),
    http.get('/api/board/:taskId', ({ params }) => {
      detailCalls += 1
      return HttpResponse.json({
        task: { id: params['taskId'], runSteering: run },
        comments: [],
        ancestors: [],
      })
    }),
  )
}

function seed(status: BoardTaskView['status']): void {
  const t: BoardTaskView = {
    id: 't1',
    title: 'Write the brief',
    status,
    assigneeAgentId: 'hermy',
    parentTaskId: null,
    summary: null,
    attention: null,
    createdAt: 1_700_000_000_000,
    updatedAt: 1_700_000_000_000,
  }
  useBoardStore.setState({
    tasksByTeam: new Map([['T', new Map([[t.id, t]])]]),
    loadedTeams: new Set(['T']),
  })
}

async function openTask(): Promise<void> {
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
  await userEvent.click(screen.getByTestId('team-task-row'))
}

/** Wait until both reads answered and the card had a moment to use them. */
async function settled(runtimeReads = 1): Promise<void> {
  await waitFor(() => {
    expect(detailCalls).toBeGreaterThan(0)
    expect(runtimesCalls).toBe(runtimeReads)
  })
  await act(async () => {
    await new Promise((r) => setTimeout(r, 30))
  })
}

beforeEach(() => {
  runtimesCalls = 0
  detailCalls = 0
  useFleetStore.setState({ agents: [hermy()] })
})
afterEach(() => {
  cleanup()
  useBoardStore.setState({ tasksByTeam: new Map(), loadedTeams: new Set() })
  useFleetStore.setState({ agents: [] })
})

describe('the runtime a task’s card names', () => {
  it('reads the agent on open work, not what the engine wrote on the row', async () => {
    server.use(
      http.get('/api/runtimes', () => {
        runtimesCalls += 1
        return HttpResponse.json({ runtimes: [] })
      }),
      http.get('/api/board/:taskId', ({ params }) => {
        detailCalls += 1
        return HttpResponse.json({
          task: { id: params['taskId'], status: 'todo', assigneeRuntime: 'openclaw' },
          comments: [],
          ancestors: [],
        })
      }),
    )
    seed('todo')
    await openTask()
    await waitFor(() => expect(detailCalls).toBeGreaterThan(0))
    const detail = await screen.findByTestId('team-task-detail')
    await waitFor(() => expect(detail).toHaveTextContent('Hermes'))
    expect(detail).not.toHaveTextContent('OpenClaw')
  })
})

describe('the composer hint on a running Hermes task', () => {
  it('a Hermes run that steers by stopping and resuming says it pauses to read the comment', async () => {
    serve('interrupt-resume', null)
    seed('in_progress')
    await openTask()
    await settled()
    expect(screen.getByText(PAUSES)).toBeInTheDocument()
    expect(screen.queryByText(LIVE)).not.toBeInTheDocument()
  })

  it('a Hermes through its gateway says it gets the comment now', async () => {
    serve('live', null)
    seed('in_progress')
    await openTask()
    await settled()
    expect(screen.getByText(LIVE)).toBeInTheDocument()
  })

  it("the run's own way beats the runtime's: a run that steers by stop and resume pauses", async () => {
    serve('live', 'interrupt-resume')
    seed('in_progress')
    await openTask()
    await settled()
    expect(screen.getByText(PAUSES)).toBeInTheDocument()
    expect(screen.queryByText(LIVE)).not.toBeInTheDocument()
  })

  it('and a run on ACP reads live while new runs would be quiet', async () => {
    serve('interrupt-resume', 'live')
    seed('in_progress')
    await openTask()
    await settled()
    expect(screen.getByText(LIVE)).toBeInTheDocument()
    expect(screen.queryByText(PAUSES)).not.toBeInTheDocument()
  })

  it('a task that is not running does not read the runtimes', async () => {
    serve('interrupt-resume', null)
    seed('todo')
    await openTask()
    await settled(0)
    expect(screen.getByText('Sending starts Hermy on this again.')).toBeInTheDocument()
  })
})
