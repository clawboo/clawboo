import { describe, it, expect } from 'vitest'
import { buildTeamAgentsMd, buildTeamWakeMessage, buildTeamContextPreamble } from '../teamProtocol'

describe('buildTeamAgentsMd', () => {
  const teammates = [
    { name: 'Bug Fixer Boo', role: 'Fixes bugs' },
    { name: 'SEO Analyst Boo', role: 'SEO optimization' },
  ]

  it('generates correct markdown with teammates and routing rules', () => {
    const result = buildTeamAgentsMd({
      agentName: 'Lead Dev Boo',
      teamName: 'Dev Team',
      teammates,
      routingRules: 'When code review needed, route to @Bug Fixer Boo',
    })
    expect(result).toContain('# AGENTS — Team Collaboration')
    expect(result).toContain('## Your Team: Dev Team')
    expect(result).toContain('You are **Lead Dev Boo**')
    expect(result).toContain('### Routing Rules')
    expect(result).toContain('When code review needed, route to @Bug Fixer Boo')
  })

  it('includes all teammate names in table', () => {
    const result = buildTeamAgentsMd({
      agentName: 'Lead Dev Boo',
      teamName: 'Dev Team',
      teammates,
      routingRules: '',
    })
    expect(result).toContain('| @Bug Fixer Boo | Fixes bugs |')
    expect(result).toContain('| @SEO Analyst Boo | SEO optimization |')
  })

  it('handles empty teammates (solo agent — omits team section)', () => {
    const result = buildTeamAgentsMd({
      agentName: 'Solo Boo',
      teamName: 'Solo Team',
      teammates: [],
      routingRules: 'Route to self',
    })
    expect(result).not.toContain('Team Collaboration')
    expect(result).not.toContain('Teammates')
    expect(result).not.toContain('CRITICAL')
    expect(result).toContain('Route to self')
  })

  it('handles empty/missing routing rules', () => {
    const result = buildTeamAgentsMd({
      agentName: 'Lead Dev Boo',
      teamName: 'Dev Team',
      teammates,
      routingRules: '',
    })
    expect(result).toContain('No specific routing rules defined.')
  })

  it('includes the "DO NOT spawn sub-agents" instruction when teammates exist', () => {
    const result = buildTeamAgentsMd({
      agentName: 'Lead Dev Boo',
      teamName: 'Dev Team',
      teammates,
      routingRules: '',
    })
    expect(result).toContain('**DO NOT:**')
    expect(result).toContain('Spawn sub-agents')
    expect(result).toContain('REAL OpenClaw agents')
  })

  it('preserves original routing rules content verbatim', () => {
    const rules =
      '1. Route bugs to @Bug Fixer\n2. Route SEO to @SEO Analyst\n3. Handle all else yourself'
    const result = buildTeamAgentsMd({
      agentName: 'Lead Dev Boo',
      teamName: 'Dev Team',
      teammates,
      routingRules: rules,
    })
    expect(result).toContain(rules)
  })
})

describe('buildTeamWakeMessage', () => {
  const teammates = [
    { name: 'Code Reviewer Boo', role: 'Reviews pull requests' },
    { name: 'QA Tester Boo', role: 'Writes and runs tests' },
  ]

  it('includes agent name and team name', () => {
    const result = buildTeamWakeMessage({
      agentName: 'Lead Dev Boo',
      teamName: 'Engineering',
      teammates,
    })
    expect(result).toContain('as Lead Dev Boo')
    expect(result).toContain('Team: Engineering')
  })

  it('lists all teammates with roles', () => {
    const result = buildTeamWakeMessage({
      agentName: 'Lead Dev Boo',
      teamName: 'Engineering',
      teammates,
    })
    expect(result).toContain('- @Code Reviewer Boo (Reviews pull requests)')
    expect(result).toContain('- @QA Tester Boo (Writes and runs tests)')
  })

  it('includes "REAL agents" instruction', () => {
    const result = buildTeamWakeMessage({
      agentName: 'Lead Dev Boo',
      teamName: 'Engineering',
      teammates,
    })
    expect(result).toContain('REAL agents with their own sessions')
  })

  it('includes "Do NOT spawn sub-agents" instruction', () => {
    const result = buildTeamWakeMessage({
      agentName: 'Lead Dev Boo',
      teamName: 'Engineering',
      teammates,
    })
    expect(result).toContain('Do NOT spawn sub-agents')
  })
})

