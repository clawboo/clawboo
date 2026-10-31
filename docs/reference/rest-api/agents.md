---
title: 'Agents API'
sidebarTitle: 'Agents'
description: 'REST reference for agents: list, create, sync, delete, agent files, sessions, model, workspaces, browser screenshots, the native shell switch and 1:1 chat.'
keywords: ['agents', 'boo', 'agent files', 'screenshot', 'browser', 'shell', 'registry']
---

These routes manage agents (each one appears as a Boo in the dashboard). SQLite is the source of truth for which agents exist. Every agent belongs to one source, named by its `sourceId`: `openclaw` agents mirror agents in the OpenClaw Gateway, while `clawboo-native`, `claude-code`, `codex` and `hermes` agents live only in SQLite.

The agent list and single-agent reads serve SQLite, so they answer with the Gateway down (the list then reports `stale: true`). For an OpenClaw agent, creating it, a sync without a body, reading or writing its files, and listing its sessions need the Gateway, and answer `503 { "error": "gateway_disconnected" }` without it. Agents on the other runtimes need no Gateway.

<Note>

These routes return Clawboo's `AgentRecord` shape, not OpenClaw protocol shapes. See [Agent model](/concepts/agent-model) for the concept and [Agent sources](/internals/agent-source) for how the Gateway is synced in.

</Note>

