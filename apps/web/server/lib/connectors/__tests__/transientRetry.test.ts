// What may be retried, and what must never be.

import { describe, expect, it, vi } from 'vitest'

import { isTransient, retryTransient } from '../transientRetry'

const noSleep = async (): Promise<void> => {}
const withCause = (message: string, code: string): Error => {
  const e = new Error(message)
  ;(e as { cause?: unknown }).cause = Object.assign(new Error('inner'), { code })
  return e
}

describe('isTransient', () => {
  it('recognises the bare fetch failure Node reports when nothing left the machine', () => {
    expect(isTransient(new TypeError('fetch failed'))).toBe(true)
  })

  it('recognises connection-level codes on the cause chain', () => {
    for (const code of ['ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT', 'EAI_AGAIN', 'ENOTFOUND']) {
      expect(isTransient(withCause('request failed', code))).toBe(true)
    }
  })

  it('does not treat a refusal as transient', () => {
    expect(isTransient(new Error('HTTP 401 Unauthorized'))).toBe(false)
    expect(isTransient(new Error('invalid_grant'))).toBe(false)
    expect(isTransient(new Error('connector handshake failed: server rejected'))).toBe(false)
  })

  it('is false for anything that is not an Error', () => {
    expect(isTransient('fetch failed')).toBe(false)
    expect(isTransient(null)).toBe(false)
  })

  it('stops walking a cyclic cause chain', () => {
    const a = new Error('a')
    ;(a as { cause?: unknown }).cause = a
    expect(() => isTransient(a)).not.toThrow()
  })
})

describe('retryTransient', () => {
  it('returns the first success without retrying', async () => {
    const fn = vi.fn().mockResolvedValue('ok')
    await expect(retryTransient(fn, { sleep: noSleep })).resolves.toBe('ok')
    expect(fn).toHaveBeenCalledTimes(1)
  })

  it('retries a transport failure and returns the eventual success', async () => {
    const fn = vi
      .fn()
      .mockRejectedValueOnce(new TypeError('fetch failed'))
      .mockRejectedValueOnce(new TypeError('fetch failed'))
      .mockResolvedValue('ok')
    await expect(retryTransient(fn, { sleep: noSleep })).resolves.toBe('ok')
    expect(fn).toHaveBeenCalledTimes(3)
  })

  it('never repeats a request that was answered', async () => {
    // The whole safety property: a refusal arrived, so sending it again would
    // be refused identically, and a write could be applied twice.
    const fn = vi.fn().mockRejectedValue(new Error('HTTP 400 invalid_request'))
    await expect(retryTransient(fn, { sleep: noSleep })).rejects.toThrow('invalid_request')
    expect(fn).toHaveBeenCalledTimes(1)
  })

  it('gives up after the attempt budget and rethrows the last error', async () => {
    const fn = vi.fn().mockRejectedValue(new TypeError('fetch failed'))
    await expect(retryTransient(fn, { attempts: 3, sleep: noSleep })).rejects.toThrow(
      'fetch failed',
    )
    expect(fn).toHaveBeenCalledTimes(3)
  })

  it('backs off, doubling each time', async () => {
    const waits: number[] = []
    const fn = vi.fn().mockRejectedValue(new TypeError('fetch failed'))
    await expect(
      retryTransient(fn, {
        attempts: 4,
        delayMs: 100,
        sleep: async (ms) => {
          waits.push(ms)
        },
      }),
    ).rejects.toThrow()
    expect(waits).toEqual([100, 200, 400])
  })
})
