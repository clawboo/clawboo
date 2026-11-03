// Who may write the board through the Tasks tools.
//
// On a team run the team engine owns claims and statuses. A coding agent's stray
// `claim_task` stranded a card that no recovery pass, Needs you, Retry or Assign
// could reach, and its own `update_task_status(done)` read to the engine as a
// person finishing the task, so the delegator never got the result. An OpenClaw
// agent's URL carries no identity at all, so the same status writes came from an
// agent nobody could name. And `claim_task` took the claimant from its arguments
// even when the caller's identity was signed.

import { claimTask, createDb, createTask, getTask, type ClawbooDb } from '@clawboo/db'
import { beforeEach, describe, expect, it } from 'vitest'

import { callText, connectInMemory, listToolNames } from '../../testing'
import { createTasksServer } from '../server'

let db: ClawbooDb
beforeEach(() => {
  db = createDb(':memory:')
})

const TEAM_RUN = { boundScope: { teamId: 'A', agentId: 'coder' }, teamRun: true } as const

/** A task the engine handed to `agentId` and claimed for it. */
function claimedBy(agentId: string, title = 'Write the parser'): string {
  const t = createTask(db, { title, teamId: 'A', status: 'todo' })
  expect(claimTask(db, t.id, agentId).ok).toBe(true)
  return t.id
}

describe('Tasks MCP on a team run', () => {
  it('serves reads, creates, comments, links and block_task, and none of the engine-owned writes', async () => {
    const names = await listToolNames(await connectInMemory(createTasksServer(db, TEAM_RUN)))
    expect(names.sort()).toEqual(
      [
        'add_comment',
        'block_task',
        'create_subtask',
        'create_task',
        'get_task',
        'link_task',
        'list_tasks',
      ].sort(),
    )
  })

  it('refuses every engine-owned write even when called by name', async () => {
    const taskId = claimedBy('coder')
    const client = await connectInMemory(createTasksServer(db, TEAM_RUN))
    for (const [name, args] of [
      ['claim_task', { taskId, assigneeAgentId: 'coder' }],
      ['assign_task', { taskId, assigneeAgentId: 'tester' }],
      ['release_task', { taskId }],
      ['update_task_status', { taskId, status: 'done' }],
      ['unblock_task', { taskId }],
    ] as const) {
      const res = await callText(client, name, args)
      expect(res.isError, name).toBe(true)
    }
    expect(getTask(db, taskId)?.status).toBe('in_progress')
    expect(getTask(db, taskId)?.assigneeAgentId).toBe('coder')
  })

  it('lets the agent block its own task', async () => {
    const taskId = claimedBy('coder')
    const client = await connectInMemory(createTasksServer(db, TEAM_RUN))
    const res = await callText(client, 'block_task', { taskId })
    expect(res.isError).toBe(false)
    expect(getTask(db, taskId)?.status).toBe('blocked')
  })

  it("refuses to block another agent's task, and says what to do instead", async () => {
    const theirs = claimedBy('tester', 'Run the suite')
    const client = await connectInMemory(createTasksServer(db, TEAM_RUN))
    const res = await callText(client, 'block_task', { taskId: theirs })
    expect(res.isError).toBe(true)
    expect(res.text).toContain('only the task you are working on')
    expect(res.text).toContain('add_comment')
    expect(getTask(db, theirs)?.status).toBe('in_progress')
  })

  it('refuses to block a waiting task nobody has claimed', async () => {
    const waiting = createTask(db, { title: 'Later step', teamId: 'A', status: 'todo' })
    const client = await connectInMemory(createTasksServer(db, TEAM_RUN))
    const res = await callText(client, 'block_task', { taskId: waiting.id })
    expect(res.isError).toBe(true)
    expect(getTask(db, waiting.id)?.status).toBe('todo')
  })
})

