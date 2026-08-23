// Row <-> domain mappers.
//
// `Grant` and `StandingRule` field names already mirror their columns, so this
// is JSON parsing and enum narrowing rather than translation. It exists so the
// widening happens in exactly ONE place: a stored enum is TEXT, and TEXT that
// reaches `decideGrant` as a bare string would silently satisfy a comparison it
// should have failed.

import type {
  ApprovalPolicy,
  Grant,
  GrantMode,
  GrantState,
  StandingRule,
} from '@clawboo/governance'

import type { DbApprovalRule, DbCapabilityGrant } from '../schema'

const GRANT_STATES: readonly GrantState[] = [
  'proposed',
  'active',
  'suspended',
  'revoked',
  'expired',
]
const GRANT_MODES: readonly GrantMode[] = ['read', 'write', 'admin']
const APPROVAL_POLICIES: readonly ApprovalPolicy[] = ['never', 'risk', 'writes', 'always']
const SUBJECT_KINDS: readonly Grant['subjectKind'][] = ['agent', 'team', 'global']
const CAPABILITY_KINDS: readonly Grant['capabilityKind'][] = ['connector', 'tool', 'skill']

/**
 * Narrow a stored string, falling back to the SAFEST member rather than trusting
 * it. A row hand-edited to `mode: 'root'` must not out-rank `admin`; a state
 * nobody recognises must not read as `active`.
 */
function narrow<T extends string>(value: string, allowed: readonly T[], fallback: T): T {
  return (allowed as readonly string[]).includes(value) ? (value as T) : fallback
}

/**
 * Parse a JSON string[] column, falling back to `fallback` on anything else.
 *
 * `toolAllow` is THREE-STATE: `['*']` is every tool, `[]` is an explicit nothing,
 * and a list is a subset. So a parse failure must NOT collapse to `[]` for
 * `toolDeny` (that would silently drop a deny) nor to `['*']` for `toolAllow`
 * (that would silently widen). Each caller passes the fallback that fails safe
 * for its own column.
 */
function parseGlobs(raw: string, fallback: string[]): string[] {
  try {
    const parsed: unknown = JSON.parse(raw)
    if (!Array.isArray(parsed)) return fallback
    return parsed.filter((v): v is string => typeof v === 'string')
  } catch {
    return fallback
  }
}

export function rowToGrant(row: DbCapabilityGrant): Grant {
  return {
    id: row.id,
    subjectKind: narrow(row.subjectKind, SUBJECT_KINDS, 'agent'),
    subjectId: row.subjectId,
    capabilityKind: narrow(row.capabilityKind, CAPABILITY_KINDS, 'connector'),
    connectorId: row.connectorId,
    capabilityId: row.capabilityId,
    // Unparseable allow-list falls back to NOTHING, unparseable deny-list falls
    // back to EVERYTHING. Both directions fail closed.
    toolAllow: parseGlobs(row.toolAllow, []),
    toolDeny: parseGlobs(row.toolDeny, ['*']),
    mode: narrow(row.mode, GRANT_MODES, 'read'),
    approvalPolicy: narrow(row.approvalPolicy, APPROVAL_POLICIES, 'always'),
    state: narrow(row.state, GRANT_STATES, 'suspended'),
    expiresAt: row.expiresAt,
    specHashPin: row.specHashPin,
    toolsHashPin: row.toolsHashPin,
    callCeilingPerHour: row.callCeilingPerHour,
  }
}

export function rowToStandingRule(row: DbApprovalRule): StandingRule {
  return {
    id: row.id,
    grantId: row.grantId,
    toolName: row.toolName,
    argsShape: row.argsShape,
    // A rule that is neither allow nor deny is treated as a DENY: an
    // unrecognised verdict must never authorize a call.
    decision: row.decision === 'allow' ? 'allow' : 'deny',
    expiresAt: row.expiresAt,
  }
}
