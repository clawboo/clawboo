// native CapabilitySource — the clawboo-MANAGED plane. Reads three DB-resident
// stores (all clawboo-owned, so all `managed`):
//   1. the `tool_registry` brokered tools (global)            → kind:'tool'
//   2. each native agent's AgentConfig.tools MCP toggles      → kind:'connector'
//   3. the per-agent `skills` table (curated installs)        → kind:'skill'
// (3) is runtime-AGNOSTIC: a curated skill installed onto an OpenClaw agent is an
// honest clawboo-managed annotation (what the TOOLS.md bullet always was), so its
// record carries the AGENT's runtime but `manageability:'managed'`. Writes reuse
// the existing tool-broker pipeline (evaluateInjection + appendAudit + setToolEnabled), never forked.

import {
  unsupported,
  type CapabilityReadResult,
  type CapabilityRecord,
  type CapabilitySource,
  type CapabilityWriteAction,
} from '@clawboo/capability-registry'
import {
  agents,
  appendAudit,
  createBuiltinRegistry,
  defaultAvailabilityContext,
  evaluateInjection,
  getCapability,
  injectionAuditSummary,
  isToolEnabled,
  setToolEnabled,
  skills,
  type ClawbooDb,
} from '@clawboo/db'
import { eq } from 'drizzle-orm'

import { getDb } from '../db'
import { loadAgentConfigOrDefault, saveAgentConfig } from '../runtimes/native/agentConfigStore'
import { buildRecord, okStatus } from './helpers'

const NATIVE_MCP_SERVERS = ['memory', 'tasks', 'tools'] as const

function slugify(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/(^-|-$)/g, '')
}

interface AgentMeta {
  runtime: string
  sourceId: string
}

function agentRuntimeMap(db: ClawbooDb): Map<string, AgentMeta> {
  const map = new Map<string, AgentMeta>()
  for (const a of db.select().from(agents).all()) {
    if (a.archivedAt != null) continue
    map.set(a.id, { runtime: a.runtime, sourceId: a.sourceId })
  }
  return map
}

export class NativeCapabilitySource implements CapabilitySource {
  readonly id = 'native' as const

  constructor(private readonly deps: { getDb: () => ClawbooDb } = { getDb }) {}

  private db(): ClawbooDb {
    return this.deps.getDb()
  }

  async read(): Promise<CapabilityReadResult> {
    const db = this.db()
    const records: CapabilityRecord[] = []
    const agentMap = agentRuntimeMap(db)

    // 1. Brokered tools (tool_registry) — global, managed.
    const ctx = defaultAvailabilityContext()
    for (const { descriptor, availability } of createBuiltinRegistry().listWithAvailability(ctx)) {
      const enabled = isToolEnabled(db, descriptor.name)
      records.push(
        buildRecord({
          sourceId: 'native',
          runtime: 'clawboo-native',
          scope: 'global',
          kind: 'tool',
          sourceKey: descriptor.name,
          origin: 'brokered-mcp',
          manageability: 'managed',
          name: descriptor.name,
          description: descriptor.description,
          availability: (descriptor.availability ?? null) as CapabilityRecord['availability'],
          available: availability.visible,
          diagnostics: availability.visible ? [] : availability.diagnostics,
          provenance: descriptor.provenance ?? null,
          status: !enabled ? 'disabled' : availability.visible ? 'ready' : 'unavailable',
        }),
      )
    }

    // 2. Per-native-agent MCP toggles (AgentConfig.tools) — agent-scoped, managed.
    for (const [agentId, meta] of agentMap) {
      if (meta.sourceId !== 'clawboo-native') continue
      const config = loadAgentConfigOrDefault(db, agentId)
      for (const server of NATIVE_MCP_SERVERS) {
        const enabled = config.tools[server]
        records.push(
          buildRecord({
            sourceId: 'native',
            runtime: 'clawboo-native',
            scope: 'agent',
            agentId,
            kind: 'connector',
            sourceKey: `mcp:${server}`,
            origin: 'mcp-connector',
            manageability: 'managed',
            name: `${server} MCP`,
            description: `clawboo ${server} MCP server`,
            available: true,
            status: enabled ? 'ready' : 'disabled',
          }),
        )
      }
    }

    // 3. Curated skills (skills table) — agent-scoped, managed, runtime = the agent's.
    for (const row of db.select().from(skills).all()) {
      const agentIds = parseAgentIds(row.metadata)
      for (const agentId of agentIds) {
        const meta = agentMap.get(agentId)
        if (!meta) continue // skip orphan annotations for deleted agents
        records.push(
          buildRecord({
            sourceId: 'native',
            runtime: meta.runtime,
            scope: 'agent',
            agentId,
            kind: 'skill',
            sourceKey: row.id,
            origin: 'curated-skill',
            manageability: 'managed',
            name: row.name,
            description: row.category ? `${row.category} skill` : '',
            available: true,
            status: 'ready',
          }),
        )
      }
    }

    return { records, status: okStatus('native') }
  }

