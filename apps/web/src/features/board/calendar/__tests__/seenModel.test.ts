import { describe, expect, it } from 'vitest'

import {
  absorb,
  acknowledge,
  dottedIds,
  markAllSeen,
  noteRead,
  readSeen,
  SEEN_KINDS,
  seenKindOf,
  seenSummary,
  summaryParts,
  WATCH_GAP_MS,
  type SeenKind,
  type SeenRecord,
} from '../seenModel'

const T0 = 1_760_000_000_000

/** A read of the board from `id: column` pairs. */
const board = (cols: Record<string, string>) =>
  Object.entries(cols).map(([id, column]) => ({ id, column }))

/** A record with these columns and pending items, taken at T0 while watching. */
const rec = (
  columns: Record<string, string>,
  items: Record<string, SeenKind> | null = null,
  since = T0 - 60_000,
): SeenRecord => ({
  v: 1,
  at: T0,
  watching: true,
  columns,
  pending: items ? { since, items } : null,
})

/** A deep copy, to prove a function left its input alone. */
const snapshot = (r: SeenRecord): SeenRecord => JSON.parse(JSON.stringify(r)) as SeenRecord

describe('seenKindOf', () => {
  it('is null when the column did not change', () => {
    expect(seenKindOf('todo', 'todo')).toBeNull()
  })

  it('names a task that was not in the snapshot', () => {
    expect(seenKindOf(undefined, 'done')).toBe('done')
    expect(seenKindOf(undefined, 'cancelled')).toBe('cancelled')
    expect(seenKindOf(undefined, 'needs_you')).toBe('needs_you')
    expect(seenKindOf(undefined, 'todo')).toBe('new')
    expect(seenKindOf(undefined, 'in_progress')).toBe('new')
  })

  it('names a task that changed column', () => {
    expect(seenKindOf('in_progress', 'done')).toBe('done')
    expect(seenKindOf('todo', 'in_progress')).toBe('started')
    expect(seenKindOf('in_progress', 'needs_you')).toBe('needs_you')
    expect(seenKindOf('todo', 'cancelled')).toBe('cancelled')
    expect(seenKindOf('todo', 'backlog')).toBe('moved')
    expect(seenKindOf('done', 'somewhere_else')).toBe('moved')
  })
})

describe('noteRead', () => {
  it('takes the first read as seen: a snapshot and nothing pending', () => {
    const r = noteRead(null, board({ a: 'todo', b: 'done' }), T0, false)
    expect(r).toEqual({
      v: 1,
      at: T0,
      watching: false,
      columns: { a: 'todo', b: 'done' },
      pending: null,
    })
  })

  it('absorbs changes the person watched happen', () => {
    const first = noteRead(null, board({ a: 'todo', b: 'todo' }), T0, true)
    const next = noteRead(first, board({ a: 'in_progress', b: 'done', c: 'todo' }), T0 + 5000, true)
    expect(next.pending).toBeNull()
    expect(next.columns).toEqual({ a: 'in_progress', b: 'done', c: 'todo' })
    expect(next.at).toBe(T0 + 5000)
    expect(next.watching).toBe(true)
  })

  it('marks each kind of change made while the person was away', () => {
    const first = noteRead(
      null,
      board({ d: 'in_progress', s: 'todo', n: 'todo', c: 'todo', m: 'todo', same: 'todo' }),
      T0,
      true,
    )
    const away = noteRead(
      first,
      board({
        d: 'done',
        s: 'in_progress',
        n: 'needs_you',
        c: 'cancelled',
        m: 'backlog',
        same: 'todo',
        fresh: 'todo',
      }),
      T0 + 3_600_000,
      true,
    )
    expect(away.pending).toEqual({
      since: T0,
      items: {
        d: 'done',
        s: 'started',
        n: 'needs_you',
        c: 'cancelled',
        m: 'moved',
        fresh: 'new',
      },
    })
  })

  it('keeps the first catch-up time across several away reads', () => {
    let r = noteRead(null, board({ a: 'todo', b: 'todo' }), T0, true)
    r = noteRead(r, board({ a: 'in_progress', b: 'todo' }), T0 + 60_000, false)
    r = noteRead(r, board({ a: 'in_progress', b: 'done' }), T0 + 120_000, false)
    r = noteRead(r, board({ a: 'in_progress', b: 'done' }), T0 + 180_000, true)
    expect(r.pending).toEqual({ since: T0, items: { a: 'started', b: 'done' } })
  })

  it('lets a newer kind replace an older one for the same task', () => {
    let r = noteRead(null, board({ a: 'todo' }), T0, true)
    r = noteRead(r, board({ a: 'in_progress' }), T0 + 60_000, false)
    expect(r.pending?.items).toEqual({ a: 'started' })
    r = noteRead(r, board({ a: 'done' }), T0 + 120_000, false)
    expect(r.pending?.items).toEqual({ a: 'done' })
  })
})

