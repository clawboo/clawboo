// A run's ending is told apart, and retried only when a retry can help. These
// scenarios play the runtime and the host over the in-memory board: an empty reply
// gets one more turn, a provider failure waits and goes again, running out of room
// gets one continuation, and a budget refusal reads as one. The ledger the board
// keeps is what a restart picks up from, so a new engine over the same board plays one.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { RuntimeEvent } from '@clawboo/executor'

import {
  createBoardOrchestrator,
  REFLECT_WINDOW_MS,
  type KnownAgent,
  type PreparedWorkCheck,
  type TaskWakeOutbox,
  type WorkCheck,
  type WorkCheckResult,
} from '../boardOrchestration'
import { BUDGET_HELD_CODE, BUDGET_REFUSED_CODE, DeliveryRefusedError } from '../deliveryRefused'
import type { RunStamp, TurnOrigin } from '../turnOrigin'
import { FakeBoard } from './fakeBoard'

const KNOWN: KnownAgent[] = [
  { id: 'leader', name: 'Boo Zero' },
  { id: 'a2', name: 'Bug Boo' },
  { id: 'a3', name: 'Doc Boo' },
]
const sk = (id: string): string => `agent:${id}:team:t1`
const agentIdForSession = (s: string): string | null => s.match(/^agent:([^:]+):/)?.[1] ?? null

const base = { sessionId: null, ts: 1, seq: 1 }
const done = (runId: string, summary: string): RuntimeEvent => ({
  ...base,
  kind: 'done',
  reason: 'success',
  summary,
  runId,
})
const outOfRoom = (runId: string, summary = 'partial work'): RuntimeEvent => ({
  ...base,
  kind: 'done',
  reason: 'max_turns',
  summary,
  runId,
})
const fatal = (runId: string, message: string, code: string | null = null): RuntimeEvent => ({
  ...base,
  kind: 'error',
  code,
  message,
  fatal: true,
  runId,
})
const toolCall = (runId: string, name: string, input: unknown): RuntimeEvent => ({
  ...base,
  kind: 'tool-call',
  toolCallId: 'c1',
  name,
  input,
  partial: false,
  runId,
})
const RATE_LIMIT = '429 rate_limit_error: too many requests'

type Delivered = { sessionKey: string; agentId: string; task: string; origin: TurnOrigin }

interface HarnessOpts {
  board?: FakeBoard
  gen?: { value: number }
  workCheck?: WorkCheck
  taskWakes?: TaskWakeOutbox
  deliverRefusal?: () => Error | null
  budgetRefusal?: () => 'paused' | 'held' | null
  held?: () => boolean
  isSessionOccupied?: (s: string) => boolean
}

function harness(opts: HarnessOpts = {}) {
  const board = opts.board ?? new FakeBoard()
  const gen = opts.gen ?? { value: 0 }
  const delivered: Delivered[] = []
  const engine = createBoardOrchestrator({
    teamId: 't1',
    board,
    known: () => KNOWN,
    leaderAgentId: () => 'leader',
    sessionKeyForAgent: sk,
    agentIdForSession,
    deliver: async (sessionKey, agentId, task, origin) => {
      const refusal = opts.deliverRefusal?.()
      if (refusal) throw refusal
      delivered.push({ sessionKey, agentId, task, origin })
    },
    stopGen: () => gen.value,
    ...(opts.workCheck ? { workCheck: opts.workCheck } : {}),
    ...(opts.taskWakes ? { taskWakes: opts.taskWakes } : {}),
    ...(opts.budgetRefusal ? { budgetRefusal: opts.budgetRefusal } : {}),
    ...(opts.held ? { held: opts.held } : {}),
    ...(opts.isSessionOccupied ? { isSessionOccupied: opts.isSessionOccupied } : {}),
  })
  return {
    board,
    gen,
    engine,
    delivered,
    toWorker: () => delivered.filter((d) => d.agentId === 'a2'),
    updates: () => delivered.filter((d) => d.task.startsWith('[Task Update]')),
    /** The ledger as the board keeps it, oldest first. */
    ledger: async (id: string) => (await board.listExecutions(id)) ?? [],
    statusOf: (id: string) => board.statusOf(id),
    waitOf: (id: string) => board.waits.get(id),
    comments: (id: string) => board.comments.filter((c) => c.taskId === id).map((c) => c.body),
  }
}
type Harness = ReturnType<typeof harness>

async function delegate(h: Harness, task = 'fix the parser'): Promise<string> {
  await h.engine.onEvent(sk('leader'), done('r1', `<delegate to="@Bug Boo">${task}</delegate>`))
  return h.board.created.at(-1)!.id
}

/** A run ended: let what follows its drain go out (a round is one macrotask later). */
async function end(h: Harness, event: RuntimeEvent, run?: RunStamp): Promise<void> {
  await h.engine.onEvent(sk('a2'), event, run)
  await vi.advanceTimersByTimeAsync(0)
}

beforeEach(() => vi.useFakeTimers())
afterEach(() => {
  vi.clearAllTimers()
  vi.useRealTimers()
})

