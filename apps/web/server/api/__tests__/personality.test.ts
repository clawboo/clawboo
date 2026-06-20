// parseStoredConfig reads ONLY the v2 `{ values, customText }` wrapper. The dead
// legacy-v1 normalization (slider keys at the top level) was removed — no shipped
// DB ever wrote v1, so a v1-shaped blob is now an unrecognized (null) config, not
// a silently-upgraded one.

import { describe, expect, it } from 'vitest'

import { parseStoredConfig } from '../personality'

describe('parseStoredConfig (v2 wrapper only)', () => {
  it('parses the v2 wrapper { values, customText }', () => {
    const c = parseStoredConfig(
      JSON.stringify({ values: { verbosity: 70, humor: 30 }, customText: 'be terse' }),
    )
    expect(c).toEqual({ values: { verbosity: 70, humor: 30 }, customText: 'be terse' })
  })

  it('defaults a missing customText to null', () => {
    expect(parseStoredConfig(JSON.stringify({ values: { verbosity: 50 } }))?.customText).toBeNull()
  })

  it('returns null for a legacy v1 blob (slider keys at the top level) — no longer normalized', () => {
    expect(parseStoredConfig(JSON.stringify({ verbosity: 50, humor: 50 }))).toBeNull()
  })

  it('returns null on corrupt / non-object JSON', () => {
    expect(parseStoredConfig('not json')).toBeNull()
    expect(parseStoredConfig('42')).toBeNull()
  })
})
