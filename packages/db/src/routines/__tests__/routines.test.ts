// The scheduled_runs ledger: due-pass boundary, THE atomic claim (0-row =
// already claimed = data, never retried), outcome paths, the adversarial
// one-TEAM-TASK-firing-owner de-dup guard, once@ self-disable, boot-resume
// reconciliation, and the state machine for user-driven transitions.

import { mkdtempSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { createDb, type ClawbooDb } from '../../db'
import { createTask, getTask } from '../../board/repository'
import {
  claimScheduledRun,
  deleteScheduledRun,
  getScheduledRun,
  listQueuedRuns,
  listScheduledRuns,
  markRunRunning,
  minNextRunAt,
  queueDueRuns,
  queueRunNow,
  reconcileScheduledRuns,
  recordRunOutcome,
  registerScheduledRun,
  setScheduledRunStatus,
  updateScheduledRun,
} from '../repository'
import { canRoutineTransition, isAutoFireable } from '../state-machine'

let dir: string
let db: ClawbooDb

const TEMPLATE = JSON.stringify({ title: 'Daily report', kind: 'research', priority: 0 })

function register(overrides: Partial<Parameters<typeof registerScheduledRun>[1]> = {}) {
  const result = registerScheduledRun(db, {
    agentId: 'agent-1',
    teamId: 'team-1',
    cronSpec: '0 9 * * *',
    taskTemplate: TEMPLATE,
    nextRunAt: 1_000,
    ...overrides,
  })
  if (!result.ok) throw new Error(`register failed: ${result.reason}`)
  return result.run
}

beforeEach(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), 'clawboo-routines-'))
  db = createDb(path.join(dir, 'test.db'))
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

describe('registration + the one-TEAM-TASK-firing-owner guard', () => {
  it('registers an unbound routine with the firing owner defaulted to clawboo', () => {
    const run = register()
    expect(run.scheduledBy).toBe('clawboo')
    expect(run.status).toBe('idle')
    expect(run.tenantId).toBeNull()
    expect(getScheduledRun(db, run.id)?.cronSpec).toBe('0 9 * * *')
  })

  it('stamps a manual-owned bound task with the registering owner', () => {
    const task = createTask(db, { title: 'Recurring chore' })
    expect(task.scheduledBy).toBe('manual')
    const result = registerScheduledRun(db, {
      agentId: 'agent-1',
      cronSpec: '0 9 * * *',
      taskTemplate: TEMPLATE,
      teamTaskId: task.id,
      nextRunAt: 1_000,
    })
    expect(result.ok).toBe(true)
    expect(getTask(db, task.id)?.scheduledBy).toBe('clawboo')
  })

  it('ADVERSARIAL: refuses a bound registration when a DIFFERENT scheduler owns the task', () => {
    // Simulate the task being owned by the OpenClaw Gateway cron domain.
    const task = createTask(db, { title: 'Gateway-owned chore', scheduledBy: 'openclaw' })
    const result = registerScheduledRun(db, {
      agentId: 'agent-1',
      cronSpec: '0 9 * * *',
      taskTemplate: TEMPLATE,
      teamTaskId: task.id,
      nextRunAt: 1_000,
    })
    expect(result).toEqual({ ok: false, reason: 'ownership_conflict', existingOwner: 'openclaw' })
    // The task's owner is untouched — exactly one firing-owner of record.
    expect(getTask(db, task.id)?.scheduledBy).toBe('openclaw')
    expect(listScheduledRuns(db)).toHaveLength(0)
  })

  it('allows a bound registration by the SAME owner (idempotent ownership)', () => {
    const task = createTask(db, { title: 'Already ours', scheduledBy: 'clawboo' })
    const result = registerScheduledRun(db, {
      agentId: 'agent-1',
      cronSpec: '0 9 * * *',
      taskTemplate: TEMPLATE,
      teamTaskId: task.id,
      nextRunAt: 1_000,
    })
    expect(result.ok).toBe(true)
  })

  it('returns task_not_found for a bound registration against a missing task', () => {
    const result = registerScheduledRun(db, {
      agentId: 'agent-1',
      cronSpec: '0 9 * * *',
      taskTemplate: TEMPLATE,
      teamTaskId: 'nope',
      nextRunAt: 1_000,
    })
    expect(result).toEqual({ ok: false, reason: 'task_not_found' })
  })
})

