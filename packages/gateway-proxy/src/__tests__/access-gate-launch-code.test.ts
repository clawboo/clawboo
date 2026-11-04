// One-time launch codes: how a browser gets the access cookie without the token
// ever appearing in a URL. `clawboo open` and the dashboard's "Open on another
// device" mint a code; `?access_code=<code>` on a page URL trades it for the
// cookie once, within two minutes. Drives the real createAccessGate().handleHttp.

import type { IncomingMessage, ServerResponse } from 'node:http'

import { describe, expect, it } from 'vitest'

import { createAccessGate } from '../access-gate'

const TOKEN = 'super-secret-token-value'

/** What a browser sends when it loads a page: a top-level navigation. */
const PAGE_LOAD = {
  'sec-fetch-mode': 'navigate',
  'sec-fetch-dest': 'document',
  'sec-fetch-site': 'none',
}

function mockReq(
  url: string,
  headers: Record<string, string> = PAGE_LOAD,
  method = 'GET',
): IncomingMessage {
  return {
    url,
    headers: { host: 'localhost:18790', ...headers },
    method,
    socket: { remoteAddress: '127.0.0.1' },
  } as unknown as IncomingMessage
}

function mockRes() {
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

/** A gate on a clock the test moves by hand. */
function gateAt(start = 1_000_000, extra: Parameters<typeof createAccessGate>[0] = {}) {
  const clock = { now: start }
  const gate = createAccessGate({ token: TOKEN, now: () => clock.now, ...extra })
  return { gate, clock }
}

function open(
  gate: ReturnType<typeof createAccessGate>,
  url: string,
  extra: Record<string, string> = {},
  base: Record<string, string> = PAGE_LOAD,
  method = 'GET',
) {
  const cap = mockRes()
  const handled = gate.handleHttp(mockReq(url, { ...base, ...extra }, method), cap.res)
  return { handled, ...cap }
}

describe('mintLaunchCode', () => {
  it('is null when the gate is off', () => {
    const gate = createAccessGate({ token: '' })
    expect(gate.mintLaunchCode()).toBeNull()
  })

  it('mints an unguessable URL-safe code that lives two minutes', () => {
    const { gate } = gateAt(5_000)
    const minted = gate.mintLaunchCode()
    expect(minted).not.toBeNull()
    expect(minted!.code).toMatch(/^[A-Za-z0-9_-]{32,}$/)
    expect(minted!.code).not.toContain(TOKEN)
    expect(minted!.expiresAt).toBe(5_000 + 120_000)
  })

  it('mints a different code each time', () => {
    const { gate } = gateAt()
    const codes = new Set(Array.from({ length: 20 }, () => gate.mintLaunchCode()!.code))
    expect(codes.size).toBe(20)
  })
})

describe('?access_code= on a page URL', () => {
  it('sets the access cookie and redirects to the same URL without the code', () => {
    const { gate } = gateAt()
    const { code } = gate.mintLaunchCode()!
    const reply = open(gate, `/?view=board&access_code=${code}`)
    expect(reply.handled).toBe(true)
    expect(reply.statusCode).toBe(302)
    expect(reply.headers['set-cookie']).toContain(`clawboo_access=${TOKEN}`)
    expect(reply.headers['set-cookie']).toContain('HttpOnly')
    expect(reply.headers['set-cookie']).toContain('SameSite=Lax')
    expect(reply.headers['set-cookie']).not.toContain('Secure')
    expect(reply.headers['location']).toBe('http://localhost:18790/?view=board')
  })

  it('works once: the second use gets no cookie', () => {
    const { gate } = gateAt()
    const { code } = gate.mintLaunchCode()!
    expect(open(gate, `/?access_code=${code}`).headers['set-cookie']).toBeDefined()
    const again = open(gate, `/?access_code=${code}`)
    expect(again.statusCode).toBe(302)
    expect(again.headers['set-cookie']).toBeUndefined()
    expect(again.headers['location']).toBe('http://localhost:18790/')
  })

  it('is dead after two minutes', () => {
    const { gate, clock } = gateAt()
    const { code, expiresAt } = gate.mintLaunchCode()!
    clock.now = expiresAt
    const reply = open(gate, `/?access_code=${code}`)
    expect(reply.statusCode).toBe(302)
    expect(reply.headers['set-cookie']).toBeUndefined()
  })

  it('still works just before it expires', () => {
    const { gate, clock } = gateAt()
    const { code, expiresAt } = gate.mintLaunchCode()!
    clock.now = expiresAt - 1
    expect(open(gate, `/?access_code=${code}`).headers['set-cookie']).toBeDefined()
  })

  it('gives an unknown code no cookie, and lands the browser on the page so it can say why', () => {
    const { gate } = gateAt()
    const reply = open(gate, '/?access_code=made-up-code-that-was-never-minted')
    expect(reply.statusCode).toBe(302)
    expect(reply.headers['set-cookie']).toBeUndefined()
    expect(reply.headers['location']).toBe('http://localhost:18790/')
  })

  it('never accepts the token itself as a code', () => {
    const { gate } = gateAt()
    expect(open(gate, `/?access_code=${TOKEN}`).headers['set-cookie']).toBeUndefined()
  })

  it('keeps every outstanding code valid on its own', () => {
    const { gate } = gateAt()
    const first = gate.mintLaunchCode()!.code
    const second = gate.mintLaunchCode()!.code
    expect(open(gate, `/?access_code=${second}`).headers['set-cookie']).toBeDefined()
    expect(open(gate, `/?access_code=${first}`).headers['set-cookie']).toBeDefined()
  })

  it('holds a bounded number of codes: the oldest goes first', () => {
    const { gate } = gateAt()
    const codes = Array.from({ length: 65 }, () => gate.mintLaunchCode()!.code)
    expect(open(gate, `/?access_code=${codes[0]}`).headers['set-cookie']).toBeUndefined()
    expect(open(gate, `/?access_code=${codes[64]}`).headers['set-cookie']).toBeDefined()
  })

  it('adds Secure when the request came over TLS', () => {
    const { gate } = gateAt()
    const { code } = gate.mintLaunchCode()!
    const reply = open(gate, `/?access_code=${code}`, { 'x-forwarded-proto': 'https' })
    expect(reply.headers['set-cookie']).toContain('Secure')
    expect(reply.headers['location']).toBe('https://localhost:18790/')
  })

  it('scopes the cookie to a mount and redirects back under it', () => {
    const { gate } = gateAt(1_000_000, { basePath: '/clawboo' })
    const { code } = gate.mintLaunchCode()!
    const reply = open(gate, `/?access_code=${code}`)
    expect(reply.headers['set-cookie']).toContain('Path=/clawboo')
    expect(reply.headers['location']).toBe('http://localhost:18790/clawboo/')
  })
})

describe('?access_code= on something other than a page load', () => {
  // A link previewer (a chat app fetching the link to show a card) or a script
  // must not spend the code, or it would receive the token in Set-Cookie and the
  // device the link was meant for would land on the locked screen.
  for (const [name, headers] of [
    ['a fetch() from a page', { 'sec-fetch-mode': 'cors', 'sec-fetch-dest': 'empty' }],
    ['a frame', { 'sec-fetch-mode': 'navigate', 'sec-fetch-dest': 'iframe' }],
    ['an image', { 'sec-fetch-mode': 'no-cors', 'sec-fetch-dest': 'image' }],
  ] as const) {
    it(`sets no cookie for ${name}, and the code survives for the browser`, () => {
      const { gate } = gateAt()
      const { code } = gate.mintLaunchCode()!
      const fetched = open(gate, `/?access_code=${code}`, {}, headers)
      expect(fetched.statusCode).toBe(302)
      expect(fetched.headers['set-cookie']).toBeUndefined()
      expect(fetched.headers['location']).toBe('http://localhost:18790/')
      expect(open(gate, `/?access_code=${code}`).headers['set-cookie']).toBeDefined()
    })
  }

  it('accepts a page load that came from another site (a link tapped in a chat app)', () => {
    const { gate } = gateAt()
    const { code } = gate.mintLaunchCode()!
    const reply = open(gate, `/?access_code=${code}`, { 'sec-fetch-site': 'cross-site' })
    expect(reply.headers['set-cookie']).toBeDefined()
  })
})

describe('?access_code= with no fetch metadata at all', () => {
  // A browser sends Sec-Fetch-* only to an HTTPS or loopback origin, so a phone
  // opening a plain-HTTP LAN link sends none, and neither does a link previewer.
  // Neither is spent by the GET: the browser gets a page whose button POSTs the
  // code, which a previewer never does.
  it('serves a sign-in page that posts the code, sets no cookie, and keeps the code', () => {
    const { gate } = gateAt()
    const { code } = gate.mintLaunchCode()!
    const page = open(gate, `/?access_code=${code}`, {}, {})
    expect(page.handled).toBe(true)
    expect(page.statusCode).toBe(200)
    expect(page.headers['content-type']).toContain('text/html')
    expect(page.headers['cache-control']).toBe('no-store')
    expect(page.headers['content-security-policy']).toContain("frame-ancestors 'none'")
    expect(page.headers['set-cookie']).toBeUndefined()
    expect(page.body).toContain('method="post"')
    expect(page.body).toContain(`action="?access_code=${code}"`)
    expect(page.body).not.toContain(TOKEN)
    expect(open(gate, `/?access_code=${code}`).headers['set-cookie']).toBeDefined()
  })

  it('signs in on the POST from that page, once', () => {
    const { gate } = gateAt()
    const { code } = gate.mintLaunchCode()!
    const posted = open(gate, `/board?access_code=${code}`, {}, {}, 'POST')
    expect(posted.statusCode).toBe(303)
    expect(posted.headers['set-cookie']).toContain(`clawboo_access=${TOKEN}`)
    expect(posted.headers['location']).toBe('http://localhost:18790/board')
    const again = open(gate, `/board?access_code=${code}`, {}, {}, 'POST')
    expect(again.statusCode).toBe(303)
    expect(again.headers['set-cookie']).toBeUndefined()
  })

  it('does not put a malformed code into the page', () => {
    const { gate } = gateAt()
    const reply = open(gate, '/?access_code="><script>alert(1)</script>', {}, {})
    expect(reply.statusCode).toBe(302)
    expect(reply.body).not.toContain('<script>')
    expect(reply.headers['set-cookie']).toBeUndefined()
  })
})

describe('?access_code= on an /api/ path', () => {
  it('is not accepted by a POST to an /api/ path either', () => {
    const { gate } = gateAt()
    const { code } = gate.mintLaunchCode()!
    const api = open(gate, `/api/settings?access_code=${code}`, {}, {}, 'POST')
    expect(api.statusCode).toBe(401)
    expect(open(gate, `/?access_code=${code}`).headers['set-cookie']).toBeDefined()
  })

  for (const path of ['/api/settings', '/API/settings', '/api/access/launch-code']) {
    it(`is not accepted on ${path}, and the code survives for the page`, () => {
      const { gate } = gateAt()
      const { code } = gate.mintLaunchCode()!
      const api = open(gate, `${path}?access_code=${code}`)
      expect(api.handled).toBe(true)
      expect(api.statusCode).toBe(401)
      expect(api.headers['set-cookie']).toBeUndefined()
      expect(open(gate, `/?access_code=${code}`).headers['set-cookie']).toBeDefined()
    })
  }
})

describe('the refusal names the way in', () => {
  it('keeps "clawboo" and "token" (older launchers and the desktop app key off both)', () => {
    const { gate } = gateAt()
    const reply = open(gate, '/api/settings')
    const body = JSON.parse(reply.body) as { error: string }
    expect(body.error.toLowerCase()).toContain('clawboo')
    expect(body.error.toLowerCase()).toContain('token')
  })

  it('names clawboo open', () => {
    const { gate } = gateAt()
    const body = JSON.parse(open(gate, '/api/settings').body) as { error: string }
    expect(body.error).toContain('clawboo open')
  })

  it('marks itself as the access gate, for the dashboard to recognise', () => {
    const { gate } = gateAt()
    const body = JSON.parse(open(gate, '/api/settings').body) as { gate?: string }
    expect(body.gate).toBe('clawboo-access')
  })
})
