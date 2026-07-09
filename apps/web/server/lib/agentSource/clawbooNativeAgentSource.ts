// The native runtime's AgentSource — a PEER of the OpenClaw source in the same
// registry. There is no remote substrate: SQLite IS the upstream, so reads and
// writes are direct, `start()`/`sync()` are no-ops, and the source is always
// "connected". Agent files + the per-agent AgentConfig live in settings-KV
// rows (the per-agent-prefix convention the agents REST sweep also knows);
// sessions come from the `sessions` table the native harness populates. Every
// write carries the dormant tenantId (null today).

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
  type SessionRecord,
  type SyncResult,
  type TeamRecord,
  type UpdateAgentInput,
} from '@clawboo/agent-registry'
import { agentConfigSchema, DEFAULT_AGENT_CONFIG, type AgentConfig } from '@clawboo/adapter-native'
import {
  agents,
  approvalHistory,
  costRecords,
  createDb,
  sessions,
  setBudgetLimit,
  settings,
  teams,
  type ClawbooDb,
  type DbAgent,
} from '@clawboo/db'
import { and, eq, isNull, like, sql } from 'drizzle-orm'

import {
  loadAgentConfig,
  nativeConfigKey,
  nativeFileKey,
  readNativeAgentFile,
  saveAgentConfig,
  writeNativeAgentFile,
} from '../runtimes/native/agentConfigStore'
import { resolveConnectedNativeDefaults } from '../runtimes/native/nativeProviderDefaults'
import { nativeTeamSessionKeysForAgentLike } from '../teamChat/nativeTeamSession'

const SOURCE_ID = 'clawboo-native'

export interface ClawbooNativeAgentSourceDeps {
  getDbPath: () => string
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

export class ClawbooNativeAgentSource implements AgentSource {
  readonly id = SOURCE_ID

  private readonly listeners = new Set<(e: AgentEvent) => void>()

  constructor(private readonly deps: ClawbooNativeAgentSourceDeps) {}

  private db(): ClawbooDb {
    return createDb(this.deps.getDbPath())
  }

  private emit(e: AgentEvent): void {
    for (const listener of [...this.listeners]) listener(e)
  }

