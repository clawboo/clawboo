// The eviction scan's QUIESCENCE wiring, in its own file.
//
// `teamOrchestratorEviction.test.ts` covers the pure policy (`shouldEvictInstance`)
// and the scan over quiescent instances. What it cannot cover is the wiring: every
// instance it builds has never started a run, so `inst.isQuiescent()` is always
// true and hardcoding `shouldEvictInstance(idle, true)` in the scan leaves all of
// it green. That mutant is exactly the regression the gate exists to prevent, so
// it needs a genuinely BUSY instance.
//
// Busy-ness here is real, not stubbed: `buildInstance` hands its `abortMap` to
// `createServerDeliver`, and `isQuiescent` is `abortMap.size === 0`. Faking the
// deliver factory lets the test put a live entry in that same map through the
// production path, so the instance is non-quiescent for the true reason.
//
// This lives in a SEPARATE file because `vi.mock` is file-global: mocking
// serverDeliver inside the eviction suite would break its three tests that need a
// real, quiescent instance.

import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { agents, teams } from '@clawboo/db'

vi.mock('../serverDeliver', () => ({
  // Register a run in the instance's own abort map at construction, so the
  // instance reports itself busy exactly as a live delegate would.
  createServerDeliver: (deps: {
    abortMap: Map<string, { adapter: { abort: () => Promise<void> }; run: unknown }>
  }) => {
    deps.abortMap.set('agent:lead:team:T', {
      adapter: { abort: async () => undefined },
      run: { id: 'run-1' },
    })
    return async () => undefined
  },
}))

const { getDb, resetDb } = await import('../../db')
const { evictIdleOrchestrators, getTeamOrchestrator, hasTeamOrchestrator, resetTeamOrchestrators } =
  await import('../teamOrchestrator')

const IDLE_TTL_MS = 30 * 60_000
const HARD_TTL_MS = 4 * IDLE_TTL_MS

describe('eviction scan — quiescence wiring', () => {
  let home: string
  let prevHome: string | undefined

  beforeEach(async () => {
    home = await mkdtemp(path.join(os.tmpdir(), 'clawboo-quiesce-'))
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
    resetTeamOrchestrators()
    resetDb()
    if (prevHome === undefined) delete process.env['HOME']
    else process.env['HOME'] = prevHome
    await rm(home, { recursive: true, force: true })
  })

  it('SPARES a busy instance past the idle TTL — the walked-away-from cascade', () => {
    // Anchor the clock BEFORE the instance exists: its lastActivity is stamped
    // during construction, so a later `Date.now() + HARD_TTL_MS` sits a few ms
    // PAST the ceiling and the at-the-boundary assertion flakes.
    const t0 = Date.now()
    getTeamOrchestrator('T')
    expect(hasTeamOrchestrator('T')).toBe(true)
    // Well past the idle TTL, and still not evicted: the run in flight wins.
    expect(evictIdleOrchestrators(t0 + IDLE_TTL_MS + 1)).toBe(0)
    expect(evictIdleOrchestrators(t0 + HARD_TTL_MS)).toBe(0)
    expect(hasTeamOrchestrator('T')).toBe(true)
  })

  it('still reaps a busy instance past the HARD ceiling', () => {
    getTeamOrchestrator('T')
    // A run that never reports a terminal keeps its abort-map entry forever, so
    // without this ceiling the instance would be immortal.
    expect(evictIdleOrchestrators(Date.now() + HARD_TTL_MS + 1)).toBe(1)
    expect(hasTeamOrchestrator('T')).toBe(false)
  })
})
