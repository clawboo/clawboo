// ─── Broker — the brokered tool-call pipeline ────────────────────────────────
// One execute path shared by the MCP tools server (stdio + HTTP) and any REST
// caller: availability → provenance(off by default) → schema-validate →
// inspector chain → (if required) DB-mediated approval → execute → result
// compaction → audit. Every branch is audited; secrets are scrubbed.

import { compactToolOutput } from '@clawboo/compaction'
import type { GrantDecision } from '@clawboo/governance'

import type { ClawbooDb } from '../db'
import { appendEvent } from '../events/appendEvent'
import { evaluateAvailability } from './availability'
import { defaultInspectors, runInspectors } from './inspectors'
import {
  createApproval,
  isToolEnabled,
  waitForApproval,
  writeAuditAfter,
  writeAuditBefore,
} from './persistence'
import { evaluateGrant, releaseGrantCharge, ruleIdOf, type GrantGateResult } from './grantGate'
import { verifyProvenance, type ProvenanceVerifyOpts } from './provenance'
import type { ToolRegistry } from './registry'
import type { Inspector, ToolCall, ToolCallContext } from './types'

export interface BrokerOptions {
  registry: ToolRegistry
  inspectors?: Inspector[]
  /** Provenance enforcement is OFF by default (the seam). */
  provenance?: ProvenanceVerifyOpts
  approvalTtlMs?: number
  approvalTimeoutMs?: number
  approvalPollMs?: number
  /** Compact the tool result before returning (default true). */
  compact?: boolean
}

export interface BrokeredResult {
  ok: boolean
  output: string
  isError: boolean
  /** Set when a gate denied the call (availability/provenance/inspector/approval). */
  denied?: string
}

/** Attribution shared by every audit row this call writes. Threaded through ALL
 *  THREE writeAuditBefore sites and the after row: a grant whose successful calls
 *  carry a null grant_id is a grant with no usage history and no last-used. */
interface GrantAttribution {
  grantId?: string | null
  connectorId?: string | null
  ruleId?: string | null
}

function attributionOf(gate: GrantGateResult | null): GrantAttribution {
  if (!gate) return {}
  return {
    grantId: gate.decision.grantId,
    connectorId: gate.connectorId,
    ruleId: ruleIdOf(gate.decision),
  }
}

function deny(
  db: ClawbooDb,
  call: ToolCall,
  ctx: ToolCallContext,
  reason: string,
  attribution: GrantAttribution = {},
): BrokeredResult {
  writeAuditBefore(db, {
    toolName: call.name,
    agentId: ctx.agentId,
    decision: 'deny',
    args: call.args,
    tenantId: ctx.tenantId,
    ...attribution,
  })
  return { ok: false, output: `denied: ${reason}`, isError: true, denied: reason }
}

/** Mirror the verdict into the durable event log. Best-effort: observability
 *  must never throw on the orchestration hot path. */
function emitGrantDecision(
  db: ClawbooDb,
  call: ToolCall,
  ctx: ToolCallContext,
  gate: GrantGateResult,
): void {
  const d: GrantDecision = gate.decision
  try {
    appendEvent(db, {
      kind: 'grant_decision',
      agentId: ctx.agentId ?? null,
      teamId: ctx.teamId ?? null,
      tenantId: ctx.tenantId ?? null,
      data: {
        decision: d.kind,
        reason: d.kind === 'allow' ? null : d.reason,
        grantId: d.grantId,
        connectorId: gate.connectorId,
        toolName: call.name,
        ruleId: ruleIdOf(d),
      },
    })
  } catch {
    /* best-effort */
  }
}

/**
 * Execute a tool call through the full broker pipeline. Returns a tool-result
 * shape (`{ ok, output, isError }`) the MCP/REST layer maps to its protocol.
 */
