// A job's count of the runs it started by itself: one row per job, written with the claim.

import { LOCAL_PERSON } from '@clawboo/board-core'
import { DEFAULT_MAX_JOB_RUNS, type VerificationResult } from '@clawboo/governance'
import { eq, sql } from 'drizzle-orm'
import { beforeEach, describe, expect, it } from 'vitest'

import { createDb, type ClawbooDb } from '../../db'
import { listEvents } from '../../events/listEvents'
import { jobRuns, tasks, taskWakes } from '../../schema'
import { listHeldChatReportUps, listHeldReportUps, recordReportUp } from '../../reportUps'
import { listWaitingTaskWakes, recordTaskWake } from '../../taskWakes'
import { attentionForTask, taskIdsNeedingPerson } from '../attention'
import {
  carryOnJob,
  giveBackJobRun,
  jobLimitedTaskIds,
  jobRunRefused,
  jobRunState,
  jobRunStopped,
  jobStoppedTaskIds,
  noteJobRun,
  personStartedJob,
  roomForAcceptedStepsTx,
} from '../jobRuns'
import { stopJob } from '../jobStop'
import { setTaskRunnerInputs } from '../runnerInputs'
import { immediateWrite } from '../contention'
import {
  claimTask,
  completeExecutionProcess,
  createExecutionProcess,
  createSubtask,
  createTask,
  getTask,
  linkDep,
  listDirectDependentIds,
  listExecutions,
  listOpenMainTasks,
  OPEN_REQUEST_WALK_LIMIT,
  reconcileOrphans,
  releaseFinishedSubtaskWaits,
  reopenTask,
  updateStatus,
} from '../repository'
import { setTaskVerification, getTaskVerification } from '../verification'

let db: ClawbooDb
beforeEach(() => {
  db = createDb(':memory:')
})

const sdid = (agent: string): string => `run-1:deleg:agent:${agent}:reflectTo:leader`
const delegated = (title = 'Top') =>
  createTask(db, { title, teamId: 'T', status: 'todo', sourceDelegationId: sdid('a2') })
const automatic = { run: { executorType: 'openclaw', runReason: 'delegation' } }

/** The job has spent everything it may. */
function atLimit(taskId: string, runs = 3): void {
  db.insert(jobRuns)
    .values({ jobTaskId: taskId, teamId: 'T', runs, runLimit: runs, updatedAt: 1 })
    .run()
}

describe('the claim counts a run the board started', () => {
  it('in the same write, against the top of the job', () => {
    const top = delegated()
    expect(claimTask(db, top.id, 'a2', 'openclaw', automatic).ok).toBe(true)
    const sub = createSubtask(db, top.id, {
      title: 'Sub',
      status: 'todo',
      sourceDelegationId: sdid('a3'),
    })
    expect(claimTask(db, sub.id, 'a3', 'openclaw', automatic).ok).toBe(true)
    expect(jobRunState(db, sub.id)).toMatchObject({ jobTaskId: top.id, runs: 2 })
    expect(jobRunState(db, sub.id).limit).toBe(DEFAULT_MAX_JOB_RUNS)
  })

  it('not a run a person asked for', () => {
    const asked = delegated('Asked')
    expect(
      claimTask(db, asked.id, 'a2', 'openclaw', {
        run: { executorType: 'openclaw', runReason: 'person_retry' },
      }).ok,
    ).toBe(true)
    const forced = delegated('Forced')
    expect(
      claimTask(db, forced.id, 'a2', 'openclaw', {
        run: { executorType: 'openclaw', runReason: 'delegation', automatic: false },
      }).ok,
    ).toBe(true)
    expect(jobRunState(db, asked.id).runs).toBe(0)
    expect(jobRunState(db, forced.id).runs).toBe(0)
  })

  it('and a conflict is no start: it counts nothing', () => {
    const top = delegated()
    claimTask(db, top.id, 'a2', 'openclaw', automatic)
    expect(claimTask(db, top.id, 'a3', 'openclaw', automatic).ok).toBe(false)
    expect(jobRunState(db, top.id).runs).toBe(1)
  })
})

