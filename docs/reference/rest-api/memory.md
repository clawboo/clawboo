---
title: Memory API
description: 'REST reference for the memory resource group: search, save, browse, the graph, feedback, and embeddings (status, reindexing, installing the model).'
---

REST surface for the shared [memory](/concepts/memory) tier: search the 2-tier store (declarative **facts** + versioned **procedures**), save a fact or a procedure, browse what is stored, read the graph and record feedback, and inspect and repair the embeddings behind vector/hybrid search and similarity links. This is the UI-facing half of the memory dual surface; the model-facing half is the [Memory MCP server](/reference/rest-api/tools-and-mcp). Both halves share one `SqliteMemoryStore` over the same SQLite file, so a fact saved here is searchable from a runtime's Memory tool and vice versa.

<Note>
Memory is always on; these routes are not flag-gated. The store is FTS5 (full-text) plus an optional vector index. Vector and hybrid search require a reachable embedding provider; when none resolves, they degrade to FTS automatically. See [`GET /api/memory/provider`](#get-apimemoryprovider) to inspect the active provider.
</Note>

The POST routes read a JSON body parsed by `express.json({ limit: '2mb' })`. The GET routes read their inputs from the query string, then validate them against the same zod schemas the save body uses, so an out-of-range `limit` or empty `query` is a **400**.

## Routes

| Method | Path                            | Summary                                                              | Stream? |
| ------ | ------------------------------- | -------------------------------------------------------------------- | ------- |
| GET    | `/api/memory`                   | Search facts (fts / vector / hybrid), scoped                         | No      |
| POST   | `/api/memory`                   | Save a fact (default) or a procedure (discriminated)                 | No      |
| GET    | `/api/memory/browse`            | List recent facts + procedures, scoped                               | No      |
| GET    | `/api/memory/graph`             | The graph: nodes, edges and communities (`?limit=` 1 to 500, scoped) | No      |
| POST   | `/api/memory/feedback`          | Record an outcome on a fact: `useful`, `dead_end` or `corrected`     | No      |
| GET    | `/api/memory/outcomes`          | A fact's outcome trail (`?factId=&limit=` up to 200)                 | No      |
| GET    | `/api/memory/provider`          | The embedding provider, and why it is or is not usable               | No      |
| POST   | `/api/memory/embedding/reindex` | Re-check the provider and index facts it has no vector for           | No      |
| POST   | `/api/memory/embedding/install` | Install the embedding model through the local Ollama                 | SSE     |

<Info>
Save scrubs secrets at the write boundary: a fact's `title`/`content` and a procedure's `content` are passed through a secret scrubber before they are embedded and inserted. A credential can never land in a durable, searchable, or auto-injectable fact regardless of who wrote it.
</Info>

---

## `GET /api/memory`

Searches stored facts. The handler reads `query`, `mode`, `limit`, `teamId`, and `agentId` from the query string, assembles a `{ query, mode, limit, scope: { teamId, agentId } }` object, and validates it with the same schema the MCP `memory_search` tool uses. Each result is a fact annotated with a `0..1` `score` and a `matchedVia` field recording how it matched.

- **Query params**

| Param     | Type                            | Required | Notes                                                                                                                             |
| --------- | ------------------------------- | -------- | --------------------------------------------------------------------------------------------------------------------------------- |
| `query`   | string                          | Yes      | 1–2000 chars (a missing/blank query is a 400)                                                                                     |
| `mode`    | `'fts' \| 'vector' \| 'hybrid'` | No       | Default: `hybrid` if an embedding provider resolved, else `fts`. `vector`/`hybrid` degrade to `fts` when no provider is reachable |
| `limit`   | integer                         | No       | 1–100; default `10`                                                                                                               |
| `teamId`  | string                          | No       | Scope filter (see scope note below)                                                                                               |
| `agentId` | string                          | No       | Scope filter (see scope note below)                                                                                               |

- **Request body**: none.

<Note>
**Scope is inclusive.** A scoped query (a `teamId` and/or `agentId`) also sees globally-scoped facts (rows with a `null` scope), so global memory is always visible to a scoped search. A `tenantId` scope, if supplied, is strict; but `tenantId` is a dormant multi-tenant seam (a single implicit tenant today).
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

**`400 Bad Request`**: the assembled query object failed validation (e.g. blank `query`, `limit` out of `1..100`, or an unknown `mode`):

```json
{ "error": "invalid query", "details": { "...": "zod flatten output" } }
```

**`500 Internal Server Error`**: any failure constructing the store or running the search:

```json
{ "error": "<message>" }
```

### Example

```bash
curl 'http://localhost:18790/api/memory?query=deploy%20checklist&mode=hybrid&teamId=<team-uuid>&limit=5'
```

---

## `POST /api/memory`

Saves a memory entry. The body is a discriminated union: a **fact** (the default, when `kind` is absent or `"fact"`) or a **procedure** (`kind: "procedure"`). A fact is a durable declarative statement ("User prefers concise responses"); a procedure is a versioned, SKILL-style "how" kept out of the fact store. Saving a procedure under a name+scope that already exists creates a new version (the prior max version `+1`) rather than overwriting.

- **Path/query params**: none.
- **Request body**: one of:

**Fact (default):**

```ts
{
  kind?: 'fact'                     // optional; absence means fact
  title: string                     // 1–500 chars
  content: string                   // 1–50,000 chars
  tags?: string[]                   // up to 50 tags, each ≤100 chars
  scope?: {
    agentId?: string | null
    teamId?: string | null
    tenantId?: string | null        // dormant multi-tenant seam
  }
}
```

**Procedure:**

```ts
{
  kind: 'procedure'                 // required discriminant
  name: string                      // 1–200 chars
  content: string                   // 1–100,000 chars
  scope?: {
    agentId?: string | null
    teamId?: string | null
    tenantId?: string | null
  }
}
```

### Responses

**`200 OK`**: a fact was saved (it is embedded if a provider was available, but the embedding is best-effort and never blocks the write):

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
    version: number // prior max version + 1
    content: string // scrubbed
    scopeAgentId: string | null
    scopeTeamId: string | null
    tenantId: string | null
    createdAt: number // epoch ms
  }
}
```

**`400 Bad Request`**: the body failed the discriminated-union validation (e.g. an over-length `title`/`content`, too many tags, or a procedure missing `name`):

```json
{ "error": "invalid body", "details": { "...": "zod flatten output" } }
```

**`500 Internal Server Error`**: any failure constructing the store or writing the row:

```json
{ "error": "<message>" }
```

### Example

```bash
# Save a team-scoped fact
curl -X POST http://localhost:18790/api/memory \
  -H 'Content-Type: application/json' \
  -d '{"title":"Release cadence","content":"Ship on Thursdays.","tags":["process"],"scope":{"teamId":"<team-uuid>"}}'

