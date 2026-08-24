// Canonical forms for the two things a grant pins: the connector's spec, and the
// tool list the human actually saw. Canonicalisation ONLY: digesting lives in
// `@clawboo/db`, so this stays browser-safe and `node:crypto`-free and the SPA
// can compute the same canonical string the server hashes.
//
// The property that matters: two specs that differ only in key order, or in a
// field nobody consented to, must produce the SAME string. Otherwise every
// harmless reserialisation reads as drift and users learn to click through the
// re-consent dialog, which is precisely the signal drift detection exists to
// preserve.

/**
 * How deep a structure may nest before it is treated as bad data.
 *
 * The input reaching this function includes a connector's `inputSchema`, which a
 * REMOTE SERVER writes. Unbounded recursion over an attacker-chosen shape is a
 * stack overflow, and a RangeError thrown out of a hash is not something any
 * caller here handles: it would take down a connect, or a projection the graph
 * runs on every read. 64 is far past any real JSON Schema and far short of the
 * default stack.
 */
const MAX_DEPTH = 64

/** Stable stringify: object keys sorted, arrays left in order (order is meaningful in argv). */
function canonicalJson(value: unknown, depth = 0): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null'
  // Truncated rather than thrown. A hash is a fingerprint, and a distinct
  // sentinel keeps it one: two schemas that differ only past this depth hash the
  // same, which is a far better failure than refusing to hash at all. Anything
  // this deep is not a schema a human is reading.
  if (depth >= MAX_DEPTH) return '"[too-deep]"'
  if (Array.isArray(value)) return `[${value.map((v) => canonicalJson(v, depth + 1)).join(',')}]`
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v, depth + 1)}`).join(',')}}`
}

/**
 * The spec fields a human consents to. Anything outside this list is
 * deliberately EXCLUDED from the hash: display names, icons and descriptions
 * change for cosmetic reasons and must not fire a drift alarm, while command,
 * args, url, headers and auth are the fields that decide what actually executes.
 *
 * `env` contributes its KEY NAMES only. The values are `${secret:…}` references,
 * and including them would both leak shape into a hash we log and make a routine
 * credential rotation look like tampering.
 */
const CONSENTED_SPEC_FIELDS = [
  'transport',
  'command',
  'args',
  'cwd',
  'url',
  'headers',
  'headersFromEnv',
  'headersCommand',
  'auth',
  'toolFilter',
] as const

export interface CanonicalizableSpec {
  env?: Record<string, unknown> | null
  [key: string]: unknown
}

/** The canonical string whose digest becomes `connectors.spec_hash`. */
export function canonicalizeSpec(spec: CanonicalizableSpec): string {
  const picked: Record<string, unknown> = {}
  for (const field of CONSENTED_SPEC_FIELDS) {
    const value = spec[field]
    if (value !== undefined && value !== null) picked[field] = value
  }
  const envKeys = spec.env ? Object.keys(spec.env).sort() : []
  if (envKeys.length > 0) picked['envKeys'] = envKeys
  return canonicalJson(picked)
}

export interface CanonicalizableTool {
  name: string
  description?: string | null
  inputSchema?: unknown
}

/**
 * The canonical string whose digest becomes `connectors.tools_hash`.
 *
 * Sorted by name so a server reordering its `tools/list` response is not drift.
 * The DESCRIPTION is included on purpose: a rug-pull that rewrites a tool's
 * description to smuggle instructions changes nothing else, and OWASP MCP03 is
 * explicitly about schema and description tampering. A hash over names alone
 * would miss the whole attack.
 */
export function canonicalizeToolSnapshot(tools: readonly CanonicalizableTool[]): string {
  const rows = [...tools]
    .map((t) => ({
      name: t.name,
      description: t.description ?? '',
      inputSchema: t.inputSchema ?? null,
    }))
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
  return canonicalJson(rows)
}
