// Contract / SDK-compatibility test. Boots each MCP server over an in-memory
// transport and drives it with a real MCP Client — the CI-enforceable form of
// "heterogeneous consumability" (no subprocess, no network, no API keys). Proves
// the pinned @modelcontextprotocol/sdk speaks tools/list + tools/call against our
// servers, and that the shared SQLite substrate backs them all.

import {
  createDb,
  defaultAvailabilityContext,
  DEFAULT_MAX_CHILDREN,
  DEFAULT_MAX_DEPTH,
  listPendingApprovals,
  listTasks,
  resolveApproval,
  type ClawbooDb,
} from '@clawboo/db'
import { beforeEach, describe, expect, it } from 'vitest'

import { createMemoryServer } from '../memory/server'
import { createTasksServer } from '../tasks/server'
import { createToolsServer } from '../tools/server'
import { callText, connectInMemory, listToolNames } from '../testing'

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

let db: ClawbooDb
beforeEach(() => {
  db = createDb(':memory:')
})

describe('Tasks MCP', () => {
  it('lists tools (SDK round-trip), creates + claims a task, and conflicts on re-claim', async () => {
    const client = await connectInMemory(createTasksServer(db))
    const names = await listToolNames(client)
    expect(names).toContain('list_tasks')
    expect(names).toContain('claim_task')

    const created = await callText(client, 'create_task', {
      title: 'Cross-runtime task',
      teamId: 't1',
    })
    const task = JSON.parse(created.text) as { id: string }
    expect(task.id).toBeTruthy()

    const claim1 = await callText(client, 'claim_task', {
      taskId: task.id,
      assigneeAgentId: 'agent-1',
    })
    expect(claim1.isError).toBe(false)

    // A second claim must conflict — and the tool-error tells the model not to retry.
    const claim2 = await callText(client, 'claim_task', {
      taskId: task.id,
      assigneeAgentId: 'agent-2',
    })
    expect(claim2.isError).toBe(true)
    expect(claim2.text).toMatch(/conflict/)

    const list = await callText(client, 'list_tasks', { teamId: 't1' })
    expect((JSON.parse(list.text) as unknown[]).length).toBe(1)
  })

  it('returns a tool error when a dependency link would create a cycle', async () => {
    const client = await connectInMemory(createTasksServer(db))
    const first = JSON.parse((await callText(client, 'create_task', { title: 'First' })).text) as {
      id: string
    }
    const second = JSON.parse(
      (await callText(client, 'create_task', { title: 'Second' })).text,
    ) as { id: string }

    const linked = await callText(client, 'link_task', {
      taskId: second.id,
      dependsOnTaskId: first.id,
    })
    expect(linked.isError).toBe(false)

    const cycle = await callText(client, 'link_task', {
      taskId: first.id,
      dependsOnTaskId: second.id,
    })
    expect(cycle.isError).toBe(true)
    expect(cycle.text).toContain('dependency cycle')
  })
})

