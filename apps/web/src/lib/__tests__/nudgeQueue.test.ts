import { describe, expect, it } from 'vitest'

import { createNudgeQueue } from '../nudgeQueue'

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
})
