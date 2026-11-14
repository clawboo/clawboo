// While a person has taken over an agent's screen, that agent's own browser
// tools are refused with the reason, and every other agent's keep working.
//
// Against a REAL spawned MCP server routed per agent (it declares a profile
// flag, as the browser connectors do), so the refusal is proved on the same
// executor the broker calls.

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import os from 'node:os'
import path from 'node:path'

import { createDb, type ClawbooDb } from '@clawboo/db'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { personInControlMessage, releaseControl, takeControl } from '../../desktop/control'
import {
  connectConnector,
  resetConnectorsForTests,
  type ConnectableDefinition,
} from '../supervisor'

function serverSource(sdk: (s: string) => string): string {
  return `
const { Server } = require(${JSON.stringify(sdk('server/index.js'))})
const { StdioServerTransport } = require(${JSON.stringify(sdk('server/stdio.js'))})
const { ListToolsRequestSchema, CallToolRequestSchema } = require(${JSON.stringify(sdk('types.js'))})
const server = new Server({ name: 'fx', version: '1.0.0' }, { capabilities: { tools: {} } })
server.setRequestHandler(ListToolsRequestSchema, () => ({
  tools: [{ name: 'browser_click', description: 'click', inputSchema: { type: 'object', properties: {} } }],
}))
server.setRequestHandler(CallToolRequestSchema, (req) => ({
  content: [{ type: 'text', text: 'clicked' }],
}))
server.connect(new StdioServerTransport())
`
}

describe('take over and an agent’s own browser tools', () => {
  let dir: string
  let db: ClawbooDb
  let file: string
  let prevClawbooHome: string | undefined

  beforeAll(() => {
    dir = mkdtempSync(path.join(os.tmpdir(), 'clawboo-takeover-'))
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

  it('refuses the agent whose screen a person holds, and only while they hold it', async () => {
    const def: ConnectableDefinition = {
      slug: 'fixturebrowser',
      displayName: 'Fixture Browser',
      provenance: 'curated',
      launch: {
        transport: 'stdio',
        command: process.execPath,
        args: [file],
        pinnedVersion: '1.0.0',
        perAgentProfileFlag: '--user-data-dir',
      },
      egressAllow: ['*'],
      trifecta: { readsPrivateData: false, ingestsUntrustedContent: true, canEgress: true },
    }
    const { connector } = await connectConnector(db, def)
    const click = connector.descriptors.find((d) => d.name.endsWith('browser_click'))!

    expect(await click.executor({}, { agentId: 'a1' } as never)).toBe('clicked')

    takeControl('a1', 'viewer-1', { kind: 'dashboard' })
    await expect(click.executor({}, { agentId: 'a1' } as never)).rejects.toThrow(
      personInControlMessage(),
    )
    // Another agent's browser is not held.
    expect(await click.executor({}, { agentId: 'a2' } as never)).toBe('clicked')

    releaseControl('a1', 'viewer-1')
    expect(await click.executor({}, { agentId: 'a1' } as never)).toBe('clicked')

    // A call that started before the take over, while its browser was still
    // starting, is refused once the browser is ready rather than clicking into
    // the window the person now uses.
    const early = click.executor({}, { agentId: 'a3' } as never)
    takeControl('a3', 'viewer-3', { kind: 'dashboard' })
    await expect(early).rejects.toThrow(personInControlMessage())
    releaseControl('a3', 'viewer-3')
  }, 60_000)
})
