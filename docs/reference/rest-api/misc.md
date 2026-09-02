---
title: Misc resources API
description: REST reference for cost records, chat history, graph layout, personality, skills, the marketplace catalog, exec settings, fleet summary, and Boo Zero context.
---

REST surface for the remaining resources that do not warrant their own group: per-run cost records and the cost summary, persisted chat transcripts, Ghost Graph node positions, per-agent personality and execution settings, skill installs (with a supply-chain injection scan), the marketplace catalog, the read-only fleet-health summary, and Boo Zero's per-team / global briefs and display-name override.

Almost every handler in this group opens the SQLite database at `<CLAWBOO_HOME>/clawboo.db` (default `~/.clawboo/clawboo.db`); these routes serve and mutate local state and do not require the Gateway to be up. The three `/api/catalog/*` routes are the exception: they touch no database at all. All POST/PUT bodies are parsed by `express.json({ limit: '2mb' })`.

<Note>
The order in `api/index.ts` matters: `/api/cost-records/summary` and `/api/exec-settings/all` are registered before their shorter prefixes so the two-segment paths are not swallowed.
</Note>

## Routes

| Method | Path                                            | Summary                                                       | Stream? |
| ------ | ----------------------------------------------- | ------------------------------------------------------------- | ------- |
| GET    | `/api/cost-records`                             | List cost records (period + agent filter)                     | No      |
| POST   | `/api/cost-records`                             | Record one run's token usage; computes USD                    | No      |
| GET    | `/api/cost-records/summary`                     | 30-day aggregation: totals, per-agent, time series            | No      |
| GET    | `/api/chat-history`                             | Load a session's transcript entries                           | No      |
| POST   | `/api/chat-history`                             | Batch-insert transcript entries (idempotent)                  | No      |
| POST   | `/api/chat-history/reset-context`               | End the model's conversation; keep every message              | No      |
| DELETE | `/api/chat-history`                             | Destroy a session's transcript                                | No      |
| GET    | `/api/graph-layout`                             | Load saved Ghost Graph node positions                         | No      |
| POST   | `/api/graph-layout`                             | Upsert Ghost Graph node positions                             | No      |
| GET    | `/api/personality`                              | Load an agent's personality slider values                     | No      |
| POST   | `/api/personality`                              | Upsert an agent's personality config                          | No      |
| GET    | `/api/skills`                                   | List installed skills (optional agent filter)                 | No      |
| POST   | `/api/skills`                                   | Install a skill (injection scan → 422 on finding)             | No      |
| DELETE | `/api/skills`                                   | Remove an agent from a skill (drops the row if last)          | No      |
| GET    | `/api/catalog/index`                            | Marketplace browse rows: the seed plus verified packs         | No      |
| GET    | `/api/catalog/agents/:id`                       | One catalog agent's document set                              | No      |
| GET    | `/api/catalog/teams/:id`                        | One catalog team's narrative and routing                      | No      |
| GET    | `/api/exec-settings`                            | Load an agent's execution settings                            | No      |
| GET    | `/api/exec-settings/all`                        | Map of all agents' `execAsk` settings                         | No      |
| POST   | `/api/exec-settings`                            | Upsert an agent's execution settings                          | No      |
| GET    | `/api/fleet/summary`                            | Read-only fleet-health aggregation                            | No      |
| GET    | `/api/boo-zero/team-briefs/:teamId`             | Load a team's Boo Zero brief                                  | No      |
| PUT    | `/api/boo-zero/team-briefs/:teamId`             | Upsert a team's Boo Zero brief                                | No      |
| DELETE | `/api/boo-zero/team-briefs/:teamId`             | Remove a team's Boo Zero brief                                | No      |
| GET    | `/api/boo-zero/global-brief`                    | Load the global Boo Zero brief                                | No      |
| PUT    | `/api/boo-zero/global-brief`                    | Upsert the global Boo Zero brief                              | No      |
| GET    | `/api/boo-zero/display-name/:agentId`           | Load Boo Zero's display-name override                         | No      |
| PUT    | `/api/boo-zero/display-name/:agentId`           | Set Boo Zero's display-name override                          | No      |
| GET    | `/api/boo-zero/override`                        | Read the leader override + the effective Boo Zero             | No      |
| POST   | `/api/boo-zero/override`                        | Set or clear the leader override                              | No      |
| GET    | `/api/connectors`                               | Lists the connectors that are live right now, as held in...   | No      |
| GET    | `/api/connectors/configured`                    | Answers, in one request for the whole shelf, which...         | No      |
| GET    | `/api/connectors/path-suggestions`              | Returns real, server-verified filesystem paths to offer as... | No      |
| POST   | `/api/connectors/connect`                       | Connects one catalog or custom connector, spawning its...     | No      |
| POST   | `/api/connectors/:slug/disconnect`              | Closes the live connector for a slug and records the...       | No      |
| POST   | `/api/connectors/:slug/authorize`               | Starts an interactive OAuth sign-in for a remote connector... | No      |
| POST   | `/api/connectors/:slug/authorize/await`         | A long poll that blocks until the sign-in started by POST...  | No      |
| DELETE | `/api/connectors/:slug/authorize`               | Signs the connector out: stops it if it is running, then...   | No      |
| GET    | `/api/connectors/:slug/config`                  | Reports everything an operator must supply before this...     | No      |
| PUT    | `/api/connectors/:slug/config`                  | Stores the credentials and the launch argument an operator... | No      |
| GET    | `/api/connectors/composio`                      | Whether a key is stored, and which brokered apps are linked   | No      |
| PUT    | `/api/connectors/composio/key`                  | Stores the operator's Composio API key                        | No      |
| DELETE | `/api/connectors/composio/key`                  | Forgets the stored key and drops the cached list of...        | No      |
| POST   | `/api/connectors/composio/apps/:slug/authorize` | Starts linking one brokered app                               | No      |
| GET    | `/api/connectors/custom`                        | Lists the operator's own connector entries, converted into... | No      |
| POST   | `/api/connectors/custom`                        | Creates or replaces a custom connector definition             | No      |
| DELETE | `/api/connectors/custom/:slug`                  | Removes a custom connector definition                         | No      |
| GET    | `/api/grants`                                   | Lists grants, newest first by grantedAt, with no cap          | No      |
| POST   | `/api/grants`                                   | Creates a grant, or widens or narrows the existing grant...   | No      |
| POST   | `/api/grants/:id/revoke`                        | Revokes a grant and cascade-deletes its standing approval...  | No      |
| POST   | `/api/grants/:id/resume`                        | Undoes a revoke, but only inside a bounded window:...         | No      |

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

Two different verbs end a conversation, and the difference matters. **Reset context** is what `/reset` and `/new` call: it ends what the model is carrying and writes a divider, and moves no message at all. **Delete** is what agent deletion calls: the conversation is destroyed. Nothing else removes a message.

`GET` returns the **most recent** page and a cursor for walking backwards, which is how a chat that is never cleared stays readable.

### `GET /api/chat-history`

Loads a page of a session's transcript entries, oldest first **within the page**. The page is the most RECENT one, and `before` walks backwards from there.

- **Query params**:

| Param        | Type   | Default | Notes                                                                   |
| ------------ | ------ | ------- | ----------------------------------------------------------------------- |
| `sessionKey` | string | n/a     | **Required**; the session to load                                       |
| `limit`      | number | 200     | Clamped to a max of 1000; a non-numeric value falls back to 200         |
| `before`     | number | n/a     | A `nextBefore` from a previous response; a non-numeric value is ignored |

- **Request body**: none.

#### Responses

**`400 Bad Request`**: missing `sessionKey`:

```json
{ "error": "sessionKey required" }
```

**`200 OK`**: the parsed transcript entries (rows that fail JSON parse are dropped), plus the cursor for the page before this one:

