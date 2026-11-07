// What keeps a wait true: a question lasts only while its task waits on it, an agent
// cannot end a person's wait, a wait that could never end is refused, and work that
// was cancelled comes to a person.

import { delegationFailureKey, LOCAL_PERSON, parseWaitingOn } from '@clawboo/board-core'
import { eq } from 'drizzle-orm'
import { beforeEach, describe, expect, it } from 'vitest'

import { createDb, type ClawbooDb } from '../../db'
import { tasks } from '../../schema'
import { listWaitingTaskWakes } from '../../taskWakes'
import { attentionForTask } from '../attention'
import { deriveCreateKey } from '../createDedupe'
import { noteDelegationFailure, readDelegationFailure } from '../delegationFailures'
import { LOCAL_READER } from '../readState'
import { answerQuestion, askQuestion, listTaskQuestions } from '../questions'
import {
  assignTaskToPerson,
  claimTask,
  createExecutionProcess,
  createSubtask,
  createTask,
  dropTask,
  getComments,
  getTask,
  handBackTask,
  linkDep,
  releaseTask,
  reopenTask,
  TaskDependencyCycleError,
  updateStatus,
  waitReaches,
} from '../repository'

let db: ClawbooDb
beforeEach(() => {
  db = createDb(':memory:')
})

const BOUND = 'run-1:deleg:agent:a2:reflectTo:leader'

function claimed(extra: { scheduledBy?: string } = {}): string {
  const t = createTask(db, {
    title: 'Write it',
    teamId: 'T',
    status: 'todo',
    sourceDelegationId: BOUND,
    ...extra,
  })
  expect(claimTask(db, t.id, 'a2').ok).toBe(true)
  return t.id
}

const ask = (taskId: string, key?: string) =>
  askQuestion(db, {
    taskId,
    agentId: 'a2',
    kind: 'confirm',
    payload: { prompt: 'Deploy?' },
    ...(key ? { idempotencyKey: key } : {}),
  })

const statusesOf = (taskId: string) => listTaskQuestions(db, taskId).map((q) => q.status)

/** The task back with its agent under a new run, as after a person's Retry. */
function runningAgain(id: string): void {
  expect(claimTask(db, id, 'a2').ok).toBe(true)
  createExecutionProcess(db, { taskId: id, executorType: 'openclaw' })
}

describe('a question lasts only while its task waits on it', () => {
  it('a new reason on a task already Blocked closes it', () => {
    const id = claimed()
    ask(id)
    expect(updateStatus(db, id, 'blocked', { waitingOn: { kind: 'failure' } }).ok).toBe(true)
    const [q] = listTaskQuestions(db, id)
    expect(q?.status).toBe('expired')
    expect(q?.closeReason).toBe('moved')
  })

  it('writing Blocked again with no new reason leaves it open', () => {
    const id = claimed()
    ask(id)
    expect(updateStatus(db, id, 'blocked').ok).toBe(true)
    expect(statusesOf(id)).toEqual(['pending'])
    expect(parseWaitingOn(getTask(db, id)?.waitingOn)?.kind).toBe('question')
  })

  it('a move closes it even when the reason no longer names it', () => {
    const id = claimed()
    ask(id)
    db.update(tasks).set({ waitingOn: '{"kind":"failure"}' }).where(eq(tasks.id, id)).run()
    expect(updateStatus(db, id, 'todo', { actor: 'person' }).ok).toBe(true)
    expect(statusesOf(id)).toEqual(['expired'])
  })

  it('a hand-back after a question closes the question, and keeps what the person must do', () => {
    const id = claimed()
    ask(id)
    expect(handBackTask(db, id, { agentId: 'a2', need: 'Log in' }).ok).toBe(true)
    expect(statusesOf(id)).toEqual(['expired'])
    expect(parseWaitingOn(getTask(db, id)?.waitingOn)).toMatchObject({
      kind: 'person',
      need: 'Log in',
    })
  })
})

