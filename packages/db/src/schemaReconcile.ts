// ─── Additive schema reconciler ───────────────────────────────────────────────
// `CREATE TABLE IF NOT EXISTS` skips the WHOLE statement when the table is already
// present, so a column added to an existing table is a silent no-op on every
// database created before the change: the upgrade appears to succeed and then
// fails at runtime on the first query that touches the column. This module closes
// that gap the one way SQLite makes cheap: read the declared column set out of the
// bootstrap DDL, diff it against `PRAGMA table_info`, and `ALTER TABLE ADD COLUMN`
// whatever is missing.
//
// WHY PARSE THE DDL RATHER THAN KEEP A LIST OF MIGRATIONS. The DDL is already the
// sole schema source (`schemaBootstrap.ts`), and a hand-maintained list of ALTERs
// would be a second one: free to drift, and drifting silently in exactly the
// direction this module exists to prevent. Parsing keeps one source, and
// `schemaReconcile.test.ts` makes the parser self-guarding: it asserts the parsed
// column set is identical to what SQLite actually creates from the same DDL, so a
// construct the parser cannot read fails the build rather than shipping.
//
// WHY NOT RECONSTRUCT THE REFERENCE SCHEMA FROM PRAGMA instead of parsing text: it
// looks simpler and is unsafe. `PRAGMA table_info` reports name, type, NOT NULL,
// DEFAULT and primary key. It cannot see `UNIQUE`, `CHECK` or `COLLATE`. A future
// `slug TEXT UNIQUE` would reconstruct as `slug TEXT`, the ADD would SUCCEED, and
// the upgraded database would then accept duplicates a fresh install rejects. That
// is this issue's fresh-vs-upgraded divergence, reintroduced by the shortcut.
//
// SCOPE: additive only. `ADD COLUMN` is the sole schema change SQLite performs
// without rewriting the table, and it is sufficient for how this schema evolves.
// NOT reconciled: a column whose TYPE / `NOT NULL` / `DEFAULT` changed, a dropped
// column, a new table constraint, an index or trigger whose DEFINITION changed
// (`CREATE … IF NOT EXISTS` matches on NAME, so a redefinition is a no-op), and any
// change to the FTS5 virtual table. `schemaSource.test.ts` compares names only for
// the same reason. Extra columns in the database that the DDL no longer declares
// are left alone: they are what a downgrade looks like, and dropping them would
// destroy the newer version's data.

import type { ClawbooDb } from './db'

/** One column as declared in the bootstrap DDL. */
export interface SchemaColumn {
  name: string
  /**
   * The column's definition exactly as the DDL declares it, whitespace-collapsed,
   * e.g. `team_id TEXT REFERENCES teams(id)`. Reused verbatim as the ADD COLUMN
   * body so a reconciled column is defined identically to a freshly created one.
   */
  definition: string
}

/** A column the reconciler added to an existing table. */
export interface AddedColumn {
  table: string
  column: string
}

export interface SchemaReconcileReport {
  /** Empty on a fresh database and on every steady-state boot. */
  added: AddedColumn[]
}

/**
 * This database cannot be brought up to the current schema, and never will be:
 * the outcome is a property of the declaration, so retrying produces the identical
 * failure. Typed so the boot probe can report it as a schema problem rather than as
 * a database it could not open, which is what the file being readable would
 * otherwise look like (see apps/web/server/lib/bootProbe.ts).
 */
export class SchemaUpgradeError extends Error {
  readonly table: string
  readonly column: string

  constructor(input: { table: string; column: string; message: string }) {
    super(input.message)
    this.name = 'SchemaUpgradeError'
    this.table = input.table
    this.column = input.column
  }
}

// ─── DDL parsing ──────────────────────────────────────────────────────────────

/**
 * Strip SQL comments, both `-- line` and block, leaving string literals untouched.
 * Naive stripping would corrupt a default like `DEFAULT '--'`; the DDL has no such
 * literal today, but the parser must not be the reason a future one is unsafe to
 * write. Block comments are handled for the same reason: the DDL uses only `--`
 * today, and someone writing the other style should not be how the schema stops
 * parsing.
 */
