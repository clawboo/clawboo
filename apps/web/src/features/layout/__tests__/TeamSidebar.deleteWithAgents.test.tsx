// Delete with agents, from a team's right-click menu in the team rail.
//
// Deleting an agent is a REST route on this server (DELETE /api/agents/:id), so
// it works with no OpenClaw Gateway: in native mode the team AND its agents go.
// The confirm says what happens to the agents, and only a team with an OpenClaw
// agent is told about removing it from the Gateway. Every team is told its folder
// on disk goes too, from either delete, and a folder the server could not remove
// is reported instead of a plain success.

import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { http, HttpResponse } from 'msw'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { server } from '@/__vitest__/mswServer'
import { useConfirmStore } from '@/stores/confirm'
import { useConnectionStore } from '@/stores/connection'
import type { AgentState } from '@/stores/fleet'
import { useFleetStore } from '@/stores/fleet'
import { useToastStore } from '@/stores/toast'
import type { Team } from '@/stores/team'
import { useTeamStore } from '@/stores/team'

import { TeamSidebar } from '../TeamSidebar'

function agent(id: string, teamId: string, runtime: string): AgentState {
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
    runtime,
    execConfig: null,
  }
}

function team(id: string, name: string): Team {
  return {
    id,
    name,
    icon: '📈',
    color: '#10b981',
    colorCollectionId: null,
    templateId: null,
    agentCount: 2,
    leaderAgentId: null,
    isArchived: false,
    serverOrchestrated: true,
  }
}

let deletedAgents: string[] = []
let deletedTeams: string[] = []
let folderRemoved = true

beforeEach(() => {
  deletedAgents = []
  deletedTeams = []
  folderRemoved = true
  useToastStore.setState({ toasts: [] })
  // Native mode: connected, with no Gateway client.
  useConnectionStore.setState({ status: 'connected', client: null, gatewayUrl: '' })
  useConfirmStore.setState({ open: false, options: null, resolver: null })
  useTeamStore.setState({
    teams: [team('t1', 'Growth Studio'), team('t2', 'Ops Crew')],
    selectedTeamId: 't1',
  })
  server.use(
    http.delete('/api/agents/:agentId', ({ params }) => {
      deletedAgents.push(String(params['agentId']))
      return HttpResponse.json({ ok: true, upstreamDeleted: true })
    }),
    http.delete('/api/teams/:teamId', ({ params }) => {
      deletedTeams.push(String(params['teamId']))
      return HttpResponse.json({ ok: true, folderRemoved })
    }),
  )
})

afterEach(() => {
  cleanup()
  useConnectionStore.setState({ status: 'disconnected', client: null, gatewayUrl: null })
})

/** Right-click the team's rail icon, pick Delete with agents, and wait for the confirm. */
async function askToDeleteWithAgents(teamName: string): Promise<void> {
  render(<TeamSidebar />)
  fireEvent.contextMenu(screen.getByRole('button', { name: teamName }))
  fireEvent.click(screen.getByRole('menuitem', { name: 'Delete with agents' }))
  await waitFor(() => expect(useConfirmStore.getState().open).toBe(true))
}

