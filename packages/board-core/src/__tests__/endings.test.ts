// How a run's ending reads: what the fire policy does with each one, and what a
// person is told. Each ending has its own row status or class, so none of them can
// be taken for a person's Stop.

import { describe, expect, it } from 'vitest'

import { taskAttention } from '../attention'
import {
  autoFireRefusal,
  BRAKE_AFTER_RUNS,
  BUDGET_HELD_RECHECK_MS,
  budgetRefusalOf,
  extraTurnUsed,
  ledgerAllowsAutoFire,
  ledgerWillAutoFire,
  MAX_AUTO_FIRES,
  MAX_CRASH_FIRES,
  MAX_PROVIDER_RETRIES,
  ORPHANED_RUN_ERROR,
  PROVIDER_RETRY_WAITS_MS,
  providerFailureOf,
  providerRetriesUsed,
  providerRetryUntil,
  PAUSED_RUN_CLASS,
  replyIsEmpty,
  runKindOf,
  runMadeProgress,
  STALE_RUN_ERROR,
  stretchStartedAt,
  trailingFailedRuns,
  trailingNoProgressRuns,
  trailingRunFailures,
  type LedgerRun,
} from '../dispatch'
import { parseWaitingOn, waitingOnJson, waitsToStartByItself } from '../waitingOn'
import { wakeDecision, WAKE_SKIP_REASONS, type WakeDecisionInput } from '../wakes'

const T0 = 1_000_000

const rateLimited = (over: Partial<LedgerRun> = {}): LedgerRun => ({
  status: 'failed',
  errorClass: 'RateLimited',
  completedAt: T0,
  runReason: 'delegation',
  ...over,
})
const crash: LedgerRun = {
  status: 'failed',
  error: ORPHANED_RUN_ERROR,
  recoveryTombstone: 1,
  completedAt: T0,
}
const staleCrash: LedgerRun = { status: 'timed_out', error: STALE_RUN_ERROR, completedAt: T0 }
const failed: LedgerRun = { status: 'failed', error: 'boom', completedAt: T0 }

describe('a run ending, as the ledger reads it', () => {
  it('names each ending', () => {
    expect(runKindOf({ status: 'succeeded' })).toBe('success')
    expect(runKindOf({ status: 'cancelled' })).toBe('cancelled')
    expect(runKindOf({ status: 'budget_paused' })).toBe('budget')
    expect(runKindOf({ status: 'budget_held' })).toBe('budget')
    expect(runKindOf({ status: 'breaker_tripped' })).toBe('breaker')
    expect(runKindOf(crash)).toBe('crash')
    expect(runKindOf(staleCrash)).toBe('crash')
    expect(runKindOf({ status: 'timed_out', error: 'watchdog' })).toBe('timeout')
    expect(runKindOf(failed)).toBe('error')
  })

  it('reads a budget class from before the statuses existed as a budget stop', () => {
    expect(runKindOf({ status: 'cancelled', errorClass: 'BudgetRefused' })).toBe('budget')
    expect(budgetRefusalOf({ status: 'failed', errorClass: 'BudgetRefused' })).toBe(true)
    expect(budgetRefusalOf({ status: 'budget_paused' })).toBe(true)
    expect(budgetRefusalOf({ status: 'budget_held' })).toBe(true)
    expect(budgetRefusalOf({ status: 'cancelled' })).toBe(false)
  })
})

