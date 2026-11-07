// The rules behind waking a task's agent: which comment may wake, what counts as
// visible progress, when the no-progress brake holds a task back, and what the
// pump does with a saved wake in every state a task can be in.

import { describe, expect, it } from 'vitest'

import {
  autoFireRefusal,
  BRAKE_AFTER_RUNS,
  BRAKE_FIRST_WAIT_MS,
  BRAKE_MAX_WAIT_MS,
  brakeUntil,
  BUDGET_REFUSED_CLASS,
  ledgerAllowsAutoFire,
  ledgerWillAutoFire,
  MAX_AUTO_FIRES,
  PAUSED_RUN_CLASS,
  runMadeProgress,
  trailingFailedRuns,
  trailingNoProgressRuns,
  type LedgerRun,
} from '../dispatch'
import { taskAttention } from '../attention'
import { TASK_STATUSES } from '../state-machine'
import {
  commentMayWake,
  MAX_TASK_WAKE_REPLAYS,
  strongerWakeReason,
  wakeDecision,
  wakeFromPerson,
  type WakeDecisionInput,
} from '../wakes'

const AT = 1_000_000_000
const failed = (completedAt: number, extra: Partial<LedgerRun> = {}): LedgerRun => ({
  status: 'failed',
  completedAt,
  ...extra,
})

describe('a comment may wake', () => {
  it('only when a person wrote it, as the writer labelled it', () => {
    expect(commentMayWake({ kind: 'person' })).toBe(true)
    for (const kind of ['agent', 'note', 'result', null, undefined])
      expect(commentMayWake({ kind })).toBe(false)
  })

  it("never reads the comment's author type", () => {
    // Retry and Assign write `user` notes. Only the kind the writer set counts.
    expect(commentMayWake({ kind: 'note', authorType: 'user' })).toBe(false)
    expect(commentMayWake({ kind: null, authorType: 'user' })).toBe(false)
  })
})

describe('wake reasons', () => {
  it('a person is behind a comment and an answered question, not a finished dependency', () => {
    expect(wakeFromPerson('person_comment')).toBe(true)
    expect(wakeFromPerson('question_answered')).toBe(true)
    expect(wakeFromPerson('dependency_done')).toBe(false)
  })

  it('a merged row keeps the reason a person is behind', () => {
    expect(strongerWakeReason('dependency_done', 'person_comment')).toBe('person_comment')
    expect(strongerWakeReason('person_comment', 'dependency_done')).toBe('person_comment')
    expect(strongerWakeReason('dependency_done', 'dependency_done')).toBe('dependency_done')
  })
})

describe('visible progress', () => {
  it('a run that ended well and left a result made progress', () => {
    expect(
      runMadeProgress({
        status: 'succeeded',
        summary: 'Fixed it.',
        taskStatus: 'done',
        subTasks: 0,
      }),
    ).toBe(true)
  })

  it('a run that moved the card forward made progress, even with nothing to say', () => {
    expect(
      runMadeProgress({ status: 'succeeded', summary: '', taskStatus: 'done', subTasks: 0 }),
    ).toBe(true)
    expect(
      runMadeProgress({ status: 'succeeded', summary: '', taskStatus: 'in_review', subTasks: 0 }),
    ).toBe(true)
  })

  it('a run that ended well with nothing to show made none', () => {
    expect(
      runMadeProgress({ status: 'succeeded', summary: '   ', taskStatus: 'blocked', subTasks: 0 }),
    ).toBe(false)
  })

  it('a failed run made none, whatever it said, unless it left a sub-task', () => {
    expect(
      runMadeProgress({ status: 'failed', summary: 'partial', taskStatus: 'blocked', subTasks: 0 }),
    ).toBe(false)
    expect(
      runMadeProgress({ status: 'timed_out', summary: '', taskStatus: 'todo', subTasks: 0 }),
    ).toBe(false)
    expect(
      runMadeProgress({ status: 'failed', summary: '', taskStatus: 'blocked', subTasks: 1 }),
    ).toBe(true)
  })

  it('a stopped run or one the budget refused has no verdict: it is not a run without progress', () => {
    expect(
      runMadeProgress({ status: 'cancelled', summary: '', taskStatus: 'todo', subTasks: 0 }),
    ).toBeNull()
    expect(
      runMadeProgress({
        status: 'failed',
        summary: '',
        taskStatus: 'blocked',
        subTasks: 0,
        errorClass: BUDGET_REFUSED_CLASS,
      }),
    ).toBeNull()
  })
})

