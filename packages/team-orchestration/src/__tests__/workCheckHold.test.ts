// A task's check waits while another run of the team is working in the folder it
// looks at. The host says when the check may run (`hold`); the engine bounds the
// wait, keeps the session bound meanwhile, and lets a person's move or a Stop end
// it. These scenarios play the host with a scripted hold over the in-memory board.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { RuntimeEvent } from '@clawboo/executor'

import {
  createBoardOrchestrator,
  DELEGATION_IDLE_TIMEOUT_MS,
  REFLECT_WINDOW_MS,
  WORK_CHECK_HOLD_LIMIT_MS,
  type KnownAgent,
  type PreparedWorkCheck,
  type WorkCheck,
  type WorkCheckResult,
} from '../boardOrchestration'
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

interface HeldCheck {
  taskId: string
  signal: AbortSignal
  /** The host's say-so: the check may run. */
  clear: () => void
  /** The check's place in the folder's line came back. */
  gaveBack: () => number
}

function makeHarness(
  opts: { holdRejects?: boolean; prepareWaitsOn?: Promise<void>; busy?: boolean } = {},
) {
  let clock = 1_000_000
  let gen = 0
  const board = new FakeBoard()
  const delivered: Array<{ agentId: string; task: string }> = []
  const held: HeldCheck[] = []
  const ran: string[] = []
  const answers: Array<(r: WorkCheckResult) => void> = []
  const workCheck: WorkCheck = {
    begin: async () => undefined,
    async prepare(taskId) {
      if (opts.prepareWaitsOn) await opts.prepareWaitsOn
      const run = (async () => {
        ran.push(taskId)
        return new Promise<WorkCheckResult>((resolve) => answers.push(resolve))
      }) as PreparedWorkCheck
      run.hold = async (signal) => {
        // The server moves the card to In review while the check waits.
        await board.updateStatus(taskId, 'in_review')
        if (opts.holdRejects) throw new Error('the folder registry broke')
        let gaveBack = 0
        await new Promise<void>((resolve) => {
          held.push({ taskId, signal, clear: resolve, gaveBack: () => gaveBack })
          signal.addEventListener('abort', () => resolve(), { once: true })
        })
        return () => {
          gaveBack += 1
        }
      }
      return run
    },
  }
  const engine = createBoardOrchestrator({
    teamId: 't1',
    board,
    known: () => KNOWN,
    leaderAgentId: () => 'leader',
    sessionKeyForAgent: sk,
    agentIdForSession,
    deliver: async (_sessionKey, agentId, task) => {
      delivered.push({ agentId, task })
    },
    stopGen: () => gen,
    now: () => clock,
    isSessionBusy: () => opts.busy === true,
    workCheck,
  })
  return {
    board,
    engine,
    delivered,
    held,
    ran,
    answers,
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

/** Let the detached hold, the check and their follow-on board writes run. */
const settle = async (): Promise<void> => {
  for (let i = 0; i < 10; i++) await Promise.resolve()
  await vi.advanceTimersByTimeAsync(0)
}

const statusOf = (board: FakeBoard, taskId: string): string | undefined =>
  board.tasks.get(taskId)?.status

/** A delegated task whose run just ended well, so its check is on hold. */
async function heldTask(h: ReturnType<typeof makeHarness>): Promise<string> {
  await h.engine.onEvent(
    sk('leader'),
    doneEvent('r1', '<delegate to="@Bug Boo">fix the parser</delegate>'),
  )
  const id = h.board.created.at(-1)!.id
  await h.engine.onEvent(sk('a2'), doneEvent('r2', 'fixed'))
  await settle()
  return id
}

describe('a work check on hold', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => {
    vi.clearAllTimers()
    vi.useRealTimers()
  })

  it('does not run until the host says so, then runs and finishes the task', async () => {
    const h = makeHarness()
    const id = await heldTask(h)

    expect(h.held).toHaveLength(1)
    expect(h.ran).toEqual([])
    expect(statusOf(h.board, id)).toBe('in_review')

    h.held[0]!.clear()
    await settle()
    expect(h.ran).toEqual([id])

    h.answers[0]!({ verdict: 'pass' })
    await settle()
    await vi.advanceTimersByTimeAsync(REFLECT_WINDOW_MS)
    expect(statusOf(h.board, id)).toBe('done')
    expect(h.updates()).toHaveLength(1)
    expect(h.held[0]!.gaveBack()).toBe(1)
    expect(h.engine.checksInFlight()).toBe(0)
  })

  it('counts as a check in flight and keeps the session bound while it waits', async () => {
    const h = makeHarness()
    const id = await heldTask(h)

    expect(h.engine.checksInFlight()).toBe(1)
    expect(h.engine.taskForSession(sk('a2'))).toBe(id)

    // No other task is given to the agent: the second stays queued.
    await h.engine.onEvent(
      sk('leader'),
      doneEvent('r3', '<delegate to="@Bug Boo">another thing</delegate>'),
    )
    await settle()
    const second = h.board.created.at(-1)!.id
    expect(statusOf(h.board, second)).toBe('todo')
    expect(h.toWorker()).toHaveLength(1)
  })

  it("the watchdog leaves it alone, and another turn's reply is not the task's result", async () => {
    const h = makeHarness()
    const id = await heldTask(h)

    h.advance(DELEGATION_IDLE_TIMEOUT_MS + 60_000)
    await h.engine.sweepStaleSessions()
    await h.engine.onEvent(sk('a2'), doneEvent('r9', 'a reply to a mention'))
    await settle()

    expect(statusOf(h.board, id)).toBe('in_review')
    expect(h.engine.taskForSession(sk('a2'))).toBe(id)
    expect(h.ran).toEqual([])
  })

  it('stops waiting at the limit and runs the check, so the task is not stranded', async () => {
    const h = makeHarness()
    const id = await heldTask(h)

    await vi.advanceTimersByTimeAsync(WORK_CHECK_HOLD_LIMIT_MS - 60_000)
    expect(h.held[0]!.signal.aborted).toBe(false)
    expect(h.ran).toEqual([])

    await vi.advanceTimersByTimeAsync(60_000)
    await settle()
    expect(h.held[0]!.signal.aborted).toBe(true)
    expect(h.ran).toEqual([id])

    h.answers[0]!({ verdict: 'pass' })
    await settle()
    expect(statusOf(h.board, id)).toBe('done')
    expect(h.engine.checksInFlight()).toBe(0)
  })

  it('gives the place in line back only after a fix round is delivered', async () => {
    const h = makeHarness()
    const id = await heldTask(h)
    h.held[0]!.clear()
    await settle()

    await h.board.updateStatus(id, 'in_progress') // the host's move on a failed attempt
    h.answers[0]!({ verdict: 'retry', fixNote: 'What: tests failed.' })
    const gaveBackAtDelivery: number[] = []
    const deliveredBefore = h.toWorker().length
    await settle()
    gaveBackAtDelivery.push(h.held[0]!.gaveBack())

    expect(h.toWorker()).toHaveLength(deliveredBefore + 1)
    expect(h.toWorker().at(-1)!.task).toContain('[Check failed]')
    expect(gaveBackAtDelivery).toEqual([1])
    expect(h.engine.checksInFlight()).toBe(0)
  })

  it('a hold that breaks still checks the work, and never strands the task', async () => {
    const h = makeHarness({ holdRejects: true })
    const id = await heldTask(h)

    expect(h.ran).toEqual([id])
    h.answers[0]!({ verdict: 'pass' })
    await settle()
    expect(statusOf(h.board, id)).toBe('done')
    expect(h.engine.checksInFlight()).toBe(0)
  })

  it("a person's move ends the wait at once, and the check never runs", async () => {
    const h = makeHarness()
    const id = await heldTask(h)

    await h.board.updateStatus(id, 'cancelled') // the person's move
    await h.engine.personMovedTask(id, 'cancelled')
    await settle()

    expect(h.held[0]!.signal.aborted).toBe(true)
    expect(h.held[0]!.gaveBack()).toBe(1)
    await vi.advanceTimersByTimeAsync(WORK_CHECK_HOLD_LIMIT_MS + 60_000)
    expect(h.ran).toEqual([])
    expect(statusOf(h.board, id)).toBe('cancelled')
    expect(h.engine.checksInFlight()).toBe(0)
    expect(h.engine.taskForSession(sk('a2'))).toBeNull()
  })

  it('a Stop ends the wait at once: the check never runs and the task goes back to To do', async () => {
    const h = makeHarness()
    const id = await heldTask(h)

    h.stop()
    await h.engine.markStopped()
    await settle()
    await vi.advanceTimersByTimeAsync(REFLECT_WINDOW_MS)

    expect(h.held[0]!.signal.aborted).toBe(true)
    expect(h.held[0]!.gaveBack()).toBe(1)
    expect(h.ran).toEqual([])
    expect(statusOf(h.board, id)).toBe('todo')
    expect(h.board.completed.map((c) => c.outcome.status)).toEqual(['cancelled'])
    expect(h.updates()).toHaveLength(0)
    expect(h.engine.checksInFlight()).toBe(0)
  })

  it("a Stop keeps the finished run's report: on the task and on its closed run", async () => {
    const h = makeHarness()
    const id = await heldTask(h)

    h.stop()
    await h.engine.markStopped()
    await settle()

    expect(h.board.comments.filter((c) => c.taskId === id).map((c) => c.body)).toContain('fixed')
    expect(h.board.completed.at(-1)?.outcome).toMatchObject({
      status: 'cancelled',
      summary: 'fixed',
    })
  })

  it("a Stop before a fix round keeps the finished run's report too", async () => {
    const h = makeHarness()
    const id = await heldTask(h)
    h.held[0]!.clear()
    await settle()

    h.stop()
    await h.engine.markStopped()
    await h.board.updateStatus(id, 'in_progress') // the check failed with an attempt left
    h.answers[0]!({ verdict: 'retry', fixNote: 'What: tests failed.' })
    await settle()

    expect(statusOf(h.board, id)).toBe('todo')
    expect(h.board.comments.filter((c) => c.taskId === id).map((c) => c.body)).toContain('fixed')
    expect(h.board.completed.at(-1)?.outcome).toMatchObject({ summary: 'fixed' })
  })

  it('a Stop that lands as the wait ends starts no check either', async () => {
    const h = makeHarness()
    const id = await heldTask(h)

    h.stop() // markStopped has not run yet
    h.held[0]!.clear()
    await settle()

    expect(h.ran).toEqual([])
    expect(statusOf(h.board, id)).toBe('todo')
    expect(h.engine.checksInFlight()).toBe(0)
  })

  it('a Stop whose move the board refuses keeps the task short of Done and tries again', async () => {
    const h = makeHarness()
    const update = h.board.updateStatus.bind(h.board)
    let refusals = 1
    h.board.updateStatus = async (taskId, status) =>
      status === 'in_progress' && refusals-- > 0 ? false : update(taskId, status)
    const id = await heldTask(h)

    h.stop()
    await h.engine.markStopped()
    await settle()
    expect(statusOf(h.board, id)).toBe('in_review')
    expect(h.engine.checksInFlight()).toBe(1)

    await h.engine.sweepStaleSessions()
    await settle()
    expect(statusOf(h.board, id)).toBe('blocked')
    expect(h.board.comments.some((c) => /Stop/.test(c.body))).toBe(true)
    expect(h.ran).toEqual([])
    expect(h.engine.checksInFlight()).toBe(0)
  })

  it("a Stop that races a person's move leaves the card where the person put it", async () => {
    const h = makeHarness()
    const id = await heldTask(h)

    await h.board.updateStatus(id, 'done') // written, but its handling has not arrived
    h.stop()
    await h.engine.markStopped()
    await settle()

    expect(h.ran).toEqual([])
    expect(statusOf(h.board, id)).toBe('done')
    expect(h.engine.checksInFlight()).toBe(0)
    expect(h.engine.taskForSession(sk('a2'))).toBeNull()
  })

  it('a teardown ends the wait, and the next engine hands the task to a person', async () => {
    const h = makeHarness()
    const id = await heldTask(h)

    h.engine.reset()
    await settle()
    expect(h.held[0]!.signal.aborted).toBe(true)
    expect(h.ran).toEqual([])
    expect(statusOf(h.board, id)).toBe('in_review')

    const next = createBoardOrchestrator({
      teamId: 't1',
      board: h.board,
      known: () => KNOWN,
      leaderAgentId: () => 'leader',
      sessionKeyForAgent: sk,
      agentIdForSession,
      deliver: async (_sessionKey, agentId, task) => {
        h.delivered.push({ agentId, task })
      },
      stopGen: () => 0,
      workCheck: { begin: async () => undefined, prepare: async () => null },
    })
    await next.resume()
    await vi.advanceTimersByTimeAsync(REFLECT_WINDOW_MS)

    expect(statusOf(h.board, id)).toBe('blocked')
    expect(h.board.comments.filter((c) => /restart/i.test(c.body))).toHaveLength(1)
    expect(h.updates()).toHaveLength(1)
  })

  it("does not start a hold for a check a person's move ended while it was being prepared", async () => {
    let finishPrepare = (): void => undefined
    const prepareWaitsOn = new Promise<void>((r) => {
      finishPrepare = r
    })
    const h = makeHarness({ prepareWaitsOn })
    await h.engine.onEvent(
      sk('leader'),
      doneEvent('r1', '<delegate to="@Bug Boo">fix the parser</delegate>'),
    )
    const id = h.board.created.at(-1)!.id
    const ended = h.engine.onEvent(sk('a2'), doneEvent('r2', 'fixed'))
    await settle()

    // The person drags the card back to To do: it runs again from the start.
    await h.board.updateStatus(id, 'todo')
    await h.engine.personMovedTask(id, 'todo')
    await settle()
    expect(statusOf(h.board, id)).toBe('in_progress')
    expect(h.toWorker()).toHaveLength(2)

    finishPrepare()
    await ended
    await settle()

    expect(h.held).toEqual([])
    expect(h.ran).toEqual([])
    expect(statusOf(h.board, id)).toBe('in_progress')
    expect(h.engine.taskForSession(sk('a2'))).toBe(id)
  })

  it('a card put back to In progress during the check does not reach Done unchecked', async () => {
    const h = makeHarness()
    const id = await heldTask(h)
    h.held[0]!.clear()
    await settle()

    await h.board.updateStatus(id, 'in_progress') // through the API; the engine is not told
    h.answers[0]!({ verdict: 'decided' })
    await settle()

    expect(statusOf(h.board, id)).toBe('in_progress')
    expect(h.engine.taskForSession(sk('a2'))).toBeNull()
    expect(h.engine.checksInFlight()).toBe(0)
    expect(h.updates()).toHaveLength(0)
    // The report stays, and the open run is left for the stale sweep to reap.
    expect(h.board.comments.some((c) => c.taskId === id && c.body.includes('fixed'))).toBe(true)
    expect(h.board.completed).toEqual([])
  })

  it('a check with nothing it could look at finishes the task as if there were no check', async () => {
    const h = makeHarness()
    const id = await heldTask(h)
    h.held[0]!.clear()
    await settle()

    h.answers[0]!({ verdict: 'unchecked' })
    await settle()
    await vi.advanceTimersByTimeAsync(REFLECT_WINDOW_MS)

    expect(statusOf(h.board, id)).toBe('done')
    expect(h.updates()).toHaveLength(1)
    expect(h.engine.checksInFlight()).toBe(0)
  })

  it('a detach ends the wait, keeps the report, and frees the place in line at once', async () => {
    const h = makeHarness()
    const id = await heldTask(h)

    await h.board.updateStatus(id, 'cancelled') // an agent's Tasks tool
    expect(h.engine.detachTask(id)).toBe(true)
    await settle()

    expect(h.held[0]!.signal.aborted).toBe(true)
    expect(h.held[0]!.gaveBack()).toBe(1)
    expect(h.engine.checksInFlight()).toBe(0)
    expect(h.ran).toEqual([])
    expect(h.board.comments.some((c) => c.taskId === id && c.body.includes('fixed'))).toBe(true)
    expect(h.board.completed.at(-1)?.outcome).toMatchObject({
      status: 'cancelled',
      summary: 'fixed',
    })
    await vi.advanceTimersByTimeAsync(WORK_CHECK_HOLD_LIMIT_MS + 60_000)
    expect(h.ran).toEqual([])
  })

  it('a detach refused for another turn still ends the wait, and the check finds the task gone', async () => {
    const h = makeHarness({ busy: true })
    const id = await heldTask(h)

    await h.board.updateStatus(id, 'cancelled')
    expect(h.engine.detachTask(id)).toBe(false)
    await settle()

    expect(h.held[0]!.signal.aborted).toBe(true)
    h.answers[0]!({ verdict: 'decided' })
    await settle()
    expect(statusOf(h.board, id)).toBe('cancelled')
    expect(h.engine.checksInFlight()).toBe(0)
    expect(h.held[0]!.gaveBack()).toBe(1)
  })

  it("a Stop after a detach cannot touch the session's next task", async () => {
    const h = makeHarness()
    const first = await heldTask(h)
    await h.board.updateStatus(first, 'cancelled')
    h.engine.detachTask(first)
    await settle()

    await h.engine.onEvent(
      sk('leader'),
      doneEvent('r3', '<delegate to="@Bug Boo">the next thing</delegate>'),
    )
    await settle()
    const second = h.board.created.at(-1)!.id
    expect(h.engine.taskForSession(sk('a2'))).toBe(second)

    h.stop()
    await h.engine.markStopped()
    await settle()

    // The Stop reached the running task the normal way.
    expect(statusOf(h.board, second)).toBe('todo')
    expect(h.board.completed.map((c) => c.outcome.status)).toEqual(['cancelled', 'cancelled'])
  })

  it('a resume while this engine holds a check leaves it alone', async () => {
    const h = makeHarness()
    const id = await heldTask(h)

    await h.engine.resume()

    expect(statusOf(h.board, id)).toBe('in_review')
    expect(h.engine.checksInFlight()).toBe(1)
  })
})
