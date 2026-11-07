// The run's own task, bound on its Tasks URL.
//
// An engine run used to start with `taskId: null` and no task on its Tasks
// URL, so an agent that wanted its own task's history had to find the id first.
// Now the URL carries the run's task (signed), and the tools that act on one
// task use it when a call leaves `taskId` out.

import {
  addComment,
  claimTask,
  createDb,
  createTask,
  getComments,
  getTask,
  type ClawbooDb,
} from '@clawboo/db'
import { beforeEach, describe, expect, it } from 'vitest'

import { callText, connectInMemory } from '../../testing'
import { createTasksServer } from '../server'

let db: ClawbooDb
beforeEach(() => {
  db = createDb(':memory:')
})

function claimed(title: string, agentId = 'coder', teamId = 'A'): string {
  const t = createTask(db, { title, teamId, status: 'todo' })
  expect(claimTask(db, t.id, agentId).ok).toBe(true)
  return t.id
}

const bound = (taskId: string) =>
  createTasksServer(db, { boundScope: { teamId: 'A', agentId: 'coder', taskId }, teamRun: true })

describe('Tasks tools with the run bound to its task', () => {
  it('get_task reads the run’s own task when taskId is left out, and any other when named', async () => {
    const mine = claimed('Write the parser')
    const other = createTask(db, { title: 'Write the docs', teamId: 'A' }).id
    addComment(db, mine, 'use the v2 grammar', 'user')
    const client = await connectInMemory(bound(mine))

    const own = await callText(client, 'get_task', {})
    expect(own.isError).toBe(false)
    const parsed = JSON.parse(own.text) as {
      task: { id: string }
      comments: Array<{ body: string }>
    }
    expect(parsed.task.id).toBe(mine)
    expect(parsed.comments.map((c) => c.body)).toEqual(['use the v2 grammar'])

    const named = await callText(client, 'get_task', { taskId: other })
    expect((JSON.parse(named.text) as { task: { id: string } }).task.id).toBe(other)
  })

  describe('the kind a comment is labelled with, which is what may wake an agent', () => {
    const kindOf = async (
      opts: Parameters<typeof createTasksServer>[1],
      args: Record<string, unknown> = {},
    ): Promise<string | null> => {
      const task = createTask(db, { title: 'A task', teamId: 'A' })
      const client = await connectInMemory(createTasksServer(db, opts))
      const res = await callText(client, 'add_comment', { taskId: task.id, body: 'hi', ...args })
      expect(res.isError).toBe(false)
      return (JSON.parse(res.text) as { kind: string | null }).kind
    }

    it("a session bound to an agent is that agent's own words, whatever the call claims", async () => {
      expect(await kindOf({ boundScope: { teamId: 'A', agentId: 'coder' } })).toBe('agent')
      expect(
        await kindOf({ boundScope: { teamId: 'A', agentId: 'coder' } }, { authorType: 'user' }),
      ).toBe('agent')
    })

    it('an unverified HTTP caller gets no kind, whatever it claims', async () => {
      expect(await kindOf({ unverifiedCaller: true })).toBeNull()
      expect(await kindOf({ unverifiedCaller: true }, { authorType: 'user' })).toBeNull()
    })

    it("a stdio bin claiming to be a person is not a person's comment", async () => {
      expect(await kindOf({})).toBeNull()
      expect(await kindOf({}, { authorType: 'user' })).toBeNull()
    })

    it('no caller of this tool can write the one kind that wakes anyone', async () => {
      for (const opts of [
        {},
        { unverifiedCaller: true },
        { boundScope: { teamId: 'A', agentId: 'coder' } },
      ]) {
        expect(await kindOf(opts, { authorType: 'user' })).not.toBe('person')
      }
    })
  })

  it('add_comment and block_task act on the run’s own task when taskId is left out', async () => {
    const mine = claimed('Write the parser')
    const client = await connectInMemory(bound(mine))

    expect((await callText(client, 'add_comment', { body: 'half done' })).isError).toBe(false)
    expect(getComments(db, mine).map((c) => c.body)).toEqual(['half done'])

    expect((await callText(client, 'block_task', {})).isError).toBe(false)
    expect(getTask(db, mine)?.status).toBe('blocked')
  })

  it('still keeps the team boundary for the bound task', async () => {
    const foreign = claimed('Elsewhere', 'coder', 'B')
    const client = await connectInMemory(bound(foreign))
    const res = await callText(client, 'get_task', {})
    expect(res.isError).toBe(true)
    expect(res.text).toContain('not found')
  })

  it('advertises taskId as optional only when a task is bound', async () => {
    const mine = claimed('Write the parser')
    const required = async (server: ReturnType<typeof createTasksServer>, name: string) => {
      const client = await connectInMemory(server)
      const tool = (await client.listTools()).tools.find((t) => t.name === name)
      return (tool?.inputSchema as { required?: string[] }).required ?? []
    }
    for (const name of ['get_task', 'add_comment', 'block_task']) {
      expect(await required(bound(mine), name)).not.toContain('taskId')
      expect(
        await required(
          createTasksServer(db, { boundScope: { teamId: 'A', agentId: 'coder' } }),
          name,
        ),
      ).toContain('taskId')
    }
  })

  it('on a task runner run too, block_task blocks the run’s own task when taskId is left out', async () => {
    // The runner binds its run's task and ends a run whose agent blocked it the
    // way the engine does.
    const mine = claimed('Write the parser')
    const other = createTask(db, { title: 'Write the docs', teamId: 'A' }).id
    const runner = createTasksServer(db, {
      boundScope: { teamId: 'A', agentId: 'coder', taskId: mine },
    })
    const client = await connectInMemory(runner)
    const block = (await client.listTools()).tools.find((t) => t.name === 'block_task')!
    expect((block.inputSchema as { required?: string[] }).required ?? []).not.toContain('taskId')
    expect(block.description).toContain('Leave out taskId')
    expect((await callText(client, 'block_task', {})).isError).toBe(false)
    expect(getTask(db, mine)?.status).toBe('blocked')
    // It can still name another task, as this caller always could.
    expect(getTask(db, other)?.status).toBe('todo')
    expect((await callText(client, 'block_task', { taskId: other })).isError).toBe(false)
    expect(getTask(db, other)?.status).toBe('blocked')
    expect((await callText(client, 'block_task', { taskId: '' })).isError).toBe(true)
  })

  it('with no task bound, block_task still needs the id', async () => {
    const mine = claimed('Write the parser')
    const client = await connectInMemory(
      createTasksServer(db, { boundScope: { teamId: 'A', agentId: 'coder' } }),
    )
    const block = (await client.listTools()).tools.find((t) => t.name === 'block_task')!
    expect((block.inputSchema as { required?: string[] }).required).toContain('taskId')
    expect(block.description).not.toContain('Leave out taskId')
    expect((await callText(client, 'block_task', {})).isError).toBe(true)
    expect(getTask(db, mine)?.status).toBe('in_progress')
  })

  it('refuses an empty taskId instead of reading it as "my task"', async () => {
    const mine = claimed('Write the parser')
    const client = await connectInMemory(bound(mine))
    expect((await callText(client, 'get_task', { taskId: '' })).isError).toBe(true)
    expect((await callText(client, 'add_comment', { taskId: '', body: 'x' })).isError).toBe(true)
    expect((await callText(client, 'block_task', { taskId: '' })).isError).toBe(true)
    expect(getComments(db, mine)).toEqual([])
    expect(getTask(db, mine)?.status).toBe('in_progress')
  })

  it('refuses a call that names no task when no task is bound', async () => {
    const client = await connectInMemory(
      createTasksServer(db, { boundScope: { teamId: 'A', agentId: 'coder' } }),
    )
    expect((await callText(client, 'get_task', {})).isError).toBe(true)
  })
})
