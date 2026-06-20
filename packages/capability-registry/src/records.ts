// @clawboo/capability-registry — records.ts
//
// The normalized capability row every CapabilitySource projects into — the
// unified Capability Inventory's lingua franca, feeding BOTH the Ghost Graph
// AND the Capabilities dashboard off ONE stream. A SUPERSET of the
// ToolDescriptor (which already carries availability / owner / risk /
// provenance): this row adds `kind`, `runtime`, `scope`, and `manageability` so
// a brokered MCP tool, a Hermes SKILL.md, an OpenClaw Gateway extension, and a
// runtime built-in are all the same shape. Browser-safe, zero runtime deps —
// the SPA imports these types to type the REST response.

/** The five read()-adapters / multiplexer keys (the `id` namespace prefix). */
export type CapabilitySourceId = 'native' | 'hermes' | 'claude-code' | 'codex' | 'openclaw'

/**
 * Runtime that OWNS the capability. Open set (mirrors the executor RuntimeId).
 * `'human'` is the humans-in-the-graph seam — a human participant slots in
 * as an `observe-only`, `agent`-scoped record with zero special-casing.
 */
export type CapabilityRuntime =
  | 'openclaw'
  | 'clawboo-native'
  | 'claude-code'
  | 'codex'
  | 'hermes'
  | 'human'
  | (string & {})

export type CapabilityKind = 'skill' | 'tool' | 'connector'

export type CapabilityScope = 'team' | 'agent' | 'global'

/**
 * How clawboo may act on this capability. The UI + the write() path are a PURE
 * function of this tier — neither may offer an action the owning runtime forbids.
 * - 'managed'           clawboo fully owns the durable row (brokered tools, curated skills).
 * - 'external-write'    the runtime owns the store; clawboo writes THROUGH it (Hermes mcp.json / SKILL.md).
 * - 'runtime-of-record' the runtime owns it; clawboo drives changes through the runtime's API (OpenClaw config).
 * - 'observe-only'      clawboo can read but never write (built-ins, external-vendor CLIs).
 */
export type CapabilityManageability =
  | 'managed'
  | 'external-write'
  | 'runtime-of-record'
  | 'observe-only'

/** Where the record was read from — drives the manageability + the write route. */
export type CapabilityOrigin =
  | 'brokered-mcp' // the tool_registry brokered tools (managed)
  | 'curated-skill' // the per-agent skills table — a clawboo-managed annotation (managed)
  | 'filesystem-skill-md' // a SKILL.md on disk in a clawboo-owned home (external-write)
  | 'mcp-connector' // an attached MCP server (Hermes mcp.json / Codex toml / Claude inline / OpenClaw mcp.servers)
  | 'runtime-builtin' // a runtime's built-in tool (observe-only)
  | 'openclaw-extension' // OpenClaw plugin / Composio connector / tools.allow (runtime-of-record)
  | 'external-vendor-cli' // an outbound connector seen via a hook (gh, Linear) — observe-only

/**
 * Lifecycle / auth status. `manageable-but-pending-auth` = a REAL, manageable
 * capability that just needs auth (Codex connectors until `codex login`) — NOT
 * broken; the dashboard renders a disabled+hint row.
 */
export type CapabilityStatus = 'ready' | 'disabled' | 'manageable-but-pending-auth' | 'unavailable'

/**
 * Declarative availability — a capability is unavailable (greyed) until its
 * requirement is satisfied. Structural mirror of @clawboo/db's
 * `AvailabilityRequirement`, declared locally so this package stays
 * dependency-free (the same discipline as @clawboo/agent-registry mirroring
 * AGENT_FILE_NAMES). Evaluated server-side into `available` + `diagnostics`.
 */
export type CapabilityAvailability =
  | { auth: string }
  | { config: string }
  | { env: string }
  | { plugin: string }
  | { allOf: CapabilityAvailability[] }
  | { anyOf: CapabilityAvailability[] }

/**
 * The Ed25519 provenance seam — structural mirror of @clawboo/db's
 * `ToolProvenance`. Verification is real but enforcement is off by default;
 * this record just carries it.
 */
export interface CapabilityProvenance {
  signerId?: string
  signature?: string
  signedAt?: number
}

/**
 * A runtime-neutral MCP server spec — the transcoder's canonical INPUT, dialected
 * per runtime on write (Claude inline mcpServers / Codex TOML / Hermes mcp.json).
 * Declared here (browser-safe) so an install spec can carry it.
 */
export interface CanonicalMcpServer {
  name: string
  transport: 'stdio' | 'http'
  command?: string
  args?: string[]
  env?: Record<string, string>
  url?: string
}

export interface CapabilityRecord {
  /** Source-namespaced composite `${sourceId}:${rawKey}`. Opaque to the UI. */
  id: string
  /** The natural identifier inside the owning store (tool name / skill slug / connector id). */
  sourceKey: string
  kind: CapabilityKind
  runtime: CapabilityRuntime
  scope: CapabilityScope
  /** null for team/global scope. */
  agentId: string | null
  source: CapabilityOrigin
  manageability: CapabilityManageability
  /** Display name (already user-facing). */
  name: string
  /** One-line description. */
  description: string
  /** Declarative availability requirement, or null when always-available. */
  availability: CapabilityAvailability | null
  /** Server-evaluated availability → drives greying in BOTH renderers. */
  available: boolean
  /** Why it's unavailable (e.g. ['auth-missing:openai']); empty when available. */
  diagnostics: string[]
  provenance: CapabilityProvenance | null
  status: CapabilityStatus
  /**
   * Whether the OWNING source can actually act on this record. Defaults to true.
   * Set false by a source that emits a row it cannot write (an OpenClaw
   * runtime-of-record connector/plugin whose config.patch write is a follow-up) so
   * the dashboard renders NO dead Enable/Disable button — the action set stays a
   * pure function of the record, never a per-runtime literal in the panel.
   */
  writable?: boolean
  /** Source-supplied affordance hint (e.g. the auth command for a pending-auth
   *  connector) — so the panel never hardcodes a per-runtime string. */
  hint?: string
  /** Dormant multi-tenant seam — always null today. */
  tenantId: string | null
  /** ISO timestamp — when this record was last read(). */
  syncedAt: string
}
