// The connectors note names only what the agent's own tool list holds, and not
// every runtime builds that list under the agent's identity. An OpenClaw agent's
// tools session is unbound, so a connector shared with that agent alone is not in
// its list; a Clawboo Native agent with Tools off has no connector tools at all.
// Naming such a connector as "usable right now" sends the agent after a tool it
// cannot call, and the note's own rule then forbids the workaround.

import { DEFAULT_AGENT_CONFIG } from '@clawboo/adapter-native'
import {
  agents,
  createDb,
  teams,
  upsertGrant,
  type ClawbooDb,
  type ToolDescriptor,
} from '@clawboo/db'
import type { TurnFraming } from '@clawboo/team-orchestration'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { saveAgentConfig } from '../../runtimes/native/agentConfigStore'

const BROWSER = 'conn:native:clawboo-native:mcp:playwright'

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

vi.mock('../../connectors/supervisor', () => ({
  listLiveConnectors: () => [
    { connectorId: BROWSER, slug: 'playwright', descriptors: [tool('browser_navigate')] },
  ],
}))

const { buildServerTeamContext } = await import('../contextPreamble')

const USER_FACING: TurnFraming = { isLeader: true, isWorker: false, isUserFacing: true }
const NAMED = /Connected and usable right now/

let db: ClawbooDb
beforeEach(() => {
  db = createDb(':memory:')
  const now = Date.now()
  db.insert(teams)
    .values({ id: 't1', name: 'Team', icon: 'T', color: '#123456', createdAt: now, updatedAt: now })
    .run()
  for (const [id, runtime] of [
    ['oc', 'openclaw'],
    ['cc', 'claude-code'],
    ['nat', 'clawboo-native'],
  ] as const) {
    db.insert(agents)
      .values({
        id,
        name: id,
        gatewayId: id,
        runtime,
        teamId: 't1',
        createdAt: now,
        updatedAt: now,
      })
      .run()
    // What every agent gets at first start: the browser, shared with it alone.
    upsertGrant(db, {
      subjectKind: 'agent',
      subjectId: id,
      capabilityKind: 'connector',
      connectorId: BROWSER,
      capabilityId: null,
      mode: 'read',
      approvalPolicy: 'risk',
    })
  }
})

const noteFor = (agentId: string): string =>
  buildServerTeamContext(db, 't1', agentId, USER_FACING) ?? ''

describe('the connectors note, by runtime', () => {
  it('names a connector shared with a Claude Code agent', () => {
    expect(noteFor('cc')).toMatch(NAMED)
  })

  it('does not name one shared only with an OpenClaw agent, whose session is unbound', () => {
    const note = noteFor('oc')
    expect(note).not.toMatch(NAMED)
    expect(note).not.toContain('[playwright]')
  })

  it('names it for an OpenClaw agent once it is shared with every agent', () => {
    upsertGrant(db, {
      subjectKind: 'global',
      subjectId: null,
      capabilityKind: 'connector',
      connectorId: BROWSER,
      capabilityId: null,
      mode: 'read',
      approvalPolicy: 'risk',
    })
    expect(noteFor('oc')).toMatch(NAMED)
  })

  it('names nothing for a Clawboo Native agent with Tools off', () => {
    expect(noteFor('nat')).toMatch(NAMED)
    saveAgentConfig(db, {
      ...DEFAULT_AGENT_CONFIG,
      id: 'nat',
      tools: { ...DEFAULT_AGENT_CONFIG.tools, tools: false },
    })
    const note = noteFor('nat')
    expect(note).not.toMatch(NAMED)
    expect(note).not.toContain('[playwright]')
  })
})
