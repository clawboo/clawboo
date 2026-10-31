---
title: 'Install, update and remove Clawboo'
sidebarTitle: 'Install'
description: 'What Clawboo needs, how to run it with npx or a global npm install, what the clawboo command starts, and how to stop, update or uninstall it.'
icon: 'download'
keywords:
  ['npm', 'npx', 'node', 'update', 'upgrade', 'uninstall', 'port', 'server log', 'Claude Agent SDK']
---

Clawboo installs from npm and runs as a small server on your computer that you use in your browser. This page covers what you need, the two ways to run it, what the `clawboo` command does, and how to stop, update and remove it. To go straight to a working team, follow the [Quickstart](/getting-started/quickstart).

<Note>

These docs track the latest code. The latest npm release is 0.5.0, so some features described here arrive with the next release; see the Unreleased section of the [changelog](/appendices/changelog).

</Note>

## Requirements

- **Node.js 22.12 or newer.** Check with `node --version`. On an older Node, `clawboo` stops right away with a message naming the version it found. Get Node from [nodejs.org](https://nodejs.org) or a version manager such as nvm or fnm.
- **A terminal and a web browser.** You type one command; everything after that happens in the browser.
- **An AI provider, chosen during setup:** an API key, a local Ollama, or a ChatGPT subscription. You don't need one to install.
- **Only if you add OpenClaw teammates:** OpenClaw needs Node 22.22.3 or later on the 22 line, 24.15 or later on the 24 line, or 25.9 or later. Clawboo does not check this before it installs OpenClaw, so compare `node --version` first.

There is no Clawboo account, Docker image or database to set up.

## Run Clawboo

<Tabs>

<Tab title="Try it with npx">

```bash
npx clawboo@latest
```

Keep `@latest`: a bare `npx clawboo` can reuse an older copy from npm's cache. An npx run cannot update itself from the dashboard; see [Update Clawboo](#update-clawboo).

</Tab>

<Tab title="Install it globally">

```bash
npm install -g clawboo
clawboo
```

A global install gives you a lasting `clawboo` command and one-click updates from the dashboard.

</Tab>

</Tabs>

On a first start the terminal shows:

```text
✔ Dashboard started
✔ Clawboo opened at http://localhost:18790
```

Your browser opens on the setup wizard. Continue with the [Quickstart](/getting-started/quickstart).

### Add Claude Code teammates (optional)

The Claude Code runtime needs the Claude Agent SDK, which the `clawboo` package does not include because it would add about 210 MB to every install. Install the two together, globally:

```bash
npm install -g clawboo @anthropic-ai/claude-agent-sdk
```

To check it, run `npm ls -g @anthropic-ai/claude-agent-sdk`: it lists the package when it is installed. A one-off `npx` run cannot load the SDK. Then connect Claude Code in **Settings → Runtimes**; see [Claude Code](/runtimes/claude-code).

## What the clawboo command does

1. Checks your Node.js version.
2. Says whether an OpenClaw Gateway answers on its default port (18789). This is information only; you don't need a Gateway.
3. Finds the Clawboo server if it is already running, or starts it. If the running server is older than the command you ran, it offers to restart it on the new version.
4. Opens your browser at the dashboard.

**The server keeps running after you close the terminal.** Run `clawboo` again to reopen the dashboard: it finds the running server instead of starting a second one.

| Detail          | Value                                                                                   |
| --------------- | --------------------------------------------------------------------------------------- |
| Address         | `http://localhost:18790`, or the next free port up to 18809                             |
| Who can connect | Only this computer: the server listens on 127.0.0.1 unless you set `HOST`               |
| Server log      | `~/.clawboo/server.log`, which rolls over to `server.log.1` past 5 MB                   |
| Fixed port      | `CLAWBOO_API_PORT=18800 clawboo` uses exactly that port and fails if something holds it |

The [CLI reference](/reference/cli) covers how the command finds the server, and every flag.

## Stop and restart

```bash
clawboo stop
clawboo restart
```

- `clawboo stop` stops the server. Running it when nothing is running is safe.
- `clawboo restart` stops the server, starts a fresh one on the same port and opens the browser. Add `--no-open` to skip the browser.
- `clawboo backup` saves a one-file copy of the database in the folder you run it from, even while the server runs.

If you run Clawboo with npx, use `npx clawboo@latest stop` and so on.

## Update Clawboo

When a newer version is on npm, an **Update available** chip appears at the bottom left of the dashboard.

- **Global install:** click the chip (**Click to update**). Clawboo installs the new version, restarts the server and reloads the page.
- **npx run:** click the chip (**Copy command**) to copy `npx clawboo@latest`, then run it in a terminal. It notices the older server still running and offers to restart it.

To update a global install from a terminal instead:

```bash
npm install -g clawboo@latest
clawboo
```

The second command offers to restart the older server; `clawboo -y` restarts it without asking. Your data stays where it is: a newer version adds what it needs to your existing database when it opens it.

## Uninstall

1. Optional: in **Settings → Providers**, click **Disconnect** on each key you added there. Keys saved in that panel are also written in plain text to OpenClaw's `~/.openclaw/.env` and to each OpenClaw agent's key file, and **Disconnect** removes every copy.
2. Stop the server and remove the package with the two commands below.
3. To delete your data as well, remove the `~/.clawboo` folder.

```bash
clawboo stop
npm uninstall -g clawboo
```

<Warning>

Deleting `~/.clawboo` permanently removes your teams, tasks, chats, memory, settings and saved keys. To keep a copy of the database, run `clawboo backup` before you uninstall.

</Warning>

If you only used npx, there is no global package: run `npx clawboo@latest stop`, then remove `~/.clawboo` if you want. OpenClaw, Codex, Claude Code and Hermes are separate programs, and uninstalling Clawboo leaves them in place.

## Where your data lives

Clawboo keeps its data in `~/.clawboo` (set `CLAWBOO_HOME` to use another folder): the database, settings, the encrypted key vault and the server log. Setting up OpenClaw, and saving keys under **Settings → Providers**, also write to OpenClaw's `~/.openclaw` folder. [Data and state](/operating/data-and-state) lists every file and covers backup and reset.

## Troubleshooting

<AccordionGroup>

<Accordion title="Clawboo requires Node.js 22.12 or newer">

Your Node is too old for Clawboo. Install Node 22.12 or newer from [nodejs.org](https://nodejs.org), or switch with a version manager (`nvm install 22` or `fnm use 22`), then run the command again.

</Accordion>

<Accordion title="Dashboard is taking too long to start.">

The first start can be slow, especially on Windows while antivirus software scans the new files. The command waits up to 45 seconds. When it gives up, it prints the last lines of `~/.clawboo/server.log` and the log's full path: read the log for the reason, fix it, then run `clawboo` again.

</Accordion>

<Accordion title="Could not find the Clawboo server.">

The installed package is incomplete. Run `npx clawboo@latest`, or reinstall with `npm install -g clawboo`.

</Accordion>

<Accordion title="A Clawboo server is running on port N, but it requires an access token.">

You set `STUDIO_ACCESS_TOKEN` to protect the dashboard, so the command cannot talk to the server. Open `http://localhost:18790/?access_token=YOUR_TOKEN` once in your browser (use the port the message names), or unset the variable and restart the server. `clawboo stop` and `clawboo restart` cannot confirm a protected server either; they print a command that stops it by hand.

</Accordion>

<Accordion title="The dashboard opened on an unexpected port">

If your shell sets a `PORT` variable, Clawboo uses that port instead of 18790. Unset it, or choose a port with `CLAWBOO_API_PORT`. The address Clawboo prints is always the right one.

</Accordion>

<Accordion title="The update chip says the update failed">

The chip shows npm's own reason. A permission error means npm cannot write to its global folder, which is common with a system-wide Node. The chip then suggests running the update with `sudo` in a terminal. To avoid `sudo`, install Node with a version manager such as nvm or fnm, which keeps global packages in your home folder, and install Clawboo again under it. If the update installed but the page did not come back, run `clawboo restart`.

</Accordion>

</AccordionGroup>

For other problems, see [Troubleshooting](/help/troubleshooting).

## Next steps

- [Quickstart](/getting-started/quickstart): connect an AI provider and deploy your first team.
- [Data and state](/operating/data-and-state): every file Clawboo keeps, backup and reset.
- [CLI reference](/reference/cli): every command and flag.
- [Remote access](/guides/self-host-securely): reach Clawboo from another machine.
