// waiting_on, person assignees, Reopen and hand-backs in the board repository.

import { LOCAL_PERSON, parseWaitingOn } from '@clawboo/board-core'
import { beforeEach, describe, expect, it } from 'vitest'

import { createDb, type ClawbooDb } from '../../db'
import { attentionForTask } from '../attention'
import { onBoardLifecycle } from '../events'
import {
  addComment,
  assignTaskDelegation,
  assignTaskToPerson,
  claimTask,
  completeExecutionProcess,
  createExecutionProcess,
  createSubtask,
  createTask,
  dropTask,
  getComments,
  getReadyTasks,
  getTask,
  handBackTask,
  listTeamsWithFireableDelegations,
  noteBlockedReason,
  reconcileOrphans,
  reopenTask,
  setTaskWaitingOn,
  updateStatus,
} from '../repository'

let db: ClawbooDb
beforeEach(() => {
  db = createDb(':memory:')
})

const BOUND = 'run-1:deleg:agent:a2:reflectTo:leader'
const PRIYA = { id: 'p-priya', name: 'Priya', role: null }

function claimed(sdid: string | null = BOUND, agent = 'a2'): string {
  const t = createTask(db, {
    title: 'Write it',
    teamId: 'T',
    status: 'todo',
    ...(sdid ? { sourceDelegationId: sdid } : {}),
  })
  expect(claimTask(db, t.id, agent).ok).toBe(true)
  return t.id
}

describe('updateStatus keeps waiting_on honest', () => {
  it('stores the reason given, and clears it when the task moves on', () => {
    const id = claimed()
    updateStatus(db, id, 'blocked', { waitingOn: { kind: 'failure' } })
    expect(parseWaitingOn(getTask(db, id)?.waitingOn)).toEqual({ kind: 'failure' })
    updateStatus(db, id, 'todo')
    expect(getTask(db, id)?.waitingOn).toBeNull()
  })

  it('a repeated write of the same status keeps the reason', () => {
    const id = claimed()
    updateStatus(db, id, 'blocked', { waitingOn: { kind: 'person', need: 'Pick one' } })
    updateStatus(db, id, 'blocked')
    expect(parseWaitingOn(getTask(db, id)?.waitingOn)).toEqual({ kind: 'person', need: 'Pick one' })
  })

  it('accepts a bare Blocked: the requirement is at the agent surface', () => {
    const id = claimed()
    expect(updateStatus(db, id, 'blocked').ok).toBe(true)
    expect(getTask(db, id)?.waitingOn).toBeNull()
  })

  it('the orphan reap of In review says it is a recovery', () => {
    const t = createTask(db, { title: 'x', teamId: 'T', status: 'todo' })
    claimTask(db, t.id, 'a2')
    // On the task runner: a team-chat check is its next engine's to park.
    createExecutionProcess(db, { taskId: t.id, executorType: 'claude-code' })
    updateStatus(db, t.id, 'in_review', { waitingOn: { kind: 'verification', state: 'running' } })
    reconcileOrphans(db, { staleAfterMs: -1 })
    expect(getTask(db, t.id)?.status).toBe('blocked')
    expect(parseWaitingOn(getTask(db, t.id)?.waitingOn)).toEqual({ kind: 'recovery' })
  })

  it('a check waiting to be parked gets a reason without moving', () => {
    const id = claimed()
    updateStatus(db, id, 'in_review')
    setTaskWaitingOn(db, id, { kind: 'verification', state: 'park_pending' })
    expect(getTask(db, id)?.status).toBe('in_review')
    expect(attentionForTask(db, id)?.reason).toBe('needs_review')
  })

  it('can say why a Blocked task did not start, and only while it is still Blocked', () => {
    const id = claimed()
    updateStatus(db, id, 'blocked')
    noteBlockedReason(db, id, { kind: 'person', need: 'Your answer is saved.' })
    expect(attentionForTask(db, id)?.detail).toBe('Your answer is saved.')
    updateStatus(db, id, 'todo')
    noteBlockedReason(db, id, { kind: 'person', need: 'Too late' })
    expect(getTask(db, id)?.waitingOn).toBeNull()
  })

  it('never writes a waiting reason onto a task that moved past it', () => {
    const id = claimed()
    updateStatus(db, id, 'done')
    setTaskWaitingOn(db, id, { kind: 'verification', state: 'park_pending' })
    expect(getTask(db, id)?.waitingOn).toBeNull()
  })
})

