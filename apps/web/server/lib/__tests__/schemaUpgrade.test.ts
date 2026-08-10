// Standing guard for the in-place upgrade: starting this server against a
// `clawboo.db` written by an OLDER release must reach a working state, keeping the
// data in it, rather than booting clean and then failing on the first query that
// touches a column the old file never had.
//
// The half in packages/db proves the reconciler in isolation. This half proves the
// wiring: that the server's own boot path (`getDb()` → `ensureSchema`) is what
// applies it, against a real file under a real CLAWBOO_HOME, and that the boot
// probe agrees afterwards.
//
// The "older database" is synthesised by taking a current one, putting rows in it,
// and removing what a later release would have added. Rows are the point: SQLite's
// ADD COLUMN guards are row-dependent, so an empty fixture would pass while a real
// user's populated file failed.

import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { agents, ensureSchema, missingSchemaColumns, openDb, teams } from '@clawboo/db'
import { eq } from 'drizzle-orm'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { runBootProbe } from '../bootProbe'
import { getDb, getDbPath, resetDb } from '../db'

let home: string
let prevHome: string | undefined

const NOW = 1_700_000_000_000

/** Write a database at the server's path that looks like an older release wrote it. */
function seedOlderDatabase(): void {
  const db = openDb(getDbPath())
  ensureSchema(db)

  db.insert(teams)
    .values({
      id: 't1',
      name: 'Launch',
      icon: 'rocket',
      color: '#dc2a48',
      isArchived: 0,
      createdAt: NOW,
      updatedAt: NOW,
    })
    .run()
  db.insert(agents)
    .values({
      id: 'a1',
      name: 'Boo Zero',
      gatewayId: 'g1',
      teamId: 't1',
      status: 'idle',
      sourceId: 'clawboo-native',
      participantKind: 'agent',
      runtime: 'clawboo-native',
      createdAt: NOW,
      updatedAt: NOW,
    })
    .run()

  // Roll the file back to an older shape: a column plus the index over it. The
  // index has to go first: SQLite refuses to drop a column an index depends on,
  // which is exactly why the reconcile has to run BEFORE the CREATE INDEX batch.
  db.$client.prepare('DROP INDEX idx_agents_team_id').run()
  db.$client.prepare('ALTER TABLE agents DROP COLUMN team_id').run()
  db.$client.prepare('ALTER TABLE agents DROP COLUMN capabilities').run()
  db.$client.prepare('ALTER TABLE budgets DROP COLUMN mode').run()

  db.$client.close()
}

beforeEach(async () => {
  home = await mkdtemp(path.join(os.tmpdir(), 'clawboo-schema-upgrade-'))
  prevHome = process.env['CLAWBOO_HOME']
  process.env['CLAWBOO_HOME'] = home
  resetDb()
})

afterEach(async () => {
  resetDb()
  if (prevHome === undefined) delete process.env['CLAWBOO_HOME']
  else process.env['CLAWBOO_HOME'] = prevHome
  await rm(home, { recursive: true, force: true }).catch(() => {})
})

describe('opening an older clawboo.db reaches a working state', () => {
  it('adds the missing columns, restores their indexes and keeps the rows', () => {
    seedOlderDatabase()

    const db = getDb()

    expect(missingSchemaColumns(db)).toEqual([])
    // The query that would have failed at runtime before: `team_id` is selected by
    // every typed read of an agent.
    const agent = db.select().from(agents).where(eq(agents.id, 'a1')).get()
    expect(agent?.name).toBe('Boo Zero')
    expect(agent?.teamId).toBeNull()
    expect(db.select().from(teams).all()).toHaveLength(1)
    // The index that could only be created after the column came back.
    const idx = db.$client
      .prepare(`SELECT name FROM sqlite_master WHERE type='index' AND name='idx_agents_team_id'`)
      .all()
    expect(idx).toHaveLength(1)
  })

  it('is a no-op the second time: only the first boot after an upgrade changes the file', () => {
    seedOlderDatabase()
    getDb()
    resetDb()

    const db = openDb(getDbPath())
    expect(ensureSchema(db).added).toEqual([])
    db.$client.close()
  })

  it('the boot probe reports the schema healthy afterwards', async () => {
    seedOlderDatabase()

    const report = await runBootProbe()

    const check = report.checks.find((c) => c.id === 'databaseSchema')
    expect(check?.ok).toBe(true)
    expect(report.fatal).not.toContain('databaseSchema')
    expect(report.degraded).not.toContain('databaseSchema')
  })

  it('the boot probe would have caught a column the bootstrap failed to add', () => {
    // The check verifies the OUTCOME rather than trusting the mechanism, so it must
    // be able to fail. Reach past `getDb()` to a handle whose schema is genuinely
    // short, which is the state the old bootstrap left every upgraded file in.
    seedOlderDatabase()
    const db = openDb(getDbPath())

    expect(missingSchemaColumns(db)).toEqual(
      expect.arrayContaining([
        { table: 'agents', column: 'team_id' },
        { table: 'agents', column: 'capabilities' },
        { table: 'budgets', column: 'mode' },
      ]),
    )

    db.$client.close()
  })
})
