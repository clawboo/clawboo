// A live tail that the browser gave up on comes back.
//
// EventSource reconnects by itself after a dropped connection, but an HTTP
// error (a proxy's 502 while the server restarts) closes it for good. The app's
// one global tail feeds the fleet's live status and the browser alerts, so a
// tail that stays closed silently switches both off. The hook opens a fresh
// stream a little later, from the last seq it saw, and leaves the browser's
// own reconnects alone.

import { act, cleanup, renderHook, waitFor } from '@testing-library/react'
import { http, HttpResponse } from 'msw'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { server } from '@/__vitest__/mswServer'

import { STREAM_REOPEN_MS, useObsStream } from '../useObsStream'

class FakeEventSource {
  static readonly CONNECTING = 0
  static readonly OPEN = 1
  static readonly CLOSED = 2
  static instances: FakeEventSource[] = []
  readyState = FakeEventSource.CONNECTING
  onopen: (() => void) | null = null
  onerror: (() => void) | null = null
  onmessage: ((e: { data: string }) => void) | null = null
  constructor(public url: string) {
    FakeEventSource.instances.push(this)
  }
  close(): void {
    this.readyState = FakeEventSource.CLOSED
  }
}

const row = (seq: number) => ({
  id: `e${seq}`,
  seq,
  ts: seq,
  kind: 'status_changed',
  teamId: null,
  taskId: 't1',
  agentId: null,
  runtime: null,
  traceId: null,
  data: '{}',
})

beforeEach(() => {
  FakeEventSource.instances = []
  vi.stubGlobal('EventSource', FakeEventSource)
  server.use(http.get('/api/obs/events', () => HttpResponse.json({ events: [row(3)] })))
})

afterEach(() => {
  cleanup()
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

async function openTail() {
  const hook = renderHook(() => useObsStream({}, { limit: 10 }))
  await waitFor(() => expect(FakeEventSource.instances).toHaveLength(1))
  const first = FakeEventSource.instances[0]!
  expect(first.url).toContain('since=3')
  act(() => {
    first.readyState = FakeEventSource.OPEN
    first.onopen?.()
    first.onmessage?.({ data: JSON.stringify(row(4)) })
  })
  return { hook, first }
}

describe('useObsStream', () => {
  it('opens a new stream from the last seq after the browser closes one', async () => {
    const { hook, first } = await openTail()
    expect(hook.result.current.live).toBe(true)
    vi.useFakeTimers()

    act(() => {
      first.readyState = FakeEventSource.CLOSED
      first.onerror?.()
    })
    expect(hook.result.current.live).toBe(false)
    expect(FakeEventSource.instances).toHaveLength(1)

    act(() => {
      vi.advanceTimersByTime(STREAM_REOPEN_MS)
    })
    expect(FakeEventSource.instances).toHaveLength(2)
    expect(FakeEventSource.instances[1]!.url).toContain('since=4')
  })

  it("leaves the browser's own reconnect alone", async () => {
    const { first } = await openTail()
    vi.useFakeTimers()
    act(() => {
      first.readyState = FakeEventSource.CONNECTING
      first.onerror?.()
      vi.advanceTimersByTime(STREAM_REOPEN_MS * 2)
    })
    expect(FakeEventSource.instances).toHaveLength(1)
  })

  it('does not reopen after the host has gone', async () => {
    const { hook, first } = await openTail()
    vi.useFakeTimers()
    act(() => {
      first.readyState = FakeEventSource.CLOSED
      first.onerror?.()
    })
    hook.unmount()
    act(() => {
      vi.advanceTimersByTime(STREAM_REOPEN_MS * 2)
    })
    expect(FakeEventSource.instances).toHaveLength(1)
  })
})
