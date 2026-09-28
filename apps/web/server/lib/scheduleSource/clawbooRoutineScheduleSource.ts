// ClawbooRoutineScheduleSource — the 'managed' team-task side of the unified
// Scheduler surface: a thin projection over the scheduled_runs ledger. Covers
// team work for every runtime class (native + wrapped-oneshot + OpenClaw team
// tasks). Writes go through the registration-time one-TEAM-TASK-firing-owner
// guard; every successful write pokes the ticker so the next fire re-arms.
//
// A routine targets a TEAM (its fire is posted into the team chat for the team's
// lead, so the row keeps no agent: `agent_id` is empty) or one AGENT (its fire is
// a board task for that agent, on the agent's own team). The target is validated
// on every write that sets it, so the ledger never holds a routine that points
// at nothing.

import {
  agents,
  deleteScheduledRun,
  getScheduledRun,
  listScheduledRuns,
  queueRunNow,
  registerScheduledRun,
  setScheduledRunStatus,
  teams,
  updateScheduledRun,
  type ClawbooDb,
  type DbScheduledRun,
} from '@clawboo/db'
import {
  BoundRecurringScheduleError,
  DuplicateFiringOwnerError,
  IllegalScheduleTransitionError,
  InvalidRoutineTargetError,
  UnknownScheduleError,
  isOnceSpec,
  makeScheduleId,
  nextOccurrence,
  parseTaskTemplate,
  probeCronSpec,
  routineTargetOf,
  taskTemplateSchema,
  InvalidCronSpecError,
  type RoutineTarget,
  type ScheduleReadResult,
  type ScheduleRecord,
  type ScheduleSource,
  type ScheduleStatus,
  type ScheduleWriteAction,
} from '@clawboo/scheduler'
import { eq, inArray } from 'drizzle-orm'

import { getRoutinesTicker } from '../routines/ticker'

export interface ClawbooRoutineScheduleSourceDeps {
  /** The shared process connection (a thunk, so a sandbox swap is picked up
   *  per call — the registries are module singletons built once per test file). */
  getDb: () => ClawbooDb
}

function isRoutineTarget(value: unknown): value is RoutineTarget {
  return value === 'team' || value === 'agent'
}

/** Where a routine's fires go, as stored on the ledger row. */
interface ResolvedTarget {
  target: RoutineTarget
  /** Empty for a team routine. */
  agentId: string
  teamId: string | null
}

/**
 * Check a routine's target against the registry and return what to store.
 * A team routine needs a live team. An agent routine needs a live agent and is
 * filed on that agent's own team: a `teamId` that names a different team is
 * refused rather than silently corrected, since the caller asked for something
 * that cannot happen.
 */
function resolveTarget(
  db: ClawbooDb,
  input: {
    target: RoutineTarget
    agentId: string | null | undefined
    teamId: string | null | undefined
    teamTaskId: string | null | undefined
  },
): ResolvedTarget {
  if (input.target === 'team') {
    if (!input.teamId) throw new InvalidRoutineTargetError('A team routine needs a team.')
    const team = db
      .select({ name: teams.name, isArchived: teams.isArchived })
      .from(teams)
      .where(eq(teams.id, input.teamId))
      .get() as { name: string; isArchived: number } | undefined
    if (!team) throw new InvalidRoutineTargetError(`There is no team "${input.teamId}".`)
    if (team.isArchived) throw new InvalidRoutineTargetError(`The team "${team.name}" is archived.`)
    if (input.teamTaskId) {
      throw new InvalidRoutineTargetError(
        'A team routine posts to the team chat, so it cannot be bound to a board task.',
      )
    }
    return { target: 'team', agentId: '', teamId: input.teamId }
  }
  if (!input.agentId) throw new InvalidRoutineTargetError('An agent routine needs an agent.')
  const agent = db
    .select({ name: agents.name, teamId: agents.teamId, archivedAt: agents.archivedAt })
    .from(agents)
    .where(eq(agents.id, input.agentId))
    .get() as { name: string; teamId: string | null; archivedAt: number | null } | undefined
  if (!agent || agent.archivedAt) {
    throw new InvalidRoutineTargetError(`There is no agent "${input.agentId}".`)
  }
  const agentTeamId = agent.teamId ?? null
  if (input.teamId !== undefined && (input.teamId ?? null) !== agentTeamId) {
    throw new InvalidRoutineTargetError(
      agentTeamId
        ? `"${agent.name}" is not on that team.`
        : `"${agent.name}" is not on a team, so its routine cannot be filed on one.`,
    )
  }
  return { target: 'agent', agentId: input.agentId, teamId: agentTeamId }
}

