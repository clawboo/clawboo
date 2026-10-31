---
title: 'Environment variables'
description: 'Every environment variable Clawboo reads or sets, with its type, default, effect and an example, from HOST and STUDIO_ACCESS_TOKEN to tuning timers.'
keywords:
  [
    'env vars',
    'CLAWBOO_HOME',
    'STUDIO_ACCESS_TOKEN',
    'HOST',
    'CLAWBOO_BASE_PATH',
    'OLLAMA_BASE_URL',
    'OTEL_EXPORTER_OTLP_ENDPOINT',
    'HOSTNAME',
  ]
---

These are the environment variables Clawboo's own code reads, and the ones it sets on programs it starts. Set them in the shell or service that runs `clawboo`. The server reads most of them once at startup, so run `clawboo restart` after a change.

Durations are in milliseconds, and an unset, empty or non-numeric duration means the default. Each variable's section below says how it handles other values. Agent runtimes and OpenClaw read variables of their own, which this page does not cover.

| Variable                               | Default                           | What it does                                                 |
| -------------------------------------- | --------------------------------- | ------------------------------------------------------------ |
| **Access and network**                 |                                   |                                                              |
| `HOST`                                 | `127.0.0.1`                       | Address the dashboard listens on                             |
| `STUDIO_ACCESS_TOKEN`                  | unset                             | Turns on the access gate for `/api/*`                        |
| `CLAWBOO_ALLOW_INSECURE`               | unset                             | Allows a wide bind with no token                             |
| `CLAWBOO_ALLOWED_ORIGINS`              | loopback only                     | Extra browser origins allowed to call the API                |
| `CLAWBOO_ALLOWED_HOSTS`                | loopback and the bind host        | Extra `Host` header values the server accepts                |
| `CLAWBOO_BASE_PATH`                    | unset (root)                      | Serves the whole app under a URL prefix                      |
| `CLAWBOO_SECRETS_MASTER_KEY`           | generated key file                | Key that encrypts saved provider keys                        |
| **Ports**                              |                                   |                                                              |
| `CLAWBOO_API_PORT`                     | unset (scan from 18790)           | Exact port for the dashboard                                 |
| `CLAWBOO_API_PORT_START`               | `18790`                           | First port of the 20-port scan                               |
| `PORT`                                 | unset                             | Hosting-platform port, used when `CLAWBOO_API_PORT` is unset |
| **Folders**                            |                                   |                                                              |
| `CLAWBOO_HOME`                         | `~/.clawboo`                      | Folder for everything Clawboo stores                         |
| `OPENCLAW_STATE_DIR`                   | `~/.openclaw`                     | OpenClaw's folder, which Clawboo reads and writes            |
| `CLAWBOO_DB_PATH`                      | `~/.openclaw/clawboo/clawboo.db`  | Database file for the MCP stdio bins only                    |
| `CLAWBOO_UI_DIR`                       | `<server folder>/ui`              | Built dashboard files the server serves                      |
| `CLAWBOO_CATALOG_INDEX_URL`            | GitHub raw URL                    | Where the marketplace catalog comes from                     |
| **Provider keys**                      |                                   |                                                              |
| `ANTHROPIC_API_KEY`                    | unset                             | Claude Code, Clawboo Native (Anthropic), Hermes              |
| `OPENAI_API_KEY`                       | unset                             | Clawboo Native (OpenAI), Hermes, memory embeddings           |
| `OPENROUTER_API_KEY`                   | unset                             | Hermes, Clawboo Native (OpenRouter)                          |
| `GEMINI_API_KEY` and six more          | unset                             | Clawboo Native through OpenAI-compatible providers           |
| `OLLAMA_BASE_URL`                      | `http://localhost:11434/v1`       | Ollama address for Clawboo Native and OpenClaw setup         |
| `TAVILY_API_KEY`                       | unset                             | Shows the `web_search` built-in tool                         |
| `COMPOSIO_BASE_URL`                    | `https://backend.composio.dev`    | Composio API address for brokered apps                       |
| **Runs and verification**              |                                   |                                                              |
| `CLAWBOO_RUN_SILENT_TIMEOUT_MS`        | `1800000` (30 min)                | Silence after which a run is stopped                         |
| `CLAWBOO_HOME_MUTEX_ACQUIRE_MS`        | `600000` (10 min)                 | Wait for the same agent's previous run                       |
| `CLAWBOO_MAX_FIX_CYCLES`               | `1`                               | Retries after a failed verification                          |
| `CLAWBOO_REVIEWER_MODEL`               | the builder's model               | Model for the verification reviewer                          |
| `CLAWBOO_ROUTINE_OPENCLAW_TIMEOUT_MS`  | `600000` (10 min)                 | Wait for an OpenClaw agent's Routine run                     |
| **Board timing**                       |                                   |                                                              |
| `CLAWBOO_BOARD_STALE_TTL_MS`           | `180000` (3 min)                  | Missed heartbeats before a running task is released          |
| `CLAWBOO_BOARD_STALE_SWEEP_MS`         | `60000` (1 min)                   | How often that check runs                                    |
| `CLAWBOO_DISPATCH_PUMP_MS`             | `60000` (1 min)                   | How often waiting delegated work is woken                    |
| `CLAWBOO_DB_WRITE_BUDGET_MS`           | `1500`                            | Retry time for a busy database write                         |
| **Approvals and retention**            |                                   |                                                              |
| `CLAWBOO_APPROVAL_TTL_MS`              | `86400000` (24 h)                 | Age at which the reaper expires a forgotten approval         |
| `CLAWBOO_APPROVAL_REAPER_INTERVAL_MS`  | `3600000` (1 h)                   | How often the reaper runs                                    |
| `CLAWBOO_TOOL_RESULT_TTL_MS`           | `604800000` (7 days)              | How long stored large tool results are kept                  |
| **Memory, browsers and MCP**           |                                   |                                                              |
| `CLAWBOO_DISABLE_EMBEDDINGS`           | unset                             | `1` turns memory embeddings off                              |
| `CLAWBOO_MAX_AGENT_BROWSERS`           | `4`                               | Agent browsers open at once                                  |
| `CLAWBOO_AGENT_BROWSER_IDLE_MS`        | `600000` (10 min)                 | Idle time before an agent browser closes                     |
| `CLAWBOO_OPENCLAW_CDP_PORT`            | `18800`                           | Debugging port of OpenClaw's browser                         |
| `OPENCLAW_GATEWAY_PORT`                | `18789`                           | Only used to work out that debugging port                    |
| `CLAWBOO_MCP_PROBE_MS`                 | `60000` (1 min)                   | How often the server checks its MCP servers                  |
| **Logging and tracing**                |                                   |                                                              |
| `LOG_LEVEL`                            | `info`                            | Server log level                                             |
| `NODE_ENV`                             | unset (the CLI sets `production`) | `production` writes JSON logs                                |
| `OTEL_EXPORTER_OTLP_ENDPOINT`          | unset                             | Exports traces over OTLP                                     |
| `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT`   | unset                             | Traces-only OTLP endpoint                                    |
| `OTEL_SERVICE_NAME`                    | `clawboo`                         | Service name on exported traces                              |
| **Read from other tools**              |                                   |                                                              |
| `CODEX_HOME`                           | `~/.codex`                        | Where Clawboo looks for your `codex login`                   |
| `HERMES_HOME`                          | `~/.hermes`                       | Where Clawboo looks for your Hermes sign-in                  |
| `CLAUDE_CODE_USE_BEDROCK`              | unset                             | Keeps AWS keys for runtimes Clawboo starts                   |
| `HTTP_PROXY` and other proxy variables | unset                             | Clawboo keeps its own loopback traffic off the proxy         |
| **Testing and development**            |                                   |                                                              |
| `CLAWBOO_ENABLE_MOCK_RUNTIME`          | unset                             | `1` adds a fault-injection test runtime                      |
| `CLAWBOO_SERVER_PATH`                  | found automatically               | Source checkout the CLI starts in development                |

