// Make clawboo somewhere an exec approval can actually be asked.
//
// THE PROBLEM. OpenClaw holds a shell command while a human decides, but it only
// sends the question to connections that DECLARE they can answer it. Today the
// only such connection is a browser tab: `GATEWAY_BROWSER_CAPS = ['exec-approvals']`.
// clawboo's own long-lived server connection declares `tool-events` and nothing
// else, so with no tab open there is no surface at all — and with no surface the
// Gateway does not queue the request, it expires it immediately with
// `no-approval-route`. The command is refused and the agent is told the policy is
// wrong.
//
// That is why the fleet policy cannot be switched on first. An operator who turns
// on "ask me" while the only surface is a tab has not made their agents ask; they
// have made every command fail whenever the tab is shut.
//
// THE ORDER MATTERS AND IS THE OPPOSITE OF THE OBVIOUS ONE. Declaring the
// capability is the LAST step, not the first. The Gateway counts a declaring
// connection as a real surface, so declaring it without handling the request
// turns a fast, explicit refusal into a thirty-minute silent hang. OpenClaw's own
// docs put it plainly: advertise only capabilities the client actually implements.
//
// WHAT THIS DOES NOT DO. It does not decide anything. The command stays held by
// the Gateway; clawboo mirrors the question so it survives a closed tab, and
// relays the answer back. The policy that decides WHICH commands ask is OpenClaw's
// own, and clawboo must never keep a second copy of it — two allowlists that
// disagree produce approvals the Gateway then ignores.

import { toolCallApprovals } from '@clawboo/db'
import { createLogger } from '@clawboo/logger'
import { and, eq, lt } from 'drizzle-orm'

import { getDb } from '../db'

const log = createLogger('exec-approvals')

/**
 * How long clawboo keeps a mirrored request live.
 *
 * MATCHED TO THE GATEWAY'S OWN WINDOW, deliberately. clawboo's broker approvals
 * expire in five minutes, which is right for a tool call someone is watching
 * happen. A shell prompt is different: OpenClaw holds it for thirty minutes
 * (`DEFAULT_EXEC_APPROVAL_TIMEOUT_MS`), and a mirror that gave up at five would
 * show the operator an expired card for a question the Gateway is still asking.
 */
export const EXEC_APPROVAL_TTL_MS = 30 * 60_000

export interface ExecApprovalRequest {
  id: string
  command: string
  agentId: string | null
  cwd: string | null
  reason: string | null
  expiresAtMs: number | null
  /**
   * Whether the Gateway would accept "Always" for THIS request.
   *
   * Not a guess. OpenClaw refuses `allow-always` in two cases and the request
   * carries both: an agent set to ask on EVERY command has nothing to remember
   * (`ask: 'always'`), and a command the Gateway will not persist arrives with
   * `allow-always` in `unavailableDecisions`. Sending it anyway comes back
   * "allow-always is unavailable for this command", so an ungated Always button
   * is one that fails on exactly the commands an operator is most tired of
   * being asked about.
   */
  allowAlways: boolean
}

/** The Gateway frame, read defensively; a shape we do not recognise is ignored. */
export function parseExecApprovalRequest(payload: unknown): ExecApprovalRequest | null {
  if (!payload || typeof payload !== 'object') return null
  const p = payload as Record<string, unknown>
  const id = typeof p['id'] === 'string' ? p['id'] : ''
  const req = (p['request'] ?? p) as Record<string, unknown>
  const command = typeof req['command'] === 'string' ? req['command'] : ''
  if (!id || !command) return null
  const unavailable = Array.isArray(req['unavailableDecisions']) ? req['unavailableDecisions'] : []

  return {
    id,
    command,
    agentId: typeof req['agentId'] === 'string' ? req['agentId'] : null,
    cwd: typeof req['cwd'] === 'string' ? req['cwd'] : null,
    // The Gateway's own sentence about why it stopped, when it wrote one. It is
    // more specific than anything clawboo can say about a command from outside.
    reason:
      typeof req['warningText'] === 'string' && req['warningText'].trim()
        ? req['warningText'].trim()
        : typeof req['reason'] === 'string'
          ? req['reason']
          : null,
    expiresAtMs: typeof p['expiresAtMs'] === 'number' ? p['expiresAtMs'] : null,
    // An absent field means no restriction, which is the vendor's own default,
    // so a frame from a Gateway that predates these fields still offers Always.
    allowAlways: req['ask'] !== 'always' && !unavailable.includes('allow-always'),
  }
}

