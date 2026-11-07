// An approval names its board task. That is a record for the card and the
// event log: nothing moves the task when the approval expires.

import { mkdtempSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { z } from 'zod'

import { claimTask, createTask, getTask, updateStatus } from '../../board/repository'
import { setTaskVerification } from '../../board/verification'
import { createDb, type ClawbooDb } from '../../db'
import { listEvents } from '../../events/listEvents'
import { defaultAvailabilityContext } from '../availability'
import { executeBrokeredCall } from '../broker'
import {
  createApproval,
  getApproval,
  listPendingApprovals,
  resolveApproval,
  waitForApproval,
} from '../persistence'
import { ToolRegistry } from '../registry'

let dir: string
let db: ClawbooDb

beforeEach(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), 'clawboo-approval-task-'))
  db = createDb(path.join(dir, 'test.db'))
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

const pastDeadline = (id: string) =>
  db.$client
    .prepare('UPDATE tool_call_approvals SET expires_at = ? WHERE id = ?')
    .run(Date.now() - 1, id)

const blockedTask = () => {
  const t = createTask(db, { title: 'gated', teamId: 'team-1' })
  updateStatus(db, t.id, 'blocked')
  return t.id
}

const failVerdict = (taskId: string) =>
  setTaskVerification(db, taskId, {
    status: 'fail',
    attempts: [
      {
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
      },
    ],
    debtNotes: [],
    updatedAt: Date.now(),
  })

const moves = (taskId: string) =>
  listEvents(db, { kinds: ['status_changed'] })
    .filter((e) => e.taskId === taskId)
    .map((e) => JSON.parse(e.data) as Record<string, unknown>)

describe('the broker', () => {
  function needsApprovalRegistry(): ToolRegistry {
    const registry = new ToolRegistry()
    registry.register({
      name: 'touch',
      description: 'touches something',
      inputSchema: z.object({}),
      owner: 'mcp',
      executor: () => 'done',
    })
    return registry
  }

  async function brokered(taskId?: string): Promise<string | null> {
    const call = executeBrokeredCall(
      db,
      { name: 'touch', args: {} },
      {
        agentId: 'boo-1',
        availability: defaultAvailabilityContext({ env: {} }),
        ...(taskId ? { taskId } : {}),
      },
      {
        registry: needsApprovalRegistry(),
        inspectors: [() => ({ kind: 'require_approval' as const, message: 'asks' })],
        approvalPollMs: 5,
        approvalTimeoutMs: 5_000,
      },
    )
    for (let i = 0; i < 200 && listPendingApprovals(db).length === 0; i += 1)
      await new Promise((r) => setTimeout(r, 5))
    const [pending] = listPendingApprovals(db)
    resolveApproval(db, pending!.id, 'deny')
    await call
    return getApproval(db, pending!.id)!.taskId
  }

  it("records the run's task on the approval it opens", async () => {
    expect(await brokered('task-1')).toBe('task-1')
  })

  it('records none for a run with no task', async () => {
    expect(await brokered()).toBeNull()
  })
})

// Nothing blocks a task FOR an approval, so a blocked task a card names is blocked
// for another reason: its agent asked for help, a run failed, a person parked it.
// A lapse must leave it there. Moved to To do, it loses its assignee and verdict and
// its Needs you card, and the pump runs it again.
describe('an approval that lapses', () => {
  /** Blocked with an agent on it, the way a run that gave up leaves a task. */
  const blockedByItsAgent = () => {
    const t = createTask(db, { title: 'gated', teamId: 'team-1' })
    claimTask(db, t.id, 'boo-1')
    updateStatus(db, t.id, 'blocked')
    return t.id
  }
  const expectUntouched = (taskId: string) => {
    expect(getTask(db, taskId)).toMatchObject({ status: 'blocked', assigneeAgentId: 'boo-1' })
    expect(moves(taskId)).toEqual([])
  }

  it('leaves a blocked task alone when its waiter gives up on the deadline', async () => {
    const taskId = blockedByItsAgent()
    const a = createApproval(db, { toolName: 'x', args: {}, taskId })
    pastDeadline(a.id)
    expect(await waitForApproval(db, a.id, { pollMs: 5 })).toBe('expired')
    expectUntouched(taskId)
  })

  it('leaves it alone when the waiter runs out of its own time first', async () => {
    const taskId = blockedByItsAgent()
    const a = createApproval(db, { toolName: 'x', args: {}, taskId })
    expect(await waitForApproval(db, a.id, { timeoutMs: 10, pollMs: 2 })).toBe('timeout')
    expectUntouched(taskId)
  })

  it('leaves it alone when a late answer is what finds the card expired', () => {
    const taskId = blockedByItsAgent()
    const a = createApproval(db, { toolName: 'x', args: {}, taskId })
    pastDeadline(a.id)
    resolveApproval(db, a.id, 'deny')
    expect(getApproval(db, a.id)?.status).toBe('expired')
    expectUntouched(taskId)
  })

  it('keeps a stored verdict on the task', async () => {
    const taskId = blockedTask()
    failVerdict(taskId)
    const a = createApproval(db, { toolName: 'x', args: {}, taskId })
    pastDeadline(a.id)
    await waitForApproval(db, a.id, { pollMs: 5 })
    expect(getTask(db, taskId)?.status).toBe('blocked')
    expect(getTask(db, taskId)?.verification).not.toBeNull()
  })

  it('still closes the card, and still names the task in its event', async () => {
    const taskId = blockedTask()
    const a = createApproval(db, { toolName: 'x', args: {}, taskId })
    pastDeadline(a.id)
    await waitForApproval(db, a.id, { pollMs: 5 })
    expect(getApproval(db, a.id)?.status).toBe('expired')
    const [event] = listEvents(db, { kinds: ['approval_resolved'] })
    expect(event?.taskId).toBe(taskId)
  })
})