describe('a budget stop or a breaker trip is not a person’s Stop', () => {
  it('the fire policy names each one', () => {
    expect(autoFireRefusal([{ status: 'budget_paused' }])).toBe('budget')
    expect(autoFireRefusal([{ status: 'breaker_tripped' }])).toBe('breaker')
    expect(autoFireRefusal([{ status: 'cancelled' }])).toBe('stopped')
  })

  it('a held budget waits briefly, then may fire: it clears by itself', () => {
    const held: LedgerRun = { status: 'budget_held', completedAt: T0 }
    expect(autoFireRefusal([held], T0 + BUDGET_HELD_RECHECK_MS - 1)).toBe('budget_held')
    expect(autoFireRefusal([held], T0 + BUDGET_HELD_RECHECK_MS)).toBeNull()
    expect(ledgerWillAutoFire([held])).toBe(true)
  })

  it('a paused budget and a breaker trip never fire by themselves', () => {
    expect(ledgerWillAutoFire([{ status: 'budget_paused' }])).toBe(false)
    expect(ledgerWillAutoFire([{ status: 'breaker_tripped' }])).toBe(false)
  })

  it('Needs you says what stopped it, not "You stopped this run"', () => {
    const sdid = 'r:deleg:agent:a1'
    expect(
      taskAttention({
        status: 'todo',
        sourceDelegationId: sdid,
        execs: [{ status: 'budget_paused', error: 'budget_paused:agent' }],
      })?.reason,
    ).toBe('budget')
    expect(
      taskAttention({
        status: 'todo',
        sourceDelegationId: sdid,
        execs: [{ status: 'breaker_tripped', error: 'circuit_broken:loop' }],
      })?.reason,
    ).toBe('breaker')
    expect(
      taskAttention({
        status: 'blocked',
        sourceDelegationId: sdid,
        waitingOn: { kind: 'budget' },
        execs: [{ status: 'budget_paused' }],
      })?.reason,
    ).toBe('budget')
    // An older row, closed before the statuses existed.
    expect(
      taskAttention({
        status: 'todo',
        sourceDelegationId: sdid,
        execs: [{ status: 'cancelled', errorClass: 'BudgetRefused' }],
      })?.reason,
    ).toBe('budget')
  })

  it('a held budget does not need a person: it goes by itself', () => {
    expect(
      taskAttention({
        status: 'todo',
        sourceDelegationId: 'r:deleg:agent:a1',
        execs: [{ status: 'budget_held', completedAt: T0 }],
      }),
    ).toBeNull()
  })

  it('a budget stop neither counts in a failure streak nor ends one', () => {
    expect(trailingFailedRuns([failed, { status: 'budget_paused' }, failed])).toBe(2)
    expect(trailingFailedRuns([failed, { status: 'budget_held' }])).toBe(1)
    expect(trailingNoProgressRuns([failed, { status: 'budget_held' }, failed])).toBe(2)
  })

  it('a breaker trip ends a failure streak, as a person looking at it does', () => {
    expect(trailingFailedRuns([failed, failed, { status: 'breaker_tripped' }, failed])).toBe(1)
  })

  it('a budget stop says nothing about progress', () => {
    for (const status of ['budget_paused', 'budget_held'])
      expect(runMadeProgress({ status, taskStatus: 'todo', subTasks: 0 })).toBeNull()
  })
})

describe('separate limits for crashes and errors', () => {
  it('counts them apart', () => {
    expect(trailingRunFailures([failed, crash, staleCrash, failed])).toEqual({
      crashes: 2,
      errors: 2,
    })
    expect(trailingRunFailures([crash, { status: 'succeeded' }, failed])).toEqual({
      crashes: 0,
      errors: 1,
    })
    expect(trailingRunFailures([crash, { status: 'cancelled' }])).toEqual({ crashes: 0, errors: 0 })
  })

  it('a mix below both limits still fires, where the one count parked it', () => {
    // Three runs in a row did not succeed, the number the one shared count parked at.
    const mix = [crash, crash, failed]
    expect(mix.length).toBe(MAX_AUTO_FIRES)
    expect(autoFireRefusal(mix, T0 + 10 * 60_000)).toBeNull()
  })

  it('each limit parks on its own', () => {
    const crashes = Array.from({ length: MAX_CRASH_FIRES }, () => crash)
    const errors = Array.from({ length: MAX_AUTO_FIRES }, () => failed)
    expect(autoFireRefusal(crashes, T0 + 3_600_000)).toBe('failed_too_often')
    expect(autoFireRefusal(errors, T0 + 3_600_000)).toBe('failed_too_often')
  })

  it('a person’s Stop stays never-refired, whatever came before', () => {
    expect(autoFireRefusal([crash, failed, { status: 'cancelled' }])).toBe('stopped')
    expect(ledgerWillAutoFire([{ status: 'cancelled' }])).toBe(false)
  })
})

