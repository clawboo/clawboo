---
title: System API
description: 'REST reference for /api/system/*: OpenClaw status, install, configure, gateway lifecycle, config, device pairing, models, plus Clawboo self-version and self-update.'
---

REST surface for the host itself. Most of it is the OpenClaw side: detect what is installed, install the OpenClaw CLI, write its config, control the Gateway process, read or patch `openclaw.json`, approve a device-pairing request, and list the model catalog. These routes are how the onboarding wizard and the System maintenance panel drive OpenClaw from the dashboard. The last two, `self-version` and `self-update`, are about **Clawboo itself** rather than OpenClaw: which release this server is running, and applying a newer one.

<Note>
Everything here except the two `self-*` routes is OpenClaw-specific. OpenClaw is a connected substrate driven over a Gateway process this server manages, so its lifecycle lives here, not under [`/api/runtimes`](/reference/rest-api/runtimes), which covers the four CLI/SDK runtimes you install and key. The agent registry is at [Agents API](/reference/rest-api/agents).
</Note>

Three of these routes stream **Server-Sent Events** rather than returning a JSON body: `POST /api/system/install-openclaw` and `POST /api/system/self-update` always, and `POST /api/system/gateway` for the `start` and `restart` actions. Each is documented below with an event-stream catalog (event `type` → payload), not a response body. All POST/PATCH routes read a JSON body parsed by `express.json({ limit: '2mb' })`.

<Info>
Every child process this group spawns (`openclaw`, `npm`) is launched with `shell: isWindows` + `windowsHide: isWindows`. On Windows the OpenClaw/npm binaries resolve to `.cmd` shims, which Node 18.20.2+ / 20.12.2+ / 22+ refuse to spawn without `shell: true` (the CVE-2024-27980 fix); the option is a no-op on Unix, and `windowsHide` suppresses the `cmd.exe` console window that would otherwise flash over the dashboard.
</Info>

## Routes

| Method | Path                                  | Summary                                                             | Stream?                   |
| ------ | ------------------------------------- | ------------------------------------------------------------------- | ------------------------- |
| GET    | `/api/system/status`                  | Node / OpenClaw / Gateway status snapshot                           | No                        |
| POST   | `/api/system/install-openclaw`        | Install the OpenClaw CLI via `npm install -g`                       | SSE                       |
| POST   | `/api/system/configure-openclaw`      | Write `openclaw.json` + `.env`, mint a Gateway token                | No                        |
| POST   | `/api/system/auto-configure-openclaw` | Provision OpenClaw from an already-connected credential (no prompt) | No                        |
| POST   | `/api/system/gateway`                 | Gateway lifecycle: `start` / `stop` / `restart` / `status`          | SSE for `start`/`restart` |
| GET    | `/api/system/openclaw-config`         | Read `openclaw.json` + provider-key flags                           | No                        |
| PATCH  | `/api/system/openclaw-config`         | Read-modify-write `openclaw.json` (model, port, keys, exec, a2a)    | No                        |
| POST   | `/api/system/approve-device`          | Approve the latest pending device-pairing request                   | No                        |
| GET    | `/api/system/models`                  | Model catalog (CLI-backed, falls back to static)                    | No                        |
| GET    | `/api/system/self-version`            | Which Clawboo this server is, and whether a newer one exists        | No                        |
| POST   | `/api/system/self-update`             | Install `clawboo@latest` globally, then restart into it             | SSE                       |

---

## `GET /api/system/status`

Returns a single snapshot: the Node runtime, OpenClaw install detection, and Gateway process state. The onboarding wizard polls this to decide which step to show; the System Health and maintenance panels poll it for the running/stopped dot. When the Gateway is running and a `.env` exists, this call also opportunistically syncs the Gateway auth token from `.env` into Clawboo's settings (so the proxy never holds a stale token).

OpenClaw detection is async, cached per resolved binary path, and bounded by a 6-second timeout; a cold-start `openclaw --version` can never freeze the single-threaded server. `installed` reflects whether the binary resolves on `PATH`; `version` is `null` if the probe timed out or failed (the binary is still reported installed).

- **Path/query params**: none.
- **Request body**: none.

### Responses

**`200 OK`**: the status snapshot:

