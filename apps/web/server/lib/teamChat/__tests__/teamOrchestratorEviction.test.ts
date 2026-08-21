// Idle-TTL eviction of the per-team server orchestrator.
//
// The regression this locks down: the instance's idle clock used to advance ONLY
// on a USER message, and the eviction scan disposed on age alone. So kicking off
// a long cascade and walking away — the product's whole premise — got every
// in-flight delegate aborted at the 30-minute mark, the engine reset before their
// terminals landed (so no release, no reflection), and nobody told. Eviction is
// now gated on QUIESCENCE: an instance with a run in flight is never evicted, no
// matter how long the human has been gone.

import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { agents, teams, type ClawbooDb } from '@clawboo/db'

import { getDb, resetDb } from '../../db'
import {
  evictIdleOrchestrators,
  getTeamOrchestrator,
  hasTeamOrchestrator,
  resetTeamOrchestrators,
  shouldEvictInstance,
} from '../teamOrchestrator'

const IDLE_TTL_MS = 30 * 60_000
const HARD_TTL_MS = 4 * IDLE_TTL_MS

describe('shouldEvictInstance (eviction policy)', () => {
  it('keeps anything under the idle TTL, busy or not', () => {
    expect(shouldEvictInstance(IDLE_TTL_MS, true)).toBe(false)
    expect(shouldEvictInstance(IDLE_TTL_MS, false)).toBe(false)
    expect(shouldEvictInstance(0, true)).toBe(false)
  })

  it('evicts an abandoned QUIESCENT instance past the TTL (normal reclaim)', () => {
    expect(shouldEvictInstance(IDLE_TTL_MS + 1, true)).toBe(true)
  })

  it('SPARES a busy instance past the TTL — the walked-away-from cascade', () => {
    // The regression this exists for: a long cascade used to be disposed here,
    // aborting every delegate mid-work with nobody told.
    expect(shouldEvictInstance(IDLE_TTL_MS + 1, false)).toBe(false)
    expect(shouldEvictInstance(HARD_TTL_MS, false)).toBe(false)
  })

  it('still reaps a busy instance past the HARD ceiling — a hung run cannot pin it forever', () => {
    // A run that hangs without emitting a terminal keeps its abort-map entry, so
    // `quiescent` stays false; without this ceiling the orchestrator would be
    // immortal. Total silence for HARD_TTL_MS is not something a live run does.
    expect(shouldEvictInstance(HARD_TTL_MS + 1, false)).toBe(true)
  })
})

describe('teamOrchestrator idle eviction', () => {
  let home: string
  let prevHome: string | undefined
  let db: ClawbooDb

  beforeEach(async () => {
    home = await mkdtemp(path.join(os.tmpdir(), 'clawboo-evict-'))
    await mkdir(path.join(home, '.clawboo'), { recursive: true })
    prevHome = process.env['HOME']
    process.env['HOME'] = home
    db = getDb()
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
    // Order matters. `resetTeamOrchestrators` first, because an orchestrator
    // instance holds the connection `getTeamOrchestrator` opened through the
    // `getDb()` memo; then `resetDb()` closes it. Both must happen BEFORE the
    // dir is removed: Windows refuses to remove a directory that still holds an
    // open file. (#140)
    resetTeamOrchestrators()
    resetDb()
    if (prevHome === undefined) delete process.env['HOME']
    else process.env['HOME'] = prevHome
    await rm(home, { recursive: true, force: true })
  })

  it('keeps a freshly-touched instance', () => {
    getTeamOrchestrator('T')
    expect(hasTeamOrchestrator('T')).toBe(true)
    expect(evictIdleOrchestrators(Date.now())).toBe(0)
    expect(hasTeamOrchestrator('T')).toBe(true)
  })

  it('evicts an abandoned, quiescent instance past the TTL', () => {
    getTeamOrchestrator('T')
    // No run was ever started, so the instance is quiescent: eviction is correct
    // here — this is the reclaim path the TTL exists for, and it must still work.
    expect(evictIdleOrchestrators(Date.now() + IDLE_TTL_MS + 1)).toBe(1)
    expect(hasTeamOrchestrator('T')).toBe(false)
  })

  it('does not evict exactly at the TTL boundary (strictly greater)', () => {
    // Anchor the clock BEFORE construction. `getTeamOrchestrator` stamps
    // lastActivityAt inside it, so reading Date.now() afterwards races the
    // stamp: one elapsed millisecond (routine under CI coverage load) makes the
    // delta strictly greater than the TTL and the eviction is CORRECT, failing
    // the test. With t0 <= lastActivityAt, t0 + TTL is always at-or-before the
    // boundary, which is exactly the property under test.
    const t0 = Date.now()
    getTeamOrchestrator('T')
    expect(evictIdleOrchestrators(t0 + IDLE_TTL_MS)).toBe(0)
    expect(hasTeamOrchestrator('T')).toBe(true)
  })

  it('a later call rebuilds the instance after eviction', () => {
    const first = getTeamOrchestrator('T')
    evictIdleOrchestrators(Date.now() + IDLE_TTL_MS + 1)
    expect(hasTeamOrchestrator('T')).toBe(false)
    const second = getTeamOrchestrator('T')
    expect(hasTeamOrchestrator('T')).toBe(true)
    expect(second).not.toBe(first)
  })
})
