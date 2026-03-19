import { describe, it, expect, vi, beforeEach } from 'vitest'
import { sendGroupChatMessage } from '../groupChatSendOperation'
import type { AgentState } from '@/stores/fleet'

// ── Mocks ────────────────────────────────────────────────────────────────────

const { mockSendChatMessage } = vi.hoisted(() => ({
  mockSendChatMessage: vi.fn(),
}))

vi.mock('@/features/chat/chatSendOperation', () => ({
  sendChatMessage: mockSendChatMessage,
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
const silent = makeAgent({ id: 'a3', name: 'Silent Boo', sessionKey: null })

const mockClient = { call: vi.fn() }

// ── Tests ────────────────────────────────────────────────────────────────────

describe('sendGroupChatMessage', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockSendChatMessage.mockResolvedValue(undefined)
  })

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
      leaderAgentId: 'a3',
      teamAgents: [silent],
      message: 'hello',
    })

    expect(mockSendChatMessage).not.toHaveBeenCalled()
  })
})
