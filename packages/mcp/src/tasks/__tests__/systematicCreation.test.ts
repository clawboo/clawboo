// Tasks are created once and easy to name: readable ids on every tool, idempotency
// keys and the same-title check on the create tools, the cycle guard on assign_task,
// the Urgent rule, and the child slot a person's cancel frees.

import {
  createDb,
  createTask,
  getComments,
  getTask,
  listTasks,
  teams,
  updateStatus,
  type ClawbooDb,
  type DbTask,
} from '@clawboo/db'
import { beforeEach, describe, expect, it } from 'vitest'

import { callText, connectInMemory } from '../../testing'
import { createTasksServer, type TasksServerOptions } from '../server'

let db: ClawbooDb

function addTeam(id: string, name: string, leaderAgentId?: string): void {
  db.insert(teams)
    .values({ id, name, icon: 'x', color: '#0', leaderAgentId, createdAt: 1, updatedAt: 1 })
    .run()
}

beforeEach(() => {
  db = createDb(':memory:')
  addTeam('A', 'Alpha')
  addTeam('B', 'Bravo')
})

const client = (opts?: TasksServerOptions) => connectInMemory(createTasksServer(db, opts))

const boundToA = (taskId?: string, agentId = 'coder'): TasksServerOptions => ({
  boundScope: { teamId: 'A', agentId, ...(taskId ? { taskId } : {}) },
})

type Created = DbTask & { deduplicated?: boolean; deduplicatedBy?: string; note?: string }
const parse = (r: { text: string }): Created => JSON.parse(r.text) as Created

describe('readable ids on the tools', () => {
  it('every tool that names a task takes the identifier, in either case', async () => {
    const t = createTask(db, { title: 'mine', teamId: 'A' })
    const other = createTask(db, { title: 'other', teamId: 'A' })
    expect(t.identifier).toBe('ALP-1')
    const c = await client()

    const read = await callText(c, 'get_task', { taskId: 'alp-1' })
    expect((JSON.parse(read.text) as { task: DbTask }).task.id).toBe(t.id)

    expect((await callText(c, 'add_comment', { taskId: 'ALP-1', body: 'hi' })).isError).toBe(false)
    expect(getComments(db, t.id).map((x) => x.body)).toEqual(['hi'])

    const sub = parse(await callText(c, 'create_subtask', { parentTaskId: 'ALP-1', title: 's' }))
    expect(sub.parentTaskId).toBe(t.id)

    const sub2 = parse(
      await callText(c, 'create_task', { parentTaskId: 'ALP-1', title: 's2', teamId: 'A' }),
    )
    expect(sub2.parentTaskId).toBe(t.id)

    const link = await callText(c, 'link_task', { taskId: 'ALP-1', dependsOnTaskId: 'ALP-2' })
    expect(link.isError).toBe(false)
    expect(link.text).toContain(other.id)

    expect((await callText(c, 'block_task', { taskId: 'ALP-1' })).isError).toBe(false)
    expect(getTask(db, t.id)?.status).toBe('blocked')
  })

  it('a tool result carries the identifier', async () => {
    const c = await client(boundToA())
    expect(parse(await callText(c, 'create_task', { title: 'x' })).identifier).toBe('ALP-1')
  })

  it("a bound session cannot tell another team's identifier from one that is not there", async () => {
    createTask(db, { title: 'theirs', teamId: 'B' })
    const c = await client(boundToA())
    const theirs = await callText(c, 'get_task', { taskId: 'BRA-1' })
    const none = await callText(c, 'get_task', { taskId: 'BRA-99' })
    expect(theirs.isError).toBe(true)
    expect(theirs.text).toBe('not found: BRA-1')
    expect(none.text).toBe('not found: BRA-99')
    const write = await callText(c, 'add_comment', { taskId: 'BRA-1', body: 'x' })
    expect(write.text).toBe('not found: BRA-1')
  })

  it('an unknown reference still answers not found', async () => {
    const c = await client()
    expect((await callText(c, 'get_task', { taskId: 'NOPE-1' })).text).toBe('not found: NOPE-1')
  })
})

