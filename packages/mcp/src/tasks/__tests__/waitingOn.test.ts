// What an agent must say when its task waits, the question and hand-back tools, and
// the person's task an agent cannot take.

import {
  addComment,
  answerQuestion,
  askQuestion,
  assignTaskToPerson,
  claimTask,
  createDb,
  createSubtask,
  createTask,
  decideAgentWakes,
  getTask,
  linkDep,
  listTaskQuestions,
  listWaitingTaskWakes,
  LOCAL_PERSON,
  openAgentWakeCard,
  saveAgentCommentWake,
  parseWaitingOn,
  updateStatus,
  wakeCommentIds,
  type ClawbooDb,
} from '@clawboo/db'
import { beforeEach, describe, expect, it } from 'vitest'

import { callText, connectInMemory, listToolNames } from '../../testing'
import { createTasksServer, type TasksServerOptions } from '../server'

let db: ClawbooDb
beforeEach(() => {
  db = createDb(':memory:')
})

/** A task the engine handed to `agentId` and claimed for it. */
function claimedBy(agentId: string, extra: { scheduledBy?: string } = {}): string {
  const t = createTask(db, { title: 'Write the parser', teamId: 'A', status: 'todo', ...extra })
  expect(claimTask(db, t.id, agentId).ok).toBe(true)
  return t.id
}

const teamRun = (taskId: string): TasksServerOptions => ({
  boundScope: { teamId: 'A', agentId: 'coder', taskId },
  teamRun: true,
})

const connect = (opts?: TasksServerOptions) => connectInMemory(createTasksServer(db, opts))

describe('block_task needs a reason', () => {
  it('is refused without one, with words the model can act on, and moves nothing', async () => {
    const id = claimedBy('coder')
    const client = await connect(teamRun(id))
    const res = await callText(client, 'block_task', {})
    expect(res.isError).toBe(true)
    expect(res.text).toMatch(/waitingOn/)
    expect(res.text).toMatch(/need/)
    expect(getTask(db, id)?.status).toBe('in_progress')
  })

  it('advertises the reason as required', async () => {
    const id = claimedBy('coder')
    const client = await connect(teamRun(id))
    const tools = (await client.listTools()).tools
    const block = tools.find((t) => t.name === 'block_task')
    expect((block?.inputSchema as { required?: string[] }).required).toContain('waitingOn')
  })

  it('a person reason says what the person must do', async () => {
    const id = claimedBy('coder')
    const client = await connect(teamRun(id))
    const res = await callText(client, 'block_task', {
      waitingOn: 'person',
      need: 'Choose the database',
    })
    expect(res.isError).toBe(false)
    expect(getTask(db, id)?.status).toBe('blocked')
    expect(parseWaitingOn(getTask(db, id)?.waitingOn)).toEqual({
      kind: 'person',
      need: 'Choose the database',
      by: 'agent',
    })
    // And it must say it.
    const blank = claimedBy('coder')
    const res2 = await callText(await connect(teamRun(blank)), 'block_task', {
      waitingOn: 'person',
    })
    expect(res2.isError).toBe(true)
  })

  it('waits on another task on its team, and refuses one that cannot end the wait', async () => {
    const id = claimedBy('coder')
    const other = createTask(db, { title: 'Schema', teamId: 'A', status: 'todo' })
    const foreign = createTask(db, { title: 'Theirs', teamId: 'B', status: 'todo' })
    const done = createTask(db, { title: 'Old', teamId: 'A', status: 'todo' })
    claimTask(db, done.id, 'x')
    updateStatus(db, done.id, 'done')
    const client = await connect(teamRun(id))

    for (const bad of [id, foreign.id, done.id, 'nope']) {
      const res = await callText(client, 'block_task', { waitingOn: 'task', waitingOnTaskId: bad })
      expect(res.isError, bad).toBe(true)
    }
    expect(getTask(db, id)?.status).toBe('in_progress')

    const res = await callText(client, 'block_task', {
      waitingOn: 'task',
      waitingOnTaskId: other.id,
    })
    expect(res.isError).toBe(false)
    expect(parseWaitingOn(getTask(db, id)?.waitingOn)).toEqual({ kind: 'task', taskId: other.id })
  })

  it('refuses a wait that would never end: two tasks waiting on each other', async () => {
    const mine = claimedBy('coder')
    const theirs = claimedBy('tester')
    updateStatus(db, theirs, 'blocked', { waitingOn: { kind: 'task', taskId: mine } })
    const res = await callText(await connect(teamRun(mine)), 'block_task', {
      waitingOn: 'task',
      waitingOnTaskId: theirs,
    })
    expect(res.isError).toBe(true)
    expect(res.text).toMatch(/each other/)
  })

  it('waits on its own sub-tasks only when it has some open', async () => {
    const id = claimedBy('coder')
    const client = await connect(teamRun(id))
    expect((await callText(client, 'block_task', { waitingOn: 'subtasks' })).isError).toBe(true)
    createSubtask(db, id, { title: 'part', status: 'todo' })
    expect((await callText(client, 'block_task', { waitingOn: 'subtasks' })).isError).toBe(false)
    expect(parseWaitingOn(getTask(db, id)?.waitingOn)).toEqual({ kind: 'subtasks' })
  })
})

