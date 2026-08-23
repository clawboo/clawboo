// Canonical composite keys for the two tables whose uniqueness cannot live on
// their identity columns.
//
// SQLite treats NULLs as DISTINCT in a UNIQUE index, so a UNIQUE over
// (subject_kind, subject_id, capability_kind, connector_id, capability_id)
// happily inserts ('global', NULL, 'connector', NULL, NULL) twice. The composite
// has to be materialised into one NOT NULL column, and that column is the only
// thing standing between an operator and two contradictory grants for the same
// pair.

import type { Grant } from '@clawboo/governance'

/** The identity half of a grant: everything uniqueness is keyed on. */
export interface GrantIdentity {
  subjectKind: Grant['subjectKind']
  subjectId: string | null
  capabilityKind: Grant['capabilityKind']
  connectorId: string | null
  capabilityId: string | null
}

/**
 * Percent-encode every component, and mark PRESENT values with a leading `=`.
 *
 * Two distinct hazards, one encoding:
 *   - a component containing the separator could otherwise forge another
 *     grant's key;
 *   - null and the empty string would otherwise both encode to nothing, so a
 *     rule scoped to "any arguments" and one scoped to an empty shape would
 *     collide on the same row.
 * Both collapse two different grants onto one key, which the UNIQUE index then
 * enforces as silent data loss rather than as an error.
 *
 * `=` is the marker because `encodeURIComponent` always escapes it (to `%3D`),
 * so a leading `=` can only ever have come from this function.
 */
function part(value: string | null): string {
  return value === null ? '' : `=${encodeURIComponent(value)}`
}

/**
 * IDENTITY NORMALISATION, and it is the reason this is a function rather than a
 * template string at each call site: when a grant carries a `connectorId`, its
 * `capabilityId` is dropped.
 *
 * A `capabilities.id` folds the OWNING AGENT into its raw key, so a grant keyed
 * on one would be findable by the granting agent and invisible to the grantee's
 * broker, which is the one lookup that has to work. `connectorId` is
 * agent-independent by construction, so when it exists it is the whole identity.
 */
export function normalizeGrantIdentity(identity: GrantIdentity): GrantIdentity {
  return identity.connectorId !== null ? { ...identity, capabilityId: null } : identity
}

/** The value stored in `capability_grants.grant_key`. */
export function grantKey(identity: GrantIdentity): string {
  const n = normalizeGrantIdentity(identity)
  return [
    part(n.subjectKind),
    part(n.subjectId),
    part(n.capabilityKind),
    part(n.connectorId),
    part(n.capabilityId),
  ].join('|')
}

/**
 * The value stored in `approval_rules.rule_key`.
 *
 * A null `argsShape` means "any arguments" and is a DIFFERENT rule from one
 * scoped to a shape, so it must not collide with the empty string. `part` marks
 * present values, which is what keeps them apart.
 */
export function ruleKey(grantId: string, toolName: string, argsShape: string | null): string {
  return [part(grantId), part(toolName), part(argsShape)].join('|')
}
