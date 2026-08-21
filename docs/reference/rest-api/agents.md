---
title: Agents API
description: 'REST reference for the agent registry-of-record: list, create, sync, per-agent reads, files, sessions, delete, and ghost cleanup.'
---

REST surface for the [agent registry-of-record](/appendices/glossary). SQLite is the source of truth for who exists; an `AgentSource` syncs each upstream (the OpenClaw Gateway, the in-process native runtime) INTO SQLite. Reads serve SQLite, so the agent list, an agent record, and an agent's files keep answering even when the Gateway connection is down; a `stale` flag marks that case. Writes (create), file PUTs, and live session lists delegate to the owning source and return **503** when the source needs a live upstream that is disconnected.

<Note>
These routes return clawboo-native `AgentRecord` shapes, not OpenClaw protocol shapes. The `OpenClawAgentSource` adapts the Gateway in both directions; a native (`clawboo-native`) agent is owned by a peer source whose reads and writes are pure SQLite and always work offline. See [agent-source internals](/internals/agent-source) for the sync discipline and [agent model](/concepts/agent-model) for the registry concept.
</Note>

Per-agent routes are multi-source: each operation routes to the source that OWNS the row (its `sourceId`); an unknown id falls back to the default (OpenClaw) source so its 404 semantics hold. All POST/PUT routes read a JSON body parsed by `express.json({ limit: '2mb' })`. Static paths (`sync`, `registry/health`, `cleanup-ghosts`) are registered BEFORE `/:agentId` so the param does not swallow them.

## Routes

| Method | Path                               | Summary                                                    | Stream? |
| ------ | ---------------------------------- | ---------------------------------------------------------- | ------- |
| GET    | `/api/agents`                      | Aggregate every source's agent list from SQLite            | No      |
| POST   | `/api/agents`                      | Create an agent through its source                         | No      |
| POST   | `/api/agents/sync`                 | Manual / browser-fallback sync of the OpenClaw source      | No      |
| GET    | `/api/agents/registry/health`      | Server-side OpenClaw connection state (always 200)         | No      |
| POST   | `/api/agents/cleanup-ghosts`       | Sweep stale local OpenClaw rows not in the live set        | No      |
| GET    | `/api/agents/:agentId`             | One agent record from its source                           | No      |
| DELETE | `/api/agents/:agentId`             | Archive upstream + clean local rows                        | No      |
| GET    | `/api/agents/:agentId/files/:name` | Read one agent file                                        | No      |
| PUT    | `/api/agents/:agentId/files/:name` | Write one agent file                                       | No      |
| GET    | `/api/agents/:agentId/sessions`    | List the agent's live sessions                             | No      |
| PATCH  | `/api/agents/:agentId/model`       | Change a native/hermes agent's model + provider (404 else) | No      |
| POST   | `/api/agents/:agentId/chat`        | Drive one 1:1 turn on a native agent (detached, 202)       | No      |
| POST   | `/api/agents/:agentId/chat/stop`   | Abort the agent's in-flight 1:1 turn                       | No      |
| GET    | `/api/agents/:agentId/chat/stream` | SSE live-tail of the agent's 1:1 chat session              | SSE     |

The `AgentRecord` shape (returned by `GET /api/agents`, `GET /api/agents/:agentId`, and inside the create `201`):

```ts
interface AgentRecord {
  // Identity
  id: string // clawboo PK (SQLite-native)
  sourceId: 'openclaw' | 'claude-code' | 'codex' | 'hermes' | string // owning source
  sourceAgentId: string // upstream id (Gateway-synced)
  // Display (merged)
  displayName: string // Boo-Zero override ▸ identity.name ▸ name ▸ id
  emoji: string | null
  avatarUrl: string | null
  avatarSeed: string | null
  // Live runtime state (Gateway-synced; may be stale when disconnected)
  status: 'idle' | 'running' | 'error' | 'sleeping' | 'archived'
  sessionKey: string | null
  isDefault: boolean // true when sourceAgentId === the source's defaultId (Boo Zero)
  // clawboo-native config (SQLite-native; preserved across re-sync)
  teamId: string | null
  personalityConfig: unknown | null
  execConfig: unknown | null
  model?: string | null // native: the AgentConfig primaryModel; absent for sources whose model lives elsewhere
  providerReady?: boolean | null // native: this agent has a runnable candidate (a key in its envVar slot, one of its fallbacks, or keyless Ollama); null/absent = not applicable
  // Classification (dormant seams)
  participantKind: 'agent' | 'human'
  runtime: 'openclaw' | 'claude-code' | 'codex' | 'hermes' | string
  capabilities: unknown | null
  tenantId: string | null // multi-tenant seam — null = single implicit tenant
  // Lifecycle
  archivedAt: number | null // soft-delete tombstone (epoch ms); null = live
  createdAt: number
  updatedAt: number
}
```

