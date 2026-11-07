// The in-process MCP bridge against REAL @clawboo/mcp servers + a real temp
// SQLite — proves the native runtime consumes the shared spine without HTTP
// or stdio: tools/list round-trips, a create_task call writes a real board
// row, toggles exclude servers, and close releases the transports.

import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import {
  DeterministicEmbeddingProvider,
  SqliteMemoryStore,
  createDb,
  createTask,
  getComments,
  listEvents,
  listTasks,
  type ClawbooDb,
} from '@clawboo/db'

import { getDbPath } from '../../../db'
import { connectMcpBridge } from '../mcpBridge'

describe('native MCP bridge (in-process)', () => {
  let sandbox: string
  let dbPath: string
  let db: ClawbooDb
  const prev: Record<string, string | undefined> = {}

  beforeEach(async () => {
    sandbox = await mkdtemp(path.join(os.tmpdir(), 'clawboo-native-mcp-'))
    dbPath = path.join(sandbox, 'test.db')
    db = createDb(dbPath) // bootstrap the schema
    // Anything that reaches the shared server state lands in the sandbox, never
    // in the developer's own ~/.clawboo.
    for (const name of ['HOME', 'CLAWBOO_HOME']) {
      prev[name] = process.env[name]
      process.env[name] = sandbox
    }
    expect(getDbPath().startsWith(sandbox)).toBe(true)
  })
  afterEach(async () => {
    for (const name of ['HOME', 'CLAWBOO_HOME']) {
      if (prev[name] === undefined) delete process.env[name]
      else process.env[name] = prev[name]
    }
    db.$client.close()
    await rm(sandbox, { recursive: true, force: true })
  })

  it('returns null when every server toggle is off', async () => {
    const bridge = await connectMcpBridge({
      db,
      enable: { tasks: false, memory: false, tools: false },
    })
    expect(bridge).toBeNull()
  })

  it('lists tools from the enabled servers (name-sorted) and routes calls', async () => {
    const bridge = await connectMcpBridge({
      db,
      agentId: 'native-bridge-test',
      enable: { tasks: true, memory: true, tools: false },
      embed: null,
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

    const rows = listTasks(db, { teamId: 'team-bridge' })
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ title: 'Bridge-created task' })

    await bridge!.close()
  })

  it('on a team run, full Tasks access still leaves out the writes the team engine owns', async () => {
    // A Clawboo Native agent whose Tasks access is set to full got claim_task and
    // update_task_status on team runs too, where the engine claims each task and
    // moves the card itself.
    const bridge = await connectMcpBridge({
      db,
      agentId: 'native-team-agent',
      enable: { tasks: true, memory: false, tools: false },
      memoryScope: { teamId: 'team-bridge', agentId: 'native-team-agent' },
      teamRun: true,
    })
    const names = (await bridge!.listTools()).map((t) => t.name)
    expect(names).toContain('block_task')
    expect(names).toContain('create_task')
    for (const withheld of [
      'claim_task',
      'assign_task',
      'release_task',
      'update_task_status',
      'unblock_task',
    ])
      expect(names).not.toContain(withheld)
    await bridge!.close()
  })

  it('on a task run, get_task reads the run’s own task when taskId is left out', async () => {
    // The in-process analog of the signed `scopeTaskId` on an HTTP runtime's
    // Tasks URL, with the default read-only access every Native agent has.
    const task = createTask(db, { title: 'Native own task', teamId: 'team-bridge' })
    const bridge = await connectMcpBridge({
      db,
      agentId: 'native-team-agent',
      enable: { tasks: 'read', memory: false, tools: false },
      memoryScope: { teamId: 'team-bridge', agentId: 'native-team-agent' },
      teamRun: true,
      boundTaskId: task.id,
    })
    const out = await bridge!.callTool('get_task', {})
    expect(out.isError).toBe(false)
    expect(out.output).toContain('Native own task')
    await bridge!.close()
  })

  it('a Tasks write records the agent and the run, as a signed Tasks URL does', async () => {
    const task = createTask(db, { title: 'Native write', teamId: 'team-bridge' })
    const bridge = await connectMcpBridge({
      db,
      agentId: 'native-team-agent',
      enable: { tasks: true, memory: false, tools: false },
      memoryScope: { teamId: 'team-bridge', agentId: 'native-team-agent' },
      boundTaskId: task.id,
      boundExecutionId: 'exec-1',
    })
    await bridge!.callTool('add_comment', { body: 'noted' })
    expect(getComments(db, task.id)[0]).toMatchObject({
      authorAgentId: 'native-team-agent',
      executionId: 'exec-1',
    })
    const [event] = listEvents(db, { kinds: ['comment_added'] }).filter((e) => e.taskId === task.id)
    expect((JSON.parse(event!.data) as Record<string, unknown>)['actor']).toEqual({
      kind: 'agent',
      agentId: 'native-team-agent',
      execId: 'exec-1',
    })
    await bridge!.close()
  })

  it('an unknown tool call is a tool error, not a throw', async () => {
    const bridge = await connectMcpBridge({
      db,
      enable: { tasks: true, memory: false, tools: false },
    })
    const out = await bridge!.callTool('nope', {})
    expect(out.isError).toBe(true)
    await bridge!.close()
  })

  it('a disabled server contributes no tools', async () => {
    const bridge = await connectMcpBridge({
      db,
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
      db,
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

    const store = new SqliteMemoryStore(db, new DeterministicEmbeddingProvider())
    const results = await store.searchMemory('payments', {
      mode: 'vector',
      scope: { teamId: 'team-bridge' },
    })
    expect(results.length).toBeGreaterThan(0)
    expect(results[0]?.matchedVia).toBe('vector')
  })
})
