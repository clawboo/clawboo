import { describe, it, expect, beforeEach } from 'vitest'
import {
  agentIdFromSessionKey,
  buildTeamSessionKey,
  setTeamChatOverride,
  clearTeamChatOverride,
  getTeamChatOverride,
  hasTeamChatOverride,
  promoteOverrideToRun,
  clearAllTeamChatOverridesForAgent,
  resetTeamChatOverrides,
} from '../sessionUtils'

describe('agentIdFromSessionKey', () => {
  it('extracts agentId from standard sessionKey format', () => {
    expect(agentIdFromSessionKey('agent:abc-123:main')).toBe('abc-123')
  })

  it('handles complex agent IDs', () => {
    expect(agentIdFromSessionKey('agent:my-agent-id:session-456')).toBe('my-agent-id')
  })

  it('returns null for invalid format', () => {
    expect(agentIdFromSessionKey('invalid-key')).toBeNull()
  })

  it('returns null for empty string', () => {
    expect(agentIdFromSessionKey('')).toBeNull()
  })

  it('returns null for partial format without trailing colon', () => {
    expect(agentIdFromSessionKey('agent:abc')).toBeNull()
  })
})

describe('buildTeamSessionKey', () => {
  it('builds team-scoped sessionKey', () => {
    expect(buildTeamSessionKey('a1', 'team-1')).toBe('agent:a1:team:team-1')
  })

  it('round-trips with agentIdFromSessionKey', () => {
    const teamKey = buildTeamSessionKey('my-agent', 'my-team')
    expect(agentIdFromSessionKey(teamKey)).toBe('my-agent')
  })

  it('handles UUID-style IDs', () => {
    expect(buildTeamSessionKey('abc-123-def', 'team-uuid-456')).toBe(
      'agent:abc-123-def:team:team-uuid-456',
    )
  })
})

describe('hasTeamChatOverride', () => {
  beforeEach(() => {
    resetTeamChatOverrides()
  })

  it('returns false when no override is set', () => {
    expect(hasTeamChatOverride('a1')).toBe(false)
  })

  it('returns true when pending override is set', () => {
    setTeamChatOverride('a1', 'agent:a1:team:team-1')
    expect(hasTeamChatOverride('a1')).toBe(true)
  })

  it('returns true when run-scoped override is set (after promotion)', () => {
    setTeamChatOverride('a1', 'agent:a1:team:team-1')
    promoteOverrideToRun('a1', 'run-1')
    expect(hasTeamChatOverride('a1')).toBe(true)
  })

  it('returns false after pending override is cleared with no runId', () => {
    setTeamChatOverride('a1', 'agent:a1:team:team-1')
    clearTeamChatOverride('a1')
    expect(hasTeamChatOverride('a1')).toBe(false)
  })

  it('returns false after run-scoped override is cleared', () => {
    setTeamChatOverride('a1', 'agent:a1:team:team-1')
    promoteOverrideToRun('a1', 'run-1')
    clearTeamChatOverride('a1', 'run-1')
    expect(hasTeamChatOverride('a1')).toBe(false)
  })

  it('returns false after resetTeamChatOverrides', () => {
    setTeamChatOverride('a1', 'agent:a1:team:team-1')
    setTeamChatOverride('a2', 'agent:a2:team:team-1')
    promoteOverrideToRun('a2', 'run-x')
    resetTeamChatOverrides()
    expect(hasTeamChatOverride('a1')).toBe(false)
    expect(hasTeamChatOverride('a2')).toBe(false)
  })
})

describe('getTeamChatOverride', () => {
  beforeEach(() => {
    resetTeamChatOverrides()
  })

  it('returns undefined when nothing is set', () => {
    expect(getTeamChatOverride('a1')).toBeUndefined()
    expect(getTeamChatOverride('a1', 'run-1')).toBeUndefined()
  })

  it('returns pending override when no runId is provided', () => {
    setTeamChatOverride('a1', 'agent:a1:team:t1')
    expect(getTeamChatOverride('a1')).toBe('agent:a1:team:t1')
  })

  it('returns pending override even when runId is provided (no scoped entry yet)', () => {
    setTeamChatOverride('a1', 'agent:a1:team:t1')
    // No promotion yet — fall through to pending
    expect(getTeamChatOverride('a1', 'run-1')).toBe('agent:a1:team:t1')
  })

  it('returns run-scoped override when runId matches after promotion', () => {
    setTeamChatOverride('a1', 'agent:a1:team:t1')
    promoteOverrideToRun('a1', 'run-1')
    expect(getTeamChatOverride('a1', 'run-1')).toBe('agent:a1:team:t1')
  })

  it('returns the most recent pending for a different runId after first promotion', () => {
    // Team A sends: set pending → promote to run-A
    setTeamChatOverride('a1', 'agent:a1:team:A')
    promoteOverrideToRun('a1', 'run-A')

    // Team B sends: set pending again (different sessionKey, no runId yet)
    setTeamChatOverride('a1', 'agent:a1:team:B')

    // Events for run-A still resolve to team A (run-scoped wins)
    expect(getTeamChatOverride('a1', 'run-A')).toBe('agent:a1:team:A')

    // Events for run-B (not yet promoted) fall back to pending → team B
    expect(getTeamChatOverride('a1', 'run-B')).toBe('agent:a1:team:B')

    // Pending lookup (no runId) → team B (most recent set)
    expect(getTeamChatOverride('a1')).toBe('agent:a1:team:B')
  })
})