`HOSTNAME`, `OPENCLAW_CONFIG_PATH`, `CLAWBOO_API_URL` and `GATEWAY_AUTH_TOKEN` (outside a `${...}` template) are not read. Variables Clawboo sets on the processes it starts are listed under [Set by Clawboo](#set-by-clawboo).

## Access and network

### HOST

The network address the dashboard listens on.

- Type: hostname or IP address
- Default: `127.0.0.1`, so only this machine can connect
- Example: `HOST=0.0.0.0`

Any address other than loopback (`localhost`, `127.x.x.x`, `::1`) exposes the dashboard to your network. The server then refuses to start, exiting with code 1, unless `STUDIO_ACCESS_TOKEN` holds a valid token or `CLAWBOO_ALLOW_INSECURE=1` is set. Prefer `0.0.0.0` to a single LAN address: Clawboo's own agents reach its MCP servers at `127.0.0.1`, which a single-address bind does not answer. A wide bind without `CLAWBOO_ALLOWED_ORIGINS` also logs a warning that browsers on other machines will be blocked.

`HOSTNAME` is ignored. Docker, systemd and many CI runners set it automatically, so widening the bind always takes an explicit `HOST`. [Self-host securely](/guides/self-host-securely) walks through reaching Clawboo from another machine.

### STUDIO_ACCESS_TOKEN

A shared secret that turns on the access gate.

- Type: string of letters, digits, `.`, `_`, `~` and `-`
- Default: unset, so the gate is off
- Example: `STUDIO_ACCESS_TOKEN=$(openssl rand -hex 32)`, saved somewhere you can reuse it

With a token set, every `/api/*` request and the Gateway WebSocket need the `clawboo_access` cookie. Open `http://<host>:<port>/?access_token=<token>` once to get it: the right token sets an HttpOnly cookie (scoped to your `CLAWBOO_BASE_PATH`, `SameSite=Lax`, and `Secure` when the request arrives with `X-Forwarded-Proto: https`) and redirects to the same address without the token. A wrong token answers 401 `Invalid Clawboo access token.` and a missing cookie answers 401 `Clawboo access token required. Open /?access_token=<token> once to set a cookie.` The page shell and its static files load without the cookie.

Clawboo's own runtimes reach its MCP servers with a per-install attach token instead of the cookie, and only on direct connections from `127.0.0.1`. The variable is read only from the environment; a `studioAccessToken` key in `settings.json` does nothing. It is removed from the environment of every runtime Clawboo starts. The `clawboo` CLI cannot use a gated server; see [CLI reference](/reference/cli).

<Warning>
Use only letters, digits, `.`, `_`, `~` and `-`. Any other character, such as the `+`, `/` or `=` in a base64 token, turns the gate off and the server only prints a warning. On a wide bind the server then refuses to start, but behind a reverse proxy on the same machine every `/api/*` route stays open while you think it is protected.
</Warning>

With no token set, the first request that reaches the server through a reverse proxy logs a one-time `SECURITY:` warning, because such a proxy delivers every request from `127.0.0.1`. [Security](/operating/security) explains what the gate does and does not protect.

### CLAWBOO_ALLOW_INSECURE

Lets the server start on a wide bind with no access token.

- Type: flag, exactly `1`
- Default: unset
- Example: `CLAWBOO_ALLOW_INSECURE=1`

With it, a non-loopback `HOST` and no valid token starts the server with a loud `SECURITY:` warning instead of exiting. It has no effect on a loopback bind or when a token is set. Use it only behind a proxy that authenticates every request.

### CLAWBOO_ALLOWED_ORIGINS

Browser origins, beyond this machine's, that may call the API.

- Type: comma-separated origins, each `scheme://host[:port]`
- Default: none extra. `http` and `https` on `localhost`, `127.0.0.1` and `[::1]` at the dashboard port, plus the bind address, are always allowed.
- Example: `CLAWBOO_ALLOWED_ORIGINS=https://clawboo.example.com`

A request to `/api/*` or the Gateway WebSocket from any other origin gets 403 `Cross-origin request blocked.` The list only adds origins; it never turns the check off. Entries that are not valid origins are skipped.

### CLAWBOO_ALLOWED_HOSTS

`Host` header values the server accepts, beyond this machine's.

- Type: comma-separated hostnames
- Default: none extra. `localhost`, `127.x.x.x`, `::1` and the bind address are always accepted.
- Example: `CLAWBOO_ALLOWED_HOSTS=clawboo.example.com`

This guards against DNS rebinding. Behind a reverse proxy or on a LAN, set both this and `CLAWBOO_ALLOWED_ORIGINS`, or every `/api/*` call answers 403 `Cross-origin request blocked.`

### CLAWBOO_BASE_PATH

A URL prefix to serve the whole app under, for sharing a hostname with other apps behind a proxy.

- Type: URL path
- Default: unset, so the app is served at `/`
- Example: `CLAWBOO_BASE_PATH=/clawboo`

How it behaves:

- The dashboard, `/api`, the event streams and the Gateway WebSocket all move under the prefix. The built app needs no rebuild.
- `clawboo`, `/clawboo` and `/clawboo/` all mean `/clawboo`. Empty or `/` means the root.
- These values stop the server at startup with `SECURITY/CONFIG: CLAWBOO_BASE_PATH is invalid (<reason>)`: whitespace, a backslash, `?`, `#` or `%`, an empty or `.`/`..` segment, any character outside `A-Z a-z 0-9 . _ ~ -`, or a first segment of `api`.
- The unprefixed `/api` stays available for the CLI and Clawboo's own runtimes, with the same checks.
- `/` and the bare prefix redirect to `<prefix>/`. Any other unprefixed path answers 404 `Not found. This Clawboo is served under <prefix>/`.
- The access cookie is scoped to the prefix, so other apps on the same hostname never receive it. The CLI adds the prefix to the URLs it prints.

### CLAWBOO_SECRETS_MASTER_KEY

The key that encrypts saved provider keys and connector secrets.

- Type: a 32-byte key as base64, 64 hex characters, or exactly 32 characters
- Default: unset, so Clawboo generates `<CLAWBOO_HOME>/secrets/master.key`
- Example: `CLAWBOO_SECRETS_MASTER_KEY="$(cat ~/.config/clawboo/master.key)"`

Set it to keep the key outside `~/.clawboo`, and give it the same value every time. An invalid value stops any use of the vault with an error that lists the accepted forms. A different key from the one that encrypted the vault makes saved keys read as missing, and **System Health** reports that the master key changed. It is removed from the environment of every runtime Clawboo starts.

## Ports

### CLAWBOO_API_PORT

The exact port for the dashboard.

- Type: whole number, 1 to 65535
- Default: unset, so the server takes the first free port from 18790 upward
- Example: `CLAWBOO_API_PORT=18795 clawboo`

With it set there is no fallback: a taken port stops the server with `CLAWBOO_API_PORT=N is already in use.` The CLI then checks only this port when it looks for a running dashboard, and `clawboo restart` sets it on the new server to keep the old port.

### CLAWBOO_API_PORT_START

The first port of the automatic scan.

- Type: whole number, 1 to 65535
- Default: `18790`
- Example: `CLAWBOO_API_PORT_START=19000`

Used only when `CLAWBOO_API_PORT` and `PORT` are unset. The server tries 20 consecutive ports from here. The CLI does not scan from this value; it finds such a server through `api-port.txt`.

### PORT

A port set by a hosting platform.

- Type: whole number, 1 to 65535
- Default: unset
- Example: `PORT=8080`

Honored only when `CLAWBOO_API_PORT` is unset and the server is not running in development mode (`--dev`). Like `CLAWBOO_API_PORT` it has no fallback: a taken port stops the server with `PORT=N is already in use (set by hosting platform).`

## Folders

### CLAWBOO_HOME

The folder for everything Clawboo stores.

- Type: path; a leading `~` is expanded and a relative path is resolved
- Default: `~/.clawboo`
- Example: `CLAWBOO_HOME=/srv/clawboo`

It moves the database, `settings.json`, the vault, `api-port.txt`, the logs, worktrees, agent browser profiles and per-agent runtime homes. The bundled server also runs with it as its working directory. Use the same value for every `clawboo` command, or `stop` and `backup` look in the wrong place. [Configuration](/reference/configuration) lists every file inside.

### OPENCLAW_STATE_DIR

OpenClaw's folder.

- Type: path; a leading `~` is expanded
- Default: the first of `~/.openclaw`, `~/.clawdbot` and `~/.moltbot` that exists, else `~/.openclaw`
- Example: `OPENCLAW_STATE_DIR=/srv/openclaw`

Clawboo reads OpenClaw's `openclaw.json`, `.env` and agent profiles here, and writes to them when you connect a provider key, set up OpenClaw or change its settings from the dashboard. `MOLTBOT_STATE_DIR` and `CLAWDBOT_STATE_DIR` are older names, checked in that order when this one is unset. [Configuration](/reference/configuration) lists every read and write.

### CLAWBOO_DB_PATH

The database file the MCP stdio bins open.

- Type: path (not `~`-expanded; use `$HOME`)
- Default: `~/.openclaw/clawboo/clawboo.db`
- Example: `CLAWBOO_DB_PATH="$HOME/.clawboo/clawboo.db" clawboo-mcp-tasks`

Only the four `clawboo-mcp-*` bins read it; the dashboard server always uses `<CLAWBOO_HOME>/clawboo.db`. The bins' default is a different file, so set this whenever you run a bin yourself and want it to see the dashboard's board and memory. The stdio snippets from `GET /api/mcp/config` already include it.

### CLAWBOO_UI_DIR

The folder of built dashboard files the server serves.

- Type: path
- Default: the `ui` folder next to the bundled server
- Example: `CLAWBOO_UI_DIR=/opt/clawboo/ui`

Not used in development mode, where Vite serves the dashboard. If the files cannot be read, the page answers 503 `The Clawboo dashboard could not be read from disk. Check CLAWBOO_UI_DIR.`

### CLAWBOO_CATALOG_INDEX_URL

Where the marketplace catalog index comes from.

- Type: URL
- Default: `https://raw.githubusercontent.com/clawboo/clawboo/refs/heads/main/catalog/dist/v1/index.json`
- Example: `CLAWBOO_CATALOG_INDEX_URL=https://mirror.example.com/catalog/v1/index.json`

A `catalog/dist/v1/` folder above the server, as in a source checkout, takes precedence. Pack files are fetched relative to the index, and each is checked against the index's digest before use. The index is cached for 6 hours. When it cannot be reached, the marketplace still shows the built-in pack.

## Provider keys

Clawboo looks up a runtime's key in this order: the server's environment, the encrypted vault, then OpenClaw's `~/.openclaw/.env`. A runtime you disconnected on its card uses only the vault until you connect it again. An exported key makes a runtime's card read as connected, but **Settings > Providers** shows a provider as connected only when its key is in the vault or in OpenClaw's `.env`. [Providers and runtimes](/using/providers-and-runtimes) covers saving keys from the dashboard instead.

### ANTHROPIC_API_KEY

- Type: string
- Default: unset
- Example: `ANTHROPIC_API_KEY=sk-ant-...`

The key for Claude Code and for Clawboo Native's Anthropic models. Hermes accepts it as an alternative to its OpenRouter key.

### OPENAI_API_KEY

- Type: string
- Default: unset
- Example: `OPENAI_API_KEY=sk-...`

The key for Clawboo Native's OpenAI models. Hermes accepts it as an alternative to its OpenRouter key. Memory can also use it for embeddings (`text-embedding-3-small`) when no local Ollama embedding model is available and you allow it. Clawboo connects Codex through `codex login`, not this key.

### OPENROUTER_API_KEY

- Type: string
- Default: unset
- Example: `OPENROUTER_API_KEY=sk-or-...`

The main key for Hermes, and the key for Clawboo Native's OpenRouter models.

### OpenAI-compatible provider keys

Clawboo Native reaches seven more providers through their OpenAI-compatible endpoints. Each key, on its own, is enough to connect Clawboo Native. All default to unset.

| Variable           | Provider | Endpoint                                                  |
| ------------------ | -------- | --------------------------------------------------------- |
| `GEMINI_API_KEY`   | Google   | `https://generativelanguage.googleapis.com/v1beta/openai` |
| `XAI_API_KEY`      | xAI      | `https://api.x.ai/v1`                                     |
| `GROQ_API_KEY`     | Groq     | `https://api.groq.com/openai/v1`                          |
| `MISTRAL_API_KEY`  | Mistral  | `https://api.mistral.ai/v1`                               |
| `TOGETHER_API_KEY` | Together | `https://api.together.xyz/v1`                             |
| `CEREBRAS_API_KEY` | Cerebras | `https://api.cerebras.ai/v1`                              |
| `MOONSHOT_API_KEY` | Moonshot | `https://api.moonshot.ai/v1`                              |

**Settings > Providers** also saves `MINIMAX_API_KEY`, `NVIDIA_API_KEY`, `HF_TOKEN` and `VENICE_API_KEY` into OpenClaw's `.env` for the OpenClaw Gateway. Clawboo's own runtimes do not use those four.

### OLLAMA_BASE_URL

The address of an Ollama server, for keyless local models.

- Type: URL including `/v1`
- Default: `http://localhost:11434/v1`
- Example: `OLLAMA_BASE_URL=http://192.168.1.20:11434/v1`

Clawboo Native sends Ollama requests here and lists your pulled models from the same server. You do not need it to use a local Ollama: picking Ollama in onboarding or in Clawboo Native's providers list records that choice. With no recorded choice, setting this variable also counts as Ollama being set up. After you remove Ollama (**Disconnect Ollama**) or disconnect Clawboo Native, the variable no longer turns Ollama on; only picking Ollama again does.

OpenClaw does not read this variable, so when Clawboo sets up OpenClaw on Ollama it writes the same address (without `/v1`) into `openclaw.json`. Memory embeddings ignore it and always look for Ollama at `http://localhost:11434`; with a remote Ollama, memory search stays keyword-only unless a local Ollama or an allowed OpenAI key provides embeddings.

### TAVILY_API_KEY

- Type: string
- Default: unset
- Example: `TAVILY_API_KEY=tvly-...`

When set in the server's environment (or the tools stdio bin's), the built-in `web_search` tool becomes available to agents.

