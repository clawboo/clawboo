import { describe, it, expect } from 'vitest'
import { parseRuleCommand, appendRule, buildTeamRulesBlock } from '../teamRules'

describe('parseRuleCommand', () => {
  it('returns the rule text when prefixed with /rule ', () => {
    expect(parseRuleCommand('/rule do not do work yourself')).toBe('do not do work yourself')
  })

  it('handles trailing whitespace', () => {
    expect(parseRuleCommand('  /rule  delegate via <delegate>  ')).toBe('delegate via <delegate>')
  })

  it('is case-insensitive on the prefix', () => {
    expect(parseRuleCommand('/RULE always verify')).toBe('always verify')
  })

  it('returns null for /rule with no body', () => {
    expect(parseRuleCommand('/rule')).toBeNull()
    expect(parseRuleCommand('/rule   ')).toBeNull()
  })

  it('returns null for non-rule commands', () => {
    expect(parseRuleCommand('/reset')).toBeNull()
    expect(parseRuleCommand('rule whatever')).toBeNull()
    expect(parseRuleCommand('/rules whatever')).toBeNull()
    expect(parseRuleCommand('/ruleset everything')).toBeNull()
  })

  it('returns null for normal user messages', () => {
    expect(parseRuleCommand('hi team, what can we do?')).toBeNull()
    expect(parseRuleCommand('')).toBeNull()
  })
})

describe('appendRule', () => {
  it('appends a single rule as a bullet line when existing is empty', () => {
    expect(appendRule('', 'do not do work yourself')).toBe('- do not do work yourself')
  })

  it('appends to existing bulleted rules', () => {
    const existing = '- always verify URLs with curl'
    const next = appendRule(existing, 'do not use sub-agents')
    expect(next).toBe('- always verify URLs with curl\n- do not use sub-agents')
  })

  it('preserves existing rule formatting when re-normalizing', () => {
    // Existing rules might come in without bullets or with `*` markers — we
    // re-normalize to `- ` so the block is consistent.
    const existing = 'always verify URLs with curl\n* do not use sub-agents'
    const next = appendRule(existing, 'delegate first')
    expect(next).toBe('- always verify URLs with curl\n- do not use sub-agents\n- delegate first')
  })

  it('deduplicates case-insensitively', () => {
    const existing = '- Delegate first'
    const next = appendRule(existing, 'delegate first')
    expect(next).toBe(existing)
  })

  it('ignores empty rules', () => {
    expect(appendRule('- existing', '   ')).toBe('- existing')
    expect(appendRule('- existing', '')).toBe('- existing')
  })
})

describe('buildTeamRulesBlock', () => {
  it('wraps non-empty content in the structured envelope', () => {
    const out = buildTeamRulesBlock('- do not do work yourself')
    expect(out).toContain('[Team Rules — set by the user, authoritative]')
    expect(out).toContain('- do not do work yourself')
    expect(out).toContain('[End Team Rules]')
  })

  it('returns null for empty / whitespace content (no envelope injected)', () => {
    expect(buildTeamRulesBlock('')).toBeNull()
    expect(buildTeamRulesBlock('   \n  ')).toBeNull()
  })
})
