// `report_result`: a report, not a move. It is bound to the run's own task, it writes no
// status, and an unbound or unverified caller cannot report for anyone.

import {
  claimTask,
  completeExecutionProcess,
  createDb,
  createTask,
  getTask,
  listExecutions,
  readResultClaim,
  updateStatus,
  type ClawbooDb,
} from '@clawboo/db'
import { beforeEach, describe, expect, it } from 'vitest'

import { callText, connectInMemory, listToolNames } from '../../testing'
import { createTasksServer, type TasksServerOptions } from '../server'

let db: ClawbooDb
beforeEach(() => {
  db = createDb(':memory:')
})

function running(agentId: string): { id: string; execId: string } {
  const t = createTask(db, { title: 'Write the parser', teamId: 'A', status: 'todo' })
  const claim = claimTask(db, t.id, agentId, 'claude-code', {
    run: { executorType: 'openclaw' },
  })
  return { id: t.id, execId: claim.execution!.id }
}

const teamRun = (taskId: string, agentId = 'coder'): TasksServerOptions => ({
  boundScope: { teamId: 'A', agentId, taskId },
  teamRun: true,
})
const connect = (opts?: TasksServerOptions) => connectInMemory(createTasksServer(db, opts))

describe('report_result', () => {
  it('stores the claim on the run, and moves no card', async () => {
    const { id, execId } = running('coder')
    const res = await callText(await connect(teamRun(id)), 'report_result', {
      outcome: 'not_done',
      summary: 'The API key is missing.',
      deliverables: ['notes.md'],
    })
    expect(res.isError).toBe(false)
    expect(readResultClaim(db, execId)).toEqual({
      outcome: 'not_done',
      summary: 'The API key is missing.',
      deliverables: ['notes.md'],
    })
    expect(getTask(db, id)?.status).toBe('in_progress')
  })

  it('tells the agent it is a report, so it does not wait for the card to move', async () => {
    const { id } = running('coder')
    const res = await callText(await connect(teamRun(id)), 'report_result', {
      outcome: 'done',
      summary: 'Parser written.',
    })
    expect(res.text).toMatch(/report/i)
    expect(res.text).toMatch(/board decides/i)
  })

  it('is served to a Native team session, which sees only the reads and these', async () => {
    const { id } = running('coder')
    const names = await listToolNames(await connect({ ...teamRun(id), readOnly: true }))
    expect(names).toEqual(
      expect.arrayContaining([
        'list_tasks',
        'get_task',
        'ask_person',
        'report_result',
        'write_plan',
      ]),
    )
    expect(names).toHaveLength(5)
  })

  it('takes a run’s own task by its id, and refuses another task', async () => {
    const { id, execId } = running('coder')
    const other = running('someone')
    const client = await connect(teamRun(id))
    const refused = await callText(client, 'report_result', {
      taskId: other.id,
      outcome: 'done',
      summary: 'Their work is fine.',
    })
    expect(refused.isError).toBe(true)
    expect(refused.text).toMatch(/only on the task you are working on/)
    expect(readResultClaim(db, other.execId)).toBeNull()

    const own = await callText(client, 'report_result', {
      taskId: id,
      outcome: 'done',
      summary: 'Mine is.',
    })
    expect(own.isError).toBe(false)
    expect(readResultClaim(db, execId)?.summary).toBe('Mine is.')
  })

  it('is not served to a caller with no bound task, agent or team run', async () => {
    const { id } = running('coder')
    expect(await listToolNames(await connect())).not.toContain('report_result')
    expect(
      await listToolNames(await connect({ boundScope: { teamId: 'A', agentId: 'coder' } })),
    ).not.toContain('report_result')
    expect(
      await listToolNames(
        await connect({ boundScope: { teamId: 'A', agentId: 'coder', taskId: id } }),
      ),
    ).not.toContain('report_result')
  })

  it('is not served to an unverified caller, and a call gets the refusal the tools give', async () => {
    const { id, execId } = running('coder')
    const client = await connect({ unverifiedCaller: true })
    expect(await listToolNames(client)).not.toContain('report_result')
    const res = await callText(client, 'report_result', {
      taskId: id,
      outcome: 'done',
      summary: 'Trust me.',
    }).catch((err: unknown) => ({ isError: true, text: String(err) }))
    expect(res.isError).toBe(true)
    expect(readResultClaim(db, execId)).toBeNull()
  })

  it('refuses a run that is over, and a task the agent is not working on', async () => {
    const { id, execId } = running('coder')
    completeExecutionProcess(db, execId, { status: 'succeeded' })
    const over = await callText(await connect(teamRun(id)), 'report_result', {
      outcome: 'done',
      summary: 'Late.',
    })
    expect(over.isError).toBe(true)
    expect(over.text).toMatch(/no run/i)

    const theirs = running('someone')
    const res = await callText(await connect(teamRun(theirs.id, 'coder')), 'report_result', {
      outcome: 'done',
      summary: 'Not mine.',
    })
    expect(res.isError).toBe(true)
    expect(res.text).toMatch(/not working on/)
    expect(listExecutions(db, theirs.id)[0]?.resultClaim).toBeNull()
  })

  it('writes on the run its URL names: an older session cannot speak for a newer run', async () => {
    const { id, execId } = running('coder')
    completeExecutionProcess(db, execId, { status: 'succeeded' })
    updateStatus(db, id, 'todo')
    const next = claimTask(db, id, 'coder', 'claude-code', { run: { executorType: 'openclaw' } })
      .execution!.id
    const old = await connect({
      boundScope: { teamId: 'A', agentId: 'coder', taskId: id, executionId: execId },
      teamRun: true,
    })
    const refused = await callText(old, 'report_result', { outcome: 'done', summary: 'Old news.' })
    expect(refused.isError).toBe(true)
    expect(refused.text).toMatch(/no run/i)
    expect(readResultClaim(db, next)).toBeNull()

    const own = await connect({
      boundScope: { teamId: 'A', agentId: 'coder', taskId: id, executionId: next },
      teamRun: true,
    })
    const res = await callText(own, 'report_result', { outcome: 'done', summary: 'This run.' })
    expect(res.isError).toBe(false)
    expect(readResultClaim(db, next)?.summary).toBe('This run.')
  })

  it('needs a summary, in words the model can act on', async () => {
    const { id, execId } = running('coder')
    const res = await callText(await connect(teamRun(id)), 'report_result', {
      outcome: 'done',
      summary: '   ',
    })
    expect(res.isError).toBe(true)
    expect(res.text).toMatch(/summary/)
    expect(readResultClaim(db, execId)).toBeNull()
  })
})