### COMPOSIO_BASE_URL

- Type: URL
- Default: `https://backend.composio.dev`
- Example: `COMPOSIO_BASE_URL=https://composio.example.com`

The Composio API address for brokered apps. The Composio key itself is saved in the vault from **Connectors**; Clawboo does not read it from the environment.

## Runs and verification

### CLAWBOO_RUN_SILENT_TIMEOUT_MS

- Type: milliseconds
- Default: `1800000` (30 minutes)
- Example: `CLAWBOO_RUN_SILENT_TIMEOUT_MS=3600000`

How long a run may go without producing any event before Clawboo stops it. Every event restarts the clock, so a run that keeps working is never cut off. It applies to team chat runs (including delegated tasks and team Routines) and to agent Routines on Clawboo Native, Claude Code, Codex and Hermes. A delegated task in team chat also has its own fixed 8-minute idle watchdog; see [Limits and defaults](/reference/limits-and-defaults).

### CLAWBOO_HOME_MUTEX_ACQUIRE_MS

- Type: milliseconds
- Default: `600000` (10 minutes)
- Example: `CLAWBOO_HOME_MUTEX_ACQUIRE_MS=900000`

How long a run waits for the same agent's previous run to finish before it gives up. It bounds the wait, never the run.

### CLAWBOO_MAX_FIX_CYCLES

