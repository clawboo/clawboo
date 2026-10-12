// ─── What a task's runs cost ────────────────────────────────────────────────
// The execution ledger is the source of truth for cost: each run records what it
// cost on its own row, with where that number came from. A task's cost is the sum
// of its runs, and it reads as an estimate unless every run that recorded a cost
// was priced by the runtime itself.
//
// Pure and import-free, so the server that sums the ledger and the board UI that
// renders the result agree by construction.

/** How a run's cost was obtained, most trustworthy first. */
export const RUN_COST_SOURCES = ['reported', 'token-estimate', 'char-estimate'] as const

export type RunCostSource = (typeof RUN_COST_SOURCES)[number]

export interface TaskRunCost {
  /** Total USD across the task's runs, or null when no run recorded a cost. */
  usd: number | null
  /** True when any part of `usd` is an estimate rather than a runtime-reported cost. */
  estimated: boolean
}

/** One run's ledger fields, as the execution row stores them. */
export interface RunCostRow {
  costUsd?: number | null
  costSource?: string | null
}

/**
 * Sum a task's run costs. A run counts only when its `costUsd` is a finite number,
 * so a tombstone or a run that never priced itself adds nothing. Any counted run
 * whose source is not 'reported' makes the total an estimate: a null or unknown
 * source is one we cannot vouch for.
 *
 * `taskCostUsd` is the task's own column, read only when no run recorded a cost.
 * A positive value there predates per-run costs (it held the last run's figure),
 * so it is shown, as an estimate.
 */
export function summarizeRunCost(
  runs: ReadonlyArray<RunCostRow>,
  taskCostUsd?: number | null,
): TaskRunCost {
  let usd = 0
  let costed = 0
  let estimated = false
  for (const run of runs) {
    const cost = run.costUsd
    if (typeof cost !== 'number' || !Number.isFinite(cost)) continue
    costed++
    usd += cost
    if (run.costSource !== 'reported') estimated = true
  }
  if (costed > 0) return { usd, estimated }
  if (typeof taskCostUsd === 'number' && Number.isFinite(taskCostUsd) && taskCostUsd > 0) {
    return { usd: taskCostUsd, estimated: true }
  }
  return { usd: null, estimated: false }
}
