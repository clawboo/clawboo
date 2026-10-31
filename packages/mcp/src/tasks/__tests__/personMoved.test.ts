// An agent's own status tools after a person moved the card: the run that was
// working on it was overruled, so update_task_status, block_task and
// unblock_task refuse, name where the person put the card, and tell the model
// not to retry. A run started after the move writes as usual.

import {
  claimTask,
  createDb,
  createExecutionProcess,
  createTask,
  getTask,
  updateStatus,
  type ClawbooDb,
} from '@clawboo/db'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { callText, connectInMemory } from '../../testing'
import { createTasksServer } from '../server'

let db: ClawbooDb
beforeEach(() => {
  db = createDb(':memory:')
})

/** A task Coder was working on when a person moved it to To do. */
function overruledTask(): string {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(1_000_000)
  const t = createTask(db, { title: 'Draft the post', teamId: 'A', status: 'todo' })
  claimTask(db, t.id, 'coder')
  createExecutionProcess(db, { taskId: t.id, executorType: 'claude-code' })
  vi.setSystemTime(1_060_000)
  expect(updateStatus(db, t.id, 'todo', { actor: 'person' }).ok).toBe(true)
  vi.useRealTimers()
  return t.id
}

describe('Tasks MCP: a status write after a person moved the card', () => {
  it('refuses each status tool and tells the model not to retry', async () => {
    const taskId = overruledTask()
    const client = await connectInMemory(createTasksServer(db, { boundScope: { teamId: 'A' } }))
    for (const [name, args] of [
      ['update_task_status', { taskId, status: 'in_progress' }],
      ['block_task', { taskId }],
    ] as const) {
      const res = await callText(client, name, args)
      expect(res.isError, name).toBe(true)
      expect(res.text, name).toContain('A person moved this task to To do')
      expect(res.text, name).toContain('do not retry')
    }
    expect(getTask(db, taskId)?.status).toBe('todo')
  })

  it('lets a run started after the move change the status', async () => {
    const taskId = overruledTask()
    claimTask(db, taskId, 'coder')
    createExecutionProcess(db, { taskId, executorType: 'claude-code' })
    const client = await connectInMemory(createTasksServer(db, { boundScope: { teamId: 'A' } }))
    const res = await callText(client, 'block_task', { taskId })
    expect(res.isError).toBe(false)
    expect(getTask(db, taskId)?.status).toBe('blocked')
  })
})
