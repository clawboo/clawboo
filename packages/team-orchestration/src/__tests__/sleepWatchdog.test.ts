// The idle watchdog must survive the machine sleeping. Wall-clock time keeps
// running while the process is suspended, so without the host's sweep cadence
// the first sweep on wake would read every in-flight delegate as silent for the
// whole sleep, fail its task, cancel its dependents and tell the lead it timed
// out. These scenarios drive the engine the way the server does: a sweep every
// SWEEP_MS from an interval, with the clock injected.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { RuntimeEvent } from '@clawboo/executor'

import {
  createBoardOrchestrator,
  DELEGATION_IDLE_TIMEOUT_MS,
  type KnownAgent,
} from '../boardOrchestration'
import { FakeBoard } from './fakeBoard'

const SWEEP_MS = 30_000
const MIN = 60_000

const KNOWN: KnownAgent[] = [
  { id: 'leader', name: 'Boo Zero' },
  { id: 'a2', name: 'Bug Boo' },
]

const sk = (id: string): string => `agent:${id}:team:t1`
const agentIdForSession = (s: string): string | null => s.match(/^agent:([^:]+):/)?.[1] ?? null

function doneEvent(runId: string, summary: string): RuntimeEvent {
  return { kind: 'done', reason: 'success', summary, runId, sessionId: null, ts: 1, seq: 1 }
}
function toolCallEvent(runId: string): RuntimeEvent {
  return {
    kind: 'tool-call',
    toolCallId: 'tc',
    name: 'run_command',
    input: { cmd: 'build' },
    partial: false,
    runId,
    sessionId: null,
    ts: 1,
    seq: 1,
  }
}
function toolResultEvent(runId: string): RuntimeEvent {
  return {
    kind: 'tool-result',
    toolCallId: 'tc',
    name: 'run_command',
    output: 'ok',
    isError: false,
    runId,
    sessionId: null,
    ts: 1,
    seq: 1,
  }
}

function makeHarness(opts: { sweepIntervalMs?: number } = { sweepIntervalMs: SWEEP_MS }) {
  let clock = 1_000_000
  const board = new FakeBoard()
  const aborted: string[] = []
  const orchestrator = createBoardOrchestrator({
    teamId: 't1',
    board,
    known: () => KNOWN,
    leaderAgentId: () => 'leader',
    sessionKeyForAgent: sk,
    agentIdForSession,
    deliver: async () => {},
    stopGen: () => 0,
    isSessionBusy: () => false,
    isSessionOccupied: () => false,
    abortSession: (s) => aborted.push(s),
    now: () => clock,
    ...(opts.sweepIntervalMs != null ? { sweepIntervalMs: opts.sweepIntervalMs } : {}),
  })
  return {
    board,
    aborted,
    orchestrator,
    /** The machine sleeps: wall-clock time jumps and no sweep runs. */
    sleep(ms: number): void {
      clock += ms
    },
    /** Time passes with no sweep, as just after a wake before the next one. */
    pass(ms: number): void {
      clock += ms
    },
    /** The process is awake for `ms`: the interval sweeps every SWEEP_MS. */
    async awake(ms: number): Promise<void> {
      for (let t = 0; t < ms; t += SWEEP_MS) {
        clock += SWEEP_MS
        await orchestrator.sweepStaleSessions()
      }
    },
    failed: (): boolean => board.statusUpdates.some((s) => s.status === 'blocked'),
  }
}

/** The leader delegates to Bug Boo; its run starts the idle clock now. */
async function delegate(h: ReturnType<typeof makeHarness>): Promise<string> {
  await h.orchestrator.onEvent(
    sk('leader'),
    doneEvent('r1', '<delegate to="@Bug Boo">fix the login bug</delegate>'),
  )
  const id = h.board.created[0]!.id
  expect(h.board.statusOf(id)).toBe('in_progress')
  return id
}

beforeEach(() => vi.useFakeTimers())
afterEach(() => {
  vi.clearAllTimers()
  vi.useRealTimers()
})

describe('the idle watchdog across a machine sleep', () => {
  it('a 30-minute jump between two sweeps fails nothing', async () => {
    const h = makeHarness()
    const id = await delegate(h)
    await h.awake(2 * MIN)

    // The lid closes for half an hour; the next sweep runs on wake.
    h.sleep(30 * MIN)
    await h.orchestrator.sweepStaleSessions()

    expect(h.failed()).toBe(false)
    expect(h.board.statusOf(id)).toBe('in_progress')
    expect(h.board.completed).toHaveLength(0)
    expect(h.aborted).toHaveLength(0)

    // Still within its 8 minutes of awake silence a few minutes later.
    await h.awake(5 * MIN)
    expect(h.failed()).toBe(false)
  })

  it('a genuinely silent delegate still fails at 8 minutes while sweeps keep running', async () => {
    const h = makeHarness()
    const id = await delegate(h)

    await h.awake(DELEGATION_IDLE_TIMEOUT_MS - SWEEP_MS)
    expect(h.failed()).toBe(false)

    await h.awake(SWEEP_MS)
    expect(h.board.statusUpdates).toContainEqual({ taskId: id, status: 'blocked' })
    expect(h.board.completed[0]!.outcome.status).toBe('timed_out')
    expect(h.aborted).toEqual([sk('a2')])
  })

  it('only the sleep is forgiven: silence on either side of it still adds up to 8 minutes', async () => {
    const h = makeHarness()
    const id = await delegate(h)
    await h.awake(5 * MIN)

    h.sleep(30 * MIN)
    await h.awake(2.5 * MIN)
    expect(h.failed()).toBe(false)

    await h.awake(SWEEP_MS)
    expect(h.board.statusUpdates).toContainEqual({ taskId: id, status: 'blocked' })
  })

  it('an event right after the wake starts a fresh clock, never one pushed past now', async () => {
    const h = makeHarness()
    const id = await delegate(h)
    await h.awake(2 * MIN)

    h.sleep(30 * MIN)
    // The delegate speaks before the first sweep after the wake runs.
    h.pass(10_000)
    await h.orchestrator.onEvent(sk('a2'), toolResultEvent('r2'))

    // Then it goes silent: it fails about 8 minutes later, not 8 plus the sleep.
    await h.awake(DELEGATION_IDLE_TIMEOUT_MS + SWEEP_MS)
    expect(h.board.statusUpdates).toContainEqual({ taskId: id, status: 'blocked' })
  })

  it('a sleep inside an open tool call does not use up its longer allowance', async () => {
    const h = makeHarness()
    await delegate(h)
    await h.orchestrator.onEvent(sk('a2'), toolCallEvent('r2'))
    await h.awake(1 * MIN)

    h.sleep(2 * 60 * MIN)
    await h.awake(1 * MIN)

    expect(h.failed()).toBe(false)
    expect(h.aborted).toHaveLength(0)
  })

  it('a sleep before the first sweep is caught too', async () => {
    const h = makeHarness()
    await delegate(h)

    h.sleep(30 * MIN)
    await h.awake(SWEEP_MS)

    expect(h.failed()).toBe(false)
  })

  it('without the host sweep cadence every gap counts as silence', async () => {
    const h = makeHarness({})
    const id = await delegate(h)
    await h.awake(2 * MIN)

    h.sleep(30 * MIN)
    await h.orchestrator.sweepStaleSessions()

    expect(h.board.statusUpdates).toContainEqual({ taskId: id, status: 'blocked' })
  })
})