describe('Delete with agents', () => {
  it("deletes the team's agents and then the team, with no Gateway", async () => {
    useFleetStore.setState({
      agents: [
        agent('a1', 't1', 'clawboo-native'),
        agent('a2', 't1', 'codex'),
        agent('a3', 't2', 'clawboo-native'),
      ],
    })
    await askToDeleteWithAgents('Growth Studio')

    const { options } = useConfirmStore.getState()
    expect(options?.title).toBe('Delete "Growth Studio" and 2 agents?')
    // Neither agent lives in a Gateway, so none is promised a removal from one.
    // Both agents worked in the team's folder, which the delete removes.
    expect(options?.message).toBe(
      "This deletes the agents and their chats. The team's folder and the files its agents saved there are deleted too. It cannot be undone.",
    )

    act(() => useConfirmStore.getState().settle(true))
    await waitFor(() => expect(deletedTeams).toEqual(['t1']))
    expect(deletedAgents).toEqual(['a1', 'a2'])
    expect(useFleetStore.getState().agents.map((a) => a.id)).toEqual(['a3'])
    expect(useTeamStore.getState().teams.map((t) => t.id)).toEqual(['t2'])
  })

  it('tells a team with an OpenClaw agent that it leaves the Gateway too', async () => {
    useFleetStore.setState({
      agents: [agent('a1', 't1', 'openclaw'), agent('a2', 't1', 'clawboo-native')],
    })
    await askToDeleteWithAgents('Growth Studio')

    expect(useConfirmStore.getState().options?.message).toBe(
      "This deletes the agents and their chats, and removes the OpenClaw agents from the Gateway. The team's folder and the files its agents saved there are deleted too. It cannot be undone.",
    )

    // Cancelling deletes nothing.
    act(() => useConfirmStore.getState().settle(false))
    await act(async () => {})
    expect(deletedAgents).toEqual([])
    expect(deletedTeams).toEqual([])
  })

  it('says so when the team folder could not be removed', async () => {
    folderRemoved = false
    useFleetStore.setState({ agents: [agent('a1', 't1', 'clawboo-native')] })
    await askToDeleteWithAgents('Growth Studio')

    act(() => useConfirmStore.getState().settle(true))
    await waitFor(() => expect(deletedTeams).toEqual(['t1']))
    await waitFor(() =>
      expect(useToastStore.getState().toasts.map((t) => [t.type, t.message])).toEqual([
        ['error', '"Growth Studio" deleted, but its team folder could not be removed'],
      ]),
    )
  })
})

describe('Delete team only', () => {
  async function askToDeleteTeam(teamName: string): Promise<void> {
    render(<TeamSidebar />)
    fireEvent.contextMenu(screen.getByRole('button', { name: teamName }))
    fireEvent.click(screen.getByRole('menuitem', { name: 'Delete team only' }))
    await waitFor(() => expect(useConfirmStore.getState().open).toBe(true))
  }

  it("says the team's folder goes when a member works in it", async () => {
    useFleetStore.setState({
      agents: [agent('a1', 't1', 'claude-code'), agent('a2', 't1', 'clawboo-native')],
    })
    await askToDeleteTeam('Growth Studio')

    expect(useConfirmStore.getState().options?.message).toBe(
      "Agents will be kept but unassigned from this team. The team's folder and the files its agents saved there are deleted too.",
    )
    act(() => useConfirmStore.getState().settle(false))
  })

  it('mentions the folder for a team of OpenClaw agents only too', async () => {
    // An agent that left the team, or was deleted, may have saved files there.
    useFleetStore.setState({
      agents: [agent('a1', 't1', 'openclaw'), agent('a2', 't1', 'openclaw')],
    })
    await askToDeleteTeam('Growth Studio')

    expect(useConfirmStore.getState().options?.message).toBe(
      "Agents will be kept but unassigned from this team. The team's folder and the files its agents saved there are deleted too.",
    )
    act(() => useConfirmStore.getState().settle(false))
  })

  it('says so when the team folder could not be removed', async () => {
    folderRemoved = false
    useFleetStore.setState({ agents: [agent('a1', 't1', 'codex')] })
    await askToDeleteTeam('Growth Studio')

    act(() => useConfirmStore.getState().settle(true))
    await waitFor(() => expect(deletedTeams).toEqual(['t1']))
    await waitFor(() =>
      expect(useToastStore.getState().toasts.map((t) => [t.type, t.message])).toEqual([
        ['error', '"Growth Studio" deleted, but its team folder could not be removed'],
      ]),
    )
    expect(useTeamStore.getState().teams.map((t) => t.id)).toEqual(['t2'])
  })
})
