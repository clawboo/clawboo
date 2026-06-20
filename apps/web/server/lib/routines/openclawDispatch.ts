// The thin connected-substrate dispatcher — the ONE path runTaskOnRuntime
// refuses by design (a connected-substrate runtime executes over its LIVE
// Gateway connection; the one-shot runner must never spawn it). The wake is
// clawboo's; the execution is the operator asking the connected agent to do
// bounded team work NOW over the server-held operator client. clawboo does
// NOT create a Gateway cron entry — that is the agent's own-life domain.
//
// Completion observation: drain the existing @clawboo/adapter-openclaw event
// stream over the operator client (the adapter already normalizes Gateway
// frames into terminal done/error events — no new protocol surface), bounded
// by a watchdog. A pure dispatch-and-record would leak in_progress board tasks
// with no closer; the watchdog (abort + release on expiry) is the documented
// degradation when frames stop flowing.

import { OpenClawAdapter, type OpenClawGatewayClient } from '@clawboo/adapter-openclaw'
import {
  addComment,
  appendAudit,
  claimTask,
  completeExecutionProcess,
  createExecutionProcess,
  getAncestors,
  recordSpend,
  releaseTask,
  updateStatus,
  type BudgetScope,
  type ClawbooDb,
  type DbAgent,
  type DbScheduledRun,
} from '@clawboo/db'
import type { RuntimeEvent } from '@clawboo/executor'
import { usdToFractionalCents } from '@clawboo/governance'
import type { TaskTemplate } from '@clawboo/scheduler'
import { KeyedMutex } from '@clawboo/worktrees'

import { budgetPreflight } from '../budgetPreflight'
import { emitEvent } from '../obs'
import { estimateRunCostUsd } from '../runtimes/estimateCost'
import type { RoutineDispatchOutcome } from './wakeBridge'

const DEFAULT_WATCHDOG_MS = 10 * 60_000 // 10 min

export type OperatorClientLike = OpenClawGatewayClient

/** The slice of the adapter this dispatcher drives (a test seam — the budget
 *  branch needs injectable `cost` events; the live Gateway emits none yet). */
export interface ConnectedAdapterLike {
  start: OpenClawAdapter['start']
  events: OpenClawAdapter['events']
  abort: OpenClawAdapter['abort']
}

export interface ConnectedDispatchInput {
  db: ClawbooDb
  run: DbScheduledRun
  template: TaskTemplate
  agentRow: DbAgent
  /** The board task the wake-bridge materialized (or bound). */
  taskId: string
  client: OperatorClientLike
  /** Override for tests; default 10 min via CLAWBOO_ROUTINE_OPENCLAW_TIMEOUT_MS. */
  watchdogMs?: number
  /** Test seam; defaults to the real OpenClawAdapter over `client`. */
  makeAdapter?: (client: OperatorClientLike) => ConnectedAdapterLike
}

function watchdogMs(override?: number): number {
  if (override != null) return override
  const raw = process.env['CLAWBOO_ROUTINE_OPENCLAW_TIMEOUT_MS']
  const n = raw ? Number(raw) : NaN
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_WATCHDOG_MS
}

function missionRootId(db: ClawbooDb, taskId: string): string {
  const ancestors = getAncestors(db, taskId)
  if (ancestors.length === 0) return taskId
  return ancestors.find((a) => a.parent_task_id == null)?.id ?? taskId
}

// Serialize same-(gateway agent) fires. The routine ticker dispatches due fires
// CONCURRENTLY, and the connected substrate is NOT covered by the executor's
// per-home mutex (it has no persistent home), so two routine fires for ONE
// OpenClaw agent would otherwise open two overlapping sessions on it. Mirror the
// persistent-home precedent — a per-gatewayAgent mutex; cross-agent fires stay parallel.
// EXPORTED so the team-chat connected-runtime path serializes on this SAME instance:
// a routine fire and a chat turn for one OpenClaw agent must not overlap sessions.
export const connectedAgentMutex = new KeyedMutex()

/** The shared serialization key for an OpenClaw agent — identical between the routine
 *  dispatcher and the team-chat connected branch so both contend on one mutex entry. */
export function connectedAgentKey(agentRow: {
  sourceAgentId?: string | null
  gatewayId?: string | null
  id: string
}): string {
  return `openclaw:${agentRow.sourceAgentId ?? agentRow.gatewayId ?? agentRow.id}`
}

