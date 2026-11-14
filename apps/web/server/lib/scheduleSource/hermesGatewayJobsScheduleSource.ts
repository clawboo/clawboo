// HermesGatewayJobsScheduleSource: the jobs each Hermes agent keeps in its own
// scheduler, read and written through the supervised Hermes gateway
// (`/p/<profile>/api/jobs`). Like OpenClaw's own cron jobs, these are the agent's
// own life (`runtime-own-life`), not team work: Clawboo never puts a team task
// here (a `team-task` create is refused, on top of the multiplexer's gate) and
// never creates one on its own; the Routines view is an operator surface over
// them.
//
// What the v0.23.1 API allows, and so what this source offers: list (paused jobs
// included with `include_disabled=true`), create with a name, a schedule and a
// prompt (output is saved in the profile, `deliver: local`, since Hermes's chat
// channels are off), rename, reschedule or re-prompt, pause, resume, delete, and
// run now (Hermes fires it on its next scheduler tick, within a minute, and a
// paused job is resumed by it). A job's model, provider or folder cannot be set
// over the API.
//
// Jobs fire only while the gateway runs. A read never starts it (the Routines
// view polls); a write does, since a person asked for it.

import {
  InvalidRoutineTargetError,
  ScheduleSourceUnavailableError,
  TeamTaskDomainViolationError,
  UnknownScheduleError,
  decodeCronSpec,
  encodeCronSpec,
  makeScheduleId,
  type GatewayCronScheduleShape,
  type ScheduleReadResult,
  type ScheduleRecord,
  type ScheduleSource,
  type ScheduleStatus,
  type ScheduleWriteAction,
} from '@clawboo/scheduler'

import { HermesApiError, type HermesClient, type HermesJob } from '../runtimes/hermes/client'

/** What this source needs from the gateway. */
export interface HermesJobsBackend {
  /** Hermes is in use: Clawboo's own install is there and it has Hermes agents.
   *  When it is not, there are no jobs to read and none that could fire. */
  configured(): boolean
  /** Every Clawboo Hermes agent with its profile's client, or null when the
   *  gateway is not running. */
  agentClients(): Promise<{ agentId: string; profile: string; client: HermesClient }[] | null>
  /** One agent's client, starting the gateway if it has to. Null when the agent
   *  is not a Clawboo Hermes agent. */
  clientFor(agentId: string): Promise<{ profile: string; client: HermesClient } | null>
  /** The agent of a profile, or null. */
  agentForProfile(profile: string): Promise<string | null>
}

/** Hermes's schedule as the unified spec. */
export function hermesScheduleShape(job: HermesJob): GatewayCronScheduleShape | null {
  const s = job.schedule ?? {}
  if (s.kind === 'cron' && typeof s.expr === 'string') {
    const tz = typeof job['timezone'] === 'string' && job['timezone'] ? job['timezone'] : undefined
    return { kind: 'cron', expr: s.expr, ...(tz ? { tz } : {}) }
  }
  if (s.kind === 'interval' && typeof s.minutes === 'number' && s.minutes > 0) {
    return { kind: 'every', everyMs: s.minutes * 60_000 }
  }
  if (s.kind === 'once' && typeof s.run_at === 'string') return { kind: 'at', at: s.run_at }
  return null
}

/** The unified spec as a schedule string Hermes reads. Throws on one it cannot
 *  take (a time zone, an interval that is not whole minutes). */
export function hermesScheduleString(cronSpec: string): string {
  const shape = decodeCronSpec(cronSpec)
  switch (shape.kind) {
    case 'cron':
      if (shape.tz) {
        throw new InvalidRoutineTargetError(
          "A Hermes job runs in Hermes's own time zone: leave the time zone out.",
        )
      }
      return shape.expr
    case 'every': {
      const minutes = shape.everyMs / 60_000
      if (!Number.isInteger(minutes) || minutes < 1) {
        throw new InvalidRoutineTargetError('A Hermes job repeats in whole minutes.')
      }
      if (shape.anchorMs != null) {
        throw new InvalidRoutineTargetError(
          'A Hermes job repeats from when it was made: leave the start time out.',
        )
      }
      return `every ${minutes}m`
    }
    case 'at':
      return shape.at
  }
}

const time = (iso: unknown): number | null => {
  if (typeof iso !== 'string' || !iso) return null
  const t = Date.parse(iso)
  return Number.isFinite(t) ? t : null
}

export class HermesGatewayJobsScheduleSource implements ScheduleSource {
  readonly id = 'hermes-gateway-jobs' as const
  readonly domain = 'runtime-own-life' as const
  readonly manageability = 'external-write' as const

