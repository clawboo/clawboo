// The app-side half of the board lifecycle bus. This module had NO test file at
// all, while carrying three behaviours the coordination overhaul depends on:
// the `:agent:` wake filter, the unconditional mailbox write for an
// executor-path terminal, and the `executorType === 'openclaw'` skip that keeps
// the engine's own cascade from double-writing every step into the digest.
//
// Driven through the REAL repository so the subscribers see genuine post-commit
// events, not hand-built ones: publishing by hand would prove only that the
// handler switch works, not that the repository actually emits what it claims.

import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  agents,
  claimTask,
  completeExecutionProcess,
  createExecutionProcess,
  createTask,
  listUndeliveredInbox,
  releaseTask,
  updateStatus,
  resetBoardLifecycleListeners,
  teams,
} from '@clawboo/db'

/** Ordered log of what the subscribers asked the orchestrator to do. The order
 *  records that the synchronous detach lands before the debounced pump. */
const calls: string[] = []
const pumped: string[] = []
let resident = false
vi.mock('../teamOrchestrator', () => {
  const orchestrator = (teamId: string) => ({
    pump: async () => {
      calls.push(`pump:${teamId}`)
      pumped.push(teamId)
    },
    detachTask: (taskId: string) => {
      calls.push(`detach:${taskId}`)
      return true
    },
    signalAgent: () => undefined,
  })
  return {
    getTeamOrchestrator: orchestrator,
    // Task-routed callers reach the task's chat room's engine; every task in this
    // suite is in the team's own group chat.
    getTaskOrchestrator: orchestrator,
    // Flipped per test: most of this suite is about the durable mailbox half,
    // where no orchestrator is resident.
    hasTeamOrchestrator: () => resident,
    hasTaskOrchestrator: () => resident,
    orchestratorKey: (teamId: string, roomId?: string | null) =>
      roomId ? `${teamId}:room:${roomId}` : teamId,
    orchestratorRoomForTask: () => null,
  }
})

const { getDb, resetDb } = await import('../../db')
const { registerBoardLifecycleSubscribers, resetBoardLifecycleRegistration } =
  await import('../boardLifecycleSubscribers')

const TEAM = 'T'
const LEADER = 'leader'

