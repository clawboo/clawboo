import { describe, it, expect } from 'vitest'
import { parseTeamOrAgentMention } from '../parseTeamOrAgentMention'

const teams = [
  { id: 't1', name: 'Marketing' },
  { id: 't2', name: 'Dev Team' },
  { id: 't3', name: 'SEO Team' },
]

const agents = [
  { id: 'a1', name: 'Code Reviewer Boo' },
  { id: 'a2', name: 'SEO' },
  { id: 'a3', name: 'Boo Zero' },
]

describe('parseTeamOrAgentMention', () => {
  it("returns 'none' when message has no @", () => {
    const r = parseTeamOrAgentMention('hello world', teams, agents)
    expect(r.kind).toBe('none')
    expect(r.cleanedMessage).toBe('hello world')
  })

  it('matches a team and strips the mention', () => {
    const r = parseTeamOrAgentMention('@Marketing please launch a campaign', teams, agents)
    expect(r.kind).toBe('team')
    expect(r.targetId).toBe('t1')
    expect(r.matchedName).toBe('Marketing')
    expect(r.cleanedMessage).toBe('please launch a campaign')
  })

  it('matches an agent when no team matches', () => {
    const r = parseTeamOrAgentMention('@Code Reviewer Boo please review', teams, agents)
    expect(r.kind).toBe('agent')
    expect(r.targetId).toBe('a1')
  })

  it('teams win on a tie (same name)', () => {
    const r = parseTeamOrAgentMention(
      '@SEO check rankings',
      [{ id: 'team-seo', name: 'SEO' }],
      [{ id: 'a2', name: 'SEO' }],
    )
    expect(r.kind).toBe('team')
    expect(r.targetId).toBe('team-seo')
  })

  it('matches multi-word team names', () => {
    const r = parseTeamOrAgentMention('@Dev Team write tests', teams, agents)
    expect(r.kind).toBe('team')
    expect(r.targetId).toBe('t2')
    expect(r.cleanedMessage).toBe('write tests')
  })

  it('longest-prefix match — "@SEO Team" beats "@SEO"', () => {
    const r = parseTeamOrAgentMention('@SEO Team check rankings', teams, agents)
    expect(r.kind).toBe('team')
    expect(r.targetId).toBe('t3')
  })

  it('handles comma terminator', () => {
    const r = parseTeamOrAgentMention('@Marketing, please do X', teams, agents)
    expect(r.kind).toBe('team')
    expect(r.cleanedMessage).toBe('please do X')
  })

  it('handles colon terminator', () => {
    const r = parseTeamOrAgentMention('@Marketing: do X', teams, agents)
    expect(r.kind).toBe('team')
    expect(r.cleanedMessage).toBe('do X')
  })

  it('handles message that is JUST the mention', () => {
    const r = parseTeamOrAgentMention('@Marketing', teams, agents)
    expect(r.kind).toBe('team')
    expect(r.cleanedMessage).toBe('')
  })

  it('is case-insensitive on the name', () => {
    const r = parseTeamOrAgentMention('@marketing brief', teams, agents)
    expect(r.kind).toBe('team')
    expect(r.matchedName).toBe('Marketing')
  })

  it("doesn't match a mention embedded in a longer word", () => {
    // "@MarketingTeamA" should not match "Marketing" (no terminator after).
    const r = parseTeamOrAgentMention('@MarketingTeamA brief', teams, agents)
    expect(r.kind).toBe('none')
  })

  it("returns 'none' when only agents provided + no agent matches", () => {
    const r = parseTeamOrAgentMention('@Nothing here', [], agents)
    expect(r.kind).toBe('none')
  })

  it('works with only teams (no agents arg)', () => {
    const r = parseTeamOrAgentMention('@Marketing brief', teams)
    expect(r.kind).toBe('team')
    expect(r.targetId).toBe('t1')
  })

  it('works with only agents', () => {
    const r = parseTeamOrAgentMention('@Boo Zero hello', [], agents)
    expect(r.kind).toBe('agent')
    expect(r.targetId).toBe('a3')
  })
})
