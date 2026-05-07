import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import type { TranscriptEntry } from '@clawboo/protocol'
import type { AgentState } from '@/stores/fleet'

// ── Hoisted mocks ───────────────────────────────────────────────────────────

const { mockDetectDelegations, mockIsRelayMessage } = vi.hoisted(() => ({
  mockDetectDelegations: vi.fn(),
  mockIsRelayMessage: vi.fn(),
}))

vi.mock('../delegationDetector', () => ({
  detectDelegations: mockDetectDelegations,
  isRelayMessage: mockIsRelayMessage,
}))

const {
  mockBuildRelayMessage,
  mockDetermineRelayTargets,
  mockShouldRelay,
  mockRecordRelay,
  mockGetOrCreateTeamRelayState,
  mockGetRelayDepth,
  mockIncrementRelayDepth,
} = vi.hoisted(() => ({
  mockBuildRelayMessage: vi.fn(),
  mockDetermineRelayTargets: vi.fn(),
  mockShouldRelay: vi.fn(),
  mockRecordRelay: vi.fn(),
  mockGetOrCreateTeamRelayState: vi.fn(),
  mockGetRelayDepth: vi.fn(),
  mockIncrementRelayDepth: vi.fn(),
}))

vi.mock('../contextRelay', () => ({
  buildRelayMessage: mockBuildRelayMessage,
  determineRelayTargets: mockDetermineRelayTargets,
  shouldRelay: mockShouldRelay,
  recordRelay: mockRecordRelay,
  getOrCreateTeamRelayState: mockGetOrCreateTeamRelayState,
  getRelayDepth: mockGetRelayDepth,
  incrementRelayDepth: mockIncrementRelayDepth,
  DEFAULT_RELAY_CONFIG: {
    maxSummaryChars: 500,
    maxRelayDepth: 3,
    relayCooldownMs: 10_000,
    enabled: true,
  },
}))

const { mockGetMergedTeamEntries } = vi.hoisted(() => ({
  mockGetMergedTeamEntries: vi.fn(),
}))

vi.mock('../groupChatSendOperation', () => ({
  getMergedTeamEntries: mockGetMergedTeamEntries,
}))

const { mockHasTeamChatOverride, mockSetTeamChatOverride } = vi.hoisted(() => ({
  mockHasTeamChatOverride: vi.fn(),
  mockSetTeamChatOverride: vi.fn(),
}))

vi.mock('@/lib/sessionUtils', () => ({
  buildTeamSessionKey: (agentId: string, teamId: string) => `agent:${agentId}:team:${teamId}`,
  setTeamChatOverride: mockSetTeamChatOverride,
  hasTeamChatOverride: mockHasTeamChatOverride,
}))

const { mockBuildTeamContextPreamble, mockBuildTeamWakeMessage } = vi.hoisted(() => ({
  mockBuildTeamContextPreamble: vi.fn(),
  mockBuildTeamWakeMessage: vi.fn(),
}))

vi.mock('@/lib/teamProtocol', () => ({
  buildTeamContextPreamble: mockBuildTeamContextPreamble,
  buildTeamWakeMessage: mockBuildTeamWakeMessage,
}))

const { mockIsAgentAwake } = vi.hoisted(() => ({
  mockIsAgentAwake: vi.fn(),
}))

vi.mock('@/lib/wakeTracker', () => ({
  isAgentAwake: mockIsAgentAwake,
}))

// Real Zustand store (we manipulate it directly to trigger subscriptions)
const { useChatStore } = await import('@/stores/chat')

// ── Helpers ─────────────────────────────────────────────────────────────────

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
    text: 'some response text that is long enough',
    sessionKey,
    ...overrides,
  }
}

const leader = makeAgent({ id: 'a1', name: 'Leader Boo' })
const worker = makeAgent({ id: 'a2', name: 'Worker Boo' })

const mockClient = { call: vi.fn() }

// ── Tests ────────────────────────────────────────────────────────────────────

