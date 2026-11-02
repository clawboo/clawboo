// Which runtime a person's rerun of a task-runner task uses, and what the runner
// is handed. The run itself is the runner's own suite; here it is a recorder.

import {
  agents,
  createDb,
  createTask,
  getTask,
  setTaskRunnerInputs,
  type ClawbooDb,
  type DbTask,
} from '@clawboo/db'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const runs: Array<Record<string, unknown>> = []
vi.mock('../executorRunner', () => ({
  runTaskOnRuntime: async (input: Record<string, unknown>) => {
    runs.push(input)
    return { ok: true }
  },
}))
vi.mock('../runtimes/runKeyEnv', () => ({ runtimeKeyEnv: () => ({}) }))

const { requestRunnerRerun, runnerRerunFor } = await import('../runnerRerun')

let db: ClawbooDb
beforeEach(() => {
  db = createDb(':memory:')
  runs.length = 0
  const now = Date.now()
  for (const [id, runtime] of [
    ['coder', 'claude-code'],
    ['codexer', 'codex'],
    ['oc', 'openclaw'],
  ] as const) {
    db.insert(agents)
      .values({ id, name: id, gatewayId: id, runtime, createdAt: now, updatedAt: now })
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
