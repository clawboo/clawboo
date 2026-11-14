// Hermes's own approvals, shown as Clawboo approval cards and answered back.
//
// When a Hermes run is about to run a command its own policy flags
// (`approvals.mode` in the profile's config; manual by default), the gateway
// holds the command and sends `approval.request` on the run's event stream. The
// driver records it here as a card, and an answer from any surface (the board,
// the chat, the phone) goes to `POST /v1/runs/{id}/approval`. Hermes decides
// which commands ask, as OpenClaw does for its own: Clawboo keeps no second copy
// of that policy.
//
// - The row's kind is `hermes`, and `decideApproval` sends its answer here.
//   Hermes is the source of truth, so the call goes first and the row changes
//   only once Hermes took it.
// - The card is a command card (`run_command`): it shows the command and the
//   folder and offers Run it or Deny. "Always" is not offered: Hermes would
//   remember it in its own allow list, which no card can show or take back.
// - Hermes stops waiting after `approvals.timeout` (300 s by default, sent on
//   the event as `timeout_s`) and denies the command, so the card expires then too.
// - What to call back lives in memory with the run that asked. A card left
//   pending when Clawboo stops is expired at the next start: the gateway stopped
//   with Clawboo, and its run with it.

import {
  approvalEvent,
  personJson,
  toolCallApprovals,
  type ClawbooDb,
  type DbToolCallApproval,
  type PersonRecord,
} from '@clawboo/db'
import { createLogger } from '@clawboo/logger'
import { and, eq } from 'drizzle-orm'

import { emitEvent } from '../../obs/emit'
import type { HermesApprovalChoice, HermesClient } from './client'

const log = createLogger('hermes-approvals')

export const HERMES_APPROVAL_KIND = 'hermes'

/** Hermes's default wait for an answer (`approvals.timeout`). */
export const HERMES_APPROVAL_TTL_MS = 300_000

export interface HermesApprovalRequest {
  runId: string
  /** `prompt_id` on the event, `request_id` in the answer. */
  requestId: string
  executionGeneration: number
  command: string
  description: string | null
  cwd: string | null
  agentId: string | null
  taskId: string | null
  /** How long Hermes waits for an answer (`timeout_s` on the event), when it says. */
  timeoutMs?: number | null
}

interface Pending {
  client: HermesClient
  runId: string
  requestId: string
  executionGeneration: number
}

const pending = new Map<string, Pending>()

/** The card's id: the run and Hermes's own prompt id, so a replayed event lands
 *  on the same row. */
export function hermesApprovalId(runId: string, requestId: string): string {
  return `hermes:${runId}:${requestId}`
}

/** Read an `approval.request` event; null when it is not one we can answer. */
export function parseHermesApprovalEvent(
  ev: Record<string, unknown>,
  runId: string,
): Omit<HermesApprovalRequest, 'cwd' | 'agentId' | 'taskId'> | null {
  const timeout = ev['timeout_s']
  const requestId =
    typeof ev['prompt_id'] === 'string'
      ? ev['prompt_id']
      : typeof ev['request_id'] === 'string'
        ? ev['request_id']
        : ''
  const generation = ev['execution_generation']
  const command = typeof ev['command'] === 'string' ? ev['command'] : ''
  if (!requestId || typeof generation !== 'number' || !command) return null
  const description = typeof ev['description'] === 'string' ? ev['description'].trim() : ''
  return {
    runId,
    requestId,
    executionGeneration: generation,
    command,
    description: description || null,
    timeoutMs:
      typeof timeout === 'number' && Number.isFinite(timeout) && timeout > 0
        ? Math.round(timeout * 1000)
        : null,
  }
}

/** Open a card for a command Hermes is holding. Idempotent on the id. */
export function openHermesApproval(
  db: ClawbooDb,
  client: HermesClient,
  req: HermesApprovalRequest,
  now = Date.now(),
): string {
  const id = hermesApprovalId(req.runId, req.requestId)
  pending.set(id, {
    client,
    runId: req.runId,
    requestId: req.requestId,
    executionGeneration: req.executionGeneration,
  })
  const inserted = db
    .insert(toolCallApprovals)
    .values({
      id,
      kind: HERMES_APPROVAL_KIND,
      toolName: 'run_command',
      agentId: req.agentId,
      taskId: req.taskId,
      argsSummary: JSON.stringify({ command: req.command, ...(req.cwd ? { cwd: req.cwd } : {}) }),
      reason: req.description ?? 'Hermes asks before running this command',
      status: 'pending',
      toolClass: 'destructive',
      toolSummary: req.command.slice(0, 200),
      neverRemember: 1,
      createdAt: now,
      // Hermes's own wait when the event names it, else its default.
      expiresAt: now + (req.timeoutMs ?? HERMES_APPROVAL_TTL_MS),
    })
    .onConflictDoNothing()
    .returning()
    .all()
  for (const row of inserted) emitEvent(db, approvalEvent(db, 'approval_requested', row))
  return id
}

/**
 * Cards whose answer is on its way to Hermes. Hermes may report the card settled
 * before it replies to the answer: that settle waits here, so the row is written
 * once, with the person's decision, by the answer. A second answer meanwhile is
 * refused rather than racing the first.
 */
const answering = new Map<string, { settledAs?: string | null }>()

