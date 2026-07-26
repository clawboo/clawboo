// Code-based graders — fast, cheap, objective, reproducible. They inspect the
// OUTCOME (the board's final state + the event log) rather than the transcript's
// claim of success. Prefer these wherever the success criterion is mechanical.

import { getReadyTasks, getTask, listEvents } from '@clawboo/db'
import type { OrchestrationEventKind } from '@clawboo/obs'

import type { EvalContext, Grader, GraderResult, TrialOutcome } from '../types'

function ok(name: string, passed: boolean, detail?: string): GraderResult {
  return { name, passed, score: passed ? 1 : 0, detail }
}

/** A taskId given either statically OR resolved from the trial OUTCOME — the latter
 *  lets these graders target a task the run creates with a dynamic id (o.data.taskId),
 *  which is how every task in this harness builds its board. */
type TaskRef = string | ((o: TrialOutcome) => string)
function refId(ref: TaskRef, o: TrialOutcome): string {
  return typeof ref === 'function' ? ref(o) : ref
}

/** The board task reached one of the expected terminal/intermediate states. `label`
 *  keeps the report name human-readable when the id is dynamic. */
export function boardStateGrader(task: TaskRef, expectStatus: string[], label?: string): Grader {
  return (ctx: EvalContext, outcome: TrialOutcome): GraderResult => {
    const id = refId(task, outcome)
    const t = getTask(ctx.db, id)
    const status = t?.status ?? 'missing'
    return ok(
      label ?? `board:${id}`,
      expectStatus.includes(status),
      `status=${status}, expected ${expectStatus.join('|')}`,
    )
  }
}

/** A specific orchestration event was recorded at least `minCount` times. Reads the
 *  obs event log, so it only has signal on a run that EMITS orchestration events —
 *  the board CRUD used by these tasks does not. It activates when the harness grades
 *  a real event-emitting run (the deferred live path); kept as that wiring seam. */
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

/** A task is (not) in the ready set — the dep gate works. Accepts a static id or an
 *  outcome-resolved one; `label` keeps the report name readable. */
export function readyGrader(
  task: TaskRef,
  shouldBeReady: boolean,
  teamId?: string,
  label?: string,
): Grader {
  return (ctx: EvalContext, outcome: TrialOutcome): GraderResult => {
    const id = refId(task, outcome)
    const ready = getReadyTasks(ctx.db, teamId ? { teamId } : {}).some((t) => t.id === id)
    return ok(
      label ?? `ready:${id}`,
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

/** Transcript-style metric bound (e.g. number of recorded events ≤ a budget). Like
 *  logParseGrader it reads the obs event log, so it only has signal on an
 *  event-emitting run — the seam for the deferred live path. */
export function eventBudgetGrader(maxEvents: number, filter?: { taskId?: string }): Grader {
  return (ctx: EvalContext): GraderResult => {
    const n = listEvents(ctx.db, { taskId: filter?.taskId, limit: 5000 }).length
    return ok('event-budget', n <= maxEvents, `${n} <= ${maxEvents}`)
  }
}
