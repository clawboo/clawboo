// The dashboard watches every control-plane response for the access gate's
// refusal, so a tab whose sign-in lapses (a restarted server with a new token,
// a cleared cookie) shows the locked screen instead of failing read after read.

import { afterEach, describe, expect, it, vi } from 'vitest'

import { apiFetch, resetControlClient, setResponseObserver } from '../index'

afterEach(() => {
  resetControlClient()
  vi.restoreAllMocks()
})

function stubFetch(status: number): void {
  globalThis.fetch = vi.fn(async () => ({ status, ok: status < 400 })) as unknown as typeof fetch
}

describe('setResponseObserver', () => {
  it('sees every apiFetch response before the caller does', async () => {
    stubFetch(401)
    const seen: number[] = []
    setResponseObserver((res) => seen.push(res.status))
    const res = await apiFetch('/api/teams')
    expect(res.status).toBe(401)
    expect(seen).toEqual([401])
  })

  it('is cleared by passing null, and by resetControlClient', async () => {
    stubFetch(200)
    const seen: number[] = []
    setResponseObserver((res) => seen.push(res.status))
    setResponseObserver(null)
    await apiFetch('/api/teams')
    setResponseObserver((res) => seen.push(res.status))
    resetControlClient()
    await apiFetch('/api/teams')
    expect(seen).toEqual([])
  })

  it('still works with a fetch that hands back a value, not a promise', async () => {
    // Tests across the app stub fetch this way; apiFetch used to pass it through.
    globalThis.fetch = vi.fn(() => ({ status: 200, ok: true })) as unknown as typeof fetch
    const seen: number[] = []
    setResponseObserver((res) => seen.push(res.status))
    expect((await apiFetch('/api/teams')).status).toBe(200)
    expect(seen).toEqual([200])
  })

  it('never breaks the request when the observer throws', async () => {
    stubFetch(200)
    setResponseObserver(() => {
      throw new Error('observer bug')
    })
    expect((await apiFetch('/api/teams')).status).toBe(200)
  })
})
