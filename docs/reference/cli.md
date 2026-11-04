---
title: 'CLI reference'
sidebarTitle: 'CLI'
description: 'Every clawboo command and flag: start the dashboard, sign a browser in, stop or restart its background server, back up the database, and run the MCP stdio bins.'
keywords:
  [
    'clawboo command',
    'npx clawboo',
    'clawboo stop',
    'clawboo restart',
    'clawboo open',
    'clawboo backup',
    'server.log',
    'port discovery',
    'clawboo-mcp-tasks',
  ]
---

The `clawboo` command starts the dashboard and manages the server behind it. Use this page to look up a command or flag, what it prints, and when it exits with an error.

| Command                 | What it does                                                        |
| ----------------------- | ------------------------------------------------------------------- |
| `clawboo`               | Find or start the dashboard server, then open it in your browser    |
| `clawboo stop`          | Stop the running dashboard server                                   |
| `clawboo restart`       | Stop the server and start a fresh one on the same port              |
| `clawboo open`          | Open the running dashboard in your browser, signed in               |
| `clawboo backup [dest]` | Write a one-file copy of the database, safe while the server runs   |
| `clawboo --version`     | Print the CLI version (`-V` for short)                              |
| `clawboo --help`        | Print usage (`-h` for short)                                        |
| `clawboo-mcp-*`         | Four MCP servers over stdio, for agent programs you set up yourself |

Install once with `npm install -g clawboo`, then run `clawboo`. For a one-off run without installing, use `npx clawboo@latest`. Every command checks your Node version first: on Node older than 22.12 it prints "Clawboo requires Node.js 22.12 or newer", your version and how to switch, then exits with code 1.

## clawboo

Run with no subcommand, `clawboo` gets you to a working dashboard:

