// The attacks the identity lane exists to refuse, and the tokens it accepts.
//
// Every refusal here is a way to pass for a person without the proxy's private
// key: a forged or tampered signature, an unsigned `alg: none` token, an HMAC
// token "signed" with the public key as its secret, a real token replayed or
// pointed at another method or path, an expired one, or one dated in the future
// beyond the clock skew allowance.

import { generateKeyPairSync, type KeyObject } from 'node:crypto'
import http from 'node:http'
import type { AddressInfo } from 'node:net'

import { SignJWT, UnsecuredJWT, type JWK, type JWTPayload } from 'jose'
import { afterEach, describe, expect, it } from 'vitest'

import type { ProxyIdentityConfig } from '../config'
import { CLOCK_SKEW_SECONDS, createAssertionVerifier } from '../verifier'

const ISSUER = 'https://proxy.example.com'
const AUDIENCE = 'clawboo'
const NOW_MS = Date.UTC(2026, 10, 4, 12, 0, 0)
const NOW = NOW_MS / 1000

const ed = generateKeyPairSync('ed25519')
const otherEd = generateKeyPairSync('ed25519')
const rsa = generateKeyPairSync('rsa', { modulusLength: 2048 })

const jwkOf = (key: KeyObject, kid?: string): JWK =>
  ({ ...(key.export({ format: 'jwk' }) as JWK), ...(kid ? { kid } : {}) }) as JWK

function config(over: Partial<ProxyIdentityConfig> = {}): ProxyIdentityConfig {
  return {
    mode: 'required',
    header: 'clawboo-identity',
    issuer: ISSUER,
    audience: AUDIENCE,
    binding: 'request',
    maxLifetimeSeconds: 60,
    nameClaim: 'name',
    roleClaim: 'role',
    keys: { source: 'public-key', jwks: { keys: [jwkOf(ed.publicKey)] } },
    accountSubjects: 'never',
    ...over,
  }
}

let jtiCount = 0
/** A good request-bound token for GET /api/board, with `over` applied. */
function claims(over: Record<string, unknown> = {}): JWTPayload {
  jtiCount += 1
  return {
    iss: ISSUER,
    aud: AUDIENCE,
    sub: 'user-42',
    name: 'Ada Lovelace',
    role: 'admin',
    iat: NOW,
    exp: NOW + 30,
    jti: `jti-${jtiCount}`,
    htm: 'GET',
    htu: '/api/board',
    ...over,
  }
}

async function sign(
  payload: JWTPayload,
  key: KeyObject = ed.privateKey,
  alg = 'EdDSA',
  kid?: string,
): Promise<string> {
  // Each claim is set as given (including `undefined` to drop one): SignJWT's
  // own setters would fill in defaults the attacks need to leave out.
  const body = Object.fromEntries(Object.entries(payload).filter(([, v]) => v !== undefined))
  return new SignJWT(body).setProtectedHeader({ alg, ...(kid ? { kid } : {}) }).sign(key)
}

const verifier = (over: Partial<ProxyIdentityConfig> = {}, now = NOW_MS) =>
  createAssertionVerifier(config(over), { now: () => now })

const at = (token: string, method = 'GET', path = '/api/board') => ({ token, method, path })

describe('a good token', () => {
  it('names the person: the subject, the name and the role', async () => {
    const result = await verifier().verify(at(await sign(claims())))
    expect(result).toEqual({
      ok: true,
      person: { id: 'user-42', name: 'Ada Lovelace', role: 'admin' },
    })
  })

  it('takes the name from email when the name claim is missing, and joins a list of roles', async () => {
    const token = await sign(
      claims({ name: undefined, email: 'ada@example.com', role: ['admin', 'ops'] }),
    )
    const result = await verifier().verify(at(token))
    expect(result).toEqual({
      ok: true,
      person: { id: 'user-42', name: 'ada@example.com', role: 'admin, ops' },
    })
  })

  it('reads a nested role claim the operator names', async () => {
    const token = await sign(claims({ role: undefined, realm_access: { roles: ['reviewer'] } }))
    const result = await verifier({ roleClaim: 'realm_access.roles' }).verify(at(token))
    expect(result).toMatchObject({ ok: true, person: { role: 'reviewer' } })
  })

  it('binds to the path, not the query, and accepts htu as a full URL', async () => {
    const v = verifier()
    expect(await v.verify(at(await sign(claims()), 'GET', '/api/board?teamId=t1'))).toMatchObject({
      ok: true,
    })
    const full = await sign(claims({ htu: 'https://dash.example.com/api/board?x=1' }))
    expect(await v.verify(at(full))).toMatchObject({ ok: true })
  })
})

