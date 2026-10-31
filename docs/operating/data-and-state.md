---
title: 'Data and state'
description: 'Where Clawboo keeps its data, what it writes in the OpenClaw folder, how to back it up, and what a reset removes and leaves behind.'
keywords:
  [
    'backup',
    'restore',
    'reset',
    'CLAWBOO_HOME',
    'clawboo.db',
    'state directory',
    'server.log',
    'CLAWBOO_DB_PATH',
  ]
---

Use this page to find Clawboo's data, back it up, move it or wipe it. Clawboo keeps its own state in one folder, `~/.clawboo`. It also writes a few files in OpenClaw's folder, `~/.openclaw`, and a reset of `~/.clawboo` leaves those alone.

## Where Clawboo keeps its data

Clawboo's folder is `~/.clawboo`. To use another folder, set `CLAWBOO_HOME` before you start the server (a leading `~` is expanded). The database, the key vault, the logs and the worktrees all move with it.

```bash
CLAWBOO_HOME=/srv/clawboo clawboo
```

```text
~/.clawboo/
├── clawboo.db                  the database
├── clawboo.db-wal, -shm        SQLite working files for the database
├── settings.json               the OpenClaw Gateway link
├── api-port.txt                the port the server is using
├── server.log, server.log.1    server output, when clawboo started the server
├── gateway.log, gateway.pid    an OpenClaw Gateway that Clawboo started
├── connector-pids.json         connector processes to clean up after a crash
├── proxy-device-identity.json  Clawboo's device key for the Gateway
├── secrets/
│   ├── master.key              the key that decrypts the vault
│   ├── runtime-keys.json       the encrypted vault
│   ├── disconnected-runtimes.json
│   └── keyless-providers.json
├── browser-profiles/           each agent's browser profile
├── frames/                     screenshots from agents' browsers
├── runtimes/                   per-agent homes for Codex and Hermes
├── catalog/                    a cached copy of the Marketplace catalog
├── worktrees/                  git worktrees for board tasks
└── reviews/                    checkouts for verifying finished work
```

| Path                                 | What it holds                                                                                                                                     | Safe to delete?                             | What you lose                                                                                    |
| ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| `clawboo.db`, `-wal`, `-shm`         | Teams, agents, the board, chats, memory, routines, budgets, most dashboard settings, and the secret that signs MCP attach URLs                    | Only to start over, with the server stopped | All of that. Attach URLs you copied by hand stop working.                                        |
| `settings.json`                      | The Gateway URL and token, and when you dismissed the first-run screen. The access token is never read from here, only from `STUDIO_ACCESS_TOKEN` | Yes                                         | The saved Gateway link. Clawboo falls back to the Gateway details in OpenClaw's `openclaw.json`. |
| `api-port.txt`                       | The port of the running server                                                                                                                    | Yes                                         | Usually nothing: `clawboo` also scans ports 18790 to 18809.                                      |
| `server.log`, `server.log.1`         | Output of a server that `clawboo` started                                                                                                         | Yes                                         | Old log lines.                                                                                   |
| `gateway.log`, `gateway.pid`         | Output and process id of an OpenClaw Gateway that Clawboo started                                                                                 | Yes                                         | Old log lines. Clawboo finds the Gateway by its port instead.                                    |
| `connector-pids.json`                | Connector processes Clawboo started                                                                                                               | Yes, with the server stopped                | After a crash, leftover connector processes are not cleaned up at the next start.                |
| `proxy-device-identity.json`         | The key pair Clawboo uses to identify itself to the OpenClaw Gateway                                                                              | Only if you can pair again                  | Clawboo makes a new identity, so the Gateway may ask you to pair it again.                       |
| `secrets/master.key`                 | The key that decrypts the vault                                                                                                                   | No                                          | Every key in the vault: re-enter provider keys and reconnect connectors.                         |
| `secrets/runtime-keys.json`          | The encrypted vault: provider keys, connector credentials and sign-ins, the Composio key                                                          | Only to remove every saved key              | The same as losing the master key.                                                               |
| `secrets/disconnected-runtimes.json` | The runtimes you disconnected                                                                                                                     | Yes                                         | A disconnected runtime can pick up a key from your shell or `~/.openclaw/.env` again.            |
| `secrets/keyless-providers.json`     | Whether you chose local Ollama for Clawboo Native                                                                                                 | Yes                                         | Clawboo forgets the choice; choose Ollama again.                                                 |
| `browser-profiles/`                  | Each agent's browser profile, including the sites it is signed in to                                                                              | Yes                                         | Agents' browser sign-ins and cookies.                                                            |
| `frames/`                            | Screenshots saved from agents' browsers                                                                                                           | Yes                                         | Those screenshots.                                                                               |
| `runtimes/`                          | Per-agent homes for Codex and Hermes agents, including a copy of your Codex sign-in                                                               | Yes, when no run is active                  | Those agents' saved sessions; they start fresh.                                                  |
| `catalog/`                           | A cached copy of the Marketplace catalog                                                                                                          | Yes                                         | Nothing. Clawboo downloads it again.                                                             |
| `worktrees/`                         | Git worktrees for board tasks that run in a repository                                                                                            | No: Clawboo removes old ones itself         | Uncommitted work in those checkouts.                                                             |
| `reviews/`                           | Read-only checkouts for verifying finished work                                                                                                   | Yes, when no check is running               | Nothing.                                                                                         |

