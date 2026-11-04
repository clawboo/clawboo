// Every spelling of a request path, as Node's HTTP parser hands it over. The
// guards decide what to protect from a request's path, and the app's router
// decides where to send it; they read a path in different ways (see
// request-path.ts). These drive the REAL createAccessGate and createOriginGuard
// behind a real Node server, with each target written to a raw socket, because
// fetch and every HTTP client library resolve dot segments and turn a whole URL
// into a path before sending.

import http, { type IncomingMessage, type ServerResponse } from 'node:http'
import net from 'node:net'

import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { createAccessGate } from '../access-gate'
import { createOriginGuard } from '../origin-guard'
import {
  anyPathUnder,
  everyPathUnder,
  isOriginFormTarget,
  requestPathReadings,
  targetPath,
} from '../request-path'

const TOKEN = 'path-readings-token'

interface RawResponse {
  status: number
  body: string
}

/** Write one request to the server exactly as given and read the status line. */
function rawRequest(
  port: number,
  target: string,
  headers: Record<string, string> = {},
  method = 'GET',
): Promise<RawResponse> {
  return new Promise((resolve, reject) => {
    const socket = net.connect(port, '127.0.0.1', () => {
      const lines = [`${method} ${target} HTTP/1.1`, `Host: 127.0.0.1:${port}`, 'Connection: close']
      for (const [name, value] of Object.entries(headers)) lines.push(`${name}: ${value}`)
      socket.write(`${lines.join('\r\n')}\r\n\r\n`)
    })
    let data = ''
    socket.setEncoding('utf8')
    socket.on('data', (chunk: string) => (data += chunk))
    socket.on('error', reject)
    socket.on('end', () => {
      const status = Number(/^HTTP\/1\.1 (\d{3})/.exec(data)?.[1] ?? 0)
      resolve({ status, body: data.split('\r\n\r\n').slice(1).join('\r\n\r\n') })
    })
  })
}

/** A server that runs `guard` and answers 200 `passed` to whatever it lets
 *  through, or 500 when the guard throws. */
