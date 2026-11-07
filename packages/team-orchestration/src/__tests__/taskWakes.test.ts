// The engine's half of a saved wake. The durable row lives in the host's database,
// so these scenarios play it with an in-memory board: a claim hands the run the
// wakes that were waiting, the run's stamp carries their ids to its end, and a
// person's comment the run never heard gets a turn of its own before Done.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { RuntimeEvent } from '@clawboo/executor'
import { isPolicyDenialCode } from '@clawboo/governance'

import type { ClaimResult, ClaimRun, CompleteExecutionOutcome, ExecutionRef } from '../boardClient'
import {
  createBoardOrchestrator,
  REFLECT_WINDOW_MS,
  type KnownAgent,
  type TaskWakeOutbox,
  type WorkCheck,
  type WorkCheckResult,
} from '../boardOrchestration'
import { BUDGET_REFUSED_CODE, DeliveryRefusedError } from '../deliveryRefused'
import { classifyTurn, isChatVisible, type RunStamp, type TurnOrigin } from '../turnOrigin'
import { FakeBoard } from './fakeBoard'

const KNOWN: KnownAgent[] = [
  { id: 'leader', name: 'Boo Zero' },
  { id: 'a2', name: 'Bug Boo' },
  { id: 'a3', name: 'Doc Boo' },
]
const sk = (id: string): string => `agent:${id}:team:t1`
const agentIdForSession = (s: string): string | null => s.match(/^agent:([^:]+):/)?.[1] ?? null
const BOUND = 'r0:deleg:agent:a2:reflectTo:leader'

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
  kind: 'error',
  code: null,
  message: 'provider said no',
  fatal: true,
  runId,
  sessionId: null,
  ts: 1,
  seq: 1,
})

type Delivered = { sessionKey: string; agentId: string; task: string; origin: TurnOrigin }

/** A board whose claim writes the run and hands over the waiting wakes, as the
 *  server's does in one transaction. */
class WakeBoard extends FakeBoard {
  waiting = new Map<string, Array<{ id: string; reason: string; commentIds: string[] }>>()
  runReasons = new Map<string, string | null>()
  override async claim(
    taskId: string,
    agentId?: string,
    _runtime?: string,
    run?: ClaimRun,
  ): Promise<ClaimResult> {
    const result = await super.claim(taskId, agentId)
    if (!result.ok || !run) return result
    const execution = await this.createExecutionRow(taskId, run.runReason ?? null)
    const wakes = (this.waiting.get(taskId) ?? []).map((w) => ({
      ...w,
      reason: w.reason as 'person_comment',
    }))
    this.waiting.delete(taskId)
    if (wakes[0]) this.runReasons.set(execution.id, wakes[0].reason)
    return { ...result, execution, wakes }
  }
  private async createExecutionRow(taskId: string, reason: string | null): Promise<ExecutionRef> {
    const ref = (await super.createExecution(taskId)) as ExecutionRef
    this.runReasons.set(ref.id, reason)
    return ref
  }
  override async createExecution(
    taskId: string,
    _executorType?: string,
    opts?: { runReason?: string },
  ): Promise<ExecutionRef | null> {
    return this.createExecutionRow(taskId, opts?.runReason ?? null)
  }
  addTask(sourceDelegationId: string, title = 'fix the bug'): string {
    const id = `seed-${this.tasks.size + 1}`
    this.tasks.set(id, {
      id,
      status: 'todo',
      parentTaskId: null,
      title,
      description: title,
      sourceDelegationId,
      assigneeAgentId: null,
    })
    return id
  }
  outcomeOf(execId: string): CompleteExecutionOutcome | undefined {
    return this.completed.find((c) => c.execId === execId)?.outcome
  }
}

function harness(
  opts: {
    wakes?: TaskWakeOutbox
    workCheck?: WorkCheck
    occupied?: Set<string>
    gen?: { value: number }
  } = {},
) {
  const board = new WakeBoard()
  const delivered: Delivered[] = []
  const settled: Array<{ ids: string[]; how: string }> = []
  const person = new Map<string, Array<{ id: string; commentIds: string[] }>>()
  const gen = opts.gen ?? { value: 0 }
  const wakes: TaskWakeOutbox = opts.wakes ?? {
    fromPersonWaiting: (taskId) => person.get(taskId) ?? [],
    settle: (ids, how) => {
      settled.push({ ids: [...ids], how })
      return true
    },
    holdAll: () => {
      settled.push({ ids: ['*'], how: 'held' })
      return true
    },
  }
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
    stopGen: () => gen.value,
    isSessionOccupied: (s) => opts.occupied?.has(s) ?? false,
    taskWakes: wakes,
    ...(opts.workCheck ? { workCheck: opts.workCheck } : {}),
  })
  return { board, engine, delivered, settled, person, gen }
}

