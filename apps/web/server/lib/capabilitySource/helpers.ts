// Shared helpers for the five CapabilitySource adapters: deterministic record
// construction (the `id` encodes the composite identity), availability
// evaluation (reusing the tool-broker's evaluator → the same greying the
// MCPToolsSection uses), the ok/degraded read-status builders, and the shared
// write-policy predicate the mapper and each source's write() both gate on.
// Keeping these here means every adapter projects an identical record shape.

import {
  makeCapabilityId,
  type CapabilityAvailability,
  type CapabilityKind,
  type CapabilityManageability,
  type CapabilityOrigin,
  type CapabilityProvenance,
  type CapabilityRecord,
  type CapabilityRuntime,
  type CapabilityScope,
  type CapabilitySourceId,
  type CapabilityStatus,
  type SourceReadStatus,
} from '@clawboo/capability-registry'
import { defaultAvailabilityContext, evaluateAvailability } from '@clawboo/db'

export interface BuildRecordInput {
  sourceId: CapabilitySourceId
  runtime: CapabilityRuntime
  scope: CapabilityScope
  agentId?: string | null
  kind: CapabilityKind
  /** Natural identifier inside the owning store (tool name / skill slug / connector id). */
  sourceKey: string
  origin: CapabilityOrigin
  manageability: CapabilityManageability
  name: string
  description?: string
  availability?: CapabilityAvailability | null
  /** Override the auto-evaluated availability (e.g. an enabled/disabled flag). */
  available?: boolean
  diagnostics?: string[]
  provenance?: CapabilityProvenance | null
  status?: CapabilityStatus
  /**
   * Whether the owning source can write this record. Omit it and `buildRecord`
   * derives it via `isSourceWritable(origin, kind)`, which is `true` everywhere
   * except an OpenClaw extension row that is not a tool. Pass it explicitly only
   * to say something the (origin, kind) pair cannot, as the clawboo MCP spine row
   * does: its origin is `mcp-connector`, which is writable for native.
   */
  writable?: boolean
  /** Source-supplied affordance hint (e.g. a pending-auth command). */
  hint?: string
  tenantId?: string | null
}

/**
 * Build a CapabilityRecord. The `id` deterministically encodes the composite
 * identity (sourceId + runtime + scope + agentId + kind + sourceKey) so the same
 * capability re-reads to the same row (idempotent upsert). When an `availability`
 * requirement is present and `available` isn't overridden, it's evaluated via the
 * tool-broker evaluator → `available` + `diagnostics` drive greying in both
 * renderers.
 */
export function buildRecord(input: BuildRecordInput): CapabilityRecord {
  const agentId = input.agentId ?? null
  const rawKey = `${input.runtime}:${input.scope}:${agentId ?? 'global'}:${input.kind}:${input.sourceKey}`
  const evaluated = evalAvailability(input.availability ?? null)
  const available = input.available ?? evaluated.available
  const diagnostics = input.diagnostics ?? (available ? [] : evaluated.diagnostics)
  return {
    id: makeCapabilityId(input.sourceId, rawKey),
    sourceKey: input.sourceKey,
    kind: input.kind,
    runtime: input.runtime,
    scope: input.scope,
    agentId,
    source: input.origin,
    manageability: input.manageability,
    name: input.name,
    description: input.description ?? '',
    availability: input.availability ?? null,
    available,
    diagnostics,
    provenance: input.provenance ?? null,
    status: input.status ?? (available ? 'ready' : 'unavailable'),
    writable: input.writable ?? isSourceWritable(input.origin, input.kind),
    ...(input.hint !== undefined ? { hint: input.hint } : {}),
    tenantId: input.tenantId ?? null,
    syncedAt: new Date().toISOString(),
  }
}

/** Resolve a declarative availability requirement into available + diagnostics. */
export function evalAvailability(req: CapabilityAvailability | null): {
  available: boolean
  diagnostics: string[]
} {
  if (!req) return { available: true, diagnostics: [] }
  // evaluateAvailability reads only descriptor.availability; the cast supplies it.
  const r = evaluateAvailability(
    { availability: req } as Parameters<typeof evaluateAvailability>[0],
    defaultAvailabilityContext(),
  )
  return { available: r.visible, diagnostics: r.diagnostics }
}

/**
 * Whether the OWNING source can actually WRITE a row with this (origin, kind).
 * The ONE statement of that policy: `buildRecord` stamps it on the live record,
 * `rowToRecord` re-derives it for the last-good DB path (the column does not
 * persist), and the owning `write()` gates on it. All three read the same row, so
 * none of them may carry its own copy of the rule.
 *
 * They did, and it broke. The mapper's copy said "any runtime-of-record OpenClaw
 * extension is unwritable", which also swallowed the tools.allow/deny rows
 * OpenClawCapabilitySource.write() genuinely supports, so every Gateway tool
 * enable/disable 422'd at the REST gate while the dashboard still rendered the
 * button (issue #146).
 *
 * OpenClaw is runtime-of-record for its own config and clawboo drives changes
 * through `config.patch`, where only the tools.allow/deny surface (kind 'tool') is
 * a confirmed write. Its MCP connectors and plugins stay read-only until their
 * config.patch shape is live-spike confirmed, so they render no dead button. Every
 * other origin is writable by its own source.
 *
 * Scope note: this keys on (origin, kind), NOT on sourceId, so it cannot tell
 * openclaw's own `mcp-connector` spine row (unwritable) from native's
 * `mcp-connector` records (managed, writable). That is deliberate. The spine row
 * is already blocked twice over, by its `observe-only` tier at the REST gate and
 * by the ownership check in OpenClawCapabilitySource.write(), so a per-source
 * dispatch table would buy nothing today.
 *
 * Params are `string`, not the CapabilityOrigin/CapabilityKind unions: both real
 * callers read a DbCapability whose columns are plain text, so union params would
 * force a cast at every call site and buy nothing the comparisons here do not.
 */
export function isSourceWritable(origin: string, kind: string): boolean {
  if (origin === 'openclaw-extension') return kind === 'tool'
  return true
}

export function okStatus(sourceId: CapabilitySourceId): SourceReadStatus {
  return { sourceId, ok: true, degraded: false, at: Date.now() }
}

export function degradedStatus(sourceId: CapabilitySourceId, reason: string): SourceReadStatus {
  return { sourceId, ok: false, degraded: true, reason, at: Date.now() }
}

/** A runtime's built-ins as a single observe-only roll-up (clawboo never manages them). */
export function builtinRollup(
  sourceId: CapabilitySourceId,
  runtime: CapabilityRuntime,
  label: string,
): CapabilityRecord {
  return buildRecord({
    sourceId,
    runtime,
    scope: 'global',
    kind: 'tool',
    sourceKey: 'builtins',
    origin: 'runtime-builtin',
    manageability: 'observe-only',
    name: 'Built-in tools',
    description: `${label} — native built-in tools, managed by the runtime`,
    available: true,
    status: 'ready',
  })
}
