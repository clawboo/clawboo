// The stale-response race.
//
// Connecting a connector fires a refresh while an earlier one is still in
// flight. If the earlier response lands second, it restores the pre-connect
// snapshot and the card goes back to offering Connect for something that is
// already running. Nothing about that is visible in ordinary use until the
// network is slow, which is exactly when a user is most likely to click twice.

import { act, renderHook, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { useConnectorCostState } from '../useConnectorCostState'

const realFetch = globalThis.fetch
afterEach(() => {
  globalThis.fetch = realFetch
  vi.restoreAllMocks()
})

/** Defer each /api/connectors response until the test releases it. */
function deferredLiveFetch(): {
  release: (index: number, slugs: string[]) => void
  calls: () => number
} {
  const resolvers: ((slugs: string[]) => void)[] = []
  globalThis.fetch = ((input: RequestInfo | URL) => {
    const url = String(input)
    if (url.includes('/api/connectors/configured')) {
      return Promise.resolve(new Response(JSON.stringify({ slugs: [] }), { status: 200 }))
    }
    // MATCHED BEFORE THE CATCH-ALL BELOW. The hook now makes a third read, for
    // apps a broker reports as connected, and its URL also starts
    // `/api/connectors`. Letting it fall through counted it as a liveness call
    // and every gate assertion here was out by one.
    if (url.includes('/api/connectors/brokered')) {
      return Promise.resolve(new Response(JSON.stringify({ connected: [] }), { status: 200 }))
    }
    if (url.includes('/api/connectors')) {
      return new Promise<Response>((resolve) => {
        resolvers.push((slugs) =>
          resolve(
            new Response(JSON.stringify({ connectors: slugs.map((slug) => ({ slug })) }), {
              status: 200,
            }),
          ),
        )
      })
    }
    return Promise.resolve(new Response('{}', { status: 200 }))
  }) as typeof fetch
  return {
    release: (index, slugs) => resolvers[index]?.(slugs),
    calls: () => resolvers.length,
  }
}

describe('useConnectorCostState refresh ordering', () => {
  it('ignores an in-flight response that resolves after a newer refresh', async () => {
    const gate = deferredLiveFetch()
    const { result } = renderHook(() => useConnectorCostState())
    await waitFor(() => expect(gate.calls()).toBe(1))

    // A second refresh starts before the first has answered.
    act(() => {
      result.current.refresh()
    })
    await waitFor(() => expect(gate.calls()).toBe(2))

    // The NEWER one answers first, reporting linear as live.
    await act(async () => {
      gate.release(1, ['linear'])
    })
    await waitFor(() => expect(result.current.isLive('linear')).toBe(true))

    // The STALE one answers second with the older, empty snapshot. It must not
    // win: without the generation guard this reverted linear to not-live.
    await act(async () => {
      gate.release(0, [])
    })
    await new Promise((r) => setTimeout(r, 10))
    expect(result.current.isLive('linear')).toBe(true)
  })
})
