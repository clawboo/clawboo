---
title: '@clawboo/capability-registry'
description: Neutral CapabilityRecord types plus the CapabilitySource trait and read-fan-in multiplexer for the unified capability inventory.
---

|                    |                                                                                                                                                   |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Version**        | `0.1.0`                                                                                                                                           |
| **Purity**         | pure zero-dep (browser-safe)                                                                                                                      |
| **Purpose**        | The unified capability-inventory seam: neutral `CapabilityRecord` types + the `CapabilitySource` trait + the read-fan-in `CapabilityMultiplexer`. |
| **Workspace deps** | none                                                                                                                                              |
| **External deps**  | none (runtime). Dev only: `tsup`, `typescript`, `vitest`, `@clawboo/tsconfig`.                                                                    |

clawboo OBSERVES every capability across all five runtimes (OpenClaw, clawboo-native, Claude Code, Codex, Hermes) and MANAGES only what the owning runtime cedes. This package holds ONLY the neutral types, the `CapabilitySource` trait, and the multiplexer; the five concrete server-side adapters live in `apps/web/server/lib/capabilitySource/`. One merged `CapabilityRecord` stream feeds both the Ghost Graph and the Capabilities dashboard. Package shape mirrors [`@clawboo/agent-registry`](/reference/packages/agent-registry); the `read()`-fan-in trait mirrors [`@clawboo/scheduler`](/reference/packages/scheduler).

## Public API

All exports come from the single `.` barrel (`src/index.ts`). No subpath exports.

### Functions

| Export              | Signature                                                                                          | Contract                                                                                                                                                                |
| ------------------- | -------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `makeCapabilityId`  | `(sourceId: CapabilitySourceId, rawKey: string) => string`                                         | Composes the source-namespaced id `${sourceId}:${rawKey}`.                                                                                                              |
| `parseCapabilityId` | `(id: string) => { sourceId: CapabilitySourceId; rawKey: string } \| null`                         | Splits an id back into source + raw key on the FIRST `:` (so a rawKey containing `:` survives); `null` when no known source prefix matches.                             |
| `unsupported`       | `(sourceId: CapabilitySourceId, action: string, manageability?: CapabilityManageability) => never` | The canonical throw every `observe-only` `source.write()` raises; constructs and throws `UnsupportedCapabilityWriteError` (default `manageability` = `'observe-only'`). |

### Classes

| Export                            | Description                                                                                                                                                                                                                                                                                                  |
| --------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `CapabilityMultiplexer`           | The fan-in over registered sources. `register(source)`, `list()`, `get(id)`, `read()` (per-source try/catch → one merged `{ records, sources }`, never rejects), `write(action)` (owner-routed by `spec.via` for install or id-prefix for enable/disable; unknown source → throws `UnknownCapabilityError`). |
| `UnknownCapabilityError`          | `extends Error`. `code = 'unknown_capability'`, `target: string`. Thrown for an action targeting an unknown source or unparseable id. REST maps to **404**.                                                                                                                                                  |
| `UnsupportedCapabilityWriteError` | `extends Error`. `code = 'unsupported_capability_write'`, `sourceId`, `action`, `manageability`. Thrown for a write aimed at a tier that forbids it. REST maps to **422**.                                                                                                                                   |

### Types & interfaces

**Records** (`records.ts`):