describe('a repeated idempotency key', () => {
  it('asks again once the question closed unanswered, so the task really waits', () => {
    const id = claimed()
    const first = ask(id, 'k1')
    expect(first.ok).toBe(true)
    updateStatus(db, id, 'todo', { actor: 'person' })
    runningAgain(id)

    const again = ask(id, 'k1')

    expect(again.ok).toBe(true)
    if (!again.ok) return
    expect(again.existing).toBeUndefined()
    expect(again.question.status).toBe('pending')
    expect(getTask(db, id)?.status).toBe('blocked')
    expect(parseWaitingOn(getTask(db, id)?.waitingOn)).toEqual({
      kind: 'question',
      questionId: again.question.id,
    })
    expect(statusesOf(id).sort()).toEqual(['expired', 'pending'])
  })

  it('returns the answer once it was answered, and moves nothing', () => {
    const id = claimed()
    const first = ask(id, 'k1')
    if (!first.ok) throw new Error('ask failed')
    expect(
      answerQuestion(db, first.question.id, { confirmed: true }, { person: LOCAL_PERSON }).ok,
    ).toBe(true)
    updateStatus(db, id, 'todo')
    runningAgain(id)

    const again = ask(id, 'k1')

    expect(again.ok && again.existing).toBe(true)
    expect(again.ok && again.question.status).toBe('answered')
    expect(getTask(db, id)?.status).toBe('in_progress')
  })

  it('is judged after the task’s own state: a finished task or another agent’s is refused', () => {
    const id = claimed()
    const first = ask(id, 'k1')
    if (!first.ok) throw new Error('ask failed')
    answerQuestion(db, first.question.id, { confirmed: true }, { person: LOCAL_PERSON })
    updateStatus(db, id, 'cancelled', { actor: 'person' })
    expect(ask(id, 'k1')).toMatchObject({ ok: false, reason: 'finished' })

    const other = claimed()
    const asked = ask(other, 'k2')
    if (!asked.ok) throw new Error('ask failed')
    answerQuestion(db, asked.question.id, { confirmed: true }, { person: LOCAL_PERSON })
    updateStatus(db, other, 'todo')
    claimTask(db, other, 'someone-else')
    expect(ask(other, 'k2')).toMatchObject({ ok: false, reason: 'not_yours' })
  })
})

describe('an agent’s write on a person’s wait', () => {
  it('cannot end or rewrite a wait on a question', () => {
    const id = claimed()
    ask(id)
    for (const write of [
      () => updateStatus(db, id, 'todo', { unlessPersonMoved: true }),
      () =>
        updateStatus(db, id, 'blocked', {
          unlessPersonMoved: true,
          waitingOn: { kind: 'person', need: 'x', by: 'agent' },
        }),
      () => updateStatus(db, id, 'in_progress', { unlessPersonMoved: true }),
      () => updateStatus(db, id, 'cancelled', { unlessPersonMoved: true }),
    ]) {
      expect(write()).toMatchObject({ ok: false, reason: 'awaiting_answer' })
    }
    expect(statusesOf(id)).toEqual(['pending'])
    expect(getTask(db, id)?.status).toBe('blocked')
    expect(parseWaitingOn(getTask(db, id)?.waitingOn)?.kind).toBe('question')
  })

  it('cannot move a task assigned to a person, from any status', () => {
    const t = createTask(db, { title: 'Theirs', teamId: 'T', status: 'todo' })
    expect(assignTaskToPerson(db, t.id, LOCAL_PERSON).ok).toBe(true)
    for (const to of ['in_progress', 'blocked', 'cancelled', 'done'] as const) {
      expect(updateStatus(db, t.id, to, { unlessPersonMoved: true }), to).toMatchObject({
        ok: false,
        reason: 'person_assigned',
      })
    }
    expect(getTask(db, t.id)?.status).toBe('todo')
  })

  it('cannot end a hand-back', () => {
    const id = claimed()
    handBackTask(db, id, { agentId: 'a2', need: 'Log in' })
    expect(updateStatus(db, id, 'todo', { unlessPersonMoved: true })).toMatchObject({
      ok: false,
      reason: 'person_assigned',
    })
    expect(getTask(db, id)?.status).toBe('blocked')
  })

  it('a release leaves a person’s task alone', () => {
    const t = createTask(db, { title: 'Theirs', teamId: 'T', status: 'todo' })
    assignTaskToPerson(db, t.id, LOCAL_PERSON)
    updateStatus(db, t.id, 'in_progress', { actor: 'person' })
    releaseTask(db, t.id)
    expect(getTask(db, t.id)?.status).toBe('in_progress')
    expect(getTask(db, t.id)?.assigneePersonId).toBe(LOCAL_PERSON.id)
  })

  it('the board’s own writes still pass: a person’s, and the engine’s', () => {
    const id = claimed()
    ask(id)
    expect(updateStatus(db, id, 'todo', { actor: 'person' }).ok).toBe(true)
    const t = claimed()
    ask(t)
    expect(updateStatus(db, t, 'blocked', { waitingOn: { kind: 'budget' } }).ok).toBe(true)
  })

  it('giving a task to a person overrules the run it was taken from', () => {
    const id = claimed()
    createExecutionProcess(db, { taskId: id, executorType: 'openclaw' })
    updateStatus(db, id, 'blocked', { waitingOn: { kind: 'failure' } })
    const before = Date.now()
    expect(assignTaskToPerson(db, id, LOCAL_PERSON).ok).toBe(true)
    expect(getTask(db, id)?.personMovedAt).toBeGreaterThanOrEqual(before)
  })
})

