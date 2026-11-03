// ─── Secret scrubbing ───────────────────────────────────────────────────────
// An audit trail that logs raw args is an exfiltration surface. Scrub secrets
// BEFORE anything is persisted or summarised: redact secret-looking KEYS, then
// the saved keys' exact values, then secret-looking VALUES. Used for audit rows,
// approval arg summaries, events, memory, run summaries and verify-gate output.

const SECRET_KEY_RE =
  /(token|secret|password|passwd|api[_-]?key|apikey|authorization|auth|bearer|credential|private[_-]?key|access[_-]?key)/i

// Keys that CONTAIN a secret-looking substring but are known-safe. Two families:
// token COUNTS ("token") and `author` ("auth"). Without the first, `inputTokens`
// matches /token/ and its count is redacted to "[REDACTED]" (and then summed as a
// string in the obs metrics); without the second, an `author` field is destroyed
// on its way into the audit trail. Matched case-insensitively against the exact
// key name, so a real credential under e.g. `accessToken` or `authorization`
// still redacts. Kept in sync with the display-layer masker in @clawboo/logger.
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
  'author',
  'authors',
])

// A PEM private key block is masked by its own scan (below) rather than by a
// pattern in the list, so the multi-line block still wins before any of the
// single-line shapes get a look at it.
const PEM_BEGIN_RE = /-----BEGIN[A-Z ]{0,32}PRIVATE KEY-----/g
const PEM_END_RE = /-----END[A-Z ]{0,32}PRIVATE KEY-----/g

/**
 * Mask every `-----BEGIN … PRIVATE KEY-----` block through its closing header.
 *
 * Each opener is paired with the next unused closer in one forward pass. A
 * single regex spanning the pair has to skip the body with a lazy `[\s\S]*?`,
 * so a blob carrying many BEGIN headers and no closing END re-scans everything
 * behind each one. The label runs are length-capped because they share their
 * alphabet with the `PRIVATE KEY` literal that follows them.
 */
function maskPemBlocks(s: string, mask: string): string {
  const ends = [...s.matchAll(PEM_END_RE)]
  if (ends.length === 0) return s
  let out = ''
  let cursor = 0
  let next = 0
  for (const begin of s.matchAll(PEM_BEGIN_RE)) {
    const at = begin.index ?? 0
    if (at < cursor) continue
    const bodyStart = at + begin[0].length
    while (next < ends.length && (ends[next]?.index ?? 0) < bodyStart) next++
    const end = ends[next]
    if (!end) break
    out += s.slice(cursor, at) + mask
    cursor = (end.index ?? 0) + end[0].length
  }
  return out + s.slice(cursor)
}

// Value patterns that look like credentials regardless of key name. Kept in sync
// with the display-layer masker in @clawboo/logger. `\bsk-…` already covers the
// Anthropic (sk-ant-) and OpenRouter (sk-or-) prefixes.
const SECRET_VALUE_RES: RegExp[] = [
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
  // in clear; an unquoted value still stops at the first whitespace. The name run
  // is length-capped for the same reason as the PEM label: it can otherwise also
  // spell the trailing keyword it is meant to stop in front of.
  /\b[A-Z][A-Z0-9_]{0,64}(?:KEY|TOKEN|SECRET|PASSWORD)\s*[=:]\s*(?:"[^"]*"|'[^']*'|\S+)/g,
]

const REDACTED = '[REDACTED]'

// ─── Known secret values ─────────────────────────────────────────────────────
// The shapes above only know a few providers. A supported key of another shape
// (Groq's `gsk_…`, a Mistral key, xAI's `xai-…`) matches none of them, so the
// process that holds the saved keys lends this module their exact values and
// every scrub below masks those too, wherever they appear in a string.
//
// The values stay with their owner: a registered source returns the owner's
// current set, and the same set object until a key changes. This module keeps
// only the needles it derives from that set, compares against them, and never
// hands them back. A value shorter than the minimum is never masked by value,
// because masking a short one would wipe ordinary words out of every stored string.

/** Shortest saved value the scrub will mask by value. */
export const MIN_KNOWN_SECRET_LENGTH = 12

/** Returns the current saved secret values; the same set object until one changes. */
export type KnownSecretSource = () => ReadonlySet<string>

let knownSource: KnownSecretSource | null = null
let compiled: { from: ReadonlySet<string>; needles: readonly string[] } | null = null
const NO_NEEDLES: readonly string[] = []

/**
 * Register (or, with null, remove) the source of saved secret values. One
 * source per process: the vault registers itself when it loads.
 */
export function registerKnownSecretSource(source: KnownSecretSource | null): void {
  knownSource = source
  compiled = null
}

/** Every spelling a value takes on its way into stored text: as itself, inside a
 *  JSON string, and inside a URL (path or query, form-encoded, either hex case). */
