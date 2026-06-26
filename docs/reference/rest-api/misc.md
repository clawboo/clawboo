---
title: Misc resources API
description: REST reference for cost records, chat history, graph layout, personality, skills, exec settings, fleet summary, and Boo Zero context.
---

REST surface for the remaining SQLite-backed resources that do not warrant their own group: per-run cost records and the cost summary, persisted chat transcripts, Ghost Graph node positions, per-agent personality and execution settings, skill installs (with a supply-chain injection scan), the read-only fleet-health summary, and Boo Zero's per-team / global briefs and display-name override.

Every handler in this group opens the SQLite database at `<CLAWBOO_HOME>/clawboo.db` (default `~/.clawboo/clawboo.db`); these routes serve and mutate local state and do not require the Gateway to be up. All POST/PUT bodies are parsed by `express.json({ limit: '2mb' })`.

<Note>
The order in `api/index.ts` matters: `/api/cost-records/summary` and `/api/exec-settings/all` are registered before their shorter prefixes so the two-segment paths are not swallowed.
</Note>

## Routes

| Method | Path                                  | Summary                                              | Stream? |
| ------ | ------------------------------------- | ---------------------------------------------------- | ------- |
| GET    | `/api/cost-records`                   | List cost records (period + agent filter)            | No      |
| POST   | `/api/cost-records`                   | Record one run's token usage; computes USD           | No      |
| GET    | `/api/cost-records/summary`           | 30-day aggregation: totals, per-agent, time series   | No      |
| GET    | `/api/chat-history`                   | Load a session's transcript entries                  | No      |
| POST   | `/api/chat-history`                   | Batch-insert transcript entries (idempotent)         | No      |
| DELETE | `/api/chat-history`                   | Clear a session's transcript                         | No      |
| GET    | `/api/graph-layout`                   | Load saved Ghost Graph node positions                | No      |
| POST   | `/api/graph-layout`                   | Upsert Ghost Graph node positions                    | No      |
| GET    | `/api/personality`                    | Load an agent's personality slider values            | No      |
| POST   | `/api/personality`                    | Upsert an agent's personality config                 | No      |
| GET    | `/api/skills`                         | List installed skills (optional agent filter)        | No      |
| POST   | `/api/skills`                         | Install a skill (injection scan → 422 on finding)    | No      |
| DELETE | `/api/skills`                         | Remove an agent from a skill (drops the row if last) | No      |
| GET    | `/api/exec-settings`                  | Load an agent's execution settings                   | No      |
| GET    | `/api/exec-settings/all`              | Map of all agents' `execAsk` settings                | No      |
| POST   | `/api/exec-settings`                  | Upsert an agent's execution settings                 | No      |
| GET    | `/api/fleet/summary`                  | Read-only fleet-health aggregation                   | No      |
| GET    | `/api/boo-zero/team-briefs/:teamId`   | Load a team's Boo Zero brief                         | No      |
| PUT    | `/api/boo-zero/team-briefs/:teamId`   | Upsert a team's Boo Zero brief                       | No      |
| DELETE | `/api/boo-zero/team-briefs/:teamId`   | Remove a team's Boo Zero brief                       | No      |
| GET    | `/api/boo-zero/global-brief`          | Load the global Boo Zero brief                       | No      |
| PUT    | `/api/boo-zero/global-brief`          | Upsert the global Boo Zero brief                     | No      |
| GET    | `/api/boo-zero/display-name/:agentId` | Load Boo Zero's display-name override                | No      |
| PUT    | `/api/boo-zero/display-name/:agentId` | Set Boo Zero's display-name override                 | No      |

---

## Cost records: `/api/cost-records`

Token-usage records, one row per accounted run. The POST handler computes USD from a built-in per-model pricing table (`calculateCostUsd`), and the summary route aggregates the last 30 days for the cost dashboard.

### `GET /api/cost-records`

Lists cost records, newest first, capped at 500.

- **Query params**:

| Param     | Type                           | Default    | Notes                                                                                                      |
| --------- | ------------------------------ | ---------- | ---------------------------------------------------------------------------------------------------------- |
| `period`  | `'today' \| 'week' \| 'month'` | none (all) | `today` = midnight today; `week` = now − 7 days; `month` = now − 30 days; any other value = no time filter |
| `agentId` | string                         | none       | Filter to one agent                                                                                        |

