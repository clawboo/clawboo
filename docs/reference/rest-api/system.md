---
title: 'System API'
description: 'REST reference for /api/system: OpenClaw status, install, setup, Gateway control, config, device pairing and models, plus Clawboo version, capabilities, self-update and drain and hold.'
keywords:
  [
    'openclaw',
    'gateway',
    'configure-openclaw',
    'auto-configure-openclaw',
    'device pairing',
    'self-update',
    'capabilities',
    'drain and hold',
    'feature flags',
    'openclaw.json',
  ]
---

Use these routes to manage the host itself. Most of them drive OpenClaw: detect what is installed, install the OpenClaw CLI, write its config, control the Gateway process, read or patch `openclaw.json`, approve a device-pairing request, and list the model catalog. The dashboard's OpenClaw setup and **Manage** section in **Settings > Runtimes**, the **System** panel and the update chip call them. The last routes are about Clawboo itself: which release this server runs and what it supports (`self-version`, `capabilities`), installing a newer one (`self-update`), holding new agent runs back before a stop (`hold`), what a host that stops an idle server needs to know (`idle`, `presence`), and the settings an administrator can pin (`operator-settings`).

<Note>

Every route here except `self-version`, `capabilities`, `self-update`, `hold`, `idle`, `presence` and `operator-settings` is for OpenClaw. OpenClaw runs as its own Gateway process that Clawboo starts and talks to, so its lifecycle lives here. [`/api/runtimes`](/reference/rest-api/runtimes) covers Clawboo Native (built in), Claude Code, Codex and Hermes, and the agent registry is in the [Agents API](/reference/rest-api/agents).

</Note>

