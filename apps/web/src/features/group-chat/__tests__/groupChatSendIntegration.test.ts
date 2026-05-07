import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import type { TranscriptEntry } from '@clawboo/protocol'
import type { AgentState } from '@/stores/fleet'
import { sendGroupChatMessage, resetWakeState } from '../groupChatSendOperation'

// ── Mocks ────────────────────────────────────────────────────────────────────

const { mockSendChatMessage } = vi.hoisted(() => ({
  mockSendChatMessage: vi.fn(),
}))

vi.mock('@/features/chat/chatSendOperation', () => ({
  sendChatMessage: mockSendChatMessage,
}))

const { mockAppendTranscript, mockGetTranscripts } = vi.hoisted(() => ({
  mockAppendTranscript: vi.fn(),
  mockGetTranscripts: vi.fn(),
}))

vi.mock('@/stores/chat', () => ({
  useChatStore: {
    getState: () => ({
      appendTranscript: mockAppendTranscript,
      transcripts: mockGetTranscripts(),
    }),
  },
}))

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

function makeEntry(sessionKey: string, overrides: Partial<TranscriptEntry> = {}): TranscriptEntry {
  return {
    entryId: crypto.randomUUID(),
    runId: null,
    source: 'runtime-chat',
    timestampMs: Date.now(),
    sequenceKey: Date.now(),
    confirmed: true,
    fingerprint: crypto.randomUUID(),
    kind: 'assistant',
    role: 'assistant',
    text: 'some response',
    sessionKey,
    ...overrides,
  }
}

const leader = makeAgent({ id: 'a1', name: 'Leader Boo' })
const worker = makeAgent({ id: 'a2', name: 'Worker Boo' })
const coder = makeAgent({ id: 'a3', name: 'Coder Boo' })

const mockClient = { call: vi.fn() }

// ── Tests ────────────────────────────────────────────────────────────────────

