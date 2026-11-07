// The state behind "ask once per job, then the brakes": one row per job and one per
// pair of agents, so a restart or an evicted engine resets nothing.

import {
  LOCAL_PERSON,
  MAX_AGENT_WAKES_PER_HOUR,
  MAX_BACK_AND_FORTH,
  parseWaitingOn,
} from '@clawboo/board-core'
import { beforeEach, describe, expect, it } from 'vitest'

import { createDb, setSetting, type ClawbooDb } from '../../db'
import { listEvents } from '../../events'
import { listUndeliveredInbox } from '../../inbox'
import { askQuestion } from '../questions'
import {
  adoptTaskWakes,
  listWaitingTaskWakes,
  noteTaskWakeSkip,
  recordTaskWake,
  wakeCommentIds,
} from '../../taskWakes'
import {
  agentWakeCardsForTasks,
  agentWakeVerdictFor,
  decideAgentWakes,
  jobTaskIdOf,
  noteAgentWakeStarted,
  openAgentWakeCard,
  readAgentWakeGate,
  readTeamAlwaysAllow,
  saveAgentCommentWake,
  teamAgentWakesSettingKey,
} from '../agentWakes'
import { attentionForTask } from '../attention'
import {
  addComment,
  assignTaskToPerson,
  claimTask,
  completeExecutionProcess,
  createExecutionProcess,
  createHandOffUnderRequest,
  createSubtask,
  createTask,
  getTask,
  handBackTask,
  updateStatus,
} from '../repository'
import { setTaskRunnerInputs } from '../runnerInputs'

let db: ClawbooDb
beforeEach(() => {
  db = createDb(':memory:')
})

const BOUND = 'run-1:deleg:agent:b:reflectTo:lead'
const A_TO_B = { fromAgentId: 'a', toAgentId: 'b' }
const B_TO_A = { fromAgentId: 'b', toAgentId: 'a' }

/** Agent b's task, parked on what it says it needs. */
function parked(over: { parentTaskId?: string; title?: string } = {}): string {
  const t = over.parentTaskId
    ? createSubtask(db, over.parentTaskId, {
        title: over.title ?? 'Their part',
        status: 'todo',
        sourceDelegationId: BOUND,
      })
    : createTask(db, {
        title: over.title ?? 'Their task',
        teamId: 'T',
        status: 'todo',
        sourceDelegationId: BOUND,
      })
  claimTask(db, t.id, 'b')
  updateStatus(db, t.id, 'blocked', { waitingOn: { kind: 'person', need: 'A key', by: 'agent' } })
  return t.id
}
const comment = (taskId: string, from = 'a', body = 'Here it is') =>
  addComment(db, taskId, body, 'agent', from, { kind: 'agent' })
/** A teammate's comment, and the card the pump raises for it. */
const asking = (taskId: string, kind: 'ask' | 'hourly_cap' | 'back_and_forth' = 'ask') => {
  saveAgentCommentWake(db, taskId, comment(taskId))
  return openAgentWakeCard(db, { taskId, kind, ...A_TO_B })
}
const allowTeam = () => setSetting(db, teamAgentWakesSettingKey('T'), '{"always":true}')

describe('the job', () => {
  it('is the task’s top-level ancestor, or the task when it has none', () => {
    const root = createTask(db, { title: 'Root', teamId: 'T', status: 'todo' })
    const mid = createSubtask(db, root.id, { title: 'Mid', status: 'todo' })
    const leaf = createSubtask(db, mid.id, { title: 'Leaf', status: 'todo' })
    expect(jobTaskIdOf(db, leaf.id)).toBe(root.id)
    expect(jobTaskIdOf(db, mid.id)).toBe(root.id)
    expect(jobTaskIdOf(db, root.id)).toBe(root.id)
  })
})

