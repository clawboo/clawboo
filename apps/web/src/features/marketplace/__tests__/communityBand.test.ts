// The predicate that decides whether four hundred registry entries exist.

import { describe, expect, it } from 'vitest'

import { wantsCommunityBand } from '../communityBand'

const ask = (over: Partial<Parameters<typeof wantsCommunityBand>[0]> = {}): boolean =>
  wantsCommunityBand({ categoryFilter: 'all', query: '', curatedHits: 19, ...over })

describe('wantsCommunityBand', () => {
  it('never loads on first paint', () => {
    expect(ask()).toBe(false)
    expect(ask({ categoryFilter: 'connected' })).toBe(false)
    expect(ask({ categoryFilter: 'dev' })).toBe(false)
  })

  it('loads when asked for by name, even with nothing typed', () => {
    expect(ask({ categoryFilter: 'community' })).toBe(true)
  })

  it('no longer lets one curated hit hide the whole registry', () => {
    // "search" matches Exa on a tag while sixty-seven registry entries also
    // match. The old predicate returned false here and showed none of them.
    expect(ask({ query: 'search', curatedHits: 1 })).toBe(true)
    expect(ask({ query: 'file', curatedHits: 3 })).toBe(true)
  })

  it('keeps the single-character miss working', () => {
    // Nine one-character queries return no curated match, and each opened the
    // band before. A flat two-character floor would have taken that away.
    expect(ask({ query: 'z', curatedHits: 0 })).toBe(true)
    expect(ask({ query: '7', curatedHits: 0 })).toBe(true)
  })

  it('holds back a single character that already found something', () => {
    expect(ask({ query: 's', curatedHits: 4 })).toBe(false)
  })

  it('loads for any two-character query', () => {
    expect(ask({ query: 'no', curatedHits: 1 })).toBe(true)
    expect(ask({ query: 'zz', curatedHits: 0 })).toBe(true)
  })
})