<Note>
`participantKind: 'human'`, `runtime` values beyond `openclaw`, and `tenantId` are documented future seams. Today every Gateway-synced record is `participantKind: 'agent'`, `runtime: 'openclaw'`, `tenantId: null`.
</Note>

---

## `GET /api/agents`

The primary fleet read. Aggregates `listAgents()` across EVERY registered source (OpenClaw + native), all SQLite-backed, so the list answers even when the Gateway connection is down. `defaultId` is the runtime-neutral Boo Zero (`resolveBooZero`: an explicit override, then the native Boo Zero, then the OpenClaw default), so a native-first install identifies its native Boo Zero. `mainKey`, `stale`, and `lastSyncedAt` stay OpenClaw-derived; `stale` is `true` whenever the server-side OpenClaw connection is not `connected`.

- **Path params**: none.
- **Query params**:

| Param             | Type     | Default          | Effect                                  |
| ----------------- | -------- | ---------------- | --------------------------------------- |
| `includeArchived` | `'true'` | off              | Include soft-deleted (archived) records |
| `teamId`          | string   | none (all teams) | Filter to one team                      |

- **Request body**: none.

### Responses

**`200 OK`**: the merged agent list:

```ts
{
  defaultId: string   // the runtime-neutral Boo Zero (resolveBooZero); '' if unset
  mainKey: string     // OpenClaw main session key; 'main' if unset
  agents: AgentRecord[]
  stale: boolean      // true when the server-side OpenClaw connection !== 'connected'
  lastSyncedAt: number | null
}
```

**`500 Internal Server Error`**: any failure listing or probing health:

```json
{ "error": "<message>" }
```

### Example

```bash
curl http://localhost:18790/api/agents
curl 'http://localhost:18790/api/agents?teamId=<team-uuid>&includeArchived=true'
```

---

## `POST /api/agents`

Creates an agent through a source. The default source is OpenClaw (Gateway create + agent-file writes + SQLite mirror), which returns **503** when the server-side connection is down. An optional `sourceId` routes the create to a peer source; `clawboo-native` writes are pure SQLite and always succeed.

- **Path/query params**: none.
- **Request body**:

```ts
{
  name: string                  // required; trimmed; must be non-empty
  teamId?: string | null
  personalityConfig?: unknown
  execConfig?: unknown
  avatarSeed?: string | null
  files?: Record<string, string>  // agent files written at create (e.g. SOUL.md, IDENTITY.md)
  sourceId?: string             // default 'openclaw'; route to a peer source (e.g. 'clawboo-native')
}
```

### Responses

**`201 Created`**: the agent was created:

```ts
{
  agent: AgentRecord
}
```

**`400 Bad Request`**: missing or blank `name`:

```json
{ "error": "name is required" }
```

**`400 Bad Request`**: `sourceId` does not name a registered source:

```json
{ "error": "unknown sourceId '<sourceId>'" }
```

**`503 Service Unavailable`**: the source needs a live Gateway connection that is down:

```json
{ "error": "gateway_disconnected" }
```

**`500 Internal Server Error`**: any other failure:

```json
{ "error": "<message>" }
```

### Example

```bash
# OpenClaw agent (default source) — needs a live Gateway
curl -X POST http://localhost:18790/api/agents \
  -H 'Content-Type: application/json' \
  -d '{"name":"Research Boo","teamId":"<team-uuid>"}'

# Native agent — pure SQLite, works offline
curl -X POST http://localhost:18790/api/agents \
  -H 'Content-Type: application/json' \
  -d '{"name":"Native Boo","sourceId":"clawboo-native"}'
```

---

## `POST /api/agents/sync`

Reconciles the OpenClaw source's upstream into SQLite. With a body it runs the **browser-fallback** path: the browser, connected through the proxy, pushes its own `agents.list` result so SQLite warms WITHOUT the server's own connection. With no body it runs the **server-side** `sync()`, which needs the connection and returns **503** when down.

- **Path/query params**: none.
- **Request body** (optional: present ⇒ browser-fallback upsert):

