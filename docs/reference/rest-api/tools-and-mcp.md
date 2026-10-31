---
title: 'Tools and MCP API'
sidebarTitle: 'Tools and MCP'
description: 'REST reference for the tools broker (tools, approvals, audit) and the MCP transport: attach snippets, the attach token, session binding and /api/mcp.'
keywords:
  [
    'mcp',
    'tools',
    'approvals',
    'audit',
    'attachToken',
    'scopeSig',
    'streamable http',
    'mcp config',
    'tools & mcp',
  ]
---

Use these routes for two related things. The tools broker routes (`/api/tools*`) list Clawboo's built-in tools, show and answer the tool-approval queue, and read the tool-call audit log. The MCP routes (`/api/mcp/*`) carry Clawboo's four MCP servers (`tasks`, `memory`, `tools`, `teamchat`) over Streamable HTTP, which the runtimes Clawboo starts attach to. `GET /api/mcp/config` builds an attach snippet for an agent you connect yourself.

<Note>

The MCP routes speak the Model Context Protocol (JSON-RPC over Streamable HTTP), not a Clawboo request and response format, so they are documented by their transport rules and status codes. The tools each server offers, and their inputs, are in the [MCP tools reference](/reference/mcp-tools). To attach an outside agent step by step, see [MCP servers](/operating/mcp-servers).

</Note>

