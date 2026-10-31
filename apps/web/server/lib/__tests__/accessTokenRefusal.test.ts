import { describe, expect, it } from 'vitest'

import { createAccessGate } from '@clawboo/gateway-proxy'

import { accessTokenRefusal } from '../accessTokenRefusal'

describe('accessTokenRefusal', () => {
  it('refuses a token with an unsupported character, naming it and the allowed set', () => {
    const message = accessTokenRefusal('q8Zr/Xk1Lw==')
    expect(message).not.toBeNull()
    expect(message).toMatch(/^SECURITY: refusing to start\./)
    expect(message).toContain('unsupported character ("/")')
    expect(message).toContain('[A-Za-z0-9._~-]')
    expect(message).toContain('openssl rand -hex 24')
  })

  it('never echoes the token itself', () => {
    const token = 'pZ3kW9vQ+rT7'
    const message = accessTokenRefusal(token) ?? ''
    expect(message).toContain('("+")')
    expect(message).not.toContain(token)
  })

  it('says CLAWBOO_ALLOW_INSECURE does not skip it', () => {
    expect(accessTokenRefusal('has space')).toContain('CLAWBOO_ALLOW_INSECURE=1 does not skip')
  })

  it('lets a usable, blank or unset token through', () => {
    expect(accessTokenRefusal('A1b2._~-token')).toBeNull()
    expect(accessTokenRefusal('')).toBeNull()
    expect(accessTokenRefusal('   ')).toBeNull()
    expect(accessTokenRefusal(undefined)).toBeNull()
  })

  it('agrees with the gate: every token it lets through builds a gate', () => {
    for (const token of ['A1b2._~-token', '', undefined]) {
      expect(accessTokenRefusal(token)).toBeNull()
      expect(() => createAccessGate({ token })).not.toThrow()
    }
    for (const token of ['semi;colon', 'pct%encode', 'q8Zr/Xk1Lw==']) {
      expect(accessTokenRefusal(token)).not.toBeNull()
      expect(() => createAccessGate({ token })).toThrow()
    }
  })
})
