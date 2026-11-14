// Saved logins in the vault, the origin rule, one-time codes, and the masks: a
// value goes in once, sits only as ciphertext, and never comes back out of a
// metadata read.

import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { scrubSecrets } from '@clawboo/db'
import { REDACTION_MASK } from '@clawboo/logger'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { lendSecretValues } from '../../secretsVault'
import { maskFilledValues, noteFilledValues, resetFilledValuesForTests } from '../filledValues'
import { loginOriginOf, pageOriginOf } from '../origin'
import {
  addSavedLogin,
  listSavedLogins,
  loginSecretFor,
  removeSavedLogin,
  updateSavedLogin,
} from '../store'
import { totpCode } from '../totp'

const PASSWORD = 'vault-stored-password-0987654321'
const USERNAME = 'someone.special@example.com'
const OTP_SECRET = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ'

let home: string
const prev: Record<string, string | undefined> = {}

beforeEach(() => {
  for (const name of ['CLAWBOO_HOME', 'CLAWBOO_SECRETS_MASTER_KEY']) prev[name] = process.env[name]
  home = mkdtempSync(path.join(os.tmpdir(), 'clawboo-login-store-'))
  process.env['CLAWBOO_HOME'] = home
  delete process.env['CLAWBOO_SECRETS_MASTER_KEY']
})

afterEach(() => {
  resetFilledValuesForTests()
  lendSecretValues('test', null)
  for (const [name, value] of Object.entries(prev)) {
    if (value === undefined) delete process.env[name]
    else process.env[name] = value
  }
  rmSync(home, { recursive: true, force: true })
})

describe('loginOriginOf', () => {
  it('reads a bare host as https and keeps only the origin', () => {
    expect(loginOriginOf('Example.COM')).toEqual({ ok: true, origin: 'https://example.com' })
    expect(loginOriginOf('https://example.com:443/login?next=/x#y')).toEqual({
      ok: true,
      origin: 'https://example.com',
    })
    expect(loginOriginOf('https://example.com:8443/')).toEqual({
      ok: true,
      origin: 'https://example.com:8443',
    })
  })

  it('refuses plain http off loopback, other schemes, and credentials in the address', () => {
    expect(loginOriginOf('http://example.com')).toEqual({ ok: false, reason: 'insecure' })
    expect(loginOriginOf('http://localhost:3000')).toEqual({
      ok: true,
      origin: 'http://localhost:3000',
    })
    expect(loginOriginOf('http://127.0.0.1:8080/x').ok).toBe(true)
    expect(loginOriginOf('javascript:alert(1)').ok).toBe(false)
    expect(loginOriginOf('file:///etc/passwd').ok).toBe(false)
    expect(loginOriginOf('https://user:pw@example.com').ok).toBe(false)
    expect(loginOriginOf('').ok).toBe(false)
    expect(loginOriginOf('exa mple.com').ok).toBe(false)
  })

  it('reads a page address as the browser reports it, with no bare-host guess', () => {
    expect(pageOriginOf('https://bank.example/login')).toBe('https://bank.example')
    expect(pageOriginOf('about:blank')).toBeNull()
    expect(pageOriginOf('data:text/html,hi')).toBeNull()
    expect(pageOriginOf('bank.example')).toBeNull()
  })
})

describe('totpCode', () => {
  it('matches RFC 6238 (SHA-1, the last six digits)', () => {
    // RFC 6238 appendix B: secret "12345678901234567890", T = 59 s -> 94287082.
    expect(totpCode(OTP_SECRET, 59_000)).toBe('287082')
    expect(totpCode(OTP_SECRET, 1_111_111_109_000)).toBe('081804')
    expect(totpCode('not base32!')).toBeNull()
  })
})

