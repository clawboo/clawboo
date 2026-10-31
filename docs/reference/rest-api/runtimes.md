---
title: 'Runtimes API'
description: 'REST reference for runtimes and provider keys: list, install, connect, disconnect, check a key, run a board task, onboarding and CLI sign-in.'
keywords:
  ['runtimes', 'providers', 'api keys', 'vault', 'disconnect', 'healthcheck', 'cli login', 'ollama']
---

Use these routes to manage the runtimes Clawboo runs agents on, other than OpenClaw: Clawboo Native (built in), Claude Code, Codex and Hermes. They list each runtime's state, install a runtime's CLI, connect or disconnect its credentials, check a provider key, and run a board task on a runtime. The page also covers the provider-key routes behind **Settings > Providers**, the first-run onboarding routes, and the in-app ChatGPT sign-in.

<Note>

OpenClaw runs as its own Gateway process that Clawboo starts and talks to, so these routes do not cover it and answer **404** for `openclaw`. Its install, setup and Gateway control are in the [System API](/reference/rest-api/system).

</Note>

An unknown `:id` answers **404** `{ "error": "unknown runtime '<id>'" }`. Request bodies are JSON (up to 2 MB). Every route counts against the general [rate limit](/reference/rest-api/index#rate-limits) of 3,000 requests a minute per client address; routes marked **sensitive** below also count against a limit of 60 a minute. The `curl` examples assume the access gate is off (the default on a loopback install); with `STUDIO_ACCESS_TOKEN` set, add `-b 'clawboo_access=<token>'` to each call (see [Authentication](/reference/rest-api/index#authentication)).

## Routes

| Method | Path                                  | Summary                                                         | Rate tier | Stream? |
| ------ | ------------------------------------- | --------------------------------------------------------------- | --------- | ------- |
| GET    | `/api/runtimes`                       | List runtimes with capabilities, health and connection state    | general   | No      |
| POST   | `/api/runtimes/:id/install`           | Install the runtime's CLI                                       | sensitive | SSE     |
| POST   | `/api/runtimes/:id/connect`           | Save a key in the vault, reuse one, or record the Ollama choice | sensitive | No      |
| POST   | `/api/runtimes/:id/disconnect`        | Delete every vault key the runtime reads, or remove Ollama only | sensitive | No      |
| POST   | `/api/runtimes/:id/logout`            | Sign Codex out with its own CLI                                 | sensitive | No      |
| POST   | `/api/runtimes/:id/healthcheck`       | Check a provider key or local Ollama (native only, stores none) | general   | No      |
| POST   | `/api/runtimes/:id/run`               | Run a board task on the runtime and wait for the result         | general   | No      |
| GET    | `/api/runtimes/openrouter/models`     | The live OpenRouter catalog                                     | general   | No      |
| POST   | `/api/onboarding/native-leader-model` | Record the default native provider and model                    | general   | No      |
| GET    | `/api/onboarding/native-leader-model` | The recorded pick and what a new native agent would get         | general   | No      |
| GET    | `/api/onboarding/state`               | First-run signals in one call                                   | general   | No      |
| GET    | `/api/providers`                      | The 14 providers and whether each has a key                     | general   | No      |
| POST   | `/api/providers/:id/connect`          | Save a key in the vault and in OpenClaw's key files             | general   | No      |
| POST   | `/api/providers/:id/disconnect`       | Remove a key from the vault and from OpenClaw's key files       | general   | No      |
| GET    | `/api/providers/:id/models`           | Live model list with the stored key (Ollama: its pulled models) | general   | No      |
| POST   | `/api/providers/:id/models`           | Live model list with a pasted, unsaved key                      | general   | No      |
| POST   | `/api/auth/cli-login/:tool`           | Run a CLI's own ChatGPT sign-in and relay its output            | sensitive | SSE     |

<Info>

`POST /api/runtimes/:id/install` and `POST /api/auth/cli-login/:tool` stream **Server-Sent Events** instead of returning a JSON body, so each is documented with an event catalog (event `type` and payload). Install answers a plain JSON **400** for the built-in Clawboo Native before any stream opens; cli-login answers a plain JSON **404** for an unknown `:tool`.

</Info>

---

## `GET /api/runtimes`

Lists every runtime with its capabilities, live health, and install and credential status. `available[]` describes the full catalog, so a client can show "available to add" cards for runtimes you have not connected yet. No key value is ever returned; the credential fields report presence only.

- **Path/query params**: none.
- **Request body**: none.

### Responses

**`200 OK`**: the runtime list plus the catalog:

```ts
{
  runtimes: Array<{
    id: 'claude-code' | 'codex' | 'hermes' | 'clawboo-native'
    participantKind: 'agent' | 'human'
    capabilities: {
      streaming: boolean
      mcp: boolean
      worktrees: boolean
      resume: boolean
      toolApproval: boolean // what the runtime can do, not whether Clawboo gates its tools
      steering?: 'live' | 'interrupt-resume' | 'none' // how a comment reaches a running task; absent = none
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
    name: string
    installed: boolean
    binPath: string | null
    builtIn: boolean
    authKind: 'api-key' | 'oauth' | 'none'
    envVar: string | null
    hasCredential: boolean
    hasVaultCredential: boolean
    loggedIn: boolean // Codex only
    codexAuth: boolean // Hermes only
    ollamaConnected: boolean // Clawboo Native only
    installCommand: string | null
    docsUrl: string
    connectionState: 'not-installed' | 'needs-auth' | 'needs-login' | 'ready' | 'unknown' // this route never sends 'unknown'
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

`steering` is `live` for Claude Code, Codex and Clawboo Native (a comment joins the running turn) and `interrupt-resume` for Hermes (the run is stopped and resumed with the comment). `toolApproval: true` does not mean Clawboo asks before a tool runs: the coding runtimes run with their own approval prompts off (see [What agents can do](/concepts/permissions)).

The status fields:

| Field                | Runtimes       | Meaning                                                                                                                                                                                                                             |
| -------------------- | -------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `installed`          | all            | Always `true` for the built-in Clawboo Native. Otherwise, whether the CLI resolves on `PATH` or in a known user install folder (where `pip --user` and `pipx` put Hermes).                                                          |
| `binPath`            | CLI runtimes   | The resolved CLI path, or `null`. Always `null` for Clawboo Native.                                                                                                                                                                 |
| `envVar`             | key runtimes   | The vault slot a connect writes by default: `ANTHROPIC_API_KEY` for Claude Code and Clawboo Native, `OPENROUTER_API_KEY` for Hermes, `null` for Codex.                                                                              |
| `hasCredential`      | key runtimes   | A key resolves for any variable the runtime reads (listed under disconnect below), from the server's environment, the vault, or `~/.openclaw/.env`. After a disconnect only the vault counts. Hermes also counts a ChatGPT sign-in. |
| `hasVaultCredential` | key runtimes   | Like `hasCredential`, but counts the vault only, so a key that exists only in the server's shell does not look like a key you connected. The first-run check reads this one.                                                        |
| `loggedIn`           | Codex          | Codex is installed and `codex login status` reports a ChatGPT sign-in.                                                                                                                                                              |
| `codexAuth`          | Hermes         | Hermes holds a usable ChatGPT sign-in in its own `auth.json` (in `~/.hermes`, or `HERMES_HOME` when set).                                                                                                                           |
| `ollamaConnected`    | Clawboo Native | Local Ollama is set up: you picked it (a connect with `provider: "ollama"`), or no choice is recorded, `OLLAMA_BASE_URL` is set, and you have not disconnected the runtime.                                                         |

`connectionState` is derived like this:

| Condition                        | `connectionState`                                                                      |
| -------------------------------- | -------------------------------------------------------------------------------------- |
| The CLI is not installed         | `not-installed`                                                                        |
| `authKind: 'none'`               | `ready`                                                                                |
| `authKind: 'oauth'` (Codex)      | `ready` when `loggedIn`, else `needs-login`                                            |
| `authKind: 'api-key'` (the rest) | `ready` when `hasCredential` (Clawboo Native: or `ollamaConnected`), else `needs-auth` |

With `CLAWBOO_ENABLE_MOCK_RUNTIME=1`, `runtimes[]` also lists a `clawboo-mock` fault-injection runtime for development. It is not in `available[]`, and the `:id` routes answer **404** for it.

**`500 Internal Server Error`**: a failure building an adapter or probing health:

```json
{ "error": "<message>" }
```

### Example

```bash
curl http://localhost:18790/api/runtimes
```

---

## `POST /api/runtimes/:id/install`

Installs the runtime's CLI, pinned to a major version:

- Claude Code: `npm install -g @anthropic-ai/claude-code@2`.
- Codex: `npm install -g @openai/codex@0`.
- Hermes: `pipx install 'hermes-agent[anthropic]<1'`, with pipx pointed at a Python 3.11 or newer when one is found. Without pipx it runs `python -m pip install --user` with such a Python, and retries once with `--break-system-packages` when pip reports an externally managed environment.

Clawboo Native is built in, so it answers **400** before any stream opens. If the client closes the connection, the install process is killed.

- **Path params**: `id`.
- **Request body**: none.

### Responses

**`400 Bad Request`**: the runtime is built in (no stream opens):

```json
{ "error": "Clawboo Native is built in \u2014 nothing to install" }
```

**`200 OK` + `text/event-stream`**: for an installable runtime the stream sends `data: <json>\n\n` frames.

#### Event catalog

| `type`     | When                                                             | Payload fields                                     |
| ---------- | ---------------------------------------------------------------- | -------------------------------------------------- |
| `progress` | Install start, the pipx path, and the externally managed retry   | `step` (`'installing'` \| `'retrying'`), `message` |
| `output`   | Each non-empty stdout or stderr line                             | `line`                                             |
| `error`    | Tooling missing, permission denied, spawn failure, non-zero exit | `code`, `message`                                  |
| `complete` | The process exits 0                                              | `success: true`, optional `warning`                |

The `error` codes:

| `code`           | Meaning                                                                |
| ---------------- | ---------------------------------------------------------------------- |
| `NPM_MISSING`    | `npm` not found (Claude Code, Codex)                                   |
| `PYTHON_MISSING` | No Python with pip or pipx found (Hermes)                              |
| `PYTHON_TOO_OLD` | The newest Python found is older than 3.11 (Hermes)                    |
| `EACCES`         | The npm or pipx error output mentioned `EACCES` or "permission denied" |
| `SPAWN_THROW`    | The spawn call threw                                                   |
| `SPAWN_ERROR`    | The child process emitted an error                                     |
| `EXIT_<code>`    | The process exited with a non-zero code (for example `EXIT_1`)         |

An `EACCES` frame does not end the stream: the exit code still decides the outcome, and its message suggests the same command with `sudo`. When the install succeeds but the CLI still cannot be found, `complete` carries a `warning` that suggests restarting the server.

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

Connects a runtime. What it does depends on the runtime:

- **Codex** takes no key. The route checks for an existing `codex login`, reports the state, and returns the command to sign in. To sign in from the dashboard, use `POST /api/auth/cli-login/codex`.
- **Claude Code** stores `apiKey` under `ANTHROPIC_API_KEY`.
- **Hermes** stores `apiKey` under `OPENROUTER_API_KEY`. Hermes also runs on an `ANTHROPIC_API_KEY` or `OPENAI_API_KEY` already stored, or on a ChatGPT sign-in.
- **Clawboo Native** stores `apiKey` in the slot for `provider` (table below). With `provider: "ollama"` it records that you picked local Ollama and stores nothing. With a `provider` and no `apiKey`, it reuses a key that already exists for that provider.

The key goes into Clawboo's encrypted vault only; it is not copied to OpenClaw's files (`POST /api/providers/:id/connect` does that). Every successful connect clears this runtime's disconnect flag, so keys in the server's environment and in `~/.openclaw/.env` count for it again. The key is never echoed back.

- **Path params**: `id`.
- **Request body**:

```ts
{
  apiKey?: string   // required, except for Codex, provider 'ollama', or a Clawboo Native key reuse
  provider?: string // Clawboo Native: which provider the key is for (see the table)
}
```

How Clawboo Native maps `provider` to a vault slot:

| `provider`         | Vault slot           |
| ------------------ | -------------------- |
| omitted, anthropic | `ANTHROPIC_API_KEY`  |
| `openai`           | `OPENAI_API_KEY`     |
| `openrouter`       | `OPENROUTER_API_KEY` |
| `google`           | `GEMINI_API_KEY`     |
| `xai`              | `XAI_API_KEY`        |
| `groq`             | `GROQ_API_KEY`       |
| `mistral`          | `MISTRAL_API_KEY`    |
| `together`         | `TOGETHER_API_KEY`   |
| `cerebras`         | `CEREBRAS_API_KEY`   |
| `moonshot`         | `MOONSHOT_API_KEY`   |
| `ollama`           | none (keyless)       |

Any other value falls back to `ANTHROPIC_API_KEY`. That includes `minimax`, `nvidia`, `huggingface` and `venice`, which the Providers routes accept but Clawboo Native cannot run on, so check the spelling before you send a key.

**Key reuse.** A Clawboo Native request with a `provider` and no `apiKey` reconnects with a key that already resolves for that provider, from the server's environment, the vault or `~/.openclaw/.env`. Nothing is stored. The dashboard's **Use** button on a provider row (in **Settings > Runtimes**, under Clawboo Native's **Manage**) sends this request after it checks the stored key with `POST /api/runtimes/clawboo-native/healthcheck`.

### Responses

**`200 OK`** (Codex): the current state and the sign-in command:

```ts
{
  ok: true
  connectionState: 'ready' | 'needs-login' | 'not-installed' // ready = an existing `codex login` was found
  loginCommand: 'codex login'
}
```

**`200 OK`** (every other case): the key was stored, reused, or the Ollama choice recorded, and the state re-derived (normally `ready`):

```ts
{ ok: true, connectionState: 'not-installed' | 'needs-auth' | 'needs-login' | 'ready' }
```

**`400 Bad Request`**: `apiKey` is missing or blank and no `provider` was sent:

```json
{ "error": "apiKey is required" }
```

**`400 Bad Request`**: a `provider` was sent with no `apiKey`, and Clawboo Native has no existing key for it. Claude Code and Hermes always answer this when `provider` comes without a key. The server's message contains an em dash, shown here as the JSON escape `\u2014`:

```json
{ "error": "no existing key found for openai \u2014 paste one to connect" }
```

### Example

```bash
# Claude Code
curl -X POST http://localhost:18790/api/runtimes/claude-code/connect \
  -H 'Content-Type: application/json' \
  -d '{"apiKey":"sk-ant-..."}'

# Clawboo Native on OpenRouter
curl -X POST http://localhost:18790/api/runtimes/clawboo-native/connect \
  -H 'Content-Type: application/json' \
  -d '{"apiKey":"sk-or-...","provider":"openrouter"}'

# Clawboo Native: reuse an OpenAI key that is already stored
curl -X POST http://localhost:18790/api/runtimes/clawboo-native/connect \
  -H 'Content-Type: application/json' \
  -d '{"provider":"openai"}'

# Clawboo Native on local Ollama (no key)
curl -X POST http://localhost:18790/api/runtimes/clawboo-native/connect \
  -H 'Content-Type: application/json' \
  -d '{"provider":"ollama"}'
```

---

## `POST /api/runtimes/:id/disconnect`

Disconnects a runtime. With no body this is a **full disconnect**: it deletes every vault key the runtime reads and stops the runtime from picking keys up anywhere else. The CLI stays installed. Clawboo Native also takes `{ "provider": "ollama" }`, which removes only the local Ollama choice.

<Warning>

A full disconnect deletes every vault key this runtime reads, not one, and the vault holds a single copy of each key. Other runtimes that use the same key lose it too: disconnecting Hermes deletes the Anthropic key that Claude Code and Clawboo Native may run on. To remove one provider's key, use `POST /api/providers/:id/disconnect` instead.

</Warning>

What a full disconnect deletes:

| Runtime          | Vault keys deleted                                                                                                                                                                          | Also                                                                                                                                                                                                      |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `claude-code`    | `ANTHROPIC_API_KEY`                                                                                                                                                                         |                                                                                                                                                                                                           |
| `hermes`         | `OPENROUTER_API_KEY`, `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`                                                                                                                                 | A ChatGPT sign-in in Hermes's own `auth.json` is kept, so Hermes can still read `ready`.                                                                                                                  |
| `clawboo-native` | `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `OPENROUTER_API_KEY`, `GEMINI_API_KEY`, `XAI_API_KEY`, `GROQ_API_KEY`, `MISTRAL_API_KEY`, `TOGETHER_API_KEY`, `CEREBRAS_API_KEY`, `MOONSHOT_API_KEY` | Records local Ollama as removed.                                                                                                                                                                          |
| `codex`          | none (Codex keeps no key in the vault)                                                                                                                                                      | Its state comes from `codex login status`, so a signed-in Codex stays `ready` in `GET /api/runtimes` (the disconnect answer itself reads `needs-login`). Sign out with `POST /api/runtimes/codex/logout`. |

A full disconnect also:

- Sets the runtime's disconnect flag. Until you connect this runtime again, it reads keys from the vault only, so a key in the server's environment or in `~/.openclaw/.env` no longer counts for it.
- Leaves the copies in `~/.openclaw/.env` and in each OpenClaw agent's `auth-profiles.json` alone. OpenClaw keeps those keys, and other runtimes that are not disconnected still find them there.
- Stops memory embeddings from using a removed key.

For Clawboo Native, neither a later key connect nor `OLLAMA_BASE_URL` turns Ollama back on after a full disconnect; only picking it again (a connect with `provider: "ollama"`) does.

**`{ "provider": "ollama" }`** removes only the Ollama choice and keeps every key. It also stops a configured `OLLAMA_BASE_URL` from counting as set up until Ollama is picked again. While Ollama is removed, no run uses it: an agent whose only provider is Ollama fails and reads `providerReady: false`, and an agent with a keyed fallback runs on the fallback.

In the dashboard, a runtime's **Manage** > **Disconnect** sends the full form. Under Clawboo Native's **Manage**, **Disconnect Ollama** sends `{ "provider": "ollama" }`, and the disconnect button on any other provider row (for example **Disconnect OpenAI**) calls `POST /api/providers/:id/disconnect`.

- **Path params**: `id`.
- **Request body**: none, or `{ "provider": "ollama" }` for `clawboo-native`.

### Responses

**`200 OK`**: done; the state re-derived:

```ts
{ ok: true, connectionState: 'needs-auth' | 'needs-login' | 'ready' | 'not-installed' }
```

**`400 Bad Request`**: `provider` was sent but is empty or not a string (it is never treated as a full disconnect):

```json
{ "error": "provider must be a non-empty string" }
```

**`400 Bad Request`**: a `provider` other than `ollama`, or `ollama` on a runtime other than `clawboo-native`:

```json
{
  "error": "only the native runtime's keyless 'ollama' disconnects by provider here; remove a provider key via /api/providers/:id/disconnect"
}
```

### Example

```bash
# Full disconnect (see the table for what it deletes)
curl -X POST http://localhost:18790/api/runtimes/hermes/disconnect

# Clawboo Native: stop using local Ollama, keep every key
curl -X POST http://localhost:18790/api/runtimes/clawboo-native/disconnect \
  -H 'Content-Type: application/json' \
  -d '{"provider":"ollama"}'
```

---

## `POST /api/runtimes/:id/logout`

Signs Codex out by running the CLI's own `codex logout`; Clawboo never deletes the vendor's tokens itself. The answer comes from a fresh `codex login status` check, not from the command's exit code. A runtime that authenticates with a key has no sign-out; use the disconnect route.

<Warning>

This signs out the ChatGPT sign-in that every tool on the machine shares, not only Clawboo's use of it.

</Warning>

- **Path params**: `id`.
- **Request body**: none.

### Responses

**`404 Not Found`**: the runtime does not use a sign-in:

```json
{ "error": "runtime '<id>' has no sign-out" }
```

**`400 Bad Request`**: the CLI is not installed:

```json
{ "error": "Codex is not installed" }
```

**`200 OK`**: the fresh check. `ok` is `true` only when the sign-out took:

```ts
{ ok: true, connectionState: 'needs-login' }  // signed out
{ ok: false, connectionState: 'ready' }       // still signed in
```

### Example

```bash
curl -X POST http://localhost:18790/api/runtimes/codex/logout
```

---

## `POST /api/runtimes/:id/healthcheck`

Checks a provider credential with one authenticated request to the provider's model list, before anything relies on it. The key is used for that one request only: it is never stored, logged or echoed. A bad key or an unreachable provider comes back as `{ ok: false, error }` with status **200**. The dashboard calls this before it saves or reuses a key: on the onboarding connect step, in **Providers**, on a runtime's connect card, and for **Use** on a provider row.

<Info>

Only `clawboo-native` takes this route; any other valid `:id` answers **400**. It checks a **provider**, not a runtime, so a key meant for another runtime is checked by naming its provider here.

</Info>

- **Path params**: `id` (must be `clawboo-native`).
- **Request body**:

```ts
{
  provider?: string // 'anthropic' | 'openai' | 'openrouter' | 'ollama' | 'google' | 'xai' |
                    // 'groq' | 'mistral' | 'together' | 'cerebras' | 'moonshot'
  apiKey?: string   // omit to check the key that already resolves for `provider`
                    // (server environment, vault, or ~/.openclaw/.env); never needed for ollama
  model?: string    // ollama only: also check that this model is pulled
}
```

Where each provider is checked: `anthropic` at `https://api.anthropic.com/v1/models`, `openai` at `https://api.openai.com/v1/models`, `openrouter` at `https://openrouter.ai/api/v1/models`, the OpenAI-compatible providers (`google`, `xai`, `groq`, `mistral`, `together`, `cerebras`, `moonshot`) at their own `<base URL>/models`, and `ollama` at `/api/tags` on `OLLAMA_BASE_URL` (a trailing `/v1` removed), else `http://localhost:11434`. The request times out after 8 seconds and refuses redirects.

### Responses

**`400 Bad Request`**: `:id` is not `clawboo-native`:

```json
{ "ok": false, "error": "healthcheck is only supported for the native runtime" }
```

**`400 Bad Request`**: unknown provider:

```json
{ "ok": false, "error": "unknown provider '<provider>'" }
```

**`400 Bad Request`**: a keyed provider with no `apiKey` and no key that resolves for it:

```json
{ "ok": false, "error": "apiKey is required" }
```

**`200 OK`**: the provider answered and accepted the key:

```json
{ "ok": true }
```

**`200 OK`**: the check failed (the failure is in the body):

```ts
{ ok: false, error: 'Invalid API key.' }                         // the provider answered 401 or 403
{ ok: false, error: 'Provider returned <status>.' }              // any other non-2xx
{ ok: false, error: 'Could not reach <provider> (timed out).' }  // no answer within 8 s
{ ok: false, error: 'Could not reach <provider>.' }              // network error or a redirect
// ollama with `model`: Ollama answered, but has not pulled the model
{ ok: false, error: 'Ollama is running, but it doesn\'t have llama3.2 yet. Pull it with "ollama pull llama3.2".', missingModel: 'llama3.2' }
```

For `ollama`, `model` matches the way Ollama resolves names: an untagged `llama3.2` is met by `llama3.2:latest`, a tagged `qwen2.5:7b` only by itself. An answer that is not a tags list proves nothing either way, so it passes.

### Example

```bash
curl -X POST http://localhost:18790/api/runtimes/clawboo-native/healthcheck \
  -H 'Content-Type: application/json' \
  -d '{"provider":"anthropic","apiKey":"sk-ant-..."}'
```

---

## `POST /api/runtimes/:id/run`

Runs one board task on the runtime from start to finish: claim the task, prepare its workspace, run the agent, and report the result. The request stays open for the whole run. If the client disconnects first, the run and its process are stopped and the task goes back to `todo`. The runtime's MCP clients attach to this server's own `/api/mcp/*` routes on its loopback port, never to the request's `Host`.

The runtime's keys are read the way its card reads them: from the server's environment, the vault, then `~/.openclaw/.env`, or from the vault only after a disconnect. Codex gets no key; it uses its own sign-in.

This route is one of the two ways work runs through Clawboo's task runner (the other is an agent Routine), so it gets the runner's extras: a git worktree when the task needs one, verification of the worktree's changes, memory injection and circuit breakers. Team chat does not run through it; see [How a team works](/intro/how-it-works) and [When work is checked](/concepts/verification).

- **Path params**: `id`.
- **Request body**:

```ts
{
  taskId: string                    // required
  assigneeAgentId?: string          // default: the runtime id; must match /^[A-Za-z0-9_-]+$/
  repoPath?: string | null          // the git repository to branch the task's worktree from
  kind?: string                     // 'code' (default) needs a worktree; 'research' and 'review' run without one
  model?: string | null             // model override for this run
  keepForResume?: boolean           // keep the worktree and release the task, for another runtime to resume
  disableMemoryAutoInject?: boolean // skip putting relevant memory into the run's prompt
  maxRotations?: number             // cap on fresh sessions when the context fills
  breakerConfig?: object            // circuit-breaker overrides; ignored when invalid
  parentTraceparent?: string | null // W3C traceparent to nest this run's trace under
}
```

A `code` task (or any kind other than `research` and `review`) changes files, so it needs a worktree. A task that already has a worktree reuses it. Otherwise, with no `repoPath`, or when the worktree cannot be created, the run is refused with `workspace_unavailable`: the task gets a `[blocked: no isolation]` comment and goes back to `todo`. A `research` or `review` task gets no worktree and starts in its team's folder, `<CLAWBOO_HOME>/workspaces/<teamId>` (`workspaces/_no-team` for a task with no team); if that folder cannot be created, the run is refused with `workspace_unavailable` too. A worktree keeps file changes apart; neither it nor the team's folder is a sandbox (see [What agents can do](/concepts/permissions)).

### Responses

A refused or finished run answers with the runner's result. A refusal (`ok: false`) maps to a status by its `reason`: `not_found` is **404**, `conflict` is **409**, and every other reason is **422**.

**`400 Bad Request`**: missing `taskId`:

```json
{ "error": "taskId is required" }
```

**`400 Bad Request`**: `assigneeAgentId` is not a bare identifier:

```json
{ "error": "invalid assigneeAgentId" }
```

**`200 OK`**: the task ran:

```ts
{
  ok: true
  runtimeId: string
  execId: string
  doneReason: 'success' | 'max_turns' | 'aborted' | 'error'
  status: string           // the task's status after the run
  summary: string
  costUsd: number | null   // reported, or estimated when the runtime reports none; 0 on a local Ollama model
  usedWorktree: boolean
  degradations: string[]
  needsVerifyFix?: true    // verification failed and the task is still in_progress, waiting for a fix
  stoppedByPerson?: true   // a person moved the task's card, which stopped the run (doneReason 'aborted')
}
```

When verification fails, the route runs the task again with the failure in its prompt, inside the same request, before it answers. It allows one fix run by default (`CLAWBOO_MAX_FIX_CYCLES` changes the number), so the answer describes the last run.

How each runtime's cost is reported or estimated is in [Budgets and spend](/using/budgets-and-spend).

**`404 Not Found`**: no task with that id:

```json
{ "ok": false, "reason": "not_found" }
```

**`409 Conflict`**: the task could not be claimed (someone else holds it). Treat it as data and do not retry:

```json
{ "ok": false, "reason": "conflict" }
```

**`422 Unprocessable Entity`**: the run was refused before it started:

```ts
{ ok: false, reason: 'too_deep' | 'connected_substrate' | 'budget_paused' | 'workspace_unavailable' }
```

| `reason`                | Meaning                                                                                                                                                       |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `too_deep`              | The task sits deeper in its delegation tree than the depth limit allows.                                                                                      |
| `connected_substrate`   | The runtime runs work over its own live connection (OpenClaw), so this route cannot run it.                                                                   |
| `budget_paused`         | A hard-cap budget covering this agent, this delegation tree or this team is paused. Warn-only budgets never block.                                            |
| `workspace_unavailable` | The task needs a worktree and none could be prepared (no `repoPath`, or the worktree failed), or the team's folder for a read-only task could not be created. |

**`500 Internal Server Error`**: an unexpected error inside the run:

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

The live OpenRouter catalog behind the OpenRouter model pickers. It reads OpenRouter's public model list (no key), keeps text models, sorts them by label, and caches the list for 30 minutes, with an 8-second fetch timeout.

- **Path/query params**: none.
- **Request body**: none.

### Responses

**`200 OK`**: the catalog. This route does not fail: a failed or empty fetch falls back to the last good list, and an empty array tells the client to use its own built-in list:

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

## Onboarding

The three `/api/onboarding/*` routes take no `:id`. They are grouped here because they are Clawboo Native's first-run routes. Onboarding creates no team of its own: you pick one in the marketplace and deploy it through the [Teams API](/reference/rest-api/teams).

### `POST /api/onboarding/native-leader-model`

Records the provider and model you picked when you connected a native provider (a key, or keyless Ollama), or later with **Make default** in Clawboo Native's provider list. Boo Zero runs on it when Clawboo creates it (if that provider can still run), and an existing native Boo Zero is switched to it. New native agents created without a model pick follow it while its provider stays set up: a leader runs the recorded model, and a specialist runs that provider's cheaper default (on Ollama, the recorded model too). See [Clawboo Native](/runtimes/native). Body `{ provider, model }`.

- **`200 OK`**: `{ "ok": true }`.
- **`400 Bad Request`**: `{ "error": "unknown provider '<provider>'" }` when `provider` is not one of the eleven native providers (the table under connect, including `ollama`), or `{ "error": "model is required" }` when `model` is missing or blank.
- **`500 Internal Server Error`**: `{ "error": "<message>" }` when the setting cannot be written.

### `GET /api/onboarding/native-leader-model`

The recorded pick, plus what a native agent created without a model pick would get right now, per tier. The native provider manager reads it for its **Default** tag and model menu, and the team-deploy dialog labels each native member left on **Default** with it.

```ts
{
  provider: string | null // the recorded pick; null when none is recorded or it cannot be read
  model: string | null
  resolved: {
    leader: { provider: string; model: string }
    specialist: { provider: string; model: string }
  } | null // null when no native provider is set up
}
```

`resolved` comes from the same logic agent creation uses, including the check that an Ollama model is pulled. A recorded value that cannot be read counts as no pick. This route does not return an error status.

### `GET /api/onboarding/state`

The first-run signals in one call, so a client can decide between the setup wizard and the dashboard without several requests:

```ts
{
  configured: boolean // OpenClaw is installed and its openclaw.json and .env both exist
  hasNative: boolean // at least one Clawboo Native agent exists
  hasTeam: boolean // at least one team exists
  hasConnectedRuntime: boolean // see below
}
```

`hasConnectedRuntime` is `true` when any of the four runtimes has one of its keys in the vault, when Codex is signed in, or when Hermes holds a ChatGPT sign-in. A key that exists only in the server's environment does not count, and neither does a keyless Ollama choice. **500** `{ "error": "<message>" }` on an unexpected error.

---

## Providers

The `/api/providers*` routes back **Settings > Providers**. A provider is a model vendor (`anthropic`, `openai`, ...), not a runtime: one Anthropic key can serve Clawboo Native, Claude Code, Hermes and OpenClaw at once. These routes keep the key in two places, so that every runtime finds it:

- Clawboo's encrypted vault (read by Clawboo Native, Claude Code and Hermes).
- OpenClaw's own key files, in plain text and owner-only (mode `0600`): `~/.openclaw/.env` and every existing OpenClaw agent's `auth-profiles.json` (as the `<provider>:default` profile). The folder is created (mode `0700`) if it does not exist, even when you do not use OpenClaw.

For where keys are stored and how to connect them in the dashboard, see [Providers and runtimes](/using/providers-and-runtimes).

The 14 providers and their key variables: `anthropic` (`ANTHROPIC_API_KEY`), `openai` (`OPENAI_API_KEY`), `google` (`GEMINI_API_KEY`), `openrouter` (`OPENROUTER_API_KEY`), `xai` (`XAI_API_KEY`), `groq` (`GROQ_API_KEY`), `mistral` (`MISTRAL_API_KEY`), `moonshot` (`MOONSHOT_API_KEY`), `minimax` (`MINIMAX_API_KEY`), `together` (`TOGETHER_API_KEY`), `nvidia` (`NVIDIA_API_KEY`), `huggingface` (`HF_TOKEN`), `cerebras` (`CEREBRAS_API_KEY`), `venice` (`VENICE_API_KEY`). `ollama` and `openai-codex` (the ChatGPT sign-in) are not providers here; `connect` answers **400** for them.

### `GET /api/providers`

Every provider and whether it has a key:

```ts
{
  providers: Array<{
    id: string // one of the 14 ids above, in that order
    connected: boolean // a key is in the vault or in ~/.openclaw/.env (a shell variable alone does not count)
    poweredRuntimes: string[] // a fixed display list per provider, e.g. ["Clawboo Native", "Claude Code", "OpenClaw"] for anthropic
  }>
}
```

`poweredRuntimes` is a fixed label list, not a live check: `Clawboo Native` for `anthropic`, `openai` and `openrouter`, `Claude Code` for `anthropic`, `Hermes` for `openrouter`, and `OpenClaw` for every provider. Clawboo Native also runs on the other keyed providers in the connect table, and Hermes also reads an Anthropic or OpenAI key, even though the list leaves them out.

### `POST /api/providers/:id/connect`

Body `{ apiKey }`. Stores the key in the vault and writes it to `~/.openclaw/.env` and every OpenClaw agent's `auth-profiles.json`, replacing an earlier key for the same provider. Memory embeddings may switch to the new key. Returns `{ ok: true, providers }` with the refreshed list. The dashboard's **Providers** page and the OpenClaw setup's key prompt call this route.

- **`400 Bad Request`**: `{ "error": "unknown provider '<id>'" }`, or `{ "error": "apiKey is required" }` when the key is missing or blank.

### `POST /api/providers/:id/disconnect`

Removes the provider's key from the vault, from `~/.openclaw/.env`, and from every OpenClaw agent's `auth-profiles.json`. A key exported in the server's environment is not touched: runtimes can still use it, though the list shows the provider as not connected. Returns `{ ok: true, providers }`.

- **`400 Bad Request`**: `{ "error": "unknown provider '<id>'" }`.

### `GET /api/providers/:id/models`

The provider's live model list, fetched with the key that resolves for it (server environment, vault, then `~/.openclaw/.env`). Returns `{ "models": [] }` when there is no key or the provider has no live list here, so a client can fall back to its built-in list. Lists are cached for 30 minutes per provider and key, with an 8-second timeout; a failed fetch serves the last good list for the same key.

| Provider                                                               | Live list                                                                         |
| ---------------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| `anthropic`, `openai`                                                  | Yes (chat models only, newest first)                                              |
| `google`, `xai`, `groq`, `mistral`, `together`, `cerebras`, `moonshot` | Yes (each provider's own `/models`, non-chat models left out)                     |
| `openrouter`                                                           | No: always `[]`. The OpenRouter catalog is `GET /api/runtimes/openrouter/models`. |
| `minimax`, `nvidia`, `huggingface`, `venice`                           | No: always `[]`                                                                   |
| `ollama`                                                               | The models your local Ollama has pulled (below)                                   |

`ollama` needs no key and answers from the local Ollama instead: its chat models (embedding-only models left out, models without tool support labelled `(can't use tools)`, newest first), whether Ollama answered, and `recommendedModel`. That is `llama3.2` when it is pulled; otherwise the newest pulled model that can use tools, then the newest whose tool support Ollama does not report, then the newest that cannot use tools; and `llama3.2` itself when Ollama lists no chat model or does not answer. It does not read your recorded default. It is read fresh on every call, so a model you just pulled shows up.

```json
{
  "models": [
    { "id": "qwen2.5:7b", "label": "qwen2.5:7b" },
    { "id": "gemma2", "label": "gemma2 (can't use tools)" }
  ],
  "reachable": true,
  "recommendedModel": "qwen2.5:7b"
}
```

### `POST /api/providers/:id/models`

Body `{ apiKey }`. The live model list using a pasted key that is not saved; the onboarding step calls it before any key is stored. The key is used for one fetch and is never logged, stored or echoed. Returns `{ "models": [] }` when the provider has no live list (see the table; `ollama` included) or the key is blank.

---

## `POST /api/auth/cli-login/:tool`

The dashboard's **Sign in with ChatGPT**. Runs the official CLI's own sign-in command on this machine and relays what it prints (a device code, a sign-in URL) over SSE. The sign-in itself stays inside the vendor's CLI: you approve it in a browser, and Clawboo never handles the tokens. Only one sign-in runs per tool; a new request stops the previous one first. A sign-in is stopped after 16 minutes, since the CLIs' own device codes expire after 15.

| `:tool`    | Command it runs                                      |
| ---------- | ---------------------------------------------------- |
| `codex`    | `codex login`                                        |
| `hermes`   | `hermes auth add openai-codex --type oauth`          |
| `openclaw` | `openclaw models auth login --provider openai-codex` |

- **Path params**: `tool`.
- **Request body**: none.

### Responses

**`404 Not Found`**: unknown `:tool`, as plain JSON before any stream opens:

```json
{ "error": "unknown login tool: <tool>" }
```

**`200 OK` + `text/event-stream`**: otherwise the stream sends `data: <json>\n\n` frames. A sign-in that cannot start (the CLI is not installed, or the OpenClaw sign-in on Windows) is an `error` frame inside the stream, not an HTTP error, so the dashboard can fall back to showing the command to copy.

#### Event catalog

| `type`        | When                                                 | Payload fields                            |
| ------------- | ---------------------------------------------------- | ----------------------------------------- |
| `progress`    | The command is about to start                        | `step: 'starting'`, `message`             |
| `output`      | Each non-empty output line (terminal colors removed) | `line`                                    |
| `device-code` | A device code appeared in the output                 | `url`, `code`                             |
| `auth-url`    | A browser sign-in URL appeared in the output         | `url`                                     |
| `error`       | Cannot start, spawn failure, time-out, or cancelled  | `code`, `message`                         |
| `complete`    | The sign-in finished, successfully or not            | `success`, `loggedIn`, optional `message` |

The `error` codes:

| `code`                 | Meaning                                                 |
| ---------------------- | ------------------------------------------------------- |
| `NOT_INSTALLED`        | The tool's CLI is not installed                         |
| `UNSUPPORTED_PLATFORM` | The OpenClaw sign-in needs a real terminal (on Windows) |
| `SPAWN_THROW`          | The spawn call threw                                    |
| `SPAWN_ERROR`          | The child process emitted an error                      |
| `TIMEOUT`              | The 16-minute limit passed                              |
| `CANCELLED`            | The command was stopped or exited with code 130         |

Completion comes from checking where the tool stores its sign-in (every 3 seconds), not from the exit code alone, because a browser sign-in can leave the CLI waiting at a prompt after the credential has landed. As soon as the credential appears, the stream sends `complete` with `success: true, loggedIn: true` and stops the command. If the command exits without a usable credential, `complete` carries `success: false, loggedIn: false` and a `message` naming the command to run in a terminal. Cancelling in the dashboard closes the connection, which stops the command and everything it started.

### Example

```bash
curl -N -X POST http://localhost:18790/api/auth/cli-login/codex
```

---

## Error envelope

Errors use the standard `{ "error": string }` body, with three exceptions: `healthcheck` answers `{ "ok": false, "error": string }` (its success body is `{ "ok": true }`), a refused `run` answers `{ "ok": false, "reason": string }`, and the two SSE routes report failures as `error` frames once the stream is open. Going over a rate limit answers **429** with `{ "error": "Too many requests. Wait a moment and retry." }` (general) or `{ "error": "Too many requests for this operation. Wait a moment and retry." }` (sensitive), plus a `Retry-After` header.

**Source of truth:** `apps/web/server/api/runtimes.ts`, `providers.ts`, `onboardingSeed.ts`, `onboardingState.ts` and `cliLogin.ts`; key storage in `apps/web/server/lib/secretsVault.ts`, `providerKeys.ts` and `openclawEnv.ts`; runtime definitions in `apps/web/server/lib/runtimes/descriptor.ts`.

## Related

- [Providers and runtimes](/using/providers-and-runtimes): connect and disconnect from the dashboard, and where keys are stored.
- [Choose a runtime](/runtimes/index): what each runtime supports.
- [System API](/reference/rest-api/system): OpenClaw install, setup and the Gateway.
- [Board API](/reference/rest-api/board): create the task you pass to the run route.
- [Tools and MCP API](/reference/rest-api/tools-and-mcp): the `/api/mcp/*` servers a run attaches to.
- [REST API overview](/reference/rest-api/index): authentication, rate limits and conventions.
