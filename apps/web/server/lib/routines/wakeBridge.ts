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
  jobRunStopped,
  routineSurvivesFailure,
  teams,
  updateStatus,
  startRefusedBy,
  teamExists,
  type ClawbooDb,
  type DbAgent,
  type DbScheduledRun,
  type DbTask,
  type StartRefusal,
  type WaitingOn,
} from '@clawboo/db'
import { resolveRuntimeIntegration, type RuntimeAdapter } from '@clawboo/executor'
import { classifyError, isTransientError, type RuntimeErrorClass } from '@clawboo/obs'
import {
  isOnceSpec,
  NotImplementedError,
  parseTaskTemplate,
  routineTargetOf,
  type TaskTemplate,
} from '@clawboo/scheduler'
import { needsWorktree } from '@clawboo/worktrees'
import { eq } from 'drizzle-orm'

import { getRegistry } from '../agentSource'
import { emitEvent } from '../obs'
import { pauseRefusalText } from '../pauseBus'
import { runTaskOnRuntime } from '../executorRunner'
import { adapterFactoryFor } from '../runtimes'
import { isOrchestratableRuntimeId } from '../runtimes/descriptor'
import { runtimeKeyEnv } from '../runtimes/runKeyEnv'
import { resolveServerOrchestrated } from '../teamChat/resolveServerOrchestrated'
import {
  getTeamOrchestrator,
  teamMessageTarget,
  type EnqueueUserMessageInput,
  type EnqueueUserMessageResult,
} from '../teamChat/teamOrchestrator'
import { dispatchConnectedSubstrate, type OperatorClientLike } from './openclawDispatch'

export interface RoutineDispatchOutcome {
  ok: boolean
  taskId?: string | null
  error?: string
  /** The class the failure was filed under, when the fire ran far enough to fail
   *  in a way the runtime error taxonomy knows. */
  errorClass?: RuntimeErrorClass
  /** The failure may pass by itself (a rate limit, a timeout, a provider outage),
   *  so the routine keeps its schedule, up to MAX_ROUTINE_TRANSIENT_FAILURES in a
   *  row. Anything else stops it until a person resumes it. */
  transient?: boolean
  /** A pause stopped or refused this fire, so it did not happen: not a failure, not a
   *  success. The ticker puts the routine back to run on resume. */
  paused?: boolean
}

/** A failed fire filed under its class, from its error text when the runner named
 *  none; an outcome that already says whether it may pass is left as it is. */
function classified(outcome: RoutineDispatchOutcome): RoutineDispatchOutcome {
  if (outcome.ok || outcome.transient !== undefined) return outcome
  const errorClass = outcome.errorClass ?? classifyError(null, outcome.error ?? null)
  return { ...outcome, errorClass, transient: isTransientError(errorClass) }
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
    // Deleting a team leaves its task rows behind, and nothing may start them.
    if (bound.teamId && !teamExists(db, bound.teamId)) {
      return { ok: false, error: 'The team of the task this routine runs no longer exists.' }
    }
    // A routine's fire is no person starting the work now, whoever scheduled it.
    if (jobRunStopped(db, bound.id)) {
      return { ok: false, error: 'A person stopped the job this routine’s task is in.' }
    }
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
    // A row from before a team's delete moved its routines still names the team.
    teamId: run.teamId && teamExists(db, run.teamId) ? run.teamId : null,
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
 * the latest one as its reason) says who failed, why, and whether the routine
 * runs again. A task bound at registration is the board's own and is left
 * exactly as the runner left it.
 */
/** Why a routine's fire failed, as a task's reason. A budget stop and a tripped
 *  breaker say so in their error (`budget_paused:…`, `breaker…`). */
function routineStopReason(error: string | undefined): WaitingOn {
  if (error && /budget/i.test(error)) return { kind: 'budget' }
  if (error && /breaker/i.test(error)) return { kind: 'breaker' }
  return { kind: 'failure' }
}