describe('provider failures wait, and retry a bounded number of times', () => {
  it('reads the classes the runtime error taxonomy files them under', () => {
    expect(providerFailureOf(rateLimited())).toBe('rate_limited')
    expect(providerFailureOf({ status: 'failed', errorClass: 'ProviderError' })).toBe('unavailable')
    expect(providerFailureOf({ status: 'failed', errorClass: 'Timeout' })).toBe('unavailable')
    expect(providerFailureOf({ status: 'failed', errorClass: 'Auth' })).toBeNull()
    expect(providerFailureOf({ status: 'failed', errorClass: 'Billing' })).toBeNull()
    expect(providerFailureOf({ status: 'failed', errorClass: 'InvalidArgs' })).toBeNull()
    expect(providerFailureOf({ status: 'succeeded', errorClass: 'RateLimited' })).toBeNull()
  })

  it('waits 30 s, then 60 s, and is done after two retries', () => {
    expect(PROVIDER_RETRY_WAITS_MS).toEqual([30_000, 60_000])
    expect(MAX_PROVIDER_RETRIES).toBe(2)
    const first = [rateLimited()]
    expect(providerRetriesUsed(first)).toBe(0)
    expect(providerRetryUntil(first)).toBe(T0 + 30_000)
    const second = [rateLimited(), rateLimited({ runReason: 'provider_retry' })]
    expect(providerRetriesUsed(second)).toBe(1)
    expect(providerRetryUntil(second)).toBe(T0 + 60_000)
    const third = [...second, rateLimited({ runReason: 'provider_retry' })]
    expect(providerRetriesUsed(third)).toBe(2)
    expect(providerRetryUntil(third)).toBeNull()
  })

  it('the fire policy holds the task for the wait, from the ledger alone', () => {
    const ledger = [rateLimited()]
    expect(autoFireRefusal(ledger, T0 + 29_999)).toBe('retry_wait')
    expect(ledgerAllowsAutoFire(ledger, T0 + 29_999)).toBe(false)
    expect(autoFireRefusal(ledger, T0 + 30_000)).toBeNull()
    // It is not stuck, so it does not need a person.
    expect(ledgerWillAutoFire(ledger)).toBe(true)
    expect(
      taskAttention({ status: 'todo', sourceDelegationId: 'r:deleg:agent:a1', execs: ledger }),
    ).toBeNull()
  })

  it('a person’s run starts the retry count again, and the error limit still stands', () => {
    const ledger = [
      rateLimited(),
      rateLimited({ runReason: 'provider_retry' }),
      rateLimited({ runReason: 'provider_retry' }),
      rateLimited({ runReason: 'person_retry' }),
    ]
    expect(providerRetriesUsed(ledger)).toBe(0)
    // Four errors in a row: the pump will not start it, whatever the retry count says.
    expect(autoFireRefusal(ledger, T0 + 3_600_000)).toBe('failed_too_often')
    expect(ledgerWillAutoFire(ledger)).toBe(false)
    // One failure earlier, the same ledger does wait and go.
    const fewer = [rateLimited(), rateLimited({ runReason: 'person_retry' })]
    expect(providerRetriesUsed(fewer)).toBe(0)
    expect(autoFireRefusal(fewer, T0 + 1)).toBe('retry_wait')
    expect(autoFireRefusal(fewer, T0 + 30_000)).toBeNull()
  })

  it('a success or any other failure ends the count', () => {
    expect(providerRetriesUsed([rateLimited(), { status: 'succeeded' }, rateLimited()])).toBe(0)
    expect(providerRetriesUsed([rateLimited(), failed, rateLimited()])).toBe(0)
    expect(providerRetryUntil([rateLimited(), failed])).toBeNull()
  })

  it('a budget refusal in the middle does not reset it', () => {
    const ledger = [rateLimited(), { status: 'budget_held' }, rateLimited()]
    expect(providerRetriesUsed(ledger)).toBe(1)
  })

  it('counts toward the error limit, and says nothing about progress', () => {
    const ledger = [
      rateLimited(),
      rateLimited({ runReason: 'provider_retry' }),
      rateLimited({ runReason: 'provider_retry' }),
    ]
    expect(trailingRunFailures(ledger).errors).toBe(3)
    expect(autoFireRefusal(ledger, T0 + 3_600_000)).toBe('failed_too_often')
    expect(
      runMadeProgress({
        status: 'failed',
        errorClass: 'RateLimited',
        taskStatus: 'todo',
        subTasks: 0,
      }),
    ).toBeNull()
    // Otherwise the brake would hold the second retry well past its 60 seconds.
    const two = ledger.slice(0, BRAKE_AFTER_RUNS)
    expect(trailingNoProgressRuns(two)).toBe(0)
    expect(autoFireRefusal(two, T0 + 60_000)).toBeNull()
  })
})

