import { describe, expect, it } from 'vitest'

import {
  agentIdFromSessionKey,
  buildTeamSessionKey,
  isTeamSessionKey,
  parseTeamSessionKey,
  roomIdFromSessionKey,
  teamIdFromSessionKey,
} from '../sessionUtils'

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

  describe('room keys', () => {
    const TEAM = '7c9e6679-7425-40de-944b-e07fc1f90ae7'
    const ROOM = 'f47ac10b-58cc-4372-a567-0e02b2c3d479'

    it('the default room keeps the plain team key', () => {
      expect(buildTeamSessionKey('a1', TEAM)).toBe(`agent:a1:team:${TEAM}`)
      expect(buildTeamSessionKey('a1', TEAM, null)).toBe(`agent:a1:team:${TEAM}`)
      expect(buildTeamSessionKey('a1', TEAM, undefined)).toBe(`agent:a1:team:${TEAM}`)
    })

    it('a room key round-trips through every helper', () => {
      const sk = buildTeamSessionKey('a1', TEAM, ROOM)
      expect(sk).toBe(`agent:a1:team:${TEAM}:room:${ROOM}`)
      expect(isTeamSessionKey(sk)).toBe(true)
      expect(agentIdFromSessionKey(sk)).toBe('a1')
      expect(teamIdFromSessionKey(sk)).toBe(TEAM)
      expect(roomIdFromSessionKey(sk)).toBe(ROOM)
      expect(parseTeamSessionKey(sk)).toEqual({ agentId: 'a1', teamId: TEAM, roomId: ROOM })
    })

    it('a plain team key parses with no room', () => {
      const sk = buildTeamSessionKey('a1', TEAM)
      expect(teamIdFromSessionKey(sk)).toBe(TEAM)
      expect(roomIdFromSessionKey(sk)).toBeNull()
      // A colon inside the team id is part of the team id, never a room.
      expect(teamIdFromSessionKey('agent:a1:team:team-with-colons:and:more')).toBe(
        'team-with-colons:and:more',
      )
      expect(roomIdFromSessionKey('agent:a1:team:team-with-colons:and:more')).toBeNull()
    })

    it('rejects or ignores malformed room suffixes', () => {
      // An empty room id is not a room: the whole tail stays the team id.
      expect(parseTeamSessionKey(`agent:a1:team:${TEAM}:room:`)).toEqual({
        agentId: 'a1',
        teamId: `${TEAM}:room:`,
        roomId: null,
      })
      expect(parseTeamSessionKey('agent:a1:team:')).toBeNull()
      expect(parseTeamSessionKey(`agent:a1:team:${TEAM}:room:r\nx`)).toBeNull()
      expect(teamIdFromSessionKey('agent:a1:native')).toBeNull()
      expect(roomIdFromSessionKey('agent:a1:native')).toBeNull()
      expect(roomIdFromSessionKey('runtime:clawboo-native:task:t1')).toBeNull()
    })

    it('stays linear on a key packed with room separators', () => {
      const hostile = 'agent:a:team:' + 'x:room:'.repeat(50000)
      const started = performance.now()
      parseTeamSessionKey(hostile)
      expect(performance.now() - started).toBeLessThan(500)
    })
  })
})