```ts
{
  node: {
    version: string // process.version, e.g. "v22.3.0"
    major: number // parsed major version
    sufficient: boolean // major >= 22
    path: string // process.execPath
  }
  openclaw: {
    installed: boolean
    version: string | null // null when the version probe timed out / failed
    path: string | null // resolved binary path, or null when not installed
    stateDir: string // resolved OpenClaw state dir (~/.openclaw)
    configExists: boolean // openclaw.json present
    envExists: boolean // .env present
  }
  gateway: {
    running: boolean // PID alive OR port reachable
    port: number // PID-file port → openclaw.json gateway.port → 18789
    pid: number | null // null unless a Clawboo-managed PID is alive
    managedByClawboo: boolean // a live PID file written by this server
    uptimeMs: number | null // since the managed start, else null
  }
}
```

**`500 Internal Server Error`**: any failure assembling the snapshot:

```json
{ "error": "<message>" }
```

### Example

```bash
curl http://localhost:18790/api/system/status
```

---

## `POST /api/system/install-openclaw`

Installs the OpenClaw CLI by running `npm install -g openclaw@^2026.5`. The version is pinned to `^2026.5` (not `@latest`) so a new install gets an OpenClaw whose WS connect protocol matches the bundled `gateway-client` (`maxProtocol: 4`); a future protocol bump would otherwise break the connection silently. On success the OpenClaw version cache is invalidated and re-read.

- **Path/query params**: none.
- **Request body**: none.

### Responses

**`200 OK` + `text/event-stream`**: the handler sets `Content-Type: text/event-stream`, `Cache-Control: no-cache`, `Connection: keep-alive`, flushes headers, and streams SSE frames. Each frame is `data: <json>\n\n`. The child process is killed if the client closes the connection.

#### Event catalog

| `type`     | When                                                          | Payload fields                  |
| ---------- | ------------------------------------------------------------- | ------------------------------- |
| `progress` | Install start                                                 | `step: 'installing'`, `message` |
| `output`   | Per non-empty stdout/stderr line                              | `line`                          |
| `error`    | EACCES detected, spawn throws, child errors, or non-zero exit | `code`, `message`               |
| `complete` | Process exits 0                                               | `success: true`, `version`      |

Terminal `error` `code` values:

| `code`        | Meaning                                                                                       |
| ------------- | --------------------------------------------------------------------------------------------- |
| `EACCES`      | stderr matched `EACCES` / "permission denied" (a global install needing elevated permissions) |
| `SPAWN_THROW` | The `spawn` call threw synchronously                                                          |
| `SPAWN_ERROR` | The child emitted an `error` event                                                            |
| `EXIT_<code>` | Non-zero process exit (e.g. `EXIT_1`)                                                         |

On a clean exit the `complete` frame carries the freshly-detected version (`'unknown'` if the post-install version probe could not read it).

Example frames:

```text
data: {"type":"progress","step":"installing","message":"Installing OpenClaw..."}

data: {"type":"output","line":"added 1 package in 4s"}

data: {"type":"complete","success":true,"version":"2026.5.27"}
```

<Note>
The EACCES `error` frame is informational; it is emitted when stderr matches the pattern, but the stream still continues and the install's final outcome is decided by the process exit code (`complete` on 0, `EXIT_<code>` otherwise).
</Note>

### Example

```bash
curl -N -X POST http://localhost:18790/api/system/install-openclaw
```

---

## `POST /api/system/configure-openclaw`

Writes a minimal `openclaw.json` and `.env` for a chosen provider, mints a fresh Gateway auth token, and saves the resulting `gatewayUrl` + token into Clawboo's settings. The written `openclaw.json` sets `gateway.mode: 'local'`, the agent default model, and turns on agent-to-agent coordination (`tools.agentToAgent.enabled: true`, `tools.sessions.visibility: 'all'`). The raw token is persisted server-side only; it is never returned in the body (the same-origin proxy injects it on connect). This is the route that _prompts_ for a key: the onboarding wizard's configure step posts straight here, always asking for a provider and (except for keyless providers) a key. The inline OpenClaw setup rendered in the Settings Runtimes panel and the wizard's add-runtimes step does not use this route at all; it posts the no-prompt [`auto-configure-openclaw`](#post-apisystemauto-configure-openclaw) on mount, and when that answers `needsKey` it saves the pasted key through `POST /api/providers/:id/connect` and retries auto-configure.

- **Path/query params**: none.
- **Request body**:

```ts
{
  provider: string       // required (e.g. 'anthropic', 'openai', 'ollama', ...)
  apiKey?: string        // required for every provider except 'ollama'
  model?: string         // optional model override; else a per-provider default
  gatewayPort?: number   // optional; default 18789
}
```

When `model` is omitted, the handler picks a per-provider default from its `MODEL_MAP` (e.g. `anthropic` → `anthropic/claude-sonnet-4-5`, `openai` → `openai/gpt-5.4`, `ollama` → `ollama/llama3.2`); an unmapped provider falls back to `<provider>/<model ?? 'default'>`. The provider's key is written to `.env` under the canonical env var name (e.g. `anthropic` → `ANTHROPIC_API_KEY`, `google` → `GEMINI_API_KEY`, `huggingface` → `HF_TOKEN`); a non-`ollama` provider with no name mapping falls back to `CUSTOM_API_KEY`.

### Responses

**`400 Bad Request`**: body is missing or not an object:

```json
{ "error": "JSON body required" }
```

**`400 Bad Request`**: `provider` is missing or empty:

```json
{ "error": "provider is required" }
```

**`400 Bad Request`**: a non-`ollama` provider with a missing or empty `apiKey`:

```json
{ "error": "apiKey is required for non-ollama providers" }
```

**`200 OK`**: config + `.env` written, token minted, settings saved:

```ts
{ ok: true, gatewayUrl: string }   // gatewayUrl is `ws://localhost:<port>`
```

**`500 Internal Server Error`**: a filesystem or token-generation failure:

```json
{ "error": "<message>" }
```

### Example

```bash
curl -X POST http://localhost:18790/api/system/configure-openclaw \
  -H 'Content-Type: application/json' \
  -d '{"provider":"anthropic","apiKey":"sk-ant-...","gatewayPort":18789}'
