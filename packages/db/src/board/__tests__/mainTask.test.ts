// A person's request as one main task with the helpers' work filed under it: how it
// is created, that it never runs by itself, and how the depth cap reads around it.

import { mkdtempSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { DEFAULT_MAX_CHILDREN, DEFAULT_MAX_DEPTH } from '@clawboo/governance'

import { createDb, type ClawbooDb } from '../../db'
import { latestReportUpForTasks, recordReportUp, settleReportUps } from '../../reportUps'
import { teams } from '../../schema'
import {
  assignTaskDelegation,
  assignTaskToPerson,
  claimTask,
  closeMainTask,
  closeMainTaskByPerson,
  closeOpenSubtasksOfMain,
  createCappedRootTask,
  createCappedSubtask,
  createHandOffUnderRequest,
  createTask,
  getAncestors,
  getReadyTasks,
  getTask,
  handOffCapacity,
  handOffChain,
  handedDownFromWork,
  listOpenMainTasks,
  listRoomsWithIdleMainTasks,
  mainTaskOfTask,
  mainTaskState,
  parkMainTask,
  releaseTask,
  reopenTask,
  spawnDepth,
  updateStatus,
  waitingOnDetailOf,
} from '../repository'
import { parsePersonJson } from '../../person'

let dir: string
let db: ClawbooDb
const TEAM = 'team-1'

beforeEach(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), 'clawboo-main-task-'))
  db = createDb(path.join(dir, 'test.db'))
  db.insert(teams)
    .values({
      id: TEAM,
      name: 'Team',
      icon: 'x',
      color: '#000',
      createdAt: 1,
      updatedAt: 1,
    } as never)
    .run()
})

afterEach(() => {
  db.$client.close()
  rmSync(dir, { recursive: true, force: true })
})

const request = (over: Partial<Parameters<typeof createHandOffUnderRequest>[1]> = {}) => ({
  title: 'Build the login page',
  description: 'Build the login page\nwith a password reset',
  leadAgentId: 'lead',
  key: `main:${TEAM}:d1`,
  ...over,
})

function firstHandOff(over: Parameters<typeof request>[0] = {}, title = 'Write the form') {
  const r = createHandOffUnderRequest(db, request(over), {
    title,
    teamId: TEAM,
    sourceDelegationId: 'd1:deleg:agent:a2:reflectTo:lead',
    agentCreated: true,
    titleMatchNeedsOwner: true,
  })
  if (!r.ok) throw new Error(r.reason)
  return r
}