describe('idempotency keys on the create tools', () => {
  it('the same create retried with the same key returns the same task', async () => {
    const c = await client(boundToA())
    const args = { title: 'Build it', idempotencyKey: 'k1' }
    const first = parse(await callText(c, 'create_task', args))
    const again = parse(await callText(c, 'create_task', args))
    expect(first.deduplicated).toBeUndefined()
    expect(again.id).toBe(first.id)
    expect(again.deduplicated).toBe(true)
    expect(listTasks(db, { teamId: 'A' })).toHaveLength(1)
  })

  it('a key belongs to its team, so it cannot fetch another team’s task', async () => {
    const a = parse(
      await callText(await client(boundToA()), 'create_task', { title: 'x', idempotencyKey: 'k' }),
    )
    const b = parse(
      await callText(
        await client({ boundScope: { teamId: 'B', agentId: 'other' } }),
        'create_task',
        { title: 'x', idempotencyKey: 'k' },
      ),
    )
    expect(b.id).not.toBe(a.id)
    expect(b.teamId).toBe('B')
  })

  it('a run that creates the same sub-task twice gets one, with no key', async () => {
    const parent = createTask(db, { title: 'parent', teamId: 'A' })
    const c = await client(boundToA(parent.id))
    const first = parse(
      await callText(c, 'create_task', { title: 'Add login', parentTaskId: parent.id }),
    )
    const again = parse(
      await callText(c, 'create_subtask', { title: 'add  LOGIN', parentTaskId: parent.id }),
    )
    expect(again.id).toBe(first.id)
    expect(again.deduplicated).toBe(true)
  })

  it('the default key finds a sub-task that has already finished', async () => {
    const parent = createTask(db, { title: 'parent', teamId: 'A' })
    const c = await client(boundToA(parent.id))
    const first = parse(
      await callText(c, 'create_subtask', { title: 'once', parentTaskId: parent.id }),
    )
    updateStatus(db, first.id, 'in_progress')
    expect(updateStatus(db, first.id, 'done').ok).toBe(true)
    const again = parse(
      await callText(c, 'create_subtask', { title: 'once', parentTaskId: parent.id }),
    )
    expect(again.id).toBe(first.id)
    expect(again.status).toBe('done')
  })

  it('the default key keeps the same title under two parents apart', async () => {
    const p1 = createTask(db, { title: 'p1', teamId: 'A' })
    const p2 = createTask(db, { title: 'p2', teamId: 'A' })
    const c = await client(boundToA(p1.id))
    const a = parse(await callText(c, 'create_subtask', { title: 'same', parentTaskId: p1.id }))
    const b = parse(await callText(c, 'create_subtask', { title: 'same', parentTaskId: p2.id }))
    expect(b.id).not.toBe(a.id)
  })

  it('a retry of a blocked sub-task makes a new one', async () => {
    const parent = createTask(db, { title: 'parent', teamId: 'A' })
    const c = await client(boundToA(parent.id))
    const first = parse(
      await callText(c, 'create_subtask', { title: 'try', parentTaskId: parent.id }),
    )
    updateStatus(db, first.id, 'blocked')
    const again = parse(
      await callText(c, 'create_subtask', { title: 'try', parentTaskId: parent.id }),
    )
    expect(again.id).not.toBe(first.id)
    expect(again.deduplicated).toBeUndefined()
  })

  it('an OpenClaw session has no bound task, so it falls back to the team and title', async () => {
    const opts: TasksServerOptions = { unverifiedCaller: true }
    const first = parse(
      await callText(await client(opts), 'create_task', { title: 'Do it', teamId: 'A' }),
    )
    // A retry from another session of the same agent, while the task is open.
    const again = parse(
      await callText(await client(opts), 'create_task', { title: 'do it!', teamId: 'A' }),
    )
    expect(again.id).toBe(first.id)
    expect(again.deduplicatedBy).toBe('key')
    const elsewhere = parse(
      await callText(await client(opts), 'create_task', { title: 'Do it', teamId: 'B' }),
    )
    expect(elsewhere.id).not.toBe(first.id)
  })

  it.each([
    ['an OpenClaw session', { unverifiedCaller: true }],
    ['a teammate with no bound task', { boundScope: { teamId: 'A', agentId: 'teammate' } }],
  ] as Array<[string, TasksServerOptions]>)(
    "a finished task does not swallow %s's new create",
    async (_who, opts) => {
      const c = await client(opts)
      const monday = parse(
        await callText(c, 'create_task', { title: 'Weekly digest', teamId: 'A' }),
      )
      updateStatus(db, monday.id, 'in_progress')
      expect(updateStatus(db, monday.id, 'done').ok).toBe(true)
      const tuesday = parse(
        await callText(c, 'create_task', { title: 'Weekly digest', teamId: 'A' }),
      )
      expect(tuesday.id).not.toBe(monday.id)
      expect(tuesday.deduplicated).toBeUndefined()
      const cancelled = parse(await callText(c, 'create_task', { title: 'One-off', teamId: 'A' }))
      expect(updateStatus(db, cancelled.id, 'cancelled').ok).toBe(true)
      const next = parse(await callText(c, 'create_task', { title: 'One-off', teamId: 'A' }))
      expect(next.id).not.toBe(cancelled.id)
    },
  )

  it("a key one agent chose does not return another agent's task", async () => {
    const a = await client(boundToA(undefined, 'agent-a'))
    const b = await client(boundToA(undefined, 'agent-b'))
    const mine = parse(
      await callText(a, 'create_task', { title: 'Write docs', idempotencyKey: 'subtask-1' }),
    )
    updateStatus(db, mine.id, 'in_progress')
    expect(updateStatus(db, mine.id, 'done').ok).toBe(true)
    const theirs = parse(
      await callText(b, 'create_task', { title: 'Fix login', idempotencyKey: 'subtask-1' }),
    )
    expect(theirs.id).not.toBe(mine.id)
    expect(theirs.title).toBe('Fix login')
    const sameWords = parse(
      await callText(b, 'create_task', { title: 'Write docs', idempotencyKey: 'subtask-1' }),
    )
    expect(sameWords.id).not.toBe(mine.id)
  })

  it('one key with other words is another create, and under another parent too', async () => {
    const p1 = createTask(db, { title: 'p1', teamId: 'A' })
    const p2 = createTask(db, { title: 'p2', teamId: 'A' })
    const c = await client(boundToA(undefined, 'agent-a'))
    const first = parse(
      await callText(c, 'create_subtask', {
        title: 'One',
        parentTaskId: p1.id,
        idempotencyKey: 'k',
      }),
    )
    const words = parse(
      await callText(c, 'create_subtask', {
        title: 'Two',
        parentTaskId: p1.id,
        idempotencyKey: 'k',
      }),
    )
    const parent = parse(
      await callText(c, 'create_subtask', {
        title: 'One',
        parentTaskId: p2.id,
        idempotencyKey: 'k',
      }),
    )
    expect(new Set([first.id, words.id, parent.id]).size).toBe(3)
  })

  it('a key on a task bound run holds for that task, whatever became of the sub-task', async () => {
    const parent = createTask(db, { title: 'parent', teamId: 'A' })
    const c = await client(boundToA(parent.id))
    const args = { title: 'Once', parentTaskId: parent.id, idempotencyKey: 'k' }
    const first = parse(await callText(c, 'create_subtask', args))
    updateStatus(db, first.id, 'blocked')
    const again = parse(await callText(c, 'create_subtask', args))
    expect(again.id).toBe(first.id)
    expect(again.deduplicatedBy).toBe('key')
  })
})

