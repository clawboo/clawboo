// Storing a tool result whole so a bounded view stays lossless by reference.
//
// The property that matters is retrievability: whatever the model was shown, the
// bytes behind it must still be there and readable in pages. The second property
// is honesty about the store's own limit, because a partial copy reported as
// whole is the same silent lie as truncating without saying so.

import { beforeEach, describe, expect, it } from 'vitest'

import { createDb, type ClawbooDb } from '../../db'
import { putToolResult, readToolResult, reapToolResults } from '../resultStore'

let db: ClawbooDb
beforeEach(() => {
  db = createDb(':memory:')
})

const put = (text: string) => putToolResult(db, { toolName: 'gmail_fetch', text })

describe('putToolResult', () => {
  it('mints an unguessable handle and reports the real size', () => {
    const r = put('x'.repeat(5_000))
    expect(r.handle).toMatch(/^tr_[0-9a-f]{16}$/)
    expect(r.totalBytes).toBe(5_000)
    expect(r.storedBytes).toBe(5_000)
  })

  it('gives every result a distinct handle', () => {
    // Two identical payloads must not collide onto one row: the second write
    // would otherwise overwrite or fail on the primary key.
    const handles = new Set(Array.from({ length: 50 }, () => put('same bytes').handle))
    expect(handles.size).toBe(50)
  })
})

describe('readToolResult', () => {
  it('reads the stored bytes back exactly', () => {
    const text = 'line one\nline two\nline three'
    const { handle } = put(text)
    const page = readToolResult(db, handle, { limit: 10_000 })
    expect(page?.text).toBe(text)
    expect(page?.more).toBe(false)
  })

  it('pages with offset and limit, and says when more remains', () => {
    const { handle } = put('abcdefghij'.repeat(100))
    const first = readToolResult(db, handle, { offset: 0, limit: 400 })
    expect(first?.text).toHaveLength(400)
    expect(first?.more).toBe(true)
    expect(first?.nextOffset).toBe(400)

    // The cursor the first page reported must land exactly where it left off.
    const second = readToolResult(db, handle, { offset: first!.nextOffset, limit: 400 })
    expect(second?.text[0]).toBe('a')
    expect(second?.nextOffset).toBe(800)

    const last = readToolResult(db, handle, { offset: 800, limit: 400 })
    expect(last?.more).toBe(false)
  })

  it('returns matching lines WITH byte offsets, so a hit is a seek target', () => {
    // Without the offset a search only tells the model the thing exists, and it
    // still has to page the whole payload to reach it.
    const { handle } = put(['alpha', 'beta invoice 42', 'gamma'].join('\n'))
    const hit = readToolResult(db, handle, { limit: 1_000, search: 'invoice' })
    expect(hit?.text).toContain('invoice 42')
    expect(hit?.text).toMatch(/^\[byte \d+\]/)
  })

  it('says so plainly when a search matches nothing', () => {
    const { handle } = put('alpha\nbeta\ngamma')
    const miss = readToolResult(db, handle, { limit: 1_000, search: 'nothing-here' })
    expect(miss?.text).toContain('No line matches')
  })

  it('returns null for a handle it does not know', () => {
    // An expired or invented handle must be distinguishable from an empty
    // result, or the model is told nothing when it should be told it is gone.
    expect(readToolResult(db, 'tr_deadbeefdeadbeef', { limit: 100 })).toBeNull()
  })
})

describe('reapToolResults', () => {
  it('deletes only rows older than the cutoff', () => {
    const now = 1_000_000_000_000
    const old = putToolResult(db, { toolName: 't', text: 'old' }, now - 10 * 86_400_000)
    const fresh = putToolResult(db, { toolName: 't', text: 'fresh' }, now)

    expect(reapToolResults(db, 7 * 86_400_000, now)).toBe(1)
    expect(readToolResult(db, old.handle, { limit: 100 })).toBeNull()
    expect(readToolResult(db, fresh.handle, { limit: 100 })?.text).toBe('fresh')
  })

  it('is a no-op when nothing has aged out', () => {
    const now = 1_000_000_000_000
    putToolResult(db, { toolName: 't', text: 'fresh' }, now)
    expect(reapToolResults(db, 7 * 86_400_000, now)).toBe(0)
  })
})

describe('paging across multi-byte characters', () => {
  it('never returns a replacement character at a page boundary', () => {
    // Page two starts wherever page one ended, which is an arbitrary byte
    // offset, so this is the common case rather than an edge case.
    const { handle } = put('🙂'.repeat(2_000))
    let offset = 0
    for (let i = 0; i < 12; i++) {
      const page = readToolResult(db, handle, { offset, limit: 101 })
      if (!page) break
      expect(page.text).not.toContain('�')
      if (!page.more) break
      expect(page.nextOffset).toBeGreaterThan(offset)
      offset = page.nextOffset
    }
  })
})