  async write(action: CapabilityWriteAction): Promise<CapabilityRecord | null> {
    const db = this.db()
    if (action.kind === 'install') return this.install(db, action.spec)

    const row = getCapability(db, action.id)
    if (!row) unsupported('native', action.kind)
    const enable = action.kind === 'enable'

    if (row.origin === 'brokered-mcp') {
      setToolEnabled(db, row.sourceKey, enable)
      appendAudit(db, {
        eventType: 'install',
        summary: { action: action.kind, capability: row.name, origin: row.origin },
      })
      return null
    }

    if (row.origin === 'mcp-connector' && row.agentId) {
      const server = row.sourceKey.replace(/^mcp:/, '') as (typeof NATIVE_MCP_SERVERS)[number]
      if (!NATIVE_MCP_SERVERS.includes(server)) unsupported('native', action.kind)
      const config = loadAgentConfigOrDefault(db, row.agentId)
      // Re-enabling `tasks` on a TEAM agent restores the READ surface, never full
      // write access. This panel is a binary toggle, and on a team the board
      // WRITES are engine-owned — a model-issued create_task/claim_task races the
      // orchestrator's claims (409) or orphans a task nothing dispatches. A plain
      // `true` would silently hand that back the first time someone toggled the
      // row off and on.
      //
      // A TEAMLESS agent has no orchestrator to race, so that rationale does not
      // apply to it: coercing there would permanently downgrade a solo agent that
      // legitimately held full board access, with no way back through the UI.
      const teamId =
        server === 'tasks'
          ? ((
              db
                .select({ teamId: agents.teamId })
                .from(agents)
                .where(eq(agents.id, row.agentId))
                .get() as { teamId: string | null } | undefined
            )?.teamId ?? null)
          : null
      if (server === 'tasks' && teamId) config.tools.tasks = enable ? 'read' : false
      else config.tools[server] = enable
      saveAgentConfig(db, config)
      appendAudit(db, {
        agentId: row.agentId,
        eventType: 'install',
        summary: { action: action.kind, capability: row.name, origin: row.origin },
      })
      return null
    }

    if (row.origin === 'curated-skill' && row.agentId) {
      this.setCuratedSkillAgent(db, row.sourceKey, row.agentId, enable)
      appendAudit(db, {
        agentId: row.agentId,
        eventType: 'install',
        summary: { action: action.kind, capability: row.name, origin: row.origin },
      })
      return null
    }

    unsupported('native', action.kind)
  }

