// The identity lane's settings: off by default, set only by an administrator
// (the operator file or the environment), and refused at startup when it is on
// but could not be trusted. Above all: no shared secret, no private key.

import { generateKeyPairSync } from 'node:crypto'
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  OperatorSettingsError,
  initOperatorSettings,
  resetOperatorSettings,
} from '../../operatorSettings'
import {
  loadProxyIdentityConfig,
  parsePublicKeySetting,
  proxyIdentityFileWarning,
  proxyIdentityMode,
} from '../config'

const ed = generateKeyPairSync('ed25519')
const edPem = ed.publicKey.export({ format: 'pem', type: 'spki' }).toString()
const edJwk = ed.publicKey.export({ format: 'jwk' })

let home: string
beforeEach(() => {
  home = mkdtempSync(path.join(os.tmpdir(), 'clawboo-proxy-identity-'))
  vi.stubEnv('HOME', home)
  vi.stubEnv('CLAWBOO_HOME', home)
  resetOperatorSettings()
})
afterEach(() => {
  resetOperatorSettings()
  vi.unstubAllEnvs()
  rmSync(home, { recursive: true, force: true })
})

/** The lane on, with everything it needs, through the environment. */
function stubLane(over: Record<string, string> = {}): void {
  const vars: Record<string, string> = {
    CLAWBOO_PROXY_IDENTITY: 'required',
    CLAWBOO_PROXY_IDENTITY_PUBLIC_KEY: edPem,
    CLAWBOO_PROXY_IDENTITY_ISSUER: 'https://proxy.example.com',
    CLAWBOO_PROXY_IDENTITY_AUDIENCE: 'clawboo',
    ...over,
  }
  for (const [name, value] of Object.entries(vars)) vi.stubEnv(name, value)
}

function refusal(): string {
  try {
    initOperatorSettings()
    loadProxyIdentityConfig()
  } catch (err) {
    expect(err).toBeInstanceOf(OperatorSettingsError)
    return (err as Error).message
  }
  throw new Error('expected a refusal')
}

describe('off by default', () => {
  it('is off with nothing set, and a capability check sees it off', () => {
    initOperatorSettings()
    expect(loadProxyIdentityConfig()).toBeNull()
    expect(proxyIdentityMode()).toBe('off')
  })
})

describe('turned on', () => {
  it('through the environment, with its defaults', () => {
    stubLane()
    initOperatorSettings()
    expect(loadProxyIdentityConfig()).toMatchObject({
      mode: 'required',
      header: 'clawboo-identity',
      issuer: 'https://proxy.example.com',
      audience: 'clawboo',
      binding: 'request',
      maxLifetimeSeconds: 60,
      nameClaim: 'name',
      roleClaim: 'role',
      keys: { source: 'public-key', jwks: { keys: [{ kty: 'OKP', crv: 'Ed25519' }] } },
    })
  })

  it('through the operator file, for a Cloudflare Access style proxy', () => {
    writeFileSync(
      path.join(home, 'operator.json'),
      JSON.stringify({
        proxyIdentity: 'on',
        proxyIdentityHeader: 'Cf-Access-Jwt-Assertion',
        proxyIdentityJwksUrl: 'https://team.cloudflareaccess.com/cdn-cgi/access/certs',
        proxyIdentityIssuer: 'https://team.cloudflareaccess.com',
        proxyIdentityAudience: 'aud-tag',
        proxyIdentityBinding: 'session',
        proxyIdentityNameClaim: 'email',
      }),
    )
    initOperatorSettings()
    const config = loadProxyIdentityConfig()
    expect(config).toMatchObject({
      mode: 'on',
      header: 'cf-access-jwt-assertion',
      binding: 'session',
      nameClaim: 'email',
      keys: { source: 'jwks-url' },
    })
    expect(config?.keys.source === 'jwks-url' && config.keys.url.href).toBe(
      'https://team.cloudflareaccess.com/cdn-cgi/access/certs',
    )
  })

  it('takes a PEM written on one line with \\n, and a JWK or a JWKS', () => {
    stubLane({ CLAWBOO_PROXY_IDENTITY_PUBLIC_KEY: edPem.trim().replace(/\n/g, '\\n') })
    initOperatorSettings()
    expect(loadProxyIdentityConfig()?.keys.source).toBe('public-key')
    expect(parsePublicKeySetting(JSON.stringify(edJwk), 'k').keys).toHaveLength(1)
    expect(
      parsePublicKeySetting(JSON.stringify({ keys: [edJwk, { ...edJwk, kid: 'b' }] }), 'k').keys,
    ).toHaveLength(2)
  })

  it('allows plain http for a JWKS on this computer only', () => {
    stubLane({
      CLAWBOO_PROXY_IDENTITY_PUBLIC_KEY: '',
      CLAWBOO_PROXY_IDENTITY_JWKS_URL: 'http://127.0.0.1:4180/jwks',
    })
    initOperatorSettings()
    expect(loadProxyIdentityConfig()?.keys.source).toBe('jwks-url')
  })
})

