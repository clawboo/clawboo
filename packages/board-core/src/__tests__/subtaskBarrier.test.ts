import { describe, expect, it } from 'vitest'

import { PAUSED_RUN_CLASS } from '../dispatch'
import { encodePlanHolder } from '../plans'
import {
  requestWaitsOn,
  subtaskNames,
  subtasksStillOut,
  subtaskStanding,
  subtaskWaitOver,
  tallySubtasks,
  unfinishedNeed,
  unfinishedSubtasks,
  type SubtaskView,
} from '../subtaskBarrier'

const BOUND = 'run:deleg:agent:a2:reflectTo:lead'
const view = (over: Partial<SubtaskView>): SubtaskView => ({
  id: 's',
  status: 'todo',
  sourceDelegationId: BOUND,
  execs: [],
  ...over,
})
const blocked = (waitingOn: unknown): SubtaskView => view({ status: 'blocked', waitingOn })

describe('subtaskStanding: how its last run ended', () => {
  const failedOn = (errorClass: string): { status: string; errorClass: string } => ({
    status: 'failed',
    errorClass,
  })
  const retrying = failedOn('RateLimited')

  it.each([
    ['a provider failure waiting for its retry', [retrying]],
    ['a provider failure with its wait over', [retrying, failedOn('ProviderError')]],
    ['a retry whose run has not closed yet', [retrying, { status: 'running' }]],
    ['room in a budget held by other runs', [{ status: 'budget_held' }]],
    ['a retry a pause stopped', [retrying, { status: 'cancelled', errorClass: PAUSED_RUN_CLASS }]],
  ])('%s: it comes back by itself, so it is still coming', (_name, execs) => {
    const task = view({
      status: 'todo',
      execs,
      waitingOn: { kind: 'retry', cause: 'rate_limited', attempt: 1 },
    })
    expect(subtaskStanding(task)).toBe('coming')
    expect(subtaskWaitOver(tallySubtasks([task]))).toBe(false)
  })

  it.each([
    ['a hard cap', { status: 'budget_paused' }],
    [
      'a hard cap, on a row from before its status',
      { status: 'cancelled', errorClass: 'BudgetRefused' },
    ],
  ])('%s: a person raises it', (_name, last) => {
    expect(subtaskStanding(view({ status: 'todo', execs: [last] }))).toBe('with_person')
  })

  it.each([
    ['the breaker', [{ status: 'breaker_tripped' }]],
    ['too many failures', [failedOn('Boom'), failedOn('Boom'), failedOn('Boom')]],
    [
      'a held budget past the failure limit',
      [failedOn('Boom'), failedOn('Boom'), failedOn('Boom'), { status: 'budget_held' }],
    ],
  ])('%s: nothing more comes by itself', (_name, execs) => {
    expect(subtaskStanding(view({ status: 'todo', execs }))).toBe('not_coming')
  })

  it('only a person’s Stop reads as stopped', () => {
    expect(subtaskStanding(view({ status: 'todo', execs: [{ status: 'cancelled' }] }))).toBe(
      'stopped',
    )
    for (const status of ['budget_paused', 'budget_held', 'breaker_tripped'])
      expect(subtaskStanding(view({ status: 'todo', execs: [{ status }] }))).not.toBe('stopped')
  })

  it.each([
    ['no result', { kind: 'no_result' }],
    ['out of room', { kind: 'out_of_room' }],
    ['the provider, retries used up', { kind: 'provider', cause: 'rate_limited' }],
    ['a budget cap', { kind: 'budget' }],
    ['the breaker', { kind: 'breaker' }],
  ])('blocked on %s: closed, and not done', (_name, waitingOn) => {
    const task = blocked(waitingOn)
    expect(subtaskStanding(task)).toBe('not_coming')
    expect(unfinishedSubtasks(tallySubtasks([task]))).toBe(1)
  })
})

