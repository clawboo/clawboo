// A PERSON moving a task's card on the board is the final word on the run that
// was working on it. These scenarios drive the engine against the in-memory
// FakeBoard the way the server does after a board PATCH: the move is written to
// the board FIRST (here, straight onto the fake's row, since it is the REST
// route's write and not one the engine made), then the engine is told.
//
// What must hold: the run is aborted and its execution closed as cancelled, the
// delegator hears what the person decided (never a person's own assignment),
// a card put back to To do while running starts over once its old run has ended,
// and the old run's late terminal can neither complete, fail, nor re-stamp the
// task the person already decided.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { encodeHumanAssignment } from '@clawboo/board-core'
import type { RuntimeEvent } from '@clawboo/executor'

import {
  createBoardOrchestrator,
  REFLECT_WINDOW_MS,
  type BoardChange,
  type KnownAgent,
} from '../boardOrchestration'
import type { TurnOrigin } from '../turnOrigin'
import { FakeBoard } from './fakeBoard'

const KNOWN: KnownAgent[] = [
  { id: 'leader', name: 'Boo Zero' },
  { id: 'a2', name: 'Bug Boo' },
  { id: 'a3', name: 'Design Boo' },
]

const sk = (id: string): string => `agent:${id}:team:t1`
const agentIdForSession = (s: string): string | null => s.match(/^agent:([^:]+):/)?.[1] ?? null

function doneEvent(runId: string, summary: string): RuntimeEvent {
  return { kind: 'done', reason: 'success', summary, runId, sessionId: null, ts: 1, seq: 1 }
}
function failedDoneEvent(
  runId: string,
  reason: 'error' | 'aborted' | 'max_turns',
  summary: string,
): RuntimeEvent {
  return { kind: 'done', reason, summary, runId, sessionId: null, ts: 1, seq: 1 }
}
function fatalErrorEvent(runId: string, message: string): RuntimeEvent {
  return { kind: 'error', code: null, message, fatal: true, runId, sessionId: null, ts: 1, seq: 1 }
}

type Delivered = { sessionKey: string; agentId: string; task: string; origin: TurnOrigin }
const reflections = (delivered: Delivered[]): Delivered[] =>
  delivered.filter((d) => d.task.startsWith('[Task Update]'))

/** A FakeBoard whose next `getTask` can be held, to land other events while a
 *  read is out (as a board backed by real I/O would let them). */
class HeldBoard extends FakeBoard {
  private hold: Promise<void> | null = null
  /** Hold the next `getTask` until the returned function is called. */
  holdNextGetTask(): () => void {
    let release!: () => void
    this.hold = new Promise<void>((r) => {
      release = r
    })
    return release
  }
  override async getTask(taskId: string) {
    const hold = this.hold
    if (hold) {
      this.hold = null
      await hold
    }
    return super.getTask(taskId)
  }
}

function makeHarness(opts: { occupied?: Set<string>; busy?: Set<string>; board?: FakeBoard } = {}) {
  const board = opts.board ?? new FakeBoard()
  const delivered: Delivered[] = []
  const changes: BoardChange[] = []
  const narrations: string[] = []
  const aborted: string[] = []
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
    isSessionBusy: (s) => opts.busy?.has(s) ?? false,
    isSessionOccupied: (s) => opts.occupied?.has(s) ?? false,
    onBoardChange: (c) => changes.push(c),
    narrate: (_s, text) => narrations.push(text),
    abortSession: (s) => aborted.push(s),
  })
  return { board, delivered, changes, narrations, aborted, orchestrator }
}

/** The board PATCH's own write: the card moves, as a person moved it. Not an
 *  engine call, so it is not recorded in `statusUpdates`. */
function personMoves(board: FakeBoard, taskId: string, to: string): void {
  const row = board.tasks.get(taskId)!
  row.status = to
  if (to === 'todo') row.assigneeAgentId = null
}

