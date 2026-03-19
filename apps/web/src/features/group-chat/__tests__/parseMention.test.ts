import { describe, it, expect } from 'vitest'
import { parseMention } from '../parseMention'

const agents = [
  { id: 'a1', name: 'Code Reviewer Boo' },
  { id: 'a2', name: 'SEO Analyst Boo' },
  { id: 'a3', name: 'Doc Writer Boo' },
  { id: 'a4', name: 'Code Boo' },
]

describe('parseMention', () => {
  it('parses @AgentName and strips mention from message', () => {
    const result = parseMention('@Code Reviewer Boo fix this bug', agents)
    expect(result.targetAgentId).toBe('a1')
    expect(result.cleanedMessage).toBe('fix this bug')
  })

  it('is case-insensitive', () => {
    const result = parseMention('@seo analyst boo check rankings', agents)
    expect(result.targetAgentId).toBe('a2')
    expect(result.cleanedMessage).toBe('check rankings')
  })

  it('uses longest prefix match', () => {
    // "Code Reviewer Boo" should match before "Code Boo"
    const result = parseMention('@Code Reviewer Boo review this', agents)
    expect(result.targetAgentId).toBe('a1')
    expect(result.cleanedMessage).toBe('review this')
  })

  it('matches shorter name when longer does not match', () => {
    const result = parseMention('@Code Boo help me', agents)
    expect(result.targetAgentId).toBe('a4')
    expect(result.cleanedMessage).toBe('help me')
  })

  it('returns null targetAgentId when no @ at start', () => {
    const result = parseMention('hello @Code Boo', agents)
    expect(result.targetAgentId).toBeNull()
    expect(result.cleanedMessage).toBe('hello @Code Boo')
  })

  it('returns null targetAgentId for unknown agent', () => {
    const result = parseMention('@Unknown Agent do something', agents)
    expect(result.targetAgentId).toBeNull()
    expect(result.cleanedMessage).toBe('@Unknown Agent do something')
  })

  it('handles empty message after mention', () => {
    const result = parseMention('@SEO Analyst Boo', agents)
    expect(result.targetAgentId).toBe('a2')
    expect(result.cleanedMessage).toBe('')
  })

  it('returns null targetAgentId for empty message', () => {
    const result = parseMention('', agents)
    expect(result.targetAgentId).toBeNull()
    expect(result.cleanedMessage).toBe('')
  })
})
