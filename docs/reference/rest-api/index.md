---
title: 'REST API overview'
sidebarTitle: 'Overview'
description: 'Call the Clawboo server API: base URL, authentication, the same-origin guard, rate limits, errors, streaming, and an index of all 199 routes.'
keywords: ['api', 'rest', 'http', 'curl', 'access token', 'rate limit', 'cors', 'sse', 'websocket']
---

The Clawboo server answers JSON requests under `/api/` on the same port as the dashboard. The dashboard itself runs on this API, so you can script anything you do in the app. Use this page for the rules every route shares; each resource page lists its routes with parameters, bodies, responses and an example.

## At a glance

| Topic          | Default                                                                               |
| -------------- | ------------------------------------------------------------------------------------- |
| Base URL       | `http://localhost:18790` (the port can differ; see [Base URL](#base-url))             |
| Request bodies | JSON, up to 2 MB                                                                      |
| Authentication | None on the default loopback bind; the `clawboo_access` cookie when a token is set    |
| Cross-origin   | Browser requests from other origins are refused with `403` unless you allowlist them  |
| Rate limits    | 3,000 requests a minute per client; 60 a minute across the sensitive routes           |
| Streaming      | 9 routes answer with Server-Sent Events; one WebSocket route for the OpenClaw Gateway |
| Routes         | 199: 89 `GET`, 79 `POST`, 15 `DELETE`, 9 `PATCH`, 7 `PUT` ([index](#route-index))     |

Check that the server is up (the response carries `"ok": true` when no boot check failed):

```bash
curl http://localhost:18790/api/health
```

The examples on these pages assume the default port and no access token. With a token set, add the cookie shown under [Authentication](#authentication).

## Base URL

The server picks its port at startup. It tries `18790` first and scans up to `18809` (20 ports), binding the first free one. Three environment variables change that:

| Variable                 | Effect                                                                                                      |
| ------------------------ | ----------------------------------------------------------------------------------------------------------- |
| `CLAWBOO_API_PORT`       | Use exactly this port. The server fails to start if it is taken. Wins over the other two.                   |
| `PORT`                   | Outside `--dev`, use exactly this port (fails if taken). Checked before the scan, so it beats the next one. |
| `CLAWBOO_API_PORT_START` | Start the scan here instead of `18790`.                                                                     |

After binding, the server writes the port to `<clawboo home>/api-port.txt` (`~/.clawboo/api-port.txt` unless `CLAWBOO_HOME` is set). The CLI reads that file to find a running server; see [CLI](/reference/cli).

### Serving under a path prefix

Set `CLAWBOO_BASE_PATH` (for example `/clawboo`) to serve the app under a prefix, typically behind a reverse proxy. The API then answers at `/clawboo/api/...`, and it still answers at the unprefixed `/api/...`, which the CLI, agent MCP connections and the update check use on the loopback port. The access cookie's `Path` follows the prefix.

The value must be one or more segments of `A-Z a-z 0-9 . _ ~ -` and must not start with `api`. A malformed value stops the server at startup with a `SECURITY/CONFIG` error.

## Host binding

The server listens on loopback (`127.0.0.1`) by default, so other machines cannot reach it. Set `HOST` to listen on another interface (`HOSTNAME` is ignored).

A non-loopback bind without an access token makes the server refuse to start (`SECURITY: refusing to start`, exit code 1). Set `STUDIO_ACCESS_TOKEN`, or set `CLAWBOO_ALLOW_INSECURE=1` to run open on purpose. [Self-host securely](/guides/self-host-securely) walks through a safe remote setup.

## Authentication

Clawboo has no user accounts. The only credential is an optional access token, read from the `STUDIO_ACCESS_TOKEN` environment variable at startup.

- **No token (the default):** every route answers without credentials. This relies on the loopback bind; the [same-origin guard](#same-origin-guard) still refuses cross-origin browser requests.
- **Token set:** every `/api/*` request and the WebSocket need a `clawboo_access` cookie whose value is the token.

A browser gets the cookie by opening `http://localhost:18790/?access_token=<token>` once. The server answers `302`, sets the cookie (`HttpOnly`, `SameSite=Lax`, `Path=/` or the base path, plus `Secure` when the request arrived with `X-Forwarded-Proto: https`) and redirects to the same URL without the token.

A script sends the cookie itself. Add `-b` to any example on these pages:

```bash
curl -b "clawboo_access=$STUDIO_ACCESS_TOKEN" http://localhost:18790/api/agents
```

Keep the token out of API URLs: any request whose URL carries `access_token` gets that `302` answer (or a `401` when the token is wrong) instead of the route's response.

| Request                                  | Status | Body                                                                                              |
| ---------------------------------------- | ------ | ------------------------------------------------------------------------------------------------- |
| Wrong token in `?access_token=`          | `401`  | `{ "error": "Invalid Clawboo access token." }`                                                    |
| `/api/*` without a valid cookie          | `401`  | `{ "error": "Clawboo access token required. Open /?access_token=<token> once to set a cookie." }` |
| WebSocket upgrade without a valid cookie | none   | The socket is closed                                                                              |

The token may contain only `A-Z a-z 0-9 . _ ~ -`. A token with any other character turns the gate off, and the server only logs a warning. A non-loopback bind then refuses to start (unless `CLAWBOO_ALLOW_INSECURE=1`), but a loopback bind behind a reverse proxy on the same machine serves every route with no token, so check the startup log. `openssl rand -hex 24` makes a suitable token. The comparison is constant-time, and the `/api/` prefix test ignores letter case.

**Agent MCP connections.** An agent runtime that Clawboo starts reaches the four MCP endpoints (`/api/mcp/tasks`, `/api/mcp/memory`, `/api/mcp/tools`, `/api/mcp/teamchat`) without a cookie. It passes only with the `attachToken` Clawboo put in its attach URL, and only when it connects straight to the loopback port with no proxy forwarding headers. `/api/mcp/config` always needs the cookie. See [Tools and MCP](/reference/rest-api/tools-and-mcp).

## Same-origin guard

Every `/api/*` request passes an origin check before the token check, whether or not a token is set. The guard answers `403` with `{ "error": "Cross-origin request blocked." }` unless all three headers pass:

| Header                       | Allowed values                                                                                                                                                         |
| ---------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Host`                       | `localhost`, any `127.x.x.x`, `::1`, the bind host, or a name in `CLAWBOO_ALLOWED_HOSTS`                                                                               |
| `Origin` (when sent)         | `http` or `https` on `localhost`, `127.0.0.1` or `[::1]` at the API port; the bind host at the API port; port `5173` in dev; or an origin in `CLAWBOO_ALLOWED_ORIGINS` |
| `Sec-Fetch-Site` (when sent) | `same-origin`, `same-site` or `none`                                                                                                                                   |

curl and other non-browser clients send no `Origin` or `Sec-Fetch-Site`, so a local script passes. A refused WebSocket upgrade gets `403 Forbidden` with no body.

The guard is not authentication: a non-browser client can send any headers it likes. Use the access token for that.

When clients reach the server by another name (a LAN address, or a reverse proxy that passes its own host name), add that name to `CLAWBOO_ALLOWED_HOSTS`. For a browser on that origin, also add the full origin (for example `https://clawboo.example.com`) to `CLAWBOO_ALLOWED_ORIGINS`. Both take comma-separated lists, and both only widen the allowlist.

**CORS.** A built app serves the dashboard and the API from one origin, so it sends no CORS headers. In dev (`--dev`, with Vite on port 5173), the server answers credentialed CORS requests only from origins the guard allows; it never reflects an arbitrary origin.

## Requests and responses

- **Bodies** are JSON (`Content-Type: application/json`), parsed once for every route with a 2 MB limit. Malformed JSON gets `400` and a larger body gets `413`. Both come from the body parser before any route runs, with an HTML error page rather than a JSON body.
- **Paths are case-sensitive.** `/api/agents` matches; `/API/agents` does not.
- **Unknown paths.** In a built app, a `GET` to an unknown `/api/` path returns the dashboard page (HTML, `200`), because the page fallback answers every unmatched `GET`. Other methods get `404`. When a call returns HTML, check the path.
- **Long requests.** Some routes hold the connection open until work finishes, for example `POST /api/runtimes/:id/run` and `POST /api/governance/delegation-approval`. Their pages say so.

## Rate limits

Two ceilings apply. Both count requests in memory, per client address, over a 60-second window.

| Tier      | Limit                                                    | Applies to                                          | `429` body                                                                      |
| --------- | -------------------------------------------------------- | --------------------------------------------------- | ------------------------------------------------------------------------------- |
| General   | 3,000 requests a minute                                  | Every `/api/*` request                              | `{ "error": "Too many requests. Wait a moment and retry." }`                    |
| Sensitive | 60 requests a minute, one budget shared by all 26 routes | The routes listed below, on top of the general tier | `{ "error": "Too many requests for this operation. Wait a moment and retry." }` |

Responses carry `RateLimit-Policy`, `RateLimit-Limit`, `RateLimit-Remaining` and `RateLimit-Reset` (IETF draft 6). A `429` also carries `Retry-After` in seconds. On a sensitive route these headers describe the sensitive budget. The dashboard's page and asset files have their own ceiling and do not count against the API.

The client address is the TCP peer. `X-Forwarded-For` is ignored, so behind a reverse proxy every client shares the proxy's budget.

The sensitive tier covers the routes that install software, rewrite runtime configuration, start sign-ins or grant access:

| Page                                                 | Sensitive routes                                                                                                                                                                                                                                                                                                                              |
| ---------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [Agents](/reference/rest-api/agents)                 | `POST /api/agents/:agentId/shell`                                                                                                                                                                                                                                                                                                             |
| [Memory](/reference/rest-api/memory)                 | `POST /api/memory/embedding/reindex`, `POST /api/memory/embedding/install`                                                                                                                                                                                                                                                                    |
| [Connectors](/reference/rest-api/connectors)         | `POST /api/connectors/connect`; `PUT` and `DELETE /api/connectors/composio/key`; `POST /api/connectors/composio/apps/:slug/authorize`; `POST /api/connectors/custom`; `DELETE /api/connectors/custom/:slug`; `POST /api/connectors/:slug/disconnect`; `POST` and `DELETE /api/connectors/:slug/authorize`; `PUT /api/connectors/:slug/config` |
| [Runtimes](/reference/rest-api/runtimes)             | `POST /api/auth/cli-login/:tool`; `POST /api/runtimes/:id/install`, `/connect`, `/disconnect`, `/logout`                                                                                                                                                                                                                                      |
| [System](/reference/rest-api/system)                 | `POST /api/system/install-openclaw`, `/configure-openclaw`, `/auto-configure-openclaw`, `/gateway`, `/approve-device`, `/self-update`; `PATCH /api/system/openclaw-config`                                                                                                                                                                    |
| [Agent settings](/reference/rest-api/agent-settings) | `POST /api/exec-allowlist/revoke`                                                                                                                                                                                                                                                                                                             |

Every other route is on the general tier, including routes that start work, such as `POST /api/runtimes/:id/run`, `POST /api/teams/:id/chat` and the MCP transports. For what to do when the dashboard shows "Too many requests", see [Troubleshooting](/help/troubleshooting).

## Errors

A JSON error body carries a human-readable `error` string. Many routes add fields (zod `details` on a validation failure, `findings`, `reason`, `code`), and some answer `{ "ok": false, "error": "..." }`. Each resource page lists its shapes. Three kinds of failure are not this JSON: body-parser errors (HTML, see above), the MCP transports (JSON-RPC error objects), and the SSE routes, which report a failure as a frame inside the stream once it has opened.

| Status | Meaning                                                                                                                                                                                                                                                                     |
| ------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `400`  | The body, query or path failed validation, or the JSON was malformed                                                                                                                                                                                                        |
| `401`  | A token is set and the cookie is missing or wrong                                                                                                                                                                                                                           |
| `403`  | The same-origin guard refused the request, or a schedule's source does not allow that change                                                                                                                                                                                |
| `404`  | Unknown resource or id                                                                                                                                                                                                                                                      |
| `409`  | A conflict that retrying will not fix: a task someone else claimed, an illegal status change, a failed check blocking `done`, a dependency cycle, an unreadable worktree. Treat it as an answer, not a transient error.                                                     |
| `413`  | A body over 2 MB, or a previewed file over 8 MB                                                                                                                                                                                                                             |
| `422`  | Well-formed but refused: blocked prompt-injection content, a capability whose tier forbids the change, a connector that cannot run here, a worktree for a task kind that gets none, or a run the task runner refuses (`budget_paused`, `too_deep`, `workspace_unavailable`) |
| `429`  | A rate limit                                                                                                                                                                                                                                                                |
| `500`  | An unexpected failure inside the handler                                                                                                                                                                                                                                    |
| `502`  | An upstream refused the request: the OpenClaw Gateway, Composio or a connector                                                                                                                                                                                              |
| `503`  | The server's connection to the OpenClaw Gateway is down (`{ "error": "gateway_disconnected" }`)                                                                                                                                                                             |

## Streaming routes

Nine routes answer with Server-Sent Events (`Content-Type: text/event-stream`) and write `data: <json>` frames. Each page documents its frames.

| Routes                                                                                                              | Page                                               |
| ------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------- |
| `POST /api/system/install-openclaw`, `POST /api/system/gateway` (start and restart), `POST /api/system/self-update` | [System](/reference/rest-api/system)               |
| `POST /api/runtimes/:id/install`, `POST /api/auth/cli-login/:tool`                                                  | [Runtimes](/reference/rest-api/runtimes)           |
| `POST /api/memory/embedding/install`                                                                                | [Memory](/reference/rest-api/memory)               |
| `GET /api/agents/:agentId/chat/stream`                                                                              | [Agents](/reference/rest-api/agents)               |
| `GET /api/teams/:id/chat/stream`                                                                                    | [Teams](/reference/rest-api/teams)                 |
| `GET /api/obs/stream`                                                                                               | [Observability](/reference/rest-api/observability) |

The three tail routes (the two chat streams and the event stream) put an `id:` line on every stored row, so an `EventSource` resumes from `Last-Event-ID` after a reconnect. They start in different places when you send no cursor: the chat streams start at the newest message and send only what follows, while the event stream replays the whole log for its scope first. A streaming route can still answer with a JSON error before the stream opens (for example `409` from the model install). The `GET` routes of the MCP transports are also event streams, but they carry MCP JSON-RPC, not Clawboo frames.

## WebSocket: the Gateway proxy

`/api/gateway/ws` is the one WebSocket route. It carries the dashboard's connection to the OpenClaw Gateway through the server, which adds the Gateway token and Clawboo's signed device identity to the upstream connect frame, so the browser never sees the Gateway token. The route also answers at `<base path>/api/gateway/ws`; any other upgrade is closed.

The same-origin guard runs on the upgrade first (`403 Forbidden` on failure), then the access gate (with a token set, a missing cookie closes the socket). The frames are the Gateway's own protocol; see [Gateway and events](/internals/gateway-and-events).

## Route index

The router registers 199 routes: 89 `GET`, 79 `POST`, 15 `DELETE`, 9 `PATCH`, 7 `PUT`. Each belongs to one page:

| Page                                                 | Routes | What it covers                                                                                                                                      |
| ---------------------------------------------------- | ------ | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| [Agents](/reference/rest-api/agents)                 | 19     | `/api/agents*`: list, create, sync, delete, model, agent files, sessions, workspaces, browser screenshots, the native shell switch, 1:1 agent chats |
| [Teams](/reference/rest-api/teams)                   | 21     | `/api/teams*` (members, rooms, onboarding, activity summary, team chat), `/api/team-rules/:teamId`, `/api/team-chat*`                               |
| [Board](/reference/rest-api/board)                   | 24     | `/api/board*`: tasks, claim, status changes, comments, retry, assign, run ledger, dependencies, worktrees, the workspace file view and preview      |
| [Memory](/reference/rest-api/memory)                 | 9      | `/api/memory*`: search, save, browse, graph, feedback, outcomes, embedding status, reindex, model install                                           |
| [Capabilities](/reference/rest-api/capabilities)     | 2      | `/api/capabilities*`: the merged skills, tools and connectors inventory, and its actions                                                            |
| [Connectors](/reference/rest-api/connectors)         | 21     | `/api/connectors*` (including Composio and custom connectors), `/api/grants*`                                                                       |
| [Boo Zero](/reference/rest-api/boo-zero)             | 9      | `/api/boo-zero/*`: team briefs, the global brief, display names, the leader override                                                                |
| [Runtimes](/reference/rest-api/runtimes)             | 17     | `/api/runtimes*`, `/api/providers*`, `/api/onboarding/*`, `/api/auth/cli-login/:tool`                                                               |
| [Schedules](/reference/rest-api/schedules)           | 7      | `/api/schedules*`: Routines and OpenClaw Gateway cron jobs                                                                                          |
| [Governance](/reference/rest-api/governance)         | 7      | `/api/governance/*` (budgets, audit log, delegation approval), `/api/approvals`                                                                     |
| [Costs](/reference/rest-api/costs)                   | 4      | `/api/cost-records*`, `/api/fleet/summary`                                                                                                          |
| [Observability](/reference/rest-api/observability)   | 8      | `/api/obs/*`, `/api/eval/smoke`                                                                                                                     |
| [Tools and MCP](/reference/rest-api/tools-and-mcp)   | 17     | `/api/tools*`, `/api/mcp/config`, the four MCP transports under `/api/mcp/*`                                                                        |
| [Agent settings](/reference/rest-api/agent-settings) | 10     | `/api/personality`, `/api/exec-settings*`, `/api/exec-allowlist*`, `/api/skills`                                                                    |
| [Chat history](/reference/rest-api/chat-history)     | 4      | `/api/chat-history*`                                                                                                                                |
| [Settings and health](/reference/rest-api/settings)  | 6      | `/api/settings`, `/api/health*`, `/api/graph-layout`                                                                                                |
| [System](/reference/rest-api/system)                 | 11     | `/api/system/*`: OpenClaw install, setup and Gateway control, models, device pairing, Clawboo's own version and update                              |
| [Catalog](/reference/rest-api/catalog)               | 3      | `/api/catalog/*`: the marketplace's agent and team templates                                                                                        |

Source of truth for maintainers: the router `apps/web/server/api/index.ts`, the middleware order in `apps/web/server/index.ts`, `apps/web/server/lib/rateLimit.ts`, and `packages/gateway-proxy/src/access-gate.ts` and `origin-guard.ts`.

## Related

- [Self-host securely](/guides/self-host-securely): reach Clawboo from another machine with a token and the allowlists.
- [Security](/operating/security): the access gate, the same-origin guard and what each protects.
- [Environment variables](/reference/environment-variables): `STUDIO_ACCESS_TOKEN`, `HOST`, the port and allowlist variables.
- [Limits and defaults](/reference/limits-and-defaults): every limit and timeout in one table.
- [MCP tools](/reference/mcp-tools): the tools agents call over the MCP transports.