const flushDeferred = async (): Promise<void> => {
  await vi.advanceTimersByTimeAsync(1)
}
const stampOf = (origin: TurnOrigin, execId?: string): RunStamp => ({
  reportForTaskId: null,
  stopGen: 0,
  ...(execId ? { execId } : {}),
  ...(origin.kind === 'wake' ? { wakeIds: origin.wakeIds } : {}),
})

beforeEach(() => {
  vi.useFakeTimers()
})
afterEach(() => {
  vi.useRealTimers()
})

describe('two tasks for one agent started at once', () => {
  it('only one takes the session: the other waits, and runs after it', async () => {
    const h = harness()
    const a = h.board.addTask(BOUND, 'job one')
    const b = h.board.addTask(BOUND, 'job two')
    const outcomes = await Promise.all([h.engine.dispatchTask(a), h.engine.dispatchTask(b)])
    expect(outcomes).toEqual(['started', 'queued'])
    expect(h.board.claims).toEqual([a])
    expect(h.engine.taskForSession(sk('a2'))).toBe(a)
    expect(h.delivered.map((d) => d.task)).toEqual(['job one'])
    // The first run's result is the first task's, and the second then gets its turn.
    await h.engine.onEvent(sk('a2'), done('r1', 'one is done'))
    expect(h.board.statusOf(a)).toBe('done')
    expect(h.board.statusOf(b)).toBe('todo')
    await flushDeferred()
    expect(h.delivered.map((d) => d.task)).toEqual(['job one', 'job two'])
    expect(h.engine.taskForSession(sk('a2'))).toBe(b)
  })

  it('a hand-off to an agent another start is claiming waits too', async () => {
    const h = harness()
    const id = h.board.addTask(BOUND, 'job one')
    await Promise.all([
      h.engine.dispatchTask(id),
      h.engine.onEvent(sk('leader'), done('r0', '<delegate to="@Bug Boo">job two</delegate>')),
    ])
    expect(h.delivered.filter((d) => d.agentId === 'a2')).toHaveLength(1)
    const inProgress = h.board.allStatuses().filter((st) => st === 'in_progress')
    expect(inProgress).toHaveLength(1)
  })

  it('a claim that lost frees the session for the next start', async () => {
    const h = harness()
    const a = h.board.addTask(BOUND, 'job one')
    h.board.forceClaimConflict = true
    await h.engine.dispatchTask(a)
    h.board.forceClaimConflict = false
    expect(await h.engine.dispatchTask(a)).toBe('started')
  })
})

describe('a wake run', () => {
  it('is delivered with its own origin, naming why and which rows it carries', async () => {
    const h = harness()
    const id = h.board.addTask(BOUND)
    h.board.waiting.set(id, [{ id: 'w1', reason: 'person_comment', commentIds: ['c1'] }])
    await h.engine.dispatchTask(id)
    expect(h.delivered).toHaveLength(1)
    expect(h.delivered[0]!.origin).toEqual({
      kind: 'wake',
      reason: 'person_comment',
      wakeIds: ['w1'],
      fromAgentId: 'leader',
    })
  })

  it('a task a person assigned keeps reporting to them', async () => {
    const h = harness()
    const id = h.board.addTask('assign:n:agent:a2:origin:human')
    h.board.waiting.set(id, [{ id: 'w1', reason: 'person_comment', commentIds: [] }])
    await h.engine.dispatchTask(id)
    expect(h.delivered[0]!.origin).toMatchObject({ kind: 'wake', assigned: true })
    await h.engine.onEvent(sk('a2'), done('r1', 'answered'), stampOf(h.delivered[0]!.origin))
    await vi.advanceTimersByTimeAsync(REFLECT_WINDOW_MS)
    expect(h.delivered.filter((d) => d.task.startsWith('[Task Update]'))).toEqual([])
  })

  it('without a saved wake, a run keeps its usual origin', async () => {
    const h = harness()
    const id = h.board.addTask(BOUND)
    await h.engine.dispatchTask(id)
    expect(h.delivered[0]!.origin).toEqual({ kind: 'delegation', fromAgentId: 'leader' })
  })

  it('is framed as work on its task, and never reaches the chat', () => {
    const origin: TurnOrigin = {
      kind: 'wake',
      reason: 'dependency_done',
      wakeIds: ['w1'],
      fromAgentId: 'leader',
    }
    const framing = classifyTurn({
      origin,
      targetAgentId: 'a2',
      leaderAgentId: 'leader',
      hasBoardTask: true,
    })
    expect(framing.isWorker).toBe(true)
    expect(framing.isLeader).toBe(false)
    expect(framing.isUserFacing).toBe(false)
    expect(framing.isUserAssigned).toBeUndefined()
    expect(isChatVisible(origin, framing)).toBe(false)
    const assigned = classifyTurn({
      origin: { ...origin, assigned: true },
      targetAgentId: 'a2',
      leaderAgentId: 'leader',
      hasBoardTask: true,
    })
    expect(assigned.isUserAssigned).toBe(true)
  })
})

