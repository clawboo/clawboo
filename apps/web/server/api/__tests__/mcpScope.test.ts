// parseBoundScope: reads the run's authoritative memory scope from the
// Memory MCP attach URL's query params. The runtime's per-run attach URL carries
// these so the HTTP MCP session binds to the team/agent.

import type { IncomingMessage } from 'node:http'

import { describe, expect, it } from 'vitest'

import { parseBoundScope } from '../mcp'

const req = (url: string): IncomingMessage => ({ url }) as IncomingMessage

describe('parseBoundScope', () => {
  it('parses team + agent (+ tenant) from the URL query', () => {
    expect(parseBoundScope(req('/api/mcp/memory?scopeTeamId=team-A&scopeAgentId=agent-1'))).toEqual(
      {
        teamId: 'team-A',
        agentId: 'agent-1',
      },
    )
    expect(
      parseBoundScope(req('/api/mcp/memory?scopeTeamId=T&scopeAgentId=A&scopeTenantId=tenant-x')),
    ).toEqual({ teamId: 'T', agentId: 'A', tenantId: 'tenant-x' })
  })

  it('returns undefined when no scope params are present (unbound / legacy)', () => {
    expect(parseBoundScope(req('/api/mcp/memory'))).toBeUndefined()
    expect(parseBoundScope(req('/api/mcp/memory?foo=bar'))).toBeUndefined()
    expect(parseBoundScope(undefined)).toBeUndefined()
    expect(parseBoundScope(req(''))).toBeUndefined()
  })
})
