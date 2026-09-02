// Durable approval-TTL reaper. A forgotten
// pending approval — its waiter died, or no one ever resolved it — would otherwise
// sit `pending` forever. This is the background timeout-watcher: it expires
// abandoned pending rows after a configurable window (default 24h), unblocks any
// linked task, and audits + emits obs. Idempotent (a second pass expires nothing).
//
// Best-effort + non-blocking, mirroring the orphan-reconciliation / worktree-GC
// boot blocks in server/index.ts: a one-shot pass at boot + a singleton interval
// that is `.unref()`'d so it never holds the process open.

import {
  appendAudit,
  expireStaleApprovals,
  reapToolResults,
  sweepExpiredGrants,
  getTask,
  getTaskVerification,
  unblockTask,
  type ClawbooDb,
} from '@clawboo/db'
import { isVerdictPromotable } from '@clawboo/governance'

import { getDb } from './db'
import { emitEvent } from './obs'

const DEFAULT_TTL_MS = 24 * 60 * 60_000 // 24h
// Stored tool results outlive their run on purpose: an operator reading an audit
// row days later should still be able to see what a tool actually returned.
const RESULT_TTL_MS = 7 * 24 * 60 * 60_000 // 7d
const DEFAULT_INTERVAL_MS = 60 * 60_000 // 1h

interface ReaperLog {
  info: (obj: object, msg: string) => void
  error: (obj: object, msg: string) => void
}

function envMs(name: string, fallback: number): number {
  const raw = process.env[name]
  const n = raw ? Number(raw) : NaN
  return Number.isFinite(n) && n > 0 ? n : fallback
}

export interface ReapResult {
  expired: string[]
  unblocked: string[]
  /** Grants moved to `expired`, and standing rules dropped, by this pass. */
  grantsExpired: number
  rulesExpired: number
  /** Stored tool results dropped by this pass. */
  toolResultsReaped: number
}

/** One reaper pass: expire stale pending approvals, unblock any linked blocked
 *  task, audit + emit obs per row. Returns only the rows expired by THIS pass. */
export function reapStaleApprovals(db: ClawbooDb, opts: { ttlMs?: number } = {}): ReapResult {
  const ttlMs = opts.ttlMs ?? envMs('CLAWBOO_APPROVAL_TTL_MS', DEFAULT_TTL_MS)

  // Grants ride the SAME tick rather than getting their own timer. The gate
  // already denies a past-expiry grant from its timestamp alone, so this sweep
  // is cosmetic for enforcement and load-bearing for everything that reads
  // `state` without running a decision: a list, a count, an audit query.
  //
  // Deliberately inside `reapStaleApprovals` rather than in the interval body:
  // that body is guarded by a module-level `started` flag, so a test could never
  // run one pass over it.
  const swept = sweepExpiredGrants(db)

  // Stored tool results ride the same tick, for the same reason grants do: they
  // are written by a path with no natural point to clean up after itself. Nothing
  // in this repo prunes `tool_call_audit` or `orchestration_events` either, and a
  // spill store is the one of the three that holds whole third-party payloads, so
  // it ships WITH its retention rather than growing until someone notices.
  const reapedResults = reapToolResults(db, envMs('CLAWBOO_TOOL_RESULT_TTL_MS', RESULT_TTL_MS))

  const expiredRows = expireStaleApprovals(db, { olderThanMs: ttlMs })
  const unblocked: string[] = []
  for (const row of expiredRows) {
    appendAudit(db, {
      eventType: 'approval',
      agentId: row.agentId,
      taskId: row.taskId,
      tenantId: row.tenantId,
      summary: { approvalId: row.id, toolName: row.toolName, resolution: 'expired' },
    })
    emitEvent(db, {
      kind: 'approval_resolved',
      taskId: row.taskId,
      agentId: row.agentId,
      data: { approvalId: row.id, decision: 'expired' },
    })
    if (row.taskId) {
      const task = getTask(db, row.taskId)
      // Only unblock a task THIS approval blocked. `blocked` has more than one
      // cause now: verification exhaustion routes here too, and `unblockTask` is
      // `updateStatus(-> todo)`, which nulls the verification cell. Without this
      // check an unrelated approval expiring somewhere else would silently clear a
      // failing verdict and re-queue work a human was asked to look at.
      const verdict = getTaskVerification(db, row.taskId)
      const blockedByVerification = verdict !== null && !isVerdictPromotable(verdict)
      if (task?.status === 'blocked' && !blockedByVerification) {
        unblockTask(db, row.taskId)
        unblocked.push(row.taskId)
      }
    }
  }
  return {
    expired: expiredRows.map((r) => r.id),
    unblocked,
    grantsExpired: swept.grants,
    rulesExpired: swept.rules,
    toolResultsReaped: reapedResults,
  }
}

let started = false
let timer: ReturnType<typeof setInterval> | null = null

/** Start the durable approval-TTL reaper: one pass at boot + a singleton interval.
 *  Best-effort, idempotent, `.unref()`'d so it never holds the process open. */
export function startApprovalReaper(opts: { log: ReaperLog }): void {
  if (started) return
  started = true
  const intervalMs = envMs('CLAWBOO_APPROVAL_REAPER_INTERVAL_MS', DEFAULT_INTERVAL_MS)

  const runOnce = (): void => {
    try {
      const { expired, unblocked } = reapStaleApprovals(getDb())
      if (expired.length > 0 || unblocked.length > 0) {
        opts.log.info(
          { expired: expired.length, unblocked: unblocked.length },
          'Approvals: reaper expired stale approvals',
        )
      }
    } catch (err) {
      opts.log.error({ err }, 'Approvals: reaper pass failed (non-fatal)')
    }
  }

  runOnce()
  timer = setInterval(runOnce, intervalMs)
  timer.unref()

  const stop = (): void => {
    if (timer) clearInterval(timer)
    timer = null
  }
  process.once('SIGTERM', stop)
  process.once('SIGINT', stop)
}
