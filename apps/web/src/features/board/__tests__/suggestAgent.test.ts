// suggestAgent: who the New task dialog suggests for a sentence. Words match a
// name twice as strongly as a role; with no match it falls back to the agent last
// given a task, then the team lead, then the first member.

import { describe, expect, it } from 'vitest'

import { stem, suggestAgent, wordStems, type AgentCandidate } from '../suggestAgent'

const ADA: AgentCandidate = {
  id: 'ada',
  name: 'Ada',
  teamId: 't1',
  role: 'Drafts blog posts, launch notes and announcements.',
}
const CODER: AgentCandidate = {
  id: 'coder',
  name: 'Coder',
  teamId: 't1',
  role: 'Fixes failing tests and ships small patches.',
}
const SCOUT: AgentCandidate = { id: 'scout', name: 'Scout', teamId: 't2', role: null }

function suggest(
  text: string,
  opts: { recent?: string[]; leads?: string[]; candidates?: AgentCandidate[] } = {},
) {
  return suggestAgent({
    text,
    candidates: opts.candidates ?? [ADA, CODER, SCOUT],
    recentAgentIds: opts.recent ?? [],
    leadAgentIds: opts.leads ?? [],
  })
}

describe('stem', () => {
  it('reads the forms of a word as one', () => {
    for (const w of ['draft', 'drafts', 'drafting', 'drafted']) expect(stem(w)).toBe('draft')
    for (const w of ['write', 'writes', 'writer', 'writing']) expect(stem(w)).toBe('writ')
    for (const w of ['story', 'stories']) expect(stem(w)).toBe('stor')
    expect(stem('process')).toBe(stem('processes'))
  })

  it('keeps at least three letters', () => {
    expect(stem('bugs')).toBe('bug')
    expect(stem('uses')).toBe('use')
  })
})

describe('wordStems', () => {
  it('drops short words, filler words and punctuation', () => {
    expect([...wordStems('Please fix the failing tests, now!')]).toEqual(['fix', 'fail', 'test'])
  })
})

describe('suggestAgent', () => {
  it('suggests the agent whose role fits the sentence', () => {
    expect(suggest('Draft the launch announcement')).toEqual({ agentId: 'ada', reason: 'match' })
    expect(suggest('The login test is failing')).toEqual({ agentId: 'coder', reason: 'match' })
  })

  it('weighs a name above a role', () => {
    // "draft" fits Ada's role, but the sentence names Coder.
    expect(suggest('Coder, draft a fix')).toEqual({ agentId: 'coder', reason: 'match' })
  })

  it('matches an agent with no role by its name', () => {
    expect(suggest('Ask scout to look around')).toEqual({ agentId: 'scout', reason: 'match' })
  })

  it('breaks a tie by the fallback order', () => {
    const twin = { ...ADA, id: 'ada2', name: 'Bea' }
    expect(suggest('Draft it', { candidates: [ADA, twin], recent: ['ada2'] })).toEqual({
      agentId: 'ada2',
      reason: 'match',
    })
  })

  it('falls back to the agent last given a task, then the lead, then the first', () => {
    expect(suggest('Something vague', { recent: ['gone', 'scout'], leads: ['coder'] })).toEqual({
      agentId: 'scout',
      reason: 'last-used',
    })
    expect(suggest('Something vague', { leads: ['gone', 'coder'] })).toEqual({
      agentId: 'coder',
      reason: 'lead',
    })
    expect(suggest('')).toEqual({ agentId: 'ada', reason: 'first' })
  })

  it('suggests nobody when there is nobody', () => {
    expect(suggest('Draft it', { candidates: [] })).toBeNull()
  })
})
