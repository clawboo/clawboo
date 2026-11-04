// Team-chat work goes through the same check as the task runner's. The engine
// asks the host before a task's run starts (so it can note what the work starts
// from) and again when the run ends well; the host answers with nothing to
// check, or with the check itself, which the engine runs without holding up the
// run's drain. These scenarios play the host with a scripted check over the
// in-memory board, moving the card the way the server's check does.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { RuntimeEvent } from '@clawboo/executor'

import {
  createBoardOrchestrator,
  DELEGATION_IDLE_TIMEOUT_MS,
  REFLECT_WINDOW_MS,
  WORK_CHECK_TIMEOUT_MS,
  type KnownAgent,
  type WorkCheck,
  type WorkCheckResult,
} from '../boardOrchestration'
import type { TurnOrigin } from '../turnOrigin'
import { FakeBoard } from './fakeBoard'

const KNOWN: KnownAgent[] = [
  { id: 'leader', name: 'Boo Zero' },
  { id: 'a2', name: 'Bug Boo' },
]

const sk = (id: string): string => `agent:${id}:team:t1`
const agentIdForSession = (s: string): string | null => s.match(/^agent:([^:]+):/)?.[1] ?? null

function doneEvent(runId: string, summary: string): RuntimeEvent {
  return { kind: 'done', reason: 'success', summary, runId, sessionId: null, ts: 1, seq: 1 }
}

type Delivered = { sessionKey: string; agentId: string; task: string; origin: TurnOrigin }

/** A check the test resolves by hand, playing the server's card moves. */
interface PendingCheck {
  taskId: string
  resolve: (r: WorkCheckResult) => void
}

function makeHarness(
  opts: {
    needsCheck?: boolean | (() => boolean)
    /** The check itself throws. */
    checkThrows?: boolean
    /** Preparing the check itself fails. */
    prepareRejects?: boolean
  } = {},
) {
  let clock = 1_000_000
  let gen = 0
  const board = new FakeBoard()
  const delivered: Delivered[] = []
  const begun: Array<{ taskId: string; agentId: string; deliveredBefore: number }> = []
  const checks: PendingCheck[] = []
  /** Sessions with another turn running or queued (the host's nudge queue). */
  const occupied = new Set<string>()
  const aborted: string[] = []
  const workCheck: WorkCheck = {
    async begin(taskId, agentId) {
      begun.push({ taskId, agentId, deliveredBefore: delivered.length })
    },
    async prepare(taskId) {
      const needs =
        typeof opts.needsCheck === 'function' ? opts.needsCheck() : opts.needsCheck !== false
      if (!needs) return null
      if (opts.prepareRejects) throw new Error('history unreadable')
      return async () => {
        // The server moves the card to In review while the check runs.
        await board.updateStatus(taskId, 'in_review')
        if (opts.checkThrows) throw new Error('git: index.lock exists')
        return new Promise<WorkCheckResult>((resolve) => checks.push({ taskId, resolve }))
      }
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
    stopGen: () => gen,
    now: () => clock,
    isSessionOccupied: (s) => occupied.has(s),
    abortSession: (s) => aborted.push(s),
    workCheck,
  })
  return {
    board,
    engine,
    delivered,
    begun,
    checks,
    occupied,
    aborted,
    updates: () => delivered.filter((d) => d.task.startsWith('[Task Update]')),
    toWorker: () => delivered.filter((d) => d.agentId === 'a2'),
    advance: (ms: number) => {
      clock += ms
    },
    stop: () => {
      gen += 1
    },
  }
}

/** Let the detached check and its follow-on board writes run. */
const settle = async (): Promise<void> => {
  for (let i = 0; i < 10; i++) await Promise.resolve()
  await vi.advanceTimersByTimeAsync(0)
}

const statusOf = (board: FakeBoard, taskId: string): string | undefined =>
  board.tasks.get(taskId)?.status

async function delegate(
  h: ReturnType<typeof makeHarness>,
  task = 'fix the parser',
): Promise<string> {
  await h.engine.onEvent(
    sk('leader'),
    doneEvent('r1', `<delegate to="@Bug Boo">${task}</delegate>`),
  )
  return h.board.created.at(-1)!.id
}

