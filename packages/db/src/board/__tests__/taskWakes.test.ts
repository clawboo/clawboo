// The saved wake: one waiting row per (agent, task), merged rather than doubled,
// handed to the run that starts the task, and settled when that run ends.

import { mkdtempSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { PAUSED_RUN_CLASS } from '@clawboo/board-core'
import { sql } from 'drizzle-orm'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { createDb, type ClawbooDb } from '../../db'
import { taskWakes, type DbTaskWake } from '../../schema'
import {
  adoptTaskWakes,
  countRefusedWakeStart,
  listTaskWakesCarriedBy,
  listWaitingTaskWakes,
  markWakeCommentsHeard,
  noteTaskWakeSkip,
  recordTaskWake,
  reapTaskWakes,
  settleTaskWakes,
  wakeCommentIds,
} from '../../taskWakes'
import {
  addComment,
  claimTask,
  completeExecutionProcess,
  createExecutionProcess,
  createTask,
  getComments,
  linkDep,
  reconcileOrphans,
  reconcileStaleInProgress,
  updateStatus,
} from '../repository'
import { tasks, teams } from '../../schema'
import { eq } from 'drizzle-orm'

let dir: string
let db: ClawbooDb
const RUN = { executorType: 'openclaw' }
const BOUND = 'r1:deleg:agent:a1:reflectTo:lead'

beforeEach(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), 'clawboo-task-wakes-'))
  db = createDb(path.join(dir, 'test.db'))
})
afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

const newTask = (sourceDelegationId: string | null = BOUND): string =>
  createTask(db, { title: 't', teamId: 'T', sourceDelegationId }).id
const comment = (id: string, reason: 'person_comment' = reason0, commentId = 'c1') =>
  recordTaskWake(db, { teamId: 'T', agentId: 'a1', taskId: id, reason, commentIds: [commentId] })
const reason0 = 'person_comment' as const
const rows = (): DbTaskWake[] => db.select().from(taskWakes).all() as DbTaskWake[]
const rowOf = (id: string): DbTaskWake => rows().find((r) => r.id === id)!

describe('one waiting wake per (agent, task)', () => {
  it('a second wake merges into the first', () => {
    const id = newTask()
    const first = comment(id, reason0, 'c1')
    const second = comment(id, reason0, 'c2')
    expect(first.merged).toBe(false)
    expect(second.merged).toBe(true)
    expect(second.id).toBe(first.id)
    const [row] = listWaitingTaskWakes(db)
    expect(rows()).toHaveLength(1)
    expect(wakeCommentIds(row!)).toEqual(['c1', 'c2'])
    expect(row!.mergeCount).toBe(2)
  })

  it('every wake kind shares the slot, and the row keeps the reason a person is behind', () => {
    const id = newTask()
    recordTaskWake(db, { teamId: 'T', agentId: 'a1', taskId: id, reason: 'dependency_done' })
    comment(id)
    const [row] = listWaitingTaskWakes(db)
    expect(rows()).toHaveLength(1)
    expect(row!.reason).toBe('person_comment')
    expect(wakeCommentIds(row!)).toEqual(['c1'])
  })

  it('the database itself refuses a second waiting row', () => {
    const id = newTask()
    comment(id)
    const now = Date.now()
    expect(() =>
      db
        .insert(taskWakes)
        .values({
          id: 'second',
          teamId: 'T',
          agentId: 'a1',
          taskId: id,
          reason: 'person_comment',
          createdAt: now,
          updatedAt: now,
        })
        .run(),
    ).toThrow(/UNIQUE/)
  })

  it('two agents can each hold a waiting wake on one task', () => {
    const id = newTask()
    comment(id)
    recordTaskWake(db, { teamId: 'T', agentId: 'a2', taskId: id, reason: 'person_comment' })
    expect(listWaitingTaskWakes(db)).toHaveLength(2)
  })
})