describe('every waiting task has a way out', () => {
  function waitingOnTask(blockerId: string): string {
    const id = claimed()
    updateStatus(db, id, 'blocked', { waitingOn: { kind: 'task', taskId: blockerId } })
    return id
  }

  it('a task waiting on another task is out of Needs you, and goes back to the queue when it is done', () => {
    const blocker = createTask(db, { title: 'First', teamId: 'T', status: 'todo' })
    claimTask(db, blocker.id, 'a1')
    const waiter = waitingOnTask(blocker.id)
    expect(attentionForTask(db, waiter)).toBeNull()

    updateStatus(db, blocker.id, 'done')

    const after = getTask(db, waiter)
    expect(after?.status).toBe('todo')
    expect(after?.waitingOn).toBeNull()
    // The dispatch pump finds it, bound to its agent.
    expect(getReadyTasks(db, { teamId: 'T' }).map((t) => t.id)).toContain(waiter)
    expect(listTeamsWithFireableDelegations(db)).toContain('T')
    expect(getComments(db, waiter).at(-1)?.body).toContain('First')
  })

  it('goes to a person when the task it waited on is cancelled', () => {
    const blocker = createTask(db, { title: 'First', teamId: 'T', status: 'todo' })
    const waiter = waitingOnTask(blocker.id)
    updateStatus(db, blocker.id, 'cancelled')
    const after = getTask(db, waiter)
    expect(after?.status).toBe('blocked')
    expect(parseWaitingOn(after?.waitingOn)?.kind).toBe('person')
    expect(attentionForTask(db, waiter)?.reason).toBe('blocked')
    expect(attentionForTask(db, waiter)?.detail).toContain('First')
  })

  it('goes to a person when the task it waited on is dropped', () => {
    const blocker = createTask(db, { title: 'First', teamId: 'T', status: 'todo' })
    const waiter = waitingOnTask(blocker.id)
    dropTask(db, blocker.id)
    expect(attentionForTask(db, waiter)?.reason).toBe('blocked')
  })

  it('an unbound waiter goes to a person: nothing would start it', () => {
    const blocker = createTask(db, { title: 'First', teamId: 'T', status: 'todo' })
    claimTask(db, blocker.id, 'a1')
    const id = claimed(null)
    updateStatus(db, id, 'blocked', { waitingOn: { kind: 'task', taskId: blocker.id } })
    updateStatus(db, blocker.id, 'done')
    expect(getTask(db, id)?.status).toBe('blocked')
    expect(attentionForTask(db, id)?.reason).toBe('blocked')
  })

  it('a task waiting on its sub-tasks is out of Needs you until the last one closes', () => {
    const parent = claimed()
    const a = createSubtask(db, parent, { title: 'a', status: 'todo' })
    const b = createSubtask(db, parent, { title: 'b', status: 'todo' })
    updateStatus(db, parent, 'blocked', { waitingOn: { kind: 'subtasks' } })
    expect(attentionForTask(db, parent)).toBeNull()

    claimTask(db, a.id, 'a1')
    updateStatus(db, a.id, 'done')
    expect(getTask(db, parent)?.status).toBe('blocked')

    claimTask(db, b.id, 'a1')
    updateStatus(db, b.id, 'done')
    expect(getTask(db, parent)?.status).toBe('todo')
    expect(getTask(db, parent)?.waitingOn).toBeNull()
  })

  it('leaves a waiter a person already moved on alone', () => {
    const blocker = createTask(db, { title: 'First', teamId: 'T', status: 'todo' })
    const waiter = waitingOnTask(blocker.id)
    updateStatus(db, waiter, 'cancelled', { actor: 'person' })
    updateStatus(db, blocker.id, 'cancelled')
    expect(getTask(db, waiter)?.status).toBe('cancelled')
  })
})