describe('every run says why it started', () => {
  it('a delegation, a person assigning, and a fix round each write their own reason', async () => {
    const results: WorkCheckResult[] = [{ verdict: 'retry', fixNote: 'tests fail' }]
    const check: WorkCheck = {
      begin: async () => undefined,
      prepare: async () => async () => results.shift() ?? { verdict: 'pass' },
    }
    const h = harness({ workCheck: check })
    const delegated = h.board.addTask(BOUND)
    await h.engine.dispatchTask(delegated)
    const assigned = h.board.addTask('assign:n:agent:a3:origin:human')
    await h.engine.dispatchTask(assigned)
    const reasons = [...h.board.runReasons.values()]
    expect(reasons).toEqual(['delegation', 'assignment'])

    await h.engine.onEvent(sk('a2'), done('r1', 'first go'))
    await flushDeferred()
    await vi.waitFor(() => expect([...h.board.runReasons.values()]).toContain('fix_round'))
  })

  it("a run started by a hand-off the engine spawned says it's a delegation", async () => {
    const h = harness()
    await h.engine.onEvent(sk('leader'), done('r0', '<delegate to="@Bug Boo">do it</delegate>'))
    expect([...h.board.runReasons.values()]).toEqual(['delegation'])
  })
})

describe('the stamp carries the rows to the end of the run', () => {
  it('a successful end delivers them, though a work check still holds the run open', async () => {
    const pending: Array<(r: WorkCheckResult) => void> = []
    const check: WorkCheck = {
      begin: async () => undefined,
      prepare: async () => () => new Promise<WorkCheckResult>((resolve) => pending.push(resolve)),
    }
    const h = harness({ workCheck: check })
    const id = h.board.addTask(BOUND)
    h.board.waiting.set(id, [{ id: 'w1', reason: 'person_comment', commentIds: ['c1'] }])
    await h.engine.dispatchTask(id)
    await h.engine.onEvent(sk('a2'), done('r1', 'answered'), stampOf(h.delivered[0]!.origin))
    expect(h.settled).toEqual([{ ids: ['w1'], how: 'delivered' }])
    await vi.waitFor(() => expect(pending).toHaveLength(1))
    pending[0]!({ verdict: 'pass' })
  })

  it('any other end leaves them to the close of its run', async () => {
    const h = harness()
    const id = h.board.addTask(BOUND)
    h.board.waiting.set(id, [{ id: 'w1', reason: 'person_comment', commentIds: [] }])
    await h.engine.dispatchTask(id)
    await h.engine.onEvent(sk('a2'), failed('r1'), stampOf(h.delivered[0]!.origin))
    expect(h.settled).toEqual([])
  })

  it("a terminal from a run that is no longer the task's is not the task's result", async () => {
    const h = harness()
    const id = h.board.addTask(BOUND)
    await h.engine.dispatchTask(id)
    // The task's run is exec-1. A terminal stamped with some other execution
    // arrived after the task moved on to a newer run.
    await h.engine.onEvent(sk('a2'), done('stale', 'old answer'), {
      reportForTaskId: null,
      stopGen: 0,
      execId: 'exec-other',
    })
    expect(h.board.statusOf(id)).toBe('in_progress')
    await h.engine.onEvent(sk('a2'), done('live', 'real answer'), {
      reportForTaskId: null,
      stopGen: 0,
      execId: 'exec-1',
    })
    expect(h.board.statusOf(id)).toBe('done')
  })
})

