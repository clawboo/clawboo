---
title: 'Run agents as their own user'
sidebarTitle: 'Agent isolation'
description: "Set CLAWBOO_AGENT_USER so every agent runs as a separate operating system user that cannot read Clawboo's database, saved keys or settings, or CLAWBOO_AGENT_USERS for a user of its own per agent, and how to set them up on Linux, macOS and in a container."
keywords:
  [
    'agent isolation',
    'CLAWBOO_AGENT_USER',
    'CLAWBOO_AGENT_USERS',
    'CLAWBOO_AGENT_GROUPS',
    'agent user',
    'user per agent',
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

On Linux you can go one step further and give each agent a user of its own, so agents are walled off from each other too: see [A user per agent](#a-user-per-agent).

<Note>
Available from 0.7.0. Clawboo 0.6.0 and older ignore `CLAWBOO_AGENT_USER`, and agents keep running as you. Run `clawboo --version` to see yours.
</Note>

## What it protects, and what it does not

With the setting on, a prompt-injected agent can no longer:

- read the vault's key and the vault, and with them every saved provider key, website login and 1Password token;
- read or change Clawboo's database: the board, approvals, budgets, routines and connector grants;
- read the secret Clawboo signs MCP attach links with, so it cannot make itself a link with another agent's identity or a privilege it was not given;
- read the access token and answer its own approval card through the API;
- read your own logins (`~/.openclaw/.env`, `~/.codex`, `~/.hermes`, `~/.claude`, `~/.ssh`), as long as your home folder is closed to other users (see [Before you start](#before-you-start));
- plant a git hook in your repository that runs as you later: task checkouts come from a copy of the repository the agent user owns;
- read a connector's token, trace the server, or kill it;
- read the access token or the vault key from the server's environment, where container deployments often pass them.

Clawboo checks the first and the last of these from inside the agent user's account every time it starts, and refuses to start when it cannot prove them.

It does **not**:

- limit network access. An agent can send what it can read anywhere, and reach other services on the machine that have no password of their own;
- protect an agent's own credentials from that agent: the provider key in its environment, its sign-ins and its browser's saved logins, and a [website login](/using/website-logins) Clawboo filled into its page;
- keep agents apart from each other. All agents share one agent user, so one team's agent can read another team's folder, and on Linux one agent's programs can open another agent's display. For that, give each agent its own user ([A user per agent](#a-user-per-agent));
- keep one agent from acting as another on Clawboo's MCP servers. An agent's attach links are long-lived links that carry their own credential, and another agent can read them in that agent's runtime home (they share the agent user), or on the command line of a Claude Code run. That includes a run's Tools link, which carries the run's reference: while the run lasts, an agent that reads it can call [`fill_login`](/using/website-logins#what-this-protects-and-what-it-does-not) as that run, with its person's logins;
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

| What                                                                              | Where, with the setting on                                                       | Owner and mode                                                            |
| --------------------------------------------------------------------------------- | -------------------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| Clawboo's data folder (`~/.clawboo`)                                              | unchanged                                                                        | you, `0700`                                                               |
| The database, the vault, settings, the token                                      | unchanged                                                                        | you, `0600`                                                               |
| The work folder (team and task folders, task checkouts)                           | `<agent home>/work`, or `CLAWBOO_WORK_DIR`                                       | agent user, `0700`                                                        |
| Each Codex agent's runtime home (`CODEX_HOME`)                                    | `<agent home>/runtimes/codex/<agent>`                                            | agent user, `0700`                                                        |
| The Hermes gateway's home (`HERMES_HOME`), with each Hermes agent's profile in it | `<agent home>/runtimes/hermes/_gateway`, one profile per agent under `profiles/` | agent user, `0700`                                                        |
| Claude Code's settings and sessions                                               | the agent user's own `~/.claude`                                                 | agent user                                                                |
| Each agent's browser profile                                                      | `<agent home>/browser-profiles/`                                                 | agent user, `0700`                                                        |
| Each agent's display: its VNC socket and X cookie                                 | `<agent home>/desktops/<hash>`                                                   | agent user, `0700`                                                        |
| The agent user's copy of each repository                                          | `<work folder>/mirrors/<repository hash>.git`                                    | agent user                                                                |
| Installed runtimes (Claude Code, Codex, Hermes, OpenClaw)                         | `CLAWBOO_RUNTIMES_DIR`, outside your home and the agent user's                   | you (or root), `0755`: the agent user runs them, nobody else changes them |
| Clawboo Native's conversation history                                             | unchanged, in the data folder                                                    | you                                                                       |

`<agent home>` is the agent user's home folder: `/var/lib/clawboo-agent` on Linux and `/var/clawboo-agent` on macOS with the setup commands below.

The first time Clawboo starts with the setting, it copies what agents already had into the agent user's space: each runtime home (Hermes memory and skills, Codex sessions) and each team folder. A Hermes agent's copied home then moves into its profile in the Hermes gateway's home on its first run. It never copies a link, a file with more than one hard link, a sign-in or key file (`auth.json`, `.env`: before, those were copies of your own logins and keys), or Clawboo Native's history, and names what it skipped in the log. The originals stay where they were, so turning the setting off again is the way back.

### Task checkouts

Without the setting, a task's checkout is a git worktree of your repository and shares its `.git` folder, hooks and config included. With it, the agent user keeps its own copy of the repository, and only data moves between the two:

- When a task starts, Clawboo bundles the commit it starts from in your repository and the agent user fetches the bundle into its copy. The first time this carries the history; later only what is new.
- The task's checkout is a worktree of the agent user's copy. Any hook in it runs as the agent user.
- When the task completes or pauses, the agent user bundles the task branch and Clawboo fetches it into your repository under the same branch name, after checking the bundle. Fetching a bundle runs nothing from it. The branch is never moved over commits you made to it in your own repository, and a task whose branch could not be brought back is blocked with the reason rather than marked done.

Repositories that use Git LFS or submodules cannot be carried by a bundle, so code tasks on them are refused with that reason while the setting is on.

### Stopping agents

Clawboo stops every process the agent user runs when it starts (that also reaps anything a crashed server left), when the agent host stops answering for 5 seconds, and when it stops. On a computer it then starts a new agent host; in a container the server exits instead, and `clawboo-launch` stops every agent process so the container's restart policy starts both again. So the agent user must belong to one Clawboo install. A second install sharing it would have its agents stopped too.

## Before you start

- **An access token.** Clawboo refuses to start without one, because without it any program on the computer, agents included, can use Clawboo's API. The per-install token every install has is enough; only setting `STUDIO_ACCESS_TOKEN` to an empty value turns it off.
- **Runtimes the agent user can run.** Node, Clawboo itself and each runtime (Claude Code, Codex, Hermes) must be where every user can run them. Clawboo installs runtimes, Hermes among them, into its [runtimes folder](/operating/data-and-state#the-runtimes-folder), `~/clawboo-runtimes` by default (`<CLAWBOO_HOME>-runtimes` when you set `CLAWBOO_HOME`), which is inside your home: once you close your home (below), the agent user cannot reach it. Before you turn the setting on, set `CLAWBOO_RUNTIMES_DIR` to a folder outside your home and the agent user's, such as `/opt/clawboo-runtimes`, owned by you with mode `0755` (the setup commands below make it), run Clawboo on a Node every user can run (Homebrew, `/usr/local`, or the desktop app's own), and install the runtimes again from the Runtimes page. A runtime the agent user cannot run is listed by the startup check, and its runs fail with the path that is out of reach.
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

Then close your home, make the runtimes folder (see [Before you start](#before-you-start)), check the setup, and start Clawboo with the setting:

```bash
chmod 750 ~
sudo install -d -o "$(id -un)" -m 755 /opt/clawboo-runtimes
```

```bash
CLAWBOO_RUNTIMES_DIR=/opt/clawboo-runtimes CLAWBOO_AGENT_USER=clawboo-agent clawboo agent-user check
```

```bash
CLAWBOO_RUNTIMES_DIR=/opt/clawboo-runtimes CLAWBOO_AGENT_USER=clawboo-agent clawboo
```

Install the runtimes again from the Runtimes page once Clawboo runs with `CLAWBOO_RUNTIMES_DIR`, so they land where the agent user can run them.

## Set it up on macOS

`clawboo agent-user plan` prints the macOS commands. They create a hidden role account named `_clawboo` with a group of its own (not `staff`), with an ID from 450 to 499 that is free on your Mac, because `sysadminctl` accepts role accounts only in that range:

```bash
sudo dscl . -create /Groups/_clawboo
sudo dscl . -create /Groups/_clawboo PrimaryGroupID 499
sudo dscl . -create /Groups/_clawboo RealName "Clawboo agents"
sudo sysadminctl -addUser _clawboo -fullName "Clawboo agents" -UID 499 -GID 499 -roleAccount -shell /bin/zsh -home /var/clawboo-agent
sudo install -d -o _clawboo -g _clawboo -m 700 /var/clawboo-agent /var/clawboo-agent/work
```

The sudoers rule goes in `/private/etc/sudoers.d/clawboo`, checked with `sudo visudo -c`. The plan then closes your home and keeps the role account from scheduling jobs of its own, which would run after Clawboo stops its agents:

```bash
chmod 750 ~
echo _clawboo | sudo tee -a /usr/lib/cron/cron.deny /usr/lib/cron/at.deny >/dev/null
```

Make the runtimes folder (see [Before you start](#before-you-start)), check, and start with the setting:

```bash
sudo install -d -o "$(id -un)" -m 755 /opt/clawboo-runtimes
CLAWBOO_RUNTIMES_DIR=/opt/clawboo-runtimes CLAWBOO_AGENT_USER=_clawboo clawboo agent-user check
CLAWBOO_RUNTIMES_DIR=/opt/clawboo-runtimes CLAWBOO_AGENT_USER=_clawboo clawboo
```

A role account has no login keychain, so Claude Code cannot use the subscription sign-in kept in your keychain. Give Claude Code an API key, or a long-lived token from `claude setup-token` as `CLAUDE_CODE_OAUTH_TOKEN` (see [Before you start](#before-you-start)).

## Set it up in a container

Hardened containers run with `--security-opt no-new-privileges`, which rules out sudo. Clawboo ships a launcher for them instead, `clawboo-launch`, a shell script in the package's `dist/` folder. Run it with `sh`, as root, as the container's entrypoint, with an init process (`docker run --init`, or tini). It only drops privileges, once for each process, with `setpriv` or `gosu`:

```bash
CLAWBOO_SERVER_USER=clawboo CLAWBOO_AGENT_USER=clawboo-agent \
CLAWBOO_HOME=/data CLAWBOO_WORK_DIR=/work CLAWBOO_RUNTIMES_DIR=/opt/clawboo-runtimes \
  sh "$(npm root -g)/clawboo/dist/clawboo-launch"
```

The launcher:

1. makes `/run/clawboo` (or `CLAWBOO_RUN_DIR`), owned by the agent user and the server's group, mode `0710`;
2. on the first start, gives the work folder to the agent user, leaving any file with more than one hard link as it was and naming it (an agent that ran as the server's user before could have linked the database in; Clawboo then refuses to start until you remove it); on every start, takes the setuid and setgid bits off every file in the work folder;
3. starts the agent host as the agent user, on a socket there with mode `0660` and the server's group; both processes start with `no_new_privs` when `setpriv` is installed (with `gosu`, run the container with `--security-opt no-new-privileges`);
4. starts the server as the server user with `CLAWBOO_AGENT_USER` and `CLAWBOO_AGENT_HOST_SOCKET` set and its environment otherwise unchanged; the agent host gets only `PATH`, `HOME`, the locale and the socket path;
5. when either process exits, stops the other and every process the agent user owns, and exits, so the container's restart policy starts both again.

Before it connects, the server checks the folder's and the socket's owners and modes, and refuses anything else. Keep the data folder and the work folder apart: two volumes, or two top-level folders on one volume with different owners, such as `/data` and `/work`. Install the runtimes into a folder outside both, owned by root or the server user and writable by no one else, and name it with `CLAWBOO_RUNTIMES_DIR` (for example `/opt/clawboo-runtimes`, made when the image is built). The launcher and the agent host both run in the one container.

## A user per agent

Available in releases after 0.7.0. Clawboo 0.7.0 and older ignore `CLAWBOO_AGENT_USERS`. Run `clawboo --version` to see yours.

With `CLAWBOO_AGENT_USERS` (Linux only for now), each agent runs as a user of its own, taken from a pool of users you make once. It is used instead of `CLAWBOO_AGENT_USER`, never with it, and everything above still holds. On top of it, one agent cannot:

- list another agent's home, or read its runtime home (its sign-ins and sessions), its browser profile (cookies included) or its display's cookie;
- connect to another agent's display;
- signal another agent's processes;
- reach the folder of a team it is not on.

Agents on the same team share their team folder, and nothing else of each other's. A file one teammate leaves there still reaches another that opens or runs it, as with any shared folder, so put agents you do not trust on different teams. A check of an agent's work (its verify command, its reviewer, git on the team's history) runs as that agent, never as another teammate.

### How it works

- **Users.** An agent gets the next free user from the pool when it is created, oldest agent first, and keeps it for its life. Archiving an agent keeps its user. When an agent is deleted, its processes stop at once and its user is wiped before another agent gets it: its home emptied and its files in `/tmp`, `/var/tmp`, `/dev/shm` and `/run/user/<uid>` removed, each checked afterwards. A user that cannot be wiped stays out of use, and so does one whose uid changed.
- **Teams.** Each team gets a group from `CLAWBOO_AGENT_GROUPS` the same way. An agent's processes run with its team's group (`sudo -g`) and nothing else, so moving an agent to another team (or out of one) stops its processes at once, and they start again with the new group. A deleted team's group is handed out again only once its folders are gone and no process holds it.
- **Hosts.** Each agent user has its own agent host, started the first time that agent needs one and closed, with the agent's processes, after 10 minutes with nothing to do. A host that stops answering for 5 seconds costs only its own agent's processes: Clawboo stops every process of that user and starts the host again on the next need. One agent stopping its own host stops nobody else.
- **The work folder** is yours, mode `0711`: agents pass through it and never list it. Each team's folders (its team folder, with its task folders inside, and the work check's history) sit under a folder Clawboo makes itself, owned by you, with the team's group and mode `2770`, and an inherited ACL that gives the team every file made inside. So a file one teammate writes, the others can read and change, while a file a program makes private (mode `0600`) stays private. An agent with no team gets the same kind of folder for itself alone, `teams/_agent-<agent id>`, instead of the shared `_no-team`.

| What                                                  | Where, with a user per agent            | Owner and mode                                                    |
| ----------------------------------------------------- | --------------------------------------- | ----------------------------------------------------------------- |
| An agent's runtime homes, browser profile and display | under the home of the agent's own user  | that user, `0700`                                                 |
| The work folder (`CLAWBOO_WORK_DIR`, required)        | the folder you name                     | you, `0711`                                                       |
| A team's folder, and its task folders                 | `<work folder>/teams/<team id>`         | you, the team's group, `2770`, with an inherited ACL for the team |
| The folder of an agent with no team                   | `<work folder>/teams/_agent-<agent id>` | you, that agent user's own group, `2770`                          |

### Not available yet with a user per agent

- **Code tasks in a repository.** A task that would work in a checkout of a repository is refused with the reason; agents still work in their team folder. Task checkouts and the agents' copies of repositories are not laid out by team yet.
- **Hermes.** The Hermes gateway runs every Hermes agent's tools in one process, so it would be one user for all of them. It does not start while `CLAWBOO_AGENT_USERS` is set.
- **OpenClaw.** As with one agent user, OpenClaw agents run in the OpenClaw Gateway and are not covered.
- **Connectors shared by every agent.** A connector with local reach and no saved credential is one program every agent talks to, so it does not start. Each agent's own browser works, and so do connectors that hold a saved credential (they run as you, as before).
- **Sign-ins on the Runtimes page.** Each agent's Codex and Hermes sign-in would be its own, kept in its user's home, and the Runtimes page's sign-in does not pick an agent yet. Give Codex an API key, or Claude Code an API key or `CLAUDE_CODE_OAUTH_TOKEN`.
- **Containers.** `clawboo-launch` starts one agent host; it does not start a pool.
- **Older state.** Turning a pool on copies nothing in: each agent starts with an empty home, and its team with an empty folder.

### When the pool is too small

A new agent with no free user is still created, and its runs refuse with "has no agent user", saying to add users or delete an agent. The next user that is freed or added goes to the oldest agent waiting. A team with no free group works the same way. An agent never falls back to a shared user.

### Set it up

Print the commands, and run them once as an administrator:

```bash
clawboo agent-user plan --pool 8 --teams 4
```

They make the users `clawboo-a1` to `clawboo-a8`, each with a group of its own and a private home under `/var/lib/clawboo-agents`, and the team groups `clawboo-t1` to `clawboo-t4`. They put the user Clawboo runs as in every one of those groups (it makes the team folders), add one sudoers rule, make the work folder, and install `setfacl` (the `acl` package). The sudoers rule names every user one by one, because sudo lets a rule change the group only when the users are written out:

```bash
alice ALL=(clawboo-a1, clawboo-a2, clawboo-a3 : clawboo-t1, clawboo-t2) NOPASSWD: ALL
```

Log in again so the new groups apply. Then check, and start Clawboo with the same settings (without them it starts with isolation off):

```bash
CLAWBOO_AGENT_USERS=clawboo-a1,clawboo-a2,clawboo-a3 CLAWBOO_AGENT_GROUPS=clawboo-t1,clawboo-t2 CLAWBOO_WORK_DIR=/var/lib/clawboo-work clawboo agent-user check
```

```bash
CLAWBOO_AGENT_USERS=clawboo-a1,clawboo-a2,clawboo-a3 CLAWBOO_AGENT_GROUPS=clawboo-t1,clawboo-t2 CLAWBOO_WORK_DIR=/var/lib/clawboo-work clawboo
```

`CLAWBOO_AGENT_USERS` also takes a range of user ids, such as `uid:20001-20008`, and `CLAWBOO_AGENT_GROUPS` a range of group ids, such as `gid:21001-21004`. Every user in the pool belongs to this Clawboo only: it stops every process they run when it starts and when it stops.

The startup check runs the steps below once for the pool, and steps 6 to 9 once for each user, in that user's own host. It also refuses when two users share a uid, a primary group or a home, when an agent user is a member of another agent user's group or of a team group, when the user Clawboo runs as is missing from one of the groups, and when one agent user can list another's home or signal another's process.

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

| Variable                    | What it does                                                                                                                                       |
| --------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| `CLAWBOO_AGENT_USER`        | The agent user's name. Unset (the default) turns isolation off.                                                                                    |
| `CLAWBOO_AGENT_SWITCH`      | `sudo` (default) or `doas`, to start the agent host on a computer or virtual machine.                                                              |
| `CLAWBOO_AGENT_HOST_SOCKET` | Set by `clawboo-launch`: the socket of an agent host the launcher started. The server connects instead of using sudo.                              |
| `CLAWBOO_WORK_DIR`          | With isolation on, must be a folder the agent user owns. Defaults to `<agent home>/work`. With a user per agent it is required, and must be yours. |
| `CLAWBOO_AGENT_USERS`       | A user per agent (Linux): the pool, as names (`clawboo-a1,clawboo-a2`) or a uid range (`uid:20001-20008`). Not with `CLAWBOO_AGENT_USER`.          |
| `CLAWBOO_AGENT_GROUPS`      | With a user per agent: the team groups, as names or a gid range (`gid:21001-21004`).                                                               |

## Related

- [Security model](/operating/security)
- [What agents can do](/concepts/permissions)
- [Data and state](/operating/data-and-state)
- [Deploy Clawboo](/operating/deployment)
