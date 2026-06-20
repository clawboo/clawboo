// Contract / SDK-compatibility test. Boots each MCP server over an in-memory
// transport and drives it with a real MCP Client — the CI-enforceable form of
// "heterogeneous consumability" (no subprocess, no network, no API keys). Proves
// the pinned @modelcontextprotocol/sdk speaks tools/list + tools/call against our
// servers, and that the shared SQLite substrate backs them all.

import {
  createDb,
  defaultAvailabilityContext,
  listPendingApprovals,
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