describe('forgery', () => {
  it('refuses a token signed by another key', async () => {
    const token = await sign(claims(), otherEd.privateKey)
    expect(await verifier().verify(at(token))).toEqual({ ok: false, reason: 'signature' })
  })

  it('refuses a good token whose payload was changed', async () => {
    const token = await sign(claims())
    const [h, p, s] = token.split('.') as [string, string, string]
    const payload = JSON.parse(Buffer.from(p, 'base64url').toString()) as Record<string, unknown>
    payload['sub'] = 'someone-else'
    const forged = `${h}.${Buffer.from(JSON.stringify(payload)).toString('base64url')}.${s}`
    expect(await verifier().verify(at(forged))).toEqual({ ok: false, reason: 'signature' })
  })

  it('refuses an unsigned alg: none token', async () => {
    const token = new UnsecuredJWT(claims()).encode()
    expect(await verifier().verify(at(token))).toEqual({ ok: false, reason: 'algorithm' })
    // The same with the empty signature segment some libraries emit filled in.
    expect(await verifier().verify(at(`${token}AAAA`))).toEqual({
      ok: false,
      reason: 'algorithm',
    })
  })

  it('refuses an HMAC token signed with the public key as its secret', async () => {
    const pem = ed.publicKey.export({ format: 'pem', type: 'spki' }).toString()
    const jwkText = JSON.stringify(jwkOf(ed.publicKey))
    for (const secret of [pem, jwkText, jwkOf(ed.publicKey).x as string]) {
      for (const alg of ['HS256', 'HS384', 'HS512']) {
        const token = await new SignJWT(claims())
          .setProtectedHeader({ alg })
          .sign(new TextEncoder().encode(secret))
        expect(await verifier().verify(at(token))).toEqual({ ok: false, reason: 'algorithm' })
      }
    }
  })

  it('refuses a token whose header names an algorithm its key does not have', async () => {
    const token = await sign(claims(), rsa.privateKey, 'RS256')
    expect(await verifier().verify(at(token))).toEqual({ ok: false, reason: 'signature' })
  })

  it('refuses text that is not a compact JWS', async () => {
    for (const junk of ['', 'abc', 'a.b', 'a.b.c.d', 'x'.repeat(20_000), 'a.b.c!']) {
      expect(await verifier().verify(at(junk))).toEqual({ ok: false, reason: 'malformed' })
    }
  })
})

describe('issuer, audience and subject', () => {
  it('refuses another issuer', async () => {
    const token = await sign(claims({ iss: 'https://evil.example.com' }))
    expect(await verifier().verify(at(token))).toEqual({ ok: false, reason: 'issuer' })
  })

  it('refuses another audience, such as a token for another app of the same provider', async () => {
    const token = await sign(claims({ aud: 'some-other-app' }))
    expect(await verifier().verify(at(token))).toEqual({ ok: false, reason: 'audience' })
  })

  it('refuses a token with no subject', async () => {
    const token = await sign(claims({ sub: undefined }))
    expect(await verifier().verify(at(token))).toEqual({ ok: false, reason: 'claims' })
  })

  it("refuses a sign-in proxy's token that names an app link's account: person", async () => {
    const token = await sign(claims({ sub: 'account:u-7' }))
    expect(await verifier().verify(at(token))).toEqual({ ok: false, reason: 'claims' })
  })

  it('keeps a proxy that already names account: people working while no app link is on', async () => {
    const token = await sign(claims({ sub: 'account:u-7' }))
    expect(await verifier({ accountSubjects: 'any' }).verify(at(token))).toMatchObject({
      ok: true,
      person: { id: 'account:u-7' },
    })
  })
})

describe("an app link's people", () => {
  const appLink = () => verifier({ accountSubjects: 'only', mode: 'on' })

  it('names an account: person', async () => {
    const token = await sign(claims({ sub: 'account:u-7', name: 'Ada', role: undefined }))
    expect(await appLink().verify(at(token))).toEqual({
      ok: true,
      person: { id: 'account:u-7', name: 'Ada', role: null },
    })
  })

  it('refuses anyone else, and an account: prefix with no id after it', async () => {
    for (const sub of ['user-42', 'local', 'account:', 'Account:u-7']) {
      const token = await sign(claims({ sub }))
      expect(await appLink().verify(at(token))).toEqual({ ok: false, reason: 'claims' })
    }
  })
})

