// The CLAWBOO_BASE_PATH contract. Everything that has to agree on the prefix
// (the Express mount, the templated SPA shell, the WS upgrade route, the access
// cookie scope, the CLI's printed URLs) normalizes through here, so the accepted
// and rejected shapes are pinned in one place.

import { describe, expect, it } from 'vitest'

import { normalizeBasePath, resolveBasePath, resolveBasePathOrRoot } from '../basePath'

describe('normalizeBasePath', () => {
  it('treats unset, empty, and "/" as the root', () => {
    for (const raw of [undefined, null, '', '   ', '/']) {
      expect(normalizeBasePath(raw)).toEqual({ ok: true, basePath: '' })
    }
  })

  it('normalizes the shapes an operator actually types', () => {
    // A proxy location block gets copied in with or without either slash.
    for (const raw of ['/clawboo', 'clawboo', '/clawboo/', 'clawboo/', '  /clawboo/  ']) {
      expect(normalizeBasePath(raw)).toEqual({ ok: true, basePath: '/clawboo' })
    }
  })

  it('keeps a multi-segment prefix', () => {
    expect(normalizeBasePath('/tools/clawboo')).toEqual({ ok: true, basePath: '/tools/clawboo' })
    expect(normalizeBasePath('tools/clawboo/')).toEqual({ ok: true, basePath: '/tools/clawboo' })
  })

  it('accepts the unreserved characters and rejects everything else', () => {
    expect(normalizeBasePath('/claw-boo_v2.1~x')).toEqual({
      ok: true,
      basePath: '/claw-boo_v2.1~x',
    })
    for (const raw of [
      '/claw boo',
      '/claw\tboo',
      '/claw\\boo',
      '/claw?boo',
      '/claw#boo',
      '/cl%61w',
    ]) {
      expect(normalizeBasePath(raw).ok).toBe(false)
    }
  })

  it('rejects empty and dot segments rather than silently repairing them', () => {
    // Repairing these would change what the prefix MATCHES, which is a silently
    // broken mount instead of a loud startup failure.
    for (const raw of ['//clawboo', '/clawboo//x', '/./clawboo', '/../clawboo', '/clawboo/..']) {
      expect(normalizeBasePath(raw).ok).toBe(false)
    }
    expect(normalizeBasePath('//')).toEqual({ ok: false, reason: 'contains only slashes' })
  })

  it("rejects a first segment of 'api', which would collide with the API routes", () => {
    for (const raw of ['/api', 'api', '/API', '/Api/x']) {
      const out = normalizeBasePath(raw)
      expect(out.ok).toBe(false)
      if (!out.ok) expect(out.reason).toMatch(/api/i)
    }
    // Only the FIRST segment collides; 'api' deeper in the prefix is fine.
    expect(normalizeBasePath('/tools/api')).toEqual({ ok: true, basePath: '/tools/api' })
  })

  it('gives a reason for every rejection', () => {
    for (const raw of ['/claw boo', '//clawboo', '/api', '/cl%61w', '/claw\\boo']) {
      const out = normalizeBasePath(raw)
      expect(out.ok).toBe(false)
      if (!out.ok) expect(out.reason.length).toBeGreaterThan(0)
    }
  })
})

describe('resolveBasePath', () => {
  it('reads CLAWBOO_BASE_PATH from the supplied env bag', () => {
    expect(resolveBasePath({ CLAWBOO_BASE_PATH: '/clawboo/' })).toEqual({
      ok: true,
      basePath: '/clawboo',
    })
    expect(resolveBasePath({})).toEqual({ ok: true, basePath: '' })
    expect(resolveBasePath({ CLAWBOO_BASE_PATH: '/api' }).ok).toBe(false)
  })

  it('resolveBasePathOrRoot falls back to the root for a display-only caller', () => {
    // The CLI only prints URLs, so it must not die on a value the server will
    // reject on its own with a precise message.
    expect(resolveBasePathOrRoot({ CLAWBOO_BASE_PATH: '/clawboo' })).toBe('/clawboo')
    expect(resolveBasePathOrRoot({ CLAWBOO_BASE_PATH: '/api' })).toBe('')
    expect(resolveBasePathOrRoot({})).toBe('')
  })
})
