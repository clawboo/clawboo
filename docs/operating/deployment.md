---
title: 'Run the Clawboo server'
sidebarTitle: 'Deployment'
description: 'Start the Clawboo server with the launcher or directly, keep it running as a service, update it, and find its port and logs.'
keywords:
  [
    'deployment',
    'deploy',
    'systemd',
    'service',
    'server',
    'port',
    'server.log',
    'update',
    'CLAWBOO_API_PORT',
    'CLAWBOO_UI_DIR',
  ]
---

Clawboo runs as one server process. On one port it serves the dashboard, its API and a WebSocket for the OpenClaw Gateway. Use this page to start that server, keep it running as a service, update it and find its logs. To open the dashboard from another computer, see [Reach Clawboo from another machine](/guides/self-host-securely).

## Before you begin

- **Node.js 22.12 or newer.** The `clawboo` command checks this and stops with a message on an older Node.
- **Clawboo installed** with `npm install -g clawboo` ([Install Clawboo](/getting-started/installation)). The package holds the launcher, the server (`dist/server.js`), the dashboard files (`dist/ui`) and the four MCP programs (`dist/bin`).

## Ways to run it

| How               | Command                                        | Use it for                                                                       |
| ----------------- | ---------------------------------------------- | -------------------------------------------------------------------------------- |
| The launcher      | `clawboo`                                      | Your own computer: it starts the server in the background and opens your browser |
| A direct start    | `node "$(npm root -g)/clawboo/dist/server.js"` | A service manager, a container, or any install with an access token              |
| A source checkout | `pnpm dev`                                     | Working on Clawboo itself ([Monorepo and build](/internals/monorepo-and-build))  |

## Start with the launcher

```bash
clawboo
```

The launcher does three things:

1. It looks for a Clawboo server that is already running ([how it finds the port](/reference/cli)) and opens your browser at it. If that server runs an older version than the launcher, it offers to restart it: `-y` restarts without asking, and `--no-version-check` skips the check.
2. If none is running, it starts the server in the background. The server's working directory is your Clawboo folder (`~/.clawboo`), and its output goes to `~/.clawboo/server.log`.
3. It waits up to 45 seconds for the server to answer, then opens `http://localhost:<port>/` (plus your `CLAWBOO_BASE_PATH`, when one is set).

The server keeps running after the launcher exits. `clawboo stop` stops it, and `clawboo restart` replaces it on the same port; see the [CLI reference](/reference/cli).

<Note>

With `STUDIO_ACCESS_TOKEN` set, the launcher cannot read the server's status. It cannot tell when a token-protected server is ready, and it will not stop or restart one. `clawboo`, `clawboo stop` and `clawboo restart` report that a server is running and requires an access token. `clawboo stop` also prints a command that stops it by port. Start a token-protected server directly instead.

</Note>

## Start the server directly

```bash
mkdir -p ~/.clawboo
cd ~/.clawboo
NODE_ENV=production node "$(npm root -g)/clawboo/dist/server.js"
```

- **It runs in the foreground** and logs to the terminal. `NODE_ENV=production` gives plain JSON log lines, as with the launcher.
- **Ctrl+C stops it cleanly.** It stops the agent processes it started, waits up to 5 seconds for them, and closes the database.
- **Start it from your Clawboo folder**, as the launcher does. Claude Code, Codex and Hermes start in the server's working directory whenever a run has no worktree: every team-chat turn, research and review tasks, and Routines you make in the dashboard.
- **The dashboard files** come from the `ui` folder next to `server.js`. `CLAWBOO_UI_DIR` points somewhere else. If Clawboo cannot read `index.html` there, page loads answer `503` with "The Clawboo dashboard could not be read from disk. Check CLAWBOO_UI_DIR."
- **MCP attach snippets.** To make the stdio snippets from `GET /api/mcp/config` name the bundled MCP programs, also set `CLAWBOO_MCP_BIN_DIR="$(npm root -g)/clawboo/dist/bin"`, as the launcher does.

### Run it as a service

A service manager keeps the server running after you log out and restarts it if it crashes. On Linux with systemd, a user service looks like this:

```ini
# ~/.config/systemd/user/clawboo.service
[Unit]
Description=Clawboo

[Service]
WorkingDirectory=%h/.clawboo
Environment=NODE_ENV=production
EnvironmentFile=%h/.config/clawboo/clawboo.env
ExecStart=/usr/bin/node /usr/lib/node_modules/clawboo/dist/server.js
Restart=on-failure

[Install]
WantedBy=default.target
```