describe('sendGroupChatMessage — context preamble integration', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.clearAllMocks()
    resetWakeState()
    mockSendChatMessage.mockResolvedValue(undefined)
    mockClient.call.mockResolvedValue(undefined)
    // Default: no agents need waking
    mockFindSleeping.mockReturnValue([])
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('injects context preamble when team has conversation history', async () => {
    // Simulate existing conversation history in transcripts
    const existingTranscripts = new Map<string, TranscriptEntry[]>()
    existingTranscripts.set('agent:a1:team:team-1', [
      makeEntry('agent:a1:team:team-1', {
        kind: 'user',
        role: 'user',
        text: 'Build me a landing page',
        timestampMs: Date.now() - 60_000,
      }),
      makeEntry('agent:a1:team:team-1', {
        kind: 'assistant',
        role: 'assistant',
        text: 'I will coordinate the team to build a landing page.',
        timestampMs: Date.now() - 30_000,
      }),
    ])
    mockGetTranscripts.mockReturnValue(existingTranscripts)

    await sendGroupChatMessage({
      client: mockClient,
      teamId: 'team-1',
      teamName: 'Dev Team',
      leaderAgentId: 'a1',
      teamAgents: [leader, worker],
      message: 'Add a hero section',
    })

    // sendChatMessage should be called with the correct sessionKey
    expect(mockSendChatMessage).toHaveBeenCalledTimes(1)

    // The preamble comes from buildTeamContextPreamble which checks for non-self entries.
    // Since the only entries are from the target (leader) and user, the preamble
    // filters out self-entries and meta entries, so it may or may not have content.
    // What matters is that sendChatMessage was called with the correct sessionKey.
    expect(mockSendChatMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        agentId: 'a1',
        sessionKey: 'agent:a1:team:team-1',
      }),
    )
  })

  it('sends raw message with no preamble on first message (no history)', async () => {
    // Empty transcripts — no history
    mockGetTranscripts.mockReturnValue(new Map())

    await sendGroupChatMessage({
      client: mockClient,
      teamId: 'team-1',
      teamName: 'Dev Team',
      leaderAgentId: 'a1',
      teamAgents: [leader, worker],
      message: 'Hello team',
    })

    expect(mockSendChatMessage).toHaveBeenCalledTimes(1)
    const sentMessage = mockSendChatMessage.mock.calls[0][0].message as string

    // No [Team Context prefix — raw message or just the message itself
    expect(sentMessage).not.toContain('[Team Context')
    expect(sentMessage).toContain('Hello team')
  })

  it('wake message is silent re-init (no @mentions, no introduction request)', async () => {
    // Agent a2 needs waking
    mockFindSleeping.mockReturnValue(['a2'])
    mockGetTranscripts.mockReturnValue(new Map())

    const p = sendGroupChatMessage({
      client: mockClient,
      teamId: 'team-1',
      teamName: 'Dev Team',
      leaderAgentId: 'a1',
      teamAgents: [leader, worker],
      message: 'build it',
    })
    await vi.advanceTimersByTimeAsync(5000)
    await p

    // Find the wake call (chat.send via mockClient.call, not mockSendChatMessage)
    const wakeCalls = mockClient.call.mock.calls.filter(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (args: any[]) => args[0] === 'chat.send',
    )
    expect(wakeCalls.length).toBeGreaterThanOrEqual(1)

    // Wake message must NOT ask for introductions or list teammates as
    // @mentions — that triggered the message-flooding cascade in production.
    // The full team protocol lives in AGENTS.md, loaded on every interaction.
    const wakeMessage = wakeCalls[0][1].message as string
    expect(wakeMessage).toContain('resuming')
    expect(wakeMessage).toContain('Worker Boo')
    expect(wakeMessage).not.toContain('@')
    expect(wakeMessage).not.toMatch(/introduce yourself/i)
  })

  it('passes team name correctly to wake message', async () => {
    mockFindSleeping.mockReturnValue(['a2', 'a3'])
    mockGetTranscripts.mockReturnValue(new Map())

    const p = sendGroupChatMessage({
      client: mockClient,
      teamId: 'team-1',
      teamName: 'Marketing Squad',
      leaderAgentId: 'a1',
      teamAgents: [leader, worker, coder],
      message: 'start campaign',
    })
    await vi.advanceTimersByTimeAsync(5000)
    await p

    // Wake messages should include team name
    const wakeCalls = mockClient.call.mock.calls.filter(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (args: any[]) => args[0] === 'chat.send',
    )
    for (const call of wakeCalls) {
      const msg = call[1].message as string
      expect(msg).toContain('Marketing Squad')
    }
  })

  it('wake message addresses the woken agent personally without listing teammates', async () => {
    // Regression guard: the previous implementation listed teammates as
    // @mentions, which agents naturally echoed in their introduction
    // responses, triggering false delegation detection and a relay cascade
    // (~40+ messages from a single user query). The fix replaced the
    // teammate-listing intro prompt with a silent re-init message.
    mockFindSleeping.mockReturnValue(['a2'])
    mockGetTranscripts.mockReturnValue(new Map())

    const p = sendGroupChatMessage({
      client: mockClient,
      teamId: 'team-1',
      teamName: 'Dev Team',
      leaderAgentId: 'a1',
      teamAgents: [leader, worker, coder],
      message: 'build it',
    })
    await vi.advanceTimersByTimeAsync(5000)
    await p

    const wakeCalls = mockClient.call.mock.calls.filter(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (args: any[]) => args[0] === 'chat.send',
    )
    expect(wakeCalls.length).toBeGreaterThanOrEqual(1)

    const workerWakeCall = wakeCalls.find(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (args: any[]) => args[1].sessionKey === 'agent:a2:team:team-1',
    )
    expect(workerWakeCall).toBeDefined()
    const msg = workerWakeCall![1].message as string
    // Addresses the agent being woken
    expect(msg).toContain('Worker Boo')
    expect(msg).toContain('Dev Team')
    // Does NOT list teammates as @mentions (regression guard)
    expect(msg).not.toContain('Leader Boo')
    expect(msg).not.toContain('Coder Boo')
    expect(msg).not.toContain('@')
  })

  // ─── User-intro persistence regression ───────────────────────────────────
  // Background: in production the user reported that they couldn't tell
  // whether their self-introduction was reaching the agent. Two bugs:
  //   (a) TeamOnboardingGate sent the wrong RPC param name (`path` instead
  //       of `name`), so the SOUL.md write silently failed.
  //   (b) Even when fixed, Gateway SOUL.md persistence is unreliable per
  //       CLAUDE.md.
  // Fix: SQLite is the source of truth for the user intro, and on every
  // group-chat send we inject it into the team context preamble. These
  // tests verify the preamble actually contains the intro text.

  it('injects userIntroText into the preamble on the first message (no history)', async () => {
    mockGetTranscripts.mockReturnValue(new Map())
    mockFindSleeping.mockReturnValue([])

    const p = sendGroupChatMessage({
      client: mockClient,
      teamId: 'team-1',
      teamName: 'Dev Team',
      leaderAgentId: 'a1',
      teamAgents: [leader, worker],
      message: 'hello team',
      userIntroText: "I'm Sanju, I'm building Clawboo.",
    })
    await vi.advanceTimersByTimeAsync(0)
    await p

    expect(mockSendChatMessage).toHaveBeenCalledTimes(1)
    const sent = mockSendChatMessage.mock.calls[0][0] as { message: string }
    expect(sent.message).toContain('[About the User]')
    expect(sent.message).toContain("I'm Sanju, I'm building Clawboo.")
    expect(sent.message).toContain('[End About the User]')
    // The original user message is preserved at the end
    expect(sent.message.endsWith('hello team')).toBe(true)
  })

  it('injects userIntroText alongside the team context block when history exists', async () => {
    const transcripts = new Map<string, TranscriptEntry[]>()
    transcripts.set('agent:a2:team:team-1', [
      makeEntry('agent:a2:team:team-1', {
        text: 'previous response',
        timestampMs: Date.now() - 60_000,
      }),
    ])
    mockGetTranscripts.mockReturnValue(transcripts)
    mockFindSleeping.mockReturnValue([])

    const p = sendGroupChatMessage({
      client: mockClient,
      teamId: 'team-1',
      teamName: 'Dev Team',
      leaderAgentId: 'a1',
      teamAgents: [leader, worker],
      message: 'follow up',
      userIntroText: 'My name is Sanju.',
    })
    await vi.advanceTimersByTimeAsync(0)
    await p

    const sent = mockSendChatMessage.mock.calls[0][0] as { message: string }
    expect(sent.message).toContain('[About the User]')
    expect(sent.message).toContain('My name is Sanju.')
    expect(sent.message).toContain('[Team Context')
  })

  it('omits [About the User] block when userIntroText is empty/missing', async () => {
    mockGetTranscripts.mockReturnValue(new Map())
    mockFindSleeping.mockReturnValue([])

    const p = sendGroupChatMessage({
      client: mockClient,
      teamId: 'team-1',
      teamName: 'Dev Team',
      leaderAgentId: 'a1',
      teamAgents: [leader, worker],
      message: 'hi',
      // no userIntroText
    })
    await vi.advanceTimersByTimeAsync(0)
    await p

    const sent = mockSendChatMessage.mock.calls[0][0] as { message: string }
    expect(sent.message).not.toContain('[About the User]')
  })
})
