// Which runtime a person's rerun of a task-runner task uses, and what the runner
// is handed. The run itself is the runner's own suite; here it is a recorder.

import { encodeHumanAssignment } from '@clawboo/board-core'
import {
  agents,
  completeExecutionProcess,
  createDb,
  createExecutionProcess,
  createTask,
  getComments,
  getTask,
  listEvents,
  setTaskRunnerInputs,
  tasks,
  type ClawbooDb,
  type DbTask,
} from '@clawboo/db'
import { eq } from 'drizzle-orm'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const runs: Array<Record<string, unknown>> = []
/** What the next run answers; a function so a test can hold it open or throw. */
let nextRun: () => Promise<unknown> = async () => ({ ok: true })
vi.mock('../executorRunner', () => ({
  runTaskOnRuntime: async (input: Record<string, unknown>) => {
    runs.push(input)
    return nextRun()
  },
}))
vi.mock('../runtimes/runKeyEnv', () => ({ runtimeKeyEnv: () => ({}) }))

const { pumpRunnerReruns, requestRunnerRerun, resetRunnerRerunsForTests, runnerRerunFor } =
  await import('../runnerRerun')

let db: ClawbooDb
beforeEach(() => {
  db = createDb(':memory:')
  runs.length = 0
  nextRun = async () => ({ ok: true })
  resetRunnerRerunsForTests()
  const now = Date.now()
  for (const [id, runtime, archivedAt] of [
    ['coder', 'claude-code', null],
    ['codexer', 'codex', null],
    ['oc', 'openclaw', null],
    ['gone', 'claude-code', now],
  ] as const) {
    db.insert(agents)
      .values({ id, name: id, gatewayId: id, runtime, archivedAt, createdAt: now, updatedAt: now })
      .run()
  }
})

/** A task the runner ran on Claude Code for `coder`. */
function runnerTask(): DbTask {
  const task = createTask(db, { title: 'Fix the bug', teamId: 't' })
  setTaskRunnerInputs(db, task.id, {
    runtime: 'claude-code',
    assigneeAgentId: 'coder',
    repoPath: '/repo',
    kind: 'code',
    model: 'claude-sonnet-4-6',
  })
  return getTask(db, task.id)!
}

describe('runnerRerunFor', () => {
  it('is null for a task the runner never ran, so it goes to team chat', () => {
    const task = createTask(db, { title: 'x', teamId: 't' })
    expect(runnerRerunFor(db, task, 'coder')).toBeNull()
  })

  it('uses the agent’s own runtime', () => {
    expect(runnerRerunFor(db, runnerTask(), 'codexer')?.runtime).toBe('codex')
  })

  it('keeps the saved runtime for an id with no agent row', () => {
    // A direct POST /api/runtimes/:id/run may run a task for any id.
    expect(runnerRerunFor(db, runnerTask(), 'claude-code')?.runtime).toBe('claude-code')
  })

  it('leaves an agent the runner cannot run to team chat', () => {
    expect(runnerRerunFor(db, runnerTask(), 'oc')).toBeNull()
  })

  it('runs nothing for a removed agent', () => {
    expect(runnerRerunFor(db, runnerTask(), 'gone')).toBeNull()
  })

  it('runs nothing for a deleted agent, whose id is not the saved runtime’s', () => {
    expect(runnerRerunFor(db, runnerTask(), 'deleted-agent')).toBeNull()
  })
})

describe('requestRunnerRerun', () => {
  it('hands the runner the saved inputs', async () => {
    const task = runnerTask()
    requestRunnerRerun(db, {
      taskId: task.id,
      assigneeAgentId: 'coder',
      rerun: runnerRerunFor(db, task, 'coder')!,
      mcpBaseUrl: 'http://127.0.0.1:1',
    })
    await vi.waitFor(() => expect(runs).toHaveLength(1))
    expect(runs[0]).toMatchObject({
      taskId: task.id,
      assigneeAgentId: 'coder',
      repoPath: '/repo',
      kind: 'code',
      model: 'claude-sonnet-4-6',
      mcpBaseUrl: 'http://127.0.0.1:1',
    })
  })

  it('drops the saved model on another runtime', async () => {
    const task = runnerTask()
    requestRunnerRerun(db, {
      taskId: task.id,
      assigneeAgentId: 'codexer',
      rerun: runnerRerunFor(db, task, 'codexer')!,
      mcpBaseUrl: null,
    })
    await vi.waitFor(() => expect(runs).toHaveLength(1))
    expect(runs[0]).toMatchObject({ assigneeAgentId: 'codexer', model: null, repoPath: '/repo' })
  })
})