describe('saving an agent’s comment as a wake', () => {
  it('holds its comment, and asks nothing by itself', () => {
    const id = parked()
    const c = comment(id)
    expect(saveAgentCommentWake(db, id, c)).toEqual({ state: 'saved', agentId: 'b' })
    const [row] = listWaitingTaskWakes(db, { taskId: id })
    expect(row?.reason).toBe('agent_comment')
    expect(row?.agentId).toBe('b')
    expect(wakeCommentIds(row!)).toEqual([c.id])
    expect(readAgentWakeGate(db, id)?.cardKind ?? null).toBeNull()
  })

  it('needs a comment written through a bound session', () => {
    const id = parked()
    const rest = addComment(db, id, 'Forged', 'agent', 'a')
    expect(saveAgentCommentWake(db, id, rest)).toEqual({ state: 'none' })
    expect(listWaitingTaskWakes(db, { taskId: id })).toEqual([])
  })

  it('an agent does not wake itself', () => {
    const id = parked()
    expect(saveAgentCommentWake(db, id, comment(id, 'b'))).toEqual({ state: 'none' })
  })

  it('wakes no one on a finished task, or one nobody runs', () => {
    const done = parked()
    updateStatus(db, done, 'cancelled', { actor: 'person' })
    expect(saveAgentCommentWake(db, done, comment(done))).toEqual({ state: 'none' })

    const nobody = createTask(db, { title: 'Nobody', teamId: 'T', status: 'todo' })
    expect(saveAgentCommentWake(db, nobody.id, comment(nobody.id))).toEqual({ state: 'none' })
  })

  it('a person’s task is theirs: nothing is saved for its agent', () => {
    const taken = createTask(db, { title: 'Mine', teamId: 'T', status: 'todo' })
    assignTaskToPerson(db, taken.id, LOCAL_PERSON)
    expect(saveAgentCommentWake(db, taken.id, comment(taken.id))).toEqual({ state: 'none' })

    const handed = createTask(db, {
      title: 'Handed',
      teamId: 'T',
      status: 'todo',
      sourceDelegationId: BOUND,
    })
    claimTask(db, handed.id, 'b')
    handBackTask(db, handed.id, { agentId: 'b', need: 'Log in' })
    expect(saveAgentCommentWake(db, handed.id, comment(handed.id))).toEqual({ state: 'none' })
  })

  it('a task waiting on other work stays as it is: the comment is on the thread', () => {
    const parent = createTask(db, {
      title: 'Parent',
      teamId: 'T',
      status: 'todo',
      sourceDelegationId: BOUND,
    })
    claimTask(db, parent.id, 'b')
    createSubtask(db, parent.id, { title: 'Part', status: 'todo' })
    updateStatus(db, parent.id, 'blocked', { waitingOn: { kind: 'subtasks' } })
    expect(saveAgentCommentWake(db, parent.id, comment(parent.id))).toEqual({ state: 'none' })

    const other = createTask(db, { title: 'First', teamId: 'T', status: 'todo' })
    const waiter = createTask(db, {
      title: 'Waiter',
      teamId: 'T',
      status: 'todo',
      sourceDelegationId: BOUND,
    })
    claimTask(db, waiter.id, 'b')
    updateStatus(db, waiter.id, 'blocked', { waitingOn: { kind: 'task', taskId: other.id } })
    expect(saveAgentCommentWake(db, waiter.id, comment(waiter.id))).toEqual({ state: 'none' })
    expect(listWaitingTaskWakes(db)).toEqual([])
  })

  it('a parent waiting on what it handed out: the comment is on the thread, and no wake', () => {
    const parent = createTask(db, {
      title: 'Parent',
      teamId: 'T',
      status: 'todo',
      sourceDelegationId: BOUND,
    })
    claimTask(db, parent.id, 'b')
    updateStatus(db, parent.id, 'blocked', { waitingOn: { kind: 'subtasks', handedOut: true } })
    expect(saveAgentCommentWake(db, parent.id, comment(parent.id))).toEqual({ state: 'none' })

    // Kept from Done until its sub-tasks come through: the same, though it reads `person`.
    const kept = createTask(db, {
      title: 'Kept',
      teamId: 'T',
      status: 'todo',
      sourceDelegationId: BOUND,
    })
    claimTask(db, kept.id, 'b')
    updateStatus(db, kept.id, 'blocked', {
      waitingOn: {
        kind: 'person',
        need: 'Part a did not finish.',
        by: 'agent',
        untilSubtasks: true,
      },
    })
    expect(saveAgentCommentWake(db, kept.id, comment(kept.id))).toEqual({ state: 'none' })
    expect(listWaitingTaskWakes(db)).toEqual([])
  })

  it('an agent that reported it did not finish said what it needs: a comment can answer that', () => {
    const t = createTask(db, {
      title: 'Short of done',
      teamId: 'T',
      status: 'todo',
      sourceDelegationId: BOUND,
    })
    claimTask(db, t.id, 'b')
    updateStatus(db, t.id, 'blocked', {
      waitingOn: { kind: 'person', need: 'The API key is missing.', by: 'agent' },
    })
    expect(saveAgentCommentWake(db, t.id, comment(t.id))).toEqual({ state: 'saved', agentId: 'b' })
  })

  it('after a no it stays on the thread and wakes no one', () => {
    const id = parked()
    asking(id)
    expect(decideAgentWakes(db, id, 'no', LOCAL_PERSON).ok).toBe(true)
    expect(saveAgentCommentWake(db, id, comment(id))).toEqual({ state: 'declined', agentId: 'b' })
    expect(listWaitingTaskWakes(db, { taskId: id })).toEqual([])
  })
})

