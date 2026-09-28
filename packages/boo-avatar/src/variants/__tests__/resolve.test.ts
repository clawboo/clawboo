import { describe, expect, it } from 'vitest'

import { contrast } from '../colour'
import { resolveTint } from '../resolve'
import { claudeLegibility } from '../tint/claude'
import { hermesLegibility } from '../tint/hermes'
import { booVariant as claude } from '../claude'
import { booVariant as codex } from '../codex'
import { booVariant as hermesLight } from '../hermes-light'
import { booVariant as hermesDark } from '../hermes-dark'

/*
 * Team palette colours are generated, not chosen from a list, so about one in twenty is a colour a
 * variant refuses: Claude's locked dark chevrons need a body above 4.5:1, and Hermes's hem has to
 * hold the silhouette against a dark page. These are real colours the generator produced.
 */
const REFUSED_BY_CLAUDE = ['#AF4E93', '#777777', '#6869CD', '#B85900', '#BF4A59', '#C04C48']
const REFUSED_BY_HERMES = ['#AF4E93', '#777777', '#6869CD', '#B85900', '#BF4A59', '#C04C48']

describe('resolveTint', () => {
  it('keeps a colour the variant can already draw', () => {
    const r = resolveTint('#34D399', (hex) => claudeLegibility(hex).ok)
    expect(r).toEqual({ tint: '#34D399', reason: 'exact' })
  })

  it('draws the locked artwork for no colour and for a malformed one', () => {
    const ok = () => true
    expect(resolveTint(null, ok).reason).toBe('locked')
    expect(resolveTint(undefined, ok).reason).toBe('locked')
    expect(resolveTint('var(--primary)', ok)).toEqual({ tint: null, reason: 'malformed' })
    expect(resolveTint('#abc', ok)).toEqual({ tint: null, reason: 'malformed' })
  })

  it('falls back to the locked artwork when no shade of the hue works', () => {
    expect(resolveTint('#34D399', () => false)).toEqual({ tint: null, reason: 'unusable' })
  })
})

describe('refused palette colours resolve to a legible shade', () => {
  it.each(REFUSED_BY_CLAUDE)('claude adjusts %s', (colour) => {
    expect(claudeLegibility(colour).ok).toBe(false)
    const { tint, reason } = resolveTint(colour, (hex) => claudeLegibility(hex).ok)
    expect(reason).toBe('adjusted')
    expect(tint).not.toBeNull()
    expect(claudeLegibility(tint!).ok).toBe(true)
    // The point of adjusting rather than dropping the colour is that it still reads as the team's.
    expect(contrast(tint!, colour)).toBeLessThan(2.2)
  })

  it.each(REFUSED_BY_HERMES)('hermes adjusts %s', (colour) => {
    expect(hermesLegibility(colour).ok).toBe(false)
    const { tint, reason } = resolveTint(colour, (hex) => hermesLegibility(hex).ok)
    expect(reason).toBe('adjusted')
    expect(hermesLegibility(tint!).ok).toBe(true)
  })
})

describe('renderers never throw on a colour the app can hand them', () => {
  const renderers = [
    ['codex', codex],
    ['claude', claude],
    ['hermes-light', hermesLight],
    ['hermes-dark', hermesDark],
  ] as const

  it.each(renderers)('%s draws every refused colour', (_name, variant) => {
    for (const colour of [...REFUSED_BY_CLAUDE, ...REFUSED_BY_HERMES]) {
      const svg = variant.render(colour)
      expect(svg.startsWith('<svg')).toBe(true)
    }
  })

  it.each(renderers)('%s draws the locked artwork for a malformed colour', (_name, variant) => {
    expect(variant.render('var(--primary)')).toBe(variant.render(null))
  })

  it.each(renderers)('%s still returns the locked bytes for no colour', (_name, variant) => {
    expect(variant.render(null)).toBe(variant.render(undefined))
  })
})
