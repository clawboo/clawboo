// A hand-off from Boo Zero's one-to-one chat goes through the same start as one from
// a lead's turn in the team's chat, so every fence still applies, but its result and
// its refusals go back to the chat that asked. The team's engine never delivers them
// into the recipient's team session.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { RuntimeEvent } from '@clawboo/executor'

import { delegationFailureKey } from '@clawboo/board-core'

import {
  createBoardOrchestrator,
  MAX_DELEGATION_FAILURES,
  REFLECT_WINDOW_MS,
  type ChatReportUps,
  type KnownAgent,
  type ReportUp,
} from '../boardOrchestration'
import type { TurnOrigin } from '../turnOrigin'
import { FakeBoard } from './fakeBoard'

const KNOWN: KnownAgent[] = [
  { id: 'bz', name: 'Boo Zero' },
  { id: 'a2', name: 'Bug Boo' },
  { id: 'a3', name: 'Data Boo' },
]
const CHAT = 'agent:bz:native'
const sk = (id: string): string => `agent:${id}:team:t1`
const agentIdForSession = (s: string): string | null => s.match(/^agent:([^:]+):/)?.[1] ?? null
const doneEvent = (runId: string, summary: string): RuntimeEvent => ({
  kind: 'done',
  reason: 'success',
  summary,
  runId,
  sessionId: null,
  ts: 1,
  seq: 1,
})

type Delivered = { sessionKey: string; agentId: string; task: string; origin: TurnOrigin }

function boot(
  board: FakeBoard,
  opts: {
    chat?: ChatReportUps
    risky?: boolean
    stopGen?: () => number
    /** A hand-off with "release" in it waits on this. */
    approval?: () => Promise<'allow_once' | 'deny'>
  } = {},
) {
  const delivered: Delivered[] = []
  const taken: Array<{ item: ReportUp; held: boolean }> = []
  const chat: ChatReportUps = opts.chat ?? {
    take(item, { held }) {
      const fromChat =
        item.chatSessionKey != null ||
        (item.taskId != null && board.tasks.get(item.taskId)?.chatSessionKey != null)
      if (!fromChat) return false
      taken.push({ item, held })
      return true
    },
  }
  const engine = createBoardOrchestrator({
    teamId: 't1',
    board,
    known: () => KNOWN,
    leaderAgentId: () => 'bz',
    sessionKeyForAgent: sk,
    agentIdForSession,
    deliver: async (sessionKey, agentId, task, origin) => {
      delivered.push({ sessionKey, agentId, task, origin })
    },
    stopGen: opts.stopGen ?? (() => 0),
    chatReportUps: chat,
    ...(opts.risky
      ? {
          isRiskyDelegation: () => true,
          requestDelegationApproval: async () => 'deny' as const,
        }
      : {}),
    ...(opts.approval
      ? {
          isRiskyDelegation: (signal: { task: string }) => signal.task.includes('release'),
          requestDelegationApproval: opts.approval,
        }
      : {}),
  })
  return { engine, delivered, taken }
}

const handOff = {
  fromAgentId: 'bz',
  targetAgentId: 'a2',
  targetAgentName: 'Bug Boo',
  task: 'fix the parser',
  turnId: 'chat-turn-1',
  chatSessionKey: CHAT,
}