```ts
{
  defaultId?: string
  mainKey?: string   // trimmed; defaults to 'main'
  scope?: string
  agents?: Array<{ id: string; name?: string; identity?: Record<string, unknown> }>
}
```

The fallback path triggers only when `agents` is an array. The upsert touches Gateway-owned columns only; SQLite-native columns (`teamId`, `personalityConfig`, `execConfig`, `avatarSeed`, etc.) are preserved.

### Responses

**`200 OK`**: browser-fallback upsert (body with an `agents` array):

```ts
{ result: { upserted: number, archived: number, durationMs: 0, at: number } }
```

**`200 OK`**: server-side sync (no body):

```ts
{ result: { upserted: number, archived: number, durationMs: number, at: number } }
```

`archived` counts agents present in SQLite but gone upstream (their `archivedAt` is set; the tombstone is reversible and cleared if the agent reappears).

**`503 Service Unavailable`**: the server-side sync needs a live connection that is down:

```json
{ "error": "gateway_disconnected" }
```

**`500 Internal Server Error`**: any other failure:

```json
{ "error": "<message>" }
```

### Example

```bash
# Server-side sync
curl -X POST http://localhost:18790/api/agents/sync

# Browser-fallback upsert
curl -X POST http://localhost:18790/api/agents/sync \
  -H 'Content-Type: application/json' \
  -d '{"defaultId":"a1","mainKey":"main","agents":[{"id":"a1","name":"Boo"}]}'
```

---

## `GET /api/agents/registry/health`

Reports the server-side OpenClaw connection state. Always returns **200** (it is a liveness surface, not gated by the connection). Registered before `/:agentId` so the param does not swallow `registry`.

- **Path/query params**: none.
- **Request body**: none.

### Responses

**`200 OK`**: the OpenClaw source's `HealthResult`:

```ts
{
  ok: boolean
  connection: 'connected' | 'connecting' | 'reconnecting' | 'disconnected'
  lastSyncedAt: number | null
  message?: string
}
```

**`500 Internal Server Error`**: a failure reading health:

```json
{ "error": "<message>" }
```

### Example

```bash
curl http://localhost:18790/api/agents/registry/health
```

---

## `POST /api/agents/cleanup-ghosts`

A one-shot sweep the client invokes after hydrating from the Gateway. The caller passes the IDs of all agents currently alive in the Gateway; the endpoint deletes every local OpenClaw-owned SQLite row NOT in that list, plus its FK-referenced cost / approval rows and its per-agent settings keys. Idempotent. The sweep is scoped to `sourceId = 'openclaw'`; the live-id list comes from the Gateway, so native (and any future peer-source) agents are never ghosts of it.

- **Path params**: none.
- **Query params**:

| Param        | Type     | Effect                                                                                      |
| ------------ | -------- | ------------------------------------------------------------------------------------------- |
| `allowEmpty` | `'true'` | Permit an empty `liveAgentIds` (guards against a transient Gateway hiccup nuking every row) |

- **Request body**:

```ts
{ liveAgentIds: string[] }   // required; the IDs alive in the Gateway
```

### Responses

**`400 Bad Request`**: `liveAgentIds` is missing or not an array:

```json
{ "error": "liveAgentIds array required" }
```

**`400 Bad Request`**: `liveAgentIds` is empty and `?allowEmpty=true` was not passed:

```json
{ "error": "empty liveAgentIds list — pass ?allowEmpty=true to confirm" }
```

**`200 OK`**: no local rows were stale:

```json
{ "ok": true, "deleted": 0 }
```

**`200 OK`**: stale rows were swept (`remaining` is the post-sweep agent count, or `null`):

```ts
{ ok: true, deleted: number, remaining: number | null }
```

**`500 Internal Server Error`**: a failure during the sweep:

```json
{ "error": "<message>" }
```

### Example

```bash
curl -X POST http://localhost:18790/api/agents/cleanup-ghosts \
  -H 'Content-Type: application/json' \
  -d '{"liveAgentIds":["a1","a2"]}'
```

---

## `GET /api/agents/:agentId`

Returns one agent record, routed to the source that owns the row.

- **Path params**: `agentId`.
- **Request body**: none.

### Responses

**`200 OK`**: the record:

```ts
{
  agent: AgentRecord
}
```

**`400 Bad Request`**: missing `agentId` segment:

```json
{ "error": "agentId required" }
```

**`404 Not Found`**: no agent with that id in its source:

```json
{ "error": "agent not found" }
```

**`500 Internal Server Error`**: a failure reading the record:

```json
{ "error": "<message>" }
```

### Example

```bash
curl http://localhost:18790/api/agents/<agent-id>
```

---

## `DELETE /api/agents/:agentId`

Archives the agent. The owning source's `archiveAgent` deletes the upstream record THEN cleans the local SQLite row plus its FK-referenced children (`cost_records`, `approval_history`) and per-agent settings keys. If the server-side Gateway connection is down, it falls back to a SQLite-only cleanup so the local row never rots, disconnect tolerance.

<Note>
The browser is responsible for the Gateway `agents.delete` RPC; this endpoint cleans up clawboo's local metadata. Without it, deleted agents leave permanent ghost rows that inflate per-team `agentCount`.
</Note>

- **Path params**: `agentId`.
- **Request body**: none.

### Responses

**`200 OK`**: archived upstream and locally:

```json
{ "ok": true, "upstreamDeleted": true }
```

**`200 OK`**: the Gateway was disconnected, so only the local rows were cleaned:

```json
{ "ok": true, "upstreamDeleted": false }
```

**`400 Bad Request`**: missing `agentId` segment:

```json
{ "error": "agentId required" }
```

**`500 Internal Server Error`**: a non-disconnect failure during archive:

```json
{ "error": "<message>" }
```

### Example

```bash
curl -X DELETE http://localhost:18790/api/agents/<agent-id>
```

---

## `GET /api/agents/:agentId/files/:name`

Reads one agent file through the owning source. The `:name` segment must be one of the seven canonical agent file names; any other name is rejected before the read.

- **Path params**: `agentId`, `name`.

`:name` ∈ `AGENTS.md`, `SOUL.md`, `IDENTITY.md`, `USER.md`, `TOOLS.md`, `HEARTBEAT.md`, `MEMORY.md`.

- **Request body**: none.

### Responses

**`200 OK`**: the file content:

```ts
{ name: string, content: string }
```

**`400 Bad Request`**: missing `agentId` segment:

```json
{ "error": "agentId required" }
```

**`400 Bad Request`**: `:name` is not a recognized agent file:

```json
{ "error": "invalid file name" }
```

**`503 Service Unavailable`**: the owning source needs a live Gateway that is down:

```json
{ "error": "gateway_disconnected" }
```

**`500 Internal Server Error`**: any other failure:

```json
{ "error": "<message>" }
```

### Example

```bash
curl http://localhost:18790/api/agents/<agent-id>/files/SOUL.md
```

---

## `PUT /api/agents/:agentId/files/:name`

Writes one agent file through the owning source. Same `:name` allowlist as the read; the body must carry a string `content`.

- **Path params**: `agentId`, `name` (same allowlist as the GET).
- **Request body**:

```ts
{
  content: string
} // required; must be a string
```

### Responses

**`200 OK`**: the file was written (echoes what was stored):

```ts
{ name: string, content: string }
```

**`400 Bad Request`**: missing `agentId` segment:

```json
{ "error": "agentId required" }
```

**`400 Bad Request`**: `:name` is not a recognized agent file:

```json
{ "error": "invalid file name" }
```

**`400 Bad Request`**: `content` is missing or not a string:

```json
{ "error": "content (string) required" }
```

**`503 Service Unavailable`**: the owning source needs a live Gateway that is down:

```json
{ "error": "gateway_disconnected" }
```

**`500 Internal Server Error`**: any other failure:

```json
{ "error": "<message>" }
```

### Example

```bash
curl -X PUT http://localhost:18790/api/agents/<agent-id>/files/TOOLS.md \
  -H 'Content-Type: application/json' \
  -d '{"content":"# Tools\n\n- read_file\n"}'
```

---

## `GET /api/agents/:agentId/sessions`

Lists the agent's live sessions. The OpenClaw source delegates LIVE to the Gateway (sessions are runtime-volatile), so this route returns **503** when the connection is down.

- **Path params**: `agentId`.
- **Request body**: none.

### Responses

**`200 OK`**: the session list:

```ts
{
  sessions: Array<{
    id: string
    sourceId: 'openclaw' | 'claude-code' | 'codex' | 'hermes' | string
    sourceSessionId: string // the upstream session key
    agentId: string
    teamId: string | null
    status: 'active' | 'idle' | 'closed'
    createdAt: number | null
    updatedAt: number | null
  }>
}
```

