// ─── Schema bootstrap ─────────────────────────────────────────────────────────
// The SOLE schema-creation source: this block declares every table, index and
// trigger on a fresh DB outright. `schema.ts` is the Drizzle TYPE layer over the
// same tables (used for typed queries, never to apply migrations);
// schemaSource.test.ts guards the two against drift, and the db.test.ts PRAGMA
// assertions guard that the CREATE DDL stays complete.
//
// THERE IS STILL NO MIGRATION LADDER. No numbered `.sql` files, no `user_version`,
// no `db:migrate`. What there IS is one derived, additive reconcile step: because
// `CREATE TABLE IF NOT EXISTS` skips the whole statement when the table already
// exists, a column added to an existing table would otherwise be a silent no-op on
// every database created before the change, surfacing later as a runtime SQL error
// on the first query that touches it. `reconcileSchema` (schemaReconcile.ts) reads
// the column set back out of this DDL and `ALTER TABLE ADD COLUMN`s whatever an
// existing table is missing, so the DDL below stays the single source of truth and
// nothing has to be hand-maintained alongside it.
//
// WHAT THAT ASKS OF THIS BLOCK. Keep it additive, and keep a NEW column on an
// EXISTING table addable: no PRIMARY KEY, no UNIQUE, no STORED generated column, a
// literal (not an expression) DEFAULT, one whenever it is NOT NULL, and no non-NULL
// DEFAULT on a REFERENCES column. A new column that breaks those rules fails loudly
// at boot with an actionable message rather than silently; see `unaddableReason`,
// and `schemaBaseline.ts`, which fails the BUILD for one instead of waiting for a
// user's upgrade to find it. Changing an existing column's type/NOT NULL/DEFAULT,
// removing one, adding a table constraint, redefining an index or trigger (their
// `IF NOT EXISTS` matches on NAME), and any change to the FTS5 virtual table are all
// still NOT in-place upgrades.
//
// WHY THIS IS ITS OWN MODULE. Every statement is `IF NOT EXISTS`, so re-running
// the block is SAFE — which is exactly why it was easy to run it on every
// connection open and never notice. Safe is not free: 88 statements, each parsed
// and resolved against `sqlite_master`, on a path that used to run once per HTTP
// request. Splitting it out of `createDb` makes "once, at boot" a shape you can
// see rather than a convention you have to remember — see `getDb()` in
// apps/web/server/lib/db.ts, which is where the server runs it.

import type { ClawbooDb } from './db'
import { noteSchemaBootstrap } from './openStats'
import {
  findMissingColumns,
  parseDdlColumns,
  reconcileSchema,
  retryOnBusy,
} from './schemaReconcile'
import type { AddedColumn, SchemaColumn, SchemaReconcileReport } from './schemaReconcile'

