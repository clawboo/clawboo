// Back and forward as the top bar uses them: a page whose team, agent or chat
// room is gone is skipped, and the team rail's selection follows the page shown,
// as a click on the team's icon would.

import { beforeEach, describe, expect, it } from 'vitest'

import { useFleetStore, type AgentState } from '@/stores/fleet'
import { useRoomStore, type Room } from '@/stores/rooms'
import { useTeamStore, type Team } from '@/stores/team'
import { useViewStore } from '@/stores/view'

import { goBack, goForward, viewStillExists } from '../viewHistory'

function team(id: string, isArchived = false): Team {
  return {
    id,
    name: id,
    icon: '📈',
    color: '#10b981',
    colorCollectionId: null,
    templateId: null,
    agentCount: 0,
    leaderAgentId: null,
    isArchived,
    serverOrchestrated: true,
  }
}

const agent = (id: string, teamId: string | null = null): AgentState =>
  ({ id, name: id, status: 'idle', teamId }) as unknown as AgentState

const room = (id: string, teamId: string): Room => ({
  id,
  teamId,
  name: id,
  memberIds: [],
  pinnedAt: null,
  createdAt: 0,
  updatedAt: 0,
})

/** The room store as it is once `teamIds`' rooms have been read. */
function roomsRead(teamIds: string[], rooms: Room[]) {
  return {
    roomsByTeam: new Map(teamIds.map((id) => [id, rooms.filter((r) => r.teamId === id)])),
    loadedTeams: new Set(teamIds),
  }
}

beforeEach(() => {
  useTeamStore.setState({
    teams: [team('t1'), team('t2'), team('old', true)],
    selectedTeamId: null,
  })
  useFleetStore.setState({ agents: [agent('a1'), agent('writer', 't1')] })
  useRoomStore.setState({ roomsByTeam: new Map(), loadedTeams: new Set() })
  useViewStore.setState({
    viewMode: { type: 'nav', view: 'graph' },
    viewHistory: { past: [], future: [] },
  })
})

describe('viewStillExists', () => {
  const teams = [team('t1'), team('old', true)]
  it('needs the agent, or a live team, behind the page', () => {
    expect(viewStillExists({ type: 'agent', agentId: 'a1' }, teams, ['a1'])).toBe(true)
    expect(viewStillExists({ type: 'agent', agentId: 'gone' }, teams, ['a1'])).toBe(false)
    expect(viewStillExists({ type: 'groupChat', teamId: 't1' }, teams, [])).toBe(true)
    expect(viewStillExists({ type: 'groupChat', teamId: 'old' }, teams, [])).toBe(false)
    expect(viewStillExists({ type: 'groupChat', teamId: 'gone' }, teams, [])).toBe(false)
    expect(viewStillExists({ type: 'nav', view: 'board' }, [], [])).toBe(true)
    expect(viewStillExists({ type: 'booZero' }, [], [])).toBe(true)
  })

  it('needs the chat room too, once its team has said which rooms it has', () => {
    const r1 = { type: 'groupChat', teamId: 't1', roomId: 'r1' } as const
    const read = roomsRead(['t1'], [room('r1', 't1')])
    expect(viewStillExists(r1, teams, [], read)).toBe(true)
    expect(viewStillExists(r1, teams, [], roomsRead(['t1'], []))).toBe(false)
    // The team's own group chat is no room, so an empty list does not touch it.
    expect(
      viewStillExists({ type: 'groupChat', teamId: 't1' }, teams, [], roomsRead(['t1'], [])),
    ).toBe(true)
    // An archived team takes its rooms with it.
    expect(
      viewStillExists(
        { type: 'groupChat', teamId: 'old', roomId: 'r9' },
        teams,
        [],
        roomsRead(['old'], [room('r9', 'old')]),
      ),
    ).toBe(false)
  })

  it("counts a room as there while its team's rooms have not been read", () => {
    const r1 = { type: 'groupChat', teamId: 't1', roomId: 'r1' } as const
    expect(viewStillExists(r1, teams, [])).toBe(true)
    expect(viewStillExists(r1, teams, [], { roomsByTeam: new Map(), loadedTeams: new Set() })).toBe(
      true,
    )
    // Another team's read rooms say nothing about this one.
    expect(viewStillExists(r1, teams, [], roomsRead(['t2'], []))).toBe(true)
  })
})

