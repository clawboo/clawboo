import { describe, it, expect } from 'vitest'
import { buildBooZeroRulesBlock } from '../booZeroRules'

describe('buildBooZeroRulesBlock', () => {
  it('opens with the [Your Rules — authoritative] sentinel and closes with [End Your Rules]', () => {
    const out = buildBooZeroRulesBlock({ displayName: 'Boo Zero' })
    expect(out.startsWith('[Your Rules — authoritative]')).toBe(true)
    expect(out.trim().endsWith('[End Your Rules]')).toBe(true)
  })

  it('asserts the display name as authoritative', () => {
    const out = buildBooZeroRulesBlock({ displayName: 'Mythos' })
    expect(out).toContain('You are Mythos.')
    expect(out).toContain('This is your name.')
    // The "do NOT use any alternative name" anchor mentions Mythos as a
    // common-drift example regardless of which name was passed.
    expect(out).toContain('"Mythos"')
  })

  it('includes the team-context role line when teamName is provided', () => {
    const out = buildBooZeroRulesBlock({
      displayName: 'Boo Zero',
      teamName: 'Project Management Excellence Team',
    })
    expect(out).toContain('coordinating team "Project Management Excellence Team"')
  })

  it('omits the team name when teamName is null/undefined (1:1 chat path)', () => {
    const a = buildBooZeroRulesBlock({ displayName: 'Boo Zero' })
    const b = buildBooZeroRulesBlock({ displayName: 'Boo Zero', teamName: null })
    expect(a).toContain('coordinating across every team')
    expect(b).toContain('coordinating across every team')
    expect(a).toBe(b)
  })

  it('contains every load-bearing rule', () => {
    const out = buildBooZeroRulesBlock({ displayName: 'Boo Zero' })
    // Delegation protocol
    expect(out).toContain('<delegate to="@AgentName">')
    expect(out).toMatch(/`<delegate>`\s+is\s+the\s+ONLY/i)
    // Don't do work yourself
    expect(out).toMatch(/Do the work yourself instead of delegating/i)
    // Don't claim timeout
    expect(out).toMatch(/timed out/i)
    // Don't reply to [Team Update] as fresh user input
    expect(out).toContain('[Team Update]')
    expect(out).toMatch(/NOT fresh user input/i)
    // No Task tool / sub-agents
    expect(out).toMatch(/Task-tool/i)
    // No resume greetings
    expect(out).toMatch(/Greet teammates, introduce yourself/i)
    // File namespacing for duplicate deliverables
    expect(out).toMatch(/Write files for a deliverable a teammate/i)
    // Honest uncertainty
    expect(out).toMatch(/Honest uncertainty beats false certainty/i)
  })

  it('is deterministic — same params produce identical output (prompt cache safe)', () => {
    const a = buildBooZeroRulesBlock({ displayName: 'X', teamName: 'Y' })
    const b = buildBooZeroRulesBlock({ displayName: 'X', teamName: 'Y' })
    expect(a).toBe(b)
  })

  it('stays under a soft 2500-char budget so the per-turn token cost is bounded', () => {
    const out = buildBooZeroRulesBlock({
      displayName: 'Boo Zero',
      teamName: 'A Sample Team With A Reasonable Length',
    })
    // Current block is ~1900 chars (~475 tokens). The soft 2500 ceiling
    // catches runaway expansion without breaking on minor edits.
    expect(out.length).toBeLessThan(2500)
  })
})
