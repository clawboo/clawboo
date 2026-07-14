// A generic SQLite-backed AgentSource for the executor-driven coding runtimes
// (claude-code / codex / hermes). It's a PEER of the OpenClaw + native sources:
// SQLite IS the upstream, so reads/writes are direct, start()/sync() are no-ops,
// and it's always "connected". One instance is registered per runtime id.
//
// Unlike the native source there is NO AgentConfig here — the coding drivers read
// no per-agent config/files; the server engine (serverDeliver) runs them from the
// agent row's `runtime` + the vault key + the delegated task as the stimulus. The
// files written at create time are stored only for the agent detail editor.

import { randomUUID } from 'node:crypto'

import {
  AGENT_FILE_NAMES,
  type AgentEvent,
  type AgentFileName,
  type AgentRecord,
  type AgentRecordStatus,
  type AgentSource,
  type CreateAgentInput,
  type HealthResult,
  type RuntimeId,
  type SessionRecord,
  type SyncResult,
  type TeamRecord,
  type UpdateAgentInput,
} from '@clawboo/agent-registry'
import {
  agents,
  approvalHistory,
  costRecords,
  createDb,
  sessions,
  settings,
  teams,
  type ClawbooDb,
  type DbAgent,
} from '@clawboo/db'
import { and, eq, isNull, like, sql } from 'drizzle-orm'

import {
  readRuntimeAgentFile,
  runtimeAgentFileKey,
  writeRuntimeAgentFile,
} from './runtimeAgentFileStore'

export interface RuntimeAgentSourceDeps {
  getDbPath: () => string
  /** The runtime id this source owns (claude-code / codex / hermes). */
  runtimeId: RuntimeId
}

function parseJson(value: string | null): unknown | null {
  if (!value) return null
  try {
    return JSON.parse(value)
  } catch {
    return null
  }
}

function slugifyName(name: string): string {
  return (
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 32) || 'agent'
  )
}

export class RuntimeAgentSource implements AgentSource {
  readonly id: RuntimeId

  private readonly listeners = new Set<(e: AgentEvent) => void>()

  constructor(private readonly deps: RuntimeAgentSourceDeps) {
    this.id = deps.runtimeId
  }

  private db(): ClawbooDb {
    return createDb(this.deps.getDbPath())
  }

  private emit(e: AgentEvent): void {
    for (const listener of [...this.listeners]) listener(e)
  }

  private mapRow(row: DbAgent): AgentRecord {
    const exec = parseJson(row.execConfig) as { model?: unknown } | null
    return {
      id: row.id,
      sourceId: row.sourceId,
      sourceAgentId: row.sourceAgentId ?? row.id,
      displayName: row.name || row.id,
      emoji: null,
      avatarUrl: null,
      avatarSeed: row.avatarSeed ?? null,
      status: row.status as AgentRecordStatus,
      sessionKey: `agent:${row.id}:${this.id}`,
      isDefault: false,
      teamId: row.teamId ?? null,
      personalityConfig: parseJson(row.personalityConfig),
      execConfig: exec,
      // A coding-runtime agent's model lives in execConfig (Hermes: { provider, model }
      // — the editable pick). Surface it so the agent-detail selector shows the current.
      model: exec && typeof exec['model'] === 'string' ? exec['model'] : null,
      participantKind: (row.participantKind as AgentRecord['participantKind']) ?? 'agent',
      runtime: row.runtime,
      capabilities: parseJson(row.capabilities),
      tenantId: row.tenantId ?? null,
      archivedAt: row.archivedAt ?? null,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    }
  }

  // ── Reads ────────────────────────────────────────────────────────────────

  async listAgents(opts?: { includeArchived?: boolean; teamId?: string }): Promise<AgentRecord[]> {
    const db = this.db()
    let rows = db.select().from(agents).where(eq(agents.sourceId, this.id)).all()
    if (!opts?.includeArchived) rows = rows.filter((r) => r.archivedAt == null)
    if (opts?.teamId) rows = rows.filter((r) => r.teamId === opts.teamId)
    return rows.map((r) => this.mapRow(r))
  }

