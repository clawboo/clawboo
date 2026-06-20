// The breaker reducer. Inherently STATEFUL (counters across a run's event stream),
// so unlike the stateless cap predicates this is a deterministic step function
// over run-local state: no I/O, no wall-clock read (every timestamp arrives on the
// signal), no Math.random. `stepBreaker` mutates the passed state — a run-local
// accumulator, exactly like the executor loop's `nodeSpentCents` — and returns the
// FIRST trip it sees, or null. The caller derives `BreakerSignal`s from the typed
// RuntimeEvent stream (tool-call / tool-result / cost / a typed denial code),
// NEVER from rendered prose.

import { BREAKER_DEFAULTS, type BreakerConfig } from './policy'
import type { BreakerTrip, BreakerTripReason } from './schema'

/** A normalized observation derived from one typed RuntimeEvent. */
export interface BreakerSignal {
  kind: 'tool-call' | 'tool-result' | 'cost' | 'policy-denied'
  /** Event timestamp (ms). The machine never reads the clock — time arrives here. */
  ts: number
  /** tool-call / tool-result / policy-denied: a stable identity string (see
   *  {@link toolSignature}); for policy-denied, the denial code itself. */
  signature?: string
  /** tool-result: whether the call SUCCEEDED. */
  ok?: boolean
  /** cost: total tokens (input + output) reported by this event. */
  tokens?: number
}

export interface BreakerState {
  readonly config: BreakerConfig
  toolIterations: number
  consecFailures: number
  lastFailSig: string | null
  productiveSigs: Set<string>
  nonProductive: number
  consecDenials: number
  lastDenialSig: string | null
  windowStartTs: number | null
  windowTokens: number
}

export function createBreakerState(config?: Partial<BreakerConfig>): BreakerState {
  return {
    config: { ...BREAKER_DEFAULTS, ...config },
    toolIterations: 0,
    consecFailures: 0,
    lastFailSig: null,
    productiveSigs: new Set<string>(),
    nonProductive: 0,
    consecDenials: 0,
    lastDenialSig: null,
    windowStartTs: null,
    windowTokens: 0,
  }
}

function trip(reason: BreakerTripReason, detail: string, s: BreakerState): BreakerTrip {
  return {
    reason,
    detail,
    counters: {
      toolIterations: s.toolIterations,
      consecFailures: s.consecFailures,
      nonProductive: s.nonProductive,
      consecDenials: s.consecDenials,
      windowTokens: s.windowTokens,
    },
  }
}

