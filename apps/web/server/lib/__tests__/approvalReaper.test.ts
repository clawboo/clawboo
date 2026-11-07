// Durable approval-TTL reaper. Against an in-memory board + the shared approvals
// table: a stale pending approval is expired, an 'approval' audit row + one
// approval_resolved obs event are written, a second pass is a no-op (idempotent),
// and no task moves.

import { beforeEach, describe, expect, it } from 'vitest'

import {
  askQuestion,
  claimTask,
  createApproval,
  createDb,
  createTask,
  getTask,
  getTaskVerification,
  handBackTask,
  listEvents,
  listGovernanceAudit,
  listTaskQuestions,
  setTaskVerification,
  updateStatus,
  type ClawbooDb,
} from '@clawboo/db'

import { reapStaleApprovals } from '../approvalReaper'

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

describe('approval-TTL reaper', () => {
  let db: ClawbooDb

  beforeEach(() => {
    db = createDb(':memory:')
  })

  it('expires a stale pending approval, audits + emits obs; idempotent', async () => {
    const task = createTask(db, { title: 'gated', status: 'blocked', teamId: 't1' })
    const approval = createApproval(db, {
      toolName: 'delegate:code',
      agentId: 'leader-1',
      args: { x: 1 },
      taskId: task.id,
    })
    await sleep(20)

    const r1 = reapStaleApprovals(db, { ttlMs: 5 })
    expect(r1.expired).toEqual([approval.id])
    expect(listGovernanceAudit(db, { eventType: 'approval' })).toHaveLength(1)
    // Exactly one event per expiry, naming the call it settled, so a reader of
    // the log can drop the card it was showing.
    const resolvedData = () =>
      listEvents(db, { kinds: ['approval_resolved'] }).map((e) => JSON.parse(e.data) as unknown)
    expect(resolvedData()).toEqual([
      { approvalId: approval.id, decision: 'expired', kind: 'tool', toolName: 'delegate:code' },
    ])

    // Second pass: nothing pending → a no-op (no new audit).
    const r2 = reapStaleApprovals(db, { ttlMs: 5 })
    expect(r2.expired).toEqual([])
    expect(listGovernanceAudit(db, { eventType: 'approval' })).toHaveLength(1)
    expect(resolvedData()).toHaveLength(1)
  })

  it('leaves a fresh (within-TTL) pending approval untouched', () => {
    const a = createApproval(db, { toolName: 'delegate:code', agentId: 'l', args: {} })
    const r = reapStaleApprovals(db, { ttlMs: 60_000 }) // 1-min window, just created → not stale
    expect(r.expired).toEqual([])
    // The approval is still pending (status unchanged).
    expect(a.status).toBe('pending')
  })

  it('an expired approval with no linked task is still expired', async () => {
    createApproval(db, { toolName: 'web_search', agentId: 'a', args: {} }) // no taskId
    await sleep(20)
    const r = reapStaleApprovals(db, { ttlMs: 5 })
    expect(r.expired).toHaveLength(1)
  })
})

describe('approval-TTL reaper: it moves no task', () => {
  const FAILED_ATTEMPT: Parameters<typeof setTaskVerification>[2]['attempts'][number] = {
    attempt: 1,
    at: Date.now(),
    deterministic: {
      command: 'pnpm test',
      exitCode: 1,
      passed: false,
      stdoutTail: '',
      stderrTail: '',
      durationMs: 12,
      timedOut: false,
    },
    critic: {
      ran: false,
      findings: [],
      reviewerRuntime: null,
      reviewerModel: null,
      reviewedSha: null,
    },
    status: 'fail',
    structuredError: null,
  }

  it('leaves a task a person parked, a day later', async () => {
    const db = createDb(':memory:')
    const task = createTask(db, { title: 'parked', teamId: 't1' })
    updateStatus(db, task.id, 'blocked', { actor: 'person' })
    const approval = createApproval(db, {
      toolName: 'delegate:code',
      agentId: 'l',
      args: {},
      taskId: task.id,
    })
    await sleep(20)
    const r = reapStaleApprovals(db, { ttlMs: 5 })
    expect(r.expired).toEqual([approval.id])
    expect(getTask(db, task.id)?.status).toBe('blocked')
  })

  it('leaves a task its run left Blocked, with its agent on it', async () => {
    const db = createDb(':memory:')
    const task = createTask(db, { title: 'failed', teamId: 't1' })
    claimTask(db, task.id, 'coder')
    updateStatus(db, task.id, 'blocked')
    createApproval(db, { toolName: 'x', agentId: 'coder', args: {}, taskId: task.id })
    await sleep(20)
    reapStaleApprovals(db, { ttlMs: 5 })
    expect(getTask(db, task.id)).toMatchObject({ status: 'blocked', assigneeAgentId: 'coder' })
  })

  it('leaves what a task says it waits on: a question, a hand-back', async () => {
    const db = createDb(':memory:')
    const asking = createTask(db, { title: 'asks', status: 'todo' })
    claimTask(db, asking.id, 'a1')
    expect(
      askQuestion(db, {
        taskId: asking.id,
        agentId: 'a1',
        kind: 'confirm',
        payload: { prompt: 'Go?' },
      }).ok,
    ).toBe(true)
    const back = createTask(db, { title: 'back', status: 'todo' })
    claimTask(db, back.id, 'a1')
    expect(handBackTask(db, back.id, { agentId: 'a1', need: 'Look' }).ok).toBe(true)
    const waitsBefore = [asking.id, back.id].map((id) => getTask(db, id)?.waitingOn)
    for (const id of [asking.id, back.id]) {
      createApproval(db, { toolName: 'delegate:code', agentId: 'a1', args: {}, taskId: id })
    }
    await sleep(20)

    expect(reapStaleApprovals(db, { ttlMs: 5 }).expired).toHaveLength(2)
    expect(getTask(db, asking.id)?.status).toBe('blocked')
    expect(listTaskQuestions(db, asking.id)[0]?.status).toBe('pending')
    expect(getTask(db, back.id)?.status).toBe('blocked')
    expect([asking.id, back.id].map((id) => getTask(db, id)?.waitingOn)).toEqual(waitsBefore)
  })

  it('leaves a failing verdict on the task', async () => {
    const db = createDb(':memory:')
    const task = createTask(db, { title: 'failed check', status: 'blocked', teamId: 't1' })
    setTaskVerification(db, task.id, {
      status: 'fail',
      attempts: [FAILED_ATTEMPT],
      debtNotes: [],
      updatedAt: Date.now(),
    })
    createApproval(db, { toolName: 'x', agentId: 'l', args: {}, taskId: task.id })
    await sleep(20)
    reapStaleApprovals(db, { ttlMs: 5 })
    expect(getTask(db, task.id)?.status).toBe('blocked')
    expect(getTaskVerification(db, task.id)?.status).toBe('fail')
  })
})