Every route here is on the general [rate limit](/reference/rest-api/index#rate-limits) (3,000 requests a minute per client address), including the approval resolve and the MCP transport; none is on the sensitive tier. Request bodies are JSON (up to 2 MB). Argument and result summaries are scrubbed when they are written; the approval queue and the audit log mask them again before they leave the server, and the `/api/tools*` routes mask their error messages. The `curl` examples assume the access gate is off. With `STUDIO_ACCESS_TOKEN` set, the `/api/tools*` routes and `GET /api/mcp/config` need the access cookie (`-b 'clawboo_access=<token>'`, see [Authentication](/reference/rest-api/index#authentication)), and the MCP transport takes the `attachToken` described below.

## Routes

| Method | Path                               | Summary                                                 | Stream?         |
| ------ | ---------------------------------- | ------------------------------------------------------- | --------------- |
| GET    | `/api/tools`                       | List the built-in tools and whether each is available   | No              |
| GET    | `/api/tools/approvals`             | The pending tool-approval queue                         | No              |
| POST   | `/api/tools/approvals/:id/resolve` | Answer a pending approval (allow once, always, or deny) | No              |
| GET    | `/api/tools/audit`                 | The tool-call audit log (before and after each call)    | No              |
| GET    | `/api/mcp/config`                  | Build an attach snippet for one runtime and one server  | No              |
| POST   | `/api/mcp/tasks`                   | MCP JSON-RPC requests (Tasks server)                    | Streamable HTTP |
| GET    | `/api/mcp/tasks`                   | MCP event stream for a Tasks session                    | SSE             |
| DELETE | `/api/mcp/tasks`                   | End a Tasks session                                     | No              |
| POST   | `/api/mcp/memory`                  | MCP JSON-RPC requests (Memory server)                   | Streamable HTTP |
| GET    | `/api/mcp/memory`                  | MCP event stream for a Memory session                   | SSE             |
| DELETE | `/api/mcp/memory`                  | End a Memory session                                    | No              |
| POST   | `/api/mcp/tools`                   | MCP JSON-RPC requests (Tools server)                    | Streamable HTTP |
| GET    | `/api/mcp/tools`                   | MCP event stream for a Tools session                    | SSE             |
| DELETE | `/api/mcp/tools`                   | End a Tools session                                     | No              |
| POST   | `/api/mcp/teamchat`                | MCP JSON-RPC requests (TeamChat server)                 | Streamable HTTP |
| GET    | `/api/mcp/teamchat`                | MCP event stream for a TeamChat session                 | SSE             |
| DELETE | `/api/mcp/teamchat`                | End a TeamChat session                                  | No              |

---

## `GET /api/tools`

Lists every built-in tool with an availability verdict worked out from the server's environment. A tool that needs something not set up reads `available: false`, with `diagnostics` saying why; the dashboard greys it out, and the Tools MCP server leaves it out of `tools/list`. The four built-in tools are `echo` and `note` (risk `safe`), `web_search` (`external`, hidden until `TAVILY_API_KEY` is set or a Tavily sign-in exists) and `delete_path` (`destructive`).

- **Path/query params**: none.
- **Request body**: none.

### Responses

**`200 OK`**: the tools and their availability:

```ts
{
  ok: true
  tools: Array<{
    name: string
    description: string
    owner: 'core' | 'plugin' | 'channel' | 'mcp' // 'core' when not set
    risk: 'safe' | 'destructive' | 'external' // 'safe' when not set
    available: boolean
    diagnostics: string[] // why it is hidden, when it is
  }>
}
```

**`500 Internal Server Error`**: the tool list could not be built:

```json
{ "error": "<masked message>" }
```

### Example

```bash
curl http://localhost:18790/api/tools
```

---

## `GET /api/tools/approvals`

The pending tool-approval queue: rows whose `status` is `pending` and whose `expiresAt` has not passed, newest first. Each row's `argsSummary` (scrubbed when it was written) is masked again here. The dashboard's approval cards read this queue, on the board's **Needs you** column and in team chat. A broker waiting on an approval, in this server or in an MCP stdio process, checks the same rows for the answer.

The queue holds two kinds of row, told apart by `kind`:

- **`tool`**: Clawboo itself holds the call. Its tool broker is waiting for the answer, a native agent's `run_command` is waiting on the row it wrote, or a delegation is waiting for its approval.
- **`exec`**: a shell command an OpenClaw agent asked to run. The OpenClaw Gateway holds the command; Clawboo copies the request into a row so the card survives a closed tab, a refresh, or a tab opened partway through. Such a row has `toolName: 'exec'`, `toolClass: 'destructive'`, and the command's first 200 characters as `toolSummary`.

- **Path/query params**: none.
- **Request body**: none.

### Responses

**`200 OK`**: the pending approvals, each the whole stored row:

```ts
{
  ok: true
  approvals: Array<{
    id: string
    kind: 'tool' | 'exec' // who holds the call: Clawboo, or the OpenClaw Gateway
    toolName: string
    agentId: string | null
    argsSummary: string | null // scrubbed JSON of the arguments, masked again here
    reason: string | null
    status: 'pending' // this route returns pending rows only
    taskId: string | null // the board task this approval holds up, when known
    tenantId: string | null // unused
    grantId: string | null // the connector grant the call runs under
    connectorId: string | null
    neverRemember: 0 | 1 // 1: an "always" answer is not remembered for this call
    ruleReason: string | null // the reason code behind the prompt
    toolClass: string | null // Clawboo's reading of the tool: 'read' | 'write' | 'destructive'
    toolSummary: string | null // a one-line description for the card
    createdAt: number
    expiresAt: number
    resolvedAt: number | null
  }>
}
```

**`500 Internal Server Error`**:

```json
{ "error": "<masked message>" }
```

### Example

```bash
curl http://localhost:18790/api/tools/approvals
```

---

## `POST /api/tools/approvals/:id/resolve`

Answers an approval. An unknown `decision` is a **400**. The route then loads the row and acts on its `kind`, because the two kinds are held by different things and released in different ways. The **404** means only that no row with that id exists; an approval that was already answered is not a 404.

**A `kind: 'tool'` row** is answered here. The answer is written only while the row is still `pending`; any other row (already answered, or marked `expired`) comes back unchanged with **200**, so check `status` in the response. A waiting broker sees the answer the next time it checks.

For a `tool` row, `allow_always` also creates a standing allow rule tied to the row's grant: later calls of the same tool under that grant run without asking, whatever their arguments, for 30 days. No rule is made when the row has no `grantId`, when it has `neverRemember: 1`, or when this call did not change the row (it was already answered).

**A `kind: 'exec'` row** is held by the OpenClaw Gateway, and answering Clawboo's copy alone would not release the command. So the answer goes to the Gateway as `exec.approval.resolve`, in OpenClaw's own words (`allow_once` becomes `allow-once`, `allow_always` becomes `allow-always`, `deny` stays `deny`), and Clawboo marks its copy only after the Gateway takes it. This branch answers a different **200** body and is the only one that can answer **502**.

<Note>

Clawboo makes no rule of its own for an `exec` row. An `allow_always` is passed on as `allow-always`, and any standing permission it creates lives in OpenClaw's own allowlist, which you can read and revoke through `/api/exec-allowlist` (see the [Agent settings API](/reference/rest-api/agent-settings)).

</Note>

- **Path params**: `id` (approval id).
- **Request body**:

```ts
{
  decision: 'allow_once' | 'allow_always' | 'deny' // required
}
```

### Responses

**`400 Bad Request`**: `decision` is missing or not one of the three values. `details` is the validation error:

```json
{
  "error": "invalid body",
  "details": { "formErrors": [], "fieldErrors": { "decision": ["..."] } }
}
```

**`404 Not Found`**: no approval with that id exists:

```json
{ "error": "approval not found" }
```

**`200 OK`** (`kind: 'tool'`): the whole row after the answer, with the same fields as the queue. `argsSummary` is the stored, scrubbed value; this route does not mask it again:

```ts
{
  ok: true
  approval: {
    id: string
    kind: 'tool'
    status: 'allow_once' | 'allow_always' | 'deny' | 'expired'
    resolvedAt: number | null // when the row was answered, which may be earlier than this call
    // ...and every other field shown under GET /api/tools/approvals
  }
}
```

**`200 OK`** (`kind: 'exec'`): the Gateway took the answer. There is **no `approval` object** here:

```ts
{
  ok: true
  kind: 'exec'
  alreadyResolved: boolean
}
```

`alreadyResolved: true` means the Gateway reports the command as already answered. That is a normal race, not a failure: the same card can be open in several browser tabs, each with its own Gateway connection. Clawboo then leaves its copy as it is and settles it from the Gateway's `exec.approval.resolved` broadcast, which is also how a card answered elsewhere clears from a tab.

**`502 Bad Gateway`** (`kind: 'exec'` only): the Gateway did not take the answer, so the command is still waiting and the card stays open:

```json
{ "error": "the Gateway did not accept that decision" }
```

**`500 Internal Server Error`**:

```json
{ "error": "<masked message>" }
```

### Example

```bash
curl -X POST http://localhost:18790/api/tools/approvals/<approval-id>/resolve \
  -H 'Content-Type: application/json' \
  -d '{"decision":"allow_once"}'
```

---

## `GET /api/tools/audit`

The tool-call audit log: one row before and one after each brokered call, newest first. `argsSummary` and `resultSummary` are masked again before they are returned.

- **Query params**:

| Param      | Type   | Default     | Meaning                 |
| ---------- | ------ | ----------- | ----------------------- |
| `toolName` | string | (all tools) | Only this tool's rows   |
| `limit`    | number | `100`       | The most rows to return |

- **Request body**: none.

### Responses

**`200 OK`**: the audit rows:

```ts
{
  ok: true
  audit: Array<{
    id: string
    toolName: string
    agentId: string | null
    phase: 'before' | 'after'
    decision: string | null // before rows: allow | deny | require_approval | rewrite
    argsSummary: string | null // scrubbed JSON, masked again here
    resultSummary: string | null // after rows: scrubbed, shortened, masked again here
    isError: number // 0 | 1
    tenantId: string | null
    grantId: string | null // the grant the call ran under; null for a built-in tool
    connectorId: string | null
    ruleId: string | null // the standing rule that allowed it, if any
    createdAt: number
  }>
}
```

**`500 Internal Server Error`**:

```json
{ "error": "<masked message>" }
```

### Example

```bash
curl 'http://localhost:18790/api/tools/audit?toolName=web_search&limit=20'
```

---

## MCP transport: `/api/mcp/{tasks,memory,tools,teamchat}`

Twelve routes, `POST`, `GET` and `DELETE` on each of `/api/mcp/tasks`, `/api/mcp/memory`, `/api/mcp/tools` and `/api/mcp/teamchat`, carry Clawboo's four MCP servers over Streamable HTTP. The servers run inside the Clawboo server. Each connection is a stateful session named by the `mcp-session-id` header.

| Method   | Role                                                                                                                                                                         |
| -------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `POST`   | JSON-RPC requests. The first must be `initialize`, sent without a session id; the response's `mcp-session-id` header names the new session, and later requests send it back. |
| `GET`    | The session's event stream from the server (notifications and streamed results). One per session.                                                                            |
| `DELETE` | Ends the session.                                                                                                                                                            |

Headers a client sends:

- Every `POST`: `Content-Type: application/json` and `Accept: application/json, text/event-stream`.
- A `GET`: `Accept: text/event-stream`.
- After `initialize`: the `mcp-session-id` it returned, and optionally `mcp-protocol-version`.

Each session gets its own server instance, made at `initialize` and dropped when the session closes. The servers bind the session to a caller when it starts (see the binding sections below). Sessions live in memory, so a restart of the Clawboo server ends them all and clients must send `initialize` again.

Errors from the transport are JSON-RPC error bodies, `{ "jsonrpc": "2.0", "error": { "code": -32000, "message": "<message>" }, "id": null }`, except where the table says otherwise:

| Status | When                                                                                                                                                       |
| ------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 400    | A `POST` with no session id that is not `initialize`, or with a session id that has no live session: `No valid session; send an initialize request first.` |
| 400    | A `GET` or `DELETE` with a missing or unknown session id: `Invalid or missing MCP session id.`                                                             |
| 400    | An `mcp-protocol-version` header the server does not support                                                                                               |
| 401    | The access gate is on and the request has neither the cookie nor a valid `attachToken` (a plain `{ "error": ... }` body, below)                            |
| 406    | A `POST` whose `Accept` lacks `application/json` or `text/event-stream`, or a `GET` whose `Accept` lacks `text/event-stream`                               |
| 409    | A second `GET` stream for a session that already has one                                                                                                   |
| 415    | A `POST` to a live session whose `Content-Type` is not `application/json` (an `initialize` sent that way gets the first 400)                               |
| 500    | An error before the response started: `{ "error": "<message>" }`                                                                                           |

### Access: the `attachToken`

With the access gate on (`STUDIO_ACCESS_TOKEN` set), a request to one of the twelve transport routes needs either the access cookie or an `attachToken` query parameter. The token is an HMAC-SHA256 the server derives from a per-install secret, and it is the same on every attach URL of an install. Clawboo writes it into every attach URL it builds: for the runtimes it starts, and in the `GET /api/mcp/config` snippet. It is checked on every request (`initialize` and the session's later `POST`, `GET` and `DELETE` alike), which is why it rides in the URL.

The token counts only on a request that reached the loopback port directly. It is refused from another machine, and on any request that carries a proxy header (`Forwarded`, `X-Forwarded-For`, `X-Forwarded-Host`, `X-Forwarded-Proto` or `X-Real-IP`). It opens these twelve routes only: `GET /api/mcp/config` always needs the cookie while the gate is on, because it signs attach URLs. With the gate off, neither is needed. The server log masks `attachToken`, `scopeSig` and `provSig` values.

Without either credential the gate answers **401**:

```json
{ "error": "Clawboo access token required. Open /?access_token=<token> once to set a cookie." }
```

Clawboo 0.5.0, the latest npm release, does not have this rule: on 0.5.0 any loopback request reaches every `/api/mcp/*` route, `/api/mcp/config` included, without the cookie. See [Security](/operating/security).

### Session binding: who is calling

Every server reads who is calling from the attach URL when the session starts, at `initialize`. A binding counts only when its `scopeSig` signature verifies. Clawboo signs the URLs it writes for the runtimes it starts, and `GET /api/mcp/config` signs the ones it builds for you. A parameter added or edited by hand, without a matching signature, is ignored, so neither the model nor the runtime can widen what a session sees by changing tool arguments or its own config.

| Server     | URL parameters                                                                                                       | What a verified binding does                                                                                                                                                                                    |
| ---------- | -------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `tasks`    | `scopeTeamId`, `scopeAgentId`, `scopeSig`                                                                            | Board reads and writes are limited to that team; a task from another team reads as not found. `scopeAgentId` also delivers the agent's undelivered inbox messages on its tool responses.                        |
| `memory`   | `scopeTeamId`, `scopeAgentId`, `scopeTenantId`, `scopeSig`; `provRuntime`, `provTaskId`, `provSessionKey`, `provSig` | Saves are tagged with the team, so every teammate can recall them. Reads see that team, this agent's private facts and the global tier. The `prov*` stamps record which runtime, task and session saved a fact. |
| `tools`    | `scopeTeamId`, `scopeAgentId`, `scopeSig`                                                                            | Connector grants scoped to that agent or team apply to its tool calls.                                                                                                                                          |
| `teamchat` | `roomTeamId`, `postAuthorAgentId`, optional `delegate=1`, `scopeSig`                                                 | Posts go to that team's peer-chat room as that agent; both parameters are required. `delegate=1` adds the `team_delegate` tool; Clawboo sets it only for runs the team chat starts.                             |

The provenance stamps have their own signature, `provSig`. They are dropped when it does not verify, and they never widen what a session can see. `delegate=1` is covered by `scopeSig`, so it cannot be added to a signed URL.

### What an unverified caller gets

An HTTP session with no binding, or with a signature that does not verify, is an **unverified caller**:

| Server     | Unverified HTTP caller                                                                                                                          |
| ---------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| `tasks`    | No `claim_task` or `assign_task`. `add_comment` posts as a plain agent comment with no author id. Reads and writes are not limited to one team. |
| `memory`   | Reads and saves use the global tier only; scope arguments in tool calls are ignored, and no provenance is recorded.                             |
| `tools`    | No agent identity, so a grant scoped to an agent or a team never matches its calls.                                                             |
| `teamchat` | No tools at all.                                                                                                                                |

**OpenClaw agents are always unverified callers.** The Gateway's MCP config is one entry for the whole Gateway, so it cannot carry a per-agent binding. Clawboo registers `tasks`, `memory` and `tools` for OpenClaw with no binding, and never registers `teamchat`. The URL carries the `attachToken` only when the Gateway runs on this machine; a Gateway on another machine gets the bare URL.

The stdio servers (the MCP bins) are different: there you, the operator, run the server, so scope comes from the tool arguments.

### What each server offers

Tasks serves board tools (12, including `list_tasks`, `create_task`, `claim_task` and `add_comment`), Memory serves `memory_save`, `memory_search`, `memory_browse` and `memory_feedback`, Tools serves the available built-in tools, the connector tools the caller's grants allow, and `read_tool_result` for a result too large to return at once, and TeamChat serves `team_chat_post`, `team_chat_subscribe` and, on a `delegate=1` session, `team_delegate`. The full list, with each tool's inputs, is in the [MCP tools reference](/reference/mcp-tools). The `GET` stream carries MCP notifications and streamed results, not Clawboo-shaped events.

### Example (a raw `initialize`)

```bash
# With the access gate on, add ?attachToken=<token> (copy it from GET /api/mcp/config)
# to the URL in both calls.

# 1. Initialize. The response carries the mcp-session-id header.
curl -i -X POST http://localhost:18790/api/mcp/tasks \
  -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"curl","version":"0"}}}'

# 2. Send the session id back on every later call.
curl -X POST http://localhost:18790/api/mcp/tasks \
  -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' \
  -H 'mcp-session-id: <id-from-step-1>' \
  -d '{"jsonrpc":"2.0","id":2,"method":"tools/list"}'
```

Without a binding this session is an unverified caller, so its `tools/list` leaves out `claim_task` and `assign_task`. In practice an MCP client library, or the runtime's own MCP support, speaks the protocol for you; get its attach snippet from `GET /api/mcp/config`.

---

## `GET /api/mcp/config`

Builds a copy-and-paste attach snippet for one runtime and one MCP server. The HTTP address uses the port this server is bound to (`http://127.0.0.1:<port>`), never the request's `Host` header, so a forged `Host` cannot send a runtime's MCP traffic elsewhere. If that port is unknown, it falls back to `CLAWBOO_API_PORT`, else `18790`.

Every `http` URL it returns carries the `attachToken`. Send `scopeTeamId` or `scopeAgentId` and the URL also carries those parameters with a matching `scopeSig`, so the binding counts. Because the route signs whatever identity you ask for, it always needs the access cookie while the gate is on; the `attachToken` does not open it.

- **Query params**:

| Param          | Type   | Default       | Values                                                              |
| -------------- | ------ | ------------- | ------------------------------------------------------------------- |
| `server`       | string | `tasks`       | `tasks`, `memory`, `tools`, `teamchat` (anything else is a **400**) |
| `runtime`      | string | `claude-code` | `claude-code`, `codex`, `openclaw`                                  |
| `transport`    | string | `http`        | `http`; any other value is treated as `stdio`                       |
| `scopeTeamId`  | string | none          | A team to bind, covered by `scopeSig`                               |
| `scopeAgentId` | string | none          | An agent to bind, covered by `scopeSig`                             |

Only `server` is checked. An unknown `runtime` answers `200` with `{ "ok": true }` and no `config`.

<Warning>

Binding `scopeAgentId` to an existing agent makes your outside agent act as that agent: it uses that agent's grants, and the Tasks server delivers that agent's inbox messages to it, so the real agent no longer receives them. Use `scopeAgentId` only with an agent id that nothing else runs as.

</Warning>

- **Request body**: none.

### Responses

**`400 Bad Request`**: `server` is not one of the four servers:

```json
{ "error": "unknown server: <server>" }
```

**`200 OK`**: the attach config:

```ts
{
  ok: true
  config?: {
    id: string // 'clawboo-<server>'
    transport: 'http' | 'stdio'
    snippet: string // a command or config block to copy
    structured: Record<string, unknown> // the same thing as data, e.g. Claude Code's inline mcpServers entry
  } // absent for an unknown runtime
}
```

What `snippet` holds:

| `runtime`     | `http`                                                                                       | `stdio`                                                                   |
| ------------- | -------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| `claude-code` | `claude mcp add --transport http clawboo-<server> '<url>'` (the URL is quoted for the shell) | `claude mcp add clawboo-<server> -e CLAWBOO_DB_PATH=<db> -- node <bin>`   |
| `codex`       | a `[mcp_servers.clawboo-<server>]` block for `~/.codex/config.toml` with `url = "<url>"`     | a `[mcp_servers.clawboo-<server>]` block with `command`, `args` and `env` |
| `openclaw`    | an entry for `mcp.servers` in `openclaw.json` with `"transport": "streamable-http"`          | an entry for `mcp.servers` with `command`, `args` and `env`               |

An `http` URL looks like `http://127.0.0.1:18790/api/mcp/tasks?attachToken=<64 hex characters>`, with the scope parameters before the token when you ask for them. A `stdio` snippet runs `node <CLAWBOO_MCP_BIN_DIR>/<server>.js` (a `<path-to>/dist/bin/<server>.js` placeholder when `CLAWBOO_MCP_BIN_DIR` is not set) and sets `CLAWBOO_DB_PATH` to this server's database, because the stdio bins otherwise open a different default database (see [Data and state](/operating/data-and-state)).

**`500 Internal Server Error`**:

```json
{ "error": "<message>" }
```

### Example

```bash
curl 'http://localhost:18790/api/mcp/config?runtime=claude-code&server=tasks&transport=http'

# A Memory attach bound to one team
curl 'http://localhost:18790/api/mcp/config?runtime=claude-code&server=memory&scopeTeamId=<team-id>'
```

---

## Error envelope

The `/api/tools*` routes and `GET /api/mcp/config` use the standard `{ "error": string }` body; on the `/api/tools*` routes the message is masked. The resolve route's validation `400` adds `details`. The MCP transport answers with the JSON-RPC error bodies in its table, except for the gate's `401` and a `500`, which use the standard body. A rate-limited request answers **429** `{ "error": "Too many requests. Wait a moment and retry." }` with a `Retry-After` header.

**Source of truth:** `apps/web/server/api/tools.ts` and `mcp.ts`; the servers in `packages/mcp/src/` (`http.ts`, `config.ts`, `tasks/`, `memory/`, `tools/`, `teamchat/`); the gate in `packages/gateway-proxy/src/access-gate.ts`; approvals in `packages/db/src/tools/persistence.ts`.

## Related

- [MCP tools reference](/reference/mcp-tools): every tool the four servers offer, and its inputs.
- [MCP servers](/operating/mcp-servers): attach an outside agent, transports and scoping in practice.
- [Security](/operating/security): the access gate, the attach token and reverse proxies.
- [Approvals](/using/approvals): answering approval cards in the dashboard.
- [Runtimes API](/reference/rest-api/runtimes): a task run attaches to these servers.
- [REST API overview](/reference/rest-api/index): authentication, rate limits and conventions.