describe('same-title dedupe on the create tools', () => {
  it('an agent passing a fresh key each time still gets the one open task', async () => {
    const c = await client(boundToA())
    const a = parse(await callText(c, 'create_task', { title: 'Fix it', idempotencyKey: '1' }))
    const b = parse(await callText(c, 'create_task', { title: 'fix it', idempotencyKey: '2' }))
    expect(b.id).toBe(a.id)
    expect(b.deduplicatedBy).toBe('title')
  })

  it('says so in the tool result, naming the task, and gives no way around it', async () => {
    const c = await client(boundToA())
    await callText(c, 'create_task', { title: 'Fix it', idempotencyKey: '1' })
    const again = parse(await callText(c, 'create_task', { title: 'Fix it', idempotencyKey: '2' }))
    expect(again.note).toContain('ALP-1')
    expect(again.note).toMatch(/already/)
    expect(again.note).not.toMatch(/rename|different title|another title|new key|reword/i)
  })

  it('the tool description tells the agent up front', async () => {
    const c = await client(boundToA())
    const { tools } = await c.listTools()
    const description = tools.find((t) => t.name === 'create_task')?.description ?? ''
    expect(description).toMatch(/deduplicated/)
    expect(description).toMatch(/48 hours/)
  })

  it("is not fooled by a person's task, which it still returns to the agent", async () => {
    const mine = createTask(db, { title: 'Fix it', teamId: 'A' })
    const c = await client(boundToA())
    expect(parse(await callText(c, 'create_task', { title: 'fix it' })).id).toBe(mine.id)
  })
})

describe('the Urgent rule', () => {
  it('an agent cannot set Urgent through create_task: it stops at High', async () => {
    const c = await client(boundToA())
    expect(parse(await callText(c, 'create_task', { title: 'a', priority: 2 })).priority).toBe(1)
    expect(parse(await callText(c, 'create_task', { title: 'b', priority: 1 })).priority).toBe(1)
    expect(parse(await callText(c, 'create_task', { title: 'c', priority: -1 })).priority).toBe(-1)
    expect(parse(await callText(c, 'create_task', { title: 'd' })).priority).toBe(0)
  })

  it('the tool description does not offer Urgent', async () => {
    const { tools } = await (await client(boundToA())).listTools()
    const description = tools.find((t) => t.name === 'create_task')?.description ?? ''
    expect(description).not.toMatch(/2 urgent/)
    expect(description).toMatch(/only a person/i)
  })
})

