---
title: Operating Clawboo
description: 'Operator overview: where Clawboo runs, how to expose it safely, where data lives, and what the defaults are.'
---

This section is for the person who runs the Clawboo server, on a laptop, a shared box, or behind a reverse proxy, rather than the person clicking around the dashboard. Clawboo is a single Node process: a bundled Express server that serves the SPA, exposes the REST API, hosts the four [MCP servers](/reference/mcp-tools) in-process, and owns one SQLite file plus an encrypted secrets vault under `~/.clawboo`. By default it binds **loopback (`127.0.0.1`)** with no authentication, which is the right posture for a single-user machine; exposing it on a network is an explicit opt-in that requires the access gate. The pages below cover the four operator concerns in order: where it runs, how to expose it safely, what attaches to it, and where the state lives, and the reference pages give the exact knobs.

## In this section

| Page                                                  | What it covers                                                                                                                                                                                                                      |
| ----------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [Deployment](/operating/deployment)                   | How the CLI launches the bundled server, port resolution and the `18790` auto-fallback window, the state directory, and dev vs. production boots.                                                                                   |
| [Security](/operating/security)                       | The default loopback bind, the access gate (case-folded, charset-validated, with a loopback `/api/mcp/*` exemption), server-side device auth, the encrypted vault, display-layer redaction, and how to expose the dashboard safely. |
| [MCP servers](/operating/mcp-servers)                 | The four MCP servers (tasks, memory, tools, teamchat) as teammates: the in-process Streamable HTTP transport, the bundled stdio bins, attach config, and per-run scoping.                                                           |
| [Data & state](/operating/data-and-state)             | The SQLite database (27 tables, no migration ladder), the `~/.clawboo` file and directory layout, the boot probe, and how to back up or hard-reset.                                                                                 |
| [Production defaults](/operating/production-defaults) | The shipped posture: budgets in warn mode, circuit-breaker defaults, approval TTLs, GC windows, and the rationale for each.                                                                                                         |

## Operator concerns at a glance

- **Where it runs**: one bundled server process. It picks a free API port at boot (default `18790`, scanning up to `18809`) and binds loopback unless you set `HOST` (`HOSTNAME` is ignored). Start with [Deployment](/operating/deployment).
- **How to expose it safely**: a non-loopback bind without `STUDIO_ACCESS_TOKEN` would be reachable unauthenticated by anyone on your network, so the server refuses to start in that case. The access gate is the only auth for a non-loopback bind. See [Security](/operating/security).
- **What attaches to it**: runtimes (and external agents) reach the shared plane by attaching Clawboo's MCP servers. The loopback exemption lets a server-spawned runtime attach `/api/mcp/*` without a token; everything else still needs the gate cookie. See [MCP servers](/operating/mcp-servers).
- **Where data lives**: everything Clawboo owns sits under `~/.clawboo` (`CLAWBOO_HOME` overrides it): the SQLite DB, `settings.json`, the secrets vault, worktrees, and the proxy device identity. OpenClaw's `~/.openclaw` is only ever read for interop. See [Data & state](/operating/data-and-state).
- **What the defaults are**: production-leaning out of the box: budgets track-and-warn instead of hard-capping, circuit breakers are conservative, and the boot probe surfaces a degraded environment without blocking. See [Production defaults](/operating/production-defaults).

## Related reference

When you need the exact value rather than the framing, go to the reference cluster:

- [Configuration](/reference/configuration), `settings.json` shape and the file/directory locations Clawboo resolves.
- [Environment variables](/reference/environment-variables), every `CLAWBOO_*`, `OPENCLAW_*`, and provider variable Clawboo reads (`CLAWBOO_HOME`, `CLAWBOO_API_PORT`, `STUDIO_ACCESS_TOKEN`, `CLAWBOO_SECRETS_MASTER_KEY`, and the rest).
- [CLI](/reference/cli), `clawboo` and the bundled MCP stdio bins.
- [REST API overview](/reference/rest-api/index), base URL, the access-gate behavior on every route, and the error envelope.
- [Database schema](/reference/database-schema), the 27 tables and their relationships.

## See also

- [How it works](/intro/how-it-works), the end-to-end architecture this section operates.
- [Installation](/getting-started/installation), `clawboo` and what it launches.
- [Glossary](/appendices/glossary), canonical terms (the board, runtime, AgentSource, MCP quartet).