describe('board lifecycle subscribers', () => {
  let home: string
  let prevHome: string | undefined

  beforeEach(async () => {
    home = await mkdtemp(path.join(os.tmpdir(), 'clawboo-lifecycle-'))
    await mkdir(path.join(home, '.clawboo'), { recursive: true })
    prevHome = process.env['HOME']
    process.env['HOME'] = home
    pumped.length = 0
    calls.length = 0
    resident = false
    const db = getDb()
    const now = Date.now()
    db.insert(teams)
      .values({
        id: TEAM,
        name: 'Team T',
        icon: '🚀',
        color: '#e94560',
        leaderAgentId: LEADER,
        createdAt: now,
        updatedAt: now,
      })
      .run()
    db.insert(agents)
      .values({
        id: LEADER,
        name: 'Boo Zero',
        gatewayId: LEADER,
        runtime: 'clawboo-native',
        teamId: TEAM,
        createdAt: now,
        updatedAt: now,
      })
      .run()
    registerBoardLifecycleSubscribers({ mcpBaseUrl: null })
  })

  afterEach(async () => {
    resetBoardLifecycleRegistration()
    resetBoardLifecycleListeners()
    resetDb()
    if (prevHome === undefined) delete process.env['HOME']
    else process.env['HOME'] = prevHome
    await rm(home, { recursive: true, force: true })
  })

  it('wakes the team only for DELEGATION-derived creates (the :agent: marker)', async () => {
    vi.useFakeTimers()
    try {
      const db = getDb()
      // The two creates must be checked in SEPARATE debounce windows. Doing both
      // then asserting one pump proves nothing: `schedulePump` collapses per team,
      // so removing the filter entirely still yields exactly one pump.
      //
      // A human/board-created card carries no `:agent:` marker and stays manual.
      createTask(db, { title: 'human card', teamId: TEAM })
      await vi.advanceTimersByTimeAsync(5_000)
      expect(pumped).toEqual([])

      // A delegation-derived card wakes the team.
      createTask(db, {
        title: 'delegated',
        teamId: TEAM,
        sourceDelegationId: 'r1:deleg:agent:a2:reflectTo:leader',
      })
      await vi.advanceTimersByTimeAsync(5_000)
      expect(pumped).toEqual([TEAM])
    } finally {
      vi.useRealTimers()
    }
  })

  it('wakes the team on a RELEASE, whatever created the task', async () => {
    vi.useFakeTimers()
    try {
      const db = getDb()
      const t = createTask(db, { title: 'released', teamId: TEAM })
      claimTask(db, t.id, 'a2')
      pumped.length = 0
      releaseTask(db, t.id)
      await vi.advanceTimersByTimeAsync(5_000)
      expect(pumped).toEqual([TEAM])
    } finally {
      vi.useRealTimers()
    }
  })

  it('a RELEASE detaches the task synchronously, so the debounced pump sees it freed', async () => {
    // The detach must be SYNCHRONOUS. The pump is debounced by 2 s, so a
    // synchronous detach is always already done by the time it runs; debouncing
    // the detach too would let the pump read a session map that still pins the
    // task. This asserts that effect, not the source order of the two blocks —
    // the debounce makes source order irrelevant.
    resident = true
    vi.useFakeTimers()
    try {
      const db = getDb()
      const t = createTask(db, {
        title: 'released mid-cascade',
        teamId: TEAM,
        sourceDelegationId: 'r1:deleg:agent:a2:reflectTo:leader',
      })
      claimTask(db, t.id, 'a2')
      calls.length = 0
      releaseTask(db, t.id)
      await vi.advanceTimersByTimeAsync(5_000)
      expect(calls).toEqual([`detach:${t.id}`, `pump:${TEAM}`])
    } finally {
      vi.useRealTimers()
    }
  })

  it('a status change to todo or cancelled by any other writer also detaches', () => {
    resident = true
    const db = getDb()
    const t = createTask(db, { title: 'dragged', teamId: TEAM })
    claimTask(db, t.id, 'a2')
    calls.length = 0
    updateStatus(db, t.id, 'todo')
    expect(calls).toContain(`detach:${t.id}`)
  })

  it('a PERSON moving the card does not detach: the board PATCH stops the run first', () => {
    // A bare detach would forget the run before `noteHumanMove` could abort it
    // and close its execution, leaving it spending with nobody tracking it.
    resident = true
    const db = getDb()
    for (const to of ['todo', 'cancelled'] as const) {
      const t = createTask(db, { title: `moved to ${to}`, teamId: TEAM })
      claimTask(db, t.id, 'a2')
      calls.length = 0
      updateStatus(db, t.id, to, { actor: 'person' })
      expect(calls.filter((c) => c.startsWith('detach:'))).toEqual([])
    }
  })

  it('a person putting a card back to To do pumps the team, so a bound agent picks it up now', async () => {
    vi.useFakeTimers()
    try {
      const db = getDb()
      // A plain card: its create carries no `:agent:` marker, so it pumps nothing.
      const t = createTask(db, { title: 'back to the queue', teamId: TEAM })
      claimTask(db, t.id, 'a2')
      updateStatus(db, t.id, 'todo', { actor: 'person' })
      await vi.advanceTimersByTimeAsync(5_000)
      expect(pumped).toEqual([TEAM])
    } finally {
      vi.useRealTimers()
    }
  })

  it('a todo move from anyone else, or a person cancelling, schedules no pump', async () => {
    vi.useFakeTimers()
    try {
      const db = getDb()
      const swept = createTask(db, { title: 'swept', teamId: TEAM })
      claimTask(db, swept.id, 'a2')
      updateStatus(db, swept.id, 'todo')
      const dropped = createTask(db, { title: 'dropped', teamId: TEAM })
      claimTask(db, dropped.id, 'a2')
      updateStatus(db, dropped.id, 'cancelled', { actor: 'person' })
      await vi.advanceTimersByTimeAsync(5_000)
      expect(pumped).toEqual([])
    } finally {
      vi.useRealTimers()
    }
  })

  it('does NOT build an orchestrator just to detach when none is resident', () => {
    resident = false
    const db = getDb()
    const t = createTask(db, { title: 'nobody home', teamId: TEAM })
    claimTask(db, t.id, 'a2')
    calls.length = 0
    releaseTask(db, t.id)
    expect(calls.filter((c) => c.startsWith('detach:'))).toEqual([])
  })

  it('an EXECUTOR-path terminal writes a durable mailbox row for the delegator', () => {
    const db = getDb()
    const t = createTask(db, {
      title: 'ship the thing',
      teamId: TEAM,
      sourceDelegationId: 'r1:deleg:agent:a2:reflectTo:leader',
    })
    claimTask(db, t.id, 'a2')
    const ex = createExecutionProcess(db, { taskId: t.id, executorType: 'codex' })
    completeExecutionProcess(db, ex.id, { status: 'succeeded' })

    const mail = listUndeliveredInbox(db, 'leader', { teamId: TEAM })
    expect(mail).toHaveLength(1)
    expect(mail[0]!.kind).toBe('task_update')
    expect(mail[0]!.taskId).toBe(t.id)
    expect(mail[0]!.body).toContain('ship the thing')
    expect(mail[0]!.body).toContain('succeeded')
  })

  it('SKIPS an engine-owned (openclaw) terminal — the engine reflects those itself', () => {
    // Without this skip every cascade step is written twice: once as the
    // engine's `[Task Update]` reflection and again as a digest line.
    const db = getDb()
    const t = createTask(db, {
      title: 'engine step',
      teamId: TEAM,
      sourceDelegationId: 'r1:deleg:agent:a2:reflectTo:leader',
    })
    claimTask(db, t.id, 'a2')
    const ex = createExecutionProcess(db, { taskId: t.id, executorType: 'openclaw' })
    completeExecutionProcess(db, ex.id, { status: 'succeeded' })

    expect(listUndeliveredInbox(db, 'leader', { teamId: TEAM })).toHaveLength(0)
  })

  it('does not stack an identical undelivered row for the same task', () => {
    const db = getDb()
    const t = createTask(db, {
      title: 'flapping',
      teamId: TEAM,
      sourceDelegationId: 'r1:deleg:agent:a2:reflectTo:leader',
    })
    for (const _ of [1, 2, 3]) {
      claimTask(db, t.id, 'a2')
      const ex = createExecutionProcess(db, { taskId: t.id, executorType: 'codex' })
      completeExecutionProcess(db, ex.id, { status: 'failed' })
      releaseTask(db, t.id)
    }
    expect(listUndeliveredInbox(db, 'leader', { teamId: TEAM })).toHaveLength(1)
  })
})