describe('subtaskStanding: what closed means', () => {
  it.each([
    ['done', view({ status: 'done' })],
    ['cancelled', view({ status: 'cancelled' })],
    ['cancelled', view({ status: 'in_progress', dropped: 1 })],
    ['done', view({ status: 'done', dropped: 1 })],
  ])('%s: it has closed', (want, task) => {
    expect(subtaskStanding(task)).toBe(want)
  })

  it.each([
    ['queued to fire', view({ status: 'todo' })],
    ['running', view({ status: 'in_progress' })],
    ['under check', view({ status: 'in_review' })],
    ['waiting on another task', blocked({ kind: 'task', taskId: 't' })],
    ['waiting on its own sub-tasks', blocked({ kind: 'subtasks' })],
    ['a ledger nobody could read', view({ status: 'todo', execs: null })],
  ])('%s: it reports by itself, so it is still coming', (_name, task) => {
    expect(subtaskStanding(task)).toBe('coming')
  })

  it.each([
    ['a question', blocked({ kind: 'question', questionId: 'q' })],
    ['an approval', blocked({ kind: 'approval' })],
    ['a person', blocked({ kind: 'person', need: 'log in' })],
    [
      'a person, in review',
      view({ status: 'in_review', waitingOn: { kind: 'person', need: 'x' } }),
    ],
    ['a person holding it', view({ status: 'todo', assigneePersonId: 'p' })],
  ])('waiting on %s: open, with a person', (_name, task) => {
    expect(subtaskStanding(task)).toBe('with_person')
  })

  it.each([
    ['a failed run', blocked({ kind: 'failure' })],
    ['a failed check', blocked({ kind: 'verification', state: 'failed' })],
    ['a check cut short', blocked({ kind: 'verification', state: 'cut_short' })],
    ['a budget cap', blocked({ kind: 'budget' })],
    ['the breaker', blocked({ kind: 'breaker' })],
    ['a restart', blocked({ kind: 'recovery' })],
    ['no reason at all', view({ status: 'blocked' })],
    ['a person parked it in Backlog', view({ status: 'backlog' })],
    [
      'three failed runs',
      view({
        status: 'todo',
        execs: [{ status: 'failed' }, { status: 'failed' }, { status: 'failed' }],
      }),
    ],
  ])('%s: nothing more comes from it without a person', (_name, task) => {
    expect(subtaskStanding(task)).toBe('not_coming')
  })

  it('a person stopped it: it stays apart, because nothing starts after a Stop', () => {
    expect(subtaskStanding(view({ status: 'todo', execs: [{ status: 'cancelled' }] }))).toBe(
      'stopped',
    )
  })

  it('a pause stopped it: it comes back by itself on resume, so it is not a Stop', () => {
    const paused = { status: 'cancelled', errorClass: PAUSED_RUN_CLASS }
    expect(subtaskStanding(view({ execs: [paused] }))).toBe('coming')
    // Whatever ran before it: the run a pause stopped was going.
    expect(
      subtaskStanding(
        view({ execs: [{ status: 'failed' }, { status: 'failed' }, { status: 'failed' }, paused] }),
      ),
    ).toBe('coming')
    // A person's Stop after the pause is a Stop.
    expect(subtaskStanding(view({ execs: [paused, { status: 'cancelled' }] }))).toBe('stopped')
  })

  it('a budget cap that closed its run cancelled is not a person stopping it: it waits on one', () => {
    expect(
      subtaskStanding(
        view({ status: 'todo', execs: [{ status: 'cancelled', errorClass: 'BudgetRefused' }] }),
      ),
    ).toBe('with_person')
  })

  it('work nobody was given was not handed out', () => {
    expect(subtaskStanding(view({ status: 'todo', sourceDelegationId: null }))).toBe(
      'not_handed_out',
    )
    expect(subtaskStanding(view({ status: 'backlog', sourceDelegationId: null }))).toBe(
      'not_handed_out',
    )
  })

  it('one that needs this task to finish first is not something this task can wait for', () => {
    const task = blocked({ kind: 'task', taskId: 'the-parent' })
    expect(subtaskStanding({ ...task, waitsOnThisTask: true })).toBe('waits_on_this')
    const t = tallySubtasks([{ ...task, waitsOnThisTask: true }])
    expect(subtasksStillOut(t)).toBe(false)
    expect(subtaskWaitOver(t)).toBe(true)
    expect(unfinishedSubtasks(t)).toBe(0)
    // Done is done, whatever its wait said.
    expect(subtaskStanding(view({ status: 'done', waitsOnThisTask: true }))).toBe('done')
  })

  it('work assigned to an agent is handed out, however it got there', () => {
    expect(
      subtaskStanding(
        view({ status: 'in_progress', sourceDelegationId: null, assigneeAgentId: 'a' }),
      ),
    ).toBe('coming')
  })
})

