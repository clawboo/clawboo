import { describe, expect, it } from 'vitest'
import { resolveGatewayAutoRetryDelayMs } from '../helpers'
import type { AutoRetryDelayParams } from '../types'

const params = (overrides: Partial<AutoRetryDelayParams> = {}): AutoRetryDelayParams => ({
  status: 'disconnected',
  didAutoConnect: true,
  wasManualDisconnect: false,
  gatewayUrl: 'ws://localhost:18789',
  errorMessage: null,
  connectErrorCode: null,
  attempt: 0,
  ...overrides,
})

describe('resolveGatewayAutoRetryDelayMs', () => {
  it('schedules a backoff delay for a plain disconnect', () => {
    expect(resolveGatewayAutoRetryDelayMs(params())).toBe(2_000)
  })

  it('backs off exponentially and caps the delay', () => {
    expect(resolveGatewayAutoRetryDelayMs(params({ attempt: 1 }))).toBe(3_000)
    expect(resolveGatewayAutoRetryDelayMs(params({ attempt: 12 }))).toBe(30_000)
  })

  it('stops retrying on each fatal proxy configuration code', () => {
    for (const code of [
      'clawboo.gateway_url_missing',
      'clawboo.gateway_url_invalid',
      'clawboo.settings_load_failed',
    ]) {
      expect(resolveGatewayAutoRetryDelayMs(params({ connectErrorCode: code }))).toBeNull()
    }
  })

  it('matches fatal codes case-insensitively and ignores padding', () => {
    expect(
      resolveGatewayAutoRetryDelayMs(params({ connectErrorCode: ' CLAWBOO.GATEWAY_URL_MISSING ' })),
    ).toBeNull()
  })

  it('keeps retrying on an unrecognized error code', () => {
    expect(
      resolveGatewayAutoRetryDelayMs(params({ connectErrorCode: 'gateway.unavailable' })),
    ).toBe(2_000)
  })

  it('gives up after the attempt cap', () => {
    expect(resolveGatewayAutoRetryDelayMs(params({ attempt: 20 }))).toBeNull()
  })

  it('never retries a manual disconnect', () => {
    expect(resolveGatewayAutoRetryDelayMs(params({ wasManualDisconnect: true }))).toBeNull()
  })
})
