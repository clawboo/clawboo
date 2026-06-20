// OpenClawAgentSource integration test: a FAKE Gateway client (the fakeGateway
// pattern) drives agents.list + files + sessions; we assert SQLite mirrors the
// list, that re-sync is idempotent + preserves SQLite-native columns, that absent
// agents are archived, and that files/sessions delegate. Sandboxes CLAWBOO_HOME so
// the sqlite db lands in a throwaway dir.

import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { agents, createDb, teams } from '@clawboo/db'
import { eq } from 'drizzle-orm'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { getDbPath } from '../../db'
import {
  OpenClawAgentSource,
  type AgentListEntryLike,
  type OpenClawClientLike,
} from '../openClawAgentSource'

// ── Fake Gateway client ──
class FakeGateway implements OpenClawClientLike {
  list: { defaultId: string; mainKey: string; agents: AgentListEntryLike[] } = {
    defaultId: 'a1',
    mainKey: 'main',
    agents: [],
  }
  files = new Map<string, string>()
  createdWith: Array<{ name: string; workspace: string }> = []
  fileWrites: Array<{ agentId: string; name: string; content: string }> = []
  configPath = '/home/u/.openclaw/openclaw.json'
  private statusCb: ((s: string) => void) | null = null

  connect(): Promise<void> {
    return Promise.resolve()
  }
  disconnect(): void {}
  onStatus(cb: (s: string) => void): () => void {
    this.statusCb = cb
    return () => {
      this.statusCb = null
    }
  }
  onEvent(): () => void {
    return () => {}
  }
  call<T = unknown>(): Promise<T> {
    return Promise.resolve(undefined as T)
  }
  emitStatus(s: string): void {
    this.statusCb?.(s)
  }
  agents = {
    list: () => Promise.resolve(this.list),
    create: (cfg: { name: string; workspace: string }) => {
      this.createdWith.push(cfg)
      return Promise.resolve({ agentId: `new-${cfg.name}` })
    },
    delete: () => Promise.resolve(),
    files: {
      read: (agentId: string, name: string) =>
        Promise.resolve(this.files.get(`${agentId}/${name}`) ?? ''),
      set: (agentId: string, name: string, content: string) => {
        this.fileWrites.push({ agentId, name, content })
        this.files.set(`${agentId}/${name}`, content)
        return Promise.resolve()
      },
    },
  }
  sessions = {
    list: (agentId: string) => Promise.resolve([{ key: `agent:${agentId}:main`, agentId }]),
  }
  configPatches: Record<string, unknown>[] = []
  // Stateful config — mirrors the real Gateway: `config.get` returns a snapshot
  // wrapper (`{ path, config }`) and `config.patch` deep-merges `mcp.servers` into
  // the stored config, so the idempotency check can observe a prior registration.
  // (registerSharedMcpServers passes a partial `{ mcp: { servers } }` to this fake,
  // which stands in for the gateway-client helper — the `{ raw }` envelope is
  // exercised in the gateway-client's own client.test.ts.)
  configState: { mcp?: { servers?: Record<string, unknown> } } = {}
  config = {
    get: () => Promise.resolve({ path: this.configPath, config: this.configState }),
    patch: (updates: Record<string, unknown>) => {
      this.configPatches.push(updates)
      const u = updates as { mcp?: { servers?: Record<string, unknown> } }
      if (u.mcp) {
        this.configState.mcp = {
          ...(this.configState.mcp ?? {}),
          ...u.mcp,
          servers: { ...(this.configState.mcp?.servers ?? {}), ...(u.mcp.servers ?? {}) },
        }
      }
      return Promise.resolve()
    },
  }
}

function makeSource(fake: FakeGateway): OpenClawAgentSource {
  return new OpenClawAgentSource({
    getDbPath,
    loadSettings: () => ({ gatewayUrl: 'ws://test:18789', gatewayToken: 'tok' }),
    makeClient: () => fake,
    connectOptions: () => ({}),
  })
}