- Type: whole number, 0 or more
- Default: `1`, which allows two attempts
- Example: `CLAWBOO_MAX_FIX_CYCLES=0`

How many times a task that failed verification goes back to the same agent with the findings. `0` allows a single attempt. When the attempts run out, the task moves to **Needs you**. Only runs that are verified count; [How work is checked](/concepts/verification) explains which runs those are.

### CLAWBOO_REVIEWER_MODEL

- Type: model id
- Default: the model that did the work
- Example: `CLAWBOO_REVIEWER_MODEL=claude-sonnet-4-6`

The model for the verification reviewer. The reviewer runs on the same runtime as the work it checks, so name a model that runtime accepts. The verdict records which model reviewed.

### CLAWBOO_ROUTINE_OPENCLAW_TIMEOUT_MS

- Type: milliseconds
- Default: `600000` (10 minutes)
- Example: `CLAWBOO_ROUTINE_OPENCLAW_TIMEOUT_MS=1200000`

How long a Routine that runs an OpenClaw agent waits for that agent to finish. Past it, Clawboo stops waiting and returns the task to **To do**.

## Board timing

### CLAWBOO_BOARD_STALE_TTL_MS

- Type: milliseconds, a whole number from 1 to 2147483647
- Default: `180000` (3 minutes)
- Example: `CLAWBOO_BOARD_STALE_TTL_MS=240000`

