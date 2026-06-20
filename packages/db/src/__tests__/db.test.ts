// The CREATE TABLE IF NOT EXISTS bootstrap is the SOLE schema source — there is
// no in-place ALTER migration ladder (hard reset on schema change; no users).
// These PRAGMA assertions are the standing guard that the CREATE DDL stays
// complete: every column that the (now-deleted) forward-only ALTERs used to add
// must be present on a fresh in-memory DB.

import { sql } from 'drizzle-orm'
import { describe, expect, it } from 'vitest'

import { createDb, listTableNames, type ClawbooDb } from '../db'

function columns(db: ClawbooDb, table: string): string[] {
  const rows = db.all(sql`PRAGMA table_info(${sql.raw(table)})`) as Array<{ name: string }>
  return rows.map((r) => r.name)
}

describe('createDb — CREATE DDL is the complete bootstrap', () => {
  it('a fresh in-memory DB has every column the old ALTER ladder added', () => {
    const db = createDb(':memory:')
    expect(columns(db, 'agents')).toEqual(
      expect.arrayContaining([
        'team_id',
        'exec_config',
        'source_id',
        'source_agent_id',
        'identity_json',
        'participant_kind',
        'runtime',
        'capabilities',
        'tenant_id',
        'archived_at',
      ]),
    )
    expect(columns(db, 'teams')).toEqual(
      expect.arrayContaining([
        'is_archived',
        'leader_agent_id',
        'tenant_id',
        'color_collection_id',
      ]),
    )
    expect(columns(db, 'tasks')).toEqual(expect.arrayContaining(['verification', 'scheduled_by']))
    expect(columns(db, 'tool_call_approvals')).toContain('task_id')
    expect(columns(db, 'budgets')).toContain('mode')
    expect(columns(db, 'sessions')).toEqual(
      expect.arrayContaining(['parent_session_id', 'runtime']),
    )
  })

  it('bootstraps the core tables on a fresh path', () => {
    const names = new Set(listTableNames(createDb(':memory:')))
    for (const t of ['teams', 'agents', 'sessions', 'budgets', 'tasks', 'tool_call_approvals']) {
      expect(names.has(t)).toBe(true)
    }
  })
})
