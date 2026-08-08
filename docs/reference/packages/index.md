---
title: Package overview
description: 'The 30 @clawboo/* workspace packages: version, purity, purpose, dependency graph, and build order.'
---

Clawboo is a TurboRepo + pnpm-workspaces monorepo. Every shared library lives under the `@clawboo/*` scope in `packages/`; all of them are **internal** (`private: true`); the only published npm artifact is the `clawboo` CLI (`apps/cli`), which inlines every `@clawboo/*` package it needs into its bundle (`dist/`). The two consumers are `apps/web` (the dashboard + Express API) and `apps/cli` (`clawboo`). Packages divide cleanly into **pure / browser-safe** ones (no `node:*` imports, safe to bundle into the Vite SPA or run in a worker) and **server-only** ones (touch `node:fs`/`node:http`/`better-sqlite3` and may only run in the Express server, the bundled CLI server, or the MCP stdio bins). Dependencies flow one way: apps depend on packages, packages depend on packages, and packages never import apps. That rule, and the split between `apps/web`'s Node server and its browser SPA, are enforced by lint, not convention, see [Layer boundaries](/internals/monorepo-and-build#layer-boundaries-lint-enforced). `@clawboo/tsconfig` is the shared TypeScript-config root (a devDependency everywhere, no runtime edge).

There are **30 packages** (25 top-level + 5 nested adapters under `packages/adapters/*`). Versions diverge per package; most sit at `0.1.0`, `events` and `gateway-client` are at `0.1.1`, and `tsconfig` is `0.0.0`.

<Note>
"Purity" here describes the package's **imports**, not whether it ships to the browser. The five runtime adapters import nothing from `node:*` (they take injected driver factories; the real subprocess/SDK drivers live server-side in `apps/web/server/lib/runtimes/`), so they are import-pure even though they're consumed server-side.
</Note>

## At a glance

