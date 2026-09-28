// The wake-bridge: what one Routine fire does. It branches first on the
// routine's TARGET:
//   - 'team'  → the instructions are posted into the team's group chat through
//     the server team orchestrator, addressed to the team's lead (Boo Zero),
//     exactly like a message the person typed. The lead answers or delegates, and
//     everything it does shows in that chat and on the team's board.
//   - 'agent' → a board task for one agent, dispatched through the standard
//     executor pipeline (budgets / approvals / verification / obs /
//     worktree-of-record all apply; never a side channel).
// An agent fire then branches on RUNTIME CLASS read from the adapter
// capabilities seam (resolveRuntimeIntegration(caps).home.kind), never a
// hardcoded id switch:
//   - 'ephemeral' | 'persistent' (native + wrapped-oneshot) → runTaskOnRuntime
//   - 'connected' (OpenClaw) → the thin operator dispatcher (the one path the
//     one-shot runner refuses BY DESIGN)
//   - a human participant → reachable typed NotImplementedError (a human
//     Routine becomes a scheduled board ping, not a spawned process)

import { OpenClawAdapter } from '@clawboo/adapter-openclaw'
import {
  addComment,
  agents,
  createTask,
  getTask,
  teams,
  updateStatus,
  type ClawbooDb,
  type DbAgent,
  type DbScheduledRun,
  type DbTask,
} from '@clawboo/db'
import { resolveRuntimeIntegration, type RuntimeAdapter } from '@clawboo/executor'
import {
  NotImplementedError,
  parseTaskTemplate,
  routineTargetOf,
  type TaskTemplate,
} from '@clawboo/scheduler'
import { needsWorktree } from '@clawboo/worktrees'
import { eq } from 'drizzle-orm'

import { getRegistry } from '../agentSource'
import { emitEvent } from '../obs'
import { runTaskOnRuntime } from '../executorRunner'
import { adapterFactoryFor } from '../runtimes'
import { getDescriptor, isOrchestratableRuntimeId, isRuntimeId } from '../runtimes/descriptor'
import { resolveRuntimeKeyForRuntime } from '../secretsVault'
import { resolveServerOrchestrated } from '../teamChat/resolveServerOrchestrated'
import {
  getTeamOrchestrator,
  type EnqueueUserMessageInput,
  type EnqueueUserMessageResult,
} from '../teamChat/teamOrchestrator'
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
  /** Test seam: post a team routine's message into its team's chat. */
  enqueueTeamMessage?: (
    teamId: string,
    input: EnqueueUserMessageInput,
  ) => Promise<EnqueueUserMessageResult>
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
 * The isolation kind an agent fire runs under. A worktree branches from a
 * repository; with no repository there is nothing to branch, so the fire runs
 * the way the agent works a task delegated in team chat, with no checkout. A
 * template that names a repository keeps its kind (and so its worktree).
 */
