// In-process MCP liveness supervisor. The core is `probeMcpServer`: an in-memory
// tools/list round-trip against a fresh server (the same Client + InMemoryTransport
// pattern the contract test uses) — a real liveness check of the MCP layer over the
// shared DB.

import { describe, expect, it } from 'vitest'

import { createDb } from '@clawboo/db'

import { probeMcpServer } from '../mcpSupervisor'

describe('MCP liveness supervisor', () => {
  it('probes each in-process MCP server with a tools/list round-trip', async () => {
    const db = createDb(':memory:')
    expect(await probeMcpServer(db, 'tasks')).toBeGreaterThan(0)
    expect(await probeMcpServer(db, 'memory')).toBeGreaterThan(0)
    expect(await probeMcpServer(db, 'tools')).toBeGreaterThan(0)
  })
})
