// What "authorized" means, and why it has to mean the same thing in two places.
//
// The panel reads it from `/config` and decides whether to show Connect; the
// connect route decides it by actually resolving a token. When the two disagree
// the operator gets a button that always fails, with no sign-in offered and no
// way back.

import { mkdtempSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { clearOAuth, isAuthorized, saveStoredTokens } from '../oauthStore'

describe('oauth store', () => {
  let home: string
  let prevHome: string | undefined
  let prevClawbooHome: string | undefined

  beforeEach(() => {
    home = mkdtempSync(path.join(os.tmpdir(), 'clawboo-oauth-'))
    prevHome = process.env['HOME']
    prevClawbooHome = process.env['CLAWBOO_HOME']
    process.env['HOME'] = home
    process.env['CLAWBOO_HOME'] = home
  })
  afterEach(() => {
    if (prevHome === undefined) delete process.env['HOME']
    else process.env['HOME'] = prevHome
    if (prevClawbooHome === undefined) delete process.env['CLAWBOO_HOME']
    else process.env['CLAWBOO_HOME'] = prevClawbooHome
    rmSync(home, { recursive: true, force: true })
  })

  it('is false before anything has been stored', () => {
    expect(isAuthorized('linear')).toBe(false)
  })

  it('treats a token with NO stated expiry as usable', () => {
    // The provider did not say. A 401 is then the only signal, which the connect
    // path handles; refusing up front would block a working connector.
    saveStoredTokens('linear', { access_token: 'at' })
    expect(isAuthorized('linear')).toBe(true)
  })

  it('treats an EXPIRED token with no refresh token as unusable', () => {
    // The disagreement this closes: the panel reported authorized and offered
    // Connect, and the server refused because it could not resolve a token.
    saveStoredTokens('linear', { access_token: 'at', expires_at: Date.now() - 1_000 })
    expect(isAuthorized('linear')).toBe(false)
  })

  it('treats an expired token WITH a refresh token as usable', () => {
    saveStoredTokens('linear', {
      access_token: 'at',
      refresh_token: 'rt',
      expires_at: Date.now() - 1_000,
    })
    expect(isAuthorized('linear')).toBe(true)
  })

  it('forgets everything on sign-out', () => {
    saveStoredTokens('linear', { access_token: 'at' })
    clearOAuth('linear')
    expect(isAuthorized('linear')).toBe(false)
  })

  it('is namespaced per connector', () => {
    saveStoredTokens('linear', { access_token: 'at' })
    expect(isAuthorized('sentry')).toBe(false)
    clearOAuth('linear')
  })

  it('never returns a token from the authorization check', () => {
    saveStoredTokens('linear', { access_token: 'super-secret' })
    expect(JSON.stringify(isAuthorized('linear'))).not.toContain('super-secret')
  })
})
