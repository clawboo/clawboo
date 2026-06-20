// Durable approval-TTL reaper. Against an in-memory board + the shared approvals
// table: a stale pending approval linked to a blocked task is expired, the task is
// unblocked, an 'approval' audit row + an approval_resolved obs event are written,
// and a second pass is a no-op (idempotent).

import { beforeEach, describe, expect, it } from 'vitest'

import {
  createApproval,
  createDb,
  createTask,
  getTask,
  listEvents,
  listGovernanceAudit,
  type ClawbooDb,
} from '@clawboo/db'

import { reapStaleApprovals } from '../approvalReaper'

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

describe('approval-TTL reaper', () => {
  let db: ClawbooDb

  beforeEach(() => {
    db = createDb(':memory:')
  })

  it('expires a stale pending approval, unblocks its linked task, audits + emits obs; idempotent', async () => {
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
    expect(r1.unblocked).toEqual([task.id])
    expect(getTask(db, task.id)?.status).toBe('todo') // unblocked → resumable
    expect(listGovernanceAudit(db, { eventType: 'approval' })).toHaveLength(1)
    const obs = listEvents(db, { kinds: ['approval_resolved'] })
    expect(
      obs.some((e) => (JSON.parse(e.data) as { decision?: string }).decision === 'expired'),
    ).toBe(true)

    // Second pass: nothing pending → a no-op (no new audit, task stays unblocked).
    const r2 = reapStaleApprovals(db, { ttlMs: 5 })
    expect(r2.expired).toEqual([])
    expect(r2.unblocked).toEqual([])
    expect(listGovernanceAudit(db, { eventType: 'approval' })).toHaveLength(1)
    expect(getTask(db, task.id)?.status).toBe('todo')
  })

  it('leaves a fresh (within-TTL) pending approval untouched', () => {
    const a = createApproval(db, { toolName: 'delegate:code', agentId: 'l', args: {} })
    const r = reapStaleApprovals(db, { ttlMs: 60_000 }) // 1-min window, just created → not stale
    expect(r.expired).toEqual([])
    // The approval is still pending (status unchanged).
    expect(a.status).toBe('pending')
  })

  it('an expired approval with no linked task is still expired (no unblock)', async () => {
    createApproval(db, { toolName: 'web_search', agentId: 'a', args: {} }) // no taskId
    await sleep(20)
    const r = reapStaleApprovals(db, { ttlMs: 5 })
    expect(r.expired).toHaveLength(1)
    expect(r.unblocked).toEqual([])
  })
})
