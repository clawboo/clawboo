import { mkdtempSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { createDb, recordSpend, setBudgetLimit, type ClawbooDb } from '@clawboo/db'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { budgetPreflight } from '../budgetPreflight'

let dir: string
let db: ClawbooDb
beforeEach(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), 'clawboo-preflight-'))
  db = createDb(path.join(dir, 'test.db'))
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

describe('budgetPreflight', () => {
  it('does not block when no budget rows exist (uncapped)', () => {
    expect(budgetPreflight(db, { agentId: 'a', teamId: 't' })).toEqual({ blocked: false })
  })

  it('does not block an active cap budget', () => {
    setBudgetLimit(db, { scope: 'team', scopeId: 't', limitUsdCents: 100, mode: 'cap' })
    expect(budgetPreflight(db, { teamId: 't' }).blocked).toBe(false)
  })

  it('blocks a paused cap budget and reports the scope', () => {
    setBudgetLimit(db, { scope: 'team', scopeId: 't', limitUsdCents: 100, mode: 'cap' })
    recordSpend(db, 'team', 't', 150) // over the cap → paused
    expect(budgetPreflight(db, { teamId: 't' })).toEqual({ blocked: true, scope: 'team' })
  })

  it('never blocks a WARN budget, even over its limit', () => {
    setBudgetLimit(db, { scope: 'team', scopeId: 't', limitUsdCents: 100, mode: 'warn' })
    recordSpend(db, 'team', 't', 500) // a warn budget never reads paused
    expect(budgetPreflight(db, { teamId: 't' }).blocked).toBe(false)
  })

  it('checks most-specific first (agent before team)', () => {
    setBudgetLimit(db, { scope: 'agent', scopeId: 'a', limitUsdCents: 10, mode: 'cap' })
    recordSpend(db, 'agent', 'a', 50)
    setBudgetLimit(db, { scope: 'team', scopeId: 't', limitUsdCents: 10, mode: 'cap' })
    recordSpend(db, 'team', 't', 50)
    expect(budgetPreflight(db, { agentId: 'a', teamId: 't' })).toEqual({
      blocked: true,
      scope: 'agent',
    })
  })
})
