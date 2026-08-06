// A broker policy denial rides `_meta.denied` through the in-memory MCP transport
// so an in-process caller (the native harness) can detect it WITHOUT parsing the
// tool output prose. This proves the round-trip the native conversation relies on.

import { createDb, createTask } from '@clawboo/db'
import { describe, expect, it } from 'vitest'
import { z } from 'zod'

import { connectInMemoryClient } from '../inMemoryClient'
import { buildServer, textResult } from '../shared'
import { createTasksServer } from '../tasks/server'

describe('denied _meta round-trip (in-memory transport)', () => {
  it('a textResult denial surfaces as outcome.denied', async () => {
    const server = buildServer('denial-test', [
      {
        name: 'risky',
        description: 'a tool that denies',
        inputSchema: z.object({}),
        handler: () => textResult('denied: security:rm', true, 'security:rm'),
      },
    ])
    const client = await connectInMemoryClient(server)
    try {
      const outcome = await client.callTool('risky', {})
      expect(outcome.isError).toBe(true)
      expect(outcome.denied).toBe('security:rm')
    } finally {
      await client.close()
    }
  })

  it('a normal textResult carries no denied field', async () => {
    const server = buildServer('ok-test', [
      {
        name: 'safe',
        description: 'safe',
        inputSchema: z.object({}),
        handler: () => textResult('ok', false),
      },
    ])
    const client = await connectInMemoryClient(server)
    try {
      const outcome = await client.callTool('safe', {})
      expect(outcome.isError).toBe(false)
      expect(outcome.denied).toBeUndefined()
    } finally {
      await client.close()
    }
  })

  // A creation-cap refusal is a policy denial, so it must ride the SAME typed
  // channel — that is what lets the native harness raise `policy_denied` and trip
  // the breaker's repeat-policy-denied rule on an agent looping against the cap,
  // instead of the agent hammering a wall it cannot see.
  it('a Tasks MCP creation-cap refusal carries its typed reason on _meta.denied', async () => {
    const db = createDb(':memory:')
    const parent = createTask(db, { title: 'parent' })
    for (let i = 0; i < 2; i += 1) createTask(db, { title: `c${i}`, parentTaskId: parent.id })

    const client = await connectInMemoryClient(createTasksServer(db))
    try {
      // Depth is the cheapest cap to trip deterministically: a grandchild's child.
      const child = createTask(db, { title: 'child', parentTaskId: parent.id })
      const grand = createTask(db, { title: 'grand', parentTaskId: child.id })
      const tooDeep = await client.callTool('create_subtask', {
        parentTaskId: grand.id,
        title: 'too deep',
      })
      expect(tooDeep.isError).toBe(true)
      expect(tooDeep.denied).toBe('depth_cap')

      const orphan = await client.callTool('create_subtask', {
        parentTaskId: 'nope',
        title: 'orphan',
      })
      expect(orphan.isError).toBe(true)
      expect(orphan.denied).toBe('parent_not_found')
    } finally {
      await client.close()
    }
  })
})
