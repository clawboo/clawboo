// Taking a standing exec grant away, and being able to prove it.
//
// There is no revoke RPC. OpenClaw exposes only `exec.approvals.get` and
// `exec.approvals.set`, so removing one row means rewriting the fleet's entire
// permissions document, under a base-hash compare-and-swap, with every other
// agent's policy riding along in the same payload. That is the whole reason this
// file is careful in ways a delete button usually is not.
//
// THREE THINGS IT REFUSES TO DO.
//
//  1. It never rebuilds an entry. Rows are filtered, never mapped: an entry that
//     lost its `argPattern` in a round-trip would stop matching the command it was
//     minted for, so the grant would be gone while the row still looked present.
//     Filtering keeps the original object references untouched.
//  2. It never revokes from the wildcard bucket. Enforcement unions `agents['*']`
//     ahead of the agent's own (exec-approvals-BSZ-fPIY.js:148), so a wildcard row
//     is live for this Boo but belongs to every other one too. Silently narrowing
//     a per-Boo revoke to the agent bucket while a wildcard copy keeps granting is
//     precisely the control that reports success and changes nothing.
//  3. It never claims success it cannot show. `exec.approvals.set` answers with
//     the post-write document, so the check is made against the Gateway's own
//     reply rather than against what we hoped we sent. Re-reading to confirm is
//     not an option: `exec.approvals.get` is itself a write.

import {
  mutateExecApprovalsDoc,
  type AgentApprovalPolicy,
  type GatewayApprovalsDoc,
} from './execApprovals'
import { execAllowlistEntryKey } from './execAllowlist'

type GatewayClientLike = {
  call<T = unknown>(method: string, params?: unknown): Promise<T>
}

export type ExecRevokeOutcome =
  /** The rows are gone, confirmed against the Gateway's own post-write document. */
  | { outcome: 'revoked'; removed: number; remaining: number }
  /** Nothing matched. Not an error, and specifically not a success either. */
  | { outcome: 'already-absent' }
  /** At least one key lives in `agents['*']`. Nothing was written. */
  | { outcome: 'blocked-wildcard'; keys: string[] }
  /** The Boo has no bucket in the document at all. Nothing was written. */
  | { outcome: 'no-such-agent' }
  /** The write went through and the rows are still there. Never reported as done. */
  | { outcome: 'not-verified'; keys: string[] }

const allowlistOf = (entry: AgentApprovalPolicy | undefined): unknown[] =>
  Array.isArray(entry?.allowlist) ? (entry.allowlist as unknown[]) : []

const keysOf = (entry: AgentApprovalPolicy | undefined): Set<string> =>
  new Set(
    allowlistOf(entry).map((e) => execAllowlistEntryKey((e ?? {}) as Record<string, unknown>)),
  )

/**
 * Drop the named rows from ONE agent's bucket, leaving the rest of the document
 * exactly as it arrived.
 *
 * Pure, and separated from the write so the interesting property (what survives)
 * can be tested without a Gateway. The agent's own `security`, `ask`,
 * `askFallback`, `autoAllowSkills` and `mcpTools` live in the same record and are
 * carried by the spread; a revoke that removed the posture along with the list
 * would take the gate down at the same moment it took the grants away.
 */
export function removeExecAllowlistEntries(
  doc: GatewayApprovalsDoc,
  agentId: string,
  keys: readonly string[],
): { next: GatewayApprovalsDoc; removed: number } {
  const targets = new Set(keys)
  const prior = doc.agents?.[agentId]
  if (!prior) return { next: doc, removed: 0 }

  const before = allowlistOf(prior)
  const after = before.filter(
    (e) => !targets.has(execAllowlistEntryKey((e ?? {}) as Record<string, unknown>)),
  )
  if (after.length === before.length) return { next: doc, removed: 0 }

  const agents: Record<string, AgentApprovalPolicy> = { ...(doc.agents ?? {}) }
  // An empty allowlist is kept, not deleted. Removing the bucket would also drop
  // this Boo's posture and hand it back to the document defaults, which is a
  // permissions change nobody asked for.
  agents[agentId] = { ...prior, allowlist: after as AgentApprovalPolicy['allowlist'] }

  const next: GatewayApprovalsDoc = { version: 1, agents }
  if (doc.socket) next.socket = doc.socket
  if (doc.defaults) next.defaults = doc.defaults
  return { next, removed: before.length - after.length }
}

/**
 * Revoke standing grants for one Boo.
 *
 * `agentId` is OPENCLAW'S id. Keys are content fingerprints from
 * `execAllowlistEntryKey`, not entry ids: ids are minted during normalisation for
 * rows that lack them, and a revoke that missed would report a clean removal of
 * something still on disk.
 *
 * A caller revoking a grant should pass BOTH rows of the mint. The `=node-command:`
 * companion is required by the node-host path, so leaving it behind leaves a row
 * that grants nothing on its own but is not litter either.
 */
export async function revokeExecAllowlistEntries(
  client: GatewayClientLike,
  params: { agentId: string; keys: readonly string[] },
): Promise<ExecRevokeOutcome> {
  const { agentId, keys } = params
  if (keys.length === 0) return { outcome: 'already-absent' }

  let blockedByWildcard: string[] = []
  let sawAgent = false
  let matched = 0

  const outcome = await mutateExecApprovalsDoc(client, (current) => {
    blockedByWildcard = []
    const doc: GatewayApprovalsDoc = current ?? { version: 1, agents: {} }
    const agentEntry = doc.agents?.[agentId]
    sawAgent = Boolean(agentEntry)
    if (!agentEntry) return null

    // Checked on EVERY attempt rather than once up front: a retry re-reads the
    // document, and the wildcard bucket may have gained a copy in between.
    const wildcardKeys = keysOf(doc.agents?.['*'])
    blockedByWildcard = keys.filter((k) => wildcardKeys.has(k))
    if (blockedByWildcard.length > 0) return null

    const { next, removed } = removeExecAllowlistEntries(doc, agentId, keys)
    matched = removed
    if (removed === 0) return null
    return next
  })

  if (blockedByWildcard.length > 0) return { outcome: 'blocked-wildcard', keys: blockedByWildcard }
  if (!sawAgent) return { outcome: 'no-such-agent' }
  if (!outcome.wrote) return { outcome: 'already-absent' }

  // The Gateway's own account of what it now holds. Without this the caller would
  // be reporting the success of a payload it sent rather than of a change it made.
  const after = outcome.result?.file
  if (after) {
    const remainingKeys = keysOf(after.agents?.[agentId])
    const survivors = keys.filter((k) => remainingKeys.has(k))
    if (survivors.length > 0) return { outcome: 'not-verified', keys: survivors }
    return { outcome: 'revoked', removed: matched, remaining: remainingKeys.size }
  }

  // No post-state to check against. Reporting a verified revoke here would be a
  // guess dressed as a receipt.
  return { outcome: 'not-verified', keys: [...keys] }
}
