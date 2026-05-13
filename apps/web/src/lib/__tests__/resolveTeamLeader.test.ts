import { describe, it, expect } from 'vitest'
import { resolveTeamLeader, resolveTeamInternalLead } from '../resolveTeamLeader'
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

describe('resolveTeamLeader (Boo Zero universal leader)', () => {
  it('returns Boo Zero when present in the fleet, regardless of team-internal lead', () => {
    const agents = [
      makeAgent({ id: 'a1', teamId: 't1' }),
      makeAgent({ id: 'a2', teamId: 't1' }),
      makeAgent({ id: 'booZero', teamId: null }),
    ]
    expect(resolveTeamLeader('t1', 'a1', agents, 'booZero')).toBe('booZero')
    // Even if the team has no internal lead set:
    expect(resolveTeamLeader('t1', null, agents, 'booZero')).toBe('booZero')
  })

  it('Boo Zero precedence works even when Boo Zero is teamless', () => {
    const agents = [makeAgent({ id: 'a1', teamId: 't1' }), makeAgent({ id: 'bz', teamId: null })]
    expect(resolveTeamLeader('t1', null, agents, 'bz')).toBe('bz')
  })

  it('falls back to team-internal lead when Boo Zero is missing', () => {
    const agents = [makeAgent({ id: 'a1', teamId: 't1' }), makeAgent({ id: 'a2', teamId: 't1' })]
    expect(resolveTeamLeader('t1', 'a2', agents, null)).toBe('a2')
  })

  it("falls back to team-internal lead when Boo Zero id doesn't exist in the fleet", () => {
    const agents = [makeAgent({ id: 'a1', teamId: 't1' }), makeAgent({ id: 'a2', teamId: 't1' })]
    expect(resolveTeamLeader('t1', 'a2', agents, 'ghost-bz')).toBe('a2')
  })

  it('falls back to first team agent when no Boo Zero and no internal lead', () => {
    const agents = [makeAgent({ id: 'a1', teamId: 't1' }), makeAgent({ id: 'a2', teamId: 't1' })]
    expect(resolveTeamLeader('t1', null, agents, null)).toBe('a1')
  })

  it('falls back to first team agent when internal lead exists but is not on the team', () => {
    const agents = [makeAgent({ id: 'a1', teamId: 't1' }), makeAgent({ id: 'a2', teamId: 't2' })]
    expect(resolveTeamLeader('t1', 'a2', agents, null)).toBe('a1')
  })

  it('returns null when team has no agents and no Boo Zero', () => {
    const agents = [makeAgent({ id: 'a1', teamId: 't2' })]
    expect(resolveTeamLeader('t1', null, agents, null)).toBeNull()
  })

  it('returns Boo Zero even when team has no agents', () => {
    // Boo Zero is the universal leader — a team with zero members still has
    // Boo Zero as its leader. The chat will respond with just Boo Zero.
    const agents = [makeAgent({ id: 'bz', teamId: null })]
    expect(resolveTeamLeader('t1', null, agents, 'bz')).toBe('bz')
  })

  it('ignores agents from a different team in the internal-lead fallback', () => {
    const agents = [makeAgent({ id: 'a1', teamId: 't2' }), makeAgent({ id: 'a2', teamId: 't1' })]
    expect(resolveTeamLeader('t1', null, agents, null)).toBe('a2')
  })
})

describe('resolveTeamInternalLead', () => {
  it('returns the internal lead when it is on the team', () => {
    const agents = [makeAgent({ id: 'a1', teamId: 't1' }), makeAgent({ id: 'a2', teamId: 't1' })]
    expect(resolveTeamInternalLead('t1', 'a2', agents)).toBe('a2')
  })

  it('returns null when no internal lead is set', () => {
    const agents = [makeAgent({ id: 'a1', teamId: 't1' })]
    expect(resolveTeamInternalLead('t1', null, agents)).toBeNull()
  })

  it('returns null when the internal lead is no longer on the team', () => {
    const agents = [makeAgent({ id: 'a1', teamId: 't1' }), makeAgent({ id: 'a2', teamId: 't2' })]
    expect(resolveTeamInternalLead('t1', 'a2', agents)).toBeNull()
  })

  it('returns null when team has no agents', () => {
    expect(resolveTeamInternalLead('t1', 'a1', [])).toBeNull()
  })

  it('never returns Boo Zero — it only looks at internal team membership', () => {
    // Even if Boo Zero is also somehow set as the internal lead AND in the
    // fleet teamless, this function does not promote it (different concern).
    const agents = [makeAgent({ id: 'bz', teamId: null }), makeAgent({ id: 'a1', teamId: 't1' })]
    expect(resolveTeamInternalLead('t1', 'bz', agents)).toBeNull()
  })
})
