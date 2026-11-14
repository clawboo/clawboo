// The fill reaches an agent's browser on the grant every agent is given: a browser
// grant is Write, and the page-run tool the fill uses is destructive (Admin to call
// it as a tool). The fill never hands that tool to the agent, so the grant decides
// at grant level. Against a real spawned MCP server registered as the Playwright
// connector, with the grant minted the way agent creation mints it.

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import os from 'node:os'
import path from 'node:path'

import { agents, listGrants, revokeGrant, teams, upsertGrant } from '@clawboo/db'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { connectorInstanceIdForSlug } from '../../capabilitySource/connectorIdentity'
import { ensureBrowserGrantsForAgent } from '../../connectors/browserGrants'
import {
  connectConnector,
  connectorToolsForServer,
  resetConnectorsForTests,
  type ConnectableDefinition,
} from '../../connectors/supervisor'
import { getDb, getDbPath, resetDb } from '../../db'
import { agentBrowserFillAvailableFor, runInAgentPage } from '../browserLink'

const AGENT = 'coder'
const TEAM = 'T'
const TEAM_AGENT = 'helper'
const PLAYWRIGHT = connectorInstanceIdForSlug('playwright')

/** A browser server with the two tools the fill and the panel use. Its page-run
 *  tool answers the way Playwright MCP does, with a `### Result` section. */
function serverSource(sdk: (s: string) => string): string {
  return `
const { Server } = require(${JSON.stringify(sdk('server/index.js'))})
const { StdioServerTransport } = require(${JSON.stringify(sdk('server/stdio.js'))})
const { ListToolsRequestSchema, CallToolRequestSchema } = require(${JSON.stringify(sdk('types.js'))})
const server = new Server({ name: 'fx', version: '1.0.0' }, { capabilities: { tools: {} } })
server.setRequestHandler(ListToolsRequestSchema, () => ({
  tools: [
    { name: 'browser_snapshot', description: 'snapshot', inputSchema: { type: 'object' }, annotations: { readOnlyHint: true } },
    { name: 'browser_run_code_unsafe', description: 'run code', inputSchema: { type: 'object' }, annotations: { destructiveHint: true } },
  ],
}))
server.setRequestHandler(CallToolRequestSchema, (req) => ({
  content: [{
    type: 'text',
    text: req.params.name === 'browser_run_code_unsafe'
      ? '### Result\\n' + JSON.stringify({ frameUrl: 'https://bank.example/login', ran: true, value: { status: 'ok' } })
      : '- Page URL: https://bank.example/login',
  }],
}))
server.connect(new StdioServerTransport())
`
}

describe('the fill on a default browser grant', () => {
  let home: string
  const prev: Record<string, string | undefined> = {}

  beforeAll(async () => {
    home = mkdtempSync(path.join(os.tmpdir(), 'clawboo-login-grant-'))
    for (const name of ['HOME', 'CLAWBOO_HOME']) prev[name] = process.env[name]
    process.env['HOME'] = home
    process.env['CLAWBOO_HOME'] = home
    expect(getDbPath().startsWith(home)).toBe(true)
    const db = getDb()
    const now = Date.now()
    db.insert(teams)
      .values({ id: TEAM, name: 'Team', icon: 'x', color: 'x', createdAt: now, updatedAt: now })
      .run()
    for (const id of [AGENT, TEAM_AGENT]) {
      db.insert(agents)
        .values({ id, name: id, gatewayId: id, teamId: TEAM, createdAt: now, updatedAt: now })
        .run()
    }

    const file = path.join(home, 'server.cjs')
    const req = createRequire(path.join(process.cwd(), 'package.json'))
    writeFileSync(
      file,
      serverSource((s) => req.resolve(`@modelcontextprotocol/sdk/${s}`)),
    )
    const def = {
      slug: 'playwright',
      displayName: 'Playwright',
      provenance: 'curated',
      launch: {
        transport: 'stdio',
        command: process.execPath,
        args: [file],
        pinnedVersion: '1.0.0',
        perAgentProfileFlag: '--user-data-dir',
      },
      egressAllow: [],
      destructiveTools: ['browser_run_code_unsafe'],
      trifecta: { readsPrivateData: true, ingestsUntrustedContent: true, canEgress: true },
    } as ConnectableDefinition
    await connectConnector(db, def)
  })

  afterAll(async () => {
    await resetConnectorsForTests()
    resetDb()
    for (const [name, value] of Object.entries(prev)) {
      if (value === undefined) delete process.env[name]
      else process.env[name] = value
    }
    rmSync(home, { recursive: true, force: true })
  })

  /** Open the agent's own browser the way its first browser tool call does. */
  async function openBrowserFor(agentId: string): Promise<void> {
    const snapshot = connectorToolsForServer().find((t) =>
      t.descriptor.name.endsWith('__browser_snapshot'),
    )
    expect(snapshot).toBeDefined()
    await snapshot!.descriptor.executor({}, { agentId, availability: {} as never })
  }

  it('fills through the Write grant every agent gets', async () => {
    expect(ensureBrowserGrantsForAgent(getDb(), AGENT)).toBeGreaterThan(0)
    const grant = listGrants(getDb(), { subjectId: AGENT }).find(
      (g) => g.connectorId === PLAYWRIGHT,
    )
    expect(grant?.mode).toBe('write')
    await openBrowserFor(AGENT)

    expect(agentBrowserFillAvailableFor({ agentId: AGENT })).toBe(true)
    const out = await runInAgentPage(
      { agentId: AGENT },
      'function () { return 1 }',
      [],
      'https://bank.example',
    )
    expect(out).toEqual({
      kind: 'ran',
      frameUrl: 'https://bank.example/login',
      value: { status: 'ok' },
    })
  })

  it('reaches a browser the agent holds through its team', async () => {
    upsertGrant(getDb(), {
      subjectKind: 'team',
      subjectId: TEAM,
      capabilityKind: 'connector',
      connectorId: PLAYWRIGHT,
      capabilityId: null,
      mode: 'write',
      toolAllow: ['*'],
      toolDeny: [],
      approvalPolicy: 'risk',
      origin: 'operator',
    })
    await openBrowserFor(TEAM_AGENT)
    const owner = { agentId: TEAM_AGENT, teamId: TEAM }
    expect(agentBrowserFillAvailableFor(owner)).toBe(true)
    const out = await runInAgentPage(owner, 'function () { return 1 }', [], 'https://bank.example')
    expect(out.kind).toBe('ran')
  })

  it('says the browser was not given once the grant is revoked', async () => {
    const grant = listGrants(getDb(), { subjectId: AGENT }).find(
      (g) => g.connectorId === PLAYWRIGHT,
    )
    revokeGrant(getDb(), grant!.id, 'test')
    expect(agentBrowserFillAvailableFor({ agentId: AGENT })).toBe(false)
    const out = await runInAgentPage(
      { agentId: AGENT },
      'function () { return 1 }',
      [],
      'https://bank.example',
    )
    expect(out).toEqual({ kind: 'not_granted' })
  })
})