describe('an empty reply', () => {
  it('never lands in Done on its first ending: the agent gets one more turn', async () => {
    const h = harness()
    const id = await delegate(h)
    await end(h, done('r2', '   '))

    expect(h.statusOf(id)).toBe('in_progress')
    expect(h.toWorker()).toHaveLength(2)
    expect(h.toWorker()[1]!.task).toMatch(/ended without a reply/i)
    const [first, second] = await h.ledger(id)
    expect(first).toMatchObject({ status: 'succeeded' })
    expect(second).toMatchObject({ status: 'running', runReason: 'empty_reply' })
    // Nobody is told anything yet: the task has not ended.
    await vi.advanceTimersByTimeAsync(REFLECT_WINDOW_MS)
    expect(h.updates()).toHaveLength(0)
  })

  it('a reply on the continue turn is the result', async () => {
    const h = harness()
    const id = await delegate(h)
    await end(h, done('r2', ''))
    await end(h, done('r3', 'fixed it in parser.ts'))

    expect(h.statusOf(id)).toBe('done')
    expect(h.comments(id)).toContain('fixed it in parser.ts')
    await vi.advanceTimersByTimeAsync(REFLECT_WINDOW_MS)
    expect(h.updates()).toHaveLength(1)
    expect(h.updates()[0]!.task).toContain('fixed it in parser.ts')
  })

  it('a second empty reply goes to Blocked waiting on no result, and says so', async () => {
    const h = harness()
    const id = await delegate(h)
    await end(h, done('r2', ''))
    await end(h, done('r3', ''))

    expect(h.statusOf(id)).toBe('blocked')
    expect(h.waitOf(id)).toEqual({ kind: 'no_result' })
    expect(h.board.statusUpdates.some((u) => u.taskId === id && u.status === 'done')).toBe(false)
    expect(h.toWorker()).toHaveLength(2)
    expect(h.comments(id).join('\n')).toMatch(/twice/i)
    expect((await h.ledger(id)).map((e) => e.status)).toEqual(['succeeded', 'succeeded'])
    await vi.advanceTimersByTimeAsync(REFLECT_WINDOW_MS)
    expect(h.updates()).toHaveLength(1)
    expect(h.updates()[0]!.task).toMatch(/without a result/i)
  })

  it('a task waiting on it stays queued: a person’s Retry carries the plan on', async () => {
    const h = harness()
    const id = await delegate(h)
    const next = await h.board.createTask({
      title: 'next',
      sourceDelegationId: 'p:step:agent:a3:reflectTo:leader',
    })
    await h.board.linkDep(next!.id, id)
    await end(h, done('r2', ''))
    await end(h, done('r3', ''))
    expect(h.statusOf(id)).toBe('blocked')
    expect(h.statusOf(next!.id)).toBe('todo')
  })

  it('is not empty when the run handed work on by tool: it waits, with no extra turn', async () => {
    const h = harness()
    const id = await delegate(h)
    await end(h, toolCall('r2', 'delegate', { assignee: 'Doc Boo', task: 'write the docs' }))
    await end(h, done('r2', ''))

    expect(h.statusOf(id)).toBe('blocked')
    expect(h.waitOf(id)).toMatchObject({ kind: 'subtasks' })
    expect(h.toWorker()).toHaveLength(1)

    // Its follow-up says nothing either. What it handed out is its work, so it closes.
    await h.engine.onEvent(sk('a3'), done('r3', 'the docs are written'))
    await vi.advanceTimersByTimeAsync(0)
    expect(h.toWorker()).toHaveLength(2)
    await end(h, done('r4', ''))
    expect(h.statusOf(id)).toBe('done')
    expect(h.toWorker()).toHaveLength(2)
    expect(h.comments(id).join('\n')).not.toContain('(no output produced)')
    expect(h.comments(id).join('\n')).toMatch(/handed/i)
  })

  it('counts the turn’s hand-off itself, when it found its work already open', async () => {
    const h = harness()
    const id = await delegate(h)
    // No new sub-task to read and none to wait on: the board handed back a task that
    // was already open somewhere else.
    h.board.listTasks = async () => []
    h.board.subtasksOf = async () => []
    await end(h, toolCall('r2', 'delegate', { assignee: 'Doc Boo', task: 'write the docs' }))
    await end(h, done('r2', ''))
    expect(h.statusOf(id)).toBe('done')
    expect(h.toWorker()).toHaveLength(1)
  })

  it('is not empty when the run created a sub-task on the board', async () => {
    const h = harness()
    const id = await delegate(h)
    h.board.addSubTask(id, 'a piece of it')
    await end(h, done('r2', ''))
    expect(h.statusOf(id)).toBe('done')
    expect(h.toWorker()).toHaveLength(1)
  })

  it('an older sub-task says nothing about this run', async () => {
    const h = harness()
    const id = await delegate(h)
    const old = h.board.addSubTask(id, 'from an earlier run')
    h.board.tasks.get(old)!.createdAt = 0
    await end(h, done('r2', ''))
    expect(h.statusOf(id)).toBe('in_progress')
    expect(h.toWorker()).toHaveLength(2)
  })

  it('is not empty when the agent wrote its own comment during the run', async () => {
    const h = harness()
    const id = await delegate(h)
    vi.advanceTimersByTime(10)
    h.board.commentRows.push({
      taskId: id,
      body: 'wrote the report to report.md',
      kind: 'agent',
      createdAt: Date.now(),
    })
    await end(h, done('r2', ''))
    expect(h.statusOf(id)).toBe('done')
    expect(h.toWorker()).toHaveLength(1)
  })

  it('a note from clawboo, or an older comment, is not the agent’s report', async () => {
    const h = harness()
    const id = await delegate(h)
    h.board.commentRows.push({ taskId: id, body: 'old', kind: 'agent', createdAt: 0 })
    h.board.commentRows.push({ taskId: id, body: 'note', kind: 'note', createdAt: Date.now() })
    await end(h, done('r2', ''))
    expect(h.statusOf(id)).toBe('in_progress')
    expect(h.toWorker()).toHaveLength(2)
  })

  it('an unreadable ledger never lands it in Done', async () => {
    const h = harness()
    const id = await delegate(h)
    h.board.listExecutions = async () => null
    await end(h, done('r2', ''))
    expect(h.statusOf(id)).toBe('blocked')
    expect(h.waitOf(id)).toEqual({ kind: 'no_result' })
  })

  it('a Stop as a silent run ends releases the task, and nothing reaches Done', async () => {
    const h = harness()
    const id = await delegate(h)
    h.gen.value += 1
    await end(h, done('r2', ''))
    expect(h.statusOf(id)).toBe('todo')
    expect(h.toWorker()).toHaveLength(1)
    expect(h.comments(id).join('\n')).not.toContain('(no output produced)')
    expect((await h.ledger(id)).at(-1)?.status).toBe('cancelled')
  })

  it('a Stop before the continue turn goes out starts nothing', async () => {
    let busy = false
    const h = harness({ isSessionOccupied: () => busy })
    const id = await delegate(h)
    busy = true
    await end(h, done('r2', ''))
    h.gen.value += 1
    await h.engine.markStopped()
    await vi.advanceTimersByTimeAsync(0)
    expect(h.statusOf(id)).toBe('todo')
    expect(h.toWorker()).toHaveLength(1)
  })

  it('a provider retry of the continue turn hands out no second one', async () => {
    const h = harness()
    const id = await delegate(h)
    await end(h, done('r2', ''))
    await end(h, fatal('r3', RATE_LIMIT))
    await vi.advanceTimersByTimeAsync(38_000)
    expect(h.toWorker()).toHaveLength(3)
    await end(h, done('r4', ''))
    expect(h.statusOf(id)).toBe('blocked')
    expect(h.waitOf(id)).toEqual({ kind: 'no_result' })
  })

  it('a person’s comment waiting takes the turn, and no second one follows it', async () => {
    const wakes: TaskWakeOutbox = {
      fromPersonWaiting: () => [{ id: 'w1', commentIds: ['c1'] }],
      settle: () => true,
      settleCarriedBy: () => true,
      holdAll: () => true,
    }
    const h = harness({ taskWakes: wakes })
    const id = await delegate(h)
    await end(h, done('r2', ''))
    expect(h.toWorker()).toHaveLength(2)
    expect(h.toWorker()[1]!.task).toMatch(/\[New comment\]/)
    expect(h.statusOf(id)).toBe('in_progress')
  })
})