describe('the other ways an agent enters a waiting status need a reason too', () => {
  it('update_task_status to Blocked or In review', async () => {
    const id = claimedBy('coder')
    const client = await connect() // the operator's own stdio bin
    for (const status of ['blocked', 'in_review']) {
      const res = await callText(client, 'update_task_status', { taskId: id, status })
      expect(res.isError, status).toBe(true)
      expect(res.text).toMatch(/waitingOn/)
    }
    expect(getTask(db, id)?.status).toBe('in_progress')
    const ok = await callText(client, 'update_task_status', {
      taskId: id,
      status: 'in_review',
      waitingOn: 'person',
      need: 'Read the diff',
    })
    expect(ok.isError).toBe(false)
    expect(getTask(db, id)?.status).toBe('in_review')
    // Other moves need none.
    expect(
      (await callText(client, 'update_task_status', { taskId: id, status: 'done' })).isError,
    ).toBe(false)
  })

  it('create_task straight into Blocked', async () => {
    const client = await connect(teamRun(claimedBy('coder')))
    const bare = await callText(client, 'create_task', { title: 'x', status: 'blocked' })
    expect(bare.isError).toBe(true)
    const ok = await callText(client, 'create_task', {
      title: 'y',
      status: 'blocked',
      waitingOn: 'person',
      need: 'A login for the staging site',
    })
    expect(ok.isError).toBe(false)
    const created = JSON.parse(ok.text) as { id: string }
    expect(parseWaitingOn(getTask(db, created.id)?.waitingOn)).toMatchObject({ kind: 'person' })
  })
})

describe('In review waits only on a person', () => {
  it('refuses a wait on other work, which nothing would ever end there', async () => {
    const id = claimedBy('coder')
    const other = createTask(db, { title: 'Schema', teamId: 'A', status: 'todo' })
    createSubtask(db, id, { title: 'part', status: 'todo' })
    const client = await connect()
    for (const args of [
      { waitingOn: 'task', waitingOnTaskId: other.id },
      { waitingOn: 'subtasks' },
    ]) {
      const res = await callText(client, 'update_task_status', {
        taskId: id,
        status: 'in_review',
        ...args,
      })
      expect(res.isError, args.waitingOn).toBe(true)
      expect(res.text).toMatch(/blocked/)
    }
    expect(getTask(db, id)?.status).toBe('in_progress')
    // Blocked takes the same reasons, and it is what ends the wait.
    const blocked = await callText(client, 'update_task_status', {
      taskId: id,
      status: 'blocked',
      waitingOn: 'subtasks',
    })
    expect(blocked.isError).toBe(false)
  })
})

