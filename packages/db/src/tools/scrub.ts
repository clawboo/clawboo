// ─── Secret scrubbing ───────────────────────────────────────────────────────
// An audit trail that logs raw args is an exfiltration surface. Scrub secrets
// BEFORE anything is persisted or summarised: redact secret-looking KEYS, then
// secret-looking VALUES. Used for both audit rows and approval arg summaries.

const SECRET_KEY_RE =
  /(token|secret|password|passwd|api[_-]?key|apikey|authorization|auth|bearer|credential|private[_-]?key|access[_-]?key)/i

// Keys that CONTAIN a secret-looking substring (notably "token") but are
// known-safe numeric telemetry — token COUNTS, never credentials. Without this,
// `inputTokens` matches /token/ and its count is redacted to "[REDACTED]" (and
// then summed as a string in the obs metrics). Matched case-insensitively against
// the exact key name, so a real credential under e.g. `accessToken` still redacts.
const SAFE_COUNT_KEYS = new Set([
  'tokens',
  'inputtokens',
  'outputtokens',
  'cachedinputtokens',
  'totaltokens',
  'prompttokens',
  'completiontokens',
  'tokencount',
  'tokensperminute',
])

// Value patterns that look like credentials regardless of key name. Kept in sync
// with the display-layer masker in @clawboo/logger. `\bsk-…` already covers the
// Anthropic (sk-ant-) and OpenRouter (sk-or-) prefixes. PEM is first so its
// multi-line match wins.
const SECRET_VALUE_RES: RegExp[] = [
  /-----BEGIN[A-Z ]*PRIVATE KEY-----[\s\S]*?-----END[A-Z ]*PRIVATE KEY-----/g, // PEM private key block
  /\bsk-[A-Za-z0-9_-]{12,}\b/g, // OpenAI / Anthropic / OpenRouter
  /\bghp_[A-Za-z0-9]{12,}\b/g, // GitHub PAT
  /\bgithub_pat_[A-Za-z0-9_]{20,}\b/g,
  /\bglpat-[A-Za-z0-9_-]{20,}\b/g, // GitLab PAT
  /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g, // Slack
  /\bAKIA[0-9A-Z]{16}\b/g, // AWS access key id
  /\bAIza[A-Za-z0-9_-]{35}\b/g, // Google API key
  /\bBearer\s+[A-Za-z0-9._-]{12,}\b/gi,
  /\beyJ[A-Za-z0-9._-]{20,}\b/g, // JWT
  // An env-var-style assignment in free text (e.g. a child process that dumps
  // its env to stderr): `OPENROUTER_API_KEY=sk-or-…` / `DB_PASSWORD: …`. The
  // value is quote-aware so a quoted multi-word secret (`MY_SECRET="two words"`)
  // is consumed in full rather than leaving the remainder past the first space
  // in clear; an unquoted value still stops at the first whitespace.
  /\b[A-Z][A-Z0-9_]*(?:KEY|TOKEN|SECRET|PASSWORD)\s*[=:]\s*(?:"[^"]*"|'[^']*'|\S+)/g,
]

const REDACTED = '[REDACTED]'

function redactValueString(s: string): string {
  let out = s
  for (const re of SECRET_VALUE_RES) out = out.replace(re, REDACTED)
  return out
}

/** Deep-clone `value`, redacting secret-looking keys + values. Pure. */
export function scrubSecrets(value: unknown): unknown {
  if (typeof value === 'string') return redactValueString(value)
  if (Array.isArray(value)) return value.map(scrubSecrets)
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      const isSecretKey = !SAFE_COUNT_KEYS.has(k.toLowerCase()) && SECRET_KEY_RE.test(k)
      out[k] = isSecretKey ? REDACTED : scrubSecrets(v)
    }
    return out
  }
  return value
}

/** Scrub + stringify args for an audit/approval summary, truncated for storage. */
export function scrubArgsSummary(args: unknown, maxChars = 4_000): string {
  let json: string
  try {
    json = JSON.stringify(scrubSecrets(args))
  } catch {
    json = String(args)
  }
  // Belt-and-suspenders: re-scrub the rendered string in case a non-JSON path slipped through.
  json = redactValueString(json)
  return json.length > maxChars ? `${json.slice(0, maxChars)}…` : json
}

/** Scrub a free-text result string (no key context) for storage. */
export function scrubResultSummary(text: string, maxChars = 8_000): string {
  const scrubbed = redactValueString(text)
  return scrubbed.length > maxChars ? `${scrubbed.slice(0, maxChars)}…` : scrubbed
}