describe('a hand-off from a one-to-one chat', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => {
    vi.clearAllTimers()
    vi.useRealTimers()
  })

  it('makes a task that remembers the chat, and starts it for the teammate', async () => {
    const board = new FakeBoard()
    const { engine, delivered } = boot(board)

    const { taskId } = await engine.handOffFromChat(handOff)

    expect(taskId).toBeTruthy()
    expect(board.tasks.get(taskId!)?.chatSessionKey).toBe(CHAT)
    expect(delivered).toHaveLength(1)
    expect(delivered[0]!.sessionKey).toBe(sk('a2'))
    expect(delivered[0]!.origin).toEqual({ kind: 'delegation', fromAgentId: 'bz' })
  })

  it('keeps the person who asked on the task', async () => {
    const board = new FakeBoard()
    const { engine } = boot(board)
    const person = { id: 'local', name: 'You', role: null }

    const { taskId } = await engine.handOffFromChat({ ...handOff, requestedBy: person })

    expect(board.tasks.get(taskId!)?.requestedBy).toEqual(person)
  })

  it('files under a parent when one is given', async () => {
    const board = new FakeBoard()
    const { engine } = boot(board)
    const parent = await board.createTask({ title: 'your request', teamId: 't1' })

    const { taskId } = await engine.handOffFromChat({ ...handOff, parentTaskId: parent!.id })

    expect(board.tasks.get(taskId!)?.parentTaskId).toBe(parent!.id)
  })

  it('sends its result to the chat, never into a team session', async () => {
    const board = new FakeBoard()
    const { engine, delivered, taken } = boot(board)

    const { taskId } = await engine.handOffFromChat(handOff)
    await engine.onEvent(sk('a2'), doneEvent('r2', 'fixed in parser.ts'))
    await vi.advanceTimersByTimeAsync(REFLECT_WINDOW_MS * 2)

    expect(taken).toHaveLength(1)
    expect(taken[0]!.item.taskId).toBe(taskId)
    expect(taken[0]!.item.summary).toContain('fixed in parser.ts')
    expect(taken[0]!.held).toBe(false)
    expect(delivered.filter((d) => d.task.startsWith('[Task Update]'))).toEqual([])
  })

  it('keeps a result that comes back after a Stop for the chat, as held: it wakes no one', async () => {
    const board = new FakeBoard()
    let gen = 0
    const { engine, delivered, taken } = boot(board, { stopGen: () => gen })
    const { taskId } = await engine.handOffFromChat(handOff)

    gen += 1
    await engine.onEvent(sk('a2'), doneEvent('r2', 'finished after the Stop'))
    await vi.advanceTimersByTimeAsync(REFLECT_WINDOW_MS * 2)

    expect(taken).toHaveLength(1)
    expect(taken[0]!.held).toBe(true)
    expect(taken[0]!.item.taskId).toBe(taskId)
    expect(delivered.filter((d) => d.task.startsWith('[Task Update]'))).toEqual([])
  })

  it('a report-up the chat could not keep goes to the team, so it is not lost', async () => {
    const board = new FakeBoard()
    const { engine, delivered } = boot(board, { chat: { take: () => false } })

    await engine.handOffFromChat(handOff)
    await engine.onEvent(sk('a2'), doneEvent('r2', 'kept nowhere'))
    await vi.advanceTimersByTimeAsync(REFLECT_WINDOW_MS * 2)

    const update = delivered.find((d) => d.task.startsWith('[Task Update]'))
    expect(update?.sessionKey).toBe(sk('bz'))
    expect(update?.task).toContain('kept nowhere')
  })

  it('sends a refusal to the chat too: nothing starts and nothing reaches a team session', async () => {
    const board = new FakeBoard()
    const { engine, delivered, taken } = boot(board, { risky: true })

    const outcome = await engine.handOffFromChat(handOff)
    await vi.advanceTimersByTimeAsync(REFLECT_WINDOW_MS * 2)

    expect(outcome).toEqual({ taskId: null, told: true })
    expect(board.tasks.size).toBe(0)
    expect(delivered).toEqual([])
    expect(taken).toHaveLength(1)
    expect(taken[0]!.item.chatSessionKey).toBe(CHAT)
    expect(taken[0]!.item.summary).toContain('not approved')
  })

  it('a refusal starts no paid turn: it is kept for the next one, and said now', async () => {
    const board = new FakeBoard()
    const { engine, delivered, taken } = boot(board, { risky: true })
    const said: string[] = []

    for (let i = 0; i < 6; i += 1) {
      await engine.handOffFromChat({
        ...handOff,
        task: `reworded ${i}`,
        turnId: `chat-turn-${i}`,
        onTold: (words) => said.push(words),
      })
      await vi.advanceTimersByTimeAsync(REFLECT_WINDOW_MS * 2)
    }

    expect(delivered).toEqual([])
    expect(taken).toHaveLength(6)
    expect(taken.every((t) => t.held)).toBe(true)
    expect(said).toHaveLength(6)
    expect(said[0]).toContain('not approved')
  })

  it("does not count a chat's work as outstanding in a team session's update", async () => {
    const board = new FakeBoard()
    const { engine, delivered } = boot(board)

    // Still running on another teammate, with its result due in the chat.
    await engine.handOffFromChat({
      ...handOff,
      targetAgentId: 'a3',
      targetAgentName: 'Data Boo',
      task: 'chat work',
    })
    // Boo Zero's hand-off in the team's own chat finishes meanwhile.
    await engine.onEvent(sk('bz'), doneEvent('r1', '<delegate to="@Bug Boo">team work</delegate>'))
    await engine.onEvent(sk('a2'), doneEvent('r2', 'team result'))
    await vi.advanceTimersByTimeAsync(REFLECT_WINDOW_MS * 2)

    const update = delivered.find((d) => d.task.startsWith('[Task Update]'))
    expect(update?.sessionKey).toBe(sk('bz'))
    expect(update?.task).toContain('team result')
    expect(update?.task).not.toContain('Still outstanding')
    expect(update?.task).not.toContain('chat work')
  })

  it("says where the result goes when the words find a task from the team's own chat", async () => {
    const board = new FakeBoard()
    const { engine, taken } = boot(board)
    // Open work from the team's chat, with these very words.
    await engine.onEvent(
      sk('bz'),
      doneEvent('r1', '<delegate to="@Bug Boo">fix the parser</delegate>'),
    )

    const outcome = await engine.handOffFromChat(handOff)

    expect(outcome).toEqual({ taskId: null, told: true })
    expect(taken).toHaveLength(1)
    expect(taken[0]!.item.outcome).toBe('already_open')
    expect(taken[0]!.item.summary).toContain("result goes to the team's chat, not here")
  })

  it('a repeat from the chat that already has the task says it will come back here', async () => {
    const board = new FakeBoard()
    const { engine, taken } = boot(board)
    await engine.handOffFromChat(handOff)

    await engine.handOffFromChat({ ...handOff, turnId: 'chat-turn-2' })

    expect(taken).toHaveLength(1)
    expect(taken[0]!.item.summary).toContain('Its result will reach you when it ends.')
  })

  describe('says what became of it, every time', () => {
    it('work that keeps failing, once the breaker has already told someone', async () => {
      const board = new FakeBoard()
      const { engine } = boot(board)
      const key = delegationFailureKey('a2', handOff.task)
      for (let i = 0; i < MAX_DELEGATION_FAILURES; i++)
        await board.noteDelegationFailure('t1', 'a2', key)
      await board.markDelegationFailureNotified('t1', 'a2', key)

      expect(await engine.handOffFromChat(handOff)).toEqual({
        taskId: null,
        told: false,
        why: 'failed_before',
      })
    })

    it('a repeat that finds the same open work a second time', async () => {
      const board = new FakeBoard()
      const { engine, taken } = boot(board)
      await engine.onEvent(
        sk('bz'),
        doneEvent('r1', '<delegate to="@Bug Boo">fix the parser</delegate>'),
      )
      await engine.handOffFromChat(handOff)
      expect(taken).toHaveLength(1)

      expect(await engine.handOffFromChat({ ...handOff, turnId: 'chat-turn-2' })).toEqual({
        taskId: null,
        told: false,
        why: 'already_open',
      })
      expect(taken).toHaveLength(1)
    })

    it('a Stop that lands while it starts', async () => {
      const board = new FakeBoard()
      let gen = 0
      const realFailure = board.delegationFailure.bind(board)
      board.delegationFailure = async (...args) => {
        gen += 1
        return realFailure(...args)
      }
      const { engine } = boot(board, { stopGen: () => gen })

      expect(await engine.handOffFromChat(handOff)).toEqual({
        taskId: null,
        told: false,
        why: 'stopped',
      })
    })

    it('the same words twice in one reply: the card there answers for both', async () => {
      const board = new FakeBoard()
      const { engine } = boot(board)
      const first = await engine.handOffFromChat(handOff)
      const second = await engine.handOffFromChat(handOff)

      expect(second).toEqual({ taskId: first.taskId })
      expect(board.tasks.size).toBe(1)
    })

    it('a task the claim could not take still has its card', async () => {
      const board = new FakeBoard()
      board.forceClaimConflict = true
      const { engine } = boot(board)

      const { taskId } = await engine.handOffFromChat(handOff)

      expect(taskId).toBeTruthy()
      expect(board.tasks.get(taskId!)?.status).toBe('todo')
    })
  })

  it('leaves everything else to the team as before', async () => {
    const board = new FakeBoard()
    const { engine, delivered, taken } = boot(board)

    await engine.onEvent(sk('bz'), doneEvent('r1', '<delegate to="@Bug Boo">team work</delegate>'))
    await engine.onEvent(sk('a2'), doneEvent('r2', 'team result'))
    await vi.advanceTimersByTimeAsync(REFLECT_WINDOW_MS * 2)

    expect(taken).toEqual([])
    const update = delivered.find((d) => d.task.startsWith('[Task Update]'))
    expect(update?.sessionKey).toBe(sk('bz'))
    expect(update?.task).toContain('team result')
  })
})

