// The eval runner — runs each task K times from a CLEAN environment (trial
// isolation: leftover state causes correlated failures, so every trial gets a
// fresh board), grades the OUTCOME, and reports pass@1 (≥1 success) AND pass^k
// (all k succeed). pass@1 rises with k, pass^k falls — use pass^k for the
// production-readiness bar.

import type { EvalTask, EvalContext, GraderResult, SuiteReport, TaskReport, Trial } from './types'

export interface RunOptions {
  /** Trials per task (K). Default 1 (smoke); the nightly uses ≥3. */
  trials?: number
  /** The exponent for pass^k. Defaults to `trials`. */
  k?: number
}

function gradeTrial(task: EvalTask, results: GraderResult[]): { passed: boolean; score: number } {
  const mean = results.length ? results.reduce((s, g) => s + g.score, 0) / results.length : 0
  if ((task.scoring ?? 'binary') === 'weighted') {
    return { passed: mean >= (task.threshold ?? 0.7), score: mean }
  }
  return { passed: results.length > 0 && results.every((g) => g.passed), score: mean }
}

/** Run one task K times against a fresh ctx each trial. `makeCtx` MUST build a
 *  clean environment (its own throwaway board) so trials are independent. */
export async function runTask(
  task: EvalTask,
  makeCtx: () => Promise<EvalContext>,
  opts: RunOptions = {},
): Promise<TaskReport> {
  const K = Math.max(1, opts.trials ?? 1)
  const trials: Trial[] = []
  for (let i = 0; i < K; i += 1) {
    const ctx = await makeCtx()
    let graderResults: GraderResult[] = []
    try {
      const outcome = await task.run(ctx)
      for (const g of task.graders) graderResults.push(await g(ctx, outcome))
    } catch (err) {
      graderResults = [{ name: 'run-error', passed: false, score: 0, detail: String(err) }]
    }
    const { passed, score } = gradeTrial(task, graderResults)
    trials.push({ taskId: task.id, passed, score, graders: graderResults })
  }
  const passes = trials.filter((t) => t.passed).length
  const passAt1 = trials.length ? passes / trials.length : 0
  const k = opts.k ?? K
  return {
    taskId: task.id,
    suite: task.suite,
    kind: task.kind,
    trials,
    passAt1,
    passPowK: Math.pow(passAt1, k),
    meanScore: trials.length ? trials.reduce((s, t) => s + t.score, 0) / trials.length : 0,
  }
}

export async function runSuite(
  tasks: EvalTask[],
  makeCtx: () => Promise<EvalContext>,
  opts: RunOptions = {},
): Promise<SuiteReport> {
  const reports: TaskReport[] = []
  for (const t of tasks) reports.push(await runTask(t, makeCtx, opts))
  const k = opts.k ?? opts.trials ?? 1
  const passAt1 = reports.length ? reports.reduce((s, r) => s + r.passAt1, 0) / reports.length : 0
  const passPowK = reports.length ? reports.reduce((s, r) => s + r.passPowK, 0) / reports.length : 0
  return { tasks: reports, passAt1, passPowK, k }
}