describe('at the limit', () => {
  it('refuses an automatic start, which waits in To do and writes no run', () => {
    const top = delegated()
    atLimit(top.id)
    expect(claimTask(db, top.id, 'a2', 'openclaw', automatic)).toEqual({
      ok: false,
      reason: 'job_limit',
    })
    expect(getTask(db, top.id)?.status).toBe('todo')
    expect(listExecutions(db, top.id)).toEqual([])
    expect(jobRunState(db, top.id).runs).toBe(3)
  })

  it('lets a person past it, spending nothing', () => {
    const top = delegated()
    atLimit(top.id)
    expect(
      claimTask(db, top.id, 'a2', 'openclaw', {
        run: { executorType: 'openclaw', runReason: 'person_retry' },
      }).ok,
    ).toBe(true)
    expect(jobRunState(db, top.id).runs).toBe(3)
  })

  it('a person’s wake waiting on the task makes the run theirs', () => {
    const top = delegated()
    atLimit(top.id)
    recordTaskWake(db, { teamId: 'T', agentId: 'a2', taskId: top.id, reason: 'person_comment' })
    expect(claimTask(db, top.id, 'a2', 'openclaw', automatic).ok).toBe(true)
    expect(jobRunState(db, top.id).runs).toBe(3)
  })

  it('asking counts nothing, and a start that goes is what counts', () => {
    const top = delegated()
    db.insert(jobRuns)
      .values({ jobTaskId: top.id, teamId: 'T', runs: 0, runLimit: 2, updatedAt: 1 })
      .run()
    expect(jobRunRefused(db, top.id)).toBe(false)
    noteJobRun(db, top.id)
    expect(jobRunRefused(db, top.id)).toBe(false)
    noteJobRun(db, top.id)
    expect(jobRunRefused(db, top.id)).toBe(true)
    expect(jobRunState(db, top.id).runs).toBe(2)
  })

  it('a run refused before it starts gives back what it took, once', () => {
    const top = delegated()
    const claim = claimTask(db, top.id, 'a2', 'openclaw', automatic)
    expect(jobRunState(db, top.id).runs).toBe(1)
    giveBackJobRun(db, claim.execution!.id)
    giveBackJobRun(db, claim.execution!.id)
    expect(jobRunState(db, top.id).runs).toBe(0)
  })

  it('a run a person started took nothing, so it gives nothing back', () => {
    const top = delegated()
    atLimit(top.id)
    const claim = claimTask(db, top.id, 'a2', 'openclaw', {
      run: { executorType: 'openclaw', runReason: 'person_retry' },
    })
    giveBackJobRun(db, claim.execution!.id)
    expect(jobRunState(db, top.id).runs).toBe(3)
  })

  it('a run with no claim counts in the write that opens it, and can give it back', () => {
    const top = delegated()
    claimTask(db, top.id, 'a2', 'openclaw', automatic)
    const round = createExecutionProcess(db, {
      taskId: top.id,
      executorType: 'openclaw',
      countJobRun: true,
    })
    expect(jobRunState(db, top.id).runs).toBe(2)
    giveBackJobRun(db, round.id)
    expect(jobRunState(db, top.id).runs).toBe(1)
    const unmarked = createExecutionProcess(db, { taskId: top.id, executorType: 'openclaw' })
    expect(jobRunState(db, top.id).runs).toBe(1)
    giveBackJobRun(db, unmarked.id)
    expect(jobRunState(db, top.id).runs).toBe(1)
  })

  it('says so once, however many starts it refuses', () => {
    const top = delegated()
    atLimit(top.id)
    for (let i = 0; i < 4; i++) expect(jobRunRefused(db, top.id)).toBe(true)
    claimTask(db, top.id, 'a2', 'openclaw', automatic)
    const said = listEvents(db, { kinds: ['job_limit_reached'] })
    expect(said).toHaveLength(1)
    expect(said[0]!.taskId).toBe(top.id)
    expect(JSON.parse(said[0]!.data ?? '{}')).toMatchObject({ runs: 3, limit: 3 })
  })

  it('makes room for the steps of a plan a person accepted, and no more', () => {
    const top = delegated()
    atLimit(top.id)
    immediateWrite(db, (tx) => roomForAcceptedStepsTx(tx, top.id, 2, Date.now()))
    expect(jobRunState(db, top.id)).toMatchObject({ runs: 3, limit: 5 })
    expect(jobRunRefused(db, top.id)).toBe(false)
    noteJobRun(db, top.id)
    noteJobRun(db, top.id)
    expect(jobRunRefused(db, top.id)).toBe(true)
  })

  it('counts a fix cycle that holds its claim, without refusing it', () => {
    const top = delegated()
    atLimit(top.id)
    noteJobRun(db, top.id)
    expect(jobRunState(db, top.id).runs).toBe(4)
  })
})

