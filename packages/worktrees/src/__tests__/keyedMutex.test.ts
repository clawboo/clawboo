import { describe, expect, it } from 'vitest'

import { KeyedMutex, MutexAcquireTimeoutError } from '../git'

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

describe('KeyedMutex', () => {
  it('serializes same-key ops; different keys run concurrently', async () => {
    const m = new KeyedMutex()
    const order: string[] = []
    const a = m.run('k1', async () => {
      order.push('a-start')
      await sleep(40)
      order.push('a-end')
    })
    const b = m.run('k1', async () => {
      order.push('b-start')
    })
    const c = m.run('k2', async () => {
      order.push('c-start')
    })
    await Promise.all([a, b, c])
    // b waited for a; c (other key) did not.
    expect(order.indexOf('b-start')).toBeGreaterThan(order.indexOf('a-end'))
    expect(order.indexOf('c-start')).toBeLessThan(order.indexOf('a-end'))
  })

  it('a waiter behind a wedged holder rejects at its acquire timeout', async () => {
    const m = new KeyedMutex()
    let release!: () => void
    void m.run('k', () => new Promise<void>((r) => (release = r))) // the wedged holder
    await expect(m.run('k', async () => 'ran', { acquireTimeoutMs: 50 })).rejects.toBeInstanceOf(
      MutexAcquireTimeoutError,
    )
    release()
  })

  it('a timed-out waiter does NOT let the next caller run beside the holder', async () => {
    const m = new KeyedMutex()
    const order: string[] = []
    let release!: () => void
    void m.run('k', () => {
      order.push('holder-start')
      return new Promise<void>((r) => (release = r))
    })
    await m.run('k', async () => undefined, { acquireTimeoutMs: 40 }).catch(() => undefined)
    const third = m.run('k', async () => {
      order.push('third-ran')
    })
    // The holder still holds the key: the third caller must wait for it.
    await sleep(60)
    expect(order).toEqual(['holder-start'])
    release()
    await third
    expect(order).toEqual(['holder-start', 'third-ran'])
  })

  it('acquire succeeds normally when the holder releases in time', async () => {
    const m = new KeyedMutex()
    void m.run('k', () => sleep(20))
    await expect(m.run('k', async () => 'ran', { acquireTimeoutMs: 500 })).resolves.toBe('ran')
  })
})
