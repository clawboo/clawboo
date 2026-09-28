import { createHash } from 'node:crypto'

import { describe, expect, it } from 'vitest'

import { CLAUDE_BOO_SVG, CLAUDE_BOO_SVG_SHA256 } from '../artwork/claude'
import { CODEX_BOO_SVG, CODEX_BOO_SVG_SHA256 } from '../artwork/codex'
import { HERMES_BOO_DARK_SVG, HERMES_BOO_DARK_SVG_SHA256 } from '../artwork/hermes-dark'
import { HERMES_BOO_LIGHT_SVG, HERMES_BOO_LIGHT_SVG_SHA256 } from '../artwork/hermes-light'

/*
 * The artwork is approved brand work locked outside this repo, and these hashes are the ones
 * clawboo-boo-variants/LOCKED.md records. Recomputing them over the embedded strings is what makes
 * a hand edit of an SVG a failing test rather than a silent redesign: the generator refuses to
 * embed bytes that miss the hash, and this refuses bytes that were changed after embedding.
 */
const ARTWORK: [string, string, string, number][] = [
  ['codex', CODEX_BOO_SVG, CODEX_BOO_SVG_SHA256, 4453],
  ['claude', CLAUDE_BOO_SVG, CLAUDE_BOO_SVG_SHA256, 5081],
  ['hermes light', HERMES_BOO_LIGHT_SVG, HERMES_BOO_LIGHT_SVG_SHA256, 88252],
  ['hermes dark', HERMES_BOO_DARK_SVG, HERMES_BOO_DARK_SVG_SHA256, 90445],
]

describe('locked variant artwork', () => {
  it.each(ARTWORK)('%s hashes to its locked sha256', (_name, svg, sha256) => {
    expect(createHash('sha256').update(svg, 'utf8').digest('hex')).toBe(sha256)
  })

  it.each(ARTWORK)('%s is the whole file, byte for byte', (_name, svg, _sha256, bytes) => {
    expect(svg.length).toBe(bytes)
    expect(svg.startsWith('<svg xmlns="http://www.w3.org/2000/svg" viewBox=')).toBe(true)
    // The trailing newline is part of the hashed bytes.
    expect(svg.endsWith('</svg>\n')).toBe(true)
  })

  it('carries the four hashes LOCKED.md records', () => {
    expect(ARTWORK.map(([, , sha256]) => sha256)).toEqual([
      '90e9e9a29327443a1cec87395b1e7da6841d4f3e4c96da1453003058ce40c335',
      'e09b7bbb66e7d97ecdd41c08b83c838823b5a77df30fc33cce98eb17e3bb97e6',
      'b685127cd7ee51bdc157e63f7a3604dbc1948d563887298d48f991e0581eca47',
      '097abd4cd93ab886f0d57ca531567e3c509e6923a0fc7be449ce95253055d5d9',
    ])
  })
})