function stripComments(ddl: string): string {
  let out = ''
  let quote: string | null = null
  for (let i = 0; i < ddl.length; i += 1) {
    const c = ddl[i] as string
    if (quote !== null) {
      out += c
      if (c === quote) quote = null
      continue
    }
    if (c === "'" || c === '"') {
      quote = c
      out += c
      continue
    }
    if (c === '-' && ddl[i + 1] === '-') {
      while (i < ddl.length && ddl[i] !== '\n') i += 1
      out += '\n'
      continue
    }
    if (c === '/' && ddl[i + 1] === '*') {
      i += 2
      while (i < ddl.length && !(ddl[i] === '*' && ddl[i + 1] === '/')) i += 1
      i += 1 // the loop's own i += 1 steps past the closing '/'
      out += ' '
      continue
    }
    out += c
  }
  return out
}

/**
 * Blank out the CONTENTS of string literals, preserving length and the quotes.
 *
 * Load-bearing for `unaddableReason`: the house style for a status column is
 * `DEFAULT 'warn'` / `DEFAULT 'backlog'`, so a value like `DEFAULT 'unique per
 * team'` would otherwise make a keyword scan see `UNIQUE` and reject a column
 * SQLite is perfectly happy to add. A false rejection is the worst thing this
 * module can do: it fails the bootstrap against a database that is entirely healthy.
 */
function blankStringLiterals(definition: string): string {
  let out = ''
  let quote: string | null = null
  for (const c of definition) {
    if (quote !== null) {
      out += c === quote ? c : ' '
      if (c === quote) quote = null
      continue
    }
    if (c === "'" || c === '"') quote = c
    out += c
  }
  return out
}

/**
 * Split a `CREATE TABLE` body on the commas that separate its top-level items.
 * Parens and quotes are tracked so `REFERENCES teams(id)`, `PRIMARY KEY (a, b)`
 * and `DEFAULT '[]'` stay in one piece.
 */
function splitTopLevel(body: string): string[] {
  const parts: string[] = []
  let depth = 0
  let quote: string | null = null
  let cur = ''
  for (let i = 0; i < body.length; i += 1) {
    const c = body[i] as string
    if (quote !== null) {
      cur += c
      if (c === quote) quote = null
      continue
    }
    if (c === "'" || c === '"') {
      quote = c
      cur += c
      continue
    }
    if (c === '(') depth += 1
    else if (c === ')') depth -= 1
    if (c === ',' && depth === 0) {
      parts.push(cur)
      cur = ''
      continue
    }
    cur += c
  }
  parts.push(cur)
  return parts.map((p) => p.trim()).filter((p) => p.length > 0)
}

/** Table-level constraints, which sit in the column list but declare no column. */
const TABLE_CONSTRAINT = /^(PRIMARY\s+KEY|UNIQUE|CHECK|FOREIGN\s+KEY|CONSTRAINT)\b/i

