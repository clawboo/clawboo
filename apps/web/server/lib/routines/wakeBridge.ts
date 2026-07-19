// The wake-bridge: a Routine fire is JUST ANOTHER TASK DISPATCH through the
// standard executor pipeline — budgets / approvals / verification / obs /
// worktree-of-record all apply; never a side channel. The dispatch branches on
// RUNTIME CLASS read from the adapter capabilities seam
// (resolveRuntimeIntegration(caps).home.kind), never a hardcoded id switch:
//   - 'ephemeral' | 'persistent' (native + wrapped-oneshot) → runTaskOnRuntime
//   - 'connected' (OpenClaw) → the thin operator dispatcher (the one path the
//     one-shot runner refuses BY DESIGN)
//   - a human participant → reachable typed NotImplementedError (a human
//     Routine becomes a scheduled board ping, not a spawned process)

import { OpenClawAdapter } from '@clawboo/adapter-openclaw'
import {
  agents,
  createTask,
  getTask,
  type ClawbooDb,
  type DbAgent,
  type DbScheduledRun,
  type DbTask,
} from '@clawboo/db'
import { resolveRuntimeIntegration, type RuntimeAdapter } from '@clawboo/executor'
import { NotImplementedError, parseTaskTemplate, type TaskTemplate } from '@clawboo/scheduler'
import { eq } from 'drizzle-orm'

import { getRegistry } from '../agentSource'
import { emitEvent } from '../obs'
import { runTaskOnRuntime } from '../executorRunner'
import { adapterFactoryFor } from '../runtimes'
import { getDescriptor, isRuntimeId } from '../runtimes/descriptor'
import { resolveRuntimeKeyForRuntime } from '../secretsVault'
import { dispatchConnectedSubstrate, type OperatorClientLike } from './openclawDispatch'

export interface RoutineDispatchOutcome {
  ok: boolean
  taskId?: string | null
  error?: string
}

export interface WakeBridgeDeps {
  db: ClawbooDb
  mcpBaseUrl: string | null
  /** Test seam: the one-shot executor entry point. */
  runTask?: typeof runTaskOnRuntime
  /** Test seam: the connected-substrate dispatcher. */
  dispatchConnected?: typeof dispatchConnectedSubstrate
  /** Test seam: the live operator client (default: the registry's source). */
  getOperatorClient?: () => OperatorClientLike | null
}

function loadAgentRow(db: ClawbooDb, agentId: string): DbAgent | null {
  return (
    (db.select().from(agents).where(eq(agents.id, agentId)).get() as DbAgent | undefined) ?? null
  )
}

/** Vault → spawned-run env, mirroring the runtimes REST run handler. */
function buildApiKeyEnv(runtime: string): Record<string, string> {
  const apiKeyEnv: Record<string, string> = {}
  if (!isRuntimeId(runtime)) return apiKeyEnv
  const d = getDescriptor(runtime)
  for (const envVar of [d.envVar, ...(d.altEnvVars ?? [])]) {
    if (!envVar) continue
    const key = resolveRuntimeKeyForRuntime(runtime, envVar)
    if (key) apiKeyEnv[envVar] = key
  }
  return apiKeyEnv
}

/**
 * Materialize the bounded team task for this fire: either the task bound at
 * registration (which must be claimable) or a fresh per-fire task stamped
 * `scheduledBy: 'clawboo'` (the firing owner of record).
 */
function materializeTask(
  db: ClawbooDb,
  run: DbScheduledRun,
  template: TaskTemplate,
  runtime: string,
): { ok: true; task: DbTask } | { ok: false; error: string } {
  if (template.teamTaskId) {
    const bound = getTask(db, template.teamTaskId)
    if (!bound) return { ok: false, error: `bound team task ${template.teamTaskId} not found` }
    if (bound.status !== 'todo') {
      return {
        ok: false,
        error: `bound team task ${template.teamTaskId} is not claimable (status ${bound.status})`,
      }
    }
    return { ok: true, task: bound }
  }
  const task = createTask(db, {
    title: template.title,
    description: template.description ?? null,
    status: 'todo',
    priority: template.priority,
    teamId: run.teamId,
    assigneeRuntime: runtime,
    scheduledBy: 'clawboo',
    tenantId: run.tenantId,
  })
  return { ok: true, task }
}

/**
 * Dispatch one claimed Routine fire. Throws typed NotImplementedError for a
 * human participant (the ticker records it as the outcome error); every other
 * failure is returned as an outcome so the ledger can park the routine.
 */
