// The run primitive's two production-only wiring points, in their own file.
//
// Every serverDeliver and engine test builds its own deps, so none of them can
// see what `buildInstance` actually hands over. Two of those deps carry the leak
// fixes: `stopGen`, which the start gate reads so a delivery made before a Stop
// never starts after it, and the RunStamp that `onEvent` must forward to the
// engine, which is how a follow-up reaches its task card and how a run delivered
// before a Stop is kept from starting new work. Dropping either compiles and
// leaves every other suite green. So does dropping `execForSession`, which names
// the execution row a task run records its cost on.
//
// Faking the deliver factory captures the deps the real orchestrator passes, and
// the real engine and DB sit behind them. This lives in a SEPARATE file because
// `vi.mock` is file-global (see teamOrchestratorQuiescence.test.ts).

import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { encodeHumanAssignment } from '@clawboo/board-core'
import { agents, createTask, getComments, listExecutions, listTasks, teams } from '@clawboo/db'
import type { RuntimeEvent } from '@clawboo/executor'

import type { ServerDeliverDeps } from '../serverDeliver'

const captured = vi.hoisted(() => ({ deps: null as ServerDeliverDeps | null }))

vi.mock('../serverDeliver', () => ({
  // Keep the deps the orchestrator wires, and deliver to nobody.
  createServerDeliver: (deps: ServerDeliverDeps) => {
    captured.deps = deps
    return async () => undefined
  },
}))

const { getDb, resetDb } = await import('../../db')
const { getTeamOrchestrator, resetTeamOrchestrators } = await import('../teamOrchestrator')

const done = (summary: string, runId: string): RuntimeEvent => ({
  kind: 'done',
  reason: 'success',
  summary,
  runId,
  sessionId: runId,
  ts: 1,
  seq: 1,
})
const flush = async (): Promise<void> => {
  for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r))
}

describe('team orchestrator: the run primitive wiring', () => {
  let home: string
  let prevHome: string | undefined

  beforeEach(async () => {
    captured.deps = null
    home = await mkdtemp(path.join(os.tmpdir(), 'clawboo-deliver-wiring-'))
    await mkdir(path.join(home, '.clawboo'), { recursive: true })
    prevHome = process.env['HOME']
    process.env['HOME'] = home
    const db = getDb()
    const now = Date.now()
    db.insert(teams)
      .values({
        id: 'T',
        name: 'Team T',
        icon: '🚀',
        color: '#e94560',
        leaderAgentId: 'L',
        createdAt: now,
        updatedAt: now,
      })
      .run()
    // Coding-runtime members, so no native Boo Zero is created to take the lead.
    db.insert(agents)
      .values([
        {
          id: 'L',
          name: 'Lead',
          gatewayId: 'L',
          runtime: 'codex',
          teamId: 'T',
          createdAt: now,
          updatedAt: now,
        },
        {
          id: 'W',
          name: 'Coder',
          gatewayId: 'W',
          runtime: 'codex',
          teamId: 'T',
          createdAt: now,
          updatedAt: now,
        },
      ])
      .run()
  })

  afterEach(async () => {
    resetTeamOrchestrators()
    // The engine's reset flushes the follow-up's pending [Task Update] to the
    // lead, which reads the board. Let it finish before the DB closes.
    await flush()
    resetDb()
    if (prevHome === undefined) delete process.env['HOME']
    else process.env['HOME'] = prevHome
    await rm(home, { recursive: true, force: true })
  })

  it('the Stop generation follows stop(), and the run stamp reaches the real engine', async () => {
    const db = getDb()
    // W's closed task, delegated by the lead. W handed part of it on before it
    // closed, so W's report on that part is a follow-up on this task.
    const t1 = createTask(db, {
      title: 'Parse the CSV',
      teamId: 'T',
      status: 'done',
      sourceDelegationId: 'r0:deleg:agent:W:reflectTo:L',
    })
    const orchestrator = getTeamOrchestrator('T')
    await orchestrator.pump()
    const deps = captured.deps!
    expect(deps.stopGen()).toBe(0)

    // A follow-up's terminal, stamped for T1, is recorded on T1's card.
    await deps.onEvent('agent:W:team:T', done('follow-up text', 'run-1'), {
      reportForTaskId: t1.id,
      stopGen: 0,
    })
    expect(
      getComments(db, t1.id)
        .map((c) => c.body)
        .join('\n'),
    ).toContain('follow-up text')

    orchestrator.stop()
    expect(deps.stopGen()).toBe(1)
    await flush() // let the Stop's durable markers land

    // A run delivered before the Stop starts no new work after it...
    const delegation = '<delegate to="@Coder">x</delegate>'
    const before = listTasks(db, { teamId: 'T' }).length
    await deps.onEvent('agent:L:team:T', done(delegation, 'run-2'), {
      reportForTaskId: null,
      stopGen: 0,
    })
    await flush()
    expect(listTasks(db, { teamId: 'T' })).toHaveLength(before)

    // ...while one delivered after it still does.
    await deps.onEvent('agent:L:team:T', done(delegation, 'run-3'), {
      reportForTaskId: null,
      stopGen: 1,
    })
    await flush()
    expect(listTasks(db, { teamId: 'T' })).toHaveLength(before + 1)
  })

  it("the run's execution row reaches the run primitive, which records its cost there", async () => {
    const db = getDb()
    const t = createTask(db, {
      title: 'Write the tests',
      teamId: 'T',
      status: 'todo',
      sourceDelegationId: encodeHumanAssignment('W', 'n1'),
    })
    const orchestrator = getTeamOrchestrator('T')
    await orchestrator.dispatchTask(t.id)
    await flush()
    const deps = captured.deps!
    const ledger = listExecutions(db, t.id)
    expect(ledger).toHaveLength(1)
    expect(deps.execForSession('agent:W:team:T')).toBe(ledger[0]!.id)
    expect(deps.execForSession('agent:L:team:T')).toBeNull()
  })
})