export async function dispatchConnectedSubstrate(
  input: ConnectedDispatchInput,
): Promise<RoutineDispatchOutcome> {
  const gatewayAgentId =
    input.agentRow.sourceAgentId ?? input.agentRow.gatewayId ?? input.agentRow.id
  return connectedAgentMutex.run(connectedAgentKey(input.agentRow), () =>
    dispatchConnectedSubstrateInner(input, gatewayAgentId),
  )
}

async function dispatchConnectedSubstrateInner(
  input: ConnectedDispatchInput,
  gatewayAgentId: string,
): Promise<RoutineDispatchOutcome> {
  const { db, run, template, taskId, client } = input

  const missionId = missionRootId(db, taskId)
  // Pre-flight cap gate: a paused CAP budget blocks the NEXT fire. The connected
  // substrate reports no incremental cost, so this is the enforceable cap — the
  // run never starts (no claim, no exec) when a relevant scope is already paused.
  const pre = budgetPreflight(db, { agentId: run.agentId, missionId, teamId: run.teamId })
  if (pre.blocked) {
    return { ok: false, taskId, error: `budget_paused:${pre.scope}` }
  }

  // Atomic claim — a lost claim means another worker owns the task; the work
  // is happening, so the fire is satisfied (drop, never retry).
  const claim = claimTask(db, taskId, run.agentId, 'openclaw')
  if (!claim.ok) {
    return claim.reason === 'conflict'
      ? { ok: true, taskId }
      : { ok: false, taskId, error: `claim failed: ${claim.reason ?? 'unknown'}` }
  }

  const exec = createExecutionProcess(db, {
    taskId,
    executorType: 'openclaw',
    runReason: 'routine',
  })
  emitEvent(db, {
    kind: 'execution_started',
    taskId,
    teamId: run.teamId,
    agentId: run.agentId,
    runtime: 'openclaw',
    tenantId: run.tenantId,
    data: { execId: exec.id, executorType: 'openclaw', runReason: 'routine' },
  })

  const adapter: ConnectedAdapterLike = input.makeAdapter
    ? input.makeAdapter(client)
    : new OpenClawAdapter(client)
  // Stable per-routine session: context accrues across fires (the Gateway's
  // own `cron:<jobId>` session-keying precedent).
  const sessionKey = `agent:${gatewayAgentId}:clawboo-routine-${run.id}`
  const contextBlock = [
    `# Scheduled team task: ${template.title}`,
    template.description ?? '',
    'Do this bounded piece of team work now and report a concise summary when done.',
  ]
    .filter(Boolean)
    .join('\n\n')
  // Char budget of what we sent (message + context) — the input side of the spend
  // estimate when the Gateway reports no usage.
  const dispatchPromptChars = template.title.length + contextBlock.length

  let runHandle
  try {
    runHandle = await adapter.start(
      { taskId, teamId: run.teamId },
      {
        agentId: gatewayAgentId,
        sessionKey,
        message: template.title,
        ...(template.model ? { model: template.model } : {}),
        context: contextBlock,
      },
    )
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    completeExecutionProcess(db, exec.id, { status: 'failed', error: message })
    releaseTask(db, taskId)
    emitEvent(db, {
      kind: 'execution_completed',
      taskId,
      teamId: run.teamId,
      agentId: run.agentId,
      runtime: 'openclaw',
      tenantId: run.tenantId,
      data: { execId: exec.id, status: 'failed', error: message },
    })
    return { ok: false, taskId, error: `gateway dispatch failed: ${message}` }
  }

  // Drain to the first terminal `done`, bounded by the watchdog. `error`
  // events are remembered but only `done` (or the watchdog) is terminal.
  const deadline = Date.now() + watchdogMs(input.watchdogMs)
  const iterator = adapter.events(runHandle)[Symbol.asyncIterator]()
  let terminal: (RuntimeEvent & { kind: 'done' }) | null = null
  let lastError: string | null = null
  let stopForBudget: string | null = null
  let timedOut = false
  // The live Gateway emits no incremental `cost` events yet, so a successful run's
  // spend arrives ONLY on the terminal `done.costUsd`. Track whether any `cost`
  // event already recorded spend so the terminal fallback can't double-count if a
  // future Gateway starts streaming cost.
  let recordedAnyCost = false

  try {
    for (;;) {
      const remaining = deadline - Date.now()
      if (remaining <= 0) {
        timedOut = true
        break
      }
      let timer: ReturnType<typeof setTimeout> | undefined
      const raced = await Promise.race([
        iterator.next(),
        new Promise<'timeout'>((resolve) => {
          timer = setTimeout(() => resolve('timeout'), remaining)
          timer.unref?.()
        }),
      ])
      if (timer) clearTimeout(timer)
      if (raced === 'timeout') {
        timedOut = true
        break
      }
      if (raced.done) break
      const ev = raced.value
      if (ev.kind === 'cost') {
        emitEvent(db, {
          kind: 'cost',
          taskId,
          teamId: run.teamId,
          agentId: run.agentId,
          runtime: 'openclaw',
          tenantId: run.tenantId,
          data: {
            costUsd: ev.costUsd,
            inputTokens: ev.usage?.inputTokens,
            outputTokens: ev.usage?.outputTokens,
            model: ev.model,
          },
        })
        // The same budget kill-switch as any executor run: record spend on
        // every scope, abort on the first cap-mode pause.
        const cents = usdToFractionalCents(ev.costUsd ?? 0)
        // Only flag `recordedAnyCost` when the event actually carried a cost. A future
        // usage-but-null-cost event records $0 here; setting the flag unconditionally
        // would then suppress the terminal text-estimate (gated on `!recordedAnyCost`)
        // and zero out the run's spend. Mirrors drainTurn's `costUsd != null` guard.
        if (ev.costUsd != null) recordedAnyCost = true
        const a = recordSpend(db, 'agent', run.agentId, cents)
        const m = recordSpend(db, 'mission', missionId, cents)
        const t = run.teamId ? recordSpend(db, 'team', run.teamId, cents) : null
        if (a?.status === 'paused' && a.mode === 'cap') stopForBudget = 'agent'
        else if (m?.status === 'paused' && m.mode === 'cap') stopForBudget = 'mission'
        else if (t?.status === 'paused' && t.mode === 'cap') stopForBudget = 'team'
        if (stopForBudget) break
      } else if (ev.kind === 'error') {
        lastError = ev.message
      } else if (ev.kind === 'done') {
        terminal = ev
        break
      }
    }
  } finally {
    await iterator.return?.()
  }

  if (stopForBudget) {
    await adapter.abort(runHandle).catch(() => undefined)
    addComment(
      db,
      taskId,
      `Auto-paused: ${stopForBudget} budget reached. Raise the cap (or resume) to continue.`,
      'system',
    )
    completeExecutionProcess(db, exec.id, {
      status: 'cancelled',
      error: `budget_paused:${stopForBudget}`,
    })
    releaseTask(db, taskId)
    emitEvent(db, {
      kind: 'execution_completed',
      taskId,
      teamId: run.teamId,
      agentId: run.agentId,
      runtime: 'openclaw',
      tenantId: run.tenantId,
      data: { execId: exec.id, status: 'cancelled', error: `budget_paused:${stopForBudget}` },
    })
    return { ok: false, taskId, error: `auto-paused (budget: ${stopForBudget})` }
  }

  if (timedOut || !terminal) {
    await adapter.abort(runHandle).catch(() => undefined)
    const error = timedOut
      ? 'watchdog timeout — no terminal event from the Gateway'
      : (lastError ?? 'event stream ended without a terminal')
    completeExecutionProcess(db, exec.id, { status: timedOut ? 'timed_out' : 'failed', error })
    releaseTask(db, taskId)
    emitEvent(db, {
      kind: 'execution_completed',
      taskId,
      teamId: run.teamId,
      agentId: run.agentId,
      runtime: 'openclaw',
      tenantId: run.tenantId,
      data: { execId: exec.id, status: timedOut ? 'timed_out' : 'failed', error },
    })
    return { ok: false, taskId, error }
  }

  if (terminal.reason === 'success') {
    const summary = terminal.summary || '(no output)'
    addComment(db, taskId, summary, 'agent', run.agentId)
    // Budget coverage for the connected substrate: the live Gateway emits no
    // incremental `cost` events AND no terminal usage, so a successful run's spend
    // is ESTIMATED from the produced text (input prompt + output summary) when the
    // terminal carries no `costUsd` — so a cap can still engage. A future cost-
    // bearing Gateway's real `costUsd` is used as-is. Skipped if a `cost` event
    // already recorded spend this run (forward-safe against a future Gateway).
    if (!recordedAnyCost) {
      const estimated = terminal.costUsd == null
      const usd = estimated
        ? estimateRunCostUsd({
            model: template.model ?? null,
            inputChars: dispatchPromptChars,
            outputChars: summary.length,
          })
        : terminal.costUsd!
      const cents = usdToFractionalCents(usd)
      const scopes: [BudgetScope, string | null][] = [
        ['agent', run.agentId],
        ['mission', missionId],
        ['team', run.teamId],
      ]
      let pausedScope: string | null = null
      for (const [scope, scopeId] of scopes) {
        if (!scopeId) continue
        const r = recordSpend(db, scope, scopeId, cents)
        if (!r) continue
        if (r.crossed !== 'none') {
          appendAudit(db, {
            eventType: 'budget',
            taskId,
            teamId: run.teamId,
            agentId: run.agentId,
            tenantId: run.tenantId,
            summary: {
              scope,
              scopeId,
              crossed: r.crossed,
              status: r.status,
              mode: r.mode,
              runtime: 'openclaw',
              estimated,
            },
          })
        }
        if (r.status === 'paused' && r.mode === 'cap' && !pausedScope) pausedScope = scope
      }
      if (pausedScope) {
        // The work already happened (we cannot un-spend it); the cap's enforcement
        // is the pre-flight gate blocking the NEXT fire. Surface it to the operator.
        addComment(
          db,
          taskId,
          `Budget cap reached (${pausedScope}). This run is recorded; the next scheduled fire is blocked until you raise the cap or resume.`,
          'system',
        )
      }
    }
    completeExecutionProcess(db, exec.id, {
      status: 'succeeded',
      summary,
      costUsd: terminal.costUsd ?? null,
      inputTokens: terminal.usage?.inputTokens ?? null,
      outputTokens: terminal.usage?.outputTokens ?? null,
    })
    // The connected substrate has no worktree/diff to verify, so this `done` is
    // NOT gated. Surface that explicitly (comment + audit) so the node is not
    // silently over-trusted — distinct from a verified `done`.
    addComment(
      db,
      taskId,
      'Completed without verification (connected-substrate runtime — no worktree to gate).',
      'system',
    )
    appendAudit(db, {
      eventType: 'verification',
      taskId,
      teamId: run.teamId,
      agentId: run.agentId,
      tenantId: run.tenantId,
      summary: { unverified: true, runtime: 'openclaw', reason: 'connected_substrate' },
    })
    // The connected-substrate completion is explicitly audited as unverified above,
    // so this `done` is an INTENTIONAL, recorded override of the intrinsic gate —
    // without it a stale non-promotable verdict from a prior runtime would silently
    // block a legitimate completion (the exec ledger claiming success while the task
    // stayed in_review).
    const doneRes = updateStatus(db, taskId, 'done', { humanOverride: true })
    if (!doneRes.ok) {
      addComment(db, taskId, `Could not finalize task (${doneRes.reason ?? 'unknown'}).`, 'system')
    }
    emitEvent(db, {
      kind: 'execution_completed',
      taskId,
      teamId: run.teamId,
      agentId: run.agentId,
      runtime: 'openclaw',
      tenantId: run.tenantId,
      data: {
        execId: exec.id,
        status: 'succeeded',
        costUsd: terminal.costUsd ?? null,
        inputTokens: terminal.usage?.inputTokens,
        outputTokens: terminal.usage?.outputTokens,
      },
    })
    return { ok: true, taskId }
  }

  const error = `run ${terminal.reason}: ${terminal.summary || lastError || '(no output)'}`
  completeExecutionProcess(db, exec.id, { status: 'failed', error })
  releaseTask(db, taskId)
  emitEvent(db, {
    kind: 'execution_completed',
    taskId,
    teamId: run.teamId,
    agentId: run.agentId,
    runtime: 'openclaw',
    tenantId: run.tenantId,
    data: { execId: exec.id, status: 'failed', error },
  })
  return { ok: false, taskId, error }
}