describe("a person's comment the run did not hear gets the next turn", () => {
  const finishWith = async (h: ReturnType<typeof harness>, summary = 'all done') => {
    await h.engine.onEvent(sk('a2'), done('r1', summary))
    await flushDeferred()
  }

  it('the run ending well does not finish the task over it', async () => {
    const h = harness()
    const id = h.board.addTask(BOUND)
    await h.engine.dispatchTask(id)
    h.person.set(id, [{ id: 'w1', commentIds: ['c1'] }])
    await finishWith(h)
    expect(h.board.statusOf(id)).toBe('in_progress')
    const turn = h.delivered.at(-1)!
    expect(turn.task).toContain('[New comment]')
    expect(turn.task).toContain('fix the bug')
    expect(turn.origin).toMatchObject({
      kind: 'wake',
      reason: 'person_comment',
      wakeIds: ['w1'],
    })
    // The first run closed as the success it was, and its result is on the card.
    expect(h.board.outcomeOf('exec-1')).toMatchObject({ status: 'succeeded', summary: 'all done' })
    expect(h.board.comments.map((c) => c.body)).toContain('all done')
    expect([...h.board.runReasons.values()]).toContain('person_comment')
    expect(h.board.execCount).toBe(2)
  })

  it('that turn ending finishes the task, and reports once', async () => {
    const h = harness()
    const id = h.board.addTask(BOUND)
    await h.engine.dispatchTask(id)
    h.person.set(id, [{ id: 'w1', commentIds: ['c1'] }])
    await finishWith(h)
    h.person.delete(id) // The turn took it when its context rendered.
    await h.engine.onEvent(sk('a2'), done('r2', 'all done, and answered'))
    await vi.advanceTimersByTimeAsync(REFLECT_WINDOW_MS + 1)
    expect(h.board.statusOf(id)).toBe('done')
    const updates = h.delivered.filter((d) => d.task.startsWith('[Task Update]'))
    expect(updates).toHaveLength(1)
    expect(updates[0]!.task).toContain('all done, and answered')
  })

  it('waits for another turn on the session to end first', async () => {
    const occupied = new Set<string>()
    const h = harness({ occupied })
    const id = h.board.addTask(BOUND)
    await h.engine.dispatchTask(id)
    h.person.set(id, [{ id: 'w1', commentIds: ['c1'] }])
    occupied.add(sk('a2'))
    await finishWith(h)
    expect(h.delivered.filter((d) => d.task.includes('[New comment]'))).toEqual([])
    occupied.clear()
    await h.engine.sweepStaleSessions()
    expect(h.delivered.filter((d) => d.task.includes('[New comment]'))).toHaveLength(1)
  })

  it('after a Stop the task is released, with no new turn', async () => {
    const gen = { value: 0 }
    const h = harness({ gen })
    const id = h.board.addTask(BOUND)
    await h.engine.dispatchTask(id)
    h.person.set(id, [{ id: 'w1', commentIds: ['c1'] }])
    gen.value = 1
    await finishWith(h)
    expect(h.delivered.filter((d) => d.task.includes('[New comment]'))).toEqual([])
  })

  it('a task its own agent blocked is not given the turn: the pump restarts it for the comment', async () => {
    const h = harness()
    const id = h.board.addTask(BOUND)
    await h.engine.dispatchTask(id)
    h.person.set(id, [{ id: 'w1', commentIds: ['c1'] }])
    await h.board.updateStatus(id, 'blocked')
    await finishWith(h, 'I need the API key')
    expect(h.board.statusOf(id)).toBe('blocked')
    expect(h.delivered.filter((d) => d.task.includes('[New comment]'))).toEqual([])
  })

  it('a comment that waited through a passing check goes before Done, from In review', async () => {
    const results: Array<(r: WorkCheckResult) => void> = []
    const board = { current: null as WakeBoard | null }
    const check: WorkCheck = {
      begin: async () => undefined,
      prepare: async (taskId) => async () => {
        await board.current!.updateStatus(taskId, 'in_review')
        return new Promise<WorkCheckResult>((resolve) => results.push(resolve))
      },
    }
    const h = harness({ workCheck: check })
    board.current = h.board
    const id = h.board.addTask(BOUND)
    await h.engine.dispatchTask(id)
    await finishWith(h)
    await vi.waitFor(() => expect(results).toHaveLength(1))
    expect(h.board.statusOf(id)).toBe('in_review')
    h.person.set(id, [{ id: 'w1', commentIds: ['c1'] }])
    results[0]!({ verdict: 'pass' })
    await vi.waitFor(() =>
      expect(h.delivered.filter((d) => d.task.includes('[New comment]'))).toHaveLength(1),
    )
    expect(h.board.statusOf(id)).toBe('in_progress')
  })

  it('with nothing waiting, nothing changes', async () => {
    const h = harness()
    const id = h.board.addTask(BOUND)
    await h.engine.dispatchTask(id)
    await finishWith(h)
    expect(h.board.statusOf(id)).toBe('done')
    expect(h.board.execCount).toBe(1)
  })

  it('a busted read of the wakes cannot strand the task', async () => {
    const h = harness({
      wakes: {
        fromPersonWaiting: () => {
          throw new Error('disk gone')
        },
        settle: () => false,
        holdAll: () => false,
      },
    })
    const id = h.board.addTask(BOUND)
    await h.engine.dispatchTask(id)
    await finishWith(h)
    expect(h.board.statusOf(id)).toBe('done')
  })
})