  private cache: ScheduleRecord[] | null = null

  constructor(private readonly backend: HermesJobsBackend) {}

  toRecord(agentId: string, profile: string, job: HermesJob): ScheduleRecord {
    const shape = hermesScheduleShape(job)
    const paused = job.enabled === false || job.state === 'paused'
    const status: ScheduleStatus = paused
      ? 'paused'
      : job.live_execution
        ? 'running'
        : job.last_status === 'error' || job.last_status === 'failed'
          ? 'error'
          : 'idle'
    const lastRunAt = time(job.last_run_at)
    return {
      id: makeScheduleId(this.id, `${profile}.${job.id}`),
      sourceScheduleId: `${profile}.${job.id}`,
      runtime: 'hermes',
      // Hermes's own scheduler fires these.
      owner: 'hermes',
      source: this.id,
      agentId,
      label: job.name,
      ...(typeof job.prompt === 'string' && job.prompt ? { description: job.prompt } : {}),
      cronSpec: shape
        ? encodeCronSpec(shape)
        : (job.schedule_display ?? job.schedule?.display ?? ''),
      nextRunAt: paused ? null : time(job.next_run_at),
      ...(lastRunAt !== null ? { lastRunAt } : {}),
      ...(job.last_error ? { lastError: String(job.last_error).slice(0, 500) } : {}),
      status,
      manageability: this.manageability,
      domain: this.domain,
      tenantId: null,
    }
  }

  async read(): Promise<ScheduleReadResult> {
    const at = Date.now()
    // Not in use: off, not unknown (a reader deciding when to wake a sleeping
    // computer reads `degraded: false` as "nothing here will fire").
    if (!this.backend.configured()) {
      this.cache = null
      return {
        records: [],
        status: { sourceId: this.id, ok: false, degraded: false, reason: 'not_configured', at },
      }
    }
    let agents: Awaited<ReturnType<HermesJobsBackend['agentClients']>>
    try {
      agents = await this.backend.agentClients()
    } catch (err) {
      agents = null
      void err
    }
    if (!agents) {
      const cached = this.cache ?? []
      return {
        records: cached,
        status: {
          sourceId: this.id,
          ok: false,
          degraded: true,
          reason: cached.length > 0 ? 'stale_cache' : 'gateway_stopped',
          at,
        },
      }
    }
    const records: ScheduleRecord[] = []
    const failures: string[] = []
    await Promise.all(
      agents.map(async ({ agentId, profile, client }) => {
        try {
          for (const job of await client.listJobs())
            records.push(this.toRecord(agentId, profile, job))
        } catch (err) {
          // Hermes answers 404 for a profile it does not have (an agent never
          // run): no jobs to show. A 401 is a profile it has, refusing this key:
          // its jobs still fire, unseen, so that is a degraded read like any other.
          if (err instanceof HermesApiError && err.status === 404) return
          failures.push(profile)
          void err
        }
      }),
    )
    this.cache = records
    return {
      records,
      status: failures.length
        ? { sourceId: this.id, ok: false, degraded: true, reason: 'profile_unreadable', at }
        : { sourceId: this.id, ok: true, degraded: false, at },
    }
  }

  /** One agent's client, or null; a gateway that cannot start is unavailable. */
  private async clientFor(
    agentId: string,
  ): Promise<{ profile: string; client: HermesClient } | null> {
    try {
      return await this.backend.clientFor(agentId)
    } catch (err) {
      throw new ScheduleSourceUnavailableError(
        this.id,
        err instanceof Error ? err.message : String(err),
      )
    }
  }

