import { describe, it, expect, beforeEach } from 'vitest'
import {
  buildRelayMessage,
  condenseSummary,
  determineRelayTargets,
  shouldRelay,
  DEFAULT_RELAY_CONFIG,
  getOrCreateTeamRelayState,
  recordRelay,
  getRelayDepth,
  incrementRelayDepth,
  clearTeamRelayState,
  resetAllRelayState,
} from '../contextRelay'

// ─── buildRelayMessage ───────────────────────────────────────────────────────

describe('buildRelayMessage', () => {
  it('formats message with agent name and response', () => {
    const result = buildRelayMessage({
      fromAgentName: 'Code Reviewer Boo',
      responseText: 'Found 3 issues in auth module.',
      maxChars: 500,
    })
    expect(result).toContain('@Code Reviewer Boo')
    expect(result).toContain('Found 3 issues in auth module.')
    expect(result).toContain('---')
    // Self-documenting envelope: explicit "not a fresh user message" hint
    // so agents don't accidentally respond to it as a new user input.
    expect(result).toContain('not a fresh user message')
    expect(result).toContain('Continue your own work using this update as context')
  })

  it('truncates long responses to maxChars', () => {
    const longText = 'A'.repeat(600)
    const result = buildRelayMessage({
      fromAgentName: 'Agent',
      responseText: longText,
      maxChars: 100,
    })
    // The condensed portion lives between the two `---` separator lines
    // (header above, footer below). Its length should not exceed
    // maxChars + "..." (the truncation suffix).
    const lines = result.split('\n')
    const firstDash = lines.indexOf('---')
    const lastDash = lines.lastIndexOf('---')
    expect(firstDash).toBeGreaterThan(0)
    expect(lastDash).toBeGreaterThan(firstDash)
    const condensedBody = lines.slice(firstDash + 1, lastDash).join('\n')
    expect(condensedBody.length).toBeLessThanOrEqual(103) // 100 + "..."
  })

  it('includes task context when provided', () => {
    const result = buildRelayMessage({
      fromAgentName: 'Agent',
      responseText: 'Done with the analysis.',
      taskContext: 'investigate auth module',
      maxChars: 500,
    })
    expect(result).toContain('(re: "investigate auth module")')
  })

  it('truncates long task context to 80 chars', () => {
    const longContext = 'A'.repeat(120)
    const result = buildRelayMessage({
      fromAgentName: 'Agent',
      responseText: 'Done with the analysis.',
      taskContext: longContext,
      maxChars: 500,
    })
    expect(result).toContain('(re: "' + 'A'.repeat(80) + '...")')
  })

  it('includes "[Team Update]" prefix', () => {
    const result = buildRelayMessage({
      fromAgentName: 'Agent',
      responseText: 'Task completed successfully.',
      maxChars: 500,
    })
    expect(result.startsWith('[Team Update]')).toBe(true)
  })
})

// ─── determineRelayTargets ───────────────────────────────────────────────────

describe('determineRelayTargets', () => {
  const agents = [
    { id: 'a1', name: 'Leader' },
    { id: 'a2', name: 'Worker' },
    { id: 'a3', name: 'Reviewer' },
  ]

  it('returns delegationSourceId when present', () => {
    const result = determineRelayTargets({
      respondingAgentId: 'a2',
      teamAgents: agents,
      leaderAgentId: null,
      delegationSourceId: 'a1',
    })
    expect(result).toContain('a1')
  })

  it('returns leaderAgentId when present', () => {
    const result = determineRelayTargets({
      respondingAgentId: 'a2',
      teamAgents: agents,
      leaderAgentId: 'a1',
    })
    expect(result).toContain('a1')
  })

  it('returns mentioned agent IDs', () => {
    const result = determineRelayTargets({
      respondingAgentId: 'a1',
      teamAgents: agents,
      leaderAgentId: null,
      mentionedAgentIds: ['a2', 'a3'],
    })
    expect(result).toEqual(['a2', 'a3'])
  })

  it('excludes responding agent from targets', () => {
    const result = determineRelayTargets({
      respondingAgentId: 'a1',
      teamAgents: agents,
      leaderAgentId: 'a1',
      delegationSourceId: 'a1',
      mentionedAgentIds: ['a1', 'a2'],
    })
    expect(result).not.toContain('a1')
    expect(result).toEqual(['a2'])
  })

  it('deduplicates targets', () => {
    const result = determineRelayTargets({
      respondingAgentId: 'a3',
      teamAgents: agents,
      leaderAgentId: 'a1',
      delegationSourceId: 'a1',
      mentionedAgentIds: ['a1', 'a2'],
    })
    // a1 appears as leader, delegation source, and mentioned — should appear once
    expect(result.filter((id) => id === 'a1')).toHaveLength(1)
  })

  it('returns empty array when responding agent is the only candidate', () => {
    const result = determineRelayTargets({
      respondingAgentId: 'a1',
      teamAgents: agents,
      leaderAgentId: 'a1',
      delegationSourceId: 'a1',
    })
    expect(result).toEqual([])
  })

  it('returns sorted array', () => {
    const result = determineRelayTargets({
      respondingAgentId: 'a1',
      teamAgents: agents,
      leaderAgentId: null,
      mentionedAgentIds: ['a3', 'a2'],
    })
    expect(result).toEqual(['a2', 'a3'])
  })
})

