import { describe, it, expect } from 'vitest'
import { agentIdFromSessionKey, buildTeamSessionKey } from '../sessionUtils'

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