/** A leader delegation to Bug Boo, running: its task id and its execution id. */
async function runningDelegation(h: ReturnType<typeof makeHarness>, task = 'fix the login bug') {
  await h.orchestrator.onEvent(
    sk('leader'),
    doneEvent('r1', `<delegate to="@Bug Boo">${task}</delegate>`),
  )
  const id = h.board.created[0]!.id
  const execId = h.orchestrator.execForSession(sk('a2'))
  expect(execId).not.toBeNull()
  expect(h.board.statusOf(id)).toBe('in_progress')
  return { id, execId: execId! }
}

/** A two-step plan from the leader: Bug Boo, then Design Boo. Step one runs. */
async function runningPlan(h: ReturnType<typeof makeHarness>) {
  await h.orchestrator.onEvent(
    sk('leader'),
    doneEvent(
      'r1',
      '<plan><step to="@Bug Boo">step one</step><step to="@Design Boo">step two</step></plan>',
    ),
  )
  const [one, two] = h.board.created.map((t) => t.id)
  expect(h.board.statusOf(one!)).toBe('in_progress')
  expect(h.board.statusOf(two!)).toBe('todo')
  return { one: one!, two: two!, execId: h.orchestrator.execForSession(sk('a2'))! }
}

beforeEach(() => vi.useFakeTimers())
afterEach(() => {
  vi.clearAllTimers()
  vi.useRealTimers()
})

