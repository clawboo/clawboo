import { mkdtempSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { createDb, type ClawbooDb } from '../../db'
import { createApproval, resolveApproval } from '../../tools/persistence'
import { priorAllowAlways } from '../approvalScope'

let dir: string
let db: ClawbooDb

beforeEach(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), 'clawboo-approvalscope-'))
  db = createDb(path.join(dir, 'test.db'))
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

describe('priorAllowAlways (sticky delegation approval)', () => {
  it('detects a prior allow_always for the same agent + scope key only', () => {
    const a = createApproval(db, { toolName: 'delegate:code', agentId: 'leader1', args: {} })
    resolveApproval(db, a.id, 'allow_always')
    expect(priorAllowAlways(db, { agentId: 'leader1', scopeKey: 'delegate:code' })).toBe(true)
    expect(priorAllowAlways(db, { agentId: 'leader1', scopeKey: 'delegate:research' })).toBe(false)
    expect(priorAllowAlways(db, { agentId: 'other', scopeKey: 'delegate:code' })).toBe(false)
  })

  it('an allow_once does not count as sticky', () => {
    const a = createApproval(db, { toolName: 'delegate:code', agentId: 'leader2', args: {} })
    resolveApproval(db, a.id, 'allow_once')
    expect(priorAllowAlways(db, { agentId: 'leader2', scopeKey: 'delegate:code' })).toBe(false)
  })
})
