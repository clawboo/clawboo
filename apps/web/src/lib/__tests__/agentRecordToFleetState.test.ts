// The registry record -> fleet store mapping.
//
// `providerReady` is the per-agent "can this one actually run" flag, and it is
// the ONLY signal that reveals an agent parked on a disconnected provider, since
// runtime health reads green whenever any provider is connected. The badge that
// renders it is tested against the store; this covers the step before that, where
// the server's answer becomes store state. Severing it here would disable the
// badge everywhere with no other test noticing.

import { describe, expect, it } from 'vitest'

import type { AgentRecord } from '@clawboo/agent-registry'

import { agentRecordToFleetState } from '../agentSourceClient'

function record(over: Partial<AgentRecord> = {}): AgentRecord {
  return {
    id: 'native-x',
    sourceId: 'clawboo-native',
    sourceAgentId: 'native-x',
    displayName: 'Test Boo',
    emoji: null,
    avatarUrl: null,
    avatarSeed: null,
    status: 'idle',
    sessionKey: 'agent:native-x:native',
    isDefault: false,
    teamId: null,
    personalityConfig: null,
    execConfig: null,
    participantKind: 'agent',
    runtime: 'clawboo-native',
    capabilities: null,
    tenantId: null,
    archivedAt: null,
    createdAt: 0,
    updatedAt: 0,
    ...over,
  }
}

describe('agentRecordToFleetState', () => {
  it('carries providerReady through to the store', () => {
    expect(agentRecordToFleetState(record({ providerReady: false })).providerReady).toBe(false)
    expect(agentRecordToFleetState(record({ providerReady: true })).providerReady).toBe(true)
  })

  it('maps an absent providerReady to null rather than undefined', () => {
    // A source that does not report readiness (OpenClaw) must read as "unknown",
    // which the badge treats as "do not badge", never as "not ready".
    expect(agentRecordToFleetState(record()).providerReady).toBeNull()
  })

  it('still maps the fields the badge sits beside', () => {
    const state = agentRecordToFleetState(record({ model: 'claude-haiku-4-5' }))
    expect(state).toMatchObject({
      id: 'native-x',
      name: 'Test Boo',
      runtime: 'clawboo-native',
      model: 'claude-haiku-4-5',
      sessionKey: 'agent:native-x:native',
    })
  })
})