describe('personMovedTask: a person cancels or finishes a running task', () => {
  it('stops the run, closes its execution as cancelled, and tells the delegator it was cancelled', async () => {
    const h = makeHarness()
    const { id, execId } = await runningDelegation(h)

    personMoves(h.board, id, 'cancelled')
    await h.orchestrator.personMovedTask(id, 'cancelled')

    expect(h.aborted).toEqual([sk('a2')])
    expect(h.board.completed).toEqual([
      {
        execId,
        outcome: { status: 'cancelled', error: 'Stopped: a person moved the card to Cancelled.' },
      },
    ])
    expect(h.orchestrator.taskForSession(sk('a2'))).toBeNull()
    expect(h.orchestrator.execForSession(sk('a2'))).toBeNull()
    // The engine wrote no status of its own: the person's move stands.
    expect(h.board.statusUpdates).toEqual([])

    // Batched like any other result, so nothing goes out before the window.
    expect(reflections(h.delivered)).toEqual([])
    await vi.advanceTimersByTimeAsync(REFLECT_WINDOW_MS)
    const sent = reflections(h.delivered)
    expect(sent).toHaveLength(1)
    expect(sent[0]!.sessionKey).toBe(sk('leader'))
    expect(sent[0]!.origin).toEqual({ kind: 'system' })
    expect(sent[0]!.task).toContain("✕ Cancelled by a person (it was Bug Boo's)")
    expect(sent[0]!.task).toContain(
      'A person cancelled it on the board. Do NOT redo cancelled work or hand it to anyone again.',
    )
    expect(sent[0]!.task).toContain('Do not redo it or hand it to anyone again.')
    // A person's decision is not a failure the lead must act on.
    expect(sent[0]!.task).not.toContain('DID NOT COMPLETE')
  })

  it('a person marking it done says so, and that the run was stopped before it reported', async () => {
    const h = makeHarness()
    const { id, execId } = await runningDelegation(h)

    personMoves(h.board, id, 'done')
    await h.orchestrator.personMovedTask(id, 'done')

    expect(h.aborted).toEqual([sk('a2')])
    expect(h.board.completed).toEqual([
      {
        execId,
        outcome: { status: 'cancelled', error: 'Stopped: a person moved the card to Done.' },
      },
    ])
    await vi.advanceTimersByTimeAsync(REFLECT_WINDOW_MS)
    const [sent] = reflections(h.delivered)
    expect(sent!.task).toContain("✓ Marked done by a person (it was Bug Boo's)")
    expect(sent!.task).toContain(
      "A person marked this done on the board. Bug Boo's run was stopped before it reported.",
    )
    expect(sent!.task).not.toContain('A person cancelled')
  })

  it("the stopped run's own late terminal changes nothing, and its stale delegation spawns nothing", async () => {
    const h = makeHarness()
    const { id } = await runningDelegation(h)
    personMoves(h.board, id, 'done')
    await h.orchestrator.personMovedTask(id, 'done')
    await vi.advanceTimersByTimeAsync(REFLECT_WINDOW_MS)
    const completedBefore = h.board.completed.length

    // The abort's own terminal, then a success that raced it and even delegates.
    await h.orchestrator.onEvent(sk('a2'), failedDoneEvent('r2', 'aborted', ''))
    await h.orchestrator.onEvent(
      sk('a2'),
      doneEvent('r2', 'Fixed it anyway. <delegate to="@Design Boo">polish it</delegate>'),
    )
    await vi.advanceTimersByTimeAsync(REFLECT_WINDOW_MS)

    expect(h.board.statusOf(id)).toBe('done')
    expect(h.board.statusUpdates).toEqual([])
    expect(h.board.completed).toHaveLength(completedBefore)
    expect(h.board.comments).toEqual([])
    expect(h.board.taskCount()).toBe(1)
    expect(reflections(h.delivered)).toHaveLength(1) // only the person's own report
    expect(h.narrations.some((n) => n.includes('completed'))).toBe(false)
  })

  it('the plan steps cancelled with it are dropped and named to the delegator', async () => {
    const h = makeHarness()
    const { one, two } = await runningPlan(h)

    personMoves(h.board, one, 'cancelled')
    // The PATCH cancels the steps waiting on it before telling the engine.
    const cancelledDependents = await h.board.cancelDependents(one)
    expect(cancelledDependents).toEqual([{ id: two, title: 'step two' }])
    await h.orchestrator.personMovedTask(one, 'cancelled', { cancelledDependents })

    expect(h.changes).toContainEqual(expect.objectContaining({ id: two, status: 'cancelled' }))
    await vi.advanceTimersByTimeAsync(REFLECT_WINDOW_MS)
    const [sent] = reflections(h.delivered)
    expect(sent!.task).toContain('The later step(s) waiting on it were cancelled too: “step two”.')
    // The cancelled step is never handed to Design Boo.
    expect(h.delivered.some((d) => d.agentId === 'a3')).toBe(false)
  })

  it("a person's Done lets the next plan step start", async () => {
    const h = makeHarness()
    const { one } = await runningPlan(h)

    personMoves(h.board, one, 'done')
    await h.orchestrator.personMovedTask(one, 'done')

    expect(h.aborted).toEqual([sk('a2')])
    expect(h.delivered.at(-1)).toEqual({
      sessionKey: sk('a3'),
      agentId: 'a3',
      task: 'step two',
      origin: { kind: 'delegation', fromAgentId: 'leader' },
    })
  })
})

