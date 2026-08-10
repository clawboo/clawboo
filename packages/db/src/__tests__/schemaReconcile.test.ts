// The additive schema reconciler. See src/schemaReconcile.ts.
//
// `CREATE TABLE IF NOT EXISTS` skips the whole statement when the table exists, so
// a column added to an existing table used to be a silent no-op on every database
// created before the change. These tests pin the three things that make the fix
// trustworthy:
//
//  1. the DDL parser sees EXACTLY what SQLite creates from the same DDL (which is
//     what makes parsing the schema, rather than hand-listing migrations, safe);
//  2. a database missing a column (with real rows in it) is brought up to date
//     without losing those rows, including when the column carries an index;
//  3. a column that CANNOT be added fails loudly, with a message that says what to
//     do, rather than booting into a database that breaks on the next query.
//
// Populated tables are load-bearing throughout. SQLite's own guards are
// row-dependent: `ADD COLUMN x TEXT NOT NULL` SUCCEEDS against an empty table and
// fails against the same table with one row in it. A suite that reconciled empty
// fixtures would pass while every real user's upgrade broke.

import { sql } from 'drizzle-orm'
import { beforeEach, describe, expect, it } from 'vitest'

import { createDb, type ClawbooDb } from '../db'
import { declaredSchemaColumns, ensureSchema, missingSchemaColumns } from '../schemaBootstrap'
import {
  findMissingColumns,
  parseDdlColumns,
  reconcileSchema,
  retryOnBusy,
  SchemaUpgradeError,
  unaddableReason,
  type SchemaColumn,
} from '../schemaReconcile'
import { SCHEMA_BASELINE } from './schemaBaseline'

/** The baseline's columns for one table, or null when the table postdates it. */
function baselineColumns(table: string): Set<string> | null {
  const recorded = SCHEMA_BASELINE[table]
  return recorded === undefined ? null : new Set(recorded.split(' '))
}

// ─── helpers ─────────────────────────────────────────────────────────────────

function columnsOf(db: ClawbooDb, table: string): string[] {
  const rows = db.all(sql`PRAGMA table_info(${sql.raw(`"${table}"`)})`) as Array<{ name: string }>
  return rows.map((r) => r.name)
}

function tableNames(db: ClawbooDb): string[] {
  const rows = db.all(
    sql`SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'`,
  ) as Array<{ name: string }>
  return rows.map((r) => r.name)
}

/** Virtual tables (and the shadow tables they create) have no ALTER-able column list. */
function isVirtualOrShadow(db: ClawbooDb, table: string): boolean {
  const rows = db.$client
    .prepare(
      `SELECT name FROM sqlite_master WHERE type='table' AND sql LIKE 'CREATE VIRTUAL TABLE%'`,
    )
    .all() as Array<{ name: string }>
  return rows.some((r) => table === r.name || table.startsWith(`${r.name}_`))
}

function indexExists(db: ClawbooDb, name: string): boolean {
  const rows = db.all(
    sql`SELECT name FROM sqlite_master WHERE type='index' AND name = ${name}`,
  ) as Array<{ name: string }>
  return rows.length === 1
}

/** Column shape as SQLite reports it, keyed by name so declaration order can differ. */
function columnShape(db: ClawbooDb, table: string): Record<string, string> {
  const rows = db.$client.prepare(`PRAGMA table_info("${table}")`).all() as Array<{
    name: string
    type: string
    notnull: number
    dflt_value: string | null
    pk: number
  }>
  return Object.fromEntries(
    rows.map((r) => [r.name, `${r.type}|notnull=${r.notnull}|default=${r.dflt_value}|pk=${r.pk}`]),
  )
}

/** Foreign keys as SQLite reports them, sorted so ordering is not part of the comparison. */
function foreignKeys(db: ClawbooDb, table: string): string[] {
  const rows = db.$client.prepare(`PRAGMA foreign_key_list("${table}")`).all() as Array<{
    table: string
    from: string
    to: string | null
  }>
  return rows.map((r) => `${r.from}->${r.table}.${r.to ?? 'rowid'}`).sort()
}

function rowCount(db: ClawbooDb, table: string): number {
  const row = db.get(sql`SELECT COUNT(*) AS n FROM ${sql.raw(`"${table}"`)}`) as { n: number }
  return row.n
}