describe('the card', () => {
  it('stands on the job’s top while work waits, even a finished top', () => {
    const top = delegated()
    claimTask(db, top.id, 'a2', 'openclaw', automatic)
    const sub = createSubtask(db, top.id, {
      title: 'Sub',
      status: 'todo',
      sourceDelegationId: sdid('a3'),
    })
    updateStatus(db, top.id, 'done')
    db.update(jobRuns).set({ runs: 3, runLimit: 3 }).run()
    expect(jobRunRefused(db, sub.id)).toBe(true)

    expect(jobLimitedTaskIds(db)).toEqual([top.id])
    expect(taskIdsNeedingPerson(db)).toContain(top.id)
    expect(attentionForTask(db, top.id)).toMatchObject({
      reason: 'job_limit',
      jobLimit: { jobTaskId: top.id, runs: 3, limit: 3 },
    })
    // Not on the task under it: one job, one card.
    expect(attentionForTask(db, sub.id)?.reason).not.toBe('job_limit')
  })

  it('is not up until something was refused, and goes when nothing waits', () => {
    const top = delegated()
    atLimit(top.id)
    expect(jobLimitedTaskIds(db)).toEqual([])
    expect(jobRunRefused(db, top.id)).toBe(true)
    expect(jobLimitedTaskIds(db)).toEqual([top.id])
    // A person cancelled the one thing that was waiting.
    updateStatus(db, top.id, 'cancelled')
    expect(jobLimitedTaskIds(db)).toEqual([])
    expect(attentionForTask(db, top.id)?.reason).not.toBe('job_limit')
  })

  it('carry on adds another lot, says who, and answers a second press with nothing', () => {
    const top = delegated()
    atLimit(top.id)
    jobRunRefused(db, top.id)
    expect(carryOnJob(db, top.id, LOCAL_PERSON)).toMatchObject({
      ok: true,
      runs: 3,
      limit: 3 + DEFAULT_MAX_JOB_RUNS,
    })
    expect(jobLimitedTaskIds(db)).toEqual([])
    expect(carryOnJob(db, top.id, LOCAL_PERSON)).toEqual({ ok: false, reason: 'no_card' })
    expect(claimTask(db, top.id, 'a2', 'openclaw', automatic).ok).toBe(true)
    expect(jobRunState(db, top.id).runs).toBe(4)
  })
})