describe('the cycle guard on assign_task', () => {
  const asAgent = (agentId: string, opts: Partial<TasksServerOptions> = {}) =>
    client({ boundScope: { teamId: 'A', agentId }, ...opts })

  it('A to B to A is refused', async () => {
    const a = await asAgent('a')
    const t1 = parse(await callText(a, 'create_task', { title: 'for B' }))
    expect(
      (await callText(a, 'assign_task', { taskId: t1.id, assigneeAgentId: 'b' })).isError,
    ).toBe(false)

    const b = await asAgent('b')
    const t2 = parse(
      await callText(b, 'create_subtask', { title: 'back to A', parentTaskId: t1.id }),
    )
    const refused = await callText(b, 'assign_task', { taskId: t2.id, assigneeAgentId: 'a' })
    expect(refused.isError).toBe(true)
    expect(refused.text).toMatch(/back to/i)
    expect(getTask(db, t2.id)?.assigneeAgentId).toBeNull()
  })

  it('A to B to C to A is refused, and to someone new is not', async () => {
    const a = await asAgent('a')
    const t1 = parse(await callText(a, 'create_task', { title: 't1' }))
    await callText(a, 'assign_task', { taskId: t1.id, assigneeAgentId: 'b' })
    const b = await asAgent('b')
    const t2 = parse(await callText(b, 'create_subtask', { title: 't2', parentTaskId: t1.id }))
    await callText(b, 'assign_task', { taskId: t2.id, assigneeAgentId: 'c' })
    const c = await asAgent('c')
    const t3 = parse(await callText(c, 'create_subtask', { title: 't3', parentTaskId: t2.id }))
    expect(
      (await callText(c, 'assign_task', { taskId: t3.id, assigneeAgentId: 'a' })).isError,
    ).toBe(true)
    expect(
      (await callText(c, 'assign_task', { taskId: t3.id, assigneeAgentId: 'd' })).isError,
    ).toBe(false)
  })

  it('a hand-off to the team lead is an escalation, and goes through', async () => {
    addTeam('L', 'Led', 'lead')
    const lead = await client({ boundScope: { teamId: 'L', agentId: 'lead' } })
    const t1 = parse(await callText(lead, 'create_task', { title: 't1' }))
    await callText(lead, 'assign_task', { taskId: t1.id, assigneeAgentId: 'b' })
    const b = await client({ boundScope: { teamId: 'L', agentId: 'b' } })
    const t2 = parse(await callText(b, 'create_subtask', { title: 'help', parentTaskId: t1.id }))
    expect(
      (await callText(b, 'assign_task', { taskId: t2.id, assigneeAgentId: 'lead' })).isError,
    ).toBe(false)
  })

  it('the host can name more leads, as Boo Zero leads every team', async () => {
    const opts = { isLeadAgent: (_t: string | null, id: string) => id === 'bz' }
    const bz = await asAgent('bz', opts)
    const t1 = parse(await callText(bz, 'create_task', { title: 't1' }))
    await callText(bz, 'assign_task', { taskId: t1.id, assigneeAgentId: 'b' })
    const b = await asAgent('b', opts)
    const t2 = parse(await callText(b, 'create_subtask', { title: 'help', parentTaskId: t1.id }))
    expect(
      (await callText(b, 'assign_task', { taskId: t2.id, assigneeAgentId: 'bz' })).isError,
    ).toBe(false)
  })

  it('a finished ancestor no longer holds anyone', async () => {
    const a = await asAgent('a')
    const t1 = parse(await callText(a, 'create_task', { title: 't1' }))
    await callText(a, 'assign_task', { taskId: t1.id, assigneeAgentId: 'b' })
    const b = await asAgent('b')
    const t2 = parse(await callText(b, 'create_subtask', { title: 't2', parentTaskId: t1.id }))
    expect(updateStatus(db, t1.id, 'done').ok).toBe(true)
    expect(
      (await callText(b, 'assign_task', { taskId: t2.id, assigneeAgentId: 'a' })).isError,
    ).toBe(false)
  })

  it('assigning to yourself is not a hand-off', async () => {
    const a = await asAgent('a')
    const t1 = parse(await callText(a, 'create_task', { title: 't1' }))
    expect(
      (await callText(a, 'assign_task', { taskId: t1.id, assigneeAgentId: 'a' })).isError,
    ).toBe(false)
  })
})

describe('the child cap message', () => {
  it('says only a person can free a slot, not that the agent can drop one', async () => {
    const parent = createTask(db, { title: 'p', teamId: 'A' })
    const c = await client(boundToA())
    for (let i = 0; i < 24; i += 1) {
      await callText(c, 'create_subtask', { title: `c${i}`, parentTaskId: parent.id })
    }
    const refused = await callText(c, 'create_subtask', {
      title: 'one more',
      parentTaskId: parent.id,
    })
    expect(refused.isError).toBe(true)
    expect(refused.text).toMatch(/person/)
    expect(refused.text).not.toMatch(/drop one/)
  })
})
