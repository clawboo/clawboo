// The 1:1 stream's turn state. The server brackets every 1:1 turn with `running`
// and `idle`/`error` status frames, and the composer stays on Stop between them.
// That is what keeps it closed through a Hermes reply (one piece, at the end) or a
// long Claude Code tool call (no text for minutes). A (re)connect clears it before
// the server replays its snapshot, so a turn that ended while the stream was down
// cannot leave the composer stuck.

import { cleanup, renderHook } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'

import { useChatHandOffStore } from '@/stores/chatHandOffs'
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

describe('useNativeAgentChatStream: the cards of its hand-offs', () => {
  it('puts a board frame in the store, under this agent, with its team', () => {
    useChatHandOffStore.setState({ tasksByAgent: new Map() })
    const { es } = mount()
    es().emit(
      'board',
      JSON.stringify({
        id: 't1',
        title: 'fix the parser',
        status: 'in_progress',
        teamId: 'team-1',
        createdAt: 5,
        updatedAt: 6,
      }),
    )
    const task = useChatHandOffStore.getState().tasksByAgent.get('cc-1')?.get('t1')
    expect(task?.status).toBe('in_progress')
    expect(task?.teamId).toBe('team-1')
  })

  it('does not take a card moving for a turn of this agent', () => {
    const activity: number[] = []
    const sources: FakeEventSource[] = []
    renderHook(() =>
      useNativeAgentChatStream({
        agentId: 'cc-1',
        enabled: true,
        onActivity: () => activity.push(1),
        eventSourceFactory: (url) => {
          const es = new FakeEventSource(url)
          sources.push(es)
          return es as unknown as EventSource
        },
      }),
    )
    sources[0]!.emit('board', JSON.stringify({ id: 't1', status: 'done', updatedAt: 9 }))
    expect(activity).toEqual([])
  })

  it('a stale frame does not move a card back', () => {
    useChatHandOffStore.setState({ tasksByAgent: new Map() })
    const { es } = mount()
    es().emit('board', JSON.stringify({ id: 't1', status: 'done', updatedAt: 9 }))
    es().emit('board', JSON.stringify({ id: 't1', status: 'in_progress', updatedAt: 5 }))
    expect(useChatHandOffStore.getState().tasksByAgent.get('cc-1')?.get('t1')?.status).toBe('done')
  })
})

describe('useNativeAgentChatStream: whether this chat hands off', () => {
  it("takes the server's word, per agent, and it can change", () => {
    useChatHandOffStore.setState({ handsOffByAgent: new Map() })
    const { es } = mount()
    expect(useChatHandOffStore.getState().handsOffByAgent.get('cc-1')).toBeUndefined()
    es().emit('handOffs', JSON.stringify({ on: true }))
    expect(useChatHandOffStore.getState().handsOffByAgent.get('cc-1')).toBe(true)
    es().emit('handOffs', JSON.stringify({ on: false }))
    expect(useChatHandOffStore.getState().handsOffByAgent.get('cc-1')).toBe(false)
  })

  it('is no turn of the agent, for the composer', () => {
    const activity: number[] = []
    const sources: FakeEventSource[] = []
    renderHook(() =>
      useNativeAgentChatStream({
        agentId: 'cc-1',
        enabled: true,
        onActivity: () => activity.push(1),
        eventSourceFactory: (url) => {
          const es = new FakeEventSource(url)
          sources.push(es)
          return es as unknown as EventSource
        },
      }),
    )
    sources[0]!.emit('handOffs', JSON.stringify({ on: true }))
    expect(activity).toEqual([])
  })
})
