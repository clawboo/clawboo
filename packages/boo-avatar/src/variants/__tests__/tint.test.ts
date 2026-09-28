import { describe, expect, it } from 'vitest'

import { TINTS } from '../../index'
import { BOO_VARIANTS, loadBooVariant } from '../registry'
import { CLAUDE_BOO_SVG } from '../artwork/claude'
import { CODEX_BOO_SVG } from '../artwork/codex'
import { HERMES_BOO_DARK_SVG } from '../artwork/hermes-dark'
import { HERMES_BOO_LIGHT_SVG } from '../artwork/hermes-light'
import type { BooSurface, BooVariantId } from '../types'

/** TINTS[0] is reserved for Boo Zero, which never takes a variant; teammates get 1..9. */
const TEAM_TINTS = TINTS.slice(1)

const LOCKED: [BooVariantId, BooSurface, string][] = [
  ['codex', 'light', CODEX_BOO_SVG],
  ['claude', 'light', CLAUDE_BOO_SVG],
  ['hermes', 'light', HERMES_BOO_LIGHT_SVG],
  ['hermes', 'dark', HERMES_BOO_DARK_SVG],
]

describe('render with no tint', () => {
  it.each(LOCKED)('%s/%s returns the locked artwork unchanged', async (id, surface, locked) => {
    const renderer = await loadBooVariant(id, surface)
    // The variant's own colour is the default, not a fallback, so both spellings of "no colour"
    // return the locked bytes rather than a derived approximation of them.
    expect(renderer.render()).toBe(locked)
    expect(renderer.render(null)).toBe(locked)
    expect(renderer.render(undefined)).toBe(locked)
  })
})

describe('render with a tint', () => {
  it.each(LOCKED)('%s/%s moves on every teammate colour', async (id, surface, locked) => {
    const renderer = await loadBooVariant(id, surface)
    const rendered = TEAM_TINTS.map((tint) => renderer.render(tint))
    for (const svg of rendered) expect(svg).not.toBe(locked)
    // Nine colours, nine distinct drawings: a tint that collapsed onto another would mean the
    // shift lost the tint's hue somewhere.
    expect(new Set(rendered).size).toBe(TEAM_TINTS.length)
  })

  it('reproduces the locked artwork when a variant is tinted with its own colour', async () => {
    for (const [id, surface, locked] of LOCKED) {
      const own = BOO_VARIANTS[id].originalColour
      if (!own) continue
      const renderer = await loadBooVariant(id, surface)
      expect(renderer.render(own)).toBe(locked)
    }
  })

  it('refuses a tint that is not a six digit hex', async () => {
    const codex = await loadBooVariant('codex')
    expect(() => codex.render('rebeccapurple')).toThrow('expected a #rrggbb tint')
    const hermes = await loadBooVariant('hermes')
    expect(() => hermes.render('#fff')).toThrow('tint must be #RRGGBB')
  })
})

describe('the guards each variant carries', () => {
  it('keeps the Codex glyph white on its own blue and flips it on a pale teammate colour', async () => {
    const codex = await loadBooVariant('codex')
    // White reads on the locked blue. On the pale tints it goes faint, so the >_ flips to a deep
    // ink derived from the tint rather than staying a mark the body cannot carry.
    expect(codex.render('#7B95FC')).toContain('stroke="#FFFFFF"')
    for (const tint of TEAM_TINTS) {
      expect(codex.render(tint)).not.toContain('stroke="#FFFFFF"')
    }
  })

  it('refuses a Claude tint that would lose the chevron eyes', async () => {
    const claude = await loadBooVariant('claude')
    expect(() => claude.render('#000000')).toThrow('under WCAG AA 4.5:1')
  })

  it('refuses a Hermes tint whose hem would sink into a dark page', async () => {
    for (const surface of ['light', 'dark'] as BooSurface[]) {
      const hermes = await loadBooVariant('hermes', surface)
      expect(() => hermes.render('#101010')).toThrow('under 3:1')
    }
  })

  it('treats a Hermes tint of its own white ink as a no-op', async () => {
    // Hermes's identity colour IS white, and white carries no chroma for a hue to ride on, so this
    // returns the locked bytes rather than a Hermes drained to greys.
    for (const [id, surface, locked] of LOCKED) {
      if (id !== 'hermes') continue
      const hermes = await loadBooVariant(id, surface)
      expect(hermes.render('#FFFFFF')).toBe(locked)
    }
  })

  it('keeps the black ink black on every Hermes tint', async () => {
    // The hair, the eyes and the headset stay ink: the black headset framing the black bob against
    // a coloured face is what keeps the mark reading at 64px.
    const hermes = await loadBooVariant('hermes')
    for (const tint of TEAM_TINTS) {
      expect(hermes.render(tint)).toContain('fill="#000000"')
    }
  })

  it('mints gradient ids per tint so two tinted Hermes Boos can share a document', async () => {
    const hermes = await loadBooVariant('hermes')
    const mint = hermes.render('#34D399')
    const amber = hermes.render('#FBBF24')
    expect(mint).toContain('hermesTint34D399Body')
    expect(amber).toContain('hermesTintFBBF24Body')
    expect(mint).not.toContain('hermesTintFBBF24Body')
  })
})

describe('two avatars of one variant sharing a document', () => {
  /** The ids a drawing points at: these are the ones a collision repaints. */
  const referenced = (svg: string): string[] => [
    ...new Set([
      ...[...svg.matchAll(/url\(#([^)]+)\)/g)].map((m) => m[1]),
      ...[...svg.matchAll(/href="#([^"]+)"/g)].map((m) => m[1]),
    ]),
  ]

  it.each(LOCKED)('%s/%s gives two tints no referenced id in common', async (id, surface) => {
    // An inlined SVG resolves url(#id) against the whole document, so a shared id would make both
    // agents paint in whichever colour mounted first. The dark Hermes file is the exception below.
    const renderer = await loadBooVariant(id, surface)
    const mint = referenced(renderer.render('#34D399'))
    const amber = new Set(referenced(renderer.render('#FBBF24')))
    // Geometry the dark file hoists into <defs> is the same path under every tint, so a shared
    // reference to it resolves to an identical shape and cannot change a drawing.
    const geometry = new Set(['hermesBodyRing', 'hermesHair', 'hermesHeadset', 'hermesEyes'])
    expect(mint.filter((x) => amber.has(x) && !geometry.has(x))).toEqual([])
  })

  it.each(LOCKED)('%s/%s keeps a tinted drawing clear of the locked ids', async (id, surface) => {
    const renderer = await loadBooVariant(id, surface)
    const locked = new Set(referenced(renderer.render(null)))
    const geometry = new Set(['hermesBodyRing', 'hermesHair', 'hermesHeadset', 'hermesEyes'])
    const tinted = referenced(renderer.render('#34D399'))
    expect(tinted.filter((x) => locked.has(x) && !geometry.has(x))).toEqual([])
  })
})
