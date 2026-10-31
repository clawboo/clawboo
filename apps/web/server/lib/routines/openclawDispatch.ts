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
  startTaskHeartbeat,
  updateStatus,
  type BudgetScope,
  type ClawbooDb,
  type CompleteExecOutcome,
  type DbAgent,
  type DbScheduledRun,
} from '@clawboo/db'
import type { RuntimeEvent } from '@clawboo/executor'
import { usdToFractionalCents } from '@clawboo/governance'
import type { TaskTemplate } from '@clawboo/scheduler'
import { KeyedMutex } from '@clawboo/worktrees'

import { budgetPreflight } from '../budgetPreflight'
import { openclawAgentModel } from '../openclawAgentModel'
import { registerRunStop, type RunStopHandle } from '../runStops'
import { registerRunSteer } from '../runSteers'
import { emitEvent } from '../obs'
import { createRunCostTally, type SettledRunCost } from '../runtimes/runCostTally'
import type { RoutineDispatchOutcome } from './wakeBridge'

const DEFAULT_WATCHDOG_MS = 10 * 60_000 // 10 min

/**
 * The executor type this dispatcher records on its execution rows. On the board
 * ledger `'openclaw'` means a run the team orchestrator started itself: the
 * engine's resume() attaches its idle watchdog to such a row, and the lifecycle
 * bus leaves its completion for the engine to report. A routine run is neither,
 * so it records its own type and the engine leaves it alone.
 */
export const ROUTINE_OPENCLAW_EXECUTOR = 'openclaw-routine'

export type OperatorClientLike = OpenClawGatewayClient

/** The slice of the adapter this dispatcher drives (a test seam — the budget
 *  branch needs injectable `cost` events; the live Gateway emits none yet). */
export interface ConnectedAdapterLike {
  start: OpenClawAdapter['start']
  events: OpenClawAdapter['events']
  abort: OpenClawAdapter['abort']
  /** Present on the real adapter: lets a person's comment steer the run. */
  capabilities?: OpenClawAdapter['capabilities']
  steer?: OpenClawAdapter['steer']
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

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
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
  const { db, run, taskId } = input

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

  // The task is ours from here, so it has to BEAT for as long as this drain owns
  // it. The stale sweep releases an `in_progress` task whose `updatedAt` has not
  // moved within the TTL (3 min), and this drain legitimately runs up to
  // `watchdogMs()` (10 min default) without otherwise touching the row. Without a
  // beat the sweep reclaims a task that is still being worked, and the real
  // completion then lands on a ledger row the sweep already closed as `timed_out`
  // — which `completeExecutionProcess` refuses, leaving the ledger, the obs stream
  // and the card disagreeing. This is the THIRD claiming drain; the executor
  // runner and the team orchestrator's serverDeliver already beat.
  const stopBeat = startTaskHeartbeat(db, taskId, { assigneeAgentId: run.agentId })
  // A person moving the card stops the run (see runStops). The drain watches for
  // that beside the Gateway's events, so it ends at once rather than at the
  // watchdog.
  let wakeOnStop: () => void = () => {}
  const stopped = new Promise<'stopped'>((resolve) => {
    wakeOnStop = () => resolve('stopped')
  })
  const stop = registerRunStop(taskId, () => wakeOnStop())
  try {
    return await drainClaimedRoutineRun(input, gatewayAgentId, missionId, stop, stopped)
  } catch (err) {
    // Whatever the drain did not settle itself. The claim is ours, so hand the
    // task back instead of leaving it in progress with nothing driving it.
    try {
      releaseTask(db, taskId)
    } catch {
      // The stale sweep releases it.
    }
    return { ok: false, taskId, error: `run failed: ${errorText(err)}` }
  } finally {
    stop.release()
    stopBeat()
  }
}

/**
 * The post-claim half of a connected-substrate dispatch: open the ledger row,
 * drive the Gateway to a terminal, and settle the board. Split out of its caller
 * purely so the liveness beat can wrap it in ONE `finally` that covers every exit
 * path, including a throw.
 */