describe('what keeps the card up', () => {
  /** A job refused at its limit, whose only open work is `task`. */
  const refused = (top: { id: string }): void => {
    updateStatus(db, top.id, 'cancelled')
    db.update(jobRuns).set({ runs: 3, runLimit: 3 }).run()
    jobRunRefused(db, top.id)
  }
  const claimedTop = () => {
    const top = delegated()
    claimTask(db, top.id, 'a2', 'openclaw', automatic)
    return top
  }

  it('not a task with no agent: nothing could start it', () => {
    const top = claimedTop()
    createSubtask(db, top.id, { title: 'Nobody', status: 'todo' })
    refused(top)
    expect(jobLimitedTaskIds(db)).toEqual([])
  })

  it('not a plan step behind its blocker: the pump could not start it yet', () => {
    const top = claimedTop()
    const blocker = createSubtask(db, top.id, { title: 'Nobody first', status: 'todo' })
    const step = createSubtask(db, top.id, {
      title: 'Then',
      status: 'todo',
      sourceDelegationId: sdid('a3'),
    })
    linkDep(db, step.id, blocker.id)
    refused(top)
    expect(jobLimitedTaskIds(db)).toEqual([])
    // Its turn comes, and now it is really waiting.
    claimTask(db, blocker.id, 'a7')
    updateStatus(db, blocker.id, 'done')
    expect(jobLimitedTaskIds(db)).toEqual([top.id])
  })

  it('not a task the runner ran with no agent saved to go back to', () => {
    const top = claimedTop()
    const sub = createSubtask(db, top.id, { title: 'By hand', status: 'todo' })
    setTaskRunnerInputs(db, sub.id, {
      runtime: 'hermes',
      assigneeAgentId: 'a3',
      repoPath: '/repo',
      kind: null,
      model: null,
    })
    refused(top)
    expect(jobLimitedTaskIds(db)).toEqual([])
  })
})

