import { describe, expect, it } from 'vitest'

import {
  breakTrifectaSuggestions,
  isLethalTrifecta,
  NO_TRIFECTA,
  trifectaLegCount,
  unionTrifecta,
  type TrifectaTags,
} from '../index'

const leg = (over: Partial<TrifectaTags>): TrifectaTags => ({ ...NO_TRIFECTA, ...over })

describe('unionTrifecta', () => {
  it('ORs the legs and ignores nullish operands', () => {
    const u = unionTrifecta(
      leg({ readsPrivateData: true }),
      null,
      undefined,
      leg({ canEgress: true }),
    )
    expect(u).toEqual({
      readsPrivateData: true,
      ingestsUntrustedContent: false,
      canEgress: true,
    })
  })

  it('returns all-false for no operands', () => {
    expect(unionTrifecta()).toEqual(NO_TRIFECTA)
  })

  it('does not mutate its operands', () => {
    const a = leg({ readsPrivateData: true })
    unionTrifecta(a, leg({ canEgress: true }))
    expect(a.canEgress).toBe(false)
  })
})

describe('isLethalTrifecta', () => {
  it('requires all three legs', () => {
    expect(isLethalTrifecta(leg({ readsPrivateData: true, ingestsUntrustedContent: true }))).toBe(
      false,
    )
    expect(
      isLethalTrifecta(
        leg({ readsPrivateData: true, ingestsUntrustedContent: true, canEgress: true }),
      ),
    ).toBe(true)
  })

  it('is false for nullish', () => {
    expect(isLethalTrifecta(null)).toBe(false)
    expect(isLethalTrifecta(undefined)).toBe(false)
  })
})

describe('trifectaLegCount', () => {
  it('counts armed legs', () => {
    expect(trifectaLegCount(NO_TRIFECTA)).toBe(0)
    expect(trifectaLegCount(leg({ canEgress: true }))).toBe(1)
    expect(
      trifectaLegCount(
        leg({ readsPrivateData: true, ingestsUntrustedContent: true, canEgress: true }),
      ),
    ).toBe(3)
    expect(trifectaLegCount(null)).toBe(0)
  })
})

describe('breakTrifectaSuggestions', () => {
  it('is empty unless the trifecta is armed', () => {
    expect(breakTrifectaSuggestions(leg({ canEgress: true }))).toEqual([])
  })

  it('leads with dropping egress, the cheapest leg to lose', () => {
    const s = breakTrifectaSuggestions(
      leg({ readsPrivateData: true, ingestsUntrustedContent: true, canEgress: true }),
    )
    expect(s).toHaveLength(3)
    expect(s[0]).toMatch(/egress/i)
  })
})