describe('team-chat work check', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => {
    vi.clearAllTimers()
    vi.useRealTimers()
  })

  it("notes where a task's work starts before its run is delivered", async () => {
    const h = makeHarness()
    const id = await delegate(h)
    expect(h.begun).toEqual([{ taskId: id, agentId: 'a2', deliveredBefore: 0 }])
    expect(h.toWorker()).toHaveLength(1)
  })

  it('a task with nothing to check lands in done as before', async () => {
    const h = makeHarness({ needsCheck: false })
    const id = await delegate(h)
    await h.engine.onEvent(sk('a2'), doneEvent('r2', 'fixed'))
    await vi.advanceTimersByTimeAsync(REFLECT_WINDOW_MS)

    expect(statusOf(h.board, id)).toBe('done')
    expect(h.updates()).toHaveLength(1)
  })

  it('a task is done only once its check passes, and the lead hears after it', async () => {
    const h = makeHarness()
    const id = await delegate(h)
    await h.engine.onEvent(sk('a2'), doneEvent('r2', 'fixed in parser.ts'))
    await settle()
    await vi.advanceTimersByTimeAsync(REFLECT_WINDOW_MS)

    expect(statusOf(h.board, id)).toBe('in_review')
    expect(h.updates()).toHaveLength(0)

    h.checks[0]!.resolve({ verdict: 'pass' })
    await settle()
    await vi.advanceTimersByTimeAsync(REFLECT_WINDOW_MS)

    expect(statusOf(h.board, id)).toBe('done')
    expect(h.updates()).toHaveLength(1)
    expect(h.updates()[0]!.task).toContain('fixed in parser.ts')
  })

  it('a failed check with an attempt left sends the agent the fix note and the task', async () => {
    const h = makeHarness()
    const id = await delegate(h, 'make the CSV parser handle quotes')
    await h.engine.onEvent(sk('a2'), doneEvent('r2', 'done'))
    await settle()
    await h.board.updateStatus(id, 'in_progress') // the server sends it back for a fix
    h.checks[0]!.resolve({ verdict: 'retry', fixNote: 'What: npm test exited 1.' })
    await settle()

    expect(h.toWorker()).toHaveLength(2)
    const fix = h.toWorker()[1]!
    expect(fix.task).toContain('npm test exited 1.')
    expect(fix.task).toContain('make the CSV parser handle quotes')
    expect(fix.origin).toEqual({ kind: 'delegation', fromAgentId: 'leader' })
    // The fix round is a run of its own, and the first one is closed.
    expect(h.board.completed.map((c) => c.outcome.status)).toEqual(['succeeded'])
    expect(h.board.execCount).toBe(2)
    expect(h.updates()).toHaveLength(0)

    // The fix round's run ends well and its check passes.
    await h.engine.onEvent(sk('a2'), doneEvent('r3', 'quotes handled, tests green'))
    await settle()
    h.checks[1]!.resolve({ verdict: 'pass' })
    await settle()
    await vi.advanceTimersByTimeAsync(REFLECT_WINDOW_MS)

    expect(statusOf(h.board, id)).toBe('done')
    expect(h.updates()).toHaveLength(1)
    expect(h.updates()[0]!.task).toContain('quotes handled, tests green')
    // Only a fresh run notes a new starting point, never a fix round.
    expect(h.begun).toHaveLength(1)
  })

  it('a check that fails on the last attempt leaves the task for a person and tells the lead why', async () => {
    const h = makeHarness()
    const id = await delegate(h)
    await h.engine.onEvent(sk('a2'), doneEvent('r2', 'done'))
    await settle()
    await h.board.updateStatus(id, 'blocked') // the server parks it in Needs you
    h.checks[0]!.resolve({ verdict: 'failed', reason: 'npm test still exits 1.' })
    await settle()
    await vi.advanceTimersByTimeAsync(REFLECT_WINDOW_MS)

    expect(statusOf(h.board, id)).toBe('blocked')
    expect(h.updates()).toHaveLength(1)
    expect(h.updates()[0]!.task).toContain('npm test still exits 1.')
    expect(h.updates()[0]!.task).toMatch(/check/i)
    expect(h.board.completed.map((c) => c.outcome.status)).toEqual(['succeeded'])
  })

  it('a person who moves the card during the check has the last word', async () => {
    const h = makeHarness()
    const id = await delegate(h)
    await h.engine.onEvent(sk('a2'), doneEvent('r2', 'done'))
    await settle()
    await h.board.updateStatus(id, 'done') // a person marks it done
    h.checks[0]!.resolve({ verdict: 'decided' })
    await settle()
    await vi.advanceTimersByTimeAsync(REFLECT_WINDOW_MS)

    expect(statusOf(h.board, id)).toBe('done')
    expect(h.updates()).toHaveLength(0)
    expect(h.board.completed.map((c) => c.outcome.status)).toEqual(['cancelled'])
  })

  it("the agent's other replies during the check are not taken as the task's result", async () => {
    const h = makeHarness()
    const id = await delegate(h)
    await h.engine.onEvent(sk('a2'), doneEvent('r2', 'the real result'))
    await settle()
    // A person @mentions the agent while its work is checked.
    await h.engine.onEvent(sk('a2'), doneEvent('chat-1', 'sure, happy to help'))
    await h.engine.onEvent(sk('a2'), {
      kind: 'done',
      reason: 'error',
      summary: 'that reply failed',
      runId: 'chat-2',
      sessionId: null,
      ts: 1,
      seq: 1,
    })
    await settle()
    expect(h.checks).toHaveLength(1)
    expect(statusOf(h.board, id)).toBe('in_review')

    h.checks[0]!.resolve({ verdict: 'pass' })
    await settle()
    await vi.advanceTimersByTimeAsync(REFLECT_WINDOW_MS)

    expect(statusOf(h.board, id)).toBe('done')
    expect(h.updates()[0]!.task).toContain('the real result')
    expect(h.updates()[0]!.task).not.toContain('happy to help')
  })

  it('the watchdog leaves a task alone while its work is checked', async () => {
    const h = makeHarness()
    const id = await delegate(h)
    await h.engine.onEvent(sk('a2'), doneEvent('r2', 'done'))
    await settle()
    h.advance(DELEGATION_IDLE_TIMEOUT_MS * 2)
    await h.engine.sweepStaleSessions()

    expect(statusOf(h.board, id)).toBe('in_review')
    h.checks[0]!.resolve({ verdict: 'pass' })
    await settle()
    expect(statusOf(h.board, id)).toBe('done')
  })

  it('no other task is given to the agent until its check is over', async () => {
    const h = makeHarness()
    const first = await delegate(h, 'first task')
    await h.engine.onEvent(sk('a2'), doneEvent('r2', 'done'))
    await settle()
    const second = await delegate(h, 'second task')

    expect(statusOf(h.board, second)).toBe('todo')
    expect(h.toWorker()).toHaveLength(1)

    h.checks[0]!.resolve({ verdict: 'pass' })
    await settle()
    await vi.advanceTimersByTimeAsync(0)

    expect(statusOf(h.board, first)).toBe('done')
    expect(statusOf(h.board, second)).toBe('in_progress')
    expect(h.toWorker()).toHaveLength(2)
  })

  it('a check a restart cut short leaves the task for a person, and the lead is told', async () => {
    const before = makeHarness()
    const id = await delegate(before)
    await before.engine.onEvent(sk('a2'), doneEvent('r2', 'done'))
    await settle()
    expect(statusOf(before.board, id)).toBe('in_review')
    vi.clearAllTimers() // the server dies mid-check

    // The next process's engine over the same board.
    const after = createBoardOrchestrator({
      teamId: 't1',
      board: before.board,
      known: () => KNOWN,
      leaderAgentId: () => 'leader',
      sessionKeyForAgent: sk,
      agentIdForSession,
      deliver: async (sessionKey, agentId, task, origin) => {
        before.delivered.push({ sessionKey, agentId, task, origin })
      },
      stopGen: () => 0,
      workCheck: { begin: async () => undefined, prepare: async () => null },
    })
    await after.resume()
    await after.resume()
    await vi.advanceTimersByTimeAsync(REFLECT_WINDOW_MS)

    expect(statusOf(before.board, id)).toBe('blocked')
    expect(before.board.comments.filter((c) => /restart/i.test(c.body))).toHaveLength(1)
    expect(before.updates()).toHaveLength(1)
    expect(before.updates()[0]!.task).toMatch(/restart/i)
  })

  it('a resume while this engine checks a task leaves the check alone', async () => {
    const h = makeHarness()
    const id = await delegate(h)
    await h.engine.onEvent(sk('a2'), doneEvent('r2', 'done'))
    await settle()
    await h.engine.resume()

    expect(statusOf(h.board, id)).toBe('in_review')
    h.checks[0]!.resolve({ verdict: 'pass' })
    await settle()
    expect(statusOf(h.board, id)).toBe('done')
  })

  it('a resume that lands while a passed check is being written leaves the task to finish', async () => {
    const h = makeHarness()
    const id = await delegate(h)
    await h.engine.onEvent(sk('a2'), doneEvent('r2', 'done'))
    await settle()
    h.checks[0]!.resolve({ verdict: 'pass' })
    for (let i = 0; i < 4; i++) {
      await Promise.resolve()
      await h.engine.resume()
    }
    await settle()

    expect(statusOf(h.board, id)).toBe('done')
    expect(h.board.comments.filter((c) => /restart/i.test(c.body))).toHaveLength(0)
  })

  it('a Stop during the check starts no fix round and puts the task back in To do', async () => {
    const h = makeHarness()
    const id = await delegate(h)
    await h.engine.onEvent(sk('a2'), doneEvent('r2', 'done'))
    await settle()
    h.stop()
    await h.engine.markStopped()
    await h.board.updateStatus(id, 'in_progress') // the check failed with an attempt left
    h.checks[0]!.resolve({ verdict: 'retry', fixNote: 'What: tests failed.' })
    await settle()
    await vi.advanceTimersByTimeAsync(REFLECT_WINDOW_MS)

    expect(h.toWorker()).toHaveLength(1)
    expect(statusOf(h.board, id)).toBe('todo')
    expect(h.updates()).toHaveLength(0)
  })

  it("a fix round waits for the agent's other turn to end, and that turn's reply is not the fix", async () => {
    const h = makeHarness()
    const id = await delegate(h)
    await h.engine.onEvent(sk('a2'), doneEvent('r2', 'done'))
    await settle()
    // A person @mentions the agent during its check; that reply is still running.
    h.occupied.add(sk('a2'))
    await h.board.updateStatus(id, 'in_progress')
    h.checks[0]!.resolve({ verdict: 'retry', fixNote: 'What: tests failed.' })
    await settle()
    expect(h.toWorker()).toHaveLength(1)

    // The @mention's reply ends: it is not the fix, and the fix round goes out now.
    h.occupied.delete(sk('a2'))
    await h.engine.onEvent(sk('a2'), doneEvent('chat-1', 'sure, happy to help'))
    await settle()

    expect(h.checks).toHaveLength(1)
    expect(h.toWorker()).toHaveLength(2)
    expect(h.toWorker()[1]!.task).toContain('[Check failed]')
    expect(statusOf(h.board, id)).toBe('in_progress')
  })

  it('a check that cannot run leaves the task for a person, not in done', async () => {
    const h = makeHarness({ checkThrows: true })
    const id = await delegate(h)
    await h.engine.onEvent(sk('a2'), doneEvent('r2', 'done'))
    await settle()
    await vi.advanceTimersByTimeAsync(REFLECT_WINDOW_MS)

    expect(statusOf(h.board, id)).toBe('blocked')
    expect(h.updates()).toHaveLength(1)
    expect(h.updates()[0]!.task).toContain('index.lock')
  })

  it('a run the board will not mark done after a failed check goes to a person', async () => {
    let checkNext = true
    const h = makeHarness({ needsCheck: () => checkNext })
    const id = await delegate(h)
    // The board's own gate: a stored failing verdict refuses `done`.
    const update = h.board.updateStatus.bind(h.board)
    h.board.updateStatus = async (taskId, status) =>
      taskId === id && status === 'done' ? false : update(taskId, status)
    await h.engine.onEvent(sk('a2'), doneEvent('r2', 'done'))
    await settle()
    await h.board.updateStatus(id, 'in_progress')
    h.checks[0]!.resolve({ verdict: 'retry', fixNote: 'What: tests failed.' })
    await settle()
    // The fix round's change cannot be measured, so nothing is checked this time.
    checkNext = false
    await h.engine.onEvent(sk('a2'), doneEvent('r3', 'reverted my change'))
    await settle()
    await vi.advanceTimersByTimeAsync(REFLECT_WINDOW_MS)

    expect(statusOf(h.board, id)).toBe('blocked')
    expect(h.updates()).toHaveLength(1)
    expect(h.updates()[0]!.task).toMatch(/check/i)
    expect(h.updates()[0]!.task).not.toMatch(/released/i)
  })

  it('a Stop leaves a running check to finish, and a teardown after it leaves the task for the next engine', async () => {
    const h = makeHarness()
    const id = await delegate(h)
    await h.engine.onEvent(sk('a2'), doneEvent('r2', 'done'))
    await settle()
    h.stop()
    await h.engine.markStopped()
    expect(h.board.completed).toEqual([])
    h.engine.reset() // the room is closed before the check answers

    const next = createBoardOrchestrator({
      teamId: 't1',
      board: h.board,
      known: () => KNOWN,
      leaderAgentId: () => 'leader',
      sessionKeyForAgent: sk,
      agentIdForSession,
      deliver: async () => undefined,
      stopGen: () => 0,
      workCheck: { begin: async () => undefined, prepare: async () => null },
    })
    await next.resume()

    expect(statusOf(h.board, id)).toBe('blocked')
  })

  it('a running check counts as work in flight', async () => {
    const h = makeHarness()
    await delegate(h)
    expect(h.engine.checksInFlight()).toBe(0)
    await h.engine.onEvent(sk('a2'), doneEvent('r2', 'done'))
    await settle()
    expect(h.engine.checksInFlight()).toBe(1)
    h.checks[0]!.resolve({ verdict: 'pass' })
    await settle()
    expect(h.engine.checksInFlight()).toBe(0)
  })

  it('a check that never answers is given up, and the task goes to a person', async () => {
    const h = makeHarness()
    const id = await delegate(h)
    await h.engine.onEvent(sk('a2'), doneEvent('r2', 'done'))
    await settle()
    await vi.advanceTimersByTimeAsync(WORK_CHECK_TIMEOUT_MS + 60_000)
    await settle()
    await vi.advanceTimersByTimeAsync(REFLECT_WINDOW_MS)

    expect(statusOf(h.board, id)).toBe('blocked')
    expect(h.engine.checksInFlight()).toBe(0)
    expect(h.updates()).toHaveLength(1)
    // The check answering late changes nothing.
    h.checks[0]!.resolve({ verdict: 'pass' })
    await settle()
    expect(statusOf(h.board, id)).toBe('blocked')
  })

  it("a person's move during the check does not stop the agent's other turn", async () => {
    const h = makeHarness()
    const id = await delegate(h)
    await h.engine.onEvent(sk('a2'), doneEvent('r2', 'done'))
    await settle()
    await h.board.updateStatus(id, 'done')
    await h.engine.personMovedTask(id, 'done')

    expect(h.aborted).toEqual([])
  })

  it("a check a person's move superseded never finishes the task, and the next run's result does", async () => {
    const h = makeHarness()
    const id = await delegate(h)
    await h.engine.onEvent(sk('a2'), doneEvent('r2', 'old result'))
    await settle()
    // A person parks it, then retries it: a new run starts on the same session.
    await h.board.updateStatus(id, 'blocked')
    await h.engine.personMovedTask(id, 'blocked')
    await h.board.updateStatus(id, 'todo')
    expect(await h.engine.dispatchTask(id)).toBe('started')
    expect(h.toWorker()).toHaveLength(2)

    h.checks[0]!.resolve({ verdict: 'pass' }) // the old check answers late
    await settle()
    expect(statusOf(h.board, id)).toBe('in_progress')

    await h.engine.onEvent(sk('a2'), doneEvent('r3', 'new result'))
    await settle()
    expect(h.checks).toHaveLength(2)
    h.checks[1]!.resolve({ verdict: 'pass' })
    await settle()
    await vi.advanceTimersByTimeAsync(REFLECT_WINDOW_MS)

    expect(statusOf(h.board, id)).toBe('done')
    expect(h.updates()).toHaveLength(1)
    expect(h.updates()[0]!.task).toContain('new result')
  })

  it('a check that cannot even be prepared leaves the task for a person, not in done', async () => {
    const h = makeHarness({ prepareRejects: true })
    const id = await delegate(h)
    await h.engine.onEvent(sk('a2'), doneEvent('r2', 'done'))
    await settle()
    await vi.advanceTimersByTimeAsync(REFLECT_WINDOW_MS)

    expect(statusOf(h.board, id)).toBe('blocked')
    expect(h.updates()[0]!.task).toContain('history unreadable')
  })

  it('a board write that fails while parking a task does not leave the session under check', async () => {
    const h = makeHarness({ checkThrows: true })
    const update = h.board.updateStatus.bind(h.board)
    h.board.updateStatus = async (taskId, status) => {
      if (status === 'blocked') throw new Error('database is locked')
      return update(taskId, status)
    }
    await delegate(h)
    await h.engine.onEvent(sk('a2'), doneEvent('r2', 'done'))
    await settle()

    expect(h.engine.checksInFlight()).toBe(0)
  })

  it("a person's move during the check does not drop what the agent's other turn hands off", async () => {
    const h = makeHarness()
    const id = await delegate(h)
    await h.engine.onEvent(sk('a2'), doneEvent('r2', 'done'))
    await settle()
    await h.board.updateStatus(id, 'done')
    await h.engine.personMovedTask(id, 'done')
    const before = h.board.created.length

    await h.engine.onEvent(
      sk('a2'),
      doneEvent('chat-1', '<delegate to="@Boo Zero">review the parser change</delegate>'),
    )

    expect(h.board.created.length).toBe(before + 1)
  })

  it('a fix round that cannot be set up leaves the task for a person, with the reason', async () => {
    const h = makeHarness()
    const id = await delegate(h)
    await h.engine.onEvent(sk('a2'), doneEvent('r2', 'done'))
    await settle()
    // The fix round waits behind the agent's other turn, then cannot open its run.
    h.occupied.add(sk('a2'))
    await h.board.updateStatus(id, 'in_progress')
    h.checks[0]!.resolve({ verdict: 'retry', fixNote: 'What: tests failed.' })
    await settle()
    h.board.createExecution = async () => {
      throw new Error('database is locked')
    }
    h.occupied.delete(sk('a2'))
    await h.engine.onEvent(sk('a2'), doneEvent('chat-1', 'sure, happy to help'))
    await settle()
    await vi.advanceTimersByTimeAsync(REFLECT_WINDOW_MS)

    expect(h.toWorker()).toHaveLength(1)
    expect(statusOf(h.board, id)).toBe('blocked')
    expect(h.board.comments.map((c) => c.body).join('\n')).toContain('database is locked')
    expect(h.updates()).toHaveLength(1)
    expect(h.updates()[0]!.task).toContain('database is locked')
  })

  it('a fix round whose first run cannot be closed still has that run closed, and the task goes to a person', async () => {
    const h = makeHarness()
    const id = await delegate(h)
    await h.engine.onEvent(sk('a2'), doneEvent('r2', 'done'))
    await settle()
    const complete = h.board.completeExecution.bind(h.board)
    let refusals = 1
    h.board.completeExecution = async (execId, outcome) => {
      if (refusals-- > 0) throw new Error('database is locked')
      return complete(execId, outcome)
    }
    await h.board.updateStatus(id, 'in_progress')
    h.checks[0]!.resolve({ verdict: 'retry', fixNote: 'What: tests failed.' })
    await settle()

    expect(h.toWorker()).toHaveLength(1)
    expect(statusOf(h.board, id)).toBe('blocked')
    expect(h.board.completed.map((c) => c.outcome.status)).toEqual(['failed'])
  })

  it('a check that cannot run, whose move to Blocked the board refuses, does not reach Done', async () => {
    const h = makeHarness({ checkThrows: true })
    const update = h.board.updateStatus.bind(h.board)
    h.board.updateStatus = async (taskId, status) =>
      status === 'blocked' ? false : update(taskId, status)
    const id = await delegate(h)
    await h.engine.onEvent(sk('a2'), doneEvent('r2', 'done'))
    await settle()
    await vi.advanceTimersByTimeAsync(REFLECT_WINDOW_MS)

    expect(statusOf(h.board, id)).not.toBe('done')
    expect(h.engine.checksInFlight()).toBe(0)
    expect(h.updates()).toHaveLength(1)
    expect(h.updates()[0]!.task).toContain('index.lock')
    // The task's run had ended; whatever runs on the session now is another turn.
    expect(h.aborted).toHaveLength(0)
  })

  it('a fix round the board cannot open a run for goes to a person, not back to To do', async () => {
    const h = makeHarness()
    const id = await delegate(h)
    await h.engine.onEvent(sk('a2'), doneEvent('r2', 'done'))
    await settle()
    h.board.createExecution = async () => null
    await h.board.updateStatus(id, 'in_progress')
    h.checks[0]!.resolve({ verdict: 'retry', fixNote: 'What: tests failed.' })
    await settle()
    await vi.advanceTimersByTimeAsync(REFLECT_WINDOW_MS)

    expect(h.toWorker()).toHaveLength(1)
    expect(statusOf(h.board, id)).toBe('blocked')
    expect(h.updates()).toHaveLength(1)
  })

  it('a passed check whose Done the board refuses goes to a person with the true reason', async () => {
    const h = makeHarness()
    const update = h.board.updateStatus.bind(h.board)
    h.board.updateStatus = async (taskId, status) =>
      status === 'done' ? false : update(taskId, status)
    const id = await delegate(h)
    await h.engine.onEvent(sk('a2'), doneEvent('r2', 'done'))
    await settle()
    h.checks[0]!.resolve({ verdict: 'pass' })
    await settle()
    await vi.advanceTimersByTimeAsync(REFLECT_WINDOW_MS)

    expect(statusOf(h.board, id)).toBe('blocked')
    expect(h.updates()).toHaveLength(1)
    expect(h.updates()[0]!.task).toContain('check passed')
    expect(h.updates()[0]!.task).not.toMatch(/earlier attempt failed/i)
  })

  it('a check a restart cut short keeps its run open until the task is parked', async () => {
    const before = makeHarness()
    const id = await delegate(before)
    await before.engine.onEvent(sk('a2'), doneEvent('r2', 'done'))
    await settle()
    vi.clearAllTimers() // the server dies mid-check
    const update = before.board.updateStatus.bind(before.board)
    let refuse = true
    before.board.updateStatus = async (taskId, status) =>
      status === 'blocked' && refuse ? false : update(taskId, status)

    const after = createBoardOrchestrator({
      teamId: 't1',
      board: before.board,
      known: () => KNOWN,
      leaderAgentId: () => 'leader',
      sessionKeyForAgent: sk,
      agentIdForSession,
      deliver: async (sessionKey, agentId, task, origin) => {
        before.delivered.push({ sessionKey, agentId, task, origin })
      },
      stopGen: () => 0,
      workCheck: { begin: async () => undefined, prepare: async () => null },
    })
    // The move to Blocked fails: the run stays open, so a later resume finds it.
    await after.resume()
    expect(statusOf(before.board, id)).toBe('in_review')
    expect(before.board.completed).toHaveLength(0)

    refuse = false
    await after.resume()
    await vi.advanceTimersByTimeAsync(REFLECT_WINDOW_MS)

    expect(statusOf(before.board, id)).toBe('blocked')
    expect(before.board.completed.map((c) => c.outcome.status)).toEqual(['failed'])
    expect(before.updates()).toHaveLength(1)
  })
})
