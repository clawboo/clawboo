// The team orchestrator's wiring for runs waiting on the process's run cap, in its
// own file because `vi.mock` is file-global.
//
// `serverDeliverRunCap.test.ts` drives the real deliver primitive and engine with a
// harness that mirrors `buildInstance`. This one drives `buildInstance` itself, with
// a deliver that behaves like a delivery queued for a slot: it registers in the
// instance's own `queuedRuns` map and settles at once. So the assertions hold for
// the production wiring, not a copy of it: the idle watchdog leaves a queued run
// alone, the instance is not evicted while one waits, and Stop, a person's move
// and teardown each take it out of the queue.

import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { encodeHumanAssignment } from '@clawboo/board-core'
import { agents, createTask, getTask, teams } from '@clawboo/db'

const queued = vi.hoisted(() => ({
  map: null as Map<string, { cancel(): void }> | null,
  cancelled: [] as string[],
}))

vi.mock('../serverDeliver', () => ({
  createServerDeliver: (deps: { queuedRuns: Map<string, { cancel(): void }> }) => {
    queued.map = deps.queuedRuns
    // Every slot is taken: the delivery waits in the queue and settles at once.
    return async (sessionKey: string) => {
      deps.queuedRuns.set(sessionKey, {
        cancel: () => {
          queued.cancelled.push(sessionKey)
          deps.queuedRuns.delete(sessionKey)
        },
      })
    }
  },
}))

const { getDb, resetDb } = await import('../../db')
const { evictIdleOrchestrators, getTeamOrchestrator, hasTeamOrchestrator, resetTeamOrchestrators } =
  await import('../teamOrchestrator')

const IDLE_TTL_MS = 30 * 60_000
const MINUTE = 60_000
const leadSession = 'agent:lead:team:T'

describe('team orchestrator × the run queue', () => {
  let home: string
  let prevHome: string | undefined

  beforeEach(async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'setInterval', 'Date'] })
    home = await mkdtemp(path.join(os.tmpdir(), 'clawboo-run-queue-'))
    await mkdir(path.join(home, '.clawboo'), { recursive: true })
    prevHome = process.env['HOME']
    process.env['HOME'] = home
    queued.map = null
    queued.cancelled = []
    const db = getDb()
    const now = Date.now()
    db.insert(teams)
      .values({ id: 'T', name: 'Team T', icon: 'x', color: '#000', createdAt: now, updatedAt: now })
      .run()
    db.insert(agents)
      .values({
        id: 'lead',
        name: 'Lead',
        gatewayId: 'lead',
        runtime: 'claude-code',
        teamId: 'T',
        createdAt: now,
        updatedAt: now,
      })
      .run()
  })

  afterEach(async () => {
    resetTeamOrchestrators()
    resetDb()
    vi.useRealTimers()
    if (prevHome === undefined) delete process.env['HOME']
    else process.env['HOME'] = prevHome
    await rm(home, { recursive: true, force: true })
  })

  /** A task a person assigned to the lead, dispatched now; its delivery queues. */
  async function dispatchQueued(): Promise<string> {
    // Built first, so its opening resume has nothing ready to fire on its own.
    const orchestrator = getTeamOrchestrator('T')
    await orchestrator.pump()
    const task = createTask(getDb(), {
      title: 'write the report',
      status: 'todo',
      teamId: 'T',
      sourceDelegationId: encodeHumanAssignment('lead', 'n1'),
    })
    expect(await orchestrator.dispatchTask(task.id)).toBe('started')
    expect(queued.map?.has(leadSession)).toBe(true)
    return task.id
  }

  it('the idle watchdog leaves a queued run alone, then times it once it has started', async () => {
    const taskId = await dispatchQueued()
    // Forty minutes in the queue, swept every 30 seconds by the instance's interval.
    await vi.advanceTimersByTimeAsync(40 * MINUTE)
    expect(getTask(getDb(), taskId)?.status).toBe('in_progress')

    // The run starts (it leaves the queue) and goes silent: now the window applies.
    queued.map!.delete(leadSession)
    await vi.advanceTimersByTimeAsync(9 * MINUTE)
    expect(getTask(getDb(), taskId)?.status).toBe('blocked')
  })

  it('keeps the instance while a run waits for a slot, past the idle TTL', async () => {
    await dispatchQueued()
    await vi.advanceTimersByTimeAsync(IDLE_TTL_MS + 5 * MINUTE)
    expect(evictIdleOrchestrators(Date.now())).toBe(0)
    expect(hasTeamOrchestrator('T')).toBe(true)
  })

  it('Stop takes a queued run out of the queue', async () => {
    await dispatchQueued()
    getTeamOrchestrator('T').stop()
    expect(queued.cancelled).toEqual([leadSession])
  })

  it("a person moving a queued run's card takes it out of the queue", async () => {
    const taskId = await dispatchQueued()
    await getTeamOrchestrator('T').personMovedTask(taskId, 'done')
    expect(queued.cancelled).toEqual([leadSession])
  })

  it('teardown takes a queued run out of the queue', async () => {
    await dispatchQueued()
    resetTeamOrchestrators()
    expect(queued.cancelled).toEqual([leadSession])
  })
})
