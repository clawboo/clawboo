// The identity lane over real HTTP, in the server's own order: base-path strip,
// access gate, identity lane, identity middleware, routes.
//
// What it must hold: a token that does not verify is refused, never let through
// as an unnamed person; `required` refuses a request without one; the access
// token is still needed beside it; a spawned runtime's own control-plane call
// is the one exemption.

import { generateKeyPairSync } from 'node:crypto'
import http from 'node:http'
import net, { type AddressInfo } from 'node:net'

import express from 'express'
import { SignJWT, type JWK } from 'jose'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { createAccessGate, isRuntimeControlRequest } from '@clawboo/gateway-proxy'

import { accessIdentityGET } from '../../../api/access'
import { attachIdentity } from '../../auth'
import { createBasePathMiddleware } from '../../basePathMiddleware'
import { resetOperatorSettings } from '../../operatorSettings'
import type { ProxyIdentityConfig } from '../config'
import { createProxyIdentityLane, type ProxyIdentityLane } from '../lane'
import { createAssertionVerifier } from '../verifier'

const ed = generateKeyPairSync('ed25519')
const other = generateKeyPairSync('ed25519')
const ACCESS_TOKEN = 'access-token-for-tests'

function config(mode: 'on' | 'required'): ProxyIdentityConfig {
  return {
    mode,
    header: 'clawboo-identity',
    issuer: 'https://proxy.example.com',
    audience: 'clawboo',
    binding: 'request',
    maxLifetimeSeconds: 60,
    nameClaim: 'name',
    roleClaim: 'role',
    keys: { source: 'public-key', jwks: { keys: [ed.publicKey.export({ format: 'jwk' }) as JWK] } },
  }
}

let n = 0
async function assertion(method: string, path: string, key = ed.privateKey): Promise<string> {
  const now = Math.floor(Date.now() / 1000)
  n += 1
  return new SignJWT({ name: 'Ada', role: 'admin', htm: method, htu: path })
    .setProtectedHeader({ alg: 'EdDSA' })
    .setIssuer('https://proxy.example.com')
    .setAudience('clawboo')
    .setSubject('user-42')
    .setIssuedAt(now)
    .setExpirationTime(now + 30)
    .setJti(`lane-${n}-${Math.random()}`)
    .sign(key)
}

let server: http.Server | null = null
let base = ''
let port = 0
let lane: ProxyIdentityLane

async function start(opts: {
  mode: 'on' | 'required'
  accessToken?: string
  basePath?: string
}): Promise<void> {
  vi.stubEnv('CLAWBOO_PROXY_IDENTITY', opts.mode)
  const gate = createAccessGate({
    token: opts.accessToken ?? '',
    basePath: opts.basePath ?? '',
    authorizeRuntime: (req) => req.headers['x-test-attach'] === 'minted',
  })
  lane = createProxyIdentityLane(config(opts.mode), createAssertionVerifier(config(opts.mode)), {
    isRuntimeRequest: (req) =>
      isRuntimeControlRequest(req, (r) => r.headers['x-test-attach'] === 'minted'),
  })
  const app = express()
  app.use(createBasePathMiddleware(opts.basePath ?? ''))
  app.use((req, res, next) => {
    if (gate.handleHttp(req, res)) return
    next()
  })
  app.use(lane.http)
  app.use(attachIdentity)
  app.get('/api/access/identity', accessIdentityGET)
  app.post('/api/mcp/tasks', (req, res) => {
    res.json({ runtime: true, person: req.person ?? null })
  })
  // A wildcard route, which absorbs dot segments the way the board's preview
  // route does: the raw path stays under /api/ while a resolved one leaves it.
  app.all('/api/files/*splat', (req, res) => {
    res.json({ files: true, person: req.person ?? null })
  })
  app.get('/', (_req, res) => {
    res.send('page')
  })
  server = http.createServer(app)
  await new Promise<void>((r) => server!.listen(0, '127.0.0.1', () => r()))
  port = (server.address() as AddressInfo).port
  base = `http://127.0.0.1:${port}`
}