describe('ask_person', () => {
  it('is served on a team run with a bound task, and to a Native team run that only reads', async () => {
    const id = claimedBy('coder')
    expect(await listToolNames(await connect(teamRun(id)))).toContain('ask_person')
    expect(await listToolNames(await connect({ ...teamRun(id), readOnly: true }))).toEqual(
      expect.arrayContaining(['list_tasks', 'get_task', 'ask_person']),
    )
    expect(await listToolNames(await connect({ ...teamRun(id), readOnly: true }))).toHaveLength(3)
  })

  it('is not served where nothing could wake the asker', async () => {
    expect(await listToolNames(await connect())).not.toContain('ask_person')
    expect(await listToolNames(await connect({ unverifiedCaller: true }))).not.toContain(
      'ask_person',
    )
    expect(
      await listToolNames(
        await connect({ boundScope: { teamId: 'A', agentId: 'coder' }, teamRun: true }),
      ),
    ).not.toContain('ask_person')
  })

  it('blocks the bound task with the question, and tells the agent to stop', async () => {
    const id = claimedBy('coder')
    const client = await connect(teamRun(id))
    const res = await callText(client, 'ask_person', {
      kind: 'question',
      question: 'Which colour for the button?',
      options: ['Red', 'Blue'],
    })
    expect(res.isError).toBe(false)
    expect(res.text).toMatch(/stop/i)
    const [q] = listTaskQuestions(db, id)
    expect(q?.status).toBe('pending')
    expect(q?.agentId).toBe('coder')
    expect(getTask(db, id)?.status).toBe('blocked')
    expect(parseWaitingOn(getTask(db, id)?.waitingOn)).toEqual({
      kind: 'question',
      questionId: q?.id,
    })
  })

  it('refuses a question about any other task', async () => {
    const id = claimedBy('coder')
    const other = claimedBy('coder')
    const res = await callText(await connect(teamRun(id)), 'ask_person', {
      taskId: other,
      kind: 'confirm',
      question: 'Go?',
    })
    expect(res.isError).toBe(true)
    expect(listTaskQuestions(db, other)).toHaveLength(0)
  })

  it('says what a repeated key really means, by where the question stands', async () => {
    const id = claimedBy('coder')
    const client = await connect(teamRun(id))
    const ask = () =>
      callText(client, 'ask_person', {
        kind: 'question',
        question: 'Which colour?',
        options: ['Red', 'Blue'],
        idempotencyKey: 'k1',
      })
    expect((await ask()).text).toMatch(/stop here/i)

    // Still open: it still waits, and the agent is told so.
    const again = await ask()
    expect(again.text).toMatch(/already asked/i)
    expect(again.text).toMatch(/stop here/i)

    // Answered and running again: never "stop", and the answer is there.
    const [q] = listTaskQuestions(db, id)
    expect(answerQuestion(db, q!.id, { choice: 'Blue' }, { person: LOCAL_PERSON }).ok).toBe(true)
    updateStatus(db, id, 'todo')
    claimTask(db, id, 'coder')
    const answered = await ask()
    expect(answered.isError).toBe(false)
    expect(answered.text).not.toMatch(/stop here/i)
    expect(answered.text).toContain('Blue')
    expect(getTask(db, id)?.status).toBe('in_progress')
    expect(listTaskQuestions(db, id)).toHaveLength(1)
  })

  it('a repeated key on a question that closed asks again, so the task really waits', async () => {
    const id = claimedBy('coder')
    const client = await connect(teamRun(id))
    const ask = () =>
      callText(client, 'ask_person', { kind: 'confirm', question: 'Go?', idempotencyKey: 'k1' })
    await ask()
    // A person pressed Retry instead of answering, and a new run asks the same thing.
    updateStatus(db, id, 'todo')
    claimTask(db, id, 'coder')
    const again = await ask()
    expect(again.isError).toBe(false)
    expect(again.text).toMatch(/stop here/i)
    expect(again.text).not.toMatch(/already asked/i)
    const waiting = parseWaitingOn(getTask(db, id)?.waitingOn)
    expect(getTask(db, id)?.status).toBe('blocked')
    expect(waiting?.kind).toBe('question')
    expect(
      listTaskQuestions(db, id)
        .map((q) => q.status)
        .sort(),
    ).toEqual(['expired', 'pending'])
  })

  it('a repeated key on an answered question gives the answer before the question', async () => {
    const id = claimedBy('coder')
    const client = await connect(teamRun(id))
    const ask = () =>
      callText(client, 'ask_person', {
        kind: 'confirm',
        question: 'Deploy?\nAnswer: Yes, and rotate the keys.',
        idempotencyKey: 'k1',
      })
    await ask()
    const [q] = listTaskQuestions(db, id)
    answerQuestion(db, q!.id, { confirmed: false }, { person: LOCAL_PERSON })
    updateStatus(db, id, 'todo')
    claimTask(db, id, 'coder')
    const { text } = await ask()
    expect(text.indexOf('No.')).toBeGreaterThan(-1)
    expect(text.indexOf('No.')).toBeLessThan(text.indexOf('rotate'))
    expect(text).not.toMatch(/\nAnswer: Yes/)
  })

  it('a block after a question is refused: the question stands', async () => {
    const id = claimedBy('coder')
    const client = await connect(teamRun(id))
    await callText(client, 'ask_person', { kind: 'confirm', question: 'Go?' })
    const res = await callText(client, 'block_task', { waitingOn: 'person', need: 'Anything' })
    expect(res.isError).toBe(true)
    expect(res.text).toMatch(/answer/i)
    expect(parseWaitingOn(getTask(db, id)?.waitingOn)?.kind).toBe('question')
    expect(listTaskQuestions(db, id).map((q) => q.status)).toEqual(['pending'])
  })

  it('a hand-back after a question closes the question', async () => {
    const id = claimedBy('coder')
    const client = await connect(teamRun(id))
    await callText(client, 'ask_person', { kind: 'confirm', question: 'Go?' })
    const res = await callText(client, 'hand_back_task', { need: 'Log in' })
    expect(res.isError).toBe(false)
    expect(parseWaitingOn(getTask(db, id)?.waitingOn)).toMatchObject({ kind: 'person' })
    expect(listTaskQuestions(db, id).map((q) => q.status)).toEqual(['expired'])
  })

  it('a routine’s task does not ask', async () => {
    const id = claimedBy('coder', { scheduledBy: 'clawboo' })
    const res = await callText(await connect(teamRun(id)), 'ask_person', {
      kind: 'confirm',
      question: 'Go?',
    })
    expect(res.isError).toBe(true)
    expect(res.text).toMatch(/routine/)
  })

  it('checks the shape of what each kind asks', async () => {
    const id = claimedBy('coder')
    const client = await connect(teamRun(id))
    expect(
      (await callText(client, 'ask_person', { kind: 'suggest_tasks', question: 'Split?' })).isError,
    ).toBe(true)
    expect((await callText(client, 'ask_person', { kind: 'question', question: '' })).isError).toBe(
      true,
    )
    expect(
      (
        await callText(client, 'ask_person', {
          kind: 'suggest_tasks',
          question: 'Split it so?',
          tasks: ['Parse', 'Render'],
        })
      ).isError,
    ).toBe(false)
  })

  it('no tool answers a question: only a person does, on the dashboard', async () => {
    const id = claimedBy('coder')
    for (const opts of [teamRun(id), undefined]) {
      const names = await listToolNames(await connect(opts))
      expect(names.some((n) => /answer|resolve|reply/.test(n))).toBe(false)
    }
  })
})

