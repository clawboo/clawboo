import { z } from 'zod'

// ─── Typed verification evidence ─────────────────────────────────────────────
// Verdicts are TYPED (zod), never prose — the board state machine and the UI
// consume them mechanically. A generator never self-certifies: the deterministic
// gate (exit code) and the read-only critic (structured findings) are the only
// inputs to "done".

/**
 * Severity taxonomy. The first five are BLOCKING (a fix must route back); the
 * rest are debt (recorded, never deadlocking). Matches the rationed-blocking
 * rule: block only for security / crash / data-loss / wrong-algorithm /
 * missing-acceptance-criteria — not style or perf nits.
 */
export const severitySchema = z.enum([
  'security',
  'crash',
  'data_loss',
  'wrong_algorithm',
  'missing_ac',
  'style',
  'perf',
  'other',
])
export type Severity = z.infer<typeof severitySchema>

/** One critic finding. `body`/`filePath`/`startLine`/`confidence` default so a
 *  terse model output still parses. */
export const findingSchema = z.object({
  severity: severitySchema,
  title: z.string().min(1),
  body: z.string().default(''),
  filePath: z.string().nullable().default(null),
  startLine: z.number().int().nullable().default(null),
  confidence: z.number().min(0).max(1).default(0.5),
})
export type Finding = z.infer<typeof findingSchema>

/** Result of the deterministic gate — the strongest signal (an exit code, not a
 *  judgement). `passed` is the gate's truth; the tails are scrubbed evidence. */
export const deterministicResultSchema = z.object({
  command: z.string(),
  exitCode: z.number().int().nullable(),
  passed: z.boolean(),
  stdoutTail: z.string().default(''),
  stderrTail: z.string().default(''),
  durationMs: z.number().int().nonnegative(),
  timedOut: z.boolean().default(false),
})
export type DeterministicResult = z.infer<typeof deterministicResultSchema>

/** What a reviewer model is asked to emit (just findings) — parsed from the
 *  extracted JSON block before being wrapped into a full {@link CriticVerdict}. */
export const criticOutputSchema = z.object({
  findings: z.array(findingSchema).default([]),
})
export type CriticOutput = z.infer<typeof criticOutputSchema>

/** The stored critic verdict. `ran:false` ⇒ the critic was not triggered (small,
 *  low-risk diff) — no worktree, no model spend. */
export const criticVerdictSchema = z.object({
  ran: z.boolean(),
  findings: z.array(findingSchema).default([]),
  reviewerRuntime: z.string().nullable().default(null),
  // The model the reviewer ran on. Surfaced so a same-model review's bias caveat
  // is visible: independence here is context-level (a fresh session, a detached
  // push-less worktree, no builder homeDir) PLUS — when an operator sets a
  // distinct reviewer model — model-level. `null` = critic not run / unknown.
  reviewerModel: z.string().nullable().default(null),
  reviewedSha: z.string().nullable().default(null),
})
export type CriticVerdict = z.infer<typeof criticVerdictSchema>

/** A structured, actionable failure routed back to the specialist — not "FAIL". */
export const structuredErrorSchema = z.object({
  what: z.string(),
  why: z.string(),
  howToFix: z.string(),
})
export type StructuredError = z.infer<typeof structuredErrorSchema>

export const verificationStatusSchema = z.enum(['pass', 'fail', 'completed_with_debt'])
export type VerificationStatus = z.infer<typeof verificationStatusSchema>

/** One verify-fix attempt. The attempts array IS the loop history. */
export const verificationAttemptSchema = z.object({
  attempt: z.number().int().positive(),
  at: z.number().int(),
  deterministic: deterministicResultSchema,
  critic: criticVerdictSchema,
  status: verificationStatusSchema,
  structuredError: structuredErrorSchema.nullable().default(null),
})
export type VerificationAttempt = z.infer<typeof verificationAttemptSchema>

/** A signed-off, rationed-blocking gap carried when cycles are exhausted. */
export const debtNoteSchema = z.object({
  criterion: z.string(),
  severity: severitySchema,
  justification: z.string(),
})
export type DebtNote = z.infer<typeof debtNoteSchema>

/**
 * The full verification record stored on a task (one TEXT cell). `attempts`
 * carries the history, so the `in_review → done` gate is a single-row read.
 */
export const verificationResultSchema = z.object({
  status: verificationStatusSchema,
  attempts: z.array(verificationAttemptSchema).min(1),
  debtNotes: z.array(debtNoteSchema).default([]),
  updatedAt: z.number().int(),
})
export type VerificationResult = z.infer<typeof verificationResultSchema>
