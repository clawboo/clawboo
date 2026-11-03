// Cancelling a task through the Tasks tools takes its waiting plan steps with it,
// as a person's cancel on the board does, and the agent that delegated the task
// hears about it.
//
// Only the board PATCH cascaded. `update_task_status(cancelled)` changed the one
// row, so every later step of the plan sat in To do forever: never ready (its
// blocker is cancelled, not done), and never in Needs you (a bound To do task with
// a clean ledger reads as queued work).

import {
  createDb,
  createTask,
  getTask,
  linkDep,
  listUndeliveredInbox,
  updateStatus,
  type ClawbooDb,
} from '@clawboo/db'
import { beforeEach, describe, expect, it } from 'vitest'

import { callText, connectInMemory } from '../../testing'
import { createTasksServer } from '../server'

let db: ClawbooDb
beforeEach(() => {
  db = createDb(':memory:')
})

/** The `sourceDelegationId` the engine writes for a hand-off from `from` to `to`. */
const sdid = (to: string, from: string): string => `run-1:deleg:agent:${to}:reflectTo:${from}`

/** A three-step plan the lead handed out: step 2 waits on step 1, step 3 on step 2. */
function plan(): { first: string; second: string; third: string } {
  const first = createTask(db, {
    title: 'Research the market',
    teamId: 'A',
    status: 'todo',
    sourceDelegationId: sdid('researcher', 'lead'),
  })
  const second = createTask(db, {
    title: 'Write the brief',
    teamId: 'A',
    status: 'todo',
    sourceDelegationId: sdid('writer', 'lead'),
  })
  const third = createTask(db, {
    title: 'Design the deck',
    teamId: 'A',
    status: 'todo',
    sourceDelegationId: sdid('designer', 'lead'),
  })
  linkDep(db, second.id, first.id)
  linkDep(db, third.id, second.id)
  return { first: first.id, second: second.id, third: third.id }
}

const cancel = async (opts: Parameters<typeof createTasksServer>[1], taskId: string) =>
  callText(await connectInMemory(createTasksServer(db, opts)), 'update_task_status', {
    taskId,
    status: 'cancelled',
  })

describe('Tasks MCP: cancelling a task', () => {
  it('cancels the plan steps waiting on it, all the way down the chain', async () => {
    const { first, second, third } = plan()
    const res = await cancel({ boundScope: { teamId: 'A', agentId: 'reviewer' } }, first)
    expect(res.isError).toBe(false)
    expect(getTask(db, first)?.status).toBe('cancelled')
    expect(getTask(db, second)?.status).toBe('cancelled')
    expect(getTask(db, third)?.status).toBe('cancelled')
    const body = JSON.parse(res.text) as {
      id: string
      status: string
      cancelledDependents?: Array<{ id: string; title: string }>
    }
    expect(body).toMatchObject({ id: first, status: 'cancelled' })
    expect(body.cancelledDependents?.map((d) => d.id).sort()).toEqual([second, third].sort())
  })

  it('leaves a step that is already running alone', async () => {
    const { first, second } = plan()
    expect(updateStatus(db, second, 'in_progress').ok).toBe(true)
    const res = await cancel({ boundScope: { teamId: 'A', agentId: 'reviewer' } }, first)
    expect(res.isError).toBe(false)
    expect(getTask(db, second)?.status).toBe('in_progress')
  })

  it("leaves a note in the delegator's mailbox naming the task and the steps cancelled with it", async () => {
    const { first } = plan()
    await cancel({ boundScope: { teamId: 'A', agentId: 'reviewer' } }, first)
    const rows = listUndeliveredInbox(db, 'lead', { teamId: 'A' })
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ kind: 'task_update', taskId: first })
    expect(rows[0]!.body).toContain('Research the market')
    expect(rows[0]!.body).toContain('2 later steps')
  })

  it('does not tell the delegator about its own cancel', async () => {
    const { first } = plan()
    await cancel({ boundScope: { teamId: 'A', agentId: 'lead' } }, first)
    expect(listUndeliveredInbox(db, 'lead', { teamId: 'A' })).toHaveLength(0)
    expect(getTask(db, first)?.status).toBe('cancelled')
  })

  it('cascades for the operator too, who cancels through the stdio bin', async () => {
    const { first, second } = plan()
    await cancel(undefined, first)
    expect(getTask(db, second)?.status).toBe('cancelled')
    expect(listUndeliveredInbox(db, 'lead', { teamId: 'A' })).toHaveLength(1)
  })

  it('writes nothing more for a status that is not a cancel', async () => {
    const { first, second } = plan()
    const client = await connectInMemory(
      createTasksServer(db, { boundScope: { teamId: 'A', agentId: 'reviewer' } }),
    )
    const res = await callText(client, 'update_task_status', { taskId: first, status: 'blocked' })
    expect(res.isError).toBe(false)
    expect(getTask(db, second)?.status).toBe('todo')
    expect(listUndeliveredInbox(db, 'lead', { teamId: 'A' })).toHaveLength(0)
  })
})
