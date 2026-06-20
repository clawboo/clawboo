// Access-gate auth regression suite. Drives the REAL createAccessGate().handleHttp
// with mock IncomingMessage/ServerResponse objects — the same function the server
// mounts as its sole auth middleware. The headline case is the gate-bypass: an
// uppercased `/API/...` prefix must NOT evade the gate (Express routes
// case-insensitively, so a cased variant reaches the same sensitive route).

import type { IncomingMessage, ServerResponse } from 'node:http'

import { describe, expect, it } from 'vitest'

import { createAccessGate } from '../access-gate'

const TOKEN = 'super-secret-token-value'

function mockReq(
  url: string,
  headers: Record<string, string> = {},
  remoteAddress?: string,
): IncomingMessage {
  return {
    url,
    headers: { host: 'dash.local', ...headers },
    method: 'GET',
    socket: { remoteAddress },
  } as unknown as IncomingMessage
}

interface CapturedRes {
  res: ServerResponse
  get statusCode(): number
  headers: Record<string, string>
  body: string
}

function mockRes(): CapturedRes {
  const headers: Record<string, string> = {}
  let body = ''
  const res = {
    statusCode: 200,
    setHeader(name: string, value: string) {
      headers[name.toLowerCase()] = value
    },
    end(chunk?: string) {
      if (typeof chunk === 'string') body += chunk
    },
  } as unknown as ServerResponse
  return {
    res,
    get statusCode() {
      return res.statusCode
    },
    headers,
    get body() {
      return body
    },
  }
}

describe('access gate — disabled when no token', () => {
  it('passes every request through (handleHttp returns false)', () => {
    const gate = createAccessGate({ token: undefined })
    expect(gate.enabled).toBe(false)
    const cap = mockRes()
    expect(gate.handleHttp(mockReq('/api/settings'), cap.res)).toBe(false)
    expect(cap.statusCode).toBe(200)
  })
})

describe('access gate — case bypass is closed (the CRITICAL)', () => {
  const gate = createAccessGate({ token: TOKEN })

  it('is enabled when a token is set', () => {
    expect(gate.enabled).toBe(true)
  })

  for (const path of [
    '/api/settings',
    '/API/settings',
    '/Api/Settings',
    '/aPi/runtimes/x/run',
    '/API/agents/a1/files/SOUL.md',
    '/api/totally-unknown-future-route',
  ]) {
    it(`blocks ${path} with 401 when no valid cookie`, () => {
      const cap = mockRes()
      const handled = gate.handleHttp(mockReq(path), cap.res)
      expect(handled).toBe(true)
      expect(cap.statusCode).toBe(401)
    })
  }

  it('allows /api/settings WHEN the request carries the valid cookie', () => {
    const cap = mockRes()
    const req = mockReq('/api/settings', { cookie: `clawboo_access=${TOKEN}` })
    expect(gate.handleHttp(req, cap.res)).toBe(false)
    expect(cap.statusCode).toBe(200)
  })

  it('also accepts the valid cookie for an uppercased prefix', () => {
    const cap = mockRes()
    const req = mockReq('/API/settings', { cookie: `clawboo_access=${TOKEN}` })
    expect(gate.handleHttp(req, cap.res)).toBe(false)
  })

  it('treats non-/api paths (the SPA) as public', () => {
    const cap = mockRes()
    expect(gate.handleHttp(mockReq('/'), cap.res)).toBe(false)
    expect(gate.handleHttp(mockReq('/assets/app.js'), cap.res)).toBe(false)
  })
})