describe('the extra turns together', () => {
  it('cannot alternate: empty, out of room, empty goes to Blocked', async () => {
    const h = harness()
    const id = await delegate(h)
    await end(h, done('r2', ''))
    await end(h, outOfRoom('r3'))
    expect(h.toWorker()).toHaveLength(3)
    await end(h, done('r4', ''))

    expect(h.statusOf(id)).toBe('blocked')
    expect(h.waitOf(id)).toEqual({ kind: 'no_result' })
    expect(h.toWorker()).toHaveLength(3)
    expect(h.board.statusUpdates.some((u) => u.taskId === id && u.status === 'done')).toBe(false)
  })

  it('cannot alternate: out of room, empty, out of room goes to Blocked', async () => {
    const h = harness()
    const id = await delegate(h)
    await end(h, outOfRoom('r2'))
    await end(h, done('r3', ''))
    expect(h.toWorker()).toHaveLength(3)
    await end(h, outOfRoom('r4'))

    expect(h.statusOf(id)).toBe('blocked')
    expect(h.waitOf(id)).toEqual({ kind: 'out_of_room' })
    expect(h.toWorker()).toHaveLength(3)
  })

  it('a person’s Retry gives the task its extra turns again', async () => {
    const h = harness()
    const id = await delegate(h)
    await end(h, done('r2', ''))
    await end(h, done('r3', ''))
    expect(h.statusOf(id)).toBe('blocked')

    await h.board.updateStatus(id, 'todo')
    expect(await h.engine.dispatchTask(id)).toBe('started')
    await end(h, done('r4', ''))
    expect(h.statusOf(id)).toBe('in_progress')
    expect(h.toWorker()).toHaveLength(4)
    expect(h.toWorker()[3]!.task).toMatch(/ended without a reply/i)
  })

  it('a fix round in between does not hand out another', async () => {
    const answers: Array<(r: WorkCheckResult) => void> = []
    let needs = false
    const workCheck: WorkCheck = {
      async begin() {},
      async prepare() {
        if (!needs) return null
        return () => new Promise<WorkCheckResult>((resolve) => answers.push(resolve))
      },
    }
    const h = harness({ workCheck })
    const id = await delegate(h)
    await end(h, done('r2', ''))
    // Its one extra turn changed the folder and said something, and the check failed it.
    needs = true
    await end(h, done('r3', 'wrote it'))
    await vi.advanceTimersByTimeAsync(0)
    answers[0]!({ verdict: 'retry', fixNote: 'tests are red' })
    await vi.advanceTimersByTimeAsync(0)
    await vi.advanceTimersByTimeAsync(0)
    expect(h.toWorker()).toHaveLength(3)
    // The fix round says nothing and changes nothing.
    needs = false
    await end(h, done('r4', ''))
    expect(h.statusOf(id)).toBe('blocked')
    expect(h.waitOf(id)).toEqual({ kind: 'no_result' })
    expect(h.toWorker()).toHaveLength(3)
  })
})

describe('a reply that is only a control token', () => {
  it.each(['__skipped__', 'NO_REPLY', 'ANNOUNCE_SKIP', '  NO_REPLY\n', '__resumed__'])(
    'reads %j as empty: one more turn, then Blocked, never Done',
    async (token) => {
      const h = harness()
      const id = await delegate(h)
      await end(h, done('r2', token))
      expect(h.statusOf(id)).toBe('in_progress')
      expect(h.toWorker()).toHaveLength(2)
      await end(h, done('r3', token))
      expect(h.statusOf(id)).toBe('blocked')
      expect(h.waitOf(id)).toEqual({ kind: 'no_result' })
      expect(h.comments(id).join('\n')).not.toContain(token.trim())
      await vi.advanceTimersByTimeAsync(REFLECT_WINDOW_MS)
      expect(h.updates()[0]!.task).not.toContain(token.trim())
    },
  )

  it('a sentence that mentions one is a reply', async () => {
    const h = harness()
    const id = await delegate(h)
    await end(h, done('r2', 'I removed NO_REPLY from the prompt.'))
    expect(h.statusOf(id)).toBe('done')
  })
})

describe('a hand-off the board found already open', () => {
  it('counts as showing something, when a retry repeats its hand-off', async () => {
    const h = harness()
    const id = await delegate(h)
    await end(h, toolCall('r2', 'delegate', { assignee: 'Doc Boo', task: 'write the docs' }))
    await end(h, fatal('r2', RATE_LIMIT))
    await vi.advanceTimersByTimeAsync(38_000)
    expect(h.toWorker()).toHaveLength(2)
    const children = h.board.created.filter((t) => t.parentTaskId === id)
    expect(children).toHaveLength(1)

    // The retry says the same thing again, and the board hands back the open task.
    const listTasks = h.board.listTasks.bind(h.board)
    h.board.listTasks = async () => []
    await end(h, toolCall('r3', 'delegate', { assignee: 'Doc Boo', task: 'write the docs' }))
    expect(h.board.created.filter((t) => t.parentTaskId === id)).toHaveLength(1)
    await end(h, done('r3', ''))

    // It waits for that task, with no extra turn.
    expect(h.statusOf(id)).toBe('blocked')
    expect(h.toWorker()).toHaveLength(2)

    h.board.listTasks = listTasks
    await h.engine.onEvent(sk('a3'), done('r4', 'the docs are written'))
    await vi.advanceTimersByTimeAsync(0)
    await end(h, done('r5', ''))
    expect(h.statusOf(id)).toBe('done')
    expect(h.toWorker()).toHaveLength(3)
    expect(h.comments(id).join('\n')).toMatch(/handed/i)
  })

  it('a sub-task an earlier try of this run made still counts', async () => {
    const h = harness()
    const id = await delegate(h)
    await end(h, toolCall('r2', 'delegate', { assignee: 'Doc Boo', task: 'write the docs' }))
    const child = h.board.created.find((t) => t.parentTaskId === id)!
    h.board.tasks.get(child.id)!.createdAt = Date.now()
    await end(h, fatal('r2', RATE_LIMIT))
    await vi.advanceTimersByTimeAsync(38_000)
    // The retry resumes its session, knows the work is handed on, and says nothing.
    await end(h, done('r3', ''))
    expect(h.statusOf(id)).toBe('blocked')
    expect(h.waitOf(id)).toMatchObject({ kind: 'subtasks' })
    expect(h.toWorker()).toHaveLength(2)
  })
})