  async write(action: ScheduleWriteAction): Promise<ScheduleRecord | null> {
    if (action.kind === 'create') {
      const spec = action.spec
      if (spec.domain === 'team-task') throw new TeamTaskDomainViolationError(this.id)
      // Team work is a Routine: a Hermes job runs one agent's prompt, nothing more.
      if (
        (spec.target !== undefined && spec.target !== 'agent') ||
        spec.teamId ||
        spec.teamTaskId ||
        spec.taskTemplate !== undefined
      ) {
        throw new InvalidRoutineTargetError(
          "Team work is a Routine: Hermes's own jobs run one agent's prompt.",
        )
      }
      if (!action.spec.agentId) throw new InvalidRoutineTargetError('A Hermes job needs an agent.')
      const target = await this.clientFor(action.spec.agentId)
      if (!target) throw new InvalidRoutineTargetError('That agent does not run on Hermes.')
      const payload = action.spec.payload as { message?: unknown; prompt?: unknown } | undefined
      const prompt =
        typeof payload?.prompt === 'string'
          ? payload.prompt
          : typeof payload?.message === 'string'
            ? payload.message
            : (action.spec.label ?? '')
      if (!prompt.trim()) throw new InvalidRoutineTargetError('A Hermes job needs a prompt.')
      const schedule = hermesScheduleString(action.spec.cronSpec)
      const job = await this.call(() =>
        target.client
          .createJob({ name: action.spec.label ?? 'Scheduled job', schedule, prompt })
          .catch((err: unknown) => {
            // The agent's profile is made on its first run; until then Hermes
            // has no such profile (404). A 401 is a key refused, said below.
            if (err instanceof HermesApiError && err.status === 404) {
              throw new InvalidRoutineTargetError(
                'Run this agent once before giving it a Hermes job: its Hermes profile is made on its first run.',
              )
            }
            throw err
          }),
      )
      return this.toRecord(action.spec.agentId, target.profile, job)
    }

    const { agentId, profile, jobId, client } = await this.locate(action.id)
    switch (action.kind) {
      case 'update': {
        const p = action.patch
        if (
          p.target !== undefined ||
          p.teamId !== undefined ||
          p.taskTemplate !== undefined ||
          (p.agentId !== undefined && p.agentId !== agentId)
        ) {
          throw new InvalidRoutineTargetError(
            'A Hermes job stays with its agent and runs a prompt: change its name, time or prompt.',
          )
        }
        const payload = action.patch.payload as { message?: unknown; prompt?: unknown } | undefined
        const prompt =
          typeof payload?.prompt === 'string'
            ? payload.prompt
            : typeof payload?.message === 'string'
              ? payload.message
              : undefined
        const patch = {
          ...(action.patch.label !== undefined ? { name: action.patch.label } : {}),
          ...(action.patch.cronSpec !== undefined
            ? { schedule: hermesScheduleString(action.patch.cronSpec) }
            : {}),
          ...(prompt !== undefined ? { prompt } : {}),
        }
        const job = await this.call(() => client.updateJob(jobId, patch), action.id)
        return job ? this.toRecord(agentId, profile, job) : null
      }
      case 'pause':
        await this.call(() => client.pauseJob(jobId), action.id)
        return this.readBack(agentId, profile, jobId, client)
      case 'resume':
        await this.call(() => client.resumeJob(jobId), action.id)
        return this.readBack(agentId, profile, jobId, client)
      case 'remove':
        await this.call(() => client.deleteJob(jobId), action.id)
        return null
      case 'run':
        await this.call(() => client.runJob(jobId), action.id)
        return null
    }
  }

  /** The agent, profile, job and client behind a composite id. */
  private async locate(
    id: string,
  ): Promise<{ agentId: string; profile: string; jobId: string; client: HermesClient }> {
    const raw = id.startsWith(`${this.id}:`) ? id.slice(this.id.length + 1) : id
    const dot = raw.lastIndexOf('.')
    const profile = dot > 0 ? raw.slice(0, dot) : ''
    const jobId = dot > 0 ? raw.slice(dot + 1) : ''
    if (!profile || !/^[a-f0-9]{12}$/.test(jobId)) throw new UnknownScheduleError(id)
    const agentId = await this.backend.agentForProfile(profile)
    if (!agentId) throw new UnknownScheduleError(id)
    const target = await this.clientFor(agentId)
    if (!target || target.profile !== profile) throw new UnknownScheduleError(id)
    return { agentId, profile, jobId, client: target.client }
  }

  private async readBack(
    agentId: string,
    profile: string,
    jobId: string,
    client: HermesClient,
  ): Promise<ScheduleRecord | null> {
    try {
      return this.toRecord(agentId, profile, await client.getJob(jobId))
    } catch {
      return null // the write landed; the read-back is best effort
    }
  }

  /** One call on the gateway: an unknown job is a 404, a stopped gateway a 503. */
  private async call<T>(fn: () => Promise<T>, scheduleId?: string): Promise<T> {
    try {
      return await fn()
    } catch (err) {
      if (err instanceof InvalidRoutineTargetError) throw err
      if (err instanceof HermesApiError) {
        if (err.status === 404 && scheduleId) throw new UnknownScheduleError(scheduleId)
        if (err.status === 401) throw new ScheduleSourceUnavailableError(this.id, 'key_refused')
        if (err.status === 400 || err.status === 422)
          throw new InvalidRoutineTargetError(err.message)
      }
      if (err instanceof TypeError || (err as { name?: string }).name === 'TimeoutError') {
        throw new ScheduleSourceUnavailableError(this.id, 'gateway_unreachable')
      }
      throw err
    }
  }
}