describe('a person’s message from a one-to-one chat is a request', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => {
    vi.clearAllTimers()
    vi.useRealTimers()
  })

  const person = { id: 'local', name: 'You', role: null }
  const asked = {
    ...handOff,
    requestedBy: person,
    request: { messageId: 'message-1', words: 'Fix the parser\nand say how it went' },
  }
  const mains = (board: FakeBoard) => [...board.tasks.values()].filter((t) => t.isMainTask)

  it('makes a main task from their words, held by the chat, with the hand-off under it', async () => {
    const board = new FakeBoard()
    const { engine } = boot(board)

    const { taskId } = await engine.handOffFromChat(asked)

    expect(mains(board)).toHaveLength(1)
    const main = mains(board)[0]!
    expect(main.title).toBe('Fix the parser')
    expect(main.description).toBe('Fix the parser\nand say how it went')
    expect(main.assigneeAgentId).toBe('bz')
    expect(main.chatSessionKey).toBe(CHAT)
    expect(main.requestedBy).toEqual(person)
    const task = board.tasks.get(taskId!)!
    expect(task.parentTaskId).toBe(main.id)
    expect(task.chatSessionKey).toBe(CHAT)
    expect(task.requestedBy).toEqual(person)
  })

  it('files the message’s next hand-off under the same one', async () => {
    const board = new FakeBoard()
    const { engine } = boot(board)

    const first = await engine.handOffFromChat(asked)
    const second = await engine.handOffFromChat({
      ...asked,
      targetAgentId: 'a3',
      targetAgentName: 'Data Boo',
      task: 'check the numbers',
    })

    expect(mains(board)).toHaveLength(1)
    expect(board.tasks.get(second.taskId!)?.parentTaskId).toBe(
      board.tasks.get(first.taskId!)?.parentTaskId,
    )
  })

  it('finds it from another engine, overlapping or after a retry of the message', async () => {
    const board = new FakeBoard()
    const one = boot(board).engine
    const other = boot(board).engine

    const [a, b] = await Promise.all([
      one.handOffFromChat(asked),
      other.handOffFromChat({
        ...asked,
        turnId: 'chat-turn-2',
        targetAgentId: 'a3',
        targetAgentName: 'Data Boo',
        task: 'check the numbers',
      }),
    ])
    const retried = await boot(board).engine.handOffFromChat({
      ...asked,
      turnId: 'chat-turn-3',
      task: 'and the tests',
    })

    expect(mains(board)).toHaveLength(1)
    const main = mains(board)[0]!.id
    for (const outcome of [a, b, retried])
      expect(board.tasks.get(outcome.taskId!)?.parentTaskId).toBe(main)
  })

  it('a second message is a new request', async () => {
    const board = new FakeBoard()
    const { engine } = boot(board)

    await engine.handOffFromChat(asked)
    await engine.handOffFromChat({
      ...asked,
      request: { messageId: 'message-2', words: 'Something else' },
      task: 'something else',
      turnId: 'chat-turn-2',
    })

    expect(mains(board).map((m) => m.title)).toEqual(['Fix the parser', 'Something else'])
  })

  it('a message with no words, and a turn with no message, make none', async () => {
    const board = new FakeBoard()
    const { engine } = boot(board)

    await engine.handOffFromChat({ ...handOff, request: { messageId: 'm', words: '   ' } })
    await engine.handOffFromChat({ ...handOff, task: 'other work', turnId: 'chat-turn-2' })

    expect(mains(board)).toEqual([])
  })

  it('a turn reading a request’s results goes on with it, and a closed one refuses out loud', async () => {
    const board = new FakeBoard()
    const { engine, taken } = boot(board)
    await engine.handOffFromChat(asked)
    const main = mains(board)[0]!

    const more = await engine.handOffFromChat({
      ...handOff,
      targetAgentId: 'a3',
      targetAgentName: 'Data Boo',
      task: 'one more thing',
      turnId: 'update-turn',
      parentTaskId: main.id,
    })
    expect(board.tasks.get(more.taskId!)?.parentTaskId).toBe(main.id)
    expect(mains(board)).toHaveLength(1)

    main.status = 'done'
    const refused = await engine.handOffFromChat({
      ...handOff,
      task: 'too late',
      turnId: 'update-turn-2',
      parentTaskId: main.id,
    })
    expect(refused).toEqual({ taskId: null, told: true })
    expect(taken.at(-1)!.item.summary).toContain('This request has closed')
    expect(taken.at(-1)!.item.chatSessionKey).toBe(CHAT)
  })

  describe('closes after its summary to the chat', () => {
    /** The chat's outbox: `kept` is what has not settled yet. */
    function withChatOutbox(board: FakeBoard) {
      const kept: ReportUp[] = []
      const chat: ChatReportUps = {
        take(item) {
          const from =
            item.chatSessionKey != null ||
            (item.taskId != null && board.tasks.get(item.taskId)?.chatSessionKey != null)
          if (from) kept.push(item)
          return from
        },
        waiting: () => kept,
      }
      return { chat, kept }
    }

    it('with the reply on the card, once its work is in and the chat has heard', async () => {
      const board = new FakeBoard()
      const { chat, kept } = withChatOutbox(board)
      const { engine, delivered } = boot(board, { chat })
      await engine.handOffFromChat(asked)
      const main = mains(board)[0]!

      // Its work is still running.
      await engine.closeRequestFromChat(main.id, 'bz', 'too early')
      expect(main.status).toBe('in_progress')

      await engine.onEvent(sk('a2'), doneEvent('r2', 'fixed'))
      expect(kept.map((i) => i.summary)).toEqual(['fixed'])

      // Its work is in, but the chat has not heard: that row is what the reply answers.
      await engine.closeRequestFromChat(main.id, 'bz', 'too early as well')
      expect(main.status).toBe('in_progress')
      // Nor does the sweep ask its lead again meanwhile.
      await engine.sweepStaleSessions()
      expect(kept).toHaveLength(1)

      kept.length = 0
      await engine.closeRequestFromChat(main.id, 'bz', 'The parser is fixed.')

      expect(main.status).toBe('done')
      const trail = board.comments.filter((c) => c.taskId === main.id).map((c) => c.body)
      expect(trail).toEqual(['The parser is fixed.'])
      expect(delivered.filter((d) => d.task.startsWith('[Task Update]'))).toEqual([])
    })

    it('not while a hand-off under it waits on its approval, which then files under it', async () => {
      const board = new FakeBoard()
      const { chat, kept } = withChatOutbox(board)
      let allow!: (answer: 'allow_once') => void
      const decided = new Promise<'allow_once'>((resolve) => {
        allow = resolve
      })
      const { engine } = boot(board, { chat, approval: () => decided })
      await engine.handOffFromChat(asked)
      const main = mains(board)[0]!

      const second = engine.handOffFromChat({
        ...asked,
        targetAgentId: 'a3',
        targetAgentName: 'Data Boo',
        task: 'release the numbers',
      })
      await vi.advanceTimersByTimeAsync(0)
      await engine.onEvent(sk('a2'), doneEvent('r2', 'fixed'))
      kept.length = 0

      await engine.closeRequestFromChat(main.id, 'bz', 'not yet')
      expect(main.status).toBe('in_progress')

      allow('allow_once')
      const { taskId } = await second
      expect(board.tasks.get(taskId!)?.parentTaskId).toBe(main.id)
      expect(main.status).toBe('in_progress')
    })

    it('a task under it that goes to the chat still counts as open', async () => {
      const board = new FakeBoard()
      const { engine } = boot(board)
      await engine.handOffFromChat(asked)
      const main = mains(board)[0]!

      expect((await board.mainTaskState(main.id))?.openSubtasks).toBe(1)
    })

    it('a request nothing told the chat about asks its lead there, not in the team', async () => {
      const board = new FakeBoard()
      const { chat, kept } = withChatOutbox(board)
      const { engine, delivered } = boot(board, { chat })
      await engine.handOffFromChat(asked)
      const main = mains(board)[0]!
      await engine.onEvent(sk('a2'), doneEvent('r2', 'fixed'))
      kept.length = 0

      await engine.sweepStaleSessions()

      expect(kept.map((i) => i.outcome)).toEqual(['all_in'])
      expect(kept[0]!.taskId).toBe(main.id)
      expect(delivered.filter((d) => d.task.startsWith('[Task Update]'))).toEqual([])
    })
  })
})

