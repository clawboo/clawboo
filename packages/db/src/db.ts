import fs from 'node:fs'
import path from 'node:path'

import Database from 'better-sqlite3'
import { eq } from 'drizzle-orm'
import { drizzle } from 'drizzle-orm/better-sqlite3'

import * as schema from './schema'
import { settings } from './schema'
import type { DbSetting } from './schema'

// ─── Database connection ───────────────────────────────────────────────────────

export type ClawbooDb = ReturnType<typeof drizzle<typeof schema>>

/**
 * Create and initialise a Clawboo SQLite database at the given path.
 * Applies the inline DDL bootstrap so the file is immediately usable even
 * without running drizzle-kit migrations separately.
 */
export function createDb(dbPath: string): ClawbooDb {
  const dir = path.dirname(dbPath)
  fs.mkdirSync(dir, { recursive: true })

  const sqlite = new Database(dbPath)

  // Performance + correctness pragmas
  sqlite.pragma('journal_mode = WAL')
  sqlite.pragma('foreign_keys = ON')
  sqlite.pragma('synchronous = NORMAL')

  // Bootstrap DDL — forward-only; never edit committed statements.
  // drizzle-kit generate produces the canonical migration history;
  // this block ensures a fresh DB is usable without running drizzle-kit.
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS agents (
      id             TEXT    PRIMARY KEY,
      name           TEXT    NOT NULL,
      gateway_id     TEXT    NOT NULL,
      avatar_seed    TEXT,
      personality_config TEXT,
      status         TEXT    NOT NULL DEFAULT 'idle',
      created_at     INTEGER NOT NULL,
      updated_at     INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_agents_gateway_id ON agents (gateway_id);
    CREATE INDEX IF NOT EXISTS idx_agents_status      ON agents (status);

    CREATE TABLE IF NOT EXISTS cost_records (
      id             INTEGER PRIMARY KEY AUTOINCREMENT,
      agent_id       TEXT    NOT NULL REFERENCES agents(id),
      model          TEXT    NOT NULL,
      input_tokens   INTEGER NOT NULL,
      output_tokens  INTEGER NOT NULL,
      cost_usd       REAL    NOT NULL,
      run_id         TEXT,
      created_at     INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_cost_records_agent_id   ON cost_records (agent_id);
    CREATE INDEX IF NOT EXISTS idx_cost_records_run_id     ON cost_records (run_id);
    CREATE INDEX IF NOT EXISTS idx_cost_records_created_at ON cost_records (created_at);

    CREATE TABLE IF NOT EXISTS graph_layouts (
      id             INTEGER PRIMARY KEY AUTOINCREMENT,
      name           TEXT    NOT NULL DEFAULT 'default',
      gateway_url    TEXT    NOT NULL,
      layout_data    TEXT    NOT NULL,
      created_at     INTEGER NOT NULL,
      updated_at     INTEGER NOT NULL
    );
    CREATE UNIQUE INDEX IF NOT EXISTS uniq_graph_layouts_name_url
      ON graph_layouts (name, gateway_url);

    CREATE TABLE IF NOT EXISTS settings (
      key            TEXT    PRIMARY KEY,
      value          TEXT    NOT NULL,
      updated_at     INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS skills (
      id             TEXT    PRIMARY KEY,
      name           TEXT    NOT NULL,
      source         TEXT    NOT NULL,
      category       TEXT,
      trust_score    REAL,
      installed_at   INTEGER,
      metadata       TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_skills_source   ON skills (source);
    CREATE INDEX IF NOT EXISTS idx_skills_category ON skills (category);

    CREATE TABLE IF NOT EXISTS team_profiles (
      id             TEXT    PRIMARY KEY,
      name           TEXT    NOT NULL,
      description    TEXT,
      agents_config  TEXT    NOT NULL,
      skills_config  TEXT    NOT NULL,
      graph_layout   TEXT,
      is_builtin     INTEGER NOT NULL DEFAULT 0,
      created_at     INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS approval_history (
      id             INTEGER PRIMARY KEY AUTOINCREMENT,
      agent_id       TEXT    NOT NULL REFERENCES agents(id),
      action         TEXT    NOT NULL,
      tool_name      TEXT    NOT NULL,
      details        TEXT,
      created_at     INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_approval_history_agent_id
      ON approval_history (agent_id);
    CREATE INDEX IF NOT EXISTS idx_approval_history_created_at
      ON approval_history (created_at);

    CREATE TABLE IF NOT EXISTS chat_messages (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      session_key  TEXT    NOT NULL,
      gateway_url  TEXT    NOT NULL,
      entry_id     TEXT    NOT NULL,
      timestamp_ms INTEGER NOT NULL,
      data         TEXT    NOT NULL
    );
    CREATE UNIQUE INDEX IF NOT EXISTS uniq_chat_messages_entry_id
      ON chat_messages (entry_id);
    CREATE INDEX IF NOT EXISTS idx_chat_messages_session_ts
      ON chat_messages (session_key, timestamp_ms);
  `)

  return drizzle(sqlite, { schema })
}

// ─── Settings helpers (typed key/value store) ─────────────────────────────────

export function getSetting(db: ClawbooDb, key: string): string | null {
  const row = db.select().from(settings).where(eq(settings.key, key)).get() as DbSetting | undefined
  return row?.value ?? null
}

export function setSetting(db: ClawbooDb, key: string, value: string): void {
  const now = Date.now()
  db.insert(settings)
    .values({ key, value, updatedAt: now })
    .onConflictDoUpdate({
      target: settings.key,
      set: { value, updatedAt: now },
    })
    .run()
}