export class ClawbooRoutineScheduleSource implements ScheduleSource {
  readonly id = 'clawboo-routine' as const
  readonly domain = 'team-task' as const
  readonly manageability = 'managed' as const

  constructor(private readonly deps: ClawbooRoutineScheduleSourceDeps) {}

  private db(): ClawbooDb {
    return this.deps.getDb()
  }

  private toRecord(row: DbScheduledRun, runtimeByAgent: Map<string, string>): ScheduleRecord {
    const template = parseTaskTemplate(row.taskTemplate)
    return {
      id: makeScheduleId(this.id, row.id),
      sourceScheduleId: row.id,
      runtime: runtimeByAgent.get(row.agentId) ?? 'unknown',
      owner: row.scheduledBy,
      source: this.id,
      agentId: row.agentId,
      target: template ? routineTargetOf(template) : 'agent',
      teamId: row.teamId,
      ...(template?.teamTaskId ? { teamTaskId: template.teamTaskId } : {}),
      ...(template?.title ? { label: template.title } : {}),
      ...(template?.description ? { description: template.description } : {}),
      cronSpec: row.cronSpec,
      nextRunAt: row.nextRunAt,
      ...(row.lastRunAt != null ? { lastRunAt: row.lastRunAt } : {}),
      ...(row.lastError ? { lastError: row.lastError } : {}),
      status: row.status as ScheduleStatus,
      manageability: this.manageability,
      domain: this.domain,
      tenantId: row.tenantId,
    }
  }

  private runtimeLookup(db: ClawbooDb, agentIds: string[]): Map<string, string> {
    const map = new Map<string, string>()
    const ids = agentIds.filter(Boolean)
    if (ids.length === 0) return map
    const rows = db
      .select({ id: agents.id, runtime: agents.runtime })
      .from(agents)
      .where(inArray(agents.id, ids))
      .all() as Array<{ id: string; runtime: string }>
    for (const row of rows) map.set(row.id, row.runtime)
    return map
  }

  async read(): Promise<ScheduleReadResult> {
    const db = this.db()
    const rows = listScheduledRuns(db)
    const runtimeByAgent = this.runtimeLookup(db, [...new Set(rows.map((r) => r.agentId))])
    return {
      records: rows.map((row) => this.toRecord(row, runtimeByAgent)),
      status: { sourceId: this.id, ok: true, degraded: false, at: Date.now() },
    }
  }

