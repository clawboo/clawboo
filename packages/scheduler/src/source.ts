// The ScheduleSource trait — the unified Scheduler surface's per-system
// adapter, fanned by ScheduleMultiplexer. Structural mirror of AgentSource
// (and the planned capability inventory): a read()-multiplexed,
// write()-adapter trait gated by manageability. read() NEVER rejects —
// degradation is data (the status), so one dead source can't take the merged
// view down.

import type {
  ScheduleDomain,
  ScheduleManageability,
  ScheduleRecord,
  ScheduleSourceId,
} from './records'
import type { RoutineTarget } from './template'

export type ScheduleWriteAction =
  | { kind: 'create'; spec: ScheduleCreateSpec }
  | { kind: 'update'; id: string; patch: ScheduleUpdatePatch }
  | { kind: 'pause'; id: string }
  | { kind: 'resume'; id: string }
  | { kind: 'remove'; id: string }
  | { kind: 'run'; id: string }

export interface ScheduleCreateSpec {
  source: ScheduleSourceId
  domain: ScheduleDomain
  /** The agent a fire runs on. Required for Gateway rows and agent routines; a
   *  team routine has none (its fire goes to whoever leads the team then). */
  agentId?: string
  /** Routine rows: who a fire goes to. Defaults to 'agent'. */
  target?: RoutineTarget
  cronSpec: string
  label?: string
  /** Routine rows: the team. Required for a team routine; for an agent routine
   *  it defaults to the agent's own team and must match it when given. */
  teamId?: string | null
  /** Routine rows: bind to an existing board task (the ownership-guard site). */
  teamTaskId?: string | null
  /** Routine rows: the ledger taskTemplate object (validated by the source). */
  taskTemplate?: unknown
  /** Gateway rows: the cron payload (e.g. { kind: 'agentTurn', message }). */
  payload?: unknown
  /** Dormant multi-tenant seam. */
  tenantId?: string | null
}

export interface ScheduleUpdatePatch {
  cronSpec?: string
  label?: string
  taskTemplate?: unknown
  payload?: unknown
  /** Routine rows: re-point the routine. The resulting target is validated
   *  exactly like a create. */
  target?: RoutineTarget
  agentId?: string | null
  teamId?: string | null
}

export interface ScheduleSourceReadStatus {
  sourceId: ScheduleSourceId
  ok: boolean
  degraded: boolean
  /** e.g. 'gateway_disconnected' | 'stale_cache' */
  reason?: string
  at: number
}

export interface ScheduleReadResult {
  records: ScheduleRecord[]
  status: ScheduleSourceReadStatus
}

export interface ScheduleSource {
  readonly id: ScheduleSourceId
  readonly domain: ScheduleDomain
  readonly manageability: ScheduleManageability
  /** Never rejects — a failing backend returns degraded status + best records. */
  read(): Promise<ScheduleReadResult>
  /**
   * Throws the typed errors from ./errors; returns the fresh record (null for
   * remove/run acknowledgements).
   */
  write(action: ScheduleWriteAction): Promise<ScheduleRecord | null>
}