1. It prints the logo and `Clawboo v<version>`.
2. It checks whether an OpenClaw Gateway answers on `localhost:18789` and says so. This is information only; the dashboard handles Gateway setup either way.
3. It looks for a running dashboard (see [Port discovery](#port-discovery)).
4. If it finds one, it compares that server's version with its own and may offer a restart (see [Version check](#version-check)).
5. If none is running, it starts one in the background and waits up to about 45 seconds for it to answer.
6. It opens the dashboard in your browser, prints "Clawboo opened at" with the URL, and lists next steps.

The URL is `http://127.0.0.1:<port>`, or `http://127.0.0.1:<port><prefix>/` when you set `CLAWBOO_BASE_PATH`: the address the server listens on. The CLI uses it rather than `localhost`, which can resolve to `::1`, where another program could be listening on the same port. When `HOST` names another loopback address, `::1` or another `127.x`, the CLI uses that one, since it is all such a server listens on. For `HOST=localhost`, which leaves the address to the system, set `HOST=127.0.0.1` or `HOST=::1` instead. A browser signed in at one of these addresses is not signed in at the other. The browser opens with `open` on macOS, `start` on Windows and `xdg-open` elsewhere. On a server with an access token, which is every install unless you turn it off, the browser opens a one-time sign-in link instead: the same URL with `?access_code=<code>` added, which signs the browser in once, within two minutes (see [Signing in a browser](#signing-in-a-browser)). Only the plain URL is printed. When no browser opens, as on a server with no desktop, it prints "Could not open a browser on this computer." and suggests `clawboo open --print`. When the server gives no sign-in link (it did not answer in time, or it is older than one-time links), the browser opens the plain address, and the CLI says it opened without a sign-in link and to run `clawboo open` if the dashboard says it is locked.

| Flag                 | Effect                                                |
| -------------------- | ----------------------------------------------------- |
| `-V`, `--version`    | Print the version and exit                            |
| `-h`, `--help`       | Print usage and exit                                  |
| `--no-version-check` | Attach to a running server without comparing versions |
| `-y`, `--yes`        | Restart an older running server without asking        |

`--no-version-check` and `-y` apply to `clawboo` itself. `clawboo restart` takes `--no-open`, `clawboo open` takes `--print`, `clawboo backup` takes `-f, --force`, and `clawboo stop` takes no flags. A mistyped subcommand, such as `clawboo stopp`, prints `error: unknown command 'stopp'` with the help text and exits 1 instead of starting anything.

### Version check

A server keeps running the code it started with, so after an upgrade the running server can be older than the CLI you just installed. Before attaching, `clawboo` asks the server for its version (`GET /api/system/self-version?local=1`, with a 2-second timeout). The `local=1` part tells the server to skip its npm lookup, so this check stays on your machine.

- It offers a restart only when both versions are real releases and the CLI is newer. It never offers a downgrade, and a source checkout (version `0.0.0-dev`) is never compared.
- The prompt reads "Restart it on port N to run vX?" and defaults to yes. `-y` answers yes for you.
- Declining, or pressing Ctrl-C at the prompt, keeps the running server and opens it.
- When stdin or stdout is not a terminal, it never prompts. It attaches and tells you to run `clawboo restart` or pass `-y`.
- If stopping the old server fails, it prints why and a manual stop command, then continues with the running server.
- If it stopped the old server and the new one never answers, it prints "The previous server was stopped and could not be replaced. Nothing is running now." and exits 1.

This check compares the server with your CLI. The **Update available** chip in the dashboard is a separate check against npm, described in the [System API](/reference/rest-api/system).

## Port discovery

`clawboo`, `clawboo stop` and `clawboo restart` all find the server the same way, so they act on the same instance:

1. **`CLAWBOO_API_PORT`**, when set to a valid port (1-65535): only that port is checked.
2. **The port file** `<CLAWBOO_HOME>/api-port.txt` (default `~/.clawboo/api-port.txt`), which the server writes when it starts listening.
3. **The default range**, ports 18790 through 18809.

Each candidate gets a quick TCP check, then a `GET /api/settings`. Only a reply with Clawboo's JSON shape counts, so another service listening in that range (OpenClaw's helper ports, a Chrome debugging port) is never mistaken for the dashboard. A server with an access token answers that request with a `401` first; see [Token-gated installs](#token-gated-installs). A server you started with a different `CLAWBOO_API_PORT_START` is found only through the port file. `clawboo backup` does not look for a server at all.

## The background server and its log

The server runs detached: it keeps running after `clawboo` exits or you close the terminal. Stop it with `clawboo stop`.

- **Normal install.** The CLI starts the bundled server with `~/.clawboo` as its working directory (created with owner-only permissions if missing) and `NODE_ENV=production`.
- **Source checkout.** With no bundled server, it runs `npx tsx apps/web/server/index.ts` from the repository root, found by walking up to a `package.json` named `clawboo` (`CLAWBOO_SERVER_PATH` overrides the search). With neither, it prints "Could not find the Clawboo server. Install with: npm install -g clawboo" and exits 1.
- **Log.** The server's output goes to `~/.clawboo/server.log`, with a header line `--- clawboo v<version> · pid <pid> ---` for each launch. A log over 5 MiB is renamed to `server.log.1` at the next launch. If the log cannot be opened, the output is discarded.
- **Slow start.** The CLI checks for the dashboard every 500 ms, 90 times (about 45 seconds). If it never answers, the CLI prints "Dashboard is taking too long to start.", the last 12 lines of the log and the log's path, then exits 1. It never starts a second server.
- **After an in-app update.** A server that the dashboard's update restarted writes nothing to this log. Run `clawboo restart` to get logging back.

## clawboo stop

```bash
clawboo stop
```

Stops the dashboard server that `clawboo` would open. To target one port, run `CLAWBOO_API_PORT=<port> clawboo stop`.

1. It finds the server through [port discovery](#port-discovery) and confirms the port really is a Clawboo dashboard.
2. It looks up the process listening on that port (`lsof` on macOS and Linux, `netstat -ano` on Windows) and sends it SIGTERM.
3. It waits up to 4 seconds for the port to close. If it is still open, it checks that the same process still holds it, sends SIGKILL, and waits up to 2 more seconds.
4. It prints "Clawboo stopped (pid N)", or "(pid N, forced)" when SIGKILL was needed.

With nothing running, it prints "No Clawboo server is running.", removes a leftover `api-port.txt` that names a dead server, and exits 0, so it is safe in teardown scripts. It never signals process 1, itself or its parent.

When the stop fails it exits 1 and prints a manual stop command after one of these reasons:

- "The server on port N did not exit."
- "The process on port N belongs to another user."
- "Port N is held by a process this launcher refuses to signal."
- "Could not identify the process listening on port N." (also printed when neither `lsof` nor `netstat` is available)

Stopping the server interrupts any work in progress. On macOS and Linux the server first signals the runtime processes it started and waits up to 5 seconds for them, removes `api-port.txt` if it still names its port, and checkpoints the database. On Windows the stop ends the process at once, so none of that runs: `clawboo stop` removes the port file itself and the database recovers when it is next opened. Routines are re-armed when the server starts again. An OpenClaw Gateway that Clawboo started keeps running.

## clawboo restart

```bash
clawboo restart
clawboo restart --no-open
```

Stops the server as `clawboo stop` does, then starts a new one on the same port, so a browser tab that is already open reconnects. It opens the browser the way `clawboo` does, with a one-time sign-in link on a server with an access token. Use it after `npm install -g clawboo@latest` (the running server keeps its old code until it restarts) or after you change an environment variable the server reads at startup.

| Flag        | Effect                                   |
| ----------- | ---------------------------------------- |
| `--no-open` | Do not open the browser after restarting |

- The new server is pinned to the old port with `CLAWBOO_API_PORT` and waits up to 15 seconds for it to free (`CLAWBOO_AWAIT_PORT`). If something else took the port in between, the new server starts without the pin and picks a port the usual way.
- With nothing running, it starts a server.
- If the stop fails, it exits 1 and does not start a replacement, so you never end up with two servers.
- If the new server never answers, it prints "The previous server was stopped and could not be replaced. Nothing is running now." and exits 1.

In a source checkout run with `pnpm dev`, the dev script supervises the server and may start it again on its own. Restart through the dev script there.

## clawboo open

```bash
clawboo open
clawboo open --print
```

Opens the running dashboard in your browser, signed in. Each run makes a fresh one-time sign-in link, so this is also the way back in for a browser that shows "This dashboard is locked to your computer". It finds the server through [port discovery](#port-discovery) and never starts one: with nothing running it prints "No Clawboo server is running." and exits 1.

| Flag      | Effect                                               |
| --------- | ---------------------------------------------------- |
| `--print` | Print the one-time link instead of opening a browser |

With `--print`, the link is the only thing written to standard output, so you can pipe it, and a note goes to standard error. Use it on a computer with no browser, or for another browser on this computer. The link names `127.0.0.1`; through an SSH tunnel that forwards the same port it opens as printed, and from another computer on the network, use this computer's address in its place. On a server with no access token, it prints the plain address and says no sign-in is needed. On a server older than one-time links, it prints the plain address and suggests `clawboo restart`.

## Signing in a browser

Every `/api/*` request needs the access cookie when the server has an access token. A server started with `STUDIO_ACCESS_TOKEN` unset locks itself with the per-install token in `~/.clawboo/access-token`, so that is every install unless you set `STUDIO_ACCESS_TOKEN` yourself or set it blank to turn the gate off. The CLI asks the server for a one-time sign-in code (`POST /api/access/launch-code`) and opens `?access_code=<code>`, which the server trades for the cookie once, within two minutes. The access token itself never goes into a URL or the command line of the program that opens your browser. [Security](/operating/security#the-access-token) has the details.

## Token-gated installs

The CLI uses the same token as the server: `STUDIO_ACCESS_TOKEN` from the shell you run it in when it is set, no token when it is set blank, and otherwise the token in `~/.clawboo/access-token` (it follows `CLAWBOO_HOME`), which it only reads. A server that `clawboo` starts gets the shell's environment, so both pick the same token. The CLI asks each port without the token first. A port is asked again with the token as the cookie only when it answers with the access gate's own refusal, which names Clawboo, and it is the port the server recorded in `api-port.txt`, at the address above. So another service in the port range, or another user's program imitating the gate, never receives it. That includes a `STUDIO_ACCESS_TOKEN` set in the shell: `CLAWBOO_API_PORT` alone never qualifies a port, since it stays set while the server is down. For a server whose `api-port.txt` this shell cannot see (one in a container, or with another `CLAWBOO_HOME`), point `CLAWBOO_HOME` at that server's folder, or manage it with its own service manager. A server that cannot write `api-port.txt` logs a warning that the CLI cannot sign in to it.

- **The CLI has the server's token.** `clawboo`, `clawboo open`, `clawboo stop` and `clawboo restart` work as they do on an install without a token, and the browser opens signed in. A server older than one-time links cannot give a sign-in code; with `STUDIO_ACCESS_TOKEN` set, `clawboo` then prints "STUDIO_ACCESS_TOKEN is set. If the dashboard does not load, open `http://127.0.0.1:<port>/?access_token=<token>` once in this browser."
- **The CLI has no token, or a different one.** This happens with a server started with a `STUDIO_ACCESS_TOKEN` that this shell does not have. The CLI can still tell that a Clawboo server is answering, because the access gate's refusal names Clawboo. `clawboo` prints "A Clawboo server is running on port N, but it requires an access token.", a line saying to set the server's token in this shell (or that this shell's token is not the server's), and the address to open once, `http://127.0.0.1:<port>/?access_token=<token>`. Then it exits 1 without starting a second server. `clawboo open` prints the same notice and exits 1. `clawboo stop` and `clawboo restart` print it with a manual stop command, then exit 1. They never signal a process they could not identify.

To stop or restart a server started with your own token, set that token in the shell first:

<Tabs>
  <Tab title="macOS and Linux">

```bash
export STUDIO_ACCESS_TOKEN=<token>
clawboo restart
```

  </Tab>
  <Tab title="Windows">

```powershell
$env:STUDIO_ACCESS_TOKEN = "<token>"
clawboo restart
```

  </Tab>
</Tabs>

The new server gets the token from that shell, so it keeps the access gate on. To skip the CLI for a gated install, start the server directly as shown in [Deployment](/operating/deployment). See [Self-host securely](/guides/self-host-securely) for choosing and setting the token.

## clawboo backup

```bash
clawboo backup
clawboo backup ~/backups/
clawboo backup ~/clawboo.db.bak --force
```

Copies the database to a single file. It opens `<CLAWBOO_HOME>/clawboo.db` (default `~/.clawboo/clawboo.db`) read-only and uses SQLite's online backup, so it is safe while the server runs and the copy includes the latest writes. The result needs no `-wal` or `-shm` files beside it.

| Argument or flag | Effect                                                                                                                                                   |
| ---------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `[dest]`         | Omitted: `clawboo-backup-YYYYMMDD-HHMMSS.db` (local time) in the current folder. An existing folder: that name inside it. Anything else: that file path. |
| `-f`, `--force`  | Replace an existing destination. Without it, the command refuses with "Refusing to overwrite (pass --force to clobber)" and exits 1.                     |

It prints the file's path and size. With no database yet it prints "No Clawboo database found at" the path, "Start the server once to create it, or set CLAWBOO_HOME.", and exits 1.

To restore, stop the server (`clawboo stop`) and copy the backup over `clawboo.db`. A database backup does not include `~/.clawboo/secrets/`, where your saved provider keys and the key that decrypts them live. The copy is owner-only (mode `0600`, like the live database) before anything is written to it, and a failed backup removes its partial file. It holds your chats and settings, so keep it private. [Data and state](/operating/data-and-state) covers what a full backup needs.

## Exit codes

Every command exits 0 on success and 1 on failure. Any command also exits 1 on Node older than 22.12 or when given an unknown subcommand.

| Command                 | Exits 0 when                                                        | Exits 1 when                                                                                                                                                                      |
| ----------------------- | ------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `clawboo`               | The browser opened on a found, restarted or newly started dashboard | Only a token-gated dashboard was found and the shell does not have its token; no server to start; the start timed out; an older server was stopped for a restart and not replaced |
| `clawboo stop`          | The server stopped, or nothing was running                          | The dashboard is token-gated and the shell does not have its token; the process could not be stopped or identified                                                                |
| `clawboo restart`       | A server is running again (or was started from nothing)             | The dashboard is token-gated and the shell does not have its token; the stop failed; the new server did not answer                                                                |
| `clawboo open`          | The browser opened signed in, or `--print` printed a link           | No server is running; the dashboard is token-gated and the CLI does not have its token; no browser could be opened                                                                |
| `clawboo backup [dest]` | The copy was written                                                | No database exists; the destination exists and `--force` was not given                                                                                                            |

## Environment variables

These are the variables the CLI itself reads or sets. Everything else in your shell passes through to the server unchanged; the server reads many more, listed in [Environment variables](/reference/environment-variables).

| Variable              | Read or set          | Effect                                                                                                                                                                                                                            |
| --------------------- | -------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `CLAWBOO_API_PORT`    | read, and set        | Read: check only this port. Set on the new server when a restart pins the old port.                                                                                                                                               |
| `CLAWBOO_AWAIT_PORT`  | set                  | Set with the pin, so the new server waits up to 15 seconds for the port to free.                                                                                                                                                  |
| `CLAWBOO_HOME`        | read                 | Where `api-port.txt`, `access-token`, `server.log` and (for `backup`) `clawboo.db` live. Default `~/.clawboo`. Also the server's working directory.                                                                               |
| `CLAWBOO_BASE_PATH`   | read                 | Added to every URL the CLI prints or opens. An invalid value is ignored here; the server itself refuses to start on it.                                                                                                           |
| `STUDIO_ACCESS_TOKEN` | read                 | The token sent as the access cookie, only to the recorded port and only after the access gate's refusal. Unset: the CLI reads `access-token` instead. Blank: no token. A server the CLI starts gets it like every other variable. |
| `CLAWBOO_SERVER_PATH` | read                 | Repository root to use for a source-checkout start.                                                                                                                                                                               |
| `CLAWBOO_LAUNCH_DIR`  | set                  | The folder you ran `clawboo` from, offered as "Where you started clawboo" when you set up a connector that needs a folder.                                                                                                        |
| `CLAWBOO_VERSION`     | set                  | The CLI's version, which the server reports as its own.                                                                                                                                                                           |
| `CLAWBOO_MCP_BIN_DIR` | set (normal install) | Where the MCP stdio bins are, so the server can print stdio attach snippets.                                                                                                                                                      |
| `NODE_ENV`            | set                  | `production` on the server it starts.                                                                                                                                                                                             |

## MCP stdio bins

The package also installs four MCP servers that speak over stdio. You add them to an agent program you set up yourself (for example, your own Claude Code or Codex); Clawboo's own agents reach the same servers over HTTP inside the dashboard server.

| Bin                    | MCP server                          |
| ---------------------- | ----------------------------------- |
| `clawboo-mcp-tasks`    | Tasks: the board                    |
| `clawboo-mcp-memory`   | Memory: saved facts and procedures  |
| `clawboo-mcp-tools`    | Tools: built-in and connector tools |
| `clawboo-mcp-teamchat` | TeamChat: the agents' peer room     |

By default the bins open `~/.openclaw/clawboo/clawboo.db`, which is a different file from the dashboard's `~/.clawboo/clawboo.db`. To work on the dashboard's board and memory, set `CLAWBOO_DB_PATH` to the dashboard's file. The stdio snippet from `GET /api/mcp/config?transport=stdio` already includes it. The bins and the server can use the same file at once.

```bash
CLAWBOO_DB_PATH="$HOME/.clawboo/clawboo.db" clawboo-mcp-tasks
```

- The memory bin looks for an embedding provider every 60 seconds: a local Ollama with `nomic-embed-text` at `http://localhost:11434`, then `OPENAI_API_KEY` when remote embeddings are allowed. With neither, memory search is keyword-only.
- The tools bin offers the two built-in tools, `echo` and `note`, and `read_tool_result`. It has no connector tools.
- A stdio caller has no Clawboo identity: TeamChat tools take the author and team as arguments.

See [MCP servers](/operating/mcp-servers) to attach an outside agent and [MCP tools](/reference/mcp-tools) for every tool and its inputs.

<Accordion title="Under the hood">

- The `clawboo` bin is `dist/bootstrap.js`. It checks the Node version before loading any dependency, because the CLI is CommonJS that loads ESM-only packages, which Node 22.0 to 22.11 cannot do. Each subcommand repeats the check.
- The version is compiled in from `apps/cli/package.json`; running the source directly reports `0.0.0-dev`.
- The MCP bins are bundled with their dependencies, except `better-sqlite3`, `ws`, `pino` and `pino-pretty`, which resolve from the CLI's own dependencies. The OpenTelemetry packages are left out.
- The CLI reads the database only for `backup` and never changes settings or the vault. Its own writes are creating `~/.clawboo` when missing, appending to `server.log`, and removing a stale `api-port.txt`.
- Source of truth: `apps/cli/src/index.ts`, `apps/cli/src/lifecycle.ts`, `apps/cli/src/server-log.ts`, `apps/cli/src/node-version.ts`, `apps/cli/src/versionCheck.ts`.

</Accordion>

## Related

- [Installation](/getting-started/installation): install Clawboo and run it the first time
- [Data and state](/operating/data-and-state): everything under `~/.clawboo`, full backup and reset
- [Environment variables](/reference/environment-variables): every variable the server reads
- [Limits and defaults](/reference/limits-and-defaults): the timeouts on this page next to every other number
- [Troubleshooting](/help/troubleshooting): fixes for a start timeout and other errors
