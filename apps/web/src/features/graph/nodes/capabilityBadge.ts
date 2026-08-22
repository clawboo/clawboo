// The single-slot badge ladder for a capability tile.
//
// A 46px disc has room for exactly ONE badge, so precedence is a decision, not
// an accident — the same discipline n8n's canvas status icons use (one strict
// if/else chain, never a row of stacked indicators).
//
// The ladder is ordered by what a human must act on FIRST, not by severity in
// the abstract:
//
//   1. revoked        the grant is gone; the tile is about to disappear
//   2. suspended      temporarily off, including the global freeze
//   3. drift          the highest-signal state — the tool list no longer hashes
//                     to what was approved. A rug-pull. It outranks needs-auth
//                     because re-authing a drifted server is the wrong move.
//   4. needs-auth     real and manageable, just not signed in
//   5. rate-limited   self-clearing; informational
//   6. unavailable    a declared requirement is unmet (auth-missing, env-missing)
//   7. disabled       a human turned it off — a CHOICE, not a fault
//   8. ok             NOTHING. Never-ran is not broken, and a badge on every
//                     healthy tile is a badge nobody reads.
//
// Pure and dependency-free so it can be unit-tested and reused by ResourceNode,
// SkillNode and MiniGraph without any of them re-deriving the precedence.

import type { CapabilityHealth } from '@clawboo/capability-registry'

export type CapabilityBadgeKind =
  'revoked' | 'suspended' | 'drift' | 'needs-auth' | 'rate-limited' | 'unavailable' | 'disabled'

export interface CapabilityBadgeInput {
  health?: CapabilityHealth
  /** Server-evaluated availability. `false` ⇒ a declared requirement is unmet. */
  available?: boolean
  /** `false` ⇒ a human turned it off. */
  enabled?: boolean
  /** Grants authorizing this tile. Empty/absent ⇒ observed, not granted. */
  grantIds?: string[]
  /** Explicit grant lifecycle, when the tile is grant-backed. */
  grantState?: 'proposed' | 'active' | 'suspended' | 'revoked' | 'expired'
}

export interface CapabilityBadge {
  kind: CapabilityBadgeKind
  /** Short, human, and safe to render in a title attribute. */
  label: string
  /** CSS custom property for the badge tint. */
  color: string
  /** Whether the badge should pulse — reserved for states awaiting a human. */
  pulse: boolean
}

const BADGES: Record<CapabilityBadgeKind, Omit<CapabilityBadge, 'kind'>> = {
  revoked: { label: 'Revoked', color: 'var(--muted-foreground)', pulse: false },
  suspended: { label: 'Suspended', color: 'var(--destructive)', pulse: false },
  drift: { label: 'Changed since you approved it', color: 'var(--amber)', pulse: true },
  'needs-auth': { label: 'Needs sign-in', color: 'var(--amber)', pulse: true },
  'rate-limited': { label: 'Rate limited', color: 'var(--muted-foreground)', pulse: false },
  unavailable: { label: 'Unavailable', color: 'var(--muted-foreground)', pulse: false },
  disabled: { label: 'Turned off', color: 'var(--muted-foreground)', pulse: false },
}

/** The one badge to render, or null when the tile is healthy. */
export function capabilityBadge(input: CapabilityBadgeInput): CapabilityBadge | null {
  const { health, available, enabled, grantState } = input

  let kind: CapabilityBadgeKind | null = null

  if (grantState === 'revoked' || grantState === 'expired') kind = 'revoked'
  else if (grantState === 'suspended') kind = 'suspended'
  else if (health === 'drift') kind = 'drift'
  else if (health === 'needs-auth') kind = 'needs-auth'
  else if (health === 'error' || health === 'degraded') kind = 'unavailable'
  else if (available === false) kind = 'unavailable'
  else if (enabled === false) kind = 'disabled'

  if (!kind) return null
  return { kind, ...BADGES[kind] }
}

/**
 * The tooltip line explaining WHY a tile is not simply fine.
 *
 * Assembled from data the server already computes and the graph currently throws
 * away: `diagnostics` (`auth-missing:openai`) and `hint` (the source-supplied
 * remedy). This is the whole "why can't this teammate do X" affordance — a greyed
 * tile with no reason is strictly worse than a 400, because a 400 at least says
 * something.
 *
 * `hint` is rendered VERBATIM and last: it comes from the owning source, so the
 * graph must never paraphrase it into a per-runtime string of its own.
 */
export function capabilityReason(input: {
  badge: CapabilityBadge | null
  diagnostics?: string[]
  healthDetail?: string | null
  hint?: string
}): string | null {
  const parts: string[] = []
  if (input.badge) parts.push(input.badge.label)
  if (input.healthDetail) parts.push(input.healthDetail)
  for (const d of input.diagnostics ?? []) parts.push(humanizeDiagnostic(d))
  if (input.hint) parts.push(input.hint)
  return parts.length > 0 ? parts.join(' · ') : null
}

/**
 * `auth-missing:openai` → `missing auth: openai`.
 *
 * Deliberately a light touch rather than a lookup table: the diagnostic
 * vocabulary is open (each source mints its own), so a table would silently drop
 * anything it had not been taught. Splitting on the first `:` degrades to showing
 * the raw code, which is still useful.
 */
export function humanizeDiagnostic(code: string): string {
  const at = code.indexOf(':')
  if (at === -1) return code.replace(/-/g, ' ')
  const kind = code.slice(0, at).replace(/-/g, ' ')
  const subject = code.slice(at + 1)
  return `${kind}: ${subject}`
}
