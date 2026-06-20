import { mkdtempSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { createDb, type ClawbooDb } from '../../db'
import { appendAudit, listGovernanceAudit } from '../audit'

let dir: string
let db: ClawbooDb

beforeEach(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), 'clawboo-audit-'))
  db = createDb(path.join(dir, 'test.db'))
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

describe('governance audit (append-only, scrubbed)', () => {
  it('scrubs secret-looking keys/values before storage', () => {
    appendAudit(db, {
      eventType: 'tool_call',
      agentId: 'a1',
      summary: { apiKey: 'sk-livesecretvalue1234567', note: 'ran ok' },
    })
    const rows = listGovernanceAudit(db, { agentId: 'a1' })
    expect(rows).toHaveLength(1)
    expect(rows[0]?.summary).not.toContain('sk-livesecretvalue')
    expect(rows[0]?.summary).toContain('[REDACTED]')
    expect(rows[0]?.summary).toContain('ran ok')
  })

  it('filters by agentId + eventType and is queryable by (agentId, ts)', () => {
    appendAudit(db, {
      eventType: 'budget',
      agentId: 'a1',
      taskId: 'task1',
      summary: { reason: 'auto_pause' },
    })
    appendAudit(db, { eventType: 'install', agentId: 'a2', summary: { name: 'skill' } })
    appendAudit(db, { eventType: 'cap_hit', agentId: 'a1', summary: { kind: 'fanout' } })
    expect(listGovernanceAudit(db, { agentId: 'a1' })).toHaveLength(2)
    expect(listGovernanceAudit(db, { eventType: 'install' })).toHaveLength(1)
    expect(listGovernanceAudit(db).length).toBeGreaterThanOrEqual(3)
  })
})
