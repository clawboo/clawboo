---
title: '@clawboo/db'
sidebarTitle: 'db'
description: 'The SQLite data layer: who owns the schema, how a database opens and upgrades, the two default file paths, the repository modules, and the rules for writers.'
keywords:
  [
    '@clawboo/db',
    'db',
    'sqlite',
    'drizzle',
    'schema',
    'ensureSchema',
    'reconciler',
    'migrations',
    'CLAWBOO_DB_PATH',
    'rooms',
    'grants',
    'memory graph',
    'withWriteRetry',
  ]
---

`@clawboo/db` is the only package that reads or writes Clawboo's SQLite database. It declares the schema, opens
and upgrades the file, and holds every repository: the board, chat rooms, memory, the tool broker, connector
grants, budgets, the event log and more.

Use this page when you add a table or a column, write to the database, or need to know which module owns a piece
of state. Each table is documented on [Database schema](/reference/database-schema).

## Who uses it

- **The server** (`apps/web/server`), through one shared connection.
- **`@clawboo/mcp`**, whose servers run inside the server and whose stdio bins open their own connection.
- **`@clawboo/evals`**, which builds a throwaway database for every trial.
- **The SPA**, for types only. Its entry point pulls in `better-sqlite3`, so
  `apps/web/src/__tests__/browserBundlePurity.test.ts` fails on any value import of `@clawboo/db` in the browser.

## Who owns the schema

`SCHEMA_DDL` in `src/schemaBootstrap.ts` is the only place tables, indexes and triggers are created, and every
statement in it is `IF NOT EXISTS`. `src/schema.ts` is the Drizzle type layer over the same tables: queries use it,
nothing applies it as a migration, and `schemaSource.test.ts` keeps the two in step.

The package entry point re-exports a Drizzle table object and its row types for almost every table. Two stay
internal behind their accessors: `agent_inbox` (use `enqueueInbox` and the other inbox functions) and
`tool_result_blobs` (use `putToolResult` and `readToolResult`).

## Opening a database

| Function           | Use it for            | What it does                                                                                                                                                |
| ------------------ | --------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `openDb(path)`     | a long-lived process  | Creates the folder, opens the file, applies the pragmas (WAL, foreign keys, a short busy timeout) and limits the file and folder to your user. Runs no DDL. |
| `ensureSchema(db)` | right after `openDb`  | Upgrades the file to the schema in one `BEGIN IMMEDIATE` transaction, then returns `{ added }`, the columns it added.                                       |
| `createDb(path)`   | short-lived processes | `openDb` plus `ensureSchema`. The stdio bins and the eval harness use it.                                                                                   |

Server code never calls these. It calls `getDb()` from `apps/web/server/lib/db.ts`, which opens one connection per
process, runs `ensureSchema` once at boot, and is closed only by `closeDb()` on exit. `sharedConnection.test.ts`
fails if server code opens its own connection. better-sqlite3 is synchronous, so one connection is not a
bottleneck.

## Where the file lives

The server and the stdio bins default to different files, on purpose:

- **The server** keeps its database at `~/.clawboo/clawboo.db`, which moves with `CLAWBOO_HOME`.
- **`defaultDbPath()`**, which the stdio bins use, returns `CLAWBOO_DB_PATH` when it is set, else
  `~/.openclaw/clawboo/clawboo.db`.

A bin you start by hand therefore opens a separate, empty board. Set `CLAWBOO_DB_PATH` to the server's file, or use
the attach snippet from `GET /api/mcp/config`, which sets it for you. Clawboo's own Claude Code, Codex and Hermes
runs reach the MCP servers over HTTP inside the server process, so they always use the server's file. WAL mode
makes the shared file safe for several processes. See [Data and state](/operating/data-and-state) and
[MCP servers](/operating/mcp-servers).

## Upgrading the schema

There is no migration ladder: no numbered migration files, no `user_version`, no migrate script. `ensureSchema`
runs two phases in one transaction. First the reconciler reads the column list back out of `SCHEMA_DDL` and adds
any column an existing table is missing. Then the DDL batch creates whatever tables, indexes and triggers are
absent. A failure anywhere leaves the file as it was, and the next start tries again.

