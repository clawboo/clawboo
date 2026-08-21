---
title: Runtimes API
description: 'REST reference for the runtimes resource group: list, install, connect, healthcheck, run, seed a native team, and manage LLM provider keys.'
---

REST surface for the four non-OpenClaw [runtimes](/appendices/glossary) (`claude-code`, `codex`, `hermes`, `clawboo-native`): list their capabilities and connection state, install a runtime CLI, connect or disconnect a provider key, verify a key before use, and drive a board task on a chosen runtime. This group also covers the `/api/onboarding/*` first-run routes and the `/api/providers*` group that backs the Settings → **Providers** panel.

<Note>
OpenClaw is the fifth runtime but it is NOT in this group; it is a connected substrate driven over the Gateway, not a CLI you install or a key you paste. These routes 404 the `openclaw` id (it is not a member of `NonOpenClawRuntimeId`). See [System API](/reference/rest-api/system) for OpenClaw lifecycle and [Agents API](/reference/rest-api/agents) for the agent registry.
</Note>

The `:id` path segment is validated against the runtime set on every route except `seed-native-team`. An unknown id returns **404** `{ error: "unknown runtime '<id>'" }`. All POST routes read a JSON body parsed by `express.json({ limit: '2mb' })`.

## Routes

| Method | Path                                  | Summary                                                       | Stream? |
| ------ | ------------------------------------- | ------------------------------------------------------------- | ------- |
| GET    | `/api/runtimes`                       | List runtimes with capabilities, health, and connection state | No      |
| POST   | `/api/runtimes/:id/install`           | Install the runtime CLI                                       | SSE     |
| POST   | `/api/runtimes/:id/connect`           | Store a provider key in the encrypted vault                   | No      |
| POST   | `/api/runtimes/:id/disconnect`        | Clear the stored credential                                   | No      |
| POST   | `/api/runtimes/:id/logout`            | Sign out an `oauth` runtime (runs the CLI's own `logout`)     | No      |
| POST   | `/api/runtimes/:id/healthcheck`       | Verify a pasted or stored provider key (no persistence)       | No      |
| POST   | `/api/runtimes/:id/run`               | Drive a board task on the runtime end to end                  | No      |
| GET    | `/api/runtimes/openrouter/models`     | The live OpenRouter catalog (Hermes model picker)             | No      |
| POST   | `/api/onboarding/seed-native-team`    | Mint a default native leader + specialist team                | No      |
| POST   | `/api/onboarding/native-leader-model` | Record the chosen leader provider + model                     | No      |
| GET    | `/api/onboarding/native-leader-model` | The recorded leader provider + model (nulls when unset)       | No      |
| GET    | `/api/onboarding/state`               | Aggregated first-run signals in one call                      | No      |
| GET    | `/api/providers`                      | List every provider with its connection state                 | No      |
| POST   | `/api/providers/:id/connect`          | Store a provider key                                          | No      |
| POST   | `/api/providers/:id/disconnect`       | Clear a stored provider key                                   | No      |
| GET    | `/api/providers/:id/models`           | Live model list using the **stored** key                      | No      |
| POST   | `/api/providers/:id/models`           | Live model list using a **pasted** (unsaved) key              | No      |
| POST   | `/api/auth/cli-login/:tool`           | Drive a CLI's own OAuth sign-in and relay its output          | SSE     |

<Info>
`POST /api/runtimes/:id/install` and `POST /api/auth/cli-login/:tool` are **Server-Sent Events**, not request/response. They are documented below with an event-stream catalog (event `type` → payload), not a JSON response body. For install, a built-in runtime (`clawboo-native`) short-circuits with a plain JSON **400** before the stream opens; for cli-login, an unknown `:tool` short-circuits with a plain JSON **404**.
</Info>

---

## `GET /api/runtimes`

Lists every runtime with its capabilities, live health, and install/auth status. The `runtimes[]` entries lead with the back-compat fields (`id`, `participantKind`, `capabilities`, `health`) followed by the install/auth status fields. The sibling `available[]` array advertises the full catalog so a UI can render "available to add" cards for runtimes the user has not connected.

- **Path/query params**: none.
- **Request body**: none.

### Responses

**`200 OK`**: the runtime list plus the descriptor catalog:

```ts
{
  runtimes: Array<{
    // back-compat shape (leading fields)
    id: 'claude-code' | 'codex' | 'hermes' | 'clawboo-native'
    participantKind: 'agent' | 'human'
    capabilities: {
      streaming: boolean
      mcp: boolean
      worktrees: boolean
      resume: boolean
      toolApproval: boolean
      models: string[]
      contextWindowTokens?: number
      runtimeClass?: 'wrapped-oneshot' | 'connected-substrate' | 'native'
      nativeHome?: { scope: 'per-identity' | 'per-run'; persist: boolean }
      nativeSkills?: 'preserve' | 'none'
      nativeMemory?: 'preserve' | 'none'
      nativeChannels?: 'gateway' | 'none'
      nativeScheduler?: boolean
    }
    health: { ok: boolean; message?: string }
    // install/auth status fields (spread from runtimeStatus)
    name: string
    installed: boolean
    binPath: string | null
    builtIn: boolean
    authKind: 'api-key' | 'oauth' | 'none'
    envVar: string | null
    hasCredential: boolean
    hasVaultCredential: boolean
    loggedIn: boolean // oauth runtimes only: an existing `codex login` was detected
    codexAuth: boolean // hermes only: a ChatGPT-subscription login is present
    installCommand: string | null
    docsUrl: string
    connectionState: 'not-installed' | 'needs-auth' | 'needs-login' | 'ready' | 'unknown'
  }>
  available: Array<{
    id: string
    name: string
    healthBin: string | null
    packageManager: 'npm' | 'pip' | null
    installCommand: string | null
    builtIn: boolean
    authKind: 'api-key' | 'oauth' | 'none'
    envVar: string | null
    docsUrl: string
    headlessAuth: boolean
  }>
}
```

`installed` is `true` for the built-in `clawboo-native` (it ships inside the server) and otherwise reflects whether `healthBin` resolves on `PATH` or a known user-install dir. `hasCredential` is presence-only; the secret value is never read into the response. `hasVaultCredential` is the same presence check but **vault-only** (via `getRuntimeSecret`): it ignores a key that resolves only from a bare `process.env` var, so it reflects a deliberate connect. The onboarding-landing decision (`GatewayBootstrap.hasConnectedRuntime`) reads `hasVaultCredential`, not `hasCredential`, so an env-var-only environment is not mistaken for a connected runtime. `connectionState` is derived as: `not-installed` if not installed; otherwise `ready` for `authKind: 'none'`, `ready`/`needs-login` for `oauth` (Codex) depending on whether an existing `codex login` is detected, and `ready`/`needs-auth` for `api-key` depending on `hasCredential`. `loggedIn` is true only for an installed `oauth` runtime whose terminal login was detected, and it is what flips that runtime's `connectionState` to `ready`. `codexAuth` is the Hermes-only ChatGPT-subscription signal (a usable `openai-codex` credential in `~/.hermes/auth.json`, which has no env var and no vault slot); it folds into `hasCredential`. Both are `false` for every other runtime.

**`500 Internal Server Error`**: any failure constructing an adapter or probing health:

```json
{ "error": "<message>" }
```

### Example

```bash
curl http://localhost:18790/api/runtimes
```

---

## `POST /api/runtimes/:id/install`

Installs the runtime's CLI. npm runtimes (`claude-code`, `codex`) run `npm install -g <pkg>`; the pip runtime (`hermes`) prefers `pipx install <pkg>` and falls back to `python -m pip install --user`, retrying once with `--break-system-packages` on a PEP-668 externally-managed environment. The built-in `clawboo-native` returns a plain **400** before any stream opens.

- **Path params**: `id` (runtime id; 404 on unknown).
- **Request body**: none.

### Responses

**`400 Bad Request`**: the runtime is built in (no stream opens):

```json
{ "error": "Clawboo Native is built in — nothing to install" }
```

**`200 OK` + `text/event-stream`**: for an installable runtime the handler sets `Content-Type: text/event-stream`, flushes headers, and streams SSE frames. Each frame is `data: <json>\n\n`. The active child process is killed if the client closes the connection.

#### Event catalog

| `type`     | When                                                              | Payload fields                                     |
| ---------- | ----------------------------------------------------------------- | -------------------------------------------------- |
| `progress` | Install start, and on the PEP-668 retry                           | `step` (`'installing'` \| `'retrying'`), `message` |
| `output`   | Per non-empty stdout/stderr line                                  | `line`                                             |
| `error`    | Tooling missing, permission denied, spawn throw, or non-zero exit | `code`, `message`                                  |
| `complete` | Process exits 0                                                   | `success: true`, optional `warning`                |

The terminal `error` `code` values:

| `code`           | Meaning                                                           |
| ---------------- | ----------------------------------------------------------------- |
| `NPM_MISSING`    | `npm` not found (npm runtimes)                                    |
| `PYTHON_MISSING` | No Python with pip/pipx found (Hermes)                            |
| `PYTHON_TOO_OLD` | A Python was found but is older than 3.11 (Hermes)                |
| `EACCES`         | Permission denied (stderr matched `EACCES` / "permission denied") |
| `SPAWN_THROW`    | The spawn call threw synchronously                                |
| `SPAWN_ERROR`    | The child emitted an `error` event                                |
| `EXIT_<code>`    | Non-zero process exit (e.g. `EXIT_1`)                             |

On success the handler emits `complete` with `success: true`; if `healthBin` still does not resolve, `complete` carries a `warning` advising a server restart.

Example frames:

```text
data: {"type":"progress","step":"installing","message":"Installing Claude Code…"}

data: {"type":"output","line":"added 1 package in 3s"}

data: {"type":"complete","success":true}
```

### Example

```bash
curl -N -X POST http://localhost:18790/api/runtimes/claude-code/install
```

---

## `POST /api/runtimes/:id/connect`

Stores a provider key in the encrypted vault and marks the runtime connected. Behavior branches on the descriptor's `authKind`: an `oauth` runtime (Codex) cannot be connected with a pasted key and returns the terminal login command; an `api-key` runtime writes the key to its vault slot. The native runtime is multi-provider; the optional `provider` field routes the key to the correct env var. The key is never echoed in the response.

- **Path params**: `id` (runtime id; 404 on unknown).
- **Request body**:

```ts
{
  apiKey?: string     // required for api-key runtimes (non-ollama)
  provider?: string   // clawboo-native only: routes the key to the provider's env var
}
```

### Responses

**`200 OK`**: `oauth` runtime (Codex): a key-less branch that probes the existing terminal login and returns the current state plus the login command:

```ts
{
  ok: true,
  connectionState: 'ready' | 'needs-login' | 'not-installed',
  loginCommand: 'codex login',
}
```

`ready` when clawboo detects and reuses an existing `codex login`; `not-installed` when the CLI is absent; `needs-login` otherwise.

**`200 OK`**: `authKind: 'none'`, or no `envVar`, or a keyless native provider (`provider: 'ollama'`): nothing stored, state re-derived:

```ts
{ ok: true, connectionState: 'not-installed' | 'needs-auth' | 'needs-login' | 'ready' | 'unknown' }
```

**`400 Bad Request`**: an `api-key` runtime with a missing or blank `apiKey`:

```json
{ "error": "apiKey is required" }
```

**`200 OK`**: key stored, state re-derived (typically `ready`):

```ts
{ ok: true, connectionState: 'ready' }
```

<Tip>
For `clawboo-native`, omit `provider` to store under `ANTHROPIC_API_KEY`, or pass `provider: "openai"` / `"openrouter"` to store under that provider's env var. An unrecognized provider falls back to the descriptor's default `envVar`.
</Tip>

### Example

```bash
# Claude Code (api-key)
curl -X POST http://localhost:18790/api/runtimes/claude-code/connect \
  -H 'Content-Type: application/json' \
  -d '{"apiKey":"sk-ant-..."}'

# Native, choosing OpenRouter
curl -X POST http://localhost:18790/api/runtimes/clawboo-native/connect \
  -H 'Content-Type: application/json' \
  -d '{"apiKey":"sk-or-...","provider":"openrouter"}'
```

---

## `POST /api/runtimes/:id/disconnect`

Clears the stored credential for the runtime. The binary stays installed and the runtime stays available; the card returns to `needs-auth` (the vault slot is empty). For a runtime with no `envVar` (Codex), this is a no-op on storage.

- **Path params**: `id` (runtime id; 404 on unknown).
- **Request body**: none.

### Responses

**`200 OK`**: credential cleared, state re-derived:

```ts
{ ok: true, connectionState: 'needs-auth' | 'needs-login' | 'ready' | 'not-installed' | 'unknown' }
```

### Example

```bash
curl -X POST http://localhost:18790/api/runtimes/hermes/disconnect
```

---

## `POST /api/runtimes/:id/logout`

Signs an `oauth` runtime (Codex) out by spawning the CLI's **own** `logout`; clawboo never deletes the vendor's tokens itself. The spawn is best-effort and the answer comes from a fresh `codex login status` re-probe, not from the child's exit code. An `api-key` runtime has no sign-out (use `/disconnect`).

<Warning>
This signs out the ChatGPT subscription that every tool on the machine shares, not only clawboo's view of it.
</Warning>

- **Path params**: `id` (runtime id; 404 on unknown).
- **Request body**: none.

### Responses

**`404 Not Found`**: the runtime's `authKind` is not `oauth`:

```json
{ "error": "runtime '<id>' has no sign-out" }
```

**`400 Bad Request`**: the runtime's CLI binary does not resolve:

```json
{ "error": "<name> is not installed" }
```

**`200 OK`**: the re-probe result. `ok` is the inverse of the probed login state, so a sign-out that did not take reads `ok: false`:

```ts
{ ok: true, connectionState: 'needs-login' }  // signed out
{ ok: false, connectionState: 'ready' }       // still logged in
```

### Example

```bash
curl -X POST http://localhost:18790/api/runtimes/codex/logout
```

---

## `POST /api/runtimes/:id/healthcheck`

Verifies a provider credential with a single authenticated GET to the provider's models/health endpoint, before anything commits to it. The key is used for exactly one fetch; it is never persisted to the vault, never logged, and never echoed. A bad key or unreachable provider resolves to `{ ok: false, error }` (the handler does not throw into the request).

Every clawboo surface that accepts or reuses a credential calls this first: the onboarding connect step, the Providers hub, the runtime connect card, and the Providers manager's one-click **Use**.

<Info>
This route is native-only. Any other `:id` (still a valid runtime) returns **400**. It probes a **provider**, not a runtime, so a surface holding a key for any other runtime verifies it by naming that key's provider here.
</Info>

- **Path params**: `id` (runtime id; 404 on unknown; **400** if not `clawboo-native`).
- **Request body**:

```ts
{
  provider?: string   // 'anthropic' | 'openai' | 'openrouter' | 'ollama' |
                      // 'google' | 'xai' | 'groq' | 'mistral' | 'together' |
                      // 'cerebras' | 'moonshot'
  apiKey?: string     // optional: omit to probe the key already stored for
                      // `provider`. Required only when nothing is stored
                      // (and never needed for keyless ollama).
}
```

Provider → probe endpoint: `anthropic` → `https://api.anthropic.com/v1/models`; `openai` → `https://api.openai.com/v1/models`; `openrouter` → `https://openrouter.ai/api/v1/models`; the extra OpenAI-compatible providers (`google`, `xai`, `groq`, `mistral`, `together`, `cerebras`, `moonshot`) → that provider's own `<baseURL>/models`; `ollama` → `<OLLAMA_BASE_URL>/api/tags` (keyless). The fetch is bounded by an 8-second timeout.

### Responses

**`400 Bad Request`**: `:id` is not the native runtime:

```json
{ "ok": false, "error": "healthcheck is only supported for the native runtime" }
```

**`400 Bad Request`**: unknown provider:

```json
{ "ok": false, "error": "unknown provider '<provider>'" }
```

**`400 Bad Request`**: non-ollama provider with a blank `apiKey` **and** no key stored for it:

```json
{ "ok": false, "error": "apiKey is required" }
```

**`200 OK`**: provider reachable and the key authenticated:

```json
{ "ok": true }
```

**`200 OK`**: provider rejected the key or returned an error (note: still HTTP 200, the failure is in the body):

```ts
{ ok: false, error: 'Invalid API key.' }            // 401/403 from the provider
{ ok: false, error: 'Provider returned <status>.' } // other non-2xx
{ ok: false, error: 'Could not reach <provider> (timed out).' } // 8s abort
{ ok: false, error: 'Could not reach <provider>.' }            // network error
```

### Example

```bash
curl -X POST http://localhost:18790/api/runtimes/clawboo-native/healthcheck \
  -H 'Content-Type: application/json' \
  -d '{"provider":"anthropic","apiKey":"sk-ant-..."}'
```

---

## `POST /api/runtimes/:id/run`

Drives a board task on the runtime end to end: claim → worktree → run → report-up, via the server-side executor runner. The runtime's MCP client attaches to this server's `/api/mcp/*` endpoints over a server-trusted loopback URL (never the client-supplied `Host`). Any connected provider key is injected from the vault into the spawned process env. If the client disconnects before the run finishes, the run (and its subprocess) is aborted and the task released.

- **Path params**: `id` (runtime id; 404 on unknown).
- **Request body**:

```ts
{
  taskId: string                    // required
  assigneeAgentId?: string          // default = the runtime id; must match /^[A-Za-z0-9_-]+$/
  repoPath?: string | null          // git repo to branch the worktree from
  kind?: string                     // task kind → isolation; default 'code'
  model?: string | null             // model override for the run
  keepForResume?: boolean           // pause-for-handoff: keep worktree + release task
  disableMemoryAutoInject?: boolean // skip run-start memory injection
  maxRotations?: number             // bound the session-rotation chain
  breakerConfig?: object            // per-run circuit-breaker overrides (zod-validated; ignored if invalid)
  parentTraceparent?: string | null // W3C traceparent to nest this run's trace
}
```

The result returned on the `200`/`409`/`404`/`422` paths is the executor runner's `RunTaskResult`. The handler maps the `!ok` reasons to status codes: `not_found` → **404**, `conflict` → **409**, and every other failure reason (`too_deep`, `connected_substrate`, `budget_paused`) → **422**.

### Responses

**`400 Bad Request`**: missing `taskId`:

```json
{ "error": "taskId is required" }
```

**`400 Bad Request`**: `assigneeAgentId` is not a bare identifier (`/^[A-Za-z0-9_-]+$/`):

```json
{ "error": "invalid assigneeAgentId" }
```

**`200 OK`**: the task ran (the success branch of `RunTaskResult`):

```ts
{
  ok: true
  runtimeId: string
  execId: string
  doneReason: 'success' | 'max_turns' | 'aborted' | 'error'
  status: string
  summary: string
  costUsd: number | null
  usedWorktree: boolean
  degradations: string[]
}
```

**`404 Not Found`**: the task does not exist (`reason: 'not_found'`):

```json
{ "ok": false, "reason": "not_found" }
```

**`409 Conflict`**: the task could not be atomically claimed (another worker won; `reason: 'conflict'`). Per the board's atomic-claim contract, a 409 is data; do not retry it:

```json
{ "ok": false, "reason": "conflict" }
```

**`422 Unprocessable Entity`**: the run was refused for a board/runtime reason (`reason` is one of `too_deep`, `connected_substrate`, `budget_paused`):

```ts
{ ok: false, reason: 'too_deep' | 'connected_substrate' | 'budget_paused' }
```

`too_deep` = the delegation depth ceiling was hit; `connected_substrate` = the runtime is a connected substrate (it cannot be dispatched through this path); `budget_paused` = a budget kill-switch is paused.

**`500 Internal Server Error`**: an unexpected throw inside the run:

```json
{ "error": "<message>" }
```

### Example

```bash
curl -X POST http://localhost:18790/api/runtimes/claude-code/run \
  -H 'Content-Type: application/json' \
  -d '{"taskId":"<task-uuid>","repoPath":"/path/to/repo","kind":"code"}'
```

---

## `GET /api/runtimes/openrouter/models`

The live OpenRouter catalog behind the OpenRouter model pickers. It reads OpenRouter's public list endpoint (no key), keeps text-capable models, sorts them by label, and caches the result in-process for 30 minutes behind an 8-second fetch timeout.

- **Path/query params**: none.
- **Request body**: none.

### Responses

**`200 OK`**: the catalog. This route never errors: a failed, empty, or timed-out fetch falls back to the last good cache, and an empty array tells the client to fall back to its own hardcoded set:

```ts
{
  models: Array<{ id: string; label: string }>
}
```

### Example

```bash
curl http://localhost:18790/api/runtimes/openrouter/models
```

---

## `POST /api/onboarding/seed-native-team`

Mints a default native team, a leader (capable model) and a specialist (cheap model), both with the Memory and Tools MCP, TeamChat, and read-only Tasks (board writes stay engine-owned), so a first-run user who just connected a provider key lands in a working team. Both agents are `clawboo-native` rows created through the native AgentSource (no Gateway, no provider SDK call). The team row is inserted first (the agents' `teamId` FK requires it), the agents are created with that `teamId`, the leader is recorded, and the "Know Your Team" onboarding flags are pre-satisfied so the user lands straight in chat.

<Note>
This route is not under `/api/runtimes` and takes no `:id` segment. It is grouped here because it is the native runtime's first-run seed step.
</Note>

- **Path/query params**: none.
- **Request body**:

```ts
{
  provider?: string  // 'anthropic' | 'openai' | 'openrouter' | 'ollama' |
                     // 'google' | 'xai' | 'groq' | 'mistral' | 'together' |
                     // 'cerebras' | 'moonshot'; resolved from the connected
                     // provider when omitted (see below)
  model?: string     // optional leader-model override (the specialist keeps its default)
}
```

When `provider` is omitted, the seed resolves one from what is actually usable instead of assuming Anthropic: first the recorded leader-model pick (`POST /api/onboarding/native-leader-model`) when that provider can still run, then the first connected provider in `KNOWN_PROVIDERS` priority order, and only when nothing is connected at all does it fall back to `anthropic`. This keeps a bare `{}` seed from minting a team whose configured key slot is empty, which would pass health checks and then fail every run.

The two Ollama rules differ on purpose, because it is keyless. Judging a pick the user already made asks whether it can run, and an Ollama pick always can (the runtime falls back to a local base URL), so a deliberate local-model choice is never swapped for a billed provider. Deriving a provider when the user chose none asks whether Ollama was actually set up, which takes a configured `OLLAMA_BASE_URL`; without that signal every install would look Ollama-ready.

Per-provider model defaults (leader = a capable model, specialist = a cheap one) come from `MODEL_DEFAULTS` in `apps/web/server/lib/runtimes/native/nativeProviderDefaults.ts`, which is the drift-free source: `anthropic` → `claude-sonnet-5` / `claude-haiku-4-5`; `openai` → `gpt-5.4` / `gpt-4o-mini`; `openrouter` → `anthropic/claude-haiku-4.5` / `openai/gpt-4o-mini`; `ollama` → `llama3.2` / `llama3.2`; `google` → `gemini-2.0-flash` (both tiers); `xai` → `grok-2-latest` (both tiers); `groq` → `llama-3.3-70b-versatile` / `llama-3.1-8b-instant`; `mistral` → `mistral-large-latest` / `mistral-small-latest`; `together` → `meta-llama/Llama-3.3-70B-Instruct-Turbo` (both tiers); `cerebras` → `llama-3.3-70b` (both tiers); `moonshot` → `moonshot-v1-32k` / `moonshot-v1-8k`.

### Responses

**`400 Bad Request`**: `provider` is not one of the known native providers:

```json
{ "error": "unknown provider '<provider>'" }
```

**`201 Created`**: the team and its two agents were created:

```ts
{ teamId: string, leaderAgentId: string, specialistAgentId: string }
```

**`500 Internal Server Error`**: a failure creating the team or agents:

```json
{ "error": "<message>" }
```

### Example

```bash
curl -X POST http://localhost:18790/api/onboarding/seed-native-team \
  -H 'Content-Type: application/json' \
  -d '{"provider":"anthropic"}'
```

---

## Onboarding

The three remaining `/api/onboarding/*` routes. Like `seed-native-team`, they take no `:id` segment and are grouped here because they are the native runtime's first-run surface.

### `POST /api/onboarding/native-leader-model`

Records the provider + model the user picked when connecting a native key, so the lazily-created universal Boo Zero runs on it instead of the auto-resolved per-provider default. Body `{ provider, model }`. The pick is also retro-applied to an existing native Boo Zero, best-effort: on a fresh install there is no Boo Zero yet, which is the normal case and not an error. Returns `{ ok: true }`. **400** `{ error: "unknown provider '<provider>'" }` when `provider` is not a known native provider, or `{ error: "model is required" }` when `model` is missing or blank. **500** `{ error }` if the setting cannot be written.

### `GET /api/onboarding/native-leader-model`

The recorded pick, read by the Runtimes panel's native provider manager so its "Default" tag and model dropdown reflect reality. Returns `{ provider, model }`, or `{ provider: null, model: null }` when nothing was ever recorded or the stored value does not parse. Never errors.

### `GET /api/onboarding/state`

The aggregated first-run signals in one call, so a thin client (desktop, mobile, npm) can decide wizard-vs-dashboard without re-running the browser's multi-call dance. Read-only; each field reuses the same detection the individual routes use:

```ts
{
  configured: boolean // OpenClaw installed + `openclaw.json` + `.env` present
  hasNative: boolean // at least one `clawboo-native` agent row
  hasTeam: boolean // at least one team row
  hasConnectedRuntime: boolean // see below
}
```

`hasConnectedRuntime` is true when any runtime has a key in the vault (the `hasVaultCredential` signal `GET /api/runtimes` exposes), or when an existing `codex login` is detected, or when a Hermes ChatGPT-subscription login is present. Codex is the exception that needs the extra probes: it has no env var and no vault slot, so without them a subscription-only user would be re-trapped in the wizard on every reload.

**500** `{ error }` on an unexpected throw.

---

## Providers

`/api/providers*` backs the Settings → **Providers** panel: the LLM provider keys that power `clawboo-native` (and any runtime routed through the same provider). A **provider** is not a runtime; `anthropic` is a provider, `clawboo-native` is a runtime that consumes one.

### `GET /api/providers`

Returns `{ providers: ProviderStatus[] }`: every known provider with its connection state. Never errors.

### `POST /api/providers/:id/connect`

Body `{ apiKey }`. Stores the key in the encrypted vault. Returns `{ ok: true, providers }` (the refreshed list). **400** `{ error: "unknown provider '<id>'" }` for an unknown id, or `{ error: 'apiKey is required' }` when the key is missing or blank.

### `POST /api/providers/:id/disconnect`

Clears the stored key. Returns `{ ok: true, providers }`. **400** for an unknown id.

### `GET /api/providers/:id/models`

The provider's **live** model list, enumerated with the **stored** key. Returns `{ models: [] }` for a keyless or non-enumerating provider rather than an error, so the client can fall back to its static catalog.

### `POST /api/providers/:id/models`

Body `{ apiKey }`. The live model list using a **pasted, unsaved** key: this is what the onboarding step calls before any key is stored. The key is used for exactly one fetch and is **never logged, persisted, or echoed back**. Returns `{ models: [] }` when the provider does not enumerate or the key is blank.

<Note>
Only providers that support live enumeration return a non-empty `models` array; the rest return `{ models: [] }` by design. See [Connecting runtimes](/runtimes/connecting-runtimes) for the vault and the connection-state machine.
</Note>

---

## `POST /api/auth/cli-login/:tool`

The UI-driven "Sign in with ChatGPT". Spawns the official CLI's own login command locally and relays its user-facing output (device code, auth URL) over SSE. The OAuth exchange stays inside the vendor CLI, the human authorizes in a browser, and clawboo never touches the tokens. Only one login child runs per tool: a new request kills the previous tree first (Retry semantics), and the run is capped at 16 minutes because the CLIs' own device windows are 15.

- **Path params**: `tool`, one of `codex`, `hermes`, `openclaw`.
- **Request body**: none.

### Responses

**`404 Not Found`**: unknown `:tool`. This is plain JSON sent **before** the stream opens:

```json
{ "error": "unknown login tool: <tool>" }
```

**`200 OK` + `text/event-stream`**: otherwise the handler sets `Content-Type: text/event-stream`, flushes headers, and streams `data: <json>\n\n` frames. A plan that cannot be built (CLI not installed, or the OpenClaw flow on Windows) is reported as an `error` frame **inside** the stream, not as an HTTP error, so the UI can degrade to its copy-the-command fallback.

#### Event catalog

| `type`        | When                                                       | Payload fields                            |
| ------------- | ---------------------------------------------------------- | ----------------------------------------- |
| `progress`    | The login command is about to start                        | `step: 'starting'`, `message`             |
| `output`      | Per non-empty stdout/stderr line (ANSI stripped)           | `line`                                    |
| `device-code` | A device code was parsed out of the CLI's output           | `url`, `code`                             |
| `auth-url`    | A browser auth URL was parsed out of the CLI's output      | `url`                                     |
| `error`       | Plan failure, spawn failure, timeout, or user cancellation | `code`, `message`                         |
| `complete`    | The sign-in finished (successfully or not)                 | `success`, `loggedIn`, optional `message` |

The `error` `code` values:

| `code`                 | Meaning                                              |
| ---------------------- | ---------------------------------------------------- |
| `NOT_INSTALLED`        | The tool's CLI does not resolve                      |
| `UNSUPPORTED_PLATFORM` | The OpenClaw sign-in needs a real terminal (Windows) |
| `SPAWN_THROW`          | The spawn call threw synchronously                   |
| `SPAWN_ERROR`          | The child emitted an `error` event                   |
| `TIMEOUT`              | The 16-minute cap elapsed                            |
| `CANCELLED`            | The child was signalled or exited 130                |

Completion is driven by **re-probing the real auth store** (polled every 3 seconds), never by the exit code alone: a browser flow can leave the CLI holding an unanswered prompt long after the credential has landed on disk. The moment the credential appears, the stream emits `complete` with `success: true, loggedIn: true` and the child tree is reaped. If the child exits without a usable credential, `complete` carries `success: false, loggedIn: false` and a `message` naming the terminal command to run by hand. Cancelling in the UI aborts the fetch, which closes the connection and kills the whole process tree.

### Example

```bash
curl -N -X POST http://localhost:18790/api/auth/cli-login/codex
```

---

## Error envelope

Every error response on these routes is the standard envelope `{ error: string }`, except the `healthcheck` route, which uses `{ ok: false, error: string }` (its success shape is `{ ok: true }`), and the `run` route's `!ok` branches, which return `{ ok: false, reason: <string> }`.

## See also

- [Runtimes overview + capability matrix](/runtimes/index)
- [Connecting runtimes (install/connect/disconnect, the encrypted vault)](/runtimes/connecting-runtimes)
- [The board](/concepts/the-board), `taskId`, atomic claim, the 409-no-retry contract
- [Board API](/reference/rest-api/board), create the task you pass to `:id/run`
- [Tools & MCP API](/reference/rest-api/tools-and-mcp), the `/api/mcp/*` endpoints a run attaches to
- [REST API overview](/reference/rest-api/index)