describe('saved logins', () => {
  it('stores a login as ciphertext and lists only what is safe to show', () => {
    const r = addSavedLogin({
      site: 'https://bank.example/login',
      username: USERNAME,
      password: PASSWORD,
      oneTimeCodeSecret: 'gezd gnbv gy3t qojq gezd gnbv gy3t qojq',
      label: 'Bank',
      ownerId: 'local',
    })
    expect(r.ok).toBe(true)
    const list = listSavedLogins('local')
    expect(list).toHaveLength(1)
    expect(list[0]).toMatchObject({
      origin: 'https://bank.example',
      label: 'Bank',
      hasUsername: true,
      hasOneTimeCode: true,
    })
    const shown = JSON.stringify(list)
    for (const v of [USERNAME, PASSWORD, OTP_SECRET]) expect(shown).not.toContain(v)
    const onDisk = readFileSync(path.join(home, 'secrets', 'runtime-keys.json'), 'utf8')
    for (const v of [USERNAME, PASSWORD, OTP_SECRET, 'bank.example']) {
      expect(onDisk).not.toContain(v)
    }
    expect(loginSecretFor('https://bank.example', 'local')).toEqual({
      username: USERNAME,
      password: PASSWORD,
      otpSecret: OTP_SECRET,
    })
  })

  it("keeps each person's logins apart", () => {
    addSavedLogin({ site: 'bank.example', password: PASSWORD, ownerId: 'user-ada' })
    expect(listSavedLogins('local')).toEqual([])
    expect(loginSecretFor('https://bank.example', 'local')).toBeNull()
    const [ada] = listSavedLogins('user-ada')
    expect(removeSavedLogin(ada!.id, 'local')).toBe(false)
    expect(updateSavedLogin(ada!.id, 'local', { password: 'x'.repeat(20) })).toEqual({
      ok: false,
      error: 'not_found',
    })
    expect(loginSecretFor('https://bank.example', 'user-ada')?.password).toBe(PASSWORD)
  })

  it('refuses a second login for the same site and person, bad sites and bad codes', () => {
    expect(addSavedLogin({ site: 'bank.example', password: PASSWORD, ownerId: 'local' }).ok).toBe(
      true,
    )
    expect(
      addSavedLogin({ site: 'https://bank.example/', password: 'x', ownerId: 'local' }),
    ).toEqual({
      ok: false,
      error: 'exists',
    })
    expect(addSavedLogin({ site: 'http://bank.example', password: 'x', ownerId: 'local' })).toEqual(
      {
        ok: false,
        error: 'insecure_site',
      },
    )
    expect(addSavedLogin({ site: 'b.example', password: '', ownerId: 'local' })).toEqual({
      ok: false,
      error: 'missing_password',
    })
    expect(
      addSavedLogin({
        site: 'b.example',
        password: 'x',
        oneTimeCodeSecret: '123',
        ownerId: 'local',
      }),
    ).toEqual({ ok: false, error: 'invalid_one_time_code' })
  })

  it('an edit keeps what it leaves out, and can drop the one-time code', () => {
    const r = addSavedLogin({
      site: 'bank.example',
      username: USERNAME,
      password: PASSWORD,
      oneTimeCodeSecret: OTP_SECRET,
      ownerId: 'local',
    })
    if (!r.ok) throw new Error(r.error)
    const changed = updateSavedLogin(r.login.id, 'local', {
      label: 'Main account',
      password: '',
      oneTimeCodeSecret: null,
    })
    expect(changed).toMatchObject({
      ok: true,
      login: { label: 'Main account', hasOneTimeCode: false },
    })
    expect(loginSecretFor('https://bank.example', 'local')).toEqual({
      username: USERNAME,
      password: PASSWORD,
      otpSecret: null,
    })
    expect(removeSavedLogin(r.login.id, 'local')).toBe(true)
    expect(listSavedLogins('local')).toEqual([])
  })

  it('lends a saved password to the storage scrub', () => {
    addSavedLogin({ site: 'bank.example', password: PASSWORD, ownerId: 'local' })
    expect(JSON.stringify(scrubSecrets({ note: `the page said ${PASSWORD}` }))).not.toContain(
      PASSWORD,
    )
  })
})

describe('values a fill put into a page', () => {
  it('are masked in that agent browser results, quoted or not, and only that agent', () => {
    const value = 'filled-into-the-page-"quoted"\\x'
    noteFilledValues('coder', [value])
    expect(maskFilledValues('coder', `field=${value}`)).toBe(`field=${REDACTION_MASK}`)
    expect(maskFilledValues('coder', JSON.stringify({ v: value }))).not.toContain('filled-into')
    expect(maskFilledValues('other', `field=${value}`)).toContain(value)
  })

  it('are lent to the storage scrub, and a value lent by name can be taken back', () => {
    const value = 'a-borrowed-secret-value-123456'
    lendSecretValues('test', new Set([value]))
    expect(JSON.stringify(scrubSecrets({ x: value }))).not.toContain(value)
    lendSecretValues('test', null)
    expect(JSON.stringify(scrubSecrets({ x: value }))).toContain(value)
    noteFilledValues('coder', ['another-filled-value-123456'])
    expect(JSON.stringify(scrubSecrets({ x: 'another-filled-value-123456' }))).not.toContain(
      'another-filled-value',
    )
  })
})