```ts
{
  entries: TranscriptEntry[]
  hasMore: boolean            // true when older messages exist
  nextBefore: number | null   // pass back as `before`; null once the start is reached
}
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

### `POST /api/chat-history/reset-context`

Ends the model's conversation on every listed session and writes one divider into the transcript. **No existing message is touched**: nothing is moved, re-keyed, or deleted. Also clears the native resume pointers for each key (the 1:1 pointer, or the per-team one for a team key) so the next turn starts without the earlier turns.

A team room passes every teammate's session key and one `noticeSessionKey`, because the person is looking at a single merged timeline and should see one divider, not one per teammate.

- **Request body**:

```ts
{
  sessionKeys: string[]        // required, non-empty
  noticeSessionKey?: string    // must be one of sessionKeys; defaults to the first
}
```

#### Responses

**`400 Bad Request`**: no usable keys (`sessionKeys` absent, not an array, or holding no non-empty string):

```json
{ "error": "sessionKeys[] required" }
```

**`400 Bad Request`**: the notice key is outside the list:

```json
{ "error": "noticeSessionKey must be one of sessionKeys" }
```

**`200 OK`**: the divider that was written, ready to append to the open transcript:

```ts
{ ok: true, entry: TranscriptEntry }
```

**`500 Internal Server Error`**: a DB failure:

```json
{ "error": "<message>" }
```

#### Example

```bash
curl -X POST http://localhost:18790/api/chat-history/reset-context \
  -H 'Content-Type: application/json' \
  -d '{"sessionKeys":["agent:my-boo:native"]}'
