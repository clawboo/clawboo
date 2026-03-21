import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import {
  isAgentAwake,
  markAgentAwake,
  findSleepingAgents,
  clearAllWakeRecords,
  clearTeamWakeRecords,
  _resetForTest,
} from '../wakeTracker'

// Stub localStorage for Node test environment
const storageMap = new Map<string, string>()
const mockStorage = {
  getItem: (key: string) => storageMap.get(key) ?? null,
  setItem: (key: string, value: string) => storageMap.set(key, value),
  removeItem: (key: string) => storageMap.delete(key),
  clear: () => storageMap.clear(),
  get length() {
    return storageMap.size
  },
  key: (index: number) => [...storageMap.keys()][index] ?? null,
} as Storage

vi.stubGlobal('localStorage', mockStorage)

describe('wakeTracker', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    // Set a known time: 2026-03-20 10:00:00 (well after 4 AM)
    vi.setSystemTime(new Date('2026-03-20T10:00:00'))
    storageMap.clear()
    _resetForTest()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('returns false for unknown agent', () => {
    expect(isAgentAwake('unknown', 'team-1')).toBe(false)
  })

  it('returns true after marking agent awake', () => {
    markAgentAwake('a1', 'team-1')
    expect(isAgentAwake('a1', 'team-1')).toBe(true)
  })

  it('returns false after 4 AM boundary crossing', () => {
    // Mark awake at 10 AM on March 20
    markAgentAwake('a1', 'team-1')
    expect(isAgentAwake('a1', 'team-1')).toBe(true)

    // Advance to 5 AM on March 21 (past the 4 AM reset)
    vi.setSystemTime(new Date('2026-03-21T05:00:00'))
    expect(isAgentAwake('a1', 'team-1')).toBe(false)
  })

  it('returns true within same 4 AM window', () => {
    // Mark awake at 10 AM
    markAgentAwake('a1', 'team-1')

    // Still 11 PM same day — within same 4 AM window
    vi.setSystemTime(new Date('2026-03-20T23:00:00'))
    expect(isAgentAwake('a1', 'team-1')).toBe(true)

    // 3:59 AM next day — still before next 4 AM boundary
    vi.setSystemTime(new Date('2026-03-21T03:59:00'))
    expect(isAgentAwake('a1', 'team-1')).toBe(true)
  })

  it('returns false for wakeup before 4 AM when checking after 4 AM', () => {
    // Wake at 3 AM
    vi.setSystemTime(new Date('2026-03-20T03:00:00'))
    markAgentAwake('a1', 'team-1')

    // Check at 5 AM same day — 4 AM boundary has passed
    vi.setSystemTime(new Date('2026-03-20T05:00:00'))
    expect(isAgentAwake('a1', 'team-1')).toBe(false)
  })

  it('findSleepingAgents returns only sleeping agents', () => {
    markAgentAwake('a1', 'team-1')
    markAgentAwake('a3', 'team-1')

    const sleeping = findSleepingAgents(['a1', 'a2', 'a3', 'a4'], 'team-1')
    expect(sleeping).toEqual(['a2', 'a4'])
  })

  it('findSleepingAgents returns empty when all awake', () => {
    markAgentAwake('a1', 'team-1')
    markAgentAwake('a2', 'team-1')

    const sleeping = findSleepingAgents(['a1', 'a2'], 'team-1')
    expect(sleeping).toEqual([])
  })

  it('clearAllWakeRecords resets everything', () => {
    markAgentAwake('a1', 'team-1')
    markAgentAwake('a2', 'team-2')
    clearAllWakeRecords()

    expect(isAgentAwake('a1', 'team-1')).toBe(false)
    expect(isAgentAwake('a2', 'team-2')).toBe(false)
  })

  it('clearTeamWakeRecords only clears the specified team', () => {
    markAgentAwake('a1', 'team-1')
    markAgentAwake('a2', 'team-2')
    clearTeamWakeRecords('team-1')

    expect(isAgentAwake('a1', 'team-1')).toBe(false)
    expect(isAgentAwake('a2', 'team-2')).toBe(true)
  })

  it('tracks different teams independently', () => {
    markAgentAwake('a1', 'team-1')

    expect(isAgentAwake('a1', 'team-1')).toBe(true)
    expect(isAgentAwake('a1', 'team-2')).toBe(false)
  })

  it('handles corrupt localStorage gracefully', () => {
    storageMap.set('clawboo:wake-records', 'not valid json{{{')
    expect(isAgentAwake('a1', 'team-1')).toBe(false)

    // Should still be able to write after corruption
    markAgentAwake('a1', 'team-1')
    expect(isAgentAwake('a1', 'team-1')).toBe(true)
  })

  it('handles missing localStorage gracefully', () => {
    storageMap.delete('clawboo:wake-records')
    expect(isAgentAwake('a1', 'team-1')).toBe(false)
  })
})
