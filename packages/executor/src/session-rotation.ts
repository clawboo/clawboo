// Session rotation — the last-resort, model-agnostic answer to "the session ran
// out of room before the task finished." Instead of failing the task and retrying
// from scratch, rotate: serialize the current session (best-effort), synthesize a
// short structured HANDOFF NOTE (decisions + last summary, never the raw
// transcript), spawn a SUCCESSOR run that starts from that note, and continue.
//
// Rotation happens at the RUN BOUNDARY, not mid-generation — clawboo's
// RuntimeAdapter owns the inner loop, so a run boundary is its unit of context
// assembly. The helper
// is PURE + runtime-agnostic + DB-free: it takes a `RuntimeAdapter`, a `restart`
// closure (the host re-assembles the prompt with the note + calls `adapter.start`),
// and an optional `recordRotation` callback (the host writes session lineage +
// emits an obs event). The future native runtime imports this verbatim.

import type { RunHandle, RuntimeAdapter } from './types'

/** Token-budget watermark trigger. A proactive signal a runtime that can observe
 *  its own token accumulation (the native runtime) checks mid-run; the executor
 *  also evaluates it at the run boundary against the last run's usage. */
export interface RotationTrigger {
  /** Tokens consumed by the current session (input + output). */
  tokensUsed: number
  /** The runtime's context window in tokens (0/unknown disables the watermark). */
  contextWindow: number
  /** Fraction of the window at which to rotate (e.g. 0.85). */
  thresholdPct: number
}

/**
 * True when the session has consumed `thresholdPct` of its context window. A
 * non-positive `contextWindow` (the runtime doesn't report one) disables the
 * watermark so rotation only fires on an explicit `max_turns` signal — keeping
 * runtimes that don't expose a window byte-identical to pre-rotation behavior.
 */
export function shouldRotate(t: RotationTrigger): boolean {
  if (t.contextWindow <= 0) return false
  if (t.thresholdPct <= 0) return false
  return t.tokensUsed / t.contextWindow >= t.thresholdPct
}

/**
 * The structured rotation handoff. Data, not prose — mirrors the spirit of
 * `AGENT_HANDOFF.json` (clawboo's cross-runtime worktree handoff): carry the
 * minimum continuity (what happened, why we rotated, where to resume), never the
 * full transcript. The successor rebuilds only the context it needs.
 */
export interface RotationHandoff {
  taskId: string
  /** The predecessor session's stream key (clawboo's sessionKey). */
  predecessorSessionKey: string
  /** The predecessor's runtime session id, if the codec captured one. */
  predecessorSessionId: string | null
  /** Why we rotated. */
  reason: 'max_turns' | 'context_watermark'
  /** A concise summary of the predecessor's last output (the report-up). */
  lastSummary: string
  /** Tokens the predecessor consumed (for the note + obs). */
  tokensUsed: number
  /** 1-based index of this rotation within the task's run chain. */
  rotationIndex: number
}

/**
 * Render the handoff note threaded into the successor's prompt. Deliberately
 * short: name the continuity, then tell the successor to pull only the context
 * it actually needs rather than replay the transcript.
 */
export function buildRotationHandoffNote(h: RotationHandoff): string {
  const lines = [
    'Session handoff (rotation): the previous session reached its context limit.',
    `- Reason: ${h.reason}`,
    `- Rotation: #${h.rotationIndex}`,
    h.lastSummary ? `- Last progress: ${h.lastSummary}` : '',
    'Pick the task up from its current state; pull in only the context you actually need instead of replaying the full history.',
  ]
  return lines.filter(Boolean).join('\n')
}

/** Injected side-effects so the helper stays DB-free + runtime-agnostic. */
export interface RotateSessionOpts {
  adapter: RuntimeAdapter
  /** The run that exhausted its room. */
  current: RunHandle
  handoff: RotationHandoff
  /**
   * Start the successor. The host re-assembles the prompt with the handoff note
   * (into the volatile/context tier) and calls `adapter.start`, returning the new
   * run handle. Receives the rendered note so the host doesn't re-derive it.
   */
  restart: (handoffNote: string) => Promise<RunHandle>
  /**
   * Persist lineage / emit observability (best-effort). `serialized` is the
   * predecessor's codec blob (null when the adapter has no `sessionCodec` or
   * serialize failed).
   */
  recordRotation?: (info: {
    serialized: string | null
    handoff: RotationHandoff
    successor: RunHandle
  }) => Promise<void> | void
}

/**
 * Rotate to a fresh successor session. Serializes the predecessor (best-effort;
 * a failed/absent codec is non-fatal — continuity rides the handoff note, not the
 * blob), renders the note, restarts, then records lineage. Returns the successor
 * `RunHandle` for the caller's drive loop to continue with.
 */
export async function rotateSession(opts: RotateSessionOpts): Promise<RunHandle> {
  const { adapter, current, handoff, restart, recordRotation } = opts

  let serialized: string | null = null
  if (adapter.sessionCodec) {
    try {
      serialized = await adapter.sessionCodec.serialize(current)
    } catch {
      serialized = null
    }
  }

  const note = buildRotationHandoffNote(handoff)
  const successor = await restart(note)

  if (recordRotation) {
    try {
      await recordRotation({ serialized, handoff, successor })
    } catch {
      /* lineage/obs is best-effort; never fail the rotation on a record error */
    }
  }

  return successor
}

/** Conservative defaults. `maxRotations` bounds the successor chain per task so a
 *  pathological loop can't spawn unbounded sessions. */
export const DEFAULT_ROTATION = {
  thresholdPct: 0.85,
  maxRotations: 3,
} as const