async function drainClaimedRoutineRun(
  input: ConnectedDispatchInput,
  gatewayAgentId: string,
  missionId: string,
  stop: RunStopHandle,
  stopped: Promise<'stopped'>,
): Promise<RoutineDispatchOutcome> {
  const { db, run, template, taskId, client } = input

  const exec = createExecutionProcess(db, {
    taskId,
    executorType: ROUTINE_OPENCLAW_EXECUTOR,
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

  // Close the ledger row and emit the obs completion that pairs with the
  // `execution_started` above. The emit is CONDITIONAL on the close winning: a
  // terminal ledger row is immutable (first terminal wins), so a row something
  // else already closed refuses this one and returns null — and emitting anyway
  // would put a `succeeded` on the obs stream for a run the ledger records as
  // timed out. `serverBoardClient` and `api/board` guard the same way.
  const settleExec = (outcome: CompleteExecOutcome, data: Record<string, unknown>): void => {
    if (!completeExecutionProcess(db, exec.id, outcome)) return
    emitEvent(db, {
      kind: 'execution_completed',
      taskId,
      teamId: run.teamId,
      agentId: run.agentId,
      runtime: 'openclaw',
      tenantId: run.tenantId,
      data: { execId: exec.id, ...data },
    })
  }

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
  // What the run cost, priced once on whichever path ends it, the way a team-chat
  // run is: USD the Gateway reported, then usage tokens, then an estimate from the
  // text, since the live Gateway reports neither. A failed, timed-out or stopped
  // run spent tokens too, so every ending is charged, not only a success. The
  // estimate is priced at the routine's model, else the agent's in openclaw.json,
  // so an agent on a local Ollama is charged nothing.
  const costTally = createRunCostTally()
  const pricedModel = template.model ?? openclawAgentModel(gatewayAgentId)
  let outputText = ''
  let costSettled: SettledRunCost | null = null
  /** Charge the budgets what no cost event already did; returns the cap it paused, if any. */
  const settleSpend = (output: string): BudgetScope | null => {
    if (costSettled) return null
    const cost = costTally.settle({
      model: pricedModel,
      inputChars: dispatchPromptChars,
      outputChars: output.length,
    })
    costSettled = cost
    if (cost.unbilledUsd <= 0) return null
    const estimated = cost.costSource !== 'reported'
    const cents = usdToFractionalCents(cost.unbilledUsd)
    const scopes: [BudgetScope, string | null][] = [
      ['agent', run.agentId],
      ['mission', missionId],
      ['team', run.teamId],
    ]
    let pausedScope: BudgetScope | null = null
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
    return pausedScope
  }
  /** The settled cost as the run's ledger row records it. */
  const ledgerCost = (): Pick<
    CompleteExecOutcome,
    'costUsd' | 'costSource' | 'inputTokens' | 'outputTokens'
  > =>
    costSettled
      ? {
          costUsd: costSettled.costUsd,
          costSource: costSettled.costSource,
          inputTokens: costSettled.inputTokens,
          outputTokens: costSettled.outputTokens,
        }
      : {}
  // The work already happened (it cannot be un-spent), so a cap this run crossed
  // is enforced by the pre-flight gate blocking the NEXT fire. Say so on the task.
  const noteCapReached = (pausedScope: BudgetScope | null): void => {
    if (!pausedScope) return
    addComment(
      db,
      taskId,
      `Budget cap reached (${pausedScope}). This run is recorded; the next scheduled fire is blocked until you raise the cap or resume.`,
      'system',
    )
  }

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
    settleExec({ status: 'failed', error: message }, { status: 'failed', error: message })
    releaseTask(db, taskId)
    return { ok: false, taskId, error: `gateway dispatch failed: ${message}` }
  }

  // Drain to the first terminal `done`, bounded by the watchdog. `error`
  // events are remembered but only `done` (or the watchdog) is terminal.
  const deadline = Date.now() + watchdogMs(input.watchdogMs)
  const iterator = adapter.events(runHandle)[Symbol.asyncIterator]()
  // A person commenting on the task steers this run while it works (see runSteers).
  const steerHandle = registerRunSteer(taskId, adapter, runHandle)
  let terminal: (RuntimeEvent & { kind: 'done' }) | null = null
  let lastError: string | null = null
  let stopForBudget: string | null = null
  let timedOut = false
  // A stream that throws (the operator connection dropped mid-run) ends the run
  // as surely as a `done` does.
  let streamError: string | null = null

  try {
    for (;;) {
      const remaining = deadline - Date.now()
      if (remaining <= 0) {
        timedOut = true
        break
      }
      let timer: ReturnType<typeof setTimeout> | undefined
      let raced: IteratorResult<RuntimeEvent> | 'timeout' | 'stopped'
      try {
        raced = await Promise.race([
          iterator.next(),
          new Promise<'timeout'>((resolve) => {
            timer = setTimeout(() => resolve('timeout'), remaining)
            timer.unref?.()
          }),
          stopped,
        ])
      } finally {
        if (timer) clearTimeout(timer)
      }
      if (raced === 'stopped') break
      if (raced === 'timeout') {
        timedOut = true
        break
      }
      if (raced.done) break
      const ev = raced.value
      costTally.observe(ev)
      if (ev.kind === 'text-delta' && ev.channel !== 'reasoning') outputText += ev.text
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
        // every scope, abort on the first cap-mode pause. A usage-only event
        // (null USD) records $0 here; the tally prices it when the run settles.
        const cents = usdToFractionalCents(ev.costUsd ?? 0)
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
  } catch (err) {
    streamError = errorText(err)
  } finally {
    steerHandle.release()
    await Promise.resolve(iterator.return?.()).catch(() => undefined)
  }

  // A person moved the card while it ran. Their move is the task's outcome, so
  // this is not a failed fire: the run is stopped, its execution is closed as
  // cancelled with their note, and the task stays where they put it (the release
  // below only touches a task still in progress). A result that came in at the
  // same moment is kept as a comment.
  if (stop.note !== null) {
    await adapter.abort(runHandle).catch(() => undefined)
    noteCapReached(settleSpend(terminal?.summary || outputText))
    settleExec(
      { status: 'cancelled', error: stop.note, ...ledgerCost() },
      { status: 'cancelled', error: stop.note },
    )
    if (terminal?.reason === 'success' && terminal.summary)
      addComment(
        db,
        taskId,
        `[late result: a person had already moved this task] ${terminal.summary}`,
        'agent',
        run.agentId,
      )
    addComment(db, taskId, stop.note, 'system')
    releaseTask(db, taskId)
    return { ok: true, taskId }
  }

  if (streamError !== null) {
    await adapter.abort(runHandle).catch(() => undefined)
    const error = `run failed: ${streamError}`
    noteCapReached(settleSpend(outputText))
    settleExec({ status: 'failed', error, ...ledgerCost() }, { status: 'failed', error })
    releaseTask(db, taskId)
    return { ok: false, taskId, error }
  }

  if (stopForBudget) {
    await adapter.abort(runHandle).catch(() => undefined)
    // Already paused, so the auto-pause comment below covers any cap this crosses.
    settleSpend(outputText)
    addComment(
      db,
      taskId,
      `Auto-paused: ${stopForBudget} budget reached. Raise the cap (or resume) to continue.`,
      'system',
    )
    settleExec(
      { status: 'cancelled', error: `budget_paused:${stopForBudget}`, ...ledgerCost() },
      { status: 'cancelled', error: `budget_paused:${stopForBudget}` },
    )
    releaseTask(db, taskId)
    return { ok: false, taskId, error: `auto-paused (budget: ${stopForBudget})` }
  }

  if (timedOut || !terminal) {
    await adapter.abort(runHandle).catch(() => undefined)
    const error = timedOut
      ? 'watchdog timeout — no terminal event from the Gateway'
      : (lastError ?? 'event stream ended without a terminal')
    noteCapReached(settleSpend(outputText))
    settleExec(
      { status: timedOut ? 'timed_out' : 'failed', error, ...ledgerCost() },
      { status: timedOut ? 'timed_out' : 'failed', error },
    )
    releaseTask(db, taskId)
    return { ok: false, taskId, error }
  }

  if (terminal.reason === 'success') {
    const summary = terminal.summary || '(no output)'
    addComment(db, taskId, summary, 'agent', run.agentId)
    noteCapReached(settleSpend(terminal.summary || outputText))
    // Not `settleExec` here: the obs completion has to stay BELOW the audit and
    // the status write, so the close and its emit are split. `closed` carries
    // whether this run actually won the ledger row through to both.
    const settled = ledgerCost()
    const closed = completeExecutionProcess(db, exec.id, {
      status: 'succeeded',
      summary,
      ...settled,
      inputTokens: settled.inputTokens ?? terminal.usage?.inputTokens ?? null,
      outputTokens: settled.outputTokens ?? terminal.usage?.outputTokens ?? null,
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
      addComment(
        db,
        taskId,
        closed
          ? `Could not finalize task (${doneRes.reason ?? 'unknown'}).`
          : `This run finished successfully, but its execution had already been closed by something else (a stale-task sweep, or an abort), so the task could not be marked done (${doneRes.reason ?? 'unknown'}). The work is real; check the board before re-running it.`,
        'system',
      )
    }
    if (closed) {
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
          costUsd: settled.costUsd ?? null,
          inputTokens: settled.inputTokens ?? terminal.usage?.inputTokens,
          outputTokens: settled.outputTokens ?? terminal.usage?.outputTokens,
        },
      })
    }
    return { ok: true, taskId }
  }

  const error = `run ${terminal.reason}: ${terminal.summary || lastError || '(no output)'}`
  noteCapReached(settleSpend(terminal.summary || outputText))
  settleExec({ status: 'failed', error, ...ledgerCost() }, { status: 'failed', error })
  releaseTask(db, taskId)
  return { ok: false, taskId, error }
}