A running task proves it is alive with a heartbeat every 30 seconds. A task in **In progress** that misses heartbeats for this long is marked timed out and returned to **To do**. At startup the same value decides which runs a previous server left behind. Keep it well above 30 seconds, and keep it plus `CLAWBOO_BOARD_STALE_SWEEP_MS` under 8 minutes, the fixed delegation watchdog, or that watchdog fails the task first.

### CLAWBOO_BOARD_STALE_SWEEP_MS

- Type: milliseconds, a whole number from 1 to 2147483647
- Default: `60000` (1 minute)
- Example: `CLAWBOO_BOARD_STALE_SWEEP_MS=30000`

How often the stale-task check runs. It also runs once at startup.

### CLAWBOO_DISPATCH_PUMP_MS

- Type: milliseconds, a whole number from 1 to 2147483647
- Default: `60000` (1 minute)
- Example: `CLAWBOO_DISPATCH_PUMP_MS=30000`

How often Clawboo looks for delegated work that is ready to run, and for messages waiting for an agent, and wakes those teams. Board changes trigger this at once; the interval is a backstop and is how waiting work resumes after a restart. The first pass runs 10 seconds after the server starts.

### CLAWBOO_DB_WRITE_BUDGET_MS

- Type: milliseconds
- Default: `1500`
- Example: `CLAWBOO_DB_WRITE_BUDGET_MS=3000`

