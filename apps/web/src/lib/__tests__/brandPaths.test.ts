// Embedded brand glyphs — data sanity. Guards against the transcription trap
// this file already hit once: an SVG's <defs>/<clipPath> rect getting embedded
// as a RENDERED path (a full-canvas 'M0 0h24v24H0z' painted last covers the
// entire mark with a solid square).

import { describe, expect, it } from 'vitest'

import * as brandPaths from '../brandPaths'
import type { BrandGlyph } from '../brandPaths'

const GLYPHS = Object.entries(brandPaths).filter(
  (e): e is [string, BrandGlyph] =>
    typeof e[1] === 'object' && e[1] !== null && Array.isArray((e[1] as BrandGlyph).paths),
)

// A path that is (approximately) the whole artboard rect — a clipPath/bounding
// shape, never legitimate mark data.
const ARTBOARD_RECT = /^M0[ ,]0\s*h\s*\d+\s*v\s*\d+\s*H0\s*z$/i

describe('brandPaths', () => {
  it('exports at least the 11 expected marks', () => {
    expect(GLYPHS.length).toBeGreaterThanOrEqual(11)
  })

  it('every glyph has ≥1 non-empty path and a valid viewBox when set', () => {
    for (const [name, glyph] of GLYPHS) {
      expect(glyph.paths.length, name).toBeGreaterThan(0)
      for (const d of glyph.paths) {
        expect(d.trim().length, name).toBeGreaterThan(10)
        expect(d.trim().startsWith('M'), `${name} path must start with a moveto`).toBe(true)
      }
      if (glyph.viewBox) {
        expect(glyph.viewBox, name).toMatch(/^\d+ \d+ \d+ \d+$/)
      }
      // Stroke paths (e.g. the mascot antennae) — non-empty movetos + a width.
      if (glyph.strokePaths) {
        expect(glyph.strokeWidth, `${name} strokePaths need a strokeWidth`).toBeGreaterThan(0)
        for (const d of glyph.strokePaths) {
          expect(d.trim().startsWith('M'), `${name} strokePath must start with a moveto`).toBe(true)
        }
      }
    }
  })

  it('no glyph embeds a full-canvas artboard/clipPath rect as a rendered path', () => {
    for (const [name, glyph] of GLYPHS) {
      for (const d of glyph.paths) {
        expect(ARTBOARD_RECT.test(d.trim()), `${name} contains an artboard rect: ${d}`).toBe(false)
      }
    }
  })
})
