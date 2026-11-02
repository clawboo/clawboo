// The task runner's inputs ride on the task, so a person's Retry or Assign can
// run it the same way again.

import { beforeEach, describe, expect, it } from 'vitest'

import { createDb, type ClawbooDb } from '../../db'
import { createTask, getTask } from '../repository'
import { readTaskRunnerInputs, setTaskRunnerInputs } from '../runnerInputs'

let db: ClawbooDb
beforeEach(() => {
  db = createDb(':memory:')
})

describe('task runner inputs', () => {
  it('a new task has none', () => {
    const task = createTask(db, { title: 'x', teamId: 't' })
    expect(task.runnerInputs).toBeNull()
    expect(readTaskRunnerInputs(getTask(db, task.id))).toBeNull()
  })

  it('round-trips what the runner saved', () => {
    const task = createTask(db, { title: 'x', teamId: 't' })
    const inputs = {
      runtime: 'codex',
      assigneeAgentId: 'coder',
      repoPath: '/repo',
      kind: 'code',
      model: null,
      keepForResume: true,
      maxNodeCents: 100,
    }
    setTaskRunnerInputs(db, task.id, inputs)
    expect(readTaskRunnerInputs(getTask(db, task.id))).toEqual(inputs)
  })

  it('reads a row it cannot use as none', () => {
    for (const runnerInputs of [
      'not json',
      '[]',
      '{"runtime":"codex"}', // no agent
      '{"assigneeAgentId":"coder"}', // no runtime
    ]) {
      expect(readTaskRunnerInputs({ runnerInputs }), runnerInputs).toBeNull()
    }
  })
})