```

---

## `POST /api/system/auto-configure-openclaw`

The no-prompt counterpart to [`configure-openclaw`](#post-apisystemconfigure-openclaw): it provisions OpenClaw from a credential you have **already** connected, so the OpenClaw setup flow never re-asks for a key. The SPA's inline OpenClaw setup calls this first and only falls back to the key prompt when this route reports it has nothing to work with.

- **Path/query params**: none.
- **Request body**: none (the handler ignores the request entirely).

It resolves a credential in four rungs, in order, and stops at the first that matches:

| Rung | Condition                                                           | Outcome                                                                                               |
| ---- | ------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| 1    | A connected provider key (encrypted vault **or** OpenClaw's `.env`) | Key upserted into `.env` + every agent's `auth-profiles.json`, config written → `{ ok: true, ... }`   |
| 2    | No key, but OpenClaw already holds an `openai-codex` OAuth profile  | Config writes only, **no** key write (the credential is OpenClaw's own profile) → `{ ok: true, ... }` |
| 3    | No such profile, but the `codex` CLI is logged in                   | `{ ok: false, needsCodexAuth: true, loginCommand }`, so the UI offers a ChatGPT sign-in + a re-check  |
| 4    | Nothing connected                                                   | `{ ok: false, needsKey: true }`, so the UI falls back to the key prompt                               |

Rung 3 exists because a `codex login` in your terminal is a subscription OpenClaw cannot use until it holds a profile of its own; `loginCommand` is `openclaw models auth login --provider openai-codex`. The dashboard runs it for you over
`POST /api/auth/cli-login/openclaw`, and surfaces the raw command only if that fails.

### Responses

**`200 OK` (rungs 1 and 2)**: `openclaw.json` was written and the Gateway URL + token saved into Clawboo's settings. `provider` is the id that satisfied the rung (`'openai-codex'` for rung 2):

```ts
{ ok: true, gatewayUrl: string, provider: string }   // gatewayUrl is `ws://localhost:18789`
```

**`200 OK` (rungs 3 and 4)**: nothing was written; the body tells the caller which prompt to show:

```ts
{ ok: false, needsCodexAuth: true, loginCommand: string }
// or
{ ok: false, needsKey: true }
```

**`500 Internal Server Error`**: a filesystem or token-generation failure:

```json
{ "error": "<message>" }
```

<Note>
Both writes are non-destructive read-modify-writes, which is what makes this safe to call on an existing install. The Gateway token is **reused** from `~/.openclaw/.env` when `GATEWAY_AUTH_TOKEN` is already set; a fresh one is minted only when it is absent. In `openclaw.json` only `gateway.mode` is forced (to `'local'`); `gateway.port`, `gateway.auth`, the default model, `tools.agentToAgent` and `tools.sessions` are filled in **only when missing**, so fields you set by hand survive. Unlike `configure-openclaw`, there is no `gatewayPort` input: the port defaults to `18789` and an existing numeric `gateway.port` is left alone.
</Note>

### Example

```bash
curl -X POST http://localhost:18790/api/system/auto-configure-openclaw
```

---

## `POST /api/system/gateway`

Drives the Gateway process lifecycle. The `action` field selects the operation. `status` and `stop` return JSON; `start` and `restart` stream SSE (because they poll for the port to bind and emit progress). The default port is resolved from the PID file, then `openclaw.json`'s `gateway.port`, then `18789`.

- **Path/query params**: none.
- **Request body**:

```ts
{
  action: 'start' | 'stop' | 'restart' | 'status'
}
```

### Responses

**`400 Bad Request`**: body is missing or not an object:

```json
{ "error": "JSON body required" }
```

**`400 Bad Request`**: `action` is not one of the four values:

```json
{ "error": "action must be 'start', 'stop', 'restart', or 'status'" }
```

**`200 OK` (`action: 'status'`)**: current process state (a stale PID file is cleaned up as a side effect):

```ts
{
  running: boolean // PID alive OR port reachable
  pid: number | null // null unless a managed PID is alive
  port: number
  uptimeMs: number | null
}
```

**`200 OK` (`action: 'stop'`)**: the stop result. `stopped` is `true` when a process was signalled (SIGTERM, then SIGKILL after a 2-second grace), `false` when none was found:

```ts
{ ok: true, stopped: true }
// or, when no gateway process was found:
{ ok: false, message: 'No gateway process found' }
```

**`200 OK` + `text/event-stream` (`action: 'start'` or `'restart'`)**: the handler sets the SSE headers, flushes, and streams frames. For `restart` it first stops the running process. A detached child is spawned; it is **not** killed when the client disconnects (the Gateway is meant to outlive the request).

#### Event catalog (`start` / `restart`)

| `type`     | When                                                                             | Payload fields                                                  |
| ---------- | -------------------------------------------------------------------------------- | --------------------------------------------------------------- |
| `progress` | `restart` stop phase                                                             | `step: 'stopping'`, `message`                                   |
| `progress` | Spawn start, or joining an in-flight launch                                      | `step: 'starting'`, `message`                                   |
| `progress` | Each poll while waiting for the port to bind                                     | `step: 'waiting'`, `message` (`Waiting for gateway... (n/120)`) |
| `output`   | Per non-empty stdout/stderr line from the Gateway                                | `line`                                                          |
| `complete` | Port became reachable, or already running                                        | `success: true`, `pid` (or `port` / `message`)                  |
| `error`    | OpenClaw missing, spawn throws/errors, internal throw, or the 60s poll times out | `code`, `message`                                               |

Terminal `error` `code` values:

| `code`          | Meaning                                                           |
| --------------- | ----------------------------------------------------------------- |
| `NOT_INSTALLED` | OpenClaw binary not found                                         |
| `SPAWN_THROW`   | The `spawn` call threw synchronously                              |
| `SPAWN_ERROR`   | The child emitted an `error` event                                |
| `TIMEOUT`       | The port did not become reachable within ~60s (120 × 500ms polls) |
| `INTERNAL`      | An unexpected throw after the SSE headers were sent               |

When the port becomes reachable, the handler syncs the `.env` token into settings and best-effort reconnects the server-side AgentSource before emitting `complete`. A `start` that finds the port already reachable emits `complete` immediately with `message: 'Gateway already running'`; a `start` that finds an alive-but-not-yet-bound managed PID joins that in-flight launch instead of spawning a duplicate.

Example frames:

```text
data: {"type":"progress","step":"starting","message":"Starting gateway on port 18789..."}

data: {"type":"progress","step":"waiting","message":"Waiting for gateway... (3/120)"}

data: {"type":"complete","success":true,"pid":48211,"port":18789}
```

### Example

```bash
# Stop (JSON)
curl -X POST http://localhost:18790/api/system/gateway \
  -H 'Content-Type: application/json' \
  -d '{"action":"stop"}'

# Start (SSE)
curl -N -X POST http://localhost:18790/api/system/gateway \
  -H 'Content-Type: application/json' \
  -d '{"action":"start"}'
