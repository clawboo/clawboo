---
title: Environment variables
description: 'Every environment variable Clawboo reads: state paths, ports, secrets, runtime keys, OpenClaw interop, logging, and operational tuning.'
---

A complete, code-grounded list of every environment variable Clawboo actually reads. Each entry names the variable, what reads it, its purpose, and its default. Variables not listed here are not consulted by Clawboo.

<Info>
This page documents only Clawboo's own configuration variables, sourced from `@clawboo/config`, the runtime descriptor, the secrets vault, server boot, port resolution, the logger, and the runtime drivers. Environment variables that appear inside the codegen'd marketplace agent templates (`FEISHU_*`, `SUPABASE_*`, `DATABASE_URL`, `BETTER_AUTH_SECRET`, and similar) are third-party *agent content*, not Clawboo config; they are never read by Clawboo and are not documented here.
</Info>

<Note>
Provider API keys (`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `OPENROUTER_API_KEY`, plus the seven native OpenAI-compatible keys listed below) are read indirectly through the credential-resolution chain (`process.env` → encrypted vault → OpenClaw's `~/.openclaw/.env`). Setting one in the process environment is the highest-priority way to satisfy a runtime's credential check. See [Runtime provider keys](#runtime-provider-keys) and [Connecting runtimes](/runtimes/connecting-runtimes).
</Note>

## At a glance

| Variable                               | Area               | Default                          | Read by                                 |
| -------------------------------------- | ------------------ | -------------------------------- | --------------------------------------- |
| `CLAWBOO_HOME`                         | State & paths      | `~/.clawboo`                     | `resolveClawbooDir()`                   |
| `OPENCLAW_STATE_DIR`                   | State & paths      | `~/.openclaw`                    | `resolveStateDir()`                     |
| `MOLTBOT_STATE_DIR`                    | State & paths      | (none)                           | `resolveStateDir()` legacy fallback     |
| `CLAWDBOT_STATE_DIR`                   | State & paths      | (none)                           | `resolveStateDir()` legacy fallback     |
| `CLAWBOO_DB_PATH`                      | State & paths      | `~/.openclaw/clawboo/clawboo.db` | `defaultDbPath()` (MCP stdio bins)      |
| `CLAWBOO_UI_DIR`                       | State & paths      | `<server>/ui`                    | server boot (production static serving) |
| `CLAWBOO_SERVER_PATH`                  | State & paths      | (auto-discovered)                | CLI dev-fallback launch                 |
| `CLAWBOO_MCP_BIN_DIR`                  | State & paths      | (set by CLI)                     | `GET /api/mcp/config` stdio snippet     |
| `CLAWBOO_API_PORT`                     | Ports & binding    | `18790` (auto-scan)              | `resolveApiPort()`                      |
| `CLAWBOO_API_PORT_START`               | Ports & binding    | `18790`                          | `resolveApiPort()` scan start           |
| `CLAWBOO_AWAIT_PORT`                   | Ports & binding    | (none)                           | server boot (restart handoff)           |
| `CLAWBOO_VERSION`                      | Version & updates  | (read from the shipped manifest) | `getCurrentVersion()`                   |
| `PORT`                                 | Ports & binding    | (none)                           | `resolveApiPort()` (production only)    |
| `HOST`                                 | Ports & binding    | `127.0.0.1`                      | `resolveHost()`                         |
| `HOSTNAME`                             | Ports & binding    | (ignored)                        | ignored (no longer a bind signal)       |
| `CLAWBOO_ALLOWED_ORIGINS`              | Ports & binding    | (loopback only)                  | same-origin guard (widen)               |
| `CLAWBOO_ALLOWED_HOSTS`                | Ports & binding    | (loopback only)                  | same-origin guard (widen)               |
| `STUDIO_ACCESS_TOKEN`                  | Secrets & auth     | (none)                           | access gate                             |
| `CLAWBOO_ALLOW_INSECURE`               | Secrets & auth     | (unset)                          | boot guard (wide-bind opt-out)          |
| `CLAWBOO_SECRETS_MASTER_KEY`           | Secrets & auth     | auto-generated key file          | secrets vault                           |
| `ANTHROPIC_API_KEY`                    | Runtime keys       | (none)                           | `resolveRuntimeKey()`                   |
| `OPENAI_API_KEY`                       | Runtime keys       | (none)                           | `resolveRuntimeKey()`                   |
| `OPENROUTER_API_KEY`                   | Runtime keys       | (none)                           | `resolveRuntimeKey()`                   |
| `GEMINI_API_KEY`                       | Runtime keys       | (none)                           | `resolveRuntimeKey()` (native compat)   |
| `XAI_API_KEY`                          | Runtime keys       | (none)                           | `resolveRuntimeKey()` (native compat)   |
| `GROQ_API_KEY`                         | Runtime keys       | (none)                           | `resolveRuntimeKey()` (native compat)   |
| `MISTRAL_API_KEY`                      | Runtime keys       | (none)                           | `resolveRuntimeKey()` (native compat)   |
| `TOGETHER_API_KEY`                     | Runtime keys       | (none)                           | `resolveRuntimeKey()` (native compat)   |
| `CEREBRAS_API_KEY`                     | Runtime keys       | (none)                           | `resolveRuntimeKey()` (native compat)   |
| `MOONSHOT_API_KEY`                     | Runtime keys       | (none)                           | `resolveRuntimeKey()` (native compat)   |
| `OLLAMA_BASE_URL`                      | Runtime keys       | `http://localhost:11434/v1`      | native OpenAI-compat provider           |
| `CLAWBOO_REVIEWER_MODEL`               | Runtime tuning     | (the builder's model)            | executor verification critic            |
| `LOG_LEVEL`                            | Logging            | `info`                           | `@clawboo/logger`                       |
| `NODE_ENV`                             | Logging            | (none)                           | `@clawboo/logger` transport selection   |
| `CLAWBOO_DB_WRITE_BUDGET_MS`           | Operational tuning | `1500` (1.5 s)                   | SQLite write-retry budget               |
| `CLAWBOO_BOARD_STALE_TTL_MS`           | Operational tuning | `180000` (3 min)                 | board stale-task sweep                  |
| `CLAWBOO_BOARD_STALE_SWEEP_MS`         | Operational tuning | `60000` (60 s)                   | board stale-task sweep                  |
| `CLAWBOO_DISPATCH_PUMP_MS`             | Operational tuning | `60000` (60 s)                   | board dispatch pump                     |
| `CLAWBOO_ENABLE_MOCK_RUNTIME`          | Testing            | (unset)                          | runtime registry (fault-injection)      |
| `CLAWBOO_HOME_MUTEX_ACQUIRE_MS`        | Operational tuning | `600000` (10 min)                | per-identity dispatch mutex             |
| `CLAWBOO_MAX_FIX_CYCLES`               | Operational tuning | `1` (2 attempts)                 | `verifyMaxAttempts()`                   |
| `CLAWBOO_RUN_SILENT_TIMEOUT_MS`        | Operational tuning | `1800000` (30 min)               | drain idle guard                        |
| `CLAWBOO_ROUTINE_DISPATCH_DEADLINE_MS` | Operational tuning | `900000` (15 min)                | routine dispatch deadline               |
| `CLAWBOO_APPROVAL_TTL_MS`              | Operational tuning | `86400000` (24 h)                | approval reaper                         |
| `CLAWBOO_APPROVAL_REAPER_INTERVAL_MS`  | Operational tuning | `3600000` (1 h)                  | approval reaper                         |
| `CLAWBOO_MCP_PROBE_MS`                 | Operational tuning | `60000` (60 s)                   | MCP liveness supervisor                 |
| `CLAWBOO_ROUTINE_OPENCLAW_TIMEOUT_MS`  | Operational tuning | `600000` (10 min)                | scheduled OpenClaw dispatch watchdog    |
| `OTEL_EXPORTER_OTLP_ENDPOINT`          | OpenTelemetry      | (none)                           | OTel bridge gate                        |
| `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT`   | OpenTelemetry      | (none)                           | OTel bridge gate                        |
| `OTEL_SERVICE_NAME`                    | OpenTelemetry      | `clawboo`                        | OTel tracer resource                    |

<Note>
There are no feature-flag environment variables; every subsystem (board, executors, worktrees, MCP, verification, governance, observability) is always on. The OpenTelemetry export bridge is the only opt-in surface, gated by the presence of an OTLP endpoint variable.
</Note>

## State & paths

### `CLAWBOO_HOME`

- **Read by**: `resolveClawbooDir()` in `@clawboo/config`.
- **Purpose**: overrides the location of Clawboo's own state directory, which holds the SQLite DB, `settings.json`, `api-port.txt`, the secrets vault, worktrees, the proxy device identity, and the managed Gateway PID file. Supports leading-`~` expansion. Used by test sandboxes to isolate state.
- **Default**: `~/.clawboo`.

### `OPENCLAW_STATE_DIR`

- **Read by**: `resolveStateDir()` in `@clawboo/config`.
- **Purpose**: overrides the location of OpenClaw's state directory, which Clawboo reads (never writes, except during OpenClaw onboarding) for interop: `openclaw.json`, the `.env` provider keys, and the Gateway auth token. Supports leading-`~` expansion.
- **Default**: `~/.openclaw` (with a fallback to any existing legacy directory before defaulting to a fresh `~/.openclaw`).

### `MOLTBOT_STATE_DIR`

- **Read by**: `resolveStateDir()` in `@clawboo/config`.
- **Purpose**: legacy alias for `OPENCLAW_STATE_DIR`, consulted only when `OPENCLAW_STATE_DIR` is unset. Present for backward compatibility with renamed-product state directories.
- **Default**: none (falls through to the standard resolution).

### `CLAWDBOT_STATE_DIR`

- **Read by**: `resolveStateDir()` in `@clawboo/config`.
- **Purpose**: second legacy alias for the OpenClaw state directory, consulted after `OPENCLAW_STATE_DIR` and `MOLTBOT_STATE_DIR`.
- **Default**: none.

### `CLAWBOO_DB_PATH`

- **Read by**: `defaultDbPath()` in `@clawboo/db`. Used by the MCP stdio bins (`clawboo-mcp-tasks` / `-memory` / `-tools` / `-teamchat`) spawned by external runtimes, so they open the same SQLite file the Express server serves.
- **Purpose**: overrides the SQLite database path.
- **Default**: `~/.openclaw/clawboo/clawboo.db`.

<Note>
The in-process Express server resolves its DB path through `getDbPath()` → `~/.clawboo/clawboo.db` (following `CLAWBOO_HOME`), **not** `defaultDbPath()`. `CLAWBOO_DB_PATH` only affects the out-of-process MCP bins. Point both at the same file if you override the server's home so external runtimes share the board. See [Configuration](/reference/configuration#the-two-db-path-resolvers).
</Note>

### `CLAWBOO_UI_DIR`

- **Read by**: server boot in `apps/web/server/index.ts` (production static serving).
- **Purpose**: overrides the directory the Express server serves the built SPA from.
- **Default**: `<server bundle dir>/ui` (`path.join(__dirname, 'ui')`).

### `CLAWBOO_SERVER_PATH`

- **Read by**: the CLI's `findMonorepoRoot()` (`apps/cli/src/lifecycle.ts`) when falling back to dev-mode launch (no bundled `server.js` present).
- **Purpose**: overrides the monorepo root the CLI spawns `tsx apps/web/server/index.ts` from. Only consulted in the dev-fallback path; the published CLI tarball uses the bundled server and ignores it.
- **Default**: auto-discovered monorepo root.

### `CLAWBOO_MCP_BIN_DIR`

- **Read by**: `GET /api/mcp/config` in `apps/web/server/api/mcp.ts`. Set by the CLI on the forked server to `<bundle dir>/bin`.
- **Purpose**: tells the server where the bundled MCP stdio bins live so `/api/mcp/config?transport=stdio` can emit a correct `node <bin>` attach snippet. When unset, only the HTTP transport attach config is emitted.
- **Default**: set by the CLI; otherwise unset (HTTP attach still works).

## Ports & binding

### `CLAWBOO_API_PORT`

- **Read by**: `resolveApiPort()` in `apps/web/server/lib/portUtils.ts`; also the CLI's dashboard discovery.
- **Purpose**: pins the Express API server to an exact port. When set, there is no auto-fallback: if the port is taken, boot fails loudly. The CLI uses the same value to discover an already-running dashboard.
- **Default**: unset → auto-scan from `18790` for the first free port.

### `CLAWBOO_API_PORT_START`

- **Read by**: `resolveApiPort()` in `apps/web/server/lib/portUtils.ts`.
- **Purpose**: overrides the starting port for the auto-scan (used only when `CLAWBOO_API_PORT` is unset). The scan tries up to 20 consecutive ports (`MAX_PORT_ATTEMPTS`).
- **Default**: `18790` (`DEFAULT_API_PORT`).

### `PORT`

- **Read by**: `resolveApiPort()` in `apps/web/server/lib/portUtils.ts`.
- **Purpose**: preserves hosting-platform compatibility (Heroku, Render, Cloud Run). Honored **only** in production-style boots (not `--dev`) and **only** when `CLAWBOO_API_PORT` is unset. Like the explicit Clawboo port, it has no fallback; boot fails if the port is taken.
- **Default**: none.

### `HOST`

- **Read by**: `resolveHost()` in `apps/web/server/lib/resolveHost.ts`.
- **Purpose**: the network interface the dashboard binds. Clawboo defaults to loopback only; set `HOST` (e.g. `0.0.0.0`) to widen the bind for a headless/remote box.
- **Default**: `127.0.0.1` (loopback).

<Warning>
A non-loopback bind (`HOST=0.0.0.0`, a LAN IP, or a hostname) WITHOUT `STUDIO_ACCESS_TOKEN` set would expose the dashboard, and every `/api/*` route, to the local network with no authentication. Clawboo **refuses to start** in that configuration — set `STUDIO_ACCESS_TOKEN`, unset `HOST`, or set `CLAWBOO_ALLOW_INSECURE=1` to run unauthenticated on purpose. See [Security](/operating/security).
</Warning>

### `HOSTNAME`

- **Read by**: nothing (as of the security hardening). `resolveHost()` **ignores** `HOSTNAME`.
- **Purpose**: previously a fallback for `HOST`. It is no longer a bind signal: Docker, systemd, and many CI runners auto-inject `HOSTNAME`, so honoring it would silently widen a container's bind to a routable IP. Widening must be an explicit `HOST=`.
- **Default**: n/a (ignored).

### `CLAWBOO_ALLOW_INSECURE`

- **Read by**: the boot guard (`shouldRefuseInsecureBind()`) in `apps/web/server/index.ts`.
- **Purpose**: explicit opt-out of the token-less-wide-bind refusal. `CLAWBOO_ALLOW_INSECURE=1` lets the server start on a non-loopback bind with no `STUDIO_ACCESS_TOKEN` (it logs a loud unauthenticated-exposure warning instead of exiting). Only use it behind your own firewall/proxy. Has no effect on a loopback bind or when a token is set.
- **Default**: unset (a token-less wide bind refuses to start).

### `CLAWBOO_ALLOWED_ORIGINS`

- **Read by**: the always-on same-origin guard (`createOriginGuard`), constructed at server boot in `apps/web/server/index.ts`.
- **Purpose**: a comma-separated list of extra browser origins to trust on `/api/*` requests and WebSocket upgrades, e.g. `https://dash.example.com`. The guard blocks every cross-origin request by default (the loopback origins are always allowed); this variable **widens** the allowlist, it never disables enforcement. Set it when you reach the dashboard from a non-loopback browser origin (a LAN IP or a reverse-proxy hostname). See [Security](/operating/security#the-same-origin-guard-always-on).
- **Default**: none (only the loopback origins, plus the Vite dev origin in `--dev`, are trusted).

### `CLAWBOO_ALLOWED_HOSTS`

- **Read by**: the always-on same-origin guard (`createOriginGuard`), constructed at server boot in `apps/web/server/index.ts`.
- **Purpose**: a comma-separated list of extra hostnames to accept in the HTTP `Host` header (the guard's DNS-rebinding defense). Like `CLAWBOO_ALLOWED_ORIGINS`, it only widens the always-enforced loopback allowlist. Set it when a reverse proxy forwards a public hostname to the dashboard.
- **Default**: none (only loopback hostnames plus the actual bind host are accepted).

### `CLAWBOO_AWAIT_PORT`

- **Read by**: server boot in `apps/web/server/index.ts`, before `resolveApiPort()`.
- **Set by**: the server's in-app self-update (`selfRestart.ts`) and the CLI's `clawboo restart` (and the restart it offers when it finds an older server), on the successor process.
- **Purpose**: makes a starting server **wait**, up to 15 seconds, for that port to be released before it tries to bind. A restart hands the same port to the successor, but the process being replaced still holds it for a moment. Without the wait, an explicitly-pinned `CLAWBOO_API_PORT` would fail loudly on a taken port and a scanning boot would drift to the next free one, orphaning the browser tab already pointed at the old URL. A missing or invalid value is a no-op, which is the common path.
- **Default**: unset (no waiting).

## Version & updates

### `CLAWBOO_VERSION`

- **Read by**: `getCurrentVersion()` in `apps/web/server/lib/updateCheck.ts`, which backs `GET /api/system/self-version`, the dashboard's "update available" chip, and the CLI's version-aware discovery check.
- **Set by**: the `clawboo` CLI on every server it spawns, so the server knows which release launched it without reading `package.json` off disk.
- **Purpose**: the fast path for "what version is this server running". The on-disk `clawboo` manifest is the fallback **and** the source of truth after an in-app self-update: a successor started by `selfRestart.ts` is launched with this variable deliberately **deleted**, precisely so it recomputes from the freshly-installed `package.json` instead of inheriting the pre-update value.
- **Default**: unset → read from the shipped `package.json` (name-guarded, so `apps/web/package.json` is never mistaken for the release), falling back to `0.0.0-dev` in a checkout.

<Note>
Setting `CLAWBOO_VERSION` by hand makes the server report a version it is not running, and makes the CLI's discovery check compare against a fiction. It exists as a launcher-to-server handoff, not as a knob.
</Note>

## Secrets & auth

### `STUDIO_ACCESS_TOKEN`

- **Read by**: the access gate (`createAccessGate({ token })`) at server boot.
- **Purpose**: when set, every HTTP request and WebSocket upgrade must present this token (the access gate is enabled). When unset, the gate is disabled, acceptable for a loopback-only bind, dangerous for a network-exposed one (see the `HOST` warning above).
- **Default**: none (access gate disabled).

<Danger>
`STUDIO_ACCESS_TOKEN` is one of the server secrets explicitly scrubbed from a spawned runtime subprocess's environment, alongside `GATEWAY_AUTH_TOKEN`, `CLAWBOO_SECRETS_MASTER_KEY`, and any `BETTER_AUTH_*` key. The same scrub also drops a curated set of the operator's third-party shell credentials (cloud, CI, package-registry, and database tokens such as `AWS_SECRET_ACCESS_KEY`, `GITHUB_TOKEN`, `NPM_TOKEN`, `DATABASE_URL`) so an untrusted agent cannot dump them from its own environment. It is best-effort by name, not a sandbox. See [Secrets never reach spawned runtimes](/operating/security#secrets-never-reach-spawned-runtimes).
</Danger>

### `CLAWBOO_SECRETS_MASTER_KEY`

- **Read by**: the encrypted secrets vault (`secretsVault.ts`).
- **Purpose**: overrides the AES-256-GCM master key used to encrypt runtime/provider credentials at rest. Accepts a 32-byte key as base64, 64 hex characters, or a literal 32-character string. An invalid value throws at use time; a wrong/rotated key makes the vault fail closed (returns null, never leaks plaintext).
- **Default**: auto-generated 32-byte key at `<CLAWBOO_HOME>/secrets/master.key` (mode `0600` inside a `0700` dir).

<Note>
`GATEWAY_AUTH_TOKEN` is the OpenClaw Gateway bearer token. Clawboo does not read it from `process.env` as its own config variable; it is resolved from OpenClaw's `~/.openclaw/.env` (or a `${GATEWAY_AUTH_TOKEN}` template token in `settings.json` / `openclaw.json`) by `@clawboo/config`. It is documented as a config concern in [Configuration](/reference/configuration#token-resolution-chain), not as a Clawboo environment variable.
</Note>

## Runtime provider keys

These are resolved through the credential chain `resolveRuntimeKey(envVar)`: `process.env[envVar]` → the encrypted vault → OpenClaw's `~/.openclaw/.env`. The variable name for each runtime comes from its [runtime descriptor](/runtimes/index) (`envVar` plus `altEnvVars`). Setting one in `process.env` is the highest-priority way to satisfy a runtime's credential check and is what makes a key visible to spawned subprocesses.

### `ANTHROPIC_API_KEY`

- **Read by**: `resolveRuntimeKey()` for the `claude-code` runtime (`envVar`) and the `clawboo-native` runtime (`envVar` / Anthropic provider).
- **Purpose**: the Anthropic provider key. Satisfies the Claude Code and Native (Anthropic) credential checks.
- **Default**: none.

### `OPENAI_API_KEY`

- **Read by**: `resolveRuntimeKey()` for the `clawboo-native` runtime (an `altEnvVar`) and the Native OpenAI provider (`envVarForProvider('openai')`).
- **Purpose**: the OpenAI provider key. Satisfies the Native (OpenAI) credential check.
- **Default**: none.

### `OPENROUTER_API_KEY`

- **Read by**: `resolveRuntimeKey()` for the `hermes` runtime (`envVar`) and the `clawboo-native` runtime (an `altEnvVar`).
- **Purpose**: the OpenRouter provider key. Satisfies the Hermes and Native (OpenRouter) credential checks.
- **Default**: none.

### Native OpenAI-compatible provider keys

The `clawboo-native` descriptor's `altEnvVars` is the whole `NATIVE_PROVIDER_ENV_VARS` list minus its primary `ANTHROPIC_API_KEY`, so seven further provider keys are read on the same terms as the three above. Each is resolved by `resolveRuntimeKey()`, on its own satisfies the Native runtime's credential check (`nativeKeyHealth()` iterates `envVar` plus `altEnvVars`), and selects that provider's OpenAI-compatible client when a routed call or fallback names it. Default for all seven: none.

| Variable           | Provider | OpenAI-compatible base URL                                |
| ------------------ | -------- | --------------------------------------------------------- |
| `GEMINI_API_KEY`   | Google   | `https://generativelanguage.googleapis.com/v1beta/openai` |
| `XAI_API_KEY`      | xAI      | `https://api.x.ai/v1`                                     |
| `GROQ_API_KEY`     | Groq     | `https://api.groq.com/openai/v1`                          |
| `MISTRAL_API_KEY`  | Mistral  | `https://api.mistral.ai/v1`                               |
| `TOGETHER_API_KEY` | Together | `https://api.together.xyz/v1`                             |
| `CEREBRAS_API_KEY` | Cerebras | `https://api.cerebras.ai/v1`                              |
| `MOONSHOT_API_KEY` | Moonshot | `https://api.moonshot.ai/v1`                              |

### `OLLAMA_BASE_URL`

- **Read by**: the Native runtime's OpenAI-compatible provider (`ollamaBaseUrl()`); also treated as a connection signal in `cliHealth` for runtimes that can route to Ollama.
- **Purpose**: overrides the base URL for a local Ollama server (keyless). Its presence also marks the Native runtime as connected even without a provider API key.
- **Default**: `http://localhost:11434/v1`.

<Note>
Codex authenticates via interactive ChatGPT OAuth (`codex login`), not a pasted key, so it has no provider-key environment variable (`envVar: null`). See [Codex runtime](/runtimes/codex).
</Note>

## Runtime tuning

### `CLAWBOO_REVIEWER_MODEL`

- **Read by**: the executor runner's verification step (`executorRunner.ts`).
- **Purpose**: lets the verification critic (the "judge" in the builder≠judge split) run on a different model than the builder. The verdict records the reviewer model so a same-model review's bias caveat stays visible.
- **Default**: the builder's own model (`input.model`).

## Logging

### `LOG_LEVEL`

- **Read by**: `@clawboo/logger` (`packages/logger/src/index.ts`).
- **Purpose**: sets the pino log level for the whole process. `debug` is deliberately not the default (too noisy for a shipped product). Read once at module-eval time behind a `typeof process` guard so the logger stays browser-safe.
- **Default**: `info`.

### `NODE_ENV`

- **Read by**: `@clawboo/logger` (transport selection).
- **Purpose**: when not `production`, the logger uses the `pino-pretty` colorized transport; in production it logs structured JSON. The CLI forks the bundled server with `NODE_ENV=production`.
- **Default**: none (treated as non-production → pretty transport).

## Operational tuning

These tune the always-on background services that run at server boot. Each is parsed as a positive number of milliseconds and falls back to its default on a missing or invalid value.

### `CLAWBOO_DB_WRITE_BUDGET_MS`

- **Read by**: the write-contention retry in `packages/db/src/board/contention.ts`.
- **Purpose**: the wall-clock budget for one outermost write's jittered lock retries. The retry sleep is synchronous (`Atomics.wait`), so in the server it blocks the event loop — this is what bounds how long a single contended write can freeze the process. Worst case is this budget plus one final `busy_timeout` (250 ms). A write that exhausts it throws `WriteBudgetExhaustedError`, which still carries `code = 'SQLITE_BUSY'`.
- **Default**: `1500` (1.5 seconds).

### `CLAWBOO_BOARD_STALE_TTL_MS`

- **Read by**: the board stale-task sweep in `apps/web/server/index.ts`.
- **Purpose**: the TTL after which an `in_progress` board task whose `updatedAt` predates the window (and whose execution is still running) is timed out and released to `todo`. `updatedAt` is a real liveness signal: every claiming drain heartbeats the task row every 30 seconds while it owns it, so the default is six missed beats. Lowering it below a few beat intervals will sweep live work. Raising it has a ceiling: the sweep is what publishes `task_released`, and that release is what detaches a stale session from a resident team orchestrator, so keep this TTL plus `CLAWBOO_BOARD_STALE_SWEEP_MS` under the engine's 8-minute idle watchdog (`DELEGATION_IDLE_TIMEOUT_MS`, a compile-time constant with no environment override). Past that window the watchdog reaches a phantom engine-driven delegation first, fails its task to `blocked` and cancels its dependent plan steps, which is the permanent stall the detach exists to prevent.
- **Default**: `180000` (3 minutes).

### `CLAWBOO_BOARD_STALE_SWEEP_MS`

- **Read by**: the board stale-task sweep in `apps/web/server/index.ts`.
- **Purpose**: the interval between stale-task sweeps. One pass also runs at boot. The timer is `.unref()`'d so it never holds the process open.
- **Default**: `60000` (60 seconds).

### `CLAWBOO_ENABLE_MOCK_RUNTIME`

- **Read by**: the runtime registry (`apps/web/server/lib/runtimes/descriptor.ts`).
- **Purpose**: set to exactly `1` to expose `clawboo-mock`, a fault-injecting runtime used to reproduce coordination failures (silence, a crash, an unresolved tool call, a slow start) through the real drain and executor paths. It executes nothing: every event it emits is synthesized from directives in the task text. Any other value, including other truthy-looking ones, leaves it hidden, so a normal install never lists it in the UI or in `GET /api/runtimes`.
- **Default**: unset (the runtime is absent).

### `CLAWBOO_DISPATCH_PUMP_MS`

- **Read by**: the board dispatch pump in `apps/web/server/index.ts`.
- **Purpose**: how often the pump scans for teams holding fireable delegation work or undelivered mailbox rows and wakes their orchestrator. The board lifecycle bus already pushes on every relevant mutation, so this interval is the durable BACKSTOP and the boot-resume path, not the primary trigger. The timer is `.unref()`'d.
- **Default**: `60000` (60 seconds).

### `CLAWBOO_HOME_MUTEX_ACQUIRE_MS`

- **Read by**: `homeDispatchMutex` in `apps/web/server/lib/executorRunner.ts`.
- **Purpose**: how long a run will WAIT for another run that shares its persistent identity home before giving up. It bounds the wait, never the run itself: a healthy queue always advances, so exceeding this means the current holder is wedged. Rejecting is what keeps one stuck run from freezing that agent's chat, 1:1 and schedules until restart.
- **Default**: `600000` (10 minutes).

### `CLAWBOO_MAX_FIX_CYCLES`

- **Read by**: `verifyMaxAttempts()` in `apps/web/server/lib/verification/index.ts`, the single reader, shared by the executor's re-dispatch loop and the exhaustion terminal in `worktrees.ts`. It counts FIX cycles, so the attempt budget is one more than it.
- **Purpose**: how many times a task whose verification FAILED is re-dispatched to the same runtime with the verdict attached before the fix loop is exhausted. Each cycle re-acquires the home mutex. Set to `0` to disable the fix loop (a single attempt). An exhausted loop routes the task to `blocked`, the needs-human terminal, and the delegator is told unconditionally.
- **Default**: `1`.

### `CLAWBOO_RUN_SILENT_TIMEOUT_MS`

- **Read by**: the drain idle guard (`withIdleTimeout`) in the executor runner and in the team orchestrator's `serverDeliver`.
- **Purpose**: how long a run may produce NO events before the drain stops waiting on it. This is a per-gap timeout, not a total run budget: a run that keeps emitting can work indefinitely. An open tool call extends the window, so a long-running tool is not mistaken for a dead stream.
- **Default**: `1800000` (30 minutes).

### `CLAWBOO_ROUTINE_DISPATCH_DEADLINE_MS`

- **Read by**: the routines ticker (`apps/web/server/lib/routines/ticker.ts`).
- **Purpose**: the ceiling on a single scheduled dispatch before the ticker stops awaiting it and moves on, so one wedged routine cannot stall the whole schedule.
- **Default**: `900000` (15 minutes).

### `CLAWBOO_APPROVAL_TTL_MS`

- **Read by**: the approval reaper (`approvalReaper.ts`).
- **Purpose**: the staleness window after which a forgotten `pending` tool-call approval is auto-expired (and any linked blocked task unblocked, unless a non-promotable verification verdict is what holds it `blocked`). Idempotent across passes.
- **Default**: `86400000` (24 hours).

### `CLAWBOO_APPROVAL_REAPER_INTERVAL_MS`

- **Read by**: the approval reaper (`approvalReaper.ts`).
- **Purpose**: the interval between reaper passes. One pass also runs at boot; the timer is `.unref()`'d.
- **Default**: `3600000` (1 hour).

### `CLAWBOO_MCP_PROBE_MS`

- **Read by**: the MCP liveness supervisor (`mcpSupervisor.ts`).
- **Purpose**: the interval between in-memory `tools/list` health probes of each hosted MCP server. On a failed probe the supervisor resets and re-warms the server with capped exponential backoff. The timer is `.unref()`'d.
- **Default**: `60000` (60 seconds).

### `CLAWBOO_ROUTINE_OPENCLAW_TIMEOUT_MS`

- **Read by**: the scheduled OpenClaw dispatch watchdog (`routines/openclawDispatch.ts`).
- **Purpose**: the watchdog window for a scheduled fire that targets an OpenClaw (connected-substrate) agent. If no terminal event arrives within the window, the dispatcher aborts and releases the task so it cannot leak as a perpetual `in_progress`.
- **Default**: `600000` (10 minutes).

## OpenTelemetry

The OTel export bridge is the only opt-in subsystem. Without these variables, the always-on local event log is the trace store and the OpenTelemetry SDK is never imported. When an endpoint is configured, the SDK is lazy-loaded and traces are exported via OTLP.

### `OTEL_EXPORTER_OTLP_ENDPOINT`

- **Read by**: `otlpConfigured()` in `apps/web/server/lib/obs/obsFlags.ts` (the bridge gate); the OTLP HTTP trace exporter then reads it for the endpoint.
- **Purpose**: when set (alone or with the traces-specific variant below), enables the OTel → OTLP bridge so traces export to a collector (Jaeger, Zipkin, etc.).
- **Default**: none (event-log-only; no external collector required).

### `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT`

- **Read by**: `otlpConfigured()` in `apps/web/server/lib/obs/obsFlags.ts`; the OTLP HTTP trace exporter.
- **Purpose**: the traces-specific OTLP endpoint. Either this or `OTEL_EXPORTER_OTLP_ENDPOINT` being set enables the bridge.
- **Default**: none.

### `OTEL_SERVICE_NAME`

- **Read by**: the OTel SDK initialization in `apps/web/server/lib/obs/otel.ts`.
- **Purpose**: the OpenTelemetry resource service name attached to exported traces.
- **Default**: `clawboo`.

## See also

- [Configuration reference](/reference/configuration): `settings.json` schema, state directory, and the OpenClaw token-resolution chain
- [CLI reference](/reference/cli): `clawboo` and the MCP stdio bins
- [Connecting runtimes](/runtimes/connecting-runtimes): install, connect, and the encrypted credential vault
- [Security](/operating/security): access gate, loopback binding, vault, and redaction
- [Deployment](/operating/deployment): ports, fallback, state directory, and the bundled server
- [Observability](/concepts/observability): the event log and the OTel bridge
