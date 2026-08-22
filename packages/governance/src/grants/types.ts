// The grant vocabulary — the typed nouns behind "this agent may use this
// capability, in this mode, under this approval policy".
//
// A grant is BOTH the permission record the broker reads AND the edge the Ghost
// Graph draws. That is deliberate and load-bearing: a badge computed by a second
// code path is governance theatre, so the renderer must call the same
// `decideGrant` the gate calls, with the same inputs, and render its verdict.
//
// Pure, browser-safe, zero runtime deps — the SPA imports these types to type an
// edge, `@clawboo/db` imports them to gate a call.

/**
 * Lifecycle of a grant. Only `active` authorizes anything.
 * - `proposed`  created but not yet accepted (an agent asked; a human has not answered).
 * - `suspended` temporarily off — drift, a failed re-auth, or the global freeze.
 *   Distinct from `revoked` because it is expected to come back.
 * - `revoked`   deliberately ended by a human. Terminal.
 * - `expired`   passed `expiresAt`. Terminal until re-granted.
 */
export type GrantState = 'proposed' | 'active' | 'suspended' | 'revoked' | 'expired'

/**
 * The privilege ceiling. Ordered — comparison IS the enforcement primitive, so
 * these are ranked numerically by `MODE_RANK` rather than compared as strings.
 */
export type GrantMode = 'read' | 'write' | 'admin'

/** Ranked so `requiredMode > grantedMode` is the whole mode gate. */
export const MODE_RANK: Readonly<Record<GrantMode, number>> = Object.freeze({
  read: 0,
  write: 1,
  admin: 2,
})

/**
 * How often a human is asked.
 * - `never`  never prompt on POLICY grounds. Does NOT bypass the trifecta/taint
 *            gate, which is evaluated earlier precisely so this cannot disarm it.
 * - `risk`   prompt only for tools the registry classified as risky (today's behaviour).
 * - `writes` prompt for every mutation.
 * - `always` prompt for every call, including reads.
 */
export type ApprovalPolicy = 'never' | 'risk' | 'writes' | 'always'

/**
 * The three legs of the "lethal trifecta". Individually ordinary; together they
 * are the shape of an exfiltration chain, so the union across a run is what the
 * gate actually watches.
 */
export interface TrifectaTags {
  /** Reads data the user would not publish (repo contents, mail, transcripts). */
  readsPrivateData: boolean
  /** Pulls in content an attacker may author (web pages, issues, email bodies). */
  ingestsUntrustedContent: boolean
  /** Can send bytes off the machine. */
  canEgress: boolean
}

export const NO_TRIFECTA: Readonly<TrifectaTags> = Object.freeze({
  readsPrivateData: false,
  ingestsUntrustedContent: false,
  canEgress: false,
})

/** The registry's coarse risk class for a tool. */
export type ToolRisk = 'safe' | 'external' | 'destructive'

/**
 * What the gate needs to know about the tool being called, independent of who is
 * calling it. Mirrors MCP `ToolAnnotations` plus clawboo's own risk class.
 *
 * NOTE the MCP rule, reproduced here: `destructive` and `idempotent` are
 * meaningful ONLY when `readOnly` is false. A read-only tool that also declares
 * `destructive: true` is a malformed manifest, and `requiredMode` resolves it in
 * favour of read-only rather than trusting the contradiction.
 */
export interface GrantToolFacts {
  name: string
  readOnly?: boolean
  destructive?: boolean
  idempotent?: boolean
  openWorld?: boolean
  risk?: ToolRisk
  trifecta?: TrifectaTags
  /**
   * Tools whose approval may never be remembered — money movement, external
   * send, credential grant. Forces `neverRemember` on the verdict so the UI does
   * not offer "Always".
   */
  neverRemember?: boolean
}

/**
 * The authorization edge. Field names mirror the `capability_grants` columns so a
 * row maps to this with no translation layer.
 */
export interface Grant {
  id: string
  subjectKind: 'agent' | 'team' | 'global'
  subjectId: string | null
  capabilityKind: 'connector' | 'tool' | 'skill'
  connectorId: string | null
  capabilityId: string | null
  /**
   * Tool-name globs this grant covers. THREE-STATE, and the distinction is
   * load-bearing:
   *   `['*']`      every tool (the column default)
   *   `[]`         NO tools — an explicit, meaningful "nothing"
   *   `['a','b*']` exactly this subset
   * Required rather than optional so a caller cannot accidentally collapse
   * "nothing" into "everything" by omitting it.
   */
  toolAllow: readonly string[]
  /** Evaluated AFTER `toolAllow`. Deny always wins. */
  toolDeny: readonly string[]
  mode: GrantMode
  approvalPolicy: ApprovalPolicy
  state: GrantState
  /** Epoch ms. Past ⇒ expired, regardless of `state`. */
  expiresAt: number | null
  /** What the human actually approved. A mismatch is drift, not a scope question. */
  specHashPin: string | null
  toolsHashPin: string | null
  callCeilingPerHour: number | null
}

/** A durable `allow_always` (or `deny`) recorded against one grant + tool. */
export interface StandingRule {
  id: string
  grantId: string
  toolName: string
  /**
   * Hash of the argument SHAPE this rule was approved for — key set plus a
   * value-scoping predicate for path/URL/host-shaped arguments, never the raw
   * values. `null` means "any arguments", which callers should only ever mint for
   * tools that have no scopable argument.
   */
  argsShape: string | null
  decision: 'allow' | 'deny'
  /** Epoch ms. Rules are minted with a mandatory expiry; a past one is inert. */
  expiresAt: number | null
}

export type GrantDenyReason =
  | 'no-grant'
  | 'grant-proposed'
  | 'grant-suspended'
  | 'grant-revoked'
  | 'grant-expired'
  | 'spec-drift'
  | 'tool-not-in-scope'
  | 'mode-insufficient'
  | 'rate-limited'
  | 'standing-deny'

export type GrantApprovalReason =
  | 'policy-always'
  | 'policy-writes'
  | 'risk-destructive'
  | 'risk-external'
  | 'lethal-trifecta'
  | 'tainted-run'
  | 'never-remembered'

export type GrantDecision =
  | { kind: 'allow'; grantId: string; ruleId?: string }
  | {
      kind: 'require_approval'
      grantId: string
      reason: GrantApprovalReason
      /** True ⇒ the UI must not offer "Always" for this call. */
      neverRemember: boolean
    }
  | { kind: 'deny'; grantId: string | null; reason: GrantDenyReason }

export interface GrantDecisionInput {
  /**
   * Every grant that could authorize this call — typically the agent-scoped one
   * plus any team/global ones. `decideGrant` picks the most specific.
   * Empty ⇒ `deny: no-grant`.
   */
  grants: readonly Grant[]
  tool: GrantToolFacts
  /** Live hashes to compare against the grant's pins. Null ⇒ nothing to compare. */
  currentSpecHash?: string | null
  currentToolsHash?: string | null
  /** Calls already made under the chosen grant inside the trailing hour. */
  callsInWindow?: number
  /** Standing rules for the chosen grant. Non-matching entries are ignored. */
  standingRules?: readonly StandingRule[]
  /** Hash of the call's argument shape, matched against `StandingRule.argsShape`. */
  argsShape?: string | null
  /**
   * Trifecta legs the RUN has already accumulated before this call. Unioned with
   * the tool's own legs — the chain is what matters, not one call.
   */
  runTrifecta?: TrifectaTags
  /** True once the run has ingested attacker-authorable content. */
  tainted?: boolean
  /** Epoch ms. Injected rather than read from the clock so the function is pure. */
  now: number
}
