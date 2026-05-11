import { describe, it, expect } from 'vitest'
import {
  detectGenuineLeader,
  matchedLeadershipKeyword,
  LEADERSHIP_KEYWORDS,
} from '../genuineLeader'

describe('detectGenuineLeader', () => {
  describe('positive matches — name field', () => {
    it.each([
      ['CEO Boo', ''],
      ['CTO Boo', ''],
      ['CFO Boo', ''],
      ['COO Boo', ''],
      ['CMO Boo', ''],
      ['CIO Boo', ''],
      ['Chief Strategist Boo', ''],
      ['Founder Boo', ''],
      ['VP Engineering Boo', ''],
      ['President Boo', ''],
      ['Principal Boo', ''],
      ['Director Boo', ''],
      ['Head of Product Boo', ''],
      ['Team Lead Boo', ''],
      ['Tech Lead Boo', ''],
      ['Project Lead Boo', ''],
      ['Product Lead Boo', ''],
      ['Engineering Lead Boo', ''],
      ['Project Manager Boo', ''],
      ['Product Manager Boo', ''],
      ['Engineering Manager Boo', ''],
      ['Program Manager Boo', ''],
      ['General Manager Boo', ''],
      ['Operator Boo', ''],
      ['Orchestrator Boo', ''],
      ['Coordinator Boo', ''],
      ['Conductor Boo', ''],
    ])('detects %s', (name, role) => {
      expect(detectGenuineLeader({ name, role })).toBe(true)
    })
  })

  describe('positive matches — role field', () => {
    it.each([
      ['Generic Boo', 'CEO'],
      ['Sprint Boo', 'Project Manager'],
      ['Workflow Boo', 'Operator'],
      ['Anything Boo', 'Tech Lead'],
      ['Pip', 'Director of Engineering'],
    ])('detects role for %s / role=%s', (name, role) => {
      expect(detectGenuineLeader({ name, role })).toBe(true)
    })
  })

  describe('negative matches', () => {
    it.each([
      ['Senior Engineer Boo', 'Engineer'],
      ['Lead Engineer Boo', 'Engineer'],
      ['Lead Developer Boo', 'Developer'],
      ['Lead Designer Boo', 'Designer'],
      ['Lead Researcher Boo', 'Researcher'],
      ['Lead Reviewer Boo', 'Reviewer'],
      ['Staff Engineer Boo', ''],
      ['Principal Engineer Boo', 'Software'],
      ['Principal Developer Boo', ''],
      ['Code Reviewer Boo', 'Code Reviewer'],
      ['Bug Fixer Boo', 'Bug Fixer'],
      ['Doc Writer Boo', 'Doc Writer'],
      ['Marketing Boo', 'Marketer'],
      ['Research Boo', 'Researcher'],
      ['', ''],
    ])('rejects %s / role=%s', (name, role) => {
      expect(detectGenuineLeader({ name, role })).toBe(false)
    })
  })

  describe('edge cases', () => {
    it('matches case-insensitively', () => {
      expect(detectGenuineLeader({ name: 'cto boo', role: '' })).toBe(true)
      expect(detectGenuineLeader({ name: 'CTO BOO', role: '' })).toBe(true)
    })

    it('handles hyphenated multi-word keywords', () => {
      expect(detectGenuineLeader({ name: 'Project-Manager Boo', role: '' })).toBe(true)
      expect(detectGenuineLeader({ name: 'Team-Lead Boo', role: '' })).toBe(true)
    })

    it('does not match keywords inside other words', () => {
      // "Chief" alone is allowed, but "MisChief" should not match Chief.
      expect(detectGenuineLeader({ name: 'Mischief Boo', role: '' })).toBe(false)
      // "CTOgrapher" should not match CTO.
      expect(detectGenuineLeader({ name: 'CTOgrapher Boo', role: '' })).toBe(false)
    })

    it('returns true when ANY field matches', () => {
      expect(detectGenuineLeader({ name: 'Generic Boo', role: 'CTO' })).toBe(true)
      expect(detectGenuineLeader({ name: 'CTO Boo', role: 'Engineer' })).toBe(true)
    })

    it('returns false when BOTH fields are leadership-y but negated', () => {
      // "Senior Engineer" + "Staff Engineer" both negated.
      expect(detectGenuineLeader({ name: 'Senior Engineer', role: 'Staff Engineer' })).toBe(false)
    })
  })
})

describe('matchedLeadershipKeyword', () => {
  it('returns the canonical keyword that matched', () => {
    expect(matchedLeadershipKeyword({ name: 'CTO Boo', role: '' })).toBe('CTO')
    expect(matchedLeadershipKeyword({ name: 'Project Manager Boo', role: '' })).toBe(
      'Project Manager',
    )
    expect(matchedLeadershipKeyword({ name: 'Operator Boo', role: '' })).toBe('Operator')
  })

  it('returns null on no match', () => {
    expect(matchedLeadershipKeyword({ name: 'Code Reviewer', role: '' })).toBeNull()
  })

  it('returns null on negative match', () => {
    expect(matchedLeadershipKeyword({ name: 'Lead Engineer Boo', role: '' })).toBeNull()
    expect(matchedLeadershipKeyword({ name: 'Senior Engineer Boo', role: '' })).toBeNull()
  })

  it('canonicalises hyphenated input back to the keyword', () => {
    expect(matchedLeadershipKeyword({ name: 'Project-Manager Boo', role: '' })).toBe(
      'Project Manager',
    )
  })
})

describe('LEADERSHIP_KEYWORDS', () => {
  it('is non-empty and contains expected canonical entries', () => {
    expect(LEADERSHIP_KEYWORDS.length).toBeGreaterThan(20)
    expect(LEADERSHIP_KEYWORDS).toContain('CEO')
    expect(LEADERSHIP_KEYWORDS).toContain('Operator')
    expect(LEADERSHIP_KEYWORDS).toContain('Team Lead')
  })
})