- **Request body**: none.

#### Responses

**`200 OK`**: the matching records (a `costRecords` row array):

```ts
{
  records: Array<{
    id: number
    agentId: string
    model: string
    inputTokens: number
    outputTokens: number
    costUsd: number
    runId: string | null
    createdAt: number // epoch ms
  }>
}
```

**`500 Internal Server Error`**: a DB failure:

```json
{ "error": "<message>" }
```

#### Example

```bash
curl "http://localhost:18790/api/cost-records?period=week&agentId=<agent-id>"
```

### `POST /api/cost-records`

Records one run's token usage. The handler computes `costUsd` from the model name and token counts, then upserts a placeholder `agents` row (the `cost_records.agentId` foreign key requires the agent to exist) before inserting the record.

- **Request body**:

```ts
{
  agentId: string        // required
  model: string          // required (drives the pricing lookup)
  inputTokens: number    // required (0 is allowed; only null/undefined fails)
  outputTokens: number   // required
  runId?: string | null  // optional run correlation id
}
```

<Note>
Pricing is a built-in table keyed by Claude model ids (opus / sonnet / haiku tiers), with a substring fallback and a `default` of $3/$15 per million input/output tokens. An unrecognized model is priced at the default rate.
</Note>

#### Responses

**`400 Bad Request`**: body is not an object:

```json
{ "error": "invalid JSON" }
```

**`400 Bad Request`**: a required field is missing (`inputTokens` / `outputTokens` are checked for `null`/`undefined`, so `0` passes):

```json
{ "error": "agentId, model, inputTokens, outputTokens required" }
```

**`200 OK`**: the record was inserted:

```ts
{ ok: true, record: { id: number, agentId: string, model: string, inputTokens: number, outputTokens: number, costUsd: number, runId: string | null, createdAt: number } }
```

**`500 Internal Server Error`**: a DB failure:

```json
{ "error": "<message>" }
```

#### Example

```bash
curl -X POST http://localhost:18790/api/cost-records \
  -H 'Content-Type: application/json' \
  -d '{"agentId":"<agent-id>","model":"claude-sonnet-4-6","inputTokens":1200,"outputTokens":340}'
```

### `GET /api/cost-records/summary`

Aggregates the last 30 days of cost records into dashboard totals, a per-agent breakdown (agent name joined from `agents`), and a 30-day time series with zero-filled empty days. Takes no parameters.

- **Path/query params**: none.
- **Request body**: none.

#### Responses

**`200 OK`**: the aggregation:

```ts
{
  totalToday: number // USD
  totalWeek: number
  totalMonth: number
  tokensToday: number
  tokensWeek: number
  tokensMonth: number
  byAgent: Array<{
    agentId: string
    agentName: string // joined from agents.name, falls back to agentId
    totalCost: number
    totalTokens: number
    inputTokens: number
    outputTokens: number
    messageCount: number
  }> // sorted by totalTokens desc
  timeSeries: Array<{
    date: string // 'Mon D' label, en-US locale
    cost: number
    tokens: number
  }> // exactly 30 entries, oldest first, zero-filled
}
```

**`500 Internal Server Error`**: a DB failure:

```json
{ "error": "<message>" }
```

#### Example

```bash
curl http://localhost:18790/api/cost-records/summary
```

---

## Chat history: `/api/chat-history`

Persists per-session chat transcripts in the `chat_messages` table. Each row stores a JSON-serialized `TranscriptEntry`; reads parse the JSON back, skipping any corrupt row.

### `GET /api/chat-history`

Loads a session's transcript entries, oldest first.

- **Query params**:

| Param        | Type   | Default | Notes                                                           |
| ------------ | ------ | ------- | --------------------------------------------------------------- |
| `sessionKey` | string | n/a     | **Required**; the session to load                               |
| `limit`      | number | 200     | Clamped to a max of 1000; a non-numeric value falls back to 200 |

- **Request body**: none.

#### Responses

**`400 Bad Request`**: missing `sessionKey`:

```json
{ "error": "sessionKey required" }
```

**`200 OK`**: the parsed transcript entries (rows that fail JSON parse are dropped):

```ts
{ entries: TranscriptEntry[] }
```

**`500 Internal Server Error`**: a DB failure:

```json
{ "error": "<message>" }
```

#### Example

```bash
curl "http://localhost:18790/api/chat-history?sessionKey=<session-key>&limit=500"
```

### `POST /api/chat-history`

Batch-inserts transcript entries for a session. Inserts are idempotent; each row carries the entry's `entryId` and conflicts on the unique `entry_id` index do nothing. Entries without an `entryId` are skipped.

- **Request body**:

```ts
{
  sessionKey: string          // required
  gatewayUrl: string          // stored on each row (defaults to '' if absent)
  entries: TranscriptEntry[]  // required, non-empty
}
```

#### Responses

**`400 Bad Request`**: body is not an object:

```json
{ "error": "invalid JSON" }
```

**`400 Bad Request`**: `sessionKey` missing or `entries` not a non-empty array:

```json
{ "error": "sessionKey and entries[] required" }
```

**`200 OK`**: inserted (idempotent on `entryId`; `saved` counts the entries received, not the rows actually written):

```ts
{ ok: true, saved: number }
```

**`500 Internal Server Error`**: a DB failure:

```json
{ "error": "<message>" }
```

#### Example

```bash
curl -X POST http://localhost:18790/api/chat-history \
  -H 'Content-Type: application/json' \
  -d '{"sessionKey":"<session-key>","gatewayUrl":"ws://localhost:18789","entries":[{"entryId":"e1","timestampMs":1700000000000}]}'
```

### `DELETE /api/chat-history`

Clears every message for a session. Used when an agent is deleted.

- **Query params**: `sessionKey` (required).
- **Request body**: none.

#### Responses

**`400 Bad Request`**: missing `sessionKey`:

```json
{ "error": "sessionKey required" }
```

**`200 OK`**: cleared:

```json
{ "ok": true }
```

**`500 Internal Server Error`**: a DB failure:

```json
{ "error": "<message>" }
```

#### Example

```bash
curl -X DELETE "http://localhost:18790/api/chat-history?sessionKey=<session-key>"
```

---

## Graph layout: `/api/graph-layout`

Persists Ghost Graph node positions in the `graph_layouts` table, keyed by the `(name, gatewayUrl)` unique index. `name` distinguishes scopes (e.g. `atlas-radial`, `team-<id>`, `default`).

### `GET /api/graph-layout`

Loads saved positions for a layout. Note the query param is `url`, not `gatewayUrl`.

- **Query params**:

| Param  | Type   | Default     | Notes                                      |
| ------ | ------ | ----------- | ------------------------------------------ |
| `name` | string | `'default'` | The layout scope key                       |
| `url`  | string | `''`        | The Gateway URL the layout was saved under |

- **Request body**: none.

#### Responses

**`200 OK`**: the saved layout, or an empty positions map when nothing is stored:

```ts
{
  positions: Record<string, { x: number; y: number }>
}
```

<Note>
This route never returns an error status. A miss returns `{ positions: {} }`, and a thrown DB error is also caught and returned as `{ positions: {} }` (HTTP 200).
</Note>

#### Example

```bash
curl "http://localhost:18790/api/graph-layout?name=team-<team-id>&url=ws://localhost:18789"
```

### `POST /api/graph-layout`

Upserts positions for a layout (conflict on `(name, gatewayUrl)` updates `layoutData` + `updatedAt`).

- **Request body**:

```ts
{
  name?: string                                          // default 'default'
  positions: Record<string, { x: number; y: number }>   // serialized to layoutData
  gatewayUrl: string                                     // required
}
```

#### Responses

**`400 Bad Request`**: body is not an object:

```json
{ "ok": false, "error": "invalid JSON" }
```

**`400 Bad Request`**: missing `gatewayUrl`:

```json
{ "ok": false, "error": "gatewayUrl required" }
```

**`200 OK`**: upserted:

```json
{ "ok": true }
```

**`500 Internal Server Error`**: a DB failure:

```json
{ "ok": false, "error": "<message>" }
```

#### Example

```bash
curl -X POST http://localhost:18790/api/graph-layout \
  -H 'Content-Type: application/json' \
  -d '{"name":"team-<team-id>","gatewayUrl":"ws://localhost:18789","positions":{"boo-a1":{"x":120,"y":40}}}'
```

---

## Personality: `/api/personality`

