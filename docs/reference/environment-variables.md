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
    'CLAWBOO_OPERATOR_SETTINGS',
    'CLAWBOO_DISABLE_SELF_UPDATE',
    'CLAWBOO_MAX_CONCURRENT_RUNS',
    'CLAWBOO_PROXY_IDENTITY',
  ]
---

These are the environment variables Clawboo's own code reads, and the ones it sets on programs it starts. Set them in the shell or service that runs `clawboo`. The server reads most of them once at startup, so run `clawboo restart` after a change.

Durations are in milliseconds, and an unset, empty or non-numeric duration means the default. Each variable's section below says how it handles other values. Agent runtimes and OpenClaw read variables of their own, which this page does not cover.

| Variable                               | Default                           | What it does                                                 |
| -------------------------------------- | --------------------------------- | ------------------------------------------------------------ |
| **Access and network**                 |                                   |                                                              |
| `HOST`                                 | `127.0.0.1`                       | Address the dashboard listens on                             |
| `STUDIO_ACCESS_TOKEN`                  | per-install token file            | The access token for `/api/*`; blank turns the gate off      |
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
| `CLAWBOO_WORK_DIR`                     | `~/clawboo-work`                  | Work folder; `<CLAWBOO_HOME>-work` when that is set          |
| `OPENCLAW_STATE_DIR`                   | `~/.openclaw`                     | OpenClaw's folder, which Clawboo reads and writes            |
| `CLAWBOO_DB_PATH`                      | `~/.openclaw/clawboo/clawboo.db`  | Database file for the MCP stdio bins only                    |
| `CLAWBOO_UI_DIR`                       | `<server folder>/ui`              | Built dashboard files the server serves                      |
| `CLAWBOO_CATALOG_INDEX_URL`            | this release's catalog on GitHub  | Where the marketplace catalog comes from                     |
| **Pinned by an administrator**         |                                   |                                                              |
| `CLAWBOO_OPERATOR_SETTINGS`            | `<CLAWBOO_HOME>/operator.json`    | The operator settings file                                   |
| `CLAWBOO_DISABLE_SELF_UPDATE`          | unset                             | `1` turns the dashboard's update chip and update off         |
| `CLAWBOO_DISABLE_BROWSER_AUTOSTART`    | unset                             | `1` stops the browsers starting on a new install             |
| `CLAWBOO_PROXY_IDENTITY`               | `off`                             | Checks a sign-in proxy's signed identity tokens              |
| `CLAWBOO_PROXY_IDENTITY_*`             | see below                         | The proxy's keys, issuer, audience, header and binding       |
| **Provider keys**                      |                                   |                                                              |
| `ANTHROPIC_API_KEY`                    | unset                             | Claude Code, Clawboo Native (Anthropic), Hermes              |
| `OPENAI_API_KEY`                       | unset                             | Clawboo Native (OpenAI), Hermes, memory embeddings           |
| `OPENROUTER_API_KEY`                   | unset                             | Hermes, Clawboo Native (OpenRouter)                          |
| `GEMINI_API_KEY` and six more          | unset                             | Clawboo Native through OpenAI-compatible providers           |
| `OLLAMA_BASE_URL`                      | `http://localhost:11434/v1`       | Ollama address for Clawboo Native and OpenClaw setup         |
| `COMPOSIO_BASE_URL`                    | `https://backend.composio.dev`    | Composio API address for brokered apps                       |
| **Runs and verification**              |                                   |                                                              |
| `CLAWBOO_MAX_CONCURRENT_RUNS`          | `8`                               | Agent runs that execute at once; the rest wait their turn    |
| `CLAWBOO_RUN_SILENT_TIMEOUT_MS`        | `1800000` (30 min)                | Silence after which a run is stopped                         |
| `CLAWBOO_HERMES_TRANSPORT`             | unset (ACP, else quiet)           | How Hermes runs are driven: `acp` or `quiet`                 |
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

