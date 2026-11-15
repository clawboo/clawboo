// Roles end to end, over real HTTP and in the server's own order: the identity
// lane verifies a signed token, reads the access its role claims grant, and each
// route's guard (registered through withRouteRules) applies its rule. The
// identity route says what the person may do.

import { generateKeyPairSync } from 'node:crypto'
import http from 'node:http'
import type { AddressInfo } from 'node:net'

import express, { Router } from 'express'
import { SignJWT, type JWK } from 'jose'
import { afterEach, describe, expect, it } from 'vitest'

import { isRuntimeControlRequest } from '@clawboo/gateway-proxy'

import { accessIdentityGET } from '../../../api/access'
import { attachIdentity } from '../../auth'
import { resetOperatorSettings } from '../../operatorSettings'
import type { ProxyIdentityConfig } from '../../proxyIdentity/config'
import { createProxyIdentityLane } from '../../proxyIdentity/lane'
import { createAssertionVerifier } from '../../proxyIdentity/verifier'
import { withRouteRules } from '../guard'

const ed = generateKeyPairSync('ed25519')
const ISSUER = 'https://sign-in.example.com'
const AUDIENCE = 'workspace-1'

function config(roles: 'off' | 'enforce'): ProxyIdentityConfig {
  return {
    mode: 'required',
    header: 'clawboo-identity',
    issuer: ISSUER,
    audience: AUDIENCE,
    binding: 'request',
    maxLifetimeSeconds: 60,
    nameClaim: 'name',
    roleClaim: 'role',
    keys: { source: 'public-key', jwks: { keys: [ed.publicKey.export({ format: 'jwk' }) as JWK] } },
    accountSubjects: 'any',
    roles,
  }
}

let n = 0
async function token(
  method: string,
  path: string,
  claims: Record<string, unknown>,
): Promise<string> {
  const now = Math.floor(Date.now() / 1000)
  n += 1
  return new SignJWT({ name: 'Ada', htm: method, htu: path, ...claims })
    .setProtectedHeader({ alg: 'EdDSA' })
    .setIssuer(ISSUER)
    .setAudience(AUDIENCE)
    .setSubject('u-42')
    .setIssuedAt(now)
    .setExpirationTime(now + 30)
    .setJti(`roles-${n}-${Math.random()}`)
    .sign(ed.privateKey)
}

let server: http.Server | null = null
let base = ''

async function start(roles: 'off' | 'enforce'): Promise<void> {
  const lane = createProxyIdentityLane(config(roles), createAssertionVerifier(config(roles)), {
    isRuntimeRequest: (req) => isRuntimeControlRequest(req, () => false),
  })
  const app = express()
  app.locals['rolesMode'] = roles
  app.use(express.json())
  app.use(lane.http)
  app.use(attachIdentity)
  const router = withRouteRules(Router({ caseSensitive: true }))
  const ok = (_req: express.Request, res: express.Response) => res.json({ ok: true })
  router.get('/api/access/identity', accessIdentityGET)
  router.get('/api/board', ok)
  router.post('/api/tools/approvals/:id/resolve', ok)
  router.post('/api/agents', ok)
  router.get('/api/teams/:id/rooms', ok)
  router.get('/api/not-in-the-rules', ok)
  app.use(router)
  server = http.createServer(app)
  await new Promise<void>((r) => server!.listen(0, '127.0.0.1', () => r()))
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
}

afterEach(async () => {
  if (server) await new Promise<void>((r) => server!.close(() => r()))
  server = null
  resetOperatorSettings()
})

async function send(
  method: string,
  path: string,
  claims: Record<string, unknown> | null,
  body?: unknown,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const headers: Record<string, string> = { 'content-type': 'application/json' }
  if (claims) headers['clawboo-identity'] = await token(method, path, claims)
  const res = await fetch(`${base}${path}`, {
    method,
    headers,
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  })
  return { status: res.status, body: (await res.json()) as Record<string, unknown> }
}

