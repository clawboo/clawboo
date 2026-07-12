// Origin/Host guard regression suite — the CSWSH + DNS-rebinding + cross-site CSRF
// defense. Drives the REAL createOriginGuard() with mock IncomingMessage/
// ServerResponse objects. The headline case (and acceptance criterion): a WS upgrade
// or /api/* request carrying a FOREIGN Origin is rejected — with NO access-token gate
// involved, since the guard is always-on and independent of it.

import type { IncomingMessage, ServerResponse } from 'node:http'

import { describe, expect, it } from 'vitest'

import { createOriginGuard } from '../origin-guard'

const PORT = 18790
const SELF = `http://localhost:${PORT}`

function mockReq(url: string, headers: Record<string, string> = {}): IncomingMessage {
  // Default Host is loopback at the API port (the legitimate same-origin shape).
  return {
    url,
    headers: { host: `127.0.0.1:${PORT}`, ...headers },
    method: 'GET',
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

describe('origin guard — the CSWSH regression (always-on, no token gate)', () => {
  const guard = createOriginGuard({ port: PORT })

  it('REJECTS a WS upgrade carrying a foreign Origin', () => {
    expect(guard.allowUpgrade(mockReq('/api/gateway/ws', { origin: 'http://evil.com' }))).toBe(
      false,
    )
  })

  it('REJECTS a foreign-Origin /api/* request with 403', () => {
    const cap = mockRes()
    const handled = guard.checkHttp(
      mockReq('/api/settings', { origin: 'http://evil.com' }),
      cap.res,
    )
    expect(handled).toBe(true)
    expect(cap.statusCode).toBe(403)
    expect(cap.body).toContain('Cross-origin request blocked')
  })

  it('ALLOWS a same-origin WS upgrade + /api/* request', () => {
    expect(guard.allowUpgrade(mockReq('/api/gateway/ws', { origin: SELF }))).toBe(true)
    const cap = mockRes()
    expect(guard.checkHttp(mockReq('/api/settings', { origin: SELF }), cap.res)).toBe(false)
    expect(cap.statusCode).toBe(200)
  })
})

describe('origin guard — allowed same-origin forms', () => {
  const guard = createOriginGuard({ port: PORT })

  for (const origin of [
    `http://localhost:${PORT}`,
    `http://127.0.0.1:${PORT}`,
    `http://[::1]:${PORT}`,
    `https://localhost:${PORT}`,
  ]) {
    it(`allows Origin ${origin}`, () => {
      expect(guard.isAllowedOrigin(origin)).toBe(true)
    })
  }

  it('rejects a same-host but DIFFERENT-port origin (a co-resident local app)', () => {
    expect(guard.isAllowedOrigin(`http://localhost:3000`)).toBe(false)
  })

  it('rejects a wrong-scheme foreign origin and userinfo-smuggling', () => {
    expect(guard.isAllowedOrigin('http://evil.com')).toBe(false)
    // `new URL('http://localhost:18790@evil.com').origin` === 'http://evil.com'
    expect(guard.isAllowedOrigin(`http://localhost:${PORT}@evil.com`)).toBe(false)
  })
})

describe('origin guard — absent vs null Origin', () => {
  const guard = createOriginGuard({ port: PORT })

  it('ALLOWS an absent/empty Origin (non-browser client)', () => {
    expect(guard.isAllowedOrigin(undefined)).toBe(true)
    expect(guard.isAllowedOrigin('')).toBe(true)
    expect(guard.allowUpgrade(mockReq('/api/gateway/ws'))).toBe(true)
    const cap = mockRes()
    expect(guard.checkHttp(mockReq('/api/mcp/tasks'), cap.res)).toBe(false) // loopback host, no origin
  })

  it('REJECTS the opaque literal `null` Origin (sandboxed iframe / data: URL)', () => {
    expect(guard.isAllowedOrigin('null')).toBe(false)
    const cap = mockRes()
    expect(guard.checkHttp(mockReq('/api/settings', { origin: 'null' }), cap.res)).toBe(true)
    expect(cap.statusCode).toBe(403)
  })
})

describe('origin guard — Host allowlist (DNS-rebinding defense)', () => {
  const guard = createOriginGuard({ port: PORT })

  it('ALLOWS loopback Host forms', () => {
    expect(guard.isAllowedHost(`localhost:${PORT}`)).toBe(true)
    expect(guard.isAllowedHost(`127.0.0.1:${PORT}`)).toBe(true)
    expect(guard.isAllowedHost(`127.0.0.5:${PORT}`)).toBe(true) // 127.0.0.0/8
    expect(guard.isAllowedHost(`[::1]:${PORT}`)).toBe(true)
    expect(guard.isAllowedHost('localhost')).toBe(true) // no port
  })

  it('REJECTS a rebind Host (evil.com resolving to 127.0.0.1)', () => {
    expect(guard.isAllowedHost(`evil.com:${PORT}`)).toBe(false)
    const cap = mockRes()
    // Rebind: Host is the attacker domain, Origin is absent or the attacker's.
    expect(guard.checkHttp(mockReq('/api/settings', { host: `evil.com:${PORT}` }), cap.res)).toBe(
      true,
    )
    expect(cap.statusCode).toBe(403)
  })

  it('REJECTS an absent Host', () => {
    expect(guard.isAllowedHost(undefined)).toBe(false)
    expect(guard.isAllowedHost('')).toBe(false)
  })

  it('REJECTS a direct cross-site fetch (foreign Origin + loopback Host)', () => {
    const cap = mockRes()
    const handled = guard.checkHttp(
      mockReq('/api/settings', { host: `localhost:${PORT}`, origin: 'http://evil.com' }),
      cap.res,
    )
    expect(handled).toBe(true)
    expect(cap.statusCode).toBe(403)
  })
})

describe('origin guard — Sec-Fetch-Site defense-in-depth (cross-site no-cors GET)', () => {
  const guard = createOriginGuard({ port: PORT })

  it('REJECTS a cross-site request even with an absent Origin (the no-cors-GET gap)', () => {
    const cap = mockRes()
    // A browser omits Origin on a cross-site no-cors GET but ALWAYS sends Sec-Fetch-Site.
    const handled = guard.checkHttp(
      mockReq('/api/settings', { 'sec-fetch-site': 'cross-site' }),
      cap.res,
    )
    expect(handled).toBe(true)
    expect(cap.statusCode).toBe(403)
    expect(guard.allowUpgrade(mockReq('/api/gateway/ws', { 'sec-fetch-site': 'cross-site' }))).toBe(
      false,
    )
  })

  for (const sfs of ['same-origin', 'same-site', 'none']) {
    it(`ALLOWS Sec-Fetch-Site: ${sfs}`, () => {
      const cap = mockRes()
      expect(guard.checkHttp(mockReq('/api/settings', { 'sec-fetch-site': sfs }), cap.res)).toBe(
        false,
      )
    })
  }

  it('ALLOWS an absent Sec-Fetch-Site (non-browser / older browser)', () => {
    const cap = mockRes()
    expect(guard.checkHttp(mockReq('/api/settings'), cap.res)).toBe(false)
  })
})

describe('origin guard — dev Vite origin', () => {
  it('allows http://localhost:5173 ONLY in dev mode', () => {
    const prod = createOriginGuard({ port: PORT, dev: false })
    const devGuard = createOriginGuard({ port: PORT, dev: true })
    expect(prod.isAllowedOrigin('http://localhost:5173')).toBe(false)
    expect(devGuard.isAllowedOrigin('http://localhost:5173')).toBe(true)
    expect(devGuard.isAllowedOrigin('http://127.0.0.1:5173')).toBe(true)
  })
})

describe('origin guard — bind-host + non-loopback posture (BYPASS-1 guard)', () => {
  it('trusts a 127.x loopback-alias bind host origin', () => {
    const guard = createOriginGuard({ port: PORT, bindHost: '127.0.0.5' })
    expect(guard.isAllowedOrigin(`http://127.0.0.5:${PORT}`)).toBe(true)
    expect(guard.isAllowedHost(`127.0.0.5:${PORT}`)).toBe(true)
  })

  it('a 0.0.0.0 bind STILL enforces loopback (foreign rejected, loopback allowed)', () => {
    const guard = createOriginGuard({ port: PORT, bindHost: '0.0.0.0' })
    // The escape hatch never disables enforcement: 127.0.0.1 is still served, so a
    // cross-site page must not be able to drive it.
    expect(guard.isAllowedOrigin('http://evil.com')).toBe(false)
    expect(guard.isAllowedOrigin(`http://127.0.0.1:${PORT}`)).toBe(true)
    expect(guard.isAllowedHost(`127.0.0.1:${PORT}`)).toBe(true)
    // A LAN origin is blocked until enumerated via CLAWBOO_ALLOWED_ORIGINS.
    expect(guard.isAllowedOrigin(`http://192.168.1.5:${PORT}`)).toBe(false)
  })
})

describe('origin guard — CLAWBOO_ALLOWED_ORIGINS / _HOSTS widening', () => {
  const guard = createOriginGuard({
    port: PORT,
    bindHost: '0.0.0.0',
    allowedOrigins: ['https://dash.example.com', 'not a url'],
    allowedHosts: ['dash.example.com'],
  })

  it('allows an operator-supplied origin + host', () => {
    expect(guard.isAllowedOrigin('https://dash.example.com')).toBe(true)
    expect(guard.isAllowedHost('dash.example.com')).toBe(true)
  })

  it('still rejects a foreign origin (widen only, never open)', () => {
    expect(guard.isAllowedOrigin('http://evil.com')).toBe(false)
  })

  it('silently ignores an unparseable allowlist entry (no crash)', () => {
    // 'not a url' was in allowedOrigins but must not become an allowed origin.
    expect(guard.isAllowedOrigin('not a url')).toBe(false)
  })
})

describe('origin guard — checkHttp scope', () => {
  const guard = createOriginGuard({ port: PORT })

  it('does NOT guard non-/api paths (the SPA + static assets stay public)', () => {
    const cap = mockRes()
    // Foreign Origin, but a non-/api path — the guard leaves it alone.
    expect(guard.checkHttp(mockReq('/', { origin: 'http://evil.com' }), cap.res)).toBe(false)
    expect(guard.checkHttp(mockReq('/assets/app.js', { origin: 'http://evil.com' }), cap.res)).toBe(
      false,
    )
  })

  it('guards an uppercased /API/ prefix too (case-folded)', () => {
    const cap = mockRes()
    expect(guard.checkHttp(mockReq('/API/settings', { origin: 'http://evil.com' }), cap.res)).toBe(
      true,
    )
    expect(cap.statusCode).toBe(403)
  })
})
