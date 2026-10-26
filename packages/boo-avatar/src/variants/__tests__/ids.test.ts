import { describe, expect, it } from 'vitest'

import { generateBooAvatar, scopeSvgIds } from '../../index'
import { loadBooVariant } from '../registry'
import type { BooSurface, BooVariantId } from '../types'

/*
 * Every drawing that points at an id, locked and tinted. The locked light Hermes is absent because
 * it is flat ink with no defs: it references nothing, so there is nothing for a copy to steal.
 */
const CASES: [BooVariantId, BooSurface, string | null][] = [
  ['codex', 'light', null],
  ['codex', 'light', '#E16F4E'],
  ['claude', 'light', null],
  ['claude', 'light', '#E16F4E'],
  ['hermes', 'light', '#E16F4E'],
  ['hermes', 'dark', null],
  ['hermes', 'dark', '#E16F4E'],
]

/** The ids a drawing points at: these are the ones a collision repaints. */
const referenced = (svg: string): string[] => [
  ...new Set([
    ...[...svg.matchAll(/url\(#([^)]+)\)/g)].map((m) => m[1]),
    ...[...svg.matchAll(/href="#([^"]+)"/g)].map((m) => m[1]),
  ]),
]

const defined = (svg: string): Set<string> =>
  new Set([...svg.matchAll(/\bid="([^"]+)"/g)].map((m) => m[1]))

describe('scopeSvgIds', () => {
  /*
   * Two copies of one colour share every id once tinted, so the first copy in the document owns
   * the paints. A hidden first copy (a collapsed sidebar) then leaves the visible one as eyes and
   * paws with no body. Each mounted copy gets its own scope so neither can resolve to the other.
   */
  it.each(CASES)(
    'gives two copies of %s/%s in %s no referenced id in common',
    async (id, surface, tint) => {
      const svg = (await loadBooVariant(id, surface)).render(tint)
      const a = referenced(scopeSvgIds(svg, 'r1'))
      const b = new Set(referenced(scopeSvgIds(svg, 'r2')))
      expect(a.length).toBeGreaterThan(0)
      expect(a.filter((x) => b.has(x))).toEqual([])
    },
  )

  it.each(CASES)('defines every id %s/%s in %s references', async (id, surface, tint) => {
    const scoped = scopeSvgIds((await loadBooVariant(id, surface)).render(tint), 'r1')
    const ids = defined(scoped)
    for (const ref of referenced(scoped)) {
      expect(ref.endsWith('-r1')).toBe(true)
      expect(ids.has(ref)).toBe(true)
    }
  })

  it('keeps the tint in a tinted id, so two colours still never share one', async () => {
    const codex = await loadBooVariant('codex')
    const scoped = scopeSvgIds(codex.render('#E16F4E'), 'r1')
    expect(scoped).toContain('id="codexBodyGradient-E16F4E-r1"')
    expect(scoped).toContain('url(#codexBodyGradient-E16F4E-r1)')
  })

  it('scopes the generated mascot body gradient the same way', () => {
    const svg = generateBooAvatar({ seed: 'milo' })
    const a = scopeSvgIds(svg, 'r1')
    const b = scopeSvgIds(svg, 'r2')
    const [ref] = referenced(a)
    expect(ref).toMatch(/^boo-body-[0-9a-f]{8}-[0-9a-f]{6}-r1$/)
    expect(defined(a).has(ref)).toBe(true)
    expect(referenced(b)).not.toContain(ref)
  })

  it('leaves the group ids nothing references alone', async () => {
    const scoped = scopeSvgIds((await loadBooVariant('codex')).render(null), 'r1')
    expect(scoped).toContain('id="codex-skin"')
    expect(scoped).toContain('id="boo-base"')
  })

  it('drops characters a React id carries that an svg id should not', () => {
    const svg = generateBooAvatar({ seed: 'milo' })
    expect(referenced(scopeSvgIds(svg, ':r5:'))[0]).toMatch(/-r5$/)
    expect(referenced(scopeSvgIds(svg, '«r5»'))[0]).toMatch(/-r5$/)
  })

  it('reads a long run of unclosed references in linear time', () => {
    // An id class that ran on through `(` took about 8 seconds on this string.
    const hostile = 'url(#('.repeat(50_000)
    const started = performance.now()
    expect(scopeSvgIds(hostile, 'r1')).toBe(hostile)
    expect(performance.now() - started).toBeLessThan(1000)
  })
})
