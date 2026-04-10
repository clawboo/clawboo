import { describe, it, expect } from 'vitest'
import { resolveTeamLeader } from '../resolveTeamLeader'
import type { AgentState } from '@/stores/fleet'

function makeAgent(overrides: Partial<AgentState> = {}): AgentState {
  return {
    id: 'a1',
    name: 'Test Agent',
    status: 'idle',
    sessionKey: null,
    model: null,
    createdAt: null,
    streamingText: null,
    runId: null,
    lastSeenAt: null,
    teamId: 't1',
    execConfig: null,
    ...overrides,
  }
}

describe('resolveTeamLeader', () => {
  it('returns explicit leaderAgentId when agent exists in team', () => {
    const agents = [makeAgent({ id: 'a1', teamId: 't1' }), makeAgent({ id: 'a2', teamId: 't1' })]
    expect(resolveTeamLeader('t1', 'a2', agents)).toBe('a2')
  })

  it('falls back to first team agent when leaderAgentId is null', () => {
    const agents = [makeAgent({ id: 'a1', teamId: 't1' }), makeAgent({ id: 'a2', teamId: 't1' })]
    expect(resolveTeamLeader('t1', null, agents)).toBe('a1')
  })

  it('falls back to first team agent when leader agent not in the team', () => {
    const agents = [makeAgent({ id: 'a1', teamId: 't1' }), makeAgent({ id: 'a2', teamId: 't2' })]
    expect(resolveTeamLeader('t1', 'a2', agents)).toBe('a1')
  })

  it('returns null when team has no agents', () => {
    const agents = [makeAgent({ id: 'a1', teamId: 't2' })]
    expect(resolveTeamLeader('t1', null, agents)).toBeNull()
  })

  it('ignores agents from a different team', () => {
    const agents = [makeAgent({ id: 'a1', teamId: 't2' }), makeAgent({ id: 'a2', teamId: 't1' })]
    expect(resolveTeamLeader('t1', null, agents)).toBe('a2')
  })
})