```

### `DELETE /api/chat-history`

Destroys every message for a session. Used when an agent is deleted. To end a conversation without losing it, use the reset-context route above.

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
    source: string // free-text provenance (e.g. 'curated'); not an external registry
    category: string | null
    trustScore: number | null // retained column, no longer populated
    installedAt: number | null
    metadata: string | null // JSON; { agentIds: string[] }
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

Adds a skill (a capability annotation) to an agent. Before recording anything, the handler runs `evaluateInjection` over the install blob (name + source + category + the raw body) on the **`exec`** surface, where a skill install is spawn-bound and every rule that fires is blocking. A blocking finding refuses the install with **422** and writes a blocked-install audit row; a clean install is also audited (the forensic trail). The audit row stores only `{pattern, line, fingerprint}` per finding; full excerpts stay in the HTTP response. On a clean scan, an existing skill row merges the `agentId` into `metadata.agentIds`; otherwise a new row is inserted.

- **Request body**:

```ts
{
  id: string               // required
  name: string             // required
  source: string           // required (e.g. 'curated')
  agentId: string          // required
  category?: string | null
}
```

#### Responses

**`400 Bad Request`**: body is not an object:

```json
{ "ok": false, "error": "Invalid JSON body" }
```

**`400 Bad Request`**: a required field is missing or not a non-empty string (or `category` is a non-string):

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
  -d '{"id":"web-search","name":"Web Search","source":"curated","agentId":"<agent-id>","category":"web"}'
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

## Marketplace catalog: `/api/catalog/*`

The only routes in this group backed by files rather than SQLite. Marketplace
content lives in `catalog/`, which is excluded from the npm tarball; the server
resolves it (local filesystem, then `CLAWBOO_CATALOG_INDEX_URL`, then a default
URL), verifies each pack bundle against the digest the index publishes, and
flattens the verified packs to entries. For `/api/catalog/*` specifically, the
browser therefore needs no integrity logic and no second origin. That is a
property of these three routes, not a project-wide rule.

The connector registry is deliberately not behind this seam. A catalog pack
leaves the tarball and arrives from a remote that can change after release, so a
runtime digest check is the only one available. The connector snapshot is itself
the shipped artifact, compiled in and served as a lazy chunk, so it is
content-addressed before publish instead: `pnpm verify:connectors` recomputes its
digest and fails CI on an edit that preserves shape. Each is checked at the point
where checking it means something, and moving the snapshot behind these routes
would trade an offline guarantee for integrity it already has.

<Note>
  These never fail closed. The built-in pack is compiled into the server and merged
  unconditionally, so an unreachable or empty remote degrades the catalog rather than emptying it.
  That matters because first-run onboarding renders its team picker with no "start from scratch"
  escape hatch: an empty catalog is not a degraded browse experience, it is a first run with nothing
  to click.
</Note>

### `GET /api/catalog/index`

Browse rows only, never prose. Roughly 275 KB for the 436 agents and 85 teams
this repo ships.

```json
{
  "schemaVersion": 1,
  "counts": { "agents": 436, "teams": 85 },
  "agents": [
    {
      "id": "clawboo-dev-code-reviewer-boo",
      "packId": "clawboo",
      "source": "clawboo",
      "name": "Code Reviewer Boo",
      "role": "Code Reviewer",
      "emoji": "🔍",
      "color": "#34D399",
      "description": "Reviews diffs for correctness, security and style.",
      "category": "engineering",
      "tags": ["review", "quality"],
      "skillIds": ["code-search"]
    }
  ],
  "teams": [
    {
      "id": "clawboo-dev",
      "packId": "clawboo",
      "source": "clawboo",
      "name": "Dev Squad",
      "emoji": "🛠️",
      "color": "#34D399",
      "description": "Ships code: fix, review, document.",
      "category": "engineering",
      "tags": ["dev"],
      "agentIds": ["clawboo-dev-bug-fixer-boo", "clawboo-dev-code-reviewer-boo"]
    }
  ],
  "packs": [
    {
      "publisher": "clawboo",
      "slug": "builtin",
      "id": "clawboo",
      "version": "1.0.0",
      "offline": true
    }
  ]
}
```

A `packs[]` row with `offline: true` is the compiled seed rather than a fetched
pack.

### `GET /api/catalog/agents/:id`

The agent's document set, keyed by filename. `404` on an unknown id.

```json
{
  "id": "clawboo-dev-code-reviewer-boo",
  "files": {
    "SOUL.md": "# SOUL\n\n...",
    "IDENTITY.md": "# Code Reviewer Boo\n\n...",
    "TOOLS.md": "# TOOLS\n\n## Skills\n- code-search"
  },
  "sourceUrl": "https://github.com/..."
}
```

`AGENTS.md` and `CLAWBOO.md` are **not** here. They are synthesized per-deploy
from the team topology, and `IDENTITY.md` is rewritten with the agent's final,
deduped name, so the deploy path overlays on this map rather than passing it
through.

### `GET /api/catalog/teams/:id`

```json
{
  "id": "clawboo-dev",
  "workflowNarrative": "...",
  "routing": { "clawboo-dev-bug-fixer-boo": "# AGENTS\n\n..." }
}
```

`404` on an unknown id. See
[the marketplace catalog reference](/reference/marketplace-catalog) for the pack
format and the verification rules.

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

[Boo Zero](/appendices/glossary) is the universal team leader. These routes store the markdown briefs it reads (per-team and global), a Clawboo-side display-name override, and the runtime-neutral leader override that decides which agent is Boo Zero at all. Per-team briefs live in the `boo_zero_team_briefs` table (FK-cascades on team delete); the global brief, the display name, and the leader override live in the `settings` key/value table.

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

### `GET /api/boo-zero/override`

Reads the runtime-neutral leader override stored in the `settings` key `boo-zero:agent-id`, alongside the Boo Zero that `resolveBooZero` currently lands on and which rung of its chain (override → native → OpenClaw) produced it.

- **Request body**: none.

#### Responses

**`200 OK`**: the stored override (`null` when unset or cleared), the effective leader, and the tier:

```ts
{
  overrideAgentId: string | null
  effective: { id: string, name: string } | null
  tier: 'override' | 'native' | 'openclaw' | null
}
```

`tier` is derived from the stored setting first, so a non-null `overrideAgentId` always reports `'override'`.

**`500 Internal Server Error`**: a DB failure:

```json
{ "error": "<message>" }
```

#### Example

```bash
curl http://localhost:18790/api/boo-zero/override
```

### `POST /api/boo-zero/override`

Sets or clears the override. Any runtime is legal by design (the resolver does no runtime check), which is what lets a non-native agent lead every team in a mixed install. Setting validates that the agent row exists and is not archived, so a stale id is never stored; clearing writes an empty value, restoring the default override → native → OpenClaw chain.

- **Request body**:

```ts
{
  agentId: string | null
} // required (a non-empty string to set, null to clear)
```

#### Responses

**`400 Bad Request`**: the body is not an object, or has no `agentId` key:

```json
{ "error": "agentId is required (string to set, null to clear)" }
```

**`400 Bad Request`**: `agentId` is neither `null` nor a non-empty string:

```json
{ "error": "agentId must be a non-empty string or null" }
```

**`404 Not Found`**: the id does not match a live agent row:

```json
{ "error": "agent not found (or archived)" }
```

**`200 OK`**: stored (or cleared), with the re-resolved effective leader:

```ts
{
  ok: true
  overrideAgentId: string | null
  effective: { id: string, name: string } | null
}
```

**`500 Internal Server Error`**: a DB failure:

```json
{ "error": "<message>" }
```

#### Example

```bash
# Promote any agent (any runtime) to Boo Zero
curl -X POST http://localhost:18790/api/boo-zero/override \
  -H 'Content-Type: application/json' \
  -d '{"agentId":"<agent-id>"}'

# Clear the override
curl -X POST http://localhost:18790/api/boo-zero/override \
  -H 'Content-Type: application/json' \
  -d '{"agentId":null}'
```

---

## Connectors: `/api/connectors`

A connector is a third-party MCP server the operator connects to clawboo, which then runs with credentials the operator supplies: an API key pasted into the vault, an OAuth sign-in, or a launch argument such as the folder a filesystem server is allowed to see. Connectors come from the committed catalog (`@clawboo/connector-catalog`) or from custom entries the operator registers themselves, and the three routes below are the read-only surface the panel polls: what is running, what is already configured, and what real paths exist on this machine.

All three sit on the general rate-limit tier, 3000 requests a minute per client address, above which the limiter answers `429` with `{ "error": "Too many requests. Wait a moment and retry." }`. None of them requires a credential to call, and none returns a secret value: the configured route reports presence only.

### `GET /api/connectors`

Lists the connectors that are live right now, as held in the supervisor's in-memory map. A connector that is defined but not connected does not appear.

- **Query params**: none.
- **Request body**: none.

#### Responses

**`200 OK`**: the live connectors:

```ts
{
  ok: true
  connectors: Array<{
    connectorId: string
    slug: string
    toolCount: number
    tools: string[]
    skipped: Array<{ name: string; reason: string }>
    specHash: string
    toolsHash: string
  }>
}
```

`toolCount` is the length of the connector's descriptor list and `tools` is those descriptors' names, each already namespaced by slug. `skipped` carries the tools that could not be represented, each with the reason it was dropped, so a missing tool is visible rather than silent; the reasons seen here are the namespacing refusal, `duplicate-name`, and one synthetic entry named `(inventory)` with reason `tool-list-truncated`, which marks an inventory the server could not read to the end.

The live connector's resolved command is held in memory but is not part of this response.

**`500 Internal Server Error`**: any thrown error, stringified and passed through the redactor:

```json
{ "error": "<message>" }
```

#### Example

```bash
curl "http://localhost:18790/api/connectors"
```

### `GET /api/connectors/configured`

Answers, in one request for the whole shelf, which connectors already have everything they asked for. It walks every definition, the committed catalog plus the operator's custom entries, and returns two separate lists of slugs.

- **Query params**: none.
- **Request body**: none.

#### Responses

**`200 OK`**: two slug lists:

```ts
{ ok: true; slugs: string[]; supplied: string[] }
```

`slugs` holds every connector whose configuration is satisfied: every required credential stored, the launch argument satisfied, and, for a remote connector that is not bearer-authenticated, an OAuth authorization on file. A bearer remote is answered by its credential instead, so it is never held back waiting on a sign-in it does not run. `supplied` holds every connector a person actually handed something to, meaning at least one credential is present or a launch argument is stored. The two differ: a connector that declares no inputs and takes no argument is satisfied the moment it exists, so it appears in `slugs` but not in `supplied`.

No value, token, or per-connector detail is returned here. Presence only.

**`500 Internal Server Error`**: any thrown error, stringified and passed through the redactor:

```json
{ "error": "<message>" }
```

#### Example

```bash
curl "http://localhost:18790/api/connectors/configured"
```

### `GET /api/connectors/path-suggestions`

Returns real, server-verified filesystem paths to offer as chips for a connector that takes a path argument. Every suggestion is stat'd before it is offered, so a chip that comes back exists on this machine right now, and the list can legitimately be empty. The lookup uses the committed catalog only, so a custom connector is not resolved here.

- **Query params**:

| Param  | Type     | Default | Notes                                                                                                          |
| ------ | -------- | ------- | -------------------------------------------------------------------------------------------------------------- |
| `slug` | `string` | `''`    | Catalog connector slug. Must resolve to a definition that declares a `userArgument`, otherwise the route 404s. |

- **Request body**: none.

Behaviour depends on the slug. For `sqlite` the handler does a depth-2 walk from `process.cwd()`, skipping dotted entries and `node_modules` and never following symlinks out of the tree, gathering files matching `.db`, `.sqlite`, or `.sqlite3` and stopping the walk once 25 candidates are in hand, then sorting them and offering the first five, each labelled with its basename and re-checked as a file. For any other qualifying slug it offers, in order, the working directory (labelled `Where clawboo runs`), then `Documents`, `Desktop`, and `Downloads` under the home directory, keeping only the ones that exist and are directories. Duplicate paths are dropped, and the response is capped at five suggestions either way.

#### Responses

**`200 OK`**: the verified suggestions:

```ts
{
  ok: true
  suggestions: Array<{ label: string; path: string }>
}
```

**`404 Not Found`**: the slug is missing, is not a catalog connector, or names one that declares no `userArgument`:

```json
{ "error": "that connector does not take a path" }
```

**`500 Internal Server Error`**: any thrown error, stringified and passed through the redactor:

```json
{ "error": "<message>" }
```

#### Example

```bash
curl "http://localhost:18790/api/connectors/path-suggestions?slug=filesystem"
```

### `POST /api/connectors/connect`

Connects one catalog or custom connector, spawning its child process (stdio) or opening its remote session (streamable HTTP), and returns the tools it advertised. Sits on the sensitive rate-limit tier (60 requests per minute per client address), since one request spawns a process off the back of it.

Before it will connect anything, the handler re-evaluates the same refusal predicate the browser renders, server-side, against the credential vault and the settings store. A `community` connector is refused outright. A connector that declares credentials needs those values stored first (via `PUT /api/connectors/:slug/config`), a connector that declares a launch argument needs that path supplied, and a remote connector needs either a completed OAuth sign-in or, when its auth kind is `bearer`, a stored token. Anything still missing answers `422` rather than spawning. For an OAuth remote the access token is resolved before the check, which refreshes a refreshable but expired token; a bearer remote skips the sign-in machinery entirely and is answered by its credential.

Connecting a slug that is already live returns the existing session rather than starting a second child, and a request that arrives while a connect for the same slug is still in flight joins that attempt instead of spawning alongside it.

- **Query params**: none.
- **Request body**:

| Field  | Type     | Required | Notes                                                                                                                                  |
| ------ | -------- | -------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| `slug` | `string` | yes      | 1 to 48 chars, must match `^[a-z0-9][a-z0-9-]*$`. Resolved against the committed catalog first, then the operator's custom connectors. |

#### Responses

**`200 OK`**: the connector came up:

```ts
{
  ok: true
  connectorId: string
  // The resolved command that actually ran, or the URL for a remote connector.
  command: string
  tools: string[]
  skipped: Array<{ name: string; reason: string }>
}
```

**`400 Bad Request`**: the body failed schema validation:

```ts
{ error: 'invalid body'; details: /* zod flatten() output */ }
```

**`404 Not Found`**: no catalog or custom connector carries that slug:

```json
{ "error": "no catalog connector named <slug>" }
```

**`422 Unprocessable Entity`**: the server refuses to connect it, with a machine-readable reason and the human copy for it. `error` is `CONNECT_REFUSAL_COPY[reason]`:

```ts
{
  error: string
  reason:
    | 'community-unsandboxed'
    | 'remote-needs-registered-app'
    | 'remote-needs-oauth'
    | 'needs-credential'
    | 'needs-user-supplied-argument'
}
```

**`502 Bad Gateway`**: the spawn or handshake failed. Connection-level failures that never reached the other end are retried first, up to three attempts with a doubling delay; a request that arrived and was refused is not retried. `error` is a translated sentence naming the connector and the likely obstacle (missing `npx` or `uvx`, a Node version too old, an unpublished package or version, a rejected key, a missing scope, a timeout, an unreachable host, a missing file), falling back to `<Name> did not start.` when nothing matches. `detail` carries the original text, redacted and trimmed:

```ts
{
  error: string
  detail: string
}
```

Every failure on this route lands here, not on a `500`.

#### Example

```bash
curl -X POST http://localhost:18790/api/connectors/connect \
  -H 'Content-Type: application/json' \
  -d '{"slug":"filesystem"}'