beforeEach(() => resetOperatorSettings())
afterEach(async () => {
  if (server) await new Promise<void>((r) => server!.close(() => r()))
  server = null
  resetOperatorSettings()
  vi.unstubAllEnvs()
})

async function get(
  path: string,
  headers: Record<string, string> = {},
  method = 'GET',
): Promise<{ status: number; body: Record<string, unknown> }> {
  const res = await fetch(`${base}${path}`, { method, headers })
  const text = await res.text()
  let body: Record<string, unknown> = {}
  try {
    body = JSON.parse(text) as Record<string, unknown>
  } catch {
    body = { text }
  }
  return { status: res.status, body }
}

/**
 * Send a request target exactly as written, over a raw socket: fetch and
 * http.request normalize what they send, and an absolute-form target
 * (`GET http://host/api/x HTTP/1.1`) or a dot segment is the point here.
 */
function raw(
  target: string,
  headers: Record<string, string> = {},
  method = 'GET',
): Promise<{ status: number; body: Record<string, unknown> }> {
  return new Promise((resolve, reject) => {
    const lines = [`${method} ${target} HTTP/1.1`, `Host: 127.0.0.1:${port}`, 'Connection: close']
    for (const [name, value] of Object.entries(headers)) lines.push(`${name}: ${value}`)
    if (method !== 'GET') lines.push('Content-Length: 0')
    const socket = net.connect(port, '127.0.0.1', () =>
      socket.write(`${lines.join('\r\n')}\r\n\r\n`),
    )
    let buf = ''
    socket.on('data', (d) => (buf += d.toString()))
    socket.on('error', reject)
    socket.on('end', () => {
      const status = Number(buf.split('\r\n')[0]?.split(' ')[1])
      const text = buf.slice(buf.indexOf('\r\n\r\n') + 4)
      let body: Record<string, unknown> = {}
      try {
        body = JSON.parse(text) as Record<string, unknown>
      } catch {
        body = { text }
      }
      resolve({ status, body })
    })
  })
}

const signed = async (method: string, path: string) => ({
  'clawboo-identity': await assertion(method, path),
})

describe('on', () => {
  it('names the person a good token carries', async () => {
    await start({ mode: 'on' })
    const res = await get('/api/access/identity', await signed('GET', '/api/access/identity'))
    expect(res).toEqual({
      status: 200,
      body: { proxyIdentity: 'on', person: { id: 'user-42', name: 'Ada', role: 'admin' } },
    })
  })

  it('lets a request without a token through with no name', async () => {
    await start({ mode: 'on' })
    expect(await get('/api/access/identity')).toEqual({
      status: 200,
      body: { proxyIdentity: 'on', person: null },
    })
  })

  it('refuses a token that does not verify, rather than treating it as no token', async () => {
    await start({ mode: 'on' })
    const forged = await assertion('GET', '/api/access/identity', other.privateKey)
    const res = await get('/api/access/identity', { 'clawboo-identity': forged })
    expect(res.status).toBe(401)
    expect(res.body).toMatchObject({ gate: 'clawboo-proxy-identity', reason: 'signature' })
    expect(String(res.body['error'])).toMatch(/clawboo/i)
    expect(String(res.body['error'])).toMatch(/token/)

    const wrongPath = await get('/api/access/identity', await signed('GET', '/api/board'))
    expect(wrongPath).toMatchObject({ status: 401, body: { reason: 'binding' } })
    const empty = await get('/api/access/identity', { 'clawboo-identity': '' })
    expect(empty).toMatchObject({ status: 401, body: { reason: 'malformed' } })
  })

  it('refuses a replayed token', async () => {
    await start({ mode: 'on' })
    const headers = await signed('GET', '/api/access/identity')
    expect((await get('/api/access/identity', headers)).status).toBe(200)
    expect(await get('/api/access/identity', headers)).toMatchObject({
      status: 401,
      body: { reason: 'replayed' },
    })
  })
})