describe('a run takes the waiting wakes when it starts the task', () => {
  it('the claim hands them to the run, in the same write', () => {
    const id = newTask()
    const wake = comment(id)
    const claim = claimTask(db, id, 'a1', 'openclaw', { run: RUN })
    expect(claim.wakes?.map((w) => w.id)).toEqual([wake.id])
    expect(rowOf(wake.id).carriedExecId).toBe(claim.execution!.id)
    expect(listWaitingTaskWakes(db)).toEqual([])
  })

  it("writes the wake's reason on the run", () => {
    const id = newTask()
    comment(id)
    const claim = claimTask(db, id, 'a1', 'openclaw', {
      run: { executorType: 'openclaw', runReason: 'delegation' },
    })
    expect(claim.execution!.runReason).toBe('person_comment')
  })

  it('a lost claim takes nothing', () => {
    const id = newTask()
    claimTask(db, id, 'a1', 'openclaw', { run: RUN })
    const wake = comment(id)
    expect(claimTask(db, id, 'a2', 'openclaw', { run: RUN }).ok).toBe(false)
    expect(rowOf(wake.id).carriedExecId).toBeNull()
  })

  it('a comment during the run starts a new waiting row, not one the run already carries', () => {
    const id = newTask()
    const first = comment(id, reason0, 'c1')
    claimTask(db, id, 'a1', 'openclaw', { run: RUN })
    const second = comment(id, reason0, 'c2')
    expect(second.merged).toBe(false)
    expect(second.id).not.toBe(first.id)
  })

  it('a run started without a claim adopts what is waiting when its context renders', () => {
    const id = newTask()
    const claim = claimTask(db, id, 'a1', 'openclaw', { run: RUN })
    const wake = comment(id)
    const adopted = adoptTaskWakes(db, id, claim.execution!.id)
    expect(adopted.map((w) => w.id)).toEqual([wake.id])
    expect(listTaskWakesCarriedBy(db, claim.execution!.id).map((w) => w.id)).toEqual([wake.id])
    expect(adoptTaskWakes(db, id, claim.execution!.id)).toEqual([])
  })
})

