---
title: 'Self-hosting overview'
sidebarTitle: 'Overview'
description: 'What to read when you run the Clawboo server for yourself or a small team, and how a fresh install behaves before you change anything.'
icon: 'server'
keywords: ['operating', 'operator', 'self-host', 'production', 'Operating Clawboo']
---

Use this section if you run the Clawboo server: on your own computer, on a shared machine or home server, or behind a reverse proxy so a small team can reach it. If you only use the dashboard on the computer where you installed it, the defaults below already keep it on that machine, and you can go straight to [Use Clawboo](/using/index).

## What you are running

Clawboo is one Node.js program. It serves the dashboard and the REST API on one port, hosts Clawboo's [MCP servers](/operating/mcp-servers), and keeps its data in a SQLite file in `~/.clawboo`. Clawboo Native agents run inside that program. Claude Code, Codex and Hermes run as programs it starts on the same machine, and OpenClaw agents run in the OpenClaw Gateway.

## In this section

| Page                                                             | Read it when                                                                                             |
| ---------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| [Reach Clawboo from another machine](/guides/self-host-securely) | You want to open the dashboard from another computer, over an SSH tunnel, or through a reverse proxy.    |
| [Deployment](/operating/deployment)                              | You run the server as a service, in a container or from source, or you need its ports, logs and updates. |
| [Security](/operating/security)                                  | You want the security model: the access token, the same-origin guard, the key vault, and what each does. |
| [Data and state](/operating/data-and-state)                      | You want to find, back up, move or reset Clawboo's data, or see what it writes in OpenClaw's folder.     |
| [MCP servers](/operating/mcp-servers)                            | You want an agent that Clawboo does not run to use the board, shared memory, tools or the peer room.     |
| [Production defaults](/operating/production-defaults)            | You want to know what a fresh install allows and limits, and how to change each default.                 |

## The default posture

- **Only this machine can connect.** The server listens on `127.0.0.1` until you set `HOST`.
- **There is no access token.** Anyone who can reach the server can use it until you set `STUDIO_ACCESS_TOKEN`. With `HOST` set to anything but a loopback address, the server refuses to start without one, but a reverse proxy on the same machine does not trip that check.
- **Browsers must use a local address.** The same-origin guard rejects API calls that arrive under another name, such as your proxy's domain, until you list it in `CLAWBOO_ALLOWED_HOSTS` and `CLAWBOO_ALLOWED_ORIGINS`.
- **State lives in `~/.clawboo`.** Clawboo also writes provider keys and OpenClaw settings in OpenClaw's `~/.openclaw` folder.
- **Spend is tracked, not capped.** Budgets warn by default. A hard cap is something you turn on.

Prompts go only to the providers and apps you connect. No Clawboo account, and Clawboo itself sends no telemetry. The server also fetches the Marketplace catalog from GitHub, OpenRouter's public model list and the latest version from npm, and the dashboard loads its font from Google Fonts and its GitHub star count; [Production defaults](/operating/production-defaults#what-leaves-the-machine) lists each one.

Claude Code, Codex and Hermes run with their own sandboxes and approval prompts turned off, so they can read and change any file your user account can. For work you do not trust, run Clawboo under a separate user account or in a virtual machine. See [What agents can do](/concepts/permissions).

## Related

- [CLI reference](/reference/cli): start, stop and restart the server, find its port, and read its log.
- [Environment variables](/reference/environment-variables): every variable the server reads.
- [Limits and defaults](/reference/limits-and-defaults): every number, timeout and cap in one place.
- [Troubleshooting](/help/troubleshooting): error messages and what to do about each one.
