---
title: Connecting runtimes
description: Install, connect, disconnect, and health-check the non-OpenClaw runtimes from the Runtimes panel.
---

Use this page when you want to bring a non-OpenClaw [runtime](/appendices/glossary), `claude-code`, `codex`, `hermes`, or `clawboo-native`, online so it can execute board tasks. Each runtime is a [RuntimeAdapter](/appendices/glossary): Clawboo lists it, installs its CLI, stores its provider key, and reports its connection state. OpenClaw is connected differently (the Gateway, not a CLI install); see [OpenClaw](/runtimes/openclaw).

The whole lifecycle runs from the **Runtimes** panel (`RuntimeConnectionCard`), backed by `/api/runtimes/*`. Open it from **Settings** (the gear at the bottom of the sidebar, or `Cmd/Ctrl + ,`), then **Runtimes** under the Workspace group. This page documents what each step does, where keys are stored, and the per-runtime differences.

![The Runtimes panel: Clawboo Native and Hermes connected, Claude Code one click away, Codex awaiting sign-in, OpenClaw connected](/images/runtimes-panel.png)

## Prerequisites

<Note>
The Runtimes panel is always available; every runtime is listed regardless of install or credential state. What changes per runtime is whether it needs a CLI install, an API key, or an interactive terminal login.
</Note>

- `claude-code`, `codex`, and `hermes` are external CLIs Clawboo installs for you. `clawboo-native` ships inside the Clawboo server; there is nothing to install.
- `npm` (bundled with Node.js) is required to install `claude-code` and `codex`. `hermes` installs via Python; `pipx` is preferred, with a `pip --user` fallback.
- A provider API key for the runtimes that authenticate head-less (`claude-code`, `hermes`, `clawboo-native`). `codex` authenticates through an interactive ChatGPT OAuth login instead of a pasted key.

## At a glance

Every runtime resolves to one **connection state** that drives the card UI. The state is derived from `installed` + `hasCredential` + the runtime's auth model, and is recomputed (never echoing any secret) after each action.

| State           | Meaning                                                         | Card action                                |
| --------------- | --------------------------------------------------------------- | ------------------------------------------ |
| `not-installed` | CLI binary not found on PATH or known user-install dirs         | **Install** (SSE)                          |
| `needs-auth`    | Installed (api-key runtime) but no key stored                   | Paste key → **Connect**                    |
| `needs-login`   | Installed (oauth runtime, i.e. `codex`), no pasted key possible | Run `codex login`, then **Re-check**       |
| `ready`         | Installed and credential present (or `none` auth)               | **Re-check** · **Disconnect** (panel only) |
| `unknown`       | First status fetch in flight                                    | **Re-check**                               |

## Per-runtime matrix

| Runtime                           | Built-in | Install                                      | Auth    | Env var written to vault                                       | Notes                                                                                                |
| --------------------------------- | -------- | -------------------------------------------- | ------- | -------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| `clawboo-native` (Clawboo Native) | yes      | none                                         | api-key | `ANTHROPIC_API_KEY` (+ `OPENAI_API_KEY`, `OPENROUTER_API_KEY`) | In-process harness; multi-provider; any of the three keys (or `OLLAMA_BASE_URL`) counts as connected |
| `claude-code` (Claude Code)       | no       | `npm install -g @anthropic-ai/claude-code@2` | api-key | `ANTHROPIC_API_KEY`                                            | Health binary `claude`                                                                               |
| `codex` (Codex)                   | no       | `npm install -g @openai/codex@0`             | oauth   | none                                                           | Connects via `codex login`, not a pasted key; health binary `codex`                                  |
| `hermes` (Hermes)                 | no       | `pipx install 'hermes-agent<1'`              | api-key | `OPENROUTER_API_KEY`                                           | Python CLI; installs to the user-site bin (resolved off PATH); health binary `hermes`                |

## Steps

### 1. List the runtimes

`GET /api/runtimes` returns `{ runtimes, available }`. Each `runtimes[]` entry carries the adapter's `participantKind`, `capabilities`, and `health`, plus its install/auth status (`installed`, `binPath`, `builtIn`, `authKind`, `envVar`, `hasCredential`, `installCommand`, `docsUrl`, `connectionState`). The `available[]` list is the full descriptor catalog (no secrets) so the panel can render "available to add" cards for runtimes you have not connected yet.

