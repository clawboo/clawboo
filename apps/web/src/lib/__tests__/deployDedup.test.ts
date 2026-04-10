import { describe, it, expect } from 'vitest'
import { computeDedupSuffix, rewriteAgentsMd, rewriteTemplateName } from '../deployDedup'

// ─── computeDedupSuffix ──────────────────────────────────────────────────────

describe('computeDedupSuffix', () => {
  it('returns suffix 0 when no collisions exist', () => {
    const plan = computeDedupSuffix(['Alpha Boo', 'Beta Boo'], ['Gamma Boo'], 'My Team', [
      'Other Team',
    ])
    expect(plan.suffix).toBe(0)
    expect(plan.teamName).toBe('My Team')
    expect(plan.agentNameMap.get('Alpha Boo')).toBe('Alpha Boo')
    expect(plan.agentNameMap.get('Beta Boo')).toBe('Beta Boo')
  })

  it('returns suffix 0 when fleet is empty', () => {
    const plan = computeDedupSuffix(['Agent Boo'], [], 'Team', [])
    expect(plan.suffix).toBe(0)
    expect(plan.teamName).toBe('Team')
    expect(plan.agentNameMap.get('Agent Boo')).toBe('Agent Boo')
  })

  it('suffixes all names when one agent name collides', () => {
    const plan = computeDedupSuffix(['Alpha Boo', 'Beta Boo'], ['Alpha Boo'], 'My Team', [])
    expect(plan.suffix).toBe(2)
    expect(plan.teamName).toBe('My Team 2')
    expect(plan.agentNameMap.get('Alpha Boo')).toBe('Alpha Boo 2')
    expect(plan.agentNameMap.get('Beta Boo')).toBe('Beta Boo 2')
  })

  it('suffixes all names when team name collides', () => {
    const plan = computeDedupSuffix(['Alpha Boo', 'Beta Boo'], [], 'My Team', ['My Team'])
    expect(plan.suffix).toBe(2)
    expect(plan.teamName).toBe('My Team 2')
    expect(plan.agentNameMap.get('Alpha Boo')).toBe('Alpha Boo 2')
    expect(plan.agentNameMap.get('Beta Boo')).toBe('Beta Boo 2')
  })

  it('suffixes all names when both agent and team names collide', () => {
    const plan = computeDedupSuffix(['Alpha Boo'], ['Alpha Boo'], 'My Team', ['My Team'])
    expect(plan.suffix).toBe(2)
    expect(plan.teamName).toBe('My Team 2')
    expect(plan.agentNameMap.get('Alpha Boo')).toBe('Alpha Boo 2')
  })

  it('increments to 3 when suffix 2 is already taken', () => {
    const plan = computeDedupSuffix(
      ['Alpha Boo', 'Beta Boo'],
      ['Alpha Boo', 'Alpha Boo 2'],
      'Team',
      [],
    )
    expect(plan.suffix).toBe(3)
    expect(plan.teamName).toBe('Team 3')
    expect(plan.agentNameMap.get('Alpha Boo')).toBe('Alpha Boo 3')
    expect(plan.agentNameMap.get('Beta Boo')).toBe('Beta Boo 3')
  })

  it('handles case-insensitive collision detection', () => {
    const plan = computeDedupSuffix(['Code Reviewer Boo'], ['code reviewer boo'], 'Dev Team', [])
    expect(plan.suffix).toBe(2)
    expect(plan.agentNameMap.get('Code Reviewer Boo')).toBe('Code Reviewer Boo 2')
  })

  it('works with a single-agent template', () => {
    const plan = computeDedupSuffix(['Solo Boo'], ['Solo Boo', 'Solo Boo 2'], 'Solo Team', [
      'Solo Team',
    ])
    expect(plan.suffix).toBe(3)
    expect(plan.teamName).toBe('Solo Team 3')
    expect(plan.agentNameMap.get('Solo Boo')).toBe('Solo Boo 3')
  })

  it('skips suffix numbers where team name collides', () => {
    const plan = computeDedupSuffix(['Agent Boo'], ['Agent Boo'], 'Team', ['Team', 'Team 2'])
    expect(plan.suffix).toBe(3)
    expect(plan.teamName).toBe('Team 3')
    expect(plan.agentNameMap.get('Agent Boo')).toBe('Agent Boo 3')
  })
})

