// Opening the database clears remembered approvals saved before an Always
// could cover an external change, once, the way it retires fleet-wide grants.

import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { createDb, listStandingRules, mintStandingRule, upsertGrant } from '@clawboo/db'
import { afterEach, beforeEach, expect, it } from 'vitest'

import { getDb, getDbPath, resetDb } from '../db'

let home: string

beforeEach(() => {
  home = mkdtempSync(path.join(os.tmpdir(), 'clawboo-boot-rules-'))
  process.env['CLAWBOO_HOME'] = home
  mkdirSync(home, { recursive: true })
})
afterEach(() => {
  resetDb()
  delete process.env['CLAWBOO_HOME']
  rmSync(home, { recursive: true, force: true })
})

it('clears allow rules an older version saved, on the first open', () => {
  // The database as an older version left it: an Always on a Playwright click.
  const old = createDb(getDbPath())
  const grantId = upsertGrant(old, {
    subjectKind: 'agent',
    subjectId: 'a1',
    capabilityKind: 'connector',
    connectorId: 'conn:connector:clawboo:mcp:playwright',
    capabilityId: null,
    mode: 'admin',
    approvalPolicy: 'risk',
  }).id
  mintStandingRule(old, {
    grantId,
    toolName: 'mcp__playwright__browser_click',
    argsShape: null,
    decision: 'allow',
    expiresAt: Date.now() + 60_000,
  })
  old.$client.close()

  expect(listStandingRules(getDb(), grantId)).toEqual([])
})
