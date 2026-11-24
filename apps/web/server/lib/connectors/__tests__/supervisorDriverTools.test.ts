// A desktop driver's browser, scripting, install and settings tools are never
// offered: connected to a REAL spawned MCP server that declares one display
// per agent (as Cua Driver does), they are missing from the tools and listed
// as held back, with why.

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import os from 'node:os'
import path from 'node:path'

import { createDb, type ClawbooDb } from '@clawboo/db'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import {
  connectConnector,
  resetConnectorsForTests,
  type ConnectableDefinition,
} from '../supervisor'

const TOOLS = [
  'click',
  'type_text',
  'get_window_state',
  'run_script',
  'run_steps',
  'page',
  'browser_navigate',
  'set_config',
  'install_ffmpeg',
  'check_for_update',
]

function serverSource(sdk: (s: string) => string): string {
  return `
const { Server } = require(${JSON.stringify(sdk('server/index.js'))})
const { StdioServerTransport } = require(${JSON.stringify(sdk('server/stdio.js'))})
const { ListToolsRequestSchema, CallToolRequestSchema } = require(${JSON.stringify(sdk('types.js'))})
const server = new Server({ name: 'fx', version: '1.0.0' }, { capabilities: { tools: {} } })
server.setRequestHandler(ListToolsRequestSchema, () => ({
  tools: ${JSON.stringify(TOOLS)}.map((name) => ({ name, description: name, inputSchema: { type: 'object', properties: {} } })),
}))
server.setRequestHandler(CallToolRequestSchema, () => ({ content: [{ type: 'text', text: 'ok' }] }))
server.connect(new StdioServerTransport())
`
}

describe("a desktop driver's refused tools", () => {
  let dir: string
  let db: ClawbooDb
  let file: string
  let prevClawbooHome: string | undefined

  beforeAll(() => {
    dir = mkdtempSync(path.join(os.tmpdir(), 'clawboo-drivertools-'))
    prevClawbooHome = process.env['CLAWBOO_HOME']
    process.env['CLAWBOO_HOME'] = dir
    db = createDb(path.join(dir, 'test.db'))
    file = path.join(dir, 'server.cjs')
    const req = createRequire(path.join(process.cwd(), 'package.json'))
    writeFileSync(
      file,
      serverSource((s) => req.resolve(`@modelcontextprotocol/sdk/${s}`)),
    )
  })

  afterAll(async () => {
    await resetConnectorsForTests()
    db.$client.close()
    if (prevClawbooHome === undefined) delete process.env['CLAWBOO_HOME']
    else process.env['CLAWBOO_HOME'] = prevClawbooHome
    rmSync(dir, { recursive: true, force: true })
  })

  const base = {
    displayName: 'Fixture Driver',
    provenance: 'curated' as const,
    egressAllow: ['*'],
    trifecta: { readsPrivateData: true, ingestsUntrustedContent: true, canEgress: true },
  }

  it('are not offered, and are listed as held back', async () => {
    const def: ConnectableDefinition = {
      ...base,
      slug: 'fixturedriver',
      launch: {
        transport: 'stdio',
        command: process.execPath,
        args: [file],
        pinnedVersion: '1.0.0',
        perAgentDisplay: true,
      },
    }
    const { connector } = await connectConnector(db, def)
    const offered = connector.descriptors.map((d) => d.name.split('__').pop())
    expect(offered.sort()).toEqual(['click', 'get_window_state', 'type_text'])
    expect(
      connector.skipped
        .filter((s) => s.reason === 'refused-on-agent-screens')
        .map((s) => s.name)
        .sort(),
    ).toEqual([
      'browser_navigate',
      'check_for_update',
      'install_ffmpeg',
      'page',
      'run_script',
      'run_steps',
      'set_config',
    ])
  }, 60_000)

  it('leave every other connector alone', async () => {
    const def: ConnectableDefinition = {
      ...base,
      slug: 'fixtureplain',
      launch: {
        transport: 'stdio',
        command: process.execPath,
        args: [file],
        pinnedVersion: '1.0.0',
      },
    }
    const { connector } = await connectConnector(db, def)
    expect(connector.descriptors).toHaveLength(TOOLS.length)
  }, 60_000)
})