/**
 * The Gateway's decision word in clawboo's own vocabulary.
 *
 * TWO SPELLINGS OF THE SAME DECISION, and the audit log has to settle on one:
 * OpenClaw says `allow-always`, clawboo's own broker says `allow_always`, and
 * both land in the same `status` column. Worse than the inconsistency, the
 * resolve path used to fold anything that was not a denial into `allow_once`,
 * so a standing grant an operator had just minted was recorded as a one-off.
 * The record then disagreed with the allowlist it created, which is the one
 * place someone would look to find out why a command stopped being asked about.
 */
export function execDecisionStatus(decision: string): string {
  const normalized = decision.replace(/-/g, '_')
  return normalized === 'deny' || normalized === 'allow_always' ? normalized : 'allow_once'
}

export interface ExecApprovalSource {
  operatorCall<T>(method: string, params?: unknown): Promise<T>
  onGatewayBroadcast(cb: (frame: { event: string; payload?: unknown }) => void): () => void
}

/** Map an OpenClaw agent id to the clawboo row id the card is filed under. */
export type ResolveAgentId = (sourceAgentId: string) => string | null

/** How often the mirror checks whether the Gateway has stopped waiting. */
const EXPIRY_SWEEP_MS = 30_000

/**
 * Retire mirrored approvals the Gateway has already given up on.
 *
 * REQUIRED, because a timeout is the one outcome nobody announces. The Gateway
 * emits `exec.approval.resolved` when a human answers, but on timeout it
 * resolves internally with null and says nothing — the browser carries its own
 * sweep for exactly this reason.
 *
 * Without this the mirror is wrong in the direction that matters. clawboo's
 * generic reaper expires a pending row after 24 HOURS, judged on its age, while
 * the Gateway gives up after 30 MINUTES. So a card would stay on screen looking
 * answerable for most of a day after the command behind it had been refused, and
 * pressing Approve would do nothing. This expires on the row's OWN `expiresAt`,
 * which is copied from the Gateway's deadline, so the card stops offering a
 * choice at the moment the choice stops existing.
 */
export function expireStaleExecApprovals(db: ReturnType<typeof getDb>): number {
  const rows = db
    .update(toolCallApprovals)
    .set({ status: 'expired', resolvedAt: Date.now() })
    .where(
      and(
        eq(toolCallApprovals.kind, 'exec'),
        eq(toolCallApprovals.status, 'pending'),
        lt(toolCallApprovals.expiresAt, Date.now()),
      ),
    )
    .returning()
    .all()
  return rows.length
}

export interface ExecApprovalSurface {
  stop(): void
}

/**
 * Mirror OpenClaw's exec approvals into clawboo, and answer them.
 *
 * The row is written with the GATEWAY'S OWN id as the primary key, which is what
 * makes the whole thing idempotent: a redelivered request lands on the existing
 * row, and the id is also the handle `exec.approval.resolve` needs, so no
 * separate mapping has to be kept in step.
 */