const SCHEMA_DDL = `
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
    CREATE INDEX IF NOT EXISTS idx_tasks_parent_dropped_created ON tasks (parent_task_id, dropped, created_at);

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
      -- The connector this tool was discovered from. Null for a builtin, which
      -- is every row today. Namespacing already keeps two connectors exposing
      -- the same remote name from colliding on the PRIMARY KEY, so this column
      -- is not what makes them storable: it is what makes them QUERYABLE, so
      -- revoking a connector can find its tools instead of pattern-matching
      -- their names.
      connector_id          TEXT,
      created_at            INTEGER NOT NULL,
      updated_at            INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_tool_registry_owner ON tool_registry (owner);
    CREATE INDEX IF NOT EXISTS idx_tool_registry_connector ON tool_registry (connector_id);

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
      -- Grant attribution. Nullable because most tool calls are core builtins that
      -- no grant governs, and because every row written before this column existed
      -- has to keep meaning what it meant.
      grant_id       TEXT,
      connector_id   TEXT,
      rule_id        TEXT,
      created_at     INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_tool_audit_tool    ON tool_call_audit (tool_name);
    CREATE INDEX IF NOT EXISTS idx_tool_audit_created ON tool_call_audit (created_at);
    -- (grant_id, created_at) so "when was this grant last used" is one indexed
    -- read. That derivation is why capability_grants carries no last_used_at: a
    -- team- or global-scoped grant would be a hot single row on a single-writer DB.
    CREATE INDEX IF NOT EXISTS idx_tool_audit_grant   ON tool_call_audit (grant_id, created_at);

    CREATE TABLE IF NOT EXISTS tool_call_approvals (
      id           TEXT    PRIMARY KEY,
      tool_name    TEXT    NOT NULL,
      agent_id     TEXT,
      args_summary TEXT,
      reason       TEXT,
      status       TEXT    NOT NULL DEFAULT 'pending',
      task_id      TEXT,
      tenant_id    TEXT,
      grant_id       TEXT,
      connector_id   TEXT,
      -- Set when the tool cannot be scoped to an argument shape, which is what
      -- makes "Always" unofferable for it. Persisted rather than recomputed so the
      -- resolve path cannot mint a durable rule the prompt never offered.
      never_remember INTEGER NOT NULL DEFAULT 0,
      rule_reason    TEXT,
      created_at   INTEGER NOT NULL,
      expires_at   INTEGER NOT NULL,
      resolved_at  INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_tool_approvals_status  ON tool_call_approvals (status);
    CREATE INDEX IF NOT EXISTS idx_tool_approvals_created ON tool_call_approvals (created_at);
    CREATE INDEX IF NOT EXISTS idx_tool_approvals_grant   ON tool_call_approvals (grant_id, status);

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

    -- ── Durable per-agent mailbox — the delivery plane (see src/inbox.ts) ──
    -- A row is a notification an agent must eventually receive (an executor-path
    -- task update, a parked/undeliverable alert, a peer signal). Consumed by
    -- whichever channel reaches the agent first — the run-seed digest or the MCP
    -- tool-response piggyback — each stamping delivered_at + delivered_via.
    -- Undelivered rows survive eviction and restart: a restart is a pause, and
    -- the agent catches up from its mailbox rather than from luck.
    CREATE TABLE IF NOT EXISTS agent_inbox (
      id              TEXT    PRIMARY KEY,
      team_id         TEXT,
      agent_id        TEXT    NOT NULL,
      kind            TEXT    NOT NULL,
      body            TEXT    NOT NULL,
      task_id         TEXT,
      created_at      INTEGER NOT NULL,
      delivered_at    INTEGER,
      delivered_via   TEXT,
      tenant_id       TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_agent_inbox_pending ON agent_inbox (agent_id, delivered_at);

    -- ── Connector INSTANCES: see src/grants/ ────────────────────────────────
    -- Three nouns kept apart on purpose. The catalog TYPE is committed TypeScript
    -- in @clawboo/connector-catalog, this row is a configured INSTANCE, and a
    -- capabilities row is one callable TOOL. spec_hash / tools_hash are
    -- sha256 hex over the canonical strings @clawboo/governance produces, so a
    -- server that rewrites its own tool list is detectable as drift.
    --
    -- No secret material ever lands here: spec carries only secret:NAME
    -- references, which is also why it is safe to hash and to log.
    --
    -- ONE ROW PER CONNECTED CONNECTOR, written by the supervisor once discovery
    -- has succeeded, and never before: a row for a server that never answered
    -- would make the directory claim a connection that does not exist.
    CREATE TABLE IF NOT EXISTS connectors (
      id            TEXT    PRIMARY KEY,
      slug          TEXT    NOT NULL,
      catalog_id    TEXT,
      display_name  TEXT    NOT NULL,
      transport     TEXT    NOT NULL,
      spec          TEXT    NOT NULL DEFAULT '{}',
      spec_hash     TEXT    NOT NULL,
      tools_hash    TEXT,
      egress_allow  TEXT    NOT NULL DEFAULT '[]',
      trifecta      TEXT    NOT NULL DEFAULT '{"readsPrivateData":false,"ingestsUntrustedContent":false,"canEgress":false}',
      health        TEXT    NOT NULL DEFAULT 'unknown',
      health_detail TEXT,
      failures      INTEGER NOT NULL DEFAULT 0,
      tenant_id     TEXT,
      created_at    INTEGER NOT NULL,
      updated_at    INTEGER NOT NULL
    );
    CREATE UNIQUE INDEX IF NOT EXISTS uniq_connectors_slug   ON connectors (slug);
    CREATE INDEX IF NOT EXISTS        idx_connectors_health  ON connectors (health);
    CREATE INDEX IF NOT EXISTS        idx_connectors_catalog ON connectors (catalog_id);

    -- ── The grant spine: capability_grants IS the edge ──────────────────────
    -- One row is BOTH the permission executeBrokeredCall enforces AND the Ghost
    -- Graph edge an operator reads. The renderer calls the same decideGrant the
    -- gate calls: a badge computed by a second code path is governance theatre,
    -- and this schema exists to make that second path impossible rather than
    -- merely discouraged.
    --
    -- grant_key is the canonicalised (subject, capability) composite, and it is
    -- the ONLY column uniqueness can live on. A UNIQUE index over the five
    -- nullable identity columns does NOT enforce one-grant-per-pair: SQLite treats
    -- NULLs as distinct, so ('global',NULL,'connector',NULL,NULL) inserts twice.
    --
    -- IDENTITY NORMALISATION, enforced by grantKey: when connector_id is set,
    -- capability_id is stored NULL. A capabilities.id folds the agent id into
    -- its raw key, so keying a grant on it would make the granting agent's row
    -- unfindable by the grantee's broker. connector_id is agent-independent by
    -- construction, which is the whole reason it exists.
    --
    -- There is deliberately NO last_used_at and NO use_count. A team- or
    -- global-scoped grant is a hot single row on a single-writer database, and a
    -- contended write can block the event loop for the full retry budget. Both
    -- values are DERIVED from tool_call_audit via idx_tool_audit_grant.
    CREATE TABLE IF NOT EXISTS capability_grants (
      id                    TEXT    PRIMARY KEY,
      grant_key             TEXT    NOT NULL,
      subject_kind          TEXT    NOT NULL,
      subject_id            TEXT,
      capability_kind       TEXT    NOT NULL,
      connector_id          TEXT,
      capability_id         TEXT,
      tool_allow            TEXT    NOT NULL DEFAULT '["*"]',
      tool_deny             TEXT    NOT NULL DEFAULT '[]',
      mode                  TEXT    NOT NULL DEFAULT 'read',
      approval_policy       TEXT    NOT NULL DEFAULT 'risk',
      state                 TEXT    NOT NULL DEFAULT 'active',
      -- 'owner'    the runtime config already attaches this connector to this
      --            subject, so the authorization merely records what is already
      --            true. Never rendered as an edge: the tile IS that statement.
      -- 'operator' a human deliberately shared it. This is what draws an edge.
      origin                TEXT    NOT NULL DEFAULT 'operator',
      expires_at            INTEGER,
      spec_hash_pin         TEXT,
      tools_hash_pin        TEXT,
      call_ceiling_per_hour INTEGER,
      granted_by            TEXT,
      granted_at            INTEGER NOT NULL,
      revoked_at            INTEGER,
      revoked_reason        TEXT,
      tenant_id             TEXT,
      created_at            INTEGER NOT NULL,
      updated_at            INTEGER NOT NULL
    );
    CREATE UNIQUE INDEX IF NOT EXISTS uniq_capability_grants_key ON capability_grants (grant_key);
    CREATE INDEX IF NOT EXISTS idx_grants_subject    ON capability_grants (subject_kind, subject_id);
    CREATE INDEX IF NOT EXISTS idx_grants_connector  ON capability_grants (connector_id);
    CREATE INDEX IF NOT EXISTS idx_grants_capability ON capability_grants (capability_id);
    CREATE INDEX IF NOT EXISTS idx_grants_state      ON capability_grants (state);
    CREATE INDEX IF NOT EXISTS idx_grants_expires    ON capability_grants (expires_at);

    -- ── approval_rules: durable allow_always, BOUND to a grant ──────────────
    -- priorAllowAlways (src/governance/approvalScope.ts) already ships a durable
    -- remembered-approval reader, so this table has to justify itself by what it
    -- ADDS: an args-shape binding, a cascade-revoke with its grant, and an expiry.
    --
    -- expires_at is NOT NULL on purpose. The rule matcher treats a NULL expiry
    -- as an IMMORTAL rule, so "every remembered approval expires" is a policy the
    -- column enforces or nothing does.
    CREATE TABLE IF NOT EXISTS approval_rules (
      id                       TEXT    PRIMARY KEY,
      rule_key                 TEXT    NOT NULL,
      grant_id                 TEXT    NOT NULL,
      tool_name                TEXT    NOT NULL,
      args_shape               TEXT,
      decision                 TEXT    NOT NULL,
      created_from_approval_id TEXT,
      expires_at               INTEGER NOT NULL,
      tenant_id                TEXT,
      created_at               INTEGER NOT NULL
    );
    CREATE UNIQUE INDEX IF NOT EXISTS uniq_approval_rules_key    ON approval_rules (rule_key);
    CREATE INDEX IF NOT EXISTS        idx_approval_rules_grant   ON approval_rules (grant_id);
    CREATE INDEX IF NOT EXISTS        idx_approval_rules_expires ON approval_rules (expires_at);`

