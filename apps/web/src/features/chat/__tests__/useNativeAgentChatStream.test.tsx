// The 1:1 stream's turn state. The server brackets every 1:1 turn with `running`
// and `idle`/`error` status frames, and the composer stays on Stop between them.
// That is what keeps it closed through a Hermes reply (one piece, at the end) or a
// long Claude Code tool call (no text for minutes). A (re)connect clears it before
// the server replays its snapshot, so a turn that ended while the stream was down
// cannot leave the composer stuck.

import { cleanup, renderHook } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'

import { useFleetStore } from '@/stores/fleet'

import { useNativeAgentChatStream } from '../useNativeAgentChatStream'

class FakeEventSource {
  readonly listeners = new Map<string, Set<(e: MessageEvent) => void>>()
  closed = false
  constructor(readonly url: string) {}
  addEventListener(type: string, fn: (e: MessageEvent) => void): void {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set())
    this.listeners.get(type)!.add(fn)
  }
  removeEventListener(type: string, fn: (e: MessageEvent) => void): void {
    this.listeners.get(type)?.delete(fn)
  }
  close(): void {
    this.closed = true
  }
  emit(type: string, data = ''): void {
    for (const fn of this.listeners.get(type) ?? []) fn({ data } as MessageEvent)
  }
}

afterEach(() => {
  cleanup()
  useFleetStore.setState({ agents: [], selectedAgentId: null })
})

function mount() {
  const sources: FakeEventSource[] = []
  const live: boolean[] = []
  const hook = renderHook(() =>
    useNativeAgentChatStream({
      agentId: 'cc-1',
      enabled: true,
      onTurnLive: (v) => live.push(v),
      eventSourceFactory: (url) => {
        const es = new FakeEventSource(url)
        sources.push(es)
        return es as unknown as EventSource
      },
    }),
  )
  return { hook, es: () => sources[0]!, live }
}

const status = (agentId: string, s: string): string => JSON.stringify({ agentId, status: s })

describe('useNativeAgentChatStream: the turn state', () => {
  it("opens the agent's own 1:1 stream", () => {
    const { es } = mount()
    expect(es().url).toContain('/api/agents/cc-1/chat/stream')
  })

  it('is live from the running frame to the terminal one', () => {
    const { es, live } = mount()
    es().emit('status', status('cc-1', 'running'))
    expect(live).toEqual([true])
    es().emit('status', status('cc-1', 'idle'))
    es().emit('status', status('cc-1', 'running'))
    es().emit('status', status('cc-1', 'error'))
    expect(live).toEqual([true, false, true, false])
  })

  it('clears on every (re)connect, before the snapshot replays', () => {
    const { es, live } = mount()
    es().emit('status', status('cc-1', 'running'))
    es().emit('open')
    expect(live).toEqual([true, false])
  })

  it('ignores a frame about another agent and clears on unmount', () => {
    const { hook, es, live } = mount()
    es().emit('status', status('someone-else', 'running'))
    expect(live).toEqual([])
    hook.unmount()
    expect(es().closed).toBe(true)
    expect(live).toEqual([false])
  })
})
