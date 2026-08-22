// The Gateway proxy URL under a path prefix.
//
// The prefix reaches this helper two ways: the global the server templates into
// the SPA shell, and an explicit argument. Both are normalized, because a caller
// (or an operator's env value) may spell the prefix with a trailing slash, and
// `/clawboo/` + `/api/gateway/ws` would otherwise produce a doubled slash. `/`
// is worse than cosmetic: `//api/gateway/ws` is protocol-relative.

import { afterEach, describe, expect, it } from 'vitest'

import { resolveProxyGatewayUrl } from '../helpers'

const g = globalThis as { __CLAWBOO_BASE__?: unknown }
afterEach(() => {
  delete g.__CLAWBOO_BASE__
})

// `window` is undefined here, so the helper takes its SSR branch and returns the
// loopback form. The base handling is identical on both branches.
describe('resolveProxyGatewayUrl', () => {
  it('serves the root when no prefix is set', () => {
    expect(resolveProxyGatewayUrl()).toBe('ws://localhost:18790/api/gateway/ws')
  })

  it('reads the prefix the server templated into the shell', () => {
    g.__CLAWBOO_BASE__ = '/clawboo'
    expect(resolveProxyGatewayUrl()).toBe('ws://localhost:18790/clawboo/api/gateway/ws')
  })

  it('normalizes whatever shape the prefix arrives in', () => {
    for (const raw of ['/clawboo', 'clawboo', '/clawboo/', 'clawboo//', '  /clawboo/  ']) {
      expect(resolveProxyGatewayUrl(raw), raw).toBe('ws://localhost:18790/clawboo/api/gateway/ws')
    }
  })

  it('treats an empty or root-only prefix as the root, never a doubled slash', () => {
    // `//api/gateway/ws` would be read as protocol-relative, pointing the socket
    // at a host named "api".
    for (const raw of ['', '/', '   ', '//']) {
      expect(resolveProxyGatewayUrl(raw), JSON.stringify(raw)).toBe(
        'ws://localhost:18790/api/gateway/ws',
      )
    }
  })

  it('ignores a non-string global rather than interpolating it', () => {
    g.__CLAWBOO_BASE__ = 42
    expect(resolveProxyGatewayUrl()).toBe('ws://localhost:18790/api/gateway/ws')
  })
})
