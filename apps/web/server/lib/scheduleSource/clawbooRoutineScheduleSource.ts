// ClawbooRoutineScheduleSource — the 'managed' team-task side of the unified
// Scheduler surface: a thin projection over the scheduled_runs ledger. Covers
// team work for every runtime class (native + wrapped-oneshot + OpenClaw team
// tasks). Writes go through the registration-time one-TEAM-TASK-firing-owner
// guard; every successful write pokes the ticker so the next fire re-arms.

import {
  agents,
  createDb,
  deleteScheduledRun,
  getScheduledRun,
  listScheduledRuns,
  queueRunNow,
  registerScheduledRun,
  setScheduledRunStatus,
  updateScheduledRun,
  type ClawbooDb,
  type DbScheduledRun,
} from '@clawboo/db'
import {
  BoundRecurringScheduleError,
  DuplicateFiringOwnerError,
  IllegalScheduleTransitionError,
  UnknownScheduleError,
  isOnceSpec,
  makeScheduleId,
  nextOccurrence,
  parseTaskTemplate,
  probeCronSpec,
  taskTemplateSchema,
  InvalidCronSpecError,
  type ScheduleReadResult,
  type ScheduleRecord,
  type ScheduleSource,
  type ScheduleStatus,
  type ScheduleWriteAction,
} from '@clawboo/scheduler'
import { inArray } from 'drizzle-orm'

import { getRoutinesTicker } from '../routines/ticker'

export interface ClawbooRoutineScheduleSourceDeps {
  getDbPath: () => string
}

export class ClawbooRoutineScheduleSource implements ScheduleSource {
  readonly id = 'clawboo-routine' as const
  readonly domain = 'team-task' as const
  readonly manageability = 'managed' as const

  constructor(private readonly deps: ClawbooRoutineScheduleSourceDeps) {}

  private db(): ClawbooDb {
    return createDb(this.deps.getDbPath())
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
      ...(template?.teamTaskId ? { teamTaskId: template.teamTaskId } : {}),
      ...(template?.title ? { label: template.title } : {}),
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
    if (agentIds.length === 0) return map
    const rows = db
      .select({ id: agents.id, runtime: agents.runtime })
      .from(agents)
      .where(inArray(agents.id, agentIds))
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
          const template = taskTemplateSchema.parse({
            title: spec.label ?? 'Scheduled team task',
            ...(typeof spec.taskTemplate === 'object' && spec.taskTemplate !== null
              ? spec.taskTemplate
              : {}),
            ...(spec.teamTaskId ? { teamTaskId: spec.teamTaskId } : {}),
          })
          // A bound team task is claimable exactly once (todo → done), so a
          // recurring schedule would fire once then park in error forever.
          // Refuse the combination at registration — bound routines must be
          // one-shot (`once@<iso>`).
          if (template.teamTaskId && !isOnceSpec(spec.cronSpec)) {
            throw new BoundRecurringScheduleError(template.teamTaskId, spec.cronSpec)
          }
          const result = registerScheduledRun(db, {
            agentId: spec.agentId,
            teamId: spec.teamId ?? null,
            cronSpec: spec.cronSpec,
            taskTemplate: JSON.stringify(template),
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
          const patch: { cronSpec?: string; taskTemplate?: string; nextRunAt?: number | null } = {}
          if (action.patch.cronSpec !== undefined) {
            probeCronSpec(action.patch.cronSpec)
            patch.cronSpec = action.patch.cronSpec
            // Only an ARMABLE (idle) routine gets a recomputed next-run. A
            // paused/error row is DISARMED (next_run_at NULL); changing its cron
            // spec must not silently re-arm it — resume re-arms via safeNext.
            patch.nextRunAt =
              existing.status === 'idle' ? nextOccurrence(action.patch.cronSpec, Date.now()) : null
          }
          if (action.patch.taskTemplate !== undefined || action.patch.label !== undefined) {
            const current = parseTaskTemplate(existing.taskTemplate)
            patch.taskTemplate = JSON.stringify(
              taskTemplateSchema.parse({
                ...(current ?? { title: 'Scheduled team task' }),
                ...(typeof action.patch.taskTemplate === 'object' &&
                action.patch.taskTemplate !== null
                  ? action.patch.taskTemplate
                  : {}),
                ...(action.patch.label !== undefined ? { title: action.patch.label } : {}),
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
