// A pause stops the runs it covers within seconds: not a person pressing Stop, which
// is a decision about the task and never re-fires it, but a wait. The task goes back
// to To do with its binding, the ledger says a pause stopped the run, and the pump
// fires it again as soon as nothing refuses the claim. What a pause does not cover
// is untouched, and nothing here reaches the delegator.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { ledgerAllowsAutoFire, PAUSED_RUN_CLASS, stoppedByPause } from '@clawboo/board-core'
import type { RuntimeEvent } from '@clawboo/executor'

import { createBoardOrchestrator, type KnownAgent } from '../boardOrchestration'
import type { TurnOrigin } from '../turnOrigin'
import { FakeBoard } from './fakeBoard'

const KNOWN: KnownAgent[] = [
  { id: 'leader', name: 'Boo Zero' },
  { id: 'a2', name: 'Bug Boo' },
  { id: 'a3', name: 'Design Boo' },
]
const NOTE = 'Paused by a person. This run was stopped and starts again on resume.'

const sk = (id: string): string => `agent:${id}:team:t1`
const agentIdForSession = (s: string): string | null => s.match(/^agent:([^:]+):/)?.[1] ?? null

function doneEvent(runId: string, summary: string): RuntimeEvent {
  return { kind: 'done', reason: 'success', summary, runId, sessionId: null, ts: 1, seq: 1 }
}
function abortedEvent(runId: string): RuntimeEvent {
  return { kind: 'done', reason: 'aborted', summary: '', runId, sessionId: null, ts: 1, seq: 1 }
}

type Delivered = { sessionKey: string; agentId: string; task: string; origin: TurnOrigin }

function makeHarness() {
  const board = new FakeBoard()
  const delivered: Delivered[] = []
  const aborted: string[] = []
  const engine = createBoardOrchestrator({
    teamId: 't1',
    board,
    known: () => KNOWN,
    leaderAgentId: () => 'leader',
    sessionKeyForAgent: sk,
    agentIdForSession,
    deliver: async (sessionKey, agentId, task, origin) => {
      delivered.push({ sessionKey, agentId, task, origin })
    },
    stopGen: () => 0,
    isSessionBusy: () => false,
    isSessionOccupied: () => false,
    abortSession: (s) => aborted.push(s),
  })
  return { board, delivered, aborted, engine }
}

async function running(h: ReturnType<typeof makeHarness>, who = '@Bug Boo', agent = 'a2') {
  await h.engine.onEvent(
    sk('leader'),
    doneEvent('r1', `<delegate to="${who}">fix the login bug</delegate>`),
  )
  const id = h.board.created.at(-1)!.id
  const execId = h.engine.execForSession(sk(agent))
  expect(execId).not.toBeNull()
  expect(h.board.statusOf(id)).toBe('in_progress')
  return { id, execId: execId! }
}

const everything = (): boolean => true

beforeEach(() => vi.useFakeTimers())
afterEach(() => {
  vi.clearAllTimers()
  vi.useRealTimers()
})