describe('a batch from a one-to-one chat, on a team that asks first', () => {
  const asked = {
    fromAgentId: 'bz',
    turnId: 'chat-turn-1',
    chatSessionKey: CHAT,
    request: { messageId: 'message-1', words: 'Do both' },
    steps: [
      { targetAgentId: 'a2', targetAgentName: 'Bug Boo', task: 'fix the parser' },
      { targetAgentId: 'a3', targetAgentName: 'Data Boo', task: 'check the numbers' },
    ],
  }

  it('waits on a card the chat sees, under its main task, and starts nothing', async () => {
    const board = new FakeBoard()
    board.setPlanApproval(true)
    const { engine, delivered } = boot(board)

    expect(await engine.handOffBatchFromChat(asked)).toBe('asked')

    expect(delivered).toEqual([])
    const main = [...board.tasks.values()].find((t) => t.isMainTask)!
    expect(main.chatSessionKey).toBe(CHAT)
    const holder = [...board.tasks.values()].find((t) => !t.isMainTask)!
    expect(holder.status).toBe('blocked')
    expect(holder.parentTaskId).toBe(main.id)
    expect(holder.chatSessionKey).toBe(CHAT)
  })

  it('does not ask on a team that does not, and the hand-offs go out', async () => {
    const board = new FakeBoard()
    const { engine } = boot(board)

    expect(await engine.handOffBatchFromChat(asked)).toBe('not_asked')
    expect(board.tasks.size).toBe(0)
  })

  it('a batch refused whole is told to the chat, and a repeat of that refusal says so', async () => {
    const board = new FakeBoard()
    board.setPlanApproval(true)
    const { engine, taken } = boot(board)
    const long = 'x'.repeat(4_001)
    const refused = { ...asked, steps: [{ ...asked.steps[0]!, task: long }, asked.steps[1]!] }

    expect(await engine.handOffBatchFromChat(refused)).toBe('told')
    expect(taken.at(-1)!.item.chatSessionKey).toBe(CHAT)
    expect(taken.at(-1)!.item.outcome).toBe('not_started')

    expect(await engine.handOffBatchFromChat({ ...refused, turnId: 'chat-turn-2' })).toBe(
      'refused_before',
    )
  })
})

