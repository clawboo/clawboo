// Capability-driven graceful degradation. A runtime advertises what it can do
// via `capabilities()`; the runner consults this plan to fill the gaps in CODE
// (never by assuming): no native resume → carry state across runs via the
// worktree handoff (the per-task system-of-record); no native tool approval → route
// risky tools through clawboo's own approval gate; no token stream → expect
// coarse, block-level updates. Pure + unit-tested.

import type { Capabilities } from '@clawboo/executor'

export interface DegradationPlan {
  /** Runtime can't resume its own session → resume via the worktree handoff. */
  resumeViaHandoff: boolean
  /** Runtime has no native tool approval → gate risky tools through clawboo. */
  routeApprovalsThroughClawboo: boolean
  /** Runtime doesn't stream tokens → expect coarse, block-level progress. */
  coarseStreaming: boolean
}

export function planDegradations(caps: Capabilities): DegradationPlan {
  return {
    resumeViaHandoff: !caps.resume,
    routeApprovalsThroughClawboo: !caps.toolApproval,
    coarseStreaming: !caps.streaming,
  }
}

/** Human-readable notes for the execution record / a board comment. */
export function describeDegradations(plan: DegradationPlan): string[] {
  const notes: string[] = []
  if (plan.resumeViaHandoff) notes.push('resume-via-handoff (no native resume)')
  if (plan.routeApprovalsThroughClawboo)
    notes.push('approvals-via-clawboo (no native tool approval)')
  if (plan.coarseStreaming) notes.push('coarse-streaming (no native token stream)')
  return notes
}