function spellingsOf(value: string): string[] {
  const json = JSON.stringify(value).slice(1, -1)
  let uri: string
  try {
    uri = encodeURIComponent(value)
  } catch {
    // A lone surrogate cannot be URL-encoded, so it never reaches a URL that way.
    return [value, json, json.replaceAll('/', '\\/')]
  }
  const form = new URLSearchParams([['', value]]).toString().slice(1)
  const lowerHex = (s: string): string => s.replace(/%[0-9A-F]{2}/g, (m) => m.toLowerCase())
  return [value, json, json.replaceAll('/', '\\/'), uri, lowerHex(uri), form, lowerHex(form)]
}

function currentNeedles(): readonly string[] {
  if (!knownSource) return NO_NEEDLES
  let values: ReadonlySet<string>
  try {
    values = knownSource()
  } catch {
    // A source must not throw into a write path; if one does, keep what it last lent.
    return compiled?.needles ?? NO_NEEDLES
  }
  if (compiled?.from === values) return compiled.needles
  const needles = new Set<string>()
  for (const value of values) {
    if (value.length < MIN_KNOWN_SECRET_LENGTH) continue
    for (const spelling of spellingsOf(value)) needles.add(spelling)
  }
  compiled = { from: values, needles: [...needles] }
  return compiled.needles
}

/**
 * Mask every occurrence of every needle with one marker per covered run.
 *
 * Plain `indexOf` scans rather than one alternation regex: a few dozen literal
 * scans stay linear on a multi-megabyte verify log, and nothing is allocated on
 * the common path where no saved value occurs. Occurrences are collected first
 * and merged, so two values that overlap or touch are masked as one run rather
 * than leaving the tail of the second one behind the first marker.
 */
function maskKnownValues(s: string, needles: readonly string[]): string {
  if (needles.length === 0 || s.length < MIN_KNOWN_SECRET_LENGTH) return s
  let spans: Array<[number, number]> | null = null
  for (const needle of needles) {
    for (let at = s.indexOf(needle); at !== -1; at = s.indexOf(needle, at + 1)) {
      ;(spans ??= []).push([at, at + needle.length])
    }
  }
  if (!spans) return s
  spans.sort((a, b) => a[0] - b[0])
  let out = ''
  let cursor = 0
  let [runStart, runEnd] = spans[0] as [number, number]
  for (const [start, end] of spans) {
    if (start <= runEnd) {
      runEnd = Math.max(runEnd, end)
      continue
    }
    out += s.slice(cursor, runStart) + REDACTED
    cursor = runEnd
    runStart = start
    runEnd = end
  }
  return out + s.slice(cursor, runStart) + REDACTED + s.slice(runEnd)
}

function redactPatterns(s: string): string {
  let out = maskPemBlocks(s, REDACTED)
  for (const re of SECRET_VALUE_RES) out = out.replace(re, REDACTED)
  return out
}

/** Saved values first: they are exact, so a pattern can never split one and
 *  leave part of it in clear. */
function redactValueString(s: string, needles: readonly string[]): string {
  return redactPatterns(maskKnownValues(s, needles))
}

// Object keys are structure, so the value pass never rewrites one: a saved value
// that happens to spell a field name must not blank that field. A secret-looking
// key still has its VALUE masked, as before.
function scrubWith(value: unknown, needles: readonly string[]): unknown {
  if (typeof value === 'string') return redactValueString(value, needles)
  if (Array.isArray(value)) return value.map((v) => scrubWith(v, needles))
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      const isSecretKey = !SAFE_COUNT_KEYS.has(k.toLowerCase()) && SECRET_KEY_RE.test(k)
      out[k] = isSecretKey ? REDACTED : scrubWith(v, needles)
    }
    return out
  }
  return value
}

/** Deep-clone `value`, redacting secret-looking keys + values and saved secret values. */
export function scrubSecrets(value: unknown): unknown {
  return scrubWith(value, currentNeedles())
}

/** Scrub + stringify args for an audit/approval summary, truncated for storage. */
export function scrubArgsSummary(args: unknown, maxChars = 4_000): string {
  const needles = currentNeedles()
  let json: string
  try {
    // Every string leaf has had the value pass, so the rendered JSON below only
    // needs the patterns; running the value pass again would reach the keys.
    json = redactPatterns(JSON.stringify(scrubWith(args, needles)))
  } catch {
    json = redactValueString(String(args), needles)
  }
  return json.length > maxChars ? `${json.slice(0, maxChars)}…` : json
}

/** Scrub a free-text result string (no key context) for storage. */
export function scrubResultSummary(text: string, maxChars = 8_000): string {
  const scrubbed = redactValueString(text, currentNeedles())
  return scrubbed.length > maxChars ? `${scrubbed.slice(0, maxChars)}…` : scrubbed
}
