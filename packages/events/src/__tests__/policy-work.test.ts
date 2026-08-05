import { describe, it, expect } from 'vitest'
import { decideWorkChatEvent, decideWorkAgentEvent, deriveChatCost } from '../policy/work'
import type { ClassifiedEvent, ChatEventPayload, AgentEventPayload } from '../types'

function makeChatEvent(agentId: string | undefined): ClassifiedEvent {
  return {
    kind: 'runtime-chat',
    agentId,
    payload: {},
    timestamp: Date.now(),
    raw: { type: 'event', event: 'chat' },
  }
}

function makeAgentEvent(agentId: string | undefined): ClassifiedEvent {
  return {
    kind: 'runtime-agent',
    agentId,
    payload: {},
    timestamp: Date.now(),
    raw: { type: 'event', event: 'agent' },
  }
}

describe('decideWorkChatEvent', () => {
  it('returns queueLivePatch for delta state', () => {
    const event = makeChatEvent('a1')
    const payload: ChatEventPayload = {
      runId: 'r1',
      sessionKey: 'sk1',
      state: 'delta',
      message: 'hello',
    }
    const intents = decideWorkChatEvent(event, payload)
    expect(intents.some((i) => i.kind === 'queueLivePatch')).toBe(true)
  })

  it('includes runId in delta patch', () => {
    const event = makeChatEvent('a1')
    const payload: ChatEventPayload = {
      runId: 'r1',
      sessionKey: 'sk1',
      state: 'delta',
    }
    const intents = decideWorkChatEvent(event, payload)
    const patch = intents.find((i) => i.kind === 'queueLivePatch')
    expect(patch).toBeDefined()
    if (patch?.kind === 'queueLivePatch') {
      expect(patch.patch.runId).toBe('r1')
    }
  })

  it('returns clearPendingLivePatch + commitChat for final state', () => {
    const event = makeChatEvent('a1')
    const payload: ChatEventPayload = {
      runId: 'r1',
      sessionKey: 'sk1',
      state: 'final',
      message: 'done',
    }
    const intents = decideWorkChatEvent(event, payload)
    expect(intents.some((i) => i.kind === 'clearPendingLivePatch')).toBe(true)
    expect(intents.some((i) => i.kind === 'commitChat')).toBe(true)
  })

  it('sets status to idle in final patch', () => {
    const event = makeChatEvent('a1')
    const payload: ChatEventPayload = {
      runId: 'r1',
      sessionKey: 'sk1',
      state: 'final',
    }
    const intents = decideWorkChatEvent(event, payload)
    const commit = intents.find((i) => i.kind === 'commitChat')
    if (commit?.kind === 'commitChat') {
      expect(commit.patch.status).toBe('idle')
      expect(commit.patch.runId).toBeNull()
      // The patch CLOSES the run, so `patch.runId` is null — the intent carries
      // the incoming frame's runId separately, which is what the Handler's
      // closed-run guard matches on.
      expect(commit.runId).toBe('r1')
    }
  })

  it('requests history refresh on final without thinking trace', () => {
    const event = makeChatEvent('a1')
    const payload: ChatEventPayload = {
      runId: 'r1',
      sessionKey: 'sk1',
      state: 'final',
    }
    const intents = decideWorkChatEvent(event, payload)
    expect(intents.some((i) => i.kind === 'requestHistoryRefresh')).toBe(true)
  })

  it('returns clearPendingLivePatch + commitChat for aborted state', () => {
    const event = makeChatEvent('a1')
    const payload: ChatEventPayload = {
      runId: 'r1',
      sessionKey: 'sk1',
      state: 'aborted',
    }
    const intents = decideWorkChatEvent(event, payload)
    expect(intents.some((i) => i.kind === 'clearPendingLivePatch')).toBe(true)
    expect(intents.some((i) => i.kind === 'commitChat')).toBe(true)
  })

  it('sets status to idle in aborted patch', () => {
    const event = makeChatEvent('a1')
    const payload: ChatEventPayload = {
      runId: 'r1',
      sessionKey: 'sk1',
      state: 'aborted',
    }
    const intents = decideWorkChatEvent(event, payload)
    const commit = intents.find((i) => i.kind === 'commitChat')
    if (commit?.kind === 'commitChat') {
      expect(commit.patch.status).toBe('idle')
      expect(commit.runId).toBe('r1')
    }
  })

  it('returns clearPendingLivePatch + commitChat for error state', () => {
    const event = makeChatEvent('a1')
    const payload: ChatEventPayload = {
      runId: 'r1',
      sessionKey: 'sk1',
      state: 'error',
      errorMessage: 'boom',
    }
    const intents = decideWorkChatEvent(event, payload)
    expect(intents.some((i) => i.kind === 'clearPendingLivePatch')).toBe(true)
    expect(intents.some((i) => i.kind === 'commitChat')).toBe(true)
  })

  it('sets status to error and preserves errorMessage for error state', () => {
    const event = makeChatEvent('a1')
    const payload: ChatEventPayload = {
      runId: 'r1',
      sessionKey: 'sk1',
      state: 'error',
      errorMessage: 'boom',
    }
    const intents = decideWorkChatEvent(event, payload)
    const commit = intents.find((i) => i.kind === 'commitChat')
    if (commit?.kind === 'commitChat') {
      expect(commit.patch.status).toBe('error')
      expect(commit.patch.streamText).toBe('boom')
      expect(commit.runId).toBe('r1')
    }
  })

  it('returns ignore when agentId is missing', () => {
    const event = makeChatEvent(undefined)
    const payload: ChatEventPayload = {
      runId: 'r1',
      sessionKey: 'sk1',
      state: 'delta',
    }
    const intents = decideWorkChatEvent(event, payload)
    expect(intents[0].kind).toBe('ignore')
  })
})

