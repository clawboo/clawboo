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
  setTaskRunnerInputs,
  teams,
  getSetting,
  setSetting,
  getComments,
  linkDep,
  listEvents,
  listWaitingTaskWakes,
  reconcileStaleInProgress,
  recordTaskWake,
  tasks,
} from '@clawboo/db'
import { eq } from 'drizzle-orm'

import { encodeTaskSessionPointer, taskSessionSettingKey } from '../nativeTeamSession'
import { engineHold } from '../../engineHold'

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

const { getDb, getDbPath, resetDb } = await import('../../db')
const { registerBoardLifecycleSubscribers, resetBoardLifecycleRegistration } =
  await import('../boardLifecycleSubscribers')

const TEAM = 'T'
const LEADER = 'leader'

describe('board lifecycle subscribers', () => {
  let home: string
  let prevHome: string | undefined
  let prevClawbooHome: string | undefined

  beforeEach(async () => {
    home = await mkdtemp(path.join(os.tmpdir(), 'clawboo-lifecycle-'))
    await mkdir(path.join(home, '.clawboo'), { recursive: true })
    prevHome = process.env['HOME']
    prevClawbooHome = process.env['CLAWBOO_HOME']
    process.env['HOME'] = home
    // `getDb()` follows CLAWBOO_HOME before $HOME: sandbox both.
    process.env['CLAWBOO_HOME'] = path.join(home, '.clawboo')
    expect(getDbPath().startsWith(home)).toBe(true)
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
    if (prevClawbooHome === undefined) delete process.env['CLAWBOO_HOME']
    else process.env['CLAWBOO_HOME'] = prevClawbooHome
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

  it('wakes no team while the engine is held', async () => {
    vi.useFakeTimers()
    try {
      const db = getDb()
      const t = createTask(db, { title: 'released', teamId: TEAM })
      claimTask(db, t.id, 'a2')
      pumped.length = 0
      engineHold().place('lifecycle-test')
      releaseTask(db, t.id)
      await vi.advanceTimersByTimeAsync(5_000)
      expect(pumped).toEqual([])
    } finally {
      engineHold().release('lifecycle-test')
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

  it('does not call a task runner run that left its task blocked "finished"', () => {
    // The task runner's own notice (the agent blocked it, or its check failed for
    // good) tells the delegator what actually happened.
    const db = getDb()
    const t = createTask(db, {
      title: 'waits on a person',
      teamId: TEAM,
      sourceDelegationId: 'r1:deleg:agent:a2:reflectTo:leader',
    })
    claimTask(db, t.id, 'a2')
    setTaskRunnerInputs(db, t.id, {
      runtime: 'codex',
      assigneeAgentId: 'a2',
      repoPath: null,
      kind: null,
      model: null,
    })
    const ex = createExecutionProcess(db, { taskId: t.id, executorType: 'codex' })
    updateStatus(db, t.id, 'blocked')
    completeExecutionProcess(db, ex.id, { status: 'succeeded' })

    expect(listUndeliveredInbox(db, 'leader', { teamId: TEAM })).toEqual([])
  })

  it.each(['openclaw-routine', 'my-ci'])(
    'still reports a %s run on a blocked task: nothing else tells the delegator',
    (executorType) => {
      // The routine dispatcher closes `succeeded`, then fails its move to Done and
      // only comments on the card. An outside executor has no notice of its own.
      const db = getDb()
      const t = createTask(db, {
        title: 'waits on a person',
        teamId: TEAM,
        sourceDelegationId: 'r1:deleg:agent:a2:reflectTo:leader',
      })
      claimTask(db, t.id, 'a2')
      const ex = createExecutionProcess(db, { taskId: t.id, executorType })
      updateStatus(db, t.id, 'blocked')
      completeExecutionProcess(db, ex.id, { status: 'succeeded' })

      const mail = listUndeliveredInbox(db, 'leader', { teamId: TEAM })
      expect(mail).toHaveLength(1)
      expect(mail[0]!.body).toContain('succeeded')
    },
  )

  it('still reports a failed run on a blocked task', () => {
    // Nothing else says so: a failure is not a block anyone announced.
    const db = getDb()
    const t = createTask(db, {
      title: 'waits on a person',
      teamId: TEAM,
      sourceDelegationId: 'r1:deleg:agent:a2:reflectTo:leader',
    })
    claimTask(db, t.id, 'a2')
    const ex = createExecutionProcess(db, { taskId: t.id, executorType: 'codex' })
    updateStatus(db, t.id, 'blocked')
    completeExecutionProcess(db, ex.id, { status: 'failed' })

    const mail = listUndeliveredInbox(db, 'leader', { teamId: TEAM })
    expect(mail).toHaveLength(1)
    expect(mail[0]!.body).toContain('failed')
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

  it('forgets every agent’s resume pointer on a task that finishes or is cancelled, and only then', () => {
    const db = getDb()
    const pointer = encodeTaskSessionPointer({
      sessionId: 's',
      runtime: 'codex',
      ticketHash: 'h',
      seenAt: 1,
    })
    const done = createTask(db, { title: 'will finish', teamId: TEAM })
    const cancelled = createTask(db, { title: 'will be cancelled', teamId: TEAM })
    const blocked = createTask(db, { title: 'will be blocked', teamId: TEAM })
    for (const t of [done, cancelled, blocked]) {
      setSetting(db, taskSessionSettingKey('a1', TEAM, t.id), pointer)
      setSetting(db, taskSessionSettingKey('a2', TEAM, t.id), pointer)
    }
    updateStatus(db, done.id, 'in_progress')
    updateStatus(db, done.id, 'done')
    updateStatus(db, cancelled.id, 'cancelled')
    updateStatus(db, blocked.id, 'blocked')

    for (const agent of ['a1', 'a2']) {
      expect(getSetting(db, taskSessionSettingKey(agent, TEAM, done.id))).toBeNull()
      expect(getSetting(db, taskSessionSettingKey(agent, TEAM, cancelled.id))).toBeNull()
      // Blocked waits on a person; its next run resumes the same session.
      expect(getSetting(db, taskSessionSettingKey(agent, TEAM, blocked.id))).toBe(pointer)
    }
  })
})

describe('saved wakes reach the pump within seconds', () => {
  let home: string
  const prev: Record<string, string | undefined> = {}
  let wakePasses = 0

  beforeEach(async () => {
    home = await mkdtemp(path.join(os.tmpdir(), 'clawboo-lifecycle-wakes-'))
    for (const k of ['HOME', 'CLAWBOO_HOME']) prev[k] = process.env[k]
    process.env['HOME'] = home
    process.env['CLAWBOO_HOME'] = path.join(home, '.clawboo')
    expect(getDbPath().startsWith(home)).toBe(true)
    wakePasses = 0
    const now = Date.now()
    getDb()
      .insert(teams)
      .values({
        id: TEAM,
        name: 'Team T',
        icon: 'x',
        color: '#e94560',
        leaderAgentId: LEADER,
        createdAt: now,
        updatedAt: now,
      })
      .run()
    registerBoardLifecycleSubscribers({
      mcpBaseUrl: null,
      pumpWakes: () => {
        wakePasses += 1
      },
    })
  })
  afterEach(async () => {
    resetBoardLifecycleRegistration()
    resetBoardLifecycleListeners()
    resetDb()
    for (const [k, v] of Object.entries(prev)) {
      if (v === undefined) delete process.env[k]
      else process.env[k] = v
    }
    await rm(home, { recursive: true, force: true })
  })

  const blockerAndDependent = () => {
    const db = getDb()
    const blocker = createTask(db, { title: 'first', teamId: TEAM })
    const dependent = createTask(db, {
      title: 'next',
      teamId: TEAM,
      sourceDelegationId: 'r1:deleg:agent:a2:reflectTo:leader',
    })
    linkDep(db, dependent.id, blocker.id)
    claimTask(db, blocker.id, 'a9')
    return { blocker, dependent }
  }

  it('a dependency finished in this process (the HTTP Tasks MCP, the engine, a person) wakes its dependent', async () => {
    vi.useFakeTimers()
    try {
      const { blocker, dependent } = blockerAndDependent()
      updateStatus(getDb(), blocker.id, 'done')
      expect(listWaitingTaskWakes(getDb()).map((w) => w.taskId)).toEqual([dependent.id])
      await vi.advanceTimersByTimeAsync(2_000)
      expect(wakePasses).toBe(1)
      const recorded = listEvents(getDb(), { kinds: ['task_wake_recorded'] })
      expect(recorded.map((e) => e.taskId)).toEqual([dependent.id])
    } finally {
      vi.useRealTimers()
    }
  })

  it('one finished by a stdio bin, which the bus does not reach, saves the wake for the next pump pass', async () => {
    vi.useFakeTimers()
    try {
      const { blocker, dependent } = blockerAndDependent()
      // A stdio bin is another process: the server's subscribers never hear its write.
      resetBoardLifecycleListeners()
      updateStatus(getDb(), blocker.id, 'done')
      await vi.advanceTimersByTimeAsync(10_000)
      expect(wakePasses).toBe(0)
      expect(listWaitingTaskWakes(getDb()).map((w) => w.taskId)).toEqual([dependent.id])
    } finally {
      vi.useRealTimers()
    }
  })

  it('a burst of wakes is one pass', async () => {
    vi.useFakeTimers()
    try {
      const db = getDb()
      for (let i = 0; i < 5; i++) {
        const t = createTask(db, { title: `t${i}`, teamId: TEAM })
        recordTaskWake(db, { teamId: TEAM, agentId: 'a2', taskId: t.id, reason: 'person_comment' })
      }
      await vi.advanceTimersByTimeAsync(2_000)
      expect(wakePasses).toBe(1)
    } finally {
      vi.useRealTimers()
    }
  })

  it('a task released with no progress on its last runs says it waits, once', async () => {
    const db = getDb()
    const t = createTask(db, {
      title: 'flaky',
      teamId: TEAM,
      sourceDelegationId: 'r1:deleg:agent:a2:reflectTo:leader',
    })
    for (let i = 0; i < 2; i++) {
      const c = claimTask(db, t.id, 'a2', 'codex', { run: { executorType: 'openclaw' } })
      expect(c.ok).toBe(true)
      db.update(tasks).set({ updatedAt: 1 }).where(eq(tasks.id, t.id)).run()
      expect(reconcileStaleInProgress(db, 1_000).reconciled).toBe(1)
    }
    const notes = getComments(db, t.id).filter((c) => c.body.includes('made no visible progress'))
    expect(notes).toHaveLength(1)
    expect(notes[0]!.kind).toBe('note')
    expect(listEvents(db, { kinds: ['task_braked'] })).toHaveLength(1)
  })
})