// ─── rewriteAgentsMd ─────────────────────────────────────────────────────────

describe('rewriteAgentsMd', () => {
  it('returns content unchanged when no renames needed', () => {
    const map = new Map([['Alpha Boo', 'Alpha Boo']])
    expect(rewriteAgentsMd('Route to @Alpha Boo for tasks', map)).toBe(
      'Route to @Alpha Boo for tasks',
    )
  })

  it('returns undefined for undefined content', () => {
    const map = new Map([['Alpha Boo', 'Alpha Boo 2']])
    expect(rewriteAgentsMd(undefined, map)).toBeUndefined()
  })

  it('rewrites a single @mention', () => {
    const map = new Map([['Alpha Boo', 'Alpha Boo 2']])
    const result = rewriteAgentsMd('Route to @Alpha Boo for code review.', map)
    expect(result).toBe('Route to @Alpha Boo 2 for code review.')
  })

  it('rewrites multiple @mentions in one file', () => {
    const map = new Map([
      ['Alpha Boo', 'Alpha Boo 2'],
      ['Beta Boo', 'Beta Boo 2'],
    ])
    const content = ['Route code reviews to @Alpha Boo.', 'Route testing to @Beta Boo.'].join('\n')
    const result = rewriteAgentsMd(content, map)
    expect(result).toContain('@Alpha Boo 2.')
    expect(result).toContain('@Beta Boo 2.')
    expect(result).not.toContain('@Alpha Boo.')
    expect(result).not.toContain('@Beta Boo.')
  })

  it('uses longest-match-first to prevent partial replacement', () => {
    const map = new Map([
      ['Code Boo', 'Code Boo 2'],
      ['Code Reviewer Boo', 'Code Reviewer Boo 2'],
    ])
    const content = 'Route to @Code Reviewer Boo for reviews, @Code Boo for coding.'
    const result = rewriteAgentsMd(content, map)
    expect(result).toBe('Route to @Code Reviewer Boo 2 for reviews, @Code Boo 2 for coding.')
  })

  it('handles @mention at end of string', () => {
    const map = new Map([['Alpha Boo', 'Alpha Boo 2']])
    expect(rewriteAgentsMd('Route to @Alpha Boo', map)).toBe('Route to @Alpha Boo 2')
  })

  it('handles double-quoted @mentions', () => {
    const map = new Map([['Alpha Boo', 'Alpha Boo 2']])
    expect(rewriteAgentsMd('Route to @"Alpha Boo" for tasks', map)).toBe(
      'Route to @"Alpha Boo 2" for tasks',
    )
  })

  it('handles single-quoted @mentions', () => {
    const map = new Map([['Alpha Boo', 'Alpha Boo 2']])
    expect(rewriteAgentsMd("Route to @'Alpha Boo' for tasks", map)).toBe(
      "Route to @'Alpha Boo 2' for tasks",
    )
  })
})

// ─── rewriteTemplateName ─────────────────────────────────────────────────────

describe('rewriteTemplateName', () => {
  it('replaces agent name in identity content', () => {
    const result = rewriteTemplateName(
      'You are Alpha Boo, the code reviewer.',
      'Alpha Boo',
      'Alpha Boo 2',
    )
    expect(result).toBe('You are Alpha Boo 2, the code reviewer.')
  })

  it('returns content unchanged when names are the same', () => {
    expect(rewriteTemplateName('You are Alpha Boo.', 'Alpha Boo', 'Alpha Boo')).toBe(
      'You are Alpha Boo.',
    )
  })

  it('returns undefined for undefined content', () => {
    expect(rewriteTemplateName(undefined, 'Alpha Boo', 'Alpha Boo 2')).toBeUndefined()
  })

  it('replaces all occurrences of the name', () => {
    const result = rewriteTemplateName(
      '# Alpha Boo\nYou are Alpha Boo, a specialist.',
      'Alpha Boo',
      'Alpha Boo 3',
    )
    expect(result).toBe('# Alpha Boo 3\nYou are Alpha Boo 3, a specialist.')
  })
})