# Save a procedure (auto-versions on a repeat name+scope)
curl -X POST http://localhost:18790/api/memory \
  -H 'Content-Type: application/json' \
  -d '{"kind":"procedure","name":"deploy-runbook","content":"1. run tests …"}'
```

---

## `GET /api/memory/browse`

Lists the most recent facts and procedures (facts newest-first by `updatedAt`), scoped the same inclusive way as search. The handler reads `limit`, `teamId`, and `agentId` from the query string, validates them, then fetches facts and procedures in parallel.

- **Query params**

| Param     | Type    | Required | Notes                                                               |
| --------- | ------- | -------- | ------------------------------------------------------------------- |
| `limit`   | integer | No       | 1–200; default `10` (applied to facts and procedures independently) |
| `teamId`  | string  | No       | Scope filter (inclusive of global rows)                             |
| `agentId` | string  | No       | Scope filter (inclusive of global rows)                             |

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

**`500 Internal Server Error`**: any failure constructing the store or reading:

```json
{ "error": "<message>" }
```

### Example

```bash
curl 'http://localhost:18790/api/memory/browse?teamId=<team-uuid>&limit=50'
```

---

## `GET /api/memory/graph`

The store projected as a graph: facts and procedures as nodes, with similarity, shared-tag and version edges, grouped into communities. Every edge maps to something in the store.

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
    similarityAvailable: boolean // some same-model bucket has two or more embedded facts
  }
  provider: { id: string; dimensions: number } | null
}
```

**`400 Bad Request`**: `{ "error": "invalid query", "details": { … } }`.

---

## `POST /api/memory/feedback`

Record how a fact fared, the signal behind the learning pills.

- **Body**: `{ factId: string; outcome: 'useful' | 'dead_end' | 'corrected'; note?: string; scope?: { teamId?, agentId? } }`. `corrected` requires a `note`.

**`200 OK`**: `{ ok: true, outcome: MemoryOutcome, learning: LearningEntry }`, the recorded outcome and the fact's updated learning entry.

**`400 Bad Request`**: `{ "error": "invalid body", "details": { … } }`, or `{ "error": "corrected requires a note" }`.

**`404 Not Found`**: `{ "error": "unknown fact" }`.

---

## `GET /api/memory/outcomes`

A fact's full outcome trail, newest first.

- **Query params**: `factId` (required), `limit` (1 to 200).

**`200 OK`**: `{ ok: true, factId: string, outcomes: MemoryOutcome[] }`, where each outcome is `{ id, factId, outcome, note, agentId, teamId, taskId, runtime, createdAt }`.

