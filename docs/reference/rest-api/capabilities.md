---
title: Capabilities API
description: "REST reference for the unified capability inventory: list every runtime's skills, tools, and connectors, and act on the manageable ones."
---

REST surface for the unified [capability inventory](/concepts/capabilities): one merged stream of every skill, tool, and connector across all five runtimes, plus a single manageability-gated action endpoint. `GET /api/capabilities` is the one read both the Ghost Graph and the Capabilities dashboard consume; `POST /api/capabilities/:action` installs a curated skill or connector, toggles a manageable capability, or resolves a pending tool-call approval.

The read fans a `CapabilityMultiplexer` over five per-runtime `CapabilitySource` adapters (`native`, `hermes`, `claude-code`, `codex`, `openclaw`), persists each OK source's records, and serves last-good rows for any degraded source, so a blipped Gateway never blanks the inventory. The merged result carries both the records and a per-source read-status list.

<Note>
A capability is acted on by a pure function of its `manageability` tier. `managed` and `external-write` rows are writable; `observe-only` rows (runtime built-ins, external-vendor CLIs) are read-only and reject `enable`/`disable` with **422**. A `runtime-of-record` row may also be non-writable when its source emits `writable: false`. See [Concepts → Capabilities](/concepts/capabilities) for the tier model.
</Note>

The POST body is parsed by `express.json({ limit: '2mb' })`.

## Routes

| Method | Path                        | Summary                                           | Stream? |
| ------ | --------------------------- | ------------------------------------------------- | ------- |
| GET    | `/api/capabilities`         | List the merged capability inventory (filterable) | No      |
| POST   | `/api/capabilities/:action` | `install` \| `enable` \| `disable` \| `approve`   | No      |

---

## `GET /api/capabilities`

Returns the merged `CapabilityRecord[]` plus a `SourceReadStatus[]` for every source. Records are deduplicated by `id` with fresh records winning over stale (last-good) rows, then filtered by the supplied query params. Filtering happens after the merge; an unknown filter value yields an empty `records[]`, not an error.

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
    runtime: 'openclaw' | 'clawboo-native' | 'claude-code' | 'codex' | 'hermes' | 'human' | string
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
    available: boolean // server-evaluated → drives greying
    diagnostics: string[] // why unavailable (e.g. ['auth-missing:openai'])
    provenance: { signerId?: string; signature?: string; signedAt?: number } | null
    status: 'ready' | 'disabled' | 'manageable-but-pending-auth' | 'unavailable'
    writable?: boolean // false → render no Enable/Disable action; defaults to true
    hint?: string // source-supplied affordance (e.g. the auth command)
    tenantId: string | null // dormant multi-tenant seam — always null today
    syncedAt: string // ISO timestamp of the read()
  }>
  sources: Array<{
    sourceId: 'native' | 'hermes' | 'claude-code' | 'codex' | 'openclaw'
    ok: boolean
    degraded: boolean
    reason?: string // e.g. 'gateway_disconnected' | 'home_missing'
    at: number // epoch ms
  }>
}
```

`sources[]` reports each adapter's read outcome. A source with `ok: false, degraded: true` did not read fresh; its records in `records[]` are the last-good rows from the durable table (served unchanged so the inventory stays populated through a disconnect).

**`500 Internal Server Error`**: any failure loading the inventory:

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

A single action endpoint dispatched on the `:action` path segment. `install` adds a curated skill or connector to an agent; `enable`/`disable` toggle an existing manageable capability by its `id`; `approve` resolves a pending tool-call approval. Writes route to the owning source's `write()` through the multiplexer (which is also where the durable audit happens); `approve` reuses the existing approval handshake (`resolveApproval`) and never routes through a source.

- **Path params**: `action` (one of `install` \| `enable` \| `disable` \| `approve`; any other value returns **400**).
- **Request body**: shape depends on `:action` (below).

### Action: `install`

Installs a skill or connector onto an agent. The body is the install spec, accepted either nested under `spec` or as the top-level body. The target agent must exist (an unknown `agentId` would produce an invisible orphan annotation, so it is rejected up front). The owning runtime is resolved authoritatively from the agent row; the client's `runtime` field is a placeholder and is overwritten before the write.

**Request body**:

```ts
{
  // accepted as the top-level body OR nested under `spec`
  via: 'native' | 'hermes' | 'claude-code' | 'codex' | 'openclaw'  // adapter that owns the write
  agentId: string
  runtime: string   // placeholder — server overwrites it from the agent row
  kind: 'skill' | 'tool' | 'connector'
  name: string
  mcpServer?: { name: string; transport: 'stdio' | 'http'; command?: string; args?: string[]; env?: Record<string,string>; url?: string }
  skillContent?: string   // SKILL.md content (injection-scanned before write)
  tenantId?: string | null
}
```

**`400 Bad Request`**: the body is not a valid install spec (missing/non-string `via`, `agentId`, `runtime`, `kind`, or `name`):

```json
{ "error": "install requires a valid spec { via, agentId, runtime, kind, name }" }
```

**`404 Not Found`**: the target `agentId` is not a known agent row:

```json
{ "error": "agent not found" }
```

**`200 OK`**: the capability was installed; the fresh record is returned (or `null` for an acknowledgement that yields no new row):

```ts
{ ok: true, record: CapabilityRecord | null }
```

**`422 Unprocessable Entity`**: the owning source refused the write for its tier (an `UnsupportedCapabilityWriteError`, e.g. an `observe-only` source):

```ts
{ error: "<message>", manageability: 'managed' | 'external-write' | 'runtime-of-record' | 'observe-only' }
```

### Action: `enable` / `disable`

Toggles an existing capability identified by its composite `id`. The handler resolves the row, then enforces the same tier the UI shows: an `observe-only` capability, or any capability whose source marked it `writable: false`, is rejected with **422** before any source write is attempted.

**Request body**:

```ts
{
  id: string
} // the composite capability id, e.g. "native:tool_registry:echo"
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

