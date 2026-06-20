// Model-based grader (LLM-as-judge) — flexible, captures nuance, for the
// subjective dimensions code can't grade (coordination/handoff quality,
// groundedness). Reuses the SHARED structured-output judge drive from @clawboo/obs
// (the same one the read-only critic uses), with a way-out and one isolated judge
// per dimension. Non-deterministic + priced → the NIGHTLY set, never the PR smoke.

import type { RuntimeAdapter } from '@clawboo/executor'
import { buildJudgePrompt, driveStructuredJudge } from '@clawboo/obs'
import { z } from 'zod'

import type { EvalContext, Grader, TrialOutcome } from '../types'

const scoreSchema = z.object({ score: z.number().min(0).max(1), reason: z.string().optional() })

export interface LlmJudgeOptions {
  name: string
  /** The single dimension this judge scores (isolate one judge per dimension). */
  dimension: string
  rubric: string
  /** Build the reviewer runtime (the caller owns the adapter). */
  makeAdapter: () => RuntimeAdapter
  model?: string | null
  /** Passed when score ≥ threshold (default 0.6). */
  threshold?: number
}

export function llmJudgeGrader(opts: LlmJudgeOptions): Grader {
  return async (_ctx: EvalContext, outcome: TrialOutcome) => {
    const adapter = opts.makeAdapter()
    const prompt = buildJudgePrompt({
      task: outcome.summary ?? JSON.stringify(outcome.data ?? {}),
      shape: '{"score": 0.0, "reason": "..."}',
      rubric: `Dimension: ${opts.dimension}\n${opts.rubric}`,
      notes: ['score ∈ [0,1]: 1 = fully meets the dimension, 0 = fails it.'],
    })
    const drain = async (): Promise<string> => {
      const run = await adapter.start(
        { taskId: null, teamId: null },
        {
          agentId: 'judge',
          sessionKey: `judge:${opts.name}`,
          message: 'Evaluate the work.',
          model: opts.model ?? null,
          context: prompt,
        },
      )
      let text = ''
      for await (const ev of adapter.events(run)) {
        if (ev.kind === 'text-delta') {
          if (ev.channel !== 'reasoning') text += ev.text
        } else if (ev.kind === 'done') {
          if (ev.summary && ev.summary.length > text.length) text = ev.summary
          break
        } else if (ev.kind === 'error') {
          break
        }
      }
      return text
    }
    const judged = await driveStructuredJudge({ runText: drain, schema: scoreSchema })
    const score = judged.status === 'parsed' && judged.value ? judged.value.score : 0
    const threshold = opts.threshold ?? 0.6
    return { name: opts.name, passed: score >= threshold, score, detail: judged.value?.reason }
  }
}
