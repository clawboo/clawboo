import { describe, it, expect, beforeEach } from 'vitest'
import { nextSeq, _resetSeqForTest } from '../sequenceKey'

describe('sequenceKey — monotonic counter', () => {
  beforeEach(() => {
    _resetSeqForTest()
  })

  it('returns >= 1 on the first call from a fresh module', () => {
    expect(nextSeq()).toBe(1)
  })

  it('is strictly increasing across rapid calls', () => {
    const values: number[] = []
    for (let i = 0; i < 100; i++) values.push(nextSeq())
    for (let i = 1; i < values.length; i++) {
      expect(values[i]!).toBeGreaterThan(values[i - 1]!)
    }
  })

  // The whole point of this counter — `Date.now()` collisions are routine
  // when the runtime-chat handler emits multiple lines from a single batch
  // (`appendOutputLines`), or when two agents reply within the same ms.
  // The counter has no relationship to wall-clock time, so it doesn't care.
  it('produces unique values even when called within the same millisecond', () => {
    const before = Date.now()
    const values = [nextSeq(), nextSeq(), nextSeq(), nextSeq(), nextSeq()]
    const after = Date.now()
    // Sanity: the calls really did happen in a tight burst
    expect(after - before).toBeLessThan(20)
    // Each value is unique
    expect(new Set(values).size).toBe(values.length)
    // And strictly increasing
    expect(values).toEqual([...values].sort((a, b) => a - b))
  })

  it('_resetSeqForTest restores the counter to zero', () => {
    nextSeq()
    nextSeq()
    nextSeq()
    expect(nextSeq()).toBe(4)
    _resetSeqForTest()
    expect(nextSeq()).toBe(1)
  })
})
