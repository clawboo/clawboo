---
title: Reference
description: "Index of Clawboo's factual reference: REST API, CLI, configuration, env vars, database schema, MCP tools, marketplace catalog, events, and packages."
---

Factual, code-grounded reference for every public surface of Clawboo: the **141-route** REST API, the `clawboo` CLI, configuration and environment variables, the **27-table** SQLite schema, the **4** MCP servers and their tools, the marketplace catalog of **304 agents** and **82 teams**, the orchestration event and error vocabulary, and one page per workspace package (**27** in total). These pages describe what the code does, verified against source; they do not teach a workflow. For learning-oriented walkthroughs see [Getting Started](/getting-started/index); for the _why_ see [Concepts](/concepts/index).

<Note>
These docs describe Clawboo **v0.3.0**, the current release.
</Note>

## At a glance

| Area          | Page                                                      | Scope                                                      |
| ------------- | --------------------------------------------------------- | ---------------------------------------------------------- |
| REST API      | [REST overview](/reference/rest-api/index)                | Base URL, auth/loopback, error envelope, 141-route summary |
| CLI           | [CLI reference](/reference/cli)                           | `clawboo` + the bundled MCP bins                           |
| Configuration | [Configuration](/reference/configuration)                 | `settings.json`, file/dir locations                        |
| Environment   | [Environment variables](/reference/environment-variables) | `CLAWBOO_*` / `OPENCLAW_*` / provider keys                 |
| Database      | [Database schema](/reference/database-schema)             | 27 tables + ERD                                            |
| MCP           | [MCP tools](/reference/mcp-tools)                         | 4 servers, tool list, zod input shapes                     |
| Marketplace   | [Marketplace catalog](/reference/marketplace-catalog)     | Agent/team schemas, sources, ingestion                     |
| Events        | [Events & errors](/reference/events-and-errors)           | Orchestration event kinds + error taxonomy                 |
| Packages      | [Packages overview](/reference/packages/index)            | Dependency graph + build order + 25 package pages          |

## REST API

Base URL, loopback posture, the shared `{ error: string }` envelope, and the route summary live in the [REST overview](/reference/rest-api/index). The surface is grouped by resource:

- [Settings & health](/reference/rest-api/settings), `/api/settings`, `/api/health*`
- [Agents](/reference/rest-api/agents), `/api/agents*` (registry, files, sessions, sync, cleanup-ghosts)
- [Teams](/reference/rest-api/teams), `/api/teams*`, team-onboarding, team-rules, team-chat
- [Board](/reference/rest-api/board), `/api/board*` (tasks, claim, comments, executions, deps, workspace)
- [Runtimes](/reference/rest-api/runtimes), `/api/runtimes*`, `/api/onboarding/seed-native-team`
- [Memory](/reference/rest-api/memory), `/api/memory*`
- [Tools & MCP](/reference/rest-api/tools-and-mcp), `/api/tools*`, `/api/mcp*` (incl. SSE/WS)
- [Governance](/reference/rest-api/governance), budgets, delegation-approval, approvals
- [Capabilities](/reference/rest-api/capabilities), `/api/capabilities*`
- [Observability](/reference/rest-api/observability), `/api/obs*` (incl. SSE), `/api/eval/smoke`
- [Schedules](/reference/rest-api/schedules), `/api/schedules*`
- [System](/reference/rest-api/system), `/api/system/*` (status, install, configure, gateway, device)
- [Misc](/reference/rest-api/misc), cost-records, chat-history, graph-layout, personality, skills, exec-settings, fleet, boo-zero

## CLI & configuration

- [CLI reference](/reference/cli), the single `clawboo` entry point plus the `clawboo-mcp-{tasks,memory,tools,teamchat}` stdio bins.
- [Configuration](/reference/configuration), `settings.json`, the `~/.clawboo` state directory, and the file/dir locations Clawboo owns.
- [Environment variables](/reference/environment-variables), every `CLAWBOO_*`, `OPENCLAW_*`, and provider key Clawboo reads, sourced only from `@clawboo/config`, the runtime descriptor, and the secrets vault.

## Data, MCP & catalog

- [Database schema](/reference/database-schema), the 27 SQLite tables with column-level detail and an ERD.
- [MCP tools](/reference/mcp-tools), the Tasks / Memory / Tools / TeamChat servers, each tool's name, and its zod input shape.
- [Marketplace catalog](/reference/marketplace-catalog), the `AgentCatalogEntry` and `TeamTemplate` schemas, the three pinned-SHA sources, and the codegen ingestion pipeline.
- [Events & errors](/reference/events-and-errors), the orchestration event kinds and the runtime-error taxonomy (unknown class = harness bug).

## Packages

[Packages overview](/reference/packages/index) carries the dependency graph and build order. One page per `@clawboo/*` package documents its version, purity, public API, and consumers:

- Adapters, [adapter-claude-code](/reference/packages/adapter-claude-code), [adapter-codex](/reference/packages/adapter-codex), [adapter-hermes](/reference/packages/adapter-hermes), [adapter-native](/reference/packages/adapter-native), [adapter-openclaw](/reference/packages/adapter-openclaw)
- Registries & sources, [agent-registry](/reference/packages/agent-registry), [capability-registry](/reference/packages/capability-registry), [scheduler](/reference/packages/scheduler)
- Core substrate, [executor](/reference/packages/executor), [db](/reference/packages/db), [events](/reference/packages/events), [protocol](/reference/packages/protocol), [config](/reference/packages/config)
- Gateway, [gateway-client](/reference/packages/gateway-client), [gateway-proxy](/reference/packages/gateway-proxy)
- Pure primitives, [compaction](/reference/packages/compaction), [governance](/reference/packages/governance), [obs](/reference/packages/obs), [worktrees](/reference/packages/worktrees)
- MCP & evals, [mcp](/reference/packages/mcp), [evals](/reference/packages/evals)
- UI & shared, [ui](/reference/packages/ui), [boo-avatar](/reference/packages/boo-avatar), [logger](/reference/packages/logger), [tsconfig](/reference/packages/tsconfig)

## See also

- [Concepts](/concepts/index), the model behind the surfaces documented here
- [Using Clawboo](/using/index), task-oriented guides for the dashboard features
- [Operating Clawboo](/operating/index), deployment, security, and data/state
- [Glossary](/appendices/glossary), canonical term definitions
- [Known issues](/appendices/known-issues), candid limitations
