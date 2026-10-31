// Tokens Used reads `cost_records`. OpenClaw's turns reach it from the session
// watcher, which reads them off OpenClaw's own transcripts (with the real token
// counts), so they are skipped here. Every other runtime is recorded here, one
// row per run, when the run's cost is settled: the task runner and team chat.

import { costRecords, type ClawbooDb } from '@clawboo/db'

export interface RunTokens {
  agentId: string
  runtime: string | null
  /** The model the run was priced at; the runtime id stands in when none is known. */
  model: string | null
  inputTokens: number
  outputTokens: number
  costUsd: number
  runId?: string | null
  sessionKey?: string | null
}

export function recordRunTokens(db: ClawbooDb, run: RunTokens): void {
  if (run.runtime === 'openclaw') return
  const inputTokens = Math.max(0, Math.round(run.inputTokens))
  const outputTokens = Math.max(0, Math.round(run.outputTokens))
  if (inputTokens + outputTokens === 0 && !(run.costUsd > 0)) return
  try {
    db.insert(costRecords)
      .values({
        agentId: run.agentId,
        model: run.model || run.runtime || 'unknown',
        inputTokens,
        outputTokens,
        costUsd: Math.max(0, run.costUsd),
        runId: run.runId ?? null,
        sessionKey: run.sessionKey ?? null,
        createdAt: Date.now(),
      })
      .run()
  } catch {
    // A report, never a reason to break a run. An agent with no registry row
    // fails the foreign key and is simply not listed.
  }
}
