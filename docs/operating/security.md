---
title: Security model and safe exposure
description: How Clawboo authenticates, isolates secrets, and redacts output, and how to expose the dashboard safely.
---

Clawboo is a local-first, single-user tool. A fresh install binds loopback only, holds no public credential, and runs every API route behind that boundary. The security model is built around that default: the network boundary is the primary control against other hosts, an always-on same-origin guard stops a malicious web page in your own browser from reaching the loopback API, the optional access gate is the opt-in second wall when you widen the bind, the secrets vault keeps provider keys off disk in plaintext, and a display-layer redaction pass keeps credentials out of responses and logs.

This page explains the model end to end: the loopback bind, the same-origin guard, the access gate, server-side device authentication, the encrypted secrets vault, and redact-on-display, and then gives honest guidance for exposing Clawboo beyond `localhost`. It is deliberately candid about what each control does and does not protect against.

## What it is, and what it isn't

Clawboo's security posture is **single-tenant, local-first**. The defaults assume one operator on one machine. Every shipped control is designed to make that default safe and to make widening it a conscious, opt-in act:

- **The bind is the first wall.** By default nothing off the local machine can reach the dashboard or any `/api/*` route. This is the control you rely on for a normal install.
- **The same-origin guard is always on.** Loopback stops other hosts, but not a page running in your own browser, because your browser originates the connection to `127.0.0.1`. The guard validates the `Origin`, `Host`, and `Sec-Fetch-Site` headers on every `/api/*` request and WebSocket upgrade, independent of the access gate, so a malicious page you visit cannot drive the loopback API. It ships enforced with zero configuration.
- **The access gate is the opt-in second wall.** It is a single shared bearer token, off by default. It exists for the case where you deliberately bind a non-loopback interface.
- **The vault is defense in depth for provider keys**, not a targeted-attacker boundary. It defeats commodity infostealers and accidental backup/share of the vault file; it does not protect against a process running as you.
- **Redaction is a display-and-log boundary**, distinct from the storage-layer scrub. It is the last line that keeps a credential out of an API body or a log line.

