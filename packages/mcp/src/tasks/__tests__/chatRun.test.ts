// A person's one-to-one chat, on the Tasks tools.
//
// It has no task and no engine behind it, and it was served every write there is, board
// wide, since a chat has no team of its own. So a Boo Zero reading a teammate's result
// could move another team's cards, whatever the fence on its hand-off tags said. It gets
// the reads and `add_comment`, held to the agent's own team when it has one. Mailbox rows
// are for the agent's runs on its work, not for this person's turn.

import {
  claimTask,
  createDb,
  createTask,
  enqueueInbox,
  getComments,
  listUndeliveredInbox,
  listWaitingTaskWakes,
  type ClawbooDb,
} from '@clawboo/db'
import { beforeEach, describe, expect, it } from 'vitest'

import { callText, connectInMemory, listToolNames } from '../../testing'
import { createTasksServer } from '../server'

let db: ClawbooDb
beforeEach(() => {
  db = createDb(':memory:')
})

const TEAMLESS = { boundScope: { agentId: 'boo-zero' }, chatRun: true } as const
const MEMBER = { boundScope: { teamId: 'A', agentId: 'coder' }, chatRun: true } as const

describe('Tasks MCP on a one-to-one chat', () => {
  it('serves the reads and add_comment, and no other tool', async () => {
    const names = await listToolNames(await connectInMemory(createTasksServer(db, TEAMLESS)))
    expect(names.sort()).toEqual(['add_comment', 'get_task', 'list_tasks'])
  })

  it('serves the reads alone when the agent’s Tasks access is read', async () => {
    const names = await listToolNames(
      await connectInMemory(createTasksServer(db, { ...TEAMLESS, readOnly: true })),
    )
    expect(names.sort()).toEqual(['get_task', 'list_tasks'])
  })

  it('refuses every other write when called by name', async () => {
    const t = createTask(db, { title: 'Someone else’s', teamId: 'B', status: 'todo' })
    const client = await connectInMemory(createTasksServer(db, TEAMLESS))
    for (const [name, args] of [
      ['update_task_status', { taskId: t.id, status: 'done' }],
      ['unblock_task', { taskId: t.id }],
      ['release_task', { taskId: t.id }],
      ['block_task', { taskId: t.id, waitingOn: 'person', need: 'x' }],
      ['claim_task', { taskId: t.id }],
      ['assign_task', { taskId: t.id, assigneeAgentId: 'coder' }],
      ['create_task', { title: 'New', teamId: 'B' }],
      ['create_subtask', { parentTaskId: t.id, title: 'New' }],
      ['link_task', { taskId: t.id, dependsOnTaskId: t.id }],
    ] as const) {
      expect((await callText(client, name, args)).isError, name).toBe(true)
    }
  })

  it('a teamless agent reads across teams', async () => {
    createTask(db, { title: 'Team A work', teamId: 'A' })
    createTask(db, { title: 'Team B work', teamId: 'B' })
    const client = await connectInMemory(createTasksServer(db, TEAMLESS))
    const { text } = await callText(client, 'list_tasks', {})
    expect(text).toContain('Team A work')
    expect(text).toContain('Team B work')
  })

  it('a team member reads and comments on its own team only', async () => {
    createTask(db, { title: 'Team A work', teamId: 'A' })
    const other = createTask(db, { title: 'Team B work', teamId: 'B' })
    const client = await connectInMemory(createTasksServer(db, MEMBER))
    const { text } = await callText(client, 'list_tasks', {})
    expect(text).toContain('Team A work')
    expect(text).not.toContain('Team B work')
    expect((await callText(client, 'get_task', { taskId: other.id })).isError).toBe(true)
    const comment = await callText(client, 'add_comment', { taskId: other.id, body: 'Hello' })
    expect(comment.isError).toBe(true)
    expect(getComments(db, other.id)).toEqual([])
  })

  it('a comment stays on the thread, under the agent, and wakes no one', async () => {
    const t = createTask(db, { title: 'Theirs', teamId: 'B', status: 'todo' })
    expect(claimTask(db, t.id, 'coder').ok).toBe(true)
    const client = await connectInMemory(createTasksServer(db, TEAMLESS))
    const res = await callText(client, 'add_comment', {
      taskId: t.id,
      body: 'Please look at this',
      authorType: 'user',
      authorAgentId: 'someone-else',
    })
    expect(res.isError).toBe(false)
    expect(res.text).not.toContain('"wake"')
    const [comment] = getComments(db, t.id)
    expect(comment).toMatchObject({ authorType: 'agent', authorAgentId: 'boo-zero', kind: null })
    expect(listWaitingTaskWakes(db, { taskId: t.id })).toEqual([])
  })

  it('takes no mailbox rows: they wait for the agent’s runs on its work', async () => {
    enqueueInbox(db, { agentId: 'boo-zero', teamId: 'A', kind: 'alert', body: 'For a team run' })
    const client = await connectInMemory(createTasksServer(db, TEAMLESS))
    const res = await client.callTool({ name: 'list_tasks', arguments: {} })
    const blocks = res.content as { text: string }[]
    expect(blocks.map((b) => b.text).join('\n')).not.toContain('For a team run')
    expect(listUndeliveredInbox(db, 'boo-zero')).toHaveLength(1)
  })
})