describe('a rerun that does not start', () => {
  const start = (task: DbTask): void =>
    requestRunnerRerun(db, {
      taskId: task.id,
      assigneeAgentId: 'coder',
      rerun: runnerRerunFor(db, task, 'coder')!,
      mcpBaseUrl: null,
    })

  it('moves the task to Needs you and says why when the runner refuses it', async () => {
    const task = runnerTask()
    nextRun = async () => ({ ok: false, reason: 'budget_paused' })
    start(task)
    await vi.waitFor(() => expect(getTask(db, task.id)?.status).toBe('blocked'))
    expect(getComments(db, task.id).map((c) => [c.authorType, c.body])).toEqual([
      [
        'system',
        'The rerun on Claude Code did not start: a budget it counts against is paused at its hard cap.',
      ],
    ])
    // On the event log too, which is what the browser alerts wake up on.
    expect(
      listEvents(db, { taskId: task.id, kinds: ['status_changed'] }).map((e) => JSON.parse(e.data)),
    ).toEqual([{ to: 'blocked', reason: 'rerun_not_started' }])
  })

  it('does the same when the run throws, for example a timed-out wait for the agent', async () => {
    const task = runnerTask()
    nextRun = async () => {
      throw new Error('mutex acquire timed out')
    }
    start(task)
    await vi.waitFor(() => expect(getTask(db, task.id)?.status).toBe('blocked'))
    expect(getComments(db, task.id).at(-1)?.body).toContain('mutex acquire timed out')
  })

  it('leaves a task alone when another run claimed it first', async () => {
    const task = runnerTask()
    nextRun = async () => ({ ok: false, reason: 'conflict' })
    start(task)
    await vi.waitFor(() => expect(runs).toHaveLength(1))
    await new Promise((r) => setTimeout(r, 0))
    expect(getTask(db, task.id)?.status).toBe('todo')
    expect(getComments(db, task.id)).toEqual([])
  })
})

describe('a second rerun of the same task', () => {
  it('stops the one still waiting, so it cannot claim the task later', async () => {
    const task = runnerTask()
    nextRun = () => new Promise(() => {}) // waits behind another run, forever
    const rerun = runnerRerunFor(db, task, 'coder')!
    requestRunnerRerun(db, { taskId: task.id, assigneeAgentId: 'coder', rerun, mcpBaseUrl: null })
    requestRunnerRerun(db, { taskId: task.id, assigneeAgentId: 'coder', rerun, mcpBaseUrl: null })
    await vi.waitFor(() => expect(runs).toHaveLength(2))
    expect((runs[0]!['abortSignal'] as AbortSignal).aborted).toBe(true)
    expect((runs[1]!['abortSignal'] as AbortSignal).aborted).toBe(false)
  })
})

describe('the handoff pause', () => {
  it('is never replayed, so a rerun of a paused task can finish', async () => {
    // A row an earlier build wrote with the pause in it.
    const task = createTask(db, { title: 'paused', teamId: 't' })
    db.update(tasks)
      .set({
        runnerInputs: JSON.stringify({
          runtime: 'claude-code',
          assigneeAgentId: 'coder',
          repoPath: '/repo',
          kind: 'code',
          model: null,
          keepForResume: true,
        }),
      })
      .where(eq(tasks.id, task.id))
      .run()
    const stored = getTask(db, task.id)!
    requestRunnerRerun(db, {
      taskId: task.id,
      assigneeAgentId: 'coder',
      rerun: runnerRerunFor(db, stored, 'coder')!,
      mcpBaseUrl: null,
    })
    await vi.waitFor(() => expect(runs).toHaveLength(1))
    expect(runs[0]!['keepForResume']).toBeUndefined()
  })
})

describe('pumpRunnerReruns: the automatic re-fire', () => {
  /** A task the runner ran for `agentId`, bound to it, whose runs so far failed. */
  function failedBoundTask(agentId: string, failures: number): string {
    const task = createTask(db, {
      title: `bound to ${agentId}`,
      teamId: 't',
      status: 'todo',
      sourceDelegationId: encodeHumanAssignment(agentId, `n-${agentId}-${failures}`),
    })
    setTaskRunnerInputs(db, task.id, {
      runtime: 'claude-code',
      assigneeAgentId: agentId,
      repoPath: '/repo',
      kind: 'code',
      model: null,
    })
    for (let i = 0; i < failures; i++) {
      const exec = createExecutionProcess(db, { taskId: task.id, executorType: 'claude-code' })
      completeExecutionProcess(db, exec.id, { status: 'failed', error: 'boom' })
    }
    return task.id
  }

  it('re-fires a failed task through the runner, for its bound agent', async () => {
    const id = failedBoundTask('coder', 1)
    pumpRunnerReruns(db, null)
    await vi.waitFor(() => expect(runs).toHaveLength(1))
    expect(runs[0]).toMatchObject({ taskId: id, assigneeAgentId: 'coder' })
  })

  it('stops after three failed runs in a row, as team chat does', () => {
    failedBoundTask('coder', 3)
    pumpRunnerReruns(db, null)
    expect(runs).toEqual([])
  })

  it('leaves a task bound to an agent the runner cannot run to team chat', () => {
    failedBoundTask('oc', 1)
    pumpRunnerReruns(db, null)
    expect(runs).toEqual([])
  })

  it('does not fire a task twice while its rerun waits', async () => {
    failedBoundTask('coder', 1)
    nextRun = () => new Promise(() => {})
    pumpRunnerReruns(db, null)
    pumpRunnerReruns(db, null)
    await new Promise((r) => setTimeout(r, 0))
    expect(runs).toHaveLength(1)
  })
})