  private mapRow(row: DbAgent, db: ClawbooDb): AgentRecord {
    return {
      id: row.id,
      sourceId: row.sourceId,
      sourceAgentId: row.sourceAgentId ?? row.id,
      displayName: row.name || row.id,
      emoji: null,
      avatarUrl: null,
      avatarSeed: row.avatarSeed ?? null,
      status: row.status as AgentRecordStatus,
      sessionKey: `agent:${row.id}:native`,
      isDefault: false,
      teamId: row.teamId ?? null,
      personalityConfig: parseJson(row.personalityConfig),
      execConfig: parseJson(row.execConfig),
      // Surface the AgentConfig's model so the client's model selector shows the
      // native agent's real model (the config is the source of truth for native).
      model: loadAgentConfig(db, row.id)?.primaryModel ?? null,
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
    let rows = db.select().from(agents).where(eq(agents.sourceId, SOURCE_ID)).all()
    if (!opts?.includeArchived) rows = rows.filter((r) => r.archivedAt == null)
    if (opts?.teamId) rows = rows.filter((r) => r.teamId === opts.teamId)
    return rows.map((r) => this.mapRow(r, db))
  }

  async getAgent(id: string): Promise<AgentRecord | null> {
    const db = this.db()
    const row = db.select().from(agents).where(eq(agents.id, id)).get()
    // Scoped — a foreign source's row is not this source's agent.
    return row && row.sourceId === SOURCE_ID ? this.mapRow(row, db) : null
  }

  /** Teams are clawboo-owned (not source-owned) — same shared-table read as
   *  the OpenClaw source. */
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

  /** Native sessions are SQLite rows the harness upserts — never throws. */
  async listSessions(agentId: string): Promise<SessionRecord[]> {
    const db = this.db()
    const rows = db
      .select()
      .from(sessions)
      .where(and(eq(sessions.sourceId, SOURCE_ID), eq(sessions.agentId, agentId)))
      .all()
    return rows.map((s) => ({
      id: s.id,
      sourceId: SOURCE_ID,
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
    const id = `native-${slugifyName(input.name)}-${randomUUID().slice(0, 6)}`

    // The AgentConfig rides CreateAgentInput.execConfig (the registry input's
    // free-form config carrier); SOUL.md doubles as the systemPrompt fallback.
    // `modelTier` is a NON-schema hint (the zod parse strips it): when the caller
    // omits an explicit `primaryProvider` (e.g. CreateTeamModal, which doesn't know
    // which key the user connected), the provider/model/envVar are auto-resolved
    // from the first connected vault key so the agent runs on whatever the user
    // connected — an anthropic default with only an OpenAI key would fail at run
    // time. An explicit provider (the onboarding seed) bypasses this untouched.
    const rawExec =
      input.execConfig && typeof input.execConfig === 'object'
        ? (input.execConfig as Record<string, unknown>)
        : {}
    const { modelTier, ...execConfig } = rawExec as { modelTier?: unknown } & Record<string, unknown>
    const hasExplicitProvider =
      typeof execConfig['primaryProvider'] === 'string' && execConfig['primaryProvider'].length > 0
    const resolvedProvider = hasExplicitProvider
      ? {}
      : resolveConnectedNativeDefaults(modelTier === 'leader' ? 'leader' : 'specialist')
    const files = input.files ?? {}
    const config: AgentConfig = agentConfigSchema.parse({
      ...DEFAULT_AGENT_CONFIG,
      ...resolvedProvider,
      ...execConfig,
      id,
      name: input.name,
      systemPrompt:
        typeof execConfig['systemPrompt'] === 'string' && execConfig['systemPrompt']
          ? execConfig['systemPrompt']
          : (files['SOUL.md'] ?? DEFAULT_AGENT_CONFIG.systemPrompt),
      createdAt: now,
      updatedAt: now,
      tenantId: input.tenantId ?? null,
    })

    db.insert(agents)
      .values({
        id,
        name: input.name,
        // Legacy non-null column from the Gateway era — native rows self-reference.
        gatewayId: id,
        sourceId: SOURCE_ID,
        sourceAgentId: id,
        status: 'idle',
        participantKind: config.participantKind,
        runtime: SOURCE_ID,
        teamId: input.teamId ?? null,
        personalityConfig:
          input.personalityConfig != null ? JSON.stringify(input.personalityConfig) : null,
        // Store the cleaned carrier (the non-schema `modelTier` hint stripped).
        execConfig: input.execConfig != null ? JSON.stringify(execConfig) : null,
        avatarSeed: input.avatarSeed ?? null,
        tenantId: input.tenantId ?? null,
        createdAt: now,
        updatedAt: now,
      })
      .run()

    saveAgentConfig(db, config)
    for (const [name, content] of Object.entries(files)) {
      if (typeof content === 'string' && content) writeNativeAgentFile(db, id, name, content)
    }
    if (config.budgetUsd != null && config.budgetUsd > 0) {
      setBudgetLimit(db, {
        scope: 'agent',
        scopeId: id,
        limitUsdCents: Math.round(config.budgetUsd * 100),
        mode: 'cap',
        tenantId: input.tenantId ?? null,
      })
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

    // An execConfig patch re-validates + rewrites the stored AgentConfig.
    if (
      patch.execConfig !== undefined &&
      patch.execConfig &&
      typeof patch.execConfig === 'object'
    ) {
      const base = loadAgentConfig(db, id) ?? { ...DEFAULT_AGENT_CONFIG, id, createdAt: now }
      const merged = agentConfigSchema.parse({
        ...base,
        ...(patch.execConfig as Record<string, unknown>),
        id,
        updatedAt: now,
        tenantId: null,
      })
      saveAgentConfig(db, merged)
    }

    const record = await this.getAgent(id)
    if (!record) throw new Error(`updateAgent: agent ${id} not found after update`)
    this.emit({ kind: 'agent-upserted', at: now, agent: record })
    return record
  }

  /** Hard delete (house semantics — the archivedAt tombstone marks sync-detected
   *  upstream absence, which a substrate-less source cannot have): the agents
   *  row, its FK children, its sessions, and its per-agent KV rows. */
  async archiveAgent(id: string): Promise<void> {
    const db = this.db()
    db.delete(costRecords).where(eq(costRecords.agentId, id)).run()
    db.delete(approvalHistory).where(eq(approvalHistory.agentId, id)).run()
    db.delete(sessions)
      .where(and(eq(sessions.sourceId, SOURCE_ID), eq(sessions.agentId, id)))
      .run()
    db.delete(settings)
      .where(eq(settings.key, nativeConfigKey(id)))
      .run()
    db.delete(settings)
      .where(like(settings.key, `${nativeFileKey(id, '')}%`))
      .run()
    // The agent's native leader session-resume pointers, one per team it leads
    // (Boo Zero leads many). Orphan-harmless, but swept for hygiene.
    db.delete(settings)
      .where(like(settings.key, nativeTeamSessionKeysForAgentLike(id)))
      .run()
    db.delete(agents)
      .where(and(eq(agents.id, id), eq(agents.sourceId, SOURCE_ID)))
      .run()
    this.emit({ kind: 'agent-archived', at: Date.now(), agentId: id })
  }

  // ── Files (settings-KV; the registry's AGENT_FILE_NAMES namespace) ────────

  async readFile(agentId: string, name: AgentFileName): Promise<string> {
    return readNativeAgentFile(this.db(), agentId, name)
  }

  async writeFile(agentId: string, name: AgentFileName, content: string): Promise<void> {
    if (!(AGENT_FILE_NAMES as readonly string[]).includes(name))
      throw new Error(`unknown agent file: ${name}`)
    writeNativeAgentFile(this.db(), agentId, name, content)
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
