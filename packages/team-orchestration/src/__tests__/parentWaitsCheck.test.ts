// When a parent's own work is checked: once, at the end of its follow-up turn, when the
// work it handed out has closed. A check at the end of its first run would measure a
// folder its own sub-tasks are still writing, and would hold for them to leave it.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { RuntimeEvent } from '@clawboo/executor'

import {
  createBoardOrchestrator,
  REFLECT_WINDOW_MS,
  type KnownAgent,
  type PreparedWorkCheck,
  type WorkCheck,
  type WorkCheckResult,
} from '../boardOrchestration'
import { MemoryReportUps } from '../contract'
import type { TurnOrigin } from '../turnOrigin'
import { FakeBoard } from './fakeBoard'

const KNOWN: KnownAgent[] = [
  { id: 'leader', name: 'Boo Zero' },
  { id: 'a2', name: 'Bug Boo' },
  { id: 'a3', name: 'Design Boo' },
]
const sk = (id: string): string => `agent:${id}:team:t1`
const agentIdForSession = (s: string): string | null => s.match(/^agent:([^:]+):/)?.[1] ?? null
const done = (runId: string, summary: string): RuntimeEvent => ({
  kind: 'done',
  reason: 'success',
  summary,
  runId,
  sessionId: null,
  ts: 1,
  seq: 1,
})

type Delivered = { agentId: string; task: string; origin: TurnOrigin }

function harness(verdicts: WorkCheckResult[]) {
  const board = new FakeBoard()
  const delivered: Delivered[] = []
  const prepared: string[] = []
  const held: string[] = []
  const checked: string[] = []
  const workCheck: WorkCheck = {
    async begin() {},
    async prepare(taskId) {
      prepared.push(taskId)
      const check: PreparedWorkCheck = async () => {
        checked.push(taskId)
        await board.updateStatus(taskId, 'in_review')
        const verdict = verdicts.shift() ?? { verdict: 'pass' }
        if (verdict.verdict === 'retry') await board.updateStatus(taskId, 'in_progress')
        if (verdict.verdict === 'failed')
          await board.updateStatus(taskId, 'blocked', {
            waitingOn: { kind: 'verification', state: 'failed' },
          })
        return verdict
      }
      check.hold = async () => {
        held.push(taskId)
        return () => undefined
      }
      return check
    },
  }
  const engine = createBoardOrchestrator({
    teamId: 't1',
    board,
    known: () => KNOWN,
    leaderAgentId: () => 'leader',
    sessionKeyForAgent: sk,
    agentIdForSession,
    deliver: async (_sessionKey, agentId, task, origin) => {
      delivered.push({ agentId, task, origin })
    },
    stopGen: () => 0,
    isSessionOccupied: () => false,
    workCheck,
  })
  return { board, engine, delivered, prepared, held, checked }
}
type H = ReturnType<typeof harness>

/** Lead hands Bug Boo a task, which hands Design Boo a sub-task and ends well. */
async function parked(h: H): Promise<{ top: string; sub: string }> {
  await h.engine.onEvent(sk('leader'), done('r1', '<delegate to="@Bug Boo">top task</delegate>'))
  const top = h.board.created[0]!.id
  await h.engine.onEvent(
    sk('a2'),
    done('r2', 'my half. <delegate to="@Design Boo">part a</delegate>'),
  )
  return { top, sub: h.board.created.find((t) => t.title === 'part a')!.id }
}
/** The sub-task ends well, is checked, and its parent's follow-up starts. */
async function subDone(h: H): Promise<void> {
  await h.engine.onEvent(sk('a3'), done('r3', 'a result'))
  await vi.advanceTimersByTimeAsync(0)
}

beforeEach(() => vi.useFakeTimers())
afterEach(() => vi.useRealTimers())

describe('results a run could not take', () => {
  it('earn one more turn, not a loop, and then go out on the closed task', async () => {
    // A host that never hands a run its results: nothing here can ever settle them.
    const board = new FakeBoard()
    const delivered: Delivered[] = []
    const engine = createBoardOrchestrator({
      teamId: 't1',
      board,
      known: () => KNOWN,
      leaderAgentId: () => 'leader',
      sessionKeyForAgent: sk,
      agentIdForSession,
      deliver: async (_sessionKey, agentId, task, origin) => {
        delivered.push({ agentId, task, origin })
      },
      stopGen: () => 0,
      isSessionOccupied: () => false,
      reportUps: new MemoryReportUps(),
    })
    await engine.onEvent(sk('leader'), done('r1', '<delegate to="@Bug Boo">top task</delegate>'))
    const top = board.created[0]!.id
    await engine.onEvent(sk('a2'), done('r2', '<delegate to="@Design Boo">part a</delegate>'))
    await engine.onEvent(sk('a3'), done('r3', 'a result'))
    await vi.advanceTimersByTimeAsync(0)
    const turns = (): Delivered[] => delivered.filter((d) => d.origin.kind === 'wake')
    expect(turns()).toHaveLength(1)

    // The first follow-up ends with the result still unheard: the same one it started
    // with is new to the guard, so that is one more turn, and the next is not.
    await engine.onEvent(sk('a2'), done('r4', 'the first follow-up'))
    await vi.advanceTimersByTimeAsync(0)
    expect(turns()).toHaveLength(2)
    await engine.onEvent(sk('a2'), done('r5', 'the second follow-up'))
    await vi.advanceTimersByTimeAsync(REFLECT_WINDOW_MS)
    expect(turns()).toHaveLength(2)
    expect(board.statusOf(top)).toBe('done')
    // Nothing is lost: it goes out as a follow-up on the task that closed.
    await engine.sweepStaleSessions()
    await vi.advanceTimersByTimeAsync(REFLECT_WINDOW_MS)
    const late = delivered.find((d) => d.agentId === 'a2' && d.task.includes('a result'))
    expect(late?.origin).toMatchObject({ kind: 'system', forTaskId: top })
  })
})