export function runKindFor(template: Pick<TaskTemplate, 'kind' | 'repoPath'>): string {
  if (template.repoPath || !needsWorktree(template.kind)) return template.kind
  return 'research'
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
 * Set aside the task a failed fire created. The runners release a failed task
 * back to `todo` so it can be retried, but a routine retries by filing a fresh
 * task on its next run; left in `todo`, this one would sit on the board looking
 * like pending work that any agent's `claim_task` could pick up. `blocked` is
 * what the team engine uses for a failed task too, and the note (the card shows
 * the latest one as its reason) says who failed and why. A task bound at
 * registration is the board's own and is left exactly as the runner left it.
 */
function setAsideFailedFireTask(
  db: ClawbooDb,
  taskId: string,
  agentName: string,
  error: string | undefined,
): void {
  try {
    if (getTask(db, taskId)?.status !== 'todo') return
    if (!updateStatus(db, taskId, 'blocked').ok) return
    addComment(
      db,
      taskId,
      `${agentName}'s scheduled run failed${error ? `: ${error}` : ''}. ` +
        'The routine files a new task on its next run, so this one was set aside.',
      'system',
    )
  } catch {
    // Best effort: the routine's own error is already recorded.
  }
}

/**
 * A team fire: post the routine's instructions into the team's chat for its
 * lead. The outcome is whether the lead's turn started (or queued behind one
 * already running); what the team then does lands in that chat and on the board.
 */
async function dispatchTeamRoutine(
  run: DbScheduledRun,
  template: TaskTemplate,
  deps: WakeBridgeDeps,
): Promise<RoutineDispatchOutcome> {
  const { db } = deps
  const teamId = run.teamId
  if (!teamId) return { ok: false, error: 'This team routine has no team.' }
  const team = db
    .select({ name: teams.name, isArchived: teams.isArchived })
    .from(teams)
    .where(eq(teams.id, teamId))
    .get() as { name: string; isArchived: number } | undefined
  if (!team) return { ok: false, error: 'The team this routine posts to no longer exists.' }
  if (team.isArchived) return { ok: false, error: `The team "${team.name}" is archived.` }
  if (!resolveServerOrchestrated(db, teamId)) {
    return { ok: false, error: `The team "${team.name}" does not take messages from routines.` }
  }

  const stimulus = template.description?.trim() || template.title
  const enqueue =
    deps.enqueueTeamMessage ??
    ((id: string, input: EnqueueUserMessageInput) =>
      getTeamOrchestrator(id, { mcpBaseUrl: deps.mcpBaseUrl }).enqueueUserMessage(input))
  const result = await enqueue(teamId, {
    stimulus,
    routine: { id: run.id, name: template.title },
  })
  if (!result.ok) return { ok: false, error: result.error }

  const runtime = loadAgentRow(db, result.targetAgentId)?.runtime ?? null
  emitEvent(db, {
    kind: 'routine_dispatched',
    teamId,
    agentId: result.targetAgentId,
    runtime,
    tenantId: run.tenantId,
    data: {
      scheduledRunId: run.id,
      taskId: null,
      runtime,
      dispatchPath: 'team-chat',
      targetAgentId: result.targetAgentId,
    },
  })
  return { ok: true, taskId: null }
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

  if (routineTargetOf(template) === 'team') return dispatchTeamRoutine(run, template, deps)

  const agentRow = loadAgentRow(db, run.agentId)
  if (!agentRow) return { ok: false, error: `agent ${run.agentId} not found` }
  if (agentRow.archivedAt) {
    return { ok: false, error: `The agent "${agentRow.name}" was removed.` }
  }

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
  // The same runtime set a team run may use, so the fault-injecting mock runtime
  // (behind its env flag) reaches this path too.
  if (isOrchestratableRuntimeId(runtime)) {
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

  // Everything below owns a task this fire may have created; a failed fire sets
  // it aside (see setAsideFailedFireTask). A dispatch that throws is a failed fire
  // too: both runners hand back a task they claimed before the error escapes.
  const settle = (outcome: RoutineDispatchOutcome): RoutineDispatchOutcome => {
    if (!outcome.ok && !template.teamTaskId)
      setAsideFailedFireTask(db, task.id, agentRow.name, outcome.error)
    return outcome
  }
  const thrown = (err: unknown): RoutineDispatchOutcome => ({
    ok: false,
    taskId: task.id,
    error: err instanceof Error ? err.message : String(err),
  })

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
    try {
      return settle(
        await dispatch({
          db,
          run,
          template,
          agentRow,
          taskId: task.id,
          client: operatorClient!,
        }),
      )
    } catch (err) {
      return settle(thrown(err))
    }
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
  const runTask = deps.runTask ?? runTaskOnRuntime
  let result: Awaited<ReturnType<typeof runTaskOnRuntime>>
  try {
    const apiKeyEnv = buildApiKeyEnv(runtime)
    result = await runTask({
      db,
      makeAdapter: adapterFactoryFor(runtime as Parameters<typeof adapterFactoryFor>[0]),
      taskId: task.id,
      assigneeAgentId: run.agentId,
      repoPath: template.repoPath ?? null,
      kind: runKindFor(template),
      model: template.model ?? null,
      mcpBaseUrl: deps.mcpBaseUrl,
      ...(template.maxNodeCents != null ? { maxNodeCents: template.maxNodeCents } : {}),
      ...(Object.keys(apiKeyEnv).length > 0 ? { apiKeyEnv } : {}),
    })
  } catch (err) {
    return settle(thrown(err))
  }

  if (!result.ok) {
    // A lost claim means another worker already owns the task — the work is
    // happening; treat the fire as satisfied (drop, never retry).
    if (result.reason === 'conflict') return { ok: true, taskId: task.id }
    return settle({ ok: false, taskId: task.id, error: `dispatch refused: ${result.reason}` })
  }
  if (result.doneReason !== 'success') {
    return settle({
      ok: false,
      taskId: task.id,
      error: `run ${result.doneReason}: ${result.summary || '(no output)'}`,
    })
  }
  return { ok: true, taskId: task.id }
}
