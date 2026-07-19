// useTeamChatStream hook — the EventSource wiring. Uses an INJECTED fake EventSource
// (jsdom has none): a committed `message` frame + a named `delta` frame both flow
// into the chat store and fire onActivity; unmount closes the stream.

import { act, cleanup, render } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { useChatStore } from '@/stores/chat'
import { useFleetStore, type AgentState } from '@/stores/fleet'

import { useTeamChatStream } from '../useTeamChatStream'

const SK = 'agent:a2:team:t1'

class FakeEventSource {
  listeners = new Map<string, Set<(e: MessageEvent) => void>>()
  closed = false
  constructor(public url: string) {}
  addEventListener(type: string, fn: (e: MessageEvent) => void): void {
    const set = this.listeners.get(type) ?? new Set<(e: MessageEvent) => void>()
    set.add(fn)
    this.listeners.set(type, set)
  }
  removeEventListener(type: string, fn: (e: MessageEvent) => void): void {
    this.listeners.get(type)?.delete(fn)
  }
  close(): void {
    this.closed = true
  }
  emit(type: string, data: string): void {
    for (const fn of this.listeners.get(type) ?? []) fn({ data } as MessageEvent)
  }
}

function Harness({
  es,
  onActivity,
  enabled = true,
}: {
  es: FakeEventSource
  onActivity: () => void
  enabled?: boolean
}): null {
  useTeamChatStream({
    teamId: 't1',
    enabled,
    onActivity,
    eventSourceFactory: () => es as unknown as EventSource,
  })
  return null
}

function committed(entryId: string): string {
  return JSON.stringify({
    entryId,
    role: 'assistant',
    kind: 'assistant',
    text: 'done',
    sessionKey: SK,
    runId: 'r1',
    source: 'local-send',
    timestampMs: 1000,
    sequenceKey: 1,
    confirmed: true,
    fingerprint: 'f',
  })
}

afterEach(() => {
  cleanup()
  useChatStore.setState({
    transcripts: new Map(),
    streamingText: new Map(),
    streamStartedAt: new Map(),
    lastTokenUsage: new Map(),
  })
})

describe('useTeamChatStream', () => {
  it('routes committed + delta frames into the store and fires onActivity', () => {
    const es = new FakeEventSource('/x')
    const onActivity = vi.fn()
    render(<Harness es={es} onActivity={onActivity} />)

    act(() => es.emit('delta', JSON.stringify({ sessionKey: SK, runId: 'r1', text: 'partial' })))
    expect(useChatStore.getState().streamingText.get(SK)).toBe('partial')

    act(() => es.emit('message', committed('e1')))
    expect(useChatStore.getState().transcripts.get(SK)).toHaveLength(1)
    // The committed assistant turn dropped the live delta.
    expect(useChatStore.getState().streamingText.get(SK)).toBeUndefined()

    expect(onActivity).toHaveBeenCalledTimes(2)
  })

  it('routes status frames into the fleet store (the left-pane Working/Idle badges)', () => {
    const a: AgentState = {
      id: 'a2',
      name: 'Data Analyst Boo',
      status: 'idle',
      sessionKey: 'agent:a2:main',
      model: null,
      createdAt: null,
      streamingText: null,
      runId: null,
      lastSeenAt: null,
      teamId: 't1',
      runtime: 'openclaw',
      execConfig: null,
    }
    useFleetStore.setState({ agents: [a] })
    const es = new FakeEventSource('/x')
    const onActivity = vi.fn()
    render(<Harness es={es} onActivity={onActivity} />)

    act(() => es.emit('status', JSON.stringify({ agentId: 'a2', status: 'running' })))
    expect(useFleetStore.getState().agents[0]?.status).toBe('running')

    act(() => es.emit('status', JSON.stringify({ agentId: 'a2', status: 'idle' })))
    expect(useFleetStore.getState().agents[0]?.status).toBe('idle')

    expect(onActivity).toHaveBeenCalledTimes(2)
  })

  it('closes the stream on unmount', () => {
    const es = new FakeEventSource('/x')
    const { unmount } = render(<Harness es={es} onActivity={vi.fn()} />)
    expect(es.closed).toBe(false)
    unmount()
    expect(es.closed).toBe(true)
  })

  it('is inert when disabled (no EventSource opened)', () => {
    const factory = vi.fn()
    render(<DisabledHarness factory={factory} />)
    expect(factory).not.toHaveBeenCalled()
  })
})

function DisabledHarness({ factory }: { factory: () => EventSource }): null {
  useTeamChatStream({ teamId: 't1', enabled: false, eventSourceFactory: factory })
  return null
}
