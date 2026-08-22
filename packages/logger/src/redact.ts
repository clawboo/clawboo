// Display/log-layer redaction.
//
// This is the RENDERING + LOG boundary twin of @clawboo/db's storage-layer
// `scrubSecrets` (which masks with `[REDACTED]` BEFORE anything is persisted to
// SQLite / audit / obs). This module runs at two later boundaries — just before an
// API response body is sent to the browser, and inside the pino logger — and masks
// with a fixed bullet string. The two layers are intentionally separate (different
// boundary, different marker) and compose as defense in depth: data that was
// already scrubbed at storage time passes through here harmlessly.
//
// It lives in @clawboo/logger (the lowest-level package, pino-only) so the pino
// instance in this same package and the Express server can share ONE implementation
// without a dependency inversion. The server re-exports it from
// apps/web/server/lib/redact.ts as the documented apply-site import.

/** The mask shown in place of a redacted value at the display / log boundary. */
export const REDACTION_MASK = '••••'

// Keys whose VALUE is a credential and is masked regardless of content. A CONTAINS
// match (not anchored) so nested shapes like `accessToken` / `clientSecret` /
// `set-cookie` are caught — paired with SAFE_COUNT_KEYS below so numeric telemetry
// that merely contains "token" (token COUNTS) is never masked. Mirrors the proven
// storage-layer key set in @clawboo/db's scrub.ts.
const SENSITIVE_KEY_RE =
  /(token|secret|password|passwd|api[_-]?key|apikey|authorization|auth|bearer|credential|private[_-]?key|access[_-]?key|cookie)/i

// Keys that CONTAIN a sensitive substring but are known-safe. Two families:
// token COUNTS (numeric telemetry, never credentials), and `author` — which is
// only caught because SENSITIVE_KEY_RE matches the `auth` substring, and which
// is one of the most common field names in event/audit payloads.
// Matched case-insensitively against the EXACT key name, so a real credential
// under e.g. `accessToken` or `authorization` still redacts. That exactness also
// means near-misses like `authorId` are NOT covered — add them here explicitly
// if they show up. Kept in sync with @clawboo/db's scrub.ts SAFE_COUNT_KEYS so
// the storage + display layers agree.
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

// Value patterns that look like a credential regardless of the key they sit
// under. This is an intentional ALLOW-LIST (not universal SHAPE coverage) so
// telemetry / hashes survive — EXTEND it for a new vendor, don't assume every
// secret shape is caught.
const SENSITIVE_VALUE_RES: RegExp[] = [
  /\bsk-[A-Za-z0-9_-]{12,}\b/g, // OpenAI-style API key
  /\bsk-ant-[A-Za-z0-9_-]{12,}\b/g, // Anthropic-style API key
  /\bsk-or-[A-Za-z0-9_-]{12,}\b/g, // OpenRouter-style API key
  /\bghp_[A-Za-z0-9]{12,}\b/g, // GitHub PAT
  /\bgithub_pat_[A-Za-z0-9_]{20,}\b/g,
  /\bglpat-[A-Za-z0-9_-]{20,}\b/g, // GitLab PAT
  /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g, // Slack
  /\bAKIA[0-9A-Z]{16}\b/g, // AWS access key id
  /\bAIza[A-Za-z0-9_-]{35}\b/g, // Google API key
  /\bBearer\s+[A-Za-z0-9._-]{12,}\b/gi, // Authorization: Bearer ...
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{6,}\b/g, // JWT (3 segments)
  // An env-var-style assignment in free text (a child process dumping its env to
  // stderr): `OPENROUTER_API_KEY=sk-or-…` / `DB_PASSWORD: …`. Quote-aware so a
  // quoted multi-word secret is fully masked; secret-shaped (UPPER_SNAKE key
  // ending KEY/TOKEN/SECRET/PASSWORD), so it never fires on prose or telemetry.
  // The name run is length-capped for the same reason as the PEM label: it can
  // otherwise also spell the trailing keyword it is meant to stop in front of.
  /\b[A-Z][A-Z0-9_]{0,64}(?:KEY|TOKEN|SECRET|PASSWORD)\s*[=:]\s*(?:"[^"]*"|'[^']*'|\S+)/g,
]

/** Whole-string JWT shape (a bare token value, not embedded in prose). */
const JWT_RE = /^[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{4,}$/

function maskString(s: string): string {
  if (JWT_RE.test(s.trim())) return REDACTION_MASK
  let out = maskPemBlocks(s, REDACTION_MASK)
  for (const re of SENSITIVE_VALUE_RES) out = out.replace(re, REDACTION_MASK)
  return out
}

function isSensitiveKey(key: string): boolean {
  return !SAFE_COUNT_KEYS.has(key.toLowerCase()) && SENSITIVE_KEY_RE.test(key)
}

/**
 * Redact a single value for display. When a `key` is supplied and it looks like a
 * credential key, the entire value is masked; otherwise strings are scanned for
 * credential-shaped substrings. Numbers / booleans / null pass through unchanged so
 * numeric telemetry (token counts, cost) survives.
 */
export function redactValue(value: unknown, key?: string): unknown {
  if (key !== undefined && isSensitiveKey(key)) return REDACTION_MASK
  return redactDeep(value, new WeakSet())
}

/**
 * `path` holds the ancestors on the CURRENT recursion path only — entries are
 * removed on the way back out. That distinction is load-bearing: a "visited-ever"
 * set would mistake a DAG (the same object referenced twice in one payload, e.g.
 * a shared agent record on two events) for a cycle and replace the second
 * occurrence with the '[Circular]' STRING — silently dropping real data from log
 * records and from API response bodies.
 */
function redactDeep(value: unknown, path: WeakSet<object>): unknown {
  if (typeof value === 'string') return maskString(value)
  if (value === null || typeof value !== 'object') return value
  // Guard against circular references (the log path can receive arbitrary objects).
  if (path.has(value)) return '[Circular]'
  path.add(value)
  try {
    if (Array.isArray(value)) return value.map((v) => redactDeep(v, path))
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = isSensitiveKey(k) ? REDACTION_MASK : redactDeep(v, path)
    }
    return out
  } finally {
    // `finally` so an unexpected throw mid-branch can't leave a stale ancestor
    // behind and turn every later sibling into a false '[Circular]'.
    path.delete(value)
  }
}

/**
 * Deep-clone `obj`, masking credential-looking keys + values with the bullet mask.
 * Pure; safe on circular structures. The single helper applied at every API
 * response site that exposes event payloads / audit entries / trace spans, and
 * inside the pino `formatters.log` hook.
 */
export function redactObject<T>(obj: T): T {
  return redactDeep(obj, new WeakSet()) as T
}

/**
 * Redact a JSON STRING field (the obs event `data`, the audit `summary`, the tool
 * `argsSummary`/`resultSummary` — all stored as JSON text). Parses, masks
 * credential-looking KEYS + VALUES, and re-stringifies so a sensitive key renders
 * as `••••` for the UI. Falls back to a value-only scan when the field is not JSON.
 */
export function redactJsonString<T extends string | null | undefined>(s: T): T {
  if (typeof s !== 'string' || s.length === 0) return s
  try {
    return JSON.stringify(redactObject(JSON.parse(s))) as T
  } catch {
    return redactValue(s) as T
  }
}