describe('personMovedTask: who hears about it', () => {
  it('a task a person assigned is reported to no agent, even when this engine ran it', async () => {
    const h = makeHarness()
    const task = await h.board.createTask({
      title: 'Draft the launch post',
      teamId: 't1',
      sourceDelegationId: encodeHumanAssignment('a2', 'n1'),
    })
    expect(await h.orchestrator.dispatchTask(task!.id)).toBe('started')
    const execId = h.orchestrator.execForSession(sk('a2'))

    personMoves(h.board, task!.id, 'cancelled')
    await h.orchestrator.personMovedTask(task!.id, 'cancelled')

    // Still stopped and closed: only the report is skipped.
    expect(h.aborted).toEqual([sk('a2')])
    expect(h.board.completed).toContainEqual({
      execId,
      outcome: { status: 'cancelled', error: 'Stopped: a person moved the card to Cancelled.' },
    })
    await vi.advanceTimersByTimeAsync(REFLECT_WINDOW_MS)
    expect(reflections(h.delivered)).toEqual([])
  })

  it('a person-assigned task this engine never saw is read from its binding', async () => {
    const h = makeHarness()
    const task = await h.board.createTask({
      title: 'Later work',
      teamId: 't1',
      sourceDelegationId: encodeHumanAssignment('a2', 'n1'),
    })
    personMoves(h.board, task!.id, 'cancelled')
    await h.orchestrator.personMovedTask(task!.id, 'cancelled')
    await vi.advanceTimersByTimeAsync(REFLECT_WINDOW_MS)
    expect(reflections(h.delivered)).toEqual([])
  })

  it('a queued delegation a person re-assigned is theirs, so the old delegator is not told', async () => {
    // Bug Boo is busy, so the lead's delegation waits as a queued card, and the
    // engine still remembers the lead as the one to report to.
    const h = makeHarness({ occupied: new Set([sk('a2')]) })
    await h.orchestrator.onEvent(
      sk('leader'),
      doneEvent('r1', '<delegate to="@Bug Boo">fix the login bug</delegate>'),
    )
    const id = h.board.created[0]!.id
    expect(h.board.statusOf(id)).toBe('todo')
    // The person hands it to Design Boo from the board, then cancels it.
    h.board.tasks.get(id)!.sourceDelegationId = encodeHumanAssignment('a3', 'n1')
    personMoves(h.board, id, 'cancelled')
    await h.orchestrator.personMovedTask(id, 'cancelled')
    await vi.advanceTimersByTimeAsync(REFLECT_WINDOW_MS)
    expect(reflections(h.delivered)).toEqual([])
  })

  it('a delegation from before a restart reports to the delegator named in its binding', async () => {
    const h = makeHarness()
    // Queued, never started, delegated by Design Boo (a mid-chain reduce point).
    const task = await h.board.createTask({
      title: 'Check the copy',
      teamId: 't1',
      sourceDelegationId: 'r9:deleg:agent:a2:reflectTo:a3',
    })
    personMoves(h.board, task!.id, 'cancelled')
    await h.orchestrator.personMovedTask(task!.id, 'cancelled')

    // Nothing was running, so nothing is stopped.
    expect(h.aborted).toEqual([])
    expect(h.board.completed).toEqual([])
    await vi.advanceTimersByTimeAsync(REFLECT_WINDOW_MS)
    const sent = reflections(h.delivered)
    expect(sent).toHaveLength(1)
    expect(sent[0]!.sessionKey).toBe(sk('a3'))
    expect(sent[0]!.task).toContain("✕ Cancelled by a person (it was Bug Boo's)")
    expect(sent[0]!.task).not.toContain('was stopped before it reported')
  })

  it('a card nobody delegated reports to no one', async () => {
    const h = makeHarness()
    const task = await h.board.createTask({ title: 'Loose card', teamId: 't1' })
    personMoves(h.board, task!.id, 'cancelled')
    await h.orchestrator.personMovedTask(task!.id, 'cancelled')
    await vi.advanceTimersByTimeAsync(REFLECT_WINDOW_MS)
    expect(reflections(h.delivered)).toEqual([])
  })
})

