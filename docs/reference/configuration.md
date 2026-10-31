---
title: 'Configuration reference'
sidebarTitle: 'Configuration'
description: 'Where Clawboo keeps each setting: environment variables, settings.json, the database settings table, your browser, ~/.clawboo files and ~/.openclaw.'
keywords:
  [
    'settings.json',
    'studioAccessToken',
    'CLAWBOO_HOME',
    'state directory',
    'secrets vault',
    'openclaw.json',
    'auth-profiles.json',
  ]
---

Clawboo spreads its configuration over a few places. Use this page to find where a setting lives, how to change it, and which files Clawboo reads or writes.

| Where                                           | What it holds                                                     | How you change it                                                                            |
| ----------------------------------------------- | ----------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| Environment variables                           | Bind address, ports, access token, URL prefix, folders, tuning    | Your shell or service manager; see [Environment variables](/reference/environment-variables) |
| `~/.clawboo/settings.json`                      | The OpenClaw Gateway URL and token, and the first-run flag        | The dashboard's Gateway and OpenClaw setup, or by hand                                       |
| The `settings` table in `~/.clawboo/clawboo.db` | Most dashboard settings, such as the default model and team rules | The dashboard                                                                                |
| Your browser's local storage                    | View preferences such as the theme and sidebar width              | The dashboard, separately in each browser                                                    |
| `~/.clawboo/secrets/`                           | Provider keys and connector secrets, encrypted                    | **Settings > Providers**, **Settings > Runtimes**, Connectors                                |
| `~/.openclaw/`                                  | OpenClaw's own configuration, part of which Clawboo writes        | OpenClaw, or the dashboard                                                                   |

`~/.clawboo` is the default for `CLAWBOO_HOME` and `~/.openclaw` the default for `OPENCLAW_STATE_DIR`; every path under them on this page moves with them. The `~/.codex`, `~/.hermes` and `~/.claude` paths below do not.

## settings.json

`<CLAWBOO_HOME>/settings.json` holds the connection to your OpenClaw Gateway. Clawboo creates it the first time it saves a setting; a missing or unreadable file means the defaults apply.

```json
{
  "gateway": {
    "url": "ws://localhost:18789",
    "token": "your-gateway-token"
  },
  "firstRunDismissedAt": 1717286400000
}
```

| Key                   | Type   | Default                | Meaning                                                                              |
| --------------------- | ------ | ---------------------- | ------------------------------------------------------------------------------------ |
| `gateway.url`         | string | `ws://localhost:18789` | The Gateway's WebSocket URL. Through the API it must start with `ws://` or `wss://`. |
| `gateway.token`       | string | empty                  | The Gateway's auth token. `GET /api/settings` never returns it, only `hasToken`.     |
| `firstRunDismissedAt` | number | unset                  | When you dismissed the first-run nudge, in milliseconds since 1970.                  |

How the token is resolved:

1. A value written as a template, such as `${GATEWAY_AUTH_TOKEN}`, is read from the server's environment first, then from OpenClaw's `~/.openclaw/.env`.
2. With no usable token, Clawboo falls back to OpenClaw's `openclaw.json` (`gateway.auth.token` and `gateway.port`). It uses that token and, when `settings.json` has no URL, connects to `ws://localhost:<port>`.
3. Otherwise the literal value is used.

The file is plain JSON, readable only by you (mode 0600). A folder Clawboo creates for it is owner-only (mode 0700); a folder that already exists keeps its mode. Saving a setting narrows an older file to 0600 first, and refuses to save when it cannot and the file is readable by others.

<Warning>
A `studioAccessToken` key in settings.json does nothing. The access gate reads only the `STUDIO_ACCESS_TOKEN` environment variable, so a token written here leaves the dashboard open. See [Environment variables](/reference/environment-variables) for the variable and its rules.
</Warning>

## Settings stored in the database

Most settings you change in the dashboard are rows in the `settings` table of `clawboo.db`, so they travel with a database backup.