How long one database write keeps retrying while another process holds the file. The retry pauses the server, so this caps how long one busy write can stall it (plus a final 250 ms wait).

## Approvals and retention

### CLAWBOO_APPROVAL_TTL_MS

- Type: milliseconds
- Default: `86400000` (24 hours)
- Example: `CLAWBOO_APPROVAL_TTL_MS=43200000`

The age at which the hourly reaper marks a still-pending approval expired and unblocks any task it was holding (unless a failed verification is what holds it). It does not change how long an approval prompt waits for your answer: tool and delegation approvals expire after 5 minutes whatever this is set to. [Limits and defaults](/reference/limits-and-defaults) lists every approval window.

### CLAWBOO_APPROVAL_REAPER_INTERVAL_MS

- Type: milliseconds
- Default: `3600000` (1 hour)
- Example: `CLAWBOO_APPROVAL_REAPER_INTERVAL_MS=600000`

How often the reaper runs; it also runs once at startup. The same pass expires time-limited connector grants and remembered approvals, and deletes stored tool results older than `CLAWBOO_TOOL_RESULT_TTL_MS`.

### CLAWBOO_TOOL_RESULT_TTL_MS

- Type: milliseconds
- Default: `604800000` (7 days)
- Example: `CLAWBOO_TOOL_RESULT_TTL_MS=86400000`

A tool result too large for an agent's context is cut down, and the whole result (up to 8 MB) is stored so the agent can read the rest. The reaper deletes stored results older than this.

## Memory, browsers and MCP

### CLAWBOO_DISABLE_EMBEDDINGS

- Type: flag, exactly `1`
- Default: unset
- Example: `CLAWBOO_DISABLE_EMBEDDINGS=1`

Turns memory embeddings off in the server and in the memory stdio bin. Memory search then matches keywords only.

### CLAWBOO_MAX_AGENT_BROWSERS

- Type: whole number
- Default: `4`
- Example: `CLAWBOO_MAX_AGENT_BROWSERS=2`

At most this many agent browsers run at once; each takes roughly 400 MB. A browser call beyond the limit closes an idle browser if there is one, otherwise it waits up to 60 seconds for a free slot.

### CLAWBOO_AGENT_BROWSER_IDLE_MS

- Type: milliseconds
- Default: `600000` (10 minutes)
- Example: `CLAWBOO_AGENT_BROWSER_IDLE_MS=300000`

An agent browser nobody has used for this long is closed.

### CLAWBOO_OPENCLAW_CDP_PORT

- Type: port
- Default: `OPENCLAW_GATEWAY_PORT` plus 11, so `18800`
- Example: `CLAWBOO_OPENCLAW_CDP_PORT=18850`