describe('buildTeamContextPreamble', () => {
  const ts = (h: number, m: number) => new Date(2026, 0, 1, h, m).getTime()

  it('returns null when no entries', () => {
    const result = buildTeamContextPreamble({
      entries: [],
      targetAgentName: 'Lead Boo',
    })
    expect(result).toBeNull()
  })

  it('returns null when all entries are from the target agent', () => {
    const result = buildTeamContextPreamble({
      entries: [
        {
          agentName: 'Lead Boo',
          text: 'hello',
          timestampMs: ts(10, 0),
          kind: 'text',
          role: 'assistant',
        },
      ],
      targetAgentName: 'Lead Boo',
    })
    expect(result).toBeNull()
  })

  it('excludes target agent own messages', () => {
    const result = buildTeamContextPreamble({
      entries: [
        {
          agentName: 'Lead Boo',
          text: 'my msg',
          timestampMs: ts(10, 0),
          kind: 'text',
          role: 'assistant',
        },
        {
          agentName: 'Bug Fixer',
          text: 'their msg',
          timestampMs: ts(10, 1),
          kind: 'text',
          role: 'assistant',
        },
      ],
      targetAgentName: 'Lead Boo',
    })
    expect(result).not.toContain('my msg')
    expect(result).toContain('Bug Fixer: their msg')
  })

  it('excludes meta entries (kind === "meta")', () => {
    const result = buildTeamContextPreamble({
      entries: [
        {
          agentName: 'System',
          text: 'Initializing...',
          timestampMs: ts(10, 0),
          kind: 'meta',
          role: 'system',
        },
        {
          agentName: 'Bug Fixer',
          text: 'ready',
          timestampMs: ts(10, 1),
          kind: 'text',
          role: 'assistant',
        },
      ],
      targetAgentName: 'Lead Boo',
    })
    expect(result).not.toContain('Initializing')
    expect(result).toContain('Bug Fixer: ready')
  })

  it('excludes [Team Update] prefixed entries', () => {
    const result = buildTeamContextPreamble({
      entries: [
        {
          agentName: 'Bug Fixer',
          text: '[Team Update] relay msg',
          timestampMs: ts(10, 0),
          kind: 'text',
          role: 'assistant',
        },
        {
          agentName: 'QA Boo',
          text: 'actual msg',
          timestampMs: ts(10, 1),
          kind: 'text',
          role: 'assistant',
        },
      ],
      targetAgentName: 'Lead Boo',
    })
    expect(result).not.toContain('relay msg')
    expect(result).toContain('QA Boo: actual msg')
  })

  it('truncates long messages to 200 chars', () => {
    const longText = 'a'.repeat(300)
    const result = buildTeamContextPreamble({
      entries: [
        {
          agentName: 'Bug Fixer',
          text: longText,
          timestampMs: ts(10, 0),
          kind: 'text',
          role: 'assistant',
        },
      ],
      targetAgentName: 'Lead Boo',
    })
    expect(result).toContain('a'.repeat(200) + '...')
    expect(result).not.toContain('a'.repeat(201))
  })

  it('respects maxMessages limit (takes last N)', () => {
    const entries = Array.from({ length: 5 }, (_, i) => ({
      agentName: 'Bug Fixer',
      text: `msg-${i}`,
      timestampMs: ts(10, i),
      kind: 'text',
      role: 'assistant' as const,
    }))
    const result = buildTeamContextPreamble({
      entries,
      targetAgentName: 'Lead Boo',
      maxMessages: 2,
    })
    expect(result).not.toContain('msg-0')
    expect(result).not.toContain('msg-2')
    expect(result).toContain('msg-3')
    expect(result).toContain('msg-4')
  })

  it('respects maxChars limit (drops oldest)', () => {
    const entries = Array.from({ length: 10 }, (_, i) => ({
      agentName: 'Bug Fixer',
      text: `message number ${i} with some padding text`,
      timestampMs: ts(10, i),
      kind: 'text',
      role: 'assistant' as const,
    }))
    const result = buildTeamContextPreamble({
      entries,
      targetAgentName: 'Lead Boo',
      maxChars: 300,
    })
    expect(result).not.toBeNull()
    expect(result!.length).toBeLessThanOrEqual(300)
    // Should contain later messages, not earlier ones
    expect(result).toContain('message number 9')
  })

  it('formats timestamps as HH:MM', () => {
    const result = buildTeamContextPreamble({
      entries: [
        {
          agentName: 'Bug Fixer',
          text: 'hello',
          timestampMs: ts(9, 5),
          kind: 'text',
          role: 'assistant',
        },
      ],
      targetAgentName: 'Lead Boo',
    })
    expect(result).toContain('[09:05]')
  })

  it('uses "User" for user role entries', () => {
    const result = buildTeamContextPreamble({
      entries: [
        {
          agentName: 'ignored-name',
          text: 'user says hi',
          timestampMs: ts(10, 0),
          kind: 'text',
          role: 'user',
        },
      ],
      targetAgentName: 'Lead Boo',
    })
    expect(result).toContain('User: user says hi')
    expect(result).not.toContain('ignored-name')
  })
})