function setAsideFailedFireTask(
  db: ClawbooDb,
  taskId: string,
  agentName: string,
  error: string | undefined,
  routineContinues: boolean,
): void {
  try {
    if (getTask(db, taskId)?.status !== 'todo') return
    const moved = updateStatus(db, taskId, 'blocked', { waitingOn: routineStopReason(error) })
    if (!moved.ok) return
    // The event log is what live views follow; the status write reaches only
    // the in-process bus.
    emitEvent(db, {
      kind: 'status_changed',
      taskId,
      teamId: moved.task?.teamId ?? null,
      data: { to: 'blocked', reason: 'routine_fire_failed' },
    })
    // The next run is said as a condition: the routine can be deleted while its
    // fire runs, and this note is written before the outcome is recorded.
    addComment(
      db,
      taskId,
      `${agentName}'s scheduled run failed${error ? `: ${error}` : ''}. ` +
        (routineContinues
          ? 'While the routine is scheduled, it files a new task on its next run, so this one was set aside.'
          : 'The routine is stopped until you resume it, so this one was set aside.'),
      'system',
    )
  } catch {
    // Best effort: the routine's own error is already recorded.
  }
}

/**
 * Set aside the task a fire a pause stopped had made. The routine runs again on
 * resume and files its own task then, as it does after a failure. `cancelled` rather
 * than `blocked`, because nothing here needs a person. Only while it is still in To
 * do: a person's move stands.
 */
function setAsidePausedFireTask(db: ClawbooDb, taskId: string): void {
  try {
    if (getTask(db, taskId)?.status !== 'todo') return
    const moved = updateStatus(db, taskId, 'cancelled')
    if (!moved.ok) return
    emitEvent(db, {
      kind: 'status_changed',
      taskId,
      teamId: moved.task?.teamId ?? null,
      data: { to: 'cancelled', reason: 'routine_fire_paused' },
    })
    addComment(
      db,
      taskId,
      'A pause stopped this scheduled run. The routine runs again on resume, as a new task, so this one was set aside.',
      'system',
    )
  } catch {
    // Best effort: the routine runs again whether or not this card moved.
  }
}

/**
 * What holds this routine's next fire back, or null when it may start: a pause on
 * its real target, or an archived team. A team routine's target is who its message
 * would reach: an @mention in its instructions, else the lead. An agent routine's is
 * its agent, its team, and the tree of the task it is bound to. The ledger's own read
 * sees only the paused agents and teams a row names, so the ticker asks this too.
 */