  /** Install a curated catalog skill onto an agent — the headline managed write.
   *  Reuses the existing supply-chain scan + audit (mirrors POST /api/skills). */
  private install(
    db: ClawbooDb,
    spec: Extract<CapabilityWriteAction, { kind: 'install' }>['spec'],
  ): CapabilityRecord {
    // The payload is TWO surfaces, not one blob. `name` + `skillContent` are
    // prose that lands in an agent's context, so they evaluate on `prompt`:
    // instruction-override phrasing blocks, while security-education prose about
    // a destructive command is flagged for review rather than refused. A
    // connector's command/args/env is spawn-bound, so it evaluates on `exec`
    // where every rule blocks, so a malicious MCP-connector command can never slip
    // the scan before a future caller wires it to a spawn.
    const scope = `capability:${spec.name}`
    const prose = evaluateInjection([spec.name, spec.skillContent ?? ''].join('\n'), {
      surface: 'prompt',
      scope: `${scope}#content`,
    })
    const spawn = evaluateInjection(
      [
        spec.mcpServer?.command ?? '',
        ...(spec.mcpServer?.args ?? []),
        ...Object.entries(spec.mcpServer?.env ?? {}).flat(),
      ].join('\n'),
      { surface: 'exec', scope: `${scope}#mcpServer` },
    )
    if (prose.blocked || spawn.blocked) {
      appendAudit(db, {
        agentId: spec.agentId,
        eventType: 'install',
        summary: {
          blocked: true,
          name: spec.name,
          findings: injectionAuditSummary([...prose.block, ...spawn.block]),
        },
      })
      throw new Error('capability blocked: injection / supply-chain finding')
    }
    const skillId = `cap:${slugify(spec.name)}`
    const existing = db.select().from(skills).where(eq(skills.id, skillId)).get()
    if (existing) {
      const meta = parseMeta(existing.metadata)
      const ids = Array.isArray(meta.agentIds) ? (meta.agentIds as string[]) : []
      if (!ids.includes(spec.agentId)) ids.push(spec.agentId)
      meta.agentIds = ids
      db.update(skills)
        .set({ metadata: JSON.stringify(meta) })
        .where(eq(skills.id, skillId))
        .run()
    } else {
      db.insert(skills)
        .values({
          id: skillId,
          name: spec.name,
          source: 'capability',
          category: null,
          trustScore: null,
          installedAt: Date.now(),
          metadata: JSON.stringify({ agentIds: [spec.agentId] }),
        })
        .run()
    }
    appendAudit(db, {
      agentId: spec.agentId,
      eventType: 'install',
      summary: { blocked: false, name: spec.name, runtime: spec.runtime },
    })
    return buildRecord({
      sourceId: 'native',
      runtime: spec.runtime,
      scope: 'agent',
      agentId: spec.agentId,
      kind: 'skill',
      sourceKey: skillId,
      origin: 'curated-skill',
      manageability: 'managed',
      name: spec.name,
      available: true,
      status: 'ready',
    })
  }

  private setCuratedSkillAgent(
    db: ClawbooDb,
    skillId: string,
    agentId: string,
    present: boolean,
  ): void {
    const existing = db.select().from(skills).where(eq(skills.id, skillId)).get()
    if (!existing) return
    const meta = parseMeta(existing.metadata)
    let ids = Array.isArray(meta.agentIds) ? (meta.agentIds as string[]) : []
    ids = present ? [...new Set([...ids, agentId])] : ids.filter((x) => x !== agentId)
    if (ids.length === 0) {
      db.delete(skills).where(eq(skills.id, skillId)).run()
      return
    }
    meta.agentIds = ids
    db.update(skills)
      .set({ metadata: JSON.stringify(meta) })
      .where(eq(skills.id, skillId))
      .run()
  }
}

function parseMeta(metadata: string | null): Record<string, unknown> {
  if (!metadata) return {}
  try {
    return JSON.parse(metadata) as Record<string, unknown>
  } catch {
    return {}
  }
}

function parseAgentIds(metadata: string | null): string[] {
  const meta = parseMeta(metadata)
  return Array.isArray(meta.agentIds) ? (meta.agentIds as string[]) : []
}