describe('personMovedTask: back to To do', () => {
  it('a running task starts over with the same agent once its old run has ended', async () => {
    const occupied = new Set<string>()
    const h = makeHarness({ occupied })
    const { id, execId } = await runningDelegation(h, 'fix it')
    // The host still holds the old run until its terminal lands.
    occupied.add(sk('a2'))

    personMoves(h.board, id, 'todo')
    await h.orchestrator.personMovedTask(id, 'todo')

    expect(h.aborted).toEqual([sk('a2')])
    expect(h.board.completed).toEqual([
      {
        execId,
        outcome: { status: 'cancelled', error: 'Stopped: a person moved the card to To do.' },
      },
    ])
    // Not bound behind the old run: its terminal would complete or fail it.
    expect(h.delivered).toHaveLength(1)
    expect(h.orchestrator.taskForSession(sk('a2'))).toBeNull()

    // The old run ends: the host frees the session, then reports the terminal.
    occupied.delete(sk('a2'))
    await h.orchestrator.onEvent(sk('a2'), failedDoneEvent('r2', 'aborted', ''))
    await vi.advanceTimersByTimeAsync(0)

    expect(h.delivered).toHaveLength(2)
    expect(h.delivered[1]).toEqual({
      sessionKey: sk('a2'),
      agentId: 'a2',
      task: 'fix it',
      origin: { kind: 'delegation', fromAgentId: 'leader' },
    })
    expect(h.board.claims).toEqual([id, id])
    expect(h.board.statusOf(id)).toBe('in_progress')
    const fresh = h.orchestrator.execForSession(sk('a2'))
    expect(fresh).not.toBeNull()
    expect(fresh).not.toBe(execId)
    // Not a failure, not a finish: the delegator is not told anything.
    await vi.advanceTimersByTimeAsync(REFLECT_WINDOW_MS)
    expect(reflections(h.delivered)).toEqual([])
  })

  it('a card that was not running is left for the pump', async () => {
    const h = makeHarness()
    const task = await h.board.createTask({
      title: 'Parked',
      teamId: 't1',
      sourceDelegationId: 'r9:deleg:agent:a2:reflectTo:leader',
    })
    personMoves(h.board, task!.id, 'backlog')
    personMoves(h.board, task!.id, 'todo')
    await h.orchestrator.personMovedTask(task!.id, 'todo')
    expect(h.aborted).toEqual([])
    expect(h.delivered).toEqual([])
    expect(h.board.claims).toEqual([])
  })
})

describe('a run ending after a person already decided the task', () => {
  it.each(['done', 'cancelled'] as const)(
    'a success after a person moved it to %s is kept as a late result and changes nothing else',
    async (to) => {
      const h = makeHarness()
      const { id, execId } = await runningDelegation(h)
      // The PATCH wrote the move, and the run finished before the engine heard.
      personMoves(h.board, id, to)
      await h.orchestrator.onEvent(sk('a2'), doneEvent('r2', 'Here is the fix.'))

      expect(h.board.statusOf(id)).toBe(to)
      expect(h.board.statusUpdates).toEqual([])
      expect(h.board.completed).toEqual([
        {
          execId,
          outcome: {
            status: 'cancelled',
            error: 'The task was finished by a person before this run ended.',
          },
        },
      ])
      expect(h.board.comments).toEqual([
        {
          taskId: id,
          body: '[late result: a person had already finished this task] Here is the fix.',
        },
      ])
      expect(h.orchestrator.taskForSession(sk('a2'))).toBeNull()
      expect(h.narrations).toEqual([])
      await vi.advanceTimersByTimeAsync(REFLECT_WINDOW_MS)
      expect(reflections(h.delivered)).toEqual([])
    },
  )

  it('an empty late result leaves no comment', async () => {
    const h = makeHarness()
    const { id } = await runningDelegation(h)
    personMoves(h.board, id, 'done')
    await h.orchestrator.onEvent(sk('a2'), doneEvent('r2', ''))
    expect(h.board.comments).toEqual([])
    expect(h.board.statusUpdates).toEqual([])
  })

  it.each([
    ['an error terminal', failedDoneEvent('r2', 'error', 'it broke')],
    ['a fatal error', fatalErrorEvent('r2', 'it broke')],
  ])(
    'a failure after a person cancelled it (%s) writes no blocked and cancels no plan steps',
    async (_label, failure) => {
      const h = makeHarness()
      const { one, two, execId } = await runningPlan(h)
      personMoves(h.board, one, 'cancelled')

      await h.orchestrator.onEvent(sk('a2'), failure)

      expect(h.board.statusOf(one)).toBe('cancelled')
      expect(h.board.statusOf(two)).toBe('todo')
      expect(h.board.statusUpdates).toEqual([])
      expect(h.board.comments).toEqual([])
      expect(h.board.completed).toEqual([
        {
          execId,
          outcome: {
            status: 'cancelled',
            error: 'The task was finished by a person before this run ended.',
          },
        },
      ])
      await vi.advanceTimersByTimeAsync(REFLECT_WINDOW_MS)
      expect(reflections(h.delivered)).toEqual([])
      expect(h.delivered.some((d) => d.agentId === 'a3')).toBe(false)
    },
  )
})