A new column on an existing table must be one SQLite can add to a table that already has rows: no `PRIMARY KEY`
or `UNIQUE`, no stored generated column, a literal default, a default whenever it is `NOT NULL`, and no non-null
default on a `REFERENCES` column. `schemaReconcile.test.ts` checks every new column against the frozen snapshot in
`schemaBaseline.ts`, so a column that breaks the rules fails the build instead of a user's upgrade. A column that
still cannot be added at boot throws `SchemaUpgradeError`, which the server treats as fatal.

These changes are not in-place upgrades: changing an existing column's type, `NOT NULL` or default, removing a
column, adding a table constraint, redefining an index or trigger (they match by name), and any change to the FTS5
table. Plan those separately. The upgrade rules are also covered in [Database schema](/reference/database-schema).

To add a table, add its `CREATE TABLE IF NOT EXISTS` statement to `SCHEMA_DDL`, its declaration to `src/schema.ts`,
its exports to `src/index.ts` and repository functions to the module that owns it, then document it on the schema
page. `pnpm --filter @clawboo/db test` runs the schema guards.

## The repository modules

Everything is exported from the package entry point; the source folders below are where to look and where to add.

| Module (`src/`)  | Owns                                                                                   | Main entry points                                                                                                                                                               | More                                                   |
| ---------------- | -------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------ |
| `board/`         | tasks, dependencies, comments, execution runs, the board's lifecycle events            | `createTask`, `createCappedSubtask`, `claimTask`, `updateStatus`, `releaseTask`, `linkDep`, `getReadyTasks`, `startTaskHeartbeat`, `reconcileOrphans`, `onBoardLifecycle`       | [Board internals](/internals/board-internals)          |
| `board/rooms.ts` | a team's chat rooms                                                                    | `createRoom`, `listRooms`, `setRoomMembers`, `archiveRoom`, `activeRoomMemberIds`                                                                                               | [Work with your team in chat](/using/team-chat)        |
| `memory/`        | facts, procedures, outcome reports, embeddings, the memory graph                       | `SqliteMemoryStore` (`saveFact`, `searchMemory`, `browseMemory`, `recordOutcome`, `getMemoryGraph`), `computeLearningOverlay`, `projectMemoryGraph`, `resolveEmbeddingProvider` | [Memory](/concepts/memory)                             |
| `tools/`         | the tool registry, the brokered call pipeline, approvals and audit, large tool results | `executeBrokeredCall`, `createBuiltinRegistry`, `runInspectors`, `evaluateInjection`, `putToolResult`, `readToolResult`, `scrubSecrets`                                         | [Tools and MCP API](/reference/rest-api/tools-and-mcp) |
| `grants/`        | connectors, capability grants, standing approval rules, per-grant rate windows         | `upsertConnector`, `upsertGrant`, `listCandidateGrants`, `revokeGrant`, `mintStandingRule`, `chargeCall`, `previewGrant`                                                        | [governance](/reference/packages/governance)           |
| `capabilities/`  | the stored capability inventory                                                        | `upsertCapabilities`, `listCapabilities`, `getCapability`                                                                                                                       | [Capabilities](/concepts/capabilities)                 |
| `governance/`    | budgets and the governance audit log                                                   | `recordSpend`, `setBudgetLimit`, `getBudget`, `resumeBudget`, `appendAudit`, `priorAllowAlways`                                                                                 | [Budgets and guardrails](/concepts/governance)         |
| `events/`        | the append-only orchestration event log                                                | `appendEvent`, `listEvents`                                                                                                                                                     | [Events and errors](/reference/events-and-errors)      |
| `sessions/`      | session rotation lineage                                                               | `recordRotation`, `getSessionLineage`                                                                                                                                           | [The executor runner](/internals/executor-runner)      |
| `routines/`      | the routines ledger and fire history                                                   | `registerScheduledRun`, `queueDueRuns`, `claimScheduledRun`, `recordRunOutcome`, `listRoutineFires`                                                                             | [scheduler](/reference/packages/scheduler)             |
| `teamChat/`      | the agents' peer channel (`team_chat`), which TeamChat MCP tools post to               | `postToRoom`, `readRoom`, `resolveRoomForTeam`                                                                                                                                  | [How agents talk to each other](/concepts/peer-chat)   |
| `inbox.ts`       | each agent's mailbox of updates, alerts and signals                                    | `enqueueInbox`, `listUndeliveredInbox`, `packInboxRows`, `markInboxDelivered`, `reapOrphanInbox`                                                                                | [The executor runner](/internals/executor-runner)      |
| `chat/`          | the dashboard's chat transcript (`chat_messages`)                                      | `listRecentChatMessages`, `listChatMessagesSince`, `latestChatMessageId`                                                                                                        | [Work with your team in chat](/using/team-chat)        |