describe('a task the task runner runs, which reads comments from its mailbox', () => {
  function runnerTask(): string {
    const t = createTask(db, { title: 'Runner task', teamId: 'T', status: 'todo' })
    setTaskRunnerInputs(db, t.id, {
      runtime: 'hermes',
      assigneeAgentId: 'b',
      repoPath: null,
      kind: null,
      model: null,
    })
    claimTask(db, t.id, 'b')
    updateStatus(db, t.id, 'blocked', { waitingOn: { kind: 'person', need: 'A key', by: 'agent' } })
    return t.id
  }

  it('gets the comment there, saying a teammate wrote it', () => {
    const id = runnerTask()
    saveAgentCommentWake(db, id, comment(id, 'a', 'Here is the key'))
    const [note] = listUndeliveredInbox(db, 'b', { teamId: 'T' })
    expect(note?.taskId).toBe(id)
    expect(note?.body).toContain('Here is the key')
    expect(note?.body).toContain('teammate')
    expect(note?.body).not.toContain('person')
  })

  it('while it waits on other work too: no wake, and the later run can still read it', () => {
    const id = runnerTask()
    const sub = createTask(db, { title: 'Sub', teamId: 'T', status: 'todo', parentTaskId: id })
    expect(sub.parentTaskId).toBe(id)
    updateStatus(db, id, 'todo')
    claimTask(db, id, 'b')
    updateStatus(db, id, 'blocked', { waitingOn: { kind: 'subtasks' } })
    expect(saveAgentCommentWake(db, id, comment(id, 'a', 'For when you are back'))).toEqual({
      state: 'none',
    })
    expect(listWaitingTaskWakes(db).filter((w) => w.taskId === id)).toEqual([])
    expect(
      listUndeliveredInbox(db, 'b', { teamId: 'T' }).some((r) =>
        r.body.includes('For when you are back'),
      ),
    ).toBe(true)
  })

  it('after a no too: it is not a wake, and the run has no other way to read it', () => {
    const id = runnerTask()
    asking(id)
    decideAgentWakes(db, id, 'no', LOCAL_PERSON)
    saveAgentCommentWake(db, id, comment(id, 'a', 'Said after the no'))
    expect(
      listUndeliveredInbox(db, 'b', { teamId: 'T' }).some((r) =>
        r.body.includes('Said after the no'),
      ),
    ).toBe(true)
  })

  it('cuts a long one and says where the rest is', () => {
    const id = runnerTask()
    saveAgentCommentWake(db, id, comment(id, 'a', `${'x'.repeat(1_500)}END`))
    const [note] = listUndeliveredInbox(db, 'b', { teamId: 'T' })
    expect(note?.body).not.toContain('END')
    expect(note?.body).toMatch(/cut/)
    expect(note?.body).toMatch(/on the task/)
  })

  it('a team chat task writes none: its ticket block carries the comment', () => {
    const id = parked()
    saveAgentCommentWake(db, id, comment(id))
    expect(listUndeliveredInbox(db, 'b', { teamId: 'T' })).toEqual([])
  })
})

describe('the verdict, read off the database', () => {
  it('reads the job’s row and the team’s setting', () => {
    const id = parked()
    const verdict = () => agentWakeVerdictFor(db, id, A_TO_B)
    expect(verdict()).toBe('ask')
    allowTeam()
    expect(readTeamAlwaysAllow(db, 'T')).toBe(true)
    expect(verdict()).toBe('allowed')
    setSetting(db, teamAgentWakesSettingKey('T'), '{"always":false}')
    expect(verdict()).toBe('ask')
  })

  it('the job’s decision covers all its tasks, and no other job’s', () => {
    const root = createTask(db, { title: 'Root', teamId: 'T', status: 'todo' })
    const inside = parked({ parentTaskId: root.id })
    const other = parked({ title: 'Another job' })
    asking(inside)
    expect(decideAgentWakes(db, root.id, 'job', LOCAL_PERSON).ok).toBe(true)
    expect(agentWakeVerdictFor(db, inside, A_TO_B)).toBe('allowed')
    expect(agentWakeVerdictFor(db, other, A_TO_B)).toBe('ask')
  })

  it('the hourly count is on disk: nothing about the brake is in memory', () => {
    const id = parked()
    allowTeam()
    for (let i = 0; i < MAX_AGENT_WAKES_PER_HOUR; i++) noteAgentWakeStarted(db, id, A_TO_B)
    expect(readAgentWakeGate(db, id)?.windowCount).toBe(MAX_AGENT_WAKES_PER_HOUR)
    expect(agentWakeVerdictFor(db, id, A_TO_B)).toBe('hourly_cap')
  })
})