```

### `POST /api/connectors/:slug/disconnect`

Closes the live connector for a slug and records the operator's intent, so boot restore leaves it down instead of bringing it back. Sits on the sensitive rate-limit tier.

Intent is recorded first, before the teardown runs, so a `404` from this route has still written `desiredState: 'disconnected'` onto the connector's row when one exists. If a connect for the same slug is still in flight, the handler waits for that attempt to settle before deciding whether anything is live.

- **Path params**:

| Param  | Type     | Notes                                                                               |
| ------ | -------- | ----------------------------------------------------------------------------------- |
| `slug` | `string` | Mapped to the connector instance id for that slug, the same id a grant is keyed on. |

- **Query params**: none.
- **Request body**: none.

#### Responses

**`200 OK`**: the connector was closed:

```json
{ "ok": true }
```

**`404 Not Found`**: nothing was live under that slug:

```json
{ "error": "connector is not connected" }
```

**`500 Internal Server Error`**: the teardown threw, with the message redacted:

```json
{ "error": "<message>" }
```

#### Example

```bash
curl -X POST http://localhost:18790/api/connectors/filesystem/disconnect
```

### `POST /api/connectors/:slug/authorize`

Starts an interactive OAuth sign-in for a remote connector and returns the URL the operator has to open. It does not open anything itself, because the server may not be on the machine with the browser. The slug is resolved against the committed catalog first and then the operator's own custom connectors, so a custom entry takes the same code path as a catalog one. Sits on the sensitive rate-limit tier (60 requests per minute per client address), since one request opens a sign-in at a third party.

No operator-supplied credential is involved. Clawboo discovers the provider's authorization server and registers itself per install via dynamic client registration, and the redirect lands on a loopback `http://127.0.0.1:<port>/callback` listener that is already bound before this route answers, never on a route under `/api`. The port is ephemeral, except that the port a previous registration was pinned to is tried first so the registration can be reused. (The broker route `POST /api/connectors/composio/apps/:slug/authorize` is a different endpoint and does need the operator's Composio API key, which it answers `409` without.)

Starting a sign-in cancels any earlier pending sign-in for the same slug and closes its listener, and a slower concurrent attempt that finishes after another one claimed the slug throws rather than publishing over it, so at most one is ever pending per connector.

- **Path params**:

| Param  | Type     | Default  | Notes                                                                                                 |
| ------ | -------- | -------- | ----------------------------------------------------------------------------------------------------- |
| `slug` | `string` | required | Catalog or custom connector slug. Must resolve, and its `launch.transport` must be `streamable-http`. |

- **Query params**: none.
- **Request body**: none. The handler reads no body.

#### Responses

**`200 OK`**: the URL to open:

```ts
{
  ok: true
  authorizeUrl: string
}
```

**`400 Bad Request`**: the connector is local, so there is nothing to sign in to:

```json
{ "error": "only remote connectors sign in" }
```

**`404 Not Found`**: no catalog or custom connector has that slug:

```json
{ "error": "no such connector" }
```

**`429 Too Many Requests`**: the sensitive ceiling:

```json
{ "error": "Too many requests for this operation. Wait a moment and retry." }
```

**`502 Bad Gateway`**: every other failure, because the fault is almost always at the provider's discovery or registration endpoint rather than in this server. There is no `500` here: the whole handler sits in one `try`, and its `catch` always answers `502`. The start step (resource-metadata discovery, authorization-server discovery, the listener bind, and dynamic registration) is retried up to 3 attempts with a doubling 300 ms backoff, but only for failures that never reached the other end. Two message shapes, both naming the connector:

```ts
// transport failure (the request did not leave this machine)
{
  error: `Could not reach ${displayName}. The request did not leave this machine, so this is network rather than the connector.`
}
// anything else; the detail is redacted, then truncated to 200 characters
{
  error: `${displayName} could not start sign-in. ${detail}`
}
```

The second shape is what a provider without dynamic client registration produces. It is also what a provider whose resource metadata names no authorization server produces (`<url> did not name an authorization server`), and what a concurrent sign-in that claimed the slug first produces (`another sign-in for this connector started first`).

#### Example

```bash
curl -X POST "http://localhost:18790/api/connectors/linear/authorize"
```

---

### `POST /api/connectors/:slug/authorize/await`

A long poll that blocks until the sign-in started by `POST /api/connectors/:slug/authorize` finishes. Separate from starting it so the browser can open the authorize URL first and then wait. On the general rate-limit tier, not the sensitive one. No credential is involved.

The handler imposes no timeout of its own: it awaits the pending flow's completion promise, and the bound on how long that can take belongs to the loopback listener, which gives up 5 minutes after the `authorize` call answered. So the request returns as soon as the flow settles, at the latest about 5 minutes after that, and an operator who abandons the provider tab gets a `400` rather than a request that hangs forever.

`200` means the authorization code was exchanged and the tokens were stored, not merely that the redirect arrived: the completion promise covers the token exchange and the save. Everything else, including the timeout, is a `400`.

The flow's completion also removes its pending entry, so calling this a second time after the same sign-in has settled reports that no sign-in is in progress. Two callers awaiting the same in-flight sign-in both receive the same answer.

- **Path params**:

| Param  | Type     | Default  | Notes                                                                                                                      |
| ------ | -------- | -------- | -------------------------------------------------------------------------------------------------------------------------- |
| `slug` | `string` | required | The connector whose in-flight sign-in to wait on. Not validated against the catalog, only against the pending-sign-in map. |

- **Query params**: none.
- **Request body**: none. The handler reads no body.

#### Responses

**`200 OK`**: the tokens are stored:

```ts
{
  ok: true
  authorized: true
}
```

**`400 Bad Request`**: the sign-in did not complete. The body carries the failure message, passed through `redactValue(String(err))`, so it keeps the `Error: ` prefix:

```json
{ "error": "<message>" }
```

Messages that originate in this code path:

| Message                                               | Cause                                                                                                                                                                                                                           |
| ----------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Error: no sign-in is in progress for this connector` | No pending flow for that slug, either because `authorize` was never called or because the flow already settled.                                                                                                                 |
| `Error: timed out waiting for the sign-in to finish`  | The 5-minute listener window elapsed with no callback.                                                                                                                                                                          |
| `Error: authorization failed: <code>`                 | The provider redirected back with an `error` parameter; `<code>` is that parameter's value.                                                                                                                                     |
| `Error: callback missing code or state`               | The callback arrived without an authorization code.                                                                                                                                                                             |
| `Error: state mismatch, authorization refused`        | The returned `state` did not match the one this flow issued. Belt and braces in practice: the listener already answers a mismatched `state` with a bare `404` and never resolves, so this second check is not normally reached. |

A failure inside the token exchange surfaces here too, carrying that exchange's own message. So does any other throw, since the whole handler sits in one `try` whose `catch` always answers `400`.

**`429 Too Many Requests`**: the general ceiling:

```json
{ "error": "Too many requests. Wait a moment and retry." }
```

A related 30-second bound is not this route's: it governs how long the operator's callback tab is held open waiting for the exchange before it renders "clawboo is still finishing. Check the connectors panel." That page can settle while this request is still waiting.

#### Example

```bash
curl -X POST "http://localhost:18790/api/connectors/linear/authorize/await"
```

---

### `DELETE /api/connectors/:slug/authorize`

Signs the connector out: stops it if it is running, then forgets its stored client registration and its tokens, which live in the vault under `connector-oauth-client:<slug>` and `connector-oauth-tokens:<slug>`. The teardown happens first, deliberately, because a live session is holding a token that is about to be deleted. That teardown also records the connector's desired state as `disconnected`, so boot restore does not bring it back, and it waits for any in-flight connect attempt to settle before tearing down, so this can take as long as a connect does. Sits on the sensitive rate-limit tier (60 requests per minute per client address).

No definition lookup happens, so an unknown slug is not a `404`: the route is idempotent and answers `200` whether or not anything was stored or running. It clears credentials only, and does not cancel a sign-in that is currently in flight.

- **Path params**:

| Param  | Type     | Default  | Notes                                             |
| ------ | -------- | -------- | ------------------------------------------------- |
| `slug` | `string` | required | The connector to sign out. Any value is accepted. |

- **Query params**: none.
- **Request body**: none.

#### Responses

**`200 OK`**: the connection is stopped and the stored client and tokens are deleted:

```json
{ "ok": true }
```

**`429 Too Many Requests`**: the sensitive ceiling:

```json
{ "error": "Too many requests for this operation. Wait a moment and retry." }
```

**`500 Internal Server Error`**: the disconnect or the secret deletion threw, with the message redacted:

```json
{ "error": "<message>" }
```

#### Example

```bash
curl -X DELETE "http://localhost:18790/api/connectors/linear/authorize"
```

### `GET /api/connectors/:slug/config`

Reports everything an operator must supply before this connector can run, and whether they have. The slug is resolved against the committed catalog first and then the operator's own custom connectors, so both kinds answer here.

Secret values are never returned. Each declared credential comes back as a `present` boolean only, while the launch argument comes back in full, because checking which folder or file a connector was handed is the reason for asking.

- **Path params**:

| Param  | Type     | Default  | Notes                                                       |
| ------ | -------- | -------- | ----------------------------------------------------------- |
| `slug` | `string` | required | Catalog or custom connector slug, for example `filesystem`. |

- **Request body**: none.

#### Responses

**`200 OK`**: the connector's configuration state:

```ts
{
  ok: true
  credentials: Array<{
    key: string          // the env var name, e.g. NOTION_TOKEN
    label?: string       // present only when the definition declares one
    description: string
    required: boolean
    secret: boolean
    present: boolean     // whether a value is stored, never the value
    docsUrl?: string     // present only when the definition declares one
  }>
  argument: string | null       // the stored launch argument, in full
  argumentSpec: {               // null when the definition declares no userArgument
    label: string
    description: string
    example: string
    replacesArg?: string
  } | null
  authorized: boolean
  satisfied: boolean
}
```

`argument` is `null` when nothing is stored for this connector, and also when the stored value is empty.

`authorized` is the OAuth question, and it is only asked of a `streamable-http` connector whose auth kind is not `bearer`; every other connector reports `true`. A bearer remote is answered by its credential rather than by the OAuth store, which is why it is excluded here.

`satisfied` is true when every **required** credential is stored (optional ones never block), the launch argument requirement is met, and `authorized` is true. Only a connector flagged `requiresUserArgument` needs a non-empty argument; one that merely declares a `userArgument` is satisfied without it.

**`404 Not Found`**: no catalog or custom connector carries that slug:

```json
{ "error": "no such connector" }
```

**`500 Internal Server Error`**: an unexpected failure, with the message passed through the redactor:

```json
{ "error": "<message>" }
```

#### Example

```bash
curl "http://localhost:18790/api/connectors/filesystem/config"
```

### `PUT /api/connectors/:slug/config`

Stores the credentials and the launch argument an operator supplies for one connector. Credential values go to the local secrets vault under a slot namespaced by connector, `connector:<slug>:<KEY>`, and the launch argument is stored as a setting outside the vault. These are the operator's own credentials for the connector itself, entered once and explicitly, rather than a broker key such as a Composio API key.

This route sits on the sensitive rate-limit tier in `index.ts`, alongside the other writes that hand out access.

The slug is resolved before the body is parsed, so an unknown slug answers `404` even when the body is also invalid. After that, the whole body is validated before anything is written, so a rejected request never persists half of itself.

Each supplied credential value passes through the same paste cleaner the UI field runs. It trims surrounding whitespace, strips a leading auth scheme (`Bearer`, `Token` or `Basic`, case-insensitive), and unwraps matched surrounding quotes (`"`, `'` or a backtick), repeating so a nested pair such as `'"abc"'` unwraps and a scheme hidden inside quotes is still removed. A value that cleans down to the empty string clears that credential instead of storing it.

- **Path params**:

| Param  | Type     | Default  | Notes                             |
| ------ | -------- | -------- | --------------------------------- |
| `slug` | `string` | required | Catalog or custom connector slug. |

- **Request body**:

| Field      | Type                     | Default                | Notes                                                                                                                                                                                  |
| ---------- | ------------------------ | ---------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `argument` | `string` (max 4096)      | omitted (unchanged)    | The launch argument, for example a folder or a database file. Trimmed before storing; an empty string clears it.                                                                       |
| `values`   | `Record<string, string>` | omitted (none written) | Credential values by declared env var name. Keys must match `/^[A-Z][A-Z0-9_]*$/`, values are capped at 8192 characters, and a value that cleans down to empty clears that credential. |

Both fields are optional, so an empty object is a valid body and returns the current state unchanged.

Every key in `values` must be declared by the connector's own auth spec. An undeclared key is refused, so this route cannot be used as a general write into the vault under a connector's name.

#### Responses

**`200 OK`**: the configuration state after the write, the same shape `GET` returns and still presence-only for credentials, so a secret handed to this route cannot be read back from it:

```ts
{
  ok: true
  credentials: Array<{
    key: string
    label?: string
    description: string
    required: boolean
    secret: boolean
    present: boolean
    docsUrl?: string
  }>
  argument: string | null
  argumentSpec: {
    label: string
    description: string
    example: string
    replacesArg?: string
  } | null
  authorized: boolean
  satisfied: boolean
}
```

**`400 Bad Request`**: the body failed schema validation, which includes a `values` key that is not a valid env var name and a value over the length cap:

```ts
{
  error: 'invalid body'
  details: ReturnType<ZodError['flatten']>
}
```

**`400 Bad Request`**: a key in `values` is a valid env var name but is not declared by this connector:

```json
{ "error": "<KEY> is not declared by <slug>" }
```

**`404 Not Found`**: no catalog or custom connector carries that slug:

```json
{ "error": "no such connector" }
```

**`500 Internal Server Error`**: an unexpected failure, with the message passed through the redactor:

```json
{ "error": "<message>" }
```

#### Example

```bash
curl -X PUT "http://localhost:18790/api/connectors/filesystem/config" \
  -H 'Content-Type: application/json' \
  -d '{"argument":"/Users/me/projects"}'
```

```bash
curl -X PUT "http://localhost:18790/api/connectors/notion/config" \
  -H 'Content-Type: application/json' \
  -d '{"values":{"NOTION_TOKEN":"ntn_..."}}'
```

### Composio, the broker routes

Composio is the broker clawboo uses for apps it cannot sign into directly. These
four routes are about an account at Composio and which of its apps the operator
has linked, not about a connector clawboo spawns or holds a session to, so they
live in their own handler file, `apps/web/server/api/composio.ts`.

The credential behind them is a Composio API key that the operator supplies. It
is the project key, the one starting with `ak_` on the Composio project settings
page, and clawboo takes it through `PUT /api/connectors/composio/key` and holds
it in the encrypted runtime vault under the slot name `COMPOSIO_API_KEY`. Only
`POST .../apps/:slug/authorize` refuses to run without a stored key; the status
read and the delete both answer when no key is held. The key itself never comes
back out over HTTP: the only fact any of these responses reports about it is the
boolean `hasKey`.

The three write routes sit on the sensitive rate-limit tier; the status read
stays on the general tier because the connector panel polls it.

### `GET /api/connectors/composio`

Whether a key is stored, and which brokered apps are linked. Reading it refreshes
the connected-apps cache when that cache is older than 60 seconds, waiting for at
most one refresh, and a second reader arriving during a refresh waits on the same
one rather than starting another.

- **Query params**: none.
- **Request body**: none.

#### Responses

**`200 OK`**, no key stored:

```json
{ "ok": true, "hasKey": false, "known": true, "connected": [] }
```

**`200 OK`**, a key is stored. `connected` holds clawboo slugs for the brokered
apps with an active connected account, `known` is false until a refresh has
succeeded at least once, so a failed read with nothing cached returns
`known: false` with an empty `connected` rather than claiming nothing is linked,
and `keyRejected` is true when the last call made with the stored key was refused
with a 401 or 403:

```ts
{ ok: true; hasKey: true; known: boolean; connected: string[]; keyRejected: boolean }
```

**`502 Bad Gateway`**: reading the connected apps threw. The appended message is
redacted and truncated to 200 characters:

```json
{ "error": "Could not read connected apps. <message>" }
```

#### Example

```bash
curl "http://localhost:18790/api/connectors/composio"
```

### `PUT /api/connectors/composio/key`

Stores the operator's Composio API key. Sensitive rate-limit tier.

The paste is unwrapped first, so `COMPOSIO_API_KEY=ak_...`, an `export` line and a
quoted value all work, then the key is tried against Composio before anything is
written. A key Composio refuses is not stored. A key that could not be checked
because Composio was unreachable is stored, and the response says it was not
verified. Storing a key also drops the cached connected-apps answer, which
described the previous key's account.

- **Query params**: none.
- **Request body**:

| Field    | Type     | Required | Notes                                                                                                                 |
| -------- | -------- | -------- | --------------------------------------------------------------------------------------------------------------------- |
| `apiKey` | `string` | yes      | At most 512 characters. A longer value, a non-string, or a body that is not an object is refused with `invalid body`. |

#### Responses

**`200 OK`**: the key was stored. `verified` is true only when Composio answered
and accepted it, false when Composio could not be reached:

```ts
{
  ok: true
  hasKey: true
  verified: boolean
}
```

**`400 Bad Request`**: the body carried no usable `apiKey` string:

```json
{ "error": "invalid body" }
```

**`400 Bad Request`**: the paste did not read as a project key, which is `ak_`
followed by at least ten more characters from `A-Za-z0-9_-`. The message is one
of `Paste your Composio key.` for an empty value, `That is a Composio login key.
The one needed here starts with ak_ and is on your project settings page.` for a
`uak_` value, or `That does not look like a Composio key. It starts with ak_.`
for anything else:

```json
{ "error": "That does not look like a Composio key. It starts with ak_." }
```

**`400 Bad Request`**: Composio answered and refused the key, so nothing was
stored:

```json
{ "error": "Composio rejected that key. Copy it again from your project settings." }
```

**`500 Internal Server Error`**: an unexpected failure, redacted and truncated to
200 characters:

```json
{ "error": "<message>" }
```

#### Example

```bash
curl -X PUT "http://localhost:18790/api/connectors/composio/key" \
  -H 'Content-Type: application/json' \
  -d '{"apiKey":"ak_xxxxxxxxxxxx"}'
```

### `DELETE /api/connectors/composio/key`

Forgets the stored key and drops the cached list of connected apps. The
per-app grants stay at Composio; this only removes clawboo's ability to reach
them. Succeeds whether or not a key was held. Sensitive rate-limit tier.

- **Query params**: none.
- **Request body**: none.

#### Responses

**`200 OK`**:

```json
{ "ok": true, "hasKey": false }
```

**`500 Internal Server Error`**: clearing the vault slot threw. The message is
redacted and truncated to 200 characters:

```json
{ "error": "<message>" }
```

#### Example

```bash
curl -X DELETE "http://localhost:18790/api/connectors/composio/key"
```

### `POST /api/connectors/composio/apps/:slug/authorize`

Starts linking one brokered app. The response carries Composio's hosted consent
URL for the browser to open; the provider's tokens are exchanged at Composio and
never reach this server. Sensitive rate-limit tier.

The stored key is checked before the slug is, so a request naming an unknown app
while no key is held answers `409`, not `404`. Past that, the route refreshes the
connected set before acting, so authorizing an app that is already linked returns
without minting a second consent flow. A successful authorization drops the cache
so the next status read cannot answer from before it.

The connection is created against a fixed local user id, `clawboo-local`, so one
install is one Composio user.

- **Path params**:

| Param  | Type     | Notes                                                                                                                                                                |
| ------ | -------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `slug` | `string` | clawboo's slug for a brokered app, for example `gmail`, `slack`, `google-calendar`. Not the Composio toolkit name, which for that third example is `googlecalendar`. |

- **Request body**: none.

#### Responses

**`409 Conflict`**: no Composio key is stored. Checked first, before the slug:

```json
{ "error": "Add a Composio key first.", "reason": "no-key" }
```

**`404 Not Found`**: no brokered app carries that slug:

```json
{ "error": "no brokered app named <slug>" }
```

**`200 OK`**: the app was already linked, so nothing was started:

```json
{ "ok": true, "alreadyConnected": true }
```

**`200 OK`**: a consent flow was opened. Open `url` in a browser:

```ts
{
  ok: true
  url: string
}
```

**`502 Bad Gateway`**: Composio refused or failed the authorization, or answered
successfully but without a redirect URL, which is treated as a failure rather
than a connection. In the second case the trailing detail is absent:

```json
{ "error": "<App name> could not be connected. <detail>" }
```

**`500 Internal Server Error`**: an unexpected failure, redacted and truncated to
200 characters:

```json
{ "error": "Could not connect this app. <message>" }
```

#### Example

```bash
curl -X POST "http://localhost:18790/api/connectors/composio/apps/gmail/authorize"
```

Custom connectors are servers the operator points clawboo at themselves. They are stored under the `connectors:custom` settings key, not in the committed catalog, and they are returned with `provenance: 'custom'`. clawboo has not run or inspected them and vouches for nothing about them: `toDefinition` deliberately declares the trifecta at its most permissive (`readsPrivateData`, `ingestsUntrustedContent` and `canEgress` all `true`), an `egressAllow` of `['*']`, and marks every declared auth input `secret: true`, because a value clawboo cannot vet is treated as a credential rather than as configuration.