describe('required', () => {
  it('refuses an /api/ request without a token, in any letter case', async () => {
    await start({ mode: 'required' })
    expect(await get('/api/access/identity')).toMatchObject({
      status: 401,
      body: { gate: 'clawboo-proxy-identity', reason: 'missing' },
    })
    expect(await get('/API/access/identity')).toMatchObject({
      status: 401,
      body: { reason: 'missing' },
    })
  })

  it('accepts a good token, also behind a Bearer prefix', async () => {
    await start({ mode: 'required' })
    const token = await assertion('GET', '/api/access/identity')
    const res = await get('/api/access/identity', { 'clawboo-identity': `Bearer ${token}` })
    expect(res).toMatchObject({ status: 200, body: { person: { id: 'user-42' } } })
  })

  it('refuses the header sent twice', async () => {
    await start({ mode: 'required' })
    const a = await assertion('GET', '/api/access/identity')
    const b = await assertion('GET', '/api/access/identity')
    const headers = new Headers()
    headers.append('clawboo-identity', a)
    headers.append('clawboo-identity', b)
    const res = await fetch(`${base}/api/access/identity`, { headers })
    expect(res.status).toBe(401)
  })

  it('serves pages without a token: the lane guards /api/ and the Gateway connection', async () => {
    await start({ mode: 'required' })
    expect(await get('/')).toMatchObject({ status: 200, body: { text: 'page' } })
  })

  it("lets a spawned runtime's own control-plane call through, and nothing that only looks like one", async () => {
    await start({ mode: 'required' })
    expect(await get('/api/mcp/tasks', { 'x-test-attach': 'minted' }, 'POST')).toEqual({
      status: 200,
      body: { runtime: true, person: null },
    })
    // Without the runtime's credential, or forwarded by a proxy, it is a person's request.
    expect((await get('/api/mcp/tasks', {}, 'POST')).status).toBe(401)
    expect(
      (
        await get(
          '/api/mcp/tasks',
          { 'x-test-attach': 'minted', 'x-forwarded-for': '1.2.3.4' },
          'POST',
        )
      ).status,
    ).toBe(401)
  })
})

describe('request targets that are not a plain path', () => {
  it('refuses an absolute-form /api/ request without a token, as the router still routes it', async () => {
    await start({ mode: 'required' })
    for (const target of [
      `http://127.0.0.1:${port}/api/access/identity`,
      'HTTP://evil.example/api/access/identity',
      'http://127.0.0.1/API/access/identity',
    ]) {
      expect(await raw(target)).toMatchObject({
        status: 401,
        body: { gate: 'clawboo-proxy-identity', reason: 'missing' },
      })
    }
  })

  it('accepts an absolute-form request with a good token for its path', async () => {
    await start({ mode: 'required' })
    const res = await raw(
      `http://127.0.0.1:${port}/api/access/identity`,
      await signed('GET', '/api/access/identity'),
    )
    expect(res).toMatchObject({ status: 200, body: { person: { id: 'user-42' } } })
    const wrong = await raw(
      `http://127.0.0.1:${port}/api/access/identity`,
      await signed('GET', `http://127.0.0.1:${port}/api/board`),
    )
    expect(wrong).toMatchObject({ status: 401, body: { reason: 'binding' } })
  })

  it('refuses a dot-segment path the router keeps under /api/ even when it resolves outside', async () => {
    await start({ mode: 'required' })
    for (const target of ['/api/files/x/../../../x', '/api/files/x/%2e%2e/%2e%2e/%2e%2e/x']) {
      expect(await raw(target)).toMatchObject({ status: 401, body: { reason: 'missing' } })
    }
    // Bound to the path as sent, which is the one the router matched.
    const sent = '/api/files/x/../../../x'
    expect(await raw(sent, await signed('GET', sent))).toMatchObject({
      status: 200,
      body: { files: true, person: { id: 'user-42' } },
    })
  })

  it('refuses a runtime credential on a path that only resolves to /api/mcp/', async () => {
    await start({ mode: 'required' })
    // Resolved, this is /api/mcp/tasks; the router sends it to /api/files/*splat.
    const res = await raw('/api/files/x/../../mcp/tasks', { 'x-test-attach': 'minted' }, 'POST')
    expect(res).toMatchObject({ status: 401, body: { reason: 'missing' } })
    // The real control-plane path still passes, absolute-form included.
    expect(
      await raw(`http://127.0.0.1:${port}/api/mcp/tasks`, { 'x-test-attach': 'minted' }, 'POST'),
    ).toMatchObject({ status: 200, body: { runtime: true } })
  })
})

