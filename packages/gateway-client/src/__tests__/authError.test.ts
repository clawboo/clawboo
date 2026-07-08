// isAuthConnectError / authRetryAfterMs — the classifier that keeps the server-side
// reconnect from hammering a failed connect (bad token / unpaired device / rate-limit
// lockout) into a Gateway "too many failed authentication attempts" lockout.

import { describe, expect, it } from 'vitest'

import { GatewayResponseError } from '../errors'
import { authRetryAfterMs, isAuthConnectError } from '../helpers'

describe('isAuthConnectError', () => {
  it('flags the rate-limit lockout message (the reported failure)', () => {
    const err = new GatewayResponseError({
      code: 'INVALID_REQUEST',
      message: 'unauthorized: too many failed authentication attempts (retry later)',
    })
    expect(isAuthConnectError(err)).toBe(true)
  })

  it('flags permanent auth codes regardless of message', () => {
    expect(isAuthConnectError(new GatewayResponseError({ code: 'NOT_PAIRED', message: 'x' }))).toBe(
      true,
    )
    expect(
      isAuthConnectError(new GatewayResponseError({ code: 'UNAUTHORIZED', message: 'x' })),
    ).toBe(true)
    expect(
      isAuthConnectError(
        new GatewayResponseError({ code: 'CONTROL_UI_ORIGIN_NOT_ALLOWED', message: 'x' }),
      ),
    ).toBe(true)
  })

  it('flags NOT_PAIRED surfaced only as a message (plain Error, no code)', () => {
    expect(
      isAuthConnectError(new Error('pairing required: device is not approved yet')),
    ).toBe(true)
  })

  it('does NOT flag a transient Gateway-down error (keeps the fast backoff)', () => {
    expect(isAuthConnectError(new Error('Gateway closed (1011): upstream error'))).toBe(false)
    expect(isAuthConnectError(new Error('no gateway'))).toBe(false)
    expect(
      isAuthConnectError(new GatewayResponseError({ code: 'INTERNAL', message: 'boom' })),
    ).toBe(false)
  })

  it('is safe on non-Error input', () => {
    expect(isAuthConnectError(null)).toBe(false)
    expect(isAuthConnectError('unauthorized')).toBe(false)
  })
})

describe('authRetryAfterMs', () => {
  it('returns the Gateway-supplied retryAfterMs when present', () => {
    expect(
      authRetryAfterMs(
        new GatewayResponseError({ code: 'INVALID_REQUEST', message: 'retry later', retryAfterMs: 30_000 }),
      ),
    ).toBe(30_000)
  })

  it('returns null when absent or on a plain Error', () => {
    expect(authRetryAfterMs(new GatewayResponseError({ code: 'X', message: 'y' }))).toBeNull()
    expect(authRetryAfterMs(new Error('nope'))).toBeNull()
  })
})
