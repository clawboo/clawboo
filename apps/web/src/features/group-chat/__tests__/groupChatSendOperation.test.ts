import { describe, it, expect, vi, beforeEach } from 'vitest'
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
    vi.clearAllMocks()
    resetWokenTeams()
    mockSendChatMessage.mockResolvedValue(undefined)
    mockClient.call.mockResolvedValue(undefined)
  })

  // ── Routing tests ──────────────────────────────────────────────────────────

  it('sends to leader agent when no @mention', async () => {
    await sendGroupChatMessage({
      client: mockClient,
      teamId: 'team-1',
      leaderAgentId: 'a1',
      teamAgents: [leader, worker],
      message: 'hello team',
    })

    expect(mockSendChatMessage).toHaveBeenCalledWith({
      client: mockClient,
      agentId: 'a1',
      sessionKey: 'agent:a1:main',
      message: 'hello team',
      displayText: undefined,
    })
  })

  it('sends to @mentioned agent with cleaned message', async () => {
    await sendGroupChatMessage({
      client: mockClient,
      teamId: 'team-1',
      leaderAgentId: 'a1',
      teamAgents: [leader, worker],
      message: '@Worker Boo do the thing',
    })

    expect(mockSendChatMessage).toHaveBeenCalledWith({
      client: mockClient,
      agentId: 'a2',
      sessionKey: 'agent:a2:main',
      message: 'do the thing',
      displayText: undefined,
    })
  })

  it('passes displayText through to sendChatMessage', async () => {
    await sendGroupChatMessage({
      client: mockClient,
      teamId: 'team-1',
      leaderAgentId: 'a1',
      teamAgents: [leader, worker],
      message: '@Worker Boo do the thing',
      displayText: '@Worker Boo do the thing',
    })

    expect(mockSendChatMessage).toHaveBeenCalledWith({
      client: mockClient,
      agentId: 'a2',
      sessionKey: 'agent:a2:main',
      message: 'do the thing',
      displayText: '@Worker Boo do the thing',
    })
  })

  it('falls back to first agent when leader is null and no mention', async () => {
    await sendGroupChatMessage({
      client: mockClient,
      teamId: 'team-1',
      leaderAgentId: null,
      teamAgents: [leader, worker],
      message: 'general question',
    })

    expect(mockSendChatMessage).toHaveBeenCalledWith({
      client: mockClient,
      agentId: 'a1',
      sessionKey: 'agent:a1:main',
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

  it('no-ops when target agent has no sessionKey', async () => {
    await sendGroupChatMessage({
      client: mockClient,
      teamId: 'team-1',
      leaderAgentId: 'a4',
      teamAgents: [silent],
      message: 'hello',
    })

    expect(mockSendChatMessage).not.toHaveBeenCalled()
  })

  // ── Auto-wake tests ────────────────────────────────────────────────────────

  it('wakes all team agents on first group chat message', async () => {
    await sendGroupChatMessage({
      client: mockClient,
      teamId: 'team-1',
      leaderAgentId: 'a1',
      teamAgents: [leader, worker, coder],
      message: 'build the app',
    })

    // Should have called chat.send for the non-target agents (a2, a3)
    const wakeCalls = mockClient.call.mock.calls.filter(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (args: any[]) => args[0] === 'chat.send',
    )
    expect(wakeCalls).toHaveLength(2)
    expect(wakeCalls[0][1].sessionKey).toBe('agent:a2:main')
    expect(wakeCalls[1][1].sessionKey).toBe('agent:a3:main')
  })

  it('does not wake agents on subsequent messages to the same team', async () => {
    await sendGroupChatMessage({
      client: mockClient,
      teamId: 'team-1',
      leaderAgentId: 'a1',
      teamAgents: [leader, worker],
      message: 'first message',
    })

    mockClient.call.mockClear()

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
    await sendGroupChatMessage({
      client: mockClient,
      teamId: 'team-1',
      leaderAgentId: 'a1',
      teamAgents: [leader, worker, coder],
      message: 'build the app',
    })

    // a1 is the target (leader) — should NOT be in wakeup calls
    const wakeCalls = mockClient.call.mock.calls.filter(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (args: any[]) => args[0] === 'chat.send',
    )
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const wakedSessionKeys = wakeCalls.map((args: any[]) => args[1].sessionKey)
    expect(wakedSessionKeys).not.toContain('agent:a1:main')
    expect(wakedSessionKeys).toContain('agent:a2:main')
    expect(wakedSessionKeys).toContain('agent:a3:main')
  })

  it('handles wakeup failures gracefully', async () => {
    // First chat.send call rejects, second succeeds
    mockClient.call.mockRejectedValueOnce(new Error('connection lost')).mockResolvedValue(undefined)

    await sendGroupChatMessage({
      client: mockClient,
      teamId: 'team-1',
      leaderAgentId: 'a1',
      teamAgents: [leader, worker, coder],
      message: 'build the app',
    })

    // Actual message should still be sent despite wakeup failure
    expect(mockSendChatMessage).toHaveBeenCalledTimes(1)
  })

  it('adds meta notification before wakeup', async () => {
    await sendGroupChatMessage({
      client: mockClient,
      teamId: 'team-1',
      leaderAgentId: 'a1',
      teamAgents: [leader, worker],
      message: 'hello',
    })

    expect(mockAppendTranscript).toHaveBeenCalledWith(
      'agent:a1:main',
      expect.arrayContaining([
        expect.objectContaining({
          kind: 'meta',
          role: 'system',
          text: 'Initializing team agents for collaboration...',
        }),
      ]),
    )
  })

  it('skips agents without sessionKey in wakeup', async () => {
    await sendGroupChatMessage({
      client: mockClient,
      teamId: 'team-1',
      leaderAgentId: 'a1',
      teamAgents: [leader, worker, silent],
      message: 'hello',
    })

    // Only worker (a2) should be woken — silent (a4) has no sessionKey
    const wakeCalls = mockClient.call.mock.calls.filter(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (args: any[]) => args[0] === 'chat.send',
    )
    expect(wakeCalls).toHaveLength(1)
    expect(wakeCalls[0][1].sessionKey).toBe('agent:a2:main')
  })

  it('wakes independently for different teams', async () => {
    await sendGroupChatMessage({
      client: mockClient,
      teamId: 'team-1',
      leaderAgentId: 'a1',
      teamAgents: [leader, worker],
      message: 'team-1 msg',
    })

    mockClient.call.mockClear()

    await sendGroupChatMessage({
      client: mockClient,
      teamId: 'team-2',
      leaderAgentId: 'a1',
      teamAgents: [leader, worker],
      message: 'team-2 msg',
    })

    // Second team should trigger its own wakeup
    const wakeCalls = mockClient.call.mock.calls.filter(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (args: any[]) => args[0] === 'chat.send',
    )
    expect(wakeCalls).toHaveLength(1) // worker woken for team-2
  })
})