export async function dispatchRoutine(
  run: DbScheduledRun,
  deps: WakeBridgeDeps,
): Promise<RoutineDispatchOutcome> {
  const { db } = deps
  const template = parseTaskTemplate(run.taskTemplate)
  if (!template) return { ok: false, error: 'invalid task template' }

  const agentRow = loadAgentRow(db, run.agentId)
  if (!agentRow) return { ok: false, error: `agent ${run.agentId} not found` }

  // Humans-in-the-graph seam: a human Routine becomes a scheduled board
  // ping/reminder, not a spawned process. Reachable, typed, unimplemented.
  if (agentRow.participantKind === 'human') {
    throw new NotImplementedError(
      'human-participant Routines are not implemented yet (a scheduled ping, not a spawned run)',
    )
  }

  const runtime = agentRow.runtime

  // Resolve the adapter PROBE (a registry lookup by id — the dispatch branch
  // below reads ONLY the capabilities seam, so a misdeclared runtime routes by
  // its declared class, never by its name).
  let probe: RuntimeAdapter
  let operatorClient: OperatorClientLike | null = null
  if (isRuntimeId(runtime)) {
    probe = adapterFactoryFor(runtime)({})
  } else if (runtime === 'openclaw') {
    operatorClient = deps.getOperatorClient
      ? deps.getOperatorClient()
      : getRegistry().source.operatorClient()
    if (!operatorClient) {
      return { ok: false, error: `gateway_disconnected — cannot dispatch runtime '${runtime}'` }
    }
    probe = new OpenClawAdapter(operatorClient)
  } else {
    // Fail CLOSED for an unrecognized runtime (a data typo / a future runtime):
    // never silently dispatch it over the OpenClaw Gateway by fallthrough.
    return { ok: false, error: `unknown runtime '${runtime}' — not dispatched` }
  }

  const integration = resolveRuntimeIntegration(probe.capabilities())

  const materialized = materializeTask(db, run, template, runtime)
  if (!materialized.ok) return { ok: false, error: materialized.error }
  const task = materialized.task

  if (integration.home.kind === 'connected') {
    emitEvent(db, {
      kind: 'routine_dispatched',
      taskId: task.id,
      teamId: run.teamId,
      agentId: run.agentId,
      runtime,
      tenantId: run.tenantId,
      data: { scheduledRunId: run.id, taskId: task.id, runtime, dispatchPath: 'connected' },
    })
    const dispatch = deps.dispatchConnected ?? dispatchConnectedSubstrate
    return dispatch({
      db,
      run,
      template,
      agentRow,
      taskId: task.id,
      client: operatorClient!,
    })
  }

  // One-shot path (native + wrapped-oneshot): the standard executor pipeline.
  emitEvent(db, {
    kind: 'routine_dispatched',
    taskId: task.id,
    teamId: run.teamId,
    agentId: run.agentId,
    runtime,
    tenantId: run.tenantId,
    data: { scheduledRunId: run.id, taskId: task.id, runtime, dispatchPath: 'one-shot' },
  })
  const apiKeyEnv = buildApiKeyEnv(runtime)
  const runTask = deps.runTask ?? runTaskOnRuntime
  const result = await runTask({
    db,
    makeAdapter: adapterFactoryFor(runtime as Parameters<typeof adapterFactoryFor>[0]),
    taskId: task.id,
    assigneeAgentId: run.agentId,
    repoPath: template.repoPath ?? null,
    kind: template.kind,
    model: template.model ?? null,
    mcpBaseUrl: deps.mcpBaseUrl,
    ...(template.maxNodeCents != null ? { maxNodeCents: template.maxNodeCents } : {}),
    ...(Object.keys(apiKeyEnv).length > 0 ? { apiKeyEnv } : {}),
  })

  if (!result.ok) {
    // A lost claim means another worker already owns the task — the work is
    // happening; treat the fire as satisfied (drop, never retry).
    if (result.reason === 'conflict') return { ok: true, taskId: task.id }
    return { ok: false, taskId: task.id, error: `dispatch refused: ${result.reason}` }
  }
  if (result.doneReason !== 'success') {
    return {
      ok: false,
      taskId: task.id,
      error: `run ${result.doneReason}: ${result.summary || '(no output)'}`,
    }
  }
  return { ok: true, taskId: task.id }
}
