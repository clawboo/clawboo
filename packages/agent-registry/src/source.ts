import type {
  AgentRecord,
  AgentRecordStatus,
  RuntimeId,
  SessionRecord,
  TeamRecord,
} from './records'

/** The agent files that make up an agent's configuration of record. Matches
 *  @clawboo/protocol's AGENT_FILE_NAMES (kept as a local literal so this package
 *  stays dependency-free / browser-safe). */
export type AgentFileName =
  | 'AGENTS.md'
  | 'SOUL.md'
  | 'IDENTITY.md'
  | 'USER.md'
  | 'TOOLS.md'
  | 'HEARTBEAT.md'
  | 'MEMORY.md'

export const AGENT_FILE_NAMES: readonly AgentFileName[] = [
  'AGENTS.md',
  'SOUL.md',
  'IDENTITY.md',
  'USER.md',
  'TOOLS.md',
  'HEARTBEAT.md',
  'MEMORY.md',
]

export interface CreateAgentInput {
  name: string
  teamId?: string | null
  personalityConfig?: unknown
  execConfig?: unknown
  avatarSeed?: string | null
  /** Optional agent files written at create time (SOUL/IDENTITY/TOOLS/AGENTS/CLAWBOO). */
  files?: Partial<Record<string, string>>
  /**
   * The owning tenant for the created row (multi-tenant seam). Resolved once at the
   * REST handler via `getTenantId(req)` and threaded here (the sources have no
   * request). `null`/omitted = the single implicit tenant (byte-identical today).
   */
  tenantId?: string | null
}

export interface UpdateAgentInput {
  displayName?: string
  teamId?: string | null
  personalityConfig?: unknown
  execConfig?: unknown
  avatarSeed?: string | null
  status?: AgentRecordStatus
}

export interface HealthResult {
  ok: boolean
  connection: 'connected' | 'connecting' | 'reconnecting' | 'disconnected'
  lastSyncedAt: number | null
  message?: string
}

export interface SyncResult {
  upserted: number
  /** Agents present in SQLite but gone upstream → archivedAt set. */
  archived: number
  durationMs: number
  at: number
}

/** A live registry change. Async-iterable so an SSE route / a consumer can
 *  `for await` it; the consumer terminates observation explicitly (break /
 *  iterator.return()), mirroring RuntimeAdapter.events(). */
export type AgentEvent =
  | { kind: 'agent-upserted'; at: number; agent: AgentRecord }
  | { kind: 'agent-status'; at: number; agentId: string; status: AgentRecordStatus }
  | { kind: 'agent-archived'; at: number; agentId: string }
  | { kind: 'sync-complete'; at: number; result: SyncResult }
  | { kind: 'connection'; at: number; connection: HealthResult['connection'] }

/**
 * The agent-registry-of-record seam. `AgentSource` answers "where does the agent
 * list come from?" — reads are SQLite-backed (work even when the upstream is down),
 * writes + file I/O + sessions go to the upstream and mirror into SQLite. The only
 * Phase-A implementation is `OpenClawAgentSource` (server-side, wraps the Gateway).
 * A future native runtime adds a second source with the SAME interface.
 *
 * Concerns: this is about WHO exists (the registry). It is NOT about HOW agents run
 * (that's `RuntimeAdapter` in @clawboo/executor); the two must not entangle.
 */
export interface AgentSource {
  readonly id: RuntimeId

  // ── Reads (SQLite-backed → work even when the upstream is down) ──
  listAgents(opts?: { includeArchived?: boolean; teamId?: string }): Promise<AgentRecord[]>
  getAgent(id: string): Promise<AgentRecord | null>
  listTeams(opts?: { includeArchived?: boolean }): Promise<TeamRecord[]>
  /** OpenClaw: delegates LIVE to the Gateway (sessions are runtime-volatile). */
  listSessions(agentId: string): Promise<SessionRecord[]>

  // ── Writes (require a live upstream → throw when disconnected) ──
  createAgent(input: CreateAgentInput): Promise<AgentRecord>
  updateAgent(id: string, patch: UpdateAgentInput): Promise<AgentRecord>
  archiveAgent(id: string): Promise<void>

  // ── Agent files (route through the source) ──
  readFile(agentId: string, name: AgentFileName): Promise<string>
  writeFile(agentId: string, name: AgentFileName, content: string): Promise<void>

  // ── Lifecycle / observability ──
  start(): Promise<void>
  stop(): Promise<void>
  health(): Promise<HealthResult>
  /** Idempotent upstream→SQLite reconcile. Preserves every SQLite-native column. */
  sync(): Promise<SyncResult>
  events(): AsyncIterable<AgentEvent>
}