describe('the no-progress brake', () => {
  it('engages after 2 runs in a row with no progress, for 2 minutes', () => {
    expect(BRAKE_AFTER_RUNS).toBe(2)
    expect(BRAKE_FIRST_WAIT_MS).toBe(2 * 60_000)
    const one = [failed(AT)]
    expect(trailingNoProgressRuns(one)).toBe(1)
    expect(brakeUntil(one)).toBeNull()
    expect(autoFireRefusal(one, AT + 1)).toBeNull()

    const two = [failed(AT - 5_000), failed(AT)]
    expect(trailingNoProgressRuns(two)).toBe(2)
    expect(brakeUntil(two)).toBe(AT + BRAKE_FIRST_WAIT_MS)
    expect(autoFireRefusal(two, AT + BRAKE_FIRST_WAIT_MS - 1)).toBe('braked')
    expect(ledgerAllowsAutoFire(two, AT + BRAKE_FIRST_WAIT_MS - 1)).toBe(false)
    expect(autoFireRefusal(two, AT + BRAKE_FIRST_WAIT_MS)).toBeNull()
    expect(ledgerAllowsAutoFire(two, AT + BRAKE_FIRST_WAIT_MS)).toBe(true)
  })

  it('doubles from there, up to 30 minutes', () => {
    expect(BRAKE_MAX_WAIT_MS).toBe(30 * 60_000)
    // A run that ended well with nothing to show keeps the streak without
    // counting toward the failure park, so the doubling can be reached.
    const quiet = (completedAt: number): LedgerRun => ({
      status: 'succeeded',
      madeProgress: false,
      completedAt,
    })
    const waits = [2, 3, 4, 5, 6, 7].map((n) => {
      const runs = Array.from({ length: n }, (_, i) => quiet(AT - (n - 1 - i)))
      return ((brakeUntil(runs) ?? 0) - AT) / 60_000
    })
    expect(waits).toEqual([2, 4, 8, 16, 30, 30])
  })

  it('progress ends the streak', () => {
    const runs: LedgerRun[] = [
      failed(AT - 3),
      failed(AT - 2),
      { status: 'succeeded', madeProgress: true, completedAt: AT - 1 },
      failed(AT),
    ]
    expect(trailingNoProgressRuns(runs)).toBe(1)
    expect(brakeUntil(runs)).toBeNull()
  })

  it("a person's Stop ends the streak too", () => {
    const runs: LedgerRun[] = [
      failed(AT - 3),
      { status: 'cancelled', completedAt: AT - 2 },
      failed(AT),
    ]
    expect(trailingNoProgressRuns(runs)).toBe(1)
  })

  it('a run the budget refused neither counts nor ends the streak', () => {
    const refused = failed(AT - 1, { errorClass: BUDGET_REFUSED_CLASS })
    expect(trailingNoProgressRuns([refused])).toBe(0)
    expect(trailingNoProgressRuns([failed(AT - 2), refused, failed(AT)])).toBe(2)
    expect(brakeUntil([refused, refused])).toBeNull()
  })

  it('an old run with no recorded verdict reads from its outcome', () => {
    expect(trailingNoProgressRuns([{ status: 'succeeded' }])).toBe(0)
    expect(trailingNoProgressRuns([{ status: 'timed_out' }])).toBe(1)
  })

  it('a ledger with no finish times waits for nothing', () => {
    // Runs written before the brake, and the bare rows some callers pass.
    expect(ledgerAllowsAutoFire([{ status: 'failed' }, { status: 'failed' }], AT)).toBe(true)
  })

  it('a run still going is skipped, not counted', () => {
    const runs: LedgerRun[] = [failed(AT - 1), failed(AT), { status: 'running' }]
    expect(trailingNoProgressRuns(runs)).toBe(2)
    expect(autoFireRefusal(runs, AT + 1)).toBe('running')
  })
})