export function startExecApprovalSurface(
  source: ExecApprovalSource,
  resolveAgentId: ResolveAgentId,
): ExecApprovalSurface {
  const off = source.onGatewayBroadcast((frame) => {
    try {
      if (frame.event === 'exec.approval.requested') {
        const req = parseExecApprovalRequest(frame.payload)
        if (!req) return
        const now = Date.now()
        getDb()
          .insert(toolCallApprovals)
          .values({
            id: req.id,
            kind: 'exec',
            toolName: 'exec',
            // Resolved to clawboo's row id where possible, but NOT dropped when it
            // cannot be: unlike an activity row, an unattributed approval still
            // has to be answerable. Showing a command whose agent is unknown is
            // worse than nothing only if it is silently ignored.
            agentId: req.agentId ? (resolveAgentId(req.agentId) ?? req.agentId) : null,
            argsSummary: JSON.stringify({ command: req.command, cwd: req.cwd }),
            reason: req.reason ?? 'this command is not on the trusted list',
            status: 'pending',
            // The shell is the one tool clawboo cannot classify, because the risk
            // is in the command text rather than in a descriptor it owns.
            toolClass: 'destructive',
            toolSummary: req.command.slice(0, 200),
            // "Always" is OpenClaw's to mint, into ITS allowlist, and the resolve
            // route now asks it to. So the question is no longer whether clawboo
            // can honour the button, it is whether the GATEWAY would, and the
            // request answers that itself.
            neverRemember: req.allowAlways ? 0 : 1,
            createdAt: now,
            expiresAt: req.expiresAtMs ?? now + EXEC_APPROVAL_TTL_MS,
          })
          .onConflictDoNothing()
          .run()
        log.info({ id: req.id, agentId: req.agentId }, 'mirrored an exec approval')
        return
      }

      // The Gateway tells every surface when any of them answers, which is how a
      // card clears from the tab after being answered here, and the reverse.
      if (frame.event === 'exec.approval.resolved') {
        const p = frame.payload as Record<string, unknown> | undefined
        const id = typeof p?.['id'] === 'string' ? p['id'] : ''
        const decision = typeof p?.['decision'] === 'string' ? p['decision'] : ''
        if (!id) return
        getDb()
          .update(toolCallApprovals)
          .set({
            status: decision ? execDecisionStatus(decision) : 'resolved',
            resolvedAt: Date.now(),
          })
          .where(eq(toolCallApprovals.id, id))
          .run()
      }
    } catch (err) {
      // A malformed frame must never break the fan-out for every other listener.
      log.debug({ err }, 'exec approval frame dropped')
    }
  })

  const sweep = setInterval(() => {
    try {
      const n = expireStaleExecApprovals(getDb())
      if (n > 0) log.info({ count: n }, 'retired exec approvals the Gateway stopped waiting on')
    } catch (err) {
      log.debug({ err }, 'exec approval sweep failed')
    }
  }, EXPIRY_SWEEP_MS)
  // Unref'd so a mirror with nothing to do never holds the process open.
  sweep.unref()

  return {
    stop: () => {
      clearInterval(sweep)
      off()
    },
  }
}

/**
 * Answer a mirrored approval.
 *
 * THE GATEWAY IS THE SOURCE OF TRUTH, so the RPC goes first and the local row is
 * only updated once it succeeds. Writing the row first would leave clawboo
 * showing an answered card for a command the Gateway is still holding, and the
 * operator would have no way to tell.
 *
 * A second answer is expected rather than exceptional: the same card may be open
 * in a browser tab. The Gateway replies `APPROVAL_ALREADY_RESOLVED`, which is a
 * normal race and not a failure to report.
 */
export async function resolveExecApproval(
  source: ExecApprovalSource,
  id: string,
  decision: 'allow-once' | 'allow-always' | 'deny',
): Promise<{ ok: boolean; alreadyResolved?: boolean }> {
  try {
    await source.operatorCall('exec.approval.resolve', { id, decision })
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    if (msg.includes('APPROVAL_ALREADY_RESOLVED') || msg.includes('already resolved')) {
      return { ok: true, alreadyResolved: true }
    }
    log.warn({ err, id }, 'could not resolve exec approval')
    return { ok: false }
  }
  getDb()
    .update(toolCallApprovals)
    .set({ status: execDecisionStatus(decision), resolvedAt: Date.now() })
    .where(eq(toolCallApprovals.id, id))
    .run()
  return { ok: true }
}