describe('binding to the request', () => {
  it('refuses a token for another path', async () => {
    const token = await sign(claims({ htu: '/api/board/other' }))
    expect(await verifier().verify(at(token))).toEqual({ ok: false, reason: 'binding' })
  })

  it('refuses a token for another method', async () => {
    const token = await sign(claims({ htm: 'GET' }))
    expect(await verifier().verify(at(token, 'POST'))).toEqual({ ok: false, reason: 'binding' })
  })

  it('refuses a token for the same path under another mount', async () => {
    const token = await sign(claims({ htu: '/api/board' }))
    expect(await verifier().verify(at(token, 'GET', '/clawboo/api/board'))).toEqual({
      ok: false,
      reason: 'binding',
    })
  })

  it('binds to the raw path: dot segments and other spellings of it are another path', async () => {
    const v = verifier()
    for (const [htu, path] of [
      ['/api/board', '/api/x/../board'],
      ['/api/x/../board', '/api/board'],
      ['https://dash.example.com/api/x/../board', '/api/board'],
      ['https://dash.example.com/api/x/../board', '/api/x/../board'],
      ['//evil.example.com/api/board', '/api/board'],
      ['javascript:/api/board', '/api/board'],
      ['/api/Board', '/api/board'],
    ] as const) {
      const token = await sign(claims({ htu }))
      expect(await v.verify(at(token, 'GET', path))).toEqual({ ok: false, reason: 'binding' })
    }
  })

  it('refuses a request-bound token with no htm, htu or jti', async () => {
    for (const missing of ['htm', 'htu', 'jti']) {
      const token = await sign(claims({ [missing]: undefined }))
      expect(await verifier().verify(at(token))).toEqual({ ok: false, reason: 'claims' })
    }
  })

  it('accepts a token once: the same token again is a replay', async () => {
    const v = verifier()
    const token = await sign(claims())
    expect(await v.verify(at(token))).toMatchObject({ ok: true })
    expect(await v.verify(at(token))).toEqual({ ok: false, reason: 'replayed' })
  })

  it('remembers a token with a fractional exp for as long as it is still accepted', async () => {
    // The clock is read in whole seconds, so exp NOW + 30.5 is still good at
    // NOW + 35.6 (NOW + 35 is not past exp plus the 5 s skew allowance). Its
    // record must outlive that, or the same token passes a second time.
    let clock = NOW_MS
    const v = createAssertionVerifier(config(), { now: () => clock })
    const token = await sign(claims({ iat: NOW, exp: NOW + 30.5 }))
    expect(await v.verify(at(token))).toMatchObject({ ok: true })
    clock = (NOW + 35.6) * 1000
    expect(await v.verify(at(token))).toEqual({ ok: false, reason: 'replayed' })
    clock = (NOW + 36) * 1000
    expect(await v.verify(at(token))).toEqual({ ok: false, reason: 'expired' })
  })

  it('does not spend a token on a refused request', async () => {
    const v = verifier()
    const token = await sign(claims())
    expect(await v.verify(at(token, 'POST'))).toEqual({ ok: false, reason: 'binding' })
    expect(await v.verify(at(token))).toMatchObject({ ok: true })
  })
})

describe('time', () => {
  it('refuses an expired token', async () => {
    const token = await sign(claims({ iat: NOW - 50, exp: NOW - 20 }))
    expect(await verifier().verify(at(token))).toEqual({ ok: false, reason: 'expired' })
  })

  it('refuses a token that lives longer than the operator allows', async () => {
    const token = await sign(claims({ iat: NOW, exp: NOW + 200 }))
    expect(await verifier().verify(at(token))).toEqual({ ok: false, reason: 'lifetime' })
    // The operator's own maximum, not a fixed one.
    const fits = await sign(claims({ iat: NOW, exp: NOW + 200 }))
    expect(await verifier({ maxLifetimeSeconds: 300 }).verify(at(fits))).toMatchObject({
      ok: true,
    })
  })

  it('refuses an old token whose expiry is still ahead', async () => {
    const token = await sign(claims({ iat: NOW - 90, exp: NOW + 30 }))
    expect((await verifier().verify(at(token))).ok).toBe(false)
  })

  it(`allows ${CLOCK_SKEW_SECONDS} s of clock skew either way, and no more`, async () => {
    const v = verifier()
    const ahead = await sign(claims({ iat: NOW + 3, exp: NOW + 30 }))
    expect(await v.verify(at(ahead))).toMatchObject({ ok: true })
    const tooFar = await sign(claims({ iat: NOW + 10, exp: NOW + 40 }))
    expect(await v.verify(at(tooFar))).toEqual({ ok: false, reason: 'not-yet-valid' })

    const justExpired = await sign(claims({ iat: NOW - 30, exp: NOW - 3 }))
    expect(await v.verify(at(justExpired))).toMatchObject({ ok: true })
    const longExpired = await sign(claims({ iat: NOW - 40, exp: NOW - 10 }))
    expect(await v.verify(at(longExpired))).toEqual({ ok: false, reason: 'expired' })
  })

  it('refuses a token that is not valid yet', async () => {
    const token = await sign(claims({ nbf: NOW + 30 }))
    expect(await verifier().verify(at(token))).toEqual({ ok: false, reason: 'not-yet-valid' })
  })
})