describe('the extra turns a run may get', () => {
  const run = (runReason: string | null, over: Partial<LedgerRun> = {}): LedgerRun => ({
    status: 'succeeded',
    runReason,
    createdAt: 100,
    ...over,
  })
  it('sees through the automatic runs since whatever started this stretch', () => {
    const chain = [run('delegation'), run('empty_reply'), run('provider_retry'), run('fix_round')]
    expect(extraTurnUsed(chain, 'empty_reply')).toBe(true)
    expect(extraTurnUsed(chain, 'max_turns')).toBe(false)
  })
  it('starts again at a run something new started', () => {
    for (const fresh of ['person_retry', 'person_comment', 'delegation', 'reopened', null]) {
      expect(extraTurnUsed([run('empty_reply'), run(fresh)], 'empty_reply')).toBe(false)
    }
  })
  it('reads from the run it is given', () => {
    const chain = [run('delegation'), run('empty_reply'), run('person_retry')]
    expect(extraTurnUsed(chain, 'empty_reply', 1)).toBe(true)
    expect(extraTurnUsed(chain, 'empty_reply', 2)).toBe(false)
  })
  it('names when this stretch began', () => {
    const chain = [
      run('delegation', { createdAt: 1 }),
      run('person_retry', { createdAt: 2 }),
      run('provider_retry', { createdAt: 3 }),
      run('max_turns', { createdAt: 4 }),
    ]
    expect(stretchStartedAt(chain)).toBe(2)
    expect(stretchStartedAt([])).toBeNull()
    expect(stretchStartedAt(chain, 0)).toBe(1)
  })
})

describe('a follow-up after sub-tasks belongs to the work that handed them out', () => {
  const run = (runReason: string, createdAt = 1): LedgerRun => ({
    status: 'succeeded',
    runReason,
    createdAt,
  })

  it('hands out no second extra turn across it', () => {
    const chain = [run('delegation'), run('empty_reply'), run('subtasks_closed')]
    expect(extraTurnUsed(chain, 'empty_reply')).toBe(true)
    expect(
      extraTurnUsed([run('delegation'), run('max_turns'), run('subtasks_closed')], 'max_turns'),
    ).toBe(true)
    expect(extraTurnUsed([run('delegation'), run('subtasks_closed')], 'empty_reply')).toBe(false)
  })

  it('reads what the earlier runs handed out as its own', () => {
    const chain = [run('delegation', 5), run('subtasks_closed', 9)]
    expect(stretchStartedAt(chain)).toBe(5)
    expect(stretchStartedAt([run('person_comment', 3), ...chain.slice(1)])).toBe(3)
  })

  it('a person’s run after it starts new work', () => {
    const chain = [run('empty_reply'), run('subtasks_closed'), run('person_retry')]
    expect(extraTurnUsed(chain, 'empty_reply')).toBe(false)
  })
})