describe('createHandOffUnderRequest', () => {
  it('makes one main task from the words, with the person and the lead on it', () => {
    const person = { id: 'p1', name: 'Pat', role: null }
    const r = firstHandOff({ requestedBy: person })
    const main = getTask(db, r.task.parentTaskId as string)!
    expect(r.mainTask?.id).toBe(main.id)
    expect(main.isMainTask).toBe(1)
    expect(main.title).toBe('Build the login page')
    expect(main.description).toContain('password reset')
    expect(main.status).toBe('in_progress')
    expect(main.assigneeAgentId).toBe('lead')
    expect(main.sourceDelegationId).toBeNull()
    expect(parsePersonJson(main.requestedBy)).toEqual(person)
    expect(main.identifier).toBeTruthy()
    // The hand-off itself is an ordinary task, ready for its agent.
    expect(r.task.status).toBe('todo')
    expect(r.task.isMainTask).toBe(0)
  })

  it('files a second hand-off of the same turn under the same main task', () => {
    const first = firstHandOff()
    const second = firstHandOff({}, 'Write the tests')
    expect(second.mainTask).toBeUndefined()
    expect(second.task.parentTaskId).toBe(first.task.parentTaskId)
  })

  it('another message makes another main task, so unrelated work never merges', () => {
    const first = firstHandOff()
    const second = firstHandOff({ key: `main:${TEAM}:d2` }, 'Clean the logs')
    expect(second.task.parentTaskId).not.toBe(first.task.parentTaskId)
  })

  it('answers a hand-off that repeats open work with that work, and makes no main task', () => {
    const first = firstHandOff()
    const repeat = createHandOffUnderRequest(db, request({ key: `main:${TEAM}:d2` }), {
      title: 'Write the form',
      teamId: TEAM,
      sourceDelegationId: 'd2:deleg:agent:a2:reflectTo:lead',
      agentCreated: true,
      titleMatchNeedsOwner: true,
    })
    expect(repeat.ok && repeat.task.id).toBe(first.task.id)
    expect(repeat.ok && repeat.task.deduplicated).toBe(true)
    expect(listOpenMainTasks(db, { teamId: TEAM })).toHaveLength(1)
  })

  it('a main task never stands in for a hand-off with the same words', () => {
    const r = firstHandOff({ title: 'Write the form', description: 'Write the form' })
    expect(r.task.isMainTask).toBe(0)
    expect(r.task.parentTaskId).toBeTruthy()
  })

  it('holds to the root rate cap for the main task', () => {
    const made = createHandOffUnderRequest(
      db,
      request(),
      { title: 'x', teamId: TEAM },
      {
        maxRootCreates: 0,
      },
    )
    expect(made).toMatchObject({ ok: false, reason: 'root_rate_cap', max: 0 })
    expect(listOpenMainTasks(db, { teamId: TEAM })).toHaveLength(0)
  })

  it('counts only the main task as a root, not the work under it', () => {
    firstHandOff()
    firstHandOff({}, 'two')
    firstHandOff({}, 'three')
    expect(handOffCapacity(db, null, TEAM)?.room).toBe(handOffCapacity(db, null, TEAM)!.max - 1)
  })

  it('refuses a hand-off under a request a person has closed', () => {
    const first = firstHandOff()
    const mainId = first.task.parentTaskId as string
    expect(updateStatus(db, mainId, 'cancelled', { actor: 'person' }).ok).toBe(true)
    const late = createCappedSubtask(db, mainId, { title: 'late' })
    expect(late).toMatchObject({ ok: false, reason: 'main_closed' })
    const viaKey = createHandOffUnderRequest(db, request(), { title: 'later', teamId: TEAM })
    expect(viaKey).toMatchObject({ ok: false, reason: 'main_closed' })
  })
})

describe('the depth cap skips the main task', () => {
  it('leaves helpers the same levels as a hand-off with no main task', () => {
    const root = createCappedRootTask(db, { title: 'old', teamId: TEAM })
    if (!root.ok) throw new Error(root.reason)
    const levelsUnder = (start: string): number => {
      let levels = 0
      let parent = start
      for (;;) {
        const made = createCappedSubtask(db, parent, {
          title: `l${levels}-${parent}`,
          teamId: TEAM,
        })
        if (!made.ok) return levels
        levels += 1
        parent = made.task.id
      }
    }
    const under = firstHandOff()
    // Below the first hand-off, as below a root hand-off.
    const levels = levelsUnder(under.task.id)
    expect(levels).toBe(levelsUnder(root.task.id))
    expect(levels).toBe(DEFAULT_MAX_DEPTH)
  })

  it('counts a chain below a main task as the chain alone', () => {
    const under = firstHandOff()
    const mid = createCappedSubtask(db, under.task.id, { title: 'mid' })
    if (!mid.ok) throw new Error(mid.reason)
    expect(spawnDepth(getAncestors(db, under.task.id))).toBe(0)
    expect(spawnDepth(getAncestors(db, mid.task.id))).toBe(1)
    const leaf = createCappedSubtask(db, mid.task.id, { title: 'leaf' })
    if (!leaf.ok) throw new Error(leaf.reason)
    expect(spawnDepth(getAncestors(db, leaf.task.id))).toBe(DEFAULT_MAX_DEPTH)
    expect(createCappedSubtask(db, leaf.task.id, { title: 'too deep' })).toMatchObject({
      ok: false,
      reason: 'depth_cap',
    })
  })

  it('keeps the child cap on the main task', () => {
    const first = firstHandOff()
    const mainId = first.task.parentTaskId as string
    for (let i = 1; i < DEFAULT_MAX_CHILDREN; i++) {
      const r = createCappedSubtask(db, mainId, { title: `c${i}` })
      if (!r.ok) throw new Error(r.reason)
    }
    expect(createCappedSubtask(db, mainId, { title: 'one too many' })).toMatchObject({
      ok: false,
      reason: 'child_cap',
    })
  })

  it('the cycle guard reads no delegator on it', () => {
    const under = firstHandOff()
    const chain = handOffChain(db, under.task.id)
    expect(chain.map((l) => l.delegatedBy)).toEqual(['lead', null])
  })
})

