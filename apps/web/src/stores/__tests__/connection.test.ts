// `isSessionLive` is the predicate behind every app-shell overlay gate, so which
// statuses count as "inside a live session" is pinned here rather than left
// implicit at a dozen call sites.

import { beforeEach, describe, expect, it } from 'vitest'

import { isSessionLive, useConnectionStore } from '../connection'

beforeEach(() => {
  useConnectionStore.setState({ status: 'disconnected', client: null, gatewayUrl: null })
})

describe('isSessionLive', () => {
  it('treats a connected session as live', () => {
    expect(isSessionLive('connected')).toBe(true)
  })

  it('treats a dropped-but-retrying socket as STILL live', () => {
    // The whole point: the client is reconnecting on its own backoff, so the
    // workspace must stay up rather than being covered by the connect modal.
    expect(isSessionLive('reconnecting')).toBe(true)
  })

  it('does not treat pre-session or failed states as live', () => {
    expect(isSessionLive('disconnected')).toBe(false)
    expect(isSessionLive('connecting')).toBe(false)
    // Load-bearing: 'error' must keep BLOCKING, so its retry overlay can render.
    expect(isSessionLive('error')).toBe(false)
  })
})

describe('useConnectionStore', () => {
  it('starts disconnected with no client', () => {
    const s = useConnectionStore.getState()
    expect(s.status).toBe('disconnected')
    expect(s.client).toBeNull()
  })

  it('round-trips the reconnecting status', () => {
    useConnectionStore.getState().setStatus('reconnecting')
    expect(useConnectionStore.getState().status).toBe('reconnecting')
  })
})
