import { describe, expect, it } from 'vitest'

import { classifyError, isHarnessBug, isUnexpectedFor } from '../errors'

describe('error taxonomy', () => {
  it('classifies the expected baseline classes from code or message', () => {
    expect(classifyError('ETIMEDOUT', 'request timed out')).toBe('Timeout')
    expect(classifyError(null, 'HTTP 429 Too Many Requests')).toBe('RateLimited')
    expect(classifyError(null, 'user aborted the run')).toBe('UserAborted')
    expect(classifyError('ENOENT', 'spawn openclaw ENOENT')).toBe('UnexpectedEnv')
    expect(classifyError('400', 'invalid argument: missing required field')).toBe('InvalidArgs')
    expect(classifyError(null, 'provider error: 503 service unavailable')).toBe('ProviderError')
  })

  it('returns Unknown for an unrecognized failure — and flags it as a harness bug', () => {
    const cls = classifyError('WAT_IS_THIS', 'the flux capacitor desynchronized')
    expect(cls).toBe('Unknown')
    expect(isHarnessBug(cls)).toBe(true)
  })

  it('Unknown on an empty signal', () => {
    expect(classifyError(null, null)).toBe('Unknown')
    expect(classifyError('', '')).toBe('Unknown')
  })

  it('expected classes are not harness bugs', () => {
    expect(isHarnessBug('Timeout')).toBe(false)
    expect(isHarnessBug('ProviderError')).toBe(false)
  })

  it('isUnexpectedFor: Unknown is always unexpected; baselined classes are expected', () => {
    expect(isUnexpectedFor('claude-code', 'Unknown')).toBe(true)
    expect(isUnexpectedFor('claude-code', 'Timeout')).toBe(false)
    expect(isUnexpectedFor('some-future-runtime', 'ProviderError')).toBe(false)
  })
})