| Setting                                                   | Where you change it                                                                            |
| --------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| Default Clawboo Native provider and model                 | Onboarding, or **Make default** in the Clawboo Native providers list (**Settings > Runtimes**) |
| Boo Zero's display name and global brief                  | Boo Zero's agent page, **Brief**                                                               |
| Team rules and your introduction to a team                | Team chat: `/rule`, the team's brief and rules sheet, the Know Your Team step                  |
| Whether memory may use OpenAI for embeddings              | Memory, when no local Ollama embedding model is available                                      |
| Custom connectors and connector arguments                 | Connectors                                                                                     |
| A Clawboo Native agent's model and tool switches          | The agent's page                                                                               |
| Agent files for agents that do not run on OpenClaw        | The agent's **Agent Files**                                                                    |
| Chat state: resume points, Clear chat times, leader state | Set automatically as you chat                                                                  |
| The secret that signs MCP attach URLs                     | Created automatically; it never leaves the server                                              |
| OpenClaw sync state and the tools Clawboo denies there    | Set automatically on each Gateway connection                                                   |

The table has no schema of its own beyond key and value; [Database schema](/reference/database-schema) describes it.

## Preferences stored in your browser

The theme, sidebar width and collapsed state, panel layout, Board view, Org chart layout and a few one-time flags live in your browser's local storage. They apply to one browser only, a database backup does not include them, and clearing the site's data resets them.

## Files under ~/.clawboo

Clawboo owns everything in this folder. The bundled server also runs with it as its working directory. [Data and state](/operating/data-and-state) explains what to back up, what is safe to delete, and how to reset.

| Path                                 | What it holds                                                                                 | Sensitive                       |
| ------------------------------------ | --------------------------------------------------------------------------------------------- | ------------------------------- |
| `clawboo.db`, `-wal`, `-shm`         | The database: agents, teams, board, chats, memory, settings, the event log                    | Yes                             |
| `settings.json`                      | The Gateway URL and token                                                                     | Yes                             |
| `secrets/master.key`                 | The key that decrypts the vault                                                               | Yes                             |
| `secrets/runtime-keys.json`          | Encrypted provider keys, connector secrets and sign-in tokens                                 | Encrypted                       |
| `secrets/disconnected-runtimes.json` | Which runtimes you disconnected                                                               | No                              |
| `secrets/keyless-providers.json`     | Whether you chose or removed keyless Ollama                                                   | No                              |
| `proxy-device-identity.json`         | The key pair Clawboo uses to sign in to the OpenClaw Gateway as a device                      | Yes                             |
| `api-port.txt`                       | The port the server listens on; removed at shutdown if it still names that port               | No                              |
| `server.log`, `server.log.1`         | Output of a server the CLI started                                                            | No                              |
| `gateway.log`, `gateway.pid`         | Output and process record of an OpenClaw Gateway that Clawboo started                         | No                              |
| `connector-pids.json`                | Connector processes Clawboo started, so leftovers from a crash are stopped at the next start  | No                              |
| `catalog/`                           | Verified marketplace packs, cached                                                            | No                              |
| `frames/`                            | Saved screenshots from agents' browsers                                                       | May show private pages          |
| `browser-profiles/`                  | Each agent's browser profile, including sites it is signed in to                              | Yes                             |
| `workspaces/<team id>/`              | Each team's shared folder, where runs without a worktree start; `_no-team` for teamless tasks | Holds what agents saved there   |
| `worktrees/`, `reviews/`             | Per-task git worktrees and review checkouts                                                   | No                              |
| `runtimes/<runtime>/<agent>/`        | Each Clawboo Native, Codex or Hermes agent's own runtime home                                 | May hold runtime sign-in copies |

The database files, `settings.json` and secrets are owner-only (mode 0600) in an owner-only folder (0700).

## Saved keys

Provider keys, connector secrets and sign-in tokens are encrypted with AES-256-GCM in `secrets/runtime-keys.json`, under the key in `secrets/master.key`. This protects a copied or synced vault file; a program running as your user can still read both files. To keep the key apart from the vault, set `CLAWBOO_SECRETS_MASTER_KEY`. If the key changes, saved keys read as missing and **System Health** reports that the master key changed.

A runtime looks for its key in this order: the server's environment, the vault, then OpenClaw's `~/.openclaw/.env`. After you disconnect a runtime on its card in **Settings > Runtimes**, that runtime uses only the vault until you connect it again. That disconnect deletes every vault key the runtime reads, including keys other runtimes share; [Providers and runtimes](/using/providers-and-runtimes) covers connecting and disconnecting.

<Warning>
Keys you add in **Settings > Providers**, or in OpenClaw's setup inside Clawboo, are also written in plain text to OpenClaw's `~/.openclaw/.env` and to each OpenClaw agent's `auth-profiles.json`, because the OpenClaw Gateway reads them there. Disconnecting the provider removes both copies. A key you enter on a runtime's own card in **Settings > Runtimes** stays only in the encrypted vault.
</Warning>