/**
 * Bring the database up to the schema above, so the file is immediately usable
 * without a separate migration step. Two phases, in this order:
 *
 *  1. `reconcileSchema` adds any column an ALREADY-EXISTING table is missing. On a
 *     fresh database this is a no-op, because there are no tables yet.
 *  2. the DDL batch creates everything absent: new tables, indexes, triggers.
 *
 * The order is load-bearing, not stylistic. A new column normally ships with an
 * index over it, and `CREATE INDEX IF NOT EXISTS … ON t (new_col)` fails with
 * "no such column" if the batch runs before the column exists. That takes the
 * whole batch, and the boot, with it.
 *
 * Idempotent: every statement is `IF NOT EXISTS` and the reconcile is a diff, so a
 * re-run against an already-bootstrapped database changes nothing (just not for
 * free), which is why a long-lived server runs it once at boot rather than per
 * connection.
 *
 * BOTH phases run in ONE transaction, because SQLite DDL is transactional. So a
 * failure anywhere (an un-addable column found late, an index the new data cannot
 * satisfy, a lock that outlasts its retry) leaves the file exactly as it was
 * rather than half-upgraded, and the next start retries from a known state.
 *
 * Returns what the reconcile changed. `added` is empty on a fresh database and on
 * every steady-state boot, and non-empty exactly once: on the boot that follows an
 * upgrade. Throws `SchemaUpgradeError` when a missing column can never be added
 * (see `unaddableReason`); the server treats that as fatal rather than serving a
 * database whose every query would fail.
 *
 * The batch goes through the raw better-sqlite3 client on purpose: it is a
 * MULTI-statement string, and drizzle's `run()` prepares a single statement.
 */
