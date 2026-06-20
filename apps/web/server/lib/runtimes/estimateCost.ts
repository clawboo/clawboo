// Estimated USD for a runtime run when no provider/Gateway usage is reported — the
// connected-substrate case (OpenClaw's Gateway sends no token usage) and any
// runtime turn that produces only text. Token counts are approximated from
// character length (the ~4-chars/token heuristic the dashboard already uses for
// its display) and priced via the shared model table. The result is an ESTIMATE
// used only to keep a budget ledger moving and a cap engaged where the runtime
// gives us nothing real — it is never presented as an exact charge.

import { calculateCostUsd } from '../costUtils'

const CHARS_PER_TOKEN = 4

/** Approximate token count from a character length (ceil, floored at 0). */
export function estimateTokensFromChars(chars: number): number {
  return Math.max(0, Math.ceil(Math.max(0, chars) / CHARS_PER_TOKEN))
}

export interface EstimateRunCostInput {
  /** Best-known model id; unknown/empty falls back to the shared default pricing. */
  model?: string | null
  inputChars: number
  outputChars: number
}

export function estimateRunCostUsd(input: EstimateRunCostInput): number {
  const inputTokens = estimateTokensFromChars(input.inputChars)
  const outputTokens = estimateTokensFromChars(input.outputChars)
  return calculateCostUsd(input.model ?? 'default', inputTokens, outputTokens)
}

export interface EstimateFromUsageInput {
  /** Best-known model id; unpriced/empty falls back to the shared default rate. */
  model?: string | null
  inputTokens: number
  outputTokens: number
}

/**
 * Estimate USD from EXACT token usage × the model rate — for runtimes that report
 * usage but no USD (Codex / Hermes / unpinned-native). The token counts are exact
 * (no char→token guess), so this is more accurate than `estimateRunCostUsd`; the
 * RATE falls back to the shared default for an unpriced model — which over- rather
 * than under-estimates, the safe direction for a cap. Deliberately uses
 * `calculateCostUsd` (with its default fallback) rather than `native/pricing.ts`
 * (which returns null for unknown models): the result is marked `estimated` by the
 * caller and used only to engage a budget cap, never presented as an exact charge.
 */
export function estimateRunCostUsdFromUsage(input: EstimateFromUsageInput): number {
  return calculateCostUsd(
    input.model ?? 'default',
    Math.max(0, input.inputTokens),
    Math.max(0, input.outputTokens),
  )
}
