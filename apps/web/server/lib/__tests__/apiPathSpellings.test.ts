// The server's guard stack against every spelling of an /api/ path, with the
// REAL createAccessGate and createOriginGuard mounted in the order index.ts
// mounts them, in front of an Express 5 router built the way apiRouter is (case
// sensitive, with the Board preview's wildcard route). Each target goes over a
// raw socket, because fetch and supertest resolve dot segments and turn a whole
// URL into a path before sending. A request the guards let through answers
// `{"reached": ...}` from the route the router picked.

import http from 'node:http'
import net from 'node:net'

import { createAccessGate, createOriginGuard } from '@clawboo/gateway-proxy'
import express, { Router } from 'express'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { createBasePathMiddleware } from '../basePathMiddleware'

const TOKEN = 'path-spellings-token'

function buildApp(port: () => number, basePath: string): express.Express {
  const accessGate = createAccessGate({ token: TOKEN, basePath, authorizeRuntime: () => true })
  const app = express()
  app.set('case sensitive routing', true)
  app.use(createBasePathMiddleware(basePath))
  app.use((req, res, next) => {
    // Built per request: the listening port is known only after listen().
    if (createOriginGuard({ port: port() }).checkHttp(req, res)) return
    next()
  })
  app.use(express.json())
  app.use((req, res, next) => {
    if (accessGate.handleHttp(req, res)) return
    next()
  })
  const router = Router({ caseSensitive: true })
  router.get('/api/board/:taskId/preview/*splat', (_req, res) => {
    res.json({ reached: 'preview' })
  })
  router.get('/api/mcp/tasks', (_req, res) => {
    res.json({ reached: 'mcp' })
  })
  app.use(router)
  app.use((_req, res) => {
    res.status(404).json({ reached: null })
  })
  return app
}

interface RawResponse {
  status: number
  body: string
}

/** Stands for this server's own origin in a target, filled in once it listens. */
const SELF = '<self>'

function rawRequest(
  port: number,
  target: string,
  headers: Record<string, string> = {},
): Promise<RawResponse> {
  const sent = target.replace(SELF, `http://127.0.0.1:${port}`)
  return new Promise((resolve, reject) => {
    const socket = net.connect(port, '127.0.0.1', () => {
      const lines = [`GET ${sent} HTTP/1.1`, `Host: 127.0.0.1:${port}`, 'Connection: close']
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

/** Spellings the router sends to the preview route, given a mount prefix. */
function previewSpellings(prefix: string): string[] {
  const p = `${prefix}/api/board/task-1/preview`
  return [
    `${p}/../../../../x`,
    `${p}/%2e%2e/%2e%2e/%2e%2e/%2e%2e/x`,
    `${p}/.%2E/%2E./.%2e/%2e%2e/x?q=1`,
    `${p}/..\\..\\..\\..\\x`,
    `${prefix}/api\\board\\task-1\\preview\\..\\..\\..\\..\\x#f`,
    `${SELF}${p}/../../../../x`,
    `${SELF}${p}/a`,
  ]
}

/**
 * The status a refused spelling gets. A full-URL target is refused before any
 * route runs: by the origin guard with 400 at the root, and by the base-path
 * strip with 404 under a prefix, which answers first. Every path target reaches
 * the guards and gets `refusal`.
 */
function expectedStatus(target: string, basePath: string, refusal: number): number {
  if (target.startsWith(SELF)) return basePath === '' ? 400 : 404
  return refusal
}

for (const basePath of ['', '/clawboo']) {
  describe(`guard stack, base path ${JSON.stringify(basePath)}: no spelling reaches an /api/ route without the cookie`, () => {
    let server: http.Server
    let port = 0
    beforeAll(async () => {
      server = http.createServer(buildApp(() => port, basePath))
      await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
      const address = server.address()
      if (address === null || typeof address === 'string') throw new Error('no port')
      port = address.port
    })
    afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())))

    it('serves the preview route to a request with the cookie (the control)', async () => {
      const res = await rawRequest(port, `${basePath}/api/board/task-1/preview/index.html`, {
        Cookie: `clawboo_access=${TOKEN}`,
      })
      expect(res.status).toBe(200)
      expect(JSON.parse(res.body)).toEqual({ reached: 'preview' })
    })

    for (const target of previewSpellings(basePath)) {
      it(`refuses ${JSON.stringify(target)} without the cookie`, async () => {
        const res = await rawRequest(port, target)
        expect(res.body).not.toContain('"reached":"')
        expect(res.status).toBe(expectedStatus(target, basePath, 401))
      })
    }

    // The gate here vouches for every runtime credential, so only the path decides.
    for (const target of [
      `${basePath}/api/board/task-1/preview/../../../mcp/tasks`,
      `${basePath}/api/board/task-1/preview/%2e%2e/%2e%2e/%2e%2e/mcp/tasks`,
    ]) {
      it(`a runtime credential does not admit ${JSON.stringify(target)}`, async () => {
        const res = await rawRequest(port, target)
        expect(res.body).not.toContain('"reached":"')
        expect(res.status).toBe(401)
      })
    }

    for (const target of previewSpellings(basePath)) {
      it(`refuses a foreign Origin on ${JSON.stringify(target)}, cookie or not`, async () => {
        const res = await rawRequest(port, target, {
          Cookie: `clawboo_access=${TOKEN}`,
          Origin: 'http://evil.example',
        })
        expect(res.body).not.toContain('"reached":"')
        expect(res.status).toBe(expectedStatus(target, basePath, 403))
      })
    }
  })
}
