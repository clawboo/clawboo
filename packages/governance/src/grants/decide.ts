// `decideGrant`: the ONE function that decides whether a capability call may
// proceed. The broker's inspector calls it to gate; the Ghost Graph calls it to
// render an edge's badge. One function, two consumers, on purpose: a badge
// computed by a parallel code path drifts from the gate, and a permission-shaped
// field that enforces nothing is worse than no field, because operators trust it.
//
// Pure and total: no clock, no I/O, no throw. `now` and every count are injected.

import { isToolInScope } from './match'
import { isLethalTrifecta, unionTrifecta } from './trifecta'
import {
  MODE_RANK,
  type Grant,
  type GrantDecision,
  type GrantDecisionInput,
  type GrantMode,
  type GrantToolFacts,
  type StandingRule,
} from './types'

/** Most specific subject wins: an agent grant overrides team, team overrides global. */
const SUBJECT_SPECIFICITY: Readonly<Record<Grant['subjectKind'], number>> = Object.freeze({
  agent: 2,
  team: 1,
  global: 0,
})

/**
 * The mode a tool REQUIRES, derived from its annotations.
 *
 * `readOnly` wins over a contradictory `destructive`. Per the MCP spec,
 * destructive/idempotent are meaningful only when `readOnly` is false, so a
 * manifest declaring both is malformed, and resolving a malformed manifest
 * toward the SAFER reading would be wrong here: it would let a tool claim
 * read-only and still be treated as destructive-and-therefore-gated. We treat it
 * as read-only for the MODE gate (what it says it does) and leave the risk gate
 * below to catch it if the registry classified it as destructive anyway.
 */
export function requiredMode(tool: GrantToolFacts): GrantMode {
  if (tool.readOnly === true) return 'read'
  if (tool.destructive === true) return 'admin'
  return 'write'
}

/** True when this call changes something. Drives `policy: 'writes'`. */
export function isMutating(tool: GrantToolFacts): boolean {
  return tool.readOnly !== true
}

/** The grant that governs this call, or null. Ties break toward the newest state. */
export function selectGrant(grants: readonly Grant[]): Grant | null {
  let best: Grant | null = null
  for (const g of grants) {
    if (!best) {
      best = g
      continue
    }
    const a = SUBJECT_SPECIFICITY[g.subjectKind] ?? -1
    const b = SUBJECT_SPECIFICITY[best.subjectKind] ?? -1
    if (a > b) best = g
    // An ACTIVE grant beats an equally specific inactive one, so a stale
    // suspended row never masks a live sibling at the same specificity.
    else if (a === b && best.state !== 'active' && g.state === 'active') best = g
  }
  return best
}

function findStandingRule(
  rules: readonly StandingRule[] | undefined,
  grantId: string,
  toolName: string,
  argsShape: string | null | undefined,
  now: number,
): StandingRule | null {
  if (!rules) return null
  let exactMatch: StandingRule | null = null
  let anyArgsMatch: StandingRule | null = null
  for (const r of rules) {
    if (r.grantId !== grantId || r.toolName !== toolName) continue
    if (r.expiresAt !== null && r.expiresAt <= now) continue
    // An exact args-shape match is strictly more specific than a rule that
    // covers any arguments, so it wins outright.
    //
    // WITHIN one specificity level, deny beats allow regardless of row order.
    // Conflicting rows are reachable: a user mints a deny while an older allow
    // for the same shape is still on file. Returning whichever the array happened
    // to list first would let a superseded allow resurrect a call the user has
    // since forbidden. `isToolInScope` already evaluates deny after
    // allow for exactly this reason; standing rules must not be the one place
    // where precedence is an accident of insertion order.
    if (r.argsShape !== null && r.argsShape === argsShape) {
      if (r.decision === 'deny') return r
      exactMatch ??= r
    } else if (r.argsShape === null) {
      // Take `r` when nothing is held yet, or when `r` upgrades an allow to a deny.
      // Written without a self-reference on the right-hand side: TS cannot narrow
      // `anyArgsMatch` through a circular assignment and collapses it to `never`.
      const upgradesToDeny = r.decision === 'deny' && anyArgsMatch?.decision !== 'deny'
      if (anyArgsMatch === null || upgradesToDeny) anyArgsMatch = r
    }
  }
  return exactMatch ?? anyArgsMatch
}

/**
 * Evaluation order is deliberate and must not be reshuffled:
 *
 *   resolve grant → state → DRIFT → scope → mode → rate → standing rule
 *                 → trifecta/taint → policy → risk
 *
 * Two orderings carry real weight:
 *
 * - **Drift before scope.** If a server silently renames or redefines its tools
 *   after approval, a scope check could be satisfied by the NEW name. Checking
 *   the pin first means a rug-pull is caught as a rug-pull, not waved through.
 *
 * - **Trifecta before policy.** `approvalPolicy: 'never'` is a legitimate user
 *   choice for a boring connector, but it must not be able to disarm the
 *   exfiltration gate. Evaluating the trifecta first makes that structural
 *   rather than a rule someone can forget.
 */