  async write(action: ScheduleWriteAction): Promise<ScheduleRecord | null> {
    const db = this.db()
    try {
      switch (action.kind) {
        case 'create': {
          const spec = action.spec
          probeCronSpec(spec.cronSpec) // throws InvalidCronSpecError
          const requested =
            typeof spec.taskTemplate === 'object' && spec.taskTemplate !== null
              ? (spec.taskTemplate as Record<string, unknown>)
              : {}
          const template = taskTemplateSchema.parse({
            title: spec.label ?? 'Scheduled team task',
            ...requested,
            ...(spec.target ? { target: spec.target } : {}),
            ...(spec.teamTaskId ? { teamTaskId: spec.teamTaskId } : {}),
          })
          const resolved = resolveTarget(db, {
            target: routineTargetOf(template),
            agentId: spec.agentId,
            teamId: spec.teamId,
            teamTaskId: template.teamTaskId,
          })
          // A bound team task is claimable exactly once (todo → done), so a
          // recurring schedule would fire once then park in error forever.
          // Refuse the combination at registration — bound routines must be
          // one-shot (`once@<iso>`).
          if (template.teamTaskId && !isOnceSpec(spec.cronSpec)) {
            throw new BoundRecurringScheduleError(template.teamTaskId, spec.cronSpec)
          }
          const result = registerScheduledRun(db, {
            agentId: resolved.agentId,
            teamId: resolved.teamId,
            cronSpec: spec.cronSpec,
            taskTemplate: JSON.stringify({ ...template, target: resolved.target }),
            teamTaskId: template.teamTaskId ?? null,
            nextRunAt: nextOccurrence(spec.cronSpec, Date.now()),
            tenantId: spec.tenantId ?? null,
          })
          if (!result.ok) {
            if (result.reason === 'ownership_conflict') {
              throw new DuplicateFiringOwnerError(
                result.existingOwner,
                `team task ${template.teamTaskId}`,
              )
            }
            throw new UnknownScheduleError(String(template.teamTaskId))
          }
          return this.toRecord(result.run, this.runtimeLookup(db, [result.run.agentId]))
        }
        case 'update': {
          const existing = getScheduledRun(db, this.rawId(action.id))
          if (!existing) throw new UnknownScheduleError(action.id)
          const patch: {
            cronSpec?: string
            taskTemplate?: string
            nextRunAt?: number | null
            agentId?: string
            teamId?: string | null
          } = {}
          if (action.patch.cronSpec !== undefined) {
            probeCronSpec(action.patch.cronSpec)
            patch.cronSpec = action.patch.cronSpec
            // Only an ARMABLE (idle) routine gets a recomputed next-run. A
            // paused/error row is DISARMED (next_run_at NULL); changing its cron
            // spec must not silently re-arm it — resume re-arms via safeNext.
            patch.nextRunAt =
              existing.status === 'idle' ? nextOccurrence(action.patch.cronSpec, Date.now()) : null
          }
          const current = parseTaskTemplate(existing.taskTemplate)
          const templatePatch =
            typeof action.patch.taskTemplate === 'object' && action.patch.taskTemplate !== null
              ? { ...(action.patch.taskTemplate as Record<string, unknown>) }
              : null
          // A target named inside the template patch is a retarget like any
          // other, so it goes through the same validation. A binding to a board
          // task is made only at registration, where the firing-owner guard runs.
          const templateTarget = templatePatch?.['target']
          if (templatePatch) {
            delete templatePatch['target']
            delete templatePatch['teamTaskId']
          }
          for (const named of [action.patch.target, templateTarget]) {
            if (named !== undefined && !isRoutineTarget(named)) {
              throw new InvalidRoutineTargetError(`Unknown routine target "${String(named)}".`)
            }
          }
          const requestedTarget =
            action.patch.target ?? (isRoutineTarget(templateTarget) ? templateTarget : undefined)
          const retargets =
            requestedTarget !== undefined ||
            action.patch.agentId !== undefined ||
            action.patch.teamId !== undefined
          let target: RoutineTarget | undefined
          if (retargets) {
            const resolved = resolveTarget(db, {
              target: requestedTarget ?? (current ? routineTargetOf(current) : 'agent'),
              agentId: action.patch.agentId !== undefined ? action.patch.agentId : existing.agentId,
              teamId: action.patch.teamId !== undefined ? action.patch.teamId : existing.teamId,
              teamTaskId: current?.teamTaskId,
            })
            target = resolved.target
            patch.agentId = resolved.agentId
            patch.teamId = resolved.teamId
          }
          if (templatePatch || action.patch.label !== undefined || target !== undefined) {
            patch.taskTemplate = JSON.stringify(
              taskTemplateSchema.parse({
                ...(current ?? { title: 'Scheduled team task' }),
                ...(templatePatch ?? {}),
                ...(action.patch.label !== undefined ? { title: action.patch.label } : {}),
                ...(target !== undefined ? { target } : {}),
              }),
            )
          }
          const updated = updateScheduledRun(db, existing.id, patch)
          if (!updated) throw new UnknownScheduleError(action.id)
          return this.toRecord(updated, this.runtimeLookup(db, [updated.agentId]))
        }
        case 'pause':
        case 'resume': {
          const raw = this.rawId(action.id)
          const existing = getScheduledRun(db, raw)
          if (!existing) throw new UnknownScheduleError(action.id)
          const to = action.kind === 'pause' ? ('paused' as const) : ('idle' as const)
          const result = setScheduledRunStatus(db, raw, to, {
            ...(action.kind === 'resume' ? { nextRunAt: this.safeNext(existing.cronSpec) } : {}),
          })
          if (!result.ok) {
            if (result.reason === 'not_found') throw new UnknownScheduleError(action.id)
            throw new IllegalScheduleTransitionError(existing.status, to)
          }
          return this.toRecord(result.run, this.runtimeLookup(db, [result.run.agentId]))
        }
        case 'remove': {
          const raw = this.rawId(action.id)
          if (!getScheduledRun(db, raw)) throw new UnknownScheduleError(action.id)
          deleteScheduledRun(db, raw)
          return null
        }
        case 'run': {
          const raw = this.rawId(action.id)
          const existing = getScheduledRun(db, raw)
          if (!existing) throw new UnknownScheduleError(action.id)
          if (!queueRunNow(db, raw)) {
            throw new IllegalScheduleTransitionError(existing.status, 'queued')
          }
          return null
        }
        default: {
          const exhaustive: never = action
          throw new Error(`unhandled schedule write action: ${JSON.stringify(exhaustive)}`)
        }
      }
    } finally {
      getRoutinesTicker()?.requestRescan()
    }
  }

  private rawId(compositeOrRaw: string): string {
    const prefix = `${this.id}:`
    return compositeOrRaw.startsWith(prefix) ? compositeOrRaw.slice(prefix.length) : compositeOrRaw
  }

  private safeNext(cronSpec: string): number | null {
    try {
      return nextOccurrence(cronSpec, Date.now())
    } catch (err) {
      if (err instanceof InvalidCronSpecError) return null
      throw err
    }
  }
}
