// agentStatusBus — the in-memory per-channel working/idle pub/sub (the SSE `status`
// channel) + its last-status SNAPSHOT. Asserts: delivery + unsubscribe + channel
// isolation + throwing-listener isolation (the chatDeltaBus contract), and the
// reconcile snapshot — the last-published status per agent is recorded even with
// ZERO subscribers, so a (re)connecting SSE stream can replay it and fix a badge
// left stale by a terminal that published while no client was listening.

import { describe, expect, it } from 'vitest'

import {
  getAgentStatusSnapshot,
  publishAgentStatus,
  subscribeAgentStatus,
  type AgentStatusUpdate,
} from '../agentStatusBus'

describe('agentStatusBus', () => {
  it('delivers a published update to a current subscriber', () => {
    const seen: AgentStatusUpdate[] = []
    const unsub = subscribeAgentStatus('team-a', (u) => seen.push(u))
    publishAgentStatus('team-a', { agentId: 'a1', status: 'running' })
    expect(seen).toEqual([{ agentId: 'a1', status: 'running' }])
    unsub()
  })

  it('stops delivering after unsubscribe + isolates channels', () => {
    const seen: AgentStatusUpdate[] = []
    const unsub = subscribeAgentStatus('team-b', (u) => seen.push(u))
    publishAgentStatus('team-other', { agentId: 'x', status: 'running' })
    publishAgentStatus('team-b', { agentId: 'b1', status: 'running' })
    unsub()
    publishAgentStatus('team-b', { agentId: 'b1', status: 'idle' })
    expect(seen).toEqual([{ agentId: 'b1', status: 'running' }])
  })

  it('a throwing listener never breaks sibling listeners', () => {
    const seen: AgentStatusUpdate[] = []
    const unsub1 = subscribeAgentStatus('team-c', () => {
      throw new Error('dead SSE write')
    })
    const unsub2 = subscribeAgentStatus('team-c', (u) => seen.push(u))
    expect(() => publishAgentStatus('team-c', { agentId: 'c1', status: 'idle' })).not.toThrow()
    expect(seen).toEqual([{ agentId: 'c1', status: 'idle' }])
    unsub1()
    unsub2()
  })

  it('records the last status per agent even with ZERO subscribers (the reconcile snapshot)', () => {
    // A run starts + finishes while no SSE stream is open — the badge fix depends
    // on the terminal still being recorded for the next connect to replay.
    publishAgentStatus('team-d', { agentId: 'd1', status: 'running' })
    publishAgentStatus('team-d', { agentId: 'd1', status: 'idle' })
    publishAgentStatus('team-d', { agentId: 'd2', status: 'running' })
    expect(
      getAgentStatusSnapshot('team-d').sort((a, b) => a.agentId.localeCompare(b.agentId)),
    ).toEqual([
      { agentId: 'd1', status: 'idle' },
      { agentId: 'd2', status: 'running' },
    ])
  })

  it('an unknown channel snapshots to an empty list', () => {
    expect(getAgentStatusSnapshot('never-published')).toEqual([])
  })
})