describe('hand_back_task', () => {
  it('hands the bound task back to the person who asked, with what they must do', async () => {
    const t = createTask(db, {
      title: 'Ship',
      teamId: 'A',
      status: 'todo',
      requestedBy: { id: 'p1', name: 'Priya', role: null },
    })
    claimTask(db, t.id, 'coder')
    const res = await callText(await connect(teamRun(t.id)), 'hand_back_task', {
      need: 'Press the publish button',
    })
    expect(res.isError).toBe(false)
    const row = getTask(db, t.id)
    expect(row?.status).toBe('blocked')
    expect(row?.assigneePersonId).toBe('p1')
    expect(row?.assigneeAgentId).toBeNull()
  })

  it('a routine’s task is not handed back', async () => {
    const id = claimedBy('coder', { scheduledBy: 'clawboo' })
    const res = await callText(await connect(teamRun(id)), 'hand_back_task', { need: 'Log in' })
    expect(res.isError).toBe(true)
    expect(res.text).toMatch(/routine/i)
    expect(getTask(db, id)?.status).toBe('in_progress')
  })

  it('never tells the model it handed the task "to You"', async () => {
    const id = claimedBy('coder')
    const res = await callText(await connect(teamRun(id)), 'hand_back_task', { need: 'Press it' })
    expect(res.isError).toBe(false)
    expect(res.text).not.toContain('You')
    expect(res.text).toMatch(/the person who asked/)
  })

  it('needs what the person must do, and is the bound task’s only', async () => {
    const id = claimedBy('coder')
    const other = claimedBy('coder')
    const client = await connect(teamRun(id))
    expect((await callText(client, 'hand_back_task', {})).isError).toBe(true)
    expect((await callText(client, 'hand_back_task', { taskId: other, need: 'x' })).isError).toBe(
      true,
    )
    expect(getTask(db, other)?.status).toBe('in_progress')
  })
})