describe('Tasks MCP for an unverified caller (every OpenClaw agent)', () => {
  it('serves no status writes, since nobody can tell which agent is writing', async () => {
    const names = await listToolNames(
      await connectInMemory(createTasksServer(db, { unverifiedCaller: true })),
    )
    expect(names.sort()).toEqual(
      [
        'add_comment',
        'create_subtask',
        'create_task',
        'get_task',
        'link_task',
        'list_tasks',
      ].sort(),
    )
  })

  it('refuses a status write called by name', async () => {
    const taskId = claimedBy('coder')
    const client = await connectInMemory(createTasksServer(db, { unverifiedCaller: true }))
    for (const [name, args] of [
      ['update_task_status', { taskId, status: 'done' }],
      ['block_task', { taskId }],
      ['release_task', { taskId }],
    ] as const) {
      expect((await callText(client, name, args)).isError, name).toBe(true)
    }
    expect(getTask(db, taskId)?.status).toBe('in_progress')
  })
})

describe('claim_task claims for the verified caller', () => {
  it('claims for the bound agent without being told who it is', async () => {
    const t = createTask(db, { title: 'Fix the flake', teamId: 'A', status: 'todo' })
    const client = await connectInMemory(
      createTasksServer(db, { boundScope: { teamId: 'A', agentId: 'coder' } }),
    )
    const res = await callText(client, 'claim_task', { taskId: t.id })
    expect(res.isError).toBe(false)
    expect(getTask(db, t.id)?.assigneeAgentId).toBe('coder')
  })

  it('refuses to claim as another agent, and points at assign_task', async () => {
    const t = createTask(db, { title: 'Fix the flake', teamId: 'A', status: 'todo' })
    const client = await connectInMemory(
      createTasksServer(db, { boundScope: { teamId: 'A', agentId: 'coder' } }),
    )
    const res = await callText(client, 'claim_task', { taskId: t.id, assigneeAgentId: 'tester' })
    expect(res.isError).toBe(true)
    expect(res.text).toContain('assign_task')
    expect(getTask(db, t.id)?.status).toBe('todo')
    expect(getTask(db, t.id)?.assigneeAgentId).toBeNull()
  })

  it('still accepts its own id as the claimant', async () => {
    const t = createTask(db, { title: 'Fix the flake', teamId: 'A', status: 'todo' })
    const client = await connectInMemory(
      createTasksServer(db, { boundScope: { teamId: 'A', agentId: 'coder' } }),
    )
    const res = await callText(client, 'claim_task', { taskId: t.id, assigneeAgentId: 'coder' })
    expect(res.isError).toBe(false)
    expect(getTask(db, t.id)?.assigneeAgentId).toBe('coder')
  })

  it('leaves assign_task free to name any agent', async () => {
    const t = createTask(db, { title: 'Fix the flake', teamId: 'A', status: 'todo' })
    const client = await connectInMemory(
      createTasksServer(db, { boundScope: { teamId: 'A', agentId: 'coder' } }),
    )
    const res = await callText(client, 'assign_task', { taskId: t.id, assigneeAgentId: 'tester' })
    expect(res.isError).toBe(false)
    expect(getTask(db, t.id)?.assigneeAgentId).toBe('tester')
  })

  it('keeps the argument for the operator (stdio bin), who has no bound identity', async () => {
    const t = createTask(db, { title: 'Fix the flake', teamId: 'A', status: 'todo' })
    const client = await connectInMemory(createTasksServer(db))
    const res = await callText(client, 'claim_task', { taskId: t.id, assigneeAgentId: 'tester' })
    expect(res.isError).toBe(false)
    expect(getTask(db, t.id)?.assigneeAgentId).toBe('tester')
  })

  it('tells the operator the claimant is needed when it is left out', async () => {
    const t = createTask(db, { title: 'Fix the flake', teamId: 'A', status: 'todo' })
    const client = await connectInMemory(createTasksServer(db))
    const res = await callText(client, 'claim_task', { taskId: t.id })
    expect(res.isError).toBe(true)
    expect(getTask(db, t.id)?.status).toBe('todo')
  })
})