describe('a steer the run heard', () => {
  it('a run that ends well settles everything it carries, even with a check still open', async () => {
    const carriedBy: string[] = []
    const pending: Array<(r: WorkCheckResult) => void> = []
    const check: WorkCheck = {
      begin: async () => undefined,
      prepare: async () => () => new Promise<WorkCheckResult>((resolve) => pending.push(resolve)),
    }
    const h = harness({
      workCheck: check,
      wakes: {
        fromPersonWaiting: () => [],
        settle: () => true,
        holdAll: () => true,
        settleCarriedBy: (execId) => {
          carriedBy.push(execId)
          return true
        },
      },
    })
    const id = h.board.addTask(BOUND)
    await h.engine.dispatchTask(id)
    await h.engine.onEvent(sk('a2'), done('r1', 'answered'), {
      reportForTaskId: null,
      stopGen: 0,
      execId: 'exec-1',
    })
    expect(carriedBy).toEqual(['exec-1'])
  })

  it('a run that fails settles nothing: its close gives the rows back', async () => {
    const carriedBy: string[] = []
    const h = harness({
      wakes: {
        fromPersonWaiting: () => [],
        settle: () => true,
        holdAll: () => true,
        settleCarriedBy: (execId) => {
          carriedBy.push(execId)
          return true
        },
      },
    })
    const id = h.board.addTask(BOUND)
    await h.engine.dispatchTask(id)
    await h.engine.onEvent(sk('a2'), failed('r1'), {
      reportForTaskId: null,
      stopGen: 0,
      execId: 'exec-1',
    })
    expect(carriedBy).toEqual([])
  })
})

describe('a run the host refused for a hard budget', () => {
  const budgetRow = (h: ReturnType<typeof harness>) => h.board.completed.at(-1)?.outcome.errorClass

  it('is filed under its own class, when deliver rejected it', async () => {
    const board = new WakeBoard()
    const id = board.addTask(BOUND)
    const engine = createBoardOrchestrator({
      teamId: 't1',
      board,
      known: () => KNOWN,
      leaderAgentId: () => 'leader',
      sessionKeyForAgent: sk,
      agentIdForSession,
      deliver: async () => {
        throw new DeliveryRefusedError('The team budget is paused at its hard cap.', {
          budget: true,
        })
      },
      stopGen: () => 0,
    })
    await engine.dispatchTask(id)
    expect(board.completed.at(-1)?.outcome).toMatchObject({
      status: 'budget_paused',
      errorClass: 'BudgetRefused',
    })
  })

  it('is filed the same way when it reached the engine as a run ending', async () => {
    const h = harness()
    const id = h.board.addTask(BOUND)
    await h.engine.dispatchTask(id)
    await h.engine.onEvent(sk('a2'), {
      kind: 'error',
      code: BUDGET_REFUSED_CODE,
      message: 'The team budget is paused at its hard cap.',
      fatal: true,
      runId: 'r',
      sessionId: null,
      ts: 1,
      seq: 1,
    })
    expect(budgetRow(h)).toBe('BudgetRefused')
  })

  it('its code is not read as a policy denial', () => {
    expect(isPolicyDenialCode(BUDGET_REFUSED_CODE)).toBe(false)
  })

  it('any other refusal keeps no class of its own', async () => {
    const board = new WakeBoard()
    const id = board.addTask(BOUND)
    const engine = createBoardOrchestrator({
      teamId: 't1',
      board,
      known: () => KNOWN,
      leaderAgentId: () => 'leader',
      sessionKeyForAgent: sk,
      agentIdForSession,
      deliver: async () => {
        throw new DeliveryRefusedError('Refused for another reason.')
      },
      stopGen: () => 0,
    })
    await engine.dispatchTask(id)
    expect(board.completed.at(-1)?.outcome.errorClass).toBeUndefined()
  })
})