describe('the fire policy names why it refuses', () => {
  it('names each refusal, in the order a person would need them', () => {
    expect(autoFireRefusal([], AT)).toBeNull()
    expect(autoFireRefusal([{ status: 'running' }], AT)).toBe('running')
    expect(autoFireRefusal([{ status: 'cancelled' }], AT)).toBe('stopped')
    expect(autoFireRefusal([failed(AT, { errorClass: 'Auth' })], AT)).toBe('sign_in')
    expect(autoFireRefusal([failed(AT, { errorClass: 'Billing' })], AT)).toBe('billing')
    expect(autoFireRefusal([failed(AT, { errorClass: BUDGET_REFUSED_CLASS })], AT)).toBe('budget')
    // A run a budget cap killed closes `cancelled`, and it is still not a Stop.
    expect(autoFireRefusal([{ status: 'cancelled', errorClass: BUDGET_REFUSED_CLASS }], AT)).toBe(
      'budget',
    )
    const capped = Array.from({ length: MAX_AUTO_FIRES }, () => ({ status: 'failed' }))
    expect(autoFireRefusal(capped, AT)).toBe('failed_too_often')
  })

  it('sign-in and billing stay parked, not braked', () => {
    const runs = [failed(AT - 1), failed(AT, { errorClass: 'Auth' })]
    expect(autoFireRefusal(runs, AT + 1)).toBe('sign_in')
  })

  it('a task that is only braked will still fire by itself; a parked one will not', () => {
    expect(ledgerWillAutoFire([failed(AT - 1), failed(AT)])).toBe(true)
    expect(ledgerWillAutoFire([{ status: 'cancelled' }])).toBe(false)
    expect(ledgerWillAutoFire([failed(AT, { errorClass: 'Auth' })])).toBe(false)
    expect(
      ledgerWillAutoFire(Array.from({ length: MAX_AUTO_FIRES }, () => ({ status: 'failed' }))),
    ).toBe(false)
  })

  it('a budget refusal is no failure: it leaves the streak out', () => {
    expect(trailingFailedRuns([failed(AT, { errorClass: BUDGET_REFUSED_CLASS })])).toBe(0)
  })
})

describe('a braked task does not read as needing a person', () => {
  it('is not in Needs you while it waits', () => {
    const now = Date.now()
    const execs = [failed(now - 2), failed(now - 1)]
    expect(taskAttention({ status: 'todo', sourceDelegationId: 'x:agent:a1', execs })).toBeNull()
  })
})

// The pump's decision over a saved wake.
const base: WakeDecisionInput = {
  reason: 'person_comment',
  replays: 0,
  status: 'todo',
  dropped: false,
  hasAgent: true,
  ready: true,
  execs: [],
  runProvenAlive: false,
  held: false,
  paused: false,
  refusal: null,
  budgetRefused: false,
  now: AT,
}

