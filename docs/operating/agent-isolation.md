---
title: 'Run agents as their own user'
sidebarTitle: 'Agent isolation'
description: "Set CLAWBOO_AGENT_USER so every agent runs as a separate operating system user that cannot read Clawboo's database, saved keys or settings, and how to set it up on Linux, macOS and in a container."
keywords:
  [
    'agent isolation',
    'CLAWBOO_AGENT_USER',
    'agent user',
    'sandbox',
    'sudo',
    'sudoers',
    'clawboo-launch',
    'no-new-privileges',
    'agent-user plan',
    'agent-user check',
  ]
---

By default, Claude Code, Codex, Hermes and Clawboo Native's commands run as your user account. They can open any file you can, including Clawboo's database and the vault that holds your saved keys. Set `CLAWBOO_AGENT_USER` and every agent runs as a separate user account instead, one that cannot read any of that. This page explains what that protects, what it does not, and how to set it up.

It is off unless you set it. An install without the setting runs exactly as before.

## What it protects, and what it does not

With the setting on, a prompt-injected agent can no longer:

- read the vault's key and the vault, and with them every saved provider key, website login and 1Password token;
- read or change Clawboo's database: the board, approvals, budgets, routines and connector grants;
- read the secret behind its MCP attach links, and so sign itself as another agent;
- read the access token and answer its own approval card through the API;
- read your own logins (`~/.openclaw/.env`, `~/.codex`, `~/.hermes`, `~/.claude`, `~/.ssh`), as long as your home folder is closed to other users (see [Before you start](#before-you-start));
- plant a git hook in your repository that runs as you later: task checkouts come from a copy of the repository the agent user owns;
- read a connector's token, trace the server, or kill it;
- read the access token or the vault key from the server's environment, where container deployments often pass them.

Clawboo checks the first and the last of these from inside the agent user's account every time it starts, and refuses to start when it cannot prove them.

It does **not**:

- limit network access. An agent can send what it can read anywhere, and reach other services on the machine that have no password of their own;
- protect an agent's own credentials from that agent: the provider key in its environment, its sign-ins and its browser's saved logins, and a [website login](/using/website-logins) Clawboo filled into its page;
- keep agents apart from each other. All agents share one agent user, so one team's agent can read another team's folder, and on Linux one agent's programs can open another agent's display;
- change what Clawboo's tools allow. Agents still reach the board, memory and team chat through Clawboo's MCP servers, and approvals, grants and budgets still apply;
- cover OpenClaw agents. They run inside the OpenClaw Gateway, as whoever started it. Use OpenClaw's own sandbox for them;
- protect you from running an agent's output yourself, such as merging its branch and running it;
- keep the server's own environment variables from agents, except the ones Clawboo knows to be secrets (its token, the vault key, well-known cloud and registry tokens). Keep other secrets out of the environment Clawboo starts in;
- hide the address and access link of Clawboo's MCP servers that a Claude Code run gets on its command line from other user accounts on the same computer.

It is not available on Windows. Run Clawboo under WSL 2 or in a Linux container to use it.

## How it works

When Clawboo starts with `CLAWBOO_AGENT_USER` set, it starts one long-lived process as that user, the agent host. Every agent process starts through it. Clawboo itself never runs an agent's command, git, or a file read or write in the agents' folders as your user.

| What                                                                          | Runs as                              |
| ----------------------------------------------------------------------------- | ------------------------------------ |
| Claude Code and Codex runs, and the Hermes gateway every Hermes agent runs in | the agent user                       |
| Clawboo Native's approved commands and its file tools                         | the agent user                       |
| The verify command a task's check runs                                        | the agent user                       |
| git in a task's checkout, and in the agent user's copy of each repository     | the agent user                       |
| Connectors with local reach and no saved credential, and each agent's browser | the agent user                       |
| Each agent's display on Linux, its window manager and session bus             | the agent user                       |
| Connectors that hold a saved credential (OAuth, an API key)                   | you, so agents cannot read the token |
| Clawboo itself, its database, the vault, installs and updates                 | you                                  |

Clawboo Native's model calls stay in the server, so its provider key never reaches the agent user.

Agents keep every tool. They reach Clawboo's MCP servers over HTTP on `127.0.0.1` with their attach link, which works across users.

### Where things live

| What                                                    | Where, with the setting on                    | Owner and mode     |
| ------------------------------------------------------- | --------------------------------------------- | ------------------ |
| Clawboo's data folder (`~/.clawboo`)                    | unchanged                                     | you, `0700`        |
| The database, the vault, settings, the token            | unchanged                                     | you, `0600`        |
| The work folder (team and task folders, task checkouts) | `<agent home>/work`, or `CLAWBOO_WORK_DIR`    | agent user, `0700` |
| Each agent's runtime home (`CODEX_HOME`, `HERMES_HOME`) | `<agent home>/runtimes/<runtime>/<agent>`     | agent user, `0700` |
| Claude Code's settings and sessions                     | the agent user's own `~/.claude`              | agent user         |
| Each agent's browser profile                            | `<agent home>/browser-profiles/`              | agent user, `0700` |
| Each agent's display: its VNC socket and X cookie       | `<agent home>/desktops/<hash>`                | agent user, `0700` |
| The agent user's copy of each repository                | `<work folder>/mirrors/<repository hash>.git` | agent user         |
| Clawboo Native's conversation history                   | unchanged, in the data folder                 | you                |

`<agent home>` is the agent user's home folder: `/var/lib/clawboo-agent` on Linux and `/var/clawboo-agent` on macOS with the setup commands below.

The first time Clawboo starts with the setting, it copies what agents already had into the agent user's space: each runtime home (Hermes memory and skills, Codex sessions) and each team folder. A Hermes agent's copied home then moves into its profile in the Hermes gateway's home on its first run. It never copies a link, a file with more than one hard link, a sign-in or key file (`auth.json`, `.env`: before, those were copies of your own logins and keys), or Clawboo Native's history, and names what it skipped in the log. The originals stay where they were, so turning the setting off again is the way back.

### Task checkouts

Without the setting, a task's checkout is a git worktree of your repository and shares its `.git` folder, hooks and config included. With it, the agent user keeps its own copy of the repository, and only data moves between the two:

- When a task starts, Clawboo bundles the commit it starts from in your repository and the agent user fetches the bundle into its copy. The first time this carries the history; later only what is new.
- The task's checkout is a worktree of the agent user's copy. Any hook in it runs as the agent user.
- When the task completes or pauses, the agent user bundles the task branch and Clawboo fetches it into your repository under the same branch name, after checking the bundle. Fetching a bundle runs nothing from it. The branch is never moved over commits you made to it in your own repository, and a task whose branch could not be brought back is blocked with the reason rather than marked done.

Repositories that use Git LFS or submodules cannot be carried by a bundle, so code tasks on them are refused with that reason while the setting is on.

### Stopping agents

Clawboo stops every process the agent user runs when it starts (that also reaps anything a crashed server left), when the agent host stops answering for 5 seconds (it then starts a new one), and when it stops. So the agent user must belong to one Clawboo install. A second install sharing it would have its agents stopped too.

## Before you start

- **An access token.** Clawboo refuses to start without one, because without it any program on the computer, agents included, can use Clawboo's API. The per-install token every install has is enough; only setting `STUDIO_ACCESS_TOKEN` to an empty value turns it off.
- **Runtimes the agent user can run.** Node, Clawboo itself and each runtime (Claude Code, Codex, Hermes) must be installed where every user can run them, such as `/usr/local`, `/opt` or Homebrew. A runtime installed under your home (with nvm, say) cannot run as another user: the startup check lists it, and its runs fail with the path that is out of reach. The runtimes Clawboo installs for you, Hermes among them, go in its [runtimes folder](/operating/data-and-state#the-runtimes-folder), `~/clawboo-runtimes` by default, which is under your home: set `CLAWBOO_RUNTIMES_DIR` to a folder every user can run and only you can change, such as one under `/opt`.
- **Your home folder closed to other users.** On macOS your home is readable by the `staff` group; run `chmod 750 ~`. On Linux, `chmod 750 ~` too. Clawboo warns at every start while the agent user can list your home.
- **Sign-ins for the agent user.** API keys you save in Clawboo reach each run in its environment, as before. Your own Codex and Hermes sign-ins are not shared with the agents: they are yours, and the agent user cannot read them. Sign in for the agents from the Runtimes page (that sign-in runs as the agent user and is kept in its home), or give the runtime an API key; until you do, a subscription run says so instead of starting. Claude Code uses the agent user's own `~/.claude`: give it an API key, or a long-lived token from `claude setup-token` set as `CLAUDE_CODE_OAUTH_TOKEN` in Clawboo's environment.

## Set it up on Linux

Print the commands for your machine, and run them once as an administrator. Clawboo never runs them itself.

```bash
clawboo agent-user plan
```

They create the user and its work folder, and add one sudoers rule:

```bash
sudo useradd --system --user-group --create-home --home-dir /var/lib/clawboo-agent --shell /bin/bash clawboo-agent
sudo passwd -l clawboo-agent
sudo install -d -o clawboo-agent -g clawboo-agent -m 700 /var/lib/clawboo-agent /var/lib/clawboo-agent/work
printf '%s\n' 'alice ALL=(clawboo-agent) NOPASSWD: ALL' 'Defaults:alice !requiretty' | sudo tee /etc/sudoers.d/clawboo >/dev/null
sudo chmod 440 /etc/sudoers.d/clawboo
sudo visudo -cf /etc/sudoers.d/clawboo
echo clawboo-agent | sudo tee -a /etc/cron.deny /etc/at.deny >/dev/null
```

Here `alice` is the user Clawboo runs as. The rule only lets that user start processes as the less privileged agent user, which is why it names no commands. The last line keeps the agent user from scheduling jobs that would run after Clawboo stops its agents. Where `setpriv` is installed (most Linux systems), Clawboo starts the agent host with `no_new_privs`, so no agent process can become another user through a setuid program. The agent user gets a real shell (Codex and Claude Code run commands in it) but no password, so nobody can log in as it, and no sudo rights at all: Clawboo refuses to start if it has any.

Then check the setup, and start Clawboo with the setting:

```bash
CLAWBOO_AGENT_USER=clawboo-agent clawboo agent-user check
```

```bash
CLAWBOO_AGENT_USER=clawboo-agent clawboo
```

## Set it up on macOS

`clawboo agent-user plan` prints the macOS commands. They create a hidden role account named `_clawboo` with a group of its own (not `staff`), with an ID from 450 to 499 that is free on your Mac, because `sysadminctl` accepts role accounts only in that range:

```bash
sudo dscl . -create /Groups/_clawboo
sudo dscl . -create /Groups/_clawboo PrimaryGroupID 499
sudo dscl . -create /Groups/_clawboo RealName "Clawboo agents"
sudo sysadminctl -addUser _clawboo -fullName "Clawboo agents" -UID 499 -GID 499 -roleAccount -shell /bin/zsh -home /var/clawboo-agent
sudo install -d -o _clawboo -g _clawboo -m 700 /var/clawboo-agent /var/clawboo-agent/work
```

The sudoers rule goes in `/private/etc/sudoers.d/clawboo`, checked with `sudo visudo -c`. Then run `chmod 750 ~`, check, and start with `CLAWBOO_AGENT_USER=_clawboo`.

A role account has no login keychain, so Claude Code cannot use the subscription sign-in kept in your keychain. Give Claude Code an API key, or a long-lived token from `claude setup-token` as `CLAUDE_CODE_OAUTH_TOKEN` (see [Before you start](#before-you-start)).

## Set it up in a container

Hardened containers run with `--security-opt no-new-privileges`, which rules out sudo. Clawboo ships a launcher for them instead, `clawboo-launch`, a shell script in the package's `dist/` folder. Run it with `sh`, as root, as the container's entrypoint, with an init process (`docker run --init`, or tini). It only drops privileges, once for each process, with `setpriv` or `gosu`:

```bash
CLAWBOO_SERVER_USER=clawboo CLAWBOO_AGENT_USER=clawboo-agent \
CLAWBOO_HOME=/data CLAWBOO_WORK_DIR=/work \
  sh "$(npm root -g)/clawboo/dist/clawboo-launch"
```

The launcher:

1. makes `/run/clawboo` (or `CLAWBOO_RUN_DIR`), owned by the agent user and the server's group, mode `0710`;
2. on the first start, gives the work folder to the agent user, leaving any file with more than one hard link as it was and naming it (an agent that ran as the server's user before could have linked the database in; Clawboo then refuses to start until you remove it); on every start, takes the setuid and setgid bits off every file in the work folder;
3. starts the agent host as the agent user, on a socket there with mode `0660` and the server's group; both processes start with `no_new_privs` when `setpriv` is installed (with `gosu`, run the container with `--security-opt no-new-privileges`);
4. starts the server as the server user with `CLAWBOO_AGENT_USER` and `CLAWBOO_AGENT_HOST_SOCKET` set and its environment otherwise unchanged; the agent host gets only `PATH`, `HOME`, the locale and the socket path;
5. when either process exits, stops the other and every process the agent user owns, and exits, so the container's restart policy starts both again.

Before it connects, the server checks the folder's and the socket's owners and modes, and refuses anything else. Keep the data folder and the work folder apart: two volumes, or two top-level folders on one volume with different owners, such as `/data` and `/work`. For the strongest split, run the agent host in a second container that mounts only the work folder, joined to the server's by the socket on a shared volume.

## What the startup check proves

`clawboo agent-user check` runs the same check the server runs at every start, without starting the dashboard or stopping anything. In order:

| Step | Checks                                                                                                                                                                                                                                                                                                                                                                                                      | When it fails                                                                                              |
| ---- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| 1    | Not Windows                                                                                                                                                                                                                                                                                                                                                                                                 | refuses                                                                                                    |
| 2    | The user exists, and is neither the user Clawboo runs as nor root                                                                                                                                                                                                                                                                                                                                           | refuses                                                                                                    |
| 3    | An access token is set                                                                                                                                                                                                                                                                                                                                                                                      | refuses                                                                                                    |
| 4    | The data folder is the server user's and `0700`, its private files `0600` with no second hard link (narrowed if wider), and no folder above it can be changed by other users                                                                                                                                                                                                                                | refuses                                                                                                    |
| 5    | sudo (or doas, or the launcher's socket) starts the agent host                                                                                                                                                                                                                                                                                                                                              | refuses, and prints the sudoers lines to add                                                               |
| 6    | The agent host runs as the named user                                                                                                                                                                                                                                                                                                                                                                       | refuses                                                                                                    |
| 7    | As the agent user: the database and its `-wal` and `-shm`, the vault, its key, settings, the token file, a listing of the data folder and your own login files cannot be opened; the work folder can be written; the server's environment cannot be read and no secret shows in its command line; no file in the work folder is a hard link to a private file, or a setuid or setgid file another user owns | refuses, saying which path and the `chmod` that fixes it. A home folder the agent user can list only warns |
| 8    | The agent user cannot become another user: `sudo` and `doas` are tried as it, not only listed                                                                                                                                                                                                                                                                                                               | refuses; warns when it may schedule `cron` jobs                                                            |
| 9    | Each runtime binary can run as the agent user                                                                                                                                                                                                                                                                                                                                                               | warns; that runtime's runs fail with the reason                                                            |

## Settings

| Variable                    | What it does                                                                                                          |
| --------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| `CLAWBOO_AGENT_USER`        | The agent user's name. Unset (the default) turns isolation off.                                                       |
| `CLAWBOO_AGENT_SWITCH`      | `sudo` (default) or `doas`, to start the agent host on a computer or virtual machine.                                 |
| `CLAWBOO_AGENT_HOST_SOCKET` | Set by `clawboo-launch`: the socket of an agent host the launcher started. The server connects instead of using sudo. |
| `CLAWBOO_WORK_DIR`          | With isolation on, must be a folder the agent user owns. Defaults to `<agent home>/work`.                             |

## Related

- [Security model](/operating/security)
- [What agents can do](/concepts/permissions)
- [Data and state](/operating/data-and-state)
- [Deploy Clawboo](/operating/deployment)