describe('a run a pause stopped is no ending at all', () => {
  const paused = (over: Partial<LedgerRun> = {}): LedgerRun => ({
    status: 'cancelled',
    errorClass: PAUSED_RUN_CLASS,
    completedAt: T0 + 5,
    ...over,
  })

  it('is neither a failure nor the end of a streak', () => {
    expect(trailingRunFailures([failed, paused(), failed])).toEqual({ crashes: 0, errors: 2 })
    expect(trailingFailedRuns([failed, failed, paused()])).toBe(2)
  })

  it('does not spend a provider retry, and does not end the row', () => {
    // First try, its retry stopped by a pause: the retry is still to come.
    expect(providerRetriesUsed([rateLimited(), paused()])).toBe(0)
    // The run after the resume is that retry.
    expect(providerRetriesUsed([rateLimited(), paused(), rateLimited()])).toBe(1)
    expect(providerRetryUntil([rateLimited(), paused()])).toBe(T0 + PROVIDER_RETRY_WAITS_MS[0]!)
  })

  it('fires on resume whatever came before it, retry wait included', () => {
    expect(autoFireRefusal([rateLimited(), paused()], T0 + 1)).toBeNull()
  })

  it('neither counts toward the brake nor moves the time it counts from', () => {
    const silent: LedgerRun = { status: 'succeeded', madeProgress: 0, completedAt: T0 }
    expect(trailingNoProgressRuns([silent, paused(), silent])).toBe(2)
  })

  it('is a stop to the attempt reader, and Needs you stays quiet', () => {
    expect(runKindOf(paused())).toBe('cancelled')
    expect(
      taskAttention({
        status: 'todo',
        sourceDelegationId: 'r:d:agent:a2',
        execs: [rateLimited(), paused()],
      }),
    ).toBeNull()
  })
})

describe('what counts as an empty reply', () => {
  const run = { summary: '', handOffs: 0, subTasks: 0, agentComments: 0 }
  it('no text and nothing else to show', () => {
    expect(replyIsEmpty(run)).toBe(true)
    expect(replyIsEmpty({ ...run, summary: '  \n ' })).toBe(true)
    expect(replyIsEmpty({ ...run, summary: null })).toBe(true)
  })
  it('text, a hand-off, a sub-task or the agent’s own comment is not', () => {
    expect(replyIsEmpty({ ...run, summary: 'done' })).toBe(false)
    expect(replyIsEmpty({ ...run, handOffs: 1 })).toBe(false)
    expect(replyIsEmpty({ ...run, subTasks: 1 })).toBe(false)
    expect(replyIsEmpty({ ...run, agentComments: 1 })).toBe(false)
    expect(replyIsEmpty({ ...run, reported: true })).toBe(false)
    expect(replyIsEmpty({ ...run, reported: false })).toBe(true)
  })
})

describe('Needs you, for the new waits', () => {
  const blocked = (waitingOn: unknown, execs: LedgerRun[]) =>
    taskAttention({ status: 'blocked', waitingOn, execs, sourceDelegationId: 'r:deleg:agent:a1' })

  it('no result', () => {
    expect(blocked({ kind: 'no_result' }, [{ status: 'succeeded' }])?.reason).toBe('no_result')
  })
  it('rate limited, with what the provider said', () => {
    const a = blocked({ kind: 'provider', cause: 'rate_limited' }, [
      rateLimited({ error: '429 too many requests' }),
    ])
    expect(a?.reason).toBe('rate_limited')
    expect(a?.detail).toBe('429 too many requests')
    expect(a?.cause).toBeUndefined()
  })
  it('provider unavailable', () => {
    expect(
      blocked({ kind: 'provider', cause: 'unavailable' }, [
        { status: 'failed', errorClass: 'ProviderError' },
      ])?.reason,
    ).toBe('provider_down')
  })
  it('out of room', () => {
    expect(blocked({ kind: 'out_of_room' }, [{ status: 'failed' }])?.reason).toBe('out_of_room')
  })
  it('a breaker trip', () => {
    expect(blocked({ kind: 'breaker' }, [{ status: 'breaker_tripped' }])?.reason).toBe('breaker')
  })
})