describe('what a task can wait on', () => {
  const plain = (title = 'Task') => createTask(db, { title, teamId: 'T', status: 'todo' }).id

  it('follows a wait on a task, a wait on sub-tasks, and a dependency', () => {
    const p = plain('Parent')
    const s = createSubtask(db, p, { title: 'Sub', status: 'todo' }).id
    expect(waitReaches(db, [p], s)).toBe(false)
    updateStatus(db, p, 'in_progress')
    updateStatus(db, p, 'blocked', { waitingOn: { kind: 'subtasks' } })
    expect(waitReaches(db, [p], s)).toBe(true)

    const a = plain('A')
    const b = plain('B')
    linkDep(db, b, a)
    expect(waitReaches(db, [b], a)).toBe(true)

    const c = plain('C')
    updateStatus(db, c, 'in_progress')
    updateStatus(db, c, 'blocked', { waitingOn: { kind: 'task', taskId: b } })
    expect(waitReaches(db, [c], a)).toBe(true)
    expect(waitReaches(db, [a], c)).toBe(false)
  })

  it('stops at work that already finished, and survives a loop in the data', () => {
    const far = plain('Far')
    const a = plain('A')
    const b = plain('B')
    linkDep(db, a, far)
    linkDep(db, b, a)
    expect(waitReaches(db, [b], far)).toBe(true)
    updateStatus(db, a, 'cancelled')
    expect(waitReaches(db, [b], far)).toBe(false)

    const x = plain('X')
    const y = plain('Y')
    const waitOn = (id: string, taskId: string) =>
      db
        .update(tasks)
        .set({ status: 'blocked', waitingOn: JSON.stringify({ kind: 'task', taskId }) })
        .where(eq(tasks.id, id))
        .run()
    waitOn(x, y)
    waitOn(y, x)
    expect(waitReaches(db, [x], 'nowhere')).toBe(false)
  })

  it('a dependency that would close a loop with a wait is refused, in the other order too', () => {
    const t = plain('T')
    const x = plain('X')
    updateStatus(db, t, 'in_progress')
    updateStatus(db, t, 'blocked', { waitingOn: { kind: 'task', taskId: x } })
    expect(() => linkDep(db, x, t)).toThrow(TaskDependencyCycleError)
  })
})

describe('Reopen and the work a step depends on', () => {
  function cancelledStep(): { blocker: string; step: string } {
    const blocker = createTask(db, { title: 'First step', teamId: 'T', status: 'todo' }).id
    const step = createTask(db, { title: 'Second step', teamId: 'T', status: 'todo' }).id
    linkDep(db, step, blocker)
    updateStatus(db, blocker, 'cancelled')
    updateStatus(db, step, 'cancelled')
    return { blocker, step }
  }

  it('refuses a step whose blocker stays cancelled, rather than leaving it looking queued', () => {
    const { step } = cancelledStep()
    expect(reopenTask(db, step)).toMatchObject({ ok: false, reason: 'blocker_cancelled' })
    expect(getTask(db, step)?.status).toBe('cancelled')
  })

  it('takes the step once its blocker is reopened', () => {
    const { blocker, step } = cancelledStep()
    expect(reopenTask(db, blocker).ok).toBe(true)
    expect(reopenTask(db, step).ok).toBe(true)
    expect(getTask(db, step)?.status).toBe('todo')
  })

  it('a blocker that was dropped is as gone as a cancelled one; a done one is fine', () => {
    const gone = createTask(db, { title: 'Gone', teamId: 'T', status: 'todo' }).id
    const step = createTask(db, { title: 'Step', teamId: 'T', status: 'todo' }).id
    linkDep(db, step, gone)
    updateStatus(db, step, 'cancelled')
    dropTask(db, gone)
    expect(reopenTask(db, step)).toMatchObject({ ok: false, reason: 'blocker_cancelled' })

    const fine = createTask(db, { title: 'Fine', teamId: 'T', status: 'todo' }).id
    const next = createTask(db, { title: 'Next', teamId: 'T', status: 'todo' }).id
    linkDep(db, next, fine)
    updateStatus(db, fine, 'in_progress')
    updateStatus(db, fine, 'done')
    updateStatus(db, next, 'cancelled')
    expect(reopenTask(db, next).ok).toBe(true)
  })
})