describe("a person's Stop", () => {
  it("is named on the runs it closes: only a person's Stop holds what a run carries", async () => {
    const gen = { value: 0 }
    const h = harness({ gen })
    const id = h.board.addTask(BOUND)
    await h.engine.dispatchTask(id)
    gen.value = 1
    await h.engine.markStopped()
    expect(h.board.outcomeOf('exec-1')).toMatchObject({ status: 'cancelled', byPerson: true })
  })

  it('a run a person stopped by moving the card is named too', async () => {
    const h = harness()
    const id = h.board.addTask(BOUND)
    await h.engine.dispatchTask(id)
    await h.board.updateStatus(id, 'blocked')
    await h.engine.personMovedTask(id, 'blocked')
    expect(h.board.outcomeOf('exec-1')).toMatchObject({ status: 'cancelled', byPerson: true })
  })

  it('a check that passes after the Stop starts no step waiting on the task', async () => {
    const results: Array<(r: WorkCheckResult) => void> = []
    const board = { current: null as WakeBoard | null }
    const check: WorkCheck = {
      begin: async () => undefined,
      prepare: async (taskId) => async () => {
        await board.current!.updateStatus(taskId, 'in_review')
        return new Promise<WorkCheckResult>((resolve) => results.push(resolve))
      },
    }
    const gen = { value: 0 }
    const h = harness({ workCheck: check, gen })
    board.current = h.board
    const a = h.board.addTask(BOUND, 'first step')
    const b = h.board.addTask('r0:plan:1:agent:a3:reflectTo:leader', 'second step')
    await h.board.linkDep(b, a)
    await h.engine.dispatchTask(a)
    await h.engine.onEvent(sk('a2'), done('r1', 'first is done'))
    await vi.waitFor(() => expect(results).toHaveLength(1))
    // A person presses Stop while the work is being checked. The check runs on.
    gen.value = 1
    await h.engine.markStopped()
    results[0]!({ verdict: 'pass' })
    await vi.waitFor(() => expect(h.board.statusOf(a)).toBe('done'))
    // The step is now ready, and neither this engine nor the next one starts it.
    await h.engine.resume()
    await flushDeferred()
    expect(h.board.statusOf(b)).toBe('todo')
    expect(h.delivered.filter((d) => d.task === 'second step')).toEqual([])
    const ledger = await h.board.listExecutions(b)
    expect(ledger?.at(-1)?.status).toBe('cancelled')
  })

  it('holds every wake this room has for the next run, as it holds report-ups', async () => {
    const h = harness()
    const id = h.board.addTask(BOUND)
    h.board.waiting.set(id, [{ id: 'w1', reason: 'person_comment', commentIds: [] }])
    await h.engine.dispatchTask(id)
    await h.engine.markStopped()
    expect(h.settled).toEqual([{ ids: ['*'], how: 'held' }])
  })
})

describe('the no-progress brake at the engine', () => {
  const AT = 1_000_000_000
  const braked = (h: ReturnType<typeof harness>, id: string): void => {
    const real = h.board.listExecutions.bind(h.board)
    h.board.listExecutions = async (taskId: string) =>
      taskId === id
        ? [
            { id: 'e1', status: 'timed_out', completedAt: AT - 5_000 },
            { id: 'e2', status: 'timed_out', completedAt: AT - 1_000 },
          ]
        : real(taskId)
  }

  beforeEach(() => {
    vi.setSystemTime(AT)
  })

  it('the pump leaves a braked task in To do', async () => {
    const h = harness()
    const id = h.board.addTask(BOUND)
    braked(h, id)
    await h.engine.resume()
    expect(h.delivered).toEqual([])
    expect(h.board.statusOf(id)).toBe('todo')
  })

  it('the pump fires it once the wait is over', async () => {
    const h = harness()
    const id = h.board.addTask(BOUND)
    braked(h, id)
    vi.setSystemTime(AT + 2 * 60_000)
    await h.engine.resume()
    expect(h.delivered).toHaveLength(1)
  })

  it('a person asking for the run skips the wait', async () => {
    const h = harness()
    const id = h.board.addTask(BOUND)
    braked(h, id)
    expect(await h.engine.dispatchTask(id)).toBe('started')
  })

  it('tells the lead nothing: it is not parked, so a report still lists it as outstanding', async () => {
    const h = harness()
    const waiting = h.board.addTask(BOUND, 'second job')
    braked(h, waiting)
    const other = h.board.addTask('r0:deleg:agent:a3:reflectTo:leader', 'first job')
    await h.engine.dispatchTask(other)
    await h.engine.onEvent(sk('a3'), done('r1', 'first job done'))
    await vi.advanceTimersByTimeAsync(REFLECT_WINDOW_MS + 1)
    const update = h.delivered.find((d) => d.task.startsWith('[Task Update]'))!
    expect(update.task).toContain('Still outstanding: 1')
    expect(update.task).toContain('second job')
  })
})

