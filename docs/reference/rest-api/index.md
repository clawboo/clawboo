---
title: REST API overview
description: Base URL, the SPA proxy, the access gate, the WS upgrade, the error envelope, and a grouped index of all 124 routes.
---

The Clawboo dashboard server (`apps/web/server/index.ts`) is an Express app wrapped in a raw `http.Server` so it can also handle the WebSocket upgrade for the Gateway proxy. Every JSON route lives under `/api/`, is registered in one router (`apps/web/server/api/index.ts`), and returns the standard `{ error: string }` envelope on failure. This page covers the cross-cutting facts: base URL, the proxy, auth, body limits, the error shape, and the streaming endpoints, then links to the per-resource reference pages.

<Note>
These docs describe Clawboo **v0.2.1**, the current release.
</Note>

## Base URL

The server picks its port at boot, so there is no single hardcoded URL. The default is **`18790`**; if it is taken the server scans upward through `18809` (20 consecutive ports) and binds the first free one.

```
http://localhost:18790
```

- **`CLAWBOO_API_PORT=N`** pins the port exactly (no fallback; the server throws if `N` is taken).
- **`CLAWBOO_API_PORT_START=M`** changes where the auto-scan begins (default `18790`).
- In a non-`--dev` (production / CLI) boot with neither Clawboo override set, the legacy **`PORT`** env var is honored (Heroku/Render/Cloud Run compatibility).

After a successful bind the chosen port is written to `<clawboo-home>/api-port.txt` so the CLI, the Vite dev proxy, and e2e helpers can discover it without scanning. All `curl` examples in the per-resource pages assume the default `18790`.

## Host binding

The server binds **loopback (`127.0.0.1`) by default**; a fresh install is never reachable by other hosts. Set `HOST` or `HOSTNAME` to widen the bind (e.g. a headless/remote box). Binding a non-loopback interface **without** an access token logs a loud security warning at boot; pair a wide bind with `STUDIO_ACCESS_TOKEN`.

## How the SPA reaches `/api`

The SPA and the API are served from the same origin in production: the Express app serves the Vite build (`dist/ui/`) as static files with a GET catch-all that returns `index.html` for client-side routes, and the same app mounts the API router. So a browser at `http://localhost:18790` hits `/api/...` on that same origin with no CORS.

In **dev** (`pnpm dev`), Vite serves the SPA on `:5173` and proxies `/api` to the dynamic API port; CORS (`origin: true, credentials: true`) is enabled **only** in dev mode.

## Request body limit

All routes share one JSON body parser, applied before the router:

```ts
app.use(express.json({ limit: '2mb' }))
```

A body larger than 2 MB is rejected by the parser. Routes that take no body (most GET/DELETE routes) ignore it.

## The access gate

Authentication is opt-in via the **`STUDIO_ACCESS_TOKEN`** env var. When it is **unset or blank, the gate is disabled** and every route is open; the secure-by-default posture relies on the loopback bind, not on a token.

When the token is set, the gate (`packages/gateway-proxy/src/access-gate.ts`) is enforced as middleware before the router:

| Step                            | Behavior                                                                                                                                                                                                                                                                                  |
| ------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| First visit                     | Open `http://localhost:18790/?access_token=<token>` once. The gate validates the token (constant-time, SHA-256-hashed compare), sets an `HttpOnly` cookie `clawboo_access`, and **302-redirects** to strip the token from the URL.                                                        |
| Bad token in `?access_token=`   | **`401`** `{ "error": "Invalid Clawboo access token." }`                                                                                                                                                                                                                                  |
| `/api/*` without a valid cookie | **`401`** `{ "error": "Clawboo access token required. Open /?access_token=<token> once to set a cookie." }`                                                                                                                                                                               |
| Loopback `/api/mcp/*`           | **Exempt**: an MCP-transport request from a loopback peer (`127.0.0.1` / `::1`) passes without a cookie, so a server-spawned runtime can reach its own MCP control plane (its env is scrubbed of the token by design). A **non-loopback** `/api/mcp/*` request still requires the cookie. |
| WS upgrade                      | Allowed only when the cookie is valid (always allowed when the gate is disabled).                                                                                                                                                                                                         |

<Tip>
The cookie is marked `Secure` only when the request arrives over TLS (`X-Forwarded-Proto: https`). On a plain-http loopback origin the cookie is set without `Secure` so the gate still works.
</Tip>

<Note>
The `/api/` prefix check is **case-folded** (`pathname.toLowerCase()`), so `/API/settings`, `/Api/...`, etc. are gated identically; there is no case-sensitivity bypass (the server also sets Express `case sensitive routing: true`). The configured token is validated against a safe charset (`^[A-Za-z0-9._~-]+$`) when the gate is built; a token containing a disallowed character disables the gate with a loud warning (fail-loud, never a silent lockout).
</Note>

The query param (`access_token`) and cookie name (`clawboo_access`) are the defaults; both are configurable in `createAccessGate(...)` but the server passes neither, so the defaults apply.

## The WebSocket upgrade: `/api/gateway/ws`

The one non-HTTP endpoint. The raw `http.Server` routes the `upgrade` event: a request whose pathname is exactly `/api/gateway/ws` is handed to the Gateway proxy; every other upgrade has its socket destroyed (Vite HMR runs on its own port). The proxy opens an upstream WebSocket to the OpenClaw Gateway, injects the server-side auth token + device signature into the `connect` frame, and forwards frames bidirectionally; the browser never sees the upstream token.