Three routes stream **Server-Sent Events** instead of returning a JSON body: `POST /api/system/install-openclaw` and `POST /api/system/self-update` always, and `POST /api/system/gateway` for `start` and `restart`. Each is documented with an event catalog (event `type` and payload). Request bodies are JSON (up to 2 MB). Every route counts against the general [rate limit](/reference/rest-api/index#rate-limits) of 3,000 requests a minute per client address; routes marked **sensitive** also count against a limit of 60 a minute. Add the access cookie to each `curl` example (see [Authentication](/reference/rest-api/index#authentication)).

## Routes

| Method | Path                                  | Summary                                                         | Rate tier | Stream?                   |
| ------ | ------------------------------------- | --------------------------------------------------------------- | --------- | ------------------------- |
| GET    | `/api/system/status`                  | Node, OpenClaw and Gateway status                               | general   | No                        |
| POST   | `/api/system/install-openclaw`        | Install OpenClaw into Clawboo's runtimes folder                 | sensitive | SSE                       |
| POST   | `/api/system/configure-openclaw`      | Replace `openclaw.json` and `.env` for one provider (API only)  | sensitive | No                        |
| POST   | `/api/system/auto-configure-openclaw` | Set up OpenClaw from a credential you already connected         | sensitive | No                        |
| POST   | `/api/system/gateway`                 | Gateway control: `start`, `stop`, `restart`, `status`           | sensitive | SSE for `start`/`restart` |
| GET    | `/api/system/openclaw-config`         | Read `openclaw.json`, key flags and the ChatGPT sign-in state   | general   | No                        |
| PATCH  | `/api/system/openclaw-config`         | Change parts of `openclaw.json` (model, port, keys, exec, a2a)  | sensitive | No                        |
| POST   | `/api/system/approve-device`          | Approve the latest pending device-pairing request               | sensitive | No                        |
| GET    | `/api/system/models`                  | Model catalog (from the OpenClaw CLI, else the built-in list)   | general   | No                        |
| GET    | `/api/system/self-version`            | Which Clawboo this server runs, and whether a newer one exists  | general   | No                        |
| GET    | `/api/system/capabilities`            | This server's version, API revision and feature flags           | general   | No                        |
| POST   | `/api/system/self-update`             | Install `clawboo@latest` globally, then restart into it         | sensitive | SSE                       |
| GET    | `/api/system/hold`                    | Whether the server is held, and whether agent runs are going    | general   | No                        |
| POST   | `/api/system/hold`                    | Hold the server, or renew a hold: no new agent run starts       | general   | No                        |
| DELETE | `/api/system/hold/:owner`             | Release the hold that owner placed                              | general   | No                        |
| GET    | `/api/system/idle`                    | Is a person here, is work going, when is scheduled work due     | general   | No                        |
| POST   | `/api/system/presence`                | A client says a person is at it (only this counts as a person)  | general   | No                        |
| GET    | `/api/system/operator-settings`       | Settings an administrator can pin, and where each value is from | general   | No                        |
| PUT    | `/api/system/operator-settings/:key`  | Save a value for a setting nobody pinned, for the whole install | sensitive | No                        |

---

## `GET /api/system/status`

Returns one snapshot of the Node runtime, the OpenClaw install and the Gateway process. The dashboard reads it at startup to decide what to show, and the OpenClaw setup and the **System** panel read it for the Gateway's state. When the Gateway is running and `.env` exists, the call also copies the Gateway token from `.env` into Clawboo's settings, so Clawboo never connects with a stale token.

The OpenClaw check looks in Clawboo's [runtimes folder](/operating/data-and-state#the-runtimes-folder) first, then on `PATH`. For Clawboo's own copy the version comes from its install record, and nothing is spawned. For a copy on `PATH` the check is cached per binary path and gives up on `openclaw --version` after 6 seconds, so a slow first start never holds up the server. `installed` says whether either was found; `version` is `null` when the version check timed out or failed (the binary still reads installed).

- **Path/query params**: none.
- **Request body**: none.

### Responses

**`200 OK`**: the status snapshot:

```ts
{
  node: {
    version: string // process.version, e.g. "v22.3.0"
    major: number // parsed major version
    sufficient: boolean // whether this Node satisfies OpenClaw's engines, NOT a bare major check; install-openclaw refuses when false
    required: string // the range OpenClaw requires, e.g. ">=24.22.1 <25 || >=26.12.1"
    path: string // process.execPath
  }
  openclaw: {
    installed: boolean
    version: string | null // null when the version probe timed out / failed
    path: string | null // the launcher in the runtimes folder, else the binary on PATH; null when not installed
    source: 'clawboo' | 'path' | null // 'clawboo': Clawboo's copy in the runtimes folder; 'path': found on PATH; null when not installed
    runsOnNode: { path: string; version: string } | null // the Node.js Clawboo's copy runs on; null otherwise
    command: string // how to type `openclaw` in a terminal: the launcher's full path for Clawboo's copy, else 'openclaw'
    problem: string | null // why Clawboo's copy cannot be used although one is on record (its Node.js removed, say); null otherwise
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

Installs OpenClaw into Clawboo's own [runtimes folder](/operating/data-and-state#the-runtimes-folder), never into npm's global folder, so it never needs `sudo`. **Set up OpenClaw** and **Check for Updates** in **Settings > System** call it.

1. **Node.js first.** OpenClaw will run on the Node.js the server runs on, so the route checks that version against OpenClaw's range, `>=24.22.1 <25 || >=26.12.1`. Outside it, the stream sends one `NODE_UNSUPPORTED` error and installs nothing. npm itself would not refuse such a Node: it would install an older OpenClaw release.
2. **One install at a time.** A request while an OpenClaw install is running gets an `INSTALL_RUNNING` error.
3. **npm into a new folder.** npm runs on the server's Node (the npm beside it, else the one on `PATH`) as `npm install --prefix <new install folder> --include=optional --no-fund --no-audit openclaw@~2026.9`, under umask 022 and without `npm_config_global`, `npm_config_location` and `npm_config_prefix`. The pin is `~2026.9` (not `@latest`, and not `^2026.9`, which would allow any 2026.x) so a new install gets an OpenClaw whose config format matches what Clawboo writes.
4. **Switch on success.** The install becomes current, and its launcher, `<runtimes folder>/bin/openclaw`, starts OpenClaw on that Node. The previous install is kept and older ones are removed. A failed or stopped install is removed, and the current one is untouched.

The Gateway Clawboo starts, `openclaw doctor --fix`, device approval, the model list and the ChatGPT sign-in all use that launcher when it is there, else an `openclaw` on `PATH`. A Gateway that something else runs, such as OpenClaw's own launchd service on port 18789, is left alone.

- **Path/query params**: none.
- **Request body**: none.

### Responses

**`200 OK` + `text/event-stream`**: the stream sends `data: <json>\n\n` frames with `Cache-Control: no-cache`. If the client closes the connection, the install is stopped and its folder removed.

#### Event catalog

| `type`     | When                                                        | Payload fields                     |
| ---------- | ----------------------------------------------------------- | ---------------------------------- |
| `progress` | Install start, after the checks                             | `step: 'installing'`, `message`    |
| `output`   | Each non-empty line npm prints                              | `line`                             |
| `error`    | A check refused the install, or npm failed. The stream ends | `code`, `message`                  |
| `complete` | npm succeeded and the install is current                    | `success: true`, `version`, `path` |

The `error` codes:

| `code`                 | Meaning                                                                                                                                                                                                                |
| ---------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `NODE_UNSUPPORTED`     | The server's Node.js is outside OpenClaw's range; nothing was installed. The message names the range and this Node's version                                                                                           |
| `INSTALL_RUNNING`      | An OpenClaw install is still running; nothing new was started                                                                                                                                                          |
| `RUNTIMES_DIR_REFUSED` | The runtimes folder is, contains or sits inside the data folder or the work folder, its `bin/` is a link or not a folder, or another user owns it or others can write to it. The message says which, and how to fix it |
| `RUNTIMES_DIR_FAILED`  | The runtimes folder, or the new install's folder, could not be created                                                                                                                                                 |
| `NPM_MISSING`          | No npm beside the server's Node and none on `PATH`                                                                                                                                                                     |
| `SPAWN_THROW`          | The spawn call threw                                                                                                                                                                                                   |
| `SPAWN_ERROR`          | The npm process emitted an error                                                                                                                                                                                       |
| `STOPPED`              | The install was stopped                                                                                                                                                                                                |
| `NOT_INSTALLED`        | npm finished, but `openclaw` is not in the install's folder                                                                                                                                                            |
| `NO_COMMAND`           | The installed package has no `openclaw` command                                                                                                                                                                        |
| `COMMIT_FAILED`        | The install could not be made current, for example because an item in it belongs to another user or a link in it points outside it                                                                                     |
| npm's own code         | npm failed and named a code, such as `EACCES` or `ETARGET`                                                                                                                                                             |
| `EXIT_<code>`          | npm failed with a non-zero exit and no code of its own (for example `EXIT_1`)                                                                                                                                          |

When npm fails, the message reads `Installation failed with exit code <n>.` followed by npm's own reason. On success, `complete` carries the installed version (`'unknown'` when it could not be read) and `path`, the launcher in the runtimes folder.

Example frames:

```text
data: {"type":"progress","step":"installing","message":"Installing OpenClaw..."}

data: {"type":"output","line":"added 1 package in 4s"}

data: {"type":"complete","success":true,"version":"2026.9.34","path":"/Users/you/clawboo-runtimes/bin/openclaw"}
```

On a Node.js outside the range, the only frame is:

```text
data: {"type":"error","code":"NODE_UNSUPPORTED","message":"Node.js v22.12.0 is too old for OpenClaw, which needs >=24.22.1 <25 || >=26.12.1, so nothing was installed. Update the Node.js Clawboo runs on: if Clawboo came with the desktop app, update the app; otherwise start Clawboo with Node.js 24.22.1 or a newer Node 24. Then install OpenClaw again."}
```

### Example

```bash
curl -N -X POST http://localhost:18790/api/system/install-openclaw
```

---

## `POST /api/system/configure-openclaw`

**A person's route.** A caller that does not pass [the person check](/operating/security#the-person-check) gets `403 { "ok": false, "error": "person_only" }`, and nothing changes. A script you run yourself can pass it with the two `Sec-Fetch-` headers in the example.

Writes a fresh `openclaw.json` and `.env` for one provider, makes a new Gateway token, and saves the Gateway URL and token in Clawboo's settings. No dashboard screen calls this route; it is for scripts and manual setup. The dashboard's OpenClaw setup (in **Settings > Runtimes** and onboarding's **Add more runtimes** step) uses `POST /api/system/auto-configure-openclaw` instead, and when that answers `needsKey` it saves the key you paste with `POST /api/providers/:id/connect` and calls auto-configure again.

<Warning>

This route replaces `~/.openclaw/openclaw.json` and `~/.openclaw/.env` entirely, and makes a new Gateway token on every call. On an existing install that drops the agent roster (`agents.entries`), channels, plugins, the exec policy and every other key in `.env`, including keys saved from **Providers**. Use it only on a fresh install. To keep existing settings, use `auto-configure-openclaw` or `PATCH /api/system/openclaw-config`. Restart the Gateway afterwards so it runs with the new config and token.

</Warning>

The written `openclaw.json` holds only: `gateway` (`mode: 'local'`, the port, token auth read from `GATEWAY_AUTH_TOKEN`), the default model under `agents.defaults.model.primary`, OpenClaw's tool sandbox turned off (`agents.defaults.sandbox.mode: 'off'`), agent-to-agent coordination (`tools.agentToAgent.enabled: true`, `tools.sessions.visibility: 'all'`), and for Ollama an optional `models.providers.ollama` entry. With the sandbox off, OpenClaw runs its agents' tools on the host, the computer Clawboo and its other agents use, rather than in a Docker or Podman container of its own. `off` is OpenClaw's default; the route writes it so it holds if a later OpenClaw changes that default. The written `.env` holds `GATEWAY_AUTH_TOKEN=<64 hex characters>` plus one key line, and only its owner can read it (mode `0600`). The route also creates `~/.openclaw/workspace`. The token is kept on the server and never returned.

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

Default models when `model` is omitted: `anthropic/claude-sonnet-4-5`, `openai/gpt-5.4`, `google/gemini-3.6-flash`, `openrouter/anthropic/claude-sonnet-4-5`, `xai/grok-3`, `groq/llama-3.3-70b-versatile`, `mistral/mistral-large-latest`, `moonshot/kimi-k2.5`, `minimax/MiniMax-M2.5`, `together/meta-llama/Llama-3.3-70B-Instruct-Turbo`, `nvidia/llama-3.1-nemotron-70b-instruct`, `huggingface/deepseek-ai/DeepSeek-R1`, `cerebras/zai-glm-4.7`, `venice/llama-3.3-70b`, and for `ollama` a pulled model (below). Any other provider gets `<provider>/default`. `openai-codex` (the ChatGPT sign-in) gets your plan's own default model as `openai-codex/<model>`, read from your Codex CLI through [`GET /api/runtimes/codex/models`](/reference/rest-api/runtimes). OpenAI decides which models each plan may use, so Clawboo names none of its own: when that list is unknown, `openclaw.json` gets no default model and OpenClaw applies its own.

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
{ ok: true, gatewayUrl: string, model: string | null } // gatewayUrl is ws://localhost:<port>
```

`model` is the default written to `openclaw.json`. For `ollama` it can differ from the model you sent, when Ollama has not pulled that one. It is `null` for `openai-codex` when your plan's model list is unknown, and then no default is written.

**`500 Internal Server Error`**: a file or token failure:

```json
{ "error": "<message>" }
```

### Example

```bash
curl -X POST http://localhost:18790/api/system/configure-openclaw \
  -H 'Sec-Fetch-Site: same-origin' -H 'Sec-Fetch-Mode: cors' \
  -H 'Content-Type: application/json' \
  -d '{"provider":"anthropic","apiKey":"sk-ant-...","gatewayPort":18789}'
```

---

## `POST /api/system/auto-configure-openclaw`

**A person's route.** A caller that does not pass [the person check](/operating/security#the-person-check) gets `403 { "ok": false, "error": "person_only" }`, and nothing changes. A script you run yourself can pass it with the two `Sec-Fetch-` headers in the example.

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

In step 2 a missing default model becomes your plan's own default (`openai-codex/<model>`, read from your Codex CLI through [`GET /api/runtimes/codex/models`](/reference/rest-api/runtimes)). When that list is unknown, none is written and OpenClaw applies its own.

Step 3 exists because a `codex login` in your terminal is a ChatGPT subscription that OpenClaw cannot use until it holds a sign-in profile of its own. `loginCommand` is `openclaw models auth login --provider openai-codex`. When the OpenClaw found is Clawboo's copy, `openclaw` is replaced by its launcher's full path (quoted when it needs it), since the runtimes folder is not on your `PATH`. The dashboard runs it for you through `POST /api/auth/cli-login/openclaw` and shows the command only if that fails.

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
- **Your `openclaw.json` settings.** Only `gateway.mode` is set (to `'local'`). `gateway.port`, `gateway.auth`, the default model, `agents.defaults.sandbox` (as `{ mode: 'off' }`), `tools.agentToAgent`, `tools.sessions` and, in step 4, `models.providers.ollama` are filled in only when missing. A sandbox you set up yourself stays.
- **An existing `OLLAMA_API_KEY`.** Step 4 keeps one that has a value, since any value lets OpenClaw load its Ollama provider.
- **The port.** There is no `gatewayPort` input. A missing `gateway.port` becomes `18789`; an existing one is left alone.

The returned and saved `gatewayUrl` uses the port the Gateway route will use: the port in Clawboo's Gateway PID file, then `gateway.port` when it is a positive number, then `18789`. So a Gateway you moved to another port is the one Clawboo connects to.

### Example

```bash
curl -X POST http://localhost:18790/api/system/auto-configure-openclaw \
  -H 'Sec-Fetch-Site: same-origin' -H 'Sec-Fetch-Mode: cors'
```

---

## `POST /api/system/gateway`

Starts, stops, restarts or reports on the Gateway process. `action` picks the operation. A start runs Clawboo's own OpenClaw from the runtimes folder when there is one, so the Gateway runs on the Node.js that installed it, else the `openclaw` on `PATH`. `status` and `stop` return JSON; `start` and `restart` stream SSE, because they wait for the port to open and report progress. The port comes from Clawboo's Gateway PID file, then `gateway.port` in `openclaw.json`, then `18789`.

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
| `NOT_INSTALLED`       | OpenClaw binary not found; when Clawboo's copy is on record but unusable, the message adds why                                          |
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
    loginCommand: string // 'openclaw models auth login --provider openai-codex', with the launcher's full path for Clawboo's copy
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

**A person's route.** A caller that does not pass [the person check](/operating/security#the-person-check) gets `403 { "ok": false, "error": "person_only" }`, and nothing changes. A script you run yourself can pass it with the two `Sec-Fetch-` headers in the example.

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
  -H 'Sec-Fetch-Site: same-origin' -H 'Sec-Fetch-Mode: cors' \
  -H 'Content-Type: application/json' \
  -d '{"model":"anthropic/claude-sonnet-4-5","agentToAgent":{"enabled":true}}'

# Give one agent its own model
curl -X PATCH http://localhost:18790/api/system/openclaw-config \
  -H 'Content-Type: application/json' \
  -d '{"agentModel":{"agentId":"<agent-id>","model":"openai/gpt-5.4"}}'
```

---

## `POST /api/system/approve-device`

**A person's route.** A caller that does not pass [the person check](/operating/security#the-person-check) gets `403 { "ok": false, "error": "person_only" }`, and nothing changes. A script you run yourself can pass it with the two `Sec-Fetch-` headers in the example.

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
curl -X POST http://localhost:18790/api/system/approve-device \
  -H 'Sec-Fetch-Site: same-origin' -H 'Sec-Fetch-Mode: cors'
```

---

## `GET /api/system/models`

The model catalog behind the OpenClaw model pickers. It comes from `openclaw models list --all --json` (cached for 5 minutes); without the CLI, the built-in catalog is used instead. OpenClaw 2026.9 refuses that listing when several agents are configured and none is named the owner ("model inspection has no explicit owner"), which an install running a Clawboo team usually is. Clawboo then asks again with `--agent`, naming the agent marked `default`, else `main`, else the first one configured, and keeps passing it on later refreshes until a system agent (`agents.defaults.systemAgent.agentId`) is configured; OpenClaw then lists as that agent by itself, and the plain command runs again. It never sends `--agent` to an install that did not refuse. The listing follows that agent's sign-ins and keys. The result keeps only the 14 key providers, `ollama` and `openai-codex`, with provider names in the built-in catalog's display spelling. A known provider the CLI does not list is filled in from the built-in catalog. The built-in catalog's `OpenAI Codex` group has no models: the pickers fill it from your plan's live list ([`GET /api/runtimes/codex/models`](/reference/rest-api/runtimes)) and leave it out while that list is unknown.

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

With `CLAWBOO_DISABLE_SELF_UPDATE=1`, or `disableSelfUpdate` in the operator settings file, every request answers as `?local=1` does, and `applyable` is `false`.

`?local=1` is for the CLI, which reads this route each time it attaches to a running server only to compare versions. The registry check is capped at 5 seconds and a failed check is not cached, so without it an offline machine would wait on every launch.

### Responses

Always `200`. An unreachable registry is a `null` `latest`, never an error status.

| Field             | Type                         | Notes                                                                                                                                                    |
| ----------------- | ---------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `current`         | `string`                     | The running version. `CLAWBOO_VERSION` if set (the CLI injects it), else the shipped `package.json`, else `0.0.0-dev`.                                   |
| `latest`          | `string \| null`             | npm's `latest` for `clawboo`. `null` when unreachable or skipped. Cached ~6 h.                                                                           |
| `updateAvailable` | `boolean`                    | True only for a real (non-`0.0.0*`) `current` with a strictly greater `latest`.                                                                          |
| `updateCommand`   | `string`                     | `npx clawboo@latest` for an npx run, `npm install -g clawboo@latest` otherwise.                                                                          |
| `installMethod`   | `'global' \| 'npx' \| 'dev'` | Derived from the running entry path.                                                                                                                     |
| `applyable`       | `boolean`                    | Whether `POST /api/system/self-update` would run here: a `global` install whose folders the server's user can write, with in-app updates not turned off. |
| `isDeprecated`    | `boolean`                    | `current` is on the npm-deprecated `0.1.x` line.                                                                                                         |
| `checkedAt`       | `number \| null`             | Epoch ms of the last registry fetch, `null` when `latest` is `null`.                                                                                     |

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

## `GET /api/system/capabilities`

What this server is and which features it has: its Clawboo version, the client API revision, the oldest release whose clients it still serves, and a flat map of feature flags. A client (the dashboard, a desktop shell that bundles the server, a proxy in front of it, or an app on another device) reads it before it uses a feature, instead of calling a route to see whether it answers. The dashboard reads it after an in-app update, to tell the new server from the one that is shutting down.

The answer is built from the running process alone: no database read, no network call, nothing written. It carries no secret and no file path. The route sits behind the same-origin guard and the access token like every other `/api` route. A client that has not signed in gets the `401` described in [Authentication](/reference/rest-api/index#authentication), and that answer already tells it a Clawboo server is there.

- **Path/query params**: none.
- **Request body**: none.

### Responses

**`200 OK`**, with `Cache-Control: no-store` because the answer changes when the server restarts into a new version:

| Field          | Type                      | Notes                                                                                                                                                                                              |
| -------------- | ------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `version`      | `string`                  | The running version, from the same source as `self-version`'s `current`: `CLAWBOO_VERSION`, else the shipped `package.json`, else `0.0.0-dev`.                                                     |
| `apiRevision`  | `number`                  | The client API revision, now `1`. It goes up only when a route, response field or stream event a client may use is removed or renamed. Adding one never changes it.                                |
| `supportFloor` | `string`                  | The oldest `major.minor` whose clients this server still serves: the previous minor of the same major (`0.5` for `0.6.2`). An `x.0` release starts a new window, so its floor is `x.0`.            |
| `features`     | `Record<string, boolean>` | Feature flags by name (below). A client treats a flag it does not find as `false`: a server never sends flags newer than itself, and a client should keep flags it does not know rather than fail. |

[Supported versions](/operating/supported-versions) explains the window and how a client checks it.

```json
{
  "version": "0.6.0",
  "apiRevision": 1,
  "supportFloor": "0.5",
  "features": {
    "runtime.openclaw": true,
    "runtime.clawboo-native": true,
    "runtime.claude-code": true,
    "runtime.codex": true,
    "runtime.hermes": true,
    "chat.rooms": true,
    "chat.direct": true,
    "chat.handOffs": true,
    "board.verification": true,
    "board.checkHold": true,
    "board.reportResult": true,
    "board.parentWaits": true,
    "board.steering": true,
    "board.readableIds": true,
    "board.labels": true,
    "board.inbox": true,
    "board.mainTasks": true,
    "board.wakes": true,
    "board.agentWakes": true,
    "board.jobLimit": true,
    "board.planDocuments": true,
    "board.planApproval": true,
    "board.reopen": true,
    "board.personAssignees": true,
    "board.questions": true,
    "board.personCheck": true,
    "workspace.view": true,
    "workspace.preview": true,
    "agent.nativeShell": true,
    "agent.screenshots": true,
    "routines": true,
    "memory": true,
    "memory.embeddings": true,
    "connectors": true,
    "connectors.custom": true,
    "connectors.broker": true,
    "stream.teamChat.resume": true,
    "stream.agentChat.resume": true,
    "stream.events.resume": true,
    "system.selfUpdate": true,
    "system.hold": true,
    "system.idle": true,
    "auth.proxyIdentity": false,
    "auth.appLink": false
  }
}
```

### Feature flags

A flag's name never changes. A feature that goes away reports `false` until the next API revision. The flags describe what the server can do, not the state of the machine: a runtime flag says the server can run that runtime, not that its CLI is installed.

| Flag                                                                        | On when                                                                                                                                                                                                                                                                                                           |
| --------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `runtime.openclaw`                                                          | Always. OpenClaw agents run in an OpenClaw Gateway; whether OpenClaw is installed is in `GET /api/system/status`.                                                                                                                                                                                                 |
| `runtime.clawboo-native`                                                    | Always. Clawboo Native is built in.                                                                                                                                                                                                                                                                               |
| `runtime.claude-code`, `runtime.codex`, `runtime.hermes`                    | The server can run that coding agent. Whether its CLI is installed and signed in is in [`GET /api/runtimes`](/reference/rest-api/runtimes).                                                                                                                                                                       |
| `chat.rooms`                                                                | Always. Chat rooms inside a team (`/api/teams/:id/rooms`).                                                                                                                                                                                                                                                        |
| `chat.direct`                                                               | Always. The server runs 1:1 chats with Clawboo Native, Claude Code, Codex and Hermes agents itself (`/api/agents/:agentId/chat`).                                                                                                                                                                                 |
| `chat.handOffs`                                                             | Always. Boo Zero's 1:1 chat hands work to a team when the server runs it, and its stream sends `board` frames. It has no route of its own.                                                                                                                                                                        |
| `board.verification`                                                        | Always. A task whose stored verification verdict fails cannot reach `done` without a person's override.                                                                                                                                                                                                           |
| `board.reopen`                                                              | Always. `POST /api/board/:taskId/reopen`.                                                                                                                                                                                                                                                                         |
| `board.personAssignees`                                                     | Always. A task can be assigned to a person: `POST /api/board/:taskId/assign-person`.                                                                                                                                                                                                                              |
| `board.questions`                                                           | Always. An agent can ask a person, and a person can answer: `GET /api/board/:taskId/questions`, `POST /api/board/questions/:questionId/answer`.                                                                                                                                                                   |
| `board.checkHold`                                                           | Always. A team-chat work check waits while another run of the team is working in the team folder, and its task carries `checkHeldSince` meanwhile.                                                                                                                                                                |
| `board.reportResult`                                                        | Always. An agent on a team chat run can say how its task went with `report_result`, which moves nothing: the server decides Done.                                                                                                                                                                                 |
| `board.parentWaits`                                                         | Always. A team chat task whose run ends with work it handed out still going waits for it, and gets one follow-up turn.                                                                                                                                                                                            |
| `board.steering`                                                            | Always. A comment on a running task reaches the run, and `POST /api/board/:taskId/comments` answers with how it was delivered.                                                                                                                                                                                    |
| `board.readableIds`                                                         | Always. Tasks carry a readable id, and `/api/teams/:id/task-prefix` reads and sets a team's letters.                                                                                                                                                                                                              |
| `board.labels`                                                              | Always. Team labels (`/api/teams/:id/labels`) and a task's labels (`PUT /api/board/:taskId/labels`).                                                                                                                                                                                                              |
| `board.inbox`                                                               | Always. Read state per task on the server (`/api/board/inbox`, `POST /api/board/:taskId/read`). The event stream says when to read it.                                                                                                                                                                            |
| `board.mainTasks`                                                           | Always. A lead's hand-offs for a person's chat message are filed under one main task, a row with `isMainTask: 1`. See [A person's main task](/reference/rest-api/board#main-tasks).                                                                                                                               |
| `board.wakes`                                                               | Always. A person's comment and a dependency moving to done save a wake that starts the task's agent, one per agent and task, within seconds.                                                                                                                                                                      |
| `board.agentWakes`                                                          | Always. An agent's comment can wake a teammate once a person has allowed it on the job: `POST /api/board/agent-wakes/:jobTaskId`, `/api/team-agent-wakes/:teamId`.                                                                                                                                                |
| `board.jobLimit`                                                            | Always. A job at its limit of runs started by itself waits for a person: `POST /api/board/job-limit/:jobTaskId`.                                                                                                                                                                                                  |
| `board.planDocuments`                                                       | Always. A task's plan as a document, in revisions: `GET /api/board/:taskId/plan`, and `write_plan` for an agent's run.                                                                                                                                                                                            |
| `board.planApproval`                                                        | Always. A team can ask a person before a plan starts: `/api/team-plan-approval/:teamId`.                                                                                                                                                                                                                          |
| `board.personCheck`                                                         | Always. Moves, Retry, Assign, Reopen, approval and question answers, the card about agents waking each other, labels, read marks and a team's work check take a person's authority only from the dashboard's page or a person a sign-in proxy vouched for (see [Security](/operating/security#the-person-check)). |
| `workspace.view`                                                            | Always. The read-only view of a task's worktree: tree, file, diff and status.                                                                                                                                                                                                                                     |
| `workspace.preview`                                                         | Always. The preview of a page a task built (`/api/board/:taskId/preview`).                                                                                                                                                                                                                                        |
| `agent.nativeShell`                                                         | Always. The per-agent switch that lets a Clawboo Native agent ask to run shell commands.                                                                                                                                                                                                                          |
| `agent.screenshots`                                                         | Always. Screenshots of what an agent's browser shows.                                                                                                                                                                                                                                                             |
| `routines`                                                                  | Always. Routines, the scheduler (`/api/schedules`).                                                                                                                                                                                                                                                               |
| `memory`                                                                    | Always. Shared memory: search, save and browse.                                                                                                                                                                                                                                                                   |
| `memory.embeddings`                                                         | Similarity search may run: `false` when `CLAWBOO_DISABLE_EMBEDDINGS=1`. Whether a provider is ready is in `GET /api/memory/provider`.                                                                                                                                                                             |
| `connectors`                                                                | Always. Connectors to outside tools and apps.                                                                                                                                                                                                                                                                     |
| `connectors.custom`                                                         | Always. Custom connectors that point at a server of your own.                                                                                                                                                                                                                                                     |
| `connectors.broker`                                                         | Always. Apps connected through one broker key (`/api/connectors/composio`).                                                                                                                                                                                                                                       |
| `stream.teamChat.resume`, `stream.agentChat.resume`, `stream.events.resume` | Always. The team chat stream, the 1:1 chat stream and the event stream each resume from `Last-Event-ID`.                                                                                                                                                                                                          |
| `system.selfUpdate`                                                         | `POST /api/system/self-update` can succeed here: a global npm install this user can write, with in-app updates not turned off. The same answer as `self-version`'s `applyable`.                                                                                                                                   |
| `system.hold`                                                               | Always. The server can be held before a stop or an update (`/api/system/hold`), and the in-app update waits for agent runs before it restarts.                                                                                                                                                                    |
| `system.idle`                                                               | Always. A host that stops this server when nobody is using it reads `GET /api/system/idle`, and the dashboard reports a person with `POST /api/system/presence`.                                                                                                                                                  |
| `board.pause`                                                               | Always. A person can pause an agent, a team or a task tree until they resume it (`/api/pauses`).                                                                                                                                                                                                                  |
| `auth.proxyIdentity`                                                        | An administrator turned the [proxy identity lane](/guides/sso-proxy) `on` or `required`: a sign-in proxy's signed identity tokens are checked, and the person each names is recorded. `GET /api/access/identity` says which mode, and who the request is.                                                         |
| `auth.appLink`                                                              | The app that started this server, such as the desktop app, gave it a key (`CLAWBOO_APP_LINK_PUBLIC_KEY`): the tokens it signs for its own `account:` people are checked, and each person is recorded. See [An app that starts Clawboo](/guides/sso-proxy#an-app-that-starts-clawboo).                             |

### For client authors

The workspace package `@clawboo/control-client` (in the repository, not published to npm) exports `engineCapabilitiesSchema` (zod), `fetchEngineCapabilities()`, `engineHasFeature()`, `engineSupportsClient()`, `RESUMABLE_STREAMS`, the schema of every event on the three resumable streams, and `engineHoldStateSchema`, the answer of the hold routes. A server older than this route answers `404` in development and the dashboard page (HTML, `200`) once built; `fetchEngineCapabilities()` returns `null` for both.

The contract test `apps/web/server/api/__tests__/clientContract.test.ts` pins this answer, every route and method, the hold routes' answer, and the stream events. It fails when one is removed or renamed without raising `apiRevision`.

### Example

```bash
curl http://localhost:18790/api/system/capabilities
```

---

## `POST /api/system/self-update`

Installs `clawboo@latest` globally and restarts the server into it, without cutting off an agent run. Streams **Server-Sent Events**. The request body is optional: `{ "force": true }` restarts without waiting for agent runs.

Only a `global` install can update itself. An `npx` run lives in npm's `_npx` cache, so a global install lands somewhere the running copy cannot reach, and a dev checkout never updates itself. A global install whose package folder, the folder holding it, or the prefix's `bin` folder (where npm links the `clawboo` command) the server's user cannot write is refused too, as is any install whose administrator turned in-app updates off. Each gets one `unsupported` event naming the reason and the command to run instead (the chip hides its button in those cases anyway).

| `reason`       | Why                                                                                   |
| -------------- | ------------------------------------------------------------------------------------- |
| `disabled`     | `CLAWBOO_DISABLE_SELF_UPDATE` or the operator settings file turned in-app updates off |
| `npx`          | An npx run                                                                            |
| `dev`          | A source checkout                                                                     |
| `not-writable` | The server's user cannot write the install, so `npm install -g` would fail or diverge |

### Waiting for agent runs

An update holds the server from its first event, under the owner id `self-update` (see [Drain and hold](#drain-and-hold)), so no new agent run starts while npm installs. An install that takes longer than 5 minutes stops holding, so a stalled npm does not keep agent work waiting; the update holds again once the install lands. Once the new version is installed, the server waits for the agent runs already going, then restarts. It waits at most 10 minutes; at that bound it restarts anyway, which interrupts the runs still going. While it waits it sends a `progress` event with `step: 'waiting'` each time the number of runs changes, and a `: keepalive` comment every 15 seconds, so a proxy does not close a quiet stream. A browser that disconnects during the wait does not cancel the restart, because the new version is already on disk. An update that ends without a restart (a failed install, or `installed-elsewhere`) releases its hold, and one refused with `unsupported` never holds.

`{ "force": true }` skips the wait. Sent with a new update, the server restarts as soon as the install lands. Sent while an update is waiting, it makes that update restart now and answers with one `forced` event; the waiting update's own stream then reports `restarting`. The update chip's **Restart now** button sends it. One update runs at a time: a second request without `force` gets an `error` event with `code: 'IN_PROGRESS'`.

### Event stream

| `type`                | When                                                                                                                   | Payload fields                                                                 |
| --------------------- | ---------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| `unsupported`         | The update cannot run here (see `reason` above)                                                                        | `method`, `reason`, `command`, `message`                                       |
| `progress`            | Install start                                                                                                          | `step: 'installing'`, `message`                                                |
| `output`              | Each non-empty line of npm output                                                                                      | `line`                                                                         |
| `error`               | A spawn failure, or npm exits non-zero; at most one per stream                                                         | `code`, `message`, and on a non-zero exit `exitCode` and `detail`              |
| `installed-elsewhere` | npm exited 0 but the on-disk version did not change, the API port is unknown, or the server cannot start its successor | `version`, `message`                                                           |
| `installed`           | npm exited 0 and the on-disk version changed                                                                           | `version`                                                                      |
| `progress`            | Installed, and agent runs are still going (see above)                                                                  | `step: 'waiting'`, `running`, `message`                                        |
| `restarting`          | Just before the new server starts                                                                                      | `port`, `version`, `interruptedRuns` (runs still going, `0` after a full wait) |
| `forced`              | This request made an update that was waiting restart now                                                               | `message`                                                                      |

| `code`        | Meaning                                                                                  |
| ------------- | ---------------------------------------------------------------------------------------- |
| `IN_PROGRESS` | An update is already running, and this request did not ask for `force`                   |
| `EACCES`      | npm's output named `EACCES`, `EPERM` or "permission denied": the install needs elevation |
| npm's code    | npm printed its own code (`ETARGET`, `ENOTFOUND`, ...)                                   |
| `EXIT_<code>` | A non-zero npm exit that printed no code of its own (e.g. `EXIT_7`)                      |
| `SPAWN_THROW` | The spawn call threw                                                                     |
| `SPAWN_ERROR` | The child process emitted an error                                                       |

On a non-zero exit, `detail` is npm's own reason in one line (the `Error:` line, or the first line of its error block, or the name of a package whose install script failed), and `message` leads with it, so the chip shows why rather than only an exit code. `detail` is `null` when npm's output named no reason.

npm runs in a working directory that exists, because npm exits with code 7 when its working directory has been deleted.

After `restarting`, the server starts a new server on the same port (`CLAWBOO_API_PORT`), told to wait until that port is free (`CLAWBOO_AWAIT_PORT`), and then exits so the new one can bind. The new server starts in a working directory that exists, and a server that does start in a deleted directory moves into the Clawboo directory before it loads anything. `CLAWBOO_VERSION` is removed from its environment, so it reads its version from the newly installed package. It starts with the old server's node options (`process.execArgv`, such as `--max-old-space-size=4096`), except the inspector's, whose port the old server still holds. The browser keeps polling the same address and reloads when the new server answers. The browser polls `GET /api/system/capabilities` and reloads once a server on a different version answers.

<Note>

`installed-elsewhere` means the global install landed somewhere this running copy does not point at, so a restart would run the old code again. The server stays up and asks you to restart it yourself.

</Note>

From a terminal, run the `updateCommand` that `self-version` reports, then `clawboo restart` (see the [CLI reference](/reference/cli)).

### Example

```bash
curl -N -X POST http://localhost:18790/api/system/self-update

# While an update waits for agent runs: restart now
curl -N -X POST http://localhost:18790/api/system/self-update \
  -H 'Content-Type: application/json' -d '{"force": true}'
```

---

## Drain and hold

Anything that stops or restarts the server can first ask it to hold: `clawboo stop`, `clawboo restart`, a desktop app's updater, a process manager's stop script. A held server starts no new agent run, and the runs already going carry on to their end. The caller waits until `backgroundWork` is `none`, then stops the server, so no agent is cut off halfway through.

While the server is held:

- A run that would start waits instead, in the same queue that holds runs back when [`CLAWBOO_MAX_CONCURRENT_RUNS`](/reference/environment-variables) is reached. That covers board task runs, team chat turns, 1:1 chat turns with Clawboo Native, Claude Code, Codex and Hermes agents, the turns of a peer exchange and Routine runs on any runtime. A run that is waiting is not failed and does not count against any time limit.
- Clawboo's Routines scheduler fires nothing. A Routine that falls due stays due and fires once the hold lifts, or after the next start.
- Team chat claims no board task. A task agents hand each other stays in To do instead of waiting `in_progress`, and the board's dispatch pump, which starts those tasks, skips its pass.

When the last hold is released or lapses, the waiting runs start in the queue's order, the scheduler checks for due Routines and the pump runs a pass, which starts the tasks left in To do.

The hold covers the runs this server starts. A 1:1 chat with an OpenClaw agent, and OpenClaw's own scheduled jobs and messaging channels, run inside the OpenClaw Gateway: they are neither held nor counted in `backgroundWork`, and stopping the server does not stop them.

A hold belongs to the owner id its caller picks, and only that id releases it. Each hold lapses after its time to live, 60 seconds unless the caller asks for another, so a caller that crashes cannot leave the server held. To hold for longer, place the hold again before it lapses: that renews it. Several callers can each hold at once; the server stays held until every hold is gone. Holds live in memory, so a restart clears them.

A typical stop:

1. `POST /api/system/hold` with your owner id.
2. Poll `GET /api/system/hold` until `backgroundWork` is `none`. Place the hold again every 20 seconds or so while you wait. Give up at a bound of your own.
3. Stop the server. To cancel instead, `DELETE /api/system/hold/<owner>`.

Runs waiting to start when the server stops do not run. Tasks agents handed to each other are picked up again after the next start, as after any restart; a chat message or a task run a person started during the hold has to be started again. A routine fire that had already begun and was waiting for a free run slot counts as cut off: a recurring routine waits for its next time and a one-time routine stops with an error, as after any restart in the middle of a fire (`work.routinesInFlight` on `GET /api/system/idle` ([Sleep and wake](#sleep-and-wake)) counts these fires).

### `GET /api/system/hold`

- **Path/query params**: none.
- **Request body**: none.

**`200 OK`**:

| Field            | Type                  | Notes                                                                                                                                         |
| ---------------- | --------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| `held`           | `boolean`             | `true` while any hold is live: no new agent run starts                                                                                        |
| `holds`          | `object[]`            | The live holds, oldest first (below)                                                                                                          |
| `backgroundWork` | `'present' \| 'none'` | `present` while an agent run or a team chat's work check is going or waiting its turn; `none` when stopping the server now cuts neither short |
| `runs.running`   | `number`              | Agent runs going now                                                                                                                          |
| `runs.queued`    | `number`              | Runs waiting to start. While the server is held they do not start, so `backgroundWork` does not count them                                    |
| `runs.limit`     | `number`              | How many runs may go at once (`CLAWBOO_MAX_CONCURRENT_RUNS`, default 8)                                                                       |

Each entry in `holds`:

| Field         | Type             | Notes                                                                       |
| ------------- | ---------------- | --------------------------------------------------------------------------- |
| `owner`       | `string`         | The owner id that placed it, and the only one that releases it              |
| `reason`      | `string \| null` | What its caller said it is for (`stop`, `restart`, `update`), or `null`     |
| `heldAt`      | `number`         | Epoch ms on the server's clock when the owner placed it; a renewal keeps it |
| `expiresAt`   | `number`         | Epoch ms when it lapses unless renewed                                      |
| `expiresInMs` | `number`         | Time left on the server's clock, for a caller whose clock differs           |

```json
{
  "held": true,
  "holds": [
    {
      "owner": "clawboo-stop-48213",
      "reason": "stop",
      "heldAt": 1793782800000,
      "expiresAt": 1793782860000,
      "expiresInMs": 41250
    }
  ],
  "backgroundWork": "present",
  "runs": { "running": 2, "queued": 1, "limit": 8 }
}
```

### `POST /api/system/hold`

Holds the server, or renews the hold this owner already placed. Body:

| Field        | Type     | Required | Notes                                                                                                                                                          |
| ------------ | -------- | -------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `owner`      | `string` | Yes      | 1 to 128 letters, digits or `.` `_` `:` `@` `-`, starting with a letter or digit. Pick one per caller. `self-update` is the in-app update's own and is refused |
| `ttlSeconds` | `number` | No       | How long the hold lives unless renewed: a whole number from 5 to 900. Default 60                                                                               |
| `reason`     | `string` | No       | Up to 200 characters, shown in `holds`. A renewal that leaves it out keeps the one given before                                                                |

| Status | When                          | Body                                   |
| ------ | ----------------------------- | -------------------------------------- |
| `200`  | Held, or the hold was renewed | The same answer as `GET`               |
| `400`  | A field failed the checks     | `{ "error": "<which field and why>" }` |

### `DELETE /api/system/hold/:owner`

Releases the hold `owner` placed. No other owner's hold is touched.

| Status | When                                                                     | Body                                                                                                   |
| ------ | ------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------ |
| `200`  | Released                                                                 | The same answer as `GET`                                                                               |
| `403`  | `self-update`, the in-app update's own hold, which ends with the update  | `{ "error": "self-update is the in-app update's own hold. It ends with the update." }`                 |
| `404`  | That owner holds no hold: it never placed one, released it, or it lapsed | `{ "error": "No hold is placed under that owner id. Only the owner that placed a hold releases it." }` |

### Example

```bash
# Hold for two minutes before a stop
curl -X POST http://localhost:18790/api/system/hold \
  -H 'Content-Type: application/json' \
  -d '{"owner": "my-stop-script", "ttlSeconds": 120, "reason": "stop"}'

# Is an agent run still going?
curl http://localhost:18790/api/system/hold

# Changed your mind: let the server start new work again
curl -X DELETE http://localhost:18790/api/system/hold/my-stop-script
```

---

## Sleep and wake

A host can stop the server when nobody is using it and start it again when it is needed: a process supervisor, a service manager, a desktop app, or a computer that sleeps when idle. Before it stops the server it needs three answers, and `GET /api/system/idle` gives all three in one read:

- **Is a person here?** Not "is anything asking". An open board polls the API dozens of times a minute whether or not anyone is looking at it, so request traffic says nothing about people. A person counts as here for 60 seconds after either of these:
  - **A presence beat** a client sends on purpose (`POST /api/system/presence`, below). The dashboard sends one every 20 seconds while its tab is visible and focused and someone has touched the page (or switched to it) in the last 15 minutes, and one more as that stops. A hidden or background tab sends nothing.
  - **Something a person does**, seen by the server from any client (the dashboard, the API, a linked device): answering an approval or an agent's question, sending a chat message or a comment, and creating, moving, retrying, reopening, assigning, stopping or pausing work, or pressing **Run now**. Beyond those, any other write the [identity lane](/guides/sso-proxy) names a person on counts too, except the automatic writes listed below.

  A read never counts, whoever sent it, and neither does a request just because a sign-in proxy or an app link vouched for it: a proxy vouches for everything it forwards, a background tab's polling included.

- **Is work going?** The same answer as `GET /api/system/hold` ([Drain and hold](#drain-and-hold)): `backgroundWork` is `present` while an agent run or a team chat's work check is going. `routinesInFlight` counts routine fires that have begun.
- **When is scheduled work next due?** The earliest next run across every schedule: Clawboo's own routines, the cron jobs of an OpenClaw Gateway on this machine, and the jobs of a Hermes gateway Clawboo runs. Wake the server a minute before it.

A typical idle stop:

1. Read `GET /api/system/idle` every 30 seconds or so.
2. Wait until `people.present` has been `false`, `work.backgroundWork` has been `none` and `work.routinesInFlight` has been `0` for as long as you like (a few minutes; `people.lastSeenAt` and `people.lastActedAt` let you measure your own window). Compare times with `at`, the server's own clock, rather than yours: a virtual machine's clock can fall behind after a sleep.
3. Drain the server as in [Drain and hold](#drain-and-hold), note `nextDue.at`, and stop it.
4. Start it again a minute before `nextDue.at`, or when a person asks for it. When `nextDue.complete` is `false`, a source could not be read and something may be due sooner, so pick a shorter bound of your own.

A routine whose time passed while the server was stopped runs once when the server starts again, then carries on with its schedule. Missed times are not made up, so waking late costs one run, not one per missed time. See [How routines run](/concepts/scheduling#missed-and-overlapping-runs).

### What the dashboard sends on its own

So a host can check its idle rule against them, these are the requests an open dashboard sends without anyone doing anything. None of them counts as a person.

Writes. Several of these routes are also used when a person does something (saving a file, creating a team); they never count either, because the server cannot tell the two apart.

| Request                                                                                                                                                              | When                                                                                                           |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| `POST /api/system/presence`                                                                                                                                          | The presence beat itself                                                                                       |
| `POST /api/graph-layout`                                                                                                                                             | After each automatic graph layout, page load included, and when nodes are moved to fit                         |
| `POST /api/agents/sync`, `PUT /api/boo-zero/display-name/:agentId`, `PUT /api/agents/:agentId/files/:name`                                                           | On each OpenClaw Gateway connect, page load included; the last also when an editor with unsaved changes closes |
| `POST /api/teams`, `POST /api/teams/:id/agents`, `DELETE /api/teams/:id/agents/:agentId`, `PATCH /api/teams/:id`                                                     | On a Gateway connect or a team list load, when agents need a team or a team's colour needs fixing              |
| `POST /api/board/inbox/read`, `POST /api/board/:taskId/read`                                                                                                         | As a view opens, marking what it shows as read                                                                 |
| `POST /api/agents/:agentId/screenshot/capture`                                                                                                                       | When a browser card opens, or picks another agent by itself                                                    |
| `POST /api/settings`                                                                                                                                                 | Once, when the first-run note sees a finished task                                                             |
| `POST /api/cost-records`, `POST /api/chat-history`                                                                                                                   | Records kept from the Gateway's events                                                                         |
| `POST /api/access/launch-code`, `POST /api/system/auto-configure-openclaw`, `POST /api/system/install-openclaw`, `POST /api/system/gateway`, `POST /api/personality` | As a dialog or setup panel opens, or a personality edit is left                                                |
| `POST /api/connectors/:slug/authorize/await`, `POST /api/providers/:id/models`                                                                                       | A sign-in's long wait, and a model list fetched as you stop typing                                             |
| `POST /api/system/hold`, `DELETE /api/system/hold/:owner`                                                                                                            | Never sent by the dashboard; a stop script's                                                                   |

Reads, which never count anyway. While its tab is visible the dashboard polls, depending on what is open: pending approvals and an agent's latest browser frame every 3 seconds; the board, the run graph's health and the budgets every 5 seconds; runtimes, fleet health and routines every 8 seconds; system status, previews and a task's workspace every 10 seconds; workspaces and an agent's routines every 15; routine runs, System Health and runtimes every 30; the memory provider every 2 to 30; brokered apps every 60 to 120. A hidden tab polls nothing, except that with background alerts on it reads the board and pending approvals when something happens. Event streams stay open: `GET /api/obs/stream` from every open dashboard, hidden or not, and the chat streams of an open chat.

### `GET /api/system/idle`

- **Path/query params**: none.
- **Request body**: none.
- Answers with `Cache-Control: no-store`. Reading it writes nothing and starts nothing.

**`200 OK`**:

| Field                   | Type                                                                                                                           | Notes                                                                                                               |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------- |
| `at`                    | `number`                                                                                                                       | The server's clock when it answered, epoch ms                                                                       |
| `people.present`        | `boolean`                                                                                                                      | A visible, focused tab beat, or something a person did (see above), within the last 60 seconds                      |
| `people.lastSeenAt`     | `number \| null`                                                                                                               | The latest focused-tab beat or action, epoch ms; `null` when none since the server started                          |
| `people.lastActedAt`    | `number \| The latest action: a beat's `acted`, or something a person did. Epoch ms; `null` when none since the server started |
| `people.focusedTabs`    | `number`                                                                                                                       | Tabs whose latest beat said visible and focused                                                                     |
| `work.backgroundWork`   | `'present' \| 'none'`                                                                                                          | As on `GET /api/system/hold`: `none` when stopping now cuts no agent run or work check short                        |
| `work.runs`             | `object`                                                                                                                       | `running`, `queued` and `limit`, as on `GET /api/system/hold`                                                       |
| `work.checks`           | `number`                                                                                                                       | Team chat work checks going, or waiting for the team folder                                                         |
| `work.routinesInFlight` | `number`                                                                                                                       | Routine fires under way: claimed, or started and not finished                                                       |
| `work.held`             | `boolean`                                                                                                                      | `true` while a hold is placed                                                                                       |
| `nextDue.at`            | `number \| null`                                                                                                               | The earliest next run any source named, epoch ms. At or before `at` means due now. `null` when nothing is scheduled |
| `nextDue.complete`      | `boolean`                                                                                                                      | `false` when a source is `unknown`: something may be due sooner than `nextDue.at`                                   |
| `nextDue.timeZone`      | `string`                                                                                                                       | The time zone routines are worked out in                                                                            |
| `nextDue.sources`       | `object[]`                                                                                                                     | One entry per schedule source (below)                                                                               |

Each entry in `nextDue.sources`:

| Field      | Type                         | Notes                                                                                                                                                                                                                              |
| ---------- | ---------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `id`       | `string`                     | `clawboo-routine` for Clawboo's routines, `openclaw-gateway-cron` for the OpenClaw Gateway's own cron jobs, `hermes-gateway-jobs` for a Hermes gateway's jobs                                                                      |
| `state`    | `'ok' \| 'off' \| 'unknown'` | `ok`: read now. `off`: not in use, so nothing is due from it. `unknown`: in use but not readable now, such as a Gateway still connecting in the seconds after a start, or one that is set up and stopped                           |
| `at`       | `number \| null`             | Its earliest next run. For an `unknown` source, the earliest it reported before, if that is still ahead                                                                                                                            |
| `count`    | `number`                     | Schedules with a next run                                                                                                                                                                                                          |
| `timeZone` | `string \| null`             | The zone its earliest time was worked out in, when the source says: the routines' zone, or a Gateway job's own. `null` for a fixed interval or time, or a source that leaves it to its own system. Every `at` is epoch ms          |
| `reason`   | `string`                     | Why it is `off` or `unknown`, for example `not_configured` (nothing set up), `remote` (the Gateway runs on another machine, so its jobs run whether or not this server sleeps), `gateway_disconnected`, `stale_cache` or `timeout` |

What counts as due, for Clawboo's routines: a routine waiting for its next time, and one that is due and not yet fired (its time passed, or someone pressed **Run now**). A paused routine, one stopped after a failure, a spent one-time routine, one on an archived team, and one whose agent or team is paused are not counted: they do not run until a person acts, and a person acting brings the server up anyway. A routine that is running is work, not due. For the Gateway's cron jobs: enabled jobs with a next run.

```json
{
  "at": 1793782800000,
  "people": {
    "present": false,
    "lastSeenAt": 1793782500000,
    "lastActedAt": 1793782440000,
    "focusedTabs": 0
  },
  "work": {
    "backgroundWork": "none",
    "runs": { "running": 0, "queued": 0, "limit": 8 },
    "checks": 0,
    "routinesInFlight": 0,
    "held": false
  },
  "nextDue": {
    "at": 1793786400000,
    "complete": true,
    "timeZone": "Europe/London",
    "sources": [
      {
        "id": "clawboo-routine",
        "state": "ok",
        "at": 1793786400000,
        "count": 3,
        "timeZone": "Europe/London"
      },
      {
        "id": "openclaw-gateway-cron",
        "state": "off",
        "at": null,
        "count": 0,
        "timeZone": null,
        "reason": "not_configured"
      }
    ]
  }
}
```

### `POST /api/system/presence`

A client says whether a person is at it. Send one beat when that changes and every 20 seconds while a person is there; a beat counts for 60 seconds. Each client names its own tab or window with a `tabId`, so its later beats replace its earlier ones.

| Field     | Type      | Required | Notes                                                                                                |
| --------- | --------- | -------- | ---------------------------------------------------------------------------------------------------- |
| `tabId`   | `string`  | Yes      | 1 to 64 letters, digits, `_` or `-`, chosen by the client                                            |
| `visible` | `boolean` | Yes      | The tab or window is on screen                                                                       |
| `focused` | `boolean` | Yes      | It has focus. Only a beat with both `true` counts as a person                                        |
| `acted`   | `boolean` | No       | The person did something since the last beat; it counts for 60 seconds, even after the tab goes away |

| Status | When                      | Body                                   |
| ------ | ------------------------- | -------------------------------------- |
| `200`  | Taken                     | `people`, as in `GET /api/system/idle` |
| `400`  | A field failed the checks | `{ "error": "<which field and why>" }` |

Presence lives in memory, so a server that just started has seen nobody until the next beat.

### Example

```bash
# Is anyone here, is anything running, and when must the server be up next?
curl http://localhost:18790/api/system/idle

# A client with a person at it
curl -X POST http://localhost:18790/api/system/presence \
  -H 'Content-Type: application/json' \
  -d '{"tabId": "phone-1", "visible": true, "focused": true, "acted": true}'
```

---

## `GET /api/system/operator-settings`

The settings an administrator can pin for everyone on this install, with the value in force and where it comes from. The **Deployment** card in **Settings** > **System** reads it. [Pin settings for everyone](/operating/deployment#pin-settings-for-everyone) explains the file.

### Responses

`200` with `{ "settings": [...] }`, one entry per key, in this order: `disableSelfUpdate`, `disableBrowserAutostart`, `catalogIndexUrl`, then the ten [proxy identity](/guides/sso-proxy#settings) keys from `proxyIdentity` to `proxyIdentityRoleClaim`.

| Field          | Type                                             | Notes                                                                                                               |
| -------------- | ------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------- |
| `key`          | `string`                                         | The operator settings file key                                                                                      |
| `value`        | `boolean \| string \| number \| null`            | The value in force. `catalogIndexUrl` is `null` when the default applies                                            |
| `source`       | `'environment' \| 'file' \| 'user' \| 'default'` | Where the value comes from: the key's variable, the operator file, a value saved from the dashboard, or the default |
| `pinned`       | `boolean`                                        | `true` when `source` is `environment` or `file`. The dashboard shows "Set by your administrator"                    |
| `userEditable` | `boolean`                                        | Whether `PUT` accepts a value for this key while it is not pinned                                                   |
| `env`          | `string`                                         | The key's environment variable                                                                                      |

### Example

```bash
curl http://localhost:18790/api/system/operator-settings
```

---

## `PUT /api/system/operator-settings/:key`

Saves a value for a key the dashboard offers, today only `disableBrowserAutostart`. There is one value per install, so it applies to everyone who uses it. It never writes the operator file. Body: `{ "value": true }` or `{ "value": false }`.

### Responses

| Status | When                                                                      | Body                                                                     |
| ------ | ------------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| `200`  | Saved                                                                     | `{ "setting": <entry> }`, the value now in force                         |
| `400`  | `value` is not a boolean                                                  | `{ "error": "value must be true or false." }`                            |
| `403`  | A key only an administrator sets (`disableSelfUpdate`, `catalogIndexUrl`) | `{ "error": "This setting can only be set by an administrator." }`       |
| `404`  | An unknown key                                                            | `{ "error": "Unknown setting." }`                                        |
| `409`  | The key is pinned by its variable or the operator file                    | `{ "error": "<key> is set by your administrator.", "setting": <entry> }` |

### Example

```bash
curl -X PUT http://localhost:18790/api/system/operator-settings/disableBrowserAutostart \
  -H 'Content-Type: application/json' -d '{"value": true}'
```

---

## Error envelope

Errors use the standard `{ "error": string }` body. `approve-device` adds `details` on its 404 and `requestId` on the 500 from the approval command. `GET /api/system/models` never returns an error status; it falls back to a `200` with a `null` catalog. The SSE routes report failures as `error` frames once the stream is open. Going over a rate limit answers **429** with `{ "error": "Too many requests. Wait a moment and retry." }` (general) or `{ "error": "Too many requests for this operation. Wait a moment and retry." }` (sensitive), plus a `Retry-After` header.

**Source of truth:** `apps/web/server/api/system.ts`, `systemUpdate.ts`, `systemCapabilities.ts`, `systemHold.ts` and `operatorSettings.ts`; the hold in `apps/web/server/lib/engineHold.ts` and the run queue it gates in `apps/web/server/lib/runSlots.ts`; the version check in `apps/web/server/lib/updateCheck.ts`; the feature flags in `apps/web/server/lib/engineCapabilities.ts`; pinned settings in `apps/web/server/lib/operatorSettings.ts`; key files in `apps/web/server/lib/openclawEnv.ts`.

## Related

- [OpenClaw](/runtimes/openclaw): set up OpenClaw, the Gateway and device pairing in the dashboard.
- [System](/using/system): Gateway control and OpenClaw settings in the **System** panel.
- [System Health](/using/system-health): the start-up checks behind `/api/health`.
- [Settings API](/reference/rest-api/settings): the saved Gateway URL and token these routes write.
- [Runtimes API](/reference/rest-api/runtimes): Clawboo Native, Claude Code, Codex and Hermes.
- [REST API overview](/reference/rest-api/index): authentication, rate limits and conventions.