async function serve(
  guard: (req: IncomingMessage, res: ServerResponse) => boolean,
): Promise<{ port: number; close: () => Promise<void> }> {
  const server = http.createServer((req, res) => {
    try {
      if (guard(req, res)) return
    } catch {
      res.statusCode = 500
      res.end('threw')
      return
    }
    res.statusCode = 200
    res.end('passed')
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('no port')
  return {
    port: address.port,
    close: () => new Promise((resolve) => server.close(() => resolve())),
  }
}

// Paths whose resolved form is outside /api/ while the path as sent is under it.
const DOT_SEGMENT_TARGETS = [
  '/api/x/1/preview/../../../../y',
  '/api/x/1/preview/%2e%2e/%2e%2e/%2e%2e/%2e%2e/y',
  '/api/x/1/preview/.%2E/%2E./.%2e/%2e%2e/y?q=1',
  '/api/x/1/preview/..\\..\\..\\..\\y',
  // A fragment sends Express's parser down its slow path, which reads these
  // backslashes as slashes: the router then sees /api/x/1/preview/...
  '/api\\x\\1\\preview\\..\\..\\..\\..\\y#f',
]

describe('access gate: no spelling of an /api/ path skips the cookie', () => {
  let port: number
  let close: () => Promise<void>
  beforeAll(async () => {
    const gate = createAccessGate({ token: TOKEN })
    ;({ port, close } = await serve((req, res) => gate.handleHttp(req, res)))
  })
  afterAll(() => close())

  for (const target of DOT_SEGMENT_TARGETS) {
    it(`401s ${JSON.stringify(target)} without the cookie`, async () => {
      const res = await rawRequest(port, target)
      expect(res.status).toBe(401)
      expect(res.body).toContain('clawboo-access')
    })
  }

  it('401s an absolute-form target whose path resolves outside /api/', async () => {
    const res = await rawRequest(port, `http://127.0.0.1:${port}/api/x/1/preview/../../../../y`)
    expect(res.status).toBe(401)
  })

  it('401s an absolute-form target under /api/', async () => {
    const res = await rawRequest(port, `http://127.0.0.1:${port}/api/x/1/preview/a`)
    expect(res.status).toBe(401)
  })

  it('lets the same targets through with the cookie', async () => {
    for (const target of DOT_SEGMENT_TARGETS) {
      const res = await rawRequest(port, target, { Cookie: `clawboo_access=${TOKEN}` })
      expect(res.status, target).toBe(200)
    }
  })

  it('still serves pages and static files without the cookie', async () => {
    for (const target of ['/', '/y', '/assets/app.js', '/x/../y', '/apix/settings']) {
      const res = await rawRequest(port, target)
      expect(res.status, target).toBe(200)
    }
  })

  it('400s a target the URL parser cannot read, instead of throwing', async () => {
    // Node's HTTP parser hands this over as it is.
    expect((await rawRequest(port, '//[x/api/y')).status).toBe(400)
  })

  it('never spends a launch code on a path that is an /api/ path as sent', async () => {
    // The code would be taken on a page address; one of these readings is not.
    const res = await rawRequest(port, '/api/x/../../y?access_code=abcdefghijklmnopqrst')
    expect(res.status).toBe(401)
  })
})

describe('access gate: the /api/mcp/ exemption needs every reading under /api/mcp/', () => {
  let port: number
  let close: () => Promise<void>
  beforeAll(async () => {
    // Vouches for every request, so only the path decides. The raw socket dials
    // loopback and sends no forwarding headers, as a spawned runtime does.
    const gate = createAccessGate({ token: TOKEN, authorizeRuntime: () => true })
    ;({ port, close } = await serve((req, res) => gate.handleHttp(req, res)))
  })
  afterAll(() => close())

  it('admits a runtime on a plain /api/mcp/ path', async () => {
    expect((await rawRequest(port, '/api/mcp/tasks?attachToken=t')).status).toBe(200)
  })

  for (const target of [
    '/api/x/1/preview/../../../mcp/tasks',
    '/api/x/1/preview/%2e%2e/%2e%2e/%2e%2e/mcp/tasks',
    '/api/x/..\\mcp\\tasks',
  ]) {
    it(`401s ${JSON.stringify(target)}, which only resolves under /api/mcp/`, async () => {
      expect((await rawRequest(port, target)).status).toBe(401)
    })
  }

  it('401s an /api/mcp/ path that resolves outside it', async () => {
    expect((await rawRequest(port, '/api/mcp/../settings')).status).toBe(401)
  })
})

describe('origin guard: no target shape skips it', () => {
  let port: number
  let close: () => Promise<void>
  const EVIL = { Origin: 'http://evil.example' }
  beforeAll(async () => {
    // The port in the allowlist is irrelevant: every request below carries a
    // foreign Origin, which no allowlist entry matches.
    const guard = createOriginGuard({ port: 18790 })
    ;({ port, close } = await serve((req, res) => guard.checkHttp(req, res)))
  })
  afterAll(() => close())

  it('400s an absolute-form target, whatever its path', async () => {
    for (const target of [
      `http://127.0.0.1:${port}/api/settings`,
      `http://127.0.0.1:${port}/`,
      `HTTP://evil.example/API/settings`,
    ]) {
      const res = await rawRequest(port, target, EVIL)
      expect(res.status, target).toBe(400)
    }
  })

  for (const target of [...DOT_SEGMENT_TARGETS, '/API/settings', '/y/../api/settings']) {
    it(`403s a foreign Origin on ${JSON.stringify(target)}`, async () => {
      expect((await rawRequest(port, target, EVIL)).status).toBe(403)
    })
  }

  it('leaves pages, static files and OPTIONS * alone', async () => {
    expect((await rawRequest(port, '/assets/app.js', EVIL)).status).toBe(200)
    expect((await rawRequest(port, '/x/../y', EVIL)).status).toBe(200)
    expect((await rawRequest(port, '*', {}, 'OPTIONS')).status).toBe(200)
  })
})

function mockReq(url: string, extra: Record<string, unknown> = {}): IncomingMessage {
  return { url, headers: {}, method: 'GET', ...extra } as unknown as IncomingMessage
}

describe('request path readings', () => {
  it('reads an origin-form target as sent and resolved', () => {
    expect(requestPathReadings(mockReq('/api/a/../b?x=1'))).toEqual(['/api/a/../b', '/api/b'])
  })

  it('adds the backslash reading only when the target has a backslash', () => {
    expect(requestPathReadings(mockReq('/api\\a'))).toEqual(['/api\\a', '/api/a', '/api/a'])
  })

  it("adds the router's own reading when the framework publishes one", () => {
    const req = mockReq('/x', { path: '/api/x' })
    expect(requestPathReadings(req)).toEqual(['/x', '/x', '/api/x'])
  })

  it('reads a router reading that throws as no reading', () => {
    const req = mockReq('/x')
    Object.defineProperty(req, 'path', {
      get() {
        throw new Error('unparseable')
      },
    })
    expect(requestPathReadings(req)).toEqual(['/x', '/x'])
  })

  it('cuts an absolute-form target to its path', () => {
    expect(targetPath('http://h:1/api/x?q')).toBe('/api/x')
    expect(targetPath('https://h')).toBe('/')
    expect(targetPath('*')).toBeNull()
    expect(targetPath('h:443')).toBeNull()
  })

  it('protects on any reading, exempts on every reading, case folded', () => {
    const req = mockReq('/API/mcp/../settings')
    expect(anyPathUnder(req, '/api/')).toBe(true)
    expect(anyPathUnder(req, '/api/mcp/')).toBe(true)
    expect(everyPathUnder(req, '/api/mcp/')).toBe(false)
    expect(everyPathUnder(mockReq('/api/MCP/tasks'), '/api/mcp/')).toBe(true)
    // `*` has no path to read, so it is under nothing as sent.
    expect(everyPathUnder(mockReq('*'), '/')).toBe(false)
  })

  it('takes a path, or * on OPTIONS, as an origin-form target', () => {
    expect(isOriginFormTarget(mockReq('/'))).toBe(true)
    expect(isOriginFormTarget(mockReq('//h/api/x'))).toBe(true)
    expect(isOriginFormTarget(mockReq('*', { method: 'OPTIONS' }))).toBe(true)
    expect(isOriginFormTarget(mockReq('*'))).toBe(false)
    expect(isOriginFormTarget(mockReq('http://h/api/x'))).toBe(false)
  })
})