describe('session binding (a proxy that sends its own sign-in token)', () => {
  const session = (over: Record<string, unknown> = {}) =>
    claims({ htm: undefined, htu: undefined, jti: undefined, exp: NOW + 3600, ...over })

  it('accepts the same token on any path, again and again, until it expires', async () => {
    const v = verifier({ binding: 'session' })
    const token = await sign(session())
    expect(await v.verify(at(token, 'GET', '/api/board'))).toMatchObject({ ok: true })
    expect(await v.verify(at(token, 'POST', '/api/tools/approvals/a/resolve'))).toMatchObject({
      ok: true,
    })
    const expired = await sign(session({ iat: NOW - 7200, exp: NOW - 60 }))
    expect(await v.verify(at(expired))).toEqual({ ok: false, reason: 'expired' })
  })

  it('still checks htm and htu when the token carries them', async () => {
    const token = await sign(session({ htm: 'GET', htu: '/api/board' }))
    expect(await verifier({ binding: 'session' }).verify(at(token, 'GET', '/api/other'))).toEqual({
      ok: false,
      reason: 'binding',
    })
  })

  it('still refuses forgeries, alg none and HMAC', async () => {
    const v = verifier({ binding: 'session' })
    expect(await v.verify(at(await sign(session(), otherEd.privateKey)))).toEqual({
      ok: false,
      reason: 'signature',
    })
    expect(await v.verify(at(new UnsecuredJWT(session()).encode()))).toEqual({
      ok: false,
      reason: 'algorithm',
    })
    const pem = ed.publicKey.export({ format: 'pem', type: 'spki' }).toString()
    const hmac = await new SignJWT(session())
      .setProtectedHeader({ alg: 'HS256' })
      .sign(new TextEncoder().encode(pem))
    expect(await v.verify(at(hmac))).toEqual({ ok: false, reason: 'algorithm' })
  })

  it('refuses a token with no expiry', async () => {
    const token = await sign(session({ exp: undefined }))
    expect(await verifier({ binding: 'session' }).verify(at(token))).toEqual({
      ok: false,
      reason: 'claims',
    })
  })
})

describe('keys from a JWKS URL', () => {
  let server: http.Server | null = null
  afterEach(async () => {
    if (server) await new Promise<void>((r) => server!.close(() => r()))
    server = null
  })

  async function serveJwks(keys: JWK[]): Promise<URL> {
    server = http.createServer((_req, res) => {
      res.setHeader('Content-Type', 'application/json')
      res.end(JSON.stringify({ keys }))
    })
    await new Promise<void>((r) => server!.listen(0, '127.0.0.1', () => r()))
    return new URL(`http://127.0.0.1:${(server.address() as AddressInfo).port}/certs`)
  }

  it('verifies an RS256 token with the key its kid names, as Cloudflare Access signs', async () => {
    const url = await serveJwks([jwkOf(ed.publicKey, 'ed-1'), jwkOf(rsa.publicKey, 'rsa-1')])
    const v = verifier({ keys: { source: 'jwks-url', url } }, Date.now())
    const now = Math.floor(Date.now() / 1000)
    const token = await sign(claims({ iat: now, exp: now + 30 }), rsa.privateKey, 'RS256', 'rsa-1')
    expect(await v.verify(at(token))).toMatchObject({ ok: true, person: { id: 'user-42' } })
  })

  it('refuses a token whose kid the proxy does not publish', async () => {
    const url = await serveJwks([jwkOf(ed.publicKey, 'ed-1')])
    const v = verifier({ keys: { source: 'jwks-url', url } }, Date.now())
    const now = Math.floor(Date.now() / 1000)
    const token = await sign(
      claims({ iat: now, exp: now + 30 }),
      otherEd.privateKey,
      'EdDSA',
      'ed-unknown',
    )
    expect(await v.verify(at(token))).toEqual({ ok: false, reason: 'signature' })
  })

  it('refuses every token while the keys cannot be fetched', async () => {
    const url = await serveJwks([])
    await new Promise<void>((r) => server!.close(() => r()))
    server = null
    const v = verifier({ keys: { source: 'jwks-url', url } }, Date.now())
    const now = Math.floor(Date.now() / 1000)
    const token = await sign(claims({ iat: now, exp: now + 30 }), ed.privateKey, 'EdDSA', 'ed-1')
    expect(await v.verify(at(token))).toEqual({ ok: false, reason: 'keys-unavailable' })
  })
})
