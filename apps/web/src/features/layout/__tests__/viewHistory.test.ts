// Back and forward as the top bar uses them: a page whose team or agent is gone
// is skipped, and the team rail's selection follows the page shown, as a click
// on the team's icon would.

import { beforeEach, describe, expect, it } from 'vitest'

import { useFleetStore, type AgentState } from '@/stores/fleet'
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

beforeEach(() => {
  useTeamStore.setState({
    teams: [team('t1'), team('t2'), team('old', true)],
    selectedTeamId: null,
  })
  useFleetStore.setState({ agents: [agent('a1'), agent('writer', 't1')] })
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
    expect(viewStillExists({ type: 'teamspace', teamId: 't1' }, teams, [])).toBe(true)
    expect(viewStillExists({ type: 'groupChat', teamId: 'old' }, teams, [])).toBe(false)
    expect(viewStillExists({ type: 'teamspace', teamId: 'gone' }, teams, [])).toBe(false)
    expect(viewStillExists({ type: 'nav', view: 'board' }, [], [])).toBe(true)
    expect(viewStillExists({ type: 'booZero' }, [], [])).toBe(true)
  })
})

describe('goBack and goForward', () => {
  it('select the team of the page they land on, and none for Boo Zero', () => {
    const v = useViewStore.getState()
    v.openTeamspace('t1')
    v.openBooZero()
    v.openGroupChat('t2')

    goBack()
    expect(useViewStore.getState().viewMode).toEqual({ type: 'booZero' })
    expect(useTeamStore.getState().selectedTeamId).toBeNull()

    goBack()
    expect(useViewStore.getState().viewMode).toEqual({ type: 'teamspace', teamId: 't1' })
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
    v.openTeamspace('t2')

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
    v.openTeamspace('old')
    v.navigateTo('board')

    goBack()
    expect(useViewStore.getState().viewMode).toEqual({ type: 'agent', agentId: 'a1' })
  })

  it('do nothing with nowhere to go', () => {
    useTeamStore.setState({ selectedTeamId: 't1' })
    goBack()
    goForward()
    expect(useViewStore.getState().viewMode).toEqual({ type: 'nav', view: 'graph' })
    expect(useTeamStore.getState().selectedTeamId).toBe('t1')
  })
})