describe('beside the access token', () => {
  it('still needs the access cookie: a good token alone is not enough', async () => {
    await start({ mode: 'required', accessToken: ACCESS_TOKEN })
    const tokenOnly = await get('/api/access/identity', await signed('GET', '/api/access/identity'))
    expect(tokenOnly).toMatchObject({ status: 401, body: { gate: 'clawboo-access' } })

    const cookieOnly = await get('/api/access/identity', {
      cookie: `clawboo_access=${ACCESS_TOKEN}`,
    })
    expect(cookieOnly).toMatchObject({ status: 401, body: { reason: 'missing' } })

    const both = await get('/api/access/identity', {
      cookie: `clawboo_access=${ACCESS_TOKEN}`,
      ...(await signed('GET', '/api/access/identity')),
    })
    expect(both).toMatchObject({ status: 200, body: { person: { id: 'user-42' } } })
  })
})

describe('under a base path', () => {
  it('binds to the path as received, mount included', async () => {
    await start({ mode: 'required', basePath: '/clawboo' })
    const good = await get(
      '/clawboo/api/access/identity',
      await signed('GET', '/clawboo/api/access/identity'),
    )
    expect(good).toMatchObject({ status: 200, body: { person: { id: 'user-42' } } })
    const unmounted = await get(
      '/clawboo/api/access/identity',
      await signed('GET', '/api/access/identity'),
    )
    expect(unmounted).toMatchObject({ status: 401, body: { reason: 'binding' } })
  })
})

describe('the Gateway connection', () => {
  const upgrade = (headers: Record<string, string>, url = '/api/gateway/ws') =>
    ({ method: 'GET', url, headers }) as unknown as http.IncomingMessage

  it('required: refuses an upgrade without a token or with a bad one, and takes a good one', async () => {
    await start({ mode: 'required' })
    expect(await lane.checkUpgrade(upgrade({}))).toEqual({ ok: false, reason: 'missing' })
    const forged = await assertion('GET', '/api/gateway/ws', other.privateKey)
    expect(await lane.checkUpgrade(upgrade({ 'clawboo-identity': forged }))).toEqual({
      ok: false,
      reason: 'signature',
    })
    const good = await assertion('GET', '/api/gateway/ws')
    expect(await lane.checkUpgrade(upgrade({ 'clawboo-identity': good }))).toMatchObject({
      ok: true,
      person: { id: 'user-42' },
    })
  })

  it('reads an absolute-form upgrade target by its path', async () => {
    await start({ mode: 'required' })
    const target = `http://127.0.0.1:${port}/api/gateway/ws`
    expect(await lane.checkUpgrade(upgrade({}, target))).toEqual({ ok: false, reason: 'missing' })
    const good = await assertion('GET', '/api/gateway/ws')
    expect(await lane.checkUpgrade(upgrade({ 'clawboo-identity': good }, target))).toMatchObject({
      ok: true,
      person: { id: 'user-42' },
    })
  })

  it('on: lets an upgrade without a token through, still refusing a bad one', async () => {
    await start({ mode: 'on' })
    expect(await lane.checkUpgrade(upgrade({}))).toEqual({ ok: true, person: null })
    const wrong = await assertion('GET', '/api/board')
    expect(await lane.checkUpgrade(upgrade({ 'clawboo-identity': wrong }))).toEqual({
      ok: false,
      reason: 'binding',
    })
  })
})