Stores per-agent personality slider values in the `agents.personality_config` column as a JSON wrapper `{ values, customText }`. SQLite is the source of truth for slider values; the merged SOUL.md is written separately by the client.

### `GET /api/personality`

Loads an agent's stored personality values and optional custom text.

- **Query params**: `agentId` (required).
- **Request body**: none.

#### Responses

**`400 Bad Request`**: missing `agentId`:

```json
{ "error": "agentId required" }
```

**`200 OK`**: the stored values, or `null`s when nothing is stored or the blob is corrupt:

```ts
{ values: Record<string, number> | null, customText: string | null }
```

**`500 Internal Server Error`**: a DB failure:

```json
{ "error": "<message>" }
```

#### Example

```bash
curl "http://localhost:18790/api/personality?agentId=<agent-id>"
```

### `POST /api/personality`

Upserts an agent's personality config. The handler ensures a placeholder `agents` row exists, then sets `personality_config` to `JSON.stringify({ values, customText })`. A blank/whitespace `customText` is stored as `null`.

- **Request body**:

```ts
{
  agentId: string                  // required
  values: Record<string, number>  // required (e.g. { verbosity: 50, humor: 50, ... })
  customText?: string | null      // optional; trimmed; blank → null
}
```

#### Responses

**`400 Bad Request`**: body is not an object:

```json
{ "error": "invalid JSON" }
```

**`400 Bad Request`**: `agentId` or `values` missing:

```json
{ "error": "agentId and values required" }
```

**`200 OK`**: upserted:

```json
{ "ok": true }
```

**`500 Internal Server Error`**: a DB failure:

```json
{ "error": "<message>" }
```

#### Example

```bash
curl -X POST http://localhost:18790/api/personality \
  -H 'Content-Type: application/json' \
  -d '{"agentId":"<agent-id>","values":{"verbosity":60,"humor":40},"customText":"Concise, dry."}'
```

---

## Skills: `/api/skills`

Tracks skill installs in the `skills` table. The per-agent association lives in the row's `metadata.agentIds` array, so a single skill row can be shared across agents. **POST runs a supply-chain injection scan and blocks a flagged install with a 422.**

### `GET /api/skills`

Lists installed skills, newest first. With `agentId`, filters to rows whose `metadata.agentIds` includes that agent.

- **Query params**: `agentId` (optional).
- **Request body**: none.

#### Responses

**`200 OK`**: the skill rows:

```ts
{
  ok: true
  skills: Array<{
    id: string
    name: string
    source: string // 'clawhub' | 'skill.sh' | 'verified' | 'local'
    category: string | null
    trustScore: number | null
    installedAt: number | null
    metadata: string | null // JSON; { agentIds: string[], version?, author? }
  }>
}
```

**`500 Internal Server Error`**: a DB failure (note: `skills: []` is still present):

```json
{ "ok": false, "error": "<message>", "skills": [] }
```

#### Example

```bash
curl "http://localhost:18790/api/skills?agentId=<agent-id>"
```

### `POST /api/skills`

Installs a skill for an agent. Before recording anything, the handler runs `scanForInjection` over the install blob (name + source + category + author + the raw body). A finding blocks the install with **422** and writes a blocked-install audit row; a clean install is also audited (the forensic trail). On a clean scan, an existing skill row merges the `agentId` into `metadata.agentIds`; otherwise a new row is inserted.

- **Request body**:

```ts
{
  id: string               // required
  name: string             // required
  source: string           // required
  agentId: string          // required
  category?: string | null
  trustScore?: number | null
  version?: string | null
  author?: string | null
}
```

#### Responses

**`400 Bad Request`**: body is not an object:

```json
{ "ok": false, "error": "Invalid JSON body" }
```

**`400 Bad Request`**: a required field is missing:

```json
{ "ok": false, "error": "id, name, source, and agentId are required" }
```

**`422 Unprocessable Entity`**: the injection scan found a destructive / exfil / injection / supply-chain pattern; the install is blocked and audited:

```ts
{
  ok: false
  error: 'skill blocked: injection / supply-chain finding'
  findings: Array<{
    severity: 'exfil' | 'injection' | 'destructive' | 'supply-chain'
    pattern: string
    excerpt: string
  }>
}
```

