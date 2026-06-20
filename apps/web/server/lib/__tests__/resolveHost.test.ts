import { describe, expect, it } from 'vitest'

import { isLoopbackHost, LOOPBACK_HOST, resolveHost } from '../resolveHost'

describe('resolveHost — default-loopback bind policy', () => {
  it('defaults to 127.0.0.1 when neither HOST nor HOSTNAME is set', () => {
    expect(resolveHost({})).toBe('127.0.0.1')
    expect(LOOPBACK_HOST).toBe('127.0.0.1')
  })

  it('honors an explicit HOST (operator opt-in to a wider bind), trimmed', () => {
    expect(resolveHost({ HOST: '0.0.0.0' })).toBe('0.0.0.0')
    expect(resolveHost({ HOST: '  10.0.0.5  ' })).toBe('10.0.0.5')
  })

  it('falls back to HOSTNAME when HOST is absent; HOST wins when both are set', () => {
    expect(resolveHost({ HOSTNAME: '0.0.0.0' })).toBe('0.0.0.0')
    expect(resolveHost({ HOST: '127.0.0.1', HOSTNAME: '0.0.0.0' })).toBe('127.0.0.1')
  })

  it('ignores whitespace-only HOST/HOSTNAME and falls back to loopback', () => {
    expect(resolveHost({ HOST: '   ', HOSTNAME: '' })).toBe('127.0.0.1')
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