describe('the barrier', () => {
  const tally = (...list: SubtaskView[]) => tallySubtasks(list)

  it('a parent with nothing handed out has nothing to wait for', () => {
    expect(subtasksStillOut(tally())).toBe(false)
    expect(subtaskWaitOver(tally())).toBe(true)
    expect(subtasksStillOut(tally(view({ sourceDelegationId: null })))).toBe(false)
  })

  it('a sub-task still coming keeps the parent waiting', () => {
    const t = tally(view({ status: 'done' }), view({ status: 'in_progress' }))
    expect(subtasksStillOut(t)).toBe(true)
    expect(subtaskWaitOver(t)).toBe(false)
  })

  it('a sub-task waiting on a person keeps the parent waiting', () => {
    const t = tally(blocked({ kind: 'question', questionId: 'q' }))
    expect(subtasksStillOut(t)).toBe(true)
    expect(subtaskWaitOver(t)).toBe(false)
  })

  it('all closed ends the wait, failed work included', () => {
    const t = tally(
      view({ status: 'done' }),
      blocked({ kind: 'failure' }),
      view({ status: 'cancelled' }),
    )
    expect(subtasksStillOut(t)).toBe(false)
    expect(subtaskWaitOver(t)).toBe(true)
    expect(unfinishedSubtasks(t)).toBe(1)
  })

  it('a stopped sub-task does not make a run wait, and does not end a wait either', () => {
    const t = tally(view({ status: 'done' }), view({ execs: [{ status: 'cancelled' }] }))
    expect(subtasksStillOut(t)).toBe(false)
    expect(subtaskWaitOver(t)).toBe(false)
    expect(unfinishedSubtasks(t)).toBe(1)
  })

  it('a sub-task a pause stopped makes a run wait and is not unfinished work', () => {
    const paused = view({ execs: [{ status: 'cancelled', errorClass: PAUSED_RUN_CLASS }] })
    const t = tallySubtasks([view({ status: 'done' }), paused])
    expect(subtasksStillOut(t)).toBe(true)
    expect(subtaskWaitOver(t, { handedOutOnly: true })).toBe(false)
    expect(unfinishedSubtasks(t)).toBe(0)
    expect(subtaskNames([paused], 'not_coming', 'stopped')).toBe('')
  })

  it('an agent that chose to wait on work nobody was given keeps waiting for it', () => {
    const t = tally(view({ status: 'done' }), view({ sourceDelegationId: null }))
    expect(subtaskWaitOver(t)).toBe(false)
  })

  it('the wait a run ended in is only on what was handed out', () => {
    const t = tally(view({ status: 'done' }), view({ sourceDelegationId: null }))
    expect(subtaskWaitOver(t, { handedOutOnly: true })).toBe(true)
  })

  it('a cancelled sub-task is a decision, not unfinished work', () => {
    expect(unfinishedSubtasks(tally(view({ status: 'cancelled' })))).toBe(0)
  })
})

describe('how a person reads them', () => {
  const list = [
    view({ title: 'copy', status: 'done' }),
    view({ title: 'image', status: 'blocked', waitingOn: { kind: 'failure' } }),
    view({ title: 'video', execs: [{ status: 'cancelled' }] }),
    view({ title: 'old idea', status: 'cancelled' }),
  ]

  it('names the ones with these standings', () => {
    expect(subtaskNames(list, 'cancelled')).toBe('“old idea”')
    expect(subtaskNames(list, 'coming')).toBe('')
  })

  it('says what did not finish and what a person can do', () => {
    expect(unfinishedNeed(list)).toBe(
      '“image”, “video” did not finish. Retry them, or mark this task done.',
    )
  })
})