**`200 OK`**: installed (merged into an existing row, or a new row inserted):

```ts
{ ok: true, skill: { id: string, name: string, source: string, category: string | null, trustScore: number | null, installedAt: number | null, metadata: string | null } | null }
```

**`500 Internal Server Error`**: a DB failure:

```json
{ "ok": false, "error": "<message>" }
```

#### Example

```bash
curl -X POST http://localhost:18790/api/skills \
  -H 'Content-Type: application/json' \
  -d '{"id":"web-search","name":"Web Search","source":"verified","agentId":"<agent-id>","category":"web"}'
```

### `DELETE /api/skills`

Removes an agent from a skill's `metadata.agentIds`. If that was the last agent, the skill row is deleted entirely; otherwise the row is kept with the agent removed.

- **Query params**: `id` (skill id, required) and `agentId` (required).
- **Request body**: none.

#### Responses

**`400 Bad Request`**: `id` or `agentId` missing:

```json
{ "ok": false, "error": "id and agentId query params are required" }
```

**`200 OK`**: skill not found (idempotent no-op):

```json
{ "ok": true, "deleted": false, "reason": "skill not found" }
```

**`200 OK`**: the agent was the last holder; the row was deleted:

```json
{ "ok": true, "deleted": true, "removedRow": true }
```

**`200 OK`**: the agent was removed but the row remains (other agents still hold it):

```json
{ "ok": true, "deleted": true, "removedRow": false }
```

**`500 Internal Server Error`**: a DB failure:

```json
{ "ok": false, "error": "<message>" }
```

#### Example

```bash
curl -X DELETE "http://localhost:18790/api/skills?id=web-search&agentId=<agent-id>"
```

---

## Exec settings: `/api/exec-settings`

Stores per-agent execution permission settings in the `agents.exec_config` column as JSON. Read per agent, read all agents at once during fleet hydration, or upsert one agent.

### `GET /api/exec-settings`

Loads one agent's execution settings.

- **Query params**: `agentId` (required).
- **Request body**: none.

#### Responses

**`400 Bad Request`**: missing `agentId`:

```json
{ "error": "agentId required" }
```

**`200 OK`**: the parsed `exec_config`, or `null` when none is stored:

```ts
{ values: { execAsk: string; execSecurity?: string } | null }
```

**`500 Internal Server Error`**: a DB failure:

```json
{ "error": "<message>" }
```

#### Example

```bash
curl "http://localhost:18790/api/exec-settings?agentId=<agent-id>"
```

### `GET /api/exec-settings/all`

Returns a map of every agent's `execAsk` value. Rows without an `exec_config`, or with malformed JSON, or whose `execAsk` is not a string, are skipped. Used during fleet hydration.

- **Path/query params**: none.
- **Request body**: none.

#### Responses

**`200 OK`**: the per-agent `execAsk` map:

```ts
{
  configs: Record<string, { execAsk: string }>
}
```

**`500 Internal Server Error`**: a DB failure:

```json
{ "error": "<message>" }
```

#### Example

```bash
curl http://localhost:18790/api/exec-settings/all
```

### `POST /api/exec-settings`

Upserts one agent's execution settings. The handler ensures a placeholder `agents` row exists, then stores `JSON.stringify(values)` in `exec_config`.

- **Request body**:

```ts
{
  agentId: string
  values: { execAsk: string; execSecurity?: string }
}
```

#### Responses

**`400 Bad Request`**: body is not an object:

```json
{ "error": "invalid JSON" }
```

**`400 Bad Request`**: `agentId` or `values` missing:

```json
{ "error": "agentId and values required" }
```

**`200 OK`**: upserted:

```json
{ "ok": true }
```

**`500 Internal Server Error`**: a DB failure:

```json
{ "error": "<message>" }
```

#### Example

```bash
curl -X POST http://localhost:18790/api/exec-settings \
  -H 'Content-Type: application/json' \
  -d '{"agentId":"<agent-id>","values":{"execAsk":"always","execSecurity":"sandbox"}}'
```

---

## Fleet summary: `/api/fleet/summary`

A read-only aggregation that joins existing tables/streams into one overview; it never recomputes or re-derives state. It counts live (non-archived) agents per runtime, gets each runtime's class + health from the adapters and the OpenClaw source, rolls up the last 24h of board tasks and verification verdicts, and counts governance budgets. The per-runtime tile loop is runtime-id-agnostic (open-set `runtime` strings).

