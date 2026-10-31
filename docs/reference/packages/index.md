---
title: 'Packages'
sidebarTitle: 'Overview'
description: 'Every private @clawboo/* workspace package: what it is for, who uses it, how the packages depend on each other, and the rules they follow.'
icon: 'package'
keywords:
  [
    'packages',
    'package overview',
    'workspace',
    'monorepo',
    'pnpm',
    'turbo',
    'tsup',
    'agent-registry',
    'boo-avatar',
    'capability-registry',
    'compaction',
    'config',
    'control-client',
    'evals',
    'events',
    'gateway-proxy',
    'logger',
    'model-catalog',
    'obs',
    'pack-format',
    'process-lookup',
    'protocol',
    'tsconfig',
    'ui',
  ]
---

Use this page to find which workspace package owns a piece of Clawboo, what it may import, and where its
deeper docs live. It is written for contributors. Every package is private, so nobody outside this repository
installs one.

## At a glance

| What                                              | Count                                                                                   |
| ------------------------------------------------- | --------------------------------------------------------------------------------------- |
| Packages under `packages/`                        | 27                                                                                      |
| Runtime adapters under `packages/adapters/`       | 6                                                                                       |
| Workspace packages published to npm               | 0                                                                                       |
| Workspace packages `apps/web` depends on directly | 31 (all but `boo-avatar`, which arrives through `ui`, and `tsconfig`, a dev dependency) |

## How packages reach users

Every `@clawboo/*` package is `private: true`. The only npm package is `clawboo`, which `pnpm assemble` builds
from three pieces:

- the CLI from `apps/cli`, which imports only `@clawboo/config` and `@clawboo/process-lookup`;
- the dashboard server (`server.js`) and the browser app (`ui/`), both built by `apps/web`;
- the four MCP stdio bins (`clawboo-mcp-tasks`, `clawboo-mcp-memory`, `clawboo-mcp-tools`,
  `clawboo-mcp-teamchat`), built from `@clawboo/mcp`.

The server and the bins inline every `@clawboo/*` package they import. A package change therefore reaches users
only inside those bundles, in the next `clawboo` release. See [Release process](/internals/release-process) for
how a release is cut.

## All packages

The **Kind** column says what a package may run in. **pure** has no runtime dependencies and no `node:*` imports.
**browser-safe** has dependencies but imports nothing from `node:*`. **server-only** imports `node:*` and must stay
out of the browser app. **config** ships configuration files only. **Used by** names areas: the server is `apps/web/server`,
the SPA is `apps/web/src`, and "(types)" means type-only imports.

