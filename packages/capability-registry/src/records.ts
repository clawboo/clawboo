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
  'openclaw' | 'clawboo-native' | 'claude-code' | 'codex' | 'hermes' | 'human' | (string & {})

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
  'managed' | 'external-write' | 'runtime-of-record' | 'observe-only'

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
 * Live health — a first-class concept `CapabilityRecord` has never carried.
 *
 * Distinct from `status` (lifecycle: has a human turned it off?) and from
 * `available` (is its declared requirement met?). This is the operational
 * question: is the thing behind it actually answering right now.
 *
 * `drift` is the highest-signal value in the set. It means the server's tool
 * list no longer hashes to what a human approved — a rug-pull — and it must
 * never be collapsed into `error`, because the remediation is completely
 * different: `error` says retry, `drift` says re-read what changed before you
 * trust it again.
 */
export type CapabilityHealth = 'unknown' | 'ok' | 'needs-auth' | 'degraded' | 'error' | 'drift'

/**
 * The three legs of the "lethal trifecta", as a capability can contribute them.
 * Structural mirror of `@clawboo/governance`'s `TrifectaTags`, declared locally
 * so this package stays dependency-free — the same discipline `CapabilityAvailability`
 * already follows for `@clawboo/db`'s `AvailabilityRequirement`.
 */
export interface CapabilityTrifecta {
  readsPrivateData: boolean
  ingestsUntrustedContent: boolean
  canEgress: boolean
}

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

  // ─── Connector-era fields ─────────────────────────────────────────────────
  // All OPTIONAL, so every existing producer and consumer compiles unchanged.
  // A source that knows nothing about connectors simply omits them.

  /**
   * The grant authorizing this capability for its subject, when one exists.
   *
   * A grant is user INTENT and lives in its own table; this row is a cache that a
   * source-scoped reconcile rewrites on every read. The id is carried here only
   * so a renderer can join the two without a second fetch — never as the place
   * the grant is stored.
   */
  grantId?: string | null

  /** The connector instance this capability came from, for attribution. */
  connectorId?: string | null

  /**
   * Live health, which is strictly richer than the boolean `available`.
   *
   * `available` answers "is its declared requirement satisfied". `health`
   * answers "what is actually wrong", and that distinction is what lets a
   * renderer show a pulsing key for `needs-auth` instead of the same flat grey
   * it shows for a missing plugin.
   */
  health?: CapabilityHealth

  /** One scrubbed line explaining a non-ok `health`. Never a secret, never a stack. */
  healthDetail?: string | null

  /** ISO timestamp of the last successful use. Drives graph desaturation. */
  lastUsedAt?: string | null

  /** How many subjects hold a grant on this. `>= 2` renders the shared "xN" chip. */
  grantCount?: number

  /**
   * Tool calls under this grant waiting on a human right now.
   *
   * CAUSED BY a `require_approval` verdict but not itself one, which is why it
   * is a plain count rather than part of the decision projection: it is the
   * marching-edge signal, not an authorization.
   */
  pendingApprovals?: number

  /** Which exfiltration-risk legs this capability can contribute. */
  trifecta?: CapabilityTrifecta

  /**
   * The grant's lifecycle AS THE GATE SEES IT, which is not always what the row
   * says: an expired-but-unswept grant projects `expired` because that is what
   * the runtime would do with it. Renderers show this, never `row.state`.
   */
  grantState?: 'proposed' | 'active' | 'suspended' | 'revoked' | 'expired'

  /**
   * The projected grant's privilege ceiling.
   *
   * Threaded rather than assumed: a renderer that defaults to `read` on an
   * `admin` grant UNDER-REPORTS what the agent can actually do, which is the
   * one direction a governance surface must never be wrong in.
   */
  grantMode?: 'read' | 'write' | 'admin'

  /**
   * True for a record the server SYNTHESISED rather than read from a runtime.
   *
   * A grantee's twin tile is the only producer: agent B holds a grant on a
   * connector its own runtime never reported. Consumers that assume every record
   * id resolves through `getCapability` must skip these, and the client's
   * inherit-if-empty grouping must not count them as "this agent has its own
   * capabilities" -- doing so switches inheritance off and hides the agent's
   * entire real fan.
   */
  synthetic?: boolean
}
