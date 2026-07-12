import { describe, expect, it } from 'vitest'

import {
  isLoopbackHost,
  LOOPBACK_HOST,
  resolveHost,
  shouldRefuseInsecureBind,
} from '../resolveHost'

describe('resolveHost — default-loopback bind policy', () => {
  it('defaults to 127.0.0.1 when HOST is not set', () => {
    expect(resolveHost({})).toBe('127.0.0.1')
    expect(LOOPBACK_HOST).toBe('127.0.0.1')
  })

  it('honors an explicit HOST (operator opt-in to a wider bind), trimmed', () => {
    expect(resolveHost({ HOST: '0.0.0.0' })).toBe('0.0.0.0')
    expect(resolveHost({ HOST: '  10.0.0.5  ' })).toBe('10.0.0.5')
  })

  it('IGNORES HOSTNAME entirely (Docker/CI auto-inject it; widening must be explicit HOST)', () => {
    // A container's auto-set HOSTNAME must NOT silently widen the bind.
    expect(resolveHost({ HOSTNAME: '0.0.0.0' })).toBe('127.0.0.1')
    expect(resolveHost({ HOSTNAME: 'a1b2c3-container-id' })).toBe('127.0.0.1')
    // An explicit HOST still wins; a stray HOSTNAME alongside it is irrelevant.
    expect(resolveHost({ HOST: '0.0.0.0', HOSTNAME: 'ignored' })).toBe('0.0.0.0')
  })

  it('ignores a whitespace-only HOST and falls back to loopback', () => {
    expect(resolveHost({ HOST: '   ', HOSTNAME: '0.0.0.0' })).toBe('127.0.0.1')
  })
})

describe('shouldRefuseInsecureBind — fail-closed on a token-less wide bind', () => {
  it('does NOT refuse the default loopback bind (regardless of gate/opt-out)', () => {
    for (const hostname of ['127.0.0.1', '127.0.0.53', 'localhost', '::1', '[::1]']) {
      expect(shouldRefuseInsecureBind({ hostname, gateEnabled: false, allowInsecure: false })).toBe(
        false,
      )
    }
  })

  it('REFUSES a non-loopback bind with the gate disabled and no opt-out', () => {
    for (const hostname of ['0.0.0.0', '::', '10.0.0.5', '192.168.1.20', 'my-box.local']) {
      expect(shouldRefuseInsecureBind({ hostname, gateEnabled: false, allowInsecure: false })).toBe(
        true,
      )
    }
  })

  it('does NOT refuse a wide bind when a token is set (gate enabled)', () => {
    expect(
      shouldRefuseInsecureBind({ hostname: '0.0.0.0', gateEnabled: true, allowInsecure: false }),
    ).toBe(false)
  })

  it('does NOT refuse a wide bind when CLAWBOO_ALLOW_INSECURE opt-out is set', () => {
    expect(
      shouldRefuseInsecureBind({ hostname: '0.0.0.0', gateEnabled: false, allowInsecure: true }),
    ).toBe(false)
  })
})

describe('isLoopbackHost — drives the no-token exposure warning', () => {
  it('treats loopback addresses as local (no warning)', () => {
    for (const h of ['127.0.0.1', '127.0.0.53', '::1', '[::1]', 'localhost', 'LOCALHOST']) {
      expect(isLoopbackHost(h)).toBe(true)
    }
  })

  it('treats wildcard + LAN binds as network-exposed (warning fires)', () => {
    for (const h of ['0.0.0.0', '::', '10.0.0.5', '192.168.1.20', 'my-box.local']) {
      expect(isLoopbackHost(h)).toBe(false)
    }
  })
})