describe("all of one agent's hand-offs closed", () => {
  const reportTo = (h: ReturnType<typeof harness>) =>
    h.delivered.filter((d) => d.task.startsWith('[Task Update]'))

  it('the report says so, once nothing is outstanding', async () => {
    const h = harness()
    const first = h.board.addTask('r0:deleg:agent:a2:reflectTo:leader', 'job one')
    const second = h.board.addTask('r0:deleg:agent:a3:reflectTo:leader', 'job two')
    await h.engine.dispatchTask(first)
    await h.engine.dispatchTask(second)
    await h.engine.onEvent(sk('a2'), done('r1', 'one is in'))
    await vi.advanceTimersByTimeAsync(REFLECT_WINDOW_MS + 1)
    expect(reportTo(h)[0]!.task).toContain('Still outstanding: 1')
    expect(reportTo(h)[0]!.task).not.toContain('All of the work you handed off')
    await h.engine.onEvent(sk('a3'), done('r2', 'two is in'))
    await vi.advanceTimersByTimeAsync(REFLECT_WINDOW_MS + 1)
    expect(reportTo(h)[1]!.task).toContain('All of the work you handed off here is in')
    expect(reportTo(h)[1]!.task).not.toContain('Still outstanding')
  })

  it('says how many of them need a person', async () => {
    const h = harness()
    const first = h.board.addTask('r0:deleg:agent:a2:reflectTo:leader', 'job one')
    const second = h.board.addTask('r0:deleg:agent:a3:reflectTo:leader', 'job two')
    await h.engine.dispatchTask(first)
    await h.engine.dispatchTask(second)
    await h.board.updateStatus(first, 'blocked')
    await h.engine.onEvent(sk('a2'), done('r1', 'need the key'))
    await h.engine.onEvent(sk('a3'), done('r2', 'two is in'))
    await vi.advanceTimersByTimeAsync(REFLECT_WINDOW_MS + 1)
    const message = reportTo(h)[0]!.task
    expect(message).toContain('All of the work you handed off here is in')
    expect(message).toContain('1 of it needs a person before it can go on')
    expect(message).toContain('job one')
  })

  describe('a hand-off that will not start by itself is not in', () => {
    it('a sibling a Stop left in To do: the report does not say all of it is in', async () => {
      const gen = { value: 0 }
      const h = harness({ gen })
      const first = h.board.addTask('r0:deleg:agent:a2:reflectTo:leader', 'job one')
      const second = h.board.addTask('r0:deleg:agent:a3:reflectTo:leader', 'job two')
      await h.engine.dispatchTask(first)
      await h.engine.dispatchTask(second)
      gen.value = 1
      await h.engine.markStopped()
      // A person retries only the first, and it finishes.
      await h.engine.onEvent(sk('a2'), {
        kind: 'done',
        reason: 'aborted',
        summary: '',
        runId: 'r1',
        sessionId: null,
        ts: 1,
        seq: 1,
      })
      await h.engine.onEvent(sk('a3'), {
        kind: 'done',
        reason: 'aborted',
        summary: '',
        runId: 'r2',
        sessionId: null,
        ts: 1,
        seq: 1,
      })
      await h.engine.dispatchTask(first)
      await h.engine.onEvent(sk('a2'), done('r3', 'one is in'), {
        reportForTaskId: null,
        stopGen: 1,
      })
      await vi.advanceTimersByTimeAsync(REFLECT_WINDOW_MS + 1)
      const message = reportTo(h).at(-1)!.task
      expect(message).not.toContain('All of the work you handed off')
      expect(message).toContain('not all in')
      expect(message).toContain('job two')
    })

    it('a sibling in Backlog', async () => {
      const h = harness()
      const first = h.board.addTask('r0:deleg:agent:a2:reflectTo:leader', 'job one')
      const parked = h.board.addTask('r0:deleg:agent:a3:reflectTo:leader', 'job two')
      await h.board.updateStatus(parked, 'backlog')
      await h.engine.dispatchTask(first)
      await h.engine.onEvent(sk('a2'), done('r1', 'one is in'))
      await vi.advanceTimersByTimeAsync(REFLECT_WINDOW_MS + 1)
      const message = reportTo(h)[0]!.task
      expect(message).not.toContain('All of the work you handed off')
      expect(message).toContain('job two')
    })

    it('a sibling parked after failing too often', async () => {
      const h = harness()
      const first = h.board.addTask('r0:deleg:agent:a2:reflectTo:leader', 'job one')
      const parked = h.board.addTask('r0:deleg:agent:a3:reflectTo:leader', 'job two')
      const real = h.board.listExecutions.bind(h.board)
      h.board.listExecutions = async (taskId: string) =>
        taskId === parked
          ? [
              { id: 'e1', status: 'failed' },
              { id: 'e2', status: 'failed' },
              { id: 'e3', status: 'failed' },
            ]
          : real(taskId)
      await h.engine.dispatchTask(first)
      await h.engine.onEvent(sk('a2'), done('r1', 'one is in'))
      await vi.advanceTimersByTimeAsync(REFLECT_WINDOW_MS + 1)
      const message = reportTo(h)[0]!.task
      expect(message).not.toContain('All of the work you handed off')
      expect(message).toContain('job two')
    })
  })

  it('a hand-off the board refused is not in, so it is named and All in is not said', async () => {
    const h = harness()
    const first = h.board.addTask(BOUND, 'job one')
    await h.engine.dispatchTask(first)
    h.board.createHandOff = async () => ({
      ok: false,
      reason: 'root_rate_cap',
      count: 1,
      max: 1,
      windowMs: 1_000,
    })
    await h.engine.onEvent(
      sk('leader'),
      done('r0', '<delegate to="@Doc Boo">write docs</delegate>'),
    )
    await h.engine.onEvent(sk('a2'), done('r1', 'one is in'))
    await vi.advanceTimersByTimeAsync(REFLECT_WINDOW_MS + 1)
    const message = reportTo(h).at(-1)!.task
    expect(message).toContain('one is in')
    expect(message).not.toContain('All of the work you handed off')
    expect(message).toContain('not all in')
    expect(message).toContain('Doc Boo ("write docs")')
  })

  it('a hand-off that found its work open is not in, whoever that task reports to', async () => {
    const h = harness()
    const first = h.board.addTask(BOUND, 'job one')
    await h.engine.dispatchTask(first)
    const open = h.board.addTask('assign:n1:agent:a3:origin:human', 'write docs')
    h.board.createHandOff = async () => ({
      ok: true,
      task: (await h.board.getTask(open))!.task,
      deduplicated: 'title',
    })
    await h.engine.onEvent(
      sk('leader'),
      done('r0', '<delegate to="@Doc Boo">write docs</delegate>'),
    )
    await h.engine.onEvent(sk('a2'), done('r1', 'one is in'))
    await vi.advanceTimersByTimeAsync(REFLECT_WINDOW_MS + 1)
    const message = reportTo(h).at(-1)!.task
    expect(message).toContain('Already on the board')
    expect(message).not.toContain('All of the work you handed off')
  })

  it('a board read that failed does not say nothing is outstanding', async () => {
    const h = harness()
    const first = h.board.addTask('r0:deleg:agent:a2:reflectTo:leader', 'job one')
    await h.engine.dispatchTask(first)
    // The server's client answers a failed read with an empty list.
    h.board.listTasks = async () => []
    await h.engine.onEvent(sk('a2'), done('r1', 'one is in'))
    await vi.advanceTimersByTimeAsync(REFLECT_WINDOW_MS + 1)
    expect(reportTo(h)[0]!.task).not.toContain('All of the work you handed off')
    expect(reportTo(h)[0]!.task).toContain('one is in')
  })

  it('a task under check is still outstanding', async () => {
    const h = harness()
    const first = h.board.addTask('r0:deleg:agent:a2:reflectTo:leader', 'job one')
    const second = h.board.addTask('r0:deleg:agent:a3:reflectTo:leader', 'job two')
    await h.engine.dispatchTask(first)
    await h.engine.dispatchTask(second)
    await h.board.updateStatus(second, 'in_review')
    await h.engine.onEvent(sk('a2'), done('r1', 'one is in'))
    await vi.advanceTimersByTimeAsync(REFLECT_WINDOW_MS + 1)
    expect(reportTo(h)[0]!.task).toContain('Still outstanding: 1')
    expect(reportTo(h)[0]!.task).not.toContain('All of the work you handed off')
  })

  it('a note with no task behind it does not claim anything is in', async () => {
    const h = harness()
    await h.engine.onEvent(sk('leader'), done('r0', '<delegate to="@Nobody">do it</delegate>'))
    await h.engine.onEvent(sk('leader'), {
      kind: 'tool-call',
      name: 'clawboo-teamchat.team_delegate',
      input: { assignee: 'Nobody', task: 'do it' },
      toolCallId: 't1',
      runId: 'r3',
      sessionId: null,
      ts: 1,
      seq: 1,
    } as RuntimeEvent)
    await vi.advanceTimersByTimeAsync(REFLECT_WINDOW_MS + 1)
    expect(reportTo(h)[0]?.task).not.toContain('All of the work you handed off')
  })
})
