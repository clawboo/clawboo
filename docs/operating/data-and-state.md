---
title: 'Data and state'
description: "Where Clawboo keeps its data and its agents' work, what it writes in the OpenClaw folder, how to back it up, and what a reset removes and leaves behind."
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
    'CLAWBOO_WORK_DIR',
    'work folder',
    'CLAWBOO_RUNTIMES_DIR',
    'runtimes folder',
  ]
---

Use this page to find Clawboo's data, back it up, move it or wipe it. Clawboo keeps its own state in one folder, `~/.clawboo`, and its agents' work in another, the work folder (`~/clawboo-work`). The runtimes it installs for you go in a third, the runtimes folder (`~/clawboo-runtimes`). It also writes a few files in OpenClaw's folder, `~/.openclaw`, and a reset of `~/.clawboo` leaves those alone.

## Where Clawboo keeps its data

Clawboo's data folder is `~/.clawboo`. To use another folder, set `CLAWBOO_HOME` before you start the server (a leading `~` is expanded). The database, the key vault, the settings and the logs move with it. The work folder becomes `<CLAWBOO_HOME>-work` unless `CLAWBOO_WORK_DIR` names another, and the runtimes folder becomes `<CLAWBOO_HOME>-runtimes` unless `CLAWBOO_RUNTIMES_DIR` names another. Team folders, task checkouts and review checkouts live in the work folder; see [The work folder](#the-work-folder). OpenClaw, Claude Code's Agent SDK and Codex, when Clawboo installs them, live in the runtimes folder; see [The runtimes folder](#the-runtimes-folder).

```bash
CLAWBOO_HOME=/srv/clawboo clawboo
```

```text
~/.clawboo/
├── clawboo.db                  the database
├── clawboo.db-wal, -shm        SQLite working files for the database
├── settings.json               the OpenClaw Gateway link
├── access-token                the dashboard's access token
├── api-port.txt                the port the server is using
├── server.log, server.log.1    server output, when clawboo started the server
├── gateway.log, gateway.pid    an OpenClaw Gateway that Clawboo started
├── connector-pids.json         connector processes to clean up after a crash
├── runtime-pids/               agent processes to clean up after a crash
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
└── team-folder-history/        a git history of each team's folder, for checks
```

| Path                                 | What it holds                                                                                                                                                                                                                                                                                     | Safe to delete?                             | What you lose                                                                                        |
| ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| `clawboo.db`, `-wal`, `-shm`         | Teams, agents, the board, chats, memory, routines, budgets, most dashboard settings, and the secret that signs MCP attach URLs                                                                                                                                                                    | Only to start over, with the server stopped | All of that. Attach URLs you copied by hand stop working.                                            |
| `settings.json`                      | The Gateway URL and token, and when you dismissed the first-run screen. The access token is never read from here                                                                                                                                                                                  | Yes                                         | The saved Gateway link. Clawboo falls back to the Gateway details in OpenClaw's `openclaw.json`.     |
| `access-token`                       | The dashboard's access token when `STUDIO_ACCESS_TOKEN` is unset, made on the first start and readable only by you. The Clawboo desktop app can share it                                                                                                                                          | Yes, with the server stopped                | Every browser's sign-in. The next start makes a new token; run `clawboo open` to sign in again.      |
| `api-port.txt`                       | The port of the running server                                                                                                                                                                                                                                                                    | Yes                                         | Usually nothing: `clawboo` also scans ports 18790 to 18809.                                          |
| `server.log`, `server.log.1`         | Output of a server that `clawboo` started                                                                                                                                                                                                                                                         | Yes                                         | Old log lines.                                                                                       |
| `gateway.log`, `gateway.pid`         | Output and process id of an OpenClaw Gateway that Clawboo started                                                                                                                                                                                                                                 | Yes                                         | Old log lines. Clawboo finds the Gateway by its port instead.                                        |
| `connector-pids.json`                | Connector processes Clawboo started                                                                                                                                                                                                                                                               | Yes, with the server stopped                | After a crash, leftover connector processes are not cleaned up at the next start.                    |
| `runtime-pids/`                      | Agent processes each running server started (Codex, Hermes, Claude Code, and commands a Clawboo Native agent runs), one file per server                                                                                                                                                           | Yes, with the server stopped                | After a crash, agent runs that outlived the server are not stopped at the next start.                |
| `proxy-device-identity.json`         | The key pair Clawboo uses to identify itself to the OpenClaw Gateway                                                                                                                                                                                                                              | Only if you can pair again                  | Clawboo makes a new identity, so the Gateway may ask you to pair it again.                           |
| `secrets/master.key`                 | The key that decrypts the vault                                                                                                                                                                                                                                                                   | No                                          | Every key in the vault: re-enter provider keys and reconnect connectors.                             |
| `secrets/runtime-keys.json`          | The encrypted vault: provider keys, connector credentials and sign-ins, the Composio key                                                                                                                                                                                                          | Only to remove every saved key              | The same as losing the master key.                                                                   |
| `secrets/disconnected-runtimes.json` | The runtimes you disconnected                                                                                                                                                                                                                                                                     | Yes                                         | A disconnected runtime can pick up a key from your shell or `~/.openclaw/.env` again.                |
| `secrets/keyless-providers.json`     | Whether you chose local Ollama for Clawboo Native                                                                                                                                                                                                                                                 | Yes                                         | Clawboo forgets the choice; choose Ollama again.                                                     |
| `browser-profiles/`                  | Each agent's browser profile, including the sites it is signed in to                                                                                                                                                                                                                              | Yes                                         | Agents' browser sign-ins and cookies.                                                                |
| `frames/`                            | Screenshots saved from agents' browsers                                                                                                                                                                                                                                                           | Yes                                         | Those screenshots.                                                                                   |
| `runtimes/`                          | Per-agent homes for Codex and Hermes agents, including a copy of your Codex sign-in                                                                                                                                                                                                               | Yes, when no run is active                  | Those agents' saved sessions; they start fresh.                                                      |
| `catalog/`                           | A cached copy of the Marketplace catalog                                                                                                                                                                                                                                                          | Yes                                         | Nothing. Clawboo downloads it again.                                                                 |
| `team-folder-history/`               | A git history of each team's folder (`<team id>.git`), saved as team chat tasks start and end so their work can be checked. Deleting a team deletes it                                                                                                                                            | Yes, when no run or check is active         | Running tasks lose their starting point: unchecked, or Needs you after a failed check.               |
| `workspaces/`, `worktrees/`          | Left by an older version. After the [move](#move-older-work-into-it), a link at each old path to the team folder or checkout that moved, and any folder the move kept at its old place. New work goes here only when the [work folder cannot be created](#when-the-work-folder-cannot-be-created) | No                                          | A folder kept here is still in use. Without the links, 0.6.x finds no team folders after a rollback. |
| `reviews/`                           | Review checkouts an older version made. New ones go in the work folder, or here when it cannot be created                                                                                                                                                                                         | Yes, when no check is running               | Nothing.                                                                                             |

On macOS and Linux, Clawboo makes the database, its working files, `settings.json` and the folder readable only by your user account, and keeps `secrets/` the same way. A server started by `clawboo` also uses this folder as its working directory. A coding agent that runs without a worktree (every team-chat turn, every one-to-one chat, research and review tasks, and Routines you make in the dashboard) starts in its team's folder in the work folder instead. It still has your account's full file access; see [What agents can do](/concepts/permissions).

## The work folder

Your agents' work lives in the work folder, apart from the data folder. It is the folder `CLAWBOO_WORK_DIR` names, else `<CLAWBOO_HOME>-work` when `CLAWBOO_HOME` is set, else `~/clawboo-work` (`%USERPROFILE%\clawboo-work` on Windows). Clawboo uses it by its real path, with every link resolved.

```text
~/clawboo-work/
├── README.txt                  what this folder is
├── teams/                      a folder for each team, where its agents start
│   ├── <team id>/
│   └── _no-team/               for tasks and agents with no team
├── worktrees/                  git worktrees for board tasks
│   └── <repo hash>/<task id>/
└── reviews/                    checkouts for verifying finished work
    └── <install>/              a folder of this install's own
        ├── <repo hash>/<short sha>/
        └── team-<team id>/
```

| Path         | What it holds                                                                                                                                                                     | Safe to delete?                     | What you lose                                                                        |
| ------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------- | ------------------------------------------------------------------------------------ |
| `teams/`     | One folder per team (`teams/<team id>`), where its agents start when a run has no worktree, plus `_no-team` for tasks and agents with no team. Deleting a team deletes its folder | Yes, when no run is active          | The files agents saved there. Clawboo creates a team's folder again on its next run. |
| `worktrees/` | Git worktrees for board tasks that run in a repository, each with a `.<task id>.owner` file beside it                                                                             | No: Clawboo removes old ones itself | Uncommitted work in those checkouts.                                                 |
| `reviews/`   | Read-only checkouts for verifying finished work                                                                                                                                   | Yes, when no check is running       | Nothing.                                                                             |
| `README.txt` | A note on what the folder holds                                                                                                                                                   | Yes                                 | Nothing. Clawboo writes it again at the next start.                                  |

Everything Clawboo creates in the work folder is readable only by your user account (`0700`). The `.<task id>.owner` file beside each checkout holds this install's id. The worktree cleanup in the work folder removes only checkouts this install's board records or that carry its id, so two installs can share one work folder.

The data folder keeps the rest: the database, the key vault, the settings, the runtime homes (`runtimes/`), the browser profiles, connector state, and `team-folder-history/`, the work check's history of each team folder.

Keeping the work apart removes the short relative path from an agent's folder to your data: `../..` from a team folder no longer reaches the database, and neither does a tool that walks up parent folders. That holds only for work in the work folder. When the work folder cannot be created and the install keeps the old layout, or the move below keeps a folder at its old place, that folder is still inside the data folder and `../..` from it does reach the data. It is not a boundary either way. Agents still run as your user account and can open `~/.clawboo` by its full path; see [What agents can do](/concepts/permissions).

### Move older work into it

Older versions kept team folders in `~/.clawboo/workspaces` and task checkouts in `~/.clawboo/worktrees`. Once per start, after the database opens and stale runs are released, and before the worktree cleanup or any run, Clawboo moves the team folders it finds in `workspaces/`, and the checkouts the board records in `worktrees/`, into the work folder:

- **Renames only.** Nothing is copied, so a folder usually takes milliseconds.
- **A link at each old path.** `~/.clawboo/workspaces/<team id>` still leads to the folder, for older versions and for tools that saved the path.
- **Uncommitted work is saved first.** Before a checkout moves, Clawboo commits its uncommitted work on the task's branch (`clawboo: save work before moving task <id>`), the same kind of commit a pause makes. The checkout moves with `git worktree move`, or, when it is locked, with a rename and `git worktree repair`, which needs git 2.30 or later. The board's recorded paths change to the new place.
- **Paused tasks move too.** A paused task's record names the new place, and resuming the task rebuilds its checkout in the work folder.
- **Review checkouts stay.** Clawboo does not move them. New ones go in the work folder, in `reviews/` under a folder named for this install, since two installs that share a work folder can review the same commit.
- **A crash is safe.** Every step is written to a journal before it happens, so a crash or a kill at any point is finished or undone at the next start. When a folder has moved but the link at its old path cannot be made, the move still counts: runs use the new path, and the journal notes the missing link.
- **One server moves at a time.** A second server started on the same data folder waits for the first one's move to end, answering `migrating` meanwhile, and then starts.

Claude Code files its saved sessions under the folder they ran in. After a team folder moves, Clawboo drops the session ids it saved for Claude Code agents (1:1 chat, team chat and task pointers), and after a checkout moves, the session id in its handoff. Their next turn starts a fresh session with the brief and the chat history. Codex, Hermes and Clawboo Native agents keep their sessions.

### What the move leaves where it is

The move leaves these where they are, logs the warning `Work folder: kept at its old place`, and tries again at the next start. Each one keeps working where it is:

- a folder on another volume, since the move never copies;
- a checkout git does not list;
- a checkout with a run still going in it;
- a conflict, where something is already at the new path. Both are kept, and the team keeps using its old folder.

See [Troubleshooting](/help/troubleshooting#work-folder-kept-at-its-old-place) for what to do about each.

### Change the work folder

Stop Clawboo, set `CLAWBOO_WORK_DIR` to the new folder, and start it again. Clawboo treats the change as a move: at that start, this install's team folders and recorded checkouts move from the previous work folder to the new one, with links left at the previous paths. The same rules apply, so work on another volume stays in the previous folder and keeps working there. A previous work folder that is not there at that start, such as one on a drive that is not mounted, stays on record with the warning `Work folder: the previous work folder is not there`, and its team folders move at the first start that finds it again. Changing back to a work folder used before works the same way: the links the earlier move left there are replaced by the folders.

### While the move runs

The server listens while it moves folders, so a service manager or a monitor sees it starting:

- `GET /api/health` answers `200` with `{ "ok": false, "status": "migrating", "migration": { "total": 4, "done": 1, "left": 3 } }`.
- Every other request answers `503` with `Retry-After: 2` and `{ "error": "Clawboo is moving its work folders. Try again in a moment.", "status": "migrating" }`.
- A WebSocket connection is refused with `503`.

The HTTP answers come after the access gate, the same as at any other time. A WebSocket upgrade is refused before the origin and access checks. The move usually takes milliseconds per folder.

### When Clawboo refuses to start

The server exits at startup when the work folder is the data folder, sits inside it, or contains it. It compares real paths, so a link cannot hide one folder inside the other:

```text
CONFIG: refusing to start. CLAWBOO_WORK_DIR (/srv/clawboo/work) must be outside Clawboo's data folder (/srv/clawboo). Set CLAWBOO_WORK_DIR to a folder outside it.
```

When the data folder is inside the work folder, the message says the reverse: `Clawboo's data folder (<path>) must be outside the work folder (<path>). Set CLAWBOO_WORK_DIR to a folder that does not contain it.` The server also refuses to start when it cannot create or write to a `CLAWBOO_WORK_DIR` you set (`CLAWBOO_WORK_DIR (<path>) cannot be used: <reason>`), and when `teams/`, `worktrees/` or `reviews/` inside the work folder is a link (`<path> is a link. Clawboo puts agents' work only in a real folder there: remove the link and start again.`) or a file (`<path> is not a folder.`). On Windows and macOS the comparison ignores case, since their file systems usually do.

### When the work folder cannot be created

When `CLAWBOO_WORK_DIR` is not set and Clawboo cannot create or write to the default work folder, as in a container whose data folder is a volume under a root-owned `/`, it logs a warning and keeps the old layout: new work stays in the data folder (`workspaces/`, `worktrees/` and `reviews/`), and nothing moves. Set `CLAWBOO_WORK_DIR` to a folder Clawboo can create, such as a second volume in a container, and the next start moves the work there.

### Roll back to 0.6.x

You can go back to 0.6.x after the move. 0.6.0 already reads checkouts in the work folder, and finds team folders through the links. One limit: 0.6.x's work check refuses a team folder in the work folder, so team chat work checks fail on 0.6.x until you upgrade again. Versions before 0.6.0 do not read the work folder, so do not go below 0.6.0 after the move.

## The runtimes folder

The runtimes Clawboo installs for you (OpenClaw, Claude Code's Agent SDK and Codex) live in the runtimes folder, never in npm's global folder. It is the folder `CLAWBOO_RUNTIMES_DIR` names (a leading `~` is expanded), else `<CLAWBOO_HOME>-runtimes` when `CLAWBOO_HOME` is set, else `~/clawboo-runtimes` (`%USERPROFILE%\clawboo-runtimes` on Windows). Clawboo uses it by its real path, with every link resolved, and creates it on the first install.

```text
~/clawboo-runtimes/
├── README.txt                  what this folder is
├── bin/                        the commands that start each runtime
│   ├── openclaw                (openclaw.cmd on Windows)
│   └── codex                   (codex.cmd on Windows)
├── openclaw/
│   ├── clawboo-runtime.json    which install is current, and what each command runs
│   ├── 20261111-083000/        the current install
│   └── 20261020-141500/        the install before it
├── claude-code/                the Agent SDK, which offers no command
└── codex/
```

| Path                             | What it holds                                                                                                                                                                                                                           |
| -------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `bin/`                           | One launcher for each command a runtime offers. A launcher starts the runtime on the Node.js that installed it: that Node's full path is written into it, so a different `node` first on your `PATH` later does not change what it runs |
| `<runtime>/<install>/`           | One folder for each install, named by the UTC time it started, such as `20261111-083000`. Clawboo keeps the current install and the one before it, and removes older ones                                                               |
| `<runtime>/clawboo-runtime.json` | The current install's folder, its version, the spec it came from (such as `openclaw@~2026.9`), the Node.js it runs on, and what each launcher runs                                                                                      |
| `README.txt`                     | A note on what the folder holds                                                                                                                                                                                                         |

<Note>

This is not the `runtimes/` folder inside `~/.clawboo`. That one holds each Codex and Hermes agent's own home, with its sessions and sign-in copy.

</Note>

### How an install works

OpenClaw, Claude Code and Codex install the same way, whether from **Install** in **Settings > Runtimes**, **Set up OpenClaw**, or **Check for Updates** in **Settings > System**:

- **npm runs on the Node.js Clawboo runs on.** Clawboo runs npm's own script with that Node: the npm that ships beside it, Homebrew's npm for a Homebrew Node, or the `npm` on your `PATH`. Only when it cannot find that script does it run the `npm` command itself, with that Node's folder first on `PATH`.
- **Each install goes into a new folder.** The command is `npm install --prefix <new install folder> --include=optional --no-global --location=project --no-fund --no-audit <spec>`. It runs under umask 022, and without `npm_config_global`, `npm_config_location` and `npm_config_prefix` in its environment, so neither your environment nor an `.npmrc` with `global=true` makes it write to npm's global folder, and it never needs `sudo`.
- **Success switches to it.** Clawboo writes the launchers in `bin/` and points `clawboo-runtime.json` at the new install, all or nothing. It keeps the previous install, and any install a Gateway it started is still running from, and removes older ones.
- **Failure changes nothing.** When npm fails, or the install is stopped, Clawboo removes the new folder and the current install stays as it was. A failed update never leaves a runtime half replaced. The error carries npm's own code, such as `EACCES` or `ETARGET`, and the message reads `Installation failed with exit code <n>.` followed by npm's reason.

Folders Clawboo creates here are `0755`. Before an install becomes current, Clawboo makes everything in it readable by other users and writable only by the server's user, so another account on the computer can run a runtime but cannot change it. An install fails when an item in it belongs to another user, or when a link inside it points outside the install.

### Which copy Clawboo uses

Wherever Clawboo looks for a runtime, it looks in the runtimes folder first, then on your `PATH`, then in the usual user-install folders. That covers OpenClaw detection, the Gateway Clawboo starts, the `openclaw` commands it runs, Codex runs and the **Runtimes** panel. So an OpenClaw or Codex you installed globally yourself keeps working while Clawboo has no copy of its own. A Claude Code run loads the Agent SDK from the runtimes folder first, else from next to Clawboo: a source checkout's `node_modules`, or an SDK installed next to a global Clawboo.

The runtimes folder is not on your `PATH`. To run a runtime Clawboo installed from your own terminal, use its launcher's full path, such as `~/clawboo-runtimes/bin/openclaw doctor --fix`. Where the dashboard shows a command for you to run, such as a sign-in, it already names that full path.

For a Homebrew Node.js, a launcher names the formula's link, such as `/opt/homebrew/opt/node@24/bin/node`, rather than the versioned folder an upgrade deletes, so `brew upgrade` keeps it working. If the Node.js a launcher names is removed anyway, for example by `nvm uninstall`, Clawboo stops using that launcher. The runtime reads **Not installed** unless a global copy exists, the Runtimes panel and `GET /api/system/status` say why, and **Install** puts it back on the Node.js Clawboo runs on now.

### When Clawboo will not use it

Clawboo installs nothing into the runtimes folder, and runs nothing from it, when:

- it is the data folder or the work folder, sits inside one of them, or contains one of them. Clawboo compares real paths, so a link does not get around the check;
- its `bin/` is a link, or not a folder;
- the folder, its `bin/` or a launcher belongs to another user, or others can write to it;
- a folder above it lets anyone rename what is in it (others can write to it and it has no sticky bit), or holds a `node_modules` that another user owns or can change. Node.js looks for a module an install lacks in the `node_modules` of every folder above it, so such a folder could stand in for part of a runtime.

Then Clawboo uses a runtime on your `PATH`, if there is one, and an install fails with the reason. The server still starts. On Windows, ownership and write access are not checked.

```text
CLAWBOO_RUNTIMES_DIR (/srv/clawboo/runtimes) must be apart from Clawboo's data folder (/srv/clawboo). Set CLAWBOO_RUNTIMES_DIR to a folder of its own and restart Clawboo.
```

Against the work folder, the message reads `must be apart from the work folder (<path>)`. Without `CLAWBOO_RUNTIMES_DIR` set, it starts with `Clawboo's runtimes folder (<path>)` instead. For a folder you do not own:

```text
/srv/clawboo-runtimes belongs to another user or others can write to it, so Clawboo will not run anything from it. Make it yours and run chmod go-w on it, or set CLAWBOO_RUNTIMES_DIR to a folder of its own and restart Clawboo.
```

A `bin/` that is a link reads `<path> is a link. Clawboo runs launchers only from a real folder: remove it and install again.`, and one that is not a folder reads `<path> is not a folder. Move it away and install again.` In an install's event stream, each of these is the error code `RUNTIMES_DIR_REFUSED`.

### Move or remove it

Nothing moves when you change `CLAWBOO_RUNTIMES_DIR`. Stop Clawboo, set the variable, start Clawboo again, and install the runtimes again from **Settings > Runtimes**.

A reset of the data folder leaves the runtimes folder alone, and so does uninstalling Clawboo. To remove every runtime Clawboo installed, stop the OpenClaw Gateway if Clawboo started one (**Manage**, then **Disconnect**, on the **OpenClaw** row), stop the server, and delete the folder:

```bash
clawboo stop && rm -rf ~/clawboo-runtimes
```

## What Clawboo writes in OpenClaw's folder

OpenClaw keeps its state in `~/.openclaw` (`OPENCLAW_STATE_DIR` moves it). Clawboo writes there in these cases:

| When you                                              | Clawboo writes                                                                                                                                                                                                                                                                                                                                   |
| ----------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Connect a key under **Settings > Providers**          | The key, unencrypted, in `.env` and in each OpenClaw agent's `agents/<id>/agent/auth-profiles.json`, as well as in Clawboo's encrypted vault. **Disconnect** under Providers removes every copy.                                                                                                                                                 |
| Set up OpenClaw from Clawboo                          | `openclaw.json` (a local Gateway, a default model, and OpenClaw's tool sandbox off when you set none) and `.env` (the Gateway token, plus the provider key, or `OLLAMA_API_KEY=ollama-local` for Ollama). The provider key also goes into each OpenClaw agent's `auth-profiles.json`. It fills in what is missing and keeps your other settings. |
| Change an OpenClaw setting in the dashboard           | `openclaw.json`: the default command approval in **Settings > System**, OpenClaw's default model in **Settings > Runtimes**, an OpenClaw agent's model, or agent-to-agent messaging when you add a route on the Org chart or deploy a team whose agents route work to each other.                                                                |
| Create an OpenClaw agent or edit its files            | Through the Gateway: the agent, a `workspace-<name>` folder, and its files such as `SOUL.md` and `AGENTS.md`.                                                                                                                                                                                                                                    |
| Connect to the Gateway (every time)                   | Through the Gateway: its config registers Clawboo's Memory, Tasks and Tools MCP servers and denies the tools that spawn sub-agents, keeping your own denials.                                                                                                                                                                                    |
| Start a Gateway that asks for a repair                | Clawboo runs `openclaw doctor --fix` once, then tries again.                                                                                                                                                                                                                                                                                     |
| Run a Clawboo MCP stdio bin without `CLAWBOO_DB_PATH` | `~/.openclaw/clawboo/clawboo.db`, a separate database the bin creates. See [Two database paths](#two-database-paths).                                                                                                                                                                                                                            |

On macOS and Linux, Clawboo makes `.env` and each `auth-profiles.json` readable only by you (mode `0600`) whenever it writes them, and creates `~/.openclaw` owner-only (`0700`) if it does not exist yet. An existing `~/.openclaw` keeps its mode.

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

It copies the database only. The file holds all your teams, tasks, chats and memory, and the secret that signs MCP attach URLs, so on macOS and Linux it is readable only by you (mode `0600`) from the moment it is created. If the backup fails, the partial file is removed. A backup made with 0.5.0 or older has your default file permissions; restrict it:

```bash
chmod 600 clawboo-backup-*.db
```

### What else to copy

The database is most of your data, but not all of it. Copy these too when you need them:

| Copy                                         | Why                                                                                             |
| -------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| `secrets/` (both files together)             | Saved provider keys, connector credentials and sign-ins. One file is useless without the other. |
| `settings.json`                              | The OpenClaw Gateway link.                                                                      |
| `proxy-device-identity.json`                 | Clawboo's identity with the Gateway, so you do not have to pair it again.                       |
| `browser-profiles/`                          | The sites your agents' browsers are signed in to.                                               |
| `runtimes/`                                  | Codex and Hermes agents' saved sessions, including a copy of your Codex sign-in.                |
| The work folder's `teams/`                   | The files your agents saved in their team's folder.                                             |
| `~/.openclaw` (or your `OPENCLAW_STATE_DIR`) | OpenClaw's own agents, config and keys, if you use OpenClaw. Clawboo never backs it up.         |

### Back up everything

Stop the server and copy the whole folder. If you set `CLAWBOO_HOME`, use that folder in place of `~/.clawboo` here and in the commands below:

```bash
clawboo stop
cp -a ~/.clawboo ~/clawboo-backup-$(date +%Y%m%d)
clawboo
```

The copy holds your vault and its key and your agents' signed-in browser profiles. Store it as carefully as a password file. Your agents' files are in the [work folder](#the-work-folder); copy it the same way, with the server stopped, to keep them too.

<Note>

With your own `STUDIO_ACCESS_TOKEN` on the server, run `clawboo stop` and `clawboo restart` from a shell that has that token, so they can identify the server through the access gate. A server on its per-install token needs nothing: they read `access-token`. Without it, they print its port and a command that stops it by port, then exit without stopping it. Run that command, or stop Clawboo through the service manager that runs it (systemd, Docker), and start it again [directly](/operating/deployment#start-the-server-directly) or through that service manager. `clawboo backup` works either way because it reads the database file directly. See the [CLI reference](/reference/cli#token-gated-installs).

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

Both resets delete data you cannot get back. Back up first if any of it matters, and stop the server before you delete anything. A running server keeps the old database open and goes on serving it, and `clawboo` attaches to that server, so the reset seems not to happen. With `STUDIO_ACCESS_TOKEN` set, `clawboo stop` cannot stop the server: stop it as the note under [Back up everything](#back-up-everything) says, and delete only after it has stopped. The commands below delete only if `clawboo stop` succeeds.

</Warning>

### Reset only the data

```bash
clawboo stop && rm -f ~/.clawboo/clawboo.db ~/.clawboo/clawboo.db-wal ~/.clawboo/clawboo.db-shm
clawboo
```

Clawboo creates an empty database at the next start. Your keys, settings, logs, browser profiles and team folders stay. You lose everything in the database: teams and their agents, the board, chats, memory, routines, budgets and most dashboard settings. OpenClaw agents themselves stay in OpenClaw.

The secret that signs MCP attach URLs goes with the database. Attach URLs you copied by hand stop working; Clawboo's own runtimes and a local OpenClaw Gateway get new ones on their next run or connection.

### Reset everything

```bash
clawboo stop && rm -rf ~/.clawboo
clawboo
```

Clawboo starts as a new install. This also deletes the vault and its key, the device identity, the logs and the browser profiles. It does not touch `~/.openclaw` (see [What a reset leaves behind](#what-a-reset-leaves-behind)), the [runtimes folder](#move-or-remove-it) or the work folder. A new install's cleanup never removes the old team folders and worktrees there, because its board does not record them. To remove them too, delete the work folder (`rm -rf ~/clawboo-work`, with the server stopped), which loses any uncommitted work in those worktrees, then run `git worktree prune` in each repository. Do that only when no other install uses the same work folder (through `CLAWBOO_WORK_DIR`): deleting it would remove that install's team folders and checkouts too. A shared folder is cleaned by hand, removing only the reset install's team folders and the checkouts whose `.<task id>.owner` file holds its id.

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

- The database holds 51 tables and runs in SQLite's WAL mode, which is why the `-wal` and `-shm` files sit beside it. `clawboo backup` uses SQLite's online backup, so its copy needs no working files. See the [database schema](/reference/database-schema).
- `clawboo stop` sends the server a stop signal. On macOS and Linux the server stops its agent processes, folds the working files into `clawboo.db` and closes it, so after a clean stop `clawboo.db` alone holds every saved change. On Windows the process is ended at once with none of those steps, so copy the `-wal` and `-shm` files with the database.
- The `POST /api/system/configure-openclaw` route, which no dashboard screen calls, replaces `openclaw.json` and `.env` outright and mints a new Gateway token. The dashboard's OpenClaw setup uses the route that fills in only what is missing.

</Accordion>

## Related

- [CLI reference](/reference/cli): `clawboo backup`, `clawboo stop`, `clawboo restart`, and how `clawboo` finds the server.
- [Environment variables](/reference/environment-variables): `CLAWBOO_HOME`, `CLAWBOO_WORK_DIR`, `CLAWBOO_RUNTIMES_DIR`, `CLAWBOO_DB_PATH`, `CLAWBOO_SECRETS_MASTER_KEY`, `OPENCLAW_STATE_DIR`.
- [Security](/operating/security): the vault, the master key, and who can reach the server.
- [MCP servers](/operating/mcp-servers): attach outside agents and point the stdio bins at the right database.
- [Database schema](/reference/database-schema): every table in `clawboo.db`.
