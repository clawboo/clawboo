---
title: 'Capabilities API'
sidebarTitle: 'Capabilities'
description: "REST reference for the capability inventory: list every runtime's skills, tools and connectors, install or toggle manageable ones, and answer approvals."
keywords: ['capabilities', 'skills', 'tools', 'connectors', 'inventory', 'manageability']
---

These two routes serve the [capability inventory](/concepts/capabilities): one merged list of every skill, tool and connector across the five runtimes and Clawboo's own connectors. `GET /api/capabilities` is the read behind the Org chart and the **Capabilities** panel. `POST /api/capabilities/:action` installs a curated skill or connector, turns a manageable capability on or off, or answers a pending tool-call approval.

The read asks six sources (`native`, `hermes`, `claude-code`, `codex`, `openclaw`, and `connector` for the MCP connectors Clawboo runs itself) and merges their answers. A source that answers has its rows saved; a source that fails is served from its last saved rows, so a dropped Gateway connection never empties the inventory. The response also says how each source read went.

<Note>

What you can do to a capability depends only on its `manageability` tier. `managed` and `external-write` rows are writable; `observe-only` rows (runtime built-ins, outside command-line tools) are read-only and refuse `enable` and `disable` with **422**. A `runtime-of-record` row can also be read-only when its source marks it `writable: false`. See [Capabilities](/concepts/capabilities) for the tiers.

</Note>

