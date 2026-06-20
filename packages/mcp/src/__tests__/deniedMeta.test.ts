// A broker policy denial rides `_meta.denied` through the in-memory MCP transport
// so an in-process caller (the native harness) can detect it WITHOUT parsing the
// tool output prose. This proves the round-trip the native conversation relies on.

import { describe, expect, it } from 'vitest'
import { z } from 'zod'

import { connectInMemoryClient } from '../inMemoryClient'
import { buildServer, textResult } from '../shared'

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
})