describe('goBack and goForward', () => {
  it('select the team of the page they land on, and none for Boo Zero', () => {
    const v = useViewStore.getState()
    v.openGroupChat('t1')
    v.openBooZero()
    v.openGroupChat('t2')

    goBack()
    expect(useViewStore.getState().viewMode).toEqual({ type: 'booZero' })
    expect(useTeamStore.getState().selectedTeamId).toBeNull()

    goBack()
    expect(useViewStore.getState().viewMode).toEqual({ type: 'groupChat', teamId: 't1' })
    expect(useTeamStore.getState().selectedTeamId).toBe('t1')

    goForward()
    goForward()
    expect(useViewStore.getState().viewMode).toEqual({ type: 'groupChat', teamId: 't2' })
    expect(useTeamStore.getState().selectedTeamId).toBe('t2')
  })

  it("select an agent page's team, as opening it from that team's column did", () => {
    const v = useViewStore.getState()
    useTeamStore.setState({ selectedTeamId: 't1' })
    v.openAgent('writer')
    useTeamStore.setState({ selectedTeamId: 't2' })
    v.openGroupChat('t2')

    goBack()
    expect(useViewStore.getState().viewMode).toEqual({ type: 'agent', agentId: 'writer' })
    expect(useTeamStore.getState().selectedTeamId).toBe('t1')
  })

  it('leave the selection alone for a teamless agent', () => {
    useTeamStore.setState({ selectedTeamId: 't2' })
    useViewStore.getState().openAgent('a1')
    useViewStore.getState().navigateTo('board')
    goBack()
    expect(useViewStore.getState().viewMode).toEqual({ type: 'agent', agentId: 'a1' })
    expect(useTeamStore.getState().selectedTeamId).toBe('t2')
  })

  it('leave the selection alone on a page with no team of its own', () => {
    useTeamStore.setState({ selectedTeamId: 't2' })
    useViewStore.getState().navigateTo('board')
    goBack()
    expect(useViewStore.getState().viewMode).toEqual({ type: 'nav', view: 'graph' })
    expect(useTeamStore.getState().selectedTeamId).toBe('t2')
  })

  it('step over a deleted agent and an archived team', () => {
    const v = useViewStore.getState()
    v.openAgent('a1')
    v.openAgent('deleted')
    v.openGroupChat('old')
    v.navigateTo('board')

    goBack()
    expect(useViewStore.getState().viewMode).toEqual({ type: 'agent', agentId: 'a1' })
  })

  it('step over a chat room deleted since, back to the page before it', () => {
    useRoomStore.setState(roomsRead(['t1'], [room('r1', 't1')]))
    const v = useViewStore.getState()
    v.openAgent('a1')
    v.openGroupChat('t1', 'r1')
    v.navigateTo('board')
    useRoomStore.getState().remove('t1', 'r1')

    goBack()
    expect(useViewStore.getState().viewMode).toEqual({ type: 'agent', agentId: 'a1' })
  })

  it("go to a room whose team's rooms have not been read, and let the room page decide", () => {
    const v = useViewStore.getState()
    v.openAgent('a1')
    v.openGroupChat('t1', 'r1')
    v.navigateTo('board')

    goBack()
    expect(useViewStore.getState().viewMode).toEqual({
      type: 'groupChat',
      teamId: 't1',
      roomId: 'r1',
    })
    expect(useTeamStore.getState().selectedTeamId).toBe('t1')
  })

  it('do nothing with nowhere to go', () => {
    useTeamStore.setState({ selectedTeamId: 't1' })
    goBack()
    goForward()
    expect(useViewStore.getState().viewMode).toEqual({ type: 'nav', view: 'graph' })
    expect(useTeamStore.getState().selectedTeamId).toBe('t1')
  })
})
