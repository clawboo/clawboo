// ─── Tools broker — types ───────────────────────────────────────────────────
// The brokered tool layer that supersedes the markdown-bullet skill model.
// A descriptor declares its name/schema/availability/executor (+ an optional
// provenance seam). Calls run an inspector chain (risk → security → scope) and
// are audited. The descriptor's `inputSchema` is a zod schema (validated at the
// boundary; the MCP server also exposes it as the tool's JSON schema).

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
}

export interface ToolDescriptor {
  name: string
  description: string
  inputSchema: ZodTypeAny
  availability?: AvailabilityRequirement
  owner?: ToolOwner
  risk?: ToolRisk
  executor: (args: Record<string, unknown>, ctx: ToolCallContext) => Promise<string> | string
  provenance?: ToolProvenance
}

export type InspectorDecision =
  | { kind: 'allow' }
  | { kind: 'deny'; reason: string }
  | { kind: 'require_approval'; message: string }
  | { kind: 'rewrite'; args: Record<string, unknown> }

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
  | { decision: 'allow'; args: Record<string, unknown> }
  | { decision: 'deny'; reason: string }
  | { decision: 'require_approval'; message: string; args: Record<string, unknown> }