**`400 Bad Request`**: missing `agentId` segment:

```json
{ "error": "agentId required" }
```

**`503 Service Unavailable`**: the source needs a live Gateway that is down:

```json
{ "error": "gateway_disconnected" }
```

**`500 Internal Server Error`**: any other failure:

```json
{ "error": "<message>" }
```

### Example

```bash
curl http://localhost:18790/api/agents/<agent-id>/sessions
```

---

## `PATCH /api/agents/:agentId/model`

Changes a **native** or **hermes** agent's model, and optionally its provider. For a native agent it rewrites the stored `AgentConfig` (the next run reads it), so it needs no Gateway. With a `provider` in the body, `primaryProvider`, `primaryModel`, and `envVar` move **atomically**: the model picker offers every provider's models, and a cross-provider model left on the old provider would post to the wrong endpoint and fail auth. Without a `provider`, only `primaryModel` changes; that is the back-compat contract, and also how a custom model id for the agent's current provider is set. The server has no model-to-provider catalog (custom ids are supported), so it validates the provider name against the known set and trusts the model string; the dashboard sends the pair its catalog derived. A hermes agent routes every model through OpenRouter, so its execConfig is stored as `{ provider: 'openrouter', model }`; an explicit `provider` other than `openrouter` is a **400**. An OpenClaw agent changes its model through the OpenClaw config path (`PATCH /api/system/openclaw-config` `{ agentModel }`), so this route returns **404** for other runtimes.

- **Path params**: `agentId`.
- **Request body**: `{ model: string, provider?: string }` (`model` is a native-catalog or custom model id, e.g. `claude-sonnet-4-6`; `provider` is one of the known native providers, e.g. `openrouter`).

### Responses

**`200 OK`**: the model (and, when supplied, the provider) was saved. The `provider` field is echoed back only when the request carried one:

```json
{ "ok": true, "model": "anthropic/claude-haiku-4.5", "provider": "openrouter" }
```

**`400 Bad Request`**: missing `agentId` segment, an empty `model`, an unknown `provider`, or a non-`openrouter` provider on a hermes agent:

```json
{ "error": "unknown provider '<provider>'" }
```

**`404 Not Found`**: unknown agent, or an agent on a runtime this route does not edit:

```json
{ "error": "model change via this route is native/hermes-only" }
```

**`500 Internal Server Error`**: any other failure:

```json
{ "error": "<message>" }
```

### Example

```bash
curl -X PATCH http://localhost:18790/api/agents/<agent-id>/model \
  -H 'content-type: application/json' \
  -d '{ "model": "anthropic/claude-haiku-4.5", "provider": "openrouter" }'
```

---

## `POST /api/agents/:agentId/chat`

Drives ONE conversational turn on a **clawboo-native** agent's 1:1 personal chat (the Boo Zero personal chat, and any native agent's chat). The handler persists the user turn under the session key `agent:<agentId>:native`, then starts the run **detached** and returns **202** immediately: the reply streams over the SSE route below and is persisted by the native driver, so it is not aborted when the client disconnects. OpenClaw agents keep the Gateway 1:1 path, so this route returns **404** for a non-native agent.

- **Path params**: `agentId`.
- **Request body**:

```ts
{
  message: string       // required; trimmed; must be non-empty. The context-injected
                        // text delivered to the model.
  displayText?: string  // what the transcript shows; defaults to `message`. The two
                        // differ when the client prepends a rules block / @team brief.
  entryId?: string      // idempotency key for the persisted user turn; defaults to
                        // `user-<Date.now()>`. Re-posting one inserts nothing (the
                        // optimistic client bubble and the SSE replay share the id).
}
```

### Responses

**`202 Accepted`**: the user turn was persisted and the reply run started:

```json
{ "ok": true }
```

**`400 Bad Request`**: missing `agentId` segment:

```json
{ "error": "agentId required" }
```

**`400 Bad Request`**: missing or blank `message`:

```json
{ "error": "message required" }
```

**`404 Not Found`**: the agent's `runtime` is not `clawboo-native`:

```json
{ "error": "agent is not a native conversational agent" }
```

**`500 Internal Server Error`**: any other failure:

```json
{ "error": "<message>" }
```

### Example

```bash
curl -X POST http://localhost:18790/api/agents/<agent-id>/chat \
  -H 'content-type: application/json' \
  -d '{ "message": "summarize the board", "entryId": "user-1718450000000" }'
```