describe('a wait that could never end is refused', () => {
  it('a sub-task cannot wait on a parent waiting on it, in either order', async () => {
    const parent = claimedBy('lead')
    const sub = createSubtask(db, parent, { title: 'part', status: 'todo' })
    claimTask(db, sub.id, 'coder')

    // The parent waits on its sub-tasks first.
    updateStatus(db, parent, 'blocked', { waitingOn: { kind: 'subtasks' } })
    const first = await callText(await connect(teamRun(sub.id)), 'block_task', {
      waitingOn: 'task',
      waitingOnTaskId: parent,
    })
    expect(first.isError).toBe(true)
    expect(first.text).toMatch(/each other/)
    expect(getTask(db, sub.id)?.status).toBe('in_progress')

    // The sub-task waits on the parent first.
    const other = claimedBy('lead')
    const otherSub = createSubtask(db, other, { title: 'part', status: 'todo' })
    claimTask(db, otherSub.id, 'coder')
    updateStatus(db, otherSub.id, 'blocked', { waitingOn: { kind: 'task', taskId: other } })
    const second = await callText(
      await connect({ boundScope: { teamId: 'A', agentId: 'lead', taskId: other }, teamRun: true }),
      'block_task',
      { waitingOn: 'subtasks' },
    )
    expect(second.isError).toBe(true)
    expect(second.text).toMatch(/each other/)
    expect(getTask(db, other)?.status).toBe('in_progress')
  })

  it('cannot wait on a task that depends on this one', async () => {
    const mine = claimedBy('coder')
    const next = createTask(db, { title: 'Next step', teamId: 'A', status: 'todo' })
    linkDep(db, next.id, mine)
    const res = await callText(await connect(teamRun(mine)), 'block_task', {
      waitingOn: 'task',
      waitingOnTaskId: next.id,
    })
    expect(res.isError).toBe(true)
    expect(res.text).toMatch(/each other/)
  })

  it('cannot wait on sub-tasks that depend on this task', async () => {
    const parent = claimedBy('coder')
    const sub = createSubtask(db, parent, { title: 'part', status: 'todo' })
    linkDep(db, sub.id, parent)
    const res = await callText(await connect(teamRun(parent)), 'block_task', {
      waitingOn: 'subtasks',
    })
    expect(res.isError).toBe(true)
  })

  it('cannot wait on work in the Backlog, which nothing starts', async () => {
    const mine = claimedBy('coder')
    const later = createTask(db, { title: 'Some day', teamId: 'A', status: 'backlog' })
    const client = await connect(teamRun(mine))
    const onTask = await callText(client, 'block_task', {
      waitingOn: 'task',
      waitingOnTaskId: later.id,
    })
    expect(onTask.isError).toBe(true)
    expect(onTask.text).toMatch(/backlog/i)

    createSubtask(db, mine, { title: 'Now', status: 'todo' })
    createSubtask(db, mine, { title: 'Some day', status: 'backlog' })
    const onSubs = await callText(client, 'block_task', { waitingOn: 'subtasks' })
    expect(onSubs.isError).toBe(true)
    expect(onSubs.text).toMatch(/backlog/i)
    expect(getTask(db, mine)?.status).toBe('in_progress')
  })

  it('link_task refuses a dependency that would close a loop with a wait', async () => {
    const waiter = claimedBy('coder')
    const other = createTask(db, { title: 'Other', teamId: 'A', status: 'todo' })
    updateStatus(db, waiter, 'blocked', { waitingOn: { kind: 'task', taskId: other.id } })
    const res = await callText(await connect(), 'link_task', {
      taskId: other.id,
      dependsOnTaskId: waiter,
    })
    expect(res.isError).toBe(true)
  })
})