// Matches only `CREATE TABLE IF NOT EXISTS <name> (`. `CREATE VIRTUAL TABLE` has a
// word between CREATE and TABLE and so never matches. That is deliberate: a virtual
// table (the FTS5 index) has no ALTER-able column list. Trigger bodies contain no
// CREATE TABLE, so they are skipped for free.
const CREATE_TABLE = /CREATE\s+TABLE\s+IF\s+NOT\s+EXISTS\s+([A-Za-z_][A-Za-z0-9_]*)\s*\(/gi

/** The column name a column-definition begins with, or null when it declares none. */
function columnNameOf(definition: string): string | null {
  const named = definition.match(/^"?([A-Za-z_][A-Za-z0-9_]*)"?\b/)
  return named === null ? null : (named[1] as string)
}

/**
 * The column set each `CREATE TABLE IF NOT EXISTS` in `ddl` declares, keyed by
 * table name and in declaration order.
 *
 * Throws if the DDL cannot be read (unbalanced parens, an unreadable column name)
 * rather than silently returning a partial schema: a parse gap here would let the
 * very no-op this module prevents back in through the side door.
 */
export function parseDdlColumns(ddl: string): Map<string, SchemaColumn[]> {
  const clean = stripComments(ddl)
  const out = new Map<string, SchemaColumn[]>()
  for (const match of clean.matchAll(CREATE_TABLE)) {
    const table = match[1] as string
    // Scan from just past the opening paren the match consumed to its balanced partner.
    const start = (match.index ?? 0) + match[0].length
    let i = start
    let depth = 1
    let quote: string | null = null
    for (; i < clean.length && depth > 0; i += 1) {
      const c = clean[i] as string
      if (quote !== null) {
        if (c === quote) quote = null
        continue
      }
      if (c === "'" || c === '"') {
        quote = c
        continue
      }
      if (c === '(') depth += 1
      else if (c === ')') depth -= 1
    }
    if (depth !== 0) {
      throw new Error(`schema DDL: unbalanced parentheses in CREATE TABLE ${table}`)
    }
    const columns: SchemaColumn[] = []
    for (const part of splitTopLevel(clean.slice(start, i - 1))) {
      if (TABLE_CONSTRAINT.test(part)) continue
      const name = columnNameOf(part)
      if (name === null) {
        throw new Error(`schema DDL: cannot read a column name from "${part}" in ${table}`)
      }
      columns.push({ name, definition: part.replace(/\s+/g, ' ') })
    }
    out.set(table, columns)
  }
  return out
}

// ─── Addability ───────────────────────────────────────────────────────────────

/**
 * Why SQLite would refuse to `ADD` this column, or null when it can be added.
 *
 * This is a STATIC check on purpose. SQLite's own equivalents are row-dependent
 * (`ADD COLUMN x TEXT NOT NULL` succeeds against an empty table and fails against
 * the same table with one row in it), so trusting the engine would mean a change
 * that passes every test on throwaway fixtures and breaks on the first real
 * database that has data in it. Checking the declaration instead is the only form
 * of the check whose answer does not depend on who is running it.
 *
 * `schemaReconcile.test.ts` pins every rule below against what SQLite actually does
 * to a POPULATED table, in both directions, because the failure modes are not
 * symmetric: a missed rule surfaces a raw SQLite error instead of a useful one,
 * while an over-eager rule fails the bootstrap against a healthy database.
 */
export function unaddableReason(definition: string): string | null {
  // Keyword scans run over the literal-blanked form so a DEFAULT VALUE can never be
  // mistaken for a constraint; `hasDefault` is read from it too, so a literal
  // containing the word DEFAULT does not count as one.
  const d = blankStringLiterals(definition.replace(/\s+/g, ' '))

  // Most specific first, so a non-constant DEFAULT is not reported as the (also
  // true, but less useful) "NOT NULL without a DEFAULT".
  if (/\bAS\s*\([^)]*\)\s*STORED\b/i.test(d)) {
    return 'SQLite cannot ADD a STORED generated column (VIRTUAL can be added)'
  }
  // Non-constant defaults, which SQLite refuses with "Cannot add a column with
  // non-constant default": the three bare time keywords, and a parenthesised
  // expression. A parenthesised LITERAL is fine and must be allowed: `DEFAULT (0)`
  // is a common habit (it is the style drizzle-kit's own generated SQL emits), so
  // refusing every paren would fail the bootstrap against a healthy database.
  const parenDefault = /\bDEFAULT\s*\(([^)]*)\)/i.exec(d)
  const isLiteral = (v: string): boolean =>
    /^\s*([-+]?\d+(\.\d+)?|'[^']*'|NULL|TRUE|FALSE)\s*$/i.test(v)
  if (/\bDEFAULT\s+CURRENT_(TIMESTAMP|DATE|TIME)\b/i.test(d)) {
    return 'SQLite cannot ADD a column whose DEFAULT is CURRENT_TIMESTAMP, CURRENT_DATE or CURRENT_TIME'
  }
  if (parenDefault !== null && !isLiteral(parenDefault[1] ?? '')) {
    return 'SQLite cannot ADD a column whose DEFAULT is an expression rather than a constant'
  }
  if (/\bPRIMARY\s+KEY\b/i.test(d)) return 'SQLite cannot ADD a PRIMARY KEY column'
  if (/\bUNIQUE\b/i.test(d)) return 'SQLite cannot ADD a UNIQUE column'

  // `DEFAULT NULL` is spelled like a default but fills nothing in, so it neither
  // satisfies NOT NULL nor trips the REFERENCES rule. Both rules read this one
  // predicate so they cannot disagree about what "has a default" means.
  const hasNonNullDefault = /\bDEFAULT\b/i.test(d) && !/\bDEFAULT\s+NULL\b/i.test(d)
  if (/\bNOT\s+NULL\b/i.test(d) && !hasNonNullDefault) {
    return 'SQLite cannot ADD a NOT NULL column without a DEFAULT to a table that already has rows'
  }
  if (/\bREFERENCES\b/i.test(d) && hasNonNullDefault) {
    return 'SQLite cannot ADD a REFERENCES column with a non-NULL DEFAULT while foreign keys are on'
  }
  return null
}