A built-in runtime (`clawboo-native`) always reports `installed: true` with `binPath: null`. A CLI runtime reports `installed` based on whether `resolveRuntimeBin` finds its health binary; this probe checks PATH **and** the well-known user-install dirs (the `pip --user` / `pipx` location), which is how Hermes is found even though its Python user-site bin is usually off the server's PATH.

### 2. Install the CLI (claude-code, codex, hermes)

`POST /api/runtimes/:id/install` is a Server-Sent Events stream. The card opens it from the `not-installed` state and renders the install log in a terminal box. Events:

| Event `type` | Payload                       | Meaning                                                                                          |
| ------------ | ----------------------------- | ------------------------------------------------------------------------------------------------ |
| `progress`   | `{ step, message }`           | Phase marker (`installing`, `retrying`)                                                          |
| `output`     | `{ line }`                    | A line of the installer's stdout/stderr                                                          |
| `error`      | `{ code, message }`           | Failure (`NPM_MISSING`, `PYTHON_MISSING`, `EACCES`, `SPAWN_THROW`, `SPAWN_ERROR`, `EXIT_<code>`) |
| `complete`   | `{ success: true, warning? }` | Install finished; `warning` set if the binary still is not resolvable                            |

- **npm runtimes** (`claude-code`, `codex`) run `npm install -g <pkg>`. If `npm` is not found, the stream emits `error` with code `NPM_MISSING`.
- **The pip runtime** (`hermes`) prefers `pipx install <pkg>`. If `pipx` is absent it falls back to `python -m pip install --user <pkg>`, and if it detects a PEP-668 externally-managed environment it retries once with `--break-system-packages`. If neither `pipx` nor `python` is found it emits `error` with code `PYTHON_MISSING`.
- Calling install on a built-in runtime returns `400` (plain JSON, the SSE stream never opens); `clawboo-native` has nothing to install.

<Warning>
A global npm install can hit `EACCES`. When the installer's stderr contains `EACCES` or "permission denied", the stream emits an `error` event suggesting `sudo <installCommand>`. Prefer a Node version manager (nvm/fnm) or Homebrew over `sudo`.
</Warning>

### 3. Connect (api-key runtimes)

