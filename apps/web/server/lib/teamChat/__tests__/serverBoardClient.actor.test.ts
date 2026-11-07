// The engine posts a run's report in its agent's name, so the comment records that
// agent's run, and its event says who wrote it. A note from clawboo itself names
// no run and no actor.

import {
  createDb,
  createExecutionProcess,
  createTask,
  getComments,
  listEvents,
  type ClawbooDb,
} from '@clawboo/db'
import { beforeEach, describe, expect, it } from 'vitest'

import { createServerBoardClient } from '../serverBoardClient'

const TEAM = 't1'
let db: ClawbooDb

beforeEach(() => {
  db = createDb(':memory:')
})

const actorOf = (taskId: string): unknown => {
  const [event] = listEvents(db, { kinds: ['comment_added'] }).filter((e) => e.taskId === taskId)
  return (JSON.parse(event!.data) as Record<string, unknown>)['actor']
}

describe('the engine posting a comment', () => {
  it("records the task's latest run on its agent's report", async () => {
    const task = createTask(db, { title: 't', teamId: TEAM })
    createExecutionProcess(db, { taskId: task.id, executorType: 'codex' })
    const run = createExecutionProcess(db, { taskId: task.id, executorType: 'codex' })
    await createServerBoardClient(db).addComment(task.id, 'done', 'agent', 'coder')
    expect(getComments(db, task.id)[0]).toMatchObject({
      authorType: 'agent',
      authorAgentId: 'coder',
      executionId: run.id,
    })
    expect(actorOf(task.id)).toEqual({ kind: 'agent', agentId: 'coder', execId: run.id })
  })

  it('records no run on a note of its own', async () => {
    const task = createTask(db, { title: 't', teamId: TEAM })
    createExecutionProcess(db, { taskId: task.id, executorType: 'codex' })
    await createServerBoardClient(db).addComment(task.id, 'skipped', 'system')
    expect(getComments(db, task.id)[0]).toMatchObject({ authorType: 'system', executionId: null })
    expect(actorOf(task.id)).toBeUndefined()
  })
})
