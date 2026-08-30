// ─── Broker — the brokered tool-call pipeline ────────────────────────────────
// One execute path shared by the MCP tools server (stdio + HTTP) and any REST
// caller: availability → provenance(off by default) → schema-validate →
// inspector chain → (if required) DB-mediated approval → execute → result
// compaction → audit. Every branch is audited; secrets are scrubbed.

import { compactToolOutput } from '@clawboo/compaction'
import type { GrantDecision } from '@clawboo/governance'

import type { ClawbooDb } from '../db'
import { appendEvent } from '../events/appendEvent'
import { listCandidateGrants } from '../grants/repository'
import { evaluateAvailability } from './availability'
import { defaultInspectors, runInspectors } from './inspectors'
import {
  createApproval,
  isToolEnabled,
  waitForApproval,
  writeAuditAfter,
  writeAuditBefore,
} from './persistence'
import {
  chargeGrantCall,
  evaluateGrant,
  releaseGrantCharge,
  ruleIdOf,
  type GrantGateResult,
} from './grantGate'
import { brokeredAppConnectorId, brokeredAppScope } from './brokeredApp'
import { toolClassOf, toolSummaryOf } from './toolClass'
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
  /**
   * The broker's own toolkit vocabulary, for reading which upstream app a
   * brokered call is aimed at.
   *
   * Supplied by the caller because the catalog owns that list and this package
   * must not depend on it. Absent means no per-app checking, which is correct
   * for every connector that is not a broker.
   */
  brokeredToolkits?: readonly string[]
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
  // reaches it. Returns null for a core builtin, which no grant governs; every
  // connector-supplied tool goes through it.
  const gate = evaluateGrant(db, descriptor, ctx)
  let attribution = attributionOf(gate)
  if (gate) {
    emitGrantDecision(db, validatedCall, ctx, gate)
    if (gate.decision.kind === 'deny') {
      return deny(db, validatedCall, ctx, `grant:${gate.decision.reason}`, attribution)
    }
  }

  // ── The per-app gate ──────────────────────────────────────────────────────
  // A broker is one session carrying many apps, so the grant above authorised
  // the SESSION and says nothing about which app this call is aimed at. Reading
  // it off the arguments is the only place that distinction exists.
  const appGap = brokeredAppGap(db, validatedCall, ctx, gate, opts.brokeredToolkits)

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
  if (outcome.decision === 'require_approval' || grantApproval || appGap) {
    // Observations survive on THIS path too: an observed-then-approved call is
    // exactly the false-positive datum the observe mode exists to count.
    const approvalObs = outcome.observations ?? []
    const approvalArgs = outcome.decision === 'require_approval' ? outcome.args : effectiveArgs
    const approvalReason =
      outcome.decision === 'require_approval'
        ? outcome.message
        : appGap !== null
          ? appGap
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
      // The SERVER's own reading, carried to the card. Without it the browser
      // has only the tool's name to go on, which generalises to whatever
      // naming conventions someone hard-coded and to nothing else.
      toolClass: toolClassOf(descriptor),
      toolSummary: toolSummaryOf(descriptor.description),
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
    // REVALIDATE before charging or executing. The verdict above was reached
    // BEFORE the wait, and that wait is minutes by default: inside it the grant
    // can be revoked, pass its expiry, drift, or have its ceiling exhausted by a
    // concurrent call. Executing on the pre-wait verdict lets a human's "yes"
    // outlive the authorization it was given under, which is the one thing an
    // approval must never do.
    if (gate) {
      // Release BEFORE re-evaluating. The gate may already have charged: an
      // inspector can demand approval on a call the grant allowed outright, and
      // that charge is still in the window. Re-evaluating over it makes a grant
      // with a ceiling of N deny its own approved call at N, and a denial here
      // would leave the charge stranded for the rest of the hour.
      releaseGrantCharge(gate)
      const fresh = evaluateGrant(db, descriptor, ctx)
      if (fresh) {
        attribution = attributionOf(fresh)
        if (fresh.decision.kind === 'deny') {
          return deny(db, validatedCall, ctx, `grant:${fresh.decision.reason}`, attribution)
        }
        // Idempotent: `evaluateGrant` already charged if it returned `allow`.
        // This covers the still-require_approval case, where the human has now
        // answered and the call is about to run.
        chargeGrantCall(fresh)
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

/**
 * Whether this call names an app the agent has not been granted.
 *
 * Returns the reason to ask a human, or null when nothing is missing.
 *
 * AN APPROVAL RATHER THAN A REFUSAL, which is a product decision: the graph edge
 * is the durable "yes, always" and this prompt is the ad-hoc path, so an
 * ungranted app is reachable when a person says so and never silently.
 *
 * THE UNSCOPED TOOLS ARE NOT HANDLED HERE. A remote shell and a Python sandbox
 * that can call any app from inside code cannot be bounded by an app grant, so
 * no app grant is consulted for them: they stand or fall on the session grant's
 * own tool scope, which is where they can actually be allowed or denied by name.
 */
function brokeredAppGap(
  db: ClawbooDb,
  call: ToolCall,
  ctx: ToolCallContext,
  gate: GrantGateResult | null,
  known: readonly string[] | undefined,
): string | null {
  const connectorId = gate?.connectorId ?? ctx.connectorId ?? null
  if (!connectorId || !known || known.length === 0) return null

  const scope = brokeredAppScope(call.name, call.args, known)
  if (scope.kind === 'not-brokered' || scope.kind === 'unscoped') return null
  if (scope.kind === 'unknown') return `app:unreadable:${scope.tool}`

  const missing = scope.toolkits.filter((toolkit) => {
    const grants = listCandidateGrants(db, {
      agentId: ctx.agentId ?? null,
      teamId: ctx.teamId ?? null,
      connectorId: brokeredAppConnectorId(connectorId, toolkit),
    })
    // ACTIVE ONLY. `listCandidateGrants` is a pure subject-by-capability query
    // with NO state filter, so it returns revoked and suspended rows too. The
    // main gate is unaffected because `decideGrant` denies on state, but this
    // check reads the rows directly: counting them would let a REVOKED grant
    // authorise the app it was revoked from. On a real install that resurrected
    // fleet-wide Gmail access through the very row the retirement had killed.
    return !grants.some((g) => g.state === 'active')
  })

  return missing.length === 0 ? null : `app:no-grant:${missing.join(',')}`
}
