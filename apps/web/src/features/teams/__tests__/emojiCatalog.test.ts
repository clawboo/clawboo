import { describe, it, expect } from 'vitest'

import { EMOJI_CATEGORIES, ALL_EMOJIS, searchEmojis } from '../emojiCatalog'

describe('emojiCatalog — data integrity', () => {
  it('has multiple categories, each non-empty', () => {
    expect(EMOJI_CATEGORIES.length).toBeGreaterThanOrEqual(6)
    for (const cat of EMOJI_CATEGORIES) {
      expect(cat.id).toBeTruthy()
      expect(cat.label).toBeTruthy()
      expect(cat.emojis.length).toBeGreaterThan(0)
    }
  })

  it('every entry has a char and lowercase keyword string', () => {
    for (const e of ALL_EMOJIS) {
      expect(e.c.length).toBeGreaterThan(0)
      expect(e.n.length).toBeGreaterThan(0)
      expect(e.n).toBe(e.n.toLowerCase())
    }
  })

  it('ALL_EMOJIS is the flattened union of categories', () => {
    const total = EMOJI_CATEGORIES.reduce((sum, c) => sum + c.emojis.length, 0)
    expect(ALL_EMOJIS).toHaveLength(total)
  })

  it('has no duplicate emoji characters', () => {
    const chars = ALL_EMOJIS.map((e) => e.c)
    expect(new Set(chars).size).toBe(chars.length)
  })
})

describe('searchEmojis', () => {
  it('returns [] for an empty / whitespace query', () => {
    expect(searchEmojis('')).toEqual([])
    expect(searchEmojis('   ')).toEqual([])
  })

  it('matches keywords case-insensitively', () => {
    const rocket = searchEmojis('rocket')
    expect(rocket.some((e) => e.c === '🚀')).toBe(true)
    expect(searchEmojis('ROCKET').some((e) => e.c === '🚀')).toBe(true)
  })

  it('matches by any keyword in the name', () => {
    // '🚀' is keyed "rocket launch startup space ship fast"
    expect(searchEmojis('startup').some((e) => e.c === '🚀')).toBe(true)
    expect(searchEmojis('chart').every((e) => e.n.includes('chart'))).toBe(true)
    expect(searchEmojis('chart').length).toBeGreaterThanOrEqual(2)
  })

  it('returns nothing for a non-matching query', () => {
    expect(searchEmojis('zzzznotanemoji')).toEqual([])
  })
})