| Package                        | Version | Purity        | Purpose                                                                              | Page                                                           |
| ------------------------------ | ------- | ------------- | ------------------------------------------------------------------------------------ | -------------------------------------------------------------- |
| `@clawboo/agent-registry`      | 0.1.0   | pure zero-dep | `AgentSource` interface + `AgentRecord`/`TeamRecord`/`SessionRecord` + multiplexer   | [agent-registry](/reference/packages/agent-registry)           |
| `@clawboo/board-core`          | 0.1.0   | pure zero-dep | The task state machine: 7 statuses + legal-transition table, shared by db/UI/engine  | [board-core](/reference/packages/board-core)                   |
| `@clawboo/boo-avatar`          | 0.1.0   | pure zero-dep | Deterministic ghost-lobster SVG avatar generator                                     | [boo-avatar](/reference/packages/boo-avatar)                   |
| `@clawboo/capability-registry` | 0.1.0   | pure zero-dep | `CapabilityRecord` + `CapabilitySource` trait + multiplexer                          | [capability-registry](/reference/packages/capability-registry) |
| `@clawboo/compaction`          | 0.1.0   | pure zero-dep | Pass-through-safe, failure-preserving tool-output compaction                         | [compaction](/reference/packages/compaction)                   |
| `@clawboo/config`              | 0.1.0   | server-only   | Settings fallback chain + state-dir resolution (`node:fs`/`os`/`path`)               | [config](/reference/packages/config)                           |
| `@clawboo/control-client`      | 0.1.0   | browser-safe  | REST/SSE client for the control plane + the base-URL / auth-header seam              | [control-client](/reference/packages/control-client)           |
| `@clawboo/db`                  | 0.1.0   | server-only   | SQLite + Drizzle schema + board/memory/tools/governance/obs/sessions cores           | [db](/reference/packages/db)                                   |
| `@clawboo/evals`               | 0.1.0   | server-only   | Eval harness for Clawboo's own orchestration (pass@1 / pass^k + ablation)            | [evals](/reference/packages/evals)                             |
| `@clawboo/events`              | 0.1.1   | browser-safe  | Bridge → Policy → Handler event pipeline                                             | [events](/reference/packages/events)                           |
| `@clawboo/executor`            | 0.1.0   | pure zero-dep | `RuntimeAdapter` trait + `RuntimeEvent` union + registry + `./contract` + `./tiers`  | [executor](/reference/packages/executor)                       |
| `@clawboo/gateway-client`      | 0.1.1   | browser-safe  | WebSocket client for the OpenClaw Gateway                                            | [gateway-client](/reference/packages/gateway-client)           |
| `@clawboo/gateway-proxy`       | 0.1.0   | server-only   | Same-origin WS proxy + access gate + Ed25519 device auth                             | [gateway-proxy](/reference/packages/gateway-proxy)             |
| `@clawboo/governance`          | 0.1.0   | browser-safe  | Verdict schemas + severity policy + budget cent-math + caps + breaker                | [governance](/reference/packages/governance)                   |
| `@clawboo/logger`              | 0.1.0   | browser-safe  | pino wrapper + display-layer secret redaction                                        | [logger](/reference/packages/logger)                           |
| `@clawboo/mcp`                 | 0.1.0   | server-only   | Tasks/Memory/Tools/TeamChat MCP servers + stdio bins                                 | [mcp](/reference/packages/mcp)                                 |
| `@clawboo/model-catalog`       | 0.1.0   | pure zero-dep | Static OpenClaw provider/model groups + provider-name normalization                  | [model-catalog](/reference/packages/model-catalog)             |
| `@clawboo/obs`                 | 0.1.0   | browser-safe  | Orchestration-event schema + error taxonomy + graph projection + judge               | [obs](/reference/packages/obs)                                 |
| `@clawboo/process-lookup`      | 0.1.0   | server-only   | Port → listening PID via `lsof`/`netstat`, shared by CLI stop and Gateway control    | [process-lookup](/reference/packages/process-lookup)           |
| `@clawboo/protocol`            | 0.1.0   | pure zero-dep | Gateway message parser + transcript types + agent-file defs                          | [protocol](/reference/packages/protocol)                       |
| `@clawboo/scheduler`           | 0.1.0   | browser-safe  | Cron parsing + occurrence math + `ScheduleSource` trait + multiplexer                | [scheduler](/reference/packages/scheduler)                     |
| `@clawboo/team-orchestration`  | 0.1.0   | browser-safe  | The pure team-chat orchestration engine + `BoardClient` + nudge queue + `./contract` | [team-orchestration](/reference/packages/team-orchestration)   |
| `@clawboo/tsconfig`            | 0.0.0   | (config-only) | Shared TS configs (`base.json`, `react.json`, `node.json`)                           | [tsconfig](/reference/packages/tsconfig)                       |
| `@clawboo/ui`                  | 0.1.0   | browser-safe  | shadcn/ui primitives + `BooAvatar` + design tokens                                   | [ui](/reference/packages/ui)                                   |
| `@clawboo/worktrees`           | 0.1.0   | server-only   | Per-task git-worktree lifecycle + SoR scaffold + `AGENT_HANDOFF.json`                | [worktrees](/reference/packages/worktrees)                     |
| `@clawboo/adapter-claude-code` | 0.1.0   | browser-safe  | Claude Code `RuntimeAdapter` (pure; server driver injected)                          | [adapter-claude-code](/reference/packages/adapter-claude-code) |
| `@clawboo/adapter-codex`       | 0.1.0   | browser-safe  | Codex `RuntimeAdapter` (pure; server driver injected)                                | [adapter-codex](/reference/packages/adapter-codex)             |
| `@clawboo/adapter-hermes`      | 0.1.0   | browser-safe  | Hermes `RuntimeAdapter` (pure; server driver injected)                               | [adapter-hermes](/reference/packages/adapter-hermes)           |
| `@clawboo/adapter-native`      | 0.1.0   | browser-safe  | clawboo-native `RuntimeAdapter` + `AgentConfig` schema                               | [adapter-native](/reference/packages/adapter-native)           |
| `@clawboo/adapter-openclaw`    | 0.1.0   | browser-safe  | OpenClaw `RuntimeAdapter` over the Gateway client                                    | [adapter-openclaw](/reference/packages/adapter-openclaw)       |