describe('the run that carried a wake settles it when it ends', () => {
  const carried = () => {
    const id = newTask()
    const wake = comment(id)
    const exec = claimTask(db, id, 'a1', 'openclaw', { run: RUN }).execution!
    return { id, wake, exec }
  }

  it('delivered on a successful end', () => {
    const { wake, exec } = carried()
    completeExecutionProcess(db, exec.id, { status: 'succeeded', summary: 'done' })
    expect(rowOf(wake.id).settledHow).toBe('delivered')
  })

  it("held for the task's next run on a person's Stop: nothing is dropped, and it starts nothing", () => {
    const { id, wake, exec } = carried()
    completeExecutionProcess(db, exec.id, { status: 'cancelled', byPerson: true })
    const row = rowOf(wake.id)
    expect(row.settledAt).toBeNull()
    expect(row.carriedExecId).toBeNull()
    expect(row.heldAt).not.toBeNull()
    expect(row.replays).toBe(0)
    expect(listWaitingTaskWakes(db)).toEqual([])
    expect(listWaitingTaskWakes(db, { includeHeld: true }).map((w) => w.id)).toEqual([wake.id])
    // The next run on the task takes it, and it settles with that run.
    updateStatus(db, id, 'todo')
    const next = claimTask(db, id, 'a1', 'openclaw', { run: RUN })
    expect(next.wakes?.map((w) => w.id)).toEqual([wake.id])
    completeExecutionProcess(db, next.execution!.id, { status: 'succeeded', summary: 'ok' })
    expect(rowOf(wake.id).settledHow).toBe('delivered')
  })

  it("a person's new comment lifts a Stop's hold, and a finished dependency does not", () => {
    const { wake, exec, id } = carried()
    completeExecutionProcess(db, exec.id, { status: 'cancelled', byPerson: true })
    recordTaskWake(db, { teamId: 'T', agentId: 'a1', taskId: id, reason: 'dependency_done' })
    expect(rowOf(wake.id).heldAt).not.toBeNull()
    comment(id, reason0, 'c2')
    expect(rowOf(wake.id).heldAt).toBeNull()
    expect(wakeCommentIds(rowOf(wake.id)).sort()).toEqual(['c1', 'c2'])
  })

  it('a run the breaker stopped, or one cancelled by a runtime abort, is not a Stop: back to waiting, counted, and not held', () => {
    const { wake, exec } = carried()
    completeExecutionProcess(db, exec.id, {
      status: 'breaker_tripped',
      error: 'circuit_broken:loop',
    })
    const row = rowOf(wake.id)
    expect(row.settledAt).toBeNull()
    expect(row.carriedExecId).toBeNull()
    expect(row.heldAt).toBeNull()
    expect(row.replays).toBe(1)
    expect(listWaitingTaskWakes(db).map((w) => w.id)).toEqual([wake.id])
  })

  it('a run a budget cap killed goes back uncounted, and is not held', () => {
    const { wake, exec } = carried()
    completeExecutionProcess(db, exec.id, {
      status: 'budget_paused',
      error: 'budget_paused:team',
      errorClass: 'BudgetRefused',
    })
    const row = rowOf(wake.id)
    expect(row.heldAt).toBeNull()
    expect(row.replays).toBe(0)
    expect(listWaitingTaskWakes(db).map((w) => w.id)).toEqual([wake.id])
  })

  it('a run a held budget refused goes back uncounted, and is not held', () => {
    const { wake, exec } = carried()
    completeExecutionProcess(db, exec.id, { status: 'budget_held', error: 'budget_held:team' })
    const row = rowOf(wake.id)
    expect(row.heldAt).toBeNull()
    expect(row.replays).toBe(0)
  })

  it('back to waiting on any other end, counted', () => {
    for (const status of ['failed', 'timed_out'] as const) {
      const { wake, exec } = carried()
      completeExecutionProcess(db, exec.id, { status, error: 'x' })
      const row = rowOf(wake.id)
      expect(row.settledAt).toBeNull()
      expect(row.carriedExecId).toBeNull()
      expect(row.replays).toBe(1)
    }
  })

  it('a run the budget refused gives it back uncounted', () => {
    const { wake, exec } = carried()
    completeExecutionProcess(db, exec.id, {
      status: 'failed',
      error: 'over budget',
      errorClass: 'BudgetRefused',
    })
    const row = rowOf(wake.id)
    expect(row.settledAt).toBeNull()
    expect(row.carriedExecId).toBeNull()
    expect(row.replays).toBe(0)
  })

  it('back to waiting merges into a row that is already waiting', () => {
    const { id, wake, exec } = carried()
    const later = comment(id, reason0, 'c2')
    completeExecutionProcess(db, exec.id, { status: 'failed', error: 'x' })
    const waiting = listWaitingTaskWakes(db)
    expect(waiting).toHaveLength(1)
    expect(waiting[0]!.id).toBe(later.id)
    expect(wakeCommentIds(waiting[0]!).sort()).toEqual(['c1', 'c2'])
    // A person's comment waiting there has not had its first start yet.
    expect(waiting[0]!.replays).toBe(0)
    expect(rowOf(wake.id).settledHow).toBe('merged')
  })

  it('the first settlement wins', () => {
    const { wake, exec } = carried()
    expect(settleTaskWakes(db, [wake.id], 'delivered')).toEqual([wake.id])
    expect(settleTaskWakes(db, [wake.id], 'stopped')).toEqual([])
    completeExecutionProcess(db, exec.id, { status: 'failed', error: 'x' })
    expect(rowOf(wake.id).settledHow).toBe('delivered')
    expect(rowOf(wake.id).replays).toBe(0)
  })

  it('a run the stale sweep ended gives it back, for the next run', () => {
    const { id, wake } = carried()
    db.update(tasks).set({ updatedAt: 1 }).where(eq(tasks.id, id)).run()
    expect(reconcileStaleInProgress(db, 1_000).reconciled).toBe(1)
    const row = rowOf(wake.id)
    expect(row.carriedExecId).toBeNull()
    expect(row.settledAt).toBeNull()
    expect(row.replays).toBe(1)
  })

  it('a run the boot reap ended gives it back: a restart delivers it once', () => {
    const { id, wake } = carried()
    db.update(tasks).set({ updatedAt: 1 }).where(eq(tasks.id, id)).run()
    expect(reconcileOrphans(db, { staleAfterMs: 1_000 }).reconciled).toBe(1)
    const row = rowOf(wake.id)
    expect(row.carriedExecId).toBeNull()
    expect(row.replays).toBe(1)
    // The next run takes it, once.
    const next = claimTask(db, id, 'a1', 'openclaw', { run: RUN })
    expect(next.wakes?.map((w) => w.id)).toEqual([wake.id])
    completeExecutionProcess(db, next.execution!.id, { status: 'succeeded', summary: 'ok' })
    expect(rowOf(wake.id).settledHow).toBe('delivered')
    expect(listWaitingTaskWakes(db)).toEqual([])
  })
})

