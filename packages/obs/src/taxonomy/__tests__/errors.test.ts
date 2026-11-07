import { describe, expect, it } from 'vitest'

import {
  classifyError,
  isAccountError,
  isHarnessBug,
  isTransientError,
  isUnexpectedFor,
} from '../errors'

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

  it('reads "too many tokens" as an overflow only when it names the prompt or a refused request', () => {
    // With no status and no word for what it counts, it is as likely a rate limit,
    // which clears up by itself. A retry of a real overflow is refused for free.
    expect(classifyError(null, 'too many tokens')).toBe('RateLimited')
    expect(classifyError(null, 'Too many tokens, please wait before trying again.')).toBe(
      'RateLimited',
    )
    expect(
      classifyError(null, 'Tokens per minute limit exceeded - too many tokens processed.'),
    ).toBe('RateLimited')
    expect(classifyError(null, 'too many tokens (TPM)')).toBe('RateLimited')
    // Its own verdict, the thing it counted, or a refusal's status settle it.
    expect(classifyError('context_overflow', 'too many tokens')).toBe('ContextOverflow')
    expect(classifyError(null, 'too many tokens in the request')).toBe('ContextOverflow')
    expect(classifyError(null, 'Prompt has too many tokens')).toBe('ContextOverflow')
    expect(
      classifyError(
        null,
        'too many tokens: total number of tokens in the prompt cannot exceed 4081 - received 5000',
      ),
    ).toBe('ContextOverflow')
    expect(classifyError(null, 'HTTP 400: too many tokens')).toBe('ContextOverflow')
    // Naming what it counted settles it, wherever the name sits.
    expect(classifyError(null, 'Too many input tokens')).toBe('ContextOverflow')
    expect(classifyError(null, 'too many prompt tokens')).toBe('ContextOverflow')
    expect(classifyError(null, 'too many tokens for this model')).toBe('ContextOverflow')
    expect(classifyError(null, 'too many tokens per minute')).toBe('RateLimited')
    // A rate's own words decide first, whatever else it names.
    expect(classifyError(null, 'too many input tokens per minute')).toBe('RateLimited')
    expect(classifyError(null, 'Too many tokens in the request, please wait before retrying')).toBe(
      'RateLimited',
    )
    expect(classifyError(null, '429 too many tokens')).toBe('RateLimited')
    // Whichever way it goes, it never reads as a harness bug.
    expect(isHarnessBug(classifyError(null, 'too many tokens'))).toBe(false)
  })

  it('classifies context overflow as its own class (not a harness bug), before InvalidArgs', () => {
    // the typed code the native harness now emits + its clean message
    expect(
      classifyError('context_overflow', "The task was too large for the model's context window."),
    ).toBe('ContextOverflow')
    // a raw provider 400 whose message is a context-length overflow → ContextOverflow, not InvalidArgs
    expect(
      classifyError(
        null,
        "This model's maximum context length is 200000 tokens. However, your messages resulted in 250000 tokens.",
      ),
    ).toBe('ContextOverflow')
    expect(
      classifyError(null, 'Context overflow: prompt too large for the model. Try /reset (or /new)'),
    ).toBe('ContextOverflow')
    // a real, recoverable condition — NOT a harness bug, and NOT an anomaly for native
    // The typed verdict decides: a token count in the message is not a status.
    for (const count of ['201,402', '201,401', '201,403', '201,429']) {
      expect(classifyError('context_overflow', `Context length exceeded: ${count} tokens.`)).toBe(
        'ContextOverflow',
      )
    }
    expect(isHarnessBug('ContextOverflow')).toBe(false)
    expect(isUnexpectedFor('clawboo-native', 'ContextOverflow')).toBe(false)
  })

  it('classifies the typed causes Claude Code reports for an API error, never as a harness bug', () => {
    const cases: Array<[string, string, string]> = [
      ['authentication_failed', 'Invalid API key · Fix external API key (HTTP 401)', 'Auth'],
      ['oauth_org_not_allowed', 'Your organization does not allow this login', 'Auth'],
      ['cloud_credential_error', 'Could not load cloud credentials', 'Auth'],
      ['billing_error', 'Credit balance is too low (HTTP 400)', 'Billing'],
      ['account_on_hold', 'This account is on hold (HTTP 403)', 'Billing'],
      ['verification_required', 'Verify your account to continue', 'Billing'],
      ['rate_limit', 'Request rejected (HTTP 429)', 'RateLimited'],
      ['overloaded', 'Overloaded (HTTP 529)', 'ProviderError'],
      ['server_error', 'Something went wrong on our side', 'ProviderError'],
      ['invalid_request', 'Bad input (HTTP 400)', 'InvalidArgs'],
      ['model_not_found', 'There is no such model', 'InvalidArgs'],
    ]
    for (const [code, message, cls] of cases) {
      expect(classifyError(code, message), code).toBe(cls)
      expect(isUnexpectedFor('claude-code', classifyError(code, message)), code).toBe(false)
    }
  })

  it('classifies a refused sign-in as Auth, from the code or the message alone', () => {
    const cases: Array<[string | null, string]> = [
      [null, 'Invalid API key · Fix external API key (HTTP 401)'],
      [null, 'Not logged in · Please run /login'],
      [null, 'OAuth token has expired. Please obtain a new token or refresh your existing token.'],
      [
        null,
        'Your access token could not be refreshed because your refresh token has expired. Please log out and sign in again.',
      ],
      [null, 'unexpected status 401 Unauthorized'],
      [null, 'Error code: 403 - permission denied for this model'],
      ['unauthorized', 'request failed'],
      ['authentication_error', 'invalid x-api-key'],
      ['invalid_api_key', 'Incorrect API key provided: sk-...abcd.'],
      ['permission_error', 'Your API key does not have permission to use the specified resource.'],
    ]
    for (const [code, message] of cases) {
      const cls = classifyError(code, message)
      expect(cls, message).toBe('Auth')
      expect(isHarnessBug(cls)).toBe(false)
      expect(isAccountError(cls)).toBe(true)
      expect(isTransientError(cls)).toBe(false)
    }
  })

  it('classifies an account the provider will not serve as Billing, before a 429 reads as a rate limit', () => {
    const cases: Array<[string | null, string]> = [
      // OpenAI sends an empty balance as a 429 that names its quota.
      [
        'insufficient_quota',
        'You exceeded your current quota, please check your plan and billing details. (HTTP 429)',
      ],
      [
        null,
        "Error code: 429 - {'error': {'message': 'You exceeded your current quota.', 'type': 'insufficient_quota', 'code': 'insufficient_quota'}}",
      ],
      [null, 'Your credit balance is too low to access the Anthropic API.'],
      [null, 'Payment required (HTTP 402)'],
      [null, 'Insufficient credits. Add more using https://example.test/credits'],
    ]
    for (const [code, message] of cases) {
      const cls = classifyError(code, message)
      expect(cls, message).toBe('Billing')
      expect(isHarnessBug(cls)).toBe(false)
      expect(isAccountError(cls)).toBe(true)
      expect(isTransientError(cls)).toBe(false)
    }
  })

  it('keeps rate limits, usage windows, timeouts, 5xx and dropped connections transient', () => {
    const cases: Array<[string | null, string, string]> = [
      // Gemini's per-minute limit uses OpenAI's empty-balance wording, without its code.
      [
        null,
        '429 RESOURCE_EXHAUSTED: You exceeded your current quota, please check your plan and billing details. retryDelay 23s',
        'RateLimited',
      ],
      [null, 'HTTP 429 Too Many Requests', 'RateLimited'],
      [
        'rate_limit_error',
        'Number of request tokens has exceeded your per-minute rate limit',
        'RateLimited',
      ],
      ['usage_limit_exceeded', "You've hit your usage limit. Try again at 9:00 PM.", 'RateLimited'],
      [null, 'Quota exceeded for quota metric requests per minute', 'RateLimited'],
      ['ETIMEDOUT', 'request timed out', 'Timeout'],
      ['overloaded_error', 'Overloaded', 'ProviderError'],
      [null, 'provider error: 503 service unavailable', 'ProviderError'],
      [null, 'read ECONNRESET', 'ProviderError'],
      [null, 'TypeError: fetch failed', 'ProviderError'],
      ['stream_disconnected', 'stream disconnected before completion', 'ProviderError'],
      ['server_overloaded', 'The server is overloaded', 'ProviderError'],
    ]
    for (const [code, message, expected] of cases) {
      const cls = classifyError(code, message)
      expect(cls, message).toBe(expected)
      expect(isTransientError(cls), message).toBe(true)
      expect(isAccountError(cls), message).toBe(false)
    }
  })

  it('lets an exact typed code decide, before a number in the message can', () => {
    const cases: Array<[string, string, string]> = [
      [
        'rate_limit',
        'Rate limit: Limit 400, Used 397, Requested 403. Please try again.',
        'RateLimited',
      ],
      ['rate_limit', 'Requested 402 tokens over the limit', 'RateLimited'],
      ['rate_limit_error', 'Used 401 of your requests', 'RateLimited'],
      ['overloaded', 'Overloaded, request 403 dropped', 'ProviderError'],
      ['server_error', 'Upstream said 401', 'ProviderError'],
      [
        'network',
        'Client network socket disconnected before secure TLS connection was established',
        'ProviderError',
      ],
      ['network', 'The connection dropped', 'ProviderError'],
      ['auth', 'The key was refused', 'Auth'],
      ['authentication_failed', 'Rate limit on sign-in (HTTP 429)', 'Auth'],
      ['billing_error', 'Credit balance is too low (HTTP 400)', 'Billing'],
    ]
    for (const [code, message, cls] of cases)
      expect(classifyError(code, message), message).toBe(cls)
  })

  it('keeps the three readings of too many tokens apart, typed or not', () => {
    // A typed overflow decides, whatever the message says.
    expect(classifyError('context_overflow', 'Rate limit: too many requests per minute')).toBe(
      'ContextOverflow',
    )
    // So does a typed rate limit.
    expect(classifyError('rate_limit', 'too many input tokens')).toBe('RateLimited')
    expect(classifyError('rate_limit_error', 'context length exceeded')).toBe('RateLimited')
    // With no code, the words decide: what it counts means an overflow, and a rate per
    // minute means a limit, whatever else it counts.
    expect(classifyError(null, 'too many input tokens')).toBe('ContextOverflow')
    expect(classifyError(null, 'too many input tokens per minute')).toBe('RateLimited')
    expect(classifyError(null, 'too many tokens, 40000 tpm')).toBe('RateLimited')
    expect(isTransientError(classifyError(null, 'too many input tokens'))).toBe(false)
    expect(isTransientError(classifyError(null, 'too many input tokens per minute'))).toBe(true)
  })

  it('reads a throughput window as a limit, whatever the tokens it counts are called', () => {
    for (const message of [
      'too many request tokens for this hour',
      'too many tokens this hour',
      'too many input tokens per hour',
      'too many prompt tokens per day',
      'too many tokens today, 90000 tpd',
      'too many tokens, 40000 tph',
    ]) {
      expect(classifyError(null, message)).toBe('RateLimited')
      expect(isTransientError(classifyError(null, message))).toBe(true)
    }
    // With no window, what it counts still means an overflow.
    expect(classifyError(null, 'too many request tokens')).toBe('ContextOverflow')
    expect(classifyError(null, 'too many tokens for this model')).toBe('ContextOverflow')
  })

  it('reads a status 429 after a colon before any number in its message', () => {
    expect(classifyError(null, 'Status: 429: Requested 403 tokens')).toBe('RateLimited')
    expect(classifyError(null, 'HTTP: 429 Requested 403 tokens')).toBe('RateLimited')
    expect(classifyError(null, 'Status: 429: insufficient_quota')).toBe('Billing')
  })

  it('still reads an empty balance sent as a rate limit as Billing: waiting does not fix it', () => {
    for (const message of [
      "Rate limit: 429 {'error': {'type': 'insufficient_quota'}}",
      'Rate limit: Your credit balance is too low',
    ])
      expect(classifyError('rate_limit', message), message).toBe('Billing')
  })

  it('reads a message that opens with a 429 as a rate limit, whatever number follows', () => {
    expect(classifyError(null, '429 Too many tokens: Used 400, Requested 403.')).toBe('RateLimited')
    expect(classifyError(null, 'Error code: 429 - Requested 401 tokens')).toBe('RateLimited')
    expect(classifyError(null, "Error code: 429 - {'error': {'code': 'insufficient_quota'}}")).toBe(
      'Billing',
    )
  })

  it('does not read an ordinary failure as a refused sign-in', () => {
    // A local file permission error is the machine's, not the account's.
    expect(
      classifyError(null, "PermissionError: [Errno 13] Permission denied: '/home/a/.hermes/x'"),
    ).toBe('UnexpectedEnv')
    // A path that merely ends in /login says nothing about this run's sign-in.
    expect(classifyError(null, 'GET https://example.test/login returned 500')).toBe('ProviderError')
    expect(classifyError(null, 'Not logged in · Please run /login')).toBe('Auth')
  })

  it('reads a snake_case code word by word', () => {
    expect(classifyError('context_window_exceeded', 'turn failed')).toBe('ContextOverflow')
    expect(classifyError('cyber_policy', 'This request was refused')).toBe('InvalidArgs')
  })

  it('treats environment, argument, overflow and unknown failures as neither transient nor account', () => {
    for (const cls of [
      'UnexpectedEnv',
      'InvalidArgs',
      'ContextOverflow',
      'UserAborted',
      'Unknown',
    ] as const) {
      expect(isTransientError(cls), cls).toBe(false)
      expect(isAccountError(cls), cls).toBe(false)
    }
  })

  it('baselines Auth, Billing and ContextOverflow for every runtime', () => {
    for (const runtime of ['openclaw', 'claude-code', 'codex', 'hermes', 'clawboo-native']) {
      for (const cls of ['Auth', 'Billing', 'ContextOverflow'] as const) {
        expect(isUnexpectedFor(runtime, cls), `${runtime} ${cls}`).toBe(false)
      }
    }
  })

  it('isUnexpectedFor: Unknown is always unexpected; baselined classes are expected', () => {
    expect(isUnexpectedFor('claude-code', 'Unknown')).toBe(true)
    expect(isUnexpectedFor('claude-code', 'Timeout')).toBe(false)
    expect(isUnexpectedFor('some-future-runtime', 'ProviderError')).toBe(false)
  })
})