describe('an empty reply on a run that changed the team folder', () => {
  /** A check that always applies, answered by the test. */
  function checked() {
    const answers: Array<(r: WorkCheckResult) => void> = []
    let needs = true
    const workCheck: WorkCheck = {
      async begin() {},
      async prepare() {
        if (!needs) return null
        return () => new Promise<WorkCheckResult>((resolve) => answers.push(resolve))
      },
    }
    return { workCheck, answers, nothingChanged: () => (needs = false) }
  }
  const settleCheck = async (): Promise<void> => {
    await vi.advanceTimersByTimeAsync(0)
    await vi.advanceTimersByTimeAsync(0)
  }

  it('goes to the check first, with no continue turn, and a pass lands in Done', async () => {
    const c = checked()
    const h = harness({ workCheck: c.workCheck })
    const id = await delegate(h)
    await end(h, done('r2', ''))
    await settleCheck()
    expect(h.toWorker()).toHaveLength(1)
    expect(c.answers).toHaveLength(1)
    c.answers[0]!({ verdict: 'pass' })
    await settleCheck()

    expect(h.statusOf(id)).toBe('done')
    expect(h.toWorker()).toHaveLength(1)
    expect(h.comments(id).join('\n')).toMatch(/check passed/i)
    expect(h.comments(id).join('\n')).not.toContain('(no output produced)')
    await vi.advanceTimersByTimeAsync(REFLECT_WINDOW_MS)
    expect(h.updates()[0]!.task).toMatch(/passed the team's check/i)
  })

  it('a failed check sends the fix round it always did, not a continue turn', async () => {
    const c = checked()
    const h = harness({ workCheck: c.workCheck })
    await delegate(h)
    await end(h, done('r2', ''))
    await settleCheck()
    c.answers[0]!({ verdict: 'retry', fixNote: 'tests are red' })
    await settleCheck()
    expect(h.toWorker()).toHaveLength(2)
    expect(h.toWorker()[1]!.task).toMatch(/\[Check failed\]/)
  })

  it('a check that could not look gets the same continue turn', async () => {
    const workCheck: WorkCheck = {
      async begin() {},
      async prepare() {
        return async () => ({ verdict: 'unchecked' }) as WorkCheckResult
      },
    }
    const h = harness({ workCheck })
    const id = await delegate(h)
    await end(h, done('r2', ''))
    await settleCheck()
    await settleCheck()
    expect(h.statusOf(id)).toBe('in_progress')
    expect(h.toWorker()).toHaveLength(2)
    expect(h.toWorker()[1]!.task).toMatch(/ended without a reply/i)
    await end(h, done('r3', ''))
    await settleCheck()
    await settleCheck()
    expect(h.statusOf(id)).toBe('blocked')
    expect(h.waitOf(id)).toEqual({ kind: 'no_result' })
  })

  it('a hand-off still counts when the check could not look', async () => {
    const workCheck: WorkCheck = {
      async begin() {},
      async prepare() {
        return async () => ({ verdict: 'unchecked' }) as WorkCheckResult
      },
    }
    const h = harness({ workCheck })
    const id = await delegate(h)
    await end(h, toolCall('r2', 'delegate', { assignee: 'Doc Boo', task: 'write the docs' }))
    h.board.listTasks = async () => []
    h.board.subtasksOf = async () => []
    await end(h, done('r2', ''))
    await settleCheck()
    await settleCheck()
    expect(h.statusOf(id)).toBe('done')
    expect(h.toWorker()).toHaveLength(1)
  })

  it('a teammate was in the folder too: the change may not be this run’s, so it says first', async () => {
    const answers: Array<(r: WorkCheckResult) => void> = []
    const workCheck: WorkCheck = {
      async begin() {},
      async prepare() {
        const check = (() =>
          new Promise<WorkCheckResult>((resolve) => answers.push(resolve))) as PreparedWorkCheck
        check.sharedFolder = true
        return check
      },
    }
    const h = harness({ workCheck })
    const id = await delegate(h)
    await end(h, done('r2', ''))
    await settleCheck()
    expect(answers).toHaveLength(0)
    expect(h.toWorker()).toHaveLength(2)
    expect(h.toWorker()[1]!.task).toMatch(/ended without a reply/i)

    // Silence twice is no result, whatever is in the folder.
    await end(h, done('r3', ''))
    await settleCheck()
    expect(answers).toHaveLength(0)
    expect(h.statusOf(id)).toBe('blocked')
    expect(h.waitOf(id)).toEqual({ kind: 'no_result' })
  })

  describe('a run that said how it went with report_result', () => {
    const CLAIM = { outcome: 'done', summary: 'Wrote the parser.' } as const

    it('goes to the check with no text, even with a teammate in the folder', async () => {
      const answers: Array<(r: WorkCheckResult) => void> = []
      const workCheck: WorkCheck = {
        async begin() {},
        async prepare() {
          const check = (() =>
            new Promise<WorkCheckResult>((resolve) => answers.push(resolve))) as PreparedWorkCheck
          check.sharedFolder = true
          return check
        },
      }
      const h = harness({ workCheck })
      const id = await delegate(h)
      h.board.seedResultClaim(id, CLAIM)
      await end(h, done('r2', ''))
      await settleCheck()
      expect(answers).toHaveLength(1)
      expect(h.toWorker()).toHaveLength(1)
      answers[0]!({ verdict: 'pass' })
      await settleCheck()
      expect(h.statusOf(id)).toBe('done')
      expect(h.comments(id).join('\n')).toContain('Wrote the parser.')
    })

    it('is the result when the check could not look', async () => {
      const workCheck: WorkCheck = {
        async begin() {},
        async prepare() {
          return async () => ({ verdict: 'unchecked' }) as WorkCheckResult
        },
      }
      const h = harness({ workCheck })
      const id = await delegate(h)
      h.board.seedResultClaim(id, CLAIM)
      await end(h, done('r2', ''))
      await settleCheck()
      await settleCheck()
      expect(h.statusOf(id)).toBe('done')
      expect(h.toWorker()).toHaveLength(1)
    })

    it('a success claim over a failing check gets the fix round, not an extra turn', async () => {
      const c = checked()
      const h = harness({ workCheck: c.workCheck })
      const id = await delegate(h)
      h.board.seedResultClaim(id, CLAIM)
      await end(h, done('r2', ''))
      await settleCheck()
      c.answers[0]!({ verdict: 'retry', fixNote: 'the tests fail' })
      await settleCheck()
      expect(h.toWorker()).toHaveLength(2)
      expect(h.toWorker()[1]!.task).toContain('the tests fail')
      expect(h.toWorker()[1]!.task).not.toMatch(/ended without a reply/i)
      expect(h.statusOf(id)).not.toBe('done')
    })

    it('a failure claim with no text skips the check and goes to a person', async () => {
      const c = checked()
      const h = harness({ workCheck: c.workCheck })
      const id = await delegate(h)
      h.board.seedResultClaim(id, { outcome: 'not_done', summary: 'No key.' })
      await end(h, done('r2', ''))
      await settleCheck()
      expect(c.answers).toHaveLength(0)
      expect(h.statusOf(id)).toBe('blocked')
      expect(h.waitOf(id)).toMatchObject({ kind: 'person' })
      expect(h.toWorker()).toHaveLength(1)
    })
  })

  it('a teammate in the folder changes nothing for a run that replied', async () => {
    const answers: Array<(r: WorkCheckResult) => void> = []
    const workCheck: WorkCheck = {
      async begin() {},
      async prepare() {
        const check = (() =>
          new Promise<WorkCheckResult>((resolve) => answers.push(resolve))) as PreparedWorkCheck
        check.sharedFolder = true
        return check
      },
    }
    const h = harness({ workCheck })
    const id = await delegate(h)
    await end(h, done('r2', 'wrote the parser'))
    await settleCheck()
    expect(answers).toHaveLength(1)
    answers[0]!({ verdict: 'pass' })
    await settleCheck()
    expect(h.statusOf(id)).toBe('done')
  })

  it('nothing changed: no check applies, so it gets the continue turn', async () => {
    const c = checked()
    c.nothingChanged()
    const h = harness({ workCheck: c.workCheck })
    const id = await delegate(h)
    await end(h, done('r2', ''))
    expect(c.answers).toHaveLength(0)
    expect(h.toWorker()).toHaveLength(2)
    expect(h.statusOf(id)).toBe('in_progress')
  })
})

describe('a provider failure', () => {
  it('goes back to To do and waits, holding nothing and telling nobody yet', async () => {
    const h = harness()
    const id = await delegate(h)
    await end(h, fatal('r2', RATE_LIMIT, 'rate_limit'))

    expect(h.statusOf(id)).toBe('todo')
    expect(h.waitOf(id)).toEqual({ kind: 'retry', cause: 'rate_limited', attempt: 1 })
    expect(h.board.tasks.get(id)!.assigneeAgentId).toBeNull()
    expect(await h.ledger(id)).toMatchObject([
      { status: 'failed', errorClass: 'RateLimited', error: RATE_LIMIT },
    ])
    expect(h.engine.taskForSession(sk('a2'))).toBeNull()
    expect(h.comments(id).join('\n')).toMatch(/rate limit/i)
    expect(h.comments(id).join('\n')).toMatch(/30 seconds/)
    expect(h.comments(id).join('\n')).toMatch(/A comment from you starts it now/)
    await vi.advanceTimersByTimeAsync(REFLECT_WINDOW_MS)
    expect(h.updates()).toHaveLength(0)
  })

  it('retries after at least 30 s and then at least 60 s, then blocks as rate limited', async () => {
    const h = harness()
    const id = await delegate(h)
    await end(h, fatal('r2', RATE_LIMIT))

    await vi.advanceTimersByTimeAsync(29_000)
    expect(h.toWorker()).toHaveLength(1)
    await vi.advanceTimersByTimeAsync(9_000)
    expect(h.toWorker()).toHaveLength(2)
    expect(h.statusOf(id)).toBe('in_progress')
    expect(h.waitOf(id)).toBeUndefined()
    expect((await h.ledger(id)).at(-1)).toMatchObject({
      status: 'running',
      runReason: 'provider_retry',
    })

    await end(h, fatal('r3', RATE_LIMIT))
    expect(h.statusOf(id)).toBe('todo')
    expect(h.waitOf(id)).toEqual({ kind: 'retry', cause: 'rate_limited', attempt: 2 })
    await vi.advanceTimersByTimeAsync(59_000)
    expect(h.toWorker()).toHaveLength(2)
    await vi.advanceTimersByTimeAsync(17_000)
    expect(h.toWorker()).toHaveLength(3)

    await end(h, fatal('r4', RATE_LIMIT))
    expect(h.statusOf(id)).toBe('blocked')
    expect(h.waitOf(id)).toEqual({ kind: 'provider', cause: 'rate_limited' })
    await vi.advanceTimersByTimeAsync(3_600_000)
    expect(h.toWorker()).toHaveLength(3)
    expect(h.updates()).toHaveLength(1)
    expect(h.updates()[0]!.task).toMatch(/rate limited/i)
    expect(h.comments(id).join('\n')).toMatch(/tried again twice/i)
  })

  it('jitters: the wait is never shorter than asked, and not always the same', async () => {
    const delays = new Set<number>()
    for (const r of [0, 0.5, 0.999]) {
      const random = vi.spyOn(Math, 'random').mockReturnValue(r)
      const h = harness()
      await delegate(h)
      await end(h, fatal('r2', RATE_LIMIT))
      let waited = 0
      while (h.toWorker().length === 1 && waited < 60_000) {
        await vi.advanceTimersByTimeAsync(100)
        waited += 100
      }
      expect(waited).toBeGreaterThanOrEqual(30_000)
      expect(waited).toBeLessThanOrEqual(37_600)
      delays.add(waited)
      random.mockRestore()
    }
    expect(delays.size).toBeGreaterThan(1)
  })

  it('reads overload and a dropped network as the provider being unavailable', async () => {
    for (const [message, code] of [
      ['529 overloaded_error', 'overloaded'],
      ['fetch failed: ECONNRESET', null],
      ['request timed out', null],
      [
        'Client network socket disconnected before secure TLS connection was established',
        'network',
      ],
      ['The connection to the provider dropped during the reply.', 'network'],
    ] as const) {
      const h = harness()
      const id = await delegate(h)
      await end(h, fatal('r2', message, code))
      expect(h.statusOf(id)).toBe('todo')
      expect(h.waitOf(id)).toEqual({ kind: 'retry', cause: 'unavailable', attempt: 1 })
    }
  })

  it('reads a typed rate limit as one, whatever number its message holds', async () => {
    const h = harness()
    const id = await delegate(h)
    await end(h, fatal('r2', 'Rate limit: Limit 400, Used 397, Requested 403.', 'rate_limit'))
    expect(h.statusOf(id)).toBe('todo')
    expect(h.waitOf(id)).toEqual({ kind: 'retry', cause: 'rate_limited', attempt: 1 })
  })

  it('never retries a refused sign-in or billing: they stay as they were', async () => {
    for (const [message, code] of [
      ['Invalid API key', 'authentication_failed'],
      ['Your credit balance is too low', 'billing_error'],
    ] as const) {
      const h = harness()
      const id = await delegate(h)
      await end(h, fatal('r2', message, code))
      expect(h.statusOf(id)).toBe('blocked')
      expect(h.waitOf(id)).toEqual({ kind: 'failure' })
      await vi.advanceTimersByTimeAsync(3_600_000)
      expect(h.toWorker()).toHaveLength(1)
    }
  })

  it('never retries an ordinary failure', async () => {
    const h = harness()
    const id = await delegate(h)
    await end(h, fatal('r2', 'the agent crashed on a bad regex'))
    expect(h.statusOf(id)).toBe('blocked')
    expect(h.waitOf(id)).toEqual({ kind: 'failure' })
  })

  it('a Stop during the wait cancels it', async () => {
    const h = harness()
    const id = await delegate(h)
    await end(h, fatal('r2', RATE_LIMIT))

    h.gen.value += 1
    await h.engine.markStopped()
    expect(h.statusOf(id)).toBe('todo')
    expect(h.waitOf(id)).toBeUndefined()
    expect((await h.ledger(id)).at(-1)).toMatchObject({ status: 'cancelled' })

    await vi.advanceTimersByTimeAsync(3_600_000)
    expect(h.toWorker()).toHaveLength(1)
    await h.engine.resume()
    expect(h.toWorker()).toHaveLength(1)
  })

  it('a person’s Retry during the wait goes now, and the wait does not fire a second run', async () => {
    const h = harness()
    const id = await delegate(h)
    await end(h, fatal('r2', RATE_LIMIT))

    expect(await h.engine.dispatchTask(id)).toBe('started')
    expect(h.toWorker()).toHaveLength(2)
    expect((await h.ledger(id)).at(-1)).toMatchObject({ runReason: 'person_retry' })
    await vi.advanceTimersByTimeAsync(120_000)
    expect(h.toWorker()).toHaveLength(2)
    // Its failure starts the count again: a person asked.
    await end(h, fatal('r3', RATE_LIMIT))
    expect(h.waitOf(id)).toEqual({ kind: 'retry', cause: 'rate_limited', attempt: 1 })
  })

  it('promises no retry the fire policy would refuse: a person’s Retry after three goes straight back', async () => {
    const h = harness()
    const id = await delegate(h)
    await end(h, fatal('r2', RATE_LIMIT))
    await vi.advanceTimersByTimeAsync(38_000)
    await end(h, fatal('r3', RATE_LIMIT))
    await vi.advanceTimersByTimeAsync(76_000)
    await end(h, fatal('r4', RATE_LIMIT))
    expect(h.statusOf(id)).toBe('blocked')
    await vi.advanceTimersByTimeAsync(REFLECT_WINDOW_MS)
    expect(h.updates()).toHaveLength(1)

    await h.board.updateStatus(id, 'todo')
    expect(await h.engine.dispatchTask(id)).toBe('started')
    await end(h, fatal('r5', RATE_LIMIT))

    expect(h.statusOf(id)).toBe('blocked')
    expect(h.waitOf(id)).toEqual({ kind: 'provider', cause: 'rate_limited' })
    const notes = h.comments(id)
    expect(notes.at(-1)).not.toMatch(/Trying again in about/)
    expect(notes.at(-1)).not.toMatch(/tried again twice/i)
    expect(notes.at(-1)).toMatch(/failed too many times/i)
    // Whoever handed it out hears, and is not told it was tried twice more.
    await vi.advanceTimersByTimeAsync(REFLECT_WINDOW_MS)
    expect(h.updates()).toHaveLength(2)
    expect(h.updates()[1]!.task).not.toMatch(/tried it again twice/i)
    await vi.advanceTimersByTimeAsync(3_600_000)
    expect(h.toWorker()).toHaveLength(4)
  })

  it('a restart during the wait neither strands the task nor loops', async () => {
    const board = new FakeBoard()
    const gen = { value: 0 }
    const before = harness({ board, gen })
    const id = await delegate(before)
    await end(before, fatal('r2', RATE_LIMIT))
    before.engine.reset()

    // The next process, over the same board. Too early: the ledger says wait.
    const after = harness({ board, gen })
    await after.engine.resume()
    await vi.advanceTimersByTimeAsync(10_000)
    await after.engine.resume()
    expect(after.toWorker()).toHaveLength(0)
    expect(after.statusOf(id)).toBe('todo')

    // The dispatch pump's pass after the wait starts it, once.
    await vi.advanceTimersByTimeAsync(20_000)
    await after.engine.resume()
    await after.engine.resume()
    expect(after.toWorker()).toHaveLength(1)
    expect(after.statusOf(id)).toBe('in_progress')

    // The count came through the restart: the next failure waits the longer wait.
    await end(after, fatal('r3', RATE_LIMIT))
    expect(after.waitOf(id)).toEqual({ kind: 'retry', cause: 'rate_limited', attempt: 2 })
    await after.engine.resume()
    expect(after.toWorker()).toHaveLength(1)
    await vi.advanceTimersByTimeAsync(76_000)
    expect(after.toWorker()).toHaveLength(2)

    // And it ends: no third retry, however many passes come.
    await end(after, fatal('r4', RATE_LIMIT))
    expect(after.statusOf(id)).toBe('blocked')
    await after.engine.resume()
    await vi.advanceTimersByTimeAsync(3_600_000)
    await after.engine.resume()
    expect(after.toWorker()).toHaveLength(2)
  })

  it('counts awake time: a laptop asleep through the wait does not use it up', async () => {
    const h = harness()
    await delegate(h)
    await end(h, fatal('r2', RATE_LIMIT))
    await vi.advanceTimersByTimeAsync(5_000)
    // The lid closes for an hour: the wall clock jumps, and no timer ran through it.
    vi.setSystemTime(Date.now() + 3_600_000)
    // The dispatch pump's pass on waking finds the wall clock long past the wait.
    await h.engine.resume()
    expect(h.toWorker()).toHaveLength(1)
    await vi.advanceTimersByTimeAsync(40_000)
    expect(h.toWorker()).toHaveLength(1)
    await vi.advanceTimersByTimeAsync(40_000)
    expect(h.toWorker()).toHaveLength(2)
  })

  it('a task its agent parked keeps its wait, and is not retried', async () => {
    const h = harness()
    const id = await delegate(h)
    await h.board.updateStatus(id, 'blocked', {
      waitingOn: { kind: 'person', need: 'a decision', by: 'agent' },
    })
    await end(h, fatal('r2', RATE_LIMIT))
    expect(h.statusOf(id)).toBe('blocked')
    expect(h.waitOf(id)).toMatchObject({ kind: 'person' })
  })

  it('a fix round cut short by a rate limit keeps what it was told to fix', async () => {
    const answers: Array<(r: WorkCheckResult) => void> = []
    const workCheck: WorkCheck = {
      async begin() {},
      async prepare() {
        return () => new Promise<WorkCheckResult>((resolve) => answers.push(resolve))
      },
    }
    const h = harness({ workCheck })
    const id = await delegate(h)
    await end(h, done('r2', 'done'))
    await vi.advanceTimersByTimeAsync(0)
    answers[0]!({ verdict: 'retry', fixNote: 'tests are red' })
    await vi.advanceTimersByTimeAsync(0)
    await vi.advanceTimersByTimeAsync(0)
    expect(h.toWorker()).toHaveLength(2)

    await end(h, fatal('r3', RATE_LIMIT))
    expect(h.statusOf(id)).toBe('todo')
    await vi.advanceTimersByTimeAsync(38_000)
    expect(h.toWorker()).toHaveLength(3)
    expect(h.toWorker()[2]!.task).toContain('tests are red')
  })

  it('a held engine does not start the retry; the pass when the hold lifts does', async () => {
    let held = false
    const h = harness({ held: () => held })
    const id = await delegate(h)
    await end(h, fatal('r2', RATE_LIMIT))
    held = true
    await vi.advanceTimersByTimeAsync(40_000)
    expect(h.toWorker()).toHaveLength(1)
    expect(h.statusOf(id)).toBe('todo')
    held = false
    await h.engine.resume()
    expect(h.toWorker()).toHaveLength(2)
  })
})

describe('a pause, on the way through a retry or an extra turn', () => {
  const NOTE = 'Paused by a person. This run was stopped and starts again on resume.'
  const everything = (): boolean => true

  it('a retry a pause stopped is not spent: the run on resume is that retry', async () => {
    const h = harness()
    const id = await delegate(h)
    await end(h, fatal('r2', RATE_LIMIT))
    await vi.advanceTimersByTimeAsync(38_000)
    expect(h.toWorker()).toHaveLength(2)

    expect(await h.engine.pauseRuns(everything, NOTE)).toEqual([id])
    expect((await h.ledger(id)).at(-1)).toMatchObject({ status: 'cancelled', errorClass: 'Paused' })

    // It goes straight away on resume, and it is still the retry it was.
    await h.engine.resume()
    expect(h.toWorker()).toHaveLength(3)
    expect((await h.ledger(id)).at(-1)?.runReason).toBe('provider_retry')
    await end(h, fatal('r3', RATE_LIMIT))
    expect(h.waitOf(id)).toMatchObject({ kind: 'retry', attempt: 2 })

    await vi.advanceTimersByTimeAsync(80_000)
    expect(h.toWorker()).toHaveLength(4)
    await end(h, fatal('r4', RATE_LIMIT))
    expect(h.statusOf(id)).toBe('blocked')
    expect(h.waitOf(id)).toMatchObject({ kind: 'provider', cause: 'rate_limited' })
    // Three failures and one stop: the pause cost it no try.
    expect((await h.ledger(id)).map((r) => r.status)).toEqual([
      'failed',
      'cancelled',
      'failed',
      'failed',
    ])
  })

  it('a pause-stopped run is no failure: nobody hears, and the card does not say so', async () => {
    const h = harness()
    const id = await delegate(h)
    await h.engine.pauseRuns(everything, NOTE)
    await vi.advanceTimersByTimeAsync(REFLECT_WINDOW_MS)
    expect(h.statusOf(id)).toBe('todo')
    expect(h.updates()).toEqual([])
    expect((await h.ledger(id)).at(-1)?.status).toBe('cancelled')
  })

  it('an extra turn a pause stopped hands out no second one on resume', async () => {
    const h = harness()
    const id = await delegate(h)
    await end(h, done('r2', ''))
    expect(h.toWorker()).toHaveLength(2)
    expect((await h.ledger(id)).at(-1)?.runReason).toBe('empty_reply')

    await h.engine.pauseRuns(everything, NOTE)
    await h.engine.resume()
    expect(h.toWorker()).toHaveLength(3)
    // Told what it was told, and the same kind of run.
    expect(h.toWorker()[2]!.task).toContain('[No reply]')
    expect((await h.ledger(id)).at(-1)?.runReason).toBe('empty_reply')

    await end(h, done('r3', ''))
    expect(h.statusOf(id)).toBe('blocked')
    expect(h.waitOf(id)).toMatchObject({ kind: 'no_result' })
    expect(h.toWorker()).toHaveLength(3)
  })

  it('a round a pause kept from starting is told what it was to be told, on resume', async () => {
    let paused = true
    const board = new FakeBoard()
    const gen = { value: 0 }
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
      stopGen: () => gen.value,
      runHeldBy: () => (paused ? NOTE : null),
    })
    paused = false
    await engine.onEvent(
      sk('leader'),
      done('r1', '<delegate to="@Bug Boo">fix the parser</delegate>'),
    )
    const id = board.created.at(-1)!.id
    // The pause lands as the empty reply's round is about to go out.
    paused = true
    await engine.onEvent(sk('a2'), done('r2', ''))
    await vi.advanceTimersByTimeAsync(0)
    expect(board.statusOf(id)).toBe('todo')
    paused = false
    await engine.resume()
    const toWorker = delivered.filter((d) => d.agentId === 'a2')
    expect(toWorker).toHaveLength(2)
    expect(toWorker[1]!.task).toContain('[No reply]')
  })
})