describe('what the pump does with a saved wake', () => {
  it('fires a ready To do task', () => {
    expect(wakeDecision(base)).toEqual({ do: 'fire', force: true, moveToTodo: false })
    expect(wakeDecision({ ...base, reason: 'dependency_done' })).toEqual({
      do: 'fire',
      force: false,
      moveToTodo: false,
    })
  })

  it("a person's comment restarts a Blocked task, and a finished dependency does not", () => {
    expect(wakeDecision({ ...base, status: 'blocked' })).toEqual({
      do: 'fire',
      force: true,
      moveToTodo: true,
    })
    expect(wakeDecision({ ...base, status: 'blocked', reason: 'dependency_done' })).toEqual({
      do: 'wait',
      skip: 'blocked',
    })
  })

  it('a finished task settles the wake: it can never run', () => {
    for (const status of ['done', 'cancelled'])
      expect(wakeDecision({ ...base, status })).toEqual({ do: 'settle', how: 'finished' })
    expect(wakeDecision({ ...base, dropped: true })).toEqual({ do: 'settle', how: 'finished' })
  })

  it('a held engine leaves every wake waiting, and a finished task still settles', () => {
    expect(wakeDecision({ ...base, held: true })).toEqual({ do: 'wait', skip: 'held' })
    expect(wakeDecision({ ...base, held: true, status: 'done' })).toEqual({
      do: 'settle',
      how: 'finished',
    })
  })

  it('a refused budget leaves it waiting, for a person too', () => {
    expect(wakeDecision({ ...base, budgetRefused: true })).toEqual({ do: 'wait', skip: 'budget' })
    expect(wakeDecision({ ...base, status: 'blocked', budgetRefused: true })).toEqual({
      do: 'wait',
      skip: 'budget',
    })
  })

  it('goes out once the cap that refused its last run was raised', () => {
    const execs = [failed(AT, { errorClass: BUDGET_REFUSED_CLASS })]
    expect(wakeDecision({ ...base, execs, budgetRefused: true })).toEqual({
      do: 'wait',
      skip: 'budget',
    })
    expect(wakeDecision({ ...base, execs, reason: 'dependency_done', replays: 1 })).toEqual({
      do: 'fire',
      force: true,
      moveToTodo: false,
    })
  })

  it('folds into a run only while that run is proven alive', () => {
    expect(wakeDecision({ ...base, status: 'in_progress', runProvenAlive: true })).toEqual({
      do: 'wait',
      skip: 'run_live',
    })
    expect(
      wakeDecision({
        ...base,
        status: 'in_progress',
        runProvenAlive: false,
        execs: [{ status: 'running' }],
      }),
    ).toEqual({ do: 'wait', skip: 'run_unproven' })
    expect(wakeDecision({ ...base, status: 'in_progress', runProvenAlive: false })).toEqual({
      do: 'wait',
      skip: 'no_run',
    })
    expect(wakeDecision({ ...base, status: 'in_review' })).toEqual({
      do: 'wait',
      skip: 'under_check',
    })
  })

  it('waits on an unfinished dependency', () => {
    expect(wakeDecision({ ...base, ready: false })).toEqual({ do: 'wait', skip: 'dependency' })
  })

  it("a person's first start skips the brake; every automatic start honours it", () => {
    const execs = [failed(AT - 2), failed(AT - 1)]
    expect(wakeDecision({ ...base, execs })).toEqual({ do: 'fire', force: true, moveToTodo: false })
    expect(wakeDecision({ ...base, execs, reason: 'dependency_done' })).toEqual({
      do: 'wait',
      skip: 'braked',
    })
    expect(wakeDecision({ ...base, execs, replays: 1 })).toEqual({ do: 'wait', skip: 'braked' })
  })

  it('sign-in and billing refusals stay parked on an automatic start', () => {
    const execs = [failed(AT, { errorClass: 'Auth' })]
    expect(wakeDecision({ ...base, execs, reason: 'dependency_done' })).toEqual({
      do: 'wait',
      skip: 'sign_in',
    })
    expect(wakeDecision({ ...base, status: 'blocked', execs, replays: 1 })).toEqual({
      do: 'wait',
      skip: 'sign_in',
    })
  })

  it("an engine that cannot see the task says so, whoever's wake it is", () => {
    expect(wakeDecision({ ...base, refusal: 'room_archived' })).toEqual({
      do: 'wait',
      skip: 'room_archived',
    })
    expect(wakeDecision({ ...base, refusal: 'no_team' })).toEqual({ do: 'wait', skip: 'no_team' })
  })

  it('gives up past the replay cap', () => {
    expect(MAX_TASK_WAKE_REPLAYS).toBe(3)
    expect(wakeDecision({ ...base, replays: MAX_TASK_WAKE_REPLAYS })).toEqual({
      do: 'settle',
      how: 'gave_up',
    })
  })

  it('every waiting task has a way out', () => {
    // The invariant from plan 5.0, over every status and every wake reason: the
    // pump either acts, or names a wait a person or the board can end.
    const ends: Record<string, string> = {
      held: 'the hold lifting',
      budget: 'a person raising the cap, then Retry or a comment',
      braked: 'the wait running out, or a comment',
      agent_busy: 'the agent finishing',
      run_live: 'the run ending',
      run_unproven: 'the stale sweep releasing it',
      no_run: 'Retry after the stale sweep, or a person moving the card',
      under_check: 'the check answering',
      dependency: 'the dependency finishing',
      parked: 'Retry',
      stopped: 'Retry',
      sign_in: 'fixing the sign-in, then Retry',
      billing: 'fixing the billing, then Retry',
      blocked: 'Retry',
      backlog: 'moving the card to To do',
      no_agent: 'Assign',
      room_archived: 'Retry after the boot move',
      no_team: 'nothing: the team is gone, and the row is reaped',
    }
    for (const status of TASK_STATUSES) {
      for (const reason of ['person_comment', 'dependency_done', 'question_answered'] as const) {
        for (const replays of [0, 1]) {
          const d = wakeDecision({ ...base, status, reason, replays })
          if (d.do === 'wait') expect(ends[d.skip], `${status}/${reason}`).toBeTruthy()
          else expect(['fire', 'settle']).toContain(d.do)
        }
      }
    }
  })
})