function unaddableMessage(
  db: ClawbooDb,
  table: string,
  column: SchemaColumn,
  reason: string,
): string {
  return [
    'clawboo cannot upgrade this database to the current schema.',
    '',
    `  Database: ${db.$client.name}`,
    `  Table:    ${table}`,
    `  Column:   ${column.name}  (declared as: ${column.definition})`,
    `  Reason:   ${reason}.`,
    '',
    'Your data is intact, but this version of clawboo will not run against it.',
    'Either use the version of clawboo that created this database, or delete the',
    'file above to start from a clean one. That discards the board, chat history,',
    'memory and the governance ledger, and keeps your settings and API keys.',
    '',
    'If you are developing clawboo: a new column on an existing table must be',
    'addable. It may not be PRIMARY KEY, UNIQUE or a STORED generated column, its',
    'DEFAULT must be a literal, it needs one if it is NOT NULL, and it may not pair',
    'REFERENCES with a non-NULL DEFAULT. See unaddableReason in schemaReconcile.ts.',
  ].join('\n')
}

// ─── Reconcile ────────────────────────────────────────────────────────────────

interface NameRow {
  name: string
}

// SQLite identifiers are case-insensitive, so every "does it already exist" lookup
// folds case. Getting this wrong is not cosmetic: a DDL that spells a column
// differently from the stored one would look missing, and the ADD would then fail
// with "duplicate column name". That is a hard boot failure for a schema that is
// actually fine.
const fold = (name: string): string => name.toLowerCase()

/** The names of the real (non-view) tables currently in the database. */
function existingTables(db: ClawbooDb): Set<string> {
  const rows = db.$client
    .prepare(`SELECT name FROM sqlite_master WHERE type = 'table'`)
    .all() as NameRow[]
  return new Set(rows.map((r) => fold(r.name)))
}

function existingColumns(db: ClawbooDb, table: string): Set<string> {
  // The name comes from our own DDL and the parser only admits [A-Za-z_][A-Za-z0-9_]*,
  // so there is no interpolation hazard here; it is quoted anyway.
  const rows = db.$client.prepare(`PRAGMA table_info("${table}")`).all() as NameRow[]
  return new Set(rows.map((r) => fold(r.name)))
}

interface MissingColumn {
  table: string
  column: SchemaColumn
}

/**
 * Every column the DDL declares that an existing table does not have. The ONE diff:
 * `reconcileSchema` applies it and `findMissingColumns` reports it, and the boot
 * probe uses the latter to verify the former, so two copies could drift in exactly
 * the way that would make the verification meaningless.
 *
 * Tables absent from the database are skipped: `CREATE TABLE IF NOT EXISTS` in the
 * batch creates those complete. Views and virtual tables are skipped too, because a
 * virtual table is never in the parsed map, and a name that exists as a view is not
 * reported by the `type = 'table'` query.
 */
function diffMissing(db: ClawbooDb, ddl: string): MissingColumn[] {
  const declared = parseDdlColumns(ddl)
  const present = existingTables(db)
  const missing: MissingColumn[] = []
  for (const [table, columns] of declared) {
    if (!present.has(fold(table))) continue
    const have = existingColumns(db, table)
    for (const column of columns) {
      if (!have.has(fold(column.name))) missing.push({ table, column })
    }
  }
  return missing
}

// ─── Applying one column ──────────────────────────────────────────────────────

/** True for the error a losing racer sees when another process added the column first. */
function isDuplicateColumn(err: unknown): boolean {
  return err instanceof Error && /duplicate column name/i.test(err.message)
}

function isBusy(err: unknown): boolean {
  if (typeof err !== 'object' || err === null) return false
  const code = (err as { code?: unknown }).code
  return code === 'SQLITE_BUSY' || code === 'SQLITE_BUSY_SNAPSHOT' || code === 'SQLITE_LOCKED'
}

const BUSY_RETRY_BUDGET_MS = 1500

/**
 * Synchronous sleep. better-sqlite3 is synchronous by design, so an async wait
 * would make the whole bootstrap async; `Atomics.wait` blocks without spinning.
 * Same mechanism as the board's write retry (`board/contention.ts`).
 */
function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
}

