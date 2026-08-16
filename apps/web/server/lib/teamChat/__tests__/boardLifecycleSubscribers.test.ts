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
  resetBoardLifecycleListeners,
  teams,
} from '@clawboo/db'

const pumped: string[] = []
vi.mock('../teamOrchestrator', () => ({
  getTeamOrchestrator: (teamId: string) => ({
    pump: async () => {
      pumped.push(teamId)
    },
    signalAgent: () => undefined,
  }),
  // No live orchestrator: the mailbox row is the delivery of record, and this
  // suite is about the durable half, not the ambient signal.
  hasTeamOrchestrator: () => false,
}))

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