- **Path/query params**: none.
- **Request body**: none.

### Responses

**`200 OK`**: the overview:

```ts
{
  generatedAt: number // epoch ms
  tenantId: null // dormant multi-tenant seam
  totalAgents: number // live (non-archived) agent rows
  runtimes: Array<{
    runtime: string
    runtimeClass: 'connected-substrate' | 'wrapped-oneshot' | 'native'
    healthOk: boolean | null // null when no adapter/source reports for it
    agentCount: number
    healthy: number // status idle | running
    degraded: number // status error
    down: number // sleeping / other
  }> // sorted by agentCount desc, then runtime name
  tasks24h: {
    total: number
    done: number
    cancelled: number
    inProgress: number // in_progress | in_review
    passRate: number | null // done / (done + cancelled); null if no terminal tasks
  }
  verification24h: {
    total: number
    pass: number
    fail: number
    debt: number // completed_with_debt
    passRate: number | null // pass / total; null if no verdicts
  }
  spend24hUsd: number // summed task costUsd over the last 24h
  budgets: {
    count: number
    paused: number
  }
}
```

<Note>
A runtime with no agent rows still appears (with zero counts) if an adapter or the OpenClaw source reports for it; OpenClaw is always `connected-substrate` and its `healthOk` reflects whether the server-side source connection is `connected`.
</Note>

**`500 Internal Server Error`**: a failure building the summary:

```json
{ "error": "<message>" }
```

### Example

```bash
curl http://localhost:18790/api/fleet/summary
```

---

## Boo Zero context: `/api/boo-zero/*`

[Boo Zero](/appendices/glossary) is the universal team leader. These routes store the markdown briefs it reads (per-team and global) and a Clawboo-side display-name override. Per-team briefs live in the `boo_zero_team_briefs` table (FK-cascades on team delete); the global brief and the display name live in the `settings` key/value table.

<Note>
A missing brief returns `null` content, not a 404; the UI then falls back to a client-side default brief. Likewise a missing display name returns `name: null` so the caller falls back to the Gateway-side agent name.
</Note>

### `GET /api/boo-zero/team-briefs/:teamId`

Loads a team's Boo Zero brief.

- **Path params**: `teamId` (required).
- **Request body**: none.

#### Responses

**`400 Bad Request`**: missing `teamId`:

```json
{ "error": "teamId required" }
```

**`200 OK`**: the stored brief, or `null`s when none exists:

```ts
{ content: string | null, updatedAt: number | null }
```

**`500 Internal Server Error`**: a DB failure:

```json
{ "error": "<message>" }
```

#### Example

```bash
curl http://localhost:18790/api/boo-zero/team-briefs/<team-id>
```

### `PUT /api/boo-zero/team-briefs/:teamId`

Upserts a team's brief (conflict on `teamId` updates `content` + `updatedAt`).

- **Path params**: `teamId` (required).
- **Request body**:

```ts
{
  content: string
} // required (must be a string)
```

#### Responses

**`400 Bad Request`**: missing `teamId`:

```json
{ "error": "teamId required" }
```

**`400 Bad Request`**: body missing a string `content`:

```json
{ "error": "content (string) required" }
```

**`200 OK`**: upserted:

```ts
{ content: string, updatedAt: number }
```

**`500 Internal Server Error`**: a DB failure:

```json
{ "error": "<message>" }
```

#### Example

```bash
curl -X PUT http://localhost:18790/api/boo-zero/team-briefs/<team-id> \
  -H 'Content-Type: application/json' \
  -d '{"content":"# Team brief\n\nShip the docs site."}'
```

### `DELETE /api/boo-zero/team-briefs/:teamId`

Removes a team's brief. Idempotent; deleting a non-existent brief is a no-op. (The FK cascade already cleans briefs up when the team itself is deleted; this route is for an explicit user action.)

- **Path params**: `teamId` (required).
- **Request body**: none.

#### Responses

**`400 Bad Request`**: missing `teamId`:

```json
{ "error": "teamId required" }
```

**`200 OK`**: removed (or already absent):

```json
{ "ok": true }
```

**`500 Internal Server Error`**: a DB failure:

```json
{ "error": "<message>" }
```

#### Example

```bash
curl -X DELETE http://localhost:18790/api/boo-zero/team-briefs/<team-id>
```

### `GET /api/boo-zero/global-brief`

Loads the global Boo Zero brief from the `settings` key `boo-zero:global-brief`.

- **Path/query params**: none.
- **Request body**: none.

#### Responses

**`200 OK`**: the stored brief, or `null`s when unset:

```ts
{ content: string | null, updatedAt: number | null }
```

<Note>
`updatedAt` is always `null` on this route; the global brief is stored in the settings KV table, and the handler does not re-query the row's timestamp.
</Note>

**`500 Internal Server Error`**: a DB failure:

```json
{ "error": "<message>" }
```

#### Example

```bash
curl http://localhost:18790/api/boo-zero/global-brief
```

### `PUT /api/boo-zero/global-brief`

Sets the global Boo Zero brief.

- **Request body**:

```ts
{
  content: string
} // required (must be a string)
```

#### Responses

**`400 Bad Request`**: body missing a string `content`:

```json
{ "error": "content (string) required" }
```

**`200 OK`**: saved (`updatedAt` is `Date.now()`):

```ts
{ content: string, updatedAt: number }
```

**`500 Internal Server Error`**: a DB failure:

```json
{ "error": "<message>" }
```

#### Example

```bash
curl -X PUT http://localhost:18790/api/boo-zero/global-brief \
  -H 'Content-Type: application/json' \
  -d '{"content":"# Global brief\n\nDefault leadership posture."}'
```

### `GET /api/boo-zero/display-name/:agentId`

Loads the Clawboo-side display-name override for Boo Zero, keyed by agent id, from the `settings` key `boo-zero:display-name:<agentId>`.

- **Path params**: `agentId` (required).
- **Request body**: none.

#### Responses

**`400 Bad Request`**: missing `agentId`:

```json
{ "error": "agentId required" }
```

**`200 OK`**: the override, or `null` when unset:

```ts
{
  name: string | null
}
```

**`500 Internal Server Error`**: a DB failure:

```json
{ "error": "<message>" }
```

#### Example

```bash
curl http://localhost:18790/api/boo-zero/display-name/<agent-id>
```

### `PUT /api/boo-zero/display-name/:agentId`

Sets the display-name override. The value is trimmed and truncated to 80 chars; an empty string clears the override.

- **Path params**: `agentId` (required).
- **Request body**:

```ts
{
  name: string
} // required (must be a string; '' clears the override)
```

#### Responses

**`400 Bad Request`**: missing `agentId`:

```json
{ "error": "agentId required" }
```

**`400 Bad Request`**: body missing a string `name`:

```json
{ "error": "name (string) required" }
```

**`200 OK`**: saved (returns the trimmed/truncated value actually stored):

```ts
{
  name: string
}
```

**`500 Internal Server Error`**: a DB failure:

```json
{ "error": "<message>" }
```

#### Example

```bash
curl -X PUT http://localhost:18790/api/boo-zero/display-name/<agent-id> \
  -H 'Content-Type: application/json' \
  -d '{"name":"Boo Zero"}'
```

---

## Error envelope

Every error response in this group is the standard envelope `{ error: string }`, except the skills routes (and the graph-layout POST), which use `{ ok: false, error: string }`. The skills GET 500 additionally carries `skills: []`, and the skills POST 422 carries `findings: InjectionFinding[]`. The graph-layout GET never returns an error status; a miss or a thrown error both yield `{ positions: {} }` (HTTP 200).

## See also

- [Cost dashboard + budgets](/using/cost-and-budgets), the UI over cost records
- [Governance API](/reference/rest-api/governance), budgets and the budget kill-switch
- [Agents API](/reference/rest-api/agents), the agent registry that `agentId` references
- [Teams API](/reference/rest-api/teams), teams, rules, and team-chat (`teamId` references)
- [Boo Zero](/using/boo-zero), briefs, rules, and display name in the UI
- [Using the Ghost Graph](/using/ghost-graph), what `graph-layout` positions
- [Database schema](/reference/database-schema), `cost_records`, `chat_messages`, `graph_layouts`, `skills`, `boo_zero_team_briefs`, `agents`
- [REST API overview](/reference/rest-api/index)
