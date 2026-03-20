import { describe, it, expect } from 'vitest'
import { renderMessageWithMentions } from '../renderMention'

const agents = ['Worker Boo', 'Code Reviewer Boo', 'Leader Boo']

describe('renderMessageWithMentions', () => {
  it('returns plain string when no @ prefix', () => {
    const result = renderMessageWithMentions('hello world', agents)
    expect(result).toBe('hello world')
  })

  it('returns plain string for unknown @agent', () => {
    const result = renderMessageWithMentions('@Unknown Agent hello', agents)
    expect(result).toBe('@Unknown Agent hello')
  })

  it('highlights known agent name at message start', () => {
    const result = renderMessageWithMentions('@Worker Boo fix the bug', agents)
    // Returns JSX fragment, not plain string
    expect(result).not.toBe('@Worker Boo fix the bug')
    expect(typeof result).toBe('object') // React element
  })

  it('uses longest-prefix match', () => {
    // "Code Reviewer Boo" is longer than "Code" — should match the longer name
    const result = renderMessageWithMentions('@Code Reviewer Boo check this', [
      'Code Boo',
      'Code Reviewer Boo',
    ])
    expect(typeof result).toBe('object') // matched the longer name
  })

  it('is case-insensitive', () => {
    const result = renderMessageWithMentions('@worker boo fix it', agents)
    expect(typeof result).toBe('object') // matched despite lowercase
  })

  it('returns plain string when @name not followed by whitespace', () => {
    const result = renderMessageWithMentions('@Worker Booster something', agents)
    // "Worker Booster" doesn't match "Worker Boo" followed by whitespace
    expect(result).toBe('@Worker Booster something')
  })

  it('handles @mention at end of message with no trailing text', () => {
    const result = renderMessageWithMentions('@Worker Boo', agents)
    expect(typeof result).toBe('object') // matched with no rest
  })
})