Both routes are on the general rate tier (see [rate limits](/reference/rest-api/index#rate-limits)).

## Routes

| Method | Path                        | Summary                                           | Stream? |
| ------ | --------------------------- | ------------------------------------------------- | ------- |
| GET    | `/api/capabilities`         | List the merged capability inventory (filterable) | No      |
| POST   | `/api/capabilities/:action` | `install` \| `enable` \| `disable` \| `approve`   | No      |

---

## `GET /api/capabilities`

Returns the merged records and a read status for every source. When two records share an `id`, a fresh one wins over a saved one. Filters apply after the merge, so an unknown filter value returns an empty `records` list, not an error.

This read also writes. It saves every source that answered, and it stamps grant details onto connector records: it creates the owner grant for a connector an agent's own runtime already attaches (create-only, so a grant you revoked stays revoked), and it adds a read-only copy of a connector record for each other agent that holds a grant on it (`synthetic: true`).

- **Path params**: none.
- **Query params**:

| Param     | Type   | Effect                                                                              |
| --------- | ------ | ----------------------------------------------------------------------------------- |
| `runtime` | string | Keep records whose `runtime` matches (e.g. `clawboo-native`, `hermes`, `openclaw`). |
| `kind`    | string | Keep records whose `kind` matches (`skill` \| `tool` \| `connector`).               |
| `scope`   | string | Keep records whose `scope` matches (`team` \| `agent` \| `global`).                 |
| `agentId` | string | Keep records whose `agentId` matches.                                               |

Each param is applied only when present and non-empty; omit all four for the full inventory.

- **Request body**: none.

### Responses

**`200 OK`**: the merged view:

```ts
{
  records: Array<{
    id: string // source-namespaced `${sourceId}:${rawKey}`
    sourceKey: string // natural id inside the owning store
    kind: 'skill' | 'tool' | 'connector'
    runtime: 'openclaw' | 'clawboo-native' | 'claude-code' | 'codex' | 'hermes' | 'human'
    scope: 'team' | 'agent' | 'global'
    agentId: string | null // null for team/global scope
    source:
      | 'brokered-mcp'
      | 'curated-skill'
      | 'filesystem-skill-md'
      | 'mcp-connector'
      | 'runtime-builtin'
      | 'openclaw-extension'
      | 'external-vendor-cli'
    manageability: 'managed' | 'external-write' | 'runtime-of-record' | 'observe-only'
    name: string
    description: string
    availability:
      | { auth: string }
      | { config: string }
      | { env: string }
      | { plugin: string }
      | { allOf: unknown[] }
      | { anyOf: unknown[] }
      | null // null when always-available
    available: boolean // the requirement is met; false renders the row greyed out
    diagnostics: string[] // why unavailable (e.g. ['auth-missing:openai'])
    provenance: { signerId?: string; signature?: string; signedAt?: number } | null
    status: 'ready' | 'disabled' | 'manageable-but-pending-auth' | 'unavailable'
    writable?: boolean // false: no Enable or Disable action; defaults to true
    hint?: string // a hint from the source, e.g. the command that signs it in
    tenantId: string | null // always null
    syncedAt: string // ISO timestamp of the read
    // Connector and grant fields (present on connector records, absent elsewhere)
    connectorId?: string | null // the connector this record came from
    grantId?: string | null // the grant that lets this agent use it
    grantState?: 'proposed' | 'active' | 'suspended' | 'revoked' | 'expired'
    grantMode?: 'read' | 'write' | 'admin'
    grantCount?: number // how many agents hold a grant on it
    health?: 'unknown' | 'ok' | 'needs-auth' | 'degraded' | 'error' | 'drift'
    healthDetail?: string | null // one line on a health other than ok
    lastUsedAt?: string | null // ISO timestamp of the last successful use
    pendingApprovals?: number // calls under this grant waiting for a person
    trifecta?: { readsPrivateData: boolean; ingestsUntrustedContent: boolean; canEgress: boolean }
    synthetic?: true // a copy for an agent that holds a grant; it is not a stored row
  }>
  sources: Array<{
    sourceId: 'native' | 'hermes' | 'claude-code' | 'codex' | 'openclaw' | 'connector'
    ok: boolean
    degraded: boolean
    reason?: string // e.g. 'gateway_disconnected' | 'home_missing'
    at: number // epoch ms
  }>
}
```

`sources` reports how each source read went. A source with `ok: false, degraded: true` did not answer; its records are the last saved rows, served unchanged so the inventory stays filled through a disconnect.

`health: 'drift'` means the connector's tool list no longer matches the one that was approved: re-check what changed before trusting it again. `trifecta` marks which of three risks a connector brings: reading private data, taking in untrusted content, and sending data out. All three together is the combination to watch.

**`500 Internal Server Error`**: any failure loading the inventory (the message is redacted):

```json
{ "error": "<message>" }
```

### Example

```bash
# Full inventory
curl http://localhost:18790/api/capabilities

# Only Hermes connectors
curl 'http://localhost:18790/api/capabilities?runtime=hermes&kind=connector'
```

---

## `POST /api/capabilities/:action`

One route for four actions, chosen by the `:action` segment. `install` adds a curated skill or connector to an agent; `enable` and `disable` turn an existing manageable capability on or off by its `id`; `approve` answers a pending tool-call approval. `install`, `enable` and `disable` go to the source that owns the capability, which also writes the audit record. `approve` updates the approval row directly.

- **Path params**: `action` (one of `install` \| `enable` \| `disable` \| `approve`; any other value returns **400**).
- **Request body**: shape depends on `:action` (below).

### Action: `install`

Installs a skill or connector on an agent. Send the install spec as the body, or nested under `spec`. The agent must exist (an unknown `agentId` is a **404**). The server takes the agent's runtime from its own record, so the `runtime` you send is replaced before the write.

**Request body**:

```ts
{
  // accepted as the top-level body OR nested under `spec`
  via: 'native' | 'hermes' | 'claude-code' | 'codex' | 'openclaw' | 'connector' // the source that does the write; 'connector' always answers 422
  agentId: string
  runtime: string   // required, but replaced with the agent's own runtime
  kind: 'skill' | 'tool' | 'connector'
  name: string
  mcpServer?: { name: string; transport: 'stdio' | 'http'; command?: string; args?: string[]; env?: Record<string,string>; url?: string }
  skillContent?: string   // SKILL.md content
  tenantId?: string | null
}
```

With `via: 'native'`, `name` and `skillContent` are scanned for prompt injection, and any `mcpServer` command, arguments and environment are scanned more strictly. A blocked install writes an `install` audit row and answers **500** with `Error: capability blocked: injection / supply-chain finding`.

**`400 Bad Request`**: the body is not a valid install spec (`via`, `agentId`, `runtime`, `kind` or `name` missing or not a string):

```json
{ "error": "install requires a valid spec { via, agentId, runtime, kind, name }" }
```

**`404 Not Found`**: no agent with that `agentId`:

```json
{ "error": "agent not found" }
```

**`200 OK`**: the capability was installed; the fresh record is returned (or `null` for an acknowledgement that yields no new row):

```ts
{ ok: true, record: CapabilityRecord | null }
```

**`422 Unprocessable Entity`**: the owning source does not take this write for its tier (for example `via: 'connector'`, or an `observe-only` source):

```ts
{ error: "<message>", manageability: 'managed' | 'external-write' | 'runtime-of-record' | 'observe-only' }
```

**`503 Service Unavailable`**: an install through OpenClaw while the Gateway connection is down:

```json
{ "error": "gateway_disconnected" }
```

### Action: `enable` / `disable`

Turns an existing capability on or off by its `id`. The route looks the row up first and applies the same tier the panel shows: an `observe-only` capability, or one its source marked `writable: false`, is refused with **422** before anything is written.

**Request body**:

```ts
{
  id: string
} // the capability id, e.g. "native:tool_registry:echo"
```

**`400 Bad Request`**: missing `id`:

```json
{ "error": "enable requires { id }" }
```

(For `disable`, the message reads `disable requires { id }`.)

**`404 Not Found`**: no capability row with that `id`:

```json
{ "error": "capability not found" }
```

**`422 Unprocessable Entity`**: the capability cannot be modified (`observe-only`, or `writable === false`):

```ts
{
  error: 'capability cannot be modified',
  manageability: 'managed' | 'external-write' | 'runtime-of-record' | 'observe-only',
  writable: boolean
}
```

**`503 Service Unavailable`**: the tier allowed the write, but the owning source is OpenClaw and the Gateway connection is down:

```json
{ "error": "gateway_disconnected" }
```

**`200 OK`**: the toggle was applied; the updated record is returned (or `null`):

```ts
{ ok: true, record: CapabilityRecord | null }
```

### Action: `approve`

Answers a pending tool-call approval: the same `tool_call_approvals` rows the approval cards on the board and in chat answer. Answering a row that is already resolved changes nothing and returns the row as it is.

An `allow_always` on an approval tied to a connector grant also saves a standing rule that allows that tool, with any arguments, for 30 days, unless the prompt marked the call as one that cannot be remembered (`neverRemember`).

This action only updates the row. An approval of `kind: 'exec'` (an OpenClaw shell command the Gateway is holding) is not released by it; answer those with `POST /api/tools/approvals/:id/resolve` (see [Tools and MCP](/reference/rest-api/tools-and-mcp)), which also tells the Gateway.

**Request body**:

```ts
{
  id: string // approval id
  decision: 'allow_once' | 'allow_always' | 'deny'
}
```

**`400 Bad Request`**: missing `id` or a `decision` outside the allowed set:

```json
{ "error": "approve requires { id, decision }" }
```

**`404 Not Found`**: no approval row with that `id`:

```json
{ "error": "approval not found" }
```

**`200 OK`**: the approval was resolved; the row is returned:

```ts
{
  ok: true,
  approval: {
    id: string
    toolName: string
    agentId: string | null
    argsSummary: string | null   // scrubbed JSON
    reason: string | null
    status: 'pending' | 'allow_once' | 'allow_always' | 'deny' | 'expired'
    taskId: string | null
    tenantId: string | null
    grantId: string | null // the connector grant the call ran under
    connectorId: string | null
    neverRemember: 0 | 1 // 1: an "Always" answer saves no standing rule
    ruleReason: string | null // why the call needed approval, e.g. 'lethal-trifecta'
    toolClass: string | null // 'read' | 'write' | 'destructive'
    toolSummary: string | null // the tool's own one-line description
    kind: 'tool' | 'exec' // exec = an OpenClaw shell command held by the Gateway
    createdAt: number // epoch ms
    expiresAt: number // epoch ms
    resolvedAt: number | null // epoch ms
  }
}
```

### Catch-all

**`400 Bad Request`**: `:action` is not one of the four known actions:

```json
{ "error": "unknown action: <action>" }
```

**`404 Not Found`**: the write named an unknown source or a capability id that cannot be parsed:

```json
{ "error": "<message>" }
```

**`422 Unprocessable Entity`**: the owning source does not take this write for its tier:

```ts
{ error: "<message>", manageability: 'managed' | 'external-write' | 'runtime-of-record' | 'observe-only' }
```

**`503 Service Unavailable`**: the write needed the OpenClaw Gateway and its connection is down:

```json
{ "error": "gateway_disconnected" }
```

**`500 Internal Server Error`**: any other failure (the message is redacted):

```json
{ "error": "<message>" }
```

### Examples

```bash
# Install a curated skill on a native agent (the server replaces `runtime` with the agent's own)
curl -X POST http://localhost:18790/api/capabilities/install \
  -H 'Content-Type: application/json' \
  -d '{"via":"native","agentId":"native-leader-ab12cd","runtime":"clawboo-native","kind":"skill","name":"web_search"}'

# Disable a manageable capability
curl -X POST http://localhost:18790/api/capabilities/disable \
  -H 'Content-Type: application/json' \
  -d '{"id":"native:tool_registry:delete_path"}'

# Answer a pending tool-call approval
curl -X POST http://localhost:18790/api/capabilities/approve \
  -H 'Content-Type: application/json' \
  -d '{"id":"<approval-uuid>","decision":"allow_once"}'
```

---

## Error envelope

Most error bodies are `{ "error": "<message>" }`. The two tier `422`s add `manageability`, and the `enable` and `disable` check also adds `writable`, so a client can show the read-only state without a second lookup. A `503` means the tier allowed the write but the owning source could not reach its runtime: retry after the Gateway reconnects. A `500` message is redacted before it is sent.

## Related

- [Capabilities](/concepts/capabilities): the inventory and the manageability tiers.
- [Capabilities panel](/using/capabilities): the dashboard view over these routes.
- [Connectors API](/reference/rest-api/connectors): connect and disconnect connectors, and manage grants.
- [Tools and MCP API](/reference/rest-api/tools-and-mcp): the brokered tools, and the approval queue `approve` answers.
- [Governance API](/reference/rest-api/governance): delegation approvals use the same `tool_call_approvals` table.
- [@clawboo/capability-registry](/reference/packages/index#capability-registry): the `CapabilityRecord` type and the source interface.