describe('decideWorkAgentEvent', () => {
  it('returns updateAgentStatus for lifecycle start', () => {
    const event = makeAgentEvent('a1')
    const payload: AgentEventPayload = {
      runId: 'r1',
      stream: 'lifecycle',
      data: { phase: 'start' },
    }
    const intents = decideWorkAgentEvent(event, payload)
    expect(intents[0].kind).toBe('updateAgentStatus')
    if (intents[0].kind === 'updateAgentStatus') {
      expect(intents[0].patch.status).toBe('running')
      expect(intents[0].runId).toBe('r1')
    }
  })

  it('returns updateAgentStatus for lifecycle end', () => {
    const event = makeAgentEvent('a1')
    const payload: AgentEventPayload = {
      runId: 'r1',
      stream: 'lifecycle',
      data: { phase: 'end' },
    }
    const intents = decideWorkAgentEvent(event, payload)
    expect(intents[0].kind).toBe('updateAgentStatus')
    if (intents[0].kind === 'updateAgentStatus') {
      expect(intents[0].patch.status).toBe('idle')
      // Terminal patches null out `patch.runId`; the guard needs the INCOMING id.
      expect(intents[0].runId).toBe('r1')
    }
  })

  it('returns updateAgentStatus for lifecycle error', () => {
    const event = makeAgentEvent('a1')
    const payload: AgentEventPayload = {
      runId: 'r1',
      stream: 'lifecycle',
      data: { phase: 'error' },
    }
    const intents = decideWorkAgentEvent(event, payload)
    expect(intents[0].kind).toBe('updateAgentStatus')
    if (intents[0].kind === 'updateAgentStatus') {
      expect(intents[0].patch.status).toBe('error')
      expect(intents[0].runId).toBe('r1')
    }
  })

  it('returns ignore for unknown lifecycle phase', () => {
    const event = makeAgentEvent('a1')
    const payload: AgentEventPayload = {
      runId: 'r1',
      stream: 'lifecycle',
      data: { phase: 'unknown' },
    }
    const intents = decideWorkAgentEvent(event, payload)
    expect(intents[0].kind).toBe('ignore')
  })

  it('returns queueLivePatch for reasoning stream with text', () => {
    const event = makeAgentEvent('a1')
    const payload: AgentEventPayload = {
      runId: 'r1',
      stream: 'thinking',
      data: { text: 'I am thinking...' },
    }
    const intents = decideWorkAgentEvent(event, payload)
    expect(intents[0].kind).toBe('queueLivePatch')
    if (intents[0].kind === 'queueLivePatch') {
      expect(intents[0].patch.thinkingTrace).toBe('I am thinking...')
    }
  })

  it('returns ignore for reasoning stream without text', () => {
    const event = makeAgentEvent('a1')
    const payload: AgentEventPayload = {
      runId: 'r1',
      stream: 'thinking',
      data: {},
    }
    const intents = decideWorkAgentEvent(event, payload)
    expect(intents[0].kind).toBe('ignore')
  })

  it('returns queueLivePatch for assistant stream with text', () => {
    const event = makeAgentEvent('a1')
    const payload: AgentEventPayload = {
      runId: 'r1',
      stream: 'assistant',
      data: { text: 'Hello!' },
    }
    const intents = decideWorkAgentEvent(event, payload)
    expect(intents[0].kind).toBe('queueLivePatch')
    if (intents[0].kind === 'queueLivePatch') {
      expect(intents[0].patch.streamText).toBe('Hello!')
    }
  })

  it('returns ignore for assistant stream without text', () => {
    const event = makeAgentEvent('a1')
    const payload: AgentEventPayload = {
      runId: 'r1',
      stream: 'assistant',
      data: {},
    }
    const intents = decideWorkAgentEvent(event, payload)
    expect(intents[0].kind).toBe('ignore')
  })

  it('returns ignore for tool stream', () => {
    const event = makeAgentEvent('a1')
    const payload: AgentEventPayload = {
      runId: 'r1',
      stream: 'tool',
      data: { text: 'tool output' },
    }
    const intents = decideWorkAgentEvent(event, payload)
    expect(intents[0].kind).toBe('ignore')
  })

  it('returns ignore when agentId is missing', () => {
    const event = makeAgentEvent(undefined)
    const payload: AgentEventPayload = {
      runId: 'r1',
      stream: 'lifecycle',
      data: { phase: 'start' },
    }
    const intents = decideWorkAgentEvent(event, payload)
    expect(intents[0].kind).toBe('ignore')
  })
})

