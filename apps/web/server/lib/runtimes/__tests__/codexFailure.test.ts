// The error code a failed Codex turn carries, read off the app-server's typed
// `codexErrorInfo`. The code feeds the runtime error taxonomy, which decides
// whether a failure is the account's (sign-in, billing), passing, or a bug.

import { isPolicyDenialCode } from '@clawboo/governance'
import { classifyError } from '@clawboo/obs'
import { describe, expect, it } from 'vitest'

import { codexErrorCode } from '../codexFailure'

describe('codexErrorCode', () => {
  it('names each plain cause', () => {
    expect(codexErrorCode('unauthorized')).toBe('authentication_failed')
    expect(codexErrorCode('usageLimitExceeded')).toBe('usage_limit_exceeded')
    expect(codexErrorCode('contextWindowExceeded')).toBe('context_overflow')
    expect(codexErrorCode('serverOverloaded')).toBe('overloaded')
    expect(codexErrorCode('internalServerError')).toBe('server_error')
    expect(codexErrorCode('badRequest')).toBe('invalid_request')
    expect(codexErrorCode('sandboxError')).toBe('sandbox_error')
    expect(codexErrorCode('cyberPolicy')).toBe('cyber_policy')
  })

  it('reads a connection failure by its HTTP status when the backend sent one', () => {
    expect(codexErrorCode({ httpConnectionFailed: { httpStatusCode: 401 } })).toBe(
      'authentication_failed',
    )
    expect(codexErrorCode({ responseStreamConnectionFailed: { httpStatusCode: 403 } })).toBe(
      'authentication_failed',
    )
    expect(codexErrorCode({ httpConnectionFailed: { httpStatusCode: 402 } })).toBe('billing_error')
    expect(codexErrorCode({ responseTooManyFailedAttempts: { httpStatusCode: 429 } })).toBe(
      'rate_limit',
    )
    expect(codexErrorCode({ httpConnectionFailed: { httpStatusCode: 502 } })).toBe(
      'connection_failed',
    )
    expect(codexErrorCode({ httpConnectionFailed: { httpStatusCode: null } })).toBe(
      'connection_failed',
    )
    expect(codexErrorCode({ responseStreamDisconnected: { httpStatusCode: null } })).toBe(
      'stream_disconnected',
    )
    expect(codexErrorCode({ responseTooManyFailedAttempts: { httpStatusCode: null } })).toBe(
      'too_many_failed_attempts',
    )
  })

  it('never names a code the task runner reads as a policy denial', () => {
    const infos: unknown[] = [
      'unauthorized',
      'badRequest',
      'sandboxError',
      { httpConnectionFailed: { httpStatusCode: 401 } },
      { httpConnectionFailed: { httpStatusCode: 403 } },
    ]
    for (const info of infos) expect(isPolicyDenialCode(codexErrorCode(info))).toBe(false)
  })

  it('names nothing for a cause that says nothing, or for no cause', () => {
    expect(codexErrorCode('other')).toBeNull()
    expect(codexErrorCode({ activeTurnNotSteerable: { turnKind: 'review' } })).toBeNull()
    expect(codexErrorCode(null)).toBeNull()
    expect(codexErrorCode(undefined)).toBeNull()
    expect(codexErrorCode(42)).toBeNull()
  })

  it('every code it names lands in the class it means', () => {
    const cases: Array<[unknown, string]> = [
      ['unauthorized', 'Auth'],
      [{ httpConnectionFailed: { httpStatusCode: 402 } }, 'Billing'],
      ['usageLimitExceeded', 'RateLimited'],
      [{ responseTooManyFailedAttempts: { httpStatusCode: 429 } }, 'RateLimited'],
      ['contextWindowExceeded', 'ContextOverflow'],
      ['serverOverloaded', 'ProviderError'],
      ['internalServerError', 'ProviderError'],
      [{ httpConnectionFailed: { httpStatusCode: null } }, 'ProviderError'],
      [{ responseStreamDisconnected: { httpStatusCode: null } }, 'ProviderError'],
      [{ responseTooManyFailedAttempts: { httpStatusCode: null } }, 'ProviderError'],
      ['badRequest', 'InvalidArgs'],
      ['cyberPolicy', 'InvalidArgs'],
      ['sandboxError', 'UnexpectedEnv'],
    ]
    for (const [info, cls] of cases) {
      // The message is deliberately uninformative: the code alone must decide.
      expect(classifyError(codexErrorCode(info), 'turn failed'), JSON.stringify(info)).toBe(cls)
    }
  })
})
