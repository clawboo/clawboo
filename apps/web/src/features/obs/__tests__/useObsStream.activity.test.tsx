// The tail also says when the board's record of task changes moves, for a client
// that asks: one more reason not to poll. A write that leaves no event row (an
// agent's comment through its task tool) still reaches the badge this way.

import { act, cleanup, renderHook, waitFor } from '@testing-library/react'
import { http, HttpResponse } from 'msw'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { server } from '@/__vitest__/mswServer'

import { useObsStream } from '../useObsStream'

type Listener = (e: { data: string }) => void

class FakeEventSource {
  static readonly CONNECTING = 0
  static readonly OPEN = 1
  static readonly CLOSED = 2
  static instances: FakeEventSource[] = []
  readyState = FakeEventSource.CONNECTING
  onopen: (() => void) | null = null
  onerror: (() => void) | null = null
  onmessage: Listener | null = null
  listeners = new Map<string, Listener>()
  constructor(public url: string) {
    FakeEventSource.instances.push(this)
  }
  addEventListener(name: string, fn: Listener): void {
    this.listeners.set(name, fn)
  }
  close(): void {
    this.readyState = FakeEventSource.CLOSED
  }
}

beforeEach(() => {
  FakeEventSource.instances = []
  vi.stubGlobal('EventSource', FakeEventSource)
  server.use(http.get('/api/obs/events', () => HttpResponse.json({ events: [] })))
})
afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

async function open(activity: boolean) {
  const hook = renderHook(() => useObsStream({}, { limit: 10, activity }))
  await waitFor(() => expect(FakeEventSource.instances).toHaveLength(1))
  return { hook, es: FakeEventSource.instances[0]! }
}

describe('useObsStream: board activity', () => {
  it('asks for it and reports the newest position', async () => {
    const { hook, es } = await open(true)
    expect(es.url).toContain('activity=1')
    expect(hook.result.current.boardActivity).toBeNull()

    act(() => es.listeners.get('activity')?.({ data: JSON.stringify({ seq: 41, read: 7 }) }))
    expect(hook.result.current.boardActivity).toEqual({ seq: 41, read: 7 })
    act(() => es.listeners.get('activity')?.({ data: JSON.stringify({ seq: 42, read: 7 }) }))
    expect(hook.result.current.boardActivity).toEqual({ seq: 42, read: 7 })
  })

  it('ignores a malformed frame', async () => {
    const { hook, es } = await open(true)
    act(() => es.listeners.get('activity')?.({ data: 'not json' }))
    act(() => es.listeners.get('activity')?.({ data: JSON.stringify({ seq: 'x', read: 1 }) }))
    act(() => es.listeners.get('activity')?.({ data: JSON.stringify({ seq: 1 }) }))
    expect(hook.result.current.boardActivity).toBeNull()
  })

  it('does not change a stream that did not ask', async () => {
    const { es } = await open(false)
    expect(es.url).not.toContain('activity')
    expect(es.listeners.size).toBe(0)
  })
})