/** Hermes settled it (an answer from here, a timeout, the run ending). Its
 *  `approval.settled` event names no answer: a card past its deadline expired,
 *  one settled before it was answered somewhere else (`resolved`). */
export function settleHermesApproval(db: ClawbooDb, id: string, status: string | null): void {
  const inFlight = answering.get(id)
  if (inFlight) {
    inFlight.settledAs = status
    return
  }
  pending.delete(id)
  const now = Date.now()
  const row = db
    .select({ expiresAt: toolCallApprovals.expiresAt })
    .from(toolCallApprovals)
    .where(eq(toolCallApprovals.id, id))
    .get()
  const settled = status ?? (row && now >= row.expiresAt - 5_000 ? 'expired' : 'resolved')
  const rows = db
    .update(toolCallApprovals)
    .set({ status: settled, resolvedAt: now })
    .where(and(eq(toolCallApprovals.id, id), eq(toolCallApprovals.status, 'pending')))
    .returning()
    .all()
  for (const r of rows) emitEvent(db, approvalEvent(db, 'approval_resolved', r))
}

/** Close every card a run left open (it ended, or its stream was lost). */
export function settleRunApprovals(db: ClawbooDb, runId: string): void {
  for (const id of [...pending.keys()]) {
    if (pending.get(id)?.runId === runId) settleHermesApproval(db, id, 'expired')
  }
}

const CHOICE: Record<'allow_once' | 'allow_always' | 'deny', HermesApprovalChoice> = {
  allow_once: 'once',
  // Not offered on the card; a caller that sends it anyway gets "once": an
  // "always" here would land in Hermes's own allow list, out of sight.
  allow_always: 'once',
  deny: 'deny',
}

/** Answer a card: Hermes first, then the row. */
export async function resolveHermesApproval(
  db: ClawbooDb,
  id: string,
  decision: 'allow_once' | 'allow_always' | 'deny',
  opts: { resolvedBy?: PersonRecord | null } = {},
): Promise<{ status: number; body: Record<string, unknown> }> {
  if (answering.has(id)) {
    return { status: 409, body: { error: 'this approval is already being answered' } }
  }
  const p = pending.get(id)
  if (!p) {
    // Clawboo restarted, or the run already ended: nothing holds this command.
    settleHermesApproval(db, id, 'expired')
    return { status: 409, body: { error: 'approval expired' } }
  }
  const inFlight: { settledAs?: string | null } = {}
  answering.set(id, inFlight)
  try {
    await p.client.answerApproval(p.runId, {
      requestId: p.requestId,
      executionGeneration: p.executionGeneration,
      choice: CHOICE[decision],
    })
  } catch (err) {
    answering.delete(id)
    const status = (err as { status?: number }).status
    if (status === 409 || status === 404) {
      // Timed out, or the run moved on.
      settleHermesApproval(db, id, 'expired')
      return { status: 409, body: { error: 'approval expired' } }
    }
    // Not delivered. A settle Hermes reported meanwhile still applies.
    if ('settledAs' in inFlight) settleHermesApproval(db, id, inFlight.settledAs ?? null)
    log.warn(
      { id, err: err instanceof Error ? err.message : String(err) },
      'hermes approval answer failed',
    )
    return { status: 502, body: { error: 'Hermes did not accept that decision' } }
  }
  answering.delete(id)
  pending.delete(id)
  const row = recordHermesAnswer(db, id, decision === 'deny' ? 'deny' : 'allow_once', opts)
  return { status: 200, body: { ok: true, kind: HERMES_APPROVAL_KIND, approval: row } }
}

/**
 * Record an answer Hermes took. Hermes holds the deadline: once it accepted the
 * answer, the command ran (or was refused) whatever the card's own clock says
 * when the reply comes back, so the card is not checked against its deadline
 * here, as a local waiter's is (`resolveApproval`). Named with the answer, in
 * the same write.
 */
function recordHermesAnswer(
  db: ClawbooDb,
  id: string,
  decision: 'allow_once' | 'deny',
  opts: { resolvedBy?: PersonRecord | null },
): DbToolCallApproval | null {
  const rows = db
    .update(toolCallApprovals)
    .set({ status: decision, resolvedAt: Date.now(), resolvedBy: personJson(opts.resolvedBy) })
    .where(and(eq(toolCallApprovals.id, id), eq(toolCallApprovals.status, 'pending')))
    .returning()
    .all()
  for (const r of rows) emitEvent(db, approvalEvent(db, 'approval_resolved', r))
  return (
    rows[0] ?? db.select().from(toolCallApprovals).where(eq(toolCallApprovals.id, id)).get() ?? null
  )
}

/** At start: no card from before can still be answered. */
export function expireOrphanedHermesApprovals(db: ClawbooDb): number {
  const rows = db
    .update(toolCallApprovals)
    .set({ status: 'expired', resolvedAt: Date.now() })
    .where(
      and(
        eq(toolCallApprovals.kind, HERMES_APPROVAL_KIND),
        eq(toolCallApprovals.status, 'pending'),
      ),
    )
    .returning()
    .all()
  for (const row of rows) emitEvent(db, approvalEvent(db, 'approval_resolved', row))
  return rows.length
}

/** Tests only. */
export function clearPendingHermesApprovals(): void {
  pending.clear()
  answering.clear()
}
