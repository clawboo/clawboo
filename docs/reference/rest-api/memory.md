---
title: 'Memory API'
sidebarTitle: 'Memory'
description: 'REST reference for shared memory: search, save, browse, the memory graph, feedback, outcomes, and the embeddings behind vector search.'
keywords:
  [
    'memory',
    'facts',
    'procedures',
    'embeddings',
    'ollama',
    'nomic-embed-text',
    'vector search',
    'memory browser',
  ]
---

These routes read and write the shared [memory](/concepts/memory). Memory holds two kinds of entry: **facts** (short statements, such as "Ship on Thursdays") and **procedures** (named, versioned how-to text). The routes search, save and browse entries, read the memory graph, record how a fact worked out, and inspect or repair the embeddings that power vector search and similarity links.

Agents reach the same store through the Memory MCP server (see [MCP tools](/reference/mcp-tools)), so a fact saved here is searchable by agents, and the reverse.

<Note>

Memory is always on. Search uses full-text matching, plus vector matching when an embedding provider is available; without one, `vector` and `hybrid` searches fall back to full text. `GET /api/memory/provider` shows which provider is in use and why.

</Note>

The `GET` routes check their query string as strictly as the `POST` routes check their bodies, so an out-of-range `limit` or an empty `query` is a **400**. Every route is on the general rate tier except `POST /api/memory/embedding/reindex` and `POST /api/memory/embedding/install`, which are on the sensitive tier (see [rate limits](/reference/rest-api/index#rate-limits)).

## Routes

| Method | Path                            | Summary                                                              | Stream? |
| ------ | ------------------------------- | -------------------------------------------------------------------- | ------- |
| GET    | `/api/memory`                   | Search facts (full text, vector or hybrid), optionally scoped        | No      |
| POST   | `/api/memory`                   | Save a fact (the default) or a procedure                             | No      |
| GET    | `/api/memory/browse`            | List recent facts and procedures, optionally scoped                  | No      |
| GET    | `/api/memory/graph`             | The graph: nodes, edges and communities (`?limit=` 1 to 500, scoped) | No      |
| POST   | `/api/memory/feedback`          | Record an outcome on a fact: `useful`, `dead_end` or `corrected`     | No      |
| GET    | `/api/memory/outcomes`          | A fact's outcome trail (`?factId=&limit=` up to 200)                 | No      |
| GET    | `/api/memory/provider`          | The embedding provider, and why it is or is not usable               | No      |
| POST   | `/api/memory/embedding/reindex` | Re-check the provider and index facts it has no vector for           | No      |
| POST   | `/api/memory/embedding/install` | Install the embedding model through the local Ollama                 | SSE     |

<Info>

Saving runs a fact's `title` and `content`, and a procedure's `content`, through a secret scrubber before anything is embedded or stored. Text that looks like a credential (API keys, tokens, `NAME_KEY=value` pairs, PEM blocks) is replaced with `[REDACTED]`. The scrubber matches patterns, so a secret in an unusual shape can still get through: keep secrets out of memory.

</Info>

---

## `GET /api/memory`

Searches stored facts. The query string is checked with the same rules as the agents' `memory_search` tool. Each result is a fact with a `score` from 0 to 1 and a `matchedVia` field saying how it matched.

- **Query params**

| Param     | Type                            | Required | Notes                                                                                                                             |
| --------- | ------------------------------- | -------- | --------------------------------------------------------------------------------------------------------------------------------- |
| `query`   | string                          | Yes      | 1 to 2000 chars (a missing or blank query is a 400)                                                                               |
| `mode`    | `'fts' \| 'vector' \| 'hybrid'` | No       | Default: `hybrid` if an embedding provider resolved, else `fts`. `vector`/`hybrid` degrade to `fts` when no provider is reachable |
| `limit`   | integer                         | No       | 1 to 100; default `10`                                                                                                            |
| `teamId`  | string                          | No       | Scope filter (see scope note below)                                                                                               |
| `agentId` | string                          | No       | Scope filter (see scope note below)                                                                                               |

- **Request body**: none.

<Note>

**Scope is inclusive.** A query scoped by `teamId` or `agentId` also sees global facts (those saved with no scope), so global memory is visible to every scoped search.

</Note>

### Responses

**`200 OK`**: the (possibly empty) result list:

```ts
{
  ok: true
  results: Array<{
    id: string
    title: string
    content: string
    tags: string[]
    scopeAgentId: string | null
    scopeTeamId: string | null
    tenantId: string | null
    createdByAgentId: string | null // provenance: who saved it, when recorded
    createdByRuntime: string | null
    sourceTaskId: string | null
    sourceSessionKey: string | null
    createdAt: number // epoch ms
    updatedAt: number // epoch ms
    score: number // 0..1, higher = more relevant
    matchedVia: 'fts' | 'vector' | 'hybrid'
  }>
  learning: Record<string, LearningEntry> // by fact id: how each result has fared in runs
}
```

`matchedVia` reflects the mode that actually ran, not the mode requested: a `vector`/`hybrid` request with no embedding provider runs as `fts` and reports `matchedVia: 'fts'`. In `hybrid` mode the score blends the cosine similarity (60%) and an FTS-hit signal (40%).

**`400 Bad Request`**: the query failed validation (for example a blank `query`, a `limit` outside 1 to 100, or an unknown `mode`):

```json
{ "error": "invalid query", "details": { "...": "zod flatten output" } }
```

**`500 Internal Server Error`**: any failure running the search:

```json
{ "error": "<message>" }
```

### Example

```bash
curl 'http://localhost:18790/api/memory?query=deploy%20checklist&mode=hybrid&teamId=<team-uuid>&limit=5'
```

---

## `POST /api/memory`

Saves a memory entry: a **fact** (the default, when `kind` is left out or is `"fact"`) or a **procedure** (`kind: "procedure"`). A fact is a lasting statement ("The client prefers short answers"); a procedure is named how-to text that keeps every version. Saving a procedure under a name and scope that already exist adds a new version (the highest version plus 1) instead of overwriting.

Entries saved here record `createdByRuntime: 'user'` and no agent, so you can tell them apart from what agents save.

- **Path/query params**: none.
- **Request body**: one of:

**Fact (default):**

```ts
{
  kind?: 'fact'                     // optional; absence means fact
  title: string                     // 1 to 500 chars
  content: string                   // 1 to 50,000 chars
  tags?: string[]                   // up to 50 tags, each up to 100 chars
  scope?: {
    agentId?: string | null
    teamId?: string | null
    tenantId?: string | null
  }
}
```

**Procedure:**

```ts
{
  kind: 'procedure'                 // required discriminant
  name: string                      // 1 to 200 chars
  content: string                   // 1 to 100,000 chars
  scope?: {
    agentId?: string | null
    teamId?: string | null
    tenantId?: string | null
  }
}
```

### Responses

**`200 OK`**: a fact was saved. It is embedded when a provider is available; a failed embedding never blocks the save:

```ts
{
  ok: true
  fact: {
    id: string
    title: string                  // scrubbed
    content: string                // scrubbed
    tags: string[]
    scopeAgentId: string | null
    scopeTeamId: string | null
    tenantId: string | null
    createdByAgentId: string | null   // null for a save through this route
    createdByRuntime: string | null   // 'user' for a save through this route
    sourceTaskId: string | null
    sourceSessionKey: string | null
    createdAt: number              // epoch ms
    updatedAt: number              // epoch ms
  }
}
```

**`200 OK`**: a procedure was saved (`kind: 'procedure'`):

```ts
{
  ok: true
  procedure: {
    id: string
    name: string
    version: number // the previous highest version + 1
    content: string // scrubbed
    scopeAgentId: string | null
    scopeTeamId: string | null
    tenantId: string | null
    createdByAgentId: string | null // null for a save through this route
    createdByRuntime: string | null // 'user' for a save through this route
    sourceTaskId: string | null
    sourceSessionKey: string | null
    createdAt: number // epoch ms
  }
}
```

**`400 Bad Request`**: the body failed validation (for example a `title` or `content` that is too long, too many tags, or a procedure with no `name`):

```json
{ "error": "invalid body", "details": { "...": "zod flatten output" } }
```

**`500 Internal Server Error`**: any failure writing the entry:

```json
{ "error": "<message>" }
```

### Example

```bash
# Save a team-scoped fact
curl -X POST http://localhost:18790/api/memory \
  -H 'Content-Type: application/json' \
  -d '{"title":"Release cadence","content":"Ship on Thursdays.","tags":["process"],"scope":{"teamId":"<team-uuid>"}}'

# Save a procedure (a repeat name and scope adds a version)
curl -X POST http://localhost:18790/api/memory \
  -H 'Content-Type: application/json' \
  -d '{"kind":"procedure","name":"deploy-runbook","content":"1. Run the tests. 2. Tag the release."}'
```

---

## `GET /api/memory/browse`

Lists the most recent facts (newest `updatedAt` first) and procedures (newest first, one row per version). Facts are scoped the same inclusive way as search. Procedures are filtered by `teamId` only: `agentId` does not narrow them.

- **Query params**

| Param     | Type    | Required | Notes                                                                  |
| --------- | ------- | -------- | ---------------------------------------------------------------------- |
| `limit`   | integer | No       | 1 to 200; default `10` (applied to facts and to procedures separately) |
| `teamId`  | string  | No       | Scope filter (inclusive of global rows)                                |
| `agentId` | string  | No       | Scope filter (inclusive of global rows)                                |

- **Request body**: none.

### Responses

**`200 OK`**: facts and procedures side by side:

```ts
{
  ok: true
  facts: Array<{
    id: string
    title: string
    content: string
    tags: string[]
    scopeAgentId: string | null
    scopeTeamId: string | null
    tenantId: string | null
    createdByAgentId: string | null
    createdByRuntime: string | null
    sourceTaskId: string | null
    sourceSessionKey: string | null
    createdAt: number
    updatedAt: number
  }>
  procedures: Array<{
    id: string
    name: string
    version: number
    content: string
    scopeAgentId: string | null
    scopeTeamId: string | null
    tenantId: string | null
    createdByAgentId: string | null
    createdByRuntime: string | null
    sourceTaskId: string | null
    sourceSessionKey: string | null
    createdAt: number
  }>
  learning: Record<string, LearningEntry> // by fact id
}
```

**`400 Bad Request`**: `limit` out of the `1..200` range:

```json
{ "error": "invalid query", "details": { "...": "zod flatten output" } }
```

**`500 Internal Server Error`**: any failure reading the store:

```json
{ "error": "<message>" }
```

### Example

```bash
curl 'http://localhost:18790/api/memory/browse?teamId=<team-uuid>&limit=50'
```

---

## `GET /api/memory/graph`

The store as a graph: facts and procedures are nodes, joined by similarity, shared-tag and version edges and grouped into communities. Every edge comes from something stored.

- **Query params**: `limit` (1 to 500 facts, newest first), `teamId`, `agentId` (scope, as for search).

**`200 OK`**:

```ts
{
  ok: true
  graph: {
    nodes: MemoryGraphNode[] // facts and procedures; a procedure is one node however many versions.
    // A fact with hasEmbedding false carries embedSkipped: true when the provider turned it down,
    // so a client can tell "not indexed yet" from "never will be".
    edges: Array<{ id: string; source: string; target: string; kind: 'similarity' | 'tag' | 'version'; weight: number; sharedTags: string[] }>
    communities: Array<{ id: number; label: string; size: number }> // id is positional: not stable across payloads
    totalFacts: number
    totalProcedures: number
    truncated: boolean
    similarityAvailable: boolean // at least two facts carry vectors from the same model
  }
  provider: { id: string; dimensions: number } | null
}
```

**`400 Bad Request`**: `{ "error": "invalid query", "details": { ... } }`.

---

## `POST /api/memory/feedback`

Records how a fact worked out. Outcomes feed the `learning` entry returned with each fact by search and browse. `factId` can be the full id, or a prefix of at least 8 characters that matches exactly one fact.

- **Body**: `{ factId: string; outcome: 'useful' | 'dead_end' | 'corrected'; note?: string; scope?: { teamId?, agentId? } }`. `corrected` requires a `note`.

**`200 OK`**: `{ ok: true, outcome: MemoryOutcome, learning: LearningEntry }`, the recorded outcome and the fact's updated learning entry.

**`400 Bad Request`**: `{ "error": "invalid body", "details": { ... } }`, or `{ "error": "corrected requires a note" }`.

**`404 Not Found`**: `{ "error": "unknown fact" }`.

---

## `GET /api/memory/outcomes`

Every outcome recorded for one fact, newest first. `factId` can be a prefix, as for feedback.

- **Query params**: `factId` (required), `limit` (1 to 200).

**`200 OK`**: `{ ok: true, factId: string, outcomes: MemoryOutcome[] }`, where each outcome is `{ id, factId, outcome, note, agentId, teamId, taskId, runtime, createdAt }`.

**`400 Bad Request`**: `{ "error": "invalid query", "details": { ... } }`.

**`404 Not Found`**: `{ "error": "unknown fact" }`.

---

## `GET /api/memory/provider`

Reports the embedding provider behind vector and hybrid search and the graph's similarity links, and why it is the one in use. Providers are tried in this order:

1. Ollama at `http://localhost:11434` with the `nomic-embed-text` model installed. This address is fixed: `OLLAMA_BASE_URL`, which Clawboo Native honors, is not used for embeddings.
2. OpenAI, with `OPENAI_API_KEY` from the server's environment or a key saved under **Providers**. OpenClaw's `~/.openclaw/.env` is not read.
3. None: search uses full text only.

Two rules apply on top of that order:

- **Ollama without the model cannot embed.** With no OpenAI key this is reported as `ollama-model-missing`. With a key, OpenAI serves, and `missingModel` names the model whose install would move embeddings onto this machine.
- **Local first.** Once any fact holds an Ollama vector, an OpenAI key is not used on its own, and an Ollama that stops answering is reported as `ollama-unreachable` instead of being replaced quietly.

To use OpenAI during such an outage, send `POST /api/memory/embedding/reindex` with `allowRemote: true`. That choice lasts until one of these happens:

- any Clawboo process (the server, or the stdio Memory server) finds Ollama serving again;
- the OpenAI key is disconnected under **Providers** or **Runtimes**;
- a check finds no OpenAI key at all (a key store that failed to read does not count).

A pending `reembedAll` is dropped along with it.

`CLAWBOO_DISABLE_EMBEDDINGS=1` turns embeddings off: `provider` is `null` and `status.state` is `disabled`.

The server re-checks the provider on its own, whether or not anything reads this route:

| Situation                                                        | Next check       |
| ---------------------------------------------------------------- | ---------------- |
| No provider can serve, or OpenAI is standing in                  | Every 30 seconds |
| Ollama is serving                                                | Every 10 minutes |
| An embedding call failed, or a key was connected or disconnected | Straight away    |

A disconnected key stops being used at once, including by Memory MCP sessions already open, which ask for the current provider on every call. Reading this route while facts wait to be indexed also starts indexing them, unless the last attempt failed within the past minute.

- **Path/query params**: none.
- **Request body**: none.

### Responses

**`200 OK`**: `provider` keeps its original shape (and is `null` whenever `status.state` is not `ready`); `status` explains it:

```ts
{
  provider: { id: string; dimensions: number } | null // e.g. 'ollama:nomic-embed-text', 'openai:text-embedding-3-small'
  status: {
    state: 'ready' | 'ollama-model-missing' | 'ollama-unreachable' | 'none' | 'disabled'
    provider: { id: string; dimensions: number } | null
    remote: boolean // the provider sends fact text off this machine
    missingModel: string | null // a model whose install is a fix: none can embed without it, or it would move embeddings local
    remoteAvailable: boolean // an OpenAI key exists that local-first is deliberately not using
    pending: number | null // facts the running pass (else an automatic one) would index; null with no provider
    factCount: number // every fact in the store: the scale of what switching to OpenAI sends
    localFirst: boolean // the store has had local vectors; a remote provider serving is the user's choice
    vectorsWritten: number // vectors written by indexing since the server started; only grows
    skipped: number // facts the provider turned down (they still match by keyword)
    indexing: boolean // a background indexing pass is running
    installing: boolean // a model install is running
    lastError: string | null // the most recent embedding or indexing failure
  }
}
```

With a remote provider, `pending` counts only facts that have no vector at all: an automatic pass never re-uploads facts another provider already indexed. The exception is a switch the user asked for (`reembedAll`) that has not finished: until it has, `pending` also counts the facts still carrying another provider's vectors, and automatic retries carry on with them.

**`500 Internal Server Error`**: an unexpected failure:

```json
{ "error": "<message>" }
```

### Example

```bash
curl http://localhost:18790/api/memory/provider
```

---

## `POST /api/memory/embedding/reindex`

Re-checks the provider straight away and starts indexing every fact that has no vector, including facts the provider turned down before. In the background it sends the provider one short fixed string (never fact text), so a provider that has recovered stops reporting its last failure. Indexing runs in the background, newest facts first, and never changes a fact's `updatedAt`.

**Rate tier: sensitive** (60 requests a minute, shared with the other sensitive routes).

- **Request body** (optional): `{ allowRemote?: boolean; reembedAll?: boolean }`.
  - `allowRemote: true` records the choice to use an OpenAI key although the store was indexed locally (see `GET /api/memory/provider` for when the choice ends).
  - `reembedAll: true` also replaces vectors another provider made, which an automatic pass never does for a remote provider. The request stays pending for the provider it found until every fact is re-indexed: it survives a pass that fails partway and a server restart, and is dropped once another provider takes over.

### Responses

**`202 Accepted`**: indexing started, or there was nothing to do. Poll `GET /api/memory/provider` for progress:

```ts
{
  status: EmbeddingStatus
} // the same shape as GET /api/memory/provider's `status`
```

**`500 Internal Server Error`**: the re-check or the status read failed:

```json
{ "error": "<message>" }
```

### Example

```bash
curl -X POST http://localhost:18790/api/memory/embedding/reindex
```

---

## `POST /api/memory/embedding/install`

Asks the local Ollama to download the embedding model (through Ollama's own `/api/pull`) and streams the progress as Server-Sent Events. The model is always `nomic-embed-text`; any request body is ignored. On success the provider is re-checked, which starts indexing the store. Closing the connection cancels the download; Ollama keeps what it already fetched.

**Rate tier: sensitive** (60 requests a minute, shared with the other sensitive routes), because it downloads over the network.

- **Request body**: none.

### Responses

**`409 Conflict`** (JSON, not a stream): there is nothing to install, because `status.missingModel` is `null` (Ollama is not running, or already has the model). `state` is the current `status.state`, or `unknown` when the status check itself failed:

```json
{
  "error": "nothing to install",
  "detail": "Ollama is not running, or already has the embedding model",
  "state": "ready"
}
```

**`200 OK`** (`text/event-stream`): one `data:` frame per event:

```ts
{ type: 'progress'; message: string; completed?: number; total?: number } // bytes of the model layer only
{ type: 'complete'; status: EmbeddingStatus } // installed and re-checked
{ type: 'error'; code: 'PULL_FAILED' | 'IN_PROGRESS' | 'CANCELLED'; message: string }
```

`message` is a plain phrase (`Preparing the download`, `Downloading`, `Verifying`, `Finishing`). Byte counts follow the largest layer only, so the percentage does not restart for each small file after the model. A stream that ends without Ollama reporting success is an `error`, never a `complete`. `IN_PROGRESS` means another install is already running.

### Example

```bash
curl -N -X POST http://localhost:18790/api/memory/embedding/install
```

## Error envelope

Most error bodies are `{ "error": "<message>" }`. The validating routes (search, save, browse, graph, feedback, outcomes) add `details`, the zod `flatten()` output, on a `400`: `{ "error": "invalid query", "details": { ... } }`. The install route's `409` carries `detail` and `state` instead, since nothing in the request was wrong.

## Related

- [Memory](/concepts/memory): what facts and procedures are, scopes, and how agents use them.
- [Memory panel](/using/memory): search, save and browse from the dashboard.
- [MCP tools](/reference/mcp-tools): the Memory tools agents call against the same store.
- [Tools and MCP API](/reference/rest-api/tools-and-mcp): attach the Memory MCP server to an agent.
- [@clawboo/db](/reference/packages/db): `SqliteMemoryStore` and the memory schemas.
