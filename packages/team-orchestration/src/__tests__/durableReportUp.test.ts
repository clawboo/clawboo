// A delegate's result must reach whoever handed the work off even when the
// server restarts in between. The board keeps the result either way; what a
// restart used to lose was the `[Task Update]` itself: it waited in memory for
// the 3-second batch, then in the nudge queue until the lead's run started, and
// nothing rebuilt it. Each scenario plays one process's engine, lets it die
// (its timers are cleared, nothing is flushed) and starts a fresh engine over
// the same board and the same durable outbox, as a real restart does.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { RuntimeEvent } from '@clawboo/executor'

import {
  createBoardOrchestrator,
  HELD_REPORT_UPS_BUDGET_CHARS,
  MAX_REPORT_UP_REPLAYS,
  REFLECT_WINDOW_MS,
  type KnownAgent,
  type ReportUp,
  type ReportUpOutbox,
  type ReportUpSettlement,
} from '../boardOrchestration'
import type { RunStamp, TurnOrigin } from '../turnOrigin'
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
function endedEvent(runId: string, reason: 'aborted' | 'error'): RuntimeEvent {
  return { kind: 'done', reason, summary: '', runId, sessionId: null, ts: 1, seq: 1 }
}

/** The durable store as the server keeps it, in memory: it outlives each engine. */
class MemoryOutbox implements ReportUpOutbox {
  rows = new Map<
    string,
    { item: ReportUp; replays: number; settled: ReportUpSettlement | null; held: boolean }
  >()
  private n = 0
  /** A broken database: every write after this is set fails. */
  failWrites = false
  record(item: ReportUp, opts: { held?: boolean } = {}): string {
    const id = `ru-${++this.n}`
    this.rows.set(id, {
      item: structuredClone(item),
      replays: 0,
      settled: null,
      held: opts.held === true,
    })
    return id
  }
  pending(): Array<{ id: string; item: ReportUp; replays: number }> {
    return [...this.rows]
      .filter(([, r]) => r.settled === null && !r.held)
      .map(([id, r]) => ({ id, item: structuredClone(r.item), replays: r.replays }))
  }
  hold(ids: string[]): boolean {
    if (this.failWrites) return false
    for (const id of ids) {
      const r = this.rows.get(id)
      if (r && r.settled === null) r.held = true
    }
    return true
  }
  held(): Array<{ id: string; item: ReportUp }> {
    return [...this.rows]
      .filter(([, r]) => r.settled === null && r.held)
      .map(([id, r]) => ({ id, item: structuredClone(r.item) }))
  }
  markReplayed(ids: string[]): boolean {
    if (this.failWrites) return false
    for (const id of ids) {
      const r = this.rows.get(id)
      if (r && r.settled === null) r.replays += 1
    }
    return true
  }
  settle(ids: string[], how: ReportUpSettlement): boolean {
    if (this.failWrites) return false
    for (const id of ids) {
      const r = this.rows.get(id)
      if (r && r.settled === null) r.settled = how
    }
    return true
  }
  settledAs(): Array<ReportUpSettlement | null> {
    return [...this.rows.values()].map((r) => r.settled)
  }
}

type Delivered = { sessionKey: string; agentId: string; task: string; origin: TurnOrigin }

/** One process's engine over the shared board and outbox. */
function boot(
  board: FakeBoard,
  outbox: MemoryOutbox,
  opts: {
    rejectDeliveryTo?: string
    stopGen?: () => number
    known?: () => KnownAgent[]
    leader?: () => string | null
    /** False: the alert could not be written anywhere. */
    alertWrites?: () => boolean
  } = {},
): {
  engine: ReturnType<typeof createBoardOrchestrator>
  delivered: Delivered[]
  updates: () => Delivered[]
  alerts: Array<{ sessionKey: string; text: string }>
} {
  const delivered: Delivered[] = []
  const alerts: Array<{ sessionKey: string; text: string }> = []
  const engine = createBoardOrchestrator({
    teamId: 't1',
    board,
    known: opts.known ?? (() => KNOWN),
    leaderAgentId: opts.leader ?? (() => 'leader'),
    sessionKeyForAgent: sk,
    agentIdForSession,
    deliver: async (sessionKey, agentId, task, origin) => {
      if (agentId === opts.rejectDeliveryTo) throw new Error('chat.send failed')
      delivered.push({ sessionKey, agentId, task, origin })
    },
    stopGen: opts.stopGen ?? (() => 0),
    narrate: (sessionKey, text, kind) => {
      if (kind !== 'alert') return
      if (opts.alertWrites && !opts.alertWrites()) return false
      alerts.push({ sessionKey, text })
    },
    reportUps: outbox,
  })
  return {
    engine,
    delivered,
    updates: () => delivered.filter((d) => d.task.startsWith('[Task Update]')),
    alerts,
  }
}

