---
title: 'System API'
description: 'REST reference for /api/system: OpenClaw status, install, setup, Gateway control, config, device pairing and models, plus Clawboo version and self-update.'
keywords:
  [
    'openclaw',
    'gateway',
    'configure-openclaw',
    'auto-configure-openclaw',
    'device pairing',
    'self-update',
    'openclaw.json',
  ]
---

Use these routes to manage the host itself. Most of them drive OpenClaw: detect what is installed, install the OpenClaw CLI, write its config, control the Gateway process, read or patch `openclaw.json`, approve a device-pairing request, and list the model catalog. The dashboard's OpenClaw setup and **Manage** section in **Settings > Runtimes**, the **System** panel and the update chip call them. The last two routes, `self-version` and `self-update`, are about Clawboo itself: which release this server runs, and installing a newer one.

<Note>

Every route here except the two `self-*` routes is for OpenClaw. OpenClaw runs as its own Gateway process that Clawboo starts and talks to, so its lifecycle lives here. [`/api/runtimes`](/reference/rest-api/runtimes) covers Clawboo Native (built in), Claude Code, Codex and Hermes, and the agent registry is in the [Agents API](/reference/rest-api/agents).

</Note>

Three routes stream **Server-Sent Events** instead of returning a JSON body: `POST /api/system/install-openclaw` and `POST /api/system/self-update` always, and `POST /api/system/gateway` for `start` and `restart`. Each is documented with an event catalog (event `type` and payload). Request bodies are JSON (up to 2 MB). Every route counts against the general [rate limit](/reference/rest-api/index#rate-limits) of 3,000 requests a minute per client address; routes marked **sensitive** also count against a limit of 60 a minute. The `curl` examples assume the access gate is off; with `STUDIO_ACCESS_TOKEN` set, add `-b 'clawboo_access=<token>'` (see [Authentication](/reference/rest-api/index#authentication)).

## Routes

| Method | Path                                  | Summary                                                        | Rate tier | Stream?                   |
| ------ | ------------------------------------- | -------------------------------------------------------------- | --------- | ------------------------- |
| GET    | `/api/system/status`                  | Node, OpenClaw and Gateway status                              | general   | No                        |
| POST   | `/api/system/install-openclaw`        | Install the OpenClaw CLI with `npm install -g`                 | sensitive | SSE                       |
| POST   | `/api/system/configure-openclaw`      | Replace `openclaw.json` and `.env` for one provider (API only) | sensitive | No                        |
| POST   | `/api/system/auto-configure-openclaw` | Set up OpenClaw from a credential you already connected        | sensitive | No                        |
| POST   | `/api/system/gateway`                 | Gateway control: `start`, `stop`, `restart`, `status`          | sensitive | SSE for `start`/`restart` |
| GET    | `/api/system/openclaw-config`         | Read `openclaw.json`, key flags and the ChatGPT sign-in state  | general   | No                        |
| PATCH  | `/api/system/openclaw-config`         | Change parts of `openclaw.json` (model, port, keys, exec, a2a) | sensitive | No                        |
| POST   | `/api/system/approve-device`          | Approve the latest pending device-pairing request              | sensitive | No                        |
| GET    | `/api/system/models`                  | Model catalog (from the OpenClaw CLI, else the built-in list)  | general   | No                        |
| GET    | `/api/system/self-version`            | Which Clawboo this server runs, and whether a newer one exists | general   | No                        |
| POST   | `/api/system/self-update`             | Install `clawboo@latest` globally, then restart into it        | sensitive | SSE                       |

---

## `GET /api/system/status`

Returns one snapshot of the Node runtime, the OpenClaw install and the Gateway process. The dashboard reads it at startup to decide what to show, and the OpenClaw setup and the **System** panel read it for the Gateway's state. When the Gateway is running and `.env` exists, the call also copies the Gateway token from `.env` into Clawboo's settings, so Clawboo never connects with a stale token.

The OpenClaw check is cached per binary path and gives up on `openclaw --version` after 6 seconds, so a slow first start never holds up the server. `installed` says whether the binary resolves on `PATH`; `version` is `null` when the version check timed out or failed (the binary still reads installed).

- **Path/query params**: none.
- **Request body**: none.

### Responses

**`200 OK`**: the status snapshot:

```ts
{
  node: {
    version: string // process.version, e.g. "v22.3.0"
    major: number // parsed major version
    sufficient: boolean // whether this Node satisfies OpenClaw's engines, NOT a bare major check
    required: string // the range OpenClaw requires, e.g. ">=24.22.1 <25 || >=26.12.1"
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

Installs the OpenClaw CLI by running `npm install -g openclaw@~2026.9`. The pin is `~2026.9` (not `@latest`, and not `^2026.9`, which would allow any 2026.x) so a new install gets an OpenClaw whose config format matches what Clawboo writes. On success the installed version is read again and reported.

- **Path/query params**: none.
- **Request body**: none.

### Responses

**`200 OK` + `text/event-stream`**: the stream sends `data: <json>\n\n` frames with `Cache-Control: no-cache`. The install process is killed if the client closes the connection.

#### Event catalog

| `type`     | When                                                 | Payload fields                  |
| ---------- | ---------------------------------------------------- | ------------------------------- |
| `progress` | Install start                                        | `step: 'installing'`, `message` |
| `output`   | Each non-empty stdout or stderr line                 | `line`                          |
| `error`    | Permission denied, spawn failure, or a non-zero exit | `code`, `message`               |
| `complete` | Process exits 0                                      | `success: true`, `version`      |

The `error` codes:

| `code`        | Meaning                                                                                  |
| ------------- | ---------------------------------------------------------------------------------------- |
| `EACCES`      | stderr mentioned `EACCES` or "permission denied" (a global install that needs elevation) |
| `SPAWN_THROW` | The spawn call threw                                                                     |
| `SPAWN_ERROR` | The child process emitted an error                                                       |
| `EXIT_<code>` | The process exited with a non-zero code (for example `EXIT_1`)                           |

On a clean exit, `complete` carries the newly installed version (`'unknown'` when the version check could not read it).

Example frames:

```text
data: {"type":"progress","step":"installing","message":"Installing OpenClaw..."}

data: {"type":"output","line":"added 1 package in 4s"}

data: {"type":"complete","success":true,"version":"2026.9.1"}
```

An `EACCES` frame does not end the stream: the exit code still decides the outcome (`complete` on 0, `EXIT_<code>` otherwise), and its message suggests running the install with `sudo`.

### Example

```bash
curl -N -X POST http://localhost:18790/api/system/install-openclaw
```

---

## `POST /api/system/configure-openclaw`

Writes a fresh `openclaw.json` and `.env` for one provider, makes a new Gateway token, and saves the Gateway URL and token in Clawboo's settings. No dashboard screen calls this route; it is for scripts and manual setup. The dashboard's OpenClaw setup (in **Settings > Runtimes** and onboarding's **Add more runtimes** step) uses `POST /api/system/auto-configure-openclaw` instead, and when that answers `needsKey` it saves the key you paste with `POST /api/providers/:id/connect` and calls auto-configure again.

<Warning>

This route replaces `~/.openclaw/openclaw.json` and `~/.openclaw/.env` entirely, and makes a new Gateway token on every call. On an existing install that drops the agent roster (`agents.entries`), channels, plugins, the exec policy and every other key in `.env`, including keys saved from **Providers**. Use it only on a fresh install. To keep existing settings, use `auto-configure-openclaw` or `PATCH /api/system/openclaw-config`. Restart the Gateway afterwards so it runs with the new config and token.

</Warning>

The written `openclaw.json` holds only: `gateway` (`mode: 'local'`, the port, token auth read from `GATEWAY_AUTH_TOKEN`), the default model under `agents.defaults.model.primary`, agent-to-agent coordination (`tools.agentToAgent.enabled: true`, `tools.sessions.visibility: 'all'`), and for Ollama an optional `models.providers.ollama` entry. The written `.env` holds `GATEWAY_AUTH_TOKEN=<64 hex characters>` plus one key line, and only its owner can read it (mode `0600`). The route also creates `~/.openclaw/workspace`. The token is kept on the server and never returned.

- **Path/query params**: none.
- **Request body**:

```ts
{
  provider: string     // required: 'anthropic', 'openai', 'ollama', 'openai-codex', ...
  apiKey?: string      // required except for the keyless 'ollama' and 'openai-codex'
  model?: string       // default: the provider's default model (below)
  gatewayPort?: number // default 18789
}
```

Default models when `model` is omitted: `anthropic/claude-sonnet-4-5`, `openai/gpt-5.4`, `google/gemini-2.0-flash`, `openrouter/anthropic/claude-sonnet-4-5`, `xai/grok-3`, `groq/llama-3.3-70b-versatile`, `mistral/mistral-large-latest`, `moonshot/kimi-k2.5`, `minimax/MiniMax-M2.5`, `together/meta-llama/Llama-3.3-70B-Instruct-Turbo`, `nvidia/llama-3.1-nemotron-70b-instruct`, `huggingface/deepseek-ai/DeepSeek-R1`, `cerebras/zai-glm-4.7`, `venice/llama-3.3-70b`, `openai-codex/gpt-5.5`, and for `ollama` a pulled model (below). Any other provider gets `<provider>/default`.

The key line in `.env` uses the provider's own variable (for example `ANTHROPIC_API_KEY`, `GEMINI_API_KEY` for `google`, `HF_TOKEN` for `huggingface`). A provider with no known variable gets `CUSTOM_API_KEY`. `openai-codex` (the ChatGPT sign-in) writes no key line: OpenClaw uses its own sign-in profile, created with `openclaw models auth login --provider openai-codex`.

`ollama` works differently, because OpenClaw runs only a model the local Ollama has pulled and loads its Ollama provider only when it has a credential:

- The model is checked against Ollama's `/api/tags`. The requested model (or `llama3.2` when none is sent) is kept when it is pulled; otherwise the route writes the most recently pulled model, preferring one that can use tools, the same pick a new [Clawboo Native](/runtimes/native) agent gets. With no chat model pulled, or Ollama not answering, the request stands. It is always written as an `ollama/<model>` ref.
- `.env` gets `OLLAMA_API_KEY=ollama-local`, the marker OpenClaw accepts for a local Ollama. It is not a secret.
- OpenClaw calls `http://127.0.0.1:11434` and does not read `OLLAMA_BASE_URL`. When that variable is set, the route writes its address (without `/v1`) to `models.providers.ollama.baseUrl`, so OpenClaw uses the same Ollama whose models were checked.

### Responses

**`400 Bad Request`**: the body is missing or not an object:

```json
{ "error": "JSON body required" }
```

**`400 Bad Request`**: `provider` is missing or empty:

```json
{ "error": "provider is required" }
```

**`400 Bad Request`**: a keyed provider with a missing or empty `apiKey`:

```json
{ "error": "apiKey is required for non-keyless providers" }
```

**`200 OK`**: both files written, the token made and saved:

```ts
{ ok: true, gatewayUrl: string, model: string } // gatewayUrl is ws://localhost:<port>
```

`model` is the default written to `openclaw.json`. For `ollama` it can differ from the model you sent, when Ollama has not pulled that one.

**`500 Internal Server Error`**: a file or token failure:

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

Sets up OpenClaw from a credential you have already connected, so the OpenClaw setup never asks for a key it could find itself. The dashboard's OpenClaw setup calls it first and shows the key prompt only when this route finds nothing to use. Unlike `configure-openclaw`, it keeps what is already in `openclaw.json` and `.env` (see the list after the responses).

- **Path/query params**: none.
- **Request body**: none (ignored).

It looks for a credential in five steps, in order, and stops at the first that matches:

| Step | Condition                                                            | Outcome                                                                                                  |
| ---- | -------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| 1    | A provider key is connected (in the vault or in `~/.openclaw/.env`)  | The key is written to `.env` and every OpenClaw agent's `auth-profiles.json`, config written, `ok: true` |
| 2    | OpenClaw already holds an `openai-codex` (ChatGPT) sign-in profile   | Config written, no key written (OpenClaw uses its own profile), `ok: true`                               |
| 3    | The `codex` CLI is signed in, but OpenClaw has no profile of its own | Nothing written; `needsCodexAuth: true` and `loginCommand`, so the dashboard offers a ChatGPT sign-in    |
| 4    | Local Ollama is set up for Clawboo Native                            | Ollama's marker in `.env`, a pulled default model, config written, `ok: true`                            |
| 5    | Nothing is connected                                                 | Nothing written; `needsKey: true`, so the dashboard shows the key prompt                                 |

In step 1, with several keys connected, the route takes the first in this fixed order, not your default native provider: anthropic, openai, google, openrouter, xai, groq, mistral, moonshot, minimax, together, nvidia, huggingface, cerebras, venice. A provider counts as connected when its key is in the vault or in `~/.openclaw/.env` (a variable only in the server's shell does not count), but the value written is the one that resolves first: the server's environment, then the vault, then `.env`.

Step 3 exists because a `codex login` in your terminal is a ChatGPT subscription that OpenClaw cannot use until it holds a sign-in profile of its own. `loginCommand` is `openclaw models auth login --provider openai-codex`. The dashboard runs it for you through `POST /api/auth/cli-login/openclaw` and shows the command only if that fails.

Step 4 uses the same Ollama setup Clawboo Native reads: you picked **Ollama** in onboarding or pressed **Use** on it in Clawboo Native's **Manage**, or no choice is recorded and `OLLAMA_BASE_URL` is set. **Disconnect Ollama**, or a full disconnect of Clawboo Native, turns it off again. It is the last resort before the key prompt. It writes what `configure-openclaw` writes for `ollama`: `OLLAMA_API_KEY=ollama-local` in `.env`, a default model your Ollama has pulled (when `llama3.2` is not pulled, the most recently pulled model, preferring one that can use tools, always as `ollama/<model>`), and, when `OLLAMA_BASE_URL` is set, its address as `models.providers.ollama.baseUrl`.

### Responses

**`200 OK`** (steps 1, 2 and 4): `openclaw.json` was written and the Gateway URL and token saved in Clawboo's settings. `provider` is the provider that matched (`'openai-codex'` for step 2, `'ollama'` for step 4):

```ts
{
  ok: true
  gatewayUrl: string // e.g. ws://localhost:18789
  provider: string
  // step 4 only, when the default model is an ollama/ model:
  model?: string // the default in openclaw.json, kept or just written
  modelPulled?: boolean // false when Ollama does not list it, or is not answering
  pullCommand?: string // with modelPulled false, e.g. `ollama pull llama3.2`
}
```

An Ollama default that is not pulled fails every OpenClaw turn, so the dashboard's setup stops on `pullCommand` before it starts the Gateway, with **Check again** (which calls this route again) and **Continue anyway**.

**`200 OK`** (steps 3 and 5): nothing was written; the body says which prompt to show:

```ts
{ ok: false, needsCodexAuth: true, loginCommand: string }
// or
{ ok: false, needsKey: true }
```

**`500 Internal Server Error`**: a file or token failure:

```json
{ "error": "<message>" }
```

What this route keeps, which makes it safe on an existing install:

- **The Gateway token.** `GATEWAY_AUTH_TOKEN` in `.env` is reused; a new token is made only when there is none.
- **Your `openclaw.json` settings.** Only `gateway.mode` is set (to `'local'`). `gateway.port`, `gateway.auth`, the default model, `tools.agentToAgent`, `tools.sessions` and, in step 4, `models.providers.ollama` are filled in only when missing.
- **An existing `OLLAMA_API_KEY`.** Step 4 keeps one that has a value, since any value lets OpenClaw load its Ollama provider.
- **The port.** There is no `gatewayPort` input. A missing `gateway.port` becomes `18789`; an existing one is left alone.

The returned and saved `gatewayUrl` uses the port the Gateway route will use: the port in Clawboo's Gateway PID file, then `gateway.port` when it is a positive number, then `18789`. So a Gateway you moved to another port is the one Clawboo connects to.

### Example

```bash
curl -X POST http://localhost:18790/api/system/auto-configure-openclaw
```

---

## `POST /api/system/gateway`

Starts, stops, restarts or reports on the Gateway process. `action` picks the operation. `status` and `stop` return JSON; `start` and `restart` stream SSE, because they wait for the port to open and report progress. The port comes from Clawboo's Gateway PID file, then `gateway.port` in `openclaw.json`, then `18789`.

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

**`200 OK` (`action: 'stop'`)**: the stop result. `stopped: true` means a process was signalled (SIGTERM, then SIGKILL after a 2-second grace). When none was found, the body is `{ ok: false, message }` instead:

```ts
{ ok: true, stopped: true }
// or, when no gateway process was found:
{ ok: false, message: 'No gateway process found' }
```

**`200 OK` + `text/event-stream` (`action: 'start'` or `'restart'`)**: the stream sends `data: <json>\n\n` frames. `restart` first stops the running process. The route starts `openclaw gateway --port <port> --allow-unconfigured` as a detached process that keeps running when the client disconnects or Clawboo restarts. The Gateway's output goes to `~/.clawboo/gateway.log` (under `CLAWBOO_HOME` when set), and the stream relays new lines from that file as `output` frames.

#### Event catalog (`start` / `restart`)

| `type`     | When                                                                                                                                        | Payload fields                                                  |
| ---------- | ------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------- |
| `progress` | `restart` stop phase                                                                                                                        | `step: 'stopping'`, `message`                                   |
| `progress` | Spawn start, or joining an in-flight launch                                                                                                 | `step: 'starting'`, `message`                                   |
| `progress` | Each poll while waiting for the port to bind                                                                                                | `step: 'waiting'`, `message` (`Waiting for gateway... (n/120)`) |
| `progress` | The Gateway asked for `openclaw doctor --fix` and the repair is running, or another start is already running it                             | `step: 'repairing'`, `message`                                  |
| `output`   | Each non-empty line of Gateway output (read from `gateway.log`) and of the repair                                                           | `line`                                                          |
| `complete` | The port opened, or the Gateway was already running                                                                                         | `success: true`, `port`, and `pid` or `message`                 |
| `error`    | OpenClaw missing, a spawn failure, the Gateway exits with a stated reason, the repair fails, an unexpected error, or the 60 s wait runs out | `code`, `message`                                               |

Terminal `error` `code` values:

| `code`                | Meaning                                                                                                                                 |
| --------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| `NOT_INSTALLED`       | OpenClaw binary not found                                                                                                               |
| `SPAWN_THROW`         | The spawn call threw                                                                                                                    |
| `SPAWN_ERROR`         | The child process emitted an error                                                                                                      |
| `TIMEOUT`             | The port did not become reachable within ~60s (120 × 500ms polls); the message carries the Gateway's stated reason when its log has one |
| `GATEWAY_EXITED`      | The Gateway exited before binding and its log says why (`Gateway failed to start: ...`); reported at once rather than after the poll    |
| `DOCTOR_FIX_FAILED`   | The Gateway asked for `openclaw doctor --fix` and running it failed; the message carries doctor's last line                             |
| `DOCTOR_FIX_REQUIRED` | The Gateway still asked for `openclaw doctor --fix` after the repair ran once                                                           |
| `INTERNAL`            | An unexpected error after the stream opened                                                                                             |

**Automatic repair.** After an OpenClaw upgrade the Gateway can refuse to start until its data is migrated (for example `Legacy workspace setup state requires migration for ~/.openclaw/workspace; run openclaw doctor --fix`). When a launch exits with that request, the route runs `openclaw doctor --fix --non-interactive` once, with `OPENCLAW_SERVICE_REPAIR_POLICY=external` so doctor never installs, loads or restarts a launchd or systemd Gateway service, streams its output, and launches again. Only the failure line of that launch counts, so a passing mention of doctor elsewhere in the log never triggers it. A second `start` or `restart` that arrives while the repair runs waits for it instead of launching against data that is mid-migration. The repair has a 5-minute limit.

Every launch, and the repair, runs with an explicit working directory that exists: the OpenClaw CLI refuses to start in a deleted one.

When the port opens, the route copies the `.env` token into Clawboo's settings, starts reconnecting Clawboo's own Gateway connection (which then syncs the agent list), and sends `complete` without waiting for that reconnect. A `start` that finds the port already open sends `complete` at once with `message: 'Gateway already running'`. A `start` that finds a Gateway Clawboo launched still starting up waits for that launch instead of starting a second one.

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

Reads `openclaw.json`, flags for which provider keys OpenClaw holds (from `.env` and the agents' `auth-profiles.json`), the exec policy, and the state of OpenClaw's ChatGPT sign-in. The flags report presence only; no key value is returned.

- **Path/query params**: none.
- **Request body**: none.

### Responses

**`200 OK`**: the config and flags:

```ts
{
  config: Record<string, unknown> | null // the parsed openclaw.json, or null when missing or unreadable
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
  version: string | null // OpenClaw version; null when the check failed
  execAsk: unknown | null // tools.exec.ask from openclaw.json
  execSecurity: unknown | null // tools.exec.security
  codexAuth: {
    profile: boolean // OpenClaw holds its own openai-codex (ChatGPT) sign-in profile
    codexCli: boolean // a `codex login` exists on this machine
    bootstrapTrusted: boolean // currently false: Clawboo does not rely on OpenClaw making a profile from a codex login
    loginCommand: string // 'openclaw models auth login --provider openai-codex'
  }
}
```

A provider flag is `true` when its variable has a value in `.env`, or an agent's `auth-profiles.json` holds a key for that provider. Only one agent's file counts: the scan stops at the first agent whose `auth-profiles.json` holds any key. `hasGoogleKey` matches `GEMINI_API_KEY` or `GOOGLE_API_KEY`; `hasHuggingFaceKey` matches `HF_TOKEN` or `HUGGINGFACE_HUB_TOKEN`.

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

Changes parts of `openclaw.json` and, when keys are sent, writes them to `.env` and every OpenClaw agent's `auth-profiles.json`. Every field is optional and only the fields you send are touched. A missing or unreadable `openclaw.json` is treated as empty. Keys sent here go to OpenClaw's files only, not to Clawboo's vault.

- **Path/query params**: none.
- **Request body** (all fields optional):

```ts
{
  model?: string        // agents.defaults.model.primary (and agents.defaults.contextTokens, below)
  fallbacks?: string[]  // agents.defaults.model.fallbacks (non-strings dropped)
  gatewayPort?: number  // gateway.port, and Clawboo's saved Gateway URL
  apiKeys?: Array<{ provider: string; key: string }> // .env and every agent's auth-profiles.json
  agentModel?: { agentId: string; model: string | null } // agents.entries.<agentId>.model
  exec?: { ask?: string; security?: string } // tools.exec.ask, tools.exec.security
  agentToAgent?: { enabled: boolean } // tools.agentToAgent.enabled
}
```

What each field writes:

- **`model`** sets the default model. It also sets `agents.defaults.contextTokens` to the context window the OpenClaw CLI's model catalog reports for that exact model; when the catalog has no entry, `contextTokens` is not written.
- **`agentModel`** sets one agent's model override in OpenClaw's roster, `agents.entries.<agentId>.model`. A legacy `agents.list` array is folded into `agents.entries` and removed first, because OpenClaw rejects a config that has both. A `model` of `null` or `''` deletes only the override and keeps the agent's entry, since the entry is the agent's place in the roster. When the roster then holds more than one agent and has no `agents.ownership`, it is set to `'explicit'`.
- **`gatewayPort`** sets `gateway.port` and saves `ws://localhost:<port>` as Clawboo's Gateway URL.
- **`apiKeys`** upserts each key under its provider's variable (a provider with no known variable gets `<PROVIDER>_API_KEY`) and as the `<provider>:default` profile in each agent's `auth-profiles.json`.
- **`agentToAgent`** with `enabled: true` also sets `tools.sessions.visibility: 'all'`.

### Responses

**`400 Bad Request`**: the body is missing or not an object:

```json
{ "error": "JSON body required" }
```

**`400 Bad Request`**: `agentModel.agentId` is `__proto__`, `constructor` or `prototype`. Nothing is written:

```json
{ "error": "invalid agentId" }
```

**`200 OK`**: written. `hotReloadHint` is present only when the Gateway is reachable, as a sign that a client can reload its config:

```ts
{ ok: true }
// or, when the Gateway is running:
{ ok: true, hotReloadHint: true }
```

**`500 Internal Server Error`**: a file failure:

```json
{ "error": "<message>" }
```

### Example

```bash
curl -X PATCH http://localhost:18790/api/system/openclaw-config \
  -H 'Content-Type: application/json' \
  -d '{"model":"anthropic/claude-sonnet-4-5","agentToAgent":{"enabled":true}}'

# Give one agent its own model
curl -X PATCH http://localhost:18790/api/system/openclaw-config \
  -H 'Content-Type: application/json' \
  -d '{"agentModel":{"agentId":"<agent-id>","model":"openai/gpt-5.4"}}'
```

---

## `POST /api/system/approve-device`

Approves the most recent pending OpenClaw device-pairing request. OpenClaw does not pair a new device on its own: the device waits until a person approves it, and until then its Gateway connection fails with `NOT_PAIRED` ("pairing required: device is not approved yet"). The dashboard's pairing card (**Approve this device**) calls this route.

It runs two commands. First `openclaw devices approve --latest`, which only previews: it prints the pending request's UUID (in a line like `Approve this exact request with: openclaw devices approve <UUID>`) and exits non-zero. The route reads the UUID from that output, then runs `openclaw devices approve <UUID>` to approve it. The first command gets 5 seconds and the second 10.

- **Path/query params**: none.
- **Request body**: none.

### Responses

**`400 Bad Request`**: OpenClaw is not installed:

```json
{ "error": "OpenClaw not installed" }
```

**`500 Internal Server Error`**: the preview command could not run (not found, or timed out):

```json
{ "error": "Failed to run openclaw: <message>" }
```

**`404 Not Found`**: the preview output named no pending request. `details` is its first 500 characters:

```json
{ "error": "No pending device pairing requests found", "details": "<preview output>" }
```

**`200 OK`**: the device was approved. `output` is the command's output, up to 1,000 characters:

```ts
{ ok: true, requestId: string, output: string }
```

**`500 Internal Server Error`**: the approval command failed. The message carries its error output, up to 500 characters:

```json
{ "error": "Failed to approve device: <message>", "requestId": "<uuid>" }
```

<Note>

Finding the UUID depends on the wording of OpenClaw's output (the pattern `/openclaw devices approve\s+([a-f0-9-]{36})/i`). If an OpenClaw release changes that line, this route answers 404. The pairing card then shows the error, and its footer always lists the manual `openclaw devices approve` commands.

</Note>

### Example

```bash
curl -X POST http://localhost:18790/api/system/approve-device
```

---

## `GET /api/system/models`

The model catalog behind the OpenClaw model pickers. It comes from `openclaw models list --all --json` (cached for 5 minutes); without the CLI, the built-in catalog is used instead. The result keeps only the 14 key providers, `ollama` and `openai-codex`, with provider names in the built-in catalog's display spelling. A known provider the CLI does not list is filled in from the built-in catalog.

`configuredProviders` lists the providers OpenClaw can use: those with a key in `.env` or in an agent's `auth-profiles.json`, those with a sign-in profile (for example `openai-codex` after a ChatGPT sign-in), and always `ollama`.

- **Path/query params**: none.
- **Request body**: none.

### Responses

**`200 OK`**: the grouped catalog:

```ts
{
  groups: Array<{
    provider: string
    models: Array<{ id: string; label: string }>
  }> | null // null only after an unexpected error
  configuredProviders: string[] // always includes 'ollama'
}
```

<Note>

This route never answers with an error status. An unexpected error comes back as `{ "groups": null, "configuredProviders": [] }` with status **200**, so a picker can fall back to its own list.

</Note>

### Example

```bash
curl http://localhost:18790/api/system/models
```

---

## `GET /api/system/self-version`

Which Clawboo this server runs, how it was installed, and whether a newer release is published. The dashboard's **Update available** chip reads it, and so does the `clawboo` command when it finds a server already running (see the [CLI reference](/reference/cli)).

### Query parameters

| Param   | Values | Effect                                                                                                                    |
| ------- | ------ | ------------------------------------------------------------------------------------------------------------------------- |
| `local` | `1`    | Skip the npm-registry probe. `latest` and `checkedAt` come back `null` and `updateAvailable` `false`, i.e. "not checked". |

`?local=1` is for the CLI, which reads this route each time it attaches to a running server only to compare versions. The registry check is capped at 5 seconds and a failed check is not cached, so without it an offline machine would wait on every launch.

### Responses

Always `200`. An unreachable registry is a `null` `latest`, never an error status.

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

A dev checkout reports `current: "0.0.0-dev"` and is never told an update is available. The chip and the CLI both treat a `0.0.0*` version as "don't nag", and the CLI never offers to restart such a server, so a contributor's `pnpm dev` process is never a target.

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

Only a `global` install can update itself. An `npx` run lives in npm's `_npx` cache, so a global install lands somewhere the running copy cannot reach, and a dev checkout never updates itself. Both get an `unsupported` event with the command to run instead (the chip hides its button in those cases anyway).

### Event stream

| `type`                | When                                                                            | Payload fields                                                    |
| --------------------- | ------------------------------------------------------------------------------- | ----------------------------------------------------------------- |
| `unsupported`         | `installMethod` is not `global`                                                 | `method`, `command`, `message`                                    |
| `progress`            | Install start                                                                   | `step: 'installing'`, `message`                                   |
| `output`              | Each non-empty line of npm output                                               | `line`                                                            |
| `error`               | A spawn failure, or npm exits non-zero; at most one per stream                  | `code`, `message`, and on a non-zero exit `exitCode` and `detail` |
| `installed-elsewhere` | npm exited 0 but the on-disk version did not change, or the API port is unknown | `version`, `message`                                              |
| `installed`           | npm exited 0 and the on-disk version changed                                    | `version`                                                         |
| `restarting`          | Just before the new server starts                                               | `port`, `version`                                                 |

| `code`        | Meaning                                                                                  |
| ------------- | ---------------------------------------------------------------------------------------- |
| `EACCES`      | npm's output named `EACCES`, `EPERM` or "permission denied": the install needs elevation |
| npm's code    | npm printed its own code (`ETARGET`, `ENOTFOUND`, ...)                                   |
| `EXIT_<code>` | A non-zero npm exit that printed no code of its own (e.g. `EXIT_7`)                      |
| `SPAWN_THROW` | The spawn call threw                                                                     |
| `SPAWN_ERROR` | The child process emitted an error                                                       |

On a non-zero exit, `detail` is npm's own reason in one line (the `Error:` line, or the first line of its error block, or the name of a package whose install script failed), and `message` leads with it, so the chip shows why rather than only an exit code. `detail` is `null` when npm's output named no reason.

npm runs in a working directory that exists, because npm exits with code 7 when its working directory has been deleted.

After `restarting`, the server starts a new server on the same port (`CLAWBOO_API_PORT`), told to wait until that port is free (`CLAWBOO_AWAIT_PORT`), and then exits so the new one can bind. The new server starts in a working directory that exists, and a server that does start in a deleted directory moves into the Clawboo directory before it loads anything. `CLAWBOO_VERSION` is removed from its environment, so it reads its version from the newly installed package. The browser keeps polling the same address and reloads when the new server answers.

<Note>

`installed-elsewhere` means the global install landed somewhere this running copy does not point at, so a restart would run the old code again. The server stays up and asks you to restart it yourself.

</Note>

From a terminal, run the `updateCommand` that `self-version` reports, then `clawboo restart` (see the [CLI reference](/reference/cli)).

### Example

```bash
curl -N -X POST http://localhost:18790/api/system/self-update
```

---

## Error envelope

Errors use the standard `{ "error": string }` body. `approve-device` adds `details` on its 404 and `requestId` on the 500 from the approval command. `GET /api/system/models` never returns an error status; it falls back to a `200` with a `null` catalog. The SSE routes report failures as `error` frames once the stream is open. Going over a rate limit answers **429** with `{ "error": "Too many requests. Wait a moment and retry." }` (general) or `{ "error": "Too many requests for this operation. Wait a moment and retry." }` (sensitive), plus a `Retry-After` header.

**Source of truth:** `apps/web/server/api/system.ts` and `systemUpdate.ts`; the version check in `apps/web/server/lib/updateCheck.ts`; key files in `apps/web/server/lib/openclawEnv.ts`.

## Related

- [OpenClaw](/runtimes/openclaw): set up OpenClaw, the Gateway and device pairing in the dashboard.
- [System](/using/system): Gateway control and OpenClaw settings in the **System** panel.
- [System Health](/using/system-health): the start-up checks behind `/api/health`.
- [Settings API](/reference/rest-api/settings): the saved Gateway URL and token these routes write.
- [Runtimes API](/reference/rest-api/runtimes): Clawboo Native, Claude Code, Codex and Hermes.
- [REST API overview](/reference/rest-api/index): authentication, rate limits and conventions.