### `GET /api/connectors/custom`

Lists the operator's own connector entries, converted into the same shape as a catalog entry so nothing downstream has to special-case them. No pagination, no filtering, and the order is storage order.

- **Query params**: none.
- **Request body**: none.

#### Responses

**`200 OK`**: every custom entry, in catalog shape:

```ts
{
  ok: true
  connectors: Array<{
    slug: string
    displayName: string
    description: string // falls back to 'A connector you added.'
    category: 'dev' // always, for custom entries
    provenance: 'custom'
    launch: {
      transport: 'stdio'
      command: string
      args: string[]
      pinnedVersion: string // the stored version, else 'user-supplied'
    }
    auth:
      | {
          kind: 'api-key'
          inputs: Array<{ key: string; description: string; required: boolean; secret: true }>
        }
      | { kind: 'none'; inputs: [] }
    egressAllow: ['*']
    trifecta: { readsPrivateData: true; ingestsUntrustedContent: true; canEgress: true }
    tags: ['custom']
    catalogId?: string // present only when the stored entry carried one
  }>
}
```

`auth` is `{ kind: 'none', inputs: [] }` whenever the stored entry declared no `authInputs`. An input whose stored `description` is empty comes back as `'Required by this server.'`.

**`500 Internal Server Error`**: a read failure, with the message passed through `redactValue`:

```json
{ "error": "<message>" }
```

Bad stored data never reaches either of those. If the settings value is missing, is not valid JSON, or does not parse to an array, the whole list reads as empty; within a well-formed array, an entry missing a string `slug`, a string `command` or an array `args` is dropped and the rest are still returned.

#### Example

```bash
curl "http://localhost:18790/api/connectors/custom"
```

### `POST /api/connectors/custom`

Creates or replaces a custom connector definition. Sits on the SENSITIVE rate-limit tier, 60 requests a minute, because the `command` and `args` it stores become a real child process later. Saving a slug that already exists as a custom entry replaces it and moves it to the end of the stored list.

This route takes no secret values. `authInputs` declares only the environment-variable NAMES the server needs, so the operator is actually asked for them; the values themselves are supplied afterwards through `PUT /api/connectors/:slug/config` and live in the vault.

- **Query params**: none.
- **Request body**: validated by `createCustomConnectorBody`.

| Field           | Type                                    | Default  | Notes                                                                                                                                  |
| --------------- | --------------------------------------- | -------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| `slug`          | `string`                                | required | 1 to 48 chars, `^[a-z0-9][a-z0-9-]*$`. Becomes a tool-name segment and a grant identity.                                               |
| `displayName`   | `string`                                | required | 1 to 80 chars.                                                                                                                         |
| `description`   | `string`                                | optional | Up to 300 chars.                                                                                                                       |
| `command`       | `string`                                | required | 1 to 1024 chars.                                                                                                                       |
| `args`          | `string[]`                              | `[]`     | At most 64 entries, each at most 2048 chars. An array, so nothing here is shell-parsed.                                                |
| `authInputs`    | `Array<{ key; description; required }>` | `[]`     | At most 16. `key` is 1 to 64 chars matching `^[A-Za-z_][A-Za-z0-9_]*$`; `description` defaults to `''`; `required` defaults to `true`. |
| `catalogId`     | `string`                                | optional | Up to 200 chars. Registry identity, when the entry came from the community snapshot.                                                   |
| `pinnedVersion` | `string`                                | optional | Up to 64 chars. The exact version the operator was shown before approving.                                                             |

#### Responses

**`200 OK`**: the entry was stored:

```ts
{
  ok: true
  slug: string
}
```

**`400 Bad Request`**: the body failed schema validation. `details` is the zod `flatten()` shape:

```ts
{ error: 'invalid body'; details: { formErrors: string[]; fieldErrors: Record<string, string[]> } }
```

**`409 Conflict`**: the slug is already a committed catalog connector. Shadowing one would silently replace an entry clawboo vouches for with a command it knows nothing about:

```json
{ "error": "<slug> is already a catalog connector" }
```

**`500 Internal Server Error`**: a write failure, with the message passed through `redactValue`:

```json
{ "error": "<message>" }
```

#### Example

```bash
curl -X POST "http://localhost:18790/api/connectors/custom" \
  -H 'Content-Type: application/json' \
  -d '{
        "slug": "my-notes",
        "displayName": "My Notes",
        "command": "node",
        "args": ["/Users/me/servers/notes/index.js"],
        "authInputs": [{ "key": "NOTES_API_KEY", "description": "Key for the notes server", "required": true }]
      }'
```

### `DELETE /api/connectors/custom/:slug`

Removes a custom connector definition. Sits on the SENSITIVE rate-limit tier, 60 requests a minute.

The handler disconnects FIRST and deletes second: removing the definition of something still running would orphan the child process with nothing left that knows how to stop it. The disconnect runs for `connectorInstanceId(slug)` on every call and its result is ignored, returning `false` when nothing is live, so the 404 below means only that no stored definition carried that slug. The slug is read straight from the path with no shape validation on this route.

- **Path params**: `slug`, the custom connector's slug.
- **Query params**: none.
- **Request body**: none.

#### Responses

**`200 OK`**: the definition was removed:

```json
{ "ok": true }
```

**`404 Not Found`**: no stored custom connector had that slug. The disconnect has already run by this point:

```json
{ "error": "no such custom connector" }
```

**`500 Internal Server Error`**: the disconnect or the write threw, with the message passed through `redactValue`:

```json
{ "error": "<message>" }
```

#### Example

```bash
curl -X DELETE "http://localhost:18790/api/connectors/custom/my-notes"
```

## Grants: `/api/grants`

A grant is one row in `capability_grants` saying that a subject (an agent, a team, or everything) may use a capability (a connector, a tool, or a skill) in a given mode, under a given approval policy, and it is the same record the broker's gate reads and the Ghost Graph draws as an edge. Grants carry an `origin`: `owner` rows record what a runtime's own config already attaches, while `operator` rows are deliberate human shares, and only the latter are drawn as an edge with a Detach control.

All four routes are registered in `apps/web/server/api/index.ts` on the general rate-limit tier, not the sensitive one, so they inherit the router-wide ceiling of 3000 requests per minute per client address and return `429 Too Many Requests` with `{ "error": "Too many requests. Wait a moment and retry." }` above it. None of them needs an operator-supplied credential: they read and write the local database only, and never call Composio or any remote provider.

Every route that returns a grant returns the same object:

```ts
type GrantRow = {
  id: string
  subjectKind: 'agent' | 'team' | 'global'
  subjectId: string | null
  capabilityKind: 'connector' | 'tool' | 'skill'
  connectorId: string | null
  capabilityId: string | null
  toolAllow: string[] // ['*'] is every tool, [] is an explicit nothing
  toolDeny: string[] // checked first, and it wins: a denied name is out of scope
  mode: 'read' | 'write' | 'admin'
  approvalPolicy: 'never' | 'risk' | 'writes' | 'always'
  state: 'proposed' | 'active' | 'suspended' | 'revoked' | 'expired'
  expiresAt: number | null
  specHashPin: string | null
  toolsHashPin: string | null
  callCeilingPerHour: number | null
  origin: 'owner' | 'operator'
  grantedBy: string | null
  grantedAt: number
  revokedAt: number | null
  revokedReason: string | null
}
```

Each enum is narrowed on the way out of the row mapper, falling back to its safest member rather than trusting stored text, so a hand-edited `mode` reads as `read`, an unrecognised `state` reads as `suspended`, and an unrecognised `approvalPolicy` reads as `always`. An unparseable `toolAllow` column reads as `[]` and an unparseable `toolDeny` reads as `['*']`, both failing closed.