What Clawboo is _not_: a multi-user authorization system, a per-tenant isolation boundary, or a key-management service. Those are future seams (see [Boundaries and non-goals](#boundaries-and-non-goals)), not shipped features.

## The model

```mermaid
flowchart TB
    subgraph remote["Remote host"]
        rc["Remote client"]
    end
    subgraph local["Local machine (127.0.0.1)"]
        bind["Bind: loopback by default<br/>(widen only via explicit HOST)"]
        guard["Same-origin guard<br/>(Origin + Host + Sec-Fetch-Site,<br/>always on)"]
        gate["Access gate<br/>(STUDIO_ACCESS_TOKEN, opt-in)"]
        api["/api/* routes"]
        proxy["Gateway proxy<br/>(Ed25519 device auth, server-side)"]
        vault["Secrets vault<br/>(AES-256-GCM)"]
        runtime["Spawned runtime<br/>(env scrubbed of server<br/>+ operator secrets)"]
    end

    rc -. "blocked at the OS<br/>unless HOST set" .-> bind
    bind --> guard
    guard -->|"same-origin only<br/>(else 403)"| gate
    gate -->|"valid cookie / token"| api
    gate -->|"loopback /api/mcp/* only"| runtime
    api --> proxy
    api --> vault
    vault -->|"plaintext ONLY into child env"| runtime
    proxy -->|"signed connect frame"| upstream["Upstream OpenClaw Gateway"]
```

The flow is: a request reaches the bind; if the bind is loopback, only local traffic gets that far. The same-origin guard then checks the `Origin`, `Host`, and `Sec-Fetch-Site` headers and answers any cross-origin `/api/*` request with a `403`, so a malicious page in your browser is turned away before any work. If the access gate is enabled, the request must carry a valid token (cookie or one-time query param), except a loopback `/api/mcp/*` request, which is the server's own spawned runtime and is exempt. Past the gate, the gateway proxy signs upstream connect frames with a server-held Ed25519 device key, and the secrets vault resolves provider keys into spawned-runtime env only, never into a response or a log.

## The loopback bind (secure by default)

The dashboard binds `127.0.0.1` unless you explicitly set `HOST`. The host resolver returns loopback, not `0.0.0.0`, so the dashboard and every `/api/*` route are reachable only from the local machine on a fresh install. An explicit `HOST` value wins (trimmed); anything else falls back to loopback.

`HOSTNAME` is intentionally **ignored** as a bind signal. Docker, systemd, and many CI runners auto-inject `HOSTNAME` into every process, so honoring it would silently bind a container to its routable IP — a network exposure you never chose. Widening the bind must be a deliberate `HOST=`.

`localhost`, `::1`, and the entire `127.0.0.0/8` range count as loopback. `0.0.0.0`, `::`, a LAN IP, or a hostname are all network-exposed.

<Warning>
If you bind a non-loopback interface (`HOST=…`) **and** have not set an access token, the server **refuses to start** — the origin guard is not authentication against a non-browser client (a LAN peer can forge the `Host`/`Origin` headers), so a token-less wide bind would leave the dashboard and every `/api/*` route reachable unauthenticated. Fix one of: set `STUDIO_ACCESS_TOKEN=<random>` to require a token; unset `HOST` to bind loopback only; or set `CLAWBOO_ALLOW_INSECURE=1` to run unauthenticated on purpose (an explicit, greppable choice that logs a loud warning). The default loopback bind never trips this.
</Warning>

## The same-origin guard (always on)

The loopback bind stops other hosts on your network, but it does not stop code running in your own browser: a web page you visit can still issue a `fetch` to (or open a WebSocket against) `http://127.0.0.1:<port>/api/*`, and because your browser originates the request, it reaches the loopback server. Left unguarded, a malicious page could drive the whole `/api/*` surface (start runtime work that spends provider credits, read your team chat and board), and a Cross-Site WebSocket Hijack could ride the server-injected upstream Gateway token. A loopback bind alone does not close this, and neither does CORS: the same-origin policy does not block the requests that matter here (a no-cors POST is still sent; a hijacked WebSocket still connects).

Clawboo closes it with a same-origin guard that runs on **every** `/api/*` request and WebSocket upgrade, **independent of the access token**, so it protects the default token-less install. It validates three things:

- **`Origin`** against an exact-match allowlist. A browser sets `Origin` on every cross-site WebSocket handshake and state-changing fetch and cannot forge or omit it, so this is the core Cross-Site WebSocket Hijacking (CSWSH) and cross-site-request defense. A foreign origin is answered with a `403`.
- **`Host`** against a hostname allowlist. This is the DNS-rebinding defense: an attacker who rebinds their own domain to `127.0.0.1` still sends `Host: their-domain`, which is not on the allowlist, so the request is rejected.
- **`Sec-Fetch-Site`** as defense in depth, covering the cross-site no-cors GET case where a browser omits `Origin`. Only `same-origin`, `same-site`, and `none` are accepted; a `cross-site` value is rejected.

A request that carries neither `Origin` nor `Sec-Fetch-Site` is allowed, because a browser cannot omit both on a cross-site request, while non-browser clients (the CLI, a spawned runtime's loopback MCP attach, an SSE/`EventSource` stream) legitimately do. That is why the loopback `/api/mcp/*` attach and the team-chat streams keep working.

**Posture.** The loopback allowlist (localhost, the `127.0.0.0/8` range, `::1`, plus the actual bind host) is always enforced with zero configuration, so the default `npx clawboo` install is protected out of the box. The environment allowlists only **widen** the set, never disable it: to reach the dashboard from a non-loopback browser origin (a LAN IP or a reverse-proxy hostname), enumerate the origins in `CLAWBOO_ALLOWED_ORIGINS` (and hostnames in `CLAWBOO_ALLOWED_HOSTS`). Because the allowlist can only be widened, a `HOST=0.0.0.0` bind cannot silently re-open the hole while `127.0.0.1` stays reachable.

<Note>
The same-origin guard is not authentication against a non-browser client on a wide bind: a LAN peer can forge `Host` and `Origin` with a plain HTTP client, which the guard cannot detect. That is why a non-loopback bind still requires `STUDIO_ACCESS_TOKEN` (and the server refuses to start without it). The guard defends against the browser attacker; the token defends against the network peer. They are complementary, not substitutes.
</Note>

## The access gate (opt-in)

The access gate is a single shared bearer token, controlled by the `STUDIO_ACCESS_TOKEN` environment variable and read at server start. A blank or unset value disables the gate entirely. When enabled, it is the only authentication on the dashboard, so its design is deliberately conservative.

**Constant-time, length-hiding compare.** The token is never compared byte-by-byte against the cookie. Both sides are SHA-256-hashed to a fixed 32-byte digest first, then compared with a constant-time equality check. Hashing first means the comparison neither short-circuits on the first differing byte (a timing oracle) nor leaks the token's length.

**Case-folded path test (no `/API/` bypass).** Before the gate tests whether a path is an `/api/*` route, it lowercases the pathname. The Express app also sets case-sensitive routing so its matcher and the gate agree. Together this closes a bypass where an uppercased `/API/settings` could resolve to the real handler while slipping past a case-sensitive prefix check. The gate folds case itself rather than trusting the host app's routing configuration.

**Loopback `/api/mcp/*` exemption.** A spawned runtime attaches its MCP client to `http://127.0.0.1:<port>/api/mcp/*` with no cookie, by design, because the runtime's environment is scrubbed of the access token (see [Secrets never reach spawned runtimes](#secrets-never-reach-spawned-runtimes)). The gate therefore lets a request through _only_ when it is both loopback (`127.0.0.1`, `::1`, or `::ffff:127.0.0.1` at the TCP socket) **and** targets `/api/mcp/*`. A remote client cannot forge a loopback source address on a real TCP handshake, so this is a safe basis for the exemption. Every other `/api/*` route, and any non-loopback `/api/mcp/*` request, still requires the cookie.

**Token charset validation (fail-loud).** The token is written raw into a `Set-Cookie` value and compared raw against the cookie, but percent-decoded on the query path. A token containing a cookie delimiter or other unsafe character would corrupt the cookie and silently lock the operator out of every `/api/*` route with no hint. So the gate validates the token against a safe charset (`[A-Za-z0-9._~-]`). If the token contains anything else, the gate logs a warning naming the offending character and **disables itself** rather than ship a permanent lockout.

How a token is presented:

| Channel                             | Behaviour                                                                                                                                                                                                                                                  |
| ----------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `?access_token=<token>` query param | Validated; on success the gate sets an `HttpOnly`, `SameSite=Lax`, `Path=/` cookie and 302-redirects to strip the token from the URL. `Secure` is added only when the request arrived over TLS, so the cookie still works on a plain-http loopback origin. |
| `clawboo_access` cookie             | The steady-state credential, validated on every `/api/*` request and every WebSocket upgrade.                                                                                                                                                              |
| Invalid / missing                   | `401` with a JSON `{ error }` body. The missing-cookie message tells you to open `/?access_token=<token>` once to set the cookie.                                                                                                                          |

The same authorization check guards the WebSocket upgrade for the gateway proxy: when the gate is enabled, an upgrade is allowed only if it carries a valid cookie.

<Note>
The access gate is a single shared secret; every client that knows the token has full operator access. It is the right tool for "lock down a deliberately-exposed single-user dashboard," not for multi-user authorization. There are no per-user accounts, roles, or scopes.
</Note>

## Server-side device authentication

The upstream OpenClaw Gateway requires an Ed25519 device signature on every connect frame. Clawboo handles this entirely server-side in the [gateway proxy](/concepts/gateway-and-events), so the browser never manages device keys.

The proxy holds a persistent Ed25519 identity at `~/.clawboo/proxy-device-identity.json`. The file contains the private key and is written with restrictive permissions: a `0700` directory and a `0600` file, and the proxy re-hardens the file to `0600` on every load, so an identity file loosened by an older code path or an upgrade is brought back to safe permissions. POSIX modes are advisory on Windows, so this is best-effort there.

When a browser opens a WebSocket to the proxy, the proxy opens the upstream connection eagerly, captures the Gateway's `connect.challenge` nonce, then, on the browser's connect frame, injects the upstream bearer token (which lives only on the server; `GET /api/settings` exposes a `hasToken` flag, never the value) and signs the frame with the proxy's device identity, replacing any browser-supplied device fields. Fresh browser contexts (preview, incognito, a new machine) connect with no device setup. If signing fails for any reason, the proxy strips the device fields and forwards without them rather than crashing the connection.

For the full handshake and event pipeline, see [Gateway and events](/concepts/gateway-and-events).

## The encrypted secrets vault

Provider and runtime API keys you connect through the dashboard are stored in an encrypted vault under Clawboo's own directory, never in OpenClaw's directory and never in plaintext on disk:

| Path                                   | Contents                                | Permissions                     |
| -------------------------------------- | --------------------------------------- | ------------------------------- |
| `~/.clawboo/secrets/master.key`        | 32-byte AES master key, base64          | `0600` file inside a `0700` dir |
| `~/.clawboo/secrets/runtime-keys.json` | `{ [envVar]: { iv, tag, ciphertext } }` | `0600`, ciphertext only         |

Each value is encrypted with AES-256-GCM under the master key. The master key is auto-generated on first use, or you can supply your own via `CLAWBOO_SECRETS_MASTER_KEY` (a 32-byte key as base64, 64 hex characters, or a raw 32-character string). Decryption enforces the standard GCM 96-bit IV and 128-bit auth-tag lengths; a truncated tag, which would weaken forgery resistance, is rejected.

The key and the ciphertext are colocated under `secrets/` by design — a local-first, single-user tool has no daemon or keychain, and the only reader that can reach the key (a process running as you) can already read the plaintext elsewhere. For true at-rest key/ciphertext **separation** (so a whole-directory backup of `secrets/` can't carry both), point `CLAWBOO_SECRETS_MASTER_KEY` at a source **outside** `~/.clawboo` — e.g. `CLAWBOO_SECRETS_MASTER_KEY=$(cat ~/.config/clawboo-master.key)` or a secret manager. Permissions are enforced at write (`0700` dir / `0600` files) and re-verified on every boot (a group/other-readable secret surfaces as a degraded check in System Health).

**Resolution chain.** A runtime provider key is resolved by env-var name, highest priority first:

1. `process.env[envVar]`: an explicit environment variable wins.
2. The encrypted vault (decrypt).
3. OpenClaw's `~/.openclaw/.env`, so an existing OpenClaw provider key auto-satisfies a sibling runtime.

This single function is the _only_ place a secret value is read; callers put the plaintext straight into a spawned process's env and nowhere else.

**Fail-closed.** A wrong, rotated, or lost master key, or a corrupt vault entry, returns `null`, never a partial plaintext and never a thrown error into a request path.

<Danger>
The vault is **defense in depth, not targeted-attacker-proof.** It defeats commodity infostealers and the accidental backup, sync, or sharing of the vault file (the ciphertext is useless without the separate master key), but it does **not** protect against a process running as you, which can read the master key from disk or grab the decrypted value from memory or the spawned child's env. The vault holds one value per env-var, server-wide; a multi-key / per-team model is a documented future seam.
</Danger>

### Secrets never reach spawned runtimes

A spawned runtime (a Codex or Hermes CLI, the Claude Agent SDK child, and the deterministic verify gate) executes an _untrusted_ agent that can read its own process environment with a single `env` dump. The child-environment builder scrubs two families of secrets before the child inherits them, then merges the caller's explicit provider-key grant on top:

- **Clawboo's own server secrets**, which must never leak: `GATEWAY_AUTH_TOKEN`, `STUDIO_ACCESS_TOKEN`, `CLAWBOO_SECRETS_MASTER_KEY`, and any `BETTER_AUTH*` key.
- **A curated set of the operator's third-party shell credentials** that no runtime uses for auth: cloud, CI, package-registry, and database tokens such as `AWS_SECRET_ACCESS_KEY`, `GITHUB_TOKEN`, `NPM_TOKEN`, `STRIPE_SECRET_KEY`, and `DATABASE_URL`. This keeps a prompt-injected task from dumping the credentials you happen to have exported into your shell, including env-only secrets (CI-injected session tokens) that never touch disk and so are reachable no other way.

The scrub is **by exact name, not a broad heuristic**. The provider auth a runtime legitimately reads from the ambient env (`OPENAI_API_KEY` for Codex, a configured provider key for Hermes, `ANTHROPIC_AUTH_TOKEN` for Claude Code) and infra config (`PATH`, `HOME`, `PYTHONUSERBASE`, proxy variables, `AWS_REGION`) are preserved, so tightening the scrub never silently breaks a runtime. AWS access keys are the one conditional case: they are scrubbed by default but kept when you explicitly run Claude Code against Amazon Bedrock (`CLAUDE_CODE_USE_BEDROCK`), the signal that a runtime needs them.

<Warning>
This is defense in depth, **best-effort by name, not a sandbox.** The agent still runs un-sandboxed and can read on-disk credentials (`~/.aws/credentials`, `~/.config/gh/hosts.yml`, a project `.env`), so treat every task you run as code you are choosing to execute locally. The scrub closes the trivial `env`-dump vector and the env-only secrets; it does not isolate the runtime.
</Warning>

Scrubbing `STUDIO_ACCESS_TOKEN` is also exactly why the loopback `/api/mcp/*` access-gate exemption exists: the runtime's env has been stripped of the token, so it _cannot_ present the gate cookie, and the loopback exemption is the controlled way to let only the server's own runtime through.

## Redact-on-display

Clawboo masks credential-looking content at two distinct boundaries, with two distinct markers, defense in depth:

- **Storage-layer scrub** (in `@clawboo/db`) masks secrets with `[REDACTED]` _before_ anything is persisted to SQLite, the audit log, or the observability event log.
- **Display/log-layer redaction** (in `@clawboo/logger`, re-exported by the server) masks with a bullet string (`••••`) at two later boundaries: just before an API response body is sent, and inside the pino logger so every log record passes through it.

The display redactor masks both credential-looking **keys** (a key containing `token`, `secret`, `password`, `api_key`, `authorization`, `bearer`, `credential`, `private_key`, `access_key`, or `cookie`) and credential-shaped **values** (PEM private-key blocks, `sk-`/`sk-ant-`/`sk-or-` API keys, GitHub/GitLab PATs, Slack tokens, AWS access-key IDs, Google API keys, `Bearer …` headers, and JWTs). Crucially, numeric telemetry survives: a `SAFE_COUNT_KEYS` allowlist (`inputTokens`, `outputTokens`, `totalTokens`, and similar token _counts_) is matched against the exact key name, so a token _count_ is never masked while a real credential under e.g. `accessToken` still is. Numbers, booleans, and `null` always pass through.

It is applied at the API response sites that expose stored payloads: the observability events, traces, and graph projection; the governance audit summary; and the tools audit `argsSummary`/`resultSummary`, each of which runs the JSON-string `data`/`summary` field through `redactJsonString` before sending, and at the System Health endpoint, which runs the whole report through `redactObject`.

<Note>
Redaction is a safety net, not the primary control; the value patterns are an intentional allow-list of known credential shapes, not universal coverage. A new vendor's key format may need an entry. The real guarantee that a provider key never reaches a response or log is the [vault's invariant](#the-encrypted-secrets-vault): the plaintext flows only into a spawned process's env.
</Note>

## How to expose Clawboo safely

The honest summary: Clawboo is single-tenant and local-first today. If you keep the loopback default you need none of the following; if you widen the bind, do all of it.

1. **Prefer not to widen the bind.** For local use, leave `HOST`/`HOSTNAME` unset. The dashboard is loopback-only and no token is needed.
2. **If you must reach it remotely, tunnel rather than bind wide.** An SSH tunnel or a reverse proxy that terminates TLS and forwards to `127.0.0.1:<port>` keeps the bind loopback and adds a real transport-security and authentication layer in front. This is the recommended path.
3. **If you do bind a non-loopback interface, set `STUDIO_ACCESS_TOKEN`.** Use a long random token from the safe charset (`[A-Za-z0-9._~-]`). The boot warning exists to catch the case where you forget; do not run a non-loopback bind without it.
4. **Terminate TLS in front of the dashboard** so the access cookie is sent with `Secure`. The gate only marks the cookie `Secure` when the request arrives over TLS (it detects this via `x-forwarded-proto: https`), so a terminating proxy that sets that header is what upgrades the cookie.
5. **Treat the access token as a full-operator credential.** Everyone who has it can do everything. Rotate it by changing the env var and restarting; there is no per-user revocation.

<Warning>
A non-loopback bind with no access token is the single most dangerous misconfiguration: every `/api/*` route, including the ones that resolve provider keys into spawned runtimes, becomes reachable by anyone on the network. The boot-time `SECURITY:` warning is your signal that this has happened.
</Warning>

## Design rationale and trade-offs

The model optimizes for a frictionless single-user local install while keeping a clear, opt-in path to a locked-down exposed one. Loopback-by-default means a fresh install is never accidentally on the network, and the always-on same-origin guard means a malicious web page in your own browser cannot reach the loopback API either, so the zero-config install is safe against both the remote host and the drive-by browser attacker. A single shared token (rather than accounts) keeps the exposed-but-single-user case trivial to set up. Server-side device auth keeps key management out of the browser entirely, so any browser context connects. The vault is a pragmatic "raise the bar against the common threats without pretending to defeat a local attacker" choice, and it says so plainly. Redaction is a cheap, broad backstop layered behind a narrow structural guarantee (secrets only enter child env).

The trade-offs are equally plain: there is no multi-user authorization, the token is all-or-nothing, and the vault cannot defend against a process running as you. Each is a conscious scope boundary, not an oversight.

## Boundaries and non-goals

- **Single-tenant today.** There is no per-tenant isolation. The dormant `tenant_id` columns across the schema are a future seam; no per-tenant filtering or scoping is active in v0.2.1.
- **OpenClaw shared memory is registered globally.** Because OpenClaw agents are cross-team, Clawboo registers the shared [Memory](/concepts/memory) MCP server for the OpenClaw runtime at _global_ scope rather than per-run/per-team scope (the other four runtimes get per-run team scope). In a multi-tenant world that global registration would need narrowing; it is a documented multi-tenant deferral, not a leak in the single-tenant model Clawboo ships.
- **Not a key-management service.** The vault stores one value per env-var, server-wide. Named profiles, per-team keys, and rotation tooling are future seams.
- **Not multi-user.** The access gate is one shared secret with no accounts, roles, or scopes.

<Note>
These docs describe Clawboo **v0.2.1**, the current release.
</Note>

## See also

- [Deployment](/operating/deployment): ports, state directory, and the bundled server
- [Gateway and events](/concepts/gateway-and-events): the proxy handshake and event pipeline
- [Connecting runtimes](/runtimes/connecting-runtimes): the connect/disconnect flow that writes the vault
- [Memory](/concepts/memory): the shared-tier registration and its OpenClaw global-scope note
- [Environment variables](/reference/environment-variables): `STUDIO_ACCESS_TOKEN`, `HOST`/`HOSTNAME`, `CLAWBOO_SECRETS_MASTER_KEY`
- [Configuration](/reference/configuration): settings file and directory locations
- [Glossary](/appendices/glossary): canonical term definitions
