// Who did it: every write the Tasks tools make records its actor. A session clawboo
// bound to an agent records that agent and its run; any other caller records that
// nothing says who it was.

import {
  claimTask,
  createDb,
  createExecutionProcess,
  createTask,
  getComments,
  listEvents,
  listTaskQuestions,
  listWaitingTaskWakes,
  updateStatus,
  type ClawbooDb,
} from '@clawboo/db'
import { beforeEach, describe, expect, it } from 'vitest'

import { createTasksServer } from '../tasks/server'
import { callText, connectInMemory } from '../testing'

let db: ClawbooDb

beforeEach(() => {
  db = createDb(':memory:')
})

const TEAM = 'team-A'
const AGENT = { kind: 'agent', agentId: 'coder', execId: 'exec-1' }
const bound = { teamId: TEAM, agentId: 'coder', executionId: 'exec-1' }

/** The events of one kind, with their data read back. */
function events(kind: string): Array<{ taskId: string | null; data: Record<string, unknown> }> {
  return listEvents(db, { limit: 1000 })
    .filter((e) => e.kind === kind)
    .map((e) => ({ taskId: e.taskId, data: JSON.parse(e.data) as Record<string, unknown> }))
}

const boundClient = () => connectInMemory(createTasksServer(db, { boundScope: bound }))
const teamRunClient = (taskId: string) =>
  connectInMemory(createTasksServer(db, { boundScope: { ...bound, taskId }, teamRun: true }))

describe('a bound session records its agent and its run', () => {
  it('on create_task and create_subtask', async () => {
    const client = await boundClient()
    const parent = JSON.parse((await callText(client, 'create_task', { title: 'P' })).text) as {
      id: string
    }
    await callText(client, 'create_subtask', { parentTaskId: parent.id, title: 'C' })
    const created = events('task_created')
    expect(created.map((e) => e.data['title']).sort()).toEqual(['C', 'P'])
    for (const e of created) expect(e.data['actor']).toEqual(AGENT)
  })

  it('on claim_task and assign_task, naming who acted and not only who got it', async () => {
    const mine = createTask(db, { title: 'mine', teamId: TEAM })
    const theirs = createTask(db, { title: 'theirs', teamId: TEAM })
    const client = await boundClient()
    await callText(client, 'claim_task', { taskId: mine.id })
    await callText(client, 'assign_task', { taskId: theirs.id, assigneeAgentId: 'reviewer' })
    const claims = events('task_claimed')
    expect(claims.find((e) => e.taskId === mine.id)?.data).toMatchObject({
      assigneeAgentId: 'coder',
      actor: AGENT,
    })
    expect(claims.find((e) => e.taskId === theirs.id)?.data).toMatchObject({
      assigneeAgentId: 'reviewer',
      actor: AGENT,
    })
  })

  it('on a claim that lost: nothing happened, so nothing is recorded', async () => {
    const task = createTask(db, { title: 'taken', teamId: TEAM })
    claimTask(db, task.id, 'someone-else')
    const client = await boundClient()
    await callText(client, 'claim_task', { taskId: task.id })
    expect(events('task_claimed')).toEqual([])
  })

  it('on update_task_status, block_task, unblock_task and release_task', async () => {
    const task = createTask(db, { title: 'moved', teamId: TEAM })
    claimTask(db, task.id, 'coder')
    const client = await boundClient()
    await callText(client, 'block_task', { taskId: task.id, waitingOn: 'person', need: 'Decide.' })
    await callText(client, 'unblock_task', { taskId: task.id })
    claimTask(db, task.id, 'coder')
    await callText(client, 'release_task', { taskId: task.id })
    claimTask(db, task.id, 'coder')
    await callText(client, 'update_task_status', { taskId: task.id, status: 'done' })
    const moves = events('status_changed')
    expect(moves.map((e) => e.data['to'])).toEqual(['blocked', 'todo', 'todo', 'done'])
    for (const e of moves) expect(e.data['actor']).toEqual(AGENT)
  })

  it('on a status write the board refused: nothing is recorded', async () => {
    const task = createTask(db, { title: 'illegal', teamId: TEAM, status: 'backlog' })
    const client = await boundClient()
    await callText(client, 'update_task_status', { taskId: task.id, status: 'done' })
    expect(events('status_changed')).toEqual([])
  })

  it('on a comment that saves a teammate’s wake: the comment says who, the wake does not', async () => {
    const theirs = createTask(db, { title: 'theirs', teamId: TEAM })
    claimTask(db, theirs.id, 'reviewer')
    updateStatus(db, theirs.id, 'blocked', {
      waitingOn: { kind: 'person', need: 'A key', by: 'agent' },
    })
    const client = await boundClient()
    const res = await callText(client, 'add_comment', { taskId: theirs.id, body: 'Here it is' })
    const reply = JSON.parse(res.text) as { id: string; wake?: { state: string } }
    expect(reply.wake?.state).toBe('saved')
    expect(getComments(db, theirs.id)[0]).toMatchObject({
      id: reply.id,
      kind: 'agent',
      authorAgentId: 'coder',
      executionId: 'exec-1',
    })
    expect(events('comment_added')[0]?.data['actor']).toEqual(AGENT)
    const [wake] = listWaitingTaskWakes(db, { taskId: theirs.id })
    expect(wake).toMatchObject({ reason: 'agent_comment', agentId: 'reviewer' })
  })

  it('on add_comment, on the row and in the log', async () => {
    const task = createTask(db, { title: 'noted', teamId: TEAM })
    const client = await boundClient()
    await callText(client, 'add_comment', { taskId: task.id, body: 'hello' })
    const [comment] = getComments(db, task.id)
    expect(comment).toMatchObject({
      authorType: 'agent',
      authorAgentId: 'coder',
      executionId: 'exec-1',
    })
    expect(events('comment_added')[0]?.data).toMatchObject({ body: 'hello', actor: AGENT })
  })

  it('on link_task', async () => {
    const a = createTask(db, { title: 'a', teamId: TEAM })
    const b = createTask(db, { title: 'b', teamId: TEAM })
    const client = await boundClient()
    await callText(client, 'link_task', { taskId: a.id, dependsOnTaskId: b.id })
    expect(events('dep_linked')[0]).toMatchObject({
      taskId: a.id,
      data: { dependsOnTaskId: b.id, actor: AGENT },
    })
  })

  it('on ask_person, on the question and in the log', async () => {
    const task = createTask(db, { title: 'asks', teamId: TEAM })
    claimTask(db, task.id, 'coder')
    const client = await teamRunClient(task.id)
    await callText(client, 'ask_person', { kind: 'question', question: 'Which one?' })
    expect(listTaskQuestions(db, task.id)[0]?.executionId).toBe('exec-1')
    expect(events('status_changed').at(-1)).toMatchObject({
      taskId: task.id,
      data: { to: 'blocked', reason: 'question', actor: AGENT },
    })
  })

  it('on hand_back_task', async () => {
    const task = createTask(db, { title: 'hands back', teamId: TEAM })
    claimTask(db, task.id, 'coder')
    const client = await teamRunClient(task.id)
    await callText(client, 'hand_back_task', { need: 'Sign the form.' })
    expect(events('status_changed').at(-1)).toMatchObject({
      taskId: task.id,
      data: { to: 'blocked', reason: 'handed_back', actor: AGENT },
    })
  })

  it('on report_result, in the log: who said it and on which run, and none of its words', async () => {
    const task = createTask(db, { title: 'reported', teamId: TEAM, status: 'todo' })
    const execId = claimTask(db, task.id, 'coder', 'codex', { run: { executorType: 'openclaw' } })
      .execution!.id
    const client = await connectInMemory(
      createTasksServer(db, {
        boundScope: { teamId: TEAM, agentId: 'coder', taskId: task.id, executionId: execId },
        teamRun: true,
      }),
    )
    const res = await callText(client, 'report_result', {
      outcome: 'not_done',
      summary: 'The words stay on the run.',
    })
    expect(res.isError).toBe(false)
    const [report] = events('status_changed')
    expect(report?.taskId).toBe(task.id)
    expect(report?.data).toMatchObject({
      to: 'in_progress',
      reason: 'result_reported',
      outcome: 'not_done',
      actor: { kind: 'agent', agentId: 'coder', execId },
    })
    expect(JSON.stringify(report?.data)).not.toContain('The words stay')
  })

  it('on a report the board refused: nothing is recorded', async () => {
    const task = createTask(db, { title: 'theirs', teamId: TEAM, status: 'todo' })
    claimTask(db, task.id, 'someone-else')
    const res = await callText(await teamRunClient(task.id), 'report_result', {
      outcome: 'done',
      summary: 'Not mine.',
    })
    expect(res.isError).toBe(true)
    expect(events('status_changed')).toEqual([])
  })

  it('records the run the URL named, whatever execution row the task has', async () => {
    const task = createTask(db, { title: 't', teamId: TEAM })
    createExecutionProcess(db, { taskId: task.id, executorType: 'codex' })
    const client = await boundClient()
    await callText(client, 'add_comment', { taskId: task.id, body: 'x' })
    expect(getComments(db, task.id)[0]?.executionId).toBe('exec-1')
  })
})