The Chrome debugging port of OpenClaw's managed browser. Clawboo reads it to capture what an OpenClaw agent's browser shows. Set it if you moved that port in OpenClaw.

### OPENCLAW_GATEWAY_PORT

- Type: port
- Default: `18789`
- Example: `OPENCLAW_GATEWAY_PORT=19789`

Used only to work out the default debugging port above. It does not change which Gateway Clawboo connects to; `settings.json` holds that address.

### CLAWBOO_MCP_PROBE_MS

- Type: milliseconds
- Default: `60000` (1 minute)
- Example: `CLAWBOO_MCP_PROBE_MS=120000`

How often the server checks its own Tasks, Memory, Tools and TeamChat servers. A server that fails the check is rebuilt, and retried after 30 seconds, doubling up to 5 minutes.

## Logging and tracing

### LOG_LEVEL

- Type: one of `trace`, `debug`, `info`, `warn`, `error`, `fatal`, `silent`
- Default: `info`
- Example: `LOG_LEVEL=debug`

The level for the server's log. On a CLI-started server the log goes to `~/.clawboo/server.log`. Credential-looking values are masked in every log line.

### NODE_ENV

- Type: string
- Default: unset; the CLI sets `production` on the server it starts
- Example: `NODE_ENV=production`

With `production` the server logs one JSON object per line. Anything else gives colored, readable lines.

### OTEL_EXPORTER_OTLP_ENDPOINT

- Type: URL
- Default: unset
- Example: `OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4318`

With this or `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT` set, Clawboo exports traces over OTLP/HTTP for agent Routines on Clawboo Native, Claude Code, Codex and Hermes, and for runs started with `POST /api/runtimes/:id/run`. Team chat runs produce no traces. Without either variable, the local event log is the only trace store.

<Note>
The npm package does not include the OpenTelemetry SDK, so on an npm install these variables export nothing, and **System Health** reports that the exporter failed to initialize. Export works from a source checkout, where the SDK is installed.
</Note>

### OTEL_EXPORTER_OTLP_TRACES_ENDPOINT

- Type: URL
- Default: unset
- Example: `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT=http://localhost:4318/v1/traces`

The traces-only OTLP endpoint. Either this or `OTEL_EXPORTER_OTLP_ENDPOINT` turns export on.

### OTEL_SERVICE_NAME

- Type: string
- Default: `clawboo`
- Example: `OTEL_SERVICE_NAME=clawboo-office`

The service name on exported traces.

## Read from other tools

### CODEX_HOME

- Type: path
- Default: `~/.codex`
- Example: `CODEX_HOME=/srv/codex`

Where Clawboo looks for the sign-in your `codex login` saved (`auth.json`). Each Codex agent then runs with its own Codex home under `~/.clawboo/runtimes/`, which Clawboo sets for that run.

### HERMES_HOME

- Type: path
- Default: `~/.hermes`
- Example: `HERMES_HOME=/srv/hermes`

Where Clawboo looks for your Hermes sign-in (`auth.json`). Each Hermes agent runs with its own Hermes home under `~/.clawboo/runtimes/`.

### CLAUDE_CODE_USE_BEDROCK

- Type: flag; any value except empty, `0` or `false` turns it on
- Default: unset
- Example: `CLAUDE_CODE_USE_BEDROCK=1`

Clawboo normally removes `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY` and `AWS_SESSION_TOKEN` from the environment of runtimes it starts. With this set, it keeps them, so Claude Code can use Amazon Bedrock.

### Proxy variables

`HTTP_PROXY`, `HTTPS_PROXY` and `ALL_PROXY` (in either case), plus `NO_PROXY` and `no_proxy`. When any proxy variable is set, Clawboo adds `127.0.0.1,localhost,::1` to both `NO_PROXY` and `no_proxy` for the runtimes it starts, keeping any hosts already listed. Their calls to Clawboo's own MCP servers then skip the proxy, which would otherwise see the attach token and break the connection.

### GATEWAY_AUTH_TOKEN and other templates

Clawboo does not read `GATEWAY_AUTH_TOKEN` as its own setting. When `settings.json` or `openclaw.json` holds a template such as `${GATEWAY_AUTH_TOKEN}` (any `${NAME}` works), Clawboo resolves `NAME` from its own environment first, then from OpenClaw's `.env`. It removes `GATEWAY_AUTH_TOKEN` from the environment of runtimes it starts.

### Operating system variables

`PATH` and, on Windows, `PATHEXT`, `ComSpec` and `APPDATA` are read to find and start programs. Your home folder comes from the operating system (`HOME` or `USERPROFILE`).

## Set by Clawboo

Clawboo sets these on processes it starts. Do not set them yourself.