describe('Stop on the card', () => {
  /** A job at its limit with a plan A to B to C, a runner task bound to an agent, a task
   *  with no agent, a saved wake and a report on its way to a one-to-one chat. */
  function bigJob() {
    const top = delegated()
    claimTask(db, top.id, 'a2', 'openclaw', automatic)
    const step = (title: string, agent: string) =>
      createSubtask(db, top.id, { title, status: 'todo', sourceDelegationId: sdid(agent) })
    const a = step('A', 'a3')
    const b = step('B', 'a4')
    const c = step('C', 'a5')
    linkDep(db, b.id, a.id)
    linkDep(db, c.id, b.id)
    const runner = step('Runner', 'a6')
    setTaskRunnerInputs(db, runner.id, {
      runtime: 'hermes',
      assigneeAgentId: 'a6',
      repoPath: '/repo',
      kind: null,
      model: null,
    })
    const nobody = createSubtask(db, top.id, { title: 'Nobody', status: 'todo' })
    recordTaskWake(db, { teamId: 'T', agentId: 'a3', taskId: a.id, reason: 'dependency_done' })
    recordReportUp(db, {
      teamId: 'T',
      roomId: null,
      taskId: a.id,
      recipientAgentId: 'lead',
      payload: '{}',
      chatSessionKey: 'agent:lead:chat',
    })
    recordReportUp(db, {
      teamId: 'T',
      roomId: null,
      taskId: top.id,
      recipientAgentId: 'lead',
      payload: '{}',
    })
    updateStatus(db, top.id, 'cancelled')
    db.update(jobRuns).set({ runs: 3, runLimit: 3 }).run()
    jobRunRefused(db, a.id)
    expect(jobLimitedTaskIds(db)).toEqual([top.id])
    return { top, a, b, c, runner, nobody }
  }

  it('takes the card down for good, whatever passes after it', () => {
    const { top, a, runner } = bigJob()
    const result = stopJob(db, top.id, LOCAL_PERSON)
    expect(result.ok).toBe(true)
    expect(jobLimitedTaskIds(db)).toEqual([])
    expect(jobRunStopped(db, a.id)).toBe(true)
    for (let i = 0; i < 3; i++) {
      expect(jobRunRefused(db, a.id)).toBe(true)
      expect(claimTask(db, runner.id, 'a6', 'openclaw', automatic)).toEqual({
        ok: false,
        reason: 'job_limit',
      })
      expect(jobLimitedTaskIds(db)).toEqual([])
    }
    expect(listEvents(db, { kinds: ['job_limit_reached'] })).toHaveLength(1)
  })

  it('leaves each task saying why', () => {
    const { top, a, b, c, runner, nobody } = bigJob()
    stopJob(db, top.id, LOCAL_PERSON)
    // What would have started reads as a person's Stop, and offers its Retry.
    expect(attentionForTask(db, a.id)?.reason).toBe('stopped')
    expect(attentionForTask(db, runner.id)?.reason).toBe('stopped')
    // What it waited on is still true, and a Retry of that one carries the plan on.
    expect(listExecutions(db, b.id)).toEqual([])
    expect(listExecutions(db, c.id)).toEqual([])
    expect([...jobStoppedTaskIds(db, [b, c])]).toEqual([b.id, c.id])
    // Nobody has it, so that is still what it says.
    expect(attentionForTask(db, nobody.id)?.reason).toBe('unassigned')
  })

  it('holds what was on its way, the one-to-one chat’s too', () => {
    const { top, a } = bigJob()
    stopJob(db, top.id, LOCAL_PERSON)
    expect(listWaitingTaskWakes(db, { taskId: a.id })).toEqual([])
    const [wake] = db.select().from(taskWakes).where(eq(taskWakes.taskId, a.id)).all()
    expect(wake?.heldAt).toBeTypeOf('number')
    expect(wake?.settledAt).toBeNull()
    expect(listHeldChatReportUps(db, 'agent:lead:chat')).toHaveLength(1)
    expect(listHeldReportUps(db, 'T', null)).toHaveLength(1)
  })

  it('a task waiting on its sub-tasks reads as stopped, since nothing will end the wait', () => {
    const top = delegated()
    claimTask(db, top.id, 'a2', 'openclaw', automatic)
    const parent = createSubtask(db, top.id, {
      title: 'Parent',
      status: 'todo',
      sourceDelegationId: sdid('a3'),
    })
    claimTask(db, parent.id, 'a3', 'openclaw', automatic)
    createSubtask(db, parent.id, { title: 'Kid', status: 'todo', sourceDelegationId: sdid('a4') })
    updateStatus(db, parent.id, 'blocked', { waitingOn: { kind: 'subtasks' } })
    updateStatus(db, top.id, 'cancelled')
    db.update(jobRuns).set({ runs: 3, runLimit: 3 }).run()
    jobRunRefused(db, parent.id)
    expect(stopJob(db, top.id, LOCAL_PERSON).ok).toBe(true)
    expect(getTask(db, parent.id)?.status).toBe('todo')
    expect(attentionForTask(db, parent.id)?.reason).toBe('stopped')
  })

  it('leaves other jobs alone', () => {
    const { top } = bigJob()
    const other = delegated('Other')
    const running = claimTask(db, other.id, 'a9', 'openclaw', automatic)
    const waiting = createSubtask(db, other.id, {
      title: 'Next',
      status: 'todo',
      sourceDelegationId: sdid('a8'),
    })
    stopJob(db, top.id, LOCAL_PERSON)
    expect(getTask(db, other.id)?.status).toBe('in_progress')
    expect(listExecutions(db, other.id).map((e) => e.status)).toEqual(['running'])
    expect(running.ok).toBe(true)
    expect(listExecutions(db, waiting.id)).toEqual([])
    expect(jobRunStopped(db, other.id)).toBe(false)
    expect(jobRunRefused(db, waiting.id)).toBe(false)
  })

  it('answers a second press with nothing, and a stale carry on too', () => {
    const { top } = bigJob()
    stopJob(db, top.id, LOCAL_PERSON)
    expect(stopJob(db, top.id, LOCAL_PERSON)).toEqual({ ok: false, reason: 'no_card' })
    expect(carryOnJob(db, top.id, LOCAL_PERSON)).toEqual({ ok: false, reason: 'no_card' })
  })

  it('a person’s Retry goes, and the next refusal brings the card back', () => {
    const { top, a, runner } = bigJob()
    stopJob(db, top.id, LOCAL_PERSON)
    const retried = claimTask(db, a.id, 'a3', 'openclaw', {
      run: { executorType: 'openclaw', runReason: 'person_retry', automatic: false },
    })
    expect(retried.ok).toBe(true)
    expect(jobRunStopped(db, a.id)).toBe(false)
    expect(jobRunState(db, top.id).runs).toBe(3)
    // A stopped task keeps its Stop, and nothing has been refused yet.
    expect(jobLimitedTaskIds(db)).toEqual([])
    completeExecutionProcess(db, retried.execution!.id, { status: 'succeeded' })
    updateStatus(db, a.id, 'done')
    // Its next step would start by itself, and the job is still at its limit.
    const b = listDirectDependentIds(db, a.id)[0]!
    expect(jobRunRefused(db, b)).toBe(true)
    expect(jobLimitedTaskIds(db)).toEqual([top.id])
    expect(attentionForTask(db, runner.id)?.reason).toBe('stopped')
  })

  it('a person’s words, or a Reopen, start work again', () => {
    const { top, a } = bigJob()
    stopJob(db, top.id, LOCAL_PERSON)
    personStartedJob(db, a.id)
    expect(jobRunStopped(db, a.id)).toBe(false)
    db.update(jobRuns).set({ stoppedAt: Date.now() }).run()
    expect(jobRunStopped(db, a.id)).toBe(true)
    expect(reopenTask(db, top.id).ok).toBe(true)
    expect(jobRunStopped(db, a.id)).toBe(false)
  })
})