describe('noteRead: pruning and the watching rule', () => {
  it('drops tasks that are no longer on the board', () => {
    const prev = rec({ a: 'todo', b: 'done' }, { a: 'started', b: 'done' })
    const next = noteRead(prev, board({ a: 'in_progress' }), T0 + 60_000, false)
    expect(next.columns).toEqual({ a: 'in_progress' })
    expect(next.pending?.items).toEqual({ a: 'started' })
  })

  it('clears pending once every pending task has left the board', () => {
    const prev = rec({ a: 'done' }, { a: 'done' })
    const next = noteRead(prev, board({}), T0 + 60_000, false)
    expect(next.columns).toEqual({})
    expect(next.pending).toBeNull()
  })

  it('drops a pending item the person then watched move again, and keeps the rest', () => {
    const prev = rec({ a: 'in_progress', b: 'done' }, { a: 'started', b: 'done' })
    const next = noteRead(prev, board({ a: 'done', b: 'done' }), T0 + 2000, true)
    expect(next.pending).toEqual({ since: T0 - 60_000, items: { b: 'done' } })
  })

  it('counts exactly WATCH_GAP_MS as watching throughout, and one ms more as away', () => {
    const prev = rec({ a: 'todo' })
    const onEdge = noteRead(prev, board({ a: 'done' }), T0 + WATCH_GAP_MS, true)
    expect(onEdge.pending).toBeNull()
    const past = noteRead(prev, board({ a: 'done' }), T0 + WATCH_GAP_MS + 1, true)
    expect(past.pending).toEqual({ since: T0, items: { a: 'done' } })
  })

  it('never treats a read taken while not watching as continuous', () => {
    const prev = rec({ a: 'todo' })
    const hidden = noteRead(prev, board({ a: 'done' }), T0 + 1, false)
    expect(hidden.pending?.items).toEqual({ a: 'done' })
    expect(hidden.watching).toBe(false)
  })

  it('treats the first watched read after an unwatched one as coming back', () => {
    const prev: SeenRecord = { ...rec({ a: 'todo' }), watching: false }
    const back = noteRead(prev, board({ a: 'in_progress' }), T0 + 1, true)
    expect(back.pending?.items).toEqual({ a: 'started' })
  })

  it('does not mutate the previous record', () => {
    const prev = rec({ a: 'todo', b: 'todo' }, { b: 'moved' })
    const before = snapshot(prev)
    noteRead(prev, board({ a: 'done' }), T0 + 60_000, false)
    noteRead(prev, board({ a: 'done' }), T0 + 1, true)
    expect(prev).toEqual(before)
  })

  it('reads a task id like toString as an ordinary id', () => {
    const prev = rec({})
    const next = noteRead(prev, board({ toString: 'todo' }), T0 + 60_000, false)
    expect(next.pending?.items).toEqual({ toString: 'new' })
  })
})

describe('acknowledge, markAllSeen, absorb', () => {
  it('acknowledge removes only those ids and leaves the input alone', () => {
    const r = rec({ a: 'done', b: 'done', c: 'todo' }, { a: 'done', b: 'done', c: 'new' })
    const before = snapshot(r)
    const next = acknowledge(r, ['a', 'c', 'missing'])
    expect(next.pending).toEqual({ since: T0 - 60_000, items: { b: 'done' } })
    expect(r).toEqual(before)
    expect(next).not.toBe(r)
  })

  it('acknowledge clears pending when nothing is left', () => {
    const r = rec({ a: 'done' }, { a: 'done' })
    expect(acknowledge(r, new Set(['a'])).pending).toBeNull()
    expect(acknowledge(rec({ a: 'done' }), ['a']).pending).toBeNull()
  })

  it('markAllSeen clears pending and leaves the input alone', () => {
    const r = rec({ a: 'done' }, { a: 'done' })
    const before = snapshot(r)
    const next = markAllSeen(r)
    expect(next.pending).toBeNull()
    expect(next.columns).toEqual({ a: 'done' })
    expect(r).toEqual(before)
  })

  it("absorb records the person's own move and drops its pending item", () => {
    const r = rec({ a: 'todo', b: 'todo' }, { a: 'started', b: 'new' })
    const before = snapshot(r)
    const next = absorb(r, 'a', 'done')
    expect(next.columns).toEqual({ a: 'done', b: 'todo' })
    expect(next.pending?.items).toEqual({ b: 'new' })
    expect(r).toEqual(before)
    // The absorbed move does not come back on the next away read.
    const later = noteRead(next, board({ a: 'done', b: 'todo' }), T0 + 60_000, false)
    expect(later.pending?.items).toEqual({ b: 'new' })
  })
})

