import { describe, it, expect } from 'vitest'
import { decideWorkChatEvent, decideWorkAgentEvent } from '../policy/work'
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
