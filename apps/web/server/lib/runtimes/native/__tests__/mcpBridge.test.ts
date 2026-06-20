// The in-process MCP bridge against REAL @clawboo/mcp servers + a real temp
// SQLite — proves the native runtime consumes the shared spine without HTTP
// or stdio: tools/list round-trips, a create_task call writes a real board
// row, toggles exclude servers, and close releases the transports.

import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { DeterministicEmbeddingProvider, SqliteMemoryStore, createDb, listTasks } from '@clawboo/db'

import { connectMcpBridge } from '../mcpBridge'

describe('native MCP bridge (in-process)', () => {
  let sandbox: string
  let dbPath: string

  beforeEach(async () => {
    sandbox = await mkdtemp(path.join(os.tmpdir(), 'clawboo-native-mcp-'))
    dbPath = path.join(sandbox, 'test.db')
    createDb(dbPath) // bootstrap the schema
  })
  afterEach(async () => {
    await rm(sandbox, { recursive: true, force: true })
  })

  it('returns null when every server toggle is off', async () => {
    const bridge = await connectMcpBridge({
      dbPath,
      enable: { tasks: false, memory: false, tools: false },
    })
    expect(bridge).toBeNull()
  })

  it('lists tools from the enabled servers (name-sorted) and routes calls', async () => {
    const bridge = await connectMcpBridge({
      dbPath,
      agentId: 'native-bridge-test',
      enable: { tasks: true, memory: true, tools: false },
    })
    expect(bridge).not.toBeNull()
    const tools = await bridge!.listTools()
    const names = tools.map((t) => t.name)
    expect(names).toContain('create_task')
    expect(names).toContain('memory_save')
    expect(names).toEqual([...names].sort())
    expect(bridge!.owns('create_task')).toBe(true)
    expect(bridge!.owns('write_file')).toBe(false)

    const result = await bridge!.callTool('create_task', {
      title: 'Bridge-created task',
      teamId: 'team-bridge',
    })
    expect(result.isError).toBe(false)

    const db = createDb(dbPath)
    const rows = listTasks(db, { teamId: 'team-bridge' })
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ title: 'Bridge-created task' })

    await bridge!.close()
  })

  it('an unknown tool call is a tool error, not a throw', async () => {
    const bridge = await connectMcpBridge({
      dbPath,
      enable: { tasks: true, memory: false, tools: false },
    })
    const out = await bridge!.callTool('nope', {})
    expect(out.isError).toBe(true)
    await bridge!.close()
  })

  it('a disabled server contributes no tools', async () => {
    const bridge = await connectMcpBridge({
      dbPath,
      enable: { tasks: true, memory: false, tools: false },
    })
    const names = (await bridge!.listTools()).map((t) => t.name)
    expect(names).toContain('create_task')
    expect(names).not.toContain('memory_save')
    await bridge!.close()
  })

  it('native memory writes carry vectors — the fact is vector-recallable (not FTS-only)', async () => {
    // With a real embedding provider threaded into the in-process Memory server, a
    // native-saved fact stores a vector and is recallable via VECTOR search — which
    // it could not be if the bridge constructed the store with a null provider.
    const bridge = await connectMcpBridge({
      dbPath,
      agentId: 'native-bridge-test',
      enable: { tasks: false, memory: true, tools: false },
      memoryScope: { teamId: 'team-bridge', agentId: 'native-bridge-test' },
      embed: new DeterministicEmbeddingProvider(),
    })
    await bridge!.callTool('memory_save', {
      title: 'Stripe',
      content: 'payments go through Stripe checkout',
    })
    await bridge!.close()

    const db = createDb(dbPath)
    const store = new SqliteMemoryStore(db, new DeterministicEmbeddingProvider())
    const results = await store.searchMemory('payments', {
      mode: 'vector',
      scope: { teamId: 'team-bridge' },
    })
    expect(results.length).toBeGreaterThan(0)
    expect(results[0]?.matchedVia).toBe('vector')
  })
})