describe('roles enforced', () => {
  it("applies each role's rule to the route it was registered with", async () => {
    await start('enforce')
    const resolve = '/api/tools/approvals/ap-1/resolve'
    expect(
      (await send('POST', resolve, { role: 'owner' }, { decision: 'allow_once' })).status,
    ).toBe(200)
    expect(
      (await send('POST', resolve, { role: 'operator' }, { decision: 'allow_once' })).status,
    ).toBe(403)
    const always = await send(
      'POST',
      resolve,
      { role: 'member', approve: true },
      { decision: 'allow_always' },
    )
    expect(always).toEqual({
      status: 403,
      body: {
        ok: false,
        error: 'role',
        reason: 'not-allowed',
        message: 'Your role in this workspace does not allow this.',
      },
    })
    expect((await send('POST', '/api/agents', { role: 'operator' }, {})).status).toBe(200)
    expect((await send('POST', '/api/agents', { role: 'owner' }, {})).status).toBe(403)
  })

  it('keeps a route nobody listed to operators', async () => {
    await start('enforce')
    expect((await send('GET', '/api/not-in-the-rules', { role: 'owner' })).status).toBe(403)
    expect((await send('GET', '/api/not-in-the-rules', { role: 'operator' })).status).toBe(200)
  })

  it('limits a guest to the teams in their token', async () => {
    await start('enforce')
    const guest = {
      role: 'guest',
      teams: ['team-a'],
      roleLabel: 'Expert',
      access_until: Math.floor(Date.now() / 1000) + 3600,
    }
    expect((await send('GET', '/api/teams/team-a/rooms', guest)).status).toBe(200)
    expect((await send('GET', '/api/teams/team-b/rooms', guest)).status).toBe(403)
  })

  it('refuses a guest token with no end, as it refuses any malformed one', async () => {
    await start('enforce')
    const res = await send('GET', '/api/teams/team-a/rooms', { role: 'guest', teams: ['team-a'] })
    expect(res.status).toBe(401)
    expect(res.body['reason']).toBe('claims')
  })

  it('refuses a token whose claims beside the role are malformed, as the lane refuses any bad token', async () => {
    await start('enforce')
    const res = await send('GET', '/api/board', { role: 'guest', teams: 'team-a' })
    expect(res.status).toBe(401)
    expect(res.body['reason']).toBe('claims')
  })

  it('tells a person what they may do, and a person with no role that they may do nothing', async () => {
    await start('enforce')
    const owner = await send('GET', '/api/access/identity', { role: 'owner' })
    expect(owner.status).toBe(200)
    expect(owner.body['roles']).toBe('enforce')
    expect(owner.body['access']).toMatchObject({
      roles: ['owner'],
      permissions: ['see', 'work', 'tighten', 'accounts', 'approve', 'standing', 'records'],
      guest: false,
      teams: null,
    })

    const until = Math.floor(Date.now() / 1000) + 3600
    const guest = await send('GET', '/api/access/identity', {
      role: 'guest',
      teams: ['team-a'],
      access_until: until,
      roleLabel: 'Expert',
    })
    expect(guest.body['access']).toMatchObject({
      roles: ['guest'],
      label: 'Expert',
      permissions: ['see', 'work'],
      guest: true,
      teams: ['team-a'],
      accessUntil: until,
      ended: false,
      service: false,
    })

    const nobody = await send('GET', '/api/access/identity', { role: 'stranger' })
    expect(nobody.status).toBe(200)
    expect(nobody.body['access']).toMatchObject({ roles: [], permissions: [] })
    expect((await send('GET', '/api/board', { role: 'stranger' })).body['reason']).toBe('no-role')
  })

  it("ends a guest's access at their until, refusal by refusal", async () => {
    await start('enforce')
    const past = Math.floor(Date.now() / 1000) - 1
    const res = await send('GET', '/api/teams/team-a/rooms', {
      role: 'guest',
      teams: ['team-a'],
      access_until: past,
    })
    expect(res.status).toBe(403)
    expect(res.body['reason']).toBe('ended')
  })
})

describe('a service token', () => {
  it('is a program with its role, never a person', async () => {
    await start('enforce')
    const svc = { role: 'operator', svc: true, rv: 1 }
    expect((await send('GET', '/api/not-in-the-rules', svc)).status).toBe(200)
    expect(
      (await send('POST', '/api/tools/approvals/ap-1/resolve', svc, { decision: 'allow_once' }))
        .status,
    ).toBe(403)
    const identity = await send('GET', '/api/access/identity', svc)
    expect(identity.body['person']).toBeNull()
    expect(identity.body['service']).toMatchObject({ id: 'u-42' })
    expect(identity.body['access']).toMatchObject({ roles: ['operator'], service: true })
  })

  it('is refused for a version of the claims this engine does not know', async () => {
    await start('enforce')
    const res = await send('GET', '/api/board', { role: 'owner', rv: 2 })
    expect(res.status).toBe(401)
    expect(res.body['reason']).toBe('claims')
  })
})

describe('roles off', () => {
  it('records the role and decides nothing by it', async () => {
    await start('off')
    expect((await send('POST', '/api/agents', { role: 'guest' }, {})).status).toBe(200)
    // A malformed claim beside the role is not read at all while roles are off.
    expect((await send('GET', '/api/board', { role: 'guest', teams: 'x' })).status).toBe(200)
    const identity = await send('GET', '/api/access/identity', { role: 'guest' })
    expect(identity.body['roles']).toBe('off')
    expect(identity.body['access']).toBeUndefined()
    expect(identity.body['person']).toMatchObject({ id: 'u-42', role: 'guest' })
  })
})