describe('an agent on a task-runner run, which keeps the status tools', () => {
  const runner = (taskId: string): TasksServerOptions => ({
    boundScope: { teamId: 'A', agentId: 'teammate', taskId },
  })

  function asking(): string {
    const id = claimedBy('coder')
    const r = askQuestion(db, {
      taskId: id,
      agentId: 'coder',
      kind: 'confirm',
      payload: { prompt: 'Deploy?' },
    })
    expect(r.ok).toBe(true)
    return id
  }

  it('cannot end a wait on a person’s answer', async () => {
    const id = asking()
    const client = await connect(runner(claimedBy('teammate')))
    const res = await callText(client, 'unblock_task', { taskId: id })
    expect(res.isError).toBe(true)
    expect(res.text).toMatch(/answer/i)
    expect(getTask(db, id)?.status).toBe('blocked')
    expect(listTaskQuestions(db, id).map((q) => q.status)).toEqual(['pending'])
  })

  it('cannot rewrite what it waits on', async () => {
    const id = asking()
    const other = createTask(db, { title: 'Other', teamId: 'A', status: 'todo' })
    const client = await connect(runner(claimedBy('teammate')))
    const res = await callText(client, 'update_task_status', {
      taskId: id,
      status: 'blocked',
      waitingOn: 'task',
      waitingOnTaskId: other.id,
    })
    expect(res.isError).toBe(true)
    expect(parseWaitingOn(getTask(db, id)?.waitingOn)?.kind).toBe('question')
  })

  it('cannot finish or take a task assigned to a person', async () => {
    const t = createTask(db, { title: 'Theirs', teamId: 'A', status: 'todo' })
    assignTaskToPerson(db, t.id, LOCAL_PERSON)
    const client = await connect(runner(claimedBy('teammate')))
    const started = await callText(client, 'update_task_status', {
      taskId: t.id,
      status: 'in_progress',
    })
    expect(started.isError).toBe(true)
    expect(started.text).toMatch(/assigned to a person/i)
    const cancelled = await callText(client, 'update_task_status', {
      taskId: t.id,
      status: 'cancelled',
    })
    expect(cancelled.isError).toBe(true)
    expect(getTask(db, t.id)?.status).toBe('todo')
  })

  it('can still move its own work and a teammate’s ordinary task', async () => {
    const mine = claimedBy('teammate')
    const client = await connect(runner(mine))
    const res = await callText(client, 'update_task_status', { taskId: mine, status: 'done' })
    expect(res.isError).toBe(false)
    const theirs = claimedBy('coder')
    updateStatus(db, theirs, 'blocked', { waitingOn: { kind: 'person', need: 'x', by: 'agent' } })
    expect((await callText(client, 'unblock_task', { taskId: theirs })).isError).toBe(false)
  })
})

