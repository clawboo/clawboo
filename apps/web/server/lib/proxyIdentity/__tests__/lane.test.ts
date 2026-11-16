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
import { systemLiveGET } from '../../../api/systemLive'
import { actsAsPerson, attachIdentity } from '../../auth'
import { createBasePathMiddleware } from '../../basePathMiddleware'
import { resetOperatorSettings } from '../../operatorSettings'
import { resetPersonCheckForTests, setPersonCheckMode } from '../../personCheck'
import { withRouteRules } from '../../roles/guard'
import {
  APP_LINK_KEY_ENV,
  identityConfigs,
  loadAppLinkConfig,
  loadReaderConfig,
  type ProxyIdentityConfig,
} from '../config'
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
/** The reader key: a program beside the server making its own reads. */
const readerKey = generateKeyPairSync('ed25519')
const READER_PEM = readerKey.publicKey.export({ format: 'pem', type: 'spki' }).toString()
const ACCESS_TOKEN = 'access-token-for-tests'

function config(mode: 'on' | 'required', controlClaim?: 'required'): ProxyIdentityConfig {
  return {
    ...(controlClaim ? { controlClaim } : {}),
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
async function assertion(
  method: string,
  path: string,
  key = ed.privateKey,
  extra: Record<string, unknown> = {},
): Promise<string> {
  const now = Math.floor(Date.now() / 1000)
  n += 1
  return new SignJWT({ name: 'Ada', role: 'admin', htm: method, htu: path, ...extra })
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
  { sub = 'account:u-7', key = app.privateKey, extra = {} as Record<string, unknown> } = {},
): Promise<string> {
  const now = Math.floor(Date.now() / 1000)
  n += 1
  return new SignJWT({ name: 'Grace', htm: method, htu: path, ...extra })
    .setProtectedHeader({ alg: 'EdDSA' })
    .setIssuer('clawboo-app-link')
    .setAudience('clawboo-engine')
    .setSubject(sub)
    .setIssuedAt(now)
    .setExpirationTime(now + 30)
    .setJti(`app-${n}-${Math.random()}`)
    .sign(key)
}

/** A token the reader key signs for one of its reads. `path` is the path alone. */
async function readerAssertion(
  method: string,
  path: string,
  { sub = 'reader:companion', key = readerKey.privateKey, iss = 'clawboo-reader' } = {},
): Promise<string> {
  const now = Math.floor(Date.now() / 1000)
  n += 1
  return new SignJWT({ name: 'Not a person', role: 'owner', htm: method, htu: path })
    .setProtectedHeader({ alg: 'EdDSA' })
    .setIssuer(iss)
    .setAudience('clawboo-engine')
    .setSubject(sub)
    .setIssuedAt(now)
    .setExpirationTime(now + 30)
    .setJti(`reader-${n}-${Math.random()}`)
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
  /** Read the take-over claim (proxyIdentityControlClaim: required). */
  controlClaim?: boolean
  /** Also trust the reader key, as the server does when one is set. */
  reader?: boolean
  /** Enforce roles on the routes the reader may read, as the server's guard does. */
  roles?: boolean
}): Promise<void> {
  const claim = opts.controlClaim ? ('required' as const) : undefined
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
  if (opts.reader) {
    // As index.ts builds them: the proxy, the app link when on, then the reader.
    vi.stubEnv('CLAWBOO_PROXY_IDENTITY_READER_PUBLIC_KEY', READER_PEM)
    if (opts.appLink) vi.stubEnv(APP_LINK_KEY_ENV, APP_PEM)
    const proxyConfig = config(opts.mode, claim)
    const appLink = opts.appLink ? loadAppLinkConfig(process.env) : null
    const configs = identityConfigs(proxyConfig, appLink, loadReaderConfig(proxyConfig, appLink))
    lane = createIdentityLane(
      configs.map((c) => ({ config: c, verifier: createAssertionVerifier(c) })),
      laneOpts,
    )
  } else if (opts.appLink) {
    vi.stubEnv(APP_LINK_KEY_ENV, APP_PEM)
    const sources: LaneSource[] = []
    if (opts.proxy !== false) {
      sources.push({
        config: config(opts.mode, claim),
        verifier: createAssertionVerifier(config(opts.mode, claim)),
      })
    }
    const appLink = loadAppLinkConfig(process.env)!
    sources.push({ config: appLink, verifier: createAssertionVerifier(appLink) })
    lane = createIdentityLane(sources, laneOpts)
  } else {
    lane = createProxyIdentityLane(
      config(opts.mode, claim),
      createAssertionVerifier(config(opts.mode, claim)),
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
  if (opts.roles) app.locals['rolesMode'] = 'enforce'
  app.get('/api/access/identity', accessIdentityGET)
  // The reads on the reader's list, behind the role guard as the server mounts
  // them, and one route that is not on it.
  const reads = withRouteRules(express.Router({ caseSensitive: true }), { onUnlisted: () => {} })
  const echo = (req: express.Request, res: express.Response): void => {
    res.json({
      reader: req.reader ?? null,
      person: req.person ?? null,
      actsAsPerson: actsAsPerson(req),
      access: req.access ?? null,
    })
  }
  reads.get('/api/system/live', systemLiveGET)
  for (const route of [
    '/api/system/self-version',
    '/api/runtimes',
    '/api/teams',
    '/api/agents',
    '/api/tools/approvals',
    '/api/obs/stream',
    '/api/obs/events',
    '/api/settings',
    '/api/health',
  ]) {
    reads.get(route, echo)
  }
  reads.post('/api/teams', echo)
  app.use(reads)
  app.post('/api/mcp/tasks', (req, res) => {
    res.json({ runtime: true, person: req.person ?? null })
  })
  app.put('/api/team-verify-command/:teamId', (req, res) => {
    res.json({ actsAsPerson: actsAsPerson(req), person: req.person ?? null })
  })
  app.get('/api/who', (req, res) => {
    res.json({ via: req.personVia ?? null })
  })
  // One of the routes the app link may sign for: sending an agent work.
  app.post('/api/agents/:agentId/chat', (req, res) => {
    res.json({
      actsAsPerson: actsAsPerson(req),
      person: req.person ?? null,
      via: req.personVia ?? null,
      claim: req.controlClaim ?? null,
    })
  })
  app.post('/api/agents/:agentId/computer/control', (req, res) => {
    res.json({ claim: req.controlClaim ?? null, actsAsPerson: actsAsPerson(req) })
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
  resetPersonCheckForTests()
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
        roles: 'off',
        personCheck: 'page',
        controlClaim: 'off',
        readerKey: false,
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
        roles: 'off',
        personCheck: 'page',
        controlClaim: 'off',
        readerKey: false,
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

  // The reader key's list is matched on the path after the mount is stripped,
  // and its token binds to the path as it arrived, mount included, as a person's.
  it("matches the reader's list after the mount, and binds its token to the mount", async () => {
    await start({ mode: 'required', reader: true, basePath: '/w/abc' })
    const readerFor = async (path: string) => ({
      'clawboo-reader-identity': await readerAssertion('GET', path),
    })
    const target = '/w/abc/api/tools/approvals?status=pending'
    // A read on the list, signed for the path as it arrives.
    const allowed = await get(target, await readerFor('/w/abc/api/tools/approvals'))
    expect(allowed).toMatchObject({ status: 200, body: { reader: 'reader:companion' } })
    // A read off the list, under the mount: the reader's 403.
    const offList = await get('/w/abc/api/settings', await readerFor('/w/abc/api/settings'))
    expect(offList).toMatchObject({ status: 403, body: { error: 'role', reason: 'reader' } })
    const offShape = await get(
      '/w/abc/api/tools/approvals',
      await readerFor('/w/abc/api/tools/approvals'),
    )
    expect(offShape).toMatchObject({ status: 403, body: { reason: 'reader' } })
    // A token that leaves the mount out of htu binds to another path.
    const unmounted = await get(target, await readerFor('/api/tools/approvals'))
    expect(unmounted).toMatchObject({ status: 401, body: { reason: 'binding' } })
    // The liveness probe under the mount needs no token.
    expect(await get('/w/abc/api/system/live')).toEqual({ status: 200, body: { ok: true } })
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
        roles: 'off',
        personCheck: 'page',
        controlClaim: 'off',
        readerKey: false,
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
      '/api/agents/a1/chat',
      await signedByApp('POST', '/api/agents/a1/chat'),
      'POST',
    )
    expect(res).toEqual({
      status: 200,
      body: {
        actsAsPerson: true,
        person: { id: 'account:u-7', name: 'Grace', role: null },
        via: 'app',
        claim: null,
      },
    })
  })

  it('refuses the app token on any route the app does not sign for', async () => {
    await start({ mode: 'on', appLink: true, proxy: false })
    // A person write such as a team's work check, a standing grant or any other
    // setting: a copied key must not reach them.
    const res = await get(
      '/api/team-verify-command/t1',
      await signedByApp('PUT', '/api/team-verify-command/t1'),
      'PUT',
    )
    expect(res).toMatchObject({
      status: 401,
      body: {
        reason: 'route',
        error: 'The app that started Clawboo may not sign for this request.',
      },
    })
    // The right path with the wrong method.
    const wrongMethod = await get(
      '/api/agents/a1/chat',
      await signedByApp('GET', '/api/agents/a1/chat'),
    )
    expect(wrongMethod).toMatchObject({ status: 401, body: { reason: 'route' } })
  })

  it('refuses an allowed-looking path that another reading takes elsewhere', async () => {
    await start({ mode: 'on', appLink: true, proxy: false })
    // As sent it matches /api/agents/:id/chat; resolved, it is /api/chat.
    const sneaky = '/api/agents/%2e%2e/chat'
    const res = await raw(
      sneaky,
      { 'clawboo-app-identity': await appAssertion('POST', sneaky) },
      'POST',
    )
    expect(res).toMatchObject({ status: 401, body: { reason: 'route' } })
    const dotted = '/api/agents/../files/x/chat'
    const res2 = await raw(
      dotted,
      { 'clawboo-app-identity': await appAssertion('POST', dotted) },
      'POST',
    )
    expect(res2).toMatchObject({ status: 401, body: { reason: 'route' } })
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

  it('says which issuer vouched for the person, so a rule can tell them apart', async () => {
    await start({ mode: 'on', appLink: true })
    const viaApp = await get(
      '/api/agents/a1/chat',
      await signedByApp('POST', '/api/agents/a1/chat'),
      'POST',
    )
    expect(viaApp.body['via']).toBe('app')
    expect((await get('/api/who', await signed('GET', '/api/who'))).body).toEqual({
      via: 'proxy',
    })
    expect((await get('/api/who')).body).toEqual({ via: null })
  })

  it('says two-tokens before anything else, even on a route the app may not sign for', async () => {
    await start({ mode: 'on', appLink: true })
    const res = await get(
      '/api/team-verify-command/t1',
      {
        ...(await signed('PUT', '/api/team-verify-command/t1')),
        ...(await signedByApp('PUT', '/api/team-verify-command/t1')),
      },
      'PUT',
    )
    expect(res).toMatchObject({ status: 401, body: { reason: 'two-tokens' } })
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

describe('the take-over claim', () => {
  const CONTROL = '/api/agents/a1/computer/control'
  const withClaim = async (control: unknown, method = 'POST', path = CONTROL) => ({
    'clawboo-identity': await assertion(method, path, ed.privateKey, { control }),
  })

  it("puts the agent a proxy token's control claim names on the request", async () => {
    await start({ mode: 'on', controlClaim: true })
    expect(await get(CONTROL, await withClaim('a1'), 'POST')).toEqual({
      status: 200,
      body: { claim: 'a1', actsAsPerson: true },
    })
  })

  it('refuses a token whose claim is malformed, never treating it as no claim', async () => {
    await start({ mode: 'on', controlClaim: true })
    const res = await get(CONTROL, await withClaim(7), 'POST')
    expect(res.status).toBe(401)
    expect(res.body['reason']).toBe('claims')
  })

  it('carries no claim for a request without a token, or with the switch off', async () => {
    await start({ mode: 'on', controlClaim: true })
    expect((await get(CONTROL, {}, 'POST')).body['claim']).toBeNull()
    await new Promise<void>((r) => server!.close(() => r()))
    await start({ mode: 'on' })
    expect((await get(CONTROL, await withClaim('a1'), 'POST')).body['claim']).toBeNull()
  })

  it("never takes one from the app link's token", async () => {
    await start({ mode: 'on', appLink: true, controlClaim: true })
    const path = '/api/agents/a1/chat'
    const res = await get(
      path,
      { 'clawboo-app-identity': await appAssertion('POST', path, { extra: { control: 'a1' } }) },
      'POST',
    )
    expect(res.status).toBe(200)
    expect(res.body['via']).toBe('app')
    expect(res.body['claim']).toBeNull()
  })
})

describe('the verified person check, over the lane', () => {
  const ROUTE = '/api/team-verify-command/T'
  const PAGE = { 'sec-fetch-site': 'same-origin', 'sec-fetch-mode': 'cors' }

  it('page: the dashboard page acts as the person without a token', async () => {
    await start({ mode: 'on' })
    expect((await get(ROUTE, PAGE, 'PUT')).body['actsAsPerson']).toBe(true)
  })

  it('verified: the page alone does not; a signed person does', async () => {
    setPersonCheckMode('verified')
    await start({ mode: 'on' })
    expect((await get(ROUTE, PAGE, 'PUT')).body['actsAsPerson']).toBe(false)
    expect((await get(ROUTE, { Origin: base }, 'PUT')).body['actsAsPerson']).toBe(false)
    const signedPage = { ...PAGE, ...(await signed('PUT', ROUTE)) }
    expect((await get(ROUTE, signedPage, 'PUT')).body).toEqual({
      actsAsPerson: true,
      person: { id: 'user-42', name: 'Ada', role: 'admin' },
    })
  })

  it("verified: the app link's person still acts on its own routes", async () => {
    setPersonCheckMode('verified')
    await start({ mode: 'on', appLink: true })
    const path = '/api/agents/a1/chat'
    const res = await get(
      path,
      { 'clawboo-app-identity': await appAssertion('POST', path) },
      'POST',
    )
    expect(res.body['actsAsPerson']).toBe(true)
  })

  it('says how the person check runs on the identity route', async () => {
    setPersonCheckMode('verified')
    await start({ mode: 'on' })
    expect((await get('/api/access/identity')).body).toMatchObject({
      personCheck: 'verified',
      controlClaim: 'off',
      person: null,
    })
  })
})

// The reader key: a program running beside the server making its own reads.
// It reaches its list and nothing else, never acts as a person, and never opens
// the Gateway connection.
describe('the reader key', () => {
  const STREAM = '/api/obs/stream?kinds=approval_requested,approval_resolved'
  const EVENTS = '/api/obs/events?kinds=approval_requested,approval_resolved&limit=1'
  const READS = [
    '/api/system/live',
    '/api/system/self-version?local=1',
    '/api/runtimes',
    '/api/teams',
    '/api/agents',
    '/api/tools/approvals?status=pending',
    `${STREAM}&afterSeq=0`,
    `${STREAM}&afterSeq=1234`,
    '/api/obs/stream?afterSeq=7&kinds=approval_requested%2Capproval_resolved',
    EVENTS,
    `${EVENTS}&order=desc`,
    `${EVENTS}&order=asc`,
    '/api/obs/events?order=desc&limit=1&kinds=approval_requested%2Capproval_resolved',
  ]
  /** The page's fetch metadata, which in `page` mode makes a request the person's. */
  const PAGE = { 'sec-fetch-site': 'same-origin', 'sec-fetch-mode': 'cors' }
  const byReader = async (method: string, target: string) => ({
    'clawboo-reader-identity': await readerAssertion(method, target.split('?')[0]!),
  })
  const REFUSED = {
    ok: false,
    error: 'role',
    reason: 'reader',
    message: 'The reader key may make only the reads on its list.',
  }

  it('makes each read on its list, in on and required, roles or not, never as a person', async () => {
    for (const [mode, roles] of [
      ['on', false],
      ['required', false],
      ['required', true],
    ] as const) {
      await start({ mode, reader: true, roles })
      for (const target of READS) {
        for (const method of ['GET', 'HEAD']) {
          const res = await get(target, { ...PAGE, ...(await byReader(method, target)) }, method)
          expect(res.status, `${mode} roles=${roles} ${method} ${target}`).toBe(200)
          if (method === 'GET' && target !== '/api/system/live') {
            expect(res.body, target).toEqual({
              reader: 'reader:companion',
              person: null,
              actsAsPerson: false,
              access: null,
            })
          }
        }
      }
      await new Promise<void>((r) => server!.close(() => r()))
      server = null
    }
  })

  it('refuses every other route, method and query shape with 403, before spending the token', async () => {
    await start({ mode: 'required', reader: true })
    const offList: Array<[string, string]> = [
      ['GET', '/api/settings'],
      ['GET', '/api/health'],
      ['GET', '/api/access/identity'],
      ['POST', '/api/teams'],
      ['DELETE', '/api/agents'],
      ['POST', '/api/system/live'],
      ['POST', '/api/mcp/tasks'],
      ['GET', '/api/mcp/tasks'],
      ['GET', '/api/teams?x=1'],
      ['GET', '/api/teams/'],
      ['GET', '/API/teams'],
      ['GET', '/api/runtimes?status=pending'],
      ['GET', '/api/system/live?x=1'],
      ['GET', '/api/system/self-version'],
      ['GET', '/api/system/self-version?local=0'],
      ['GET', '/api/system/self-version?local=1&local=1'],
      ['GET', '/api/system/self-version?local=1&extra='],
      ['GET', '/api/tools/approvals'],
      ['GET', '/api/tools/approvals?status=resolved'],
      ['GET', '/api/tools/approvals?status=pending&teamId=T'],
      ['GET', STREAM],
      ['GET', '/api/obs/stream?afterSeq=0'],
      ['GET', '/api/obs/stream?kinds=approval_requested&afterSeq=0'],
      ['GET', '/api/obs/stream?kinds=approval_resolved,approval_requested&afterSeq=0'],
      ['GET', '/api/obs/stream?kinds=approval_requested,approval_resolved,error&afterSeq=0'],
      ['GET', `${STREAM}&kinds=error&afterSeq=0`],
      ['GET', `${STREAM}&afterSeq=0&activity=1`],
      ['GET', `${STREAM}&afterSeq=0&teamId=T`],
      ['GET', `${STREAM}&afterSeq=-1`],
      ['GET', `${STREAM}&afterSeq=1e3`],
      ['GET', `${STREAM}&since=0`],
      ['GET', '/api/obs/events?kinds=approval_requested,approval_resolved'],
      ['GET', '/api/obs/events?limit=1'],
      ['GET', '/api/obs/events?kinds=error&limit=1'],
      ['GET', `${EVENTS.replace('limit=1', 'limit=2')}`],
      ['GET', `${EVENTS.replace('limit=1', 'limit=01')}`],
      ['GET', `${EVENTS}&order=random`],
      ['GET', `${EVENTS}&afterSeq=5`],
      ['GET', `${EVENTS}&teamId=T`],
      ['GET', `${EVENTS}&limit=1`],
    ]
    for (const [method, target] of offList) {
      const res = await get(target, await byReader(method, target), method)
      expect(res, `${method} ${target}`).toEqual({ status: 403, body: REFUSED })
    }
    // Spellings fetch would tidy up: every reading of the path must be the read's.
    for (const target of [
      '/api/x/../teams',
      '/api/teams/./',
      '/api/teams/%2e%2e/settings',
      '/api\\teams',
      `http://127.0.0.1:${port}/api/settings`,
    ]) {
      const res = await raw(target, await byReader('GET', target.split('?')[0]!))
      expect(res.status, target).toBe(403)
      expect(res.body, target).toEqual(REFUSED)
    }
    // A refused request did not spend its token: the same one makes its read.
    const token = await byReader('GET', '/api/teams')
    expect((await get('/api/teams?x=1', token)).status).toBe(403)
    expect((await get('/api/teams', token)).status).toBe(200)
  })

  it("takes the stream's Last-Event-ID header in place of afterSeq, digits only", async () => {
    await start({ mode: 'required', reader: true })
    const withLast = async (target: string, last: string) =>
      get(target, { ...(await byReader('GET', target.split('?')[0]!)), 'last-event-id': last })
    expect((await withLast(STREAM, '42')).status).toBe(200)
    expect((await withLast(`${STREAM}&afterSeq=40`, '42')).status).toBe(200)
    for (const last of ['abc', '-1', '4 2', '']) {
      expect((await withLast(STREAM, last)).status, JSON.stringify(last)).toBe(403)
    }
    expect((await withLast(`${STREAM}&afterSeq=40`, 'x')).status).toBe(403)
  })

  it('never opens the Gateway WebSocket, even with a good token', async () => {
    const upgrade = (headers: Record<string, string>) =>
      ({ method: 'GET', url: '/api/gateway/ws', headers }) as unknown as http.IncomingMessage
    for (const mode of ['on', 'required'] as const) {
      await start({ mode, reader: true })
      const readerToken = await readerAssertion('GET', '/api/gateway/ws')
      expect(await lane.checkUpgrade(upgrade({ 'clawboo-reader-identity': readerToken }))).toEqual({
        ok: false,
        reason: 'binding',
      })
      // Beside a good person token too: the reader's token alone shuts it.
      const both = {
        'clawboo-reader-identity': await readerAssertion('GET', '/api/gateway/ws'),
        'clawboo-identity': await assertion('GET', '/api/gateway/ws'),
      }
      expect(await lane.checkUpgrade(upgrade(both))).toEqual({ ok: false, reason: 'binding' })
      const person = await assertion('GET', '/api/gateway/ws')
      expect(await lane.checkUpgrade(upgrade({ 'clawboo-identity': person }))).toMatchObject({
        ok: true,
        person: { id: 'user-42' },
      })
      await new Promise<void>((r) => server!.close(() => r()))
      server = null
    }
  })

  it('refuses a reader token beside a person or app token on one request', async () => {
    await start({ mode: 'required', reader: true, appLink: true })
    const withPerson = {
      ...(await byReader('GET', '/api/teams')),
      ...(await signed('GET', '/api/teams')),
    }
    expect(await get('/api/teams', withPerson)).toMatchObject({
      status: 401,
      body: { reason: 'two-tokens' },
    })
    const withApp = {
      ...(await byReader('GET', '/api/teams')),
      'clawboo-app-identity': await appAssertion('GET', '/api/teams'),
    }
    expect(await get('/api/teams', withApp)).toMatchObject({
      status: 401,
      body: { reason: 'two-tokens' },
    })
  })

  it('refuses a reader token that does not verify, or is used twice, rather than skip it', async () => {
    await start({ mode: 'on', reader: true })
    const forged = await readerAssertion('GET', '/api/teams', { key: other.privateKey })
    expect(await get('/api/teams', { 'clawboo-reader-identity': forged })).toMatchObject({
      status: 401,
      body: {
        reason: 'signature',
        error: 'Clawboo refused the identity token signed with its reader key.',
      },
    })
    // The proxy's own key on the reader's header is no reader's token either.
    const proxyKey = await readerAssertion('GET', '/api/teams', { key: ed.privateKey })
    expect((await get('/api/teams', { 'clawboo-reader-identity': proxyKey })).status).toBe(401)
    const notReader = await readerAssertion('GET', '/api/teams', { sub: 'user-42' })
    expect(await get('/api/teams', { 'clawboo-reader-identity': notReader })).toMatchObject({
      status: 401,
      body: { reason: 'claims' },
    })
    const once = await byReader('GET', '/api/teams')
    expect((await get('/api/teams', once)).status).toBe(200)
    expect(await get('/api/teams', once)).toMatchObject({
      status: 401,
      body: { reason: 'replayed' },
    })
  })

  it('leaves required as it was: a read with no token at all is refused', async () => {
    await start({ mode: 'required', reader: true })
    expect(await get('/api/teams')).toMatchObject({ status: 401, body: { reason: 'missing' } })
  })

  it('bars a sign-in proxy from naming a reader: subject while the key is on', async () => {
    await start({ mode: 'required', reader: true })
    const now = Math.floor(Date.now() / 1000)
    const posing = await new SignJWT({ htm: 'GET', htu: '/api/teams' })
      .setProtectedHeader({ alg: 'EdDSA' })
      .setIssuer('https://proxy.example.com')
      .setAudience('clawboo')
      .setSubject('reader:companion')
      .setIssuedAt(now)
      .setExpirationTime(now + 30)
      .setJti(`posing-${Math.random()}`)
      .sign(ed.privateKey)
    expect(await get('/api/teams', { 'clawboo-identity': posing })).toMatchObject({
      status: 401,
      body: { reason: 'claims' },
    })
  })

  it('says on the identity route whether a reader key is set', async () => {
    await start({ mode: 'on', reader: true })
    const res = await get('/api/access/identity', await signed('GET', '/api/access/identity'))
    expect(res.body).toMatchObject({ readerKey: true, person: { id: 'user-42' } })
    await new Promise<void>((r) => server!.close(() => r()))
    server = null
    vi.unstubAllEnvs()
    resetOperatorSettings()
    await start({ mode: 'on' })
    expect((await get('/api/access/identity')).body).toMatchObject({ readerKey: false })
  })
})

// GET and HEAD /api/system/live: whether the server is up, with no sign-in.
describe('the liveness probe', () => {
  const cookie = { cookie: `clawboo_access=${ACCESS_TOKEN}` }

  it('answers up with no access cookie and no identity token, in required mode', async () => {
    await start({ mode: 'required', accessToken: ACCESS_TOKEN })
    const res = await fetch(`${base}/api/system/live`)
    expect(res.status).toBe(200)
    expect(res.headers.get('cache-control')).toBe('no-store')
    expect(await res.json()).toEqual({ ok: true })
    const head = await fetch(`${base}/api/system/live`, { method: 'HEAD' })
    expect(head.status).toBe(200)
    expect(await head.text()).toBe('')
  })

  it('is only the probe: another method, spelling or query needs both as ever', async () => {
    await start({ mode: 'required', accessToken: ACCESS_TOKEN })
    expect(await get('/api/system/live', {}, 'POST')).toMatchObject({
      status: 401,
      body: { gate: 'clawboo-access' },
    })
    for (const target of ['/api/system/live?x=1', '/api/system/live/', '/API/system/live']) {
      expect((await get(target)).body, target).toMatchObject({ gate: 'clawboo-access' })
      expect((await get(target, cookie)).body, target).toMatchObject({ reason: 'missing' })
    }
    expect((await raw('/api/system/x/../live', cookie)).body).toMatchObject({ reason: 'missing' })
  })

  it('checks a token the probe carries, like any other request', async () => {
    await start({ mode: 'on', reader: true })
    const forged = await assertion('GET', '/api/system/live', other.privateKey)
    expect(await get('/api/system/live', { 'clawboo-identity': forged })).toMatchObject({
      status: 401,
      body: { reason: 'signature' },
    })
    const person = await signed('GET', '/api/system/live')
    expect(await get('/api/system/live', person)).toEqual({ status: 200, body: { ok: true } })
    const readerToken = {
      'clawboo-reader-identity': await readerAssertion('GET', '/api/system/live'),
    }
    expect(await get('/api/system/live', readerToken)).toEqual({ status: 200, body: { ok: true } })
  })
})
