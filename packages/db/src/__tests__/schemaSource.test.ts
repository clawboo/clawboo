// Schema source-of-truth guard. The runtime `CREATE TABLE IF NOT EXISTS` DDL in
// db.ts is the SOLE schema-creation source: there is no migration ladder — a
// schema change is a hard reset of the local DB (no users). `schema.ts` is the
// Drizzle TYPE layer over the same tables (used for typed queries, NEVER to
// apply migrations). Nothing keeps the two descriptions in sync automatically,
// so this test does: it builds a DB via the REAL `createDb()` and asserts every
// `schema.ts` table + its column set matches the live DDL (and vice-versa). The
// FTS5 virtual table + its shadow tables are excluded (raw DDL in db.ts, not
// modellable in schema.ts).
//
// SCOPE — read before trusting this as the FULL parity guard: it compares ONLY
// {table -> set(column NAMES)}. Column TYPE / NOT NULL / DEFAULT / PRIMARY KEY / FK /
// index drift between the two sources is NOT compared — the Drizzle-column →
// SQLite-PRAGMA affinity/default mapping is lossy and would produce false drift, so
// the deeper shape check is deliberately deferred (revisit before a real schema
// change). The drift this DOES catch: a column or table added to one source but not
// the other.
//
// It also pins the posture decision: the previously-shipped, never-applied
// drizzle migration ladder must not ship in the npm package nor be runnable as
// an operator action against a bootstrapped DB.

import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'

import { is, sql } from 'drizzle-orm'
import { getTableConfig, SQLiteTable } from 'drizzle-orm/sqlite-core'
import { describe, expect, it } from 'vitest'

import { createDb } from '../db'
import * as schema from '../schema'

function isExcluded(table: string): boolean {
  // sqlite internals + the FTS5 virtual table and its auto-created shadow tables.
  return table.startsWith('sqlite_') || table.startsWith('memory_facts_fts')
}

// {table -> set(column names)} from the Drizzle `schema.ts` type layer.
function schemaFromTypeLayer(): Map<string, Set<string>> {
  const out = new Map<string, Set<string>>()
  for (const value of Object.values(schema)) {
    if (!is(value, SQLiteTable)) continue
    const cfg = getTableConfig(value)
    if (isExcluded(cfg.name)) continue
    out.set(cfg.name, new Set(cfg.columns.map((c) => c.name)))
  }
  return out
}

// {table -> set(column names)} from the REAL createDb() inline DDL.
function schemaFromCreateDb(): Map<string, Set<string>> {
  const db = createDb(':memory:')
  const tables = (
    db.all(sql`SELECT name FROM sqlite_master WHERE type='table'`) as { name: string }[]
  )
    .map((r) => r.name)
    .filter((t) => !isExcluded(t))
  const out = new Map<string, Set<string>>()
  for (const t of tables) {
    const cols = db.all(sql`PRAGMA table_info(${sql.raw(`"${t}"`)})`) as Array<{ name: string }>
    out.set(t, new Set(cols.map((c) => c.name)))
  }
  return out
}

// Comparable plain object (Maps/Sets don't deep-equal nicely across nesting).
function plain(schemaMap: Map<string, Set<string>>): Record<string, string[]> {
  const o: Record<string, string[]> = {}
  for (const [t, cols] of schemaMap) o[t] = [...cols].sort()
  return o
}

describe('schema source of truth: the schema.ts type layer and the runtime CREATE DDL agree', () => {
  it('define the same tables and columns', () => {
    const fromType = schemaFromTypeLayer()
    const fromDdl = schemaFromCreateDb()
    // Same table set.
    expect(new Set(fromType.keys())).toEqual(new Set(fromDdl.keys()))
    // Same {table -> {column}} across the board.
    expect(plain(fromType)).toEqual(plain(fromDdl))
  })

  it('the comparison actually fails when a column exists on only one source', () => {
    const fromDdl = schemaFromCreateDb()
    // Simulate a runtime column the type layer does NOT declare.
    expect(fromDdl.get('budgets')).toBeDefined()
    fromDdl.get('budgets')?.add('drift_probe')
    const fromType = schemaFromTypeLayer()

    expect(fromType.get('budgets')?.has('drift_probe')).toBe(false)
    expect(plain(fromType)).not.toEqual(plain(fromDdl))
  })
})

describe('schema posture: the unapplied drizzle ladder does not ship or run', () => {
  const pkgPath = path.join(__dirname, '..', '..', 'package.json')
  const pkg = JSON.parse(readFileSync(pkgPath, 'utf8')) as {
    files?: string[]
    scripts?: Record<string, string>
  }

  it('the npm files array excludes build-only migration metadata', () => {
    expect(pkg.files ?? []).not.toContain('drizzle')
  })

  it('exposes no db:migrate / db:generate footgun scripts', () => {
    const scripts = pkg.scripts ?? {}
    expect(scripts['db:migrate']).toBeUndefined()
    expect(scripts['db:generate']).toBeUndefined()
  })

  it('has no migration-ladder directory on disk', () => {
    expect(existsSync(path.join(__dirname, '..', '..', 'drizzle'))).toBe(false)
  })
})
