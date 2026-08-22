// Canonical forms for the two things a grant pins: the connector's spec, and the
// tool list the human actually saw. Canonicalisation ONLY — digesting lives in
// `@clawboo/db`, so this stays browser-safe and `node:crypto`-free and the SPA
// can compute the same canonical string the server hashes.
//
// The property that matters: two specs that differ only in key order, or in a
// field nobody consented to, must produce the SAME string. Otherwise every
// harmless reserialisation reads as drift and users learn to click through the
// re-consent dialog — which is precisely the signal drift detection exists to
// preserve.

/** Stable stringify: object keys sorted, arrays left in order (order is meaningful in argv). */
function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null'
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(',')}}`
}

/**
 * The spec fields a human consents to. Anything outside this list is
 * deliberately EXCLUDED from the hash — display names, icons and descriptions
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
 * explicitly about schema and description tampering — a hash over names alone
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
