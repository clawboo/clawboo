// A run that asked a person ends through the engine's self-block ending, with its own
// report: the delegator learns the task waits on an answer, not that it failed. And
// the engine's own parks say what the task waits for.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { RuntimeEvent } from '@clawboo/executor'

import { createBoardOrchestrator, REFLECT_WINDOW_MS, type KnownAgent } from '../boardOrchestration'
import { buildTaskUpdateMessage } from '../taskUpdate'
import type { WorkCheck } from '../boardOrchestration'
import type { TurnOrigin } from '../turnOrigin'
import { FakeBoard } from './fakeBoard'

const KNOWN: KnownAgent[] = [
  { id: 'leader', name: 'Boo Zero' },
  { id: 'a2', name: 'Bug Boo' },
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
const failed = (runId: string): RuntimeEvent => ({
  kind: 'done',
  reason: 'error',
  summary: '',
  runId,
  sessionId: null,
  ts: 1,
  seq: 1,
})

type Delivered = { sessionKey: string; agentId: string; task: string; origin: TurnOrigin }

function harness(workCheck?: WorkCheck) {
  const board = new FakeBoard()
  const delivered: Delivered[] = []
  const orchestrator = createBoardOrchestrator({
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
    ...(workCheck ? { workCheck } : {}),
  })
  return { board, delivered, orchestrator }
}

async function running(h: ReturnType<typeof harness>): Promise<string> {
  await h.orchestrator.onEvent(
    sk('leader'),
    done('r1', '<delegate to="@Bug Boo">fix it</delegate>'),
  )
  return h.board.created[0]!.id
}

/** What the agent's `ask_person` writes: the card Blocked, waiting on the question. */
function asks(board: FakeBoard, taskId: string): void {
  board.tasks.get(taskId)!.status = 'blocked'
  board.waits.set(taskId, { kind: 'question', questionId: 'q1' })
}

beforeEach(() => vi.useFakeTimers())
afterEach(() => vi.useRealTimers())

describe('a run that asked a person', () => {
  it('closes as succeeded, keeps its reply, stays Blocked, and tells the delegator it waits', async () => {
    const h = harness()
    const id = await running(h)
    asks(h.board, id)
    await h.orchestrator.onEvent(sk('a2'), done('r2', 'I asked which colour to use.'))

    expect(h.board.statusOf(id)).toBe('blocked')
    expect(h.board.completed.at(-1)?.outcome.status).toBe('succeeded')
    expect(h.board.comments.some((c) => c.body === 'I asked which colour to use.')).toBe(true)

    await vi.advanceTimersByTimeAsync(REFLECT_WINDOW_MS)
    const update = h.delivered.find((d) => d.task.startsWith('[Task Update]'))
    expect(update?.agentId).toBe('leader')
    expect(update?.task).toContain('asked a person a question and waits for the answer')
    expect(update?.task).toContain('Do NOT redo or reassign')
    // Not reported as work that failed.
    expect(update?.task).not.toContain('DID NOT COMPLETE')
    // And the question's reason survives the run's end.
    expect(h.board.waits.get(id)).toEqual({ kind: 'question', questionId: 'q1' })
  })

  it('a bare block still reports as a block', async () => {
    const h = harness()
    const id = await running(h)
    h.board.tasks.get(id)!.status = 'blocked'
    await h.orchestrator.onEvent(sk('a2'), done('r2', 'I need the key.'))
    await vi.advanceTimersByTimeAsync(REFLECT_WINDOW_MS)
    const update = h.delivered.find((d) => d.task.startsWith('[Task Update]'))
    expect(update?.task).toContain('marked it blocked')
  })

  it('renders a mix of waiting and failed work apart', () => {
    const msg = buildTaskUpdateMessage([
      { by: 'A', summary: 'asked', outcome: 'asked' },
      { by: 'B', summary: 'boom', outcome: 'error' },
    ])
    expect(msg).toContain('1 of these are waiting')
    expect(msg).toContain('1 of these did NOT complete')
  })
})

describe('a run that fails after its agent parked the task', () => {
  const reportOf = async (h: ReturnType<typeof harness>): Promise<string> => {
    await vi.advanceTimersByTimeAsync(REFLECT_WINDOW_MS)
    return h.delivered.find((d) => d.task.startsWith('[Task Update]'))?.task ?? ''
  }

  it('after asking: the question stands, the run closes failed, and no one is told to redo it', async () => {
    const h = harness()
    const id = await running(h)
    const cancel = vi.spyOn(h.board, 'cancelDependents')
    asks(h.board, id)
    await h.orchestrator.onEvent(sk('a2'), failed('r2'))

    expect(h.board.statusOf(id)).toBe('blocked')
    expect(h.board.waits.get(id)).toEqual({ kind: 'question', questionId: 'q1' })
    expect(h.board.completed.at(-1)?.outcome.status).toBe('failed')
    expect(cancel).not.toHaveBeenCalled()

    const update = await reportOf(h)
    expect(update).toContain('asked a person a question and waits for the answer')
    expect(update).toContain('Do NOT redo or reassign')
    expect(update).not.toContain('DID NOT COMPLETE')
  })

  it('after a hand-back: what the person must do survives, and the plan stays queued', async () => {
    const h = harness()
    const id = await running(h)
    const cancel = vi.spyOn(h.board, 'cancelDependents')
    const need = { kind: 'person', need: 'Log in', by: 'agent' } as const
    h.board.tasks.get(id)!.status = 'blocked'
    h.board.waits.set(id, need)
    await h.orchestrator.onEvent(sk('a2'), failed('r2'))

    expect(h.board.waits.get(id)).toEqual(need)
    expect(cancel).not.toHaveBeenCalled()
    expect(await reportOf(h)).toContain('marked it blocked')
  })

  it('after a wait on other work: it still waits, and is not reported as failed', async () => {
    const h = harness()
    const id = await running(h)
    const cancel = vi.spyOn(h.board, 'cancelDependents')
    h.board.tasks.get(id)!.status = 'blocked'
    h.board.waits.set(id, { kind: 'task', taskId: 'other' })
    await h.orchestrator.onEvent(sk('a2'), failed('r2'))

    expect(h.board.waits.get(id)).toEqual({ kind: 'task', taskId: 'other' })
    expect(cancel).not.toHaveBeenCalled()
    const update = await reportOf(h)
    expect(update).not.toContain('DID NOT COMPLETE')
    expect(update).toContain('waiting on other work')
  })

  it('a task Blocked for another reason is still the failure it was', async () => {
    const h = harness()
    const id = await running(h)
    h.board.tasks.get(id)!.status = 'blocked'
    h.board.waits.set(id, { kind: 'budget' })
    await h.orchestrator.onEvent(sk('a2'), failed('r2'))
    expect(h.board.waits.get(id)).toEqual({ kind: 'failure' })
    expect(await reportOf(h)).toContain('DID NOT COMPLETE')
  })
})

describe('a run that waits on other work', () => {
  for (const wait of [{ kind: 'task', taskId: 'other' }, { kind: 'subtasks' }] as const) {
    it(`on ${wait.kind}: told apart from a failure, with no invitation to redo it`, async () => {
      const h = harness()
      const id = await running(h)
      h.board.tasks.get(id)!.status = 'blocked'
      h.board.waits.set(id, wait)
      await h.orchestrator.onEvent(sk('a2'), done('r2', 'Waiting for that to land.'))
      await vi.advanceTimersByTimeAsync(REFLECT_WINDOW_MS)
      const update = h.delivered.find((d) => d.task.startsWith('[Task Update]'))?.task ?? ''
      expect(update).toContain('waiting on other work')
      expect(update).toContain('Do NOT redo or reassign')
      expect(update).not.toContain('DID NOT COMPLETE')
      expect(update).not.toMatch(/retry, reassign/)
      expect(h.board.completed.at(-1)?.outcome.status).toBe('succeeded')
    })
  }

  it('renders apart from an asked task and from a failed one', () => {
    const msg = buildTaskUpdateMessage([
      { by: 'A', summary: 'asked', outcome: 'asked' },
      { by: 'W', summary: 'waiting', outcome: 'waiting' },
      { by: 'B', summary: 'boom', outcome: 'error' },
    ])
    expect(msg).toContain('1 of these are waiting for a person')
    expect(msg).toContain('1 of these are waiting on other work')
    expect(msg).toContain('1 of these did NOT complete')
  })
})

describe('the engine’s parks say why', () => {
  it('a failed run waits on a failure', async () => {
    const h = harness()
    const id = await running(h)
    await h.orchestrator.onEvent(sk('a2'), failed('r2'))
    expect(h.board.statusOf(id)).toBe('blocked')
    expect(h.board.waits.get(id)).toEqual({ kind: 'failure' })
  })

  it('a check that failed for good waits on verification', async () => {
    const h = harness({
      begin: async () => undefined,
      prepare: async () => ({
        run: async () => ({ verdict: 'failed' as const, reason: 'It does not build.' }),
      }),
    } as unknown as WorkCheck)
    const id = await running(h)
    await h.orchestrator.onEvent(sk('a2'), done('r2', 'all done'))
    await vi.runAllTimersAsync()
    expect(h.board.statusOf(id)).toBe('blocked')
    expect(h.board.waits.get(id)?.kind).toBe('verification')
  })
})
