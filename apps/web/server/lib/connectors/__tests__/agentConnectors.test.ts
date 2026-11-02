// A live connector counts as one an agent may use only when it was shared with
// that agent, by the same rule the MCP tool list applies.

import { createDb, upsertGrant, type ClawbooDb, type ToolDescriptor } from '@clawboo/db'
import { beforeEach, describe, expect, it } from 'vitest'

import { connectorsForAgent } from '../agentConnectors'

const GITHUB = 'conn:native:clawboo-native:mcp:github'
const NOTION = 'conn:native:clawboo-native:mcp:notion'

function tool(name: string): ToolDescriptor {
  return {
    name,
    description: name,
    // apps/web carries no zod; the visibility check never reads the schema.
    inputSchema: {} as ToolDescriptor['inputSchema'],
    owner: 'mcp',
    readOnly: true,
    executor: () => 'ok',
  }
}

const live = [
  { connectorId: GITHUB, slug: 'github', descriptors: [tool('gh_read')] },
  { connectorId: NOTION, slug: 'notion', descriptors: [tool('notion_read')] },
]

let db: ClawbooDb
beforeEach(() => {
  db = createDb(':memory:')
})

describe('connectorsForAgent', () => {
  it('splits live connectors into the ones shared with this agent and the rest', () => {
    upsertGrant(db, {
      subjectKind: 'agent',
      subjectId: 'a1',
      capabilityKind: 'connector',
      connectorId: GITHUB,
      capabilityId: null,
      mode: 'read',
      approvalPolicy: 'never',
    })
    expect(connectorsForAgent(db, live, { agentId: 'a1' })).toEqual({
      connected: ['github'],
      unshared: ['notion'],
    })
    // Another agent was given nothing.
    expect(connectorsForAgent(db, live, { agentId: 'a2' })).toEqual({
      connected: [],
      unshared: ['github', 'notion'],
    })
  })

  it('counts a connector shared with the agent’s team', () => {
    upsertGrant(db, {
      subjectKind: 'team',
      subjectId: 't1',
      capabilityKind: 'connector',
      connectorId: NOTION,
      capabilityId: null,
      mode: 'read',
      approvalPolicy: 'never',
    })
    expect(connectorsForAgent(db, live, { agentId: 'a1', teamId: 't1' }).connected).toEqual([
      'notion',
    ])
    expect(connectorsForAgent(db, live, { agentId: 'a1' }).connected).toEqual([])
  })

  it('an unbound session sees only what is shared with every agent', () => {
    // OpenClaw's tools session carries no agent: a grant to one agent is not in it.
    upsertGrant(db, {
      subjectKind: 'agent',
      subjectId: 'a1',
      capabilityKind: 'connector',
      connectorId: GITHUB,
      capabilityId: null,
      mode: 'read',
      approvalPolicy: 'never',
    })
    upsertGrant(db, {
      subjectKind: 'global',
      subjectId: null,
      capabilityKind: 'connector',
      connectorId: NOTION,
      capabilityId: null,
      mode: 'read',
      approvalPolicy: 'never',
    })
    expect(connectorsForAgent(db, live, { agentId: null, teamId: null })).toEqual({
      connected: ['notion'],
      unshared: ['github'],
    })
  })
})
