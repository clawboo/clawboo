import { z } from 'zod'

// Zod bodies for the governance REST surface (mirrors the board's schemas.ts).

export const budgetScopeSchema = z.enum(['agent', 'mission', 'team', 'tenant'])

/** Budget posture: 'cap' auto-pauses at 100%; 'warn' (track-and-warn) only warns. */
export const budgetModeSchema = z.enum(['cap', 'warn'])

export const setBudgetBody = z.object({
  scope: budgetScopeSchema,
  scopeId: z.string().min(1),
  // A cap of 0 most naturally means "may not spend anything" (a hard stop), which
  // is confusing as a row that never pauses — so reject it: a budget row is a real
  // positive cap, and UNCAPPED is the absence of a row (null), not a 0 limit.
  limitUsdCents: z.number().int().positive(),
  mode: budgetModeSchema.optional(),
  tenantId: z.string().nullable().optional(),
})

export const resumeBudgetBody = z.object({
  /** Optional headroom (cents) to grant on resume when the scope is still
   *  at/over its limit, so the run can actually make progress. */
  graceUsdCents: z.number().int().positive().optional(),
})
export type SetBudgetBody = z.infer<typeof setBudgetBody>