describe('the fire path', () => {
  it('queues exactly the due rows (boundary inclusive) and skips disarmed ones', () => {
    const due = register({ nextRunAt: 1_000 })
    const exact = register({ nextRunAt: 2_000 })
    register({ nextRunAt: 3_000 }) // future
    register({ nextRunAt: null }) // disarmed
    const queued = queueDueRuns(db, 2_000)
    expect(queued.map((r) => r.id).sort()).toEqual([due.id, exact.id].sort())
    expect(listQueuedRuns(db)).toHaveLength(2)
  })

  it('paused rows NEVER auto-fire, even with a due nextRunAt', () => {
    const run = register({ nextRunAt: 1_000 })
    expect(setScheduledRunStatus(db, run.id, 'paused').ok).toBe(true)
    expect(queueDueRuns(db, 5_000)).toHaveLength(0)
  })

  it('ATOMIC CLAIM: the second claim of one queued row returns null (data, never retried)', () => {
    const run = register({ nextRunAt: 1_000 })
    queueDueRuns(db, 2_000)
    const first = claimScheduledRun(db, run.id)
    const second = claimScheduledRun(db, run.id)
    expect(first?.status).toBe('claimed')
    expect(second).toBeNull()
  })

  it('ATOMIC CLAIM is atomic ACROSS connections (the multi-handle server reality)', () => {
    // The server opens many createDb handles to the same file (ticker + each REST
    // handler). The serializer is SQLite's file-level WAL write lock, NOT an
    // in-process lock — so a claim from a SECOND connection on the same row loses.
    const db2 = createDb(path.join(dir, 'test.db'))
    const run = register({ nextRunAt: 1_000 })
    queueDueRuns(db, 2_000)
    const onA = claimScheduledRun(db, run.id)
    const onB = claimScheduledRun(db2, run.id)
    expect([onA, onB].filter((r) => r?.status === 'claimed')).toHaveLength(1)
    expect([onA, onB].filter((r) => r === null)).toHaveLength(1)
  })

  it('records a successful recurring outcome: idle + lastRunAt + re-armed', () => {
    const run = register({ nextRunAt: 1_000 })
    queueDueRuns(db, 2_000)
    claimScheduledRun(db, run.id)
    expect(markRunRunning(db, run.id)).toBe(true)
    recordRunOutcome(db, run.id, { ok: true }, 99_000, 2_000)
    const after = getScheduledRun(db, run.id)
    expect(after).toMatchObject({
      status: 'idle',
      lastRunAt: 2_000,
      nextRunAt: 99_000,
      lastError: null,
    })
  })

  it('once@ self-disables: success with a null re-arm leaves idle + next_run_at NULL', () => {
    const run = register({ cronSpec: 'once@2026-07-01T09:00:00Z', nextRunAt: 1_000 })
    queueDueRuns(db, 2_000)
    claimScheduledRun(db, run.id)
    markRunRunning(db, run.id)
    recordRunOutcome(db, run.id, { ok: true }, null, 2_000)
    expect(getScheduledRun(db, run.id)).toMatchObject({ status: 'idle', nextRunAt: null })
    // The due-pass never picks it up again.
    expect(queueDueRuns(db, 999_999)).toHaveLength(0)
  })

  it('a failed fire HALTS the routine: error + disarmed until a human resumes', () => {
    const run = register({ nextRunAt: 1_000 })
    queueDueRuns(db, 2_000)
    claimScheduledRun(db, run.id)
    markRunRunning(db, run.id)
    recordRunOutcome(db, run.id, { ok: false, error: 'dispatch exploded' }, 99_000, 2_000)
    const after = getScheduledRun(db, run.id)
    expect(after).toMatchObject({
      status: 'error',
      lastError: 'dispatch exploded',
      nextRunAt: null,
    })
    expect(queueDueRuns(db, 999_999)).toHaveLength(0)
    // Resume re-arms.
    const resumed = setScheduledRunStatus(db, run.id, 'idle', { nextRunAt: 5_000 })
    expect(resumed.ok).toBe(true)
    expect(queueDueRuns(db, 6_000)).toHaveLength(1)
  })

  it('queueRunNow force-fires an idle row and minNextRunAt tracks the arm key', () => {
    const a = register({ nextRunAt: 9_000 })
    register({ nextRunAt: 5_000 })
    expect(minNextRunAt(db)).toBe(5_000)
    expect(queueRunNow(db, a.id)).toBe(true)
    expect(listQueuedRuns(db).map((r) => r.id)).toEqual([a.id])
    // Not idle anymore → can't force-fire twice.
    expect(queueRunNow(db, a.id)).toBe(false)
  })
})