/** Value to seed for one column, resolving foreign keys to the row we already seeded. */
function seedValue(
  table: string,
  column: SchemaColumn,
  ids: Map<string, string>,
): string | number | null {
  const ref = column.definition.match(/\bREFERENCES\s+([A-Za-z_][A-Za-z0-9_]*)\s*\(/i)
  if (ref !== null) return ids.get((ref[1] as string).toLowerCase()) ?? null
  if (/\bTEXT\b/i.test(column.definition)) {
    return column.name === 'id' ? `${table}-seed` : `${table}.${column.name}`
  }
  if (/\bREAL\b/i.test(column.definition)) return 1.5
  if (/\bBLOB\b/i.test(column.definition)) return null
  return 1
}

/**
 * Put one row in EVERY table, derived from the DDL itself rather than hand-listed,
 * so the fixture cannot drift away from the schema it is meant to represent. Seeds
 * in declaration order, which is already a valid topological order for the schema's
 * foreign keys (`teams` before `agents`, `tasks` before `workspaces` before
 * `execution_processes`, …), and resolves each `REFERENCES t(id)` to the id already
 * seeded for `t`.
 *
 * Only the columns that must be supplied are: the primary key, and anything NOT
 * NULL without a DEFAULT. AUTOINCREMENT keys are left to SQLite.
 */
function seedEveryTable(db: ClawbooDb): string[] {
  const ids = new Map<string, string>()
  const seeded: string[] = []
  for (const [table, columns] of declaredSchemaColumns()) {
    const use = columns.filter((c) => {
      if (/\bAUTOINCREMENT\b/i.test(c.definition)) return false
      if (/\bPRIMARY\s+KEY\b/i.test(c.definition)) return true
      return /\bNOT\s+NULL\b/i.test(c.definition) && !/\bDEFAULT\b/i.test(c.definition)
    })
    if (use.length === 0) continue
    const values = use.map((c) => seedValue(table, c, ids))
    const names = use.map((c) => `"${c.name}"`).join(', ')
    const placeholders = use.map(() => '?').join(', ')
    db.$client.prepare(`INSERT INTO "${table}" (${names}) VALUES (${placeholders})`).run(...values)
    const pk = use.find((c) => c.name === 'id')
    if (pk !== undefined) ids.set(table.toLowerCase(), `${table}-seed`)
    seeded.push(table)
  }
  return seeded
}

/**
 * Remove a column the way an older release "not having it yet" looks, dropping the
 * indexes over it first.
 *
 * The index step is what makes the sweep honest. SQLite refuses to drop a column an
 * index depends on, so without it the 29 addable-but-indexed columns are invisible
 * to the test. Those include `tasks.dropped` and `sessions.parent_session_id`, the
 * two most recent real additions to this schema. Returns false only for a column
 * SQLite will not drop for a reason the reconciler cannot face either (a primary key,
 * a trigger reference).
 */
function tryRemoveColumn(db: ClawbooDb, table: string, column: string): boolean {
  const indexes = db.$client.prepare(`PRAGMA index_list("${table}")`).all() as Array<{
    name: string
  }>
  const dropped: string[] = []
  for (const idx of indexes) {
    const cols = db.$client.prepare(`PRAGMA index_info("${idx.name}")`).all() as Array<{
      name: string | null
    }>
    if (!cols.some((c) => c.name === column)) continue
    try {
      db.$client.prepare(`DROP INDEX "${idx.name}"`).run()
      dropped.push(idx.name)
    } catch {
      /* an auto-index cannot be dropped; the column drop below will refuse too */
    }
  }
  try {
    db.$client.prepare(`ALTER TABLE "${table}" DROP COLUMN "${column}"`).run()
    return true
  } catch {
    return false
  }
}

// ─── the parser sees what SQLite sees ────────────────────────────────────────

describe('parseDdlColumns: the parsed schema is what SQLite actually creates', () => {
  it('declares the same tables, columns and order as a freshly bootstrapped database', () => {
    const db = createDb(':memory:')
    const declared = declaredSchemaColumns()

    // Every real table is parsed. Without this direction a table the parser failed
    // to recognise would simply never be reconciled: the original bug, per table.
    // The virtual tables and their FTS5 shadow tables are excluded, derived from the
    // database rather than by name, so adding a second virtual table does not turn
    // this red for a reconciler that is behaving correctly.
    const real = tableNames(db).filter((t) => !isVirtualOrShadow(db, t))
    expect([...declared.keys()].sort()).toEqual(real.sort())

    for (const [table, columns] of declared) {
      expect(columns.map((c) => c.name)).toEqual(columnsOf(db, table))
    }
  })

  it('parses a fresh database as having nothing missing', () => {
    expect(missingSchemaColumns(createDb(':memory:'))).toEqual([])
  })

  it('the parity assertion fails when the parser and the database disagree', () => {
    // Proves the check above has teeth rather than comparing two empty things: the
    // same comparison, like for like, with one extra column on the parsed side.
    const db = createDb(':memory:')
    const parsed =
      declaredSchemaColumns()
        .get('budgets')
        ?.map((c) => c.name) ?? []
    expect(parsed.length).toBeGreaterThan(0)
    expect(parsed).toEqual(columnsOf(db, 'budgets'))
    expect([...parsed, 'drift_probe']).not.toEqual(columnsOf(db, 'budgets'))
  })

  it('reads the constructs the real DDL uses', () => {
    const parsed = parseDdlColumns(`
      -- a leading comment
      CREATE TABLE IF NOT EXISTS t (
        id         TEXT    PRIMARY KEY,
        tags       TEXT    NOT NULL DEFAULT '[]',   -- a trailing comment
        team_id    TEXT    REFERENCES teams(id) ON DELETE CASCADE,
        n          INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (id, n)
      );
      CREATE INDEX IF NOT EXISTS idx_t ON t (team_id);
      CREATE VIRTUAL TABLE IF NOT EXISTS t_fts USING fts5(a, b, c UNINDEXED);
      CREATE TRIGGER IF NOT EXISTS t_ai AFTER INSERT ON t BEGIN
        INSERT INTO t_fts(rowid, a, b) VALUES (new.rowid, new.id, new.tags);
      END;
    `)

    // The virtual table and the trigger body contribute no columns.
    expect([...parsed.keys()]).toEqual(['t'])
    // The table-level PRIMARY KEY (id, n) is a constraint, not a fifth column.
    expect(parsed.get('t')?.map((c) => c.name)).toEqual(['id', 'tags', 'team_id', 'n'])
    // A DEFAULT containing quotes and a REFERENCES containing parens stay intact.
    expect(parsed.get('t')?.[1]?.definition).toBe(`tags TEXT NOT NULL DEFAULT '[]'`)
    expect(parsed.get('t')?.[2]?.definition).toBe(
      'team_id TEXT REFERENCES teams(id) ON DELETE CASCADE',
    )
  })

  it('reads block comments too, so a comment style cannot stop the schema parsing', () => {
    const parsed = parseDdlColumns(
      'CREATE TABLE IF NOT EXISTS t (id TEXT PRIMARY KEY, /* why */ a TEXT);',
    )
    expect(parsed.get('t')?.map((c) => c.name)).toEqual(['id', 'a'])
  })

  it('keeps a comment marker that is really string content', () => {
    const parsed = parseDdlColumns(
      `CREATE TABLE IF NOT EXISTS t (id TEXT PRIMARY KEY, a TEXT DEFAULT '-- not a comment');`,
    )
    expect(parsed.get('t')?.[1]?.definition).toBe(`a TEXT DEFAULT '-- not a comment'`)
  })

  it('treats every table-level constraint as a constraint, and reads a quoted column', () => {
    // None of these appear in the real DDL today, so only a synthetic case covers
    // them. Getting one wrong invents a phantom column the reconciler would then
    // try to ADD on every boot.
    const parsed = parseDdlColumns(`
      CREATE TABLE IF NOT EXISTS t (
        id      TEXT PRIMARY KEY,
        "order" INTEGER NOT NULL DEFAULT 0,
        a       TEXT,
        b       TEXT,
        UNIQUE (a, b),
        CHECK (a <> b),
        CONSTRAINT fk_a FOREIGN KEY (a) REFERENCES u(id)
      );
    `)
    expect(parsed.get('t')?.map((c) => c.name)).toEqual(['id', 'order', 'a', 'b'])
  })

  it('refuses a column list it cannot read rather than dropping the column silently', () => {
    expect(() => parseDdlColumns('CREATE TABLE IF NOT EXISTS t (id TEXT, 42 INTEGER);')).toThrow(
      /cannot read a column name/i,
    )
  })

  it('does not track a generated column, which is why the parity guard rejects one', () => {
    // `PRAGMA table_info` omits VIRTUAL generated columns entirely, so one in the
    // DDL would read as permanently missing: every boot would try to add it and the
    // health check would stay red. The parity assertion above is what stops one
    // reaching the schema; this pins the reason.
    const db = createDb(':memory:')
    db.$client.prepare('CREATE TABLE gen (id TEXT PRIMARY KEY, a TEXT)').run()
    db.$client.prepare('ALTER TABLE gen ADD COLUMN b TEXT GENERATED ALWAYS AS (a) VIRTUAL').run()

    expect(columnsOf(db, 'gen')).toEqual(['id', 'a'])
    expect(
      findMissingColumns(
        db,
        'CREATE TABLE IF NOT EXISTS gen (id TEXT PRIMARY KEY, a TEXT, b TEXT GENERATED ALWAYS AS (a) VIRTUAL);',
      ),
    ).toEqual([{ table: 'gen', column: 'b' }])
  })

  it('refuses to half-read a malformed CREATE TABLE rather than returning a partial schema', () => {
    expect(() => parseDdlColumns('CREATE TABLE IF NOT EXISTS t (id TEXT PRIMARY KEY')).toThrow(
      /unbalanced parentheses/i,
    )
  })

  it('does not see a CREATE TABLE written without IF NOT EXISTS, which the parity test catches', () => {
    // Documented, deliberate: the reconciler only knows the tables the bootstrap
    // declares idempotently. A table declared any other way would silently never be
    // reconciled, so the parity test above (parsed table set === real table set) is
    // what stops one from shipping.
    expect(parseDdlColumns('CREATE TABLE t (id TEXT PRIMARY KEY, a TEXT);').size).toBe(0)
  })
})

// ─── addability ──────────────────────────────────────────────────────────────

describe('unaddableReason: the static gate on what SQLite will accept', () => {
  it('names the reason it rejects', () => {
    expect(unaddableReason('id TEXT PRIMARY KEY')).toMatch(/PRIMARY KEY/)
    expect(unaddableReason('slug TEXT UNIQUE')).toMatch(/UNIQUE/)
    expect(unaddableReason('name TEXT NOT NULL')).toMatch(/NOT NULL column without a DEFAULT/)
    expect(unaddableReason(`team_id TEXT DEFAULT 'x' REFERENCES teams(id)`)).toMatch(/REFERENCES/)
    expect(unaddableReason('upper TEXT GENERATED ALWAYS AS (name) STORED')).toMatch(/STORED/)
    expect(unaddableReason('at INTEGER DEFAULT (unixepoch())')).toMatch(/expression/)
    expect(unaddableReason('made_at TEXT DEFAULT CURRENT_TIMESTAMP')).toMatch(/CURRENT_TIMESTAMP/)
  })

  it('reads keywords in the declaration, never inside a DEFAULT value', () => {
    // The house style for a status column is DEFAULT '<word>' (budgets.mode
    // DEFAULT 'warn', tasks.status DEFAULT 'backlog'), so a keyword scan that saw
    // into string literals would fail the bootstrap against a perfectly healthy
    // database: the worst outcome this module can produce.
    expect(unaddableReason(`mode TEXT NOT NULL DEFAULT 'unique per team'`)).toBeNull()
    expect(unaddableReason(`mode TEXT NOT NULL DEFAULT 'primary key style'`)).toBeNull()
    expect(unaddableReason(`mode TEXT NOT NULL DEFAULT 'stored'`)).toBeNull()
  })

  it('agrees with what SQLite actually does to a populated table, both ways', () => {
    // The gate is static because SQLite's is row-dependent. That only holds up if
    // the two give the SAME answers, so every rule is pinned against the real engine
    // on the case that matters: a table with a row in it. A false negative here
    // surfaces a raw SQLite error instead of a useful one; a false positive refuses
    // to boot against a healthy database.
    const db = createDb(':memory:')
    db.$client.prepare('CREATE TABLE probe (id TEXT PRIMARY KEY, name TEXT)').run()
    db.$client.prepare(`INSERT INTO probe (id, name) VALUES ('p1', 'x')`).run()

    const cases = [
      // addable
      'note TEXT',
      `tags TEXT NOT NULL DEFAULT '[]'`,
      'dropped INTEGER NOT NULL DEFAULT 0',
      'team_id TEXT REFERENCES probe(id)',
      'ref_null TEXT DEFAULT NULL REFERENCES probe(id)',
      'label TEXT COLLATE NOCASE',
      'checked INTEGER CHECK (checked IN (0, 1))',
      'upper_name TEXT GENERATED ALWAYS AS (name) VIRTUAL',
      `mode TEXT NOT NULL DEFAULT 'unique per team'`,
      `kind TEXT NOT NULL DEFAULT 'primary key style'`,
      'stored TEXT',
      'retry_count INTEGER NOT NULL DEFAULT (0)',
      "paren_str TEXT DEFAULT ('x')",
      // not addable
      'slug TEXT UNIQUE',
      'req TEXT NOT NULL',
      'req_null TEXT NOT NULL DEFAULT NULL',
      `ref TEXT DEFAULT 'x' REFERENCES probe(id)`,
      'gen TEXT GENERATED ALWAYS AS (name) STORED',
      'at INTEGER DEFAULT (unixepoch())',
      'computed INTEGER DEFAULT (1 + 1)',
      'made_at TEXT DEFAULT CURRENT_TIMESTAMP',
      'made_on TEXT DEFAULT CURRENT_DATE',
      'made_time TEXT DEFAULT CURRENT_TIME',
    ]
    for (const def of cases) {
      let sqliteAccepted = true
      try {
        db.$client.prepare(`ALTER TABLE probe ADD COLUMN ${def}`).run()
      } catch {
        sqliteAccepted = false
      }
      expect({ def, addable: unaddableReason(def) === null }).toEqual({
        def,
        addable: sqliteAccepted,
      })
    }
  })
})

// ─── the build-time gate ─────────────────────────────────────────────────────

describe('every column added since the baseline can reach an existing database', () => {
  it('holds for the current schema', () => {
    // The addability gate only fires against a database that is MISSING the column,
    // and no fresh-install test database ever is. So without this, shipping
    // `foo TEXT NOT NULL` on an existing table passes CI and breaks every upgrade.
    // Scoped to what is NEW: a column present when the table was created never has
    // to be added to anything, which is why 133 of the baseline's own columns are
    // un-addable and that is fine.
    const offenders: string[] = []
    for (const [table, columns] of declaredSchemaColumns()) {
      const recorded = baselineColumns(table)
      if (recorded === null) continue // a brand-new table is built whole by CREATE TABLE
      for (const column of columns) {
        if (recorded.has(column.name)) continue
        const reason = unaddableReason(column.definition)
        if (reason !== null) offenders.push(`${table}.${column.name}: ${reason}`)
      }
    }
    expect(offenders).toEqual([])
  })

  it('the baseline still describes the schema it was taken from', () => {
    // Guards the check above from quietly becoming vacuous: a baseline that lost
    // touch with the DDL would report every column as "new" or none at all.
    const declared = declaredSchemaColumns()
    for (const table of Object.keys(SCHEMA_BASELINE)) {
      expect(declared.has(table)).toBe(true)
      const names = declared.get(table)?.map((c) => c.name) ?? []
      // Baseline columns are a subset: the DDL may have gained some since.
      expect(names).toEqual(expect.arrayContaining([...(baselineColumns(table) ?? [])]))
    }
  })
})

// ─── lock contention ─────────────────────────────────────────────────────────

describe('retryOnBusy: another process holding the write lock is not a boot failure', () => {
  it('retries a busy error and returns once the lock frees', () => {
    let attempts = 0
    const slept: number[] = []
    const result = retryOnBusy(
      () => {
        attempts += 1
        if (attempts < 3)
          throw Object.assign(new Error('database is locked'), { code: 'SQLITE_BUSY' })
        return 'added'
      },
      { sleep: (ms) => slept.push(ms) },
    )

    expect(result).toBe('added')
    expect(attempts).toBe(3)
    expect(slept).toHaveLength(2)
  })

  it('gives up once the budget is spent, so a held lock does not hang the boot', () => {
    let now = 0
    expect(() =>
      retryOnBusy(
        () => {
          throw Object.assign(new Error('database is locked'), { code: 'SQLITE_BUSY' })
        },
        { budgetMs: 100, now: () => now, sleep: () => (now += 25) },
      ),
    ).toThrow(/database is locked/)
  })

  it('never retries an error waiting cannot fix', () => {
    let attempts = 0
    expect(() =>
      retryOnBusy(() => {
        attempts += 1
        throw new Error('duplicate column name: note')
      }),
    ).toThrow(/duplicate column name/)
    expect(attempts).toBe(1)
  })
})

// ─── reconciling a real, populated database ──────────────────────────────────

describe('reconcileSchema: an existing database is brought up to the current schema', () => {
  let db: ClawbooDb

  beforeEach(() => {
    db = createDb(':memory:')
  })

  it('changes nothing on a freshly bootstrapped database', () => {
    expect(ensureSchema(db).added).toEqual([])
  })

  it('is idempotent: a second bootstrap adds nothing', () => {
    seedEveryTable(db)
    expect(ensureSchema(db).added).toEqual([])
    expect(ensureSchema(db).added).toEqual([])
  })

  it('restores every column an older database could be missing, keeping its rows', () => {
    // Simulate "older schema" the only way that is faithful without shipping a
    // binary fixture: take a current database with data in it and remove each
    // column that a future release could plausibly ADD, then bootstrap again.
    const seeded = seedEveryTable(db)
    expect(seeded.length).toBeGreaterThan(20)
    const before = new Map(seeded.map((t) => [t, rowCount(db, t)]))

    const addable: string[] = []
    const removed: string[] = []
    for (const [table, columns] of declaredSchemaColumns()) {
      for (const column of columns) {
        if (unaddableReason(column.definition) !== null) continue
        addable.push(`${table}.${column.name}`)
        if (tryRemoveColumn(db, table, column.name)) removed.push(`${table}.${column.name}`)
      }
    }
    // Every addable column is exercised. Asserting the FULL set, not a floor, is
    // what keeps the sweep from quietly shrinking: a column that stops being
    // reachable (because an index now covers it, say) fails here instead of just
    // going untested.
    expect(removed).toEqual(addable)
    expect(removed.length).toBeGreaterThan(130)

    const { added } = ensureSchema(db)
    expect(added.map((c) => `${c.table}.${c.column}`).sort()).toEqual(removed.sort())
    expect(missingSchemaColumns(db)).toEqual([])

    // A restored column must be DEFINED like a freshly created one, not merely
    // present. Comparing names only would bless an ADD COLUMN that dropped the
    // NOT NULL or the REFERENCES clause, leaving an upgraded database that silently
    // accepts rows a fresh install rejects: the fresh-vs-upgraded divergence this
    // module exists to remove.
    const fresh = createDb(':memory:')
    for (const table of declaredSchemaColumns().keys()) {
      expect({ table, shape: columnShape(db, table) }).toEqual({
        table,
        shape: columnShape(fresh, table),
      })
      expect({ table, fks: foreignKeys(db, table) }).toEqual({
        table,
        fks: foreignKeys(fresh, table),
      })
    }

    // Every seeded row is still there, the indexes are back, and the keys still hold.
    for (const [table, n] of before) expect(rowCount(db, table)).toBe(n)
    expect(indexExists(db, 'idx_agents_team_id')).toBe(true)
    expect(indexExists(db, 'idx_tasks_parent_dropped_created')).toBe(true)
    expect(db.all(sql`PRAGMA foreign_key_check`)).toEqual([])
  })

  it('restores a column that an index depends on, then the index', () => {
    // The case that forces reconcile to run BEFORE the DDL batch. `agents.team_id`
    // carries `idx_agents_team_id`, so with the batch first the whole thing dies on
    // "no such column: team_id" and the server never boots.
    seedEveryTable(db)
    db.$client.prepare('DROP INDEX idx_agents_team_id').run()
    expect(tryRemoveColumn(db, 'agents', 'team_id')).toBe(true)
    expect(columnsOf(db, 'agents')).not.toContain('team_id')

    const { added } = ensureSchema(db)

    expect(added).toContainEqual({ table: 'agents', column: 'team_id' })
    expect(columnsOf(db, 'agents')).toContain('team_id')
    expect(indexExists(db, 'idx_agents_team_id')).toBe(true)
    expect(rowCount(db, 'agents')).toBe(1)
  })

  it('creates a table that is missing entirely rather than trying to alter it', () => {
    db.$client.prepare('DROP TABLE team_chat').run()
    expect(tableNames(db)).not.toContain('team_chat')

    expect(ensureSchema(db).added).toEqual([])
    expect(tableNames(db)).toContain('team_chat')
    expect(columnsOf(db, 'team_chat')).toContain('kind')
  })

  it('leaves a column the schema no longer declares alone (a downgrade keeps its data)', () => {
    seedEveryTable(db)
    db.$client.prepare(`ALTER TABLE budgets ADD COLUMN from_a_newer_release TEXT`).run()
    db.$client.prepare(`UPDATE budgets SET from_a_newer_release = 'keep me'`).run()

    expect(ensureSchema(db).added).toEqual([])

    const row = db.get(sql`SELECT from_a_newer_release AS v FROM budgets`) as { v: string }
    expect(row.v).toBe('keep me')
  })

  it('never alters the FTS5 virtual table or its shadow tables', () => {
    seedEveryTable(db)
    const before = tableNames(db).filter((t) => t.startsWith('memory_facts_fts'))
    expect(before.length).toBeGreaterThan(1)

    expect(ensureSchema(db).added).toEqual([])
    expect(
      tableNames(db)
        .filter((t) => t.startsWith('memory_facts_fts'))
        .sort(),
    ).toEqual(before.sort())
  })

  it('treats a column another process added first as benign, not a conflict', () => {
    // The multi-process race: an MCP stdio bin opens the same file and reconciles
    // the same column between this process's PRAGMA read and its ALTER. Driven here
    // by declaring the column twice, which reaches the same "already there" branch
    // without needing two interleaved connections.
    db.$client.prepare('CREATE TABLE racer (id TEXT PRIMARY KEY)').run()
    db.$client.prepare(`INSERT INTO racer (id) VALUES ('r1')`).run()

    const { added } = reconcileSchema(
      db,
      'CREATE TABLE IF NOT EXISTS racer (id TEXT PRIMARY KEY, note TEXT, note TEXT);',
    )

    expect(added).toEqual([{ table: 'racer', column: 'note' }])
    expect(columnsOf(db, 'racer')).toEqual(['id', 'note'])
  })

  it('matches column names case-insensitively, the way SQLite does', () => {
    db.$client.prepare('CREATE TABLE caser (id TEXT PRIMARY KEY, note TEXT)').run()
    db.$client.prepare(`INSERT INTO caser (id) VALUES ('c1')`).run()

    // The TABLE name stays as-is on purpose: varying it too would make the reconciler
    // skip the table outright, and the test would pass with case folding removed
    // entirely without ever reaching the column comparison it is named for.
    const ddl = 'CREATE TABLE IF NOT EXISTS caser (id TEXT PRIMARY KEY, NOTE TEXT);'

    // The DIFF is the real assertion: `added` alone is masked by the benign
    // duplicate-column catch, which would swallow the ALTER this must never make.
    expect(findMissingColumns(db, ddl)).toEqual([])
    expect(reconcileSchema(db, ddl).added).toEqual([])
    expect(columnsOf(db, 'caser')).toEqual(['id', 'note'])
  })

  it('propagates an ALTER failure it cannot explain rather than skipping the column', () => {
    // The duplicate-column catch must stay narrow. If it swallowed any error, a
    // column that failed to land would leave the boot "successful" with the column
    // missing: issue #144 restored through the error path.
    db.$client.prepare('CREATE TABLE strict (id TEXT PRIMARY KEY)').run()
    db.$client.prepare(`INSERT INTO strict (id) VALUES ('s1')`).run()
    // The declaration has to PARSE and pass the static gate so the ALTER is actually
    // reached. An unparseable one would throw earlier, and the test would then pass
    // even with the guard removed. An unknown collation is the smallest thing SQLite
    // accepts in a CREATE and rejects in an ALTER.
    const def = 'bad TEXT COLLATE NO_SUCH_COLLATION'
    expect(unaddableReason(def)).toBeNull()

    expect(() =>
      reconcileSchema(db, `CREATE TABLE IF NOT EXISTS strict (id TEXT PRIMARY KEY, ${def});`),
    ).toThrow(/no such collation/i)
    expect(columnsOf(db, 'strict')).toEqual(['id'])
  })
})

// ─── failing loudly ──────────────────────────────────────────────────────────

describe('reconcileSchema: a column it cannot add fails loudly and changes nothing', () => {
  it('names the column, the reason and the remedy', () => {
    const db = createDb(':memory:')
    db.$client.prepare('CREATE TABLE legacy (id TEXT PRIMARY KEY)').run()
    db.$client.prepare(`INSERT INTO legacy (id) VALUES ('l1')`).run()

    expect(() =>
      reconcileSchema(
        db,
        'CREATE TABLE IF NOT EXISTS legacy (id TEXT PRIMARY KEY, name TEXT NOT NULL);',
      ),
    ).toThrow(
      // Table, column, the declaration, the reason, and both remedies. The message
      // IS the whole recovery surface for a user whose server will not start.
      /Table:\s+legacy[\s\S]*Column:\s+name[\s\S]*name TEXT NOT NULL[\s\S]*NOT NULL column without a DEFAULT[\s\S]*delete the\s+file above[\s\S]*developing clawboo/,
    )
  })

  it('throws a typed SchemaUpgradeError naming the column', () => {
    // Typed because the server treats it as fatal (retrying is pointless: the
    // outcome is a property of the declaration), while a transient open failure
    // stays retryable.
    const db = createDb(':memory:')
    db.$client.prepare('CREATE TABLE legacy (id TEXT PRIMARY KEY)').run()
    db.$client.prepare(`INSERT INTO legacy (id) VALUES ('l1')`).run()

    try {
      reconcileSchema(
        db,
        'CREATE TABLE IF NOT EXISTS legacy (id TEXT PRIMARY KEY, n TEXT NOT NULL);',
      )
      expect.unreachable('should have thrown')
    } catch (err) {
      expect(err).toBeInstanceOf(SchemaUpgradeError)
      expect((err as SchemaUpgradeError).table).toBe('legacy')
      expect((err as SchemaUpgradeError).column).toBe('n')
    }
  })

  it('adds nothing at all when any one column of the table is un-addable', () => {
    // Validate-then-apply, so an upgrade that cannot complete does not half-apply.
    const db = createDb(':memory:')
    db.$client.prepare('CREATE TABLE legacy (id TEXT PRIMARY KEY)').run()
    db.$client.prepare(`INSERT INTO legacy (id) VALUES ('l1')`).run()

    expect(() =>
      reconcileSchema(
        db,
        'CREATE TABLE IF NOT EXISTS legacy (id TEXT PRIMARY KEY, ok TEXT, bad TEXT NOT NULL);',
      ),
    ).toThrow()

    expect(columnsOf(db, 'legacy')).toEqual(['id'])
  })

  it('adds nothing to an EARLIER table when a LATER one cannot be upgraded', () => {
    // Validation is one pass over the whole diff, not per table. Per table, the
    // early table's ALTER would commit and the next boot would throw on the same
    // late column again: a permanently half-upgraded file, not a self-heal.
    const db = createDb(':memory:')
    db.$client.prepare('CREATE TABLE early (id TEXT PRIMARY KEY)').run()
    db.$client.prepare('CREATE TABLE late (id TEXT PRIMARY KEY)').run()
    db.$client.prepare(`INSERT INTO early (id) VALUES ('e1')`).run()
    db.$client.prepare(`INSERT INTO late (id) VALUES ('l1')`).run()

    expect(() =>
      reconcileSchema(
        db,
        'CREATE TABLE IF NOT EXISTS early (id TEXT PRIMARY KEY, ok TEXT);' +
          'CREATE TABLE IF NOT EXISTS late (id TEXT PRIMARY KEY, bad TEXT NOT NULL);',
      ),
    ).toThrow(SchemaUpgradeError)

    expect(columnsOf(db, 'early')).toEqual(['id'])
  })

  it('rolls the whole bootstrap back when the DDL batch fails after a column landed', () => {
    // Driven through the REAL ensureSchema and the REAL DDL, so it fails if the
    // transaction wrapper is removed. A test that built its own transaction would
    // only be asserting that SQLite DDL is transactional, which is true regardless.
    //
    // `graph_layouts.name` is addable (NOT NULL DEFAULT 'default') and carries a
    // UNIQUE index with gateway_url. Two rows sharing a gateway_url means the
    // backfilled default collides, so the reconcile succeeds and the batch's index
    // then cannot be created.
    const db = createDb(':memory:')
    const seed = `INSERT INTO graph_layouts (name, gateway_url, layout_data, created_at, updated_at)`
    db.$client.prepare(`${seed} VALUES ('a', 'ws://x', '{}', 1, 1)`).run()
    db.$client.prepare(`${seed} VALUES ('b', 'ws://x', '{}', 1, 1)`).run()
    db.$client.prepare('DROP INDEX uniq_graph_layouts_name_url').run()
    db.$client.prepare('ALTER TABLE graph_layouts DROP COLUMN name').run()

    expect(() => ensureSchema(db)).toThrow(/UNIQUE constraint failed/)

    // Neither half applied: no orphan column, and the rows are untouched.
    expect(columnsOf(db, 'graph_layouts')).not.toContain('name')
    expect(indexExists(db, 'uniq_graph_layouts_name_url')).toBe(false)
    expect(rowCount(db, 'graph_layouts')).toBe(2)
  })

  it('leaves a name that exists as a VIEW to the DDL batch to reject', () => {
    // `teams` as a view is the shape sharedConnection.test.ts uses to make
    // ensureSchema throw; the reconciler must not be the thing that throws first,
    // and must never try to ALTER a view.
    const db = createDb(':memory:')
    db.$client.prepare('DROP TABLE boo_zero_team_briefs').run()
    db.$client.prepare('DROP TABLE agents').run()
    db.$client.prepare('DROP TABLE teams').run()
    db.$client.prepare('CREATE VIEW teams AS SELECT 1 AS id, 1 AS name').run()

    expect(() =>
      reconcileSchema(db, 'CREATE TABLE IF NOT EXISTS teams (id TEXT PRIMARY KEY, extra TEXT);'),
    ).not.toThrow()
    expect(() => ensureSchema(db)).toThrow(/view/i)
  })
})