describe('a main task never runs by itself', () => {
  it('is not ready, cannot be claimed, and no agent can move it', () => {
    const first = firstHandOff()
    const mainId = first.task.parentTaskId as string
    expect(getReadyTasks(db, { teamId: TEAM }).map((t) => t.id)).not.toContain(mainId)
    expect(claimTask(db, mainId, 'a2').ok).toBe(false)
    const written = updateStatus(db, mainId, 'done', { unlessPersonMoved: true })
    expect(written).toMatchObject({ ok: false, reason: 'main_task' })
    expect(updateStatus(db, mainId, 'todo')).toMatchObject({ ok: false, reason: 'main_task' })
    expect(updateStatus(db, mainId, 'in_review')).toMatchObject({ ok: false, reason: 'main_task' })
    releaseTask(db, mainId)
    expect(getTask(db, mainId)?.status).toBe('in_progress')
  })

  it('stays out of the ready list and the claim even if a write put it in To do', () => {
    const first = firstHandOff()
    const mainId = first.task.parentTaskId as string
    db.$client
      .prepare(`UPDATE tasks SET status = 'todo', assignee_agent_id = NULL WHERE id = ?`)
      .run(mainId)
    expect(getReadyTasks(db, { teamId: TEAM }).map((t) => t.id)).not.toContain(mainId)
    expect(claimTask(db, mainId, 'a2', null, { run: { executorType: 'openclaw' } }).ok).toBe(false)
  })

  it('cannot be assigned to an agent or a person', () => {
    const mainId = firstHandOff().task.parentTaskId as string
    expect(assignTaskDelegation(db, mainId, 'x:agent:a2').ok).toBe(false)
    expect(assignTaskToPerson(db, mainId, { id: 'p', name: null, role: null }).ok).toBe(false)
    parkMainTask(db, mainId, 'The lead could not write its summary.')
    expect(assignTaskDelegation(db, mainId, 'x:agent:a2').ok).toBe(false)
    expect(getTask(db, mainId)?.sourceDelegationId).toBeNull()
  })
})

describe('closing a main task', () => {
  it('counts its whole tree', () => {
    const first = firstHandOff()
    const mainId = first.task.parentTaskId as string
    const deep = createCappedSubtask(db, first.task.id, {
      title: 'deep',
      sourceDelegationId: 'r2:deleg:agent:a3:reflectTo:a2',
    })
    if (!deep.ok) throw new Error(deep.reason)
    expect(mainTaskState(db, mainId)).toMatchObject({
      open: true,
      openSubtasks: 2,
      doneSubtasks: 0,
      cancelledSubtasks: 0,
    })
    expect(mainTaskState(db, mainId)?.subtaskIds.sort()).toEqual(
      [first.task.id, deep.task.id].sort(),
    )
    expect(mainTaskOfTask(db, deep.task.id)?.id).toBe(mainId)
    expect(mainTaskOfTask(db, mainId)?.id).toBe(mainId)
    updateStatus(db, deep.task.id, 'cancelled')
    expect(mainTaskState(db, mainId)).toMatchObject({ openSubtasks: 1, cancelledSubtasks: 1 })
  })

  it('reaches Done with no verdict and frees the waiters, from Blocked too', () => {
    const mainId = firstHandOff().task.parentTaskId as string
    parkMainTask(db, mainId, 'Waiting on a person.')
    expect(getTask(db, mainId)?.status).toBe('blocked')
    expect(closeMainTask(db, mainId, 'done')).toBe(true)
    const closed = getTask(db, mainId)!
    expect(closed.status).toBe('done')
    expect(closed.completedAt).not.toBeNull()
    expect(closeMainTask(db, mainId, 'cancelled')).toBe(false)
  })

  it('refuses to close anything else', () => {
    const plain = createTask(db, { title: 'plain', teamId: TEAM })
    expect(closeMainTask(db, plain.id, 'done')).toBe(false)
    expect(getTask(db, plain.id)?.status).toBe('todo')
  })

  it('cancels every open sub-task with a person cancel, leaving closed ones alone', () => {
    const first = firstHandOff()
    const mainId = first.task.parentTaskId as string
    const second = firstHandOff({}, 'second')
    const deep = createCappedSubtask(db, first.task.id, { title: 'deep' })
    if (!deep.ok) throw new Error(deep.reason)
    updateStatus(db, second.task.id, 'in_progress')
    updateStatus(db, second.task.id, 'done')
    const cancelled = closeOpenSubtasksOfMain(db, mainId, { byPerson: true })
    expect(cancelled.map((t) => t.id).sort()).toEqual([first.task.id, deep.task.id].sort())
    expect(getTask(db, second.task.id)?.status).toBe('done')
    expect(getTask(db, first.task.id)?.personCancelledAt).not.toBeNull()
    expect(mainTaskState(db, mainId)?.openSubtasks).toBe(0)
  })
})