export function stepBreaker(state: BreakerState, signal: BreakerSignal): BreakerTrip | null {
  const c = state.config
  switch (signal.kind) {
    case 'tool-call': {
      state.toolIterations += 1
      if (state.toolIterations > c.maxToolIterations) {
        return trip(
          'iteration-cap',
          `reached ${state.toolIterations} tool calls (cap ${c.maxToolIterations}).`,
          state,
        )
      }
      return null
    }
    case 'tool-result': {
      const sig = signal.signature ?? ''
      const ok = signal.ok === true
      // Repeat-failure: the SAME failing signature N times in a row.
      if (!ok) {
        if (sig === state.lastFailSig) state.consecFailures += 1
        else {
          state.lastFailSig = sig
          state.consecFailures = 1
        }
        if (state.consecFailures >= c.repeatFailureThreshold) {
          return trip(
            'repeat-failure',
            `tool ${sig} failed ${state.consecFailures}x in a row.`,
            state,
          )
        }
      } else {
        state.lastFailSig = null
        state.consecFailures = 0
      }
      // No-progress: only FAILURES / empty results advance the stall counter. A
      // successful NEW signature is progress (reset). A successful REPEAT of an
      // already-seen tool is NEUTRAL — a healthy run legitimately re-reads the
      // same file/config while reasoning, so counting that as no-progress would
      // false-abort it. A genuinely stuck loop (repeated failures, or alternating
      // failures that never produce new successful output) still trips.
      if (ok && !state.productiveSigs.has(sig)) {
        state.productiveSigs.add(sig)
        state.nonProductive = 0
      } else if (!ok) {
        state.nonProductive += 1
        if (state.nonProductive >= c.noProgressThreshold) {
          return trip(
            'no-progress',
            `${state.nonProductive} tool results with no new successful output.`,
            state,
          )
        }
      }
      return null
    }
    case 'cost': {
      // Velocity needs ≥2 cost events spanning at least `velocityMinWindowMs` (the
      // first sets the window start, so elapsedMs is 0 on it). This is reachable on
      // runtimes that emit cost PER TURN (the native harness) and across rotations;
      // a wrapped-oneshot adapter (Claude Code / Codex / Hermes) emits exactly ONE
      // cost event per run, so for those this is a multi-rotation backstop, never an
      // in-run trip. NOT a fight with a runtime's own max-turns — a coarse runaway net.
      if (state.windowStartTs === null) state.windowStartTs = signal.ts
      state.windowTokens += signal.tokens ?? 0
      const elapsedMs = signal.ts - state.windowStartTs
      if (elapsedMs >= c.velocityMinWindowMs && elapsedMs > 0) {
        const perMin = (state.windowTokens / elapsedMs) * 60_000
        if (perMin > c.tokenVelocityCeiling) {
          return trip(
            'token-velocity',
            `${Math.round(perMin)} tokens/min exceeds ceiling ${c.tokenVelocityCeiling}.`,
            state,
          )
        }
      }
      return null
    }
    case 'policy-denied': {
      // Trips on `repeatPolicyDeniedThreshold` CONSECUTIVE denials carrying the
      // same SIGNATURE — the typed RuntimeEvent error `code`, NEVER scraped prose.
      // A runtime may emit a CONSTANT denial code (the native harness uses
      // `policy_denied` for every broker denial, with the specific reason in the
      // message), so for such a runtime this trips on ANY N consecutive denials
      // regardless of the underlying tool/reason. That is intentional: a rapid run
      // of policy denials is a "fighting the guardrails" signal worth a fast
      // backstop, and keying the signature on the reason prose would both violate
      // the no-prose-as-control-signal rule AND weaken the backstop (alternating
      // reasons would never trip). The reason still surfaces in the audit/comment.
      const sig = signal.signature ?? ''
      if (sig === state.lastDenialSig) state.consecDenials += 1
      else {
        state.lastDenialSig = sig
        state.consecDenials = 1
      }
      if (state.consecDenials >= c.repeatPolicyDeniedThreshold) {
        return trip(
          'repeat-policy-denied',
          `policy denied (${sig}) ${state.consecDenials}x in a row.`,
          state,
        )
      }
      return null
    }
    default:
      return null
  }
}

// ─── Pure helpers the caller uses to build signals from typed RuntimeEvents ─────

function fnv1a(str: string): number {
  let h = 0x811c9dc5
  for (let i = 0; i < str.length; i += 1) {
    h ^= str.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return h >>> 0
}

/** Stable identity for a tool call: name + a hash of its (typed) input. Compared
 *  as a string by the reducer; computed from typed fields, never scraped prose. */
export function toolSignature(name: string, input: unknown): string {
  let inputPart: string
  try {
    inputPart = JSON.stringify(input) ?? 'null'
  } catch {
    inputPart = '' // circular / unserializable → name-only signature
  }
  return `${name}:${fnv1a(inputPart).toString(16)}`
}

// A small allowlist of typed error CODES that denote a policy/permission denial.
// Keyed on the RuntimeEvent `error.code` field exactly — NOT a regex over the
// message prose. Inert (returns false) if a runtime never emits such a code.
const DENIAL_CODES: ReadonlySet<string> = new Set([
  'policy_denied',
  'permission_denied',
  'denied',
  'forbidden',
  'unauthorized',
  'eperm',
  'eacces',
])

export function isPolicyDenialCode(code: string | null | undefined): boolean {
  if (!code) return false
  return DENIAL_CODES.has(code.toLowerCase())
}
