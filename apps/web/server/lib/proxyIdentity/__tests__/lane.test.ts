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
import { actsAsPerson, attachIdentity } from '../../auth'
import { createBasePathMiddleware } from '../../basePathMiddleware'
import { resetOperatorSettings } from '../../operatorSettings'
import { APP_LINK_KEY_ENV, loadAppLinkConfig, type ProxyIdentityConfig } from '../config'
import {
  createIdentityLane,
  createProxyIdentityLane,
  type LaneSource,
  type ProxyIdentityLane,
} from '../lane'
import { createAssertionVerifier } from '../verifier'

const ed = generateKeyPairSync('ed25519')
const other = generateKeyPairSync('ed25519')
/** The app link's own key: one per purpose, never the proxy's. */
const app = generateKeyPairSync('ed25519')
const APP_PEM = app.publicKey.export({ format: 'pem', type: 'spki' }).toString()
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
    accountSubjects: 'never',
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

/** A token the app that started the engine signs for one of its own people. */
async function appAssertion(
  method: string,
  path: string,
  { sub = 'account:u-7', key = app.privateKey } = {},
): Promise<string> {
  const now = Math.floor(Date.now() / 1000)
  n += 1
  return new SignJWT({ name: 'Grace', htm: method, htu: path })
    .setProtectedHeader({ alg: 'EdDSA' })
    .setIssuer('clawboo-app-link')
    .setAudience('clawboo-engine')
    .setSubject(sub)
    .setIssuedAt(now)
    .setExpirationTime(now + 30)
    .setJti(`app-${n}-${Math.random()}`)
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
  /** Also trust an app link, as the server does when its launcher hands it a key. */
  appLink?: boolean
  /** Leave the sign-in proxy out, for an app link on its own. */
  proxy?: boolean
}): Promise<void> {
  if (opts.proxy !== false) vi.stubEnv('CLAWBOO_PROXY_IDENTITY', opts.mode)
  const gate = createAccessGate({
    token: opts.accessToken ?? '',
    basePath: opts.basePath ?? '',
    authorizeRuntime: (req) => req.headers['x-test-attach'] === 'minted',
  })
  const laneOpts = {
    isRuntimeRequest: (req: http.IncomingMessage) =>
      isRuntimeControlRequest(req, (r) => r.headers['x-test-attach'] === 'minted'),
  }
  if (opts.appLink) {
    vi.stubEnv(APP_LINK_KEY_ENV, APP_PEM)
    const sources: LaneSource[] = []
    if (opts.proxy !== false) {
      sources.push({
        config: config(opts.mode),
        verifier: createAssertionVerifier(config(opts.mode)),
      })
    }
    const appLink = loadAppLinkConfig(process.env)!
    sources.push({ config: appLink, verifier: createAssertionVerifier(appLink) })
    lane = createIdentityLane(sources, laneOpts)
  } else {
    lane = createProxyIdentityLane(
      config(opts.mode),
      createAssertionVerifier(config(opts.mode)),
      laneOpts,
    )
  }
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
  app.put('/api/team-verify-command/:teamId', (req, res) => {
    res.json({ actsAsPerson: actsAsPerson(req), person: req.person ?? null })
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
      body: {
        proxyIdentity: 'on',
        appLink: false,
        person: { id: 'user-42', name: 'Ada', role: 'admin' },
        you: { id: 'user-42', name: 'Ada', role: 'admin' },
      },
    })
  })

  it('lets a request without a token through with no name', async () => {
    await start({ mode: 'on' })
    expect(await get('/api/access/identity')).toEqual({
      status: 200,
      body: {
        proxyIdentity: 'on',
        appLink: false,
        person: null,
        you: { id: 'local', name: 'You', role: null },
      },
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

// What makes a person write real behind a sign-in proxy: in `required` mode, no
// person-only route answers without a verified person, however its path is spelled,
// and a runtime's attach credential opens none of them.
describe('required: the person-only routes', () => {
  const ROUTES: Array<[string, string]> = [
    ['GET', '/api/settings'],
    ['POST', '/api/settings'],
    ['GET', '/api/governance/budgets'],
    ['POST', '/api/governance/budgets'],
    ['POST', '/api/governance/budgets/team/T/resume'],
    ['GET', '/api/system/hold'],
    ['POST', '/api/system/hold'],
    ['DELETE', '/api/system/hold/me'],
    ['PUT', '/api/team-verify-command/T'],
    ['PATCH', '/api/board/t1'],
    ['POST', '/api/board/t1/retry'],
    ['POST', '/api/board/t1/assign'],
    ['POST', '/api/tools/approvals/a1/resolve'],
    ['POST', '/api/capabilities/approve'],
  ]

  it.each(ROUTES)('%s %s refuses a request with no verified person', async (method, route) => {
    await start({ mode: 'required' })
    const res = await get(route, {}, method)
    expect(res).toMatchObject({ status: 401, body: { reason: 'missing' } })
  })

  it.each(ROUTES)('%s %s refuses a runtime attach credential', async (method, route) => {
    await start({ mode: 'required' })
    const res = await get(route, { 'x-test-attach': 'minted' }, method)
    expect(res).toMatchObject({ status: 401, body: { reason: 'missing' } })
  })

  it('reads the path every way the router can', async () => {
    await start({ mode: 'required' })
    // A runtime's credential must not reach a route by a spelling that starts under
    // the mounts it may use: every reading has to be under them.
    for (const route of [
      '/API/settings',
      '/api/./settings',
      '/api/mcp/../settings',
      '/api/mcp/tasks/../../settings',
    ]) {
      const { status } = await raw(route, { 'x-test-attach': 'minted' })
      expect(status, route).toBe(401)
    }
  })

  it('lets a verified person through, who then counts as the person with no fetch metadata', async () => {
    await start({ mode: 'required' })
    const token = await assertion('PUT', '/api/team-verify-command/T')
    const res = await get('/api/team-verify-command/T', { 'clawboo-identity': token }, 'PUT')
    expect(res).toMatchObject({
      status: 200,
      body: { actsAsPerson: true, person: { id: 'user-42' } },
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

  it('checks an identity token a runtime call carries, rather than skipping it', async () => {
    await start({ mode: 'required' })
    const forged = await assertion('POST', '/api/mcp/tasks', other.privateKey)
    expect(
      await get(
        '/api/mcp/tasks',
        { 'x-test-attach': 'minted', 'clawboo-identity': forged },
        'POST',
      ),
    ).toMatchObject({ status: 401, body: { reason: 'signature' } })
    const good = await assertion('POST', '/api/mcp/tasks')
    expect(
      await get('/api/mcp/tasks', { 'x-test-attach': 'minted', 'clawboo-identity': good }, 'POST'),
    ).toEqual({
      status: 200,
      body: { runtime: true, person: { id: 'user-42', name: 'Ada', role: 'admin' } },
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

  // The server's own path check drops an absolute-form upgrade before the lane
  // is asked (apps/web/server/index.ts). This pins how the lane reads one for
  // any caller that does pass it.
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

describe('two issuers: a sign-in proxy and the app that started the engine', () => {
  const signedByApp = async (method: string, path: string, over = {}) => ({
    'clawboo-app-identity': await appAssertion(method, path, over),
  })

  it("names the app's account: person, and still the proxy's person on its own header", async () => {
    await start({ mode: 'on', appLink: true })
    expect(
      await get('/api/access/identity', await signedByApp('GET', '/api/access/identity')),
    ).toEqual({
      status: 200,
      body: {
        proxyIdentity: 'on',
        appLink: true,
        person: { id: 'account:u-7', name: 'Grace', role: null },
        you: { id: 'account:u-7', name: 'Grace', role: null },
      },
    })
    const viaProxy = await get('/api/access/identity', await signed('GET', '/api/access/identity'))
    expect(viaProxy.body['person']).toEqual({ id: 'user-42', name: 'Ada', role: 'admin' })
  })

  it('makes the app its person: it passes the person check with no fetch metadata', async () => {
    await start({ mode: 'on', appLink: true, proxy: false })
    const res = await get(
      '/api/team-verify-command/t1',
      await signedByApp('PUT', '/api/team-verify-command/t1'),
      'PUT',
    )
    expect(res).toEqual({
      status: 200,
      body: { actsAsPerson: true, person: { id: 'account:u-7', name: 'Grace', role: null } },
    })
  })

  it('lets a request without a token through with no name: an app link never requires one', async () => {
    await start({ mode: 'on', appLink: true, proxy: false })
    expect(lane.mode).toBe('on')
    const res = await get('/api/team-verify-command/t1', {}, 'PUT')
    expect(res).toEqual({ status: 200, body: { actsAsPerson: false, person: null } })
  })

  it('refuses an app token that does not verify, rather than treating it as no token', async () => {
    await start({ mode: 'on', appLink: true })
    const forged = await signedByApp('GET', '/api/access/identity', { key: other.privateKey })
    const res = await get('/api/access/identity', forged)
    expect(res.status).toBe(401)
    expect(res.body).toMatchObject({
      gate: 'clawboo-proxy-identity',
      reason: 'signature',
      error: 'Clawboo refused the identity token from the app that started it.',
    })
  })

  it("refuses the app's key used to name anyone but an account: person", async () => {
    await start({ mode: 'on', appLink: true })
    const res = await get(
      '/api/access/identity',
      await signedByApp('GET', '/api/access/identity', { sub: 'user-42' }),
    )
    expect(res).toMatchObject({ status: 401, body: { reason: 'claims' } })
  })

  it("refuses a proxy-signed token on the app's header, and an app token on the proxy's", async () => {
    await start({ mode: 'on', appLink: true })
    const proxyTokenOnAppHeader = {
      'clawboo-app-identity': await assertion('GET', '/api/access/identity'),
    }
    expect((await get('/api/access/identity', proxyTokenOnAppHeader)).status).toBe(401)
    const appTokenOnProxyHeader = {
      'clawboo-identity': await appAssertion('GET', '/api/access/identity'),
    }
    expect((await get('/api/access/identity', appTokenOnProxyHeader)).status).toBe(401)
  })

  it('refuses a request that carries both tokens', async () => {
    await start({ mode: 'on', appLink: true })
    const res = await get('/api/access/identity', {
      ...(await signed('GET', '/api/access/identity')),
      ...(await signedByApp('GET', '/api/access/identity')),
    })
    expect(res).toMatchObject({ status: 401, body: { reason: 'two-tokens' } })
  })

  it("lets the app's person through a required proxy lane, and nothing without a token", async () => {
    await start({ mode: 'required', appLink: true })
    expect(lane.mode).toBe('required')
    const res = await get('/api/access/identity', await signedByApp('GET', '/api/access/identity'))
    expect(res.status).toBe(200)
    expect((await get('/api/access/identity')).status).toBe(401)
  })

  it("refuses the app's token on the Gateway connection, even a good one", async () => {
    const upgrade = (headers: Record<string, string>) =>
      ({ method: 'GET', url: '/api/gateway/ws', headers }) as unknown as http.IncomingMessage
    for (const mode of ['on', 'required'] as const) {
      await start({ mode, appLink: true })
      const appToken = await appAssertion('GET', '/api/gateway/ws')
      expect(await lane.checkUpgrade(upgrade({ 'clawboo-app-identity': appToken }))).toEqual({
        ok: false,
        reason: 'binding',
      })
      const proxyToken = await assertion('GET', '/api/gateway/ws')
      expect(await lane.checkUpgrade(upgrade({ 'clawboo-identity': proxyToken }))).toEqual({
        ok: true,
        person: { id: 'user-42', name: 'Ada', role: 'admin' },
      })
      await new Promise<void>((r) => server!.close(() => r()))
      server = null
    }
    await start({ mode: 'on', appLink: true, proxy: false })
    expect(await lane.checkUpgrade(upgrade({}))).toEqual({ ok: true, person: null })
  })

  it("lets a spawned runtime's own call through only when it carries neither token", async () => {
    await start({ mode: 'required', appLink: true })
    const runtime = { 'x-test-attach': 'minted' }
    expect((await get('/api/mcp/tasks', runtime, 'POST')).status).toBe(200)
    const withForgedAppToken = {
      ...runtime,
      ...(await signedByApp('POST', '/api/mcp/tasks', { key: other.privateKey })),
    }
    expect((await get('/api/mcp/tasks', withForgedAppToken, 'POST')).status).toBe(401)
  })
})
