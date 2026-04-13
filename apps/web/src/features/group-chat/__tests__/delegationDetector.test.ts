import { describe, it, expect } from 'vitest'
import { detectDelegations, isRelayMessage } from '../delegationDetector'

const agents = [
  { id: 'a1', name: 'Code Reviewer Boo' },
  { id: 'a2', name: 'SEO Analyst Boo' },
  { id: 'a3', name: 'Bug Fixer Boo' },
  { id: 'a4', name: 'Bug Fixer' },
  { id: 'a5', name: 'Doc Writer Boo' },
]

describe('detectDelegations — basic patterns', () => {
  it('detects "@AgentName, please do X" pattern', () => {
    const result = detectDelegations(
      '@Code Reviewer Boo, please review the auth module',
      'src',
      agents,
    )
    expect(result).toHaveLength(1)
    expect(result[0]!.targetAgentId).toBe('a1')
    expect(result[0]!.taskDescription).toBe('review the auth module')
  })

  it('detects "route to @AgentName for X" pattern', () => {
    const result = detectDelegations(
      'route to @SEO Analyst Boo for keyword analysis',
      'src',
      agents,
    )
    expect(result).toHaveLength(1)
    expect(result[0]!.targetAgentId).toBe('a2')
    expect(result[0]!.taskDescription).toBe('keyword analysis')
  })

  it('detects "coordinate with @AgentName on X" pattern', () => {
    const result = detectDelegations(
      'coordinate with @Bug Fixer Boo on the memory leak',
      'src',
      agents,
    )
    expect(result).toHaveLength(1)
    expect(result[0]!.targetAgentId).toBe('a3')
    expect(result[0]!.taskDescription).toBe('the memory leak')
  })

  it('detects "I need @AgentName to X" pattern', () => {
    const result = detectDelegations('I need @Doc Writer Boo to update the API docs', 'src', agents)
    expect(result).toHaveLength(1)
    expect(result[0]!.targetAgentId).toBe('a5')
    expect(result[0]!.taskDescription).toBe('update the API docs')
  })

  it('detects "delegate to @AgentName: X" pattern', () => {
    const result = detectDelegations(
      'delegate to @SEO Analyst Boo: run a site audit',
      'src',
      agents,
    )
    expect(result).toHaveLength(1)
    expect(result[0]!.targetAgentId).toBe('a2')
    expect(result[0]!.taskDescription).toBe('run a site audit')
  })

  it('detects direct address "@AgentName, X" with comma', () => {
    const result = detectDelegations(
      '@Bug Fixer Boo, investigate the crash in the parser',
      'src',
      agents,
    )
    expect(result).toHaveLength(1)
    expect(result[0]!.targetAgentId).toBe('a3')
    expect(result[0]!.taskDescription).toBe('investigate the crash in the parser')
  })
})

describe('detectDelegations — task extraction', () => {
  it('extracts task up to period', () => {
    const result = detectDelegations(
      '@Code Reviewer Boo, check the types. Then we can merge.',
      'src',
      agents,
    )
    expect(result).toHaveLength(1)
    expect(result[0]!.taskDescription).toBe('check the types')
  })

  it('extracts task up to newline', () => {
    const result = detectDelegations(
      '@Code Reviewer Boo, check the types\nAlso fix the tests',
      'src',
      agents,
    )
    expect(result).toHaveLength(1)
    expect(result[0]!.taskDescription).toBe('check the types')
  })

  it('extracts task up to next @mention', () => {
    const result = detectDelegations(
      '@Code Reviewer Boo, check the types @SEO Analyst Boo, run an audit',
      'src',
      agents,
    )
    expect(result).toHaveLength(2)
    expect(result[0]!.taskDescription).toBe('check the types')
    expect(result[1]!.targetAgentId).toBe('a2')
  })

  it('trims whitespace from task', () => {
    const result = detectDelegations('@Code Reviewer Boo,   review the PR   ', 'src', agents)
    expect(result).toHaveLength(1)
    expect(result[0]!.taskDescription).toBe('review the PR')
  })
})

describe('detectDelegations — multiple delegations', () => {
  it('finds multiple @mentions to different agents', () => {
    const text = '@Code Reviewer Boo, review auth module\n@SEO Analyst Boo, check meta tags'
    const result = detectDelegations(text, 'src', agents)
    expect(result).toHaveLength(2)
    expect(result[0]!.targetAgentId).toBe('a1')
    expect(result[1]!.targetAgentId).toBe('a2')
  })

  it('dedupes same agent mentioned twice (returns first only)', () => {
    const text = '@Code Reviewer Boo, review auth module\nAlso @Code Reviewer Boo, check types'
    const result = detectDelegations(text, 'src', agents)
    expect(result).toHaveLength(1)
    expect(result[0]!.taskDescription).toBe('review auth module')
  })
})

describe('detectDelegations — filters', () => {
  it('skips self-mention (source === target)', () => {
    const result = detectDelegations('@Code Reviewer Boo, review this', 'a1', agents)
    expect(result).toHaveLength(0)
  })

  it('skips @mention inside fenced code block', () => {
    const text = '```\n@Code Reviewer Boo, review this\n```'
    const result = detectDelegations(text, 'src', agents)
    expect(result).toHaveLength(0)
  })

  it('skips @mention inside inline code', () => {
    const text = 'Use `@Code Reviewer Boo` for reviews'
    const result = detectDelegations(text, 'src', agents)
    expect(result).toHaveLength(0)
  })

  it('skips @mention inside blockquote', () => {
    const text = '> @Code Reviewer Boo, review this'
    const result = detectDelegations(text, 'src', agents)
    expect(result).toHaveLength(0)
  })

  it('skips when task description is empty', () => {
    const text = 'delegate to @Code Reviewer Boo:'
    const result = detectDelegations(text, 'src', agents)
    expect(result).toHaveLength(0)
  })

  it('skips unknown agent names (not in teamAgents)', () => {
    const result = detectDelegations('@Unknown Agent, do something', 'src', agents)
    expect(result).toHaveLength(0)
  })
})

describe('detectDelegations — edge cases', () => {
  it('returns empty array for text with no @mentions', () => {
    const result = detectDelegations('Just a normal message', 'src', agents)
    expect(result).toHaveLength(0)
  })

  it('handles case-insensitive agent names', () => {
    const result = detectDelegations('@code reviewer boo, check the PR', 'src', agents)
    expect(result).toHaveLength(1)
    expect(result[0]!.targetAgentId).toBe('a1')
    expect(result[0]!.targetAgentName).toBe('Code Reviewer Boo')
  })

  it('uses longest-prefix match for agent names', () => {
    const result = detectDelegations('@Bug Fixer Boo, fix the null pointer', 'src', agents)
    expect(result).toHaveLength(1)
    // Should match "Bug Fixer Boo" (a3), not "Bug Fixer" (a4)
    expect(result[0]!.targetAgentId).toBe('a3')
    expect(result[0]!.targetAgentName).toBe('Bug Fixer Boo')
  })
})

describe('isRelayMessage', () => {
  it('returns true for "[Team Update]" prefix', () => {
    expect(isRelayMessage('[Team Update] Agent completed task')).toBe(true)
  })

  it('returns true for "[Team Context" prefix', () => {
    expect(isRelayMessage('[Team Context — last 3 messages]\n...')).toBe(true)
  })

  it('returns false for normal text', () => {
    expect(isRelayMessage('Hello team, lets get started')).toBe(false)
  })
})