// ── deriveChatCost ───────────────────────────────────────────────────────────
//
// Token spend is derived here, in the pure layer, so it can ride on the
// `commitChat` intent and inherit the Handler's closed-run guard. It used to be
// re-parsed from the raw frame by a second subscription in `useGatewayEvents`,
// which billed a replayed final twice.

describe('deriveChatCost', () => {
  const base: ChatEventPayload = { runId: 'r1', sessionKey: 'sk1', state: 'final' }

  it('returns null when the frame carries no message', () => {
    expect(deriveChatCost(base, 'text')).toBeNull()
    expect(deriveChatCost({ ...base, message: 'not-an-object' }, 'text')).toBeNull()
  })

  it('prefers real usage reported by the Gateway', () => {
    const payload: ChatEventPayload = {
      ...base,
      message: { model: 'claude-opus-5', usage: { input_tokens: 120, output_tokens: 340 } },
    }
    expect(deriveChatCost(payload, 'ignored when usage is present')).toEqual({
      model: 'claude-opus-5',
      inputTokens: 120,
      outputTokens: 340,
    })
  })

  it('reads usage nested under metadata', () => {
    const payload: ChatEventPayload = {
      ...base,
      message: { metadata: { usage: { input_tokens: 7, output_tokens: 9 } } },
    }
    expect(deriveChatCost(payload, null)).toMatchObject({ inputTokens: 7, outputTokens: 9 })
  })

  it('estimates output from the response text and defers input to the host', () => {
    const payload: ChatEventPayload = { ...base, message: { model: 'm' } }
    // null input == "no usage block; estimate the prompt from the transcript",
    // which is a store read and therefore not Policy's job.
    expect(deriveChatCost(payload, '12345678')).toEqual({
      model: 'm',
      inputTokens: null,
      outputTokens: 2,
    })
  })

  it('falls back to the payload model, then to "unknown"', () => {
    expect(deriveChatCost({ ...base, model: 'top-level', message: {} }, null)?.model).toBe(
      'top-level',
    )
    expect(deriveChatCost({ ...base, message: {} }, null)?.model).toBe('unknown')
  })

  it('treats missing or nonsense usage counts as zero', () => {
    const payload: ChatEventPayload = {
      ...base,
      message: { usage: { input_tokens: 'lots', output_tokens: -5 } },
    }
    expect(deriveChatCost(payload, null)).toMatchObject({ inputTokens: 0, outputTokens: 0 })
  })

  it('is attached to a final commit, and never to aborted/error', () => {
    const event = makeChatEvent('a1')
    const message = { usage: { input_tokens: 1, output_tokens: 2 } }
    for (const [state, expected] of [
      ['final', true],
      ['aborted', false],
      ['error', false],
    ] as const) {
      const intents = decideWorkChatEvent(event, { ...base, state, message })
      const commit = intents.find((i) => i.kind === 'commitChat')
      if (commit?.kind === 'commitChat') {
        expect(commit.cost !== null).toBe(expected)
      }
    }
  })
})
