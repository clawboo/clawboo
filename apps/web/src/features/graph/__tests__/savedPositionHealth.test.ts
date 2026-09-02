// The predicate that decides whether the canvas remembers where you put things.
//
// The case worth pinning hardest is the spawn: a node arriving with a position
// already recorded must NOT look like a stale blob, because treating it as one
// re-solved the entire canvas and made every node jump on every spawn.

import { describe, expect, it } from 'vitest'

import { judgeSavedPositions } from '../savedPositionHealth'

const n = (...ids: string[]) => ids.map((id) => ({ id }))
const at = (x: number, y: number) => ({ x, y })

describe('judgeSavedPositions', () => {
  it('uses a blob that covers every Boo', () => {
    const v = judgeSavedPositions(
      n('boo-a', 'boo-b'),
      { 'boo-a': at(0, 0), 'boo-b': at(100, 0) },
      false,
    )
    expect(v).toEqual({ usable: true, reason: null })
  })

  it('lays out from scratch when NOTHING is saved — that is a first layout, not a stale blob', () => {
    expect(judgeSavedPositions(n('boo-a', 'boo-b'), {}, false)).toEqual({
      usable: true,
      reason: null,
    })
  })

  it('rejects a blob that covers some Boos but not others', () => {
    // The real case: a blob written before Boo Zero existed. Without this the
    // uncovered Boos would pile on the origin.
    const v = judgeSavedPositions(n('boo-a', 'boo-b'), { 'boo-a': at(0, 0) }, false)
    expect(v).toEqual({ usable: false, reason: 'partial-coverage' })
  })

  it('KEEPS the blob when a spawned node arrives with its position already recorded', () => {
    // THE REGRESSION THIS FILE EXISTS FOR. `boo-new` is the node just dropped;
    // spawnNode.ts writes its position before the rebuild lands. Coverage is
    // therefore complete and every hand-placed position survives.
    const v = judgeSavedPositions(
      n('boo-a', 'boo-b', 'boo-new'),
      { 'boo-a': at(0, 0), 'boo-b': at(100, 0), 'boo-new': at(240, 60) },
      false,
    )
    expect(v).toEqual({ usable: true, reason: null })
  })

  it('would have thrown the whole blob away if the spawn had NOT recorded its position', () => {
    // The old behaviour, kept as a test so the fix cannot silently regress:
    // the same three nodes with the new one unplaced is partial coverage.
    const v = judgeSavedPositions(
      n('boo-a', 'boo-b', 'boo-new'),
      { 'boo-a': at(0, 0), 'boo-b': at(100, 0) },
      false,
    )
    expect(v.usable).toBe(false)
  })

  it('honours an explicit re-layout over everything else', () => {
    const v = judgeSavedPositions(n('boo-a'), { 'boo-a': at(0, 0) }, true)
    expect(v).toEqual({ usable: false, reason: 'requested' })
  })

  it('rejects a runaway span from the old compounding-stretch bug', () => {
    const v = judgeSavedPositions(
      n('boo-a', 'boo-b'),
      { 'boo-a': at(0, 0), 'boo-b': at(9000, 0) },
      false,
    )
    expect(v).toEqual({ usable: false, reason: 'runaway-span' })
  })

  it('does not call a single saved node a runaway span', () => {
    // One point has no span. The old code guarded on >= 2 and this keeps that.
    const v = judgeSavedPositions(n('boo-a'), { 'boo-a': at(99999, 99999) }, false)
    expect(v.usable).toBe(true)
  })
})