```

---

## `GET /api/system/openclaw-config`

Reads `openclaw.json` and the provider-key flags derived from `.env` and per-agent `auth-profiles.json` files. The flags report key presence only; no key values are returned. The exec policy (`tools.exec.ask` / `tools.exec.security`) is surfaced for easy client consumption.

- **Path/query params**: none.
- **Request body**: none.

### Responses

**`200 OK`**: the config and derived flags:

```ts
{
  config: Record<string, unknown> | null // parsed openclaw.json, or null if missing/corrupt
  env: {
    hasAnthropicKey: boolean
    hasOpenAIKey: boolean
    hasGoogleKey: boolean
    hasOpenRouterKey: boolean
    hasXaiKey: boolean
    hasGroqKey: boolean
    hasMistralKey: boolean
    hasMoonshotKey: boolean
    hasMiniMaxKey: boolean
    hasTogetherKey: boolean
    hasNvidiaKey: boolean
    hasHuggingFaceKey: boolean
    hasCerebrasKey: boolean
    hasVeniceKey: boolean
    hasGatewayToken: boolean
  }
  version: string | null // OpenClaw version (null if probe failed)
  execAsk: unknown | null // tools.exec.ask from openclaw.json
  execSecurity: unknown | null // tools.exec.security
}
```

A provider flag is `true` when its env var is set in `.env` **or** a matching `auth-profiles.json` entry exists. (`hasGoogleKey` matches `GEMINI_API_KEY` or `GOOGLE_API_KEY`; `hasHuggingFaceKey` matches `HF_TOKEN` or `HUGGINGFACE_HUB_TOKEN`.)

**`500 Internal Server Error`**: a read failure:

```json
{ "error": "<message>" }
```

### Example

```bash
curl http://localhost:18790/api/system/openclaw-config
```

---

## `PATCH /api/system/openclaw-config`

Read-modify-writes `openclaw.json` and, when keys are supplied, `.env` plus every agent's `auth-profiles.json`. Every field is optional; only the supplied parts are touched. A missing or corrupt `openclaw.json` is treated as an empty object (started fresh).

- **Path/query params**: none.
- **Request body**: all fields optional:

```ts
{
  model?: string        // → agents.defaults.model.primary
  fallbacks?: string[]  // → agents.defaults.model.fallbacks (non-strings filtered out)
  gatewayPort?: number  // → gateway.port (and Clawboo settings gatewayUrl)
  apiKeys?: Array<{ provider: string; key: string }>  // → .env + auth-profiles.json
  agentModel?: { agentId: string; model: string | null }  // per-agent override in agents.list[]
  exec?: { ask?: string; security?: string }  // → tools.exec.*
  agentToAgent?: { enabled: boolean }  // → tools.agentToAgent.enabled (and sessions.visibility on enable)
}
```

Notes on behavior: `agentModel.model === null | ''` removes the per-agent override (and prunes the `agents.list[]` entry if only `id` remains). Enabling `agentToAgent` also sets `tools.sessions.visibility: 'all'`. An `apiKeys` entry whose `provider` has no canonical mapping is written under `<PROVIDER>_API_KEY`. When `gatewayPort` changes, the Clawboo settings `gatewayUrl` is updated to `ws://localhost:<port>`.

### Responses

**`400 Bad Request`**: body is missing or not an object:

```json
{ "error": "JSON body required" }
```

**`200 OK`**: the config (and `.env` / profiles) was written. `hotReloadHint` is present only when the Gateway is currently reachable (the client should hot-reload its config):

```ts
{ ok: true }
// or, when the gateway is running:
{ ok: true, hotReloadHint: true }
```

**`500 Internal Server Error`**: a filesystem failure:

```json
{ "error": "<message>" }
```

### Example

```bash
curl -X PATCH http://localhost:18790/api/system/openclaw-config \
  -H 'Content-Type: application/json' \
  -d '{"model":"anthropic/claude-sonnet-4-5","agentToAgent":{"enabled":true}}'
```

---

## `POST /api/system/approve-device`

Approves the most-recently pending OpenClaw device-pairing request. Required since OpenClaw 2026.5.x dropped auto-pair-on-first-connect: a fresh device sits pending until a human approves it, and an unapproved device's WS connect fails with `NOT_PAIRED` ("pairing required: device is not approved yet"). This endpoint is the in-product remediation the SPA's pairing dialog calls.

