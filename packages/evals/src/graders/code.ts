// Code-based graders — fast, cheap, objective, reproducible. They inspect the
// OUTCOME (the board's final state + the event log) rather than the transcript's
// claim of success. Prefer these wherever the success criterion is mechanical.

import { getReadyTasks, getTask, listEvents } from '@clawboo/db'
import type { OrchestrationEventKind } from '@clawboo/obs'

import type { EvalContext, Grader, GraderResult, TrialOutcome } from '../types'

function ok(name: string, passed: boolean, detail?: string): GraderResult {
  return { name, passed, score: passed ? 1 : 0, detail }
}

/** The board task reached one of the expected terminal/intermediate states. */
export function boardStateGrader(taskId: string, expectStatus: string[]): Grader {
  return (ctx: EvalContext): GraderResult => {
    const t = getTask(ctx.db, taskId)
    const status = t?.status ?? 'missing'
    return ok(
      `board:${taskId}`,
      expectStatus.includes(status),
      `status=${status}, expected ${expectStatus.join('|')}`,
    )
  }
}

/** A specific orchestration event was recorded at least `minCount` times. */
export function logParseGrader(
  kind: OrchestrationEventKind,
  minCount = 1,
  filter?: { taskId?: string },
): Grader {
  return (ctx: EvalContext): GraderResult => {
    const n = listEvents(ctx.db, { kinds: [kind], taskId: filter?.taskId, limit: 1000 }).length
    return ok(`log:${kind}`, n >= minCount, `${n} >= ${minCount}`)
  }
}

/** A task is (not) in the ready set — the dep gate works. */
export function readyGrader(taskId: string, shouldBeReady: boolean, teamId?: string): Grader {
  return (ctx: EvalContext): GraderResult => {
    const ready = getReadyTasks(ctx.db, teamId ? { teamId } : {}).some((t) => t.id === taskId)
    return ok(
      `ready:${taskId}`,
      ready === shouldBeReady,
      `ready=${ready}, expected ${shouldBeReady}`,
    )
  }
}

/** A free-form outcome predicate (with optional partial credit). */
export function outcomeGrader(
  name: string,
  predicate: (o: TrialOutcome, ctx: EvalContext) => boolean | number,
): Grader {
  return (ctx: EvalContext, outcome: TrialOutcome): GraderResult => {
    const r = predicate(outcome, ctx)
    const score = typeof r === 'number' ? Math.max(0, Math.min(1, r)) : r ? 1 : 0
    return { name, passed: score >= 1, score }
  }
}

/** Transcript-style metric bound (e.g. number of recorded events ≤ a budget). */
export function eventBudgetGrader(maxEvents: number, filter?: { taskId?: string }): Grader {
  return (ctx: EvalContext): GraderResult => {
    const n = listEvents(ctx.db, { taskId: filter?.taskId, limit: 5000 }).length
    return ok('event-budget', n <= maxEvents, `${n} <= ${maxEvents}`)
  }
}