| Package                        | Kind         | Purpose                                                                                     | Used by                                                         | Documented in                                                                           |
| ------------------------------ | ------------ | ------------------------------------------------------------------------------------------- | --------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| `@clawboo/agent-registry`      | pure         | The `AgentSource` interface, agent, team and session records, and the registry of sources   | server; SPA and `control-client` (types)                        | [AgentSource and the agent registry](/internals/agent-source), [notes](#agent-registry) |
| `@clawboo/board-core`          | pure         | Task statuses, legal moves, dispatch rules, Needs you reasons, run-cost sums                | server, SPA, `db`, `team-orchestration`                         | [board-core](/reference/packages/board-core)                                            |
| `@clawboo/boo-avatar`          | pure         | The generated per-agent Boo SVG and the fixed Codex, Claude and Hermes Boos                 | `ui`                                                            | [notes](#boo-avatar-and-ui)                                                             |
| `@clawboo/capability-registry` | pure         | The capability record and source interface behind the Capabilities panel and the Org chart  | server, SPA                                                     | [Capability and schedule sources](/internals/seams), [notes](#capability-registry)      |
| `@clawboo/compaction`          | pure         | Shrinks long tool output without dropping error lines                                       | server, `db`                                                    | [notes](#compaction)                                                                    |
| `@clawboo/config`              | server-only  | State folders, `settings.json`, and the `CLAWBOO_BASE_PATH` rules                           | server, CLI, `gateway-proxy`                                    | [notes](#config)                                                                        |
| `@clawboo/connector-catalog`   | pure         | The offline connector directory: curated entries, the community snapshot, brokered apps     | server, SPA, root scripts                                       | [Add a connector](/reference/packages/connector-catalog)                                |
| `@clawboo/control-client`      | browser-safe | The SPA's REST and SSE client (`apiFetch`, `apiUrl`, typed route wrappers)                  | SPA                                                             | [notes](#control-client)                                                                |
| `@clawboo/db`                  | server-only  | The SQLite schema and every repository: board, rooms, memory, tools, grants, budgets        | server, `mcp`, `evals`; SPA (types)                             | [db](/reference/packages/db)                                                            |
| `@clawboo/evals`               | server-only  | The eval harness that grades Clawboo's own orchestration guarantees                         | server                                                          | [Testing strategy](/internals/testing), [notes](#evals)                                 |
| `@clawboo/events`              | browser-safe | Turns OpenClaw Gateway frames into typed intents (Bridge, Policy, Handler)                  | server, SPA, `adapter-openclaw`                                 | [The event pipeline](/internals/event-pipeline), [notes](#events)                       |
| `@clawboo/executor`            | pure         | The `RuntimeAdapter` interface, the `RuntimeEvent` union, the adapter contract suite        | server, every adapter; `team-orchestration` and `evals` (types) | [Write a runtime adapter](/reference/packages/executor)                                 |
| `@clawboo/gateway-client`      | browser-safe | The WebSocket client for the OpenClaw Gateway, plus exec-approval helpers                   | server, SPA; `events` and `adapter-openclaw` (types)            | [gateway-client](/reference/packages/gateway-client)                                    |
| `@clawboo/gateway-proxy`       | server-only  | The dashboard's Gateway WebSocket proxy, the access gate, the Origin and Host guard         | server                                                          | [gateway-client](/reference/packages/gateway-client)                                    |
| `@clawboo/governance`          | browser-safe | Pure decision rules: verification verdicts, budget math, caps, breakers, connector grants   | server, `db`, `team-orchestration`                              | [governance](/reference/packages/governance)                                            |
| `@clawboo/logger`              | browser-safe | The pino logger, with secret masking on every record                                        | server, `gateway-client`; `events` (types)                      | [notes](#logger)                                                                        |
| `@clawboo/mcp`                 | server-only  | Clawboo's four MCP servers, the client for third-party connectors, attach signing           | server; the four stdio bins                                     | [mcp](/reference/packages/mcp)                                                          |
| `@clawboo/model-catalog`       | pure         | The static provider and model list behind the model pickers                                 | server, SPA                                                     | [notes](#model-catalog)                                                                 |
| `@clawboo/obs`                 | browser-safe | Orchestration event kinds, the error taxonomy, pure projections over the event log          | server, `db`, `evals`                                           | [Events and errors](/reference/events-and-errors), [notes](#obs)                        |
| `@clawboo/pack-format`         | browser-safe | The marketplace pack schema and its version ladder                                          | server, root catalog scripts; SPA (types)                       | [Marketplace catalog](/reference/marketplace-catalog), [notes](#pack-format)            |
| `@clawboo/process-lookup`      | server-only  | Finds the process listening on a port, through `lsof` or `netstat`                          | server, CLI                                                     | [notes](#process-lookup)                                                                |
| `@clawboo/protocol`            | pure         | Gateway message parsing, transcript types, agent-file definitions, the OpenClaw install pin | server, SPA, `events`, `adapter-openclaw`                       | [notes](#protocol)                                                                      |
| `@clawboo/scheduler`           | browser-safe | Routine spec parsing, next-run math, the calendar projection, schedule sources              | server, SPA                                                     | [scheduler](/reference/packages/scheduler)                                              |
| `@clawboo/team-orchestration`  | browser-safe | The team chat engine: delegation, the board cascade, session keys                           | server, SPA                                                     | [team-orchestration](/reference/packages/team-orchestration)                            |
| `@clawboo/tsconfig`            | config       | Shared TypeScript presets: `base.json`, `react.json`, `node.json`                           | every package and both apps (`extends`)                         | [notes](#tsconfig)                                                                      |
| `@clawboo/ui`                  | browser-safe | `BooAvatar`, `BooVariantAvatar`, and the `cn` and `cva` class helpers                       | SPA                                                             | [Design system](/internals/design-system), [notes](#boo-avatar-and-ui)                  |
| `@clawboo/worktrees`           | server-only  | Per-task git worktrees, the task's working files, the handoff record                        | server                                                          | [worktrees](/reference/packages/worktrees)                                              |
| `@clawboo/adapter-claude-code` | browser-safe | The Claude Code runtime adapter                                                             | server                                                          | [Runtime adapters](/reference/packages/adapters)                                        |
| `@clawboo/adapter-codex`       | browser-safe | The Codex runtime adapter                                                                   | server                                                          | [Runtime adapters](/reference/packages/adapters)                                        |
| `@clawboo/adapter-hermes`      | browser-safe | The Hermes runtime adapter                                                                  | server                                                          | [Runtime adapters](/reference/packages/adapters)                                        |
| `@clawboo/adapter-mock`        | browser-safe | A fault-injection runtime, offered only with `CLAWBOO_ENABLE_MOCK_RUNTIME=1`                | server                                                          | [Runtime adapters](/reference/packages/adapters)                                        |
| `@clawboo/adapter-native`      | browser-safe | The Clawboo Native runtime adapter and its `AgentConfig` schema                             | server                                                          | [Runtime adapters](/reference/packages/adapters)                                        |
| `@clawboo/adapter-openclaw`    | browser-safe | The OpenClaw runtime adapter over the Gateway client                                        | server                                                          | [Runtime adapters](/reference/packages/adapters)                                        |

## Dependency layers

Each package depends only on packages in a lower layer, counting runtime `dependencies` in its `package.json`.
Turbo derives the build order from those same edges (`"dependsOn": ["^build"]` in `turbo.json`), so nobody keeps
a build order by hand. `@clawboo/tsconfig` is a dev dependency of everything and sits outside the layers.

| Layer | Package                                                                                                                                                                                                                                             | Workspace dependencies                                               |
| ----- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------- |
| 0     | `agent-registry`, `board-core`, `boo-avatar`, `capability-registry`, `compaction`, `config`, `connector-catalog`, `executor`, `governance`, `logger`, `model-catalog`, `obs`, `pack-format`, `process-lookup`, `protocol`, `scheduler`, `worktrees` | none                                                                 |
| 1     | `adapter-claude-code`, `adapter-codex`, `adapter-hermes`, `adapter-mock`, `adapter-native`                                                                                                                                                          | `executor`                                                           |
| 1     | `control-client`                                                                                                                                                                                                                                    | `agent-registry`                                                     |
| 1     | `db`                                                                                                                                                                                                                                                | `board-core`, `compaction`, `governance`, `obs`                      |
| 1     | `gateway-client`                                                                                                                                                                                                                                    | `logger`                                                             |
| 1     | `gateway-proxy`                                                                                                                                                                                                                                     | `config`                                                             |
| 1     | `team-orchestration`                                                                                                                                                                                                                                | `board-core`, `executor`, `governance`                               |
| 1     | `ui`                                                                                                                                                                                                                                                | `boo-avatar`                                                         |
| 2     | `evals`                                                                                                                                                                                                                                             | `db`, `executor`, `governance`, `obs`                                |
| 2     | `events`                                                                                                                                                                                                                                            | `gateway-client`, `logger`, `protocol`                               |
| 2     | `mcp`                                                                                                                                                                                                                                               | `db`                                                                 |
| 3     | `adapter-openclaw`                                                                                                                                                                                                                                  | `events`, `executor`, `gateway-client`, `logger`, `protocol`         |
| app   | `apps/cli`                                                                                                                                                                                                                                          | `config`, `process-lookup` (dev dependencies, inlined at build time) |
| app   | `apps/web`                                                                                                                                                                                                                                          | every package except `boo-avatar` and `tsconfig`                     |

## Rules

- **Dependencies flow one way.** Apps depend on packages and packages depend on packages. A package never imports
  from `apps/`, and the Express server (`apps/web/server`) and the SPA (`apps/web/src`) never import each other.
  Code both halves need goes in a package, which is why `model-catalog` exists. ESLint enforces all three
  boundaries for static imports, and the server and SPA boundaries for dynamic `import()` too; see
  [Monorepo and build](/internals/monorepo-and-build).
- **The browser imports `@clawboo/db` for types only.** Its entry point pulls in `better-sqlite3`, Drizzle and
  `node:*` modules. `apps/web/src/__tests__/browserBundlePurity.test.ts` fails on any value import, re-export or
  dynamic import of `@clawboo/db` under `apps/web/src`. Keep the other server-only packages out of the SPA as
  well; no test checks those, so check for it in review.
- **`board-core` keeps zero dependencies.** The same test checks that its built files declare no bare import and
  that `state-machine.ts` imports nothing, so the transition table can ship to the browser.
- **Re-export a workspace dependency by name.** tsup keeps workspace dependencies external, and an `export *` from
  an external module leaves the server's esbuild bundle unable to resolve the names. `@clawboo/db` re-exports the
  `board-core` symbols by name, and `@clawboo/ui` does the same for `boo-avatar`. A star re-export of a module
  inside the same package is fine.
- **Test helpers get their own entry point.** `@clawboo/executor/contract` and
  `@clawboo/team-orchestration/contract` import vitest and keep it external, so they bind to the caller's vitest
  and the main entry points never pull in a test runner.
- **Builds and type checks are separate.** Every package except `tsconfig` builds with tsup to CommonJS, ESM and `.d.ts` files. Its
  `typecheck` script runs `tsc --noEmit` against one of the `@clawboo/tsconfig` presets.

## Add a package

<Steps>

<Step title="Create the folder">

Make `packages/<name>/` (or `packages/adapters/<name>/` for a runtime adapter). The workspace globs in
`pnpm-workspace.yaml` already include both locations.

</Step>

<Step title="Write the manifest and configs">

Copy a sibling with the same kind. The `package.json` needs `"name": "@clawboo/<name>"`, `"private": true`, the
`build`, `lint`, `typecheck` and `test` scripts, and `"@clawboo/tsconfig": "workspace:*"` as a dev dependency.
Add a `tsconfig.json` that extends the matching preset and a `tsup.config.ts` with `format: ['cjs', 'esm']` and
`dts: true`.

</Step>

<Step title="Wire the consumers">

Add `"@clawboo/<name>": "workspace:*"` to the `dependencies` of every package or app that imports it (usually
`apps/web/package.json`), then run `pnpm install`.

</Step>

<Step title="List it here">

Add a row to the table above and to the layer table, and check it with `pnpm build` and `pnpm test`. You should see
the new package build before the packages that depend on it.

</Step>

</Steps>

## Notes on the smaller packages

These packages have no page of their own. Each note names the main entry points and what to know before you
change one.

### agent-registry

The `AgentSource` interface, the agent, team and session record types, and `AgentRegistry`, which holds one source
per runtime. A source answers who exists; how an agent runs is the `RuntimeAdapter`'s job in `@clawboo/executor`,
and the two never mix. The server registers five sources: `OpenClawAgentSource`, `ClawbooNativeAgentSource`, and a
`RuntimeAgentSource` each for Claude Code, Codex and Hermes. Every source reads its records from SQLite. Only the
OpenClaw source needs a live upstream: creating an OpenClaw agent, its agent files and its session list go through
the Gateway and fail while it is disconnected, while the other sources write SQLite directly. Details live on
[AgentSource and the agent registry](/internals/agent-source).

### boo-avatar and ui

`@clawboo/boo-avatar` draws the generated Boo: `generateBooAvatar(params)` returns the same SVG string for the
same parameters, and `resolveBooTint(seed)` picks a tint from `TINTS`, whose first entry is reserved for Boo Zero.
It also holds the fixed Boo drawings for three runtimes: `variantIdForRuntime` maps `codex`, `claude-code` and
`hermes` to their drawing and every other runtime to `null` (keep the generated Boo). The drawings sit behind
`loadBooVariant` and their own entry points (`./variants/codex`, `./variants/claude`, `./variants/hermes-light`,
`./variants/hermes-dark`), so they stay out of the main bundle. `scopeSvgIds` gives each inlined copy its own
gradient and clip ids.

`@clawboo/ui` wraps both as React components: `BooAvatar` (ids scoped per mounted copy, memoized on all props) and
`BooVariantAvatar` (loads the drawing on demand, so its first render can be empty for a moment). In the app,
`AgentBooAvatar` picks between them by runtime. The package also exports the `cn` and `cva` class helpers and a
`tokens` constant that the app does not read; the live theme is the CSS custom properties described in
[Design system](/internals/design-system). `@clawboo/ui` is the only importer of `@clawboo/boo-avatar`.

### capability-registry

The `CapabilityRecord` shape, the `CapabilitySource` interface, and `CapabilityMultiplexer`, which merges every
source into the one list the Capabilities panel and the Org chart read. There are six sources: `native`, `hermes`,
`claude-code`, `codex` and `openclaw` (what each runtime's agents have), plus `connector` (the connectors Clawboo
itself connects). Capability ids are `<sourceId>:<key>`, and a write goes to the source that owns the id. Records
also carry connector grant, health and risk fields, which the Org chart draws as grant edges and badges. A new
runtime needs its id in `CapabilitySourceId` and `SOURCE_IDS` plus a source under
`apps/web/server/lib/capabilitySource/`; the pattern is described on [Capability and schedule sources](/internals/seams).

### compaction

`compactToolOutput(toolName, output)` shrinks long tool output before it re-enters a prompt, and
`compactToolResultMarkdown` applies it to every tool-result block inside a transcript. It makes two promises: small
outputs and low-savings results come back unchanged, and if a rule would drop an error line, the original comes
back instead. Built-in rules handle git status, test output and HTML, with a dedupe-and-elide fallback; pass extra
rules in `opts.rules` and they run first. All callers are on the server: the tool broker in `@clawboo/db`, the task
runner, the team orchestrator and the Clawboo Native conversation loop.

### config

`resolveClawbooDir()` returns Clawboo's own state folder (`CLAWBOO_HOME`, else `~/.clawboo`), and
`resolveStateDir()` returns OpenClaw's (`OPENCLAW_STATE_DIR`, else the first existing folder among `~/.openclaw`,
`~/.clawdbot` and `~/.moltbot`, falling back to `~/.openclaw`). `loadSettings()` and
`saveSettings()` read and write `settings.json` in Clawboo's folder. `resolveBasePath()` validates
`CLAWBOO_BASE_PATH`: it accepts `/clawboo`-style paths and rejects whitespace, `%`, `?`, `#`, backslashes, empty or
dot segments and a first segment of `api`, and the server exits on an invalid value. The CLI uses
`resolveBasePathOrRoot()`, which falls back to the root. See [Configuration](/reference/configuration).

### control-client

The browser's API client. `apiFetch(path)` and `apiUrl(path)` add the base path, and typed modules wrap the agent,
runtime, provider and onboarding routes. At startup the SPA calls `setApiBase` with the path prefix the server
injects, so a dashboard served under `CLAWBOO_BASE_PATH` keeps working. ESLint rejects a root-absolute `/api/...`
`fetch` or `EventSource` in `apps/web/src`, so always go through these helpers. `setRequestHeaderProvider` exists
for a client on another origin; the dashboard never calls it.

### evals

The harness that checks Clawboo's own orchestration guarantees against throwaway boards: regression tasks (the
atomic claim is never retried, the dependency gate, report-up, the state machine) and capability tasks
(cross-runtime resume, verification catching a bug, delegation fan-out). Each task runs K trials in a fresh
environment. `passAt1` is the share of trials that passed, and `passPowK` is that share raised to the k-th power,
the estimated chance that k trials in a row all pass. The smoke subset runs in `pnpm test`, from the dashboard
through `POST /api/eval/smoke`, and in the manual `evals.yml` workflow. Tasks use code graders only, so no suite
needs a provider key. Add a task to `packages/evals/src/tasks/regression.ts` or `capability.ts`. See
[Testing strategy](/internals/testing).

### events

The browser runs every OpenClaw Gateway frame through three steps: `classifyEvent` sorts it (Bridge),
`derivePolicy` decides what should change (Policy), and `createEventHandler` applies those intents to the SPA's
stores (Handler). The server reuses the parsers, `parseSessionMessagePayload` in particular, to show activity from
OpenClaw sessions Clawboo did not start. The full walk-through is on [The event pipeline](/internals/event-pipeline).

### logger

`createLogger(module)` returns a child of one pino logger. The level comes from `LOG_LEVEL` (default `info`), and
output is pretty-printed unless `NODE_ENV=production`. Every record goes through `redactObject`, which masks
credential-looking keys and values with `••••` while token counts and costs survive. The server's API routes
apply the same redactor to event payloads and audit rows before they send them. Stored data is scrubbed
separately by `@clawboo/db`, which writes `[REDACTED]`. The package reads `process.env` behind a guard, so it is
safe in the browser bundle.

### model-catalog

`MODEL_GROUPS` is the static list of OpenClaw providers and models behind the model pickers, with ids in
OpenClaw's `provider/model-id` routing shape. Clawboo Native keeps its own catalog with provider-native ids
(`apps/web/src/lib/nativeModelCatalog.ts`). `findModelLabel`, `findProviderForModel` and `formatProviderName` read
the list, and `providerSlug` is the one comparison key for provider names (so `Hugging Face` matches
`huggingface`). The list does not decide which providers are set up: the server's `/api/system/models` route reads
the live list from the OpenClaw CLI, uses this one for casing, and falls back to it for a known provider the CLI
does not list (or for every provider when the CLI is unavailable). It is a package so that route and the SPA can
share it without crossing the server and SPA boundary; the SPA imports it through
`apps/web/src/lib/modelCatalog.ts`.

### obs

Pure observability building blocks: the orchestration event kinds and their data schemas, the runtime error
taxonomy (`classifyError`), projections that fold the event log into a task graph and fleet health
(`projectGraph`, `projectFleetHealth`), and the structured-output judge that the verification critic and the eval
model grader share. It never imports OpenTelemetry; the server loads that only when an OTLP endpoint is set. To add
an event kind, add it to `ORCHESTRATION_EVENT_KINDS` with a data schema in `packages/obs/src/events/schema.ts` and
document it on [Events and errors](/reference/events-and-errors). An unknown kind reaching `appendEvent` in
`@clawboo/db` is stored as `error`.

### pack-format

The versioned schema for marketplace packs. The published contract is the JSON Schema in `catalog/schema/`; this
package is its TypeScript mirror and stays private. `parseAgentPack` validates a pack and runs it up the version
ladder, bounded by `MIN_SUPPORTED_SCHEMA_VERSION` and `CURRENT_SCHEMA_VERSION`. The server's catalog index and the
`scripts/catalog/*` tools use it (the scripts import its source by relative path), and the SPA imports only its
types. The format is documented in [Marketplace catalog](/reference/marketplace-catalog).

### process-lookup

`findListenerPid(port)` returns the process listening on a TCP port, or `null`, and never throws. The CLI's `stop`
and `restart` commands and the server's managed-Gateway control both pass its answer to `process.kill`, so a wrong
answer kills an innocent process. Three details keep it right:

- On macOS and Linux it runs `lsof -nP -iTCP:<port> -sTCP:LISTEN -t`. Without `-sTCP:LISTEN`, a browser tab
  connected to the dashboard also matches, and `-n -P` keep a slow DNS resolver from blocking the call.
- On Windows it parses `netstat -ano` with a raised output buffer, because a busy host overflows Node's default.
- `netstat` translates its state column on non-English Windows, so when no `LISTENING` row matches it accepts a
  row whose local address is the port and whose foreign address is all zeros.

The parsers (`parseLsofPids`, `parseNetstatPid`) are pure; keep their recorded-output tests when you change them.

### protocol

Pure helpers for OpenClaw Gateway messages (`extractText`, `extractThinking`, `extractToolCalls`, `parseMessage`),
the transcript entry types the chat views render, and the agent-file definitions. `AGENT_FILE_RUNTIME_SUPPORT`
decides which file tabs the agent editor shows on each runtime (`agentFilesForRuntime`), and a runtime missing
from it shows all seven files, so add a row when you add a runtime. The user-facing table is on
[Create and edit agents](/using/agents). The package also pins the OpenClaw version Clawboo installs (`OPENCLAW_INSTALL_SPEC`, with
the Node versions it accepts) and holds the web-browsing guidance appended to a new OpenClaw agent's `AGENTS.md`.

### tsconfig

Three TypeScript presets. `base.json` is the strict baseline, and every package not named below extends it.
`react.json` adds JSX and the DOM libraries, for `apps/web` and `packages/ui`. `node.json` adds Node types and
Node-style resolution, for `apps/cli`, `config`, `db`, `gateway-proxy`, `logger`, `mcp`, `process-lookup` and
`worktrees`. The presets drive type checking only, and
tsup decides the build output. `board-core` and `pack-format` also pin `types: []` in their main `tsconfig.json`,
so a Node global cannot slip into browser-safe source, and type-check their tests separately with a second
`tsconfig.test.json` that drops the pin. See
[Monorepo and build](/internals/monorepo-and-build).

## Related

- [Monorepo and build](/internals/monorepo-and-build): the workspace layout, the lint boundaries and the build
  pipeline.
- [Write a runtime adapter](/reference/packages/executor): the extension point for a new runtime.
- [Runtime adapters](/reference/packages/adapters): the six adapters compared.
- [@clawboo/db](/reference/packages/db): the schema owner and every repository.
- [Testing strategy](/internals/testing): the test projects, the e2e suite and the standing guards.