**`400 Bad Request`**: `{ "error": "invalid query", "details": { … } }`. **`404 Not Found`**: `{ "error": "unknown fact" }`.

---

## `GET /api/memory/provider`

Reports the embedding provider behind vector/hybrid search and the graph's similarity links, and **why** it is what it is. The resolution order is: an Ollama at `http://localhost:11434` that has `nomic-embed-text` installed, then an OpenAI key (`OPENAI_API_KEY` in the server's environment, or one stored through **Providers**; OpenClaw's `~/.openclaw/.env` is deliberately not consulted), then none.

Two rules sit on top of that order:

- A reachable Ollama is not enough on its own: without the model every embedding call fails. With no OpenAI key that is reported as `ollama-model-missing`; with one, OpenAI serves and `missingModel` says a local install would move embeddings onto this machine.
- Once any fact holds an Ollama vector, the store is local-first: an OpenAI key is not used automatically, and an Ollama that stops answering is reported as `ollama-unreachable` rather than silently replaced. `POST /api/memory/embedding/reindex` with `allowRemote: true` records the choice to use OpenAI for the current outage. It is withdrawn the next time any clawboo process (the dashboard, or the stdio Memory bin) finds Ollama serving, when the OpenAI key is disconnected under Providers or Runtimes, and when a resolution finds no OpenAI key at all (a vault that merely failed to read does not count); a switch still owed is dropped with it.

`CLAWBOO_DISABLE_EMBEDDINGS=1` turns embeddings off: `provider` is `null` and `status.state` is `disabled`.

The server re-checks the answer on its own timer, whether or not anything reads this route: every 30 seconds while no provider can serve or OpenAI is standing in, every 10 minutes while Ollama serves, and straight away after an embedding call fails or a provider key is connected or disconnected. A key that is disconnected stops being used at once, including by MCP sessions that were already open: a Memory session asks for the current provider on every call. Reading this route while facts are waiting to be indexed also starts indexing them, unless the previous attempt failed within the last minute.

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

Re-checks the provider straight away, sends it one short fixed string (never fact text) in the background to confirm it answers, so a provider that has recovered stops reporting its last failure on the next status read, and starts indexing every fact it has no vector for, including facts the provider turned down earlier. Indexing runs in the background, newest facts first, and never changes a fact's `updatedAt`. Rate-limited on the sensitive tier.

- **Request body** (optional): `{ allowRemote?: boolean; reembedAll?: boolean }`. `allowRemote: true` records the choice to use an OpenAI key even though the store was indexed locally; the choice lasts until Ollama is found serving again, the key is disconnected, or no key is available. `reembedAll: true` also replaces vectors another provider produced, which an automatic pass does not do for a remote provider. It is owed to the provider this request resolved until that provider has converged the store: it survives a pass that fails partway and a server restart, and is dropped once another provider takes over.

### Responses

**`202 Accepted`**: indexing was started (or there was nothing to do); poll `GET /api/memory/provider` for progress:

```ts
{
  status: EmbeddingStatus
} // the same shape as GET /api/memory/provider's `status`
```

### Example

```bash
curl -X POST http://localhost:18790/api/memory/embedding/reindex
```

---

## `POST /api/memory/embedding/install`

Installs the embedding model through the local Ollama's own `/api/pull` and streams its progress as server-sent events. The model is fixed server-side (`nomic-embed-text`); any request body is ignored. On success the provider is re-checked, which starts indexing the store. Closing the connection cancels the download. Rate-limited on the sensitive tier, since it downloads over the network.

- **Request body**: none.

### Responses

**`409 Conflict`** (JSON, not a stream): there is nothing to install, because `status.missingModel` is `null` (Ollama is not running, or already has the model):

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

Errors on these routes use the standard envelope `{ error: string }`. The validating routes (search, save, browse, graph, feedback, outcomes) add a `details` field carrying the zod `flatten()` output on a 400, e.g. `{ "error": "invalid query", "details": { … } }`. The install route's 409 carries `detail` and `state` instead, since nothing was malformed.

## See also

- [Memory (concept)](/concepts/memory), the shared tier, FTS5 + vector, scope inclusivity, scrub-on-write
- [Memory browser (UI)](/using/memory-browser), search/save/browse from the dashboard
- [Tools & MCP API](/reference/rest-api/tools-and-mcp), the Memory MCP server (the model-facing half), attach config, transports
- [@clawboo/db](/reference/packages/db), `SqliteMemoryStore`, the `MemoryStore`/`EmbeddingProvider` seams, the memory schemas
- [REST API overview](/reference/rest-api/index)