describe('the back-and-forth brake', () => {
  it('holds across jobs: two agents answering each other on two tasks still stop', () => {
    const one = parked({ title: 'One job' })
    const two = parked({ title: 'Another job' })
    allowTeam()
    for (let i = 0; i < MAX_BACK_AND_FORTH; i++)
      noteAgentWakeStarted(db, i % 2 === 0 ? one : two, i % 2 === 0 ? A_TO_B : B_TO_A)
    expect(agentWakeVerdictFor(db, one, A_TO_B)).toBe('back_and_forth')
    expect(agentWakeVerdictFor(db, two, A_TO_B)).toBe('back_and_forth')
  })

  it('other agents waking each other meanwhile do not break it', () => {
    const one = parked({ title: 'One job' })
    allowTeam()
    for (let i = 0; i < MAX_BACK_AND_FORTH; i++) {
      noteAgentWakeStarted(db, one, i % 2 === 0 ? A_TO_B : B_TO_A)
      noteAgentWakeStarted(db, one, { fromAgentId: 'c', toAgentId: 'd' })
    }
    expect(agentWakeVerdictFor(db, one, A_TO_B)).toBe('back_and_forth')
    expect(agentWakeVerdictFor(db, one, { fromAgentId: 'd', toAgentId: 'e' })).toBe('allowed')
  })

  it('does not reach across teams', () => {
    const one = parked({ title: 'One job' })
    const elsewhere = createTask(db, { title: 'Elsewhere', teamId: 'U', status: 'todo' })
    setSetting(db, teamAgentWakesSettingKey('U'), '{"always":true}')
    allowTeam()
    for (let i = 0; i < MAX_BACK_AND_FORTH; i++)
      noteAgentWakeStarted(db, one, i % 2 === 0 ? A_TO_B : B_TO_A)
    expect(agentWakeVerdictFor(db, elsewhere.id, A_TO_B)).toBe('allowed')
  })

  it('a chain that went quiet for an hour is over', () => {
    const one = parked({ title: 'One job' })
    allowTeam()
    const start = Date.now()
    for (let i = 0; i < MAX_BACK_AND_FORTH; i++)
      noteAgentWakeStarted(db, one, i % 2 === 0 ? A_TO_B : B_TO_A, start)
    expect(agentWakeVerdictFor(db, one, A_TO_B, start + 60 * 60_000)).toBe('allowed')
  })

  it('a yes on its card lets that pair carry on, and a person’s wake clears it too', () => {
    const one = parked({ title: 'One job' })
    const two = parked({ title: 'Another job' })
    allowTeam()
    const chain = () => {
      for (let i = 0; i < MAX_BACK_AND_FORTH; i++)
        noteAgentWakeStarted(db, one, i % 2 === 0 ? A_TO_B : B_TO_A)
    }
    chain()
    asking(two, 'back_and_forth')
    expect(attentionForTask(db, two)?.agentWakes?.kind).toBe('back_and_forth')
    expect(decideAgentWakes(db, two, 'job', LOCAL_PERSON).ok).toBe(true)
    expect(agentWakeVerdictFor(db, two, A_TO_B)).toBe('allowed')

    chain()
    expect(agentWakeVerdictFor(db, one, A_TO_B)).toBe('back_and_forth')
    asking(one, 'back_and_forth')
    recordTaskWake(db, { teamId: 'T', agentId: 'b', taskId: two, reason: 'person_comment' })
    expect(agentWakeVerdictFor(db, one, A_TO_B)).toBe('allowed')
    expect(readAgentWakeGate(db, one)?.cardKind).toBeNull()
  })

  it('a person’s wake leaves other pairs, the ask-once card and the hourly count alone', () => {
    const id = parked()
    const other = parked({ title: 'Another job' })
    asking(id)
    allowTeam()
    const C_TO_D = { fromAgentId: 'c', toAgentId: 'd' }
    const D_TO_C = { fromAgentId: 'd', toAgentId: 'c' }
    for (let i = 0; i < MAX_BACK_AND_FORTH; i++)
      noteAgentWakeStarted(db, other, i % 2 === 0 ? C_TO_D : D_TO_C)
    const before = readAgentWakeGate(db, other)?.windowCount
    expect(agentWakeVerdictFor(db, other, C_TO_D)).toBe('back_and_forth')
    recordTaskWake(db, { teamId: 'T', agentId: 'b', taskId: id, reason: 'person_comment' })
    expect(readAgentWakeGate(db, id)?.cardKind).toBe('ask')
    expect(readAgentWakeGate(db, other)?.windowCount).toBe(before)
    expect(agentWakeVerdictFor(db, other, C_TO_D)).toBe('back_and_forth')
  })
})

