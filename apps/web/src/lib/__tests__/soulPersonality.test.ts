// The personality system. Two things here are load-bearing and everything else
// is copy:
//
//   1. MIGRATION. `agents.personalityConfig` rows written before the redesign
//      carry the old five keys. A strict validator returns null for those, the
//      UI falls back to defaults, and the user's tuning vanishes with no error.
//      That silent-reset path is what these tests exist to prevent.
//   2. THE FLOOR. The limits block is what lets the top of every dial be
//      genuinely sharp. No slider position may remove it.

import { describe, expect, it } from 'vitest'

import {
  DEFAULT_PERSONALITY,
  PERSONALITY_FLOOR,
  PERSONALITY_KEYS,
  PERSONALITY_PRESETS,
  buildPersonalityBlock,
  getDimensionText,
  getDimensions,
  hasPersonalityBlock,
  mergeSoulWithPersonality,
  migratePersonalityValues,
  stripPersonalityBlock,
} from '../soulPersonality'

describe('migration from the pre-redesign keys', () => {
  it('carries an old config forward instead of dropping it', () => {
    const old = { verbosity: 80, humor: 90, caution: 30, speed_cost: 50, formality: 20 }
    const next = migratePersonalityValues(old)
    expect(next).not.toBeNull()
    expect(next?.glass).toBe(80) // verbosity -> glass
    expect(next?.bite).toBe(90) // humor -> bite
    expect(next?.spine).toBe(30) // caution -> spine
    // No successor: these fall back to the shipped default rather than 0.
    expect(next?.elbows).toBe(DEFAULT_PERSONALITY.elbows)
    expect(next?.receipts).toBe(DEFAULT_PERSONALITY.receipts)
  })

  it('passes a current config through untouched', () => {
    const cur = { bite: 100, spine: 0, glass: 70, elbows: 90, receipts: 85, hobbyhorse: 60 }
    expect(migratePersonalityValues(cur)).toEqual(cur)
  })

  it('a current key wins over a legacy key that maps onto it', () => {
    const mixed = { bite: 10, humor: 99 }
    expect(migratePersonalityValues(mixed)?.bite).toBe(10)
  })

  it('fills the gaps in a partial config', () => {
    const next = migratePersonalityValues({ bite: 100 })
    expect(next?.bite).toBe(100)
    for (const k of PERSONALITY_KEYS) expect(typeof next?.[k]).toBe('number')
  })

  it('returns null only when there is nothing usable', () => {
    for (const junk of [null, undefined, 42, 'nope', [], {}, { unrelated: 5 }]) {
      expect(migratePersonalityValues(junk)).toBeNull()
    }
  })

  it('clamps out-of-range and non-finite numbers', () => {
    const next = migratePersonalityValues({ bite: 999, spine: -50, glass: Number.NaN })
    expect(next?.bite).toBe(100)
    expect(next?.spine).toBe(0)
    expect(next?.glass).toBe(DEFAULT_PERSONALITY.glass) // NaN is not usable
  })
})

describe('the floor', () => {
  it('ships at every slider position, including all-zero', () => {
    const zero = Object.fromEntries(PERSONALITY_KEYS.map((k) => [k, 0])) as Record<string, number>
    const max = Object.fromEntries(PERSONALITY_KEYS.map((k) => [k, 100])) as Record<string, number>
    for (const values of [zero, max, DEFAULT_PERSONALITY]) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const block = buildPersonalityBlock(values as any)
      expect(block).toContain(PERSONALITY_FLOOR)
    }
  })

  it('states the rules that make a sharp persona shippable', () => {
    // Each of these is bought with a published incident; see the source comment.
    expect(PERSONALITY_FLOOR).toMatch(/never to a person/i)
    expect(PERSONALITY_FLOOR).toMatch(/never changes the verdict/i)
    expect(PERSONALITY_FLOOR).toMatch(/do not mirror hostility/i)
    expect(PERSONALITY_FLOOR).toMatch(/failures are reported flat/i)
    expect(PERSONALITY_FLOOR).toMatch(/not a companion/i)
  })
})

describe('dimensions and copy', () => {
  it('has one dimension per key, each with five stops', () => {
    const dims = getDimensions()
    expect(dims.map((d) => d.key).sort()).toEqual([...PERSONALITY_KEYS].sort())
    for (const d of dims) {
      expect(d.stops).toHaveLength(5)
      for (const stop of d.stops) expect(stop.length).toBeGreaterThan(40)
    }
  })

  it('every slider position resolves to a stop, including the ends', () => {
    for (const k of PERSONALITY_KEYS) {
      for (const v of [0, 19, 20, 50, 79, 80, 99, 100]) {
        expect(getDimensionText(k, v).length).toBeGreaterThan(0)
      }
    }
  })

  it('0 and 100 give genuinely different instructions', () => {
    for (const k of PERSONALITY_KEYS) {
      expect(getDimensionText(k, 0)).not.toBe(getDimensionText(k, 100))
    }
  })

  it('no stop reaches for an unbounded permission', () => {
    // "you are not afraid to offend" / "no filter" is the exact construction
    // behind the worst published outcome in this space. It is banned.
    const banned =
      /no filter|nothing is off[- ]limits|not afraid to offend|hold nothing back|no holds barred/i
    for (const d of getDimensions()) {
      for (const stop of d.stops) expect(stop).not.toMatch(banned)
    }
  })
})

describe('presets', () => {
  it('every preset is complete and in range', () => {
    expect(PERSONALITY_PRESETS.length).toBeGreaterThanOrEqual(5)
    for (const p of PERSONALITY_PRESETS) {
      for (const k of PERSONALITY_KEYS) {
        const v = p.values[k]
        expect(typeof v).toBe('number')
        expect(v).toBeGreaterThanOrEqual(0)
        expect(v).toBeLessThanOrEqual(100)
      }
      expect(p.name.length).toBeGreaterThan(0)
      expect(p.tagline.length).toBeGreaterThan(0)
    }
  })

  it('preset ids are unique', () => {
    const ids = PERSONALITY_PRESETS.map((p) => p.id)
    expect(new Set(ids).size).toBe(ids.length)
  })

  it('spans the range, so the roster reads as a real spectrum', () => {
    const bites = PERSONALITY_PRESETS.map((p) => p.values.bite)
    expect(Math.min(...bites)).toBeLessThan(20)
    expect(Math.max(...bites)).toBeGreaterThan(90)
  })
})

describe('SOUL.md round-trip', () => {
  it('preserves the role description above the block', () => {
    const soul = '# SOUL\n\nYou are Atlas, the migration specialist.'
    const merged = mergeSoulWithPersonality(soul, DEFAULT_PERSONALITY)
    expect(merged).toContain('You are Atlas, the migration specialist.')
    expect(hasPersonalityBlock(merged)).toBe(true)
    expect(stripPersonalityBlock(merged).trim()).toBe(soul)
  })

  it('re-merging replaces the block rather than stacking copies', () => {
    const once = mergeSoulWithPersonality('# SOUL\n\nRole.', DEFAULT_PERSONALITY)
    const twice = mergeSoulWithPersonality(once, { ...DEFAULT_PERSONALITY, bite: 100 })
    expect(twice.match(/clawboo:personality/g)).toHaveLength(1)
    expect(twice.match(/## Limits/g)).toHaveLength(1)
  })
})
