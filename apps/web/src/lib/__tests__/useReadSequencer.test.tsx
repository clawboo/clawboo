// The two-counter staleness contract every polling panel depends on. Exercised here
// directly (rather than only through a panel) because the interesting cases are orderings
// that are awkward to stage through a UI: a local commit that starts no new read, and the
// deliberate split between gating DATA and gating LOADING CHROME.

import { renderHook } from '@testing-library/react'
import { describe, expect, it } from 'vitest'

import { useReadSequencer } from '../useReadSequencer'

describe('useReadSequencer', () => {
  it('lets a lone read write', () => {
    const { result } = renderHook(() => useReadSequencer())
    const read = result.current.beginRead()
    expect(read.isNewestRead()).toBe(true)
    expect(read.isCurrent()).toBe(true)
  })

  it('supersedes an older read as soon as a newer one begins', () => {
    const { result } = renderHook(() => useReadSequencer())
    const first = result.current.beginRead()
    const second = result.current.beginRead()

    // The older read may write nothing — not the data, not the loading chrome.
    expect(first.isCurrent()).toBe(false)
    expect(first.isNewestRead()).toBe(false)
    // Whichever order they RESOLVE in, only the newest may write.
    expect(second.isCurrent()).toBe(true)
    expect(second.isNewestRead()).toBe(true)
  })

  it('fences an in-flight read on a local commit that starts no new read', () => {
    // The case a plain generation counter misses: a drag that PATCHes and commits, or an
    // optimistic list removal. No newer read exists, so the in-flight read is still the
    // newest — only writeSeq can tell that its snapshot predates the commit.
    const { result } = renderHook(() => useReadSequencer())
    const read = result.current.beginRead()

    result.current.commitLocalWrite()

    expect(read.isCurrent()).toBe(false) // data: stale, must be dropped
    expect(read.isNewestRead()).toBe(true) // chrome: still the newest read, so it settles
  })

  it('does not fence a read issued AFTER the local commit', () => {
    const { result } = renderHook(() => useReadSequencer())
    result.current.commitLocalWrite()
    const read = result.current.beginRead()
    expect(read.isCurrent()).toBe(true)
  })

  it('keeps consecutive local commits from resurrecting an intervening read', () => {
    // Two commits in a row (e.g. two quick drags) with a read issued between them: the
    // read predates the second commit, so it stays stale rather than reverting it.
    const { result } = renderHook(() => useReadSequencer())
    result.current.commitLocalWrite()
    const read = result.current.beginRead()
    result.current.commitLocalWrite()
    expect(read.isCurrent()).toBe(false)
  })

  it('is referentially stable across re-renders so it never re-creates a poll', () => {
    const { result, rerender } = renderHook(() => useReadSequencer())
    const first = result.current
    rerender()
    expect(result.current).toBe(first)
  })

  it('keeps counters per hook instance', () => {
    const a = renderHook(() => useReadSequencer())
    const b = renderHook(() => useReadSequencer())
    const readA = a.result.current.beginRead()
    b.result.current.beginRead()
    b.result.current.commitLocalWrite()
    // One panel's activity must not invalidate another panel's in-flight read.
    expect(readA.isCurrent()).toBe(true)
  })
})
