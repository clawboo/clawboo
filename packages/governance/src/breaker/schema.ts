import { z } from 'zod'

// Partial breaker overrides accepted from a REST body / run input (each field
// optional → fall back to BREAKER_DEFAULTS). Mirrors how the orchestrator caps are
// passed inline rather than from a per-scope override table (a noted future seam).
export const breakerConfigSchema = z
  .object({
    maxToolIterations: z.number().int().positive(),
    repeatFailureThreshold: z.number().int().positive(),
    noProgressThreshold: z.number().int().positive(),
    tokenVelocityCeiling: z.number().int().positive(),
    velocityMinWindowMs: z.number().int().nonnegative(),
    repeatPolicyDeniedThreshold: z.number().int().positive(),
  })
  .partial()
export type BreakerConfigInput = z.infer<typeof breakerConfigSchema>

// Which breaker tripped — the machine-readable halt reason. Rides the execution
// `error` string as `circuit_broken:<reason>` and the `[stopped: <reason>]` board
// comment, so the leader (single reduce point) can re-plan.
export const breakerTripReasonSchema = z.enum([
  'iteration-cap',
  'repeat-failure',
  'no-progress',
  'token-velocity',
  'repeat-policy-denied',
])
export type BreakerTripReason = z.infer<typeof breakerTripReasonSchema>

// A breaker trip: the reason + a human-readable detail + a forensic counter
// snapshot (written to the governance audit row — never any tool I/O).
export interface BreakerTrip {
  reason: BreakerTripReason
  detail: string
  counters: Record<string, number>
}