describe('a dependency moving to done, on any path', () => {
  const deps = () => {
    const blocker = newTask()
    const dependent = newTask()
    linkDep(db, dependent, blocker)
    claimTask(db, blocker, 'a9', 'openclaw', { run: RUN })
    return { blocker, dependent }
  }

  it('saves a wake on the agent-bound dependent, in the same write as the done', () => {
    const { blocker, dependent } = deps()
    expect(listWaitingTaskWakes(db)).toEqual([])
    expect(updateStatus(db, blocker, 'done').ok).toBe(true)
    const [row] = listWaitingTaskWakes(db)
    expect(row?.taskId).toBe(dependent)
    expect(row?.agentId).toBe('a1')
    expect(row?.reason).toBe('dependency_done')
    expect(row?.teamId).toBe('T')
  })

  it('a dependent bound to no agent stays put', () => {
    const blocker = newTask()
    const dependent = newTask(null)
    linkDep(db, dependent, blocker)
    claimTask(db, blocker, 'a9', 'openclaw', { run: RUN })
    updateStatus(db, blocker, 'done')
    expect(listWaitingTaskWakes(db)).toEqual([])
  })

  it('a dependent still waiting on another task stays put, until the last one is done', () => {
    const first = newTask()
    const second = newTask()
    const dependent = newTask()
    linkDep(db, dependent, first)
    linkDep(db, dependent, second)
    claimTask(db, first, 'a9', 'openclaw', { run: RUN })
    claimTask(db, second, 'a8', 'openclaw', { run: RUN })
    updateStatus(db, first, 'done')
    expect(listWaitingTaskWakes(db)).toEqual([])
    updateStatus(db, second, 'done')
    expect(listWaitingTaskWakes(db).map((w) => w.taskId)).toEqual([dependent])
  })

  it('a dependent that is not in To do stays put', () => {
    const { blocker, dependent } = deps()
    updateStatus(db, dependent, 'backlog')
    updateStatus(db, blocker, 'done')
    expect(listWaitingTaskWakes(db)).toEqual([])
  })

  it('writing Done a second time does not wake again', () => {
    const { blocker, dependent } = deps()
    updateStatus(db, blocker, 'done')
    const [row] = listWaitingTaskWakes(db)
    settleTaskWakes(db, [row!.id], 'delivered')
    updateStatus(db, blocker, 'done')
    expect(listWaitingTaskWakes(db).map((w) => w.taskId)).not.toContain(dependent)
  })
})

describe('a start refused before any claim', () => {
  it('counts against what is waiting, so it cannot go round for ever', () => {
    const id = newTask()
    const wake = comment(id)
    countRefusedWakeStart(db, id)
    countRefusedWakeStart(db, id)
    expect(rowOf(wake.id).replays).toBe(2)
  })

  it('leaves a row a run is carrying alone', () => {
    const id = newTask()
    const wake = comment(id)
    claimTask(db, id, 'a1', 'openclaw', { run: RUN })
    countRefusedWakeStart(db, id)
    expect(rowOf(wake.id).replays).toBe(0)
  })
})

describe('a skip leaves a reason', () => {
  it('reports only a change, so one wait is one event', () => {
    const id = newTask()
    const { id: wakeId } = comment(id)
    expect(noteTaskWakeSkip(db, wakeId, 'held')).toBe(true)
    expect(noteTaskWakeSkip(db, wakeId, 'held')).toBe(false)
    expect(rowOf(wakeId).skipReason).toBe('held')
    expect(noteTaskWakeSkip(db, wakeId, 'agent_busy')).toBe(true)
  })

  it('a skip never counts as a replay', () => {
    const id = newTask()
    const { id: wakeId } = comment(id)
    noteTaskWakeSkip(db, wakeId, 'held')
    noteTaskWakeSkip(db, wakeId, 'budget')
    expect(rowOf(wakeId).replays).toBe(0)
  })
})