| Variable                                                | Set on                                     | Value                                                                                                                                                                                                                                  |
| ------------------------------------------------------- | ------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `CLAWBOO_VERSION`                                       | The server the CLI starts                  | The CLI's version, which the server reports as its own. Without it the server reads its version from its package, or `0.0.0-dev` in a source checkout. The in-app update leaves it out, so the new server reads its version from disk. |
| `CLAWBOO_LAUNCH_DIR`                                    | The server the CLI starts                  | The folder you ran `clawboo` from, offered as "Where you started clawboo" in connector setup. Ignored unless it is an absolute path to an existing folder.                                                                             |
| `CLAWBOO_MCP_BIN_DIR`                                   | The server the CLI starts (normal install) | The bundled `bin` folder, so stdio attach snippets point at the right files. Without it, snippets show a `<path-to>/dist/bin/<server>.js` placeholder.                                                                                 |
| `CLAWBOO_API_PORT` with `CLAWBOO_AWAIT_PORT`            | A restarted server                         | The port to keep; the new server waits up to 15 seconds for it to free.                                                                                                                                                                |
| `NODE_ENV`                                              | The server the CLI starts                  | `production`                                                                                                                                                                                                                           |
| `CODEX_HOME`, `HERMES_HOME`                             | Each Codex or Hermes run                   | That agent's own home folder under `~/.clawboo/runtimes/`                                                                                                                                                                              |
| The runtime's provider key, such as `ANTHROPIC_API_KEY` | Each runtime run                           | The key found in the environment, the vault or OpenClaw's `.env`                                                                                                                                                                       |
| `NO_PROXY`, `no_proxy`                                  | Each runtime run, when a proxy is set      | Your list plus `127.0.0.1,localhost,::1`                                                                                                                                                                                               |
| `OPENCLAW_SERVICE_REPAIR_POLICY`, `NO_COLOR`            | The `openclaw doctor --fix` repair run     | `external` (leave any system Gateway service alone) and `1`                                                                                                                                                                            |
| `CLAWBOO_DB_PATH`                                       | Stdio attach snippets                      | The dashboard's database file                                                                                                                                                                                                          |

## Testing and development

### CLAWBOO_ENABLE_MOCK_RUNTIME

- Type: flag, exactly `1`
- Default: unset
- Example: `CLAWBOO_ENABLE_MOCK_RUNTIME=1`

Adds `clawboo-mock`, a fault-injection runtime for reproducing failures such as silence, a crash or a slow start. It runs nothing real: every event comes from directives in the task text. Any other value leaves it hidden from the dashboard and from `GET /api/runtimes`.

### CLAWBOO_SERVER_PATH

- Type: path
- Default: found by walking up from the CLI to a `package.json` named `clawboo`
- Example: `CLAWBOO_SERVER_PATH="$HOME/code/clawboo" clawboo`

The repository root the CLI starts the server from when there is no bundled server, as in a source checkout. A normal install ignores it.

## What runtimes inherit

Runtimes Clawboo starts (Claude Code, Codex, Hermes) and the verification command get the server's environment, minus:

- Clawboo's own secrets: `STUDIO_ACCESS_TOKEN`, `CLAWBOO_SECRETS_MASTER_KEY`, `GATEWAY_AUTH_TOKEN`, and any variable starting with `BETTER_AUTH`.
- A fixed list of common third-party credentials: GitHub, GitLab and Bitbucket tokens, npm, PyPI and Cargo tokens, hosting and cloud tokens (DigitalOcean, Vercel, Netlify, Cloudflare, Heroku, Fly, Railway), Stripe, Twilio, SendGrid, Mailgun and Slack keys, database URLs and passwords, and Vault, 1Password, Doppler, Sentry, Codecov, Turbo, CircleCI and Docker tokens.
- AWS access keys, unless `CLAUDE_CODE_USE_BEDROCK` is set.

The removal works by name. Any other secret in the server's environment, including provider keys such as `OPENAI_API_KEY`, reaches every agent those runtimes run. Start Clawboo from a shell that holds only what agents may see. [What agents can do](/concepts/permissions) covers what else they can reach.

<Accordion title="Source of truth">

Server start: `apps/web/server/index.ts`, `lib/resolveHost.ts`, `lib/portUtils.ts`. Access: `packages/gateway-proxy/src/access-gate.ts`, `origin-guard.ts`. Paths and the base path: `packages/config/src/index.ts`, `basePath.ts`. Keys: `apps/web/server/lib/secretsVault.ts`, `lib/runtimes/descriptor.ts`. Runtime environments: `lib/runtimes/childEnv.ts`. Each timer's variable is read next to its default; [Limits and defaults](/reference/limits-and-defaults) gives the file and line.

</Accordion>

## Related

- [Configuration](/reference/configuration): the files these variables move, and what is stored where
- [CLI reference](/reference/cli): the variables the `clawboo` command reads and sets
- [Limits and defaults](/reference/limits-and-defaults): every number, including the ones you cannot change
- [Self-host securely](/guides/self-host-securely): `HOST`, the access token and the allowlists, step by step
- [Security](/operating/security): what the access gate, the origin check and the vault protect
