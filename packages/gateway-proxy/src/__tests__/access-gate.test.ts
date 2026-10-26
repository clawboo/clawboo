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

describe('access gate — /api/mcp/* admits a runtime by its attach credential; the address can only refuse', () => {
  // `authorizeRuntime` stands in for the server's real check (the attach token the
  // server minted into the runtime's URL). What is under test here is when the
  // gate asks it, and when it never does.
  const consulted: string[] = []
  const gate = createAccessGate({
    token: TOKEN,
    authorizeRuntime: (req) => {
      consulted.push(req.url ?? '')
      return (req.url ?? '').includes('attachToken=good')
    },
  })

  for (const addr of ['127.0.0.1', '::1', '::ffff:127.0.0.1']) {
    it(`401s a cookieless, credential-less /api/mcp/tasks from loopback ${addr}`, () => {
      // The old exemption let exactly this through: a loopback peer was taken to
      // be the server's own runtime.
      const cap = mockRes()
      const handled = gate.handleHttp(mockReq('/api/mcp/tasks', {}, addr), cap.res)
      expect(handled).toBe(true)
      expect(cap.statusCode).toBe(401)
    })
  }

  for (const addr of ['127.0.0.1', '::1', '::ffff:127.0.0.1']) {
    it(`admits a cookieless /api/mcp/tasks the runtime check vouches for, from loopback ${addr}`, () => {
      const cap = mockRes()
      const req = mockReq('/api/mcp/tasks?attachToken=good', {}, addr)
      expect(gate.handleHttp(req, cap.res)).toBe(false)
      expect(cap.statusCode).toBe(200)
    })
  }

  for (const addr of ['192.168.1.50', '203.0.113.7', '::ffff:10.0.0.5', undefined]) {
    it(`refuses even a vouched-for credential from a non-loopback peer (${String(addr)})`, () => {
      // A wide bind (HOST=0.0.0.0) takes connections from the network directly.
      // A runtime always dials loopback, so a token arriving from anywhere else
      // was lifted from a config, and it must be worth nothing there.
      consulted.length = 0
      const cap = mockRes()
      const req = mockReq('/api/mcp/tasks?attachToken=good', {}, addr)
      expect(gate.handleHttp(req, cap.res)).toBe(true)
      expect(cap.statusCode).toBe(401)
      expect(consulted).toEqual([])
    })
  }

  it('401s a credential the runtime check rejects', () => {
    const cap = mockRes()
    const req = mockReq('/api/mcp/tasks?attachToken=forged', {}, '127.0.0.1')
    expect(gate.handleHttp(req, cap.res)).toBe(true)
    expect(cap.statusCode).toBe(401)
  })

  for (const [name, headers] of [
    ['X-Forwarded-For', { 'x-forwarded-for': '203.0.113.7' }],
    ['Forwarded', { forwarded: 'for=203.0.113.7' }],
    ['X-Forwarded-Proto', { 'x-forwarded-proto': 'https' }],
  ] as const) {
    it(`refuses even a vouched-for credential on a proxied request (${name}): a replayed token`, () => {
      // A runtime dials the loopback port directly, so its requests never carry a
      // forwarding header. One that does came in through the proxy, with a token
      // lifted from a runtime's config.
      const cap = mockRes()
      const req = mockReq('/api/mcp/tasks?attachToken=good', headers, '127.0.0.1')
      expect(gate.handleHttp(req, cap.res)).toBe(true)
      expect(cap.statusCode).toBe(401)
    })
  }

  it('never consults the runtime check outside /api/mcp/*', () => {
    consulted.length = 0
    const cap = mockRes()
    const handled = gate.handleHttp(
      mockReq('/api/settings?attachToken=good', {}, '127.0.0.1'),
      cap.res,
    )
    expect(handled).toBe(true)
    expect(cap.statusCode).toBe(401)
    expect(consulted).toEqual([])
  })

  it('still accepts the operator cookie on /api/mcp/*, proxied or not', () => {
    const variants: Record<string, string>[] = [{}, { 'x-forwarded-for': '203.0.113.7' }]
    for (const headers of variants) {
      const cap = mockRes()
      const req = mockReq(
        '/api/mcp/config',
        { cookie: `clawboo_access=${TOKEN}`, ...headers },
        '127.0.0.1',
      )
      expect(gate.handleHttp(req, cap.res)).toBe(false)
    }
  })

  it('without authorizeRuntime, /api/mcp/* needs the cookie like every other route', () => {
    const plain = createAccessGate({ token: TOKEN })
    const cap = mockRes()
    expect(
      plain.handleHttp(mockReq('/api/mcp/tasks?attachToken=good', {}, '127.0.0.1'), cap.res),
    ).toBe(true)
    expect(cap.statusCode).toBe(401)
  })
})

describe('access gate — /api/mcp/* behind a same-host reverse proxy', () => {
  // nginx, Caddy or a Cloudflare Tunnel connector on the same box forwards every
  // request to 127.0.0.1, so the socket peer of a request from ANYWHERE on the
  // internet is loopback. The forwarding header the proxy adds is the only trace
  // of the real client.
  const gate = createAccessGate({ token: TOKEN })
  const PROXIED: readonly [string, Record<string, string>][] = [
    ['X-Forwarded-For', { 'x-forwarded-for': '203.0.113.7' }],
    ['Forwarded', { forwarded: 'for=203.0.113.7;proto=https' }],
    ['X-Real-IP', { 'x-real-ip': '203.0.113.7' }],
  ]

  for (const [name, headers] of PROXIED) {
    it(`401s a cookieless /api/mcp/tasks from a remote client (loopback socket + ${name})`, () => {
      const cap = mockRes()
      const handled = gate.handleHttp(mockReq('/api/mcp/tasks', headers, '127.0.0.1'), cap.res)
      expect(handled).toBe(true)
      expect(cap.statusCode).toBe(401)
    })
  }

  it('401s a proxied /api/mcp/config, the route that mints signed attach URLs', () => {
    const cap = mockRes()
    const req = mockReq(
      '/api/mcp/config?server=tools&scopeAgentId=agent-1',
      { 'x-forwarded-for': '203.0.113.7' },
      '127.0.0.1',
    )
    expect(gate.handleHttp(req, cap.res)).toBe(true)
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