Replace the two paths in `ExecStart` with the output of `command -v node` and `npm root -g`. Agents and connectors find programs through `PATH`. If Node, npm or your agent runtimes live outside the system folders (under nvm, for example), add an `Environment=PATH=...` line with your shell's `PATH`.

Put your settings in the environment file, one `NAME=value` per line, and keep the file readable only by you:

```bash
mkdir -p ~/.clawboo ~/.config/clawboo
touch ~/.config/clawboo/clawboo.env
chmod 600 ~/.config/clawboo/clawboo.env
```

```ini
# ~/.config/clawboo/clawboo.env
STUDIO_ACCESS_TOKEN=paste-your-token-here
CLAWBOO_API_PORT=18790
CLAWBOO_ALLOWED_HOSTS=dash.example.com
CLAWBOO_ALLOWED_ORIGINS=https://dash.example.com
```

Generate the token with `openssl rand -hex 24` and save it in your password manager before you start the server. Use only letters, digits, `.`, `_`, `~` and `-`: any other character turns the token check off.

The file mode keeps other user accounts out of the file. Programs running as you, agents included, can still read it: the token guards the network, not your own account.

Then turn the service on, and let it run while you are logged out:

```bash
systemctl --user daemon-reload
systemctl --user enable --now clawboo
loginctl enable-linger "$USER"
```

`journalctl --user -u clawboo` shows its log. On macOS, run the same server command under launchd, with the same working directory and variables. Under launchd there is no journal, so set `StandardOutPath` and `StandardErrorPath` in its plist to a log file (a full path, as launchd does not expand `~`) and read that file.

## Ports

| Setting                    | What the server does                                                                                               |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| Nothing set                | Takes the first free port from `18790`, trying 20 ports (up to `18809`)                                            |
| `CLAWBOO_API_PORT=N`       | Uses exactly `N`. If `N` is taken, it stops with `CLAWBOO_API_PORT=N is already in use.`                           |
| `PORT=N`                   | Uses `N` when `CLAWBOO_API_PORT` is unset and the server is not in dev mode, for hosting platforms that set `PORT` |
| `CLAWBOO_API_PORT_START=M` | Starts the search at `M` instead of `18790`                                                                        |

The server writes the port it chose to `~/.clawboo/api-port.txt`, and removes the file when it stops unless another instance has rewritten it. Pin the port when something else must find the server, such as a reverse proxy. To run a second, separate instance, give it its own `CLAWBOO_HOME` and port.

## Where the server keeps its files

Everything lives in your Clawboo folder, `~/.clawboo` by default (`CLAWBOO_HOME` moves it): the database, settings, the encrypted key vault, logs and task worktrees. Clawboo also writes to OpenClaw's folder (`~/.openclaw`) when you connect a key under **Providers**, set up OpenClaw, or change OpenClaw settings from the dashboard. [Data and state](/operating/data-and-state) lists every file and covers backups and resets.

## Logs

- A server the launcher started writes to `~/.clawboo/server.log`. When the launcher starts a server and the log is over 5 MB, it first moves the old log to `server.log.1`.
- A direct start logs to its terminal, or to your service manager's journal.
- An OpenClaw Gateway that Clawboo starts for you logs to `~/.clawboo/gateway.log`.
- `LOG_LEVEL` sets how much the server logs: `info` by default, `debug` for more.
- After an in-app update, the new server's output does not reach `server.log`. Run `clawboo restart` to capture it again.

## Update Clawboo

<Tabs>

<Tab title="In the dashboard">

When a newer version is on npm, an **Update available** chip appears at the bottom left. On a global npm install it reads **Click to update**: one click installs `clawboo@latest` with npm, restarts the server on the same port and reloads the page. For an `npx` run or a source checkout, the chip reads **Copy command** and copies the command to run instead. If npm fails, the chip shows npm's reason; a permissions error suggests `sudo npm install -g clawboo@latest`.

</Tab>

<Tab title="With npm">

```bash
npm install -g clawboo@latest
clawboo restart
```

Or run `clawboo`: it notices that the running server is older and offers to restart it.