describe('personMovedTask: the run ends while the move is being read', () => {
  it('stops nothing the session has taken on since, and still reports the move', async () => {
    const board = new HeldBoard()
    const h = makeHarness({ board })
    const { id: first, execId: firstExec } = await runningDelegation(h)
    personMoves(h.board, first, 'done')

    const release = board.holdNextGetTask()
    const moving = h.orchestrator.personMovedTask(first, 'done')
    // While the engine reads the moved task: the old run reports, and Bug Boo's
    // session takes a new delegation.
    await h.orchestrator.onEvent(sk('a2'), doneEvent('r2', 'old result'))
    await h.orchestrator.onEvent(
      sk('leader'),
      doneEvent('r3', '<delegate to="@Bug Boo">write the tests</delegate>'),
    )
    const second = h.board.created[1]!.id
    const secondExec = h.orchestrator.execForSession(sk('a2'))
    expect(h.orchestrator.taskForSession(sk('a2'))).toBe(second)

    release()
    await moving

    // The new task's run is neither stopped nor forgotten.
    expect(h.aborted).toEqual([])
    expect(h.orchestrator.taskForSession(sk('a2'))).toBe(second)
    expect(h.orchestrator.execForSession(sk('a2'))).toBe(secondExec)
    expect(h.board.statusOf(second)).toBe('in_progress')
    // The moved task's own run was closed by its terminal, once.
    expect(h.board.completed).toEqual([
      {
        execId: firstExec,
        outcome: {
          status: 'cancelled',
          error: 'The task was finished by a person before this run ended.',
        },
      },
    ])
    // And the delegator still hears what the person decided.
    await vi.advanceTimersByTimeAsync(REFLECT_WINDOW_MS)
    const sent = reflections(h.delivered)
    expect(sent).toHaveLength(1)
    expect(sent[0]!.sessionKey).toBe(sk('leader'))
    expect(sent[0]!.task).toContain("✓ Marked done by a person (it was Bug Boo's)")
    expect(sent[0]!.task).not.toContain('was stopped before it reported')
  })
})

describe('detachTask', () => {
  it('closes the execution the released task was tracking as an infrastructure release', async () => {
    const h = makeHarness()
    const { id, execId } = await runningDelegation(h)
    h.board.forceRelease(id)

    expect(h.orchestrator.detachTask(id)).toBe(true)
    // The close is fire-and-forget; let it land.
    await vi.advanceTimersByTimeAsync(0)

    expect(h.board.completed).toEqual([
      { execId, outcome: { status: 'failed', error: 'Released before its run started.' } },
    ])
    expect(h.orchestrator.taskForSession(sk('a2'))).toBeNull()
  })

  it('leaves a live run and its execution alone', async () => {
    const busy = new Set<string>()
    const h = makeHarness({ busy })
    const { id } = await runningDelegation(h)
    busy.add(sk('a2'))
    h.board.forceRelease(id)

    expect(h.orchestrator.detachTask(id)).toBe(false)
    await vi.advanceTimersByTimeAsync(0)
    expect(h.board.completed).toEqual([])
    expect(h.orchestrator.taskForSession(sk('a2'))).toBe(id)
  })
})
