// Hermes prints a provider's refusal as text, with the provider's own error body
// inside it (a Python dict or JSON). The typed cause in that body becomes the
// run's error code, which the runtime error taxonomy reads.

import { isPolicyDenialCode } from '@clawboo/governance'
import { classifyError, isAccountError } from '@clawboo/obs'
import { describe, expect, it } from 'vitest'

import { runFailureText } from '../../runFailureText'
import { hermesErrorCode, withoutRecoveredOverflow } from '../hermes/failure'

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

describe('hermesErrorCode: a run that ended on the context window', () => {
  it('reads what Hermes prints when it gives up, on either transport (0.19.0)', () => {
    for (const text of [
      // The quiet path's stdout, seen live.
      '⚠ tirith security scanner enabled but not available\nContext length exceeded (15 tokens). Cannot compress further.',
      // ACP's stderr, seen live.
      '❌ Context length exceeded and cannot compress further.\n2026-11-05 01:17:58 [ERROR] agent.conversation_loop: Context length exceeded: 15 tokens. Cannot compress further.',
      // Out of compression attempts, on stdout and on stderr.
      'Context length exceeded: max compression attempts (3) reached.',
      '❌ Max compression attempts (3) reached.\n[ERROR] agent.conversation_loop: Context compression failed after 3 attempts.',
    ]) {
      expect(hermesErrorCode(text)).toBe('context_overflow')
    }
  })

  it('reads a provider body that says so, whichever way it says it', () => {
    for (const text of [
      // OpenAI: the specific code.
      "[ERROR] x: Non-retryable client error: Error code: 400 - {'error': {'message': \"This model's maximum context length is 8192 tokens.\", 'type': 'invalid_request_error', 'param': 'messages', 'code': 'context_length_exceeded'}}",
      // Anthropic: only the catch-all type, the cause in the message.
      "Error code: 400 - {'type': 'error', 'error': {'type': 'invalid_request_error', 'message': 'prompt is too long: 214290 tokens > 200000 maximum'}}",
      // OpenRouter: a number for a code, the cause in the message.
      "Error code: 400 - {'error': {'message': \"This endpoint's maximum context length is 128000 tokens.\", 'code': 400}}",
      // JSON instead of a Python dict.
      '{"error":{"message":"input is too long for requested model","code":400}}',
    ]) {
      expect(hermesErrorCode(text)).toBe('context_overflow')
      expect(classifyError(hermesErrorCode(text), text)).toBe('ContextOverflow')
    }
  })

  it("files Hermes's overflow as one, whatever its token count looks like", () => {
    const text = 'Context length exceeded (201,402 tokens). Cannot compress further.'
    expect(hermesErrorCode(text)).toBe('context_overflow')
    expect(classifyError(hermesErrorCode(text), text)).toBe('ContextOverflow')
  })

  it('is not a code the task runner reads as a policy denial', () => {
    expect(
      isPolicyDenialCode(
        hermesErrorCode('Context length exceeded: max compression attempts (3) reached.'),
      ),
    ).toBe(false)
  })

  it('leaves a rate limit in the same words as a rate limit', () => {
    const typed =
      "Error code: 429 - {'error': {'message': 'too many tokens', 'type': 'tokens', 'code': 'rate_limit_exceeded'}}"
    expect(hermesErrorCode(typed)).toBe('rate_limit_exceeded')
    expect(classifyError(hermesErrorCode(typed), typed)).toBe('RateLimited')
    // A status only.
    const status = "Error code: 429 - {'error': {'message': 'too many tokens', 'code': 429}}"
    expect(hermesErrorCode(status)).toBeNull()
    expect(classifyError(hermesErrorCode(status), status)).toBe('RateLimited')
    // The wording alone.
    expect(
      hermesErrorCode(
        "{'error': {'message': 'Tokens per minute limit exceeded - too many tokens processed.'}}",
      ),
    ).toBeNull()
  })

  it('leaves sign-in and billing as they were', () => {
    const key =
      "Error code: 401 - {'error': {'message': 'Incorrect API key provided: context length', 'type': 'invalid_request_error', 'code': 'invalid_api_key'}}"
    expect(hermesErrorCode(key)).toBe('invalid_api_key')
    expect(isAccountError(classifyError(hermesErrorCode(key), key))).toBe(true)
    const quota =
      "Error code: 429 - {'error': {'message': 'You exceeded your current quota.', 'type': 'insufficient_quota', 'code': 'insufficient_quota'}}"
    expect(hermesErrorCode(quota)).toBe('insufficient_quota')
    expect(classifyError(hermesErrorCode(quota), quota)).toBe('Billing')
  })

  it('is not widened to a request body too big to send', () => {
    for (const text of [
      '❌ Max compression attempts (3) reached for payload-too-large error.\n[ERROR] x: 413 compression failed after 3 attempts.',
      'Request payload too large: max compression attempts (3) reached.',
      '❌ Payload too large and cannot compress further.\n[ERROR] x: 413 payload too large. Cannot compress further.',
      'Request payload too large (413). Cannot compress further.',
    ]) {
      expect(hermesErrorCode(text)).toBeNull()
    }
  })

  it('does not read an overflow Hermes went on to recover from', () => {
    const recovered =
      "[INFO] x: Streaming failed before delivery: Error code: 400 - {'error': {'message': \"This model's maximum context length is 8192 tokens.\", 'type': 'invalid_request_error', 'code': 'context_length_exceeded'}}"
    // Its status line while it compresses says nothing about how the run ended.
    expect(
      hermesErrorCode(
        '⚠️  Context length exceeded \u2014 using provider limit: 200,000 → 8,192 tokens',
      ),
    ).toBeNull()

    // Then the run failed some other way: a refused key with no string cause...
    const refused = `${recovered}\n[ERROR] x: Non-retryable client error: Error code: 401 - {'error': {'message': 'User not found.', 'code': 401}}`
    expect(hermesErrorCode(refused)).toBeNull()
    expect(classifyError(hermesErrorCode(refused), withoutRecoveredOverflow(refused))).toBe('Auth')
    expect(runFailureText(withoutRecoveredOverflow(refused), 'hermes')).toMatch(
      /^The run failed: .*User not found/,
    )

    // ...one that names its cause...
    const named = `${recovered}\nError code: 401 - {'error': {'message': 'Bad key', 'code': 'invalid_api_key'}}`
    expect(hermesErrorCode(named)).toBe('invalid_api_key')

    // ...or a dropped connection, which passes by itself and is worth another try.
    const dropped = `${recovered}\n❌ API call failed after 3 retries: Connection error.`
    expect(hermesErrorCode(dropped)).toBeNull()
    expect(classifyError(hermesErrorCode(dropped), withoutRecoveredOverflow(dropped))).toBe(
      'ProviderError',
    )
    expect(runFailureText(withoutRecoveredOverflow(dropped), 'hermes')).toBe(
      'The run failed: ❌ API call failed after 3 retries: Connection error.',
    )
  })

  it('a sub-agent giving up is not the parent giving up', () => {
    const parentRefused =
      "[ERROR] x: Non-retryable client error: Error code: 401 - {'error': {'message': 'Bad key', 'code': 'invalid_api_key'}}\n❌ Non-retryable client error (HTTP 401). Aborting."
    // Both spacings: 0.15.2's agent_init adds a space after the prefix, the log form may not.
    for (const child of [
      '[subagent-0]❌ Context length exceeded and cannot compress further.',
      '[subagent-1] ❌ Context length exceeded and cannot compress further.',
      '[ERROR] agent.conversation_loop: [subagent-0] Context length exceeded: 15 tokens. Cannot compress further.',
      '[subagent-2] ❌ Max compression attempts (3) reached.',
    ]) {
      // Alone, it says nothing about how the parent ended.
      expect(hermesErrorCode(child)).toBeNull()
      const text = `${child}\n${parentRefused}`
      expect(hermesErrorCode(text)).toBe('invalid_api_key')
      const reason = withoutRecoveredOverflow(text)
      expect(reason).not.toMatch(/context length|compression/i)
      expect(classifyError(hermesErrorCode(text), reason)).toBe('Auth')
      expect(runFailureText(reason, 'hermes')).toMatch(/^The run failed: .*Bad key/)
    }
    // A sub-agent's own 401 is not the parent's sign-in either.
    expect(
      hermesErrorCode(
        "[ERROR] x: [subagent-0] Non-retryable client error: Error code: 401 - {'error': {'message': 'Bad key', 'code': 'invalid_api_key'}}\nhermes exited with code 1",
      ),
    ).toBeNull()
  })

  it("the parent's give-up still counts with a sub-agent's lines around it", () => {
    expect(
      hermesErrorCode(
        '[subagent-0] ❌ Non-retryable client error (HTTP 500). Aborting.\n❌ Context length exceeded and cannot compress further.',
      ),
    ).toBe('context_overflow')
  })

  it('only the final give-up counts: a later failure of its own decides', () => {
    expect(
      hermesErrorCode(
        "❌ Context length exceeded and cannot compress further.\n[ERROR] x: Error code: 401 - {'error': {'message': 'Bad key', 'code': 'invalid_api_key'}}",
      ),
    ).toBe('invalid_api_key')
  })

  it('a log line below error level is never the verdict', () => {
    const body =
      "Error code: 400 - {'error': {'message': \"This model's maximum context length is 8192 tokens.\", 'code': 'context_length_exceeded'}}"
    expect(
      hermesErrorCode(`2026-11-05 [INFO] x: Streaming failed before delivery: ${body}`),
    ).toBeNull()
    expect(hermesErrorCode(`2026-11-05 [WARNING] x: refused: ${body}`)).toBeNull()
    expect(hermesErrorCode(`2026-11-05 [ERROR] x: Non-retryable client error: ${body}`)).toBe(
      'context_overflow',
    )
  })

  it('reads the last body when a run was refused more than once', () => {
    const limited =
      "Error code: 429 - {'error': {'message': 'slow down', 'code': 'rate_limit_exceeded'}}"
    const key = "Error code: 401 - {'error': {'message': 'Bad key', 'code': 'invalid_api_key'}}"
    expect(hermesErrorCode(`${limited}\n${key}`)).toBe('invalid_api_key')
    expect(hermesErrorCode(`${key}\n${limited}`)).toBe('rate_limit_exceeded')
  })

  it('keeps a nested provider body whole', () => {
    const nested =
      "Error code: 402 - {'error': {'message': 'Provider returned error', 'code': 402, 'metadata': {'raw': '{\"error\":{\"message\":\"no funds\",\"code\":\"insufficient_quota\"}}'}}}"
    expect(hermesErrorCode(nested)).toBe('insufficient_quota')
  })

  it('does not read other text about a context window as a failure of it', () => {
    expect(hermesErrorCode('This tool read the context length setting from a file.')).toBeNull()
    expect(hermesErrorCode('hermes exited with code 1')).toBeNull()
  })
})