`HOSTNAME`, `OPENCLAW_CONFIG_PATH`, `CLAWBOO_API_URL` and `GATEWAY_AUTH_TOKEN` (outside a `${...}` template) are not read. `TAVILY_API_KEY` is no longer used: Clawboo has no built-in web search, so connect a search connector such as Exa Search instead. Variables Clawboo sets on the processes it starts are listed under [Set by Clawboo](#set-by-clawboo).

## Access and network

### HOST

The network address the dashboard listens on.

- Type: hostname or IP address
- Default: `127.0.0.1`, so only this machine can connect
- Example: `HOST=0.0.0.0`

Any address other than loopback (`localhost`, `127.x.x.x`, `::1`) exposes the dashboard to your network. The server then refuses to start, exiting with code 1, when the access gate is off (`STUDIO_ACCESS_TOKEN` set blank), unless `CLAWBOO_ALLOW_INSECURE=1` is set. A default install has its per-install token, so it starts. Prefer `0.0.0.0` to a single LAN address: Clawboo's own agents reach its MCP servers at `127.0.0.1`, which a single-address bind does not answer. A wide bind without `CLAWBOO_ALLOWED_ORIGINS` also logs a warning that browsers on other machines will be blocked.

`HOSTNAME` is ignored. Docker, systemd and many CI runners set it automatically, so widening the bind always takes an explicit `HOST`. [Self-host securely](/guides/self-host-securely) walks through reaching Clawboo from another machine.

### STUDIO_ACCESS_TOKEN

The access token, in place of the per-install one.

- Type: string of letters, digits, `.`, `_`, `~` and `-`
- Default: unset, so the server uses the per-install token in `~/.clawboo/access-token` (under `CLAWBOO_HOME`), and makes it on the first start
- Blank (`STUDIO_ACCESS_TOKEN=`): no token, so the access gate is off and every `/api/*` route is open to anything that can reach the server. `pnpm dev` sets it blank unless your shell sets it.
- Example: `STUDIO_ACCESS_TOKEN=$(openssl rand -hex 32)`, saved somewhere you can reuse it

Every `/api/*` request and the Gateway WebSocket need the `clawboo_access` cookie, with this token or the per-install one. `clawboo` opens the browser with a one-time sign-in link that sets it, and `clawboo open` does the same for a running server. With a token you know, you can also open `http://<host>:<port>/?access_token=<token>` once: the right token sets an HttpOnly cookie (scoped to your `CLAWBOO_BASE_PATH`, `SameSite=Lax`, and `Secure` when the request arrives with `X-Forwarded-Proto: https`) and redirects to the same address without the token. A wrong token answers 401 `Invalid Clawboo access token.` and a missing cookie answers 401 ``Clawboo access token required. Run `clawboo open` on the computer running Clawboo, or open /?access_token=<token> once to set a cookie.`` The page shell and its static files load without the cookie. [Security](/operating/security#the-access-token) covers one-time links and the token file.

Clawboo's own runtimes reach its MCP servers with a per-install attach token instead of the cookie, and only on direct connections from `127.0.0.1`. The variable is read only from the environment; a `studioAccessToken` key in `settings.json` does nothing. It is removed from the environment of every runtime Clawboo starts. The `clawboo` CLI uses the same token as the server: this variable from its own shell, or the token file when it is unset; see [Token-gated installs](/reference/cli#token-gated-installs).

<Warning>
Use only letters, digits, `.`, `_`, `~` and `-`. With any other character, such as the `+`, `/` or `=` in a base64 token, the server logs `SECURITY: refusing to start` with the character and the allowed set, and exits with code 1, on every bind. `CLAWBOO_ALLOW_INSECURE=1` does not skip this. On 0.5.0 and older, such a token turns the gate off with only a warning, which behind a reverse proxy on the same machine leaves every `/api/*` route open.
</Warning>

With the gate off, the first request that reaches the server through a reverse proxy logs a one-time `SECURITY:` warning, because such a proxy delivers every request from `127.0.0.1`. [Security](/operating/security) explains what the gate does and does not protect.

### CLAWBOO_ALLOW_INSECURE

Lets the server start on a wide bind with no access token.

- Type: flag, exactly `1`
- Default: unset
- Example: `CLAWBOO_ALLOW_INSECURE=1`

With it, a non-loopback `HOST` and no token starts the server with a loud `SECURITY:` warning instead of exiting. It has no effect on a loopback bind or when a token is set, and it does not skip the refusal of a token with an unsupported character. Use it only behind a proxy that authenticates every request.

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
- What the dashboard keeps in the browser (theme, layout, board view, onboarding and tour progress, the browser alert choice) is stored under keys that start with the prefix, such as `/clawboo:clawboo.theme`, so two instances under different prefixes on one hostname keep their own. A key saved before the prefix existed moves to the first instance that reads it; two instances whose pages load at the same moment can each keep a copy. At the root, keys keep their old names.

### CLAWBOO_SECRETS_MASTER_KEY

The key that encrypts saved provider keys and connector secrets.

- Type: a 32-byte key as base64, 64 hex characters, or exactly 32 characters
- Default: unset, so Clawboo generates `<CLAWBOO_HOME>/secrets/master.key`
- Example: `CLAWBOO_SECRETS_MASTER_KEY="$(cat ~/.config/clawboo/master.key)"`

Set it to keep the key outside `~/.clawboo`, and give it the same value every time. An invalid value stops any use of the vault with an error that lists the accepted forms. A different key from the one that encrypted the vault makes saved keys read as missing, and **System Health** reports that the master key changed. It is removed from the environment of every runtime Clawboo starts.

### CLAWBOO_APP_LINK_PUBLIC_KEY

Set by an app that starts Clawboo itself, such as the desktop app, so that the requests it signs carry a name. Leave it unset otherwise.

- Type: an Ed25519 public key, as a PEM public key (`-----BEGIN PUBLIC KEY-----`), a JWK or a JWKS
- Default: unset (off)
- Example: `CLAWBOO_APP_LINK_PUBLIC_KEY='{"kty":"OKP","crv":"Ed25519","x":"…"}'`

With it set, an `/api/` request may carry a token in the `clawboo-app-identity` header (a Gateway WebSocket upgrade that carries one is refused), signed with the app's private key, that names one of the app's own people. Such a person's id starts with `account:`, and the request then counts as theirs, as a [sign-in proxy's](#clawboo_proxy_identity) person's does, on the few routes the app signs for: sending work, answering an approval and checking its link. Anywhere else the token is refused. A request without the header works as before. A token that does not verify gets `401`, and an `allow_always` answer to an approval from one of these people gets `403`. [An app that starts Clawboo](/guides/sso-proxy#an-app-that-starts-clawboo) has the token's format.

Clawboo reads it from the environment only, never from the operator file, where an agent running as your user could swap in a key of its own. A key that is not an Ed25519 public key stops the server at startup.

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

It moves the database, `settings.json`, the vault, `api-port.txt`, the logs, worktrees, team folders, agent browser profiles and per-agent runtime homes. The bundled server also runs with it as its working directory. Use the same value for every `clawboo` command, or `stop` and `backup` look in the wrong place. [Configuration](/reference/configuration) lists every file inside.

### CLAWBOO_WORK_DIR

The work folder, where a newer layout keeps task worktrees, review checkouts and team folders.

- Type: path; a leading `~` is expanded and a relative path is resolved
- Default: `<CLAWBOO_HOME>-work` when `CLAWBOO_HOME` is set, else `~/clawboo-work`
- Example: `CLAWBOO_WORK_DIR=/srv/clawboo-work`

New worktrees, review checkouts and team folders still go in `CLAWBOO_HOME`. Clawboo works with a task worktree the board records under the work folder's `worktrees/`, and creates something there only to rebuild such a worktree after a pause. See [The work folder](/operating/data-and-state#the-work-folder).

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

- Type: `http` or `https` URL, with no user name, password or credential parameter in it
- Default: the index at the running release's tag, `https://raw.githubusercontent.com/clawboo/clawboo/refs/tags/clawboo%40<version>/catalog/dist/v1/index.json`. A development build (version `0.0.0-dev`) reads the `main` branch's index instead.
- Example: `CLAWBOO_CATALOG_INDEX_URL=https://mirror.example.com/catalog/v1/index.json`

A `catalog/dist/v1/` folder above the server, as in a source checkout, takes precedence. Pack files are fetched relative to the index, and each is checked against the index's digest before use. The index is cached for 6 hours. When it cannot be reached, the marketplace still shows the built-in pack. When the release's tag has no index (GitHub answers 404), Clawboo reads the `main` branch's index for that refresh. An override is used as it is, with no fallback.

The operator settings file key `catalogIndexUrl` sets the same thing; this variable wins over the file. A value Clawboo cannot use stops the server at startup (see [CLAWBOO_OPERATOR_SETTINGS](#clawboo_operator_settings)).

## Pinned by an administrator

An administrator who deploys Clawboo for a team can pin these settings for everyone, in one file or with these variables. **Settings** > **System** > **Deployment** shows a pinned setting as "Set by your administrator", and it cannot be changed there. [Run the Clawboo server](/operating/deployment#pin-settings-for-everyone) walks through the file.

Which value wins, highest first: what Clawboo itself refuses (an in-app update of an install this user cannot write stays off whatever is pinned), then the key's variable, then the operator file, then a value saved in **Settings** > **System** > **Deployment** (one value for the whole install, not one per person), then the default.

Every flag variable here takes `1` or `true` to turn the setting on and `0` or `false` to pin it off, in any letter case. Empty or unset pins nothing. Any other value stops the server at startup, exiting with code 1 and logging `CONFIG: refusing to start.` with the variable and the reason.

### CLAWBOO_OPERATOR_SETTINGS

Where the operator settings file is.

- Type: path; a leading `~` is expanded and a relative path is resolved
- Default: unset, so Clawboo looks for `<CLAWBOO_HOME>/operator.json` and runs without one when it is not there
- Example: `CLAWBOO_OPERATOR_SETTINGS=/etc/clawboo/operator.json`

The file is a JSON object of the keys below. Clawboo reads it once at startup and never writes it. It stops the server at startup, logging `CONFIG: refusing to start.` and the reason, when:

- this variable names a file that does not exist, or a folder;
- the file is not valid JSON, is not an object, or is larger than 64 KB;
- any user on the machine can write it (on macOS and Linux);
- it has a key Clawboo does not know, or a key whose value has the wrong type;
- a key's name looks like a credential (containing `token`, `secret`, `password`, `apiKey`, `credential`, `privateKey` or `auth`), or a URL carries a user name, a password or a credential parameter. Keep keys in the vault or in the environment.

| Key                        | Type                      | Variable                              |
| -------------------------- | ------------------------- | ------------------------------------- |
| `disableSelfUpdate`        | boolean                   | `CLAWBOO_DISABLE_SELF_UPDATE`         |
| `disableBrowserAutostart`  | boolean                   | `CLAWBOO_DISABLE_BROWSER_AUTOSTART`   |
| `catalogIndexUrl`          | URL                       | `CLAWBOO_CATALOG_INDEX_URL`           |
| `proxyIdentity`            | `off`, `on` or `required` | `CLAWBOO_PROXY_IDENTITY`              |
| `proxyIdentityHeader`      | header name               | `CLAWBOO_PROXY_IDENTITY_HEADER`       |
| `proxyIdentityJwksUrl`     | URL                       | `CLAWBOO_PROXY_IDENTITY_JWKS_URL`     |
| `proxyIdentityPublicKey`   | public key                | `CLAWBOO_PROXY_IDENTITY_PUBLIC_KEY`   |
| `proxyIdentityIssuer`      | string                    | `CLAWBOO_PROXY_IDENTITY_ISSUER`       |
| `proxyIdentityAudience`    | string                    | `CLAWBOO_PROXY_IDENTITY_AUDIENCE`     |
| `proxyIdentityBinding`     | `request` or `session`    | `CLAWBOO_PROXY_IDENTITY_BINDING`      |
| `proxyIdentityMaxLifetime` | seconds (number)          | `CLAWBOO_PROXY_IDENTITY_MAX_LIFETIME` |
| `proxyIdentityNameClaim`   | claim name                | `CLAWBOO_PROXY_IDENTITY_NAME_CLAIM`   |
| `proxyIdentityRoleClaim`   | claim name                | `CLAWBOO_PROXY_IDENTITY_ROLE_CLAIM`   |

Agents run as the same user as the server, so on a shared machine put the file where that user can read it but not write it, such as a root-owned `/etc/clawboo/operator.json`, and point this variable at it.

### CLAWBOO_DISABLE_SELF_UPDATE

Turns off updating Clawboo from the dashboard.

- Type: flag
- Default: unset, so a global install the server's user can write is offered the update
- Example: `CLAWBOO_DISABLE_SELF_UPDATE=1`

With it on, the dashboard shows no update chip, `GET /api/system/self-version` answers as it does with `?local=1` (no call to npm's registry, `latest` is `null`), and `POST /api/system/self-update` refuses with "In-app updates are turned off for this install by its administrator." Use it on an install that something else manages, such as a container image, a distro package or a service manager. Operator file key: `disableSelfUpdate`.

Without it, the update is still refused on an install whose package folder, the folder holding it, or the folder npm links the `clawboo` command into (the prefix's `bin`) the server's user cannot write, such as a root-owned `/usr/local`. The chip there copies the update command instead.

### CLAWBOO_DISABLE_BROWSER_AUTOSTART

Stops Clawboo starting the browser connectors on an install that has never had one.

- Type: flag
- Default: unset, so Playwright and Chrome DevTools start when Clawboo starts, if neither has been connected or disconnected yet
- Example: `CLAWBOO_DISABLE_BROWSER_AUTOSTART=1`

Each browser keeps a process running, and on a machine with no browser installed it cannot browse anyway. With this on, they start only when someone connects them from **Connectors**. Browsers someone already connected still come back after a restart. Anyone using the dashboard can turn the same thing off for the whole install in **Settings** > **System** > **Deployment**, unless this variable or the file pins it. Operator file key: `disableBrowserAutostart`.

### CLAWBOO_PROXY_IDENTITY

Checks the signed identity token a sign-in proxy in front of Clawboo sends with each request, and records the person it names on approvals, chat messages and task moves. [Run Clawboo behind a sign-in proxy](/guides/sso-proxy) has the setup.

- Type: `off`, `on` or `required`
- Default: `off`
- Example: `CLAWBOO_PROXY_IDENTITY=required`

With `on`, a request that carries a token must have a good one, and a request without one works as before, with no name recorded. With `required`, every `/api/` request and the Gateway WebSocket must carry a good token, except a spawned runtime's own MCP calls. A token that does not verify gets `401` in both. The access token is still needed beside it while it is on. Operator file key: `proxyIdentity`.

Turning it on needs a key (`CLAWBOO_PROXY_IDENTITY_JWKS_URL` or `CLAWBOO_PROXY_IDENTITY_PUBLIC_KEY`, not both), `CLAWBOO_PROXY_IDENTITY_ISSUER` and `CLAWBOO_PROXY_IDENTITY_AUDIENCE`. Without them, or with a value Clawboo cannot trust, the server logs `CONFIG: refusing to start.` and exits with code 1. Agents run as the same user as the server, so set these where that user cannot change them: in your service manager, or a root-owned operator file. The server logs a `SECURITY:` warning when they come from a file that user owns, can write, or can replace through a folder above it. On Windows, where it cannot check who can change a file, it logs the warning whenever they come from the operator file.

### CLAWBOO_PROXY_IDENTITY_HEADER

- Type: header name, letters, digits and `-`
- Default: `clawboo-identity`
- Example: `CLAWBOO_PROXY_IDENTITY_HEADER=Cf-Access-Jwt-Assertion`

The request header that carries the token, in any letter case. A `Bearer ` prefix is allowed, so `authorization` works for a proxy that sends `Authorization: Bearer <token>`. Headers Clawboo or a browser already uses, such as `cookie`, `host` and the forwarding headers, are refused, and so is `clawboo-app-identity` while [CLAWBOO_APP_LINK_PUBLIC_KEY](#clawboo_app_link_public_key) is set. Operator file key: `proxyIdentityHeader`.

### CLAWBOO_PROXY_IDENTITY_JWKS_URL

- Type: URL, `https` (plain `http` only to `localhost`, `127.0.0.1` or `::1`)
- Default: unset
- Example: `CLAWBOO_PROXY_IDENTITY_JWKS_URL=https://team.cloudflareaccess.com/cdn-cgi/access/certs`

Where the proxy publishes its public keys as a JWKS. Clawboo keeps the keys for 10 minutes and fetches again for a key id it has not seen, at most once every 30 seconds. While the keys cannot be fetched, every token is refused. Operator file key: `proxyIdentityJwksUrl`.

### CLAWBOO_PROXY_IDENTITY_PUBLIC_KEY

- Type: a PEM public key (`-----BEGIN PUBLIC KEY-----`), a JWK, or a JWKS of up to 16 keys
- Default: unset
- Example: `CLAWBOO_PROXY_IDENTITY_PUBLIC_KEY='{"kty":"OKP","crv":"Ed25519","x":"…"}'`

The proxy's public key itself, for a proxy that publishes no JWKS. Ed25519, P-256, P-384, P-521 and RSA keys of 2048 bits or more work. In a variable, write a PEM on one line with `\n` for each line break. A private key, a shared (`oct`) key or a certificate stops the server at startup. Operator file key: `proxyIdentityPublicKey`.

### CLAWBOO_PROXY_IDENTITY_ISSUER

- Type: string
- Default: unset; required when the lane is on
- Example: `CLAWBOO_PROXY_IDENTITY_ISSUER=https://team.cloudflareaccess.com`

The `iss` every token must carry. Operator file key: `proxyIdentityIssuer`.

### CLAWBOO_PROXY_IDENTITY_AUDIENCE

- Type: string
- Default: unset; required when the lane is on
- Example: `CLAWBOO_PROXY_IDENTITY_AUDIENCE=clawboo`

The `aud` every token must carry. Without it, a token your sign-in provider made for any other app would do. Operator file key: `proxyIdentityAudience`.

### CLAWBOO_PROXY_IDENTITY_BINDING

- Type: `request` or `session`
- Default: `request`
- Example: `CLAWBOO_PROXY_IDENTITY_BINDING=session`

With `request`, every token names its request's method and path (`htm`, `htu`), carries `iat`, `exp` and a `jti`, and is accepted once. With `session`, the proxy's own sign-in token works on any path until it expires, which is what Cloudflare Access and oauth2-proxy send; `htm` and `htu` are still checked when present. Operator file key: `proxyIdentityBinding`.

### CLAWBOO_PROXY_IDENTITY_MAX_LIFETIME

- Type: whole number of seconds, from 1 to 300
- Default: `60`
- Example: `CLAWBOO_PROXY_IDENTITY_MAX_LIFETIME=30`

The longest a request-bound token may live, from its `iat` to its `exp`. Ignored with `session` binding. Clocks may differ by 5 seconds either way. Operator file key: `proxyIdentityMaxLifetime`.

### CLAWBOO_PROXY_IDENTITY_NAME_CLAIM

- Type: claim name, or a dotted path such as `profile.name`
- Default: `name`
- Example: `CLAWBOO_PROXY_IDENTITY_NAME_CLAIM=email`

The claim with the person's name. When the token has none, Clawboo uses `email`, then `preferred_username`. Operator file key: `proxyIdentityNameClaim`.

### CLAWBOO_PROXY_IDENTITY_ROLE_CLAIM

- Type: claim name, or a dotted path such as `realm_access.roles`
- Default: `role`
- Example: `CLAWBOO_PROXY_IDENTITY_ROLE_CLAIM=groups`

The claim with the person's role. A list is joined with commas. The role is recorded with the person, never enforced. Operator file key: `proxyIdentityRoleClaim`.

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

### COMPOSIO_BASE_URL

- Type: URL
- Default: `https://backend.composio.dev`
- Example: `COMPOSIO_BASE_URL=https://composio.example.com`

The Composio API address for brokered apps. The Composio key itself is saved in the vault from **Connectors**; Clawboo does not read it from the environment.

## Runs and verification

### CLAWBOO_MAX_CONCURRENT_RUNS

- Type: whole number, 1 or more
- Default: `8`
- Example: `CLAWBOO_MAX_CONCURRENT_RUNS=4`

How many agent runs Clawboo executes at once, across every team and chat on the server: board tasks, team chat turns and the tasks they delegate, one-to-one chat with Clawboo Native, Claude Code, Codex and Hermes agents, peer exchanges and Routine runs. A run that starts while every slot is taken waits. A person's chat turn or peer exchange goes first. Other runs go by their task's priority, one level higher for every 15 minutes waited, and oldest first within a level, so an **Urgent** task does not wait behind everything queued before it and a **Low** one still gets its turn. While both kinds wait, one slot in every four goes to the background work. A run that has to wait for the same agent's previous run to finish anyway waits without holding a slot, even when one is free, and a later run of another agent can start before it. That way one busy agent cannot take the whole cap. A [paused](/using/board#pause-work) run waits the same way. Waiting is never a failure: a waiting task does not move to **Blocked**, the idle watchdogs do not count the wait, and Stop takes a waiting run out of the queue. Routines that fall due together start as slots free up. The verification reviewer runs inside the slot of the run it checks. One-to-one chat with an OpenClaw agent goes through the Gateway, not the server, so the cap does not count it. Any value that is not a whole number of at least 1 means the default, and the server logs it.

### CLAWBOO_RUN_SILENT_TIMEOUT_MS

- Type: milliseconds
- Default: `1800000` (30 minutes)
- Example: `CLAWBOO_RUN_SILENT_TIMEOUT_MS=3600000`

How long a run may go without producing any event before Clawboo stops it. Every event restarts the clock, so a run that keeps working is never cut off. It applies to team chat runs (including delegated tasks and team Routines), to agent Routines on Clawboo Native, Claude Code, Codex and Hermes, and to one-to-one chat with those agents. A delegated task in team chat also has its own fixed 8-minute idle watchdog; see [Limits and defaults](/reference/limits-and-defaults). Time the computer spends asleep does not count, except a sleep of under about a minute.

### CLAWBOO_HERMES_TRANSPORT

- Type: `acp` or `quiet`
- Default: unset
- Example: `CLAWBOO_HERMES_TRANSPORT=quiet`

How Clawboo drives Hermes runs. Unset, it uses `hermes acp`, Hermes's Agent Client Protocol mode, and falls back to the quiet one-shot `hermes chat` for a run where `hermes acp` cannot start or its handshake fails or times out (a run that stalls after the handshake does not fall back); after such a fallback it skips ACP for ten minutes. `quiet` always uses `hermes chat`. `acp` always tries ACP first, even right after a fallback. See [Hermes](/runtimes/hermes).

### CLAWBOO_HOME_MUTEX_ACQUIRE_MS

- Type: milliseconds
- Default: `600000` (10 minutes)
- Example: `CLAWBOO_HOME_MUTEX_ACQUIRE_MS=900000`

How long a run waits for the same agent's previous run to finish before it gives up. It bounds the wait, never the run. Time the computer spends asleep does not count, except a sleep of under about a minute.

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

How long a Routine that runs an OpenClaw agent waits for that agent to finish. Past it, Clawboo stops waiting and returns the task to **To do**. Time the computer spends asleep does not count.

## Board timing

### CLAWBOO_BOARD_STALE_TTL_MS

- Type: milliseconds, a whole number from 1 to 2147483647
- Default: `180000` (3 minutes)
- Example: `CLAWBOO_BOARD_STALE_TTL_MS=240000`

A running task proves it is alive with a heartbeat every 30 seconds. A task in **In progress** that misses heartbeats for this long is marked timed out and returned to **To do**. Time the computer spends asleep does not count. At startup the same value decides which runs a previous server left behind. Keep it well above 30 seconds, and keep it plus `CLAWBOO_BOARD_STALE_SWEEP_MS` under 8 minutes, the fixed delegation watchdog, or that watchdog fails the task first.

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

The age at which the hourly reaper marks a still-pending approval expired. It moves no task. It does not change how long an approval prompt waits for your answer: tool and delegation approvals expire after 5 minutes whatever this is set to. [Limits and defaults](/reference/limits-and-defaults) lists every approval window.

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

An agent browser nobody has used for this long is closed. Time the computer spends asleep does not count, except a sleep of under about a minute.

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

| Variable                                                                          | Set on                                     | Value                                                                                                                                                                                                                                  |
| --------------------------------------------------------------------------------- | ------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `CLAWBOO_VERSION`                                                                 | The server the CLI starts                  | The CLI's version, which the server reports as its own. Without it the server reads its version from its package, or `0.0.0-dev` in a source checkout. The in-app update leaves it out, so the new server reads its version from disk. |
| `CLAWBOO_LAUNCH_DIR`                                                              | The server the CLI starts                  | The folder you ran `clawboo` from, offered as "Where you started clawboo" in connector setup. Ignored unless it is an absolute path to an existing folder.                                                                             |
| `CLAWBOO_MCP_BIN_DIR`                                                             | The server the CLI starts (normal install) | The bundled `bin` folder, so stdio attach snippets point at the right files. Without it, snippets show a `<path-to>/dist/bin/<server>.js` placeholder.                                                                                 |
| `CLAWBOO_API_PORT` with `CLAWBOO_AWAIT_PORT`                                      | A restarted server                         | The port to keep; the new server waits up to 15 seconds for it to free. The new server also gets the old one's node options, such as `--max-old-space-size`, except the inspector's.                                                   |
| `CHROME_DEVTOOLS_MCP_NO_USAGE_STATISTICS`, `CHROME_DEVTOOLS_MCP_NO_UPDATE_CHECKS` | The Chrome DevTools connector              | `1`, which turns off its usage statistics and its daily check for a newer version. If the server's own environment sets either variable, that value is passed on instead.                                                              |
| `NODE_ENV`                                                                        | The server the CLI starts                  | `production`                                                                                                                                                                                                                           |
| `CODEX_HOME`, `HERMES_HOME`                                                       | Each Codex or Hermes run                   | That agent's own home folder under `~/.clawboo/runtimes/`                                                                                                                                                                              |
| The runtime's provider key, such as `ANTHROPIC_API_KEY`                           | Each runtime run                           | The key found in the environment, the vault or OpenClaw's `.env`                                                                                                                                                                       |
| `NO_PROXY`, `no_proxy`                                                            | Each runtime run, when a proxy is set      | Your list plus `127.0.0.1,localhost,::1`                                                                                                                                                                                               |
| `OPENCLAW_SERVICE_REPAIR_POLICY`, `NO_COLOR`                                      | The `openclaw doctor --fix` repair run     | `external` (leave any system Gateway service alone) and `1`                                                                                                                                                                            |
| `CLAWBOO_DB_PATH`                                                                 | Stdio attach snippets                      | The dashboard's database file                                                                                                                                                                                                          |

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

## What connectors and approved commands inherit

Local connectors and the shell commands you approve for a Clawboo Native agent start from an empty environment instead. They get back only:

- What a process needs to start: `PATH`, `HOME`, `SHELL`, `USER`, `LOGNAME`, `TERM`, `TMPDIR`, `TZ`, `LANG`, `LC_ALL` and `LC_CTYPE`, and on Windows `SystemRoot`, `APPDATA`, `LOCALAPPDATA`, `USERPROFILE`, `TEMP` and the other system folders.
- Proxy settings: `HTTP_PROXY`, `HTTPS_PROXY` and `NO_PROXY`, in either case.
- npm's prefix, cache and update check: `npm_config_prefix`, `npm_config_cache` and `npm_config_update_notifier`, in lower or upper case (`NPM_CONFIG_PREFIX` and so on). No other npm setting arrives, so npm credentials such as `npm_config__authToken` stay out.
- For a connector, the keys you entered for that connector.

A connector also gets `npm_config_update_notifier=false` when neither spelling is set, so its `npx` start does not ask the registry for a newer npm. An approved command runs npm as you configured it.

<Accordion title="Source of truth">

Server start: `apps/web/server/index.ts`, `lib/resolveHost.ts`, `lib/portUtils.ts`. Pinned settings: `lib/operatorSettings.ts`. Access: `packages/gateway-proxy/src/access-gate.ts`, `origin-guard.ts`. Paths and the base path: `packages/config/src/index.ts`, `basePath.ts`. Keys: `apps/web/server/lib/secretsVault.ts`, `lib/runtimes/descriptor.ts`. Runtime environments: `lib/runtimes/childEnv.ts`; connectors and approved commands: `packages/mcp/src/connector/env.ts`. Each timer's variable is read next to its default; [Limits and defaults](/reference/limits-and-defaults) gives the file and line.

</Accordion>

## Related

- [Configuration](/reference/configuration): the files these variables move, and what is stored where
- [CLI reference](/reference/cli): the variables the `clawboo` command reads and sets
- [Limits and defaults](/reference/limits-and-defaults): every number, including the ones you cannot change
- [Self-host securely](/guides/self-host-securely): `HOST`, the access token and the allowlists, step by step
- [Security](/operating/security): what the access gate, the origin check and the vault protect
