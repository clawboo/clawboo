import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { sendGroupChatMessage, resetWakeState } from '../groupChatSendOperation'
import type { AgentState } from '@/stores/fleet'

// ── Mocks ────────────────────────────────────────────────────────────────────

const { mockSendChatMessage } = vi.hoisted(() => ({
  mockSendChatMessage: vi.fn(),
}))

vi.mock('@/features/chat/chatSendOperation', () => ({
  sendChatMessage: mockSendChatMessage,
}))

const { mockAppendTranscript } = vi.hoisted(() => ({
  mockAppendTranscript: vi.fn(),
}))

vi.mock('@/stores/chat', () => ({
  useChatStore: {
    getState: () => ({
      appendTranscript: mockAppendTranscript,
      transcripts: new Map(),
    }),
  },
}))

// Mock wakeTracker — let us control wake state per test
const { mockFindSleeping, mockMarkAwake, mockClearAll } = vi.hoisted(() => ({
  mockFindSleeping: vi.fn(),
  mockMarkAwake: vi.fn(),
  mockClearAll: vi.fn(),
}))

vi.mock('@/lib/wakeTracker', () => ({
  findSleepingAgents: mockFindSleeping,
  markAgentAwake: mockMarkAwake,
  clearAllWakeRecords: mockClearAll,
}))

// ── Helpers ──────────────────────────────────────────────────────────────────

function makeAgent(overrides: Partial<AgentState> & { id: string; name: string }): AgentState {
  return {
    status: 'idle',
    sessionKey: `agent:${overrides.id}:main`,
    model: null,
    createdAt: null,
    streamingText: null,
    runId: null,
    lastSeenAt: null,
    teamId: 'team-1',
    execConfig: null,
    ...overrides,
  }
}

const leader = makeAgent({ id: 'a1', name: 'Leader Boo' })
const worker = makeAgent({ id: 'a2', name: 'Worker Boo' })
const coder = makeAgent({ id: 'a3', name: 'Coder Boo' })
const silent = makeAgent({ id: 'a4', name: 'Silent Boo', sessionKey: null })

const mockClient = { call: vi.fn() }

// ── Tests ────────────────────────────────────────────────────────────────────