This is a protocol stream, not a request/response endpoint. The frame shapes and lifecycle are documented in the [Gateway & events](/concepts/gateway-and-events) concept page, not here.

<Info>
The access gate's `allowUpgrade(req)` check runs before the proxy forwards the upgrade. If `STUDIO_ACCESS_TOKEN` is set, a browser must already hold the `clawboo_access` cookie or the upgrade is refused (socket destroyed).
</Info>

## The error envelope

Every JSON route returns the same envelope on failure:

```ts
{
  error: string
}
```

The HTTP status carries the category; the `error` string is the human-readable message. Common statuses across the surface:

| Status | Meaning                                                                                               |
| ------ | ----------------------------------------------------------------------------------------------------- |
| `400`  | Malformed/invalid body or path param                                                                  |
| `401`  | Access gate rejected the request (token set, cookie missing/invalid)                                  |
| `404`  | Unknown resource, or a flag/segment that does not resolve (e.g. an unknown runtime id)                |
| `409`  | Atomic-claim conflict on the board (a 409 is data; do not retry it)                                   |
| `422`  | The request was well-formed but refused for a domain reason (e.g. budget paused, delegation too deep) |
| `500`  | An unexpected throw inside the handler                                                                |

A handful of routes deviate from the bare `{ error }` shape, and those deviations are documented on the resource page:

- The native **`/api/runtimes/:id/healthcheck`** route returns `{ ok: false, error }` (success is `{ ok: true }`).
- **`/api/runtimes/:id/run`** returns `{ ok: false, reason }` on its non-200 board/runtime refusals.
- **SSE routes** emit `error`-typed event frames inside the stream rather than an HTTP error body (see below).

## Streaming endpoints (SSE)

Three routes are **Server-Sent Events**, not request/response. They set `Content-Type: text/event-stream`, flush headers, and emit `data: <json>\n\n` frames. They are documented with an event-stream catalog (event `type` → payload) on their resource pages, not with a response body:

| Route                                                                           | Resource page                                          |
| ------------------------------------------------------------------------------- | ------------------------------------------------------ |
| `POST /api/system/install-openclaw`, `POST /api/system/gateway` (start/restart) | [System API](/reference/rest-api/system)               |
| `POST /api/runtimes/:id/install`                                                | [Runtimes API](/reference/rest-api/runtimes)           |
| `GET /api/obs/stream`                                                           | [Observability API](/reference/rest-api/observability) |

## Route index

124 routes across 13 resource groups: **54 GET · 47 POST · 11 DELETE · 7 PATCH · 5 PUT**. Each group has a dedicated reference page.

| Resource page                                      | Routes | What it covers                                                                                |
| -------------------------------------------------- | ------ | --------------------------------------------------------------------------------------------- |
| [Settings & health](/reference/rest-api/settings)  | 4      | `/api/settings`, `/api/health`, `/api/health/recheck`                                         |
| [Agents](/reference/rest-api/agents)               | 10     | `/api/agents*`: the registry of record, files, sessions, sync, cleanup-ghosts                 |
| [Teams](/reference/rest-api/teams)                 | 12     | `/api/teams*`, `/api/team-rules/:teamId`, `/api/team-chat*`                                   |
| [Board](/reference/rest-api/board)                 | 16     | `/api/board*`: tasks, claim, comments, executions, deps, worktree workspace                   |
| [Runtimes](/reference/rest-api/runtimes)           | 7      | `/api/runtimes*`, `/api/onboarding/seed-native-team`                                          |
| [Memory](/reference/rest-api/memory)               | 4      | `/api/memory*`: search, save, browse, provider                                                |
| [Tools & MCP](/reference/rest-api/tools-and-mcp)   | 17     | `/api/tools*`, `/api/mcp/*` (the four MCP transports + attach config)                         |
| [Governance](/reference/rest-api/governance)       | 7      | `/api/governance/*`, `/api/approvals`                                                         |
| [Capabilities](/reference/rest-api/capabilities)   | 2      | `/api/capabilities`, `/api/capabilities/:action`                                              |
| [Observability](/reference/rest-api/observability) | 8      | `/api/obs/*` (incl. SSE), `/api/eval/smoke`                                                   |
| [Schedules](/reference/rest-api/schedules)         | 5      | `/api/schedules*`: the unified Routines + Gateway-cron surface                                |
| [System](/reference/rest-api/system)               | 8      | `/api/system/*`: status, install, configure, gateway, models, device pairing                  |
| [Misc](/reference/rest-api/misc)                   | 24     | cost-records, chat-history, graph-layout, personality, skills, exec-settings, fleet, boo-zero |

<Note>
The route counts above sum to 124 and partition the full surface; every registered route belongs to exactly one resource page. The "Misc" page is the catch-all for the smaller UI-backing resources that do not warrant their own page.
</Note>

## See also

- [Settings & health API](/reference/rest-api/settings), the one liveness surface that works with the Gateway down
- [System API](/reference/rest-api/system), OpenClaw install/configure/gateway lifecycle (SSE)
- [Runtimes API](/reference/rest-api/runtimes), the gold-standard per-route reference for this group
- [Gateway & events](/concepts/gateway-and-events), the `/api/gateway/ws` proxy + the Bridge→Policy→Handler pipeline
- [Security](/operating/security), access gate, device auth, redaction, exposing safely
- [Environment variables](/reference/environment-variables), `STUDIO_ACCESS_TOKEN`, `CLAWBOO_API_PORT*`, `HOST`/`HOSTNAME`