describe('the card', () => {
  it('puts the task in Needs you without touching what it waits on', () => {
    const id = parked()
    expect(asking(id)).toBe(true)
    expect(attentionForTask(db, id)).toMatchObject({
      reason: 'agent_wakes',
      agentWakes: { jobTaskId: id, kind: 'ask', fromAgentId: 'a', toAgentId: 'b' },
    })
    expect(getTask(db, id)?.status).toBe('blocked')
    expect(parseWaitingOn(getTask(db, id)?.waitingOn)).toMatchObject({ kind: 'person' })
    // Its status did not move, so this is what a browser alert has to go on.
    expect(
      listEvents(db, { kinds: ['status_changed'] }).some(
        (e) => e.taskId === id && e.data.includes('agent_wakes_ask'),
      ),
    ).toBe(true)
  })

  it('is one card per job: a second wake waits behind the first', () => {
    const root = createTask(db, { title: 'Root', teamId: 'T', status: 'todo' })
    const first = parked({ parentTaskId: root.id })
    const second = parked({ parentTaskId: root.id, title: 'Another part' })
    expect(asking(first)).toBe(true)
    expect(openAgentWakeCard(db, { taskId: first, kind: 'ask', ...A_TO_B })).toBe(false)
    expect(asking(second)).toBe(false)
    expect(attentionForTask(db, first)?.reason).toBe('agent_wakes')
    expect(attentionForTask(db, second)?.reason).not.toBe('agent_wakes')
  })

  it('moves on when the task it sits on stopped waiting', () => {
    const root = createTask(db, { title: 'Root', teamId: 'T', status: 'todo' })
    const first = parked({ parentTaskId: root.id })
    const second = parked({ parentTaskId: root.id, title: 'Another part' })
    asking(first)
    updateStatus(db, first, 'cancelled', { actor: 'person' })
    expect(attentionForTask(db, first)).toBeNull()
    expect(asking(second)).toBe(true)
    expect(attentionForTask(db, second)?.reason).toBe('agent_wakes')
  })

  it('an hour-cap card ends with its hour', () => {
    const id = parked()
    allowTeam()
    const start = Date.now()
    for (let i = 0; i < MAX_AGENT_WAKES_PER_HOUR; i++) noteAgentWakeStarted(db, id, A_TO_B, start)
    asking(id, 'hourly_cap')
    const row = [getTask(db, id)!]
    expect(agentWakeCardsForTasks(db, row, start + 1).get(id)?.kind).toBe('hourly_cap')
    expect(agentWakeCardsForTasks(db, row, start + 60 * 60_000).get(id)).toBeUndefined()
  })

  it('a decision closes it, and records who decided', () => {
    const id = parked()
    asking(id)
    const r = decideAgentWakes(db, id, 'job', LOCAL_PERSON)
    expect(r).toMatchObject({ ok: true, cardTaskId: id })
    const row = readAgentWakeGate(db, id)!
    expect(row.decision).toBe('allow')
    expect(row.cardKind).toBeNull()
    expect(JSON.parse(row.decidedBy ?? '{}')).toMatchObject({ id: LOCAL_PERSON.id })
    expect(attentionForTask(db, id)?.reason).not.toBe('agent_wakes')
  })

  it('with no card open, a decision is refused: it answers nothing', () => {
    const id = parked()
    expect(decideAgentWakes(db, id, 'job', LOCAL_PERSON)).toEqual({ ok: false, reason: 'no_card' })
  })

  it('"always in this team" needs a team, and sets it', () => {
    const id = parked()
    asking(id)
    expect(decideAgentWakes(db, id, 'team', LOCAL_PERSON).ok).toBe(true)
    expect(readTeamAlwaysAllow(db, 'T')).toBe(true)

    const lone = createTask(db, { title: 'Lone', status: 'todo', sourceDelegationId: BOUND })
    claimTask(db, lone.id, 'b')
    updateStatus(db, lone.id, 'blocked', {
      waitingOn: { kind: 'person', need: 'x', by: 'agent' },
    })
    asking(lone.id)
    expect(decideAgentWakes(db, lone.id, 'team', LOCAL_PERSON)).toEqual({
      ok: false,
      reason: 'no_team',
    })
  })

  it('carrying on after a pause starts the hour again', () => {
    const id = parked()
    allowTeam()
    for (let i = 0; i < MAX_AGENT_WAKES_PER_HOUR; i++) noteAgentWakeStarted(db, id, A_TO_B)
    asking(id, 'hourly_cap')
    expect(decideAgentWakes(db, id, 'job', LOCAL_PERSON).ok).toBe(true)
    expect(readAgentWakeGate(db, id)?.windowCount).toBe(0)
    expect(agentWakeVerdictFor(db, id, A_TO_B)).toBe('allowed')
  })
})