describe('pauseRuns', () => {
  it('stops the run, closes it as paused, and puts the task back in To do with its binding', async () => {
    const h = makeHarness()
    const { id, execId } = await running(h)
    const stopped = await h.engine.pauseRuns(everything, NOTE)

    expect(stopped).toEqual([id])
    expect(h.aborted).toEqual([sk('a2')])
    expect(h.board.completed).toContainEqual({
      execId,
      outcome: { status: 'cancelled', byPerson: false, error: NOTE, errorClass: PAUSED_RUN_CLASS },
    })
    expect(h.board.statusOf(id)).toBe('todo')
    expect(h.engine.taskForSession(sk('a2'))).toBeNull()
    const row = h.board.tasks.get(id)!
    expect(row.sourceDelegationId).toContain(':agent:a2')
  })

  it("closes it as nobody's Stop, which is what lets what it carried go back to waiting", async () => {
    const h = makeHarness()
    await running(h)
    await h.engine.pauseRuns(everything, NOTE)
    expect(h.board.completed.at(-1)!.outcome).toMatchObject({ byPerson: false })
  })

  it('leaves a task its own agent blocked Blocked, with no promise that it starts again', async () => {
    const h = makeHarness()
    const { id, execId } = await running(h)
    await h.board.updateStatus(id, 'blocked')

    expect(await h.engine.pauseRuns(everything, NOTE)).toEqual([id])

    expect(h.board.statusOf(id)).toBe('blocked')
    expect(h.board.completed.at(-1)).toMatchObject({
      execId,
      outcome: { status: 'cancelled', errorClass: PAUSED_RUN_CLASS },
    })
    expect(h.board.comments.map((c) => c.body)).not.toContain(NOTE)
    expect(h.engine.taskForSession(sk('a2'))).toBeNull()
  })

  it('leaves a card its agent moved In review for a person, with its reason', async () => {
    const h = makeHarness()
    const { id } = await running(h)
    await h.board.updateStatus(id, 'in_review', {
      waitingOn: { kind: 'person', need: 'Check the numbers', by: 'agent' },
    })
    await h.engine.pauseRuns(everything, NOTE)
    expect(h.board.statusOf(id)).toBe('in_review')
    expect(h.board.comments.map((c) => c.body)).not.toContain(NOTE)
    expect(h.board.completed.at(-1)?.outcome).toMatchObject({ errorClass: PAUSED_RUN_CLASS })
  })

  it('takes the two moves a task needs from In review', async () => {
    const h = makeHarness()
    const { id } = await running(h)
    await h.board.updateStatus(id, 'in_review')
    await h.engine.pauseRuns(everything, NOTE)
    expect(h.board.statusOf(id)).toBe('todo')
    expect(h.board.comments.map((c) => c.body)).toContain(NOTE)
  })

  it("leaves a ledger the fire policy reads as free to run again, unlike a person's Stop", async () => {
    const h = makeHarness()
    const { id } = await running(h)
    await h.engine.pauseRuns(everything, NOTE)
    const ledger = await h.board.listExecutions(id)
    expect(stoppedByPause(ledger.at(-1))).toBe(true)
    expect(ledgerAllowsAutoFire(ledger)).toBe(true)
  })

  it('says so on the task, and tells no delegator: the work is coming back', async () => {
    const h = makeHarness()
    const { id } = await running(h)
    const before = h.delivered.length
    await h.engine.pauseRuns(everything, NOTE)
    await vi.advanceTimersByTimeAsync(10_000)
    expect(h.delivered).toHaveLength(before)
    expect(h.board.comments).toContainEqual({ taskId: id, body: NOTE })
  })

  it("ignores the stopped run's late ending: it neither finishes nor fails the task", async () => {
    const h = makeHarness()
    const { id } = await running(h)
    await h.engine.pauseRuns(everything, NOTE)
    await h.engine.onEvent(sk('a2'), abortedEvent('r2'))
    await h.engine.onEvent(sk('a2'), doneEvent('r2', 'finished anyway'))
    expect(h.board.statusOf(id)).toBe('todo')
  })

  it('touches only what the pause covers', async () => {
    const h = makeHarness()
    const { id: a2Task } = await running(h)
    const { id: a3Task } = await running(h, '@Design Boo', 'a3')
    const stopped = await h.engine.pauseRuns(({ agentId }) => agentId === 'a3', NOTE)
    expect(stopped).toEqual([a3Task])
    expect(h.aborted).toEqual([sk('a3')])
    expect(h.board.statusOf(a2Task)).toBe('in_progress')
    expect(h.engine.taskForSession(sk('a2'))).toBe(a2Task)
  })

  it('matches by task too, for a task tree', async () => {
    const h = makeHarness()
    const { id } = await running(h)
    expect(await h.engine.pauseRuns(({ taskId }) => taskId === 'other', NOTE)).toEqual([])
    expect(await h.engine.pauseRuns(({ taskId }) => taskId === id, NOTE)).toEqual([id])
  })

  it('closes a run the engine only re-attached after a restart', async () => {
    const h = makeHarness()
    const { id, execId } = await running(h)
    const rebuilt = createBoardOrchestrator({
      teamId: 't1',
      board: h.board,
      known: () => KNOWN,
      leaderAgentId: () => 'leader',
      sessionKeyForAgent: sk,
      agentIdForSession,
      deliver: async () => undefined,
      stopGen: () => 0,
      isSessionBusy: () => false,
      isSessionOccupied: () => false,
      abortSession: () => undefined,
    })
    await rebuilt.resume()
    expect(rebuilt.taskForSession(sk('a2'))).toBe(id)
    await rebuilt.pauseRuns(everything, NOTE)
    expect(h.board.completed).toContainEqual({
      execId,
      outcome: { status: 'cancelled', byPerson: false, error: NOTE, errorClass: PAUSED_RUN_CLASS },
    })
    expect(h.board.statusOf(id)).toBe('todo')
  })

  it('fires the task again once nothing refuses it (the resume)', async () => {
    const h = makeHarness()
    const { id } = await running(h)
    const before = h.delivered.length
    await h.engine.pauseRuns(everything, NOTE)
    await h.engine.resume()
    await vi.advanceTimersByTimeAsync(1)
    expect(h.delivered.length).toBe(before + 1)
    expect(h.delivered.at(-1)!.agentId).toBe('a2')
    expect(h.board.statusOf(id)).toBe('in_progress')
  })

  it('leaves a task alone when another stop already took it while a read was out', async () => {
    const h = makeHarness()
    const { id } = await running(h)
    await h.engine.pauseRuns(everything, NOTE)
    // Nothing is mapped now, so a second pause covering it does nothing at all.
    expect(await h.engine.pauseRuns(everything, NOTE)).toEqual([])
    expect(h.board.statusOf(id)).toBe('todo')
  })
})

describe('a follow-up a pause stopped', () => {
  it('is not a failure: no comment, no update to its delegator, and its run goes back to pending', async () => {
    const h = makeHarness()
    const { id } = await running(h)
    await h.engine.onEvent(sk('a2'), doneEvent('r2', 'done'))
    await vi.advanceTimersByTimeAsync(5_000)
    const before = h.delivered.length
    const comments = h.board.comments.length

    await h.engine.onEvent(sk('a2'), abortedEvent('r3'), {
      reportForTaskId: id,
      stopGen: 0,
      stoppedByPause: true,
    })
    await vi.advanceTimersByTimeAsync(5_000)

    expect(h.delivered).toHaveLength(before)
    expect(h.board.comments).toHaveLength(comments)
  })

  it('a follow-up cut short by anything else still reports that it did not finish', async () => {
    const h = makeHarness()
    const { id } = await running(h)
    await h.engine.onEvent(sk('a2'), doneEvent('r2', 'done'))
    await vi.advanceTimersByTimeAsync(5_000)
    await h.engine.onEvent(sk('a2'), abortedEvent('r3'), { reportForTaskId: id, stopGen: 0 })
    expect(h.board.comments.some((c) => c.body.includes('Follow-up did not finish'))).toBe(true)
  })
})