describe('sendGroupChatMessage', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.clearAllMocks()
    resetWakeState()
    mockSendChatMessage.mockResolvedValue(undefined)
    mockClient.call.mockResolvedValue(undefined)
    // Default: all agents are sleeping (need waking)
    mockFindSleeping.mockImplementation((ids: string[]) => ids)
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  // Helper: advance through the wakeup settle delay
  async function flushWakeupDelay() {
    await vi.advanceTimersByTimeAsync(5000)
  }

  // ── Routing tests (use team-scoped sessionKeys: agent:<id>:team:<teamId>) ──

  it('sends to leader agent when no @mention using team sessionKey', async () => {
    const p = sendGroupChatMessage({
      client: mockClient,
      teamId: 'team-1',
      teamName: 'Test Team',
      leaderAgentId: 'a1',
      teamAgents: [leader, worker],
      message: 'hello team',
    })
    await flushWakeupDelay()
    await p

    expect(mockSendChatMessage).toHaveBeenCalledWith({
      client: mockClient,
      agentId: 'a1',
      sessionKey: 'agent:a1:team:team-1',
      message: 'hello team',
      displayText: undefined,
    })
  })

  it('sends to @mentioned agent with cleaned message', async () => {
    const p = sendGroupChatMessage({
      client: mockClient,
      teamId: 'team-1',
      teamName: 'Test Team',
      leaderAgentId: 'a1',
      teamAgents: [leader, worker],
      message: '@Worker Boo do the thing',
    })
    await flushWakeupDelay()
    await p

    expect(mockSendChatMessage).toHaveBeenCalledWith({
      client: mockClient,
      agentId: 'a2',
      sessionKey: 'agent:a2:team:team-1',
      message: 'do the thing',
      displayText: undefined,
    })
  })

  it('passes displayText through to sendChatMessage', async () => {
    const p = sendGroupChatMessage({
      client: mockClient,
      teamId: 'team-1',
      teamName: 'Test Team',
      leaderAgentId: 'a1',
      teamAgents: [leader, worker],
      message: '@Worker Boo do the thing',
      displayText: '@Worker Boo do the thing',
    })
    await flushWakeupDelay()
    await p

    expect(mockSendChatMessage).toHaveBeenCalledWith({
      client: mockClient,
      agentId: 'a2',
      sessionKey: 'agent:a2:team:team-1',
      message: 'do the thing',
      displayText: '@Worker Boo do the thing',
    })
  })

  it('falls back to first agent when leader is null and no mention', async () => {
    const p = sendGroupChatMessage({
      client: mockClient,
      teamId: 'team-1',
      teamName: 'Test Team',
      leaderAgentId: null,
      teamAgents: [leader, worker],
      message: 'general question',
    })
    await flushWakeupDelay()
    await p

    expect(mockSendChatMessage).toHaveBeenCalledWith({
      client: mockClient,
      agentId: 'a1',
      sessionKey: 'agent:a1:team:team-1',
      message: 'general question',
      displayText: undefined,
    })
  })

  it('no-ops when team has no agents', async () => {
    await sendGroupChatMessage({
      client: mockClient,
      teamId: 'team-1',
      teamName: 'Test Team',
      leaderAgentId: null,
      teamAgents: [],
      message: 'hello',
    })

    expect(mockSendChatMessage).not.toHaveBeenCalled()
  })

  it('no-ops when resolved target agent is not in team', async () => {
    // leaderAgentId points to agent not in teamAgents, and no @mention, no fallback
    await sendGroupChatMessage({
      client: mockClient,
      teamId: 'team-1',
      teamName: 'Test Team',
      leaderAgentId: 'nonexistent',
      teamAgents: [], // empty team — no fallback
      message: 'hello',
    })

    expect(mockSendChatMessage).not.toHaveBeenCalled()
  })

  // ── Auto-wake tests ────────────────────────────────────────────────────────

  it('wakes sleeping team agents on first group chat message', async () => {
    // findSleepingAgents returns a2, a3 as needing wake
    mockFindSleeping.mockReturnValue(['a2', 'a3'])

    const p = sendGroupChatMessage({
      client: mockClient,
      teamId: 'team-1',
      teamName: 'Test Team',
      leaderAgentId: 'a1',
      teamAgents: [leader, worker, coder],
      message: 'build the app',
    })
    await flushWakeupDelay()
    await p

    // Should have called chat.send for the sleeping agents with team sessionKeys
    const wakeCalls = mockClient.call.mock.calls.filter(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (args: any[]) => args[0] === 'chat.send',
    )
    expect(wakeCalls).toHaveLength(2)
    expect(wakeCalls[0][1].sessionKey).toBe('agent:a2:team:team-1')
    expect(wakeCalls[1][1].sessionKey).toBe('agent:a3:team:team-1')
  })

  it('does not wake agents already awake in localStorage', async () => {
    // All non-target agents are already awake
    mockFindSleeping.mockReturnValue([])

    const p = sendGroupChatMessage({
      client: mockClient,
      teamId: 'team-1',
      teamName: 'Test Team',
      leaderAgentId: 'a1',
      teamAgents: [leader, worker, coder],
      message: 'build the app',
    })
    // No delay needed — should be instant
    await p

    // No wakeup calls at all
    const wakeCalls = mockClient.call.mock.calls.filter(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (args: any[]) => args[0] === 'chat.send',
    )
    expect(wakeCalls).toHaveLength(0)

    // No meta notification either
    expect(mockAppendTranscript).not.toHaveBeenCalled()
  })

  it('skips settle delay when no agents need waking', async () => {
    mockFindSleeping.mockReturnValue([])

    const start = Date.now()
    await sendGroupChatMessage({
      client: mockClient,
      teamId: 'team-1',
      teamName: 'Test Team',
      leaderAgentId: 'a1',
      teamAgents: [leader, worker],
      message: 'instant message',
    })
    const elapsed = Date.now() - start

    // Should complete without the 5s delay
    expect(elapsed).toBeLessThan(1000)
    expect(mockSendChatMessage).toHaveBeenCalledTimes(1)
  })

  it('wakes only new agents added to team', async () => {
    // Only a3 is sleeping (a2 is already awake)
    mockFindSleeping.mockReturnValue(['a3'])

    const p = sendGroupChatMessage({
      client: mockClient,
      teamId: 'team-1',
      teamName: 'Test Team',
      leaderAgentId: 'a1',
      teamAgents: [leader, worker, coder],
      message: 'hello',
    })
    await flushWakeupDelay()
    await p

    const wakeCalls = mockClient.call.mock.calls.filter(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (args: any[]) => args[0] === 'chat.send',
    )
    expect(wakeCalls).toHaveLength(1)
    expect(wakeCalls[0][1].sessionKey).toBe('agent:a3:team:team-1')
  })

  it('marks agents as awake after successful wakeup', async () => {
    mockFindSleeping.mockReturnValue(['a2'])

    const p = sendGroupChatMessage({
      client: mockClient,
      teamId: 'team-1',
      teamName: 'Test Team',
      leaderAgentId: 'a1',
      teamAgents: [leader, worker],
      message: 'hello',
    })
    await flushWakeupDelay()
    await p

    // markAgentAwake should have been called for the woken agent
    expect(mockMarkAwake).toHaveBeenCalledWith('a2', 'team-1')
  })

  it('skips target agent in wakeup', async () => {
    // All non-target agents need waking
    mockFindSleeping.mockReturnValue(['a2', 'a3'])

    const p = sendGroupChatMessage({
      client: mockClient,
      teamId: 'team-1',
      teamName: 'Test Team',
      leaderAgentId: 'a1',
      teamAgents: [leader, worker, coder],
      message: 'build the app',
    })
    await flushWakeupDelay()
    await p

    // a1 is the target (leader) — should NOT be in wakeup calls
    const wakeCalls = mockClient.call.mock.calls.filter(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (args: any[]) => args[0] === 'chat.send',
    )
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const wakedSessionKeys = wakeCalls.map((args: any[]) => args[1].sessionKey)
    expect(wakedSessionKeys).not.toContain('agent:a1:team:team-1')
    expect(wakedSessionKeys).toContain('agent:a2:team:team-1')
    expect(wakedSessionKeys).toContain('agent:a3:team:team-1')
  })

  it('handles wakeup failures gracefully', async () => {
    mockFindSleeping.mockReturnValue(['a2', 'a3'])
    // First chat.send call rejects, second succeeds
    mockClient.call.mockRejectedValueOnce(new Error('connection lost')).mockResolvedValue(undefined)

    const p = sendGroupChatMessage({
      client: mockClient,
      teamId: 'team-1',
      teamName: 'Test Team',
      leaderAgentId: 'a1',
      teamAgents: [leader, worker, coder],
      message: 'build the app',
    })
    await flushWakeupDelay()
    await p

    // Actual message should still be sent despite wakeup failure
    expect(mockSendChatMessage).toHaveBeenCalledTimes(1)
  })

  it('adds meta notification before wakeup using team sessionKey', async () => {
    mockFindSleeping.mockReturnValue(['a2'])

    const p = sendGroupChatMessage({
      client: mockClient,
      teamId: 'team-1',
      teamName: 'Test Team',
      leaderAgentId: 'a1',
      teamAgents: [leader, worker],
      message: 'hello',
    })
    await flushWakeupDelay()
    await p

    expect(mockAppendTranscript).toHaveBeenCalledWith(
      'agent:a1:team:team-1',
      expect.arrayContaining([
        expect.objectContaining({
          kind: 'meta',
          role: 'system',
          text: 'Initializing team agents for collaboration...',
        }),
      ]),
    )
  })

  it('wakes agents even without fleet sessionKey (uses team sessionKey)', async () => {
    // silent agent has sessionKey=null in fleet store, but team sessionKey is computed
    mockFindSleeping.mockReturnValue(['a2', 'a4'])

    const p = sendGroupChatMessage({
      client: mockClient,
      teamId: 'team-1',
      teamName: 'Test Team',
      leaderAgentId: 'a1',
      teamAgents: [leader, worker, silent],
      message: 'hello',
    })
    await flushWakeupDelay()
    await p

    // Both worker (a2) AND silent (a4) should be woken — team keys don't depend on fleet sessionKey
    const wakeCalls = mockClient.call.mock.calls.filter(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (args: any[]) => args[0] === 'chat.send',
    )
    expect(wakeCalls).toHaveLength(2)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const wakedKeys = wakeCalls.map((args: any[]) => args[1].sessionKey)
    expect(wakedKeys).toContain('agent:a2:team:team-1')
    expect(wakedKeys).toContain('agent:a4:team:team-1')
  })

  it('wakes independently for different teams', async () => {
    // First team: a2 needs waking
    mockFindSleeping.mockReturnValueOnce(['a2'])

    const p1 = sendGroupChatMessage({
      client: mockClient,
      teamId: 'team-1',
      teamName: 'Test Team',
      leaderAgentId: 'a1',
      teamAgents: [leader, worker],
      message: 'team-1 msg',
    })
    await flushWakeupDelay()
    await p1

    mockClient.call.mockClear()

    // Second team: a2 needs waking again (different team)
    mockFindSleeping.mockReturnValueOnce(['a2'])

    const p2 = sendGroupChatMessage({
      client: mockClient,
      teamId: 'team-2',
      teamName: 'Test Team',
      leaderAgentId: 'a1',
      teamAgents: [leader, worker],
      message: 'team-2 msg',
    })
    await flushWakeupDelay()
    await p2

    // Second team should trigger its own wakeup
    const wakeCalls = mockClient.call.mock.calls.filter(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (args: any[]) => args[0] === 'chat.send',
    )
    expect(wakeCalls).toHaveLength(1) // worker woken for team-2
    expect(wakeCalls[0][1].sessionKey).toBe('agent:a2:team:team-2')
  })
})