describe('hand-offs from a one-to-one chat to a team the person did not name', () => {
  const unnamed = {
    fromAgentId: 'bz',
    turnId: 'chat-turn-1',
    chatSessionKey: CHAT,
    request: { messageId: 'message-1', words: 'Fix the parser' },
    steps: [{ targetAgentId: 'a2', targetAgentName: 'Bug Boo', task: 'fix the parser' }],
    ask: { reason: 'unnamed_team' as const, teamName: 'Growth' },
  }

  it('are put to the person on a team that does not ask, even one alone, and nothing starts', async () => {
    const board = new FakeBoard()
    const { engine, delivered } = boot(board)

    expect(await engine.handOffBatchFromChat(unnamed)).toBe('asked')

    expect(delivered).toEqual([])
    const holder = [...board.tasks.values()].find((t) => !t.isMainTask)!
    expect(holder.status).toBe('blocked')
    expect(holder.chatSessionKey).toBe(CHAT)
  })

  it('a Stop while it is being checked puts nothing to the person and starts nothing', async () => {
    const board = new FakeBoard()
    let gen = 0
    const room = board.handOffRoom.bind(board)
    board.handOffRoom = async (...args: Parameters<FakeBoard['handOffRoom']>) => {
      gen = 1
      return room(...args)
    }
    const { engine, delivered } = boot(board, { stopGen: () => gen })

    expect(await engine.handOffBatchFromChat(unnamed)).toBe('stopped')

    expect(delivered).toEqual([])
    expect([...board.tasks.values()].filter((t) => !t.isMainTask)).toEqual([])
  })
})
