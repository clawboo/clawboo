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

// Keys that CONTAIN a sensitive substring but are known-safe numeric telemetry —
// token COUNTS, never credentials. Matched case-insensitively against the exact key
// name, so a real credential under e.g. `accessToken` still redacts. Kept in sync
// with @clawboo/db's scrub.ts SAFE_COUNT_KEYS so the storage + display layers agree.
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

// Value patterns that look like a credential regardless of the key they sit
// under. This is an intentional ALLOW-LIST (not universal SHAPE coverage) so
// telemetry / hashes survive — EXTEND it for a new vendor, don't assume every
// secret shape is caught. PEM is first so its multi-line match wins.
const SENSITIVE_VALUE_RES: RegExp[] = [
  /-----BEGIN[A-Z ]*PRIVATE KEY-----[\s\S]*?-----END[A-Z ]*PRIVATE KEY-----/g, // PEM private key block
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
  /\b[A-Z][A-Z0-9_]*(?:KEY|TOKEN|SECRET|PASSWORD)\s*[=:]\s*(?:"[^"]*"|'[^']*'|\S+)/g,
]

/** Whole-string JWT shape (a bare token value, not embedded in prose). */
const JWT_RE = /^[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{4,}$/

function maskString(s: string): string {
  if (JWT_RE.test(s.trim())) return REDACTION_MASK
  let out = s
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

function redactDeep(value: unknown, seen: WeakSet<object>): unknown {
  if (typeof value === 'string') return maskString(value)
  if (value === null || typeof value !== 'object') return value
  // Guard against circular references (the log path can receive arbitrary objects).
  if (seen.has(value)) return '[Circular]'
  seen.add(value)
  if (Array.isArray(value)) return value.map((v) => redactDeep(v, seen))
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    out[k] = isSensitiveKey(k) ? REDACTION_MASK : redactDeep(v, seen)
  }
  return out
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
