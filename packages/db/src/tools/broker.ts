// ─── Broker — the brokered tool-call pipeline ────────────────────────────────
// One execute path shared by the MCP tools server (stdio + HTTP) and any REST
// caller: availability → provenance(off by default) → schema-validate →
// inspector chain → (if required) DB-mediated approval → execute → result
// compaction → audit. Every branch is audited; secrets are scrubbed.

import { compactToolOutput } from '@clawboo/compaction'

import type { ClawbooDb } from '../db'
import { evaluateAvailability } from './availability'
import { defaultInspectors, runInspectors } from './inspectors'
import {
  createApproval,
  isToolEnabled,
  waitForApproval,
  writeAuditAfter,
  writeAuditBefore,
} from './persistence'
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

function deny(db: ClawbooDb, call: ToolCall, ctx: ToolCallContext, reason: string): BrokeredResult {
  writeAuditBefore(db, {
    toolName: call.name,
    agentId: ctx.agentId,
    decision: 'deny',
    args: call.args,
    tenantId: ctx.tenantId,
  })
  return { ok: false, output: `denied: ${reason}`, isError: true, denied: reason }
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

  // Inspector chain.
  const outcome = await runInspectors(
    validatedCall,
    descriptor,
    ctx,
    opts.inspectors ?? defaultInspectors,
  )
  if (outcome.decision === 'deny') return deny(db, validatedCall, ctx, outcome.reason)

  let effectiveArgs = validatedCall.args
  if (outcome.decision === 'require_approval') {
    writeAuditBefore(db, {
      toolName: call.name,
      agentId: ctx.agentId,
      decision: 'require_approval',
      args: outcome.args,
      tenantId: ctx.tenantId,
    })
    const approval = createApproval(db, {
      toolName: call.name,
      agentId: ctx.agentId,
      args: outcome.args,
      reason: outcome.message,
      ttlMs: opts.approvalTtlMs,
      tenantId: ctx.tenantId,
    })
    const resolution = await waitForApproval(db, approval.id, {
      timeoutMs: opts.approvalTimeoutMs,
      pollMs: opts.approvalPollMs,
    })
    if (resolution === 'deny' || resolution === 'expired' || resolution === 'timeout') {
      return {
        ok: false,
        output: `approval ${resolution}`,
        isError: true,
        denied: `approval:${resolution}`,
      }
    }
    effectiveArgs = outcome.args // allow_once / allow_always
  } else {
    writeAuditBefore(db, {
      toolName: call.name,
      agentId: ctx.agentId,
      decision: 'allow',
      args: effectiveArgs,
      tenantId: ctx.tenantId,
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
  })
  return { ok: !isError, output, isError }
}
