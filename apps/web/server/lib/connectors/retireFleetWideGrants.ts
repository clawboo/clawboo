// Retire the fleet-wide connector grants an earlier build minted automatically.
//
// WHAT THEY WERE. Connecting a connector used to write a grant whose subject was
// `global` rather than an agent, with `mode: admin` and `toolAllow: ['*']`. A
// global grant is returned to every caller whatever agent they named
// (packages/db/src/grants/repository.ts:105), so one connect authorised the whole
// fleet. Connecting is now an availability act that grants nobody, and access is
// given per agent by drawing an edge, but a database written by the old build
// still carries those rows and they still answer for every agent.
//
// ONLY THE MINTED ONES. `origin: 'owner'` is what the automatic path wrote;
// anything an operator created through `POST /api/grants` carries `operator` and
// is left alone, because a person may legitimately want a fleet-wide grant and
// nothing here is entitled to overrule that.
//
// IDEMPOTENT BY CONSTRUCTION. Nothing mints these any more, so after the first
// pass there are none to find and this is a single query that matches nothing.

import { listGrants, revokeGrant, type ClawbooDb } from '@clawboo/db'

const REASON = 'connector access is granted per agent'

/**
 * Revoke every automatically-minted fleet-wide connector grant.
 *
 * Returns how many were retired, so the caller can say so once rather than
 * leaving a silent permission change in the operator's database.
 */
export function retireFleetWideConnectorGrants(db: ClawbooDb): number {
  let retired = 0
  for (const grant of listGrants(db)) {
    if (grant.subjectKind !== 'global') continue
    if (grant.capabilityKind !== 'connector') continue
    if (grant.origin !== 'owner') continue
    if (grant.state !== 'active') continue
    if (revokeGrant(db, grant.id, REASON)) retired += 1
  }
  return retired
}