describe('a bound session with no run', () => {
  it('records the agent and says it has no run (a lead turn, a 1:1 chat)', async () => {
    const task = createTask(db, { title: 't', teamId: TEAM })
    const client = await connectInMemory(
      createTasksServer(db, { boundScope: { teamId: TEAM, agentId: 'coder' } }),
    )
    await callText(client, 'add_comment', { taskId: task.id, body: 'x' })
    expect(getComments(db, task.id)[0]?.executionId).toBeNull()
    expect(events('comment_added')[0]?.data['actor']).toEqual({
      kind: 'agent',
      agentId: 'coder',
      execId: null,
    })
  })
})

describe('a caller with no verified identity', () => {
  it('records no agent on an OpenClaw session, whatever it claims', async () => {
    const task = createTask(db, { title: 't' })
    const client = await connectInMemory(createTasksServer(db, { unverifiedCaller: true }))
    await callText(client, 'add_comment', {
      taskId: task.id,
      body: 'as someone else',
      authorAgentId: 'victim',
    })
    expect(getComments(db, task.id)[0]).toMatchObject({
      authorAgentId: null,
      executionId: null,
    })
    expect(events('comment_added')[0]?.data['actor']).toEqual({ kind: 'caller' })
  })

  it('records the same for the stdio bin, whose caller names no one the server can check', async () => {
    const client = await connectInMemory(createTasksServer(db))
    await callText(client, 'create_task', { title: 'from the bin' })
    expect(events('task_created')[0]?.data['actor']).toEqual({ kind: 'caller' })
  })
})