describe('what a main task’s row says it waits on', () => {
  it('counts its whole tree, where another task counts what is directly under it', () => {
    const first = firstHandOff()
    const mainId = first.task.parentTaskId as string
    const deep = createCappedSubtask(db, first.task.id, {
      title: 'deep',
      sourceDelegationId: 'r2:deleg:agent:a3:reflectTo:a2',
    })
    if (!deep.ok) throw new Error(deep.reason)
    updateStatus(db, first.task.id, 'in_progress')
    updateStatus(db, first.task.id, 'done')
    expect(waitingOnDetailOf(db, getTask(db, mainId)!)).toEqual({ openSubtasks: 1 })
  })
})

describe('what a request waits on: the barrier’s reading', () => {
  it('nobody’s note holds nothing, so it closes around it', () => {
    const first = firstHandOff()
    const mainId = first.task.parentTaskId as string
    const note = createCappedSubtask(db, mainId, { title: 'a note to myself' })
    if (!note.ok) throw new Error(note.reason)
    expect(mainTaskState(db, mainId)).toMatchObject({ openSubtasks: 1 })
    updateStatus(db, first.task.id, 'cancelled')
    expect(mainTaskState(db, mainId)).toMatchObject({ openSubtasks: 0 })
    // Still on the record as filed under it.
    expect(mainTaskState(db, mainId)?.subtaskIds).toContain(note.task.id)
  })

  it('a task a person filed and has not given to anyone holds it', () => {
    const first = firstHandOff()
    const mainId = first.task.parentTaskId as string
    const filed = createTask(db, {
      title: 'mine',
      teamId: TEAM,
      parentTaskId: mainId,
      requestedBy: { id: 'p1', name: 'Pat', role: null },
    })
    updateStatus(db, first.task.id, 'cancelled')
    expect(mainTaskState(db, mainId)).toMatchObject({ openSubtasks: 1 })
    updateStatus(db, filed.id, 'cancelled')
    expect(mainTaskState(db, mainId)).toMatchObject({ openSubtasks: 0 })
  })

  it('a sub-task that waits on the request itself does not hold it, or both would wait', () => {
    const first = firstHandOff()
    const mainId = first.task.parentTaskId as string
    claimTask(db, first.task.id, 'a2')
    updateStatus(db, first.task.id, 'blocked', { waitingOn: { kind: 'task', taskId: mainId } })
    expect(mainTaskState(db, mainId)).toMatchObject({ openSubtasks: 0 })
    expect(listRoomsWithIdleMainTasks(db).map((r) => r.teamId)).toEqual([TEAM])
  })

  it('work that failed holds it, and its card counts the one that needs a person', () => {
    const first = firstHandOff()
    const mainId = first.task.parentTaskId as string
    claimTask(db, first.task.id, 'a2')
    updateStatus(db, first.task.id, 'blocked', { waitingOn: { kind: 'failure' } })
    const second = firstHandOff({}, 'Style the form')
    expect(second.task.parentTaskId).toBe(mainId)
    expect(mainTaskState(db, mainId)).toMatchObject({ openSubtasks: 2 })
    expect(waitingOnDetailOf(db, getTask(db, mainId)!)).toEqual({ openSubtasks: 2, needPerson: 1 })
    expect(listRoomsWithIdleMainTasks(db)).toEqual([])
  })

  it('takes a question at any depth as needing a person', () => {
    const first = firstHandOff()
    const mainId = first.task.parentTaskId as string
    claimTask(db, first.task.id, 'a2')
    updateStatus(db, first.task.id, 'blocked', { waitingOn: { kind: 'subtasks', handedOut: true } })
    const deep = createCappedSubtask(db, first.task.id, {
      title: 'deep',
      sourceDelegationId: 'r2:deleg:agent:a3:reflectTo:a2',
    })
    if (!deep.ok) throw new Error(deep.reason)
    claimTask(db, deep.task.id, 'a3')
    updateStatus(db, deep.task.id, 'blocked', { waitingOn: { kind: 'person', need: 'Which one?' } })
    expect(waitingOnDetailOf(db, getTask(db, mainId)!)).toEqual({ openSubtasks: 2, needPerson: 1 })
  })
})

