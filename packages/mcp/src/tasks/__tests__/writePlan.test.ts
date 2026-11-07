// The plan document tool, and a proposed breakdown on a team that asks first.

import {
  answerQuestion,
  claimTask,
  createDb,
  createTask,
  getTask,
  getTaskDocument,
  listTaskDocumentRevisions,
  listTaskQuestions,
  listTasks,
  LOCAL_PERSON,
  parseQuestionPayload,
  planApprovalSettingKey,
  setSetting,
  updateStatus,
  type ClawbooDb,
} from '@clawboo/db'
import { beforeEach, describe, expect, it } from 'vitest'

import { callText, connectInMemory, listToolNames } from '../../testing'
import { createTasksServer, type TasksServerOptions } from '../server'

let db: ClawbooDb
beforeEach(() => {
  db = createDb(':memory:')
})

function claimedBy(agentId: string, extra: { scheduledBy?: string } = {}): string {
  const t = createTask(db, { title: 'Ship it', teamId: 'A', status: 'todo', ...extra })
  expect(claimTask(db, t.id, agentId).ok).toBe(true)
  return t.id
}

const teamRun = (taskId: string): TasksServerOptions => ({
  boundScope: { teamId: 'A', agentId: 'coder', taskId },
  teamRun: true,
})

const connect = (opts?: TasksServerOptions) => connectInMemory(createTasksServer(db, opts))

describe('write_plan', () => {
  it('writes a revision on the run’s task, and a newer one keeps the older readable', async () => {
    const id = claimedBy('coder')
    const client = await connect(teamRun(id))
    const first = await callText(client, 'write_plan', { body: 'First idea' })
    expect(first.isError).toBeFalsy()
    expect(first.text).toMatch(/revision 1/)
    await callText(client, 'write_plan', { body: 'Better idea' })
    expect(getTaskDocument(db, id, 'plan')?.body).toBe('Better idea')
    expect(getTaskDocument(db, id, 'plan', 1)?.body).toBe('First idea')
    expect(listTaskDocumentRevisions(db, id, 'plan')).toHaveLength(2)
  })

  it('is served to a read-only Native team run too', async () => {
    const id = claimedBy('coder')
    const names = await listToolNames(await connect({ ...teamRun(id), readOnly: true }))
    expect(names).toContain('write_plan')
    expect(names).not.toContain('create_task')
  })

  it('is not served without a bound task or a bound agent', async () => {
    const id = claimedBy('coder')
    for (const opts of [
      {},
      { boundScope: { teamId: 'A', agentId: 'coder' }, teamRun: true },
      { boundScope: { teamId: 'A', taskId: id }, teamRun: true },
    ] as TasksServerOptions[]) {
      const client = await connect(opts)
      expect(await listToolNames(client)).not.toContain('write_plan')
      const res = await callText(client, 'write_plan', { body: 'Sneaky' })
      expect(res.isError).toBe(true)
    }
    expect(getTaskDocument(db, id, 'plan')).toBeNull()
  })

  it('is refused for an unverified caller, whatever else it claims', async () => {
    const id = claimedBy('coder')
    const client = await connect({ ...teamRun(id), unverifiedCaller: true })
    expect(await listToolNames(client)).not.toContain('write_plan')
    expect((await callText(client, 'write_plan', { body: 'Sneaky' })).isError).toBe(true)
    expect(getTaskDocument(db, id, 'plan')).toBeNull()
  })

  it('writes to the bound task only: the arguments cannot name another', async () => {
    const mine = claimedBy('coder')
    const other = claimedBy('coder')
    const client = await connect(teamRun(mine))
    await callText(client, 'write_plan', { body: 'Mine', taskId: other })
    expect(getTaskDocument(db, other, 'plan')).toBeNull()
    expect(getTaskDocument(db, mine, 'plan')?.body).toBe('Mine')
  })

  it('refuses a task the bound agent is not on', async () => {
    const id = claimedBy('someone-else')
    const res = await callText(await connect(teamRun(id)), 'write_plan', { body: 'Mine' })
    expect(res.isError).toBe(true)
    expect(res.text).toMatch(/not working on/)
    expect(getTaskDocument(db, id, 'plan')).toBeNull()
  })

  it('refuses a body over the limit, saying how much fits', async () => {
    const id = claimedBy('coder')
    const res = await callText(await connect(teamRun(id)), 'write_plan', {
      body: 'x'.repeat(32_001),
    })
    expect(res.isError).toBe(true)
    expect(res.text).toMatch(/32,?000/)
    expect(getTaskDocument(db, id, 'plan')).toBeNull()
  })

  it('refuses a finished task', async () => {
    const id = claimedBy('coder')
    const client = await connect(teamRun(id))
    updateStatus(db, id, 'done')
    expect((await callText(client, 'write_plan', { body: 'Late' })).isError).toBe(true)
  })

  it('get_task returns the newest plan, which is where a cut one in the ticket says to look', async () => {
    const id = claimedBy('coder')
    const client = await connect(teamRun(id))
    await callText(client, 'write_plan', { body: 'The plan' })
    const got = JSON.parse((await callText(client, 'get_task', {})).text) as {
      plan?: { revision: number; body: string }
    }
    expect(got.plan).toMatchObject({ revision: 1, body: 'The plan' })
  })
})

