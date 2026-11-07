// Runtime error taxonomy (the Cursor model): every runtime/tool failure is
// classified into a baseline of EXPECTED classes; anything that doesn't match is
// `Unknown`, and an `Unknown` is treated as a HARNESS BUG — it is surfaced as an
// alert (a flagged `error` event + an error-level structured log) rather than
// silently swallowed. Expected classes get baselined per-runtime so anomalies in
// their RATE can be alerted on later; an Unknown alerts immediately.

export const RUNTIME_ERROR_CLASSES = [
  'InvalidArgs',
  'ContextOverflow',
  'Timeout',
  'ProviderError',
  'RateLimited',
  'UserAborted',
  'Auth',
  'Billing',
  'UnexpectedEnv',
  'Unknown',
] as const

export type RuntimeErrorClass = (typeof RUNTIME_ERROR_CLASSES)[number]

interface Rule {
  cls: RuntimeErrorClass
  test: RegExp
}

// Order matters: the first matching rule wins. The account classes go first: a
// provider can send an empty balance as a 429 that names its quota (OpenAI's
// `insufficient_quota`), and a revoked key as a 400. Billing goes before Auth
// because a held account comes back as a 403. More specific signals (rate limit,
// abort) are then checked before the broader provider/env buckets.
const RULES: Rule[] = [
  // The provider will not serve the account until someone pays or verifies it.
  // Waiting does not fix it, so it is never transient. An empty OpenAI balance is
  // read from its `insufficient_quota` code, never from the "exceeded your current
  // quota" wording, which Gemini also sends for an ordinary per-minute limit.
  {
    cls: 'Billing',
    test: /\b(billing[\s_-]?error|account[\s_-]?on[\s_-]?hold|verification[\s_-]?required|credit balance|insufficient[\s_-]?(?:quota|credits?|funds|balance)|payment[\s_-]?required|402)\b/i,
  },
  // The runtime has no working sign-in: a missing, revoked or expired key or
  // login. Covers the typed causes the Claude Agent SDK reports
  // (`authentication_failed`, ...), Codex's `unauthorized` and the provider
  // error types (`authentication_error`, `invalid_api_key`, `permission_error`).
  {
    cls: 'Auth',
    test: /\b(401|403|authentication[\s_-]?(?:failed|error)|permission[\s_-]error|oauth[\s_-]?org[\s_-]?not[\s_-]?allowed|cloud[\s_-]?credential[\s_-]?error|invalid[\s_-]?(?:x-)?api[\s_-]?key|incorrect api key|unauthori[sz]ed|not (?:logged|signed) in|(?:token|login|session|credentials?) (?:has |have )?(?:expired|been revoked)|could not be refreshed|(?:sign|log) in again|run \/login)\b/i,
  },
  {
    cls: 'RateLimited',
    test: /\b(429|rate[\s_-]?limit|too many requests|resource[\s_-]?exhausted|quota|usage[\s_-]?limit|per[\s_-]?min(?:ute)?|tpm|wait before)\b/i,
  },
  {
    cls: 'UserAborted',
    test: /\b(abort|aborted|cancel(?:l?ed)?|sigint|sigterm|user[\s_-]?(?:aborted|cancel))\b/i,
  },
  { cls: 'Timeout', test: /\b(timeout|timed?[\s_-]?out|etimedout|deadline[\s_-]?exceeded)\b/i },
  {
    cls: 'UnexpectedEnv',
    test: /\b(enoent|eacces|eperm|einval|espawn|command not found|no such file|permission denied|not installed|spawn\s|module not found|cannot find module|sandbox[\s_-]?error)\b/i,
  },
  // Context overflow is an oversized-input 400 — checked BEFORE InvalidArgs so a
  // "context length exceeded" 400 classifies here, not as a generic bad-request. Not a
  // harness bug: it's an expected (if now-rare, post-compaction) recoverable condition.
  {
    cls: 'ContextOverflow',
    test: /context[\s_-]?(?:overflow|length|window|limit)|(?:prompt|input) (?:is )?too (?:large|long)|maximum context|too many (?:prompt|input|request|message|context)s? tokens|\b(?:400|413|422|prompt|input|request|messages?|context)\b[^\n]*too many (?:\w+ )?tokens|too many (?:\w+ )?tokens\b[^\n]*\b(?:prompt|input|request|messages?|context|model)\b/i,
  },
  // The same words with nothing to say which limit. A tokens-per-minute limit uses them
  // too, so this reads as the one that clears up by itself: retrying a real overflow is
  // refused at no cost, and a rate limit filed as an overflow would never be retried.
  { cls: 'RateLimited', test: /too many (?:\w+ )?tokens/i },
  {
    cls: 'InvalidArgs',
    test: /\b(400|422|invalid[\s_-]?(?:argument|param|input|request)|bad request|validation|unprocessable|missing required|schema|malformed|model[\s_-]?not[\s_-]?found|(?:content|cyber|usage)[\s_-]?policy)\b/i,
  },
  // The provider failed or could not be reached: a 5xx, an overload, or a
  // connection that dropped or never opened.
  {
    cls: 'ProviderError',
    test: /\b(50[0234]|provider[\s_-]?error|upstream|overloaded|service unavailable|bad gateway|internal server error|server[\s_-]?error|api[\s_-]?error|model[\s_-]?error|econnreset|econnrefused|enotfound|eai_again|socket hang up|fetch failed|network[\s_-]?error|connection (?:reset|refused|closed|failed|error)|stream (?:disconnected|error)|too many failed attempts)\b/i,
  },
]