describe('a person and a closed main task', () => {
  it('moves it to Done or Cancelled from anywhere, and to nothing else', () => {
    const mainId = firstHandOff().task.parentTaskId as string
    expect(updateStatus(db, mainId, 'blocked', { actor: 'person' })).toMatchObject({
      ok: false,
      reason: 'main_task',
    })
    expect(updateStatus(db, mainId, 'todo', { actor: 'person' })).toMatchObject({
      ok: false,
      reason: 'main_task',
    })
    parkMainTask(db, mainId, 'Needs a person.')
    expect(updateStatus(db, mainId, 'done', { actor: 'person' }).ok).toBe(true)
  })

  it('reopens to where it waits, never to To do', () => {
    const mainId = firstHandOff().task.parentTaskId as string
    updateStatus(db, mainId, 'cancelled', { actor: 'person' })
    expect(getTask(db, mainId)?.personCancelledAt).not.toBeNull()
    const r = reopenTask(db, mainId)
    expect(r.ok).toBe(true)
    const row = getTask(db, mainId)!
    expect(row.status).toBe('in_progress')
    expect(row.assigneeAgentId).toBe('lead')
    expect(row.completedAt).toBeNull()
    expect(row.personCancelledAt).toBeNull()
  })

  it('a sub-task reopened under a closed main task opens the main task again', () => {
    const first = firstHandOff()
    const mainId = first.task.parentTaskId as string
    updateStatus(db, first.task.id, 'in_progress')
    updateStatus(db, first.task.id, 'done')
    closeMainTask(db, mainId, 'done')
    expect(reopenTask(db, first.task.id).ok).toBe(true)
    expect(getTask(db, mainId)?.status).toBe('in_progress')
    expect(getTask(db, mainId)?.completedAt).toBeNull()
  })
})

describe('creating under a request that has closed', () => {
  it('a person’s task, at any depth, opens the request again, so it is not hidden there', () => {
    const first = firstHandOff()
    const mainId = first.task.parentTaskId as string
    updateStatus(db, first.task.id, 'in_progress')
    updateStatus(db, first.task.id, 'done')
    closeMainTask(db, mainId, 'done')
    const followUp = createTask(db, {
      title: 'Follow up',
      teamId: TEAM,
      parentTaskId: first.task.id,
    })
    expect(followUp.status).toBe('todo')
    const main = getTask(db, mainId)!
    expect(main.status).toBe('in_progress')
    expect(main.completedAt).toBeNull()
  })

  it('an agent’s is refused, however far under the request it would go', () => {
    const first = firstHandOff()
    const mainId = first.task.parentTaskId as string
    const mid = createCappedSubtask(db, first.task.id, { title: 'mid' })
    if (!mid.ok) throw new Error(mid.reason)
    for (const id of [mid.task.id, first.task.id]) updateStatus(db, id, 'cancelled')
    closeMainTask(db, mainId, 'cancelled')
    for (const parent of [first.task.id, mid.task.id])
      expect(createCappedSubtask(db, parent, { title: 'late' })).toMatchObject({
        ok: false,
        reason: 'main_closed',
      })
  })
})

