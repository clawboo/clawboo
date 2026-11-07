import { describe, expect, it } from 'vitest'

import { PAUSED_RUN_CLASS } from '../dispatch'
import {
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
