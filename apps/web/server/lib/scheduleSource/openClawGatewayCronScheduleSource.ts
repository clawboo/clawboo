// OpenClawGatewayCronScheduleSource — the 'external-write' runtime-own-life
// side of the unified Scheduler surface: a read+write adapter over the
// operator WS-RPC cron methods on the server-held Gateway connection.
//
// The Gateway cron schedules the OpenClaw agent's OWN standalone life — a
// different domain from team-task cron. clawboo NEVER registers a team task
// here (a domain:'team-task' create is refused, on top of the multiplexer's
// gate) and never auto-creates own-life crons; the Scheduler tab is an
// operator surface over them, not their owner. Preconditions held by the
// server-side operator connection: the device is PAIRED, and operator-WRITE scope suffices (not
// admin). The agent-side Tier-3 cron gate is irrelevant to these operator
// methods and is never touched.
//
// Verified method names: read = cron.list {includeDisabled} / cron.get;
// write = cron.add / cron.update (incl. {id, enabled} — no separate
// enable/disable method) / cron.remove / cron.run {id, mode:'force'}
// (enqueue-style ack). Live updates ride the broadcast `cron` event family.

import {
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

const REFRESH_DEBOUNCE_MS = 750

/** The operator slice this source needs (the OpenClawAgentSource satisfies it). */
export interface OperatorCronClientLike {
  isConnected(): boolean
  operatorCall<T>(method: string, params?: unknown): Promise<T>
  onGatewayBroadcast(cb: (frame: { event: string; payload?: unknown }) => void): () => void
}

// Local declarations of the Gateway cron wire shapes (kept dependency-free).
interface GatewayCronJobState {
  nextRunAtMs?: number
  runningAtMs?: number
  lastRunAtMs?: number
  lastStatus?: 'ok' | 'error' | 'skipped'
  lastError?: string
}
interface GatewayCronJobSummary {
  id: string
  name: string
  agentId?: string
  enabled: boolean
  schedule: GatewayCronScheduleShape
  sessionTarget?: string
  wakeMode?: string
  payload?: unknown
  state?: GatewayCronJobState
}

export class OpenClawGatewayCronScheduleSource implements ScheduleSource {
  readonly id = 'openclaw-gateway-cron' as const
  readonly domain = 'runtime-own-life' as const
  readonly manageability = 'external-write' as const

  private cache: ScheduleRecord[] | null = null
  private refreshTimer: ReturnType<typeof setTimeout> | null = null

  constructor(private readonly client: OperatorCronClientLike) {
    // Live cache updates on the broadcast `cron` event family. Registered on
    // the source-level fan-out, which survives Gateway reconnects.
    this.client.onGatewayBroadcast((frame) => {
      if (frame.event === 'cron') this.scheduleRefresh()
    })
  }

  private scheduleRefresh(): void {
    if (this.refreshTimer) clearTimeout(this.refreshTimer)
    this.refreshTimer = setTimeout(() => {
      this.refreshTimer = null
      void this.fetchJobs()
        .then((records) => {
          this.cache = records
        })
        .catch(() => undefined) // best-effort cache warmth; read() re-fetches live
    }, REFRESH_DEBOUNCE_MS)
    this.refreshTimer.unref?.()
  }

  private toRecord(job: GatewayCronJobSummary): ScheduleRecord {
    const state = job.state ?? {}
    const status: ScheduleStatus = !job.enabled
      ? 'paused'
      : state.runningAtMs != null
        ? 'running'
        : state.lastStatus === 'error'
          ? 'error'
          : 'idle'
    return {
      id: makeScheduleId(this.id, job.id),
      sourceScheduleId: job.id,
      runtime: 'openclaw',
      // The Gateway fires these — the firing owner of record is 'openclaw'.
      owner: 'openclaw',
      source: this.id,
      agentId: job.agentId ?? '',
      label: job.name,
      cronSpec: encodeCronSpec(job.schedule),
      nextRunAt: state.nextRunAtMs ?? null,
      ...(state.lastRunAtMs != null ? { lastRunAt: state.lastRunAtMs } : {}),
      ...(state.lastError ? { lastError: state.lastError } : {}),
      status,
      manageability: this.manageability,
      domain: this.domain,
      tenantId: null,
    }
  }

  private async fetchJobs(): Promise<ScheduleRecord[]> {
    const result = await this.client.operatorCall<{ jobs: GatewayCronJobSummary[] }>('cron.list', {
      includeDisabled: true,
    })
    return (result.jobs ?? []).map((job) => this.toRecord(job))
  }

  async read(): Promise<ScheduleReadResult> {
    const at = Date.now()
    if (!this.client.isConnected()) {
      // Degradation is DATA — never throw the merged view down. A warm cache
      // is served stale; otherwise the rows are simply hidden until reconnect.
      return {
        records: this.cache ?? [],
        status: {
          sourceId: this.id,
          ok: false,
          degraded: true,
          reason: this.cache ? 'stale_cache' : 'gateway_disconnected',
          at,
        },
      }
    }
    try {
      const records = await this.fetchJobs()
      this.cache = records
      return { records, status: { sourceId: this.id, ok: true, degraded: false, at } }
    } catch (err) {
      return {
        records: this.cache ?? [],
        status: {
          sourceId: this.id,
          ok: false,
          degraded: true,
          reason: err instanceof Error ? err.message : String(err),
          at,
        },
      }
    }
  }

  async write(action: ScheduleWriteAction): Promise<ScheduleRecord | null> {
    if (!this.client.isConnected()) {
      throw new ScheduleSourceUnavailableError(this.id, 'gateway_disconnected')
    }
    switch (action.kind) {
      case 'create': {
        // clawboo must NEVER register a team task into the Gateway cron.
        if (action.spec.domain === 'team-task') throw new TeamTaskDomainViolationError(this.id)
        const job = await this.client.operatorCall<GatewayCronJobSummary>('cron.add', {
          name: action.spec.label ?? 'clawboo schedule',
          agentId: action.spec.agentId,
          enabled: true,
          schedule: decodeCronSpec(action.spec.cronSpec),
          sessionTarget: 'main',
          wakeMode: 'now',
          payload: action.spec.payload ?? {
            kind: 'agentTurn',
            message: action.spec.label ?? 'Scheduled wake',
          },
        })
        return this.toRecord(job)
      }
      case 'update': {
        const id = this.rawId(action.id)
        await this.client.operatorCall('cron.update', {
          id,
          ...(action.patch.label !== undefined ? { name: action.patch.label } : {}),
          ...(action.patch.cronSpec !== undefined
            ? { schedule: decodeCronSpec(action.patch.cronSpec) }
            : {}),
          ...(action.patch.payload !== undefined ? { payload: action.patch.payload } : {}),
        })
        return this.readBack(id)
      }
      case 'pause':
      case 'resume': {
        const id = this.rawId(action.id)
        // No separate enable/disable method — `cron.update {id, enabled}`.
        await this.client.operatorCall('cron.update', { id, enabled: action.kind === 'resume' })
        return this.readBack(id)
      }
      case 'remove': {
        await this.client.operatorCall('cron.remove', { id: this.rawId(action.id) })
        return null
      }
      case 'run': {
        // Enqueue-style: the Gateway acks; completion is polled via cron.runs.
        await this.client.operatorCall('cron.run', { id: this.rawId(action.id), mode: 'force' })
        return null
      }
    }
  }

  private async readBack(id: string): Promise<ScheduleRecord | null> {
    try {
      const res = await this.client.operatorCall<
        GatewayCronJobSummary | { job: GatewayCronJobSummary }
      >('cron.get', { id })
      const job = 'job' in res && res.job ? res.job : (res as GatewayCronJobSummary)
      return job?.id ? this.toRecord(job) : null
    } catch (err) {
      if (err instanceof UnknownScheduleError) throw err
      return null // the write landed; the read-back is best-effort
    }
  }

  private rawId(compositeOrRaw: string): string {
    const prefix = `${this.id}:`
    return compositeOrRaw.startsWith(prefix) ? compositeOrRaw.slice(prefix.length) : compositeOrRaw
  }
}