  async getAgent(id: string): Promise<AgentRecord | null> {
    const db = this.db()
    const row = db.select().from(agents).where(eq(agents.id, id)).get()
    // Scoped — a foreign source's row is not this source's agent.
    return row && row.sourceId === this.id ? this.mapRow(row) : null
  }

  /** Teams are clawboo-owned (not source-owned) — same shared-table read as the
   *  other sources. */
  async listTeams(opts?: { includeArchived?: boolean }): Promise<TeamRecord[]> {
    const db = this.db()
    const rows = db.select().from(teams).all()
    const filtered = opts?.includeArchived ? rows : rows.filter((t) => !t.isArchived)
    return filtered.map((t) => {
      const count = db
        .select({ c: sql<number>`COUNT(*)` })
        .from(agents)
        .where(and(eq(agents.teamId, t.id), isNull(agents.archivedAt)))
        .get()
      return {
        id: t.id,
        name: t.name,
        icon: t.icon,
        color: t.color,
        colorCollectionId: t.colorCollectionId ?? null,
        templateId: t.templateId ?? null,
        leaderAgentId: t.leaderAgentId ?? null,
        isArchived: !!t.isArchived,
        agentCount: count?.c ?? 0,
        tenantId: t.tenantId ?? null,
        createdAt: t.createdAt,
        updatedAt: t.updatedAt,
      }
    })
  }

  async listSessions(agentId: string): Promise<SessionRecord[]> {
    const db = this.db()
    const rows = db
      .select()
      .from(sessions)
      .where(and(eq(sessions.sourceId, this.id), eq(sessions.agentId, agentId)))
      .all()
    return rows.map((s) => ({
      id: s.id,
      sourceId: this.id,
      sourceSessionId: s.sourceSessionId,
      agentId: s.agentId ?? agentId,
      teamId: s.teamId ?? null,
      status:
        s.status === 'closed'
          ? ('closed' as const)
          : s.status === 'idle'
            ? ('idle' as const)
            : ('active' as const),
      createdAt: s.createdAt,
      updatedAt: s.updatedAt,
    }))
  }

  // ── Writes (SQLite is the upstream — these always work) ──────────────────

  async createAgent(input: CreateAgentInput): Promise<AgentRecord> {
    const db = this.db()
    const now = Date.now()
    const id = `${this.id}-${slugifyName(input.name)}-${randomUUID().slice(0, 6)}`

    const execConfig =
      input.execConfig && typeof input.execConfig === 'object'
        ? (input.execConfig as Record<string, unknown>)
        : null
    const participantKind =
      execConfig && typeof execConfig['participantKind'] === 'string'
        ? (execConfig['participantKind'] as string)
        : 'agent'
    const files = input.files ?? {}

    db.insert(agents)
      .values({
        id,
        name: input.name,
        // Legacy non-null column from the Gateway era — self-reference.
        gatewayId: id,
        sourceId: this.id,
        sourceAgentId: id,
        status: 'idle',
        participantKind,
        runtime: this.id,
        teamId: input.teamId ?? null,
        personalityConfig:
          input.personalityConfig != null ? JSON.stringify(input.personalityConfig) : null,
        execConfig: execConfig != null ? JSON.stringify(execConfig) : null,
        avatarSeed: input.avatarSeed ?? null,
        tenantId: input.tenantId ?? null,
        createdAt: now,
        updatedAt: now,
      })
      .run()

    for (const [name, content] of Object.entries(files)) {
      if (typeof content === 'string' && content) writeRuntimeAgentFile(db, id, name, content)
    }

    const record = await this.getAgent(id)
    if (!record) throw new Error('createAgent: row not found after insert')
    this.emit({ kind: 'agent-upserted', at: now, agent: record })
    return record
  }