/**
 * Classify a runtime/tool failure from its (often null) error `code` plus its
 * free-form `message`. Returns `Unknown` when nothing matches — which `isHarnessBug`
 * then flags as an alertable harness defect.
 */
export function classifyError(code?: string | null, message?: string | null): RuntimeErrorClass {
  // The runtime's own verdict on the run. The rules below also read the message, and a
  // token count in it ("201,402 tokens") would match a status number first.
  if (code === 'context_overflow') return 'ContextOverflow'
  // A snake_case code is also read word by word, so `rate_limit_error` matches
  // the rate-limit rule the way "rate limit error" would.
  const words = code?.includes('_') ? code.replace(/_/g, ' ') : ''
  const hay = `${code ?? ''} ${words} ${message ?? ''}`.trim()
  if (!hay) return 'Unknown'
  for (const r of RULES) {
    if (r.test.test(hay)) return r.cls
  }
  return 'Unknown'
}

/** An unknown error class is, by the Cursor doctrine, a harness bug → alert. */
export function isHarnessBug(cls: RuntimeErrorClass): boolean {
  return cls === 'Unknown'
}

/** Classes that clear up by themselves: the same request can succeed later with
 *  nothing changed (a rate limit, a timeout, a provider outage or a dropped
 *  connection). */
const TRANSIENT_CLASSES: ReadonlySet<RuntimeErrorClass> = new Set([
  'RateLimited',
  'Timeout',
  'ProviderError',
])

/** True when trying the same work again later can succeed without anyone
 *  changing anything. */
export function isTransientError(cls: RuntimeErrorClass): boolean {
  return TRANSIENT_CLASSES.has(cls)
}

/** True when the provider refused the account itself (its sign-in or its
 *  billing): every retry fails the same way until a person fixes it. */
export function isAccountError(cls: RuntimeErrorClass): cls is 'Auth' | 'Billing' {
  return cls === 'Auth' || cls === 'Billing'
}

/**
 * Baseline EXPECTED classes per runtime — the classes whose mere occurrence is
 * not an alert (only an anomaly in their rate would be). `Unknown` is never in a
 * baseline: it always alerts. Unknown runtimes fall back to a generic baseline.
 */
export const BASELINE_EXPECTED_CLASSES: Record<string, RuntimeErrorClass[]> = {
  openclaw: [
    'InvalidArgs',
    'ContextOverflow',
    'Timeout',
    'ProviderError',
    'RateLimited',
    'UserAborted',
    'Auth',
    'Billing',
    'UnexpectedEnv',
  ],
  'claude-code': [
    'InvalidArgs',
    'ContextOverflow',
    'Timeout',
    'ProviderError',
    'RateLimited',
    'UserAborted',
    'Auth',
    'Billing',
    'UnexpectedEnv',
  ],
  codex: [
    'InvalidArgs',
    'ContextOverflow',
    'Timeout',
    'ProviderError',
    'RateLimited',
    'UserAborted',
    'Auth',
    'Billing',
    'UnexpectedEnv',
  ],
  hermes: [
    'InvalidArgs',
    'ContextOverflow',
    'Timeout',
    'ProviderError',
    'RateLimited',
    'UserAborted',
    'Auth',
    'Billing',
    'UnexpectedEnv',
  ],
}

const GENERIC_BASELINE: RuntimeErrorClass[] = [
  'InvalidArgs',
  'ContextOverflow',
  'Timeout',
  'ProviderError',
  'RateLimited',
  'UserAborted',
  'Auth',
  'Billing',
  'UnexpectedEnv',
]

/** True when the class is unexpected for the runtime (i.e. an alertable anomaly). */
export function isUnexpectedFor(
  runtime: string | null | undefined,
  cls: RuntimeErrorClass,
): boolean {
  if (cls === 'Unknown') return true
  const baseline = (runtime && BASELINE_EXPECTED_CLASSES[runtime]) || GENERIC_BASELINE
  return !baseline.includes(cls)
}