// The caps live at this protocol boundary, where an attached runtime creates rows
// unsupervised. The repository's own `createSubtask` stays UNCAPPED on purpose —
// the delegation spawn path and POST /api/board go through it — so these tests
// drive the caps the way an agent would: over MCP.
describe('Tasks MCP creation caps', () => {
  it(`caps children per parent — the ${DEFAULT_MAX_CHILDREN + 1}th subtask is a tool error`, async () => {
    const client = await connectInMemory(createTasksServer(db))
    const parent = JSON.parse(
      (await callText(client, 'create_task', { title: 'Parent' })).text,
    ) as {
      id: string
    }

    for (let i = 0; i < DEFAULT_MAX_CHILDREN; i += 1) {
      const ok = await callText(client, 'create_subtask', {
        parentTaskId: parent.id,
        title: `child ${i}`,
      })
      expect(ok.isError).toBe(false)
    }

    const capped = await callText(client, 'create_subtask', {
      parentTaskId: parent.id,
      title: 'one too many',
    })
    expect(capped.isError).toBe(true)
    expect(capped.text).toContain(`already has ${DEFAULT_MAX_CHILDREN} children`)

    // create_task with the same parent is refused identically (one shared path).
    const viaCreateTask = await callText(client, 'create_task', {
      title: 'one too many',
      parentTaskId: parent.id,
    })
    expect(viaCreateTask.isError).toBe(true)
    expect(viaCreateTask.text).toContain('already has')

    // The cap actually held: parent + exactly N children, nothing more.
    const all = JSON.parse((await callText(client, 'list_tasks', {})).text) as unknown[]
    expect(all).toHaveLength(DEFAULT_MAX_CHILDREN + 1)
  })

  it('refuses a subtask once the tree is at the maximum nesting depth', async () => {
    const client = await connectInMemory(createTasksServer(db))
    const mk = async (args: Record<string, unknown>, tool = 'create_subtask') => {
      const res = await callText(client, tool, args)
      expect(res.isError).toBe(false)
      return JSON.parse(res.text) as { id: string }
    }
    // DEFAULT_MAX_DEPTH levels of children are ACCEPTED — the same ceiling
    // team-chat delegation already produces, so nothing existing gets tighter.
    let parentId = (await mk({ title: 'depth 0' }, 'create_task')).id
    for (let d = 1; d <= DEFAULT_MAX_DEPTH; d += 1) {
      parentId = (await mk({ parentTaskId: parentId, title: `depth ${d}` })).id
    }

    const tooDeep = await callText(client, 'create_subtask', {
      parentTaskId: parentId,
      title: 'too deep',
    })
    expect(tooDeep.isError).toBe(true)
    expect(tooDeep.text).toContain('maximum nesting depth')
  })

  it('never caps a top-level create_task, however many roots exist', async () => {
    const client = await connectInMemory(createTasksServer(db))
    const roots = DEFAULT_MAX_CHILDREN + 5
    for (let i = 0; i < roots; i += 1) {
      const res = await callText(client, 'create_task', { title: `root-${i}` })
      expect(res.isError).toBe(false)
    }
    expect(listTasks(db)).toHaveLength(roots)
  })

  it('an unknown parent is a tool error, not a failed tool call', async () => {
    const client = await connectInMemory(createTasksServer(db))
    // Regression guard: this used to reach PRAGMA foreign_keys and escape the
    // handler as a JSON-RPC error, so `callTool` REJECTED instead of returning
    // a result with isError.
    const viaSubtask = await callText(client, 'create_subtask', {
      parentTaskId: 'nope',
      title: 'orphan',
    })
    expect(viaSubtask.isError).toBe(true)
    expect(viaSubtask.text).toBe('parent not found: nope')

    const viaCreate = await callText(client, 'create_task', {
      title: 'orphan',
      parentTaskId: 'nope',
    })
    expect(viaCreate.isError).toBe(true)
    expect(viaCreate.text).toBe('parent not found: nope')

    // An EMPTY parent id is caught by the schema, not silently made a root task.
    const empty = await callText(client, 'create_subtask', { parentTaskId: '', title: 'x' })
    expect(empty.isError).toBe(true)
    expect(empty.text).toContain('invalid args')

    expect(listTasks(db)).toHaveLength(0)
  })
})

describe('Memory MCP', () => {
  it('saves a fact and a second client retrieves it over the same DB', async () => {
    const writer = await connectInMemory(createMemoryServer(db))
    const saved = await callText(writer, 'memory_save', {
      title: 'Stripe',
      content: 'payment processing via Stripe checkout',
    })
    expect(saved.isError).toBe(false)

    const reader = await connectInMemory(createMemoryServer(db))
    const res = await callText(reader, 'memory_search', { query: 'payment', mode: 'fts' })
    const results = JSON.parse(res.text) as { content: string }[]
    expect(results.length).toBeGreaterThan(0)
    expect(results[0]?.content).toContain('payment')
  })
})

describe('Tools MCP', () => {
  it('hides an unavailable tool from tools/list and reveals it when satisfied', async () => {
    const hidden = await connectInMemory(
      createToolsServer(db, { availability: defaultAvailabilityContext({ env: {} }) }),
    )
    const hiddenNames = await listToolNames(hidden)
    expect(hiddenNames).toContain('echo')
    expect(hiddenNames).not.toContain('web_search')

    const revealed = await connectInMemory(
      createToolsServer(db, {
        availability: defaultAvailabilityContext({ env: { TAVILY_API_KEY: 'x' } }),
      }),
    )
    expect(await listToolNames(revealed)).toContain('web_search')
  })

  it('runs a safe tool through the broker', async () => {
    const client = await connectInMemory(
      createToolsServer(db, { availability: defaultAvailabilityContext({ env: {} }) }),
    )
    const res = await callText(client, 'echo', { message: 'hello-mcp' })
    expect(res.isError).toBe(false)
    expect(res.text).toBe('hello-mcp')
  })

  it('a destructive tool requires approval (resolved via the DB) before it runs', async () => {
    const client = await connectInMemory(
      createToolsServer(db, {
        availability: defaultAvailabilityContext({ env: {} }),
        broker: { approvalPollMs: 10, approvalTimeoutMs: 4000 },
      }),
    )
    const callPromise = callText(client, 'delete_path', { path: '/tmp/x' })
    let id: string | undefined
    for (let i = 0; i < 300 && !id; i++) {
      const pending = listPendingApprovals(db)
      if (pending.length > 0) id = pending[0]?.id
      else await sleep(10)
    }
    expect(id).toBeTruthy()
    resolveApproval(db, id!, 'allow_once')
    const res = await callPromise
    expect(res.isError).toBe(false)
    expect(res.text).toContain('would delete')
  })
})
