// The ONE read the graph is allowed to use to render a grant.
//
// It exists so a badge cannot be computed by a second code path. `previewGrant`
// runs the SAME `decideGrant` the broker runs, over the SAME candidate rows, and
// reports its verdict. If the two ever disagree it is because their inputs
// differ, never because someone wrote a parallel `if (row.state === 'revoked')`
// somewhere in a renderer.
//
// WHAT A PREVIEW CAN AND CANNOT ANSWER. There is no tool at preview time, so the
// probe below is a minimal read-only tool. That exercises every GRANT-level
// verdict (revoked / suspended / expired / drift / rate-limited / no-grant) and
// deliberately none of the TOOL-level ones (`tool-not-in-scope`,
// `mode-insufficient`), which depend on which tool is being called and are not
// badge material. A tile that says "this grant is fine" is claiming the grant is
// live, never that every tool under it would pass.

import { decideGrant, type Grant, type GrantDenyReason, type GrantState } from '@clawboo/governance'

import { callsInWindow } from './rateWindow'

/**
 * A read-only, unclassified, trifecta-free stand-in.
 *
 * `readOnly: true` matters: `requiredMode` treats anything else as a write, so a
 * write-probe would report `mode-insufficient` on every read-mode grant.
 *
 * The NAME is never matched against anything, because every call below passes
 * `grantLevelOnly`, which skips scope and mode. It used to be `'*'` matched as a
 * literal tool name: `matchesGlob` treats `*` as special only on the PATTERN
 * side, so any grant narrower than `toolAllow: ['*']` denied the probe
 * `tool-not-in-scope`, a verdict `DENY_TO_STATE` has no entry for, and the
 * grantee's tile disappeared from the graph.
 */
const PROBE = { name: '(preview)', readOnly: true } as const

export interface GrantPreview {
  grantId: string
  /** What `decideGrant` says the grant IS, which can differ from `row.state`:
   *  an expired-but-unswept row previews as `expired` because the gate denies
   *  it, and that is the state the operator needs to see. */
  state: GrantState
  mode: Grant['mode']
  /** Set when the grant authorizes nothing right now. */
  denyReason: GrantDenyReason | null
}

/** Map a grant-level deny back to the lifecycle the operator recognises. */
const DENY_TO_STATE: Record<GrantDenyReason, GrantState> = {
  'grant-proposed': 'proposed',
  'grant-suspended': 'suspended',
  'grant-revoked': 'revoked',
  'grant-expired': 'expired',
  // Drift and a hit ceiling are not lifecycle transitions: the grant is still
  // active, it just is not authorizing anything at this instant.
  'spec-drift': 'active',
  'rate-limited': 'active',
  // TOTAL rather than Partial, and the two below are why. They are tool-level
  // verdicts that `grantLevelOnly` now prevents, but a `Partial` map let any
  // unmapped reason fall silently through to the row's own state, which reads as
  // a healthy grant while `denyReason` is set and the renderer drops the edge.
  // Making the map total means adding a deny reason forces a decision here.
  'tool-not-in-scope': 'active',
  'mode-insufficient': 'active',
  'no-grant': 'revoked',
  'standing-deny': 'active',
}

export interface PreviewInput {
  grants: readonly Grant[]
  /** Live hashes, so a preview can report drift the gate would also report.
   *  Null means nothing to compare, and `decideGrant` skips the drift check. */
  currentSpecHash?: string | null
  currentToolsHash?: string | null
  now: number
}

/** The verdict for the most specific candidate grant, or null when there is none. */
export function previewGrant(input: PreviewInput): GrantPreview | null {
  if (input.grants.length === 0) return null

  // Two passes, and only because `decideGrant` picks the grant internally: the
  // first learns WHICH grant it chose so the rate window can be read for that
  // grant, the second decides with the count in hand.
  const first = decideGrant({
    grants: input.grants,
    tool: PROBE,
    grantLevelOnly: true,
    now: input.now,
  })
  if (first.grantId === null) return null

  const decision = decideGrant({
    grants: input.grants,
    tool: PROBE,
    grantLevelOnly: true,
    currentSpecHash: input.currentSpecHash ?? null,
    currentToolsHash: input.currentToolsHash ?? null,
    callsInWindow: callsInWindow(first.grantId, input.now),
    now: input.now,
  })

  const chosen = input.grants.find((g) => g.id === decision.grantId) ?? null
  if (!chosen || decision.grantId === null) return null

  const denyReason = decision.kind === 'deny' ? decision.reason : null
  return {
    grantId: decision.grantId,
    state: denyReason ? DENY_TO_STATE[denyReason] : 'active',
    mode: chosen.mode,
    denyReason,
  }
}