describe('OpenClawAgentSource', () => {
  let home: string
  let prevHome: string | undefined

  beforeEach(async () => {
    home = await mkdtemp(path.join(os.tmpdir(), 'clawboo-agentsource-'))
    await mkdir(path.join(home, '.clawboo'), { recursive: true })
    prevHome = process.env['HOME']
    process.env['HOME'] = home
    process.env['CLAWBOO_HOME'] = path.join(home, '.clawboo')
  })
  afterEach(async () => {
    if (prevHome === undefined) delete process.env['HOME']
    else process.env['HOME'] = prevHome
    delete process.env['CLAWBOO_HOME']
    await rm(home, { recursive: true, force: true }).catch(() => {})
  })

  it('start() connects + syncs the Gateway agent list into SQLite', async () => {
    const fake = new FakeGateway()
    fake.list = {
      defaultId: 'a1',
      mainKey: 'main',
      agents: [
        { id: 'a1', identity: { name: 'Boo Zero', emoji: '👻' } },
        { id: 'a2', name: 'Research Boo' },
      ],
    }
    const src = makeSource(fake)
    await src.start()

    const list = await src.listAgents()
    expect(list).toHaveLength(2)
    const bz = list.find((a) => a.id === 'a1')!
    expect(bz.displayName).toBe('Boo Zero')
    expect(bz.emoji).toBe('👻')
    expect(bz.isDefault).toBe(true)
    expect(bz.sessionKey).toBe('agent:a1:main')
    expect(list.find((a) => a.id === 'a2')!.displayName).toBe('Research Boo')
    await src.stop()
  })

  it('re-sync is idempotent AND preserves SQLite-native columns', async () => {
    const fake = new FakeGateway()
    fake.list = { defaultId: 'a1', mainKey: 'main', agents: [{ id: 'a1', name: 'Boo' }] }
    const src = makeSource(fake)
    await src.start()

    // Simulate clawboo-native edits (team assignment + personality) made by other
    // code paths AFTER the first sync.
    const db = createDb(getDbPath())
    const now = Date.now()
    db.insert(teams)
      .values({
        id: 'team-7',
        name: 'T7',
        icon: '🤖',
        color: '#000',
        createdAt: now,
        updatedAt: now,
      })
      .run()
    db.update(agents)
      .set({ teamId: 'team-7', personalityConfig: JSON.stringify({ humor: 80 }) })
      .where(eq(agents.id, 'a1'))
      .run()

    // A second sync with the same upstream state must NOT clobber the native cols.
    const result = await src.sync()
    expect(result.upserted).toBe(1)
    const after = await src.getAgent('a1')
    expect(after?.teamId).toBe('team-7')
    expect(after?.personalityConfig).toEqual({ humor: 80 })
    await src.stop()
  })

  it('archives agents that disappear upstream (reversible)', async () => {
    const fake = new FakeGateway()
    fake.list = {
      defaultId: 'a1',
      mainKey: 'main',
      agents: [
        { id: 'a1', name: 'Boo' },
        { id: 'a2', name: 'Gone Soon' },
      ],
    }
    const src = makeSource(fake)
    await src.start()
    expect(await src.listAgents()).toHaveLength(2)

    // a2 vanishes upstream → next sync archives it (excluded from the default list).
    fake.list = { defaultId: 'a1', mainKey: 'main', agents: [{ id: 'a1', name: 'Boo' }] }
    await src.sync()
    expect(await src.listAgents()).toHaveLength(1)
    expect(await src.listAgents({ includeArchived: true })).toHaveLength(2)

    // a2 reappears → revived (archivedAt cleared).
    fake.list = {
      defaultId: 'a1',
      mainKey: 'main',
      agents: [
        { id: 'a1', name: 'Boo' },
        { id: 'a2', name: 'Back Again' },
      ],
    }
    await src.sync()
    const revived = await src.getAgent('a2')
    expect(revived?.archivedAt).toBeNull()
    await src.stop()
  })

  it('readFile / writeFile delegate to the Gateway; listSessions maps', async () => {
    const fake = new FakeGateway()
    fake.list = { defaultId: 'a1', mainKey: 'main', agents: [{ id: 'a1', name: 'Boo' }] }
    const src = makeSource(fake)
    await src.start()

    await src.writeFile('a1', 'TOOLS.md', '# TOOLS\n- web_search\n')
    expect(fake.fileWrites).toContainEqual({
      agentId: 'a1',
      name: 'TOOLS.md',
      content: '# TOOLS\n- web_search\n',
    })
    expect(await src.readFile('a1', 'TOOLS.md')).toBe('# TOOLS\n- web_search\n')

    const sessions = await src.listSessions('a1')
    expect(sessions[0]?.sourceSessionId).toBe('agent:a1:main')
    await src.stop()
  })

  it('createAgent resolves the workspace + records the create chain + mirrors SQLite', async () => {
    const fake = new FakeGateway()
    const src = makeSource(fake)
    await src.start()

    // Seed the team the agent will join (agents.team_id has a real FK to teams).
    const now = Date.now()
    createDb(getDbPath())
      .insert(teams)
      .values({
        id: 'team-3',
        name: 'Design',
        icon: '🎨',
        color: '#fff',
        createdAt: now,
        updatedAt: now,
      })
      .run()

    const record = await src.createAgent({
      name: 'Designer',
      teamId: 'team-3',
      files: { 'SOUL.md': '# Designer\n', 'TOOLS.md': '# TOOLS\n' },
    })
    expect(fake.createdWith[0]?.workspace).toContain('workspace-designer')
    expect(record.id).toBe('new-Designer')
    expect(record.teamId).toBe('team-3')
    expect(fake.fileWrites.map((w) => w.name)).toEqual(['SOUL.md', 'TOOLS.md'])
    expect(await src.getAgent('new-Designer')).not.toBeNull()
    await src.stop()
  })

  it('reads work but writes throw gateway_disconnected when not connected', async () => {
    const fake = new FakeGateway()
    fake.list = { defaultId: 'a1', mainKey: 'main', agents: [{ id: 'a1', name: 'Boo' }] }
    const src = makeSource(fake)
    await src.start()
    await src.stop() // disconnect

    // Read still works from SQLite.
    expect(await src.listAgents()).toHaveLength(1)
    // Writes require a live connection.
    await expect(src.writeFile('a1', 'TOOLS.md', 'x')).rejects.toThrow('gateway_disconnected')
    await expect(src.createAgent({ name: 'X' })).rejects.toThrow('gateway_disconnected')
  })

  // ── register clawboo's shared MCP servers in the Gateway config ─────────────
  function makeSourceWithMcp(fake: FakeGateway, baseUrl: string | null): OpenClawAgentSource {
    return new OpenClawAgentSource({
      getDbPath,
      loadSettings: () => ({ gatewayUrl: 'ws://test:18789', gatewayToken: 'tok' }),
      makeClient: () => fake,
      connectOptions: () => ({}),
      mcpBaseUrl: () => baseUrl,
    })
  }

  /** Wait for the fire-and-forget registration (config.get → patch) to flush. */
  async function flush(): Promise<void> {
    for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0))
  }

  it('registers clawboo Memory + Tasks MCP servers in the Gateway config on connect', async () => {
    const fake = new FakeGateway()
    fake.list = { defaultId: 'a1', mainKey: 'main', agents: [{ id: 'a1', name: 'Boo' }] }
    const src = makeSourceWithMcp(fake, 'http://127.0.0.1:18790')
    await src.start()
    await flush()

    expect(fake.configPatches.length).toBeGreaterThan(0)
    // Confirmed shape (OpenClaw 2026.5.27 docs): TOP-LEVEL mcp.servers, each a
    // Streamable-HTTP entry { url, transport: 'streamable-http' }.
    const merged = fake.configPatches.at(-1) as {
      mcp?: { servers?: Record<string, { url: string; transport: string }> }
    }
    const servers = merged.mcp?.servers ?? {}
    expect(servers['clawboo-memory']?.url).toContain('/api/mcp/memory')
    expect(servers['clawboo-memory']?.transport).toBe('streamable-http')
    expect(servers['clawboo-tasks']?.url).toContain('/api/mcp/tasks')
    // TeamChat is DELIBERATELY NOT registered for OpenClaw (anti-spoof): a
    // process-wide URL can't carry a per-run author binding, so an unbound
    // team_chat_post tool would let an agent post as any author. OpenClaw's room
    // participation is server-mediated through the exchange (bound identity).
    expect(servers['clawboo-teamchat']).toBeUndefined()
    // Global scope (OpenClaw agents are cross-team): no per-run scope query.
    expect(servers['clawboo-memory']?.url).not.toContain('scopeTeamId')
    await src.stop()
  })

  it('is a no-op when no base URL is known (registration deferred, never throws)', async () => {
    const fake = new FakeGateway()
    fake.list = { defaultId: 'a1', mainKey: 'main', agents: [{ id: 'a1', name: 'Boo' }] }
    const src = makeSourceWithMcp(fake, null)
    await src.start()
    await flush()
    expect(fake.configPatches.length).toBe(0)
    await src.stop()
  })

  it('never throws when the Gateway rejects the config patch (best-effort)', async () => {
    const fake = new FakeGateway()
    fake.list = { defaultId: 'a1', mainKey: 'main', agents: [{ id: 'a1', name: 'Boo' }] }
    fake.config.patch = () => Promise.reject(new Error('gateway said no'))
    const src = makeSourceWithMcp(fake, 'http://127.0.0.1:18790')
    await expect(src.start()).resolves.toBeUndefined()
    await flush()
    // Source still serves reads despite the failed registration.
    expect(await src.listAgents()).toHaveLength(1)
    await src.stop()
  })

  it('is idempotent on reconnect: a second connected transition sends no new patch', async () => {
    const fake = new FakeGateway()
    fake.list = { defaultId: 'a1', mainKey: 'main', agents: [{ id: 'a1', name: 'Boo' }] }
    const src = makeSourceWithMcp(fake, 'http://127.0.0.1:18790')
    await src.start()
    await flush()
    expect(fake.configPatches.length).toBeGreaterThanOrEqual(1)

    // Simulate a reconnect: onStatus('connected') re-fires registration. Both
    // servers (memory + tasks) are already present (config.get reflects the prior
    // patch), so the idempotency check skips the patch — the Gateway rate-limits
    // writes to 3/60s.
    fake.configPatches.length = 0
    fake.emitStatus('connected')
    await flush()
    expect(fake.configPatches.length).toBe(0)
    await src.stop()
  })
})