describe('a card is only as live as the wake behind it', () => {
  it('a run that took the wake and failed shows the failure, with its Retry', () => {
    const id = parked()
    asking(id)
    expect(attentionForTask(db, id)?.reason).toBe('agent_wakes')
    // A person's Retry: its run takes the wake, and that run fails.
    updateStatus(db, id, 'todo', { actor: 'person' })
    const claim = claimTask(db, id, 'b', 'codex', { run: { executorType: 'openclaw' } })
    completeExecutionProcess(db, claim.execution!.id, { status: 'failed', error: 'boom' })
    updateStatus(db, id, 'blocked', { waitingOn: { kind: 'failure' } })
    expect(attentionForTask(db, id)?.reason).toBe('failed')
    expect(attentionForTask(db, id)?.agentWakes).toBeUndefined()
  })

  it('a run that took the wake and blocked again shows no card, and asks nothing', () => {
    const id = parked()
    asking(id)
    updateStatus(db, id, 'todo', { actor: 'person' })
    const claim = claimTask(db, id, 'b', 'codex', { run: { executorType: 'openclaw' } })
    completeExecutionProcess(db, claim.execution!.id, { status: 'succeeded', summary: 'x' })
    updateStatus(db, id, 'blocked', { waitingOn: { kind: 'person', need: 'y', by: 'agent' } })
    expect(attentionForTask(db, id)?.reason).toBe('blocked')
    expect(decideAgentWakes(db, id, 'no', LOCAL_PERSON)).toEqual({ ok: false, reason: 'no_card' })
    expect(readAgentWakeGate(db, id)?.decision).toBeNull()
  })

  it('a wake carried by a run going now holds no card up', () => {
    const id = parked()
    asking(id)
    const exec = createExecutionProcess(db, { taskId: id, executorType: 'openclaw' })
    adoptTaskWakes(db, id, exec.id)
    expect(attentionForTask(db, id)?.reason).not.toBe('agent_wakes')
  })

  it('a task now in review answers nothing, though it says what its agent needs', () => {
    const id = parked()
    asking(id)
    updateStatus(db, id, 'todo', { actor: 'person' })
    claimTask(db, id, 'b')
    updateStatus(db, id, 'in_review', {
      waitingOn: { kind: 'person', need: 'A look', by: 'agent' },
    })
    expect(listWaitingTaskWakes(db, { taskId: id })).toHaveLength(1)
    expect(decideAgentWakes(db, id, 'job', LOCAL_PERSON)).toEqual({ ok: false, reason: 'no_card' })
  })

  it('a task now on a question or handed back gives way, and the next wake gets its card', () => {
    const root = createTask(db, { title: 'Root', teamId: 'T', status: 'todo' })
    const first = parked({ parentTaskId: root.id })
    const second = parked({ parentTaskId: root.id, title: 'Another part' })
    const third = parked({ parentTaskId: root.id, title: 'Third part' })
    asking(first)

    // The first's agent runs again and asks a person something.
    updateStatus(db, first, 'todo', { actor: 'person' })
    claimTask(db, first, 'b')
    createExecutionProcess(db, { taskId: first, executorType: 'openclaw' })
    expect(
      askQuestion(db, { taskId: first, agentId: 'b', kind: 'confirm', payload: { prompt: 'Go?' } })
        .ok,
    ).toBe(true)
    expect(attentionForTask(db, first)?.reason).toBe('question')
    expect(asking(second)).toBe(true)
    expect(attentionForTask(db, second)?.reason).toBe('agent_wakes')

    // The same when it is handed back.
    updateStatus(db, second, 'todo', { actor: 'person' })
    claimTask(db, second, 'b')
    createExecutionProcess(db, { taskId: second, executorType: 'openclaw' })
    expect(handBackTask(db, second, { agentId: 'b', need: 'Log in' }).ok).toBe(true)
    expect(attentionForTask(db, second)?.reason).toBe('assigned')
    expect(asking(third)).toBe(true)
    expect(attentionForTask(db, third)?.reason).toBe('agent_wakes')
  })
})

