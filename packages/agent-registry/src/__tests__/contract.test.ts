import { describe, it, expect } from 'vitest'

import { AgentRegistry } from '../registry'
import type { AgentRecord, AgentSource, CreateAgentInput, SyncResult } from '../index'

// A minimal in-memory AgentSource that satisfies the contract. Proves the trait is
// implementable + the registry multiplexer behaves; the real OpenClawAgentSource is
// tested separately (apps/web) against a fake Gateway.
function makeFakeSource(id = 'fake'): AgentSource {
  const rows = new Map<string, AgentRecord>()
  const files = new Map<string, string>()
  let seq = 0
  const events: Array<{ kind: string }> = []
  const now = () => ++seq

  function toRecord(input: CreateAgentInput, rid: string): AgentRecord {
    return {
      id: rid,
      sourceId: id,
      sourceAgentId: rid,
      displayName: input.name,
      emoji: null,
      avatarUrl: null,
      avatarSeed: input.avatarSeed ?? null,
      status: 'idle',
      sessionKey: `agent:${rid}:main`,
      isDefault: false,
      teamId: input.teamId ?? null,
      personalityConfig: input.personalityConfig ?? null,
      execConfig: input.execConfig ?? null,
      participantKind: 'agent',
      runtime: id,
      capabilities: null,
      tenantId: null,
      archivedAt: null,
      createdAt: now(),
      updatedAt: now(),
    }
  }

  return {
    id,
    listAgents: (opts) =>
      Promise.resolve(
        [...rows.values()].filter((r) => (opts?.includeArchived ? true : r.archivedAt == null)),
      ),
    getAgent: (rid) => Promise.resolve(rows.get(rid) ?? null),
    listTeams: () => Promise.resolve([]),
    listSessions: () => Promise.resolve([]),
    createAgent: (input) => {
      const rid = `${id}-${now()}`
      const rec = toRecord(input, rid)
      rows.set(rid, rec)
      events.push({ kind: 'agent-upserted' })
      return Promise.resolve(rec)
    },
    updateAgent: (rid, patch) => {
      const prev = rows.get(rid)
      if (!prev) throw new Error('not found')
      const next = {
        ...prev,
        ...patch,
        displayName: patch.displayName ?? prev.displayName,
        updatedAt: now(),
      }
      rows.set(rid, next as AgentRecord)
      events.push({ kind: 'agent-upserted' })
      return Promise.resolve(next as AgentRecord)
    },
    archiveAgent: (rid) => {
      rows.delete(rid)
      events.push({ kind: 'agent-archived' })
      return Promise.resolve()
    },
    readFile: (rid, name) => Promise.resolve(files.get(`${rid}/${name}`) ?? ''),
    writeFile: (rid, name, content) => {
      files.set(`${rid}/${name}`, content)
      return Promise.resolve()
    },
    start: () => Promise.resolve(),
    stop: () => Promise.resolve(),
    health: () => Promise.resolve({ ok: true, connection: 'connected', lastSyncedAt: now() }),
    sync: () =>
      Promise.resolve({ upserted: rows.size, archived: 0, durationMs: 0, at: now() } as SyncResult),
    // Expose the event log via a one-shot async iterable for the assertion.
    events: async function* () {
      for (const e of events) yield { kind: e.kind, at: 0 } as never
    },
  }
}

describe('AgentSource contract', () => {
  it('round-trips create → get → update → archive', async () => {
    const src = makeFakeSource()
    const created = await src.createAgent({ name: 'Boo', teamId: 't1' })
    expect(created.displayName).toBe('Boo')
    expect(created.teamId).toBe('t1')

    expect(await src.getAgent(created.id)).not.toBeNull()
    expect(await src.listAgents()).toHaveLength(1)

    const updated = await src.updateAgent(created.id, { displayName: 'Boo Renamed' })
    expect(updated.displayName).toBe('Boo Renamed')

    await src.archiveAgent(created.id)
    expect(await src.listAgents()).toHaveLength(0)
    expect(await src.getAgent(created.id)).toBeNull()
  })

  it('readFile / writeFile round-trip', async () => {
    const src = makeFakeSource()
    const a = await src.createAgent({ name: 'A' })
    await src.writeFile(a.id, 'TOOLS.md', '# TOOLS\n')
    expect(await src.readFile(a.id, 'TOOLS.md')).toBe('# TOOLS\n')
  })

  it('events fire on mutations', async () => {
    const src = makeFakeSource()
    await src.createAgent({ name: 'A' })
    const seen: string[] = []
    for await (const e of src.events()) seen.push(e.kind)
    expect(seen).toContain('agent-upserted')
  })
})

describe('AgentRegistry', () => {
  it('registers + resolves the default source; aggregates nothing extra', () => {
    const reg = new AgentRegistry()
    expect(() => reg.default()).toThrow()
    const src = makeFakeSource('openclaw')
    reg.register(src)
    expect(reg.default()).toBe(src)
    expect(reg.get('openclaw')).toBe(src)
    expect(reg.list()).toHaveLength(1)
    reg.unregister('openclaw')
    expect(reg.has('openclaw')).toBe(false)
  })
})
