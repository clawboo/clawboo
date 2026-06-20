// The CapabilitySource trait — the unified Capability Inventory's per-runtime
// adapter, fanned by CapabilityMultiplexer. Structural mirror of
// @clawboo/scheduler's ScheduleSource: a read()-multiplexed, write()-adapter
// trait. read() NEVER rejects — degradation is data (the status), so one dead
// source (a disconnected Gateway) can't take the merged inventory down.
//
// DEVIATION from ScheduleSource (documented): manageability is per-RECORD here,
// not per-source — one adapter (Hermes) emits BOTH external-write SKILL.md rows
// AND observe-only built-ins. So there is no `readonly manageability` on the
// source; the write-gate is enforced at the REST layer (resolve the target
// record → reject observe-only) + defended in each source.write().

import type {
  CanonicalMcpServer,
  CapabilityKind,
  CapabilityRecord,
  CapabilityRuntime,
  CapabilitySourceId,
} from './records'

/** A connector/skill install. `via` names the adapter that owns the write. */
export interface CapabilityInstallSpec {
  /** The adapter that handles this install (curated skill → 'native'; SKILL.md → 'hermes'; …). */
  via: CapabilitySourceId
  agentId: string
  runtime: CapabilityRuntime
  kind: CapabilityKind
  /** Display name / catalog-skill name / connector id. */
  name: string
  /** Connector installs: the canonical MCP spec the transcoder dialects per runtime. */
  mcpServer?: CanonicalMcpServer
  /** Filesystem-skill installs: SKILL.md content (injection-scanned before write). */
  skillContent?: string
  /** Dormant multi-tenant seam. */
  tenantId?: string | null
}

/** Approval decision — reused by the REST `approve` action, which resolves a
 *  pending `tool_call_approvals` row via the existing tool_call_approvals handshake (NOT a
 *  source-routed write — approval ids carry no source prefix). */
export type CapabilityApprovalDecision = 'allow_once' | 'allow_always' | 'deny'

/** The source-routed write actions the multiplexer dispatches by manageability. */
export type CapabilityWriteAction =
  | { kind: 'install'; spec: CapabilityInstallSpec }
  | { kind: 'enable'; id: string }
  | { kind: 'disable'; id: string }

export interface SourceReadStatus {
  sourceId: CapabilitySourceId
  ok: boolean
  degraded: boolean
  /** e.g. 'gateway_disconnected' | 'home_missing'. */
  reason?: string
  at: number
}

export interface CapabilityReadResult {
  records: CapabilityRecord[]
  status: SourceReadStatus
}

export interface CapabilitySource {
  readonly id: CapabilitySourceId
  /** Never rejects — a failing backend returns a degraded status + best records. */
  read(): Promise<CapabilityReadResult>
  /**
   * Throws the typed errors from ./errors (observe-only → unsupported()); returns
   * the fresh record (null for acknowledgements that don't yield a new row).
   */
  write(action: CapabilityWriteAction): Promise<CapabilityRecord | null>
}
