// Agents' browsers are launched with the Clawboo dashboard blocked.
//
// The dashboard has no access check on loopback, so a browser an agent drives
// could open it and approve its own requests. Both browser connectors are
// started with the dashboard's loopback origins blocked, on the port this server
// really listens on. The spawn tests use a real child process that records the
// arguments it was started with: the block has to reach the process, not just
// a helper's return value.

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import os from 'node:os'
import path from 'node:path'

import { CONNECTOR_DEFINITIONS } from '@clawboo/connector-catalog'
import { createDb, type ClawbooDb } from '@clawboo/db'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { agentBrowserSession, closeAllAgentBrowsers } from '../agentBrowsers'
import { blockDashboardArgs, dashboardLoopbackOrigins, setDashboardPort } from '../dashboardGuard'
import { connectConnector, disconnectConnector, resetConnectorsForTests } from '../supervisor'

describe('blockDashboardArgs', () => {
  it('blocks every loopback spelling of the dashboard port, and only that port', () => {
    expect(dashboardLoopbackOrigins(18790)).toEqual([
      'http://127.0.0.1:18790',
      'http://localhost:18790',
      'http://localhost.:18790',
      'http://[::1]:18790',
      'http://0.0.0.0:18790',
    ])
  })

  it("takes Playwright's semicolon list", () => {
    expect(blockDashboardArgs({ flag: '--blocked-origins', style: 'origins' }, 18790)).toEqual([
      '--blocked-origins',
      'http://127.0.0.1:18790;http://localhost:18790;http://localhost.:18790;http://[::1]:18790;http://0.0.0.0:18790',
    ])
  })

  it("takes Chrome DevTools' URL patterns, with the IPv6 host escaped", () => {
    // An unescaped `[::1]` is an invalid URLPattern; chrome-devtools-mcp 1.7.0
    // would throw on it at every navigation.
    expect(
      blockDashboardArgs({ flag: '--blockedUrlPattern', style: 'urlPatterns' }, 18790),
    ).toEqual([
      '--blockedUrlPattern',
      'http://127.0.0.1:18790/*',
      '--blockedUrlPattern',
      'http://localhost:18790/*',
      '--blockedUrlPattern',
      'http://localhost.:18790/*',
      '--blockedUrlPattern',
      'http://\\[\\:\\:1\\]:18790/*',
      '--blockedUrlPattern',
      'http://0.0.0.0:18790/*',
    ])
  })

  it('adds nothing for a connector that declares no way to block, or before the port is known', () => {
    expect(blockDashboardArgs(undefined, 18790)).toEqual([])
    expect(blockDashboardArgs({ flag: '--blocked-origins', style: 'origins' }, null)).toEqual([])
  })

  it('is declared by both browser connectors in the catalog', () => {
    for (const slug of ['playwright', 'chrome-devtools']) {
      const def = CONNECTOR_DEFINITIONS.find((d) => d.slug === slug)!
      expect(def.launch.transport === 'stdio' && def.launch.blockOriginsArg, slug).toBeTruthy()
    }
  })
})

describe('the block reaches the launched browser server', () => {
  let dir: string
  let db: ClawbooDb
  let server: string
  let prevHome: string | undefined

  beforeAll(() => {
    dir = mkdtempSync(path.join(os.tmpdir(), 'clawboo-dashboard-guard-'))
    prevHome = process.env['CLAWBOO_HOME']
    process.env['CLAWBOO_HOME'] = dir
    db = createDb(path.join(dir, 'test.db'))
    server = path.join(dir, 'server.cjs')
    const req = createRequire(path.join(process.cwd(), 'package.json'))
    const sdk = (s: string) => JSON.stringify(req.resolve(`@modelcontextprotocol/sdk/${s}`))
    // A minimal MCP server that writes the arguments it was started with.
    writeFileSync(
      server,
      `
require('node:fs').writeFileSync(process.argv[2], JSON.stringify(process.argv.slice(3)))
const { Server } = require(${sdk('server/index.js')})
const { StdioServerTransport } = require(${sdk('server/stdio.js')})
const { ListToolsRequestSchema } = require(${sdk('types.js')})
const s = new Server({ name: 'fx', version: '1.0.0' }, { capabilities: { tools: {} } })
s.setRequestHandler(ListToolsRequestSchema, () => ({ tools: [] }))
s.connect(new StdioServerTransport())
`,
    )
    setDashboardPort(18790)
  })

  afterAll(async () => {
    await closeAllAgentBrowsers()
    await resetConnectorsForTests()
    db.$client.close()
    if (prevHome === undefined) delete process.env['CLAWBOO_HOME']
    else process.env['CLAWBOO_HOME'] = prevHome
    rmSync(dir, { recursive: true, force: true })
  })

  const argvOf = (file: string): string[] => JSON.parse(readFileSync(file, 'utf8')) as string[]

  it("on an agent's own browser", async () => {
    const out = path.join(dir, 'agent-argv.json')
    await agentBrowserSession(
      {
        slug: 'fixturebrowser',
        command: process.execPath,
        args: [server, out],
        profileFlag: '--user-data-dir',
        blockOriginsArg: { flag: '--blocked-origins', style: 'origins' },
      },
      'conn:connector:clawboo:mcp:fixturebrowser',
      'agent-1',
      { create: true },
    )
    const argv = argvOf(out)
    const at = argv.indexOf('--blocked-origins')
    expect(at).toBeGreaterThan(-1)
    expect(argv[at + 1]).toContain('http://127.0.0.1:18790')
    expect(argv).toContain('--user-data-dir')
  }, 30_000)

  it('on the shared session a connect starts', async () => {
    const out = path.join(dir, 'shared-argv.json')
    const { connector } = await connectConnector(db, {
      slug: 'fixtureshared',
      displayName: 'Fixture Shared',
      provenance: 'curated',
      launch: {
        transport: 'stdio',
        command: process.execPath,
        args: [server, out],
        pinnedVersion: '1.0.0',
        blockOriginsArg: { flag: '--blockedUrlPattern', style: 'urlPatterns' },
      },
      egressAllow: ['*'],
      trifecta: { readsPrivateData: false, ingestsUntrustedContent: true, canEgress: true },
    })
    try {
      const argv = argvOf(out)
      expect(argv).toContain('--blockedUrlPattern')
      expect(argv).toContain('http://localhost:18790/*')
    } finally {
      await disconnectConnector(connector.connectorId)
    }
  }, 30_000)
})
