// How the board shows what a task cost. The server sums the task's run ledger into
// `runCost` (see @clawboo/board-core's summarizeRunCost); this file only formats
// it, so the card and the drawer can never disagree on the figure or its marker.

import { summarizeRunCost, type TaskRunCost } from '@clawboo/board-core'

import type { BoardTask } from '@/lib/boardClient'

/** Cost label that never rounds a real sub-cent charge to a misleading $0.000: a
 *  sub-cent cost shows 4 decimals ($0.0004), ≥1¢ shows cents ($0.42), exactly 0 → $0.000. */
export function formatCostUsd(c: number): string {
  if (c === 0) return '$0.000'
  if (c < 0.01) return `$${c.toFixed(4)}`
  return `$${c.toFixed(2)}`
}

/** A recorded run cost as the board shows it. An estimate (the runtime reported no
 *  charge, so Clawboo priced the run itself) reads `~$0.02 est.`. `precise` always
 *  shows four decimals, for the drawer. */
export function formatRunCost(
  usd: number,
  estimated: boolean,
  opts?: { precise?: boolean },
): string {
  const money = opts?.precise ? `$${usd.toFixed(4)}` : formatCostUsd(usd)
  return estimated ? `~${money} est.` : money
}

function isTaskRunCost(v: unknown): v is TaskRunCost {
  if (typeof v !== 'object' || v === null) return false
  const { usd, estimated } = v as Record<string, unknown>
  const usdOk = usd === null || (typeof usd === 'number' && Number.isFinite(usd))
  return usdOk && typeof estimated === 'boolean'
}

/** What a task's runs cost: the server's `runCost` when the task carries one, else
 *  the same rule applied to the task's own `costUsd` (a task from an older server,
 *  or one shown before the board's next read). `usd` is null when no run recorded
 *  a cost, and the board then shows none. */
export function runCostOf(task: BoardTask): TaskRunCost {
  const rc = task['runCost']
  if (isTaskRunCost(rc)) return rc
  const legacy = task['costUsd']
  return summarizeRunCost([], typeof legacy === 'number' ? legacy : null)
}