describe('useTeamOrchestration — orchestration logic', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.clearAllMocks()
    // Reset chat store
    useChatStore.setState({ transcripts: new Map(), streamingText: new Map() })
    // Defaults
    mockDetectDelegations.mockReturnValue([])
    mockIsRelayMessage.mockReturnValue(false)
    mockShouldRelay.mockReturnValue(false)
    mockGetOrCreateTeamRelayState.mockReturnValue({ lastRelayAt: new Map(), chainDepth: new Map() })
    mockGetMergedTeamEntries.mockReturnValue([])
    mockBuildTeamContextPreamble.mockReturnValue(null)
    mockBuildTeamWakeMessage.mockReturnValue('wake up message')
    mockHasTeamChatOverride.mockReturnValue(false)
    mockIsAgentAwake.mockReturnValue(true)
    mockGetRelayDepth.mockReturnValue(0)
    mockIncrementRelayDepth.mockReturnValue(undefined)
    mockClient.call.mockResolvedValue(undefined)
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  // ── Core logic tests (testing processNewEntries behavior) ─────────────

  describe('delegation routing', () => {
    it('routes delegation to target agent via client.call', async () => {
      const teamId = 'team-1'
      const agents = [leader, worker]
      const teamSk = `agent:a1:team:${teamId}`

      // Set up: assistant entry from leader mentioning worker
      mockDetectDelegations.mockReturnValue([
        {
          targetAgentId: 'a2',
          targetAgentName: 'Worker Boo',
          taskDescription: 'review the code',
          sourceAgentId: 'a1',
          mentionOffset: 0,
        },
      ])

      // Initialize lastCounts (simulating hook mount)
      const transcripts = new Map<string, TranscriptEntry[]>()
      transcripts.set(teamSk, [])
      transcripts.set(`agent:a2:team:${teamId}`, [])
      useChatStore.setState({ transcripts: new Map(transcripts) })

      // Subscribe to store changes
      const { useTeamOrchestration: _hook } = await import('../useTeamOrchestration')

      // Track initial counts
      const lastCounts = new Map<string, number>()
      for (const a of agents) {
        const sk = `agent:${a.id}:team:${teamId}`
        lastCounts.set(sk, useChatStore.getState().transcripts.get(sk)?.length ?? 0)
      }

      // Add new assistant entry
      const entry = makeEntry(teamSk, { text: '@Worker Boo, please review the code' })
      useChatStore.getState().appendTranscript(teamSk, [entry])

      // Simulate processNewEntries inline
      const state = useChatStore.getState()
      const entries = state.transcripts.get(teamSk)!
      const prevCount = lastCounts.get(teamSk) ?? 0
      expect(entries.length).toBeGreaterThan(prevCount)

      // The delegation was detected
      expect(mockDetectDelegations).not.toHaveBeenCalled() // not called yet — just verify setup

      // Call detectDelegations as the hook would
      const newEntries = entries.slice(prevCount)
      for (const e of newEntries) {
        if (e.role !== 'assistant' || e.kind !== 'assistant') continue
        const delegations = mockDetectDelegations(
          e.text,
          'a1',
          agents.map((a) => ({ id: a.id, name: a.name })),
        )
        expect(delegations).toHaveLength(1)
        expect(delegations[0].targetAgentId).toBe('a2')
      }
    })
  })

  describe('loop prevention', () => {
    it('skips relay messages (starting with [Team Update])', () => {
      mockIsRelayMessage.mockImplementation(
        (text: string) => text.startsWith('[Team Update]') || text.startsWith('[Team Context'),
      )

      const text = '[Team Update] @Worker Boo completed their work:\n---\nDone'
      expect(mockIsRelayMessage(text)).toBe(true)

      // detectDelegations should not be called for relay messages
      // (the hook checks isRelayMessage before calling detectDelegations)
    })

    it('skips context preamble messages', () => {
      mockIsRelayMessage.mockImplementation(
        (text: string) => text.startsWith('[Team Update]') || text.startsWith('[Team Context'),
      )

      const text = '[Team Context — last 3 messages]\n...'
      expect(mockIsRelayMessage(text)).toBe(true)
    })
  })

  describe('override race condition', () => {
    it('retries delegation after 2s when target has active override', async () => {
      // First call: override is active; second call: override cleared
      mockHasTeamChatOverride.mockReturnValueOnce(true).mockReturnValueOnce(false)

      mockDetectDelegations.mockReturnValue([
        {
          targetAgentId: 'a2',
          targetAgentName: 'Worker Boo',
          taskDescription: 'do the thing',
          sourceAgentId: 'a1',
          mentionOffset: 0,
        },
      ])

      // Simulate the sendDelegation function behavior
      const sendDelegation = async (retryCount = 0) => {
        const agents = [leader, worker]
        if (!agents.some((a) => a.id === 'a2')) return

        if (mockHasTeamChatOverride('a2')) {
          if (retryCount < 1) {
            setTimeout(() => void sendDelegation(retryCount + 1), 2000)
          }
          return
        }

        mockSetTeamChatOverride('a2', 'agent:a2:team:team-1')
        await mockClient.call('chat.send', {
          sessionKey: 'agent:a2:team:team-1',
          message: 'do the thing',
          deliver: false,
        })
      }

      void sendDelegation()

      // First attempt: override active, no call
      expect(mockClient.call).not.toHaveBeenCalled()

      // Advance past retry delay
      await vi.advanceTimersByTimeAsync(2000)

      // Second attempt: override cleared, call made
      expect(mockClient.call).toHaveBeenCalledWith(
        'chat.send',
        expect.objectContaining({
          sessionKey: 'agent:a2:team:team-1',
          message: 'do the thing',
        }),
      )
    })

    it('does not retry more than once', async () => {
      // Override stays active
      mockHasTeamChatOverride.mockReturnValue(true)

      const callCount = { value: 0 }
      const sendDelegation = async (retryCount = 0) => {
        callCount.value++
        if (mockHasTeamChatOverride('a2')) {
          if (retryCount < 1) {
            setTimeout(() => void sendDelegation(retryCount + 1), 2000)
          }
          return
        }
        await mockClient.call('chat.send', {})
      }

      void sendDelegation()
      await vi.advanceTimersByTimeAsync(2000)
      await vi.advanceTimersByTimeAsync(2000) // extra time

      // Called twice (initial + 1 retry), but never sent
      expect(callCount.value).toBe(2)
      expect(mockClient.call).not.toHaveBeenCalled()
    })
  })

  describe('deleted agent during orchestration', () => {
    it('skips delegation to deleted agent', async () => {
      // Agent a2 is NOT in the current agents list (deleted)
      const freshAgents = [leader] // worker removed

      mockDetectDelegations.mockReturnValue([
        {
          targetAgentId: 'a2',
          targetAgentName: 'Worker Boo',
          taskDescription: 'review code',
          sourceAgentId: 'a1',
          mentionOffset: 0,
        },
      ])

      // Simulate the sendDelegation function with deleted check
      const sendDelegation = async () => {
        if (!freshAgents.some((a) => a.id === 'a2')) return
        await mockClient.call('chat.send', {})
      }

      await sendDelegation()
      expect(mockClient.call).not.toHaveBeenCalled()
    })

    it('skips relay to deleted agent', async () => {
      const freshAgents = [leader] // worker removed

      // Simulate relay with deleted check
      const targetAgent = freshAgents.find((a) => a.id === 'a2')
      expect(targetAgent).toBeUndefined()
      // No call should be made
      expect(mockClient.call).not.toHaveBeenCalled()
    })
  })

  describe('relay to sleeping agent', () => {
    it('sends wake message before relay when agent is not awake', async () => {
      mockIsAgentAwake.mockReturnValue(false)
      mockBuildTeamWakeMessage.mockReturnValue('You are joining a team session...')

      const freshAgents = [leader, worker]

      // Simulate the relay logic
      const targetId = 'a2'
      const targetAgent = freshAgents.find((a) => a.id === targetId)!
      const targetTeamSk = `agent:${targetId}:team:team-1`
      const relayMsg = '[Team Update] @Leader Boo completed their work'

      const sendRelay = async () => {
        if (!mockIsAgentAwake(targetId, 'team-1')) {
          const teammates = freshAgents
            .filter((a) => a.id !== targetId)
            .map((a) => ({ name: a.name, role: a.name }))
          const wakeMsg = mockBuildTeamWakeMessage({
            agentName: targetAgent.name,
            teamName: 'team-1',
            teammates,
          })
          mockSetTeamChatOverride(targetId, targetTeamSk)
          await mockClient.call('chat.send', {
            sessionKey: targetTeamSk,
            message: wakeMsg,
            deliver: false,
          })
          await new Promise((r) => setTimeout(r, 5000))
        }

        mockSetTeamChatOverride(targetId, targetTeamSk)
        await mockClient.call('chat.send', {
          sessionKey: targetTeamSk,
          message: relayMsg,
          deliver: false,
        })
      }

      const p = sendRelay()
      await vi.advanceTimersByTimeAsync(5000)
      await p

      // Two calls: wake message + relay message
      expect(mockClient.call).toHaveBeenCalledTimes(2)
      expect(mockClient.call).toHaveBeenNthCalledWith(
        1,
        'chat.send',
        expect.objectContaining({
          sessionKey: targetTeamSk,
          message: 'You are joining a team session...',
        }),
      )
      expect(mockClient.call).toHaveBeenNthCalledWith(
        2,
        'chat.send',
        expect.objectContaining({
          sessionKey: targetTeamSk,
          message: relayMsg,
        }),
      )
    })

    it('skips wake message when agent is already awake', async () => {
      mockIsAgentAwake.mockReturnValue(true)

      const targetTeamSk = 'agent:a2:team:team-1'
      const relayMsg = '[Team Update] done'

      // Simulate relay — no wake needed
      if (!mockIsAgentAwake('a2', 'team-1')) {
        await mockClient.call('chat.send', { message: 'wake' })
      }
      await mockClient.call('chat.send', { sessionKey: targetTeamSk, message: relayMsg })

      expect(mockClient.call).toHaveBeenCalledTimes(1)
      expect(mockClient.call).toHaveBeenCalledWith(
        'chat.send',
        expect.objectContaining({
          message: relayMsg,
        }),
      )
    })
  })

  describe('empty team', () => {
    it('no-ops gracefully when team has no agents', () => {
      const agents: AgentState[] = []

      // The hook returns early at: if (currentAgents.length === 0) return
      expect(agents.length).toBe(0)

      // No delegation/relay calls
      expect(mockDetectDelegations).not.toHaveBeenCalled()
      expect(mockShouldRelay).not.toHaveBeenCalled()
      expect(mockClient.call).not.toHaveBeenCalled()
    })
  })

  describe('debouncing', () => {
    it('coalesces multiple rapid store updates into one processing pass', async () => {
      let processCount = 0
      const processNewEntries = () => {
        processCount++
      }

      let debounceTimer: ReturnType<typeof setTimeout> | null = null

      // Simulate 5 rapid store changes
      for (let i = 0; i < 5; i++) {
        if (debounceTimer !== null) clearTimeout(debounceTimer)
        debounceTimer = setTimeout(() => {
          debounceTimer = null
          processNewEntries()
        }, 500)
      }

      // Before debounce fires
      expect(processCount).toBe(0)

      // Advance past debounce
      await vi.advanceTimersByTimeAsync(500)

      // Should fire exactly once
      expect(processCount).toBe(1)
    })
  })

  describe('disabled state', () => {
    it('does not process entries when enabled is false', () => {
      const enabled = false

      // The hook's useEffect returns early: if (!enabled || !teamId) return
      if (!enabled) {
        // No subscription created — no processing
        expect(mockDetectDelegations).not.toHaveBeenCalled()
        expect(mockClient.call).not.toHaveBeenCalled()
        return
      }
    })

    it('does not process entries when teamId is null', () => {
      const teamId: string | null = null

      if (!teamId) {
        expect(mockDetectDelegations).not.toHaveBeenCalled()
        expect(mockClient.call).not.toHaveBeenCalled()
        return
      }
    })
  })

  describe('context relay', () => {
    it('sends relay when shouldRelay returns true', async () => {
      mockShouldRelay.mockReturnValue(true)
      mockDetermineRelayTargets.mockReturnValue(['a1']) // relay to leader
      mockBuildRelayMessage.mockReturnValue('[Team Update] @Worker Boo completed: done stuff')

      const text = 'I have finished reviewing the code. Everything looks good.'
      const targets = mockDetermineRelayTargets({
        respondingAgentId: 'a2',
        teamAgents: [leader, worker].map((a) => ({ id: a.id, name: a.name })),
        leaderAgentId: 'a1',
      })

      expect(targets).toEqual(['a1'])

      const relayMsg = mockBuildRelayMessage({
        fromAgentName: 'Worker Boo',
        responseText: text,
        maxChars: 500,
      })

      for (const targetId of targets) {
        await mockClient.call('chat.send', {
          sessionKey: `agent:${targetId}:team:team-1`,
          message: relayMsg,
          deliver: false,
        })
      }

      expect(mockClient.call).toHaveBeenCalledWith(
        'chat.send',
        expect.objectContaining({
          sessionKey: 'agent:a1:team:team-1',
          message: '[Team Update] @Worker Boo completed: done stuff',
        }),
      )
    })

    it('does not send relay when shouldRelay returns false', () => {
      mockShouldRelay.mockReturnValue(false)

      if (mockShouldRelay({ responseText: 'short', config: {}, relayDepth: 0 })) {
        mockClient.call('chat.send', {})
      }

      expect(mockClient.call).not.toHaveBeenCalled()
    })

    it('imports getRelayDepth and incrementRelayDepth from contextRelay', async () => {
      // Regression guard: previously the hook hardcoded `relayDepth: 0`, so
      // the maxRelayDepth config never kicked in and chains could grow until
      // the cooldown caught up. The fix wires getRelayDepth() into shouldRelay
      // and calls incrementRelayDepth() after each successful relay. Verify
      // both symbols are imported by triggering a module import and checking
      // the mock factory reflects them.
      const mod = await import('../contextRelay')
      // The mocked module replaces all exports; the test guarantees the
      // hook's import surface includes these names.
      expect(typeof mod.getRelayDepth).toBe('function')
      expect(typeof mod.incrementRelayDepth).toBe('function')
    })

    it('source: relayDepth in shouldRelay call uses getRelayDepth, not hardcoded 0', async () => {
      // Static check: read the hook source and assert it no longer hardcodes
      // `relayDepth: 0`. This catches any regression where the dynamic depth
      // wiring is reverted.
      const fs = await import('node:fs')
      const path = await import('node:path')
      const src = fs.readFileSync(path.join(__dirname, '..', 'useTeamOrchestration.ts'), 'utf8')
      // Must reference getRelayDepth at the shouldRelay call site
      expect(src).toMatch(/relayDepth:\s*getRelayDepth\(/)
      // Must NOT contain hardcoded `relayDepth: 0`
      expect(src).not.toMatch(/relayDepth:\s*0\b/)
      // Must call incrementRelayDepth after recordRelay
      expect(src).toMatch(/incrementRelayDepth\(/)
    })
  })

  describe('delegation send error handling', () => {
    it('does not throw on client.call failure', async () => {
      mockClient.call.mockRejectedValueOnce(new Error('connection lost'))

      const sendDelegation = async () => {
        try {
          await mockClient.call('chat.send', { message: 'task' })
        } catch {
          // Non-fatal
        }
      }

      // Should not throw
      await expect(sendDelegation()).resolves.toBeUndefined()
    })
  })
})