## OpenClaw files Clawboo reads and writes

Clawboo finds OpenClaw's folder from `OPENCLAW_STATE_DIR` (or the older `MOLTBOT_STATE_DIR` and `CLAWDBOT_STATE_DIR`), else the first of `~/.openclaw`, `~/.clawdbot` and `~/.moltbot` that exists, else `~/.openclaw`.

It reads:

- `openclaw.json`: the Gateway's port and token when `settings.json` has none, and the settings the **System** panel shows.
- `.env`: a fallback for provider keys and for `${NAME}` token templates.
- `agents/<id>/agent/auth-profiles.json`: which providers each OpenClaw agent has keys for.

It writes:

- **When you connect or disconnect a provider** in **Settings > Providers** or OpenClaw's setup: the key line in `.env` and the `<provider>:default` profile in every agent's `auth-profiles.json`.
- **When you set up OpenClaw** from the dashboard: `openclaw.json` and `.env` (the Gateway token, plus the provider key or `OLLAMA_API_KEY=ollama-local` for Ollama), and the Gateway URL and token in `settings.json`. With `OLLAMA_BASE_URL` set, the Ollama address goes into `openclaw.json` too.
- **When you change OpenClaw settings from the dashboard**: `openclaw.json`, and any keys you enter. That covers the **System** panel, OpenClaw's default model, an OpenClaw agent's model, and drawing a routing link on the Org chart, which turns on agent-to-agent messaging.
- **Each time it connects to the Gateway**: through the Gateway, it registers Clawboo's Memory, Tasks and Tools servers under `mcp.servers` and adds OpenClaw's sub-agent tools (`sessions_spawn`, `sessions_yield`) to `tools.deny`, alongside your own entries.
- **When the Gateway refuses to start** and asks for a repair: it runs `openclaw doctor --fix --non-interactive` once, then tries again.

Clawboo writes `.env` and each `auth-profiles.json` owner-only (mode 0600), narrowing an existing file first, and creates OpenClaw's folder owner-only (0700) when it does not exist.

Resetting `~/.clawboo` leaves all of these in place, so provider keys saved this way keep working for OpenClaw. `OPENCLAW_CONFIG_PATH` is not read; the config is always `openclaw.json` inside that folder.

## Other folders Clawboo reads

- `~/.codex/auth.json` (or `$CODEX_HOME/auth.json`): to see whether you signed in with `codex login`. Each Codex agent then runs with its own home under `~/.clawboo/runtimes/`.
- `~/.hermes/auth.json` (or `$HERMES_HOME/auth.json`): to see whether you signed in to Hermes.
- `~/.claude`: Claude Code agents run with your real home folder and save their session files under `~/.claude/projects`. Clawboo starts them without your own settings, MCP servers and memory files from there.

<Accordion title="Under the hood">

- `settings.json` is read by `loadSettings()` and written by `saveSettings()` in `@clawboo/config`; `GET /api/settings` returns `gatewayUrl`, `hasToken` and `firstRunDismissedAt`, and `POST /api/settings` accepts only `gatewayUrl`, `gatewayToken` and `firstRunDismissedAt`.
- The server opens `<CLAWBOO_HOME>/clawboo.db`. The MCP stdio bins default to a different file, `~/.openclaw/clawboo/clawboo.db`, unless `CLAWBOO_DB_PATH` is set; the stdio snippets from `GET /api/mcp/config` set it. This split is deliberate.
- Source of truth: `packages/config/src/index.ts`, `apps/web/server/lib/secretsVault.ts`, `apps/web/server/lib/openclawEnv.ts`, `apps/web/server/lib/providerKeys.ts`, `apps/web/server/api/system.ts`, `apps/web/server/lib/agentSource/openClawAgentSource.ts`.

</Accordion>

## Related

- [Environment variables](/reference/environment-variables): every variable, including the ones that move these folders
- [Data and state](/operating/data-and-state): back up, restore and reset
- [Security](/operating/security): the access gate, the vault and what each protects
- [Providers and runtimes](/using/providers-and-runtimes): connect keys and runtimes from the dashboard
- [Settings API](/reference/rest-api/settings): `GET` and `POST /api/settings`