describe('one ask, however many jobs are waiting on it', () => {
  it('a fan-out of top-level tasks gets one card, and it says so', () => {
    const tasks = [parked({ title: 'One' }), parked({ title: 'Two' }), parked({ title: 'Three' })]
    expect(asking(tasks[0]!)).toBe(true)
    for (const id of tasks.slice(1)) {
      saveAgentCommentWake(db, id, comment(id))
      expect(openAgentWakeCard(db, { taskId: id, kind: 'ask', ...A_TO_B })).toBe(false)
      noteTaskWakeSkip(db, listWaitingTaskWakes(db, { taskId: id })[0]!.id, 'ask_once')
    }
    expect(attentionForTask(db, tasks[0]!)?.agentWakes?.alsoWaiting).toBe(2)
    expect(attentionForTask(db, tasks[1]!)?.reason).not.toBe('agent_wakes')
  })

  it('a yes covers each job waiting on it, and no job that was not', () => {
    const [one, two, later] = [
      parked({ title: 'One' }),
      parked({ title: 'Two' }),
      parked({ title: 'Later' }),
    ]
    asking(one)
    saveAgentCommentWake(db, two, comment(two))
    noteTaskWakeSkip(db, listWaitingTaskWakes(db, { taskId: two })[0]!.id, 'ask_once')
    const r = decideAgentWakes(db, one, 'job', LOCAL_PERSON)
    expect(r.ok && r.jobTaskIds.sort()).toEqual([one, two].sort())
    expect(agentWakeVerdictFor(db, two, A_TO_B)).toBe('allowed')
    expect(agentWakeVerdictFor(db, later, A_TO_B)).toBe('ask')
  })

  it('a pause is about its own job: those waiting on an ask still get theirs', () => {
    const [capped, waiting] = [parked({ title: 'Capped' }), parked({ title: 'Waiting' })]
    allowTeam()
    noteAgentWakeStarted(db, capped, A_TO_B)
    asking(capped, 'hourly_cap')
    setSetting(db, teamAgentWakesSettingKey('T'), '{"always":false}')
    saveAgentCommentWake(db, waiting, comment(waiting))
    noteTaskWakeSkip(db, listWaitingTaskWakes(db, { taskId: waiting })[0]!.id, 'ask_once')
    expect(attentionForTask(db, capped)?.agentWakes).toMatchObject({ kind: 'hourly_cap' })
    expect(attentionForTask(db, capped)?.agentWakes?.alsoWaiting).toBeUndefined()
    const r = decideAgentWakes(db, capped, 'job', LOCAL_PERSON)
    expect(r.ok && r.jobTaskIds).toEqual([capped])
    expect(agentWakeVerdictFor(db, waiting, A_TO_B)).toBe('ask')
  })

  it('a task that moved on is not waiting on it, even before the pump says so', () => {
    const [one, moved, handedBack, still] = [
      parked({ title: 'One' }),
      parked({ title: 'Moved' }),
      parked({ title: 'Handed back' }),
      parked({ title: 'Still' }),
    ]
    asking(one)
    for (const id of [moved, handedBack, still]) {
      saveAgentCommentWake(db, id, comment(id))
      noteTaskWakeSkip(db, listWaitingTaskWakes(db, { taskId: id })[0]!.id, 'ask_once')
    }
    updateStatus(db, moved, 'todo', { actor: 'person' })
    updateStatus(db, handedBack, 'todo', { actor: 'person' })
    claimTask(db, handedBack, 'b')
    createExecutionProcess(db, { taskId: handedBack, executorType: 'openclaw' })
    expect(handBackTask(db, handedBack, { agentId: 'b', need: 'Log in' }).ok).toBe(true)
    expect(attentionForTask(db, one)?.agentWakes?.alsoWaiting).toBe(1)
    const r = decideAgentWakes(db, one, 'job', LOCAL_PERSON)
    expect(r.ok && r.jobTaskIds.sort()).toEqual([one, still].sort())
    expect(agentWakeVerdictFor(db, moved, A_TO_B)).toBe('ask')
    expect(agentWakeVerdictFor(db, handedBack, A_TO_B)).toBe('ask')
  })

  it('a no does too, and closes their wakes', () => {
    const [one, two, other] = [
      parked({ title: 'One' }),
      parked({ title: 'Two' }),
      parked({ title: 'Other' }),
    ]
    asking(one)
    saveAgentCommentWake(db, two, comment(two))
    noteTaskWakeSkip(db, listWaitingTaskWakes(db, { taskId: two })[0]!.id, 'ask_once')
    saveAgentCommentWake(db, other, comment(other))
    expect(decideAgentWakes(db, one, 'no', LOCAL_PERSON).ok).toBe(true)
    expect(agentWakeVerdictFor(db, two, A_TO_B)).toBe('no')
    expect(listWaitingTaskWakes(db, { taskId: two })).toEqual([])
    // Not yet asked about: it has its own ask to come.
    expect(listWaitingTaskWakes(db, { taskId: other })).toHaveLength(1)
    expect(agentWakeVerdictFor(db, other, A_TO_B)).toBe('ask')
  })

  it('another team’s card is its own', () => {
    const here = parked({ title: 'Here' })
    const there = createTask(db, {
      title: 'There',
      teamId: 'U',
      status: 'todo',
      sourceDelegationId: BOUND,
    })
    claimTask(db, there.id, 'b')
    updateStatus(db, there.id, 'blocked', {
      waitingOn: { kind: 'person', need: 'x', by: 'agent' },
    })
    expect(asking(here)).toBe(true)
    expect(asking(there.id)).toBe(true)
  })

  it('a no on a job leaves a person’s wake on it', () => {
    const root = createTask(db, { title: 'Root', teamId: 'T', status: 'todo' })
    const a = parked({ parentTaskId: root.id })
    const b = parked({ parentTaskId: root.id, title: 'Another part' })
    asking(a)
    recordTaskWake(db, { teamId: 'T', agentId: 'b', taskId: b, reason: 'person_comment' })
    expect(decideAgentWakes(db, root.id, 'no', LOCAL_PERSON).ok).toBe(true)
    expect(listWaitingTaskWakes(db, { taskId: a })).toEqual([])
    expect(listWaitingTaskWakes(db, { taskId: b })).toHaveLength(1)
  })
})