describe('a verdict survives the task coming back by itself', () => {
  const verdict: VerificationResult = {
    status: 'fail',
    attempts: [
      {
        attempt: 1,
        at: 1,
        deterministic: {
          command: 'pnpm test',
          exitCode: 1,
          passed: false,
          stdoutTail: '',
          stderrTail: '',
          durationMs: 5,
          timedOut: false,
        },
        critic: {
          ran: false,
          findings: [],
          reviewerRuntime: null,
          reviewerModel: null,
          reviewedSha: null,
        },
        status: 'fail',
        structuredError: null,
      },
    ],
    debtNotes: [],
    updatedAt: 1,
  }

  function waitingOnSub(): { parent: string; sub: string } {
    const parent = delegated('Parent')
    const claim = claimTask(db, parent.id, 'a2', 'openclaw', automatic)
    setTaskVerification(db, parent.id, verdict)
    const sub = createSubtask(db, parent.id, {
      title: 'Sub',
      status: 'todo',
      sourceDelegationId: sdid('a3'),
    })
    completeExecutionProcess(db, claim.execution!.id, { status: 'succeeded', summary: 'out' })
    expect(updateStatus(db, parent.id, 'blocked', { waitingOn: { kind: 'subtasks' } }).ok).toBe(
      true,
    )
    return { parent: parent.id, sub: sub.id }
  }

  it('when its sub-tasks close', () => {
    const { parent, sub } = waitingOnSub()
    claimTask(db, sub, 'a3', 'openclaw', automatic)
    updateStatus(db, sub, 'done')
    releaseFinishedSubtaskWaits(db)
    expect(getTask(db, parent)?.status).toBe('todo')
    expect(getTaskVerification(db, parent)?.status).toBe('fail')
    // The gate still reads it: it cannot reach Done unchecked.
    updateStatus(db, parent, 'in_progress')
    expect(updateStatus(db, parent, 'done')).toMatchObject({ ok: false })
  })

  it('when a crash releases it', () => {
    const top = delegated()
    claimTask(db, top.id, 'a2', 'openclaw', automatic)
    setTaskVerification(db, top.id, verdict)
    reconcileOrphans(db, { staleAfterMs: -10_000 })
    expect(getTask(db, top.id)?.status).toBe('todo')
    expect(getTaskVerification(db, top.id)?.status).toBe('fail')
  })
})

