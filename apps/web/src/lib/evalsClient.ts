// Thin typed wrapper over the eval-smoke REST surface (apps/web/server/api/evalSmoke.ts).
// Defensive like `boardClient`/`memoryClient`: best-effort, resolves
// to null on network/parse/gate failure, never throws. The SPA never imports the
// server-only `@clawboo/evals` package, so the report shapes are mirrored locally
// here (they match `@clawboo/evals` `SuiteReport` / `TaskReport` and the
// `AblationScorecard` shape the scorecard renders).

const JSON_HEADERS = { 'Content-Type': 'application/json' } as const

export type EvalSuite = 'capability' | 'regression'
export type EvalKind = 'coding' | 'research' | 'coordination'

export interface TaskReport {
  taskId: string
  suite: EvalSuite
  kind: EvalKind
  passAt1: number
  passPowK: number
  meanScore: number
}

export interface SuiteReport {
  tasks: TaskReport[]
  passAt1: number
  passPowK: number
  k: number
}

// The ablation shape is rendered (explained, nightly-only) but never run on demand.
export interface AblationCell {
  variant: string
  flags: { verify: boolean; structuredState: boolean }
  passAt1: number
  passPowK: number
}
export interface AblationContribution {
  subsystem: 'verifier' | 'structured-state'
  deltaPassAt1: number
}
export interface AblationScorecard {
  baselinePassAt1: number
  cells: AblationCell[]
  contributions: AblationContribution[]
  trials: number
}

/** POST /api/eval/smoke — run the deterministic smoke suite, return a SuiteReport. */
export async function runSmokeEvals(opts: { trials?: number } = {}): Promise<SuiteReport | null> {
  try {
    const r = await fetch('/api/eval/smoke', {
      method: 'POST',
      headers: JSON_HEADERS,
      body: JSON.stringify(opts.trials ? { trials: opts.trials } : {}),
    })
    if (!r.ok) return null
    const body = (await r.json()) as Partial<SuiteReport>
    if (!Array.isArray(body.tasks)) return null
    return body as SuiteReport
  } catch {
    return null
  }
}
