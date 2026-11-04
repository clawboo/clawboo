// Which token the server locks itself with at boot, and when it refuses to start.
// The order: STUDIO_ACCESS_TOKEN when set (blank meaning "no gate"), otherwise the
// per-install token in <CLAWBOO_HOME>/access-token, created on first start.

import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { createAccessGate } from '@clawboo/gateway-proxy'

import { resolveBootAccessToken } from '../bootAccessToken'

let tmp: string
let home: string
let file: string

beforeEach(() => {
  tmp = mkdtempSync(path.join(os.tmpdir(), 'clawboo-boot-token-'))
  home = path.join(tmp, '.clawboo')
  file = path.join(home, 'access-token')
})
afterEach(() => {
  rmSync(tmp, { recursive: true, force: true })
})

describe('resolveBootAccessToken', () => {
  it('locks the server with a new per-install token when STUDIO_ACCESS_TOKEN is unset', () => {
    const boot = resolveBootAccessToken({ CLAWBOO_HOME: home })
    expect(boot.ok).toBe(true)
    if (!boot.ok) return
    expect(boot.source).toBe('file')
    expect(boot.token).toBe(readFileSync(file, 'utf8'))
    // The gate accepts it.
    expect(createAccessGate({ token: boot.token }).enabled).toBe(true)
  })

  it('reuses that token on the next start, so a browser stays signed in across a restart', () => {
    const first = resolveBootAccessToken({ CLAWBOO_HOME: home })
    const second = resolveBootAccessToken({ CLAWBOO_HOME: home })
    expect(first.ok && second.ok && second.token === first.token).toBe(true)
  })

  it('uses STUDIO_ACCESS_TOKEN when it is set, and writes no file', () => {
    const boot = resolveBootAccessToken({ CLAWBOO_HOME: home, STUDIO_ACCESS_TOKEN: 'env-token' })
    expect(boot).toEqual({ ok: true, source: 'env', token: 'env-token' })
    expect(() => readFileSync(file)).toThrow()
  })

  it('runs with no gate when STUDIO_ACCESS_TOKEN is set blank', () => {
    const boot = resolveBootAccessToken({ CLAWBOO_HOME: home, STUDIO_ACCESS_TOKEN: '' })
    expect(boot).toEqual({ ok: true, source: 'off', token: undefined })
    expect(createAccessGate({ token: boot.ok ? boot.token : 'x' }).enabled).toBe(false)
  })

  it('refuses a STUDIO_ACCESS_TOKEN the gate cannot use, as before', () => {
    const boot = resolveBootAccessToken({ CLAWBOO_HOME: home, STUDIO_ACCESS_TOKEN: 'q8Zr/Xk1Lw==' })
    expect(boot.ok).toBe(false)
    if (boot.ok) return
    expect(boot.message).toMatch(/^SECURITY: refusing to start\./)
    expect(boot.message).toContain('unsupported character')
  })

  it('refuses to start on a token file it cannot use, and says how to fix it', () => {
    mkdirSync(home, { recursive: true })
    writeFileSync(file, 'not a token')
    chmodSync(file, 0o600)
    const boot = resolveBootAccessToken({ CLAWBOO_HOME: home })
    expect(boot.ok).toBe(false)
    if (boot.ok) return
    expect(boot.message).toMatch(/^SECURITY: refusing to start\./)
    expect(boot.message).toContain(file)
    expect(boot.message).toContain('STUDIO_ACCESS_TOKEN')
    // Never overwritten: the desktop app may be using it.
    expect(readFileSync(file, 'utf8')).toBe('not a token')
  })
})
