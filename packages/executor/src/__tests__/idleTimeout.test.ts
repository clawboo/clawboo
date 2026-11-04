import { describe, expect, it, vi } from 'vitest'

import { withIdleTimeout } from '../idleTimeout'

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
    // Total elapsed (100 ms) deliberately EXCEEDS idleMs (40 ms), while every
    // individual gap (20 ms) stays under it. A total-budget implementation trips
    // here; only a per-event re-arm survives. (An earlier version of this test ran
    // 60 ms against a 200 ms window, which both implementations passed.) The gaps
    // run on a fake clock so they are exact: a real 20 ms sleep on a loaded runner
    // can oversleep past the 40 ms window and trip it.
    vi.useFakeTimers()
    try {
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
        await vi.advanceTimersByTimeAsync(20) // under idleMs individually; 5 x 20 is well over it in total
      }
      src.end()
      await consume
      expect(seen).toEqual([1, 2, 3, 4, 5])
      expect(idled).toBe(false)
    } finally {
      vi.useRealTimers()
    }
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

/** A macOS sleep under fake timers: the wall clock jumps and every timer whose
 *  delay passed fires once, on wake. (`vi.setSystemTime` would move the pending
 *  timers along with the clock, so a plain setTimeout would pass too.) */
const sleepFor = (ms: number): void =>
  (globalThis.setTimeout as unknown as { clock: { jump(ms: number): void } }).clock.jump(ms)

describe('withIdleTimeout across a machine sleep', () => {
  it('a sleep longer than the ceiling does not abort the run on wake', async () => {
    vi.useFakeTimers()
    try {
      const MIN = 60_000
      const src = manualSource<string>()
      const seen: string[] = []
      let idled = false
      const consume = (async () => {
        for await (const v of withIdleTimeout(src.iterable, {
          idleMs: 30 * MIN,
          onIdle: () => {
            idled = true
          },
        }))
          seen.push(v)
      })()
      src.push('working')
      await vi.advanceTimersByTimeAsync(5 * MIN)

      sleepFor(120 * MIN)
      await vi.advanceTimersByTimeAsync(0)
      expect(idled).toBe(false)

      // The run carries on and finishes normally.
      src.push('done')
      src.end()
      await consume
      expect(seen).toEqual(['working', 'done'])
      expect(idled).toBe(false)
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('releasing the source cannot leave a floating rejection', () => {
  it('a rejecting return() is caught, not left unhandled', async () => {
    // The `finally` releases the source with `void it.return?.(undefined)`. A
    // bare `void` attaches no rejection handler, so an iterator whose `return`
    // throws produced an unhandled rejection — which ends the process under
    // Node's default. Verified in isolation: bare void reports the rejection,
    // the `.catch` form reports none.
    const unhandled: unknown[] = []
    const onUnhandled = (e: unknown): void => {
      unhandled.push(e)
    }
    process.on('unhandledRejection', onUnhandled)
    try {
      const src: AsyncIterable<number> = {
        [Symbol.asyncIterator]: () => ({
          next: async () => ({ value: 1, done: false }),
          return: async () => {
            throw new Error('return() blew up')
          },
        }),
      }
      for await (const v of withIdleTimeout(src, { idleMs: 1_000, onIdle: () => {} })) {
        void v
        break // triggers the finally, and therefore `it.return()`
      }
      await new Promise((r) => setTimeout(r, 60))
      expect(unhandled).toEqual([])
    } finally {
      process.off('unhandledRejection', onUnhandled)
    }
  })
})

describe('a source that fails', () => {
  it('leaves no timer running after its pull rejects', async () => {
    // The pull rejects inside the race, which throws past the loop's own clear.
    vi.useFakeTimers()
    try {
      const src: AsyncIterable<number> = {
        [Symbol.asyncIterator]: () => ({
          next: () => Promise.reject(new Error('the run broke')),
        }),
      }
      const consume = async (): Promise<void> => {
        for await (const v of withIdleTimeout(src, { idleMs: 30 * 60_000, onIdle: () => {} }))
          void v
      }
      await expect(consume()).rejects.toThrow('the run broke')
      expect(vi.getTimerCount()).toBe(0)
    } finally {
      vi.useRealTimers()
    }
  })
})
