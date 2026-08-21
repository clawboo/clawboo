// A bound Tasks session must isolate WRITES, not only reads.
//
// `boundScope.teamId` guarded `list_tasks` and `get_task` and nothing else. On a
// bound session served without `readOnly`, a model could claim, release,
// re-status, block, comment on or link ANOTHER team's task by guessing an id,
// while `get_task` refused it that same id. Reads were isolated; writes were
// board-wide. Driven over the in-memory MCP transport, like the memory-scope suite.

import { createDb, createTask, getTask, type ClawbooDb } from '@clawboo/db'
import { beforeEach, describe, expect, it } from 'vitest'

import { callText, connectInMemory } from '../../testing'
import { createTasksServer } from '../server'

let db: ClawbooDb
beforeEach(() => {
  db = createDb(':memory:')
})

describe('Tasks MCP — a bound session cannot write across the boundary', () => {
  it('refuses every taskId-taking write on another team', async () => {
    const mine = createTask(db, { title: 'mine', status: 'todo', teamId: 'A' })
    const theirs = createTask(db, { title: 'theirs', status: 'todo', teamId: 'B' })
    const client = await connectInMemory(createTasksServer(db, { boundScope: { teamId: 'A' } }))

    const attempts: Array<[string, Record<string, unknown>]> = [
      ['claim_task', { taskId: theirs.id, assigneeAgentId: 'x' }],
      ['assign_task', { taskId: theirs.id, assigneeAgentId: 'x' }],
      ['release_task', { taskId: theirs.id }],
      ['update_task_status', { taskId: theirs.id, status: 'in_progress' }],
      ['block_task', { taskId: theirs.id }],
      ['unblock_task', { taskId: theirs.id }],
      ['add_comment', { taskId: theirs.id, body: 'hi' }],
      ['link_task', { taskId: mine.id, dependsOnTaskId: theirs.id }],
    ]
    for (const [name, args] of attempts) {
      const res = await callText(client, name, args)
      // Same wording as a refused READ: a bound run must not be able to tell a
      // hidden task from an absent one by probing either surface.
      expect(res.text, `${name} must refuse a cross-team write`).toContain('not found')
    }
    expect(getTask(db, theirs.id)?.status).toBe('todo') // untouched
  })

  it('create_task cannot escape the binding by NAMING another team', async () => {
    // The one write the outOfTeam guard cannot catch: the task does not exist
    // yet. The caller's teamId was honoured verbatim, so a bound model could
    // create into any team. The binding now decides the team, not the argument.
    const client = await connectInMemory(createTasksServer(db, { boundScope: { teamId: 'A' } }))
    const res = await callText(client, 'create_task', { title: 'sneaky', teamId: 'B' })
    const created = JSON.parse(res.text) as { id: string; teamId: string }
    expect(created.teamId).toBe('A') // forced into the bound team
    expect(getTask(db, created.id)?.teamId).toBe('A')
  })

  it('create_task refuses a PARENT from another team (inheritance escape)', async () => {
    // A subtask inherits its parent's team, so a foreign parent is a cross-team
    // write wearing a create's clothes.
    const theirs = createTask(db, { title: 'theirs', status: 'todo', teamId: 'B' })
    const client = await connectInMemory(createTasksServer(db, { boundScope: { teamId: 'A' } }))
    const res = await callText(client, 'create_task', {
      title: 'child',
      parentTaskId: theirs.id,
    })
    expect(res.text).toContain('not found') // same wording as a refused read
  })

  it('still permits the same writes INSIDE the bound team', async () => {
    const mine = createTask(db, { title: 'mine', status: 'todo', teamId: 'A' })
    const client = await connectInMemory(createTasksServer(db, { boundScope: { teamId: 'A' } }))
    const res = await callText(client, 'block_task', { taskId: mine.id })
    expect(res.text).not.toContain('not found')
    expect(getTask(db, mine.id)?.status).toBe('blocked')
  })

  it('an UNBOUND session is unchanged (no scope, no guard)', async () => {
    const theirs = createTask(db, { title: 'theirs', status: 'todo', teamId: 'B' })
    const client = await connectInMemory(createTasksServer(db))
    const res = await callText(client, 'block_task', { taskId: theirs.id })
    expect(res.text).not.toContain('not found')
  })
})