describe('promoteOverrideToRun', () => {
  beforeEach(() => {
    resetTeamChatOverrides()
  })

  it('moves pending → run-scoped', () => {
    setTeamChatOverride('a1', 'agent:a1:team:t1')
    const promoted = promoteOverrideToRun('a1', 'run-1')
    expect(promoted).toBe('agent:a1:team:t1')
    // Pending is consumed after promotion
    expect(getTeamChatOverride('a1')).toBeUndefined()
    // Run-scoped is in place
    expect(getTeamChatOverride('a1', 'run-1')).toBe('agent:a1:team:t1')
  })

  it('is a no-op when the same run is promoted again', () => {
    setTeamChatOverride('a1', 'agent:a1:team:t1')
    expect(promoteOverrideToRun('a1', 'run-1')).toBe('agent:a1:team:t1')
    // Second call: pending is gone, but run-scoped persists → returns the scoped value.
    expect(promoteOverrideToRun('a1', 'run-1')).toBe('agent:a1:team:t1')
  })

  it('returns undefined when no pending exists', () => {
    expect(promoteOverrideToRun('a1', 'run-1')).toBeUndefined()
  })

  it('returns undefined when runId is empty', () => {
    setTeamChatOverride('a1', 'agent:a1:team:t1')
    expect(promoteOverrideToRun('a1', '')).toBeUndefined()
  })

  it('supports two distinct runs for the same agent (concurrency)', () => {
    // Team A: send + promote
    setTeamChatOverride('a1', 'agent:a1:team:A')
    promoteOverrideToRun('a1', 'run-A')

    // Team B: send + promote
    setTeamChatOverride('a1', 'agent:a1:team:B')
    promoteOverrideToRun('a1', 'run-B')

    expect(getTeamChatOverride('a1', 'run-A')).toBe('agent:a1:team:A')
    expect(getTeamChatOverride('a1', 'run-B')).toBe('agent:a1:team:B')
    expect(hasTeamChatOverride('a1')).toBe(true)

    // Run A finishes; run B should still be routed correctly.
    clearTeamChatOverride('a1', 'run-A')
    expect(getTeamChatOverride('a1', 'run-A')).toBeUndefined()
    expect(getTeamChatOverride('a1', 'run-B')).toBe('agent:a1:team:B')
    expect(hasTeamChatOverride('a1')).toBe(true)
  })
})

describe('clearAllTeamChatOverridesForAgent', () => {
  beforeEach(() => {
    resetTeamChatOverrides()
  })

  it('removes pending + every run-scoped entry for the agent', () => {
    setTeamChatOverride('a1', 'agent:a1:team:t1')
    promoteOverrideToRun('a1', 'r1')
    setTeamChatOverride('a1', 'agent:a1:team:t2')
    promoteOverrideToRun('a1', 'r2')
    // Add a pending again
    setTeamChatOverride('a1', 'agent:a1:team:t3')

    clearAllTeamChatOverridesForAgent('a1')

    expect(hasTeamChatOverride('a1')).toBe(false)
    expect(getTeamChatOverride('a1', 'r1')).toBeUndefined()
    expect(getTeamChatOverride('a1', 'r2')).toBeUndefined()
  })

  it('leaves other agents untouched', () => {
    setTeamChatOverride('a1', 'agent:a1:team:A')
    setTeamChatOverride('a2', 'agent:a2:team:B')
    clearAllTeamChatOverridesForAgent('a1')
    expect(hasTeamChatOverride('a1')).toBe(false)
    expect(hasTeamChatOverride('a2')).toBe(true)
  })
})

describe('concurrency scenario — Boo Zero in two teams', () => {
  beforeEach(() => {
    resetTeamChatOverrides()
  })

  it("routes events to the correct team's session even when overrides overlap", () => {
    const booZero = 'boo-zero'
    const teamA_sk = buildTeamSessionKey(booZero, 'team-A')
    const teamB_sk = buildTeamSessionKey(booZero, 'team-B')

    // Step 1: user sends to team A
    setTeamChatOverride(booZero, teamA_sk)
    // Step 2: first event arrives for run-A; promote
    promoteOverrideToRun(booZero, 'run-A')

    // Step 3: user switches to team B and sends (Boo Zero still mid-response on A)
    setTeamChatOverride(booZero, teamB_sk)
    // Tail event for run-A arrives now — should STILL route to team A (run-scoped)
    expect(getTeamChatOverride(booZero, 'run-A')).toBe(teamA_sk)

    // Step 4: first event for run-B arrives; promote
    promoteOverrideToRun(booZero, 'run-B')
    expect(getTeamChatOverride(booZero, 'run-B')).toBe(teamB_sk)

    // Step 5: run-A finishes; team A override gone, team B still active
    clearTeamChatOverride(booZero, 'run-A')
    expect(getTeamChatOverride(booZero, 'run-A')).toBeUndefined()
    expect(getTeamChatOverride(booZero, 'run-B')).toBe(teamB_sk)

    // Step 6: run-B finishes; all gone.
    clearTeamChatOverride(booZero, 'run-B')
    expect(hasTeamChatOverride(booZero)).toBe(false)
  })
})
