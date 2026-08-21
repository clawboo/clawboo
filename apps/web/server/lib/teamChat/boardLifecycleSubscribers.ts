// Board-lifecycle bus subscribers — the app-side half of the "one door" plane.
// The repository publishes every board mutation post-commit (@clawboo/db
// board/events); these subscribers turn those notifications into the pushes
// the investigation found missing:
//
//   1. SSE forward — a board mutation from ANY path (MCP tool, executor,
//      sweep, REST) reaches open team-chat streams' `board` channel, not just
//      the engine's own mutations.
//   2. Wake-on-work — a delegation-derived task created or released outside a
//      live engine (an MCP `create_task`, a sweep release) schedules a pump for
//      its team within seconds instead of the 60-s interval.
//   3. Mailbox writer — an executor-path terminal for a delegated task, landing
//      while NO orchestrator instance is alive to reflect it, becomes a durable
//      `agent_inbox` row for the delegator, delivered by the next digest /
//      piggyback. This closes the "completed through the other door and nobody
//      ever heard" vacuum.
//   4. Leader signal — while the team leader has a LIVE native run, a terminal
//      for a delegated task is also pushed mid-run through the adapter's
//      writeContext seam (ambient FYI; the engine's `[Task Update]` remains the
//      actionable envelope).
//
// Registered once at boot. Every handler is best-effort and synchronous-cheap;
// anything heavier (the pump) is debounced and detached.

import {
  enqueueInbox,
  getTask,
  listUndeliveredInbox,
  onBoardLifecycle,
  type BoardLifecycleEvent,
} from '@clawboo/db'
import { createLogger } from '@clawboo/logger'

import { getDb } from '../db'
import { publishBoardChange } from './boardChangeBus'
import { recipientFor } from './inboxNotices'
import { getTeamOrchestrator, hasTeamOrchestrator } from './teamOrchestrator'

const log = createLogger('board-lifecycle')

/** Mirrors the engine's `:agent:` pump-fireable marker. */
const SDID_AGENT_RE = /:agent:/

const TERMINAL_EXEC_STATUSES = new Set(['succeeded', 'failed', 'timed_out'])

/** Debounce: at most one scheduled pump per team per window. */
const pendingPumps = new Map<string, ReturnType<typeof setTimeout>>()
const PUMP_DEBOUNCE_MS = 2_000

function schedulePump(teamId: string, mcpBaseUrl: string | null): void {
  if (pendingPumps.has(teamId)) return
  const t = setTimeout(() => {
    pendingPumps.delete(teamId)
    getTeamOrchestrator(teamId, { mcpBaseUrl })
      .pump()
      .catch((err: unknown) => log.error({ err, teamId }, 'wake-on-work pump failed'))
  }, PUMP_DEBOUNCE_MS)
  ;(t as { unref?: () => void }).unref?.()
  pendingPumps.set(teamId, t)
}

function statusForSse(
  ev: BoardLifecycleEvent,
): { status?: string; assigneeAgentId?: string | null } | null {
  switch (ev.kind) {
    case 'task_created':
      // The event carries the CREATED status: `create_task` accepts one, so a
      // hardcoded 'todo' filed a task born in_progress/blocked into the wrong
      // column until the next mutation corrected it.
      return { status: ev.status }
    case 'task_claimed':
      // Carry the assignee: an external claim (MCP, executor) must not render
      // as an ownerless in_progress card.
      return { status: 'in_progress', assigneeAgentId: ev.assigneeAgentId }
    case 'status_changed':
      return { status: ev.status }
    case 'task_released':
      return { status: 'todo', assigneeAgentId: null }
    default:
      return null // comments / exec terminals have no card-status projection
  }
}

let registered = false