describe('person assignees', () => {
  it('an agent cannot claim a person’s task: the claim itself refuses', () => {
    const t = createTask(db, { title: 'Mine', teamId: 'T', status: 'todo' })
    expect(assignTaskToPerson(db, t.id, LOCAL_PERSON).ok).toBe(true)
    const r = claimTask(db, t.id, 'a2')
    expect(r.ok).toBe(false)
    expect(r.reason).toBe('person_assigned')
    expect(getTask(db, t.id)?.assigneeAgentId).toBeNull()
    expect(getTask(db, t.id)?.status).toBe('todo')
  })

  it('never auto-starts and is not filed as unassigned', () => {
    const t = createTask(db, {
      title: 'Mine',
      teamId: 'T',
      status: 'todo',
      sourceDelegationId: BOUND,
    })
    assignTaskToPerson(db, t.id, LOCAL_PERSON)
    expect(getReadyTasks(db, { teamId: 'T' }).map((x) => x.id)).not.toContain(t.id)
    expect(listTeamsWithFireableDelegations(db)).not.toContain('T')
    expect(attentionForTask(db, t.id)).toMatchObject({ reason: 'assigned', personId: 'local' })
  })

  it('takes the agent binding off, so a later reply reaches no agent', () => {
    const t = createTask(db, {
      title: 'Mine',
      teamId: 'T',
      status: 'todo',
      sourceDelegationId: BOUND,
    })
    const r = assignTaskToPerson(db, t.id, PRIYA)
    expect(r.ok).toBe(true)
    const row = getTask(db, t.id)
    expect(row?.assigneePersonId).toBe('p-priya')
    expect(JSON.parse(row?.assigneePerson ?? '{}')).toEqual(PRIYA)
    expect(row?.sourceDelegationId ?? '').not.toContain(':agent:')
    // Who delegated it still hears about it.
    expect(row?.sourceDelegationId ?? '').toContain('reflectTo:leader')
  })

  it('a task cannot have both assignees, whoever writes', () => {
    const id = claimed()
    // Assigned to a person while an agent runs it: refused.
    expect(assignTaskToPerson(db, id, LOCAL_PERSON).ok).toBe(false)
    expect(getTask(db, id)?.assigneePersonId).toBeNull()
    // And the column pair refuses it outright, for a raw writer too.
    expect(() =>
      db.$client.prepare(`UPDATE tasks SET assignee_person_id = 'local' WHERE id = ?`).run(id),
    ).toThrow(/one assignee/i)
  })

  it('assigning an agent takes the person off', () => {
    const t = createTask(db, { title: 'Mine', teamId: 'T', status: 'todo' })
    assignTaskToPerson(db, t.id, LOCAL_PERSON)
    const r = assignTaskDelegation(db, t.id, 'assign:n1:agent:a2:origin:human')
    expect(r.ok).toBe(true)
    expect(getTask(db, t.id)?.assigneePersonId).toBeNull()
    expect(claimTask(db, t.id, 'a2').ok).toBe(true)
  })

  it('a person can give it up again', () => {
    const t = createTask(db, { title: 'Mine', teamId: 'T', status: 'todo' })
    assignTaskToPerson(db, t.id, LOCAL_PERSON)
    expect(assignTaskToPerson(db, t.id, null).ok).toBe(true)
    expect(getTask(db, t.id)?.assigneePersonId).toBeNull()
    expect(attentionForTask(db, t.id)?.reason).toBe('unassigned')
  })

  it('a person finishes their own task from To do or Blocked', () => {
    const t = createTask(db, { title: 'Mine', teamId: 'T', status: 'todo' })
    assignTaskToPerson(db, t.id, LOCAL_PERSON)
    expect(updateStatus(db, t.id, 'done', { actor: 'person' }).ok).toBe(true)
    expect(getTask(db, t.id)?.completedAt).toBeTypeOf('number')
  })

  it('nobody else can skip to Done on a task that is not a person’s', () => {
    const t = createTask(db, { title: 'Theirs', teamId: 'T', status: 'todo' })
    expect(updateStatus(db, t.id, 'done', { actor: 'person' }).ok).toBe(false)
  })

  it('an agent cannot finish a person’s task through the same move', () => {
    const t = createTask(db, { title: 'Mine', teamId: 'T', status: 'todo' })
    assignTaskToPerson(db, t.id, LOCAL_PERSON)
    expect(updateStatus(db, t.id, 'done', { unlessPersonMoved: true }).ok).toBe(false)
    expect(updateStatus(db, t.id, 'done').ok).toBe(false)
  })

  it('marking a person’s task done leaves its dependents ready', () => {
    const t = createTask(db, { title: 'Mine', teamId: 'T', status: 'todo' })
    assignTaskToPerson(db, t.id, LOCAL_PERSON)
    const next = createTask(db, {
      title: 'Next',
      teamId: 'T',
      status: 'todo',
      sourceDelegationId: BOUND,
    })
    db.$client
      .prepare(`INSERT INTO task_deps (task_id, depends_on_task_id) VALUES (?, ?)`)
      .run(next.id, t.id)
    expect(getReadyTasks(db, { teamId: 'T' }).map((x) => x.id)).not.toContain(next.id)
    updateStatus(db, t.id, 'done', { actor: 'person' })
    expect(getReadyTasks(db, { teamId: 'T' }).map((x) => x.id)).toContain(next.id)
  })
})

