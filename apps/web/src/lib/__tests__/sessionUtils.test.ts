import { describe, it, expect } from 'vitest'
import { agentIdFromSessionKey } from '../sessionUtils'

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