describe('a proposed breakdown', () => {
  const ask = (client: Awaited<ReturnType<typeof connect>>) =>
    callText(client, 'ask_person', {
      kind: 'suggest_tasks',
      question: 'Split it like this?',
      tasks: ['Part one', 'Part two'],
    })

  it('switch off: stays a question whose acceptance creates nothing', async () => {
    const id = claimedBy('coder')
    const client = await connect(teamRun(id))
    expect((await ask(client)).isError).toBeFalsy()
    const q = listTaskQuestions(db, id)[0]!
    expect(parseQuestionPayload(q.payload)?.plan).toBeUndefined()
    const a = answerQuestion(db, q.id, { accepted: true }, { person: LOCAL_PERSON })
    expect(a.ok && a.created).toBeFalsy()
    expect(listTasks(db, { teamId: 'A' })).toHaveLength(1)
  })

  it('switch on: its acceptance creates the tasks, for the agent that proposed them', async () => {
    setSetting(db, planApprovalSettingKey('A'), JSON.stringify({ on: true }))
    const id = claimedBy('coder')
    const client = await connect(teamRun(id))
    const res = await ask(client)
    expect(res.isError).toBeFalsy()
    expect(res.text).toMatch(/created for you/)
    expect(getTask(db, id)?.status).toBe('blocked')
    const q = listTaskQuestions(db, id)[0]!
    expect(parseQuestionPayload(q.payload)?.plan?.holder).toBe(false)
    const a = answerQuestion(db, q.id, { accepted: true }, { person: LOCAL_PERSON })
    if (!a.ok) throw new Error(a.reason)
    expect(a.created?.map((t) => t.title)).toEqual(['Part one', 'Part two'])
    expect(a.created?.every((t) => t.parentTaskId === id)).toBe(true)
    expect(a.created?.[0]?.sourceDelegationId).toContain(':agent:coder:reflectTo:coder')
  })

  it('switch on: the same breakdown asked again stacks nothing', async () => {
    setSetting(db, planApprovalSettingKey('A'), JSON.stringify({ on: true }))
    const id = claimedBy('coder')
    const client = await connect(teamRun(id))
    await ask(client)
    const again = await ask(client)
    expect(again.isError).toBeFalsy()
    expect(again.text).toMatch(/already/)
    expect(listTaskQuestions(db, id)).toHaveLength(1)
  })

  it('switch on: a routine’s task is refused as any ask is, with no card of its own', async () => {
    setSetting(db, planApprovalSettingKey('A'), JSON.stringify({ on: true }))
    const id = claimedBy('coder', { scheduledBy: 'clawboo' })
    const res = await ask(await connect(teamRun(id)))
    expect(res.isError).toBe(true)
    expect(listTasks(db, { teamId: 'A' })).toHaveLength(1)
  })
})