describe('hand-backs', () => {
  it('blocks the agent’s own task, assigned to the person who asked, with what they must do', () => {
    const t = createTask(db, {
      title: 'Deploy',
      teamId: 'T',
      status: 'todo',
      sourceDelegationId: BOUND,
      requestedBy: PRIYA,
    })
    claimTask(db, t.id, 'a2')
    const r = handBackTask(db, t.id, { agentId: 'a2', need: 'Check the deploy' })
    expect(r.ok).toBe(true)
    const row = getTask(db, t.id)
    expect(row?.status).toBe('blocked')
    expect(row?.assigneePersonId).toBe('p-priya')
    expect(row?.assigneeAgentId).toBeNull()
    // The agent stays bound: a person's reply or Retry goes back to it.
    expect(row?.sourceDelegationId).toBe(BOUND)
    expect(parseWaitingOn(row?.waitingOn)).toEqual({
      kind: 'person',
      need: 'Check the deploy',
      personId: 'p-priya',
      by: 'agent',
    })
    expect(attentionForTask(db, t.id)).toMatchObject({
      reason: 'assigned',
      personId: 'p-priya',
      detail: 'Check the deploy',
      handedBack: true,
    })
  })

  it('finds who asked up the parent chain, else the built-in person', () => {
    const root = createTask(db, { title: 'Root', teamId: 'T', status: 'todo', requestedBy: PRIYA })
    const child = createSubtask(db, root.id, { title: 'c', status: 'todo' })
    claimTask(db, child.id, 'a2')
    expect(handBackTask(db, child.id, { agentId: 'a2', need: 'x' }).ok).toBe(true)
    expect(getTask(db, child.id)?.assigneePersonId).toBe('p-priya')

    const lone = claimed()
    expect(handBackTask(db, lone, { agentId: 'a2', need: 'x' }).ok).toBe(true)
    expect(getTask(db, lone)?.assigneePersonId).toBe('local')
  })

  it('refuses another agent’s task and a task a person moved', () => {
    const id = claimed()
    expect(handBackTask(db, id, { agentId: 'a9', need: 'x' })).toMatchObject({
      ok: false,
      reason: 'not_yours',
    })
    updateStatus(db, id, 'todo', { actor: 'person' })
    const again = claimed()
    updateStatus(db, again, 'blocked', { actor: 'person' })
    expect(handBackTask(db, again, { agentId: 'a2', need: 'x' })).toMatchObject({
      ok: false,
      reason: 'person_moved',
    })
  })

  it('a hand-back stays in the run ledger’s hands: its close still knows the agent', () => {
    const id = claimed()
    const exec = createExecutionProcess(db, { taskId: id, executorType: 'openclaw' })
    handBackTask(db, id, { agentId: 'a2', need: 'x' })
    expect(completeExecutionProcess(db, exec.id, { status: 'succeeded' })?.status).toBe('succeeded')
  })
})