`POST /api/runtimes/:id/connect` with body `{ apiKey, provider? }` stores the key in the [encrypted vault](#where-keys-are-stored) and returns the recomputed `connectionState`. The key is trimmed; an empty key returns `400` (`{ error: "apiKey is required" }`). **The response never echoes the key.**

The card sends the key from the `needs-auth` state (the input label is the runtime's `envVar`, with a show/hide toggle). On success it clears the input and re-fetches status, which flips the card to `ready`.

For `clawboo-native` the optional `provider` field routes the key to the right vault slot. Without it, the key lands in `ANTHROPIC_API_KEY`; with `provider: "openai"` or `"openrouter"` it goes to that provider's env var (validated against the runtime's known set), and `provider: "ollama"` is a keyless no-op (nothing is stored).

### 4. Connect (codex, oauth)

`codex` cannot be connected with a pasted key on current versions. `POST /api/runtimes/codex/connect` is a no-op that returns:

```json
{ "ok": true, "connectionState": "needs-login", "loginCommand": "codex login" }
```

The card shows the `codex login` command (with a copy button), you run it in your terminal, then click **Re-check**. Once `codex login` has authenticated locally, the adapter run path uses Codex's own `CODEX_HOME`; Clawboo does not store a Codex credential in its vault.

### 5. Health-check a native provider key (optional)

`POST /api/runtimes/clawboo-native/healthcheck` with body `{ provider, apiKey }` verifies a key **before** you commit to it (used by the native onboarding flow before seeding a team). It makes a single authenticated `GET` to the provider's lightweight models/health endpoint:

| `provider`   | Endpoint probed                        |
| ------------ | -------------------------------------- |
| `anthropic`  | `https://api.anthropic.com/v1/models`  |
| `openai`     | `https://api.openai.com/v1/models`     |
| `openrouter` | `https://openrouter.ai/api/v1/models`  |
| `ollama`     | `<OLLAMA_BASE_URL>/api/tags` (keyless) |

It returns `{ ok: true }` on a 2xx, or `{ ok: false, error }` on a bad key (`401`/`403` → "Invalid API key."), an 8-second timeout, or a network failure. **The key is used for exactly that one fetch, never persisted to the vault, never logged, never echoed.** This route is only valid for `clawboo-native`; any other runtime id returns `400`. An unknown provider, or a missing key for a non-Ollama provider, returns `400`.

### 6. Disconnect

`POST /api/runtimes/:id/disconnect` deletes the runtime's stored credential and returns the recomputed `connectionState`. It keeps the CLI installed, so the card drops from `ready` to `needs-auth`. The card's **Disconnect** button (panel variant only) confirms first, since you will need to re-enter the key to reconnect. For `codex` (no `envVar`) this is a no-op that just re-reports state.

## Where keys are stored

API keys live in an **encrypted vault** at `~/.clawboo/secrets/runtime-keys.json` (under `resolveClawbooDir()`; the `CLAWBOO_HOME` override applies), keyed by env-var name. Each value is encrypted with AES-256-GCM under a 32-byte master key at `~/.clawboo/secrets/master.key` (mode `0600`, inside a `0700` dir). `CLAWBOO_SECRETS_MASTER_KEY` overrides the on-disk key (32-byte base64, 64 hex chars, or a raw 32-char string).

At run time the key is resolved by `resolveRuntimeKey(envVar)`, highest priority first:

1. `process.env[envVar]`
2. the encrypted vault (decrypt)
3. OpenClaw's `~/.openclaw/.env`

<Info>
This is defense in depth. The decrypted value is never logged, never returned in an HTTP response body, and never written to SQLite, audit, or observability records; it flows only into a spawned runtime process's environment. A wrong, rotated, or lost master key fails closed (resolution returns `null`); it never throws into a request or leaks partial plaintext.
</Info>

<Tip>
Because `resolveRuntimeKey` falls back to `process.env` and OpenClaw's `.env`, a runtime can already read as connected without an explicit Connect. For example, if `ANTHROPIC_API_KEY` is exported in the server's environment or present in `~/.openclaw/.env`, both `claude-code` and `clawboo-native` resolve a credential and report `ready`.
</Tip>

## Verify it worked

- Re-fetch `GET /api/runtimes` (or click **Re-check** in the card). The runtime's `connectionState` should read `ready`, and its `health.ok` should be `true`.
- For CLI runtimes, `health` reports the binary presence; for `clawboo-native`, `health` reports whether any routable provider key (or `OLLAMA_BASE_URL`) resolves.
- Run a board task on the runtime via `POST /api/runtimes/:id/run`; the connected key is injected from the vault into the spawned process's environment.

## Troubleshooting

<Warning>
**Hermes installs but reads as not-installed.** The `hermes` binary lands in the Python user-site bin, which is usually off the server's PATH. Clawboo resolves it via `resolveRuntimeBin` (PATH plus the known user-install dirs), so this is normally handled; but a fresh install's `complete` event may carry a `warning` if the binary is not yet resolvable, in which case restart the server.
</Warning>

<Warning>
**Codex shows "Needs login" after a successful `codex login`.** The card does not auto-detect the login; click **Re-check** to re-fetch status. Codex never reaches `ready` from a vault key; its auth lives in `CODEX_HOME`.
</Warning>

<Danger>
**`POST /api/runtimes/:id` with an unknown `:id`** returns `404` (`{ error: "unknown runtime '<id>'" }`). Only `claude-code`, `codex`, `hermes`, and `clawboo-native` are valid ids; OpenClaw is not a `/api/runtimes` runtime.
</Danger>

## Related

- [Runtimes overview](/runtimes/index): the capability matrix
- [Clawboo Native](/runtimes/native) · [Claude Code](/runtimes/claude-code) · [Codex](/runtimes/codex) · [Hermes](/runtimes/hermes)
- [OpenClaw](/runtimes/openclaw): the Gateway runtime (different connection model)
- [`/api/runtimes` reference](/reference/rest-api/runtimes): full request/response shapes
- [Security](/operating/security): the vault, redaction, and safe exposure
- [Environment variables](/reference/environment-variables): `CLAWBOO_HOME`, `CLAWBOO_SECRETS_MASTER_KEY`, `OLLAMA_BASE_URL`
