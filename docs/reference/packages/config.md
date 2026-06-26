---
title: '@clawboo/config'
description: 'Settings loader and persistence for Clawboo: resolves state dirs, env overrides, and OpenClaw config fallback.'
---

- **Version** 0.1.0 · **Purity** server-only (uses `node:fs` / `node:os` / `node:path`)
- **Purpose** Resolve Clawboo's state directories, load/save `settings.json`, and bridge OpenClaw's config for gateway URL + token + provider keys.
- **Workspace deps** none
- **External deps** none (Node built-ins only)

<Note>
Server-only. The functions read and write the filesystem (`os.homedir()`, `fs.readFileSync`/`writeFileSync`), so this package never runs in the browser. Every function takes an optional `env` parameter (defaults to `process.env`) so callers can sandbox path resolution.
</Note>

## Public API

All exports come from the single `.` barrel (`src/index.ts`). No subpath exports.

### Functions

| Export                | Signature                                                              | Contract                                                                                                                                                                                                                                                                             |
| --------------------- | ---------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `resolveStateDir`     | `(env?: NodeJS.ProcessEnv) => string`                                  | Locate the **OpenClaw** state dir. Honors `OPENCLAW_STATE_DIR` / `MOLTBOT_STATE_DIR` / `CLAWDBOT_STATE_DIR` (with `~` expansion), else probes `~/.openclaw` then legacy `~/.clawdbot` / `~/.moltbot`, falling back to `~/.openclaw`. Read-only interop; Clawboo never writes here.   |
| `resolveClawbooDir`   | `(env?: NodeJS.ProcessEnv) => string`                                  | Clawboo's OWN state dir (the SQLite DB, settings, secrets vault, worktrees, proxy identity, api-port file, managed gateway PID). Honors `CLAWBOO_HOME` (with `~` expansion), else defaults to `~/.clawboo`.                                                                          |
| `resolveSettingsPath` | `(env?: NodeJS.ProcessEnv) => string`                                  | Absolute path to `settings.json`: `resolveClawbooDir(env)/settings.json`.                                                                                                                                                                                                            |
| `readOpenclawEnvVar`  | `(varName: string, env?: NodeJS.ProcessEnv) => string \| null`         | Read one variable from OpenClaw's `<stateDir>/.env`. Interop-only lowest-priority provider-key fallback (e.g. reuse an existing `ANTHROPIC_API_KEY`). The single `.env` parser; do not add a second.                                                                                 |
| `loadSettings`        | `(env?: NodeJS.ProcessEnv) => ClawbooSettings`                         | Read `settings.json`, resolve `${VAR}` template tokens (process env → state-dir `.env`), and fall back to OpenClaw's `openclaw.json` gateway defaults when no token is present. `gatewayUrl` defaults to `ws://localhost:18789`. Never throws; corrupt/missing files yield defaults. |
| `saveSettings`        | `(updates: Partial<ClawbooSettings>, env?: NodeJS.ProcessEnv) => void` | Deep-merge `updates` into `settings.json` (creates the dir if absent). Gateway fields nest under `gateway.url` / `gateway.token`; `studioAccessToken` + `firstRunDismissedAt` are top-level. Only writes keys present in `updates`.                                                  |

### Types & interfaces

| Export            | Shape                                                                                                    | Contract                                                                                                                                                                         |
| ----------------- | -------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ClawbooSettings` | `{ gatewayUrl: string; gatewayToken: string; studioAccessToken?: string; firstRunDismissedAt?: number }` | The settings record returned by `loadSettings` and accepted (partial) by `saveSettings`. `firstRunDismissedAt` is the epoch-ms timestamp the user dismissed the first-run nudge. |

### Classes

None.

### Constants

None exported. Internal-only: `DEFAULT_GATEWAY_URL` (`ws://localhost:18789`), the state-dir names, and the OpenClaw config filename are module-private.

## Used by

- **`@clawboo/gateway-proxy`**; `proxy-device-auth.ts` resolves the proxy device-identity location via `resolveClawbooDir`.
- **`apps/cli`**, port discovery / state-dir resolution.
- **`apps/web` (server)**; `settings.ts`, `system.ts`, `index.ts`, `lib/db.ts`, `lib/portUtils.ts`, `lib/processManager.ts`, `lib/secretsVault.ts`, `lib/bootProbe.ts`, `lib/worktrees.ts`, `lib/agentSource/registry.ts`, `lib/runtimes/identityHome.ts`, and `lib/capabilitySource/hermes.ts` all resolve paths and load settings through this package.

## Source

Barrel: [`packages/config/src/index.ts`](https://github.com/clawboo/clawboo/blob/main/packages/config/src/index.ts)

## See also

- [Configuration reference](/reference/configuration), `settings.json` shape + file/dir locations
- [Environment variables](/reference/environment-variables), `CLAWBOO_HOME`, `OPENCLAW_STATE_DIR`, and the rest
- [Data and state](/operating/data-and-state), SQLite, file locations, backup/reset
- [`@clawboo/gateway-proxy`](/reference/packages/gateway-proxy), the primary package consumer