describe('Reopen gives the task a fresh start', () => {
  it('holds its slot under its parent again', () => {
    const parent = claimed()
    const child = createSubtask(db, parent, { title: 'Part', status: 'todo' }).id
    updateStatus(db, child, 'cancelled', { actor: 'person' })
    expect(getTask(db, child)?.personCancelledAt).toBeTypeOf('number')
    expect(reopenTask(db, child).ok).toBe(true)
    expect(getTask(db, child)?.personCancelledAt).toBeNull()
  })

  it('its next run can make the same sub-task again, and the key its create named', () => {
    const task = claimed()
    const key = (named: boolean) =>
      named
        ? { key: `mcp:task:${task}::my-key:hash` }
        : deriveCreateKey(['mcp-task', task, ''], 'Write the tests')
    const make = (named: boolean) =>
      createSubtask(db, task, {
        title: 'Write the tests',
        status: 'todo',
        agentCreated: true,
        createKey: key(named),
      })
    const first = make(false)
    const named = make(true)
    // Same key within the run: the same task, so a retry makes no second one.
    expect(make(false).id).toBe(first.id)
    expect(make(true).id).toBe(named.id)
    updateStatus(db, first.id, 'in_progress')
    updateStatus(db, first.id, 'done')
    updateStatus(db, named.id, 'in_progress')
    updateStatus(db, named.id, 'done')
    updateStatus(db, task, 'cancelled', { actor: 'person' })

    expect(reopenTask(db, task).ok).toBe(true)

    const again = make(false)
    expect(again.deduplicated).toBeUndefined()
    expect(again.id).not.toBe(first.id)
    const againNamed = make(true)
    expect(againNamed.id).not.toBe(named.id)
  })

  it('a key that points at the reopened task still answers: it is open again', () => {
    const key = { key: 'rest:T:draft-1' }
    const made = createTask(db, { title: 'Draft', teamId: 'T', status: 'todo', createKey: key })
    updateStatus(db, made.id, 'cancelled', { actor: 'person' })
    expect(reopenTask(db, made.id).ok).toBe(true)
    expect(createTask(db, { title: 'Draft', teamId: 'T', createKey: key }).id).toBe(made.id)
  })

  it('its agent’s failure count on it goes, so it can be handed out again', () => {
    const t = createTask(db, {
      title: 'Fix the Login page',
      teamId: 'T',
      status: 'todo',
      sourceDelegationId: BOUND,
    })
    const count = delegationFailureKey('a2', t.title)
    noteDelegationFailure(db, 'T', 'a2', count)
    noteDelegationFailure(db, 'T', 'other', delegationFailureKey('other', t.title))
    updateStatus(db, t.id, 'cancelled', { actor: 'person' })
    expect(readDelegationFailure(db, 'T', 'a2', count).failures).toBe(1)
    expect(reopenTask(db, t.id).ok).toBe(true)
    expect(readDelegationFailure(db, 'T', 'a2', count).failures).toBe(0)
    // Another agent's count is not this task's to clear.
    expect(
      readDelegationFailure(db, 'T', 'other', delegationFailureKey('other', t.title)).failures,
    ).toBe(1)
  })
})