describe('running out of room', () => {
  it('gets one continuation', async () => {
    const h = harness()
    const id = await delegate(h)
    await end(h, outOfRoom('r2', 'did the first half'))

    expect(h.statusOf(id)).toBe('in_progress')
    expect(h.toWorker()).toHaveLength(2)
    expect(h.toWorker()[1]!.task).toMatch(/ran out of room/i)
    const [first, second] = await h.ledger(id)
    expect(first).toMatchObject({ status: 'failed' })
    expect(second).toMatchObject({ status: 'running', runReason: 'max_turns' })
    // What it did so far stays on the card, for a session that starts fresh.
    expect(h.comments(id)).toContain('did the first half')
    await vi.advanceTimersByTimeAsync(REFLECT_WINDOW_MS)
    expect(h.updates()).toHaveLength(0)
  })

  it('a continuation that finishes lands in Done', async () => {
    const h = harness()
    const id = await delegate(h)
    await end(h, outOfRoom('r2'))
    await end(h, done('r3', 'finished the rest'))
    expect(h.statusOf(id)).toBe('done')
  })

  it('a second ending goes to Blocked and says so, with the plan kept', async () => {
    const h = harness()
    const id = await delegate(h)
    const next = await h.board.createTask({
      title: 'next',
      sourceDelegationId: 'p:step:agent:a3:reflectTo:leader',
    })
    await h.board.linkDep(next!.id, id)
    await end(h, outOfRoom('r2'))
    await end(h, outOfRoom('r3', 'still not there'))

    expect(h.statusOf(id)).toBe('blocked')
    expect(h.waitOf(id)).toEqual({ kind: 'out_of_room' })
    expect(h.toWorker()).toHaveLength(2)
    expect(h.comments(id).join('\n')).toMatch(/twice/i)
    expect(h.statusOf(next!.id)).toBe('todo')
    await vi.advanceTimersByTimeAsync(REFLECT_WINDOW_MS)
    expect(h.updates()).toHaveLength(1)
    expect(h.updates()[0]!.task).toMatch(/ran out of room/i)
  })

  it('the count comes from the ledger, so a restart does not hand out another', async () => {
    const board = new FakeBoard()
    const gen = { value: 0 }
    const before = harness({ board, gen })
    const id = await delegate(before)
    await end(before, outOfRoom('r2'))
    before.engine.reset()

    const after = harness({ board, gen })
    await after.engine.resume()
    await end(after, outOfRoom('r3'))
    expect(after.statusOf(id)).toBe('blocked')
    expect(after.toWorker()).toHaveLength(0)
  })

  it('a provider retry of the continuation hands out no second one', async () => {
    const h = harness()
    const id = await delegate(h)
    await end(h, outOfRoom('r2'))
    await end(h, fatal('r3', RATE_LIMIT))
    await vi.advanceTimersByTimeAsync(38_000)
    expect(h.toWorker()).toHaveLength(3)
    await end(h, outOfRoom('r4'))
    expect(h.statusOf(id)).toBe('blocked')
    expect(h.waitOf(id)).toEqual({ kind: 'out_of_room' })
    expect(h.toWorker()).toHaveLength(3)
  })

  it('a Stop before the continuation goes out starts nothing', async () => {
    let busy = false
    const h = harness({ isSessionOccupied: () => busy })
    const id = await delegate(h)
    busy = true
    await end(h, outOfRoom('r2'))
    h.gen.value += 1
    await h.engine.markStopped()
    await vi.advanceTimersByTimeAsync(0)
    expect(h.statusOf(id)).toBe('todo')
    expect(h.toWorker()).toHaveLength(1)
  })
})