| Export                    | Kind      | Contract                                                                                                                                                                                                                                                                                                                                                                           |
| ------------------------- | --------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `CapabilityRecord`        | interface | The normalized capability row every source projects into: superset of `ToolDescriptor` adding `kind`/`runtime`/`scope`/`manageability`. Carries `id`, `sourceKey`, `name`, `description`, `agentId \| null`, `source`, server-evaluated `available` + `diagnostics`, `status`, optional `writable`/`hint`, `provenance \| null`, dormant `tenantId \| null`, and `syncedAt` (ISO). |
| `CapabilitySourceId`      | union     | `'native' \| 'hermes' \| 'claude-code' \| 'codex' \| 'openclaw'`, the five read-adapter / id-prefix keys.                                                                                                                                                                                                                                                                          |
| `CapabilityRuntime`       | union     | Owning runtime, open set: `'openclaw' \| 'clawboo-native' \| 'claude-code' \| 'codex' \| 'hermes' \| 'human' \| (string & {})`. `'human'` is the humans-in-the-graph seam.                                                                                                                                                                                                         |
| `CapabilityKind`          | union     | `'skill' \| 'tool' \| 'connector'`.                                                                                                                                                                                                                                                                                                                                                |
| `CapabilityScope`         | union     | `'team' \| 'agent' \| 'global'`.                                                                                                                                                                                                                                                                                                                                                   |
| `CapabilityManageability` | union     | `'managed' \| 'external-write' \| 'runtime-of-record' \| 'observe-only'`, the tier the UI + `write()` path are a pure function of.                                                                                                                                                                                                                                                 |
| `CapabilityOrigin`        | union     | Where the record was read from: `'brokered-mcp' \| 'curated-skill' \| 'filesystem-skill-md' \| 'mcp-connector' \| 'runtime-builtin' \| 'openclaw-extension' \| 'external-vendor-cli'`.                                                                                                                                                                                             |
| `CapabilityStatus`        | union     | `'ready' \| 'disabled' \| 'manageable-but-pending-auth' \| 'unavailable'`.                                                                                                                                                                                                                                                                                                         |
| `CapabilityAvailability`  | union     | Declarative requirement: `{ auth } \| { config } \| { env } \| { plugin } \| { allOf: [] } \| { anyOf: [] }`. Local structural mirror of `@clawboo/db`'s `AvailabilityRequirement`.                                                                                                                                                                                                |
| `CapabilityProvenance`    | interface | Ed25519 provenance seam: `signerId?`, `signature?`, `signedAt?`.                                                                                                                                                                                                                                                                                                                   |
| `CanonicalMcpServer`      | interface | Runtime-neutral MCP server spec (the transcoder input): `name`, `transport: 'stdio' \| 'http'`, optional `command`/`args`/`env`/`url`.                                                                                                                                                                                                                                             |

**Source trait** (`source.ts`):

| Export                       | Kind      | Contract                                                                                                                                                                                                                               |
| ---------------------------- | --------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `CapabilitySource`           | interface | `readonly id: CapabilitySourceId`; `read(): Promise<CapabilityReadResult>` (NEVER rejects; degradation is the status); `write(action): Promise<CapabilityRecord \| null>` (throws the typed errors; `observe-only` → `unsupported()`). |
| `CapabilityReadResult`       | interface | `{ records: CapabilityRecord[]; status: SourceReadStatus }`.                                                                                                                                                                           |
| `SourceReadStatus`           | interface | `{ sourceId, ok, degraded, reason?, at }`, per-source liveness.                                                                                                                                                                        |
| `CapabilityWriteAction`      | union     | `{ kind: 'install'; spec } \| { kind: 'enable'; id } \| { kind: 'disable'; id }`.                                                                                                                                                      |
| `CapabilityInstallSpec`      | interface | A connector/skill install: `via` (the owning adapter), `agentId`, `runtime`, `kind`, `name`, optional `mcpServer`/`skillContent`, dormant `tenantId?`.                                                                                 |
| `CapabilityApprovalDecision` | union     | `'allow_once' \| 'allow_always' \| 'deny'`, reused by the REST `approve` action (resolves a `tool_call_approvals` row, NOT a source-routed write).                                                                                     |

**Multiplexer** (`registry.ts`):

| Export                 | Kind      | Contract                                                                               |
| ---------------------- | --------- | -------------------------------------------------------------------------------------- |
| `MergedCapabilityRead` | interface | `{ records: CapabilityRecord[]; sources: SourceReadStatus[] }`, the merged read shape. |

## Used by

- `apps/web/server/lib/capabilitySource/`, the five concrete adapters (`native.ts`, `hermes.ts`, `claudeCode.ts`, `codex.ts`, `openclaw.ts`), `registry.ts` (constructs the `CapabilityMultiplexer`), `service.ts`, `mapper.ts`, `helpers.ts`, and `transcoder.ts`.
- `apps/web/server/api/capabilities.ts`, the `/api/capabilities` REST surface.
- `apps/web/src/lib/capabilitiesClient.ts`, the browser client (re-exports `CapabilityRecord`, `SourceReadStatus`).
- `apps/web/src/features/graph/` (`store.ts`, `useGraphData.ts`) and `apps/web/src/features/agent-detail/useMiniGraphData.ts`, the Ghost Graph consumes the same stream.

## Source

Barrel: [`packages/capability-registry/src/index.ts`](https://github.com/clawboo/clawboo/blob/main/packages/capability-registry/src/index.ts) (re-exports `records.ts`, `source.ts`, `errors.ts`, `registry.ts`).

## See also

- [Capabilities concept](/concepts/capabilities), capability inventory + manageability tiers.
- [`/api/capabilities` REST](/reference/rest-api/capabilities), the merged stream + write actions.
- [`@clawboo/agent-registry`](/reference/packages/agent-registry), the package-shape precedent.
- [`@clawboo/scheduler`](/reference/packages/scheduler), the `read()`-fan-in trait precedent.
