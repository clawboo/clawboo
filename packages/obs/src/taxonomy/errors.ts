// Runtime error taxonomy (the Cursor model): every runtime/tool failure is
// classified into a baseline of EXPECTED classes; anything that doesn't match is
// `Unknown`, and an `Unknown` is treated as a HARNESS BUG — it is surfaced as an
// alert (a flagged `error` event + an error-level structured log) rather than
// silently swallowed. Expected classes get baselined per-runtime so anomalies in
// their RATE can be alerted on later; an Unknown alerts immediately.

export const RUNTIME_ERROR_CLASSES = [
  'InvalidArgs',
  'Timeout',
  'ProviderError',
  'RateLimited',
  'UserAborted',
  'UnexpectedEnv',
  'Unknown',
] as const

export type RuntimeErrorClass = (typeof RUNTIME_ERROR_CLASSES)[number]

interface Rule {
  cls: RuntimeErrorClass
  test: RegExp
}

// Order matters: the first matching rule wins. More specific/!-overloaded signals
// (rate-limit, abort) are checked before the broader provider/env buckets.
const RULES: Rule[] = [
  {
    cls: 'RateLimited',
    test: /\b(429|rate[\s_-]?limit|too many requests|resource[\s_-]?exhausted|quota)\b/i,
  },
  {
    cls: 'UserAborted',
    test: /\b(abort|aborted|cancel(?:l?ed)?|sigint|sigterm|user[\s_-]?(?:aborted|cancel))\b/i,
  },
  { cls: 'Timeout', test: /\b(timeout|timed?[\s_-]?out|etimedout|deadline[\s_-]?exceeded)\b/i },
  {
    cls: 'UnexpectedEnv',
    test: /\b(enoent|eacces|eperm|einval|espawn|command not found|no such file|permission denied|not installed|spawn\s|module not found|cannot find module)\b/i,
  },
  {
    cls: 'InvalidArgs',
    test: /\b(400|422|invalid[\s_-]?(?:argument|param|input|request)|bad request|validation|unprocessable|missing required|schema|malformed)\b/i,
  },
  {
    cls: 'ProviderError',
    test: /\b(50[0234]|provider[\s_-]?error|upstream|overloaded|service unavailable|bad gateway|internal server error|api[\s_-]?error|model[\s_-]?error)\b/i,
  },
]

/**
 * Classify a runtime/tool failure from its (often null) error `code` plus its
 * free-form `message`. Returns `Unknown` when nothing matches — which `isHarnessBug`
 * then flags as an alertable harness defect.
 */
export function classifyError(code?: string | null, message?: string | null): RuntimeErrorClass {
  const hay = `${code ?? ''} ${message ?? ''}`.trim()
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

/**
 * Baseline EXPECTED classes per runtime — the classes whose mere occurrence is
 * not an alert (only an anomaly in their rate would be). `Unknown` is never in a
 * baseline: it always alerts. Unknown runtimes fall back to a generic baseline.
 */
export const BASELINE_EXPECTED_CLASSES: Record<string, RuntimeErrorClass[]> = {
  openclaw: [
    'InvalidArgs',
    'Timeout',
    'ProviderError',
    'RateLimited',
    'UserAborted',
    'UnexpectedEnv',
  ],
  'claude-code': [
    'InvalidArgs',
    'Timeout',
    'ProviderError',
    'RateLimited',
    'UserAborted',
    'UnexpectedEnv',
  ],
  codex: ['InvalidArgs', 'Timeout', 'ProviderError', 'RateLimited', 'UserAborted', 'UnexpectedEnv'],
  hermes: [
    'InvalidArgs',
    'Timeout',
    'ProviderError',
    'RateLimited',
    'UserAborted',
    'UnexpectedEnv',
  ],
}

const GENERIC_BASELINE: RuntimeErrorClass[] = [
  'InvalidArgs',
  'Timeout',
  'ProviderError',
  'RateLimited',
  'UserAborted',
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
