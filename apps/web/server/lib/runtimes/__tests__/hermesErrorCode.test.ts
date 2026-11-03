// Hermes prints a provider's refusal as text, with the provider's own error body
// inside it (a Python dict or JSON). The typed cause in that body becomes the
// run's error code, which the runtime error taxonomy reads.

import { classifyError } from '@clawboo/obs'
import { describe, expect, it } from 'vitest'

import { hermesErrorCode } from '../hermesDriver'

describe('hermesErrorCode', () => {
  it('takes the code an OpenAI-style body names over its broader type', () => {
    const text =
      "Error code: 401 - {'error': {'message': 'Incorrect API key provided: sk-abc.', 'type': 'invalid_request_error', 'param': None, 'code': 'invalid_api_key'}}"
    expect(hermesErrorCode(text)).toBe('invalid_api_key')
    expect(classifyError(hermesErrorCode(text), text)).toBe('Auth')
  })

  it('reads an empty balance sent as a 429 as billing, not a rate limit', () => {
    const text =
      "Error code: 429 - {'error': {'message': 'You exceeded your current quota.', 'type': 'insufficient_quota', 'param': None, 'code': 'insufficient_quota'}}"
    expect(hermesErrorCode(text)).toBe('insufficient_quota')
    expect(classifyError(hermesErrorCode(text), text)).toBe('Billing')
  })

  it("takes the inner type of an Anthropic-style body, skipping the envelope's", () => {
    const text =
      "Error code: 401 - {'type': 'error', 'error': {'type': 'authentication_error', 'message': 'invalid x-api-key'}}"
    expect(hermesErrorCode(text)).toBe('authentication_error')
    const overloaded = '{"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}'
    expect(hermesErrorCode(overloaded)).toBe('overloaded_error')
    expect(classifyError(hermesErrorCode(overloaded), overloaded)).toBe('ProviderError')
  })

  it('reads only the error body, not other JSON on the same output', () => {
    const text = 'tool call {"type": "function", "name": "read_file"}\nTraceback: boom'
    expect(hermesErrorCode(text)).toBeNull()
  })

  it('is null when the error body names no string cause', () => {
    expect(
      hermesErrorCode("Error code: 401 - {'error': {'message': 'No auth', 'code': 401}}"),
    ).toBeNull()
    expect(hermesErrorCode('hermes exited with code 1')).toBeNull()
    expect(hermesErrorCode('')).toBeNull()
  })
})