A few modules carry rules worth knowing before you change them:

- **Rooms.** A team's own chat is its default room and has no row; its room id is `null`. A room's live roster is
  its stored members intersected with the team's active agents, so an archived or moved agent drops out without a
  sweep.
- **Grants.** `grants/` is the stored half of connector permissions: the rows, their uniqueness keys, the spec
  digests that drift is measured against, and the hourly call counter. The decision itself is the pure
  `decideGrant` in `@clawboo/governance`, which the broker's grant gate calls for every connector tool call.
- **The broker.** `executeBrokeredCall` runs one pipeline for the Tools MCP server and REST callers: availability,
  provenance (off by default), argument validation, the grant gate (connector tools only), the inspector chain,
  approval when required, execution, then compaction of the result. Every path writes audit rows with secrets
  scrubbed. Inspectors return `allow`, `deny`, `require_approval`, `rewrite` or `observe` (allow, but record what a
  stricter reading would have refused).
- **Memory.** `searchMemory` runs hybrid search when an embedding provider is available and falls back to keyword
  search when there is none. Outcome reports (`useful`, `dead_end`, `corrected`, `cited`) feed the learning
  overlay, which never rewrites a fact. The graph projection is pure and deterministic, so the same data always
  draws the same graph.
- **Embeddings.** The provider order is an explicit provider, then a local Ollama that has the embedding model, then
  OpenAI when a key allows it. A store that was ever indexed locally needs the user's consent before it embeds
  remotely, and `CLAWBOO_DISABLE_EMBEDDINGS=1` turns embeddings off.

## Rules for writers

- **Write through the contention helpers.** Use `immediateWrite` (a `BEGIN IMMEDIATE` transaction) or
  `withWriteRetry`. They retry lock errors with jitter inside a wall-clock budget (`CLAWBOO_DB_WRITE_BUDGET_MS`),
  then throw `WriteBudgetExhaustedError`, which still reads as busy. The recipe is on
  [Board internals](/internals/board-internals).
- **Never retry a lost claim.** `claimTask` returns `conflict` when another worker won. That is an answer, not an
  error.
- **Change status through `updateStatus`.** It enforces the `@clawboo/board-core` transition table inside the write
  transaction and refuses `done` with `verification_required` for a task whose verdict does not allow it, unless
  the caller passes `humanOverride`.
- **Publish after commit.** Board lifecycle events reach `onBoardLifecycle` subscribers only after the transaction
  commits, so a subscriber never sees a write that rolled back.
- **Mark only what was delivered.** After `packInboxRows`, mark delivered only the row ids it reported as included.
- **Scrub before storing.** Tool arguments, results and event payloads pass through `scrubSecrets`, which replaces
  credential-looking values with `[REDACTED]`.
- **Budgets default to warn.** `setBudgetLimit` creates a budget in `mode: 'warn'` unless the caller passes
  `mode: 'cap'`. Updating a budget without `mode` keeps the mode it has, so re-setting a hard cap's limit keeps it a
  hard cap.

`pnpm --filter @clawboo/db db:studio` opens Drizzle Studio on the development file `packages/db/dev.db`, never on
your real database.

## Related

- [Database schema](/reference/database-schema): every table, column and index.
- [Board internals](/internals/board-internals): the state machine, the atomic claim and the contention recipe.
- [Data and state](/operating/data-and-state): where the files live, backups and resets.
- [@clawboo/governance](/reference/packages/governance): the pure decisions these tables record.
- [@clawboo/mcp](/reference/packages/mcp): the MCP servers built on these repositories.