export function decideGrant(input: GrantDecisionInput): GrantDecision {
  const { tool, now } = input

  // ── resolve ──────────────────────────────────────────────────────────────
  const grant = selectGrant(input.grants)
  if (!grant) return { kind: 'deny', grantId: null, reason: 'no-grant' }

  // ── state ────────────────────────────────────────────────────────────────
  if (grant.state === 'revoked') return { kind: 'deny', grantId: grant.id, reason: 'grant-revoked' }
  if (grant.state === 'suspended')
    return { kind: 'deny', grantId: grant.id, reason: 'grant-suspended' }
  if (grant.state === 'proposed')
    return { kind: 'deny', grantId: grant.id, reason: 'grant-proposed' }
  // Expiry is checked against the clock as well as the stored state, so a row
  // the reaper has not swept yet still stops authorizing on time.
  if (grant.state === 'expired' || (grant.expiresAt !== null && grant.expiresAt <= now))
    return { kind: 'deny', grantId: grant.id, reason: 'grant-expired' }

  // ── drift (before scope, see the header) ────────────────────────────────
  if (
    grant.specHashPin !== null &&
    input.currentSpecHash != null &&
    grant.specHashPin !== input.currentSpecHash
  )
    return { kind: 'deny', grantId: grant.id, reason: 'spec-drift' }
  if (
    grant.toolsHashPin !== null &&
    input.currentToolsHash != null &&
    grant.toolsHashPin !== input.currentToolsHash
  )
    return { kind: 'deny', grantId: grant.id, reason: 'spec-drift' }

  // ── scope ────────────────────────────────────────────────────────────────
  // Both of the next two checks are properties of the TOOL being called, not of
  // the grant, so a caller with no call in hand skips them. See
  // `grantLevelOnly`: without it the graph had to invent a tool to ask about,
  // and every name it could invent was wrong for some grant.
  if (
    input.grantLevelOnly !== true &&
    !isToolInScope({ allow: grant.toolAllow, deny: grant.toolDeny, name: tool.name })
  )
    return { kind: 'deny', grantId: grant.id, reason: 'tool-not-in-scope' }

  // ── mode ─────────────────────────────────────────────────────────────────
  if (input.grantLevelOnly !== true && MODE_RANK[requiredMode(tool)] > MODE_RANK[grant.mode])
    return { kind: 'deny', grantId: grant.id, reason: 'mode-insufficient' }

  // ── rate ─────────────────────────────────────────────────────────────────
  if (grant.callCeilingPerHour !== null && (input.callsInWindow ?? 0) >= grant.callCeilingPerHour)
    return { kind: 'deny', grantId: grant.id, reason: 'rate-limited' }

  // ── trifecta / taint (before policy, see the header) ────────────────────
  const chain = unionTrifecta(input.runTrifecta, tool.trifecta)
  const neverRemember = tool.neverRemember === true
  if (isLethalTrifecta(chain))
    return {
      kind: 'require_approval',
      grantId: grant.id,
      reason: 'lethal-trifecta',
      // Never remembered: the chain is a property of THIS run, so a standing
      // allow minted here would authorize a future run that looks nothing like it.
      neverRemember: true,
    }
  if (input.tainted === true && chain.canEgress)
    return {
      kind: 'require_approval',
      grantId: grant.id,
      reason: 'tainted-run',
      neverRemember: true,
    }

  // ── standing rule ────────────────────────────────────────────────────────
  // Deliberately AFTER the trifecta gate: a rule minted on a clean run must not
  // silently authorize the same tool once the run has been tainted.
  const rule = findStandingRule(input.standingRules, grant.id, tool.name, input.argsShape, now)
  if (rule?.decision === 'deny') return { kind: 'deny', grantId: grant.id, reason: 'standing-deny' }
  if (rule?.decision === 'allow' && !neverRemember)
    return { kind: 'allow', grantId: grant.id, ruleId: rule.id }

  // A never-remembered tool always prompts, even with a rule on file: the rule
  // should never have been minted, and honouring it would make the class a lie.
  if (neverRemember)
    return {
      kind: 'require_approval',
      grantId: grant.id,
      reason: 'never-remembered',
      neverRemember: true,
    }

  // ── policy ───────────────────────────────────────────────────────────────
  if (grant.approvalPolicy === 'always')
    return { kind: 'require_approval', grantId: grant.id, reason: 'policy-always', neverRemember }
  if (grant.approvalPolicy === 'writes' && isMutating(tool))
    return { kind: 'require_approval', grantId: grant.id, reason: 'policy-writes', neverRemember }
  if (grant.approvalPolicy === 'never') return { kind: 'allow', grantId: grant.id }

  // ── risk (policy === 'risk') ─────────────────────────────────────────────
  if (tool.risk === 'destructive')
    return {
      kind: 'require_approval',
      grantId: grant.id,
      reason: 'risk-destructive',
      neverRemember,
    }
  // A read-only tool does NOT trip `risk-external`. Connectors carry an
  // `external` risk FLOOR, so without this carve-out every `list_files` on every
  // filesystem connector would prompt, and an approval dialog a user sees
  // hundreds of times a night is one they stop reading, which is how the whole
  // governance layer becomes decorative. Read-only exfiltration is not left
  // unguarded: it is exactly what the trifecta gate above catches, and that gate
  // cannot be turned off by POLICY -- `approvalPolicy: 'never'` is evaluated
  // after it, deliberately.
  //
  // It CAN be defeated by a local process, which resolves its own approval and
  // never asks a human. That is a limit of running unauthenticated on loopback,
  // not of this function, and SECURITY.md states it rather than leaving a reader
  // to infer a guarantee from this comment.
  if (tool.risk === 'external' && isMutating(tool))
    return { kind: 'require_approval', grantId: grant.id, reason: 'risk-external', neverRemember }

  return { kind: 'allow', grantId: grant.id }
}