describe('subtaskStanding: a card that only holds a plan', () => {
  const holder = (over: Partial<SubtaskView> = {}): SubtaskView =>
    view({
      status: 'blocked',
      assigneeAgentId: 'a2',
      sourceDelegationId: encodePlanHolder('a2', 'n'),
      waitingOn: { kind: 'question', questionId: 'q1' },
      ...over,
    })

  it('waiting for its answer, it is not work handed out, though an agent holds it', () => {
    expect(subtaskStanding(holder())).toBe('not_handed_out')
  })

  it('moved back to To do or running, it still reports nothing to its parent', () => {
    expect(subtaskStanding(holder({ status: 'todo', waitingOn: null }))).toBe('not_handed_out')
    expect(subtaskStanding(holder({ status: 'in_progress', waitingOn: null }))).toBe(
      'not_handed_out',
    )
  })

  it('closed by its answer, it reads as closed', () => {
    expect(subtaskStanding(holder({ status: 'done', waitingOn: null }))).toBe('done')
    expect(subtaskStanding(holder({ status: 'cancelled', waitingOn: null }))).toBe('cancelled')
  })

  it('a run that ended well does not wait for it, and it does not count against a Done', () => {
    const t = tallySubtasks([holder()])
    expect(subtasksStillOut(t)).toBe(false)
    expect(unfinishedSubtasks(t)).toBe(0)
    expect(unfinishedSubtasks(tallySubtasks([holder({ status: 'cancelled' })]))).toBe(0)
  })

  it('the engine’s wait ignores it, and an agent’s own wait on everything holds for it', () => {
    const t = tallySubtasks([holder()])
    expect(subtaskWaitOver(t, { handedOutOnly: true })).toBe(true)
    expect(subtaskWaitOver(t)).toBe(false)
  })

  it('the steps beside it are what its parent waits on', () => {
    const step = view({ id: 'step', status: 'todo', execs: [] })
    expect(subtaskStanding(step)).toBe('coming')
    expect(subtasksStillOut(tallySubtasks([holder({ status: 'done' }), step]))).toBe(true)
  })
})

describe('requestWaitsOn: what a person’s request waits on', () => {
  it.each([
    ['work that is coming', view({ status: 'in_progress', assigneeAgentId: 'a2' }), true],
    ['work with a person', blocked({ kind: 'question', questionId: 'q' }), true],
    ['work a failure ended, until a person decides', blocked({ kind: 'failure' }), true],
    ['work a Stop ended', view({ status: 'todo', execs: [{ status: 'cancelled' }] }), true],
    [
      'an open card holding a plan, which the barrier reads as not handed out',
      view({ status: 'blocked', sourceDelegationId: encodePlanHolder('a2', 'x') }),
      true,
    ],
    [
      'a task a person filed and has not given to anyone',
      view({ sourceDelegationId: null, requestedBy: '{"id":"p1"}' }),
      true,
    ],
    ['an agent’s note to itself', view({ sourceDelegationId: null }), false],
    [
      'work that needs the request closed first',
      view({ status: 'blocked', waitingOn: { kind: 'task', taskId: 'm' }, waitsOnThisTask: true }),
      false,
    ],
    ['work that is done', view({ status: 'done' }), false],
    ['work that is cancelled', view({ status: 'cancelled' }), false],
    ['work that was removed', view({ status: 'todo', dropped: 1 }), false],
    [
      'a card holding a plan, once answered',
      view({ status: 'done', sourceDelegationId: encodePlanHolder('a2', 'x') }),
      false,
    ],
  ])('%s', (_name, task, waits) => {
    expect(requestWaitsOn(task)).toBe(waits)
  })
})
