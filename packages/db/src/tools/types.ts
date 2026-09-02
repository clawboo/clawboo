// ─── Tools broker — types ───────────────────────────────────────────────────
// The brokered tool layer that supersedes the markdown-bullet skill model.
// A descriptor declares its name/schema/availability/executor (+ an optional
// provenance seam). Calls run an inspector chain (risk → security → scope) and
// are audited. The descriptor's `inputSchema` is a zod schema (validated at the
// boundary; the MCP server also exposes it as the tool's JSON schema).

import type { TrifectaTags } from '@clawboo/governance'
import type { ZodTypeAny } from 'zod'

export type ToolOwner = 'core' | 'plugin' | 'channel' | 'mcp'
/** Risk hint for the classifier. `destructive`/`external` calls require approval. */
export type ToolRisk = 'safe' | 'destructive' | 'external'

/**
 * Declarative availability — a tool is HIDDEN from the model's schema until its
 * requirement is satisfied (OpenClaw pattern). Combinable via allOf/anyOf.
 */
export type AvailabilityRequirement =
  | { auth: string } // a provider auth (e.g. 'openai')
  | { config: string } // a config path present
  | { env: string } // an env var present
  | { plugin: string } // a plugin enabled
  | { allOf: AvailabilityRequirement[] }
  | { anyOf: AvailabilityRequirement[] }

/** The provenance SEAM. Verify is real but enforcement is off by default. */
export interface ToolProvenance {
  signerId?: string
  signature?: string // base64url Ed25519 signature over the provenance payload
  signedAt?: number
}

export interface ToolCall {
  name: string
  args: Record<string, unknown>
}

/** Capabilities the availability evaluator + executors query (injectable → testable). */
export interface AvailabilityContext {
  hasAuth(provider: string): boolean
  hasConfig(path: string): boolean
  hasEnv(name: string): boolean
  hasPlugin(id: string): boolean
}

export interface ToolCallContext {
  agentId?: string | null
  tenantId?: string | null
  availability: AvailabilityContext
  /** Tools a child run must never call (e.g. delegation primitives). */
  toolBlocklist?: string[]
  /** The agent's team, so a team-scoped grant can authorize the call. */
  teamId?: string | null
  /**
   * The connector this call is being brokered on behalf of.
   *
   * REQUIRED for a grant to be found, and deliberately caller-supplied rather
   * than derived from the tool name: the identity is `conn:<source>:<runtime>:
   * <key>`, which contains `:` and cannot survive an MCP tool name. Absent on
   * every core builtin, which is why they are not grant-governed.
   */
  connectorId?: string | null
  /**
   * Trifecta legs the RUN has already accumulated, and whether it has ingested
   * attacker-authorable content. Both are CALLER-OWNED: `decideGrant` unions the
   * tool's own legs with these and cannot compute them itself. Nothing sets them
   * yet, so the lethal-trifecta gate currently fires only when a SINGLE tool
   * declares all three legs, and `tainted-run` never fires at all. Closing that
   * needs a run-scoped accumulator, which needs a run identity the broker does
   * not currently see.
   */
  runTrifecta?: TrifectaTags
  tainted?: boolean
}

export interface ToolDescriptor {
  name: string
  description: string
  inputSchema: ZodTypeAny
  availability?: AvailabilityRequirement
  owner?: ToolOwner
  /** PAIRED with `ToolRisk` in @clawboo/governance grants/types.ts. The two are
   *  structurally identical and the grant gate relies on that. Widen both or
   *  neither: a class one knows and the other does not would coerce to `safe`. */
  risk?: ToolRisk
  /**
   * MCP ToolAnnotations, mirrored so the grant gate can classify a tool without
   * a second vocabulary. Populated by `buildConnectorDescriptor` from a
   * connector's `tools/list`, but ONLY for a CURATED catalog entry: the MCP spec
   * calls annotations untrusted hints, so the trust has to come from the catalog
   * vouching for the package rather than from the server's own say-so.
   *
   * CONSEQUENCE WORTH KNOWING: `requiredMode` treats anything not declaring
   * `readOnly: true` as a write, so a `mode: 'read'` grant denies every
   * unannotated tool. That is why an owner grant is minted at `admin`.
   */
  readOnly?: boolean
  destructive?: boolean
  idempotent?: boolean
  openWorld?: boolean
  trifecta?: TrifectaTags
  /** Approvals that may never be remembered: money movement, external send,
   *  credential grant. Forces the UI not to offer "Always". */
  neverRemember?: boolean
  /**
   * The tool's own JSON Schema, when it came from a remote MCP server.
   *
   * Advertised VERBATIM rather than re-derived from `inputSchema`: a remote
   * schema has no zod original, and round-tripping it through the local
   * converter would widen it into a contract looser than the server enforces.
   * `inputSchema` remains the local validator.
   */
  jsonSchema?: Record<string, unknown>
  executor: (
    args: Record<string, unknown>,
    ctx: ToolCallContext,
  ) => Promise<ToolExecutorResult> | ToolExecutorResult
  provenance?: ToolProvenance
}

/**
 * An image a tool produced, carried alongside its text.
 *
 * Described STRUCTURALLY rather than imported from the MCP SDK, for the same
 * reason `RemoteToolFacts` is: @clawboo/db must not depend on @clawboo/mcp. The
 * field names mirror an MCP `image` content block so the tools server can emit
 * one without a translation table.
 */
export interface ToolImage {
  /** Base64, no data: prefix — exactly what an MCP image block carries. */
  data: string
  mimeType: string
}

/**
 * What an executor may return.
 *
 * A bare string is the common case and stays valid, so no existing executor
 * changes. The object form exists for tools whose output is not only prose: a
 * screenshot flattened to `[image: image/png, not rendered]` told the model a
 * picture existed and then withheld it, which is worse than useless on a tool
 * whose entire purpose is to look at something.
 *
 * `text` remains the canonical rendering. It is what the audit row stores, what
 * compaction operates on, and what any consumer that cannot carry images falls
 * back to — so the placeholder is still the right text even when the image
 * travels beside it.
 */
export type ToolExecutorResult = string | { text: string; images?: readonly ToolImage[] }

/** Normalize either executor return shape to the object form. */
export function toolOutputOf(raw: ToolExecutorResult): {
  text: string
  images: readonly ToolImage[]
} {
  return typeof raw === 'string'
    ? { text: raw, images: [] }
    : { text: raw.text, images: raw.images ?? [] }
}

export type InspectorDecision =
  | { kind: 'allow' }
  | { kind: 'deny'; reason: string }
  | { kind: 'require_approval'; message: string }
  | { kind: 'rewrite'; args: Record<string, unknown> }
  /** Allow the call, but RECORD what a stricter reading would have refused. For a
   *  gate whose false positives cost more than its true positives, this is the
   *  honest middle: the audit row shows what would have been denied without the
   *  work actually being blocked. */
  | { kind: 'observe'; reason: string }

export type Inspector = (
  call: ToolCall,
  descriptor: ToolDescriptor,
  ctx: ToolCallContext,
) => InspectorDecision | Promise<InspectorDecision>

export interface AvailabilityResult {
  visible: boolean
  diagnostics: string[]
}

/** The resolved chain outcome (args may have been rewritten in-place). */
export type ChainOutcome =
  | { decision: 'allow'; args: Record<string, unknown>; observations?: string[] }
  | { decision: 'deny'; reason: string }
  | {
      decision: 'require_approval'
      message: string
      args: Record<string, unknown>
      observations?: string[]
    }