describe('a budget refusal on the engine path', () => {
  const refused = (reason: 'paused' | 'held'): Error =>
    new DeliveryRefusedError('The team budget is at its hard cap.', {
      budget: true,
      budgetReason: reason,
    })

  it('a paused cap files its own status, and waits on the budget with the plan kept', async () => {
    let refusal: Error | null = refused('paused')
    const h = harness({ deliverRefusal: () => refusal })
    await h.engine.onEvent(
      sk('leader'),
      done('r1', '<plan><step to="@Bug Boo">one</step><step to="@Doc Boo">two</step></plan>'),
    )
    await vi.advanceTimersByTimeAsync(0)
    refusal = null
    const [one, two] = h.board.created
    expect(h.statusOf(one!.id)).toBe('blocked')
    expect(h.waitOf(one!.id)).toEqual({ kind: 'budget' })
    expect(await h.ledger(one!.id)).toMatchObject([
      { status: 'budget_paused', errorClass: 'BudgetRefused' },
    ])
    expect(h.statusOf(two!.id)).toBe('todo')
  })

  it('counts nothing against the delegation breaker', async () => {
    const h = harness({ deliverRefusal: () => refused('paused') })
    const noted = vi.spyOn(h.board, 'noteDelegationFailure')
    await delegate(h)
    expect(noted).not.toHaveBeenCalled()
  })

  it('a refusal that reached the engine as a run’s ending files the same way', async () => {
    const h = harness()
    const id = await delegate(h)
    await end(h, fatal('r2', 'The agent budget is at its hard cap.', BUDGET_REFUSED_CODE))
    expect(h.statusOf(id)).toBe('blocked')
    expect(h.waitOf(id)).toEqual({ kind: 'budget' })
    expect((await h.ledger(id)).at(-1)).toMatchObject({ status: 'budget_paused' })
  })

  it('a held budget goes back to To do and tells no one, because it clears by itself', async () => {
    const h = harness({ deliverRefusal: () => refused('held') })
    const id = await delegate(h)
    expect(h.statusOf(id)).toBe('todo')
    expect(h.waitOf(id)).toEqual({ kind: 'budget', held: true })
    expect(await h.ledger(id)).toMatchObject([{ status: 'budget_held' }])
    await vi.advanceTimersByTimeAsync(REFLECT_WINDOW_MS)
    expect(h.updates()).toHaveLength(0)
  })

  it('a held refusal as a run’s ending goes back to To do too', async () => {
    const h = harness()
    const id = await delegate(h)
    await end(h, fatal('r2', 'Room in the budget is set aside.', BUDGET_HELD_CODE))
    expect(h.statusOf(id)).toBe('todo')
    expect((await h.ledger(id)).at(-1)).toMatchObject({ status: 'budget_held' })
  })

  it('runs again when the budget clears, asking first so a wait writes no rows', async () => {
    let refusal: Error | null = refused('held')
    let stillHeld = true
    const h = harness({
      deliverRefusal: () => refusal,
      budgetRefusal: () => (stillHeld ? 'held' : null),
    })
    const id = await delegate(h)
    refusal = null

    await vi.advanceTimersByTimeAsync(5 * 60_000)
    await h.engine.resume()
    expect(h.toWorker()).toHaveLength(0)
    expect(await h.ledger(id)).toHaveLength(1)
    expect(h.statusOf(id)).toBe('todo')

    stillHeld = false
    await h.engine.resume()
    expect(h.toWorker()).toHaveLength(1)
    expect(h.statusOf(id)).toBe('in_progress')
    expect(h.waitOf(id)).toBeUndefined()
  })

  it('without a gate to ask, a held task tries again on its own, at the wait’s pace', async () => {
    let refusal: Error | null = refused('held')
    const h = harness({ deliverRefusal: () => refusal })
    const id = await delegate(h)
    await h.engine.resume()
    expect(await h.ledger(id)).toHaveLength(1)
    await vi.advanceTimersByTimeAsync(31_000)
    expect((await h.ledger(id)).length).toBe(2)
    refusal = null
    await vi.advanceTimersByTimeAsync(31_000)
    expect(h.toWorker()).toHaveLength(1)
    expect(h.statusOf(id)).toBe('in_progress')
  })

  it('the cap fills while it waits: it goes to a person, and whoever handed it out hears', async () => {
    let refusal: Error | null = refused('held')
    let gate: 'paused' | 'held' | null = 'held'
    const h = harness({ deliverRefusal: () => refusal, budgetRefusal: () => gate })
    const id = await delegate(h)
    const next = await h.board.createTask({
      title: 'next',
      sourceDelegationId: 'p:step:agent:a3:reflectTo:leader',
    })
    await h.board.linkDep(next!.id, id)
    refusal = null
    expect(h.waitOf(id)).toEqual({ kind: 'budget', held: true })

    gate = 'paused'
    await vi.advanceTimersByTimeAsync(31_000)
    await h.engine.resume()

    expect(h.statusOf(id)).toBe('blocked')
    expect(h.waitOf(id)).toEqual({ kind: 'budget' })
    expect(h.toWorker()).toHaveLength(0)
    expect(await h.ledger(id)).toHaveLength(1)
    expect(h.comments(id).join('\n')).toMatch(/hard cap/i)
    expect(h.statusOf(next!.id)).toBe('todo')
    await vi.advanceTimersByTimeAsync(REFLECT_WINDOW_MS)
    expect(h.updates()).toHaveLength(1)
    expect(h.updates()[0]!.task).toMatch(/budget cap/i)

    // Once, however many passes come.
    await h.engine.resume()
    await vi.advanceTimersByTimeAsync(REFLECT_WINDOW_MS)
    expect(h.updates()).toHaveLength(1)
  })

  it('promises nothing the fire policy would refuse: a held task past its failure limit goes to a person', async () => {
    let refusal: Error | null = null
    const h = harness({ deliverRefusal: () => refusal })
    const id = await delegate(h)
    await end(h, fatal('r2', RATE_LIMIT))
    await vi.advanceTimersByTimeAsync(38_000)
    await end(h, fatal('r3', RATE_LIMIT))
    await vi.advanceTimersByTimeAsync(76_000)
    await end(h, fatal('r4', RATE_LIMIT))
    expect(h.statusOf(id)).toBe('blocked')

    refusal = refused('held')
    await h.board.updateStatus(id, 'todo')
    await h.engine.dispatchTask(id)
    expect(h.statusOf(id)).toBe('blocked')
    expect(h.waitOf(id)).toEqual({ kind: 'budget' })
  })

  it('a round refused as held keeps what it was told, when the room comes back', async () => {
    const answers: Array<(r: WorkCheckResult) => void> = []
    const workCheck: WorkCheck = {
      async begin() {},
      async prepare() {
        return () => new Promise<WorkCheckResult>((resolve) => answers.push(resolve))
      },
    }
    let refusal: Error | null = null
    const h = harness({ workCheck, deliverRefusal: () => refusal })
    const id = await delegate(h)
    await end(h, done('r2', 'done'))
    await vi.advanceTimersByTimeAsync(0)
    refusal = refused('held')
    answers[0]!({ verdict: 'retry', fixNote: 'tests are red' })
    await vi.advanceTimersByTimeAsync(0)
    await vi.advanceTimersByTimeAsync(0)
    expect(h.statusOf(id)).toBe('todo')
    expect((await h.ledger(id)).at(-1)).toMatchObject({
      status: 'budget_held',
      runReason: 'fix_round',
    })

    refusal = null
    await vi.advanceTimersByTimeAsync(31_000)
    expect(h.toWorker()).toHaveLength(2)
    expect(h.toWorker()[1]!.task).toContain('tests are red')
    expect((await h.ledger(id)).at(-1)).toMatchObject({ status: 'running', runReason: 'fix_round' })
  })

  it('a Stop on a held task parks it as stopped', async () => {
    const h = harness({ deliverRefusal: () => refused('held') })
    const id = await delegate(h)
    h.gen.value += 1
    await h.engine.markStopped()
    expect(h.waitOf(id)).toBeUndefined()
    expect((await h.ledger(id)).at(-1)).toMatchObject({ status: 'cancelled' })
    await vi.advanceTimersByTimeAsync(3_600_000)
    expect(await h.ledger(id)).toHaveLength(2)
  })
})
