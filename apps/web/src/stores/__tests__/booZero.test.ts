import { describe, it, expect, beforeEach } from 'vitest'
import { useBooZeroStore, identifyBooZero, isBooZeroEligibleForTeam } from '../booZero'

// ── Tests ────────────────────────────────────────────────────────────────────

describe('identifyBooZero', () => {
  it('returns null for empty agent list', () => {
    expect(identifyBooZero([])).toBeNull()
  })

  it('returns defaultId when it exists in agents', () => {
    const agents = [
      { id: 'a1', teamId: 't1' },
      { id: 'a2', teamId: null },
    ]
    expect(identifyBooZero(agents, 'a1')).toBe('a1')
  })

  it('ignores defaultId when agent not in list', () => {
    const agents = [{ id: 'a1', teamId: null }]
    expect(identifyBooZero(agents, 'missing-id')).toBe('a1')
  })

  it('falls back to first agent with teamId === null', () => {
    const agents = [
      { id: 'a1', teamId: 't1' },
      { id: 'a2', teamId: null },
      { id: 'a3', teamId: null },
    ]
    expect(identifyBooZero(agents)).toBe('a2')
  })

  it('falls back to first agent overall when all have teamIds', () => {
    const agents = [
      { id: 'a1', teamId: 't1' },
      { id: 'a2', teamId: 't2' },
    ]
    expect(identifyBooZero(agents)).toBe('a1')
  })

  it('prefers defaultId over teamId===null fallback', () => {
    const agents = [
      { id: 'a1', teamId: null },
      { id: 'a2', teamId: 't1' },
    ]
    // a1 would win via teamless fallback, but a2 is the default
    expect(identifyBooZero(agents, 'a2')).toBe('a2')
  })
})

describe('isBooZeroEligibleForTeam', () => {
  it('returns false when Boo Zero is null/undefined', () => {
    expect(isBooZeroEligibleForTeam(null, 't1')).toBe(false)
    expect(isBooZeroEligibleForTeam(undefined, 't1')).toBe(false)
  })

  it('is eligible for every team when Boo Zero is teamless (the universal coordinator)', () => {
    const bz = { teamId: null }
    expect(isBooZeroEligibleForTeam(bz, 't1')).toBe(true)
    expect(isBooZeroEligibleForTeam(bz, 't2')).toBe(true)
  })

  it('is eligible for the team it already belongs to', () => {
    expect(isBooZeroEligibleForTeam({ teamId: 't1' }, 't1')).toBe(true)
  })

  it('is NOT eligible for a DIFFERENT team (the cross-team-leak bug)', () => {
    // A codex-preferred deploy / manual override can point Boo Zero at an agent
    // that belongs to team t2; it must never surface in team t1's scoped views.
    expect(isBooZeroEligibleForTeam({ teamId: 't2' }, 't1')).toBe(false)
  })
})

describe('useBooZeroStore', () => {
  beforeEach(() => {
    useBooZeroStore.setState({ booZeroAgentId: null })
  })

  it('starts with null booZeroAgentId', () => {
    expect(useBooZeroStore.getState().booZeroAgentId).toBeNull()
  })

  it('setBooZeroAgentId updates the value', () => {
    useBooZeroStore.getState().setBooZeroAgentId('a1')
    expect(useBooZeroStore.getState().booZeroAgentId).toBe('a1')
  })
})
