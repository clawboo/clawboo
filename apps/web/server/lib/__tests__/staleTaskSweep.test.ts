// The board's stale-task sweep after the machine sleeps. Every live drain's last
// beat predates the sleep, so a pass that judged rows by wall-clock age alone
// would release every running task on wake. The pass widens its TTL by the slept
// time until the drains have had one TTL to beat again.

import { describe, expect, it } from 'vitest'

import { createStaleTaskSweep } from '../staleTaskSweep'

const MIN = 60_000
const TTL = 3 * MIN
const INTERVAL = MIN

function harness() {
  let clock = 1_000_000
  const cutoffs: number[] = []
  const pass = createStaleTaskSweep({
    ttlMs: TTL,
    intervalMs: INTERVAL,
    now: () => clock,
    reconcile: (olderThanMs) => {
      cutoffs.push(olderThanMs)
      return 0
    },
  })
  return {
    cutoffs,
    /** The interval runs the pass every INTERVAL for `ms`. */
    awake(ms: number): void {
      for (let t = 0; t < ms; t += INTERVAL) {
        clock += INTERVAL
        pass()
      }
    },
    sleep(ms: number): void {
      clock += ms
    },
    boot(): void {
      pass()
    },
  }
}

describe('createStaleTaskSweep', () => {
  it('judges rows by the TTL while the machine stays awake', () => {
    const h = harness()
    h.boot()
    h.awake(5 * MIN)
    expect(h.cutoffs).toEqual(Array(6).fill(TTL))
  })

  it('after a sleep, allows for the slept time for one TTL, then returns to normal', () => {
    const h = harness()
    h.boot()
    h.awake(2 * MIN)
    h.cutoffs.length = 0

    h.sleep(40 * MIN)
    h.awake(TTL + INTERVAL)

    // The first pass on wake and the ones within a TTL of it allow for the
    // 40 minutes asleep; the pass a TTL after the wake is back to normal.
    expect(h.cutoffs.slice(0, 3)).toEqual([TTL + 40 * MIN, TTL + 40 * MIN, TTL + 40 * MIN])
    expect(h.cutoffs.slice(3)).toEqual([TTL])
  })

  it('a second sleep inside the window adds to the first', () => {
    const h = harness()
    h.boot()
    h.awake(2 * MIN)
    h.sleep(20 * MIN)
    h.awake(INTERVAL)
    h.sleep(30 * MIN)
    h.awake(INTERVAL)
    expect(h.cutoffs.at(-1)).toBe(TTL + 50 * MIN)
  })
})