### `GET /api/grants`

Lists grants, newest first by `grantedAt`, with no cap. Optionally narrowed to one subject.

- **Query params**:

| Param       | Type     | Default            | Notes                                                                                                                                                                                                                                                                                                                                                                                                                      |
| ----------- | -------- | ------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `subjectId` | `string` | none (every grant) | Matched against `capability_grants.subject_id` exactly, and independently of `subjectKind`, so an agent id and a team id that happen to be equal both match. Only a non-empty string value filters: a repeated or object-shaped param, and an empty `?subjectId=`, are all ignored and the unfiltered list is returned. A `subjectKind: 'global'` grant has a null `subject_id`, so it never matches a `subjectId` filter. |

- **Request body**: none.

#### Responses

**`200 OK`**: the matching grants:

```ts
{ ok: true; grants: GrantRow[] }
```

**`500 Internal Server Error`**: a DB failure, with the message passed through the redactor:

```json
{ "error": "<message>" }
```

#### Example

```bash
curl "http://localhost:18790/api/grants?subjectId=agent-atlas"
```

### `POST /api/grants`

Creates a grant, or widens or narrows the existing grant for the same identity. This is an upsert keyed on the composite `grant_key` of subject and capability, not an insert, so re-sharing the same connector with the same subject updates the one row and sets its `state` back to `active`, clearing `revokedAt` and `revokedReason`. An update also resets `grantedAt` to now, which moves the row to the top of the `GET /api/grants` ordering. It always sends `origin: 'operator'`, which promotes an existing `owner` row one way to `operator`, and it sends no `grantedBy` at all rather than fabricating an actor, because this server has no caller identity on any state-changing route: a newly inserted row therefore records `grantedBy: null`, and an update leaves whatever was stored alone.

- **Query params**: none.
- **Request body**: JSON, validated by `createGrantBody` in `packages/db/src/grants/schemas.ts`.

| Field                | Type                                        | Default            | Notes                                                                                                                                                                                                                                                                      |
| -------------------- | ------------------------------------------- | ------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `subjectKind`        | `'agent' \| 'team' \| 'global'`             | required           | Who the grant is for.                                                                                                                                                                                                                                                      |
| `subjectId`          | `string \| null`                            | `null`             | Required and non-empty unless `subjectKind` is `'global'`.                                                                                                                                                                                                                 |
| `capabilityKind`     | `'connector' \| 'tool' \| 'skill'`          | required           | What kind of capability this is.                                                                                                                                                                                                                                           |
| `connectorId`        | `string \| null`                            | `null`             | At least one of `connectorId` or `capabilityId` must be present. When `connectorId` is present the identity is normalised so the stored `capabilityId` is null, because a `capabilityId` folds the owning agent into its key and the grantee's broker would never find it. |
| `capabilityId`       | `string \| null`                            | `null`             | Used only when there is no `connectorId`.                                                                                                                                                                                                                                  |
| `mode`               | `'read' \| 'write' \| 'admin'`              | `'read'` on insert | Absent on an update leaves the stored value alone.                                                                                                                                                                                                                         |
| `approvalPolicy`     | `'never' \| 'risk' \| 'writes' \| 'always'` | `'risk'` on insert | Absent on an update leaves the stored value alone.                                                                                                                                                                                                                         |
| `toolAllow`          | `string[]`                                  | `['*']` on insert  | Tool-name globs. `[]` means no tools, which is different from omitting the field.                                                                                                                                                                                          |
| `toolDeny`           | `string[]`                                  | `[]` on insert     | Deny wins over `toolAllow`: a name matching a deny glob is out of scope even when an allow glob matches it.                                                                                                                                                                |
| `expiresAt`          | `number \| null`                            | none               | Positive integer epoch ms, or null. Forwarded only when the key is present, so an absent field never clears a time box an operator set.                                                                                                                                    |
| `callCeilingPerHour` | `number \| null`                            | none               | Positive integer, or null. Same presence gating as `expiresAt`.                                                                                                                                                                                                            |

#### Responses

**`200 OK`**: the inserted or updated grant:

```ts
{
  ok: true
  grant: GrantRow
}
```

**`400 Bad Request`**: the body failed schema validation. `details` is a zod v3 `flatten()` result, and the two cross-field rules ("one of connectorId or capabilityId is required" and "subjectId is required unless subjectKind is global") carry no path, so they land in `formErrors`:

```ts
{ error: 'invalid body'; details: { formErrors: string[]; fieldErrors: Record<string, string[]> } }
```

**`500 Internal Server Error`**: a DB failure, redacted:

```json
{ "error": "<message>" }
```

#### Example

```bash
curl -X POST "http://localhost:18790/api/grants" \
  -H 'Content-Type: application/json' \
  -d '{"subjectKind":"agent","subjectId":"agent-atlas","capabilityKind":"connector","connectorId":"github","mode":"read","approvalPolicy":"risk"}'
```

### `POST /api/grants/:id/revoke`

Revokes a grant and cascade-deletes its standing approval rules, so a remembered "Always" cannot outlive the grant it was recorded against. The two halves are gated differently. The state change applies only to a row that is currently `active`: revoking a grant in any other state, `proposed`, `suspended`, `revoked`, or `expired`, leaves the stored row untouched and still answers `200 OK` with that row, so the response is the grant's current state rather than a confirmation that this call changed it. The standing-rule delete is not state-gated, so it runs for the given id whatever state the grant is in.

- **Path params**: `id`, the grant id.
- **Request body**: optional, and the shipped Detach caller sends none. When present it is parsed by `revokeGrantBody`.

| Field    | Type             | Default | Notes                                                                                                                                            |
| -------- | ---------------- | ------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| `reason` | `string \| null` | `null`  | At most 200 characters. A missing body, or a body that fails validation, is not an error: `reason` falls back to `null` and the revoke proceeds. |

#### Responses

**`200 OK`**: the grant as it now stands:

```ts
{
  ok: true
  grant: GrantRow
}
```

**`404 Not Found`**: no grant has that id:

```json
{ "error": "grant not found" }
```

**`500 Internal Server Error`**: a DB failure, redacted:

```json
{ "error": "<message>" }
```

#### Example

```bash
curl -X POST "http://localhost:18790/api/grants/8f1c2d34-5e6f-4a7b-9c8d-0e1f2a3b4c5d/revoke" \
  -H 'Content-Type: application/json' \
  -d '{"reason":"detached from the graph"}'
```

### `POST /api/grants/:id/resume`

Undoes a revoke, but only inside a bounded window: `RESUME_WINDOW_MS` is 15 seconds, measured from `revokedAt`, which covers the shipped 8-second Undo toast. It restores `state: 'active'` and clears `revokedAt` and `revokedReason`, but it does not restore the standing rules the revoke deleted. A grant that is already `active` is returned as-is with `200 OK`. A `proposed`, `suspended`, or `expired` grant is not resumable here, and because the row does exist the handler answers `409 Conflict` for it, the same status a closed undo window gets.

- **Path params**: `id`, the grant id.
- **Request body**: none. Any body sent is ignored.

#### Responses

**`200 OK`**: the resumed, or already active, grant:

```ts
{
  ok: true
  grant: GrantRow
}
```

**`409 Conflict`**: the row exists but could not be resumed, either because more than 15 seconds have passed since the revoke, because the row is `revoked` with a null `revokedAt`, or because its state is not resumable:

```json
{ "error": "the undo window has closed" }
```

**`404 Not Found`**: no grant has that id:

```json
{ "error": "grant not found" }
```

**`500 Internal Server Error`**: a DB failure, redacted:

```json
{ "error": "<message>" }
```

#### Example

```bash
curl -X POST "http://localhost:18790/api/grants/8f1c2d34-5e6f-4a7b-9c8d-0e1f2a3b4c5d/resume"
```

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