/**
 * Run a write, retrying only a transient SQLite lock error within a wall-clock
 * budget. Deliberately NOT `board/contention.ts`'s `withWriteRetry`: importing it
 * would close the package's first value-import cycle (schemaBootstrap → board →
 * db → schemaBootstrap), and the two want different policies anyway. A lost claim
 * there is data to return, while here a duplicate column is a benign no-op.
 *
 * The lock matters because the four MCP stdio bins open the SAME database file
 * (`createDb(defaultDbPath())`), so the boot after an upgrade is exactly when
 * several processes may reconcile at once.
 *
 * `ensureSchema` wraps its WHOLE transaction in this, not one `ALTER`, and opens it
 * with BEGIN IMMEDIATE. Both matter. A DEFERRED transaction would read first and so
 * hold a WAL read snapshot before its first write, and a concurrent commit then
 * makes SQLite return SQLITE_BUSY_SNAPSHOT, a stale-snapshot error that retrying in
 * place can never clear. Taking the write intent up front means the diff is never
 * built against a snapshot something else can invalidate, and the only lock error
 * left is a plain busy one, which waiting does clear. Wrapping the transaction
 * rather than a statement is what lets a retry start from a fresh diff, by which
 * point a racing process has usually added the columns already.
 *
 * Exported for its unit test, which injects the sleep so it cannot flake on timing.
 */
export function retryOnBusy<T>(
  fn: () => T,
  opts: { budgetMs?: number; now?: () => number; sleep?: (ms: number) => void } = {},
): T {
  const now = opts.now ?? ((): number => performance.now())
  const sleep = opts.sleep ?? sleepSync
  const budgetMs = opts.budgetMs ?? BUSY_RETRY_BUDGET_MS
  const startedAt = now()
  for (;;) {
    try {
      return fn()
    } catch (err) {
      // Out of budget, or not something waiting can fix: let it out. The bootstrap
      // is retried on the next start, which is the right cadence for a lock that is
      // still held after a second and a half.
      if (!isBusy(err) || now() - startedAt >= budgetMs) throw err
      sleep(25)
    }
  }
}

/**
 * Bring every table that already exists up to the column set `ddl` declares.
 *
 * MUST run BEFORE the DDL batch, not after. A new column normally arrives with a
 * new index over it, and `CREATE INDEX IF NOT EXISTS … ON t (new_col)` fails with
 * "no such column" against a table that has not been reconciled yet. That takes
 * the whole batch, and the boot, down with it. Running first also means the batch
 * needs no statement splitting: on a fresh database there are no tables so this is
 * a no-op, and on an existing one the columns land before anything indexes them.
 *
 * Three phases, and the separation is load-bearing: EVERY missing column across
 * EVERY table is validated before the first `ALTER` runs. Validating per table
 * instead would let an un-addable column on a late table commit the ALTERs of the
 * earlier ones, and since the next boot throws on the same column again, that is a
 * permanently half-upgraded file, not something that heals itself. `ensureSchema`
 * additionally runs this and the batch in ONE transaction, so even an unforeseen
 * failure leaves the file exactly as it was.
 */
export function reconcileSchema(db: ClawbooDb, ddl: string): SchemaReconcileReport {
  // 1. the whole diff.
  const missing = diffMissing(db, ddl)

  // 2. validate all of it, before touching anything.
  for (const { table, column } of missing) {
    const reason = unaddableReason(column.definition)
    if (reason !== null) {
      throw new SchemaUpgradeError({
        table,
        column: column.name,
        message: unaddableMessage(db, table, column, reason),
      })
    }
  }

  // 3. apply.
  const added: AddedColumn[] = []
  for (const { table, column } of missing) {
    try {
      db.$client.prepare(`ALTER TABLE "${table}" ADD COLUMN ${column.definition}`).run()
    } catch (err) {
      // Another process (an MCP stdio bin opening the same file) reconciled the
      // same column between our PRAGMA read and this write. Its column is identical
      // to ours by construction, so this is a benign race, not a conflict.
      if (isDuplicateColumn(err)) continue
      throw err
    }
    added.push({ table, column: column.name })
  }

  return { added }
}

/**
 * Columns the DDL declares that an existing table does not have: the reconciler's
 * diff, without the writes. Empty after a successful `ensureSchema`; a non-empty
 * result means the database would fail at runtime on the first query touching one
 * of them, which is what the boot probe reports.
 */
export function findMissingColumns(db: ClawbooDb, ddl: string): AddedColumn[] {
  return diffMissing(db, ddl).map(({ table, column }) => ({ table, column: column.name }))
}
