// Routine cron-spec parsing. A spec is either a croner-parseable cron
// expression (5/6-field, optionally with seconds) or a one-shot
// `once@<ISO-8601>`. Validation of the cron-expression half lives in
// occurrence.ts (the croner probe) so this module stays dependency-free for
// consumers that only need the shape.

import { InvalidCronSpecError } from './errors'

export const ONCE_PREFIX = 'once@'

export type ParsedSpec = { kind: 'cron'; expr: string } | { kind: 'once'; atMs: number }

/**
 * Parse a Routine cron spec. Throws InvalidCronSpecError on a malformed
 * `once@` timestamp or an empty expression; cron-expression syntax is
 * validated by probeCronExpr (occurrence.ts) at the registration boundary.
 */
export function parseCronSpec(spec: string): ParsedSpec {
  const trimmed = spec.trim()
  if (!trimmed) throw new InvalidCronSpecError(spec, 'empty spec')
  if (trimmed.startsWith(ONCE_PREFIX)) {
    const iso = trimmed.slice(ONCE_PREFIX.length)
    const atMs = Date.parse(iso)
    if (Number.isNaN(atMs))
      throw new InvalidCronSpecError(spec, `unparseable ISO timestamp "${iso}"`)
    return { kind: 'once', atMs }
  }
  return { kind: 'cron', expr: trimmed }
}

export function isOnceSpec(spec: string): boolean {
  return spec.trim().startsWith(ONCE_PREFIX)
}
