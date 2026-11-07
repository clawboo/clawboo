// A work check in flight keeps a team's orchestrator from being unloaded as
// idle. While a team-chat task's work is checked no run is open (its run already
// ended), so the run map alone reads the instance as quiet, and unloading it
// would drop the check's result. The engine here is the real one, with only its
// check count overridden, so the instance is busy for the true reason and its
// run map stays empty.

import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { agents, teams } from '@clawboo/db'

const checks = { inFlight: 0 }

vi.mock('@clawboo/team-orchestration', async (importOriginal) => {
  const real = await importOriginal<typeof import('@clawboo/team-orchestration')>()
  return {
    ...real,
    createBoardOrchestrator: (deps: Parameters<typeof real.createBoardOrchestrator>[0]) => ({
      ...real.createBoardOrchestrator(deps),
      checksInFlight: () => checks.inFlight,
    }),
  }
})

const { engineHoldState } = await import('../../../api/systemHold')
const { getDb, resetDb } = await import('../../db')
const { evictIdleOrchestrators, getTeamOrchestrator, hasTeamOrchestrator, resetTeamOrchestrators } =
  await import('../teamOrchestrator')

const IDLE_TTL_MS = 30 * 60_000

describe('eviction scan: a work check in flight', () => {
  let home: string
  const prev: Record<string, string | undefined> = {}

  beforeEach(async () => {
    home = await mkdtemp(path.join(os.tmpdir(), 'clawboo-check-quiesce-'))
    await mkdir(path.join(home, '.clawboo'), { recursive: true })
    for (const k of ['HOME', 'CLAWBOO_HOME']) prev[k] = process.env[k]
    process.env['HOME'] = home
    process.env['CLAWBOO_HOME'] = path.join(home, '.clawboo')
    const db = getDb()
    const now = Date.now()
    db.insert(teams)
      .values({
        id: 'T',
        name: 'Team T',
        icon: '🚀',
        color: '#e94560',
        createdAt: now,
        updatedAt: now,
      })
      .run()
    db.insert(agents)
      .values({
        id: 'lead',
        name: 'Lead',
        gatewayId: 'lead',
        runtime: 'clawboo-native',
        teamId: 'T',
        createdAt: now,
        updatedAt: now,
      })
      .run()
  })

  afterEach(async () => {
    checks.inFlight = 0
    resetTeamOrchestrators()
    resetDb()
    for (const [k, v] of Object.entries(prev)) {
      if (v === undefined) delete process.env[k]
      else process.env[k] = v
    }
    await rm(home, { recursive: true, force: true })
  })

  it('counts as background work, so a drain waits for it', () => {
    getTeamOrchestrator('T')
    expect(engineHoldState().backgroundWork).toBe('none')
    checks.inFlight = 1
    expect(engineHoldState().backgroundWork).toBe('present')
    checks.inFlight = 0
    expect(engineHoldState().backgroundWork).toBe('none')
  })

  it('spares an instance checking work past the idle TTL, and unloads it once the check is over', () => {
    const t0 = Date.now()
    getTeamOrchestrator('T')
    checks.inFlight = 1
    expect(evictIdleOrchestrators(t0 + IDLE_TTL_MS + 60_000)).toBe(0)
    expect(hasTeamOrchestrator('T')).toBe(true)

    checks.inFlight = 0
    expect(evictIdleOrchestrators(t0 + IDLE_TTL_MS + 60_000)).toBe(1)
    expect(hasTeamOrchestrator('T')).toBe(false)
  })
})