describe('a parent’s own check', () => {
  it('does not run, or hold, at the end of the run that handed the work out', async () => {
    const h = harness([])
    const { top } = await parked(h)
    expect(h.prepared).toEqual([])
    expect(h.held).toEqual([])
    expect(h.board.statusOf(top)).toBe('blocked')
  })

  it('runs once, at the end of the follow-up, and only then is the parent done', async () => {
    const h = harness([])
    const { top, sub } = await parked(h)
    await subDone(h)
    // The sub-task's own check, and nothing of the parent's yet.
    expect(h.checked).toEqual([sub])
    expect(h.board.statusOf(top)).toBe('in_progress')

    await h.engine.onEvent(sk('a2'), done('r4', 'fits together'))
    await vi.advanceTimersByTimeAsync(0)
    expect(h.prepared).toEqual([sub, top])
    expect(h.checked).toEqual([sub, top])
    expect(h.held).toEqual([sub, top])
    expect(h.board.statusOf(top)).toBe('done')
  })

  it('a failure with an attempt left is a fix round for the parent’s agent, not a Done', async () => {
    const h = harness([{ verdict: 'pass' }, { verdict: 'retry', fixNote: 'tests are red' }])
    const { top } = await parked(h)
    await subDone(h)
    await h.engine.onEvent(sk('a2'), done('r4', 'fits together'))
    await vi.advanceTimersByTimeAsync(0)
    expect(h.board.statusOf(top)).toBe('in_progress')
    const fix = h.delivered.filter((d) => d.agentId === 'a2').at(-1)!
    expect(fix.task).toContain('tests are red')

    await h.engine.onEvent(sk('a2'), done('r5', 'fixed'))
    await vi.advanceTimersByTimeAsync(0)
    expect(h.board.statusOf(top)).toBe('done')
  })

  it('a success claim over a failing check does not reach Done', async () => {
    const h = harness([{ verdict: 'pass' }, { verdict: 'failed', reason: 'tests are red' }])
    const { top } = await parked(h)
    await subDone(h)
    h.board.seedResultClaim(top, { outcome: 'done', summary: 'All good, trust me.' })
    await h.engine.onEvent(sk('a2'), done('r4', 'fits together'))
    await vi.advanceTimersByTimeAsync(REFLECT_WINDOW_MS)
    expect(h.board.statusOf(top)).toBe('blocked')
    const update = h.delivered.find(
      (d) => d.agentId === 'leader' && d.task.includes('[Task Update]'),
    )
    expect(update!.task).toContain('DID NOT COMPLETE')
  })

  it('a failure claim is not checked: nothing it could say would change the answer', async () => {
    const h = harness([])
    await h.engine.onEvent(sk('leader'), done('r1', '<delegate to="@Bug Boo">top task</delegate>'))
    const top = h.board.created[0]!.id
    h.board.seedResultClaim(top, { outcome: 'not_done', summary: 'Wrong approach.' })
    await h.engine.onEvent(sk('a2'), done('r2', 'stopping here'))
    await vi.advanceTimersByTimeAsync(0)
    expect(h.prepared).toEqual([])
    expect(h.board.statusOf(top)).toBe('blocked')
  })

  it('a task with nothing handed out is checked when its run ends, as before', async () => {
    const h = harness([])
    await h.engine.onEvent(sk('leader'), done('r1', '<delegate to="@Bug Boo">top task</delegate>'))
    const top = h.board.created[0]!.id
    await h.engine.onEvent(sk('a2'), done('r2', 'done alone'))
    await vi.advanceTimersByTimeAsync(0)
    expect(h.prepared).toEqual([top])
    expect(h.board.statusOf(top)).toBe('done')
  })

  it('an agent that chose to wait on its sub-tasks is checked after its follow-up too', async () => {
    const h = harness([])
    await h.engine.onEvent(sk('leader'), done('r1', '<delegate to="@Bug Boo">top task</delegate>'))
    const top = h.board.created[0]!.id
    await h.engine.onEvent(sk('a2'), {
      kind: 'tool-call',
      toolCallId: 'tc',
      name: 'team_delegate',
      input: { assignee: 'Design Boo', task: 'part a' },
      partial: false,
      runId: 'r2',
      sessionId: null,
      ts: 1,
      seq: 1,
    })
    await h.board.updateStatus(top, 'blocked', { waitingOn: { kind: 'subtasks' } })
    await h.engine.onEvent(sk('a2'), done('r2', 'waiting on part a'))
    await vi.advanceTimersByTimeAsync(0)
    expect(h.prepared).toEqual([])
    expect(h.board.statusOf(top)).toBe('blocked')
    // Its delegator hears it waits, as it does for any wait the agent chose.
    await vi.advanceTimersByTimeAsync(REFLECT_WINDOW_MS)
    expect(
      h.delivered.find((d) => d.agentId === 'leader' && d.task.includes('[Task Update]'))!.task,
    ).toContain('waiting on other work')
  })
})
