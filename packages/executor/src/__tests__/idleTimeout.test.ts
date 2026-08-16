import { describe, expect, it } from 'vitest'

import { withIdleTimeout } from '../idleTimeout'

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

/** An async source the test drives by hand. */
function manualSource<T>(): {
  iterable: AsyncIterable<T>
  push: (v: T) => void
  end: () => void
} {
  const queue: T[] = []
  let ended = false
  let wake: (() => void) | null = null
  return {
    push(v) {
      queue.push(v)
      wake?.()
    },
    end() {
      ended = true
      wake?.()
    },
    iterable: {
      async *[Symbol.asyncIterator]() {
        for (;;) {
          while (queue.length === 0 && !ended)
            await new Promise<void>((r) => {
              wake = r
            })
          if (queue.length > 0) yield queue.shift()!
          else return
        }
      },
    },
  }
}

describe('withIdleTimeout', () => {
  it('the window is IDLE-reset, not a total budget: a long streaming run never trips', async () => {
    // Total elapsed (~100 ms) deliberately EXCEEDS idleMs (40 ms), while every
    // individual gap (~20 ms) stays under it. A total-budget implementation trips
    // here; only a per-event re-arm survives. (An earlier version of this test ran
    // 60 ms against a 200 ms window, which both implementations passed.)
    const src = manualSource<number>()
    const seen: number[] = []
    let idled = false
    const consume = (async () => {
      for await (const v of withIdleTimeout(src.iterable, {
        idleMs: 40,
        onIdle: () => {
          idled = true
        },
      }))
        seen.push(v)
    })()
    for (const v of [1, 2, 3, 4, 5]) {
      src.push(v)
      await sleep(20) // under idleMs individually; 5 x 20 is well over it in total
    }
    src.end()
    await consume
    expect(seen).toEqual([1, 2, 3, 4, 5])
    expect(idled).toBe(false)
  })

  it('fires onIdle on silence, then the grace window delivers the terminal', async () => {
    const src = manualSource<string>()
    const seen: string[] = []
    let idled = false
    const consume = (async () => {
      for await (const v of withIdleTimeout(src.iterable, {
        idleMs: 60,
        graceMs: 300,
        onIdle: () => {
          idled = true
          // The "abort" makes the adapter surface its terminal shortly after.
          setTimeout(() => {
            src.push('done:aborted')
            src.end()
          }, 30)
        },
      }))
        seen.push(v)
    })()
    src.push('text')
    await consume
    expect(idled).toBe(true)
    expect(seen).toEqual(['text', 'done:aborted'])
  })

  it('a source silent through the grace too is force-ended', async () => {
    const src = manualSource<string>()
    const seen: string[] = []
    let idled = false
    const consume = (async () => {
      for await (const v of withIdleTimeout(src.iterable, {
        idleMs: 50,
        graceMs: 50,
        onIdle: () => {
          idled = true // abort goes nowhere — the adapter is truly wedged
        },
      }))
        seen.push(v)
    })()
    await consume
    expect(idled).toBe(true)
    expect(seen).toEqual([])
  })
})
