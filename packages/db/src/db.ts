import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import Database from 'better-sqlite3'
import { eq, sql } from 'drizzle-orm'
import { drizzle } from 'drizzle-orm/better-sqlite3'

import * as schema from './schema'
import { settings } from './schema'
import type { DbSetting } from './schema'

// ─── Database connection ───────────────────────────────────────────────────────

export type ClawbooDb = ReturnType<typeof drizzle<typeof schema>>

/**
 * Resolve the canonical Clawboo SQLite path (`~/.openclaw/clawboo/clawboo.db`),
 * honouring a `CLAWBOO_DB_PATH` override. Shared so out-of-process consumers
 * (the MCP stdio bins spawned by external runtimes) open the SAME file the
 * Express server serves — the multi-process WAL recipe is what keeps that safe.
 */
export function defaultDbPath(): string {
  const override = process.env['CLAWBOO_DB_PATH']
  if (override && override.trim().length > 0) return override.trim()
  return path.join(os.homedir(), '.openclaw', 'clawboo', 'clawboo.db')
}

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
  // Write-contention recipe: many agents may write one DB. Wait up to 1s for the
  // write lock (dodges the SQLite "convoy effect"), and keep the WAL lean with a
  // PASSIVE autocheckpoint every ~50 pages. Paired with app-level jittered retry
  // + BEGIN IMMEDIATE in the board repository (see src/board/contention.ts).
  sqlite.pragma('busy_timeout = 1000')
  sqlite.pragma('wal_autocheckpoint = 50')

  // Bootstrap DDL — the SOLE schema source of truth. There is no migration
  // ladder: a schema change is a hard reset of the local DB (no users), so this
  // block declares every table/column on a fresh DB outright. `schema.ts` is the
  // Drizzle TYPE layer over the same tables (used for typed queries, never to
  // apply migrations); schemaSource.test.ts guards the two against drift.
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS teams (
      id             TEXT    PRIMARY KEY,
      name           TEXT    NOT NULL,
      icon           TEXT    NOT NULL,
      color          TEXT    NOT NULL,
      color_collection_id TEXT,
      template_id    TEXT,
      leader_agent_id TEXT,
      is_archived    INTEGER NOT NULL DEFAULT 0,
      tenant_id      TEXT,
      created_at     INTEGER NOT NULL,
      updated_at     INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_teams_name ON teams (name);

    CREATE TABLE IF NOT EXISTS agents (
      id             TEXT    PRIMARY KEY,
      name           TEXT    NOT NULL,
      gateway_id     TEXT    NOT NULL,
      avatar_seed    TEXT,
      personality_config TEXT,
      exec_config    TEXT,
      team_id        TEXT    REFERENCES teams(id),
      status         TEXT    NOT NULL DEFAULT 'idle',
      source_id      TEXT    NOT NULL DEFAULT 'openclaw',
      source_agent_id TEXT,
      identity_json  TEXT,
      participant_kind TEXT  NOT NULL DEFAULT 'agent',
      runtime        TEXT    NOT NULL DEFAULT 'openclaw',
      capabilities   TEXT,
      tenant_id      TEXT,
      archived_at    INTEGER,
      created_at     INTEGER NOT NULL,
      updated_at     INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_agents_gateway_id ON agents (gateway_id);
    CREATE INDEX IF NOT EXISTS idx_agents_status      ON agents (status);
    CREATE INDEX IF NOT EXISTS idx_agents_team_id     ON agents (team_id);
    CREATE INDEX IF NOT EXISTS idx_agents_source      ON agents (source_id, source_agent_id);

    CREATE TABLE IF NOT EXISTS sessions (
      id                TEXT    PRIMARY KEY,
      source_id         TEXT    NOT NULL DEFAULT 'openclaw',
      source_session_id TEXT    NOT NULL,
      agent_id          TEXT,
      team_id           TEXT,
      status            TEXT    NOT NULL DEFAULT 'idle',
      parent_session_id TEXT,
      runtime           TEXT,
      tenant_id         TEXT,
      created_at        INTEGER NOT NULL,
      updated_at        INTEGER NOT NULL
    );
    CREATE UNIQUE INDEX IF NOT EXISTS uniq_sessions_source ON sessions (source_id, source_session_id);
    CREATE INDEX IF NOT EXISTS idx_sessions_agent ON sessions (agent_id);
    CREATE INDEX IF NOT EXISTS idx_sessions_parent ON sessions (parent_session_id);

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
    -- The (session_key, id) tail index for the live SSE stream: each poll
    -- range-seeks id-greater-than-cursor per member key (O(new-rows), not O(history)).
    CREATE INDEX IF NOT EXISTS idx_chat_messages_session_id
      ON chat_messages (session_key, id);

    CREATE TABLE IF NOT EXISTS boo_zero_team_briefs (
      team_id    TEXT    PRIMARY KEY REFERENCES teams(id) ON DELETE CASCADE,
      content    TEXT    NOT NULL,
      updated_at INTEGER NOT NULL
    );

    -- ── Durable board — see src/schema.ts for column docs ──────
    CREATE TABLE IF NOT EXISTS tasks (
      id                   TEXT    PRIMARY KEY,
      title                TEXT    NOT NULL,
      description          TEXT,
      status               TEXT    NOT NULL DEFAULT 'backlog',
      priority             INTEGER NOT NULL DEFAULT 0,
      team_id              TEXT,
      assignee_agent_id    TEXT,
      assignee_runtime     TEXT,
      parent_task_id       TEXT    REFERENCES tasks(id),
      source_delegation_id TEXT,
      worktree_ref         TEXT,
      branch_ref           TEXT,
      cost_usd             REAL    NOT NULL DEFAULT 0,
      parent_session_id    TEXT,
      dropped              INTEGER NOT NULL DEFAULT 0,
      tenant_id            TEXT,
      verification         TEXT,
      scheduled_by         TEXT    NOT NULL DEFAULT 'manual',
      created_at           INTEGER NOT NULL,
      updated_at           INTEGER NOT NULL,
      completed_at         INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_tasks_team_status ON tasks (team_id, status);
    CREATE INDEX IF NOT EXISTS idx_tasks_assignee    ON tasks (assignee_agent_id);
    CREATE INDEX IF NOT EXISTS idx_tasks_parent      ON tasks (parent_task_id);

    CREATE TABLE IF NOT EXISTS task_deps (
      task_id            TEXT NOT NULL REFERENCES tasks(id),
      depends_on_task_id TEXT NOT NULL REFERENCES tasks(id),
      tenant_id          TEXT,
      PRIMARY KEY (task_id, depends_on_task_id)
    );
    CREATE INDEX IF NOT EXISTS idx_task_deps_task    ON task_deps (task_id);
    CREATE INDEX IF NOT EXISTS idx_task_deps_depends ON task_deps (depends_on_task_id);

    CREATE TABLE IF NOT EXISTS task_comments (
      id              TEXT    PRIMARY KEY,
      task_id         TEXT    NOT NULL REFERENCES tasks(id),
      author_agent_id TEXT,
      author_type     TEXT    NOT NULL,
      body            TEXT    NOT NULL,
      tenant_id       TEXT,
      created_at      INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_task_comments_task ON task_comments (task_id);

    CREATE TABLE IF NOT EXISTS workspaces (
      id            TEXT    PRIMARY KEY,
      task_id       TEXT    NOT NULL REFERENCES tasks(id),
      repo_path     TEXT    NOT NULL,
      branch        TEXT,
      worktree_path TEXT,
      status        TEXT    NOT NULL DEFAULT 'active',
      tenant_id     TEXT,
      created_at    INTEGER NOT NULL,
      last_used_at  INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_workspaces_task ON workspaces (task_id);

    CREATE TABLE IF NOT EXISTS execution_processes (
      id                 TEXT    PRIMARY KEY,
      task_id            TEXT    NOT NULL REFERENCES tasks(id),
      workspace_id       TEXT    REFERENCES workspaces(id),
      executor_type      TEXT    NOT NULL,
      status             TEXT    NOT NULL DEFAULT 'queued',
      claimed_at         INTEGER,
      started_at         INTEGER,
      completed_at       INTEGER,
      before_commit      TEXT,
      after_commit       TEXT,
      input_tokens       INTEGER,
      output_tokens      INTEGER,
      cache_read         INTEGER,
      cache_write        INTEGER,
      cost_usd           REAL,
      summary            TEXT,
      run_reason         TEXT,
      error              TEXT,
      recovery_tombstone INTEGER NOT NULL DEFAULT 0,
      tenant_id          TEXT,
      created_at         INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_exec_task   ON execution_processes (task_id);
    CREATE INDEX IF NOT EXISTS idx_exec_status ON execution_processes (status);

    -- ── Routines — durable scheduled-runs ledger; see src/routines/ ──
    CREATE TABLE IF NOT EXISTS scheduled_runs (
      id            TEXT    PRIMARY KEY,
      agent_id      TEXT    NOT NULL,
      team_id       TEXT,
      cron_spec     TEXT    NOT NULL,
      task_template TEXT    NOT NULL,
      status        TEXT    NOT NULL DEFAULT 'idle',
      last_run_at   INTEGER,
      next_run_at   INTEGER,
      scheduled_by  TEXT    NOT NULL DEFAULT 'clawboo',
      last_error    TEXT,
      tenant_id     TEXT,
      created_at    INTEGER NOT NULL,
      updated_at    INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_scheduled_runs_next        ON scheduled_runs (next_run_at);
    CREATE INDEX IF NOT EXISTS idx_scheduled_runs_status_next ON scheduled_runs (status, next_run_at);
    CREATE INDEX IF NOT EXISTS idx_scheduled_runs_agent       ON scheduled_runs (agent_id);

    -- ── MCP trifecta: Memory — see src/memory/ ──────────────────
    CREATE TABLE IF NOT EXISTS memory_facts (
      id              TEXT    PRIMARY KEY,
      title           TEXT    NOT NULL,
      content         TEXT    NOT NULL,
      tags            TEXT    NOT NULL DEFAULT '[]',
      embedding       BLOB,
      embedding_model TEXT,
      scope_agent_id  TEXT,
      scope_team_id   TEXT,
      tenant_id       TEXT,
      created_at      INTEGER NOT NULL,
      updated_at      INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_memory_facts_team    ON memory_facts (scope_team_id);
    CREATE INDEX IF NOT EXISTS idx_memory_facts_agent   ON memory_facts (scope_agent_id);
    CREATE INDEX IF NOT EXISTS idx_memory_facts_created ON memory_facts (created_at);

    CREATE TABLE IF NOT EXISTS memory_procedures (
      id             TEXT    PRIMARY KEY,
      name           TEXT    NOT NULL,
      version        INTEGER NOT NULL DEFAULT 1,
      content        TEXT    NOT NULL,
      scope_agent_id TEXT,
      scope_team_id  TEXT,
      tenant_id      TEXT,
      created_at     INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_memory_procedures_name ON memory_procedures (name);
    CREATE INDEX IF NOT EXISTS idx_memory_procedures_team ON memory_procedures (scope_team_id);

    -- FTS5 over facts (standalone copy of title/content keyed by fact_id), kept
    -- in sync by triggers. Raw DDL — Drizzle cannot model a virtual table.
    CREATE VIRTUAL TABLE IF NOT EXISTS memory_facts_fts USING fts5(
      title, content, fact_id UNINDEXED
    );
    CREATE TRIGGER IF NOT EXISTS memory_facts_ai AFTER INSERT ON memory_facts BEGIN
      INSERT INTO memory_facts_fts(rowid, title, content, fact_id)
      VALUES (new.rowid, new.title, new.content, new.id);
    END;
    CREATE TRIGGER IF NOT EXISTS memory_facts_ad AFTER DELETE ON memory_facts BEGIN
      DELETE FROM memory_facts_fts WHERE rowid = old.rowid;
    END;
    CREATE TRIGGER IF NOT EXISTS memory_facts_au AFTER UPDATE ON memory_facts BEGIN
      DELETE FROM memory_facts_fts WHERE rowid = old.rowid;
      INSERT INTO memory_facts_fts(rowid, title, content, fact_id)
      VALUES (new.rowid, new.title, new.content, new.id);
    END;

    -- ── MCP trifecta: Tools broker — see src/tools/ ─────────────
    CREATE TABLE IF NOT EXISTS tool_registry (
      name                  TEXT    PRIMARY KEY,
      description           TEXT    NOT NULL,
      input_schema          TEXT,
      availability          TEXT,
      owner                 TEXT    NOT NULL DEFAULT 'core',
      provenance_signer_id  TEXT,
      provenance_signature  TEXT,
      provenance_signed_at  INTEGER,
      enabled               INTEGER NOT NULL DEFAULT 1,
      created_at            INTEGER NOT NULL,
      updated_at            INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_tool_registry_owner ON tool_registry (owner);

    CREATE TABLE IF NOT EXISTS tool_call_audit (
      id             TEXT    PRIMARY KEY,
      tool_name      TEXT    NOT NULL,
      agent_id       TEXT,
      phase          TEXT    NOT NULL,
      decision       TEXT,
      args_summary   TEXT,
      result_summary TEXT,
      is_error       INTEGER NOT NULL DEFAULT 0,
      tenant_id      TEXT,
      created_at     INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_tool_audit_tool    ON tool_call_audit (tool_name);
    CREATE INDEX IF NOT EXISTS idx_tool_audit_created ON tool_call_audit (created_at);

    CREATE TABLE IF NOT EXISTS tool_call_approvals (
      id           TEXT    PRIMARY KEY,
      tool_name    TEXT    NOT NULL,
      agent_id     TEXT,
      args_summary TEXT,
      reason       TEXT,
      status       TEXT    NOT NULL DEFAULT 'pending',
      task_id      TEXT,
      tenant_id    TEXT,
      created_at   INTEGER NOT NULL,
      expires_at   INTEGER NOT NULL,
      resolved_at  INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_tool_approvals_status  ON tool_call_approvals (status);
    CREATE INDEX IF NOT EXISTS idx_tool_approvals_created ON tool_call_approvals (created_at);

    -- ── Governance — see src/governance/ ─────────────────
    CREATE TABLE IF NOT EXISTS budgets (
      id              TEXT    PRIMARY KEY,
      scope           TEXT    NOT NULL,
      scope_id        TEXT    NOT NULL,
      limit_usd_cents INTEGER NOT NULL,
      spent_usd_cents INTEGER NOT NULL DEFAULT 0,
      spent_micro_cents INTEGER NOT NULL DEFAULT 0,
      status          TEXT    NOT NULL DEFAULT 'active',
      mode            TEXT    NOT NULL DEFAULT 'warn',
      tenant_id       TEXT,
      created_at      INTEGER NOT NULL,
      updated_at      INTEGER NOT NULL
    );
    CREATE UNIQUE INDEX IF NOT EXISTS uniq_budgets_scope ON budgets (scope, scope_id);
    CREATE INDEX IF NOT EXISTS idx_budgets_status ON budgets (status);

    CREATE TABLE IF NOT EXISTS governance_audit (
      id         TEXT    PRIMARY KEY,
      event_type TEXT    NOT NULL,
      agent_id   TEXT,
      task_id    TEXT,
      team_id    TEXT,
      tenant_id  TEXT,
      summary    TEXT    NOT NULL,
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_gov_audit_agent   ON governance_audit (agent_id, created_at);
    CREATE INDEX IF NOT EXISTS idx_gov_audit_created ON governance_audit (created_at);

    -- ── Observability event log — see src/events/ ────────────────
    -- Append-only; seq AUTOINCREMENT for cross-process monotonic ordering. The
    -- table is created always (inert until written) but written ONLY by the gated
    -- emit path. No triggers, no seed row.
    CREATE TABLE IF NOT EXISTS orchestration_events (
      seq            INTEGER PRIMARY KEY AUTOINCREMENT,
      id             TEXT    NOT NULL,
      ts             INTEGER NOT NULL,
      kind           TEXT    NOT NULL,
      team_id        TEXT,
      task_id        TEXT,
      agent_id       TEXT,
      runtime        TEXT,
      trace_id       TEXT,
      span_id        TEXT,
      parent_span_id TEXT,
      correlation_id TEXT,
      data           TEXT    NOT NULL,
      tenant_id      TEXT,
      created_at     INTEGER NOT NULL
    );
    CREATE UNIQUE INDEX IF NOT EXISTS uniq_orch_events_id    ON orchestration_events (id);
    CREATE INDEX IF NOT EXISTS idx_orch_events_team_seq  ON orchestration_events (team_id, seq);
    CREATE INDEX IF NOT EXISTS idx_orch_events_task_seq  ON orchestration_events (task_id, seq);
    CREATE INDEX IF NOT EXISTS idx_orch_events_trace_seq ON orchestration_events (trace_id, seq);
    CREATE INDEX IF NOT EXISTS idx_orch_events_kind_ts   ON orchestration_events (kind, ts);
    CREATE INDEX IF NOT EXISTS idx_orch_events_created   ON orchestration_events (created_at);

    -- ── Unified capability inventory — see src/capabilities/ ──────
    CREATE TABLE IF NOT EXISTS capabilities (
      id            TEXT    PRIMARY KEY,
      source_id     TEXT    NOT NULL,
      source_key    TEXT    NOT NULL,
      kind          TEXT    NOT NULL,
      runtime       TEXT    NOT NULL,
      scope         TEXT    NOT NULL,
      agent_id      TEXT,
      origin        TEXT    NOT NULL,
      manageability TEXT    NOT NULL,
      name          TEXT    NOT NULL,
      description   TEXT    NOT NULL DEFAULT '',
      availability  TEXT,
      available     INTEGER NOT NULL DEFAULT 1,
      diagnostics   TEXT    NOT NULL DEFAULT '[]',
      provenance    TEXT,
      status        TEXT    NOT NULL DEFAULT 'ready',
      tenant_id     TEXT,
      synced_at     INTEGER NOT NULL,
      created_at    INTEGER NOT NULL,
      updated_at    INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_capabilities_source  ON capabilities (source_id);
    CREATE INDEX IF NOT EXISTS idx_capabilities_runtime ON capabilities (runtime);
    CREATE INDEX IF NOT EXISTS idx_capabilities_agent   ON capabilities (agent_id);
    CREATE INDEX IF NOT EXISTS idx_capabilities_kind    ON capabilities (kind);

    -- ── Mixed-runtime peer chat — the team_chat room substrate (see src/teamChat/) ──
    CREATE TABLE IF NOT EXISTS team_chat (
      id              TEXT    PRIMARY KEY,
      room_id         TEXT    NOT NULL,
      team_id         TEXT    NOT NULL,
      author_agent_id TEXT    NOT NULL,
      body            TEXT    NOT NULL,
      kind            TEXT    NOT NULL DEFAULT 'peer',
      created_at      INTEGER NOT NULL,
      seq             INTEGER NOT NULL
    );
    CREATE UNIQUE INDEX IF NOT EXISTS uniq_team_chat_room_seq ON team_chat (room_id, seq);
    CREATE INDEX IF NOT EXISTS idx_team_chat_team ON team_chat (team_id);
  `)

  // The CREATE TABLE IF NOT EXISTS block above is the sole, complete bootstrap:
  // it declares every column on a fresh DB. There is no in-place migration ladder
  // — a schema change is a hard reset of the local DB (there are no users), so we
  // never carry forward-only ALTERs (which would also have to blanket-swallow DDL
  // errors). The db.test.ts PRAGMA assertions guard that the CREATE DDL stays
  // complete.

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

// ─── Boot-probe helpers (SQLite health) ───────────────────────────────────────

/**
 * Run `PRAGMA integrity_check` and return its single-row verdict ('ok' when the
 * file is healthy). Throwing here means the DB could not be queried at all — the
 * caller treats that as a fatal boot failure. A non-'ok' string is corruption.
 */
export function integrityCheck(db: ClawbooDb): string {
  const rows = db.all(sql`PRAGMA integrity_check`) as Array<{ integrity_check?: string }>
  // PRAGMA integrity_check always yields >=1 row ('ok' or error rows); zero rows
  // means the query did not execute normally — treat that as a failure, not healthy.
  if (rows.length === 0) return 'unknown'
  return rows[0]?.integrity_check ?? 'unknown'
}

/** List the user tables present in the DB (excludes sqlite_* internal tables). */
export function listTableNames(db: ClawbooDb): string[] {
  const rows = db.all(
    sql`SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'`,
  ) as Array<{ name: string }>
  return rows.map((r) => r.name)
}