With `STUDIO_ACCESS_TOKEN` set, `clawboo restart` cannot restart the server and the old version keeps running. Stop it with the command `clawboo restart` prints, or through the service manager that runs it, then start it again [directly](#start-the-server-directly) or through that service manager.

</Tab>

<Tab title="Under a service manager">

```bash
npm install -g clawboo@latest
systemctl --user restart clawboo
```

Skip the in-app update here. It replaces the server process itself, outside the service manager's control.

</Tab>

</Tabs>

To find updates, the server asks `registry.npmjs.org` for the latest version and keeps a successful answer for 6 hours.

## Behind a reverse proxy or on another machine

- **A proxy on the same machine:** leave `HOST` unset, pin `CLAWBOO_API_PORT`, and set `STUDIO_ACCESS_TOKEN` (unless the proxy authenticates every request), `CLAWBOO_ALLOWED_HOSTS` and `CLAWBOO_ALLOWED_ORIGINS`. Deny `/api/mcp/` at the proxy.
- **Another machine, a network or a container:** set `HOST=0.0.0.0` with the token and the two allowlists. Without a working token, the server refuses to start.
- **A hostname shared with other apps:** serve Clawboo under a path prefix with `CLAWBOO_BASE_PATH`.

[Reach Clawboo from another machine](/guides/self-host-securely) has the steps and the nginx, Caddy and Cloudflare Tunnel configs. On Clawboo 0.5.0 and older the `/api/mcp/` rule is required: see the advisory in the [Security model](/operating/security).

## Check that it is running

```bash
cat ~/.clawboo/api-port.txt
curl -s http://127.0.0.1:18790/api/settings
curl -s http://127.0.0.1:18790/api/health
```

Use the port from the first command. `/api/settings` answers with `gatewayUrl`, `hasToken` and `firstRunDismissedAt`. `/api/health` returns the startup checks, and `"ok": true` means none of the fatal ones failed. On a token-protected install both answer `401`, which also means the server is up. The **System Health** panel shows the same report.

## Troubleshooting

<AccordionGroup>

<Accordion title="CLAWBOO_API_PORT=N is already in use.">

A pinned port gets no fallback. Free that port, choose another, or unset `CLAWBOO_API_PORT` so the server picks a free one.

</Accordion>

<Accordion title="Dashboard is taking too long to start.">

The launcher waited 45 seconds without an answer. It prints the last lines of `~/.clawboo/server.log` and the log's path: read them for the cause. If you set `STUDIO_ACCESS_TOKEN`, the server may be running fine, because the launcher cannot see past the token. Open the dashboard with `?access_token=<your-token>`, and start token-protected servers directly from now on.

</Accordion>

<Accordion title="A Clawboo server is running on port N, but it requires an access token.">

Expected on a token-protected install. Open the address the message prints, with your token in place of `<token>`. To stop the server, press Ctrl+C in its terminal, use your service manager, or run the command `clawboo stop` prints.

</Accordion>

<Accordion title="Clawboo requires Node.js 22.12 or newer">

Install a current Node from nodejs.org, or switch with a version manager (`nvm install 22`, `fnm use 22`), then run `clawboo` again.

</Accordion>

<Accordion title="Page loads answer 503: The Clawboo dashboard could not be read from disk.">

`CLAWBOO_UI_DIR` does not point at the dashboard files. Unset it to use the `ui` folder that ships next to `server.js`.

</Accordion>

<Accordion title="Could not find the Clawboo server.">

The launcher cannot find `server.js` next to itself. Reinstall with `npm install -g clawboo`.

</Accordion>

<Accordion title="SECURITY: refusing to start">

`HOST` is set to a network address and the server has no working access token. See [Reach Clawboo from another machine](/guides/self-host-securely), or unset `HOST` to listen on `127.0.0.1` only.

</Accordion>

<Accordion title="SECURITY/CONFIG: CLAWBOO_BASE_PATH is invalid">

The message names the problem with the value. Use a prefix like `/clawboo`, or unset the variable to serve at the root.

</Accordion>

</AccordionGroup>

## Related

- [Reach Clawboo from another machine](/guides/self-host-securely): SSH tunnels, reverse proxies, network binds and path prefixes
- [Security model](/operating/security): what is protected by default, and where your keys are stored
- [`clawboo` CLI reference](/reference/cli): every command, port discovery, stop and restart
- [Data and state](/operating/data-and-state): every file in your Clawboo folder, backups and resets
- [Environment variables](/reference/environment-variables): every setting the server reads
- [Limits and defaults](/reference/limits-and-defaults): ports, timeouts, rate limits and other numbers