export function routineStartRefusal(db: ClawbooDb, run: DbScheduledRun): StartRefusal | null {
  const template = parseTaskTemplate(run.taskTemplate)
  if (template && routineTargetOf(template) === 'team') {
    if (!run.teamId) return null
    const stimulus = template.description?.trim() || template.title
    const agentId = teamMessageTarget(db, run.teamId, null, stimulus)
    return startRefusedBy(db, { agentId, teamId: run.teamId })
  }
  return startRefusedBy(db, {
    agentId: run.agentId || null,
    teamId: run.teamId,
    taskId: template?.teamTaskId ?? null,
  })
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

  // The ticker holds a fire whose target is paused. This meets one placed since it
  // looked: the fire did not happen, and it runs on resume.
  const refused = routineStartRefusal(db, run)
  if (refused) return { ok: false, paused: true, error: pauseRefusalText(refused) }

  const stimulus = template.description?.trim() || template.title
  const enqueue =
    deps.enqueueTeamMessage ??
    ((id: string, input: EnqueueUserMessageInput) =>
      getTeamOrchestrator(id, { mcpBaseUrl: deps.mcpBaseUrl }).enqueueUserMessage(input))
  const result = await enqueue(teamId, {
    stimulus,
    routine: { id: run.id, name: template.title },
  })
  // The OpenClaw operator still down after a reconnect is a dropped connection,
  // which may pass by itself; every other refusal stops the routine as before.
  if (!result.ok) {
    if (result.paused) return { ok: false, paused: true, error: result.error }
    return result.transient
      ? { ok: false, error: result.error, errorClass: 'ProviderError', transient: true }
      : { ok: false, error: result.error }
  }

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
      // A dropped connection to the Gateway may pass by itself.
      return {
        ok: false,
        error: `gateway_disconnected — cannot dispatch runtime '${runtime}'`,
        errorClass: 'ProviderError',
        transient: true,
      }
    }
    probe = new OpenClawAdapter(operatorClient)
  } else {
    // Fail CLOSED for an unrecognized runtime (a data typo / a future runtime):
    // never silently dispatch it over the OpenClaw Gateway by fallthrough.
    return { ok: false, error: `unknown runtime '${runtime}' — not dispatched` }
  }

  const integration = resolveRuntimeIntegration(probe.capabilities())

  // The ticker holds a fire a pause covers, so this only meets one placed since it
  // looked. No task is made for a run that cannot start, and the fire runs on resume.
  const refused = routineStartRefusal(db, run)
  if (refused) return { ok: false, paused: true, error: pauseRefusalText(refused) }

  const materialized = materializeTask(db, run, template, runtime)
  if (!materialized.ok) return { ok: false, error: materialized.error }
  const task = materialized.task

  // Everything below owns a task this fire may have created; a failed fire sets
  // it aside (see setAsideFailedFireTask). A dispatch that throws is a failed fire
  // too: both runners hand back a task they claimed before the error escapes.
  const settle = (result: RoutineDispatchOutcome): RoutineDispatchOutcome => {
    const outcome = classified(result)
    if (!outcome.ok && !template.teamTaskId) {
      // The ledger applies the same rule when it records this outcome.
      const continues = routineSurvivesFailure({
        transient: outcome.transient === true,
        failureStreak: run.failureStreak,
        hasNextRun: !isOnceSpec(run.cronSpec),
      })
      setAsideFailedFireTask(db, task.id, agentRow.name, outcome.error, continues)
    }
    return outcome
  }
  const thrown = (err: unknown): RoutineDispatchOutcome => ({
    ok: false,
    taskId: task.id,
    error: err instanceof Error ? err.message : String(err),
  })
  // A pause stopped this fire, so it did not happen: it runs again on resume, as a
  // new task like any fire. This one is set aside so it does not sit on the board
  // with nothing coming for it. A task bound at registration is the board's own, and
  // the next fire runs it again.
  const pausedFire = (error: string): RoutineDispatchOutcome => {
    if (!template.teamTaskId) setAsidePausedFireTask(db, task.id)
    return { ok: false, paused: true, taskId: task.id, error }
  }

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
      const outcome = await dispatch({
        db,
        run,
        template,
        agentRow,
        taskId: task.id,
        client: operatorClient!,
      })
      return outcome.paused ? pausedFire(outcome.error ?? 'A pause stopped it.') : settle(outcome)
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
    const apiKeyEnv = runtimeKeyEnv(runtime)
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
    if (result.reason === 'paused') return pausedFire('A pause stopped it before it started.')
    // A cap whose room runs already going have set aside clears as they finish, so
    // that refusal may pass by itself; every other refusal fails the same way again.
    return settle({
      ok: false,
      taskId: task.id,
      error: `dispatch refused: ${result.reason}`,
      transient: result.reason === 'budget_held',
    })
  }
  if (result.stoppedByPause) return pausedFire(result.summary || 'A pause stopped it.')
  // A person moved the card while it ran, which stopped the run. Their move is
  // the task's outcome: the fire did not fail, so the routine stays armed and the
  // task stays where they put it.
  if (result.stoppedByPerson) return { ok: true, taskId: task.id }
  if (result.doneReason !== 'success') {
    // Only a run that errored can have failed in a way that passes; running out of
    // room or being cut off is the task's own trouble, and stops the routine.
    return settle({
      ok: false,
      taskId: task.id,
      error: `run ${result.doneReason}: ${result.summary || '(no output)'}`,
      ...(result.doneReason === 'error'
        ? { errorClass: result.errorClass ?? classifyError(null, result.summary) }
        : { transient: false }),
    })
  }
  return { ok: true, taskId: task.id }
}