describe('user-driven transitions + updates', () => {
  it('enforces the state machine (paused cannot jump to paused-from-running etc.)', () => {
    const run = register()
    queueDueRuns(db, 2_000)
    claimScheduledRun(db, run.id)
    markRunRunning(db, run.id)
    // running → paused is illegal (only idle/queued/error pause).
    expect(setScheduledRunStatus(db, run.id, 'paused')).toEqual({
      ok: false,
      reason: 'illegal_transition',
    })
    expect(setScheduledRunStatus(db, 'missing', 'paused')).toEqual({
      ok: false,
      reason: 'not_found',
    })
  })

  it('updateScheduledRun patches spec/template/nextRunAt', () => {
    const run = register()
    const updated = updateScheduledRun(db, run.id, { cronSpec: '*/5 * * * *', nextRunAt: 7_000 })
    expect(updated).toMatchObject({ cronSpec: '*/5 * * * *', nextRunAt: 7_000 })
    deleteScheduledRun(db, run.id)
    expect(getScheduledRun(db, run.id)).toBeNull()
  })
})

describe('boot-resume reconciliation', () => {
  it('requeues claimed orphans, re-arms recurring running orphans, errors once@ running orphans', () => {
    const claimed = register({ nextRunAt: 1_000 })
    queueDueRuns(db, 2_000)
    claimScheduledRun(db, claimed.id)

    const recurring = register({ nextRunAt: 1_000 })
    queueDueRuns(db, 2_000)
    claimScheduledRun(db, recurring.id)
    markRunRunning(db, recurring.id)

    const once = register({ cronSpec: 'once@2026-07-01T09:00:00Z', nextRunAt: 1_000 })
    queueDueRuns(db, 2_000)
    claimScheduledRun(db, once.id)
    markRunRunning(db, once.id)

    const untouched = register({ nextRunAt: 50_000 })

    const result = reconcileScheduledRuns(db, 10_000, (spec) =>
      spec.startsWith('once@') ? null : 60_000,
    )
    expect(result).toEqual({ requeued: 1, rearmed: 1, errored: 1 })
    expect(getScheduledRun(db, claimed.id)?.status).toBe('queued')
    expect(getScheduledRun(db, recurring.id)).toMatchObject({
      status: 'idle',
      nextRunAt: 60_000,
      lastError: 'orphaned mid-dispatch (restart)',
    })
    expect(getScheduledRun(db, once.id)).toMatchObject({ status: 'error', nextRunAt: null })
    expect(getScheduledRun(db, untouched.id)).toMatchObject({ status: 'idle', nextRunAt: 50_000 })
  })
})

describe('state machine table', () => {
  it('encodes the legal transitions', () => {
    expect(canRoutineTransition('idle', 'queued')).toBe(true)
    expect(canRoutineTransition('queued', 'claimed')).toBe(true)
    expect(canRoutineTransition('claimed', 'running')).toBe(true)
    expect(canRoutineTransition('running', 'idle')).toBe(true)
    expect(canRoutineTransition('running', 'error')).toBe(true)
    expect(canRoutineTransition('error', 'idle')).toBe(true)
    expect(canRoutineTransition('paused', 'idle')).toBe(true)
    expect(canRoutineTransition('paused', 'queued')).toBe(false)
    expect(canRoutineTransition('running', 'paused')).toBe(false)
    expect(canRoutineTransition('idle', 'idle')).toBe(true) // idempotent no-op
    expect(isAutoFireable('idle')).toBe(true)
    expect(isAutoFireable('paused')).toBe(false)
  })
})
