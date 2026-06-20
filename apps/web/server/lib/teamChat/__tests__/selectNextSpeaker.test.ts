import { describe, expect, it } from 'vitest'

import { selectNextSpeaker, type ChatParticipant } from '../selectNextSpeaker'

const team: ChatParticipant[] = [
  { agentId: 'leader', runtime: 'openclaw', isLeader: true },
  { agentId: 'claude', runtime: 'claude-code', isLeader: false },
  { agentId: 'hermes', runtime: 'hermes', isLeader: false },
]

describe('selectNextSpeaker', () => {
  it('nominates the leader when nothing is pending (leader-nominated)', () => {
    const sel = selectNextSpeaker({
      participants: team,
      lastSpeakerId: null,
      pendingObligations: new Set(),
    })
    expect(sel.speaker?.agentId).toBe('leader')
    expect(sel.policy).toBe('leader-nominated')
  })

  it('round-robins over pending obligations in stable order', () => {
    const sel = selectNextSpeaker({
      participants: team,
      lastSpeakerId: 'leader',
      pendingObligations: new Set(['hermes', 'claude']),
    })
    // Stable order = leader, then by agentId: claude before hermes.
    expect(sel.speaker?.agentId).toBe('claude')
    expect(sel.policy).toBe('round-robin')
  })

  it('avoids the immediate self-repeat when an alternative is pending', () => {
    const sel = selectNextSpeaker({
      participants: team,
      lastSpeakerId: 'claude',
      pendingObligations: new Set(['claude', 'hermes']),
    })
    expect(sel.speaker?.agentId).toBe('hermes')
  })

  it('lets a sole pending speaker go again (they owe it)', () => {
    const sel = selectNextSpeaker({
      participants: team,
      lastSpeakerId: 'claude',
      pendingObligations: new Set(['claude']),
    })
    expect(sel.speaker?.agentId).toBe('claude')
  })

  it('returns null when the leader just spoke and nothing is pending (exchange ends)', () => {
    const sel = selectNextSpeaker({
      participants: team,
      lastSpeakerId: 'leader',
      pendingObligations: new Set(),
    })
    expect(sel.speaker).toBeNull()
  })
})