describe('a person closing a request', () => {
  it('moves the main task and its open work together, or neither', () => {
    const first = firstHandOff()
    const mainId = first.task.parentTaskId as string
    const refused = closeMainTaskByPerson(db, mainId, 'cancelled', { completedAt: Date.now() * 2 })
    expect(refused.result).toMatchObject({ ok: false, reason: 'invalid_completed_at' })
    expect(refused.cancelled).toEqual([])
    expect(getTask(db, first.task.id)?.status).toBe('todo')
    expect(getTask(db, mainId)?.status).toBe('in_progress')

    const closed = closeMainTaskByPerson(db, mainId, 'cancelled')
    expect(closed.result.ok).toBe(true)
    expect(closed.cancelled.map((t) => t.id)).toEqual([first.task.id])
    expect(getTask(db, mainId)?.status).toBe('cancelled')
    expect(getTask(db, first.task.id)?.status).toBe('cancelled')
  })
})

describe('what a lead last heard about a request', () => {
  it('reads the newest row to its lead across the tree, not one to a helper', () => {
    const first = firstHandOff()
    const mainId = first.task.parentTaskId as string
    const ids = [mainId, first.task.id]
    expect(latestReportUpForTasks(db, ids, 'lead')).toBeNull()
    const toLead = recordReportUp(db, {
      teamId: TEAM,
      roomId: null,
      recipientAgentId: 'lead',
      taskId: first.task.id,
      payload: '{}',
    })
    expect(latestReportUpForTasks(db, ids, 'lead')?.id).toBe(toLead)
    recordReportUp(db, {
      teamId: TEAM,
      roomId: null,
      recipientAgentId: 'helper',
      taskId: first.task.id,
      payload: '{}',
    })
    expect(latestReportUpForTasks(db, ids, 'lead')?.id).toBe(toLead)
  })
})

describe('whether work was handed down', () => {
  it('a lead’s hand-off under a main task was not; one under other work was', () => {
    const first = firstHandOff()
    const mid = createCappedSubtask(db, first.task.id, { title: 'mid' })
    if (!mid.ok) throw new Error(mid.reason)
    expect(handedDownFromWork(db, first.task)).toBe(false)
    expect(handedDownFromWork(db, mid.task)).toBe(true)
    const plain = createTask(db, { title: 'plain', teamId: TEAM })
    expect(handedDownFromWork(db, plain)).toBe(false)
  })
})

describe('rooms holding a request with nothing left open', () => {
  it('lists a room once its work has closed, until a report is waiting', () => {
    const first = firstHandOff()
    expect(listRoomsWithIdleMainTasks(db)).toEqual([])
    updateStatus(db, first.task.id, 'in_progress')
    updateStatus(db, first.task.id, 'done')
    expect(listRoomsWithIdleMainTasks(db)).toEqual([{ teamId: TEAM, roomId: null }])
    const row = recordReportUp(db, {
      teamId: TEAM,
      roomId: null,
      recipientAgentId: 'lead',
      taskId: first.task.id,
      payload: '{}',
    })
    expect(listRoomsWithIdleMainTasks(db)).toEqual([])
    settleReportUps(db, [row], 'delivered')
    expect(listRoomsWithIdleMainTasks(db)).toEqual([{ teamId: TEAM, roomId: null }])
    closeMainTask(db, first.task.parentTaskId as string, 'done')
    expect(listRoomsWithIdleMainTasks(db)).toEqual([])
  })

  it('leaves out a parked one: it waits on a person', () => {
    const first = firstHandOff()
    updateStatus(db, first.task.id, 'cancelled')
    parkMainTask(db, first.task.parentTaskId as string, 'Needs a person.')
    expect(listRoomsWithIdleMainTasks(db)).toEqual([])
  })
})

describe('a database from before main tasks', () => {
  it('gains the column on its own, and its tasks stay as they are', () => {
    const plain = createTask(db, { title: 'old', teamId: TEAM })
    expect(getTask(db, plain.id)?.isMainTask).toBe(0)
    expect(mainTaskState(db, plain.id)).toBeNull()
    expect(mainTaskOfTask(db, plain.id)).toBeNull()
    expect(listOpenMainTasks(db, { teamId: TEAM })).toEqual([])
  })
})
