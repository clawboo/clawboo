// Moving an agent to another team from the graph's agent menu. The server does
// the whole move in one step; the dialog picks the team, sends it, and says
// plainly why a move was refused.

import { cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { http, HttpResponse } from 'msw'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { server } from '@/__vitest__/mswServer'
import type { AgentState } from '@/stores/fleet'
import { useFleetStore } from '@/stores/fleet'
import type { Team } from '@/stores/team'
import { useTeamStore } from '@/stores/team'
import { useToastStore } from '@/stores/toast'

import { MoveAgentDialog } from '../MoveAgentDialog'

function team(id: string, name: string, isArchived = false): Team {
  return {
    id,
    name,
    icon: '🧪',
    color: '#10b981',
    colorCollectionId: null,
    templateId: null,
    agentCount: 1,
    leaderAgentId: null,
    isArchived,
    serverOrchestrated: true,
  }
}

const SCOUT = {
  id: 'scout',
  name: 'Scout',
  status: 'idle',
  sessionKey: null,
  model: null,
  createdAt: null,
  streamingText: null,
  runId: null,
  lastSeenAt: null,
  teamId: 'old',
  runtime: 'clawboo-native',
  execConfig: null,
} as AgentState

let posted: unknown[] = []
let answer: { status: number; body: Record<string, unknown> } = { status: 200, body: {} }

beforeEach(() => {
  posted = []
  answer = {
    status: 200,
    body: {
      ok: true,
      fromTeamId: 'old',
      toTeamId: 'new',
      tasksHandedBack: 2,
      routinesMoved: 1,
      routinesPaused: 1,
    },
  }
  useToastStore.setState({ toasts: [] })
  useFleetStore.setState({ agents: [SCOUT] })
  useTeamStore.setState({
    teams: [team('old', 'Research'), team('new', 'Launch'), team('shelf', 'Shelved', true)],
    selectedTeamId: null,
  })
  server.use(
    http.post('/api/agents/:agentId/move', async ({ request }) => {
      posted.push(await request.json())
      return HttpResponse.json(answer.body, { status: answer.status })
    }),
    http.get('/api/teams', () => HttpResponse.json({ teams: [], assignments: [] })),
  )
})
afterEach(() => cleanup())

describe('MoveAgentDialog', () => {
  it('lists only the other active teams', () => {
    render(<MoveAgentDialog agentId="scout" agentName="Scout" onClose={vi.fn()} />)
    expect(screen.getByRole('radio', { name: /Launch/ })).toBeInTheDocument()
    expect(screen.queryByRole('radio', { name: /Research/ })).toBeNull()
    expect(screen.queryByRole('radio', { name: /Shelved/ })).toBeNull()
  })

  it('moves the agent and says what stayed behind', async () => {
    const onClose = vi.fn()
    render(<MoveAgentDialog agentId="scout" agentName="Scout" onClose={onClose} />)
    await userEvent.click(screen.getByRole('radio', { name: /Launch/ }))
    await userEvent.click(screen.getByRole('button', { name: 'Move' }))

    await waitFor(() => expect(onClose).toHaveBeenCalled())
    expect(posted).toEqual([{ teamId: 'new' }])
    expect(useFleetStore.getState().agents[0]?.teamId).toBe('new')
    expect(useToastStore.getState().toasts.at(-1)?.message).toBe(
      "Moved Scout to Launch. 2 unstarted tasks stay on Research's board, unassigned. 1 routine tied to Research's tasks is paused there.",
    )
  })

  it('explains a refusal and changes nothing', async () => {
    answer = { status: 409, body: { error: 'agent_leads_team' } }
    const onClose = vi.fn()
    render(<MoveAgentDialog agentId="scout" agentName="Scout" onClose={onClose} />)
    await userEvent.click(screen.getByRole('radio', { name: /Launch/ }))
    await userEvent.click(screen.getByRole('button', { name: 'Move' }))

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'It leads its team. Choose another lead for that team first.',
    )
    expect(onClose).not.toHaveBeenCalled()
    expect(useFleetStore.getState().agents[0]?.teamId).toBe('old')
  })
})