## Dependency graph

Runtime `dependencies` only (`@clawboo/*` edges). `@clawboo/tsconfig` is a devDependency root, omitted from the runtime graph. Leaf nodes (`config`, `protocol`, `boo-avatar`, `board-core`, `agent-registry`, `capability-registry`, `compaction`, `executor`, `model-catalog`, `obs`, `process-lookup`, `scheduler`, `worktrees`) have no `@clawboo/*` runtime edges.

```mermaid
graph TD
  logger[logger]
  protocol[protocol]
  config[config]
  obs[obs]
  governance[governance]
  compaction[compaction]
  executor[executor]
  model-catalog[model-catalog]
  boo-avatar[boo-avatar]
  board-core[board-core]
  agent-registry[agent-registry]

  gateway-client[gateway-client] --> logger
  events[events] --> gateway-client
  events --> logger
  events --> protocol
  gateway-proxy[gateway-proxy] --> config
  db[db] --> board-core
  db --> compaction
  db --> governance
  db --> obs
  mcp[mcp] --> db
  evals[evals] --> db
  evals --> executor
  evals --> governance
  evals --> obs
  team-orchestration[team-orchestration] --> board-core
  team-orchestration --> executor
  team-orchestration --> governance
  ui[ui] --> boo-avatar
  control-client[control-client] --> agent-registry

  adapter-openclaw[adapter-openclaw] --> events
  adapter-openclaw --> executor
  adapter-openclaw --> gateway-client
  adapter-openclaw --> logger
  adapter-openclaw --> protocol
  adapter-claude-code[adapter-claude-code] --> executor
  adapter-codex[adapter-codex] --> executor
  adapter-hermes[adapter-hermes] --> executor
  adapter-native[adapter-native] --> executor
```

## Build order

Packages build before the apps that depend on them. Within each tier, packages have no `@clawboo/*` edge on a sibling in the same tier.

1. **`tsconfig` + `logger`**, the shared TS-config root and the base logger (`logger` has no `@clawboo/*` edge).
2. **`config` · `gateway-client` · `protocol` · `agent-registry` · `board-core`**; `gateway-client` depends on `logger`; the rest are pure/zero-dep. `board-core` is the task state machine both `db` and `team-orchestration` build on.
3. **`events` · `db` · `gateway-proxy`**; `events` → `gateway-client`/`logger`/`protocol`; `gateway-proxy` → `config`; `db` → `compaction`/`governance`/`obs` (which build in tier 4 below; `db` is sequenced after them in practice).
4. **`executor` · `adapters/*` · `worktrees` · `compaction` · `model-catalog` · `scheduler` · `governance` · `obs`**; `executor` is pure (`./` + `./contract` + `./tiers`); the five adapters depend only on `executor` (`adapter-openclaw` also on `events`/`gateway-client`/`logger`/`protocol`); `compaction`/`obs`/`governance` are the dependencies `db` pulls in; `model-catalog` is a zero-dep leaf both `apps/web` layers read.
5. **`boo-avatar` + `ui`**; `ui` → `boo-avatar`.
6. **`mcp`**, depends on `db`; bundles its stdio bins.
7. **`apps/web` → `apps/cli`**; the web app consumes all 29 runtime packages (28 as direct dependencies; `boo-avatar` reaches it transitively via `ui`); the CLI consumes only `config` and `process-lookup`, both inlined into its bundle (declared as devDependencies alongside `tsconfig`).

<Note>
The `db` ↔ `compaction`/`governance`/`obs` and `evals` ↔ `db`/`executor`/`governance`/`obs` edges mean tiers 3–4 are interleaved in dependency terms; Turbo resolves the exact topological order from each `package.json`. The tiers above are the human-readable grouping, not a strict serial sequence.
</Note>

## See also

- [Reference map](/reference/index)
- [Monorepo & build](/internals/monorepo-and-build)
- [The RuntimeAdapter trait](/internals/runtime-adapter)
- [AgentSource & registry of record](/internals/agent-source)
- [Database schema](/reference/database-schema)