---

## `POST /api/agents/:agentId/chat/stop`

Aborts the agent's in-flight 1:1 turn (the composer's Stop button). A native agent has at most one live 1:1 run, tracked by its session key; with nothing in flight the call is a no-op that still returns **200**.

- **Path params**: `agentId`.
- **Request body**: none.

### Responses

**`200 OK`**: the run was aborted, or there was nothing to abort:

```json
{ "ok": true }
```

**`400 Bad Request`**: missing `agentId` segment:

```json
{ "error": "agentId required" }
```

**`500 Internal Server Error`**: a failure during abort:

```json
{ "error": "<message>" }
```

### Example

```bash
curl -X POST http://localhost:18790/api/agents/<agent-id>/chat/stop
```

---

## `GET /api/agents/:agentId/chat/stream`

Server-Sent Events live-tail of the agent's 1:1 session (`agent:<agentId>:native`). A pure reader: it never drives a turn. Two tiers: **committed** `chat_messages` rows polled every 750 ms past an `id` cursor (durable, carry an `id:` line, replayed on resume), and **ephemeral** in-memory bus frames for live tokens and run state (no `id:` line, never replayed). Resume from a known position via the standard `EventSource` `Last-Event-ID` header or the `?since=<id>` query param.

- **Path params**: `agentId`.
- **Query params**:

| Param   | Type   | Notes                                                                                      |
| ------- | ------ | ------------------------------------------------------------------------------------------ |
| `since` | number | Resume cursor (a `chat_messages` row id). Negative/non-finite → `0`. `Last-Event-ID` wins. |

- **Request body**: none.

<Note>
This is an SSE route, not request/response. There is no JSON response body; the catalog below describes the wire frames. A missing `agentId` ends the response with a bare **400** and no `{ error }` envelope. Each polled batch reads up to 500 rows past the cursor. The stream is cleaned up on `req`/`res` close and closes no database handle (the tail reads through the process-wide shared connection).
</Note>

### Connection

On open, the handler writes `HTTP/1.1 200` with:

```http
Content-Type: text/event-stream; charset=utf-8
Cache-Control: no-cache, no-transform
Connection: keep-alive
X-Accel-Buffering: no
```

then emits a `: connected` comment frame, flushes any rows already past the cursor, and replays the session's last-published `status` per agent so a reconnecting client reconciles a badge left stale by a run that ended while no stream was open.

### Event catalog

| Frame           | When                                 | Shape                                                                 |
| --------------- | ------------------------------------ | --------------------------------------------------------------------- |
| `: connected`   | Immediately on open                  | SSE comment (ignored by `EventSource`)                                |
| entry data      | Per new committed row (every 750 ms) | `id: <row id>` line + `data: <json>` line (the stored chat entry)     |
| `event: delta`  | Per live assistant-text delta        | `{ sessionKey, runId, text }`; `text` is the FULL running text so far |
| `event: status` | At each run boundary, plus on open   | `{ agentId, status: 'running' \| 'idle' \| 'error' }`                 |
| `: keepalive`   | Every 20 s while open                | SSE comment (keeps the connection warm)                               |

`delta` and `status` frames carry no `id:` line, so they never move the resume cursor: the committed rows are the source of truth, and the deltas only make a turn type out live.

### Example

```bash
curl -N http://localhost:18790/api/agents/<agent-id>/chat/stream
curl -N 'http://localhost:18790/api/agents/<agent-id>/chat/stream?since=4187'
```

---

## Error envelope

Every error response on these routes is the standard `{ error: string }` envelope, except the SSE route (`GET /api/agents/:agentId/chat/stream`), whose only pre-stream failure is a bare **400** with no body. The disconnect case is a **503** with the literal `{ "error": "gateway_disconnected" }` on the write/file/session routes; the read routes (`GET /api/agents`, `GET /api/agents/:agentId`) keep serving SQLite instead.

## See also

- [Agent model](/concepts/agent-model), Boo, Boo Zero, the registry of record
- [Agent-source internals](/internals/agent-source), the sync discipline + idempotency rules
- [Teams API](/reference/rest-api/teams), assign an agent to a team
- [Runtimes API](/reference/rest-api/runtimes), drive a board task on a runtime; `sourceId` peer creates
- [@clawboo/agent-registry](/reference/packages/agent-registry), `AgentSource`, `AgentRecord`, `AGENT_FILE_NAMES`
- [REST API overview](/reference/rest-api/index)