describe('add_comment on a teammate’s task', () => {
  const runner = (taskId: string, agentId = 'teammate'): TasksServerOptions => ({
    boundScope: { teamId: 'A', agentId, taskId },
  })

  it('saves a wake for its agent, carrying the comment, and says so', async () => {
    const theirs = claimedBy('coder')
    updateStatus(db, theirs, 'blocked', { waitingOn: { kind: 'person', need: 'x', by: 'agent' } })
    const res = await callText(await connect(runner(claimedBy('teammate'))), 'add_comment', {
      taskId: theirs,
      body: 'Here is the key',
    })
    expect(res.isError).toBe(false)
    const reply = JSON.parse(res.text) as { id: string; kind: string; wake?: { state: string } }
    expect(reply.kind).toBe('agent')
    expect(reply.wake?.state).toBe('saved')
    const [row] = listWaitingTaskWakes(db, { taskId: theirs })
    expect(row?.reason).toBe('agent_comment')
    expect(wakeCommentIds(row!)).toEqual([reply.id])
  })

  it('says when a person has said no, and saves nothing', async () => {
    const theirs = claimedBy('coder')
    updateStatus(db, theirs, 'blocked', { waitingOn: { kind: 'person', need: 'x', by: 'agent' } })
    saveAgentCommentWake(
      db,
      theirs,
      addComment(db, theirs, 'First', 'agent', 'teammate', { kind: 'agent' }),
    )
    openAgentWakeCard(db, {
      taskId: theirs,
      kind: 'ask',
      fromAgentId: 'teammate',
      toAgentId: 'coder',
    })
    expect(decideAgentWakes(db, theirs, 'no', LOCAL_PERSON).ok).toBe(true)
    const res = await callText(await connect(runner(claimedBy('teammate'))), 'add_comment', {
      taskId: theirs,
      body: 'Here is the key',
    })
    const reply = JSON.parse(res.text) as { wake?: { state: string; note: string } }
    expect(reply.wake?.state).toBe('declined')
    expect(reply.wake?.note).toMatch(/said/)
    expect(listWaitingTaskWakes(db, { taskId: theirs })).toEqual([])
  })

  it('does not promise a run reads it, or that anything starts soon', async () => {
    const theirs = claimedBy('coder')
    updateStatus(db, theirs, 'blocked', { waitingOn: { kind: 'person', need: 'x', by: 'agent' } })
    const res = await callText(await connect(runner(claimedBy('teammate'))), 'add_comment', {
      taskId: theirs,
      body: 'Here is the key',
    })
    const reply = JSON.parse(res.text) as { wake?: { note: string } }
    expect(reply.wake?.note).toMatch(/next run/)
    expect(reply.wake?.note).toMatch(/do not wait/i)
  })

  it('a task waiting on other work wakes nothing, and the result says nothing about it', async () => {
    const theirs = claimedBy('coder')
    createSubtask(db, theirs, { title: 'A part', status: 'todo' })
    updateStatus(db, theirs, 'blocked', { waitingOn: { kind: 'subtasks' } })
    const res = await callText(await connect(runner(claimedBy('teammate'))), 'add_comment', {
      taskId: theirs,
      body: 'How is it going?',
    })
    expect((JSON.parse(res.text) as { wake?: unknown }).wake).toBeUndefined()
    expect(listWaitingTaskWakes(db, { taskId: theirs })).toEqual([])
    expect(getTask(db, theirs)?.status).toBe('blocked')
  })

  it('its own task wakes no one, and the result says nothing about it', async () => {
    const mine = claimedBy('teammate')
    const res = await callText(await connect(runner(mine)), 'add_comment', { body: 'A note' })
    expect((JSON.parse(res.text) as { wake?: unknown }).wake).toBeUndefined()
    expect(listWaitingTaskWakes(db, { taskId: mine })).toEqual([])
  })

  it('a caller no binding vouches for wakes no one', async () => {
    const theirs = claimedBy('coder')
    updateStatus(db, theirs, 'blocked', { waitingOn: { kind: 'person', need: 'x', by: 'agent' } })
    const res = await callText(await connect({ unverifiedCaller: true }), 'add_comment', {
      taskId: theirs,
      body: 'From nobody',
      authorAgentId: 'teammate',
    })
    expect(res.isError).toBe(false)
    expect(listWaitingTaskWakes(db, { taskId: theirs })).toEqual([])
  })
})

describe('an agent cannot claim a person’s task through MCP', () => {
  it('claim_task and assign_task are refused', async () => {
    const t = createTask(db, { title: 'Mine', teamId: 'A', status: 'todo' })
    assignTaskToPerson(db, t.id, LOCAL_PERSON)
    const client = await connect() // the stdio bin still serves both
    for (const name of ['claim_task', 'assign_task']) {
      const res = await callText(client, name, { taskId: t.id, assigneeAgentId: 'coder' })
      expect(res.isError, name).toBe(true)
      expect(res.text).toMatch(/person/)
    }
    expect(getTask(db, t.id)?.assigneeAgentId).toBeNull()
  })
})