describe('refusing to start', () => {
  it('on a lane with no key', () => {
    stubLane({ CLAWBOO_PROXY_IDENTITY_PUBLIC_KEY: '' })
    expect(refusal()).toMatch(/has no key/)
  })

  it('on a lane without both an issuer and an audience', () => {
    stubLane({ CLAWBOO_PROXY_IDENTITY_AUDIENCE: '' })
    expect(refusal()).toMatch(/proxyIdentityIssuer and proxyIdentityAudience/)
    resetOperatorSettings()
    stubLane({ CLAWBOO_PROXY_IDENTITY_ISSUER: '' })
    expect(refusal()).toMatch(/proxyIdentityIssuer and proxyIdentityAudience/)
  })

  it('on both a JWKS URL and a public key', () => {
    stubLane({ CLAWBOO_PROXY_IDENTITY_JWKS_URL: 'https://proxy.example.com/jwks' })
    expect(refusal()).toMatch(/Set only one/)
  })

  it('on a private key, in any form, without repeating it', () => {
    const pkcs8 = ed.privateKey.export({ format: 'pem', type: 'pkcs8' }).toString()
    const privateJwk = JSON.stringify(ed.privateKey.export({ format: 'jwk' }))
    for (const secret of [pkcs8, privateJwk]) {
      resetOperatorSettings()
      stubLane({ CLAWBOO_PROXY_IDENTITY_PUBLIC_KEY: secret })
      const message = refusal()
      expect(message).toMatch(/private/)
      expect(message).not.toContain(secret.slice(40, 70))
    }
  })

  it('on a shared HMAC secret given as a key', () => {
    const oct = JSON.stringify({
      kty: 'oct',
      k: Buffer.from('shared-secret').toString('base64url'),
    })
    stubLane({ CLAWBOO_PROXY_IDENTITY_PUBLIC_KEY: oct })
    expect(refusal()).toMatch(/private or shared key/)
  })

  it('on an RSA key shorter than 2048 bits, a certificate, or text that is no key', () => {
    const small = generateKeyPairSync('rsa', { modulusLength: 1024 }).publicKey
    const cases: Array<[string, RegExp]> = [
      [small.export({ format: 'pem', type: 'spki' }).toString(), /shorter than 2048/],
      ['-----BEGIN CERTIFICATE-----\nMIIB\n-----END CERTIFICATE-----', /must be a PEM public key/],
      ['not a key', /must be a PEM public key/],
      ['{"kty":"OKP","crv":"X25519","x":"AAAA"}', /Ed25519/],
    ]
    for (const [value, message] of cases) {
      resetOperatorSettings()
      stubLane({ CLAWBOO_PROXY_IDENTITY_PUBLIC_KEY: value })
      expect(refusal()).toMatch(message)
    }
  })

  it('on a JWKS URL over plain http to another host', () => {
    stubLane({
      CLAWBOO_PROXY_IDENTITY_PUBLIC_KEY: '',
      CLAWBOO_PROXY_IDENTITY_JWKS_URL: 'http://proxy.example.com/jwks',
    })
    expect(refusal()).toMatch(/must be an https URL/)
  })

  it('on a header Clawboo or a browser already uses', () => {
    for (const header of ['cookie', 'Host', 'x-forwarded-for', 'bad header']) {
      resetOperatorSettings()
      stubLane({ CLAWBOO_PROXY_IDENTITY_HEADER: header })
      expect(refusal()).toMatch(/proxyIdentityHeader/)
    }
  })

  it('on a mode, binding or lifetime it does not know', () => {
    const cases: Array<[Record<string, string>, RegExp]> = [
      [{ CLAWBOO_PROXY_IDENTITY: 'yes' }, /must be one of: off, on, required/],
      [{ CLAWBOO_PROXY_IDENTITY_BINDING: 'none' }, /must be one of: request, session/],
      [{ CLAWBOO_PROXY_IDENTITY_MAX_LIFETIME: '0' }, /from 1 to 300/],
      [{ CLAWBOO_PROXY_IDENTITY_MAX_LIFETIME: '301' }, /from 1 to 300/],
      [{ CLAWBOO_PROXY_IDENTITY_MAX_LIFETIME: '1.5' }, /whole number/],
    ]
    for (const [over, message] of cases) {
      resetOperatorSettings()
      vi.unstubAllEnvs()
      vi.stubEnv('HOME', home)
      vi.stubEnv('CLAWBOO_HOME', home)
      stubLane(over)
      expect(refusal()).toMatch(message)
    }
  })

  it('on a file value of the wrong type', () => {
    writeFileSync(
      path.join(home, 'operator.json'),
      JSON.stringify({ proxyIdentityMaxLifetime: '60' }),
    )
    expect(() => initOperatorSettings()).toThrow(/must be a number of seconds/)
  })
})

describe('the operator file warning', () => {
  it('warns when the lane is set in a file this user can change', () => {
    writeFileSync(
      path.join(home, 'operator.json'),
      JSON.stringify({
        proxyIdentity: 'required',
        proxyIdentityPublicKey: edPem,
        proxyIdentityIssuer: 'https://proxy.example.com',
        proxyIdentityAudience: 'clawboo',
      }),
    )
    initOperatorSettings()
    expect(loadProxyIdentityConfig()).not.toBeNull()
    expect(proxyIdentityFileWarning()).toMatch(/every agent it runs/)
  })

  it.skipIf(process.platform === 'win32' || process.getuid?.() === 0)(
    'says nothing when the file and its folder are read-only to this user',
    () => {
      const dir = mkdtempSync(path.join(os.tmpdir(), 'clawboo-operator-ro-'))
      const file = path.join(dir, 'operator.json')
      writeFileSync(file, JSON.stringify({ proxyIdentity: 'off' }))
      chmodSync(file, 0o444)
      chmodSync(dir, 0o555)
      try {
        vi.stubEnv('CLAWBOO_OPERATOR_SETTINGS', file)
        initOperatorSettings()
        expect(proxyIdentityFileWarning()).toBeNull()
      } finally {
        chmodSync(dir, 0o755)
        rmSync(dir, { recursive: true, force: true })
      }
    },
  )

  it('says nothing when the lane is set only in the environment', () => {
    stubLane()
    initOperatorSettings()
    expect(proxyIdentityFileWarning()).toBeNull()
  })
})