**`200 OK`**: the toggle was applied; the updated record is returned (or `null`):

```ts
{ ok: true, record: CapabilityRecord | null }
```

### Action: `approve`

Resolves a pending tool-call approval row (the same `tool_call_approvals` handshake the Approvals panel uses, approval ids carry no source prefix, so this is not a source-routed write). The resolve is idempotent: a row already resolved is a no-op and returns the existing row.

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
    createdAt: number
    expiresAt: number
    resolvedAt: number | null
  }
}
```

### Catch-all

**`400 Bad Request`**: `:action` is not one of the four known actions:

```json
{ "error": "unknown action: <action>" }
```

**`404 Not Found`**: the multiplexer routed to an unknown source / unparseable id (an `UnknownCapabilityError` thrown from a write):

```json
{ "error": "<message>" }
```

**`422 Unprocessable Entity`**: a source threw `UnsupportedCapabilityWriteError` (a write aimed at a tier that forbids it):

```ts
{ error: "<message>", manageability: 'managed' | 'external-write' | 'runtime-of-record' | 'observe-only' }
```

**`500 Internal Server Error`**: any other failure:

```json
{ "error": "<message>" }
```

### Examples

```bash
# Install a curated skill on a native agent (server overwrites `runtime` from the agent row)
curl -X POST http://localhost:18790/api/capabilities/install \
  -H 'Content-Type: application/json' \
  -d '{"via":"native","agentId":"native-leader-ab12cd","runtime":"clawboo-native","kind":"skill","name":"web_search"}'

# Disable a manageable capability
curl -X POST http://localhost:18790/api/capabilities/disable \
  -H 'Content-Type: application/json' \
  -d '{"id":"native:tool_registry:delete_path"}'

# Resolve a pending tool-call approval
curl -X POST http://localhost:18790/api/capabilities/approve \
  -H 'Content-Type: application/json' \
  -d '{"id":"<approval-uuid>","decision":"allow_once"}'
```

---

## Error envelope

Every error response on these routes is the standard `{ error: string }` envelope. The two manageability-gated **422** responses additionally carry `manageability` (and, for the `enable`/`disable` pre-check, `writable`) so a client can render the right read-only affordance without a second lookup. The `error` string on a **500** is passed through a display-layer redactor before it is sent.

## See also

- [Capabilities (concept), the inventory + manageability tiers](/concepts/capabilities)
- [Capabilities dashboard (how-to)](/using/capabilities-dashboard)
- [`@clawboo/capability-registry`](/reference/packages/capability-registry), `CapabilityRecord`, the `CapabilitySource` trait, the multiplexer
- [Tools & MCP API](/reference/rest-api/tools-and-mcp), the brokered tools + the approval queue this `approve` action resolves
- [Governance API](/reference/rest-api/governance), delegation approvals share the same `tool_call_approvals` table
- [REST API overview](/reference/rest-api/index)