describe('a saved wake under a pause', () => {
  const paused: LedgerRun = { status: 'cancelled', errorClass: PAUSED_RUN_CLASS, completedAt: AT }

  it("waits, and names why, even for a person's comment", () => {
    expect(wakeDecision({ ...base, paused: true })).toEqual({ do: 'wait', skip: 'paused' })
    expect(wakeDecision({ ...base, paused: true, status: 'blocked' })).toEqual({
      do: 'wait',
      skip: 'paused',
    })
  })

  it('still closes with a task that closed', () => {
    expect(wakeDecision({ ...base, paused: true, status: 'done' })).toEqual({
      do: 'settle',
      how: 'finished',
    })
  })

  it('fires once the pause is gone, whatever its run a pause stopped says', () => {
    expect(wakeDecision({ ...base, reason: 'dependency_done', execs: [paused] })).toEqual({
      do: 'fire',
      force: false,
      moveToTodo: false,
    })
  })

  it('names an archived team as its own wait, with its own way out', () => {
    expect(wakeDecision({ ...base, refusal: 'team_archived' })).toEqual({
      do: 'wait',
      skip: 'team_archived',
    })
  })
})

describe('the brake and a run a pause stopped', () => {
  const noProgress = (completedAt: number): LedgerRun => ({
    status: 'failed',
    madeProgress: 0,
    completedAt,
  })
  const paused = (completedAt: number): LedgerRun => ({
    status: 'cancelled',
    errorClass: PAUSED_RUN_CLASS,
    completedAt,
  })

  it('neither counts it nor lets it end the streak', () => {
    expect(trailingNoProgressRuns([noProgress(1), paused(2), paused(3)])).toBe(1)
    expect(trailingNoProgressRuns([noProgress(1), paused(2), noProgress(3)])).toBe(2)
  })

  it('counts the wait from the last real ending, not from the pause', () => {
    const ledger = [noProgress(1_000), noProgress(2_000), paused(9_000_000)]
    expect(brakeUntil(ledger)).toBe(2_000 + BRAKE_FIRST_WAIT_MS)
  })

  it('never holds a run a pause stopped back: that run was going', () => {
    const ledger = [noProgress(1_000), noProgress(2_000), paused(3_000)]
    expect(autoFireRefusal(ledger, 4_000)).toBeNull()
  })
})