On macOS and Linux, Clawboo makes the database, its working files and the folder readable only by your user account, and keeps `secrets/` the same way. A server started by `clawboo` also uses this folder as its working directory. A coding agent that runs without a worktree (every team-chat turn, research and review tasks, and Routines you make in the dashboard) starts here with your account's full file access; see [What agents can do](/concepts/permissions).

## What Clawboo writes in OpenClaw's folder

OpenClaw keeps its state in `~/.openclaw` (`OPENCLAW_STATE_DIR` moves it). Clawboo writes there in these cases:

| When you                                              | Clawboo writes                                                                                                                                                                                                                                                                                   |
| ----------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Connect a key under **Settings > Providers**          | The key, unencrypted, in `.env` and in each OpenClaw agent's `agents/<id>/agent/auth-profiles.json`, as well as in Clawboo's encrypted vault. **Disconnect** under Providers removes every copy.                                                                                                 |
| Set up OpenClaw from Clawboo                          | `openclaw.json` (a local Gateway and a default model) and `.env` (the Gateway token, plus the provider key, or `OLLAMA_API_KEY=ollama-local` for Ollama). The provider key also goes into each OpenClaw agent's `auth-profiles.json`. It fills in what is missing and keeps your other settings. |
| Change an OpenClaw setting in the dashboard           | `openclaw.json`: the default command approval in **Settings > System**, OpenClaw's default model in **Settings > Runtimes**, an OpenClaw agent's model, or agent-to-agent messaging when you add a route on the Org chart or deploy a team whose agents route work to each other.                |
| Create an OpenClaw agent or edit its files            | Through the Gateway: the agent, a `workspace-<name>` folder, and its files such as `SOUL.md` and `AGENTS.md`.                                                                                                                                                                                    |
| Connect to the Gateway (every time)                   | Through the Gateway: its config registers Clawboo's Memory, Tasks and Tools MCP servers and denies the tools that spawn sub-agents, keeping your own denials.                                                                                                                                    |
| Start a Gateway that asks for a repair                | Clawboo runs `openclaw doctor --fix` once, then tries again.                                                                                                                                                                                                                                     |
| Run a Clawboo MCP stdio bin without `CLAWBOO_DB_PATH` | `~/.openclaw/clawboo/clawboo.db`, a separate database the bin creates. See [Two database paths](#two-database-paths).                                                                                                                                                                            |

Clawboo also reads `openclaw.json` (the Gateway's port and token when `settings.json` has none), `.env` (the last place it looks for a provider key, after your environment and the vault), the agents' `auth-profiles.json` (which providers OpenClaw has keys or sign-ins for), and `state/openclaw.sqlite`. It opens that database read-only, to show the standing command permissions on an OpenClaw agent's **Permissions** tab and which browser tab belongs to which agent.

Keys you enter during onboarding or on a **Runtimes** card go only into the vault. See [Providers and runtimes](/using/providers-and-runtimes) for where each kind of key is stored.

## What a reset leaves behind

Resetting `~/.clawboo` never touches `~/.openclaw`, so after a full reset:

- **Keys you connected under Providers keep working.** They are still in `~/.openclaw/.env` and in the OpenClaw agents' `auth-profiles.json`, and Clawboo reads `.env` when its vault has no key. To remove them, disconnect each one under **Settings > Providers** before you reset, or delete their lines from those files.
- **Runtimes you disconnected can connect again on their own.** Clawboo records a disconnect in `~/.clawboo`, so after the reset a matching key in your shell or in `~/.openclaw/.env` reaches them again.
- **OpenClaw agents stay in OpenClaw**, including agents Clawboo created, with their files. Clawboo finds the Gateway again from `openclaw.json`.
- **The Gateway keeps Clawboo's MCP entries.** Clawboo rewrites them with a new attach token the next time it connects.

## Back up your data

### Back up the database

`clawboo backup` copies the database into one consistent file. It is safe to run while the server is running.

```bash
clawboo backup
clawboo backup ~/backups
clawboo backup ~/backups/clawboo.db --force
```

With no argument it writes `clawboo-backup-<date>-<time>.db` in the current folder. Give it a folder to write the timestamped file there, or a file name. It refuses to replace an existing file unless you add `-f` (`--force`).

It copies the database only. The file holds all your teams, tasks, chats and memory, and the secret that signs MCP attach URLs, yet it is created with your default file permissions. Restrict it:

```bash
chmod 600 clawboo-backup-*.db
```

### What else to copy

The database is most of your data, but not all of it. Copy these too when you need them:

| Copy                             | Why                                                                                             |
| -------------------------------- | ----------------------------------------------------------------------------------------------- |
| `secrets/` (both files together) | Saved provider keys, connector credentials and sign-ins. One file is useless without the other. |
| `settings.json`                  | The OpenClaw Gateway link.                                                                      |
| `proxy-device-identity.json`     | Clawboo's identity with the Gateway, so you do not have to pair it again.                       |
| `browser-profiles/`              | The sites your agents' browsers are signed in to.                                               |
| `runtimes/`                      | Codex and Hermes agents' saved sessions, including a copy of your Codex sign-in.                |
| `~/.openclaw`                    | OpenClaw's own agents, config and keys, if you use OpenClaw. Clawboo never backs it up.         |

### Back up everything

Stop the server and copy the whole folder:

```bash
clawboo stop
cp -a ~/.clawboo ~/clawboo-backup-$(date +%Y%m%d)
clawboo
```

The copy holds your vault and its key and your agents' signed-in browser profiles. Store it as carefully as a password file.

<Note>

With `STUDIO_ACCESS_TOKEN` set, `clawboo stop` and `clawboo restart` cannot identify the server through the access gate. They print its port and a command that stops it by port, then exit without stopping it. Run that command, or stop Clawboo through the service manager that runs it (systemd, Docker). Start it again [directly](/operating/deployment#start-the-server-directly) or through that service manager, not with `clawboo`, which cannot tell when a token-protected server is ready. `clawboo backup` works either way because it reads the database file directly. See the [CLI reference](/reference/cli).

</Note>

### Restore

<Steps>
<Step title="Stop the server">

Run `clawboo stop`, or stop the service that runs Clawboo.

</Step>
<Step title="Put the backup in place">

Copy the backup file over `~/.clawboo/clawboo.db`, or replace `~/.clawboo` with a whole-folder copy.

</Step>
<Step title="Remove stale working files">

If you restored a single-file backup, delete any `clawboo.db-wal` and `clawboo.db-shm` left beside it from the old database.

</Step>
<Step title="Start Clawboo">

Run `clawboo`. You should see your teams and board as they were when you made the backup.

</Step>
</Steps>

A database from another install carries that install's attach secret, so copy any attach URLs you set up by hand again from [MCP servers](/operating/mcp-servers).

## Hard reset

Reset only to wipe data. An upgrade needs no reset; see [After an upgrade](#after-an-upgrade).

<Warning>

Both resets delete data you cannot get back. Back up first if any of it matters, and stop the server before you delete anything. A running server keeps the old database open and goes on serving it, and `clawboo` attaches to that server, so the reset seems not to happen.

</Warning>

### Reset only the data

```bash
clawboo stop
rm -f ~/.clawboo/clawboo.db ~/.clawboo/clawboo.db-wal ~/.clawboo/clawboo.db-shm
clawboo
```

Clawboo creates an empty database at the next start. Your keys, settings, logs and browser profiles stay. You lose everything in the database: teams and their agents, the board, chats, memory, routines, budgets and most dashboard settings. OpenClaw agents themselves stay in OpenClaw.

The secret that signs MCP attach URLs goes with the database. Attach URLs you copied by hand stop working; Clawboo's own runtimes and a local OpenClaw Gateway get new ones on their next run or connection.

### Reset everything

```bash
clawboo stop
rm -rf ~/.clawboo
clawboo
```

Clawboo starts as a new install. This also deletes the vault and its key, the device identity, the logs, the browser profiles and the worktrees, including any uncommitted work in them (run `git worktree prune` in each repository afterwards). It does not touch `~/.openclaw`; see [What a reset leaves behind](#what-a-reset-leaves-behind).

## Two database paths

The server always uses `clawboo.db` in Clawboo's folder (`~/.clawboo/clawboo.db`, or the same file under `CLAWBOO_HOME`). The four MCP stdio bins (`clawboo-mcp-tasks`, `clawboo-mcp-memory`, `clawboo-mcp-tools`, `clawboo-mcp-teamchat`) open the file named by `CLAWBOO_DB_PATH` instead, which defaults to `~/.openclaw/clawboo/clawboo.db` and is created empty when missing. The two defaults differ on purpose.

For a stdio bin to see the server's board and memory, set `CLAWBOO_DB_PATH` to the server's database, or copy the stdio snippet from `GET /api/mcp/config?transport=stdio`, which sets it for you. The server itself ignores `CLAWBOO_DB_PATH`. See [MCP servers](/operating/mcp-servers).

## The server log

A server started by `clawboo` writes its output to `~/.clawboo/server.log`. When `clawboo` starts a server and the log is over 5 MB, it first moves the old log to `server.log.1`. If the dashboard has not answered after about 45 seconds, `clawboo` prints the last lines of this log and its path.

A server you start yourself, from a service manager or with `node`, writes to its own output instead. After the in-app update restarts the server, the new server's output is not written to `server.log`; run `clawboo restart` to capture it again. An OpenClaw Gateway that Clawboo started logs to `~/.clawboo/gateway.log`. The [CLI reference](/reference/cli) covers starting, stopping and finding the server.

## How Clawboo checks its data at startup

Each time it starts, Clawboo checks its folder, database and vault, and shows the results in **Settings > System Health** (and at `GET /api/health`).

| Check                         | When it fails                                                                           | Severity |
| ----------------------------- | --------------------------------------------------------------------------------------- | -------- |
| **Clawboo home writable**     | Clawboo cannot create or write its folder.                                              | Fatal    |
| **Database integrity**        | The database cannot be opened or is damaged.                                            | Fatal    |
| **Database schema**           | A table or column the database needs is missing. The details name it.                   | Fatal    |
| **Secrets vault permissions** | Other users can read `secrets/`, `master.key` or the device identity (macOS and Linux). | Degraded |
| **Master key**                | The master key cannot decrypt the vault, so saved keys cannot be read.                  | Degraded |

The server keeps running either way, so you can read each check's details in System Health: they say what is wrong and what to do. Treat a fatal check as broken until fixed, and use a [full reset](#reset-everything) only as the last resort. When **Master key** fails, re-enter your provider keys and reconnect your connectors, or reset.

## After an upgrade

When a new version first starts, it adds any columns the database is missing, so your data carries over with no step from you. It also turns on read-only Tasks and TeamChat for any Clawboo Native agent that has both turned off. That repair runs once and records that it ran, so turning either tool off afterwards sticks.

<Accordion title="Under the hood">

- The database holds 35 tables and runs in SQLite's WAL mode, which is why the `-wal` and `-shm` files sit beside it. `clawboo backup` uses SQLite's online backup, so its copy needs no working files. See the [database schema](/reference/database-schema).
- `clawboo stop` sends the server a stop signal. On macOS and Linux the server stops its agent processes, folds the working files into `clawboo.db` and closes it, so after a clean stop `clawboo.db` alone holds every saved change. On Windows the process is ended at once with none of those steps, so copy the `-wal` and `-shm` files with the database.
- The `POST /api/system/configure-openclaw` route, which no dashboard screen calls, replaces `openclaw.json` and `.env` outright and mints a new Gateway token. The dashboard's OpenClaw setup uses the route that fills in only what is missing.

</Accordion>

## Related

- [CLI reference](/reference/cli): `clawboo backup`, `clawboo stop`, `clawboo restart`, and how `clawboo` finds the server.
- [Environment variables](/reference/environment-variables): `CLAWBOO_HOME`, `CLAWBOO_DB_PATH`, `CLAWBOO_SECRETS_MASTER_KEY`, `OPENCLAW_STATE_DIR`.
- [Security](/operating/security): the vault, the master key, and who can reach the server.
- [MCP servers](/operating/mcp-servers): attach outside agents and point the stdio bins at the right database.
- [Database schema](/reference/database-schema): every table in `clawboo.db`.
