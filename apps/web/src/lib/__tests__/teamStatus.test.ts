import { describe, it, expect } from 'vitest'
import type { AgentState } from '@/stores/fleet'
import { aggregateTeamStatus, teamStatusBreakdown } from '../teamStatus'

function mkAgent(id: string, status: AgentState['status']): AgentState {
  return {
    id,
    name: `Agent ${id}`,
    status,
    sessionKey: `agent:${id}:main`,
    model: null,
    createdAt: null,
    streamingText: null,
    runId: null,
    lastSeenAt: null,
    teamId: 't1',
    execConfig: null,
  }
}

describe('aggregateTeamStatus', () => {
  it('returns idle for empty team', () => {
    expect(aggregateTeamStatus([])).toBe('idle')
  })

  it('returns idle when all agents idle', () => {
    expect(aggregateTeamStatus([mkAgent('a', 'idle'), mkAgent('b', 'idle')])).toBe('idle')
  })

  it('promotes running over error / sleeping / idle', () => {
    expect(
      aggregateTeamStatus([
        mkAgent('a', 'idle'),
        mkAgent('b', 'sleeping'),
        mkAgent('c', 'error'),
        mkAgent('d', 'running'),
      ]),
    ).toBe('running')
  })

  it('promotes error over sleeping / idle (but below running)', () => {
    expect(
      aggregateTeamStatus([mkAgent('a', 'idle'), mkAgent('b', 'sleeping'), mkAgent('c', 'error')]),
    ).toBe('error')
  })

  it('promotes sleeping over idle', () => {
    expect(aggregateTeamStatus([mkAgent('a', 'idle'), mkAgent('b', 'sleeping')])).toBe('sleeping')
  })
})

describe('teamStatusBreakdown', () => {
  it('counts zero for empty team', () => {
    expect(teamStatusBreakdown([])).toEqual({
      idle: 0,
      running: 0,
      sleeping: 0,
      error: 0,
      total: 0,
    })
  })

  it('counts per-bucket correctly across mixed statuses', () => {
    const team = [
      mkAgent('a', 'running'),
      mkAgent('b', 'running'),
      mkAgent('c', 'sleeping'),
      mkAgent('d', 'idle'),
      mkAgent('e', 'idle'),
      mkAgent('f', 'idle'),
      mkAgent('g', 'error'),
    ]
    expect(teamStatusBreakdown(team)).toEqual({
      idle: 3,
      running: 2,
      sleeping: 1,
      error: 1,
      total: 7,
    })
  })

  it('keeps total === team length even when all agents share a single bucket', () => {
    const team = [mkAgent('a', 'idle'), mkAgent('b', 'idle'), mkAgent('c', 'idle')]
    const result = teamStatusBreakdown(team)
    expect(result.total).toBe(3)
    expect(result.idle).toBe(3)
    expect(result.running + result.sleeping + result.error).toBe(0)
  })
})
