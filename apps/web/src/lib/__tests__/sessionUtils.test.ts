import { describe, it, expect, beforeEach } from 'vitest'
import {
  agentIdFromSessionKey,
  buildTeamSessionKey,
  setTeamChatOverride,
  clearTeamChatOverride,
  hasTeamChatOverride,
  resetTeamChatOverrides,
} from '../sessionUtils'

describe('agentIdFromSessionKey', () => {
  it('extracts agentId from standard sessionKey format', () => {
    expect(agentIdFromSessionKey('agent:abc-123:main')).toBe('abc-123')
  })

  it('handles complex agent IDs', () => {
    expect(agentIdFromSessionKey('agent:my-agent-id:session-456')).toBe('my-agent-id')
  })

  it('returns null for invalid format', () => {
    expect(agentIdFromSessionKey('invalid-key')).toBeNull()
  })

  it('returns null for empty string', () => {
    expect(agentIdFromSessionKey('')).toBeNull()
  })

  it('returns null for partial format without trailing colon', () => {
    expect(agentIdFromSessionKey('agent:abc')).toBeNull()
  })
})

describe('buildTeamSessionKey', () => {
  it('builds team-scoped sessionKey', () => {
    expect(buildTeamSessionKey('a1', 'team-1')).toBe('agent:a1:team:team-1')
  })

  it('round-trips with agentIdFromSessionKey', () => {
    const teamKey = buildTeamSessionKey('my-agent', 'my-team')
    expect(agentIdFromSessionKey(teamKey)).toBe('my-agent')
  })

  it('handles UUID-style IDs', () => {
    expect(buildTeamSessionKey('abc-123-def', 'team-uuid-456')).toBe(
      'agent:abc-123-def:team:team-uuid-456',
    )
  })
})

describe('hasTeamChatOverride', () => {
  beforeEach(() => {
    resetTeamChatOverrides()
  })

  it('returns false when no override is set', () => {
    expect(hasTeamChatOverride('a1')).toBe(false)
  })

  it('returns true when override is set', () => {
    setTeamChatOverride('a1', 'agent:a1:team:team-1')
    expect(hasTeamChatOverride('a1')).toBe(true)
  })

  it('returns false after override is cleared', () => {
    setTeamChatOverride('a1', 'agent:a1:team:team-1')
    clearTeamChatOverride('a1')
    expect(hasTeamChatOverride('a1')).toBe(false)
  })

  it('returns false after resetTeamChatOverrides', () => {
    setTeamChatOverride('a1', 'agent:a1:team:team-1')
    setTeamChatOverride('a2', 'agent:a2:team:team-1')
    resetTeamChatOverrides()
    expect(hasTeamChatOverride('a1')).toBe(false)
    expect(hasTeamChatOverride('a2')).toBe(false)
  })
})
