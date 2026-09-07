// `config.patch` deep-merges, and from OpenClaw 2026.9 a patch that would make an
// array SHORTER is refused rather than merged:
//
//   config.patch would remove entries from array path(s): tools.allow.
//   Pass replacePaths with the exact path(s) when this is intentional,
//   or use config.apply for full-config replacement.
//
// (Measured against a real 2026.9.2 Gateway. Growing an array is still accepted
// with no declaration, so the failure only shows up on the DISABLE half of a
// toggle, which is exactly the half nobody exercises first.)
//
// Every clawboo caller reads the live config, rebuilds the whole array and sends
// the intended final set, so the encoder derives `replacePaths` from the payload.
// These assertions are about that derivation: a hand-written list at each call
// site is the thing that gets forgotten.

import { describe, expect, it } from 'vitest'

import { collectArrayPaths, encodeConfigPatchParams } from '../helpers'

describe('collectArrayPaths', () => {
  it('finds a nested array by its dotted path', () => {
    expect(collectArrayPaths({ tools: { allow: ['a'], deny: ['b'] } })).toEqual([
      'tools.allow',
      'tools.deny',
    ])
  })

  it('does not descend INTO an array', () => {
    // The path names the array itself. Indices are not config paths.
    expect(collectArrayPaths({ a: [{ b: ['c'] }] })).toEqual(['a'])
  })

  it('returns nothing for an all-object payload', () => {
    // The default-model write. It must not acquire a replacePaths it does not need.
    expect(collectArrayPaths({ agents: { defaults: { model: { primary: 'x' } } } })).toEqual([])
  })

  it('ignores object maps, which merge RFC 7386 style', () => {
    // `mcp.servers` removes a key by sending it as null. Replacing the whole map
    // would drop servers clawboo does not own.
    const paths = collectArrayPaths({ mcp: { servers: { a: { url: 'u' }, b: null } } })
    expect(paths).toEqual([])
  })

  it('survives null and undefined branches', () => {
    expect(collectArrayPaths(null)).toEqual([])
    expect(collectArrayPaths(undefined)).toEqual([])
    expect(collectArrayPaths({ a: null, b: undefined, c: ['x'] })).toEqual(['c'])
  })
})

describe('encodeConfigPatchParams', () => {
  it('JSON-stringifies the partial under `raw`', () => {
    const out = encodeConfigPatchParams({ tools: { allow: ['a'] } } as never)
    expect(JSON.parse(out.raw)).toEqual({ tools: { allow: ['a'] } })
  })

  it('carries the optimistic-concurrency hash when given one', () => {
    expect(encodeConfigPatchParams({} as never, 'hmac-sha256:v1:abc').baseHash).toBe(
      'hmac-sha256:v1:abc',
    )
  })

  it('omits baseHash entirely when absent, rather than sending undefined', () => {
    // The params schema is additionalProperties:false; an explicit undefined is
    // not the same as an absent key on the wire.
    expect('baseHash' in encodeConfigPatchParams({} as never)).toBe(false)
  })

  it('declares every array it is about to write', () => {
    // The capability toggle. Without this the disable half is rejected.
    const out = encodeConfigPatchParams({ tools: { allow: ['a'], deny: ['b'] } } as never, 'h')
    expect(out.replacePaths).toEqual(['tools.allow', 'tools.deny'])
  })

  it('omits replacePaths when the payload holds no array', () => {
    expect('replacePaths' in encodeConfigPatchParams({ agents: { defaults: {} } } as never)).toBe(
      false,
    )
  })

  it('lets an explicit replacePaths override the derivation', () => {
    const out = encodeConfigPatchParams({ tools: { allow: ['a'] } } as never, undefined, [
      'tools.deny',
    ])
    expect(out.replacePaths).toEqual(['tools.deny'])
  })

  it('treats an explicit empty array as "declare nothing"', () => {
    expect(
      'replacePaths' in encodeConfigPatchParams({ tools: { allow: ['a'] } } as never, 'h', []),
    ).toBe(false)
  })
})