describe('what a wait comes to', () => {
  it('a run that only said "waiting" counts once a sub-task it waited on got done', () => {
    const parent = delegated('Parent')
    const sub = createSubtask(db, parent.id, {
      title: 'Sub',
      status: 'todo',
      sourceDelegationId: sdid('a3'),
    })
    // From before this run, so the run did not make it.
    db.update(tasks).set({ createdAt: 1 }).where(eq(tasks.id, sub.id)).run()
    const claim = claimTask(db, parent.id, 'a2', 'openclaw', automatic)
    expect(updateStatus(db, parent.id, 'blocked', { waitingOn: { kind: 'subtasks' } }).ok).toBe(
      true,
    )
    completeExecutionProcess(db, claim.execution!.id, {
      status: 'succeeded',
      summary: 'waiting for the parts',
    })
    expect(listExecutions(db, parent.id).at(-1)?.madeProgress).toBe(0)
    claimTask(db, sub.id, 'a3', 'openclaw', automatic)
    updateStatus(db, sub.id, 'done')
    releaseFinishedSubtaskWaits(db)
    expect(getTask(db, parent.id)?.status).toBe('todo')
    expect(listExecutions(db, parent.id).at(-1)?.madeProgress).toBe(1)
  })
})

describe('handed-out work that all failed is not progress', () => {
  it('takes back the verdict of the run that handed it out', () => {
    const parent = delegated('Parent')
    const claim = claimTask(db, parent.id, 'a2', 'openclaw', automatic)
    const sub = createSubtask(db, parent.id, {
      title: 'Sub',
      status: 'todo',
      sourceDelegationId: sdid('a3'),
    })
    completeExecutionProcess(db, claim.execution!.id, { status: 'succeeded', summary: 'out' })
    expect(listExecutions(db, parent.id).at(-1)?.madeProgress).toBe(1)
    updateStatus(db, parent.id, 'blocked', { waitingOn: { kind: 'subtasks' } })

    updateStatus(db, sub.id, 'cancelled')
    releaseFinishedSubtaskWaits(db)
    expect(getTask(db, parent.id)?.status).toBe('todo')
    expect(listExecutions(db, parent.id).at(-1)?.madeProgress).toBe(0)
  })

  it('and leaves it when one got done', () => {
    const parent = delegated('Parent')
    const claim = claimTask(db, parent.id, 'a2', 'openclaw', automatic)
    const sub = createSubtask(db, parent.id, {
      title: 'Sub',
      status: 'todo',
      sourceDelegationId: sdid('a3'),
    })
    completeExecutionProcess(db, claim.execution!.id, { status: 'succeeded', summary: 'out' })
    updateStatus(db, parent.id, 'blocked', { waitingOn: { kind: 'subtasks' } })
    claimTask(db, sub.id, 'a3', 'openclaw', automatic)
    updateStatus(db, sub.id, 'done')
    releaseFinishedSubtaskWaits(db)
    expect(listExecutions(db, parent.id).at(-1)?.madeProgress).toBe(1)
  })
})

describe('the scans stay bounded', () => {
  it('an index finds a task’s report-ups', () => {
    const plan = db.all(
      sql`EXPLAIN QUERY PLAN SELECT id FROM report_up_outbox WHERE task_id = 'x' AND settled_at IS NULL`,
    ) as Array<{ detail: string }>
    expect(plan.map((r) => r.detail).join(' ')).toContain('idx_report_up_outbox_task')
  })

  it('open requests are read newest first up to a limit, and one parked for a person is not', () => {
    const main = (title: string, status: 'in_progress' | 'blocked'): string => {
      const t = createTask(db, { title, teamId: 'T', status: 'todo' })
      db.update(tasks).set({ status, isMainTask: 1 }).where(eq(tasks.id, t.id)).run()
      return t.id
    }
    const parked = main('parked', 'blocked')
    const ids = Array.from({ length: OPEN_REQUEST_WALK_LIMIT + 2 }, (_, i) =>
      main(`open ${i}`, 'in_progress'),
    )
    db.update(tasks).set({ createdAt: 1 }).where(eq(tasks.id, ids[0]!)).run()
    const read = listOpenMainTasks(db, { teamId: 'T' }).map((s) => s.id)
    expect(read).toHaveLength(OPEN_REQUEST_WALK_LIMIT)
    expect(read).not.toContain(parked)
    expect(read).not.toContain(ids[0])
  })
})
