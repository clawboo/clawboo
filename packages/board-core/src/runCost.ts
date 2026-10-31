// ─── What a task's runs cost ────────────────────────────────────────────────
// The execution ledger is the source of truth for cost: each run records what it
// cost on its own row, with where that number came from. A task's cost is the sum
// of its runs, and it reads as an estimate unless every run that recorded a cost
// was priced by the runtime itself or ran on a local model.
//
// Pure and import-free, so the server that sums the ledger and the board UI that
// renders the result agree by construction.

/** How a run's cost was obtained, most trustworthy first. 'local' is a run on a
 *  model the user's own Ollama served: it costs nothing, so its $0 is exact. */
export const RUN_COST_SOURCES = ['reported', 'local', 'token-estimate', 'char-estimate'] as const

export type RunCostSource = (typeof RUN_COST_SOURCES)[number]

export interface TaskRunCost {
  /** Total USD across the task's runs, or null when no run recorded a cost. */
  usd: number | null
  /** True when any part of `usd` is an estimate rather than a runtime-reported cost. */
  estimated: boolean
  /** True when every run that recorded a cost ran on a local model, so the task was free. */
  local?: boolean | undefined
}

/** One run's ledger fields, as the execution row stores them. */
export interface RunCostRow {
  costUsd?: number | null
  costSource?: string | null
}

/**
 * Sum a task's run costs. A run counts only when its `costUsd` is a finite number,
 * so a tombstone or a run that never priced itself adds nothing. Any counted run
 * whose source is neither 'reported' nor 'local' makes the total an estimate: a
 * null or unknown source is one we cannot vouch for.
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
  let local = true
  for (const run of runs) {
    const cost = run.costUsd
    if (typeof cost !== 'number' || !Number.isFinite(cost)) continue
    costed++
    usd += cost
    if (run.costSource !== 'local') local = false
    if (run.costSource !== 'reported' && run.costSource !== 'local') estimated = true
  }
  if (costed > 0) return local ? { usd, estimated, local } : { usd, estimated }
  if (typeof taskCostUsd === 'number' && Number.isFinite(taskCostUsd) && taskCostUsd > 0) {
    return { usd: taskCostUsd, estimated: true }
  }
  return { usd: null, estimated: false }
}
