// The lane's issuers as the server builds them: every verifier records the
// tokens it accepts in the database, so a restart (a new set of verifiers on the
// same database) still refuses a used token; and beside a proxy that publishes
// a JWKS URL, the reader key's verifier refuses a token the proxy's keys verify.

import { generateKeyPairSync, type KeyObject } from 'node:crypto'
import http from 'node:http'
import type { AddressInfo } from 'node:net'

import { createDb, type ClawbooDb } from '@clawboo/db'
import { SignJWT, type JWK } from 'jose'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import {
  READER_AUDIENCE,
  READER_HEADER,
  READER_ISSUER,
  identityConfigs,
  type ProxyIdentityConfig,
} from '../config'
import { identitySources } from '../sources'

const proxyKey = generateKeyPairSync('ed25519')
const readerKey = generateKeyPairSync('ed25519')
const jwk = (key: KeyObject, kid?: string): JWK =>
  ({ ...(key.export({ format: 'jwk' }) as JWK), ...(kid ? { kid } : {}) }) as JWK

const proxy = (keys: ProxyIdentityConfig['keys']): ProxyIdentityConfig => ({
  mode: 'required',
  header: 'clawboo-identity',
  issuer: 'https://proxy.example.com',
  audience: 'clawboo',
  binding: 'request',
  maxLifetimeSeconds: 60,
  nameClaim: 'name',
  roleClaim: 'role',
  keys,
  accountSubjects: 'any',
})
const reader = (kid?: string): ProxyIdentityConfig => ({
  mode: 'on',
  header: READER_HEADER,
  issuer: READER_ISSUER,
  audience: READER_AUDIENCE,
  binding: 'request',
  maxLifetimeSeconds: 60,
  nameClaim: 'name',
  roleClaim: 'role',
  keys: { source: 'public-key', jwks: { keys: [jwk(readerKey.publicKey, kid)] } },
  accountSubjects: 'never',
  reader: true,
})

let n = 0
async function token(
  key: KeyObject,
  iss: string,
  aud: string,
  sub: string,
  kid?: string,
): Promise<string> {
  const now = Math.floor(Date.now() / 1000)
  n += 1
  return new SignJWT({ htm: 'GET', htu: '/api/teams' })
    .setProtectedHeader({ alg: 'EdDSA', ...(kid ? { kid } : {}) })
    .setIssuer(iss)
    .setAudience(aud)
    .setSubject(sub)
    .setIssuedAt(now)
    .setExpirationTime(now + 30)
    .setJti(`sources-${n}`)
    .sign(key)
}

let db: ClawbooDb
beforeEach(() => {
  db = createDb(':memory:')
})

describe('identitySources', () => {
  it('records every lane in the database, so a restart still refuses a used token', async () => {
    const p = proxy({ source: 'public-key', jwks: { keys: [jwk(proxyKey.publicKey)] } })
    const configs = identityConfigs(p, null, reader())
    const boot = () => identitySources(configs, p, { db: () => db })
    const personToken = await token(
      proxyKey.privateKey,
      'https://proxy.example.com',
      'clawboo',
      'user-42',
    )
    const readerToken = await token(
      readerKey.privateKey,
      READER_ISSUER,
      READER_AUDIENCE,
      'reader:companion',
    )
    const input = { method: 'GET', path: '/api/teams' }
    const [proxyBefore, readerBefore] = boot()
    expect((await proxyBefore!.verifier.verify({ token: personToken, ...input })).ok).toBe(true)
    expect((await readerBefore!.verifier.verify({ token: readerToken, ...input })).ok).toBe(true)
    const [proxyAfter, readerAfter] = boot()
    expect(await proxyAfter!.verifier.verify({ token: personToken, ...input })).toEqual({
      ok: false,
      reason: 'replayed',
    })
    expect(await readerAfter!.verifier.verify({ token: readerToken, ...input })).toEqual({
      ok: false,
      reason: 'replayed',
    })
  })

  describe('beside a proxy that publishes a JWKS URL', () => {
    let server: http.Server | null = null
    afterEach(async () => {
      if (server) await new Promise<void>((r) => server!.close(() => r()))
      server = null
    })
    const serve = async (keys: JWK[]): Promise<URL> => {
      server = http.createServer((_req, res) => {
        res.setHeader('Content-Type', 'application/json')
        res.end(JSON.stringify({ keys }))
      })
      await new Promise<void>((r) => server!.listen(0, '127.0.0.1', () => r()))
      return new URL(`http://127.0.0.1:${(server.address() as AddressInfo).port}/jwks`)
    }

    it("refuses a reader token while the URL's set holds the reader key, under any kid", async () => {
      const url = await serve([jwk(proxyKey.publicKey, 'p-1'), jwk(readerKey.publicKey, 'p-2')])
      const p = proxy({ source: 'jwks-url', url })
      const sources = identitySources(identityConfigs(p, null, reader('r-1')), p, {
        db: () => db,
      })
      const t = await token(
        readerKey.privateKey,
        READER_ISSUER,
        READER_AUDIENCE,
        'reader:companion',
        'r-1',
      )
      expect(
        await sources[1]!.verifier.verify({ token: t, method: 'GET', path: '/api/teams' }),
      ).toEqual({ ok: false, reason: 'shared-key' })
      // The proxy's own tokens still verify through the same fetched set.
      const person = await token(
        proxyKey.privateKey,
        'https://proxy.example.com',
        'clawboo',
        'user-42',
        'p-1',
      )
      expect(
        (await sources[0]!.verifier.verify({ token: person, method: 'GET', path: '/api/teams' }))
          .ok,
      ).toBe(true)
    })

    it('refuses a reader token while the set cannot be fetched', async () => {
      server = http.createServer((_req, res) => {
        res.statusCode = 500
        res.end('down')
      })
      await new Promise<void>((r) => server!.listen(0, '127.0.0.1', () => r()))
      const url = new URL(`http://127.0.0.1:${(server.address() as AddressInfo).port}/jwks`)
      const p = proxy({ source: 'jwks-url', url })
      const sources = identitySources(identityConfigs(p, null, reader()), p, { db: () => db })
      const t = await token(readerKey.privateKey, READER_ISSUER, READER_AUDIENCE, 'reader:x')
      expect(
        await sources[1]!.verifier.verify({ token: t, method: 'GET', path: '/api/teams' }),
      ).toEqual({ ok: false, reason: 'keys-unavailable' })
    })

    it('takes a reader token when the proxy keeps keys of its own', async () => {
      const url = await serve([jwk(proxyKey.publicKey, 'p-1')])
      const p = proxy({ source: 'jwks-url', url })
      const sources = identitySources(identityConfigs(p, null, reader('r-1')), p, {
        db: () => db,
      })
      const t = await token(
        readerKey.privateKey,
        READER_ISSUER,
        READER_AUDIENCE,
        'reader:companion',
        'r-1',
      )
      expect(
        (await sources[1]!.verifier.verify({ token: t, method: 'GET', path: '/api/teams' })).ok,
      ).toBe(true)
    })
  })
})
