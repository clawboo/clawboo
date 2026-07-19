---
title: Data and state
description: Where Clawboo stores everything, how to back it up, and how the hard-reset model works.
---

Use this page when you need to find Clawboo's data, back it up, move it, or wipe it. Clawboo keeps **all** of its own state under one directory (`~/.clawboo` by default). It also _reads_ OpenClaw's directory (`~/.openclaw`) for interop, but never writes there.

There is no migration ladder. The SQLite schema is bootstrapped from inline `CREATE TABLE IF NOT EXISTS` DDL on every connect, so the reset model is "delete the database file"; see [Hard reset](#hard-reset). This is intentional for the pre-1.0 single-user product.

## The state directory

Clawboo's own state lives under `resolveClawbooDir()`, which defaults to `~/.clawboo`. The `CLAWBOO_HOME` environment variable overrides the location (it expands a leading `~` and resolves to an absolute path), useful for test sandboxes or running multiple isolated instances.

```bash
# default
~/.clawboo/

# override
CLAWBOO_HOME=/data/clawboo clawboo
```

Every file Clawboo owns:

| Path (under `~/.clawboo/`)         | What it is                                                                                                                                | Resolved by                    |
| ---------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------ |
| `clawboo.db`                       | The SQLite database, the agent registry of record, board, memory, chat history, settings, governance, the event log, and more (27 tables) | `getDbPath()`                  |
| `clawboo.db-wal`, `clawboo.db-shm` | SQLite Write-Ahead Log sidecars (created automatically; see [WAL files](#wal-files))                                                      | SQLite (WAL mode)              |
| `settings.json`                    | Gateway URL + token, optional studio access token, first-run dismissal timestamp                                                          | `resolveSettingsPath()`        |
| `api-port.txt`                     | The port the running server bound to (a discovery hint for the CLI and the Vite proxy)                                                    | `getApiPortFilePath()`         |
| `proxy-device-identity.json`       | The proxy's persistent Ed25519 device identity (holds a **private** key; mode `0600`)                                                     | `getProxyDeviceIdentityPath()` |
| `gateway.pid`                      | PID of the managed OpenClaw Gateway process (when Clawboo started it for you)                                                             | `getGatewayPidPath()`          |
| `secrets/master.key`               | 32-byte AES-256-GCM master key for the credential vault (mode `0600` inside a `0700` dir)                                                 | `getVaultPaths()`              |
| `secrets/runtime-keys.json`        | The encrypted runtime/provider API-key vault, ciphertext only, keyed by env-var name                                                      | `getVaultPaths()`              |
| `worktrees/<repo-hash>/`           | Per-task git worktrees (the worktree system-of-record), grouped by a hash of the repo path                                                | `worktreeRootForRepo()`        |
| `reviews/<repo-hash>/`             | Detached read-only review checkouts used by the verification critic                                                                       | `reviewRootForRepo()`          |

<Note>
The Express server (and the entire web app) reads and writes `~/.clawboo/clawboo.db`. The `defaultDbPath()` helper in `@clawboo/db` resolves a *different* path (`~/.openclaw/clawboo/clawboo.db`) and is only used by the out-of-process MCP stdio bins; see [The database path](#the-database-path).
</Note>

## OpenClaw interop (read-only)

Clawboo reads two files from OpenClaw's state directory for interop and **never writes to `~/.openclaw`**. The directory resolves via `resolveStateDir()`; `OPENCLAW_STATE_DIR` overrides it; otherwise it is `~/.openclaw`.

| Path (under `~/.openclaw/`) | Why Clawboo reads it                                                                                                                       |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| `openclaw.json`             | Gateway URL + auth token defaults when Clawboo's own `settings.json` has no usable token                                                   |
| `.env`                      | Lowest-priority fallback for a runtime provider key (e.g. an existing `ANTHROPIC_API_KEY` auto-satisfies `claude-code` / `clawboo-native`) |

Backing up or resetting `~/.clawboo` never touches OpenClaw's data. The two directories are independent.

## The database

`clawboo.db` is a single SQLite file holding **27 tables**. There is no separate Postgres, no external store, no migration ladder. The schema is applied by `createDb()`, which runs an inline `CREATE TABLE IF NOT EXISTS` block on every connection; that DDL is the _sole_ source of truth for the schema (the Drizzle `schema.ts` is the typed query layer over the same tables, never used to apply migrations). See the [database schema reference](/reference/database-schema) for the full table list and ERD.

### The database path

The path you back up is `~/.clawboo/clawboo.db`. Two resolvers exist, for two consumers:

- **`getDbPath()`** (`apps/web/server/lib/db.ts`) → `~/.clawboo/clawboo.db` via `resolveClawbooDir()`. This is the path the **Express server** uses everywhere. It honors `CLAWBOO_HOME`.
- **`defaultDbPath()`** (`@clawboo/db`) → `~/.openclaw/clawboo/clawboo.db`, with a `CLAWBOO_DB_PATH` override. This is used **only** by the MCP stdio bins (`clawboo-mcp-tasks`, `clawboo-mcp-memory`, `clawboo-mcp-tools`, `clawboo-mcp-teamchat`) that an external runtime may spawn out of process.

<Info>
The two resolvers default to different paths. If an external runtime spawns a Clawboo MCP stdio bin and you want it to read the same database the server serves, set `CLAWBOO_DB_PATH` to the server's actual `clawboo.db` so both processes open one file. The multi-process WAL recipe (below) is what keeps concurrent access safe.
</Info>

### WAL files

`createDb()` opens the database in WAL (Write-Ahead Logging) mode with this pragma set:

```ts
journal_mode = WAL
foreign_keys = ON
synchronous = NORMAL
busy_timeout = 1000 // wait up to 1s for the write lock
wal_autocheckpoint = 50 // keep the WAL lean (~50-page passive checkpoints)
```

WAL mode creates two sidecar files next to the database:

- `clawboo.db-wal`: the write-ahead log (recent writes not yet checkpointed into the main file).
- `clawboo.db-shm`: shared-memory coordination for concurrent readers/writers.

Both are normal SQLite artifacts. They matter for backups (below).

## Back up your data

Everything recoverable lives in `~/.clawboo`. A copy of the whole directory is a complete backup, and the simplest one.

### Quick backup (whole state dir)

Stop the server first so writes are quiesced, then copy the directory:

```bash
# stop the running Clawboo server (Ctrl-C in its terminal), then:
cp -a ~/.clawboo ~/clawboo-backup-$(date +%Y%m%d)
```

This captures the database, settings, the encrypted vault (and its master key), the device identity, and any worktrees.

### Database-only backup

To back up just the data tables, copy the database **plus its WAL sidecars**. With WAL mode, recent writes may still live in `clawboo.db-wal`; copying only the main file can miss them.

```bash
# stop the server first, then copy all three:
cp ~/.clawboo/clawboo.db     ~/clawboo.db.bak
cp ~/.clawboo/clawboo.db-wal ~/clawboo.db-wal.bak 2>/dev/null || true
cp ~/.clawboo/clawboo.db-shm ~/clawboo.db-shm.bak 2>/dev/null || true
```

<Tip>
If you have the `sqlite3` CLI, the most robust single-file backup is `sqlite3 ~/.clawboo/clawboo.db ".backup '/path/to/clawboo.db.bak'"`, which runs an online, checkpoint-consistent copy and produces one file with no separate WAL.
</Tip>

<Danger>
The vault is useless without its master key, and the master key is useless without the vault. If you back up `secrets/runtime-keys.json` you **must** also back up `secrets/master.key` (or set `CLAWBOO_SECRETS_MASTER_KEY` to a key you control). A wrong, rotated, or lost master key fails closed; saved runtime provider keys cannot be decrypted, and you re-enter them in the Runtimes panel. See [Security](/operating/security).
</Danger>

### Restore

Restore by copying the files back into `~/.clawboo` (with the server stopped). If you restore a database-only backup, restore the WAL sidecars too, or delete a stale `clawboo.db-wal` / `clawboo.db-shm` so SQLite re-creates them clean against the restored main file.

## Hard reset

There is no schema migration step. A schema change in Clawboo is a hard reset of the local database; `createDb()` re-bootstraps every table on the next connect. So "reset" means **delete the database file**.

### Reset just the data (keep credentials and settings)

```bash
# stop the server first, then delete the DB and its WAL sidecars:
rm -f ~/.clawboo/clawboo.db ~/.clawboo/clawboo.db-wal ~/.clawboo/clawboo.db-shm
```

The next time the server starts, `createDb()` recreates an empty, fully-bootstrapped schema. Your `settings.json` and the secrets vault are untouched.

### Full reset (everything)

The clean-slate remedy, also what the boot probe recommends after a fatal failure, is to remove the whole state directory and re-run onboarding:

```bash
rm -rf ~/.clawboo
clawboo
```

<Warning>
A full reset deletes your saved provider keys (the vault and its master key), the proxy device identity, all teams/agents/board/chat/memory data, and any task worktrees. This is safe for a pre-1.0 single-user install but is **destructive**; back up first if any of it matters.
</Warning>

## How boot health checks your data

On every start (and from the System Health surface via `GET /api/health`), Clawboo runs a **boot probe** that reports a per-check verdict. Two of its checks concern your data, and they are the only two checks that are **fatal** (the server cannot run without them); everything else _degrades_ (the server keeps serving and shows a banner):

| Check id                | What it does                                                                                              | Verdict                                                  |
| ----------------------- | --------------------------------------------------------------------------------------------------------- | -------------------------------------------------------- |
| `clawbooHomeWritable`   | `mkdir -p` the state dir and assert write access                                                          | **Fatal** if not writable                                |
| `databaseIntegrity`     | `PRAGMA integrity_check`; `ok` is healthy; any other string is corruption                                 | **Fatal** if the file can't be opened or fails the check |
| `databaseSchema`        | Confirm the core tables exist (`teams`, `agents`, `settings`, `budgets`, `orchestration_events`, `tasks`) | Degrades if any are missing                              |
| `vaultPerms`            | Assert `secrets/` is `0700` and `master.key` / `proxy-device-identity.json` are `0600` (POSIX only)       | Degrades if perms are too open                           |
| `masterKeyBootSentinel` | Encrypt a sentinel on first boot, decrypt it on every later boot to prove the master key still works      | Degrades if the key changed                              |

Because a fatal boot failure means a broken install (a corrupt DB, or an unwritable home), the documented remedy is the [full reset](#full-reset) above. There is deliberately no repair/upgrade path; re-running onboarding against a clean `~/.clawboo` is the supported recovery.

## Verify it worked

- After a reset, start the server and open System Health (`GET /api/health`). `databaseIntegrity` and `databaseSchema` should pass; the report's `resolved.dbPath` should point at your expected `clawboo.db`.
- After a backup/restore, confirm `clawboo.db` is present at `resolved.dbPath` and the integrity check passes.
- After setting `CLAWBOO_HOME`, the boot report's `resolved.clawbooHome` and `resolved.dbPath` reflect the override.

## Troubleshooting

<Warning>
**A database-only backup looks empty or stale.** WAL mode buffers recent writes in `clawboo.db-wal`. Copy all three files (`.db`, `.db-wal`, `.db-shm`) together, or use `sqlite3 ... ".backup"` for a single consistent file. Never copy `clawboo.db` alone while the server is running.
</Warning>

<Warning>
**The MCP stdio bin opens a different (empty) database.** `defaultDbPath()` resolves to `~/.openclaw/clawboo/clawboo.db`, not `~/.clawboo/clawboo.db`. Point the bin at the server's database with `CLAWBOO_DB_PATH`.
</Warning>

<Danger>
**System Health shows `master key changed`.** The master key no longer decrypts the vault sentinel. If you rotated or lost `secrets/master.key` (or changed `CLAWBOO_SECRETS_MASTER_KEY`), saved runtime keys are unrecoverable; re-enter them in the Runtimes panel, or do a [full reset](#full-reset).
</Danger>

## See also

- [Configuration](/reference/configuration): `settings.json`, file and directory locations
- [Environment variables](/reference/environment-variables): `CLAWBOO_HOME`, `CLAWBOO_DB_PATH`, `CLAWBOO_SECRETS_MASTER_KEY`, `OPENCLAW_STATE_DIR`
- [Database schema](/reference/database-schema): the 27 tables and ERD
- [Security](/operating/security): the encrypted vault, redaction, and safe exposure
- [Deployment](/operating/deployment): ports, the bundled server, and the CLI
