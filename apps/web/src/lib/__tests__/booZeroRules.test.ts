import { describe, it, expect } from 'vitest'
import { buildBooZeroAnchor, buildBooZeroRulesBlock } from '../booZeroRules'

// `buildBooZeroRulesBlock` is the canonical entry point and returns the thin
// anchor (~220 tokens). The verbose examples + full DO/DON'T list live in the
// read-once AGENTS.md / CLAWBOO.md; the anchor carries every SAFETY-critical rule.

describe('buildBooZeroRulesBlock', () => {
  it('opens with the [Your Rules — authoritative] sentinel and closes with [End Your Rules]', () => {
    const out = buildBooZeroRulesBlock({ displayName: 'Boo Zero' })
    expect(out.startsWith('[Your Rules — authoritative]')).toBe(true)
    expect(out.trim().endsWith('[End Your Rules]')).toBe(true)
  })

  it('asserts the display name as authoritative', () => {
    const out = buildBooZeroRulesBlock({ displayName: 'Mythos' })
    expect(out).toContain('You are Mythos.')
    // The anti-drift anchor names "Mythos" as a common-drift example regardless
    // of which name was passed.
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

  it('is identical to buildBooZeroAnchor (the entry point IS the anchor)', () => {
    const p = { displayName: 'Boo Zero', teamName: 'T' }
    expect(buildBooZeroRulesBlock(p)).toBe(buildBooZeroAnchor(p))
  })

  it('carries every SAFETY-critical rule', () => {
    const out = buildBooZeroRulesBlock({ displayName: 'Boo Zero', teamName: 'Demo Team' })
    // Delegation protocol — `<delegate>` is the only routing mechanism.
    expect(out).toContain('<delegate to="@AgentName">')
    expect(out).toMatch(/`<delegate>`\s+is\s+the\s+ONLY/i)
    // No spawning sub-agents.
    expect(out).toMatch(/never spawn sub-agents/i)
    // Multi-step plans.
    expect(out).toContain('<plan>')
    // Silence-on-relay.
    expect(out).toContain('[Team Update]')
    // No false-timeout.
    expect(out).toMatch(/timed out/i)
    // No resume greeting.
    expect(out).toMatch(/greet|re-introduce/i)
    // Points back at the read-once authority.
    expect(out).toMatch(/AGENTS\.md|CLAWBOO\.md/i)
  })

  it('is deterministic — same params produce identical output (prompt cache safe)', () => {
    const a = buildBooZeroRulesBlock({ displayName: 'X', teamName: 'Y' })
    const b = buildBooZeroRulesBlock({ displayName: 'X', teamName: 'Y' })
    expect(a).toBe(b)
  })

  it('stays compact (the per-turn token win)', () => {
    const out = buildBooZeroRulesBlock({
      displayName: 'Boo Zero',
      teamName: 'A Sample Team With A Reasonable Length',
    })
    expect(out.length).toBeLessThan(2500)
  })
})
