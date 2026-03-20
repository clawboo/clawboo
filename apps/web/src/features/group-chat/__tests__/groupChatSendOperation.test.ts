import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { sendGroupChatMessage, resetWokenTeams } from '../groupChatSendOperation'
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
    }),
  },
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
    resetWokenTeams()
    mockSendChatMessage.mockResolvedValue(undefined)
    mockClient.call.mockResolvedValue(undefined)
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
      leaderAgentId: 'nonexistent',
      teamAgents: [], // empty team — no fallback
      message: 'hello',
    })

    expect(mockSendChatMessage).not.toHaveBeenCalled()
  })

  // ── Auto-wake tests ────────────────────────────────────────────────────────

  it('wakes all team agents on first group chat message using team sessionKeys', async () => {
    const p = sendGroupChatMessage({
      client: mockClient,
      teamId: 'team-1',
      leaderAgentId: 'a1',
      teamAgents: [leader, worker, coder],
      message: 'build the app',
    })
    await flushWakeupDelay()
    await p

    // Should have called chat.send for the non-target agents (a2, a3) with team sessionKeys
    const wakeCalls = mockClient.call.mock.calls.filter(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (args: any[]) => args[0] === 'chat.send',
    )
    expect(wakeCalls).toHaveLength(2)
    expect(wakeCalls[0][1].sessionKey).toBe('agent:a2:team:team-1')
    expect(wakeCalls[1][1].sessionKey).toBe('agent:a3:team:team-1')
  })

  it('does not wake agents on subsequent messages to the same team', async () => {
    const p1 = sendGroupChatMessage({
      client: mockClient,
      teamId: 'team-1',
      leaderAgentId: 'a1',
      teamAgents: [leader, worker],
      message: 'first message',
    })
    await flushWakeupDelay()
    await p1

    mockClient.call.mockClear()

    // Second message — no wakeup, no delay
    await sendGroupChatMessage({
      client: mockClient,
      teamId: 'team-1',
      leaderAgentId: 'a1',
      teamAgents: [leader, worker],
      message: 'second message',
    })

    // No wakeup calls on second message
    const wakeCalls = mockClient.call.mock.calls.filter(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (args: any[]) => args[0] === 'chat.send',
    )
    expect(wakeCalls).toHaveLength(0)
  })

  it('skips target agent in wakeup', async () => {
    const p = sendGroupChatMessage({
      client: mockClient,
      teamId: 'team-1',
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
    // First chat.send call rejects, second succeeds
    mockClient.call.mockRejectedValueOnce(new Error('connection lost')).mockResolvedValue(undefined)

    const p = sendGroupChatMessage({
      client: mockClient,
      teamId: 'team-1',
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
    const p = sendGroupChatMessage({
      client: mockClient,
      teamId: 'team-1',
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
    const p = sendGroupChatMessage({
      client: mockClient,
      teamId: 'team-1',
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
    const p1 = sendGroupChatMessage({
      client: mockClient,
      teamId: 'team-1',
      leaderAgentId: 'a1',
      teamAgents: [leader, worker],
      message: 'team-1 msg',
    })
    await flushWakeupDelay()
    await p1

    mockClient.call.mockClear()

    const p2 = sendGroupChatMessage({
      client: mockClient,
      teamId: 'team-2',
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
