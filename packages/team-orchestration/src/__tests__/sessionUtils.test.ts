import { describe, expect, it } from 'vitest'

import { agentIdFromSessionKey, buildTeamSessionKey, isTeamSessionKey } from '../sessionUtils'

describe('team-scoped sessionKey helpers', () => {
  it('buildTeamSessionKey / agentIdFromSessionKey round-trip', () => {
    const sk = buildTeamSessionKey('native-coder-7f3a', 'team-abc')
    expect(sk).toBe('agent:native-coder-7f3a:team:team-abc')
    expect(agentIdFromSessionKey(sk)).toBe('native-coder-7f3a')
  })

  describe('isTeamSessionKey', () => {
    it('true for a team-scoped key', () => {
      expect(isTeamSessionKey('agent:a1:team:T')).toBe(true)
      expect(isTeamSessionKey(buildTeamSessionKey('x', 'y'))).toBe(true)
      // teamId may itself contain colons / hyphens — the prefix is what matters.
      expect(isTeamSessionKey('agent:a1:team:team-with-colons:and:more')).toBe(true)
    })

    it('false for the other live key shapes', () => {
      expect(isTeamSessionKey('agent:a1:native')).toBe(false) // 1:1 native chat
      expect(isTeamSessionKey('runtime:clawboo-native:task:t1')).toBe(false) // board task
      expect(isTeamSessionKey('teamchat:room-1:a1:t3')).toBe(false) // peer-chat heartbeat
      expect(isTeamSessionKey('agent:a1:main')).toBe(false)
      expect(isTeamSessionKey('')).toBe(false)
      expect(isTeamSessionKey('garbage')).toBe(false)
    })

    it('does NOT match "team" appearing outside the third segment', () => {
      // The agentId segment containing "team" must not trip the prefix.
      expect(isTeamSessionKey('agent:team-lead:native')).toBe(false)
    })
  })
})