describe('Reopen', () => {
  it('moves Done and Cancelled to To do for a person, and clears the finish time', () => {
    for (const end of ['done', 'cancelled'] as const) {
      const id = claimed()
      updateStatus(db, id, end, {
        actor: 'person',
        ...(end === 'done' ? { humanOverride: true } : {}),
      })
      expect(getTask(db, id)?.completedAt).toBeTypeOf('number')
      const r = reopenTask(db, id)
      expect(r.ok, end).toBe(true)
      expect(r.from).toBe(end)
      const row = getTask(db, id)
      expect(row?.status).toBe('todo')
      expect(row?.completedAt).toBeNull()
      expect(row?.personMovedAt).toBeTypeOf('number')
    }
  })

  it('is refused for a task that is not finished', () => {
    const t = createTask(db, { title: 'x', teamId: 'T', status: 'todo' })
    expect(reopenTask(db, t.id).ok).toBe(false)
  })

  it('stays out of every other writer’s reach', () => {
    const id = claimed()
    updateStatus(db, id, 'done')
    // The board PATCH's actor, an agent's own write and the engine's plain write.
    expect(updateStatus(db, id, 'todo', { actor: 'person' }).reason).toBe('illegal_transition')
    expect(updateStatus(db, id, 'todo', { unlessPersonMoved: true }).reason).toBe(
      'illegal_transition',
    )
    expect(updateStatus(db, id, 'todo').reason).toBe('illegal_transition')
    // Reopen with no person behind it does not count either.
    expect(updateStatus(db, id, 'todo', { reopen: true }).reason).toBe('illegal_transition')
    expect(getTask(db, id)?.status).toBe('done')
  })

  it('finishing it a second time records the new finish', () => {
    const id = claimed()
    updateStatus(db, id, 'done')
    reopenTask(db, id)
    claimTask(db, id, 'a2')
    updateStatus(db, id, 'done')
    expect(getTask(db, id)?.completedAt).toBeTypeOf('number')
  })
})

describe('creating a waiting task', () => {
  it('keeps the reason on the row', () => {
    const t = createTask(db, {
      title: 'x',
      teamId: 'T',
      status: 'blocked',
      waitingOn: { kind: 'person', need: 'Decide' },
    })
    expect(parseWaitingOn(getTask(db, t.id)?.waitingOn)).toEqual({ kind: 'person', need: 'Decide' })
    addComment(db, t.id, 'note', 'system')
  })
})

describe('a person taking a task over', () => {
  const FAILING = JSON.stringify({ status: 'fail', attempts: [], debtNotes: [], updatedAt: 1 })

  /** Blocked, with a verdict that keeps it from Done. */
  function failedCheck(): string {
    const id = claimed()
    updateStatus(db, id, 'blocked', { waitingOn: { kind: 'verification', state: 'failed' } })
    db.$client.prepare('UPDATE tasks SET verification = ? WHERE id = ?').run(FAILING, id)
    return id
  }

  it('clears the verdict, as every other move to To do does, so Done can work', () => {
    const id = failedCheck()
    expect(updateStatus(db, id, 'done', { actor: 'person' }).reason).toBe('illegal_transition')
    expect(assignTaskToPerson(db, id, LOCAL_PERSON).ok).toBe(true)
    expect(getTask(db, id)?.verification).toBeNull()
    expect(updateStatus(db, id, 'done', { actor: 'person' }).ok).toBe(true)
  })

  it('leaves nothing to refuse an agent’s Done if the person gives it on', () => {
    const id = failedCheck()
    assignTaskToPerson(db, id, LOCAL_PERSON)
    expect(assignTaskDelegation(db, id, 'assign:n1:agent:a2:origin:human').ok).toBe(true)
    expect(claimTask(db, id, 'a2').ok).toBe(true)
    expect(updateStatus(db, id, 'done').ok).toBe(true)
  })

  it('tells open views, even when the status stays in To do', () => {
    const t = createTask(db, { title: 'Mine', teamId: 'T', status: 'todo' })
    const seen: string[] = []
    const off = onBoardLifecycle((ev) => {
      if (ev.taskId === t.id && ev.kind === 'status_changed') seen.push(ev.status)
    })
    assignTaskToPerson(db, t.id, LOCAL_PERSON)
    expect(seen).toEqual(['todo'])
    // And when a person's task in To do goes to an agent.
    assignTaskDelegation(db, t.id, 'assign:n1:agent:a2:origin:human')
    expect(seen).toEqual(['todo', 'todo'])
    off()
  })
})