/** The stamp the host hands back with each event of the run that carried `origin`. */
function stampFor(origin: TurnOrigin): RunStamp {
  return {
    reportForTaskId: null,
    stopGen: 0,
    ...(origin.kind === 'system' && origin.reportUpIds ? { reportUpIds: origin.reportUpIds } : {}),
  }
}

/** The process dies: its timers go with it and nothing is flushed. */
const kill = (): void => {
  vi.clearAllTimers()
}

/** The lead hands a task to Bug Boo, and Bug Boo finishes it. */
async function delegateAndFinish(
  engine: ReturnType<typeof createBoardOrchestrator>,
  result = 'fixed in parser.ts, 4 tests green',
): Promise<void> {
  await engine.onEvent(
    sk('leader'),
    doneEvent('r1', '<delegate to="@Bug Boo">fix the bug</delegate>'),
  )
  await engine.onEvent(sk('a2'), doneEvent('r2', result))
}

describe('durable report-up', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => {
    vi.clearAllTimers()
    vi.useRealTimers()
  })

  it('a result that finished just before a restart still reaches the lead after it', async () => {
    const board = new FakeBoard()
    const outbox = new MemoryOutbox()
    const first = boot(board, outbox)
    await delegateAndFinish(first.engine)
    kill() // inside the 3-second batch window

    const second = boot(board, outbox)
    await second.engine.resume()
    await vi.advanceTimersByTimeAsync(REFLECT_WINDOW_MS)

    expect(first.updates()).toHaveLength(0)
    expect(second.updates()).toHaveLength(1)
    expect(second.updates()[0]!.agentId).toBe('leader')
    expect(second.updates()[0]!.task).toContain('fixed in parser.ts')
  })

  it('an update handed to a busy lead whose run never started is sent again after a restart', async () => {
    const board = new FakeBoard()
    const outbox = new MemoryOutbox()
    const first = boot(board, outbox)
    await delegateAndFinish(first.engine)
    await vi.advanceTimersByTimeAsync(REFLECT_WINDOW_MS)
    // Accepted by the host (queued behind the lead's run), then the server died.
    expect(first.updates()).toHaveLength(1)
    kill()

    const second = boot(board, outbox)
    await second.engine.resume()
    await vi.advanceTimersByTimeAsync(REFLECT_WINDOW_MS)

    expect(second.updates()).toHaveLength(1)
    expect(second.updates()[0]!.task).toContain('fixed in parser.ts')
  })

  it('is sent once per restart, however often the pump resumes the engine', async () => {
    const board = new FakeBoard()
    const outbox = new MemoryOutbox()
    const first = boot(board, outbox)
    await delegateAndFinish(first.engine)
    kill()

    const second = boot(board, outbox)
    await second.engine.resume()
    await second.engine.resume()
    await vi.advanceTimersByTimeAsync(REFLECT_WINDOW_MS)
    await second.engine.resume()
    await vi.advanceTimersByTimeAsync(REFLECT_WINDOW_MS)

    expect(second.updates()).toHaveLength(1)
  })

  it('the engine that queued it never replays it to itself', async () => {
    const board = new FakeBoard()
    const outbox = new MemoryOutbox()
    const only = boot(board, outbox)
    await delegateAndFinish(only.engine)
    await only.engine.resume()
    await vi.advanceTimersByTimeAsync(REFLECT_WINDOW_MS)
    await only.engine.resume()
    await vi.advanceTimersByTimeAsync(REFLECT_WINDOW_MS)

    expect(only.updates()).toHaveLength(1)
  })

  it('is settled once the run that carried it ends, so a later restart sends nothing', async () => {
    const board = new FakeBoard()
    const outbox = new MemoryOutbox()
    const first = boot(board, outbox)
    await delegateAndFinish(first.engine)
    await vi.advanceTimersByTimeAsync(REFLECT_WINDOW_MS)
    const update = first.updates()[0]!
    expect(update.origin.kind).toBe('system')
    await first.engine.onEvent(
      sk('leader'),
      doneEvent('r3', 'Bug Boo fixed the parser.'),
      stampFor(update.origin),
    )
    kill()

    const second = boot(board, outbox)
    await second.engine.resume()
    await vi.advanceTimersByTimeAsync(REFLECT_WINDOW_MS)

    expect(second.updates()).toHaveLength(0)
    expect(outbox.settledAs()).toEqual(['delivered'])
  })

  it("another run's terminal on the lead's session does not settle it", async () => {
    const board = new FakeBoard()
    const outbox = new MemoryOutbox()
    const first = boot(board, outbox)
    await delegateAndFinish(first.engine)
    await vi.advanceTimersByTimeAsync(REFLECT_WINDOW_MS)
    // The lead's earlier turn, the one the update queued behind, ends.
    await first.engine.onEvent(sk('leader'), doneEvent('r1-late', 'still working'), {
      reportForTaskId: null,
      stopGen: 0,
    })
    kill()

    const second = boot(board, outbox)
    await second.engine.resume()
    await vi.advanceTimersByTimeAsync(REFLECT_WINDOW_MS)

    expect(second.updates()).toHaveLength(1)
  })

  it('an eviction bumps the stop generation, and that is not a Stop: the next engine still sends it', async () => {
    const board = new FakeBoard()
    const outbox = new MemoryOutbox()
    let gen = 0
    const first = boot(board, outbox, { stopGen: () => gen })
    await delegateAndFinish(first.engine)
    await vi.advanceTimersByTimeAsync(REFLECT_WINDOW_MS)
    const update = first.updates()[0]!
    // Teardown: the host bumps its generation, resets the engine and aborts the run,
    // whose ending reaches an engine that no longer holds the row.
    gen += 1
    first.engine.reset()
    await first.engine.onEvent(
      sk('leader'),
      { kind: 'done', reason: 'aborted', summary: '', runId: 'r3', sessionId: null, ts: 1, seq: 1 },
      { ...stampFor(update.origin), stopGen: 0 },
    )
    kill()
    expect(outbox.held()).toEqual([])
    const second = boot(board, outbox)
    await second.engine.resume()
    await vi.advanceTimersByTimeAsync(REFLECT_WINDOW_MS)
    expect(second.updates()).toHaveLength(1)
  })

  it('a torn-down engine does not settle what its cancelled runs report, so the next engine sends it', async () => {
    const board = new FakeBoard()
    const outbox = new MemoryOutbox()
    const first = boot(board, outbox)
    await delegateAndFinish(first.engine)
    await vi.advanceTimersByTimeAsync(REFLECT_WINDOW_MS)
    const update = first.updates()[0]!
    // Teardown (an idle unload, or shutdown): the host cancels the update's run,
    // which never started, and that ending reaches the engine after its reset.
    first.engine.reset()
    await first.engine.onEvent(
      sk('leader'),
      { kind: 'done', reason: 'aborted', summary: '', runId: 'r3', sessionId: null, ts: 1, seq: 1 },
      stampFor(update.origin),
    )
    kill()

    const second = boot(board, outbox)
    await second.engine.resume()
    await vi.advanceTimersByTimeAsync(REFLECT_WINDOW_MS)

    expect(second.updates()).toHaveLength(1)
  })

  it("a Stop wakes no one and drops nothing: the update waits for the lead's next run, even across a restart", async () => {
    const board = new FakeBoard()
    const outbox = new MemoryOutbox()
    const first = boot(board, outbox)
    await delegateAndFinish(first.engine)
    await vi.advanceTimersByTimeAsync(REFLECT_WINDOW_MS)
    expect(first.updates()).toHaveLength(1)
    await first.engine.markStopped()
    expect(outbox.settledAs()).toEqual([null])
    expect(outbox.pending()).toEqual([])
    kill()

    const second = boot(board, outbox)
    await second.engine.resume()
    await second.engine.sweepStaleSessions()
    await vi.advanceTimersByTimeAsync(REFLECT_WINDOW_MS)
    expect(second.updates()).toEqual([])

    // The lead's next run, whatever started it, takes it, and it settles with that run.
    const taken = second.engine.takeHeldReportUps(sk('leader'))
    expect(taken?.text).toContain('fixed in parser.ts')
    expect(taken?.text).toContain('after a person pressed Stop')
    expect(second.engine.takeHeldReportUps(sk('leader'))).toBeNull()
    await second.engine.onEvent(sk('leader'), doneEvent('r9', 'noted'), {
      reportForTaskId: null,
      stopGen: 0,
      reportUpIds: taken!.ids,
    })
    expect(outbox.settledAs()).toEqual(['delivered'])
  })

  it('a run that carried it and failed leaves it held, for the run after', async () => {
    const board = new FakeBoard()
    const outbox = new MemoryOutbox()
    const { engine } = boot(board, outbox)
    await delegateAndFinish(engine)
    await vi.advanceTimersByTimeAsync(REFLECT_WINDOW_MS)
    await engine.markStopped()
    const taken = engine.takeHeldReportUps(sk('leader'))!
    await engine.onEvent(sk('leader'), endedEvent('r9', 'error'), {
      reportForTaskId: null,
      stopGen: 0,
      reportUpIds: taken.ids,
    })
    expect(outbox.settledAs()).toEqual([null])
    expect(outbox.pending()).toEqual([])
    await engine.sweepStaleSessions()
    expect(engine.takeHeldReportUps(sk('leader'))?.ids).toEqual(taken.ids)
  })

  it('a task update still in the batch window when the Stop lands starts no run', async () => {
    const board = new FakeBoard()
    const outbox = new MemoryOutbox()
    const { engine, updates } = boot(board, outbox)
    await delegateAndFinish(engine)
    await engine.markStopped()
    await vi.advanceTimersByTimeAsync(REFLECT_WINDOW_MS * 2)
    expect(updates()).toEqual([])
    expect(engine.takeHeldReportUps(sk('leader'))?.text).toContain('fixed in parser.ts')
  })

  it('a run delivered before the Stop that finishes after it still reports, on the next run', async () => {
    const board = new FakeBoard()
    const outbox = new MemoryOutbox()
    let gen = 0
    const { engine, updates } = boot(board, outbox, { stopGen: () => gen })
    await engine.onEvent(
      sk('leader'),
      doneEvent('r1', '<delegate to="@Bug Boo">fix the bug</delegate>'),
    )
    gen += 1 // the Stop; the delegate's run ended well before its abort landed
    await engine.onEvent(sk('a2'), doneEvent('r2', 'fixed it just in time'))
    await engine.markStopped()
    await vi.advanceTimersByTimeAsync(REFLECT_WINDOW_MS * 2)
    expect(updates()).toEqual([])
    expect(engine.takeHeldReportUps(sk('leader'))?.text).toContain('fixed it just in time')
  })

  it('an update goes only to the run of the agent it reports to, and a null recipient to the lead', async () => {
    const board = new FakeBoard()
    const outbox = new MemoryOutbox()
    const { engine } = boot(board, outbox)
    outbox.record({ toAgentId: null, by: 'Bug Boo', summary: 'for the lead' }, { held: true })
    outbox.record({ toAgentId: 'a2', by: 'Doc Boo', summary: 'for bug boo' }, { held: true })
    expect(engine.takeHeldReportUps(sk('a2'))?.text).toContain('for bug boo')
    expect(engine.takeHeldReportUps(sk('a2'))).toBeNull()
    expect(engine.takeHeldReportUps(sk('leader'))?.text).toContain('for the lead')
  })

  it('long results wait their turn, and one too long for any run goes cut', async () => {
    const board = new FakeBoard()
    const outbox = new MemoryOutbox()
    const { engine } = boot(board, outbox)
    outbox.record(
      { toAgentId: 'leader', by: 'A', summary: 'x'.repeat(HELD_REPORT_UPS_BUDGET_CHARS + 5_000) },
      { held: true },
    )
    outbox.record({ toAgentId: 'leader', by: 'B', summary: 'second result' }, { held: true })
    const first = engine.takeHeldReportUps(sk('leader'))!
    expect(first.ids).toHaveLength(1)
    expect(first.text).toContain('(cut: get_task reads the whole result')
    expect(first.text).not.toContain('second result')
    expect(engine.takeHeldReportUps(sk('leader'))?.text).toContain('second result')
  })

  it(`gives up after ${MAX_REPORT_UP_REPLAYS} replays that never finished, and tells the lead's chat`, async () => {
    const board = new FakeBoard()
    const outbox = new MemoryOutbox()
    const first = boot(board, outbox)
    await delegateAndFinish(first.engine)
    kill()

    let sent = 0
    for (let i = 0; i < MAX_REPORT_UP_REPLAYS; i++) {
      const next = boot(board, outbox)
      await next.engine.resume()
      await vi.advanceTimersByTimeAsync(REFLECT_WINDOW_MS)
      sent += next.updates().length
      kill() // dies again before the lead's run ends
    }
    expect(sent).toBe(MAX_REPORT_UP_REPLAYS)

    const last = boot(board, outbox)
    await last.engine.resume()
    await vi.advanceTimersByTimeAsync(REFLECT_WINDOW_MS)

    expect(last.updates()).toHaveLength(0)
    expect(last.alerts).toHaveLength(1)
    expect(last.alerts[0]!.sessionKey).toBe(sk('leader'))
    expect(last.alerts[0]!.text).toMatch(/on the board/)
    expect(outbox.settledAs()).toEqual(['gave_up'])
  })

  it('an update whose delivery kept failing is given up for good, not replayed after a restart', async () => {
    const board = new FakeBoard()
    const outbox = new MemoryOutbox()
    const first = boot(board, outbox, { rejectDeliveryTo: 'leader' })
    await delegateAndFinish(first.engine)
    for (let i = 0; i < 6; i++) await vi.advanceTimersByTimeAsync(REFLECT_WINDOW_MS)
    expect(first.alerts).toHaveLength(1)
    kill()

    const second = boot(board, outbox)
    await second.engine.resume()
    await vi.advanceTimersByTimeAsync(REFLECT_WINDOW_MS)

    expect(second.updates()).toHaveLength(0)
    expect(outbox.settledAs()).toEqual(['gave_up'])
  })

  it('a replay goes to the same recipient, as the same follow-up', async () => {
    const board = new FakeBoard()
    const outbox = new MemoryOutbox()
    // A task someone already closed: one still open would take this at its next run.
    const parent = (await board.createTask({ title: 'parent', status: 'done', teamId: 't1' }))!
    outbox.record({
      toAgentId: 'a2',
      by: 'Design Boo',
      title: 'mock the settings page',
      summary: 'mockups in design/settings.fig',
      taskId: 'sub-1',
      forTaskId: parent.id,
    })

    const engine = boot(board, outbox)
    await engine.engine.resume()
    await vi.advanceTimersByTimeAsync(REFLECT_WINDOW_MS)

    expect(engine.updates()).toHaveLength(1)
    const update = engine.updates()[0]!
    expect(update.agentId).toBe('a2')
    expect(update.origin).toMatchObject({ kind: 'system', forTaskId: parent.id })
    expect(update.task).toContain('mockups in design/settings.fig')
  })
  it('a lead run killed by a graceful shutdown leaves its update pending for the next process', async () => {
    const board = new FakeBoard()
    const outbox = new MemoryOutbox()
    const first = boot(board, outbox)
    await delegateAndFinish(first.engine)
    await vi.advanceTimersByTimeAsync(REFLECT_WINDOW_MS)
    // Shutdown signals the lead's child; its driver reports the run aborted.
    await first.engine.onEvent(
      sk('leader'),
      endedEvent('r3', 'aborted'),
      stampFor(first.updates()[0]!.origin),
    )
    kill()

    const second = boot(board, outbox)
    await second.engine.resume()
    await vi.advanceTimersByTimeAsync(REFLECT_WINDOW_MS)

    expect(second.updates()).toHaveLength(1)
    expect(outbox.settledAs()).toEqual([null])
  })

  it('a lead run that failed is sent again by the next sweep, then given up at the cap', async () => {
    const board = new FakeBoard()
    const outbox = new MemoryOutbox()
    const only = boot(board, outbox)
    await delegateAndFinish(only.engine)
    await vi.advanceTimersByTimeAsync(REFLECT_WINDOW_MS)
    for (let i = 0; i < MAX_REPORT_UP_REPLAYS; i++) {
      const last = only.updates().at(-1)!
      await only.engine.onEvent(
        sk('leader'),
        endedEvent(`fail-${i}`, 'error'),
        stampFor(last.origin),
      )
      await only.engine.sweepStaleSessions()
      await vi.advanceTimersByTimeAsync(REFLECT_WINDOW_MS)
      expect(only.updates()).toHaveLength(i + 2)
    }
    const last = only.updates().at(-1)!
    await only.engine.onEvent(sk('leader'), endedEvent('fail-last', 'error'), stampFor(last.origin))
    await only.engine.sweepStaleSessions()
    await vi.advanceTimersByTimeAsync(REFLECT_WINDOW_MS)

    expect(only.updates()).toHaveLength(MAX_REPORT_UP_REPLAYS + 1)
    expect(only.alerts).toHaveLength(1)
    expect(outbox.settledAs()).toEqual(['gave_up'])
  })

  it('a lead run that a Stop cut short keeps its update for the next run', async () => {
    const board = new FakeBoard()
    const outbox = new MemoryOutbox()
    let gen = 0
    const first = boot(board, outbox, { stopGen: () => gen })
    await delegateAndFinish(first.engine)
    await vi.advanceTimersByTimeAsync(REFLECT_WINDOW_MS)
    gen += 1 // the Stop; its abort reaches the engine before markStopped runs
    await first.engine.onEvent(sk('leader'), endedEvent('r3', 'aborted'), {
      ...stampFor(first.updates()[0]!.origin),
      stopGen: 0,
    })
    expect(outbox.settledAs()).toEqual([null])
    expect(outbox.pending()).toEqual([])
    kill()

    const second = boot(board, outbox)
    await second.engine.resume()
    await vi.advanceTimersByTimeAsync(REFLECT_WINDOW_MS)
    expect(second.updates()).toEqual([])
    expect(second.engine.takeHeldReportUps(sk('leader'))?.text).toContain('fixed in parser.ts')
  })

  it('a lead run delivered before the Stop that finished anyway did hear it', async () => {
    const board = new FakeBoard()
    const outbox = new MemoryOutbox()
    const { engine, updates } = boot(board, outbox)
    await delegateAndFinish(engine)
    await vi.advanceTimersByTimeAsync(REFLECT_WINDOW_MS)
    const stamp = stampFor(updates()[0]!.origin)
    await engine.markStopped()
    await engine.onEvent(sk('leader'), doneEvent('r3', 'synthesized'), stamp)
    expect(outbox.settledAs()).toEqual(['delivered'])
    expect(engine.takeHeldReportUps(sk('leader'))).toBeNull()
  })

  it('a teardown does not flush an update the outbox holds, so only the next engine sends it', async () => {
    const board = new FakeBoard()
    const outbox = new MemoryOutbox()
    const first = boot(board, outbox)
    await delegateAndFinish(first.engine)
    first.engine.reset() // inside the 3-second batch window
    await vi.advanceTimersByTimeAsync(REFLECT_WINDOW_MS)
    kill()

    const second = boot(board, outbox)
    await second.engine.resume()
    await vi.advanceTimersByTimeAsync(REFLECT_WINDOW_MS)

    expect(first.updates()).toHaveLength(0)
    expect(second.updates()).toHaveLength(1)
  })

  it('an accepted delivery that never started is sent again by the next sweep', async () => {
    const board = new FakeBoard()
    const outbox = new MemoryOutbox()
    const only = boot(board, outbox)
    await delegateAndFinish(only.engine)
    await vi.advanceTimersByTimeAsync(REFLECT_WINDOW_MS)
    // Queued behind the lead's run, then its start failed: the host says so.
    only.engine.onRunNotStarted(stampFor(only.updates()[0]!.origin))
    await only.engine.sweepStaleSessions()
    await vi.advanceTimersByTimeAsync(REFLECT_WINDOW_MS)

    expect(only.updates()).toHaveLength(2)
  })

  it('is settled even when handling the run that carried it throws', async () => {
    const board = new FakeBoard()
    const outbox = new MemoryOutbox()
    let broken = false
    const first = boot(board, outbox, {
      known: () => {
        if (broken) throw new Error('roster read failed')
        return KNOWN
      },
    })
    await delegateAndFinish(first.engine)
    await vi.advanceTimersByTimeAsync(REFLECT_WINDOW_MS)
    broken = true
    await expect(
      first.engine.onEvent(
        sk('leader'),
        doneEvent('r3', 'summary'),
        stampFor(first.updates()[0]!.origin),
      ),
    ).rejects.toThrow('roster read failed')

    expect(outbox.settledAs()).toEqual(['delivered'])
  })

  it('a settlement that could not be written keeps the update held, so this engine never sends it twice', async () => {
    const board = new FakeBoard()
    const outbox = new MemoryOutbox()
    const only = boot(board, outbox)
    await delegateAndFinish(only.engine)
    await vi.advanceTimersByTimeAsync(REFLECT_WINDOW_MS)
    outbox.failWrites = true
    await only.engine.onEvent(
      sk('leader'),
      doneEvent('r3', 'summary'),
      stampFor(only.updates()[0]!.origin),
    )
    outbox.failWrites = false
    await only.engine.resume()
    await only.engine.sweepStaleSessions()
    await vi.advanceTimersByTimeAsync(REFLECT_WINDOW_MS)

    expect(only.updates()).toHaveLength(1)
  })

  it('a settlement whose write failed is written by a later sweep, so no later engine resends it', async () => {
    const board = new FakeBoard()
    const outbox = new MemoryOutbox()
    const first = boot(board, outbox)
    await delegateAndFinish(first.engine)
    await vi.advanceTimersByTimeAsync(REFLECT_WINDOW_MS)
    outbox.failWrites = true
    await first.engine.onEvent(
      sk('leader'),
      doneEvent('r3', 'summary'),
      stampFor(first.updates()[0]!.origin),
    )
    outbox.failWrites = false
    await first.engine.sweepStaleSessions()
    expect(outbox.settledAs()).toEqual(['delivered'])
    kill()

    const second = boot(board, outbox)
    await second.engine.resume()
    await vi.advanceTimersByTimeAsync(REFLECT_WINDOW_MS)
    expect(second.updates()).toHaveLength(0)
  })

  it('a room with no lead neither sends nor counts an update for its lead, and sends it once one is set', async () => {
    const board = new FakeBoard()
    const outbox = new MemoryOutbox()
    outbox.record({ toAgentId: null, by: 'Bug Boo', summary: 'fixed in parser.ts' })
    for (let i = 0; i < MAX_REPORT_UP_REPLAYS + 1; i++) {
      const noLead = boot(board, outbox, { leader: () => null })
      await noLead.engine.resume()
      await vi.advanceTimersByTimeAsync(REFLECT_WINDOW_MS)
      kill()
    }
    expect(outbox.settledAs()).toEqual([null])
    expect([...outbox.rows.values()][0]!.replays).toBe(0)

    let lead: string | null = null
    const later = boot(board, outbox, { leader: () => lead })
    await later.engine.resume()
    lead = 'leader' // a lead joins the room
    await later.engine.sweepStaleSessions()
    await vi.advanceTimersByTimeAsync(REFLECT_WINDOW_MS)

    expect(later.updates()).toHaveLength(1)
    expect(later.updates()[0]!.agentId).toBe('leader')
  })

  it('an update is given up only once the alert that says so is written', async () => {
    const board = new FakeBoard()
    const outbox = new MemoryOutbox()
    const id = outbox.record({ toAgentId: 'leader', by: 'Bug Boo', summary: 'fixed' })
    outbox.rows.get(id)!.replays = MAX_REPORT_UP_REPLAYS
    let writes = false
    const only = boot(board, outbox, { alertWrites: () => writes })
    await only.engine.resume()
    expect(outbox.settledAs()).toEqual([null])

    writes = true
    await only.engine.sweepStaleSessions()
    expect(outbox.settledAs()).toEqual(['gave_up'])
    expect(only.alerts).toHaveLength(1)
  })

  it('an update whose last delivery try failed, and whose alert could not be written, is tried again later', async () => {
    const board = new FakeBoard()
    const outbox = new MemoryOutbox()
    let writes = false
    const only = boot(board, outbox, { rejectDeliveryTo: 'leader', alertWrites: () => writes })
    await delegateAndFinish(only.engine)
    for (let i = 0; i < 6; i++) await vi.advanceTimersByTimeAsync(REFLECT_WINDOW_MS)
    expect(outbox.settledAs()).toEqual([null])

    writes = true
    for (let i = 0; i < MAX_REPORT_UP_REPLAYS + 1; i++) {
      await only.engine.sweepStaleSessions()
      for (let j = 0; j < 6; j++) await vi.advanceTimersByTimeAsync(REFLECT_WINDOW_MS)
    }
    expect(outbox.settledAs()).toEqual(['gave_up'])
  })
})

