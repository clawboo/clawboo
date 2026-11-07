import { describe, expect, it, vi } from 'vitest'

import { createNudgeQueue } from '../nudgeQueue'

/** A macOS sleep under fake timers: the wall clock jumps and every timer whose
 *  delay passed fires once, on wake. (`vi.setSystemTime` would move the pending
 *  timers along with the clock, so a plain setTimeout would pass too.) */
const sleepFor = (ms: number): void =>
  (globalThis.setTimeout as unknown as { clock: { jump(ms: number): void } }).clock.jump(ms)

describe('createNudgeQueue', () => {
  it('delivers immediately when the session is idle', async () => {
    const nq = createNudgeQueue()
    const sent: string[] = []
    await nq.deliver('s1', async () => {
      sent.push('a')
    })
    expect(sent).toEqual(['a'])
  })

  it('queues a second deliver to a busy session (no concurrent run) and flushes on idle', async () => {
    const nq = createNudgeQueue()
    const sent: string[] = []
    // First deliver marks s1 busy synchronously (before its await resolves).
    const p1 = nq.deliver('s1', async () => {
      sent.push('a')
    })
    // Second deliver in the same tick sees busy → queued, NOT sent (this is the
    // guard against starting a second run on a mid-turn session).
    const p2 = nq.deliver('s1', async () => {
      sent.push('b')
    })
    await Promise.all([p1, p2])
    expect(sent).toEqual(['a'])
    // Turn boundary → flush the queued one.
    nq.markIdle('s1')
    expect(sent).toEqual(['a', 'b'])
  })

  it('tells the sender when a queued send fails, however it fails, but not an immediate one', async () => {
    const nq = createNudgeQueue()
    const failed: unknown[] = []
    const onQueuedFailure = (err: unknown): void => {
      failed.push(err)
    }
    // Immediate: the caller hears the rejection itself.
    await expect(
      nq.deliver('s0', async () => Promise.reject(new Error('now')), { onQueuedFailure }),
    ).rejects.toThrow('now')
    expect(failed).toEqual([])

    nq.markBusy('s1')
    await nq.deliver('s1', async () => Promise.reject(new Error('rejected')), { onQueuedFailure })
    await nq.deliver(
      's1',
      () => {
        throw new Error('threw while setting up')
      },
      { onQueuedFailure },
    )
    nq.markIdle('s1')
    await new Promise((r) => setImmediate(r))
    nq.markIdle('s1')
    await new Promise((r) => setImmediate(r))

    expect(failed.map((e) => (e as Error).message)).toEqual(['rejected', 'threw while setting up'])
  })

  it('isBusy reports a run in flight and a send queued behind it, until both are done', async () => {
    const nq = createNudgeQueue()
    expect(nq.isBusy('s1')).toBe(false)
    await nq.deliver('s1', async () => undefined)
    expect(nq.isBusy('s1')).toBe(true) // the first run has not reported its boundary
    await nq.deliver('s1', async () => undefined) // queued behind it
    nq.markIdle('s1') // first run ends; the queued send starts
    expect(nq.isBusy('s1')).toBe(true)
    nq.markIdle('s1') // second run ends
    expect(nq.isBusy('s1')).toBe(false)
    expect(nq.isBusy('s2')).toBe(false)
  })

  it('does not block delivery across different sessions', async () => {
    const nq = createNudgeQueue()
    const sent: string[] = []
    const p1 = nq.deliver('s1', async () => {
      sent.push('s1')
    })
    const p2 = nq.deliver('s2', async () => {
      sent.push('s2')
    })
    await Promise.all([p1, p2])
    expect([...sent].sort()).toEqual(['s1', 's2'])
  })

  it('reset clears the busy set + queued sends', async () => {
    const nq = createNudgeQueue()
    const sent: string[] = []
    await nq.deliver('s1', async () => {
      sent.push('a')
    }) // s1 busy now
    void nq.deliver('s1', async () => {
      sent.push('b')
    }) // queued
    nq.reset()
    nq.markIdle('s1') // queue was cleared by reset → nothing flushes
    expect(sent).toEqual(['a'])
    // After reset s1 is idle → delivers immediately again.
    await nq.deliver('s1', async () => {
      sent.push('c')
    })
    expect(sent).toEqual(['a', 'c'])
  })

  it('drain FIRES queued sends before clearing (teardown must not drop a busy-session reflection)', async () => {
    const nq = createNudgeQueue()
    const sent: string[] = []
    await nq.deliver('s1', async () => {
      sent.push('a')
    }) // s1 busy
    void nq.deliver('s1', async () => {
      sent.push('b')
    }) // queued — its turn boundary will never come (teardown)
    nq.drain()
    // Allow the fire-and-forget queued send's microtask to run.
    await Promise.resolve()
    await Promise.resolve()
    expect(sent).toEqual(['a', 'b'])
  })

  it('a queued send that never started frees the session and the next queued send goes', async () => {
    const nq = createNudgeQueue()
    const sent: string[] = []
    await nq.deliver('s1', async () => {
      sent.push('a')
    }) // s1 busy
    void nq.deliver('s1', async () => {
      throw new Error('refused before it started')
    })
    void nq.deliver('s1', async () => {
      sent.push('c')
    })
    nq.markIdle('s1') // a ends; the refused send flushes and rejects
    await new Promise((r) => setTimeout(r, 0))
    expect(sent).toEqual(['a', 'c'])
    nq.markIdle('s1') // c ends
    expect(nq.isBusy('s1')).toBe(false)
  })

  it('a queued send that rejects after a reset leaves the new owner of the session alone', async () => {
    const nq = createNudgeQueue()
    let reject: (err: Error) => void = () => undefined
    await nq.deliver('s1', async () => undefined) // s1 busy
    void nq.deliver(
      's1',
      () =>
        new Promise<void>((_resolve, rej) => {
          reject = rej
        }),
    )
    nq.markIdle('s1') // the queued send starts and waits
    nq.reset() // a Stop
    await nq.deliver('s1', async () => undefined) // delivered after the Stop, now running
    reject(new Error('refused'))
    await new Promise((r) => setTimeout(r, 0))
    expect(nq.isBusy('s1')).toBe(true)
  })

  it('onWedge fires before the wedge force-idles (abort the stale run before a second starts)', async () => {
    const order: string[] = []
    const nq = createNudgeQueue({
      wedgeTimeoutMs: 5,
      onWedge: (sk) => {
        order.push(`wedge:${sk}`)
      },
    })
    // s1 busy; a queued send that would otherwise start a SECOND run on wedge.
    await nq.deliver('s1', async () => {
      order.push('run1')
    })
    void nq.deliver('s1', async () => {
      order.push('run2-after-abort')
    })
    // Wait out the wedge timeout.
    await new Promise((r) => setTimeout(r, 12))
    await Promise.resolve()
    // onWedge (abort) ran BEFORE the queued send flushed.
    expect(order[0]).toBe('run1')
    expect(order.indexOf('wedge:s1')).toBeLessThan(order.indexOf('run2-after-abort'))
  })

  it('a machine that slept past the wedge timeout does not wedge the session on wake', async () => {
    vi.useFakeTimers()
    try {
      const wedged: string[] = []
      const nq = createNudgeQueue({ onWedge: (sk) => void wedged.push(sk) })
      await nq.deliver('s1', async () => {})
      vi.advanceTimersByTime(2 * 60_000)

      sleepFor(60 * 60_000)
      expect(wedged).toEqual([])
      expect(nq.isBusy('s1')).toBe(true)

      // A session that stays silent is still force-idled in awake time.
      vi.advanceTimersByTime(10 * 60_000)
      expect(wedged).toEqual(['s1'])
      expect(nq.isBusy('s1')).toBe(false)
    } finally {
      vi.useRealTimers()
    }
  })

  it('puts a person ahead of what is queued, and behind anyone else a person is waiting on', async () => {
    const q = createNudgeQueue()
    const order: string[] = []
    const send = (name: string) => async (): Promise<void> => {
      order.push(name)
    }
    await q.deliver('s', send('running'))
    await q.deliver('s', send('update 1'))
    await q.deliver('s', send('update 2'))
    await q.deliver('s', send('person 1'), { ahead: true })
    await q.deliver('s', send('person 2'), { ahead: true })
    for (let i = 0; i < 4; i += 1) await q.markIdle('s')
    expect(order).toEqual(['running', 'person 1', 'person 2', 'update 1', 'update 2'])
  })
})