  async updateAgent(id: string, patch: UpdateAgentInput): Promise<AgentRecord> {
    const db = this.db()
    const existing = await this.getAgent(id)
    if (!existing) throw new Error(`updateAgent: agent ${id} not found`)
    const now = Date.now()
    const set: Record<string, unknown> = { updatedAt: now }
    if (patch.teamId !== undefined) set['teamId'] = patch.teamId
    if (patch.personalityConfig !== undefined)
      set['personalityConfig'] =
        patch.personalityConfig != null ? JSON.stringify(patch.personalityConfig) : null
    if (patch.execConfig !== undefined)
      set['execConfig'] = patch.execConfig != null ? JSON.stringify(patch.execConfig) : null
    if (patch.avatarSeed !== undefined) set['avatarSeed'] = patch.avatarSeed
    if (patch.status !== undefined) set['status'] = patch.status
    if (patch.displayName !== undefined) set['name'] = patch.displayName
    db.update(agents).set(set).where(eq(agents.id, id)).run()

    const record = await this.getAgent(id)
    if (!record) throw new Error(`updateAgent: agent ${id} not found after update`)
    this.emit({ kind: 'agent-upserted', at: now, agent: record })
    return record
  }

  /** Hard delete (house semantics): the agents row, its FK children, its
   *  sessions, and its per-agent file-KV rows (prefix sweep, all file names). */
  async archiveAgent(id: string): Promise<void> {
    const db = this.db()
    db.delete(costRecords).where(eq(costRecords.agentId, id)).run()
    db.delete(approvalHistory).where(eq(approvalHistory.agentId, id)).run()
    db.delete(sessions)
      .where(and(eq(sessions.sourceId, this.id), eq(sessions.agentId, id)))
      .run()
    db.delete(settings)
      .where(like(settings.key, `${runtimeAgentFileKey(id, '')}%`))
      .run()
    db.delete(agents)
      .where(and(eq(agents.id, id), eq(agents.sourceId, this.id)))
      .run()
    this.emit({ kind: 'agent-archived', at: Date.now(), agentId: id })
  }

  // ── Files (settings-KV; the registry's AGENT_FILE_NAMES namespace) ────────

  async readFile(agentId: string, name: AgentFileName): Promise<string> {
    return readRuntimeAgentFile(this.db(), agentId, name)
  }

  async writeFile(agentId: string, name: AgentFileName, content: string): Promise<void> {
    if (!(AGENT_FILE_NAMES as readonly string[]).includes(name))
      throw new Error(`unknown agent file: ${name}`)
    writeRuntimeAgentFile(this.db(), agentId, name, content)
  }

  // ── Lifecycle / observability ──────────────────────────────────────────────

  async start(): Promise<void> {
    // No remote substrate to connect.
  }

  async stop(): Promise<void> {
    this.listeners.clear()
  }

  async health(): Promise<HealthResult> {
    return { ok: true, connection: 'connected', lastSyncedAt: null }
  }

  /** Nothing upstream to reconcile — SQLite is the source of truth. */
  async sync(): Promise<SyncResult> {
    return { upserted: 0, archived: 0, durationMs: 0, at: Date.now() }
  }

  events(): AsyncIterable<AgentEvent> {
    const listeners = this.listeners
    return {
      [Symbol.asyncIterator]: () => {
        const queue: AgentEvent[] = []
        let resolveNext: ((r: IteratorResult<AgentEvent>) => void) | null = null
        let done = false
        const listener = (e: AgentEvent): void => {
          if (resolveNext) {
            resolveNext({ value: e, done: false })
            resolveNext = null
          } else {
            queue.push(e)
          }
        }
        listeners.add(listener)
        return {
          next(): Promise<IteratorResult<AgentEvent>> {
            if (queue.length > 0) return Promise.resolve({ value: queue.shift()!, done: false })
            if (done) return Promise.resolve({ value: undefined, done: true })
            return new Promise((resolve) => {
              resolveNext = resolve
            })
          },
          return(): Promise<IteratorResult<AgentEvent>> {
            done = true
            listeners.delete(listener)
            if (resolveNext) {
              resolveNext({ value: undefined, done: true })
              resolveNext = null
            }
            return Promise.resolve({ value: undefined, done: true })
          },
        }
      },
    }
  }
}
