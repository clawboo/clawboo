// Saving a run's inputs on its task must not strand the task. The write comes
// after the claim; were it to throw before the runner marks the task as claimed,
// the safety net would skip the release and leave the task in progress with an
// assignee and nothing running it.

import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { createTask, getTask } from '@clawboo/db'
import { seedSandboxTeam } from './seedTeam'
import type {
  Capabilities,
  RunHandle,
  RuntimeAdapter,
  RuntimeEvent,
  StartOpts,
  TaskHandle,
} from '@clawboo/executor'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

vi.mock('@clawboo/db', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@clawboo/db')>()),
  setTaskRunnerInputs: () => {
    throw new Error('SQLITE_BUSY: database is locked')
  },
}))

const { getDb, resetDb } = await import('../db')
const { runTaskOnRuntime } = await import('../executorRunner')

const CAPS: Capabilities = {
  streaming: true,
  mcp: false,
  worktrees: false,
  resume: false,
  toolApproval: false,
  models: [],
}

/** Finishes at once with a summary. */
class DoneAdapter implements RuntimeAdapter {
  readonly id = 'claude-code'
  readonly participantKind = 'agent' as const
  capabilities(): Capabilities {
    return CAPS
  }
  async health() {
    return { ok: true }
  }
  async start(_t: TaskHandle, opts: StartOpts): Promise<RunHandle> {
    return { adapterId: this.id, sessionKey: opts.sessionKey, runId: null }
  }
  events(run: RunHandle): AsyncIterable<RuntimeEvent> {
    const base = { runId: run.sessionKey, sessionId: run.sessionKey, ts: 1 }
    return (async function* () {
      yield {
        ...base,
        seq: 1,
        kind: 'text-delta',
        text: 'Done.',
        channel: 'assistant',
      } as RuntimeEvent
      yield { ...base, seq: 2, kind: 'done', reason: 'success', summary: 'Done.' } as RuntimeEvent
    })()
  }
  async abort() {}
  async setModel() {}
  async writeContext() {}
}

let home: string
let prevHome: string | undefined
let prevClawbooHome: string | undefined

beforeEach(async () => {
  home = await mkdtemp(path.join(os.tmpdir(), 'clawboo-runner-inputs-'))
  await mkdir(path.join(home, '.clawboo'), { recursive: true })
  prevHome = process.env['HOME']
  prevClawbooHome = process.env['CLAWBOO_HOME']
  process.env['HOME'] = home
  process.env['CLAWBOO_HOME'] = path.join(home, '.clawboo')
  seedSandboxTeam(home)
})

afterEach(async () => {
  resetDb()
  if (prevHome === undefined) delete process.env['HOME']
  else process.env['HOME'] = prevHome
  if (prevClawbooHome === undefined) delete process.env['CLAWBOO_HOME']
  else process.env['CLAWBOO_HOME'] = prevClawbooHome
  await rm(home, { recursive: true, force: true })
})

it('runs the task to its end when the inputs cannot be saved', async () => {
  const db = getDb()
  const task = createTask(db, { title: 'Look it up', status: 'todo', teamId: 'team-1' })
  const result = await runTaskOnRuntime({
    db,
    makeAdapter: () => new DoneAdapter(),
    taskId: task.id,
    assigneeAgentId: 'claude-1',
    kind: 'research',
  })
  expect(result.ok).toBe(true)
  // Not stranded in progress with an assignee and nothing behind it.
  expect(getTask(db, task.id)?.status).not.toBe('in_progress')
})