describe('readSeen', () => {
  const good = rec({ a: 'todo', b: 'done' }, { b: 'done' })

  it('round-trips a stored record', () => {
    expect(readSeen(JSON.stringify(good))).toEqual(good)
    const quiet = rec({ a: 'todo' })
    expect(readSeen(JSON.stringify(quiet))).toEqual(quiet)
  })

  it('reads nothing stored as none', () => {
    expect(readSeen(null)).toBeNull()
    expect(readSeen('')).toBeNull()
  })

  it('rejects anything that is not exactly the current shape', () => {
    const junk: unknown[] = [
      'not json',
      null,
      42,
      [],
      { ...good, v: 2 },
      { ...good, v: '1' },
      { ...good, at: 'yesterday' },
      { ...good, watching: 'yes' },
      { ...good, columns: null },
      { ...good, columns: ['todo'] },
      { ...good, columns: { a: 3 } },
      { ...good, pending: undefined },
      { ...good, pending: 'none' },
      { ...good, pending: { since: 'then', items: {} } },
      { ...good, pending: { since: T0, items: null } },
      { ...good, pending: { since: T0, items: { a: 'vanished' } } },
      { ...good, pending: { since: T0 } },
    ]
    for (const value of junk) {
      const raw = typeof value === 'string' ? value : JSON.stringify(value)
      expect(readSeen(raw), raw).toBeNull()
    }
    // A non-finite number only arrives through a hand-written string.
    expect(readSeen('{"v":1,"at":1e999,"watching":true,"columns":{},"pending":null}')).toBeNull()
  })
})

describe('seenSummary and summaryParts', () => {
  it('is null without a record or without pending changes', () => {
    expect(seenSummary(null)).toBeNull()
    expect(seenSummary(rec({ a: 'todo' }))).toBeNull()
  })

  it('counts each kind, with every kind present', () => {
    const r = rec({}, { a: 'done', b: 'done', c: 'needs_you', d: 'moved' }, T0 - 5000)
    expect(seenSummary(r)).toEqual({
      since: T0 - 5000,
      counts: { done: 2, started: 0, needs_you: 1, new: 0, cancelled: 0, moved: 1 },
      total: 4,
    })
  })

  it('lists the nonzero counts in SEEN_KINDS order', () => {
    expect(
      summaryParts({ moved: 2, cancelled: 1, new: 1, needs_you: 1, started: 2, done: 3 }),
    ).toEqual(['3 done', '2 started', '1 needs you', '1 new', '1 cancelled', '2 moved'])
    expect(
      summaryParts({ done: 0, started: 0, needs_you: 1, new: 0, cancelled: 0, moved: 0 }),
    ).toEqual(['1 needs you'])
    expect(
      summaryParts({ done: 0, started: 0, needs_you: 2, new: 0, cancelled: 0, moved: 0 }),
    ).toEqual(['2 need you'])
    expect(SEEN_KINDS).toEqual(['done', 'started', 'needs_you', 'new', 'cancelled', 'moved'])
  })
})

describe('dottedIds', () => {
  it('dots every pending task except the ones that now need the person', () => {
    const r = rec({}, { a: 'done', b: 'needs_you', c: 'started' })
    expect([...dottedIds(r)].sort()).toEqual(['a', 'c'])
  })

  it('is empty without a record or without pending changes', () => {
    expect(dottedIds(null).size).toBe(0)
    expect(dottedIds(rec({ a: 'todo' })).size).toBe(0)
    expect(dottedIds(rec({}, { b: 'needs_you' })).size).toBe(0)
  })
})