It is a two-step shell-out. Step 1 runs `openclaw devices approve --latest`, which on 2026.5.x is a **preview**; it prints the pending request UUID (in a line like `Approve this exact request with: openclaw devices approve <UUID>`) and exits non-zero. The handler regex-extracts the UUID from the combined stdout/stderr. Step 2 runs `openclaw devices approve <UUID>` to actually approve it.

- **Path/query params**: none.
- **Request body**: none.

### Responses

**`400 Bad Request`**: OpenClaw is not installed:

```json
{ "error": "OpenClaw not installed" }
```

**`500 Internal Server Error`**: the step-1 preview process failed to spawn (ENOENT, timeout, etc.):

```json
{ "error": "Failed to run openclaw: <message>" }
```

**`404 Not Found`**: no pending request UUID was found in the preview output:

```json
{ "error": "No pending device pairing requests found", "details": "<truncated output>" }
```

**`200 OK`**: the device was approved:

```ts
{ ok: true, requestId: string, output: string }
```

**`500 Internal Server Error`**: step 2 (the real approval) failed; the cleaned stderr/stdout message is surfaced:

```json
{ "error": "Failed to approve device: <message>", "requestId": "<uuid>" }
```

<Warning>
The pending-UUID parse depends on OpenClaw's CLI output wording (`/openclaw devices approve\s+([a-f0-9-]{36})/i`). If a future OpenClaw release changes that line, this route returns 404 and the SPA's pairing dialog falls back to showing the manual `openclaw devices approve <id>` command.
</Warning>

### Example

```bash
curl -X POST http://localhost:18790/api/system/approve-device
```

---

## `GET /api/system/models`

Returns the model catalog used by the model pickers. The catalog is read from `openclaw models list --all --json` (cached 5 minutes); when the CLI is unavailable it falls back to the static catalog. Either way the result is filtered to known providers plus `ollama`, and CLI provider names are normalized to the static catalog's display casing. `configuredProviders` lists the providers that have a key configured (in `.env` or `auth-profiles.json`), always including `ollama`.

- **Path/query params**: none.
- **Request body**: none.

### Responses

**`200 OK`**: the grouped catalog. `groups` is `null` only when both the CLI and static catalog yield nothing:

```ts
{
  groups: Array<{
    provider: string
    models: Array<{ id: string; label: string }>
  }> | null
  configuredProviders: string[]   // provider ids with a key (always includes 'ollama')
}
```

<Note>
This route never returns an error status. Any failure is caught and answered with `{ groups: null, configuredProviders: [] }` (HTTP 200), so the picker degrades gracefully rather than erroring.
</Note>

### Example

```bash
curl http://localhost:18790/api/system/models
```

---

## `GET /api/system/self-version`