export function ensureSchema(db: ClawbooDb): SchemaReconcileReport {
  const apply = db.$client.transaction((): SchemaReconcileReport => {
    const report = reconcileSchema(db, SCHEMA_DDL)
    db.$client.exec(SCHEMA_DDL)
    return report
  })
  // BEGIN IMMEDIATE, so the write intent is taken before the reconcile reads and the
  // diff cannot be built against a snapshot a concurrent commit then invalidates.
  // The retry is at the TRANSACTION level because that is the only level a lock
  // error can be cleared from. See `retryOnBusy`, and `immediateWrite` in
  // board/contention.ts, which is the same posture for the board's writes.
  const report = retryOnBusy(() => apply.immediate())
  noteSchemaBootstrap()
  return report
}

/**
 * Columns the DDL declares that an existing table does not have. Empty after a
 * successful `ensureSchema`; a non-empty result means a query touching one of them
 * would fail at runtime, which is why the boot probe checks it rather than trusting
 * that the bootstrap ran.
 */
export function missingSchemaColumns(db: ClawbooDb): AddedColumn[] {
  return findMissingColumns(db, SCHEMA_DDL)
}

/**
 * The column set the DDL above declares, per table. Deliberately NOT on the package
 * barrel: its one consumer is `schemaReconcile.test.ts`, which asserts this is
 * identical to what SQLite actually creates from the same DDL. That assertion is
 * what makes parsing the DDL safe: a construct the parser cannot read fails the
 * build instead of silently shrinking the set of columns the reconciler knows about.
 */
export function declaredSchemaColumns(): Map<string, SchemaColumn[]> {
  return parseDdlColumns(SCHEMA_DDL)
}