/** Register all subscribers (idempotent; called once from boot). */
export function registerBoardLifecycleSubscribers(opts: { mcpBaseUrl: string | null }): void {
  if (registered) return
  registered = true

  onBoardLifecycle((ev) => {
    // 1. SSE forward — live cards for mutations from every path. Duplicate
    // patches with the engine's own onBoardChange are harmless (idempotent
    // client patch, the documented convergence property).
    if (ev.teamId) {
      const patch = statusForSse(ev)
      if (patch) publishBoardChange(ev.teamId, { id: ev.taskId, ...patch, updatedAt: Date.now() })
    }

    // 2a. DETACH-ON-RELEASE — a task freed out of band (the stale sweep, an
    // orphan reap, a human moving the card) may still be mapped to a session by
    // a RESIDENT engine. Until that mapping is dropped, `fireTask` refuses every
    // re-fire and the idle watchdog eventually fails a task no process is
    // running, cancelling its dependents.
    //
    // What is load-bearing is that this stays SYNCHRONOUS. The pump is debounced
    // by PUMP_DEBOUNCE_MS, so any detach performed in this handler necessarily
    // runs first; debouncing the detach as well would reopen the window and let a
    // pump read a session map that still pins the task. (Source order relative to
    // `schedulePump` below therefore does NOT matter — do not add a test that
    // pretends it does.) Only touch an ALREADY-resident engine: building one just
    // to tell it to forget something it never knew is pure cost.
    if (
      ev.teamId &&
      (ev.kind === 'task_released' ||
        (ev.kind === 'status_changed' && (ev.status === 'todo' || ev.status === 'cancelled')))
    ) {
      const teamId = ev.teamId
      if (hasTeamOrchestrator(teamId)) {
        try {
          getTeamOrchestrator(teamId, { mcpBaseUrl: opts.mcpBaseUrl }).detachTask(ev.taskId)
        } catch (err) {
          log.error({ err, taskId: ev.taskId, teamId }, 'detach-on-release failed')
        }
      }
    }

    // 2b. Wake-on-work — delegation-derived work appearing outside a live
    // engine's own flow gets its team pumped within seconds.
    if (
      ev.teamId &&
      ((ev.kind === 'task_created' && SDID_AGENT_RE.test(ev.sourceDelegationId ?? '')) ||
        ev.kind === 'task_released')
    ) {
      schedulePump(ev.teamId, opts.mcpBaseUrl)
    }

    // 3 + 4. Terminal notification for a delegated task. The mailbox row is
    // UNCONDITIONAL (residency is not delivery: a resident-but-idle recipient
    // would otherwise hear nothing — the engine's reflection covers only
    // engine-path terminals it observed itself, and signalAgent is a no-op
    // without a live run). The dedupe check bounds stacking; the live signal is
    // an ADDITIVE ambient FYI on top, never the delivery of record. An
    // engine-path terminal may thus produce both a [Task Update] and a later
    // one-line digest entry — mild redundancy, bought for zero dropped notices.
    // Only engine-owned execs ('openclaw') are skipped: their reflection is the
    // engine's own synchronous duty and double-writing every cascade step would
    // drown the digest.
    if (
      ev.kind === 'execution_completed' &&
      TERMINAL_EXEC_STATUSES.has(ev.status) &&
      ev.executorType !== 'openclaw'
    ) {
      try {
        const db = getDb()
        const recipient = recipientFor(db, ev.taskId, ev.teamId)
        if (!recipient) return
        const task = getTask(db, ev.taskId)
        // Cheap dedupe: don't stack an identical undelivered row per rotation.
        const body = `“${task?.title ?? ev.taskId}” finished with ${ev.status}. Check the board for the result.`
        const already = listUndeliveredInbox(db, recipient, { teamId: ev.teamId }).some(
          (r) => r.taskId === ev.taskId && r.body === body,
        )
        if (!already)
          enqueueInbox(db, {
            agentId: recipient,
            teamId: ev.teamId,
            kind: 'task_update',
            taskId: ev.taskId,
            body,
          })
        if (ev.teamId && hasTeamOrchestrator(ev.teamId)) {
          // Additive ambient mid-run signal to a LIVE recipient run (native
          // routes it into the conversation; other runtimes hear the mailbox
          // row via the MCP piggyback / next digest).
          getTeamOrchestrator(ev.teamId, { mcpBaseUrl: opts.mcpBaseUrl }).signalAgent(
            recipient,
            `[team signal] A delegated task just finished (${ev.status}). Details follow at your next turn or tool call.`,
          )
        }
      } catch (err) {
        log.error({ err, taskId: ev.taskId }, 'terminal notification failed')
      }
    }
  })
}

/** Test seam: allow re-registration after resetBoardLifecycleListeners(). */
export function resetBoardLifecycleRegistration(): void {
  registered = false
  for (const t of pendingPumps.values()) clearTimeout(t)
  pendingPumps.clear()
}