Which Clawboo this server is running, how it was installed, and whether a newer release is published. Backs the dashboard's "update available" chip and the `clawboo` launcher's [version-aware attach](/reference/cli#what-clawboo-does).

### Query parameters

| Param   | Values | Effect                                                                                                                    |
| ------- | ------ | ------------------------------------------------------------------------------------------------------------------------- |
| `local` | `1`    | Skip the npm-registry probe. `latest` and `checkedAt` come back `null` and `updateAvailable` `false`, i.e. "not checked". |

`?local=1` exists for the CLI. The launcher reads this route on every attach purely to compare the running server against its own version, and never needs `latest`; the registry probe is capped at 5 s and deliberately does not cache failures, so without the opt-out an offline machine would pay that on every launch. Servers that predate the parameter ignore it and return the full payload, which the launcher also accepts.

### Responses

`200` always. Every failure is absorbed: an unreachable registry is a `null` latest, never an error status.

| Field             | Type                         | Notes                                                                                                                  |
| ----------------- | ---------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| `current`         | `string`                     | The running version. `CLAWBOO_VERSION` if set (the CLI injects it), else the shipped `package.json`, else `0.0.0-dev`. |
| `latest`          | `string \| null`             | npm's `latest` for `clawboo`. `null` when unreachable or skipped. Cached ~6 h.                                         |
| `updateAvailable` | `boolean`                    | True only for a real (non-`0.0.0*`) `current` with a strictly greater `latest`.                                        |
| `updateCommand`   | `string`                     | `npx clawboo@latest` for an npx run, `npm install -g clawboo@latest` otherwise.                                        |
| `installMethod`   | `'global' \| 'npx' \| 'dev'` | Derived from the running entry path.                                                                                   |
| `applyable`       | `boolean`                    | Whether `POST /api/system/self-update` can succeed here, i.e. `installMethod === 'global'`.                            |
| `isDeprecated`    | `boolean`                    | `current` is on the npm-deprecated `0.1.x` line.                                                                       |
| `checkedAt`       | `number \| null`             | Epoch ms of the last registry fetch, `null` when `latest` is `null`.                                                   |

<Note>
A dev checkout reports `current: "0.0.0-dev"` and is never told an update is available. Both the chip and the CLI treat a `0.0.0*` version as "don't nag" — and the launcher additionally refuses to offer to restart such a server, so a contributor's `pnpm dev` process is never a target.
</Note>

### Example

```bash
# Full payload, including the registry check
curl http://localhost:18790/api/system/self-version

# Just this server's identity, no outbound network call
curl 'http://localhost:18790/api/system/self-version?local=1'
```

---

## `POST /api/system/self-update`

Installs `clawboo@latest` globally and restarts the server into it. Streams **Server-Sent Events**; takes no request body.

Only a `global` install can succeed: an `npx` run lives in npm's version-hashed `_npx` cache, so a global install lands somewhere the running process cannot reach, and a dev checkout must never self-update. Both get an `unsupported` event and the copy-paste command instead. That is defense in depth; the chip already hides its button in those cases.

### Event stream

| `type`                | When                                                                            | Payload fields                  |
| --------------------- | ------------------------------------------------------------------------------- | ------------------------------- |
| `unsupported`         | `installMethod` is not `global`                                                 | `method`, `command`, `message`  |
| `progress`            | Install start                                                                   | `step: 'installing'`, `message` |
| `output`              | Per non-empty stdout/stderr line from npm                                       | `line`                          |
| `error`               | EACCES detected, spawn throws, child errors, or a non-zero exit                 | `code`, `message`               |
| `installed-elsewhere` | npm exited 0 but the on-disk version did not change, or the API port is unknown | `version`, `message`            |
| `installed`           | npm exited 0 and the on-disk version changed                                    | `version`                       |
| `restarting`          | Immediately before the successor is launched                                    | `port`, `version`               |

| `code`        | Meaning                                                         |
| ------------- | --------------------------------------------------------------- |
| `EACCES`      | stderr matched `EACCES` / "permission denied" — needs elevation |
| `SPAWN_THROW` | The `spawn` call threw synchronously                            |
| `SPAWN_ERROR` | The child emitted an `error` event                              |
| `EXIT_<code>` | Non-zero npm exit (e.g. `EXIT_1`)                               |

After `restarting`, the server launches a successor pinned to the same port (`CLAWBOO_API_PORT`) and told to wait for that port to free (`CLAWBOO_AWAIT_PORT`), then exits so the successor can bind. The successor is started with `CLAWBOO_VERSION` deliberately **removed** so it recomputes its version from the freshly-installed manifest rather than inheriting the pre-update value. The browser is already polling the same origin and reloads once the successor answers.

<Note>
The `installed-elsewhere` event is the guard against a hot-swap into stale bytes: if the global install landed somewhere this running copy does not point at, restarting would just re-run the old code, so the server stays up and asks you to restart manually instead.
</Note>

The equivalent from a terminal, which works for every install shape, is `npm install -g clawboo@latest && clawboo restart` — see the [CLI reference](/reference/cli#clawboo-restart).

### Example

```bash
curl -N -X POST http://localhost:18790/api/system/self-update
```

---

## Error envelope

Every error response on these routes is the standard envelope `{ error: string }`. Two routes attach extra fields alongside it: `approve-device` adds `details` (on the 404) and `requestId` (on the step-2 500). `GET /api/system/models` is the only route here that never returns an error status; it falls back to a `200` with a `null` catalog.

## See also

- [OpenClaw runtime: Gateway, device pairing, channels](/runtimes/openclaw)
- [System maintenance (Gateway control, model, API keys)](/using/system-maintenance)
- [System Health panel](/using/system-health), the boot-probe surface at [`/api/health`](/reference/rest-api/settings)
- [Settings API](/reference/rest-api/settings), `gatewayUrl` + `hasToken`, the proxy token this group mints
- [Runtimes API](/reference/rest-api/runtimes), the four CLI/SDK runtimes (OpenClaw is not in that group)
- [REST API overview](/reference/rest-api/index)
