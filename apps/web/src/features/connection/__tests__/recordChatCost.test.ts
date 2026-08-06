// recordChatCost — the host half of token accounting.
//
// The pure half (`deriveChatCost`) lives in `@clawboo/events` and is tested
// there. This covers what could NOT move into the pure layer: estimating the
// prompt from the agent's last user message, which needs a transcript read.
//
// Why this is a function and not another `client.onEvent` subscription: billing
// used to re-parse every raw `chat:final` on its own, outside the pipeline and
// therefore outside the Handler's closed-run guard, so a replayed frame was
// charged twice. It now rides the `commitChat` intent. That the guard actually
// suppresses the replay is proven in
// `packages/events/src/__tests__/handler.test.ts`.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ChatCost } from '@clawboo/events'
import type { TranscriptEntry } from '@clawboo/protocol'

import { useChatStore } from '@/stores/chat'
import { useFleetStore, type AgentState } from '@/stores/fleet'

import { recordChatCost } from '../useGatewayEvents'

const AGENT_ID = 'a1'
const SESSION_KEY = 'agent:a1:main'

function agent(): AgentState {
  return {
    id: AGENT_ID,
    name: 'Coder',
    status: 'idle',
    sessionKey: SESSION_KEY,
    model: null,
    createdAt: 0,
    streamingText: null,
    runId: null,
    lastSeenAt: null,
    teamId: null,
    execConfig: null,
  }
}

function userEntry(text: string): TranscriptEntry {
  return {
    entryId: 'u1',
    role: 'user',
    kind: 'user',
    text,
    sessionKey: SESSION_KEY,
    runId: null,
    source: 'local-send',
    timestampMs: 1_700_000_000_000,
    sequenceKey: 1,
    confirmed: true,
    fingerprint: 'f1',
  }
}

function postedBody(fetchMock: ReturnType<typeof vi.fn>): Record<string, unknown> {
  const [, init] = fetchMock.mock.calls[0] as [string, RequestInit]
  return JSON.parse(init.body as string) as Record<string, unknown>
}

let fetchMock: ReturnType<typeof vi.fn>

beforeEach(() => {
  fetchMock = vi.fn().mockResolvedValue({ ok: true })
  vi.stubGlobal('fetch', fetchMock)
  useFleetStore.setState({ agents: [agent()], selectedAgentId: null })
  useChatStore.setState({
    transcripts: new Map(),
    streamingText: new Map(),
    streamStartedAt: new Map(),
    lastTokenUsage: new Map(),
  })
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('recordChatCost', () => {
  it('posts real Gateway usage verbatim', () => {
    const cost: ChatCost = { model: 'claude-opus-5', inputTokens: 120, outputTokens: 340 }
    recordChatCost(AGENT_ID, 'r1', cost)

    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(fetchMock.mock.calls[0]![0]).toBe('/api/cost-records')
    expect(postedBody(fetchMock)).toEqual({
      agentId: AGENT_ID,
      model: 'claude-opus-5',
      inputTokens: 120,
      outputTokens: 340,
      runId: 'r1',
    })
  })

  it('estimates the prompt from the last user message when usage is absent', () => {
    // 40 chars ⇒ 10 tokens at 4 chars/token.
    useChatStore.getState().appendTranscript(SESSION_KEY, [userEntry('x'.repeat(40))])
    recordChatCost(AGENT_ID, 'r1', { model: 'm', inputTokens: null, outputTokens: 25 })

    expect(postedBody(fetchMock)).toMatchObject({ inputTokens: 10, outputTokens: 25 })
  })

  it('reaches back past later assistant turns for the last USER message', () => {
    useChatStore
      .getState()
      .appendTranscript(SESSION_KEY, [
        userEntry('y'.repeat(80)),
        { ...userEntry('an assistant reply'), entryId: 'a1', role: 'assistant', kind: 'assistant' },
      ])
    recordChatCost(AGENT_ID, 'r1', { model: 'm', inputTokens: null, outputTokens: 1 })

    expect(postedBody(fetchMock)).toMatchObject({ inputTokens: 20 })
  })

  it('bills nothing when both sides are zero', () => {
    recordChatCost(AGENT_ID, 'r1', { model: 'm', inputTokens: null, outputTokens: 0 })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('records per-run usage for the chat UI, but only with a runId', () => {
    recordChatCost(AGENT_ID, 'r1', { model: 'm', inputTokens: 5, outputTokens: 7 })
    expect(useChatStore.getState().lastTokenUsage.get('r1')).toEqual({
      inputTokens: 5,
      outputTokens: 7,
    })

    recordChatCost(AGENT_ID, null, { model: 'm', inputTokens: 5, outputTokens: 7 })
    expect(useChatStore.getState().lastTokenUsage.size).toBe(1)
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('never throws when the POST rejects', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('offline')))
    expect(() =>
      recordChatCost(AGENT_ID, 'r1', { model: 'm', inputTokens: 1, outputTokens: 1 }),
    ).not.toThrow()
    // Let the rejected promise settle so it can't surface as an unhandled rejection.
    await Promise.resolve()
  })
})