describe('a report-up a pause holds back', () => {
  const NOTE = 'Stopped: this agent is paused.'

  beforeEach(() => vi.useFakeTimers())
  afterEach(() => {
    vi.clearAllTimers()
    vi.useRealTimers()
  })

  function pausedHarness(paused: Set<string>) {
    const board = new FakeBoard()
    const outbox = new MemoryOutbox()
    const delivered: Delivered[] = []
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
      reportUps: outbox,
      runHeldBy: ({ agentId, taskId }) =>
        paused.has(agentId) || (taskId !== null && paused.has(taskId)) ? NOTE : null,
    })
    return {
      engine,
      board,
      outbox,
      updates: () => delivered.filter((d) => d.task.startsWith('[Task Update]')),
    }
  }

  /** A worker finished a task the leader handed it: one report-up, on its way. */
  async function finished(h: ReturnType<typeof pausedHarness>): Promise<string> {
    await h.engine.onEvent(
      sk('leader'),
      {
        kind: 'done',
        reason: 'success',
        summary: '<delegate to="@Bug Boo">fix it</delegate>',
        runId: 'r1',
        sessionId: null,
        ts: 1,
        seq: 1,
      },
      { reportForTaskId: null, stopGen: 0 },
    )
    const id = h.board.created.at(-1)!.id
    await h.engine.onEvent(
      sk('a2'),
      {
        kind: 'done',
        reason: 'success',
        summary: 'fixed',
        runId: 'r2',
        sessionId: null,
        ts: 1,
        seq: 1,
      },
      { reportForTaskId: null, stopGen: 0 },
    )
    return id
  }

  it('does not deliver to a paused recipient, so nothing waits on it, and keeps the row pending', async () => {
    const paused = new Set(['leader'])
    const h = pausedHarness(paused)
    await finished(h)
    await vi.advanceTimersByTimeAsync(REFLECT_WINDOW_MS + 10)

    expect(h.updates()).toHaveLength(0)
    expect(h.outbox.pending()).toHaveLength(1)
    expect(h.outbox.pending()[0]?.replays).toBe(0)
  })

  it('does not count or send it on the sweep while the pause lasts, and sends it after', async () => {
    const paused = new Set(['leader'])
    const h = pausedHarness(paused)
    await finished(h)
    await vi.advanceTimersByTimeAsync(REFLECT_WINDOW_MS + 10)
    h.engine.sweepStaleSessions()
    await vi.advanceTimersByTimeAsync(REFLECT_WINDOW_MS + 10)
    expect(h.updates()).toHaveLength(0)
    expect(h.outbox.pending()[0]?.replays).toBe(0)

    paused.clear()
    h.engine.sweepStaleSessions()
    await vi.advanceTimersByTimeAsync(REFLECT_WINDOW_MS + 10)
    expect(h.updates()).toHaveLength(1)
  })

  it('counts no try for one a pause stopped on its way, and sends it after the resume', async () => {
    const paused = new Set<string>()
    const h = pausedHarness(paused)
    await finished(h)
    await vi.advanceTimersByTimeAsync(REFLECT_WINDOW_MS + 10)
    const sent = h.updates()[0]!
    const reportUpIds = sent.origin.kind === 'system' ? sent.origin.reportUpIds! : []
    expect(reportUpIds).toHaveLength(1)

    // Its run is aborted by the pause.
    paused.add('leader')
    await h.engine.onEvent(
      sk('leader'),
      {
        kind: 'done',
        reason: 'aborted',
        summary: '',
        runId: 'r3',
        sessionId: null,
        ts: 1,
        seq: 1,
      },
      { reportForTaskId: null, stopGen: 0, reportUpIds, stoppedByPause: true },
    )
    h.engine.sweepStaleSessions()
    await vi.advanceTimersByTimeAsync(REFLECT_WINDOW_MS + 10)
    expect(h.updates()).toHaveLength(1)

    paused.clear()
    h.engine.sweepStaleSessions()
    await vi.advanceTimersByTimeAsync(REFLECT_WINDOW_MS + 10)
    expect(h.updates()).toHaveLength(2)
    expect(h.outbox.pending()[0]?.replays).toBe(0)
  })

  it('a Stop during the pause holds what the pause kept back: the resume does not send it', async () => {
    const paused = new Set(['leader'])
    const h = pausedHarness(paused)
    await finished(h)
    await vi.advanceTimersByTimeAsync(REFLECT_WINDOW_MS + 10)
    expect(h.outbox.pending()).toHaveLength(1)

    await h.engine.markStopped()
    paused.clear()
    h.engine.sweepStaleSessions()
    await vi.advanceTimersByTimeAsync(REFLECT_WINDOW_MS + 10)

    expect(h.updates()).toHaveLength(0)
    expect(h.outbox.pending()).toHaveLength(0)
    expect(h.outbox.held()).toHaveLength(1)
  })

  it('holds one about a task in a paused tree, whoever it is for', async () => {
    const paused = new Set<string>()
    const h = pausedHarness(paused)
    const id = await finished(h)
    paused.add(id)
    await vi.advanceTimersByTimeAsync(REFLECT_WINDOW_MS + 10)
    expect(h.updates()).toHaveLength(0)
    expect(h.outbox.pending()).toHaveLength(1)
  })

  it('a paused recipient does not hold up the update for a recipient that is free', async () => {
    const h = pausedHarness(new Set(['a3']))
    h.outbox.record({ toAgentId: 'a3', by: 'Bug Boo', summary: 'for the paused one' })
    h.outbox.record({ toAgentId: 'leader', by: 'Bug Boo', summary: 'for the free one' })
    await h.engine.resume()
    await vi.advanceTimersByTimeAsync(REFLECT_WINDOW_MS + 10)
    expect(h.updates().map((u) => u.agentId)).toEqual(['leader'])
    expect(h.outbox.pending().find((p) => p.item.toAgentId === 'a3')?.replays).toBe(0)
  })
})