describe('a comment heard by the run going now', () => {
  const heardSetup = () => {
    const id = newTask()
    const c1 = addComment(db, id, 'one', 'user', null, { kind: 'person' })
    const c2 = addComment(db, id, 'two', 'user', null, { kind: 'person' })
    const { id: wakeId } = recordTaskWake(db, {
      teamId: 'T',
      agentId: 'a1',
      taskId: id,
      reason: 'person_comment',
      commentIds: [c1.id, c2.id],
    })
    return { id, c1, c2, wakeId }
  }

  it('leaves what is waiting, and the run carries it to its end', () => {
    const { id, c1, c2, wakeId } = heardSetup()
    const exec = createExecutionProcess(db, { taskId: id, executorType: 'openclaw' })
    db.update(tasks)
      .set({ status: 'in_progress', runExecutionId: exec.id })
      .where(eq(tasks.id, id))
      .run()
    markWakeCommentsHeard(db, id, [c1.id])
    expect(wakeCommentIds(rowOf(wakeId))).toEqual([c2.id])
    expect(rowOf(wakeId).carriedExecId).toBeNull()
    const carried = listTaskWakesCarriedBy(db, exec.id)
    expect(carried.map(wakeCommentIds)).toEqual([[c1.id]])
    expect(carried[0]!.settledAt).toBeNull()
    expect(getComments(db, id).find((c) => c.id === c1.id)?.steeredAt).toBeTruthy()
    expect(getComments(db, id).find((c) => c.id === c2.id)?.steeredAt).toBeNull()
    // None left: the row itself goes to the run.
    markWakeCommentsHeard(db, id, [c2.id])
    expect(rowOf(wakeId).carriedExecId).toBe(exec.id)
    // Delivered only when that run ends well.
    completeExecutionProcess(db, exec.id, { status: 'succeeded', summary: 'ok' })
    expect(rowOf(wakeId).settledHow).toBe('delivered')
    expect(listWaitingTaskWakes(db)).toEqual([])
  })

  it('back to waiting, counted, when that run dies', () => {
    const { id, c1, c2 } = heardSetup()
    const exec = createExecutionProcess(db, { taskId: id, executorType: 'openclaw' })
    db.update(tasks)
      .set({ status: 'in_progress', runExecutionId: exec.id })
      .where(eq(tasks.id, id))
      .run()
    markWakeCommentsHeard(db, id, [c1.id, c2.id])
    expect(listWaitingTaskWakes(db)).toEqual([])
    completeExecutionProcess(db, exec.id, { status: 'failed', error: 'x' })
    const [row] = listWaitingTaskWakes(db)
    expect(wakeCommentIds(row!).sort()).toEqual([c1.id, c2.id].sort())
    expect(row!.replays).toBe(1)
  })

  it('with no run stamped on the task, nothing can carry it, so it keeps waiting', () => {
    const { id, c1, wakeId } = heardSetup()
    markWakeCommentsHeard(db, id, [c1.id])
    expect(wakeCommentIds(rowOf(wakeId))).toContain(c1.id)
    expect(rowOf(wakeId).settledAt).toBeNull()
  })
})

describe("a person's comment merging into a wake", () => {
  it('starts afresh: its replays are spent, and it tells the caller no run is on its way', () => {
    const id = newTask()
    const wake = comment(id, reason0, 'c1')
    db.update(taskWakes).set({ replays: 2 }).where(eq(taskWakes.id, wake.id)).run()
    const merged = comment(id, reason0, 'c2')
    expect(merged.merged).toBe(true)
    expect(merged.startsAfresh).toBe(true)
    expect(rowOf(wake.id).replays).toBe(0)
  })

  it('a wake a person was not behind starts afresh too', () => {
    const id = newTask()
    recordTaskWake(db, { teamId: 'T', agentId: 'a1', taskId: id, reason: 'dependency_done' })
    expect(comment(id).startsAfresh).toBe(true)
  })

  it("a second reply while the first's run is on its way folds", () => {
    const id = newTask()
    comment(id, reason0, 'c1')
    expect(comment(id, reason0, 'c2').startsAfresh).toBeUndefined()
  })

  it('a finished dependency keeps the replays and starts nothing', () => {
    const id = newTask()
    const wake = comment(id)
    db.update(taskWakes).set({ replays: 2 }).where(eq(taskWakes.id, wake.id)).run()
    const merged = recordTaskWake(db, {
      teamId: 'T',
      agentId: 'a1',
      taskId: id,
      reason: 'dependency_done',
    })
    expect(merged.startsAfresh).toBeUndefined()
    expect(rowOf(wake.id).replays).toBe(2)
  })
})

describe('comments carry the kind their writer gave them', () => {
  it('stores it, and leaves it null when none was given', () => {
    const id = newTask()
    expect(addComment(db, id, 'hello', 'user', null, { kind: 'person' }).kind).toBe('person')
    expect(addComment(db, id, 'Retry requested.', 'user', null, { kind: 'note' }).kind).toBe('note')
    expect(addComment(db, id, 'plain', 'agent').kind).toBeNull()
  })
})