describe('a task released from a wait', () => {
  it('goes back to the queue with a saved wake, in the write that closed the other work', () => {
    const other = createTask(db, { title: 'First', teamId: 'T', status: 'todo' })
    const waiter = claimed()
    updateStatus(db, waiter, 'blocked', { waitingOn: { kind: 'task', taskId: other.id } })
    updateStatus(db, other.id, 'in_progress')
    updateStatus(db, other.id, 'done')
    expect(getTask(db, waiter)?.status).toBe('todo')
    expect(listWaitingTaskWakes(db, { taskId: waiter }).map((w) => w.reason)).toEqual([
      'dependency_done',
    ])
  })

  it('saves no wake when it goes to a person instead', () => {
    const other = createTask(db, { title: 'First', teamId: 'T', status: 'todo' })
    const waiter = claimed()
    updateStatus(db, waiter, 'blocked', { waitingOn: { kind: 'task', taskId: other.id } })
    updateStatus(db, other.id, 'cancelled', { actor: 'person' })
    expect(getTask(db, waiter)?.status).toBe('blocked')
    expect(listWaitingTaskWakes(db, { taskId: waiter })).toEqual([])
  })
})

describe('a parent waiting on its sub-tasks', () => {
  function parentWith(n: number): { parent: string; subs: string[] } {
    const parent = claimed()
    const subs = Array.from(
      { length: n },
      (_, i) => createSubtask(db, parent, { title: `Part ${i}`, status: 'todo' }).id,
    )
    updateStatus(db, parent, 'blocked', { waitingOn: { kind: 'subtasks' } })
    return { parent, subs }
  }
  const finish = (id: string) => {
    updateStatus(db, id, 'in_progress')
    updateStatus(db, id, 'done')
  }

  it('goes back to the queue when they are all done', () => {
    const { parent, subs } = parentWith(2)
    subs.forEach(finish)
    expect(getTask(db, parent)?.status).toBe('todo')
  })

  it('goes to a person when the last one is cancelled, and is not started', () => {
    const { parent, subs } = parentWith(2)
    finish(subs[0]!)
    updateStatus(db, subs[1]!, 'cancelled', { actor: 'person' })
    const row = getTask(db, parent)
    expect(row?.status).toBe('blocked')
    expect(attentionForTask(db, parent)?.reason).toBe('blocked')
    expect(parseWaitingOn(row?.waitingOn)).toMatchObject({ kind: 'person' })
    expect(getComments(db, parent).at(-1)?.body).toMatch(/cancelled/i)
    expect(getComments(db, parent).at(-1)?.body).not.toMatch(/have finished\.$/)
  })

  it('goes to a person when one was cancelled earlier and the last one is done', () => {
    const { parent, subs } = parentWith(2)
    updateStatus(db, subs[0]!, 'cancelled', { actor: 'person' })
    finish(subs[1]!)
    expect(getTask(db, parent)?.status).toBe('blocked')
    expect(parseWaitingOn(getTask(db, parent)?.waitingOn)).toMatchObject({ kind: 'person' })
  })

  it('goes to a person when they are all cancelled, or an open one was dropped', () => {
    const all = parentWith(2)
    all.subs.forEach((s) => updateStatus(db, s, 'cancelled', { actor: 'person' }))
    expect(getTask(db, all.parent)?.status).toBe('blocked')

    const some = parentWith(2)
    dropTask(db, some.subs[0]!)
    finish(some.subs[1]!)
    expect(getTask(db, some.parent)?.status).toBe('blocked')
  })

  it('a done sub-task dropped later is not a decision against the work', () => {
    const { parent, subs } = parentWith(2)
    finish(subs[0]!)
    dropTask(db, subs[0]!)
    finish(subs[1]!)
    expect(getTask(db, parent)?.status).toBe('todo')
  })
})

describe('a routine’s task', () => {
  it('is not handed back: its next fire needs it in To do', () => {
    const id = claimed({ scheduledBy: 'clawboo' })
    expect(handBackTask(db, id, { agentId: 'a2', need: 'Log in' })).toMatchObject({
      ok: false,
      reason: 'routine',
    })
    expect(getTask(db, id)?.status).toBe('in_progress')
    expect(getTask(db, id)?.assigneePersonId).toBeNull()
  })

  it('counts whichever owner fires it', () => {
    const id = claimed({ scheduledBy: 'hermes' })
    expect(handBackTask(db, id, { agentId: 'a2', need: 'x' })).toMatchObject({ reason: 'routine' })
    expect(ask(id)).toMatchObject({ ok: false, reason: 'routine' })
  })
})

describe('the built-in person and the built-in reader', () => {
  it('are one id, so read state needs no move now that the person exists', () => {
    expect(LOCAL_READER).toBe(LOCAL_PERSON.id)
  })
})