describe('a new wait outranks an older failed check', () => {
  it('Needs you says what the task waits on now', () => {
    const ask = (waitingOn: unknown) =>
      taskAttention({
        status: 'blocked',
        waitingOn,
        verificationBlocked: true,
        execs: [rateLimited()],
        sourceDelegationId: 'r:deleg:agent:a1',
      })?.reason
    expect(ask({ kind: 'provider', cause: 'rate_limited' })).toBe('rate_limited')
    expect(ask({ kind: 'no_result' })).toBe('no_result')
    expect(ask({ kind: 'out_of_room' })).toBe('out_of_room')
    expect(ask({ kind: 'budget' })).toBe('budget')
    expect(ask({ kind: 'failure' })).toBe('needs_review')
  })
})

describe('waiting_on, the new reasons', () => {
  it('round-trips each one', () => {
    for (const w of [
      { kind: 'no_result' },
      { kind: 'out_of_room' },
      { kind: 'provider', cause: 'rate_limited' },
      { kind: 'provider', cause: 'unavailable' },
      { kind: 'retry', cause: 'rate_limited', attempt: 1 },
      { kind: 'retry', cause: 'unavailable', attempt: 2 },
      { kind: 'budget', held: true },
      { kind: 'budget' },
    ] as const)
      expect(parseWaitingOn(waitingOnJson(w))).toEqual(w)
  })
  it('names the waits that end by a task starting by itself', () => {
    expect(waitsToStartByItself({ kind: 'retry', cause: 'rate_limited', attempt: 1 })).toBe(true)
    expect(waitsToStartByItself({ kind: 'budget', held: true })).toBe(true)
    expect(waitsToStartByItself({ kind: 'budget' })).toBe(false)
    expect(waitsToStartByItself({ kind: 'failure' })).toBe(false)
    expect(waitsToStartByItself(null)).toBe(false)
  })
  it('refuses a cause or an attempt it cannot read', () => {
    expect(parseWaitingOn({ kind: 'provider' })).toBeNull()
    expect(parseWaitingOn({ kind: 'provider', cause: 'sunspots' })).toBeNull()
    expect(parseWaitingOn({ kind: 'retry', cause: 'rate_limited' })).toBeNull()
    expect(parseWaitingOn({ kind: 'retry', cause: 'rate_limited', attempt: 'x' })).toBeNull()
  })
})

describe('a saved wake meets the new endings', () => {
  const input = (over: Partial<WakeDecisionInput>): WakeDecisionInput => ({
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
    now: T0,
    ...over,
  })

  it('a replay honours a provider wait, and a person’s first start skips it', () => {
    const execs = [rateLimited()]
    expect(wakeDecision(input({ execs, replays: 1, now: T0 + 1 }))).toEqual({
      do: 'wait',
      skip: 'retry_wait',
    })
    expect(wakeDecision(input({ execs, replays: 0, now: T0 + 1 }))).toMatchObject({ do: 'fire' })
    expect(wakeDecision(input({ execs, replays: 1, now: T0 + 30_000 }))).toMatchObject({
      do: 'fire',
    })
  })

  it('a replay waits on a breaker trip, and a person’s first start goes', () => {
    const execs: LedgerRun[] = [{ status: 'breaker_tripped' }]
    expect(wakeDecision(input({ execs, replays: 1 }))).toEqual({ do: 'wait', skip: 'breaker' })
    expect(wakeDecision(input({ execs, replays: 0 }))).toMatchObject({ do: 'fire' })
  })

  it('a held budget that cleared lets the wake go; one still held waits', () => {
    const execs: LedgerRun[] = [{ status: 'budget_held', completedAt: T0 }]
    expect(wakeDecision(input({ execs, replays: 1, budgetRefused: true }))).toEqual({
      do: 'wait',
      skip: 'budget',
    })
    expect(wakeDecision(input({ execs, replays: 1, now: T0 + 1 }))).toMatchObject({
      do: 'fire',
      force: true,
    })
  })

  it('names the new skip reasons', () => {
    expect(WAKE_SKIP_REASONS).toEqual(expect.arrayContaining(['retry_wait', 'breaker']))
  })
})