describe('work under a person’s request', () => {
  const REQUEST = {
    title: 'Ship it',
    description: 'Ship it',
    leadAgentId: 'lead',
    key: 'main:T:d1',
  }
  const under = (request = REQUEST, title = 'Their part'): { mainId: string; id: string } => {
    const r = createHandOffUnderRequest(db, request, {
      title,
      teamId: 'T',
      sourceDelegationId: BOUND,
    })
    if (!r.ok) throw new Error(r.reason)
    return { mainId: r.task.parentTaskId as string, id: r.task.id }
  }
  /** Agent b's sub-task, parked on what it says it needs. */
  const parkedUnder = (request = REQUEST, title = 'Their part'): string => {
    const { id } = under(request, title)
    claimTask(db, id, 'b')
    updateStatus(db, id, 'blocked', { waitingOn: { kind: 'person', need: 'A key', by: 'agent' } })
    return id
  }

  it('is one job: the request’s main task', () => {
    const one = under()
    const two = under(REQUEST, 'Another part')
    expect(jobTaskIdOf(db, one.id)).toBe(one.mainId)
    expect(jobTaskIdOf(db, two.id)).toBe(one.mainId)
    expect(jobTaskIdOf(db, one.mainId)).toBe(one.mainId)
  })

  it('a person’s yes on one sub-task answers for the whole request', () => {
    const one = parkedUnder()
    const two = parkedUnder(REQUEST, 'Another part')
    expect(agentWakeVerdictFor(db, two, A_TO_B)).toBe('ask')
    expect(asking(one)).toBe(true)
    expect(decideAgentWakes(db, one, 'job', LOCAL_PERSON).ok).toBe(true)
    expect(agentWakeVerdictFor(db, two, A_TO_B)).toBe('allowed')
  })

  it('two requests are two jobs, and a back-and-forth is still per pair per team', () => {
    const one = parkedUnder()
    const two = parkedUnder({ ...REQUEST, key: 'main:T:d2' }, 'The other request’s part')
    expect(jobTaskIdOf(db, one)).not.toBe(jobTaskIdOf(db, two))
    allowTeam()
    for (let i = 0; i < MAX_BACK_AND_FORTH; i++)
      noteAgentWakeStarted(db, i % 2 === 0 ? one : two, i % 2 === 0 ? A_TO_B : B_TO_A)
    expect(agentWakeVerdictFor(db, two, A_TO_B)).toBe('back_and_forth')
  })

  it('a teammate’s comment on the main task wakes nothing, open or parked', () => {
    const { mainId } = under()
    expect(saveAgentCommentWake(db, mainId, comment(mainId))).toEqual({ state: 'none' })
    updateStatus(db, mainId, 'blocked', {
      mainTaskLifecycle: true,
      waitingOn: { kind: 'person', need: 'Say what you want.', by: 'agent' },
    })
    expect(saveAgentCommentWake(db, mainId, comment(mainId))).toEqual({ state: 'none' })
    expect(listWaitingTaskWakes(db, { taskId: mainId, includeHeld: true })).toEqual([])
  })
})