A per-agent route goes to the source that owns the agent; an unknown id goes to the OpenClaw source, which answers its usual `404`. Every route here is on the general rate tier except `POST /api/agents/:agentId/shell`, which is on the sensitive tier (see [rate limits](/reference/rest-api/index#rate-limits)).

## Routes

| Method | Path                                      | Summary                                                       | Stream? |
| ------ | ----------------------------------------- | ------------------------------------------------------------- | ------- |
| GET    | `/api/agents`                             | List every agent from SQLite                                  | No      |
| POST   | `/api/agents`                             | Create an agent through its source                            | No      |
| POST   | `/api/agents/sync`                        | Sync OpenClaw agents into SQLite (server-side or from a list) | No      |
| GET    | `/api/agents/registry/health`             | The server's OpenClaw Gateway connection state                | No      |
| POST   | `/api/agents/cleanup-ghosts`              | Delete local OpenClaw rows the Gateway no longer has          | No      |
| GET    | `/api/agents/:agentId`                    | One agent record                                              | No      |
| DELETE | `/api/agents/:agentId`                    | Delete an agent and its local rows                            | No      |
| GET    | `/api/agents/:agentId/files/:name`        | Read one agent file                                           | No      |
| PUT    | `/api/agents/:agentId/files/:name`        | Write one agent file                                          | No      |
| GET    | `/api/agents/:agentId/sessions`           | List the agent's sessions                                     | No      |
| GET    | `/api/agents/:agentId/workspaces`         | The task worktrees of this agent's assigned tasks             | No      |
| GET    | `/api/agents/:agentId/screenshot`         | The newest browser screenshot for this agent                  | No      |
| POST   | `/api/agents/:agentId/screenshot/capture` | Take a fresh screenshot of a browser already open for it      | No      |
| PATCH  | `/api/agents/:agentId/model`              | Change a native or Hermes agent's model (and provider)        | No      |
| POST   | `/api/agents/:agentId/chat`               | Start one 1:1 chat turn with a native agent (`202`)           | No      |
| POST   | `/api/agents/:agentId/chat/stop`          | Stop the agent's running 1:1 turn                             | No      |
| GET    | `/api/agents/:agentId/chat/stream`        | Live tail of the agent's 1:1 chat                             | SSE     |
| GET    | `/api/agents/:agentId/shell`              | Whether a native agent may ask to run commands                | No      |
| POST   | `/api/agents/:agentId/shell`              | Turn that switch on or off (sensitive tier)                   | No      |

The `AgentRecord` shape (returned by `GET /api/agents`, `GET /api/agents/:agentId`, and inside the create `201`):

```ts
interface AgentRecord {
  // Identity
  id: string // Clawboo's id for the agent
  sourceId: 'openclaw' | 'clawboo-native' | 'claude-code' | 'codex' | 'hermes' // owning source
  sourceAgentId: string // the id inside the source (the OpenClaw agent id for OpenClaw)
  // Display (merged)
  displayName: string // Boo-Zero override ▸ identity.name ▸ name ▸ id
  emoji: string | null
  avatarUrl: string | null
  avatarSeed: string | null
  // Live state (for OpenClaw agents, synced from the Gateway; may be stale while it is down)
  status: 'idle' | 'running' | 'error' | 'sleeping' | 'archived'
  sessionKey: string | null
  isDefault: boolean // true for the source's default agent
  // Clawboo's own settings for the agent (kept across re-syncs)
  teamId: string | null
  personalityConfig: unknown | null
  execConfig: unknown | null
  model?: string | null // native agents: the configured model; absent where the model lives elsewhere
  providerReady?: boolean | null // native agents: a provider key (or keyless Ollama) can run it; absent otherwise
  // Classification
  participantKind: 'agent' | 'human'
  runtime: 'openclaw' | 'clawboo-native' | 'claude-code' | 'codex' | 'hermes'
  capabilities: unknown | null
  tenantId: string | null
  // Lifecycle
  archivedAt: number | null // epoch ms when the agent was archived; null = live
  createdAt: number // epoch ms
  updatedAt: number // epoch ms
}
```

`runtime` matches `sourceId` for every agent. `participantKind` and `tenantId` are reserved: agents Clawboo creates carry `'agent'` and `null`.

---

## `GET /api/agents`

Lists the agents of all five sources from SQLite, so the list answers even when the Gateway connection is down. `defaultId` is Boo Zero, resolved in this order: the override set with `POST /api/boo-zero/override`, then the native Boo Zero Clawboo creates, then the OpenClaw default agent. `mainKey`, `stale` and `lastSyncedAt` describe the OpenClaw connection; `stale` is `true` whenever the server's OpenClaw connection is not `connected`.

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
  pendingDeleteIds: string[] // Gateway ids of OpenClaw agents deleted while the Gateway was down
}
```

An agent in `pendingDeleteIds` is already gone from `agents`, but the Gateway still lists it until the server's next sync deletes it there. A client that reads the Gateway's own `agents.list()` leaves those ids out.

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

Creates an agent through a source. `sourceId` picks it: `openclaw` (the default), `clawboo-native`, `claude-code`, `codex` or `hermes`. An OpenClaw create makes the agent in the Gateway, writes its files there and mirrors it into SQLite, so it answers **503** while the Gateway connection is down. The other four write only to SQLite and work offline.

`name` and every entry in `files` are scanned for prompt injection before anything is written. Instruction-override phrasing and hidden Unicode characters block the create with **422** and an `install` audit row. Text aimed at machines rather than the model (a `DROP TABLE` inside a code reviewer's worked example) passes and comes back as `findings`.

- **Path/query params**: none.
- **Request body**:

```ts
{
  name: string                  // required; trimmed; must be non-empty
  teamId?: string | null
  personalityConfig?: unknown
  execConfig?: unknown          // for native agents: the agent's config (model, provider, tools, budgetUsd, ...)
  avatarSeed?: string | null
  files?: Record<string, string>  // agent files written at create (e.g. SOUL.md, AGENTS.md)
  sourceId?: 'openclaw' | 'clawboo-native' | 'claude-code' | 'codex' | 'hermes' // default 'openclaw'
}
```

Side effects of a successful create:

- The new agent gets its own grants to the browser connectors.
- Creating a `clawboo-native` agent in a team also creates the native Boo Zero, when none exists yet and a native provider is connected (best-effort).
- A `clawboo-native` agent whose `execConfig.budgetUsd` is above 0 gets an agent budget in `cap` mode (a hard cap; see [Governance](/reference/rest-api/governance)).
- An OpenClaw agent's `AGENTS.md` gets a short section on how to open web pages, added once.

### Responses

**`201 Created`**: the agent was created. `findings` is present only when the scan produced review-level findings:

```ts
{
  agent: AgentRecord,
  findings?: InjectionFinding[]
}
```

**`422 Unprocessable Entity`**: `name` or a file carries a blocking prompt-injection finding. Nothing is written:

```ts
{
  error: 'agent content blocked: prompt-injection finding',
  findings: InjectionFinding[]   // pattern, severity, intent, message, line, excerpt, fingerprint
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

**`503 Service Unavailable`**: an OpenClaw create while the Gateway connection is down:

```json
{ "error": "gateway_disconnected" }
```

**`500 Internal Server Error`**: any other failure:

```json
{ "error": "<message>" }
```

### Example

```bash
# OpenClaw agent (the default source): needs a live Gateway
curl -X POST http://localhost:18790/api/agents \
  -H 'Content-Type: application/json' \
  -d '{"name":"Research Boo","teamId":"<team-uuid>"}'

# Native agent: SQLite only, works offline
curl -X POST http://localhost:18790/api/agents \
  -H 'Content-Type: application/json' \
  -d '{"name":"Native Boo","sourceId":"clawboo-native"}'
```

---

## `POST /api/agents/sync`

Brings the OpenClaw agent list into SQLite. With a body that carries an `agents` array, it stores that list (the browser's own `agents.list` result, sent while the server has no Gateway connection of its own). With no body, the server reads the list from the Gateway itself, which needs the connection and answers **503** while it is down.

- **Path/query params**: none.
- **Request body** (optional; a body with an `agents` array stores that list):

```ts
{
  defaultId?: string
  mainKey?: string   // trimmed; defaults to 'main'
  scope?: string
  agents?: Array<{ id: string; name?: string; identity?: Record<string, unknown> }>
}
```

Without an `agents` array the body is ignored and the server syncs from the Gateway. Storing a list touches only the fields that come from the Gateway; Clawboo's own fields (`teamId`, `personalityConfig`, `execConfig`, `avatarSeed` and so on) are kept.

### Responses

**`200 OK`**: a list was stored (body with an `agents` array):

```ts
{ result: { upserted: number, archived: number, durationMs: 0, at: number } }
```

**`200 OK`**: server-side sync (no body):

```ts
{ result: { upserted: number, archived: number, durationMs: number, at: number } }
```

`archived` counts agents present in SQLite but gone upstream (their `archivedAt` is set; the tombstone is reversible and cleared if the agent reappears).

**`503 Service Unavailable`**: a sync without a list while the Gateway connection is down:

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

Reports the state of the server's own OpenClaw Gateway connection. It answers **200** whether or not the Gateway is connected.

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

A one-shot cleanup the dashboard runs after it loads the Gateway's agent list. Send the ids of every agent the Gateway has; the route deletes each local OpenClaw agent row that is not in the list, with its cost and approval-history rows and its per-agent settings. Running it again changes nothing. Only rows with `sourceId = 'openclaw'` are compared, so agents on other runtimes are never removed.

- **Path params**: none.
- **Query params**:

| Param        | Type     | Effect                                                                                   |
| ------------ | -------- | ---------------------------------------------------------------------------------------- |
| `allowEmpty` | `'true'` | Permit an empty `liveAgentIds` (a guard against wiping every row after a Gateway hiccup) |

- **Request body**:

```ts
{ liveAgentIds: string[] }   // required; the IDs alive in the Gateway
```

### Responses

**`400 Bad Request`**: `liveAgentIds` is missing or not an array:

```json
{ "error": "liveAgentIds array required" }
```

**`400 Bad Request`**: `liveAgentIds` is empty and `?allowEmpty=true` was not passed (the message contains an em dash, written here as its JSON escape):

```json
{ "error": "empty liveAgentIds list \u2014 pass ?allowEmpty=true to confirm" }
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

Deletes the agent. The owning source deletes it upstream first (for OpenClaw, the Gateway's `agents.delete`), then removes the local agent row along with the `cost_records` and `approval_history` rows that reference it. If the Gateway connection is down, the local rows are removed anyway.

<Note>

An OpenClaw agent deleted while the Gateway is down is recorded as a pending delete. On the next sync the server sends the Gateway's `agents.delete` before it reads the list, and until that lands no sync re-creates the agent's row. If the Gateway refuses the delete outright (it will not delete its only agent, or one that owns shared credentials), the pending delete is dropped and the agent comes back on that same sync. A connection failure is retried on the next sync.

</Note>

- **Path params**: `agentId`.
- **Request body**: none.

### Responses

**`200 OK`**: deleted upstream and locally. Agents on runtimes other than OpenClaw have nothing upstream, and also answer `upstreamDeleted: true`:

```json
{ "ok": true, "upstreamDeleted": true }
```

**`200 OK`**: the Gateway was disconnected, so the local rows were cleaned and, for an OpenClaw agent, the Gateway delete was recorded for the next sync (`upstreamDeletePending: true`). It is `false` when there was no OpenClaw row to delete:

```json
{ "ok": true, "upstreamDeleted": false, "upstreamDeletePending": true }
```

**`400 Bad Request`**: missing `agentId` segment:

```json
{ "error": "agentId required" }
```

**`500 Internal Server Error`**: any failure other than a lost Gateway connection:

```json
{ "error": "<message>" }
```

### Example

```bash
curl -X DELETE http://localhost:18790/api/agents/<agent-id>
```

---

## `GET /api/agents/:agentId/files/:name`

Reads one agent file through the owning source. An OpenClaw agent's files are read live from the Gateway (**503** while it is down); the other runtimes keep their files in SQLite. The `:name` segment must be one of the seven agent file names; any other name is rejected before the read.

- **Path params**: `agentId`, `name`.

`:name` is one of `AGENTS.md`, `SOUL.md`, `IDENTITY.md`, `USER.md`, `TOOLS.md`, `HEARTBEAT.md`, `MEMORY.md`. The route stores any of them on any agent, but which files actually shape an agent depends on its runtime: see [Agents](/using/agents). OpenClaw 2026.9 and later does not load `TOOLS.md`, so put tool guidance in `AGENTS.md`.

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

**`503 Service Unavailable`**: an OpenClaw agent, and the Gateway connection is down:

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

`content` is scanned for prompt injection before the write, exactly as `POST /api/agents` scans its `files`. A blocking finding refuses the write with **422** and an `install` audit row; review-level findings come back on the `200`.

- **Path params**: `agentId`, `name` (same allowlist as the GET).
- **Request body**:

```ts
{
  content: string
} // required; must be a string
```

### Responses

**`200 OK`**: the file was written (echoes what was stored). `findings` is present only when the scan produced review-level findings:

```ts
{ name: string, content: string, findings?: InjectionFinding[] }
```

**`422 Unprocessable Entity`**: `content` carries a blocking prompt-injection finding. Nothing is written:

```ts
{
  error: 'agent content blocked: prompt-injection finding',
  findings: InjectionFinding[]
}
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

**`503 Service Unavailable`**: an OpenClaw agent, and the Gateway connection is down:

```json
{ "error": "gateway_disconnected" }
```

**`500 Internal Server Error`**: any other failure:

```json
{ "error": "<message>" }
```

### Example

```bash
curl -X PUT http://localhost:18790/api/agents/<agent-id>/files/AGENTS.md \
  -H 'Content-Type: application/json' \
  -d '{"content":"# How you work\n\n- Reply in short bullet points.\n"}'
```

---

## `GET /api/agents/:agentId/sessions`

Lists the agent's sessions. For an OpenClaw agent the list is read live from the Gateway, so the route answers **503** while the connection is down. The other runtimes list the sessions stored in SQLite.

- **Path params**: `agentId`.
- **Request body**: none.

### Responses

**`200 OK`**: the session list:

```ts
{
  sessions: Array<{
    id: string
    sourceId: 'openclaw' | 'clawboo-native' | 'claude-code' | 'codex' | 'hermes'
    sourceSessionId: string // the session key inside the source
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

**`503 Service Unavailable`**: an OpenClaw agent, and the Gateway connection is down:

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

## `GET /api/agents/:agentId/workspaces`

The task worktrees of this agent's assigned tasks, newest first. The agent's **Workspace** tab uses it to pick which worktree to show, and to say so when the agent has none.

Archived workspaces are left out. `onDisk: false` marks a checkout that was paused or cleaned up: the row and the branch remain, but the files are gone, and the tab says so rather than showing an empty tree. The files themselves come from the `/api/board/:taskId/workspace/*` routes on the [Board API](/reference/rest-api/board).

- **Path params**: `agentId`.
- **Request body**: none.

### Responses

**`200 OK`**:

```json
{
  "ok": true,
  "workspaces": [
    {
      "taskId": "t_8f2c",
      "title": "Fix the flaky board round-trip test",
      "taskStatus": "in_progress",
      "branch": "clawboo/task-t_8f2c",
      "repoPath": "/Users/you/code/clawboo",
      "worktreePath": "/Users/you/.clawboo/worktrees/ab12cd34ef56/t_8f2c",
      "workspaceStatus": "active",
      "onDisk": true,
      "updatedAt": 1756000000000
    }
  ]
}
```

An agent with no worktree-backed tasks returns `{ "ok": true, "workspaces": [] }`.

**`500 Internal Server Error`**:

```json
{ "error": "<message>" }
```

### Example

```bash
curl http://localhost:18790/api/agents/<agent-id>/workspaces
```

---

## `GET /api/agents/:agentId/screenshot`

The newest browser screenshot for this agent, shown on its **Browser** card. A frame is kept whenever one of the agent's browser tools returns an image, and when `POST /api/agents/:agentId/screenshot/capture` takes one. The route serves only this agent's own frame, never another agent's.

Frames are held in memory, one per agent: a new frame replaces the old one, and past 24 MB in total the oldest frames are dropped. They are also saved under `<clawboo home>/frames/`, so a restart brings them back, marked `restored: true`. A restored frame can be hours old.

- **Path params**: `agentId`.
- **Query params**: `meta` (any value) returns the frame's details as JSON instead of the image.
- **Request body**: none.

### Responses

**`200 OK`** with `?meta`: the frame's details. `restored` is present only for a frame reloaded from disk:

```json
{
  "ok": true,
  "mimeType": "image/png",
  "toolName": "mcp__playwright__browser_take_screenshot",
  "ts": 1756000000000,
  "restored": true
}
```

**`200 OK`** without `?meta`: the image bytes. `Content-Type` is `image/png`, `image/jpeg`, `image/gif` or `image/webp` (a frame that states any other type is served as `image/png`), with `Content-Length`, `Cache-Control: no-store` and `X-Content-Type-Options: nosniff`.

**`404 Not Found`**: this agent has no frame:

```json
{ "ok": false, "error": "no screenshot for this agent" }
```

**`500 Internal Server Error`**: the stored frame could not be decoded:

```json
{ "ok": false, "error": "frame is not decodable" }
```

### Example

```bash
curl 'http://localhost:18790/api/agents/<agent-id>/screenshot?meta=1'
curl -o frame.png http://localhost:18790/api/agents/<agent-id>/screenshot
```

---

## `POST /api/agents/:agentId/screenshot/capture`

Takes a fresh screenshot of a browser that is already open for this agent, so the **Browser** card can refresh without waiting for the agent's next browser action. It never opens a browser and never navigates: with no browser open it fails, and the card stays as it was.

The route tries each browser connector Clawboo runs (Playwright's `browser_take_screenshot`, Chrome DevTools' `take_screenshot`), and only where this agent's own grant allows that tool and the agent's browser is running. If none of those has a browser open and the agent runs on OpenClaw, it captures the newest browser tab OpenClaw tracks for that agent's session (stored with `toolName: "openclaw__browser"`). Read the new frame with `GET /api/agents/:agentId/screenshot`.

- **Path params**: `agentId`.
- **Request body**: none.

### Responses

**`200 OK`**: a new frame was stored:

```json
{ "ok": true, "ts": 1756000000000 }
```

**`409 Conflict`**: no browser is open for this agent:

```json
{ "ok": false, "error": "this Boo has no browser open right now" }
```

**`400 Bad Request`**: missing `agentId` segment:

```json
{ "ok": false, "error": "agentId is required" }
```

### Example

```bash
curl -X POST http://localhost:18790/api/agents/<agent-id>/screenshot/capture
```

---

## `PATCH /api/agents/:agentId/model`

Changes the model of a `clawboo-native` or `hermes` agent, and optionally its provider. It needs no Gateway.

- **Native agent:** the stored agent config is rewritten, and the next run uses it. With a `provider`, the provider, model and the key variable it reads (`envVar`) change together, so a model picked from another provider's list never runs against the old provider. Without a `provider`, only the model changes, which is also how you set a custom model id for the current provider. The server checks the provider name but not the model string, so custom ids work.
- **Hermes agent:** Hermes reaches every model through OpenRouter, so the model is stored as `{ provider: 'openrouter', model }` and any other `provider` is a `400`.
- **Other runtimes** answer `404`. An OpenClaw agent's model is set through `PATCH /api/system/openclaw-config` (see [System API](/reference/rest-api/system)).

- **Path params**: `agentId`.
- **Request body**: `{ model: string, provider?: string }`. `provider` must be one of `anthropic`, `openai`, `openrouter`, `ollama`, `google`, `xai`, `groq`, `mistral`, `together`, `cerebras`, `moonshot`. With `ollama`, which needs no key, the stored `envVar` is `OLLAMA_BASE_URL`.

### Responses

**`200 OK`**: the model (and the provider, when sent) was saved. `provider` is echoed only when the request carried one:

```json
{ "ok": true, "model": "anthropic/claude-haiku-4.5", "provider": "openrouter" }
```

**`400 Bad Request`**: one of these messages:

| `error`                                                                              | Cause                                |
| ------------------------------------------------------------------------------------ | ------------------------------------ |
| `model (non-empty string) required`                                                  | `model` is missing or blank          |
| `unknown provider '<provider>'`                                                      | `provider` is not in the list above  |
| `hermes routes every model via OpenRouter; provider must be 'openrouter' or omitted` | A Hermes agent with another provider |
| `agentId required`                                                                   | Missing `agentId` segment            |

**`404 Not Found`**: one of these messages:

| `error`                                             | Cause                                |
| --------------------------------------------------- | ------------------------------------ |
| `agent not found`                                   | No agent with that id                |
| `native agent config not found`                     | A native agent with no stored config |
| `model change via this route is native/hermes-only` | An agent on any other runtime        |

**`500 Internal Server Error`**: any other failure:

```json
{ "error": "<message>" }
```

### Example

```bash
curl -X PATCH http://localhost:18790/api/agents/<agent-id>/model \
  -H 'Content-Type: application/json' \
  -d '{ "model": "anthropic/claude-haiku-4.5", "provider": "openrouter" }'
```

---

## `POST /api/agents/:agentId/chat`

Starts one turn of a `clawboo-native` agent's 1:1 chat (Boo Zero's personal chat, or any native agent's). The route stores your message under the session key `agent:<agentId>:native`, starts the reply in the background and answers **202** at once. The reply streams over `GET /api/agents/:agentId/chat/stream` and is saved by the server, so closing the connection does not stop it. Agents on other runtimes answer **404**; an OpenClaw agent's 1:1 chat goes through the Gateway connection instead.

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

Stops the agent's running 1:1 turn (the composer's **Stop** button). A native agent has at most one running 1:1 turn; with none running the call changes nothing and still answers **200**.

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

A Server-Sent Events tail of the agent's 1:1 chat (`agent:<agentId>:native`). It only reads; it never starts a turn. It sends two kinds of frame: stored `chat_messages` rows, polled every 750 ms past a row-id cursor (each with an `id:` line, so they replay on resume), and live frames for streaming text and run state (no `id:` line, never replayed).

**Where it starts.** With no `Last-Event-ID` header and no `since`, the stream starts at the newest stored message and sends only what follows. Load the history first with `GET /api/chat-history` (see [Chat history API](/reference/rest-api/chat-history)). A supplied cursor resumes after that row id; `Last-Event-ID` wins over `since`, and an invalid or negative value resumes from `0` (the whole chat).

- **Path params**: `agentId`.
- **Query params**:

| Param   | Type   | Notes                                                                     |
| ------- | ------ | ------------------------------------------------------------------------- |
| `since` | number | Resume after this `chat_messages` row id. `Last-Event-ID` takes priority. |

- **Request body**: none.

<Note>

This is an SSE route: there is no JSON response body, and the catalog below describes the frames. A missing `agentId` ends the response with a bare **400** and no body. Each poll reads up to 500 rows past the cursor.

</Note>

### Connection

On open, the handler writes `HTTP/1.1 200` with:

```http
Content-Type: text/event-stream; charset=utf-8
Cache-Control: no-cache, no-transform
Connection: keep-alive
X-Accel-Buffering: no
```

then sends a `: connected` comment, any stored rows already past the cursor, and the last `status` published for the chat, so a client that reconnects learns about a turn that ended while no stream was open.

### Event catalog

| Frame           | When                                    | Shape                                                             |
| --------------- | --------------------------------------- | ----------------------------------------------------------------- |
| `: connected`   | Immediately on open                     | SSE comment (ignored by `EventSource`)                            |
| entry data      | Per new stored row (every 750 ms)       | `id: <row id>` line + `data: <json>` line (the stored chat entry) |
| `event: delta`  | Per streamed piece of the reply         | `{ sessionKey, runId, text }`; `text` is the whole reply so far   |
| `event: status` | When a turn starts or ends, and on open | `{ agentId, status: 'running' \| 'idle' \| 'error' }`             |
| `: keepalive`   | Every 20 s while open                   | SSE comment (keeps the connection warm)                           |

`delta` and `status` frames carry no `id:` line, so they never move the resume cursor. The stored rows are the record; the deltas only let a reply appear as it is written.

### Example

```bash
curl -N http://localhost:18790/api/agents/<agent-id>/chat/stream
curl -N 'http://localhost:18790/api/agents/<agent-id>/chat/stream?since=4187'
```

---

## `GET /api/agents/:agentId/shell`

Reports whether a `clawboo-native` agent may ask to run commands. The value is the `tools.shell` field of the agent's stored config, and it decides whether the `run_command` tool is offered to the model at all. It does not let a command run on its own: `run_command` puts every command in front of a person, remembers nothing and has no allowlist, so a command allowed once asks again the next time.

A missing field reads as off, and the native defaults leave it out, so a new native agent starts with the shell off.

This switch is separate from `/api/exec-settings` (see [Agent settings API](/reference/rest-api/agent-settings)), which writes the OpenClaw Gateway's exec policy. Nothing reads that policy for a native agent, so this route refuses every other runtime by name.

- **Path params**: `agentId`.
- **Request body**: none.

### Responses

**`200 OK`**:

```json
{ "ok": true, "enabled": false }
```

**`400 Bad Request`**: the agent is not on the `clawboo-native` runtime. The response names the runtime it found:

```json
{ "error": "only a clawboo-native Boo has this switch", "runtime": "openclaw" }
```

**`404 Not Found`**: no agent with that id, or a native agent with no stored config:

```json
{ "error": "agent not found" }
```

```json
{ "error": "native agent config not found" }
```

**`500 Internal Server Error`**: any other failure, redacted:

```json
{ "error": "<message>" }
```

### Example

```bash
curl http://localhost:18790/api/agents/<agent-id>/shell
```

---

## `POST /api/agents/:agentId/shell`

Turns the switch on or off.

**Rate tier: sensitive.** Changing what an agent may ask to run is a permissions change, so this route shares the 60-requests-a-minute sensitive budget (see [rate limits](/reference/rest-api/index#rate-limits)).

The route writes the whole `tools` record back with only `shell` changed, so the agent's other tool flags (memory, tasks, teamchat and the reserved custom list) are kept. It then reads the config back and answers with what is stored, not with what you sent.

- **Path params**: `agentId`.
- **Request body**:

```ts
{
  enabled: boolean // required; anything other than a boolean is a 400
}
```

<Note>

The confirmation the dashboard shows before switching this on exists only in the browser. This route accepts `{ "enabled": true }` directly, and `POST /api/agents` with `sourceId: 'clawboo-native'` can set `execConfig.tools.shell` at creation. Native agents created from the dashboard start with the shell off.

</Note>

Switching this on is necessary for `run_command` to exist, but not enough. The tool is also left out of any run without a working directory, which in practice means every run except a task run in a git worktree: 1:1 chat, team chat and delegated turns carry none. It is never offered on Windows.

### Responses

**`200 OK`**: the stored value after the write:

```json
{ "ok": true, "enabled": true }
```

**`400 Bad Request`**: `enabled` is missing or is not a boolean:

```json
{ "error": "enabled must be true or false" }
```

**`400 Bad Request`**: the agent is not on the `clawboo-native` runtime:

```json
{ "error": "only a clawboo-native Boo has this switch", "runtime": "openclaw" }
```

**`404 Not Found`**: no agent with that id, or a native agent with no stored config:

```json
{ "error": "agent not found" }
```

**`429 Too Many Requests`**: the sensitive ceiling:

```json
{ "error": "Too many requests for this operation. Wait a moment and retry." }
```

**`500 Internal Server Error`**: any other failure, redacted:

```json
{ "error": "<message>" }
```

### Example

```bash
curl -X POST http://localhost:18790/api/agents/<agent-id>/shell \
  -H 'Content-Type: application/json' \
  -d '{"enabled":true}'
```

---

## Error envelope

Most error bodies are `{ "error": "<message>" }`. The exceptions:

- The two `422` responses (create, and the file `PUT`) add `findings`, the injection findings that blocked the write: each has `pattern`, `severity`, `intent`, `message`, `line`, `excerpt` and `fingerprint`.
- The two screenshot routes answer `{ "ok": false, "error": "..." }`.
- The two shell routes add `runtime` to their wrong-runtime `400`, naming the runtime they found.
- `GET /api/agents/:agentId/chat/stream` has no JSON error: its only failure before the stream opens is a bare `400` with no body.

A `503 { "error": "gateway_disconnected" }` means the route needed the OpenClaw Gateway for an OpenClaw agent and the server's connection is down. The list and single-agent reads never answer it: they serve SQLite.

## Related

- [Agent model](/concepts/agent-model): what an agent is, Boo Zero, and how agents relate to teams.
- [Agents](/using/agents): the agent files each runtime reads, and the dashboard screens behind these routes.
- [Agent settings API](/reference/rest-api/agent-settings): personality, OpenClaw exec settings and skills.
- [Teams API](/reference/rest-api/teams): add an agent to a team, and team chat.
- [Runtimes API](/reference/rest-api/runtimes): run a board task on a runtime.
- [Agent sources](/internals/agent-source): how OpenClaw agents are synced into SQLite.