describe('access gate — query-param token exchange (constant-time)', () => {
  const gate = createAccessGate({ token: TOKEN })

  it('rejects a wrong ?access_token with 401', () => {
    const cap = mockRes()
    const handled = gate.handleHttp(mockReq('/?access_token=wrong'), cap.res)
    expect(handled).toBe(true)
    expect(cap.statusCode).toBe(401)
    expect(cap.headers['set-cookie']).toBeUndefined()
  })

  it('accepts the right ?access_token: sets cookie + 302 redirect', () => {
    const cap = mockRes()
    const handled = gate.handleHttp(mockReq(`/?access_token=${TOKEN}`), cap.res)
    expect(handled).toBe(true)
    expect(cap.statusCode).toBe(302)
    expect(cap.headers['set-cookie']).toContain(`clawboo_access=${TOKEN}`)
    expect(cap.headers['set-cookie']).toContain('HttpOnly')
    expect(cap.headers['set-cookie']).toContain('SameSite=Lax')
  })
})

describe('access gate — Secure cookie only over TLS', () => {
  const gate = createAccessGate({ token: TOKEN })

  it('omits Secure on a plain-http origin (else the cookie never returns)', () => {
    const cap = mockRes()
    gate.handleHttp(mockReq(`/?access_token=${TOKEN}`), cap.res)
    expect(cap.headers['set-cookie']).not.toContain('Secure')
  })

  it('adds Secure when x-forwarded-proto is https', () => {
    const cap = mockRes()
    gate.handleHttp(mockReq(`/?access_token=${TOKEN}`, { 'x-forwarded-proto': 'https' }), cap.res)
    expect(cap.headers['set-cookie']).toContain('Secure')
  })
})

describe('access gate — loopback /api/mcp/* exemption (so spawned runtimes still reach MCP)', () => {
  const gate = createAccessGate({ token: TOKEN })

  for (const addr of ['127.0.0.1', '::1', '::ffff:127.0.0.1']) {
    it(`lets a cookieless /api/mcp/tasks through from loopback ${addr}`, () => {
      const cap = mockRes()
      // A spawned runtime: loopback peer, no cookie (token scrubbed from its env).
      const handled = gate.handleHttp(mockReq('/api/mcp/tasks', {}, addr), cap.res)
      expect(handled).toBe(false) // passed through, not 401
      expect(cap.statusCode).toBe(200)
    })
  }

  it('still 401s a NON-loopback /api/mcp/tasks without a cookie', () => {
    const cap = mockRes()
    const handled = gate.handleHttp(mockReq('/api/mcp/tasks', {}, '203.0.113.7'), cap.res)
    expect(handled).toBe(true)
    expect(cap.statusCode).toBe(401)
  })

  it('still 401s a loopback NON-mcp /api route (the exemption is /api/mcp/* only)', () => {
    const cap = mockRes()
    const handled = gate.handleHttp(mockReq('/api/settings', {}, '127.0.0.1'), cap.res)
    expect(handled).toBe(true)
    expect(cap.statusCode).toBe(401)
  })
})

describe('access gate — token charset (an unusable token fails loud, not a silent lockout)', () => {
  it('disables the gate when the token carries a cookie-delimiter / non-token char', () => {
    for (const bad of ['has space', 'semi;colon', 'comma,token', 'pct%encode', 'plus+token']) {
      const gate = createAccessGate({ token: bad })
      expect(gate.enabled).toBe(false) // disabled, not a silent permanent 401
      const cap = mockRes()
      expect(gate.handleHttp(mockReq('/api/settings'), cap.res)).toBe(false)
    }
  })

  it('stays enabled for a safe token charset', () => {
    const gate = createAccessGate({ token: 'A1b2._~-token' })
    expect(gate.enabled).toBe(true)
  })
})

describe('access gate — websocket upgrades', () => {
  it('allows upgrades only with a valid cookie when enabled', () => {
    const gate = createAccessGate({ token: TOKEN })
    expect(gate.allowUpgrade(mockReq('/api/gateway/ws'))).toBe(false)
    expect(
      gate.allowUpgrade(mockReq('/api/gateway/ws', { cookie: `clawboo_access=${TOKEN}` })),
    ).toBe(true)
  })
})