describe('retention', () => {
  const seedTeam = (id: string): void => {
    const now = Date.now()
    db.insert(teams)
      .values({ id, name: id, icon: 'x', color: '#000', createdAt: now, updatedAt: now })
      .run()
  }

  it('reaps settled rows past their week and waiting rows past their month', () => {
    seedTeam('T')
    const id = newTask()
    const old = comment(id)
    settleTaskWakes(db, [old.id], 'delivered')
    const stale = newTask()
    const ancient = comment(stale)
    const live = newTask()
    const fresh = comment(live)
    db.run(sql`UPDATE task_wakes SET settled_at = 1 WHERE id = ${old.id}`)
    db.run(sql`UPDATE task_wakes SET created_at = 1 WHERE id = ${ancient.id}`)
    expect(reapTaskWakes(db)).toBe(2)
    expect(rows().map((r) => r.id)).toEqual([fresh.id])
  })

  it('reaps a row whose task is gone', () => {
    seedTeam('T')
    const { id } = comment('no-such-task')
    expect(rows().map((r) => r.id)).toEqual([id])
    expect(reapTaskWakes(db)).toBe(1)
  })

  it('reaps a row whose team is gone: nothing should run for it', () => {
    const id = newTask()
    comment(id)
    expect(reapTaskWakes(db)).toBe(1)
    expect(rows()).toEqual([])
  })

  it('a task with no team keeps its row: the task runner can still run it', () => {
    seedTeam('T')
    const id = createTask(db, { title: 'teamless', teamId: null }).id
    const wake = recordTaskWake(db, {
      teamId: null,
      agentId: 'a1',
      taskId: id,
      reason: 'person_comment',
    })
    expect(reapTaskWakes(db)).toBe(0)
    expect(rows().map((r) => r.id)).toEqual([wake.id])
  })
})

describe('a fix round', () => {
  it('takes what waited through the check when its context renders', () => {
    const id = newTask()
    const first = claimTask(db, id, 'a1', 'openclaw', { run: RUN }).execution!
    updateStatus(db, id, 'in_review')
    const wake = comment(id)
    updateStatus(db, id, 'in_progress')
    completeExecutionProcess(db, first.id, { status: 'succeeded', summary: 'first' })
    const fix = createExecutionProcess(db, { taskId: id, executorType: 'openclaw' })
    expect(rowOf(wake.id).carriedExecId).toBeNull()
    expect(adoptTaskWakes(db, id, fix.id).map((w) => w.id)).toEqual([wake.id])
  })
})

describe('the run that carried a wake, stopped by a pause', () => {
  const carried = (): { wakeId: string; execId: string } => {
    const id = newTask()
    const { id: wakeId } = comment(id)
    const claim = claimTask(db, id, 'a1', 'openclaw', { run: RUN })
    expect(claim.ok).toBe(true)
    expect(rowOf(wakeId).carriedExecId).toBe(claim.execution!.id)
    return { wakeId, execId: claim.execution!.id }
  }

  it('gives it back to waiting, uncounted, and not held as a Stop would', () => {
    const { wakeId, execId } = carried()
    completeExecutionProcess(db, execId, { status: 'cancelled', errorClass: PAUSED_RUN_CLASS })
    expect(rowOf(wakeId)).toMatchObject({
      carriedExecId: null,
      replays: 0,
      heldAt: null,
      settledAt: null,
    })
    expect(listWaitingTaskWakes(db).map((w) => w.id)).toEqual([wakeId])
  })

  it("reads the pause first, whatever the close says of a person's hand", () => {
    const { wakeId, execId } = carried()
    completeExecutionProcess(db, execId, {
      status: 'cancelled',
      errorClass: PAUSED_RUN_CLASS,
      byPerson: true,
    })
    expect(rowOf(wakeId)).toMatchObject({ replays: 0, heldAt: null })
  })

  it('keeps a row a Stop held held: the pause lifting does not start it', () => {
    const { wakeId, execId } = carried()
    db.update(taskWakes).set({ heldAt: 1 }).where(eq(taskWakes.id, wakeId)).run()
    completeExecutionProcess(db, execId, { status: 'cancelled', errorClass: PAUSED_RUN_CLASS })
    expect(rowOf(wakeId)).toMatchObject({ heldAt: 1, carriedExecId: null })
  })
})