// ─── shouldRelay ─────────────────────────────────────────────────────────────

describe('shouldRelay', () => {
  it('returns true for normal response', () => {
    const result = shouldRelay({
      responseText: 'I completed the code review and found several issues.',
      config: DEFAULT_RELAY_CONFIG,
      relayDepth: 0,
    })
    expect(result).toBe(true)
  })

  it('returns false when disabled', () => {
    const result = shouldRelay({
      responseText: 'I completed the code review and found several issues.',
      config: { ...DEFAULT_RELAY_CONFIG, enabled: false },
      relayDepth: 0,
    })
    expect(result).toBe(false)
  })

  it('returns false for relay messages ([Team Update] prefix)', () => {
    const result = shouldRelay({
      responseText: '[Team Update] @Agent completed their work:\n---\nDone\n---',
      config: DEFAULT_RELAY_CONFIG,
      relayDepth: 0,
    })
    expect(result).toBe(false)
  })

  it('returns false when at max depth', () => {
    const result = shouldRelay({
      responseText: 'I completed the code review and found several issues.',
      config: DEFAULT_RELAY_CONFIG,
      relayDepth: 3,
    })
    expect(result).toBe(false)
  })

  it('returns false within cooldown period', () => {
    const now = 50_000
    const result = shouldRelay({
      responseText: 'I completed the code review and found several issues.',
      config: DEFAULT_RELAY_CONFIG,
      relayDepth: 0,
      lastRelayAt: 45_000, // 5s ago, within 10s cooldown
      now,
    })
    expect(result).toBe(false)
  })

  it('returns true after cooldown expires', () => {
    const now = 60_000
    const result = shouldRelay({
      responseText: 'I completed the code review and found several issues.',
      config: DEFAULT_RELAY_CONFIG,
      relayDepth: 0,
      lastRelayAt: 45_000, // 15s ago, past 10s cooldown
      now,
    })
    expect(result).toBe(true)
  })

  it('returns false for very short responses (<20 chars)', () => {
    const result = shouldRelay({
      responseText: 'OK, done.',
      config: DEFAULT_RELAY_CONFIG,
      relayDepth: 0,
    })
    expect(result).toBe(false)
  })
})

// ─── condenseSummary ─────────────────────────────────────────────────────────

describe('condenseSummary', () => {
  it('returns text unchanged when within limit', () => {
    const text = 'Short response.'
    expect(condenseSummary(text, 500)).toBe(text)
  })

  it('truncates at sentence boundary', () => {
    const text = 'First sentence. Second sentence that pushes past the limit.'
    const result = condenseSummary(text, 20)
    expect(result).toBe('First sentence...')
  })

  it('truncates at word boundary when no sentence boundary', () => {
    const text = 'one two three four five six seven eight nine ten'
    const result = condenseSummary(text, 15)
    expect(result).toBe('one two three...')
  })

  it('appends "..." to truncated text', () => {
    const text = 'A'.repeat(200)
    const result = condenseSummary(text, 100)
    expect(result.endsWith('...')).toBe(true)
  })
})

// ─── Relay state ─────────────────────────────────────────────────────────────

describe('relay state', () => {
  beforeEach(() => {
    resetAllRelayState()
  })

  it('tracks last relay timestamp per agent', () => {
    recordRelay('team-1', 'a1', 1000)
    recordRelay('team-1', 'a2', 2000)
    const state = getOrCreateTeamRelayState('team-1')
    expect(state.lastRelayAt.get('a1')).toBe(1000)
    expect(state.lastRelayAt.get('a2')).toBe(2000)
  })

  it('tracks chain depth', () => {
    expect(getRelayDepth('team-1', 'chain-abc')).toBe(0)
    incrementRelayDepth('team-1', 'chain-abc')
    expect(getRelayDepth('team-1', 'chain-abc')).toBe(1)
    incrementRelayDepth('team-1', 'chain-abc')
    expect(getRelayDepth('team-1', 'chain-abc')).toBe(2)
  })

  it('clearTeamRelayState clears team state', () => {
    recordRelay('team-1', 'a1', 1000)
    incrementRelayDepth('team-1', 'chain-1')
    clearTeamRelayState('team-1')
    expect(getRelayDepth('team-1', 'chain-1')).toBe(0)
    const state = getOrCreateTeamRelayState('team-1')
    expect(state.lastRelayAt.size).toBe(0)
  })

  it('getOrCreateTeamRelayState creates fresh state', () => {
    const state = getOrCreateTeamRelayState('new-team')
    expect(state.lastRelayAt.size).toBe(0)
    expect(state.chainDepth.size).toBe(0)
  })

  it('resetAllRelayState clears everything', () => {
    recordRelay('team-1', 'a1', 1000)
    recordRelay('team-2', 'a2', 2000)
    resetAllRelayState()
    expect(getRelayDepth('team-1', 'chain-1')).toBe(0)
    expect(getRelayDepth('team-2', 'chain-2')).toBe(0)
    const state1 = getOrCreateTeamRelayState('team-1')
    expect(state1.lastRelayAt.size).toBe(0)
  })
})