export async function executeBrokeredCall(
  db: ClawbooDb,
  call: ToolCall,
  ctx: ToolCallContext,
  opts: BrokerOptions,
): Promise<BrokeredResult> {
  const descriptor = opts.registry.get(call.name)
  if (!descriptor) return deny(db, call, ctx, `unknown-tool:${call.name}`)
  if (!isToolEnabled(db, call.name)) return deny(db, call, ctx, `disabled:${call.name}`)

  // Availability (defense-in-depth: a hidden tool shouldn't reach here).
  const availability = evaluateAvailability(descriptor, ctx.availability)
  if (!availability.visible) {
    return deny(db, call, ctx, `unavailable:${availability.diagnostics.join(',')}`)
  }

  // Provenance — no-op pass unless enforcement is explicitly enabled.
  const prov = await verifyProvenance(descriptor, opts.provenance)
  if (!prov.ok) return deny(db, call, ctx, `provenance:${prov.reason ?? 'failed'}`)

  // Validate args at the boundary.
  const parsed = descriptor.inputSchema.safeParse(call.args)
  if (!parsed.success)
    return deny(db, call, ctx, `invalid-args:${parsed.error.message.slice(0, 200)}`)
  const validatedCall: ToolCall = { name: call.name, args: parsed.data as Record<string, unknown> }

  // ── The grant gate ────────────────────────────────────────────────────────
  // Placed after validation so a denial audits the args the caller actually
  // sent, and before the inspector chain so a call nothing authorizes never
  // reaches it. Returns null for a core builtin, which no grant governs: that
  // is why nothing callable today changes behaviour.
  const gate = evaluateGrant(db, descriptor, ctx)
  const attribution = attributionOf(gate)
  if (gate) {
    emitGrantDecision(db, validatedCall, ctx, gate)
    if (gate.decision.kind === 'deny') {
      return deny(db, validatedCall, ctx, `grant:${gate.decision.reason}`, attribution)
    }
  }

  // Inspector chain.
  const outcome = await runInspectors(
    validatedCall,
    descriptor,
    ctx,
    opts.inspectors ?? defaultInspectors,
  )
  if (outcome.decision === 'deny') {
    releaseGrantCharge(gate)
    return deny(db, validatedCall, ctx, outcome.reason, attribution)
  }

  let effectiveArgs = validatedCall.args
  // A grant can require an approval the inspector chain did not. Narrowed into a
  // local so the reason below is a real string rather than a property access on
  // a union that may not have it.
  const grantApproval = gate && gate.decision.kind === 'require_approval' ? gate.decision : null
  if (outcome.decision === 'require_approval' || grantApproval) {
    // Observations survive on THIS path too: an observed-then-approved call is
    // exactly the false-positive datum the observe mode exists to count.
    const approvalObs = outcome.observations ?? []
    const approvalArgs = outcome.decision === 'require_approval' ? outcome.args : effectiveArgs
    const approvalReason =
      outcome.decision === 'require_approval'
        ? outcome.message
        : `grant:${grantApproval?.reason ?? 'policy'}`
    writeAuditBefore(db, {
      toolName: call.name,
      agentId: ctx.agentId,
      decision: 'require_approval',
      args: approvalArgs,
      tenantId: ctx.tenantId,
      ...attribution,
      ...(approvalObs.length > 0 ? { note: `would-deny: ${approvalObs.join('; ')}` } : {}),
    })
    const approval = createApproval(db, {
      toolName: call.name,
      agentId: ctx.agentId,
      args: approvalArgs,
      reason: approvalReason,
      ttlMs: opts.approvalTtlMs,
      tenantId: ctx.tenantId,
      grantId: gate?.decision.grantId ?? null,
      connectorId: gate?.connectorId ?? null,
      // PERSISTED from the verdict, so the resolve path can never mint a durable
      // rule the prompt did not offer.
      neverRemember: grantApproval?.neverRemember ?? false,
      ruleReason: grantApproval?.reason ?? null,
    })
    const resolution = await waitForApproval(db, approval.id, {
      timeoutMs: opts.approvalTimeoutMs,
      pollMs: opts.approvalPollMs,
    })
    if (resolution === 'deny' || resolution === 'expired' || resolution === 'timeout') {
      releaseGrantCharge(gate)
      return {
        ok: false,
        output: `approval ${resolution}`,
        isError: true,
        denied: `approval:${resolution}`,
      }
    }
    if (outcome.decision === 'require_approval') effectiveArgs = outcome.args // allow_once / allow_always
  } else {
    // An observed-but-allowed call is audited as `observe`, not `allow`: the whole
    // point of not denying it is that someone can still count how often it happens.
    const observations = outcome.observations ?? []
    writeAuditBefore(db, {
      toolName: call.name,
      agentId: ctx.agentId,
      decision: observations.length > 0 ? 'observe' : 'allow',
      args: effectiveArgs,
      tenantId: ctx.tenantId,
      ...attribution,
      ...(observations.length > 0 ? { note: `would-deny: ${observations.join('; ')}` } : {}),
    })
  }

  // Execute.
  let raw: string
  let isError = false
  try {
    raw = await Promise.resolve(descriptor.executor(effectiveArgs, ctx))
  } catch (err) {
    raw = err instanceof Error ? err.message : String(err)
    isError = true
  }

  // Compact (pass-through-safe + failure-preserving) before returning.
  const output = opts.compact === false ? raw : compactToolOutput(call.name, raw).text

  writeAuditAfter(db, {
    toolName: call.name,
    agentId: ctx.agentId,
    result: output,
    isError,
    tenantId: ctx.tenantId,
    // The `after` row is the ONLY producer lastUsedByGrant reads. Omitting the
    // attribution here is what would make every grant's "last used" permanently
    // null while the query itself looked correct.
    grantId: attribution.grantId ?? null,
    connectorId: attribution.connectorId ?? null,
  })
  return { ok: !isError, output, isError }
}
