// A password the login fill put into an agent's page does not come back to the
// model through that agent's own browser tools. Against a real spawned MCP server
// routed per agent, the way the browser connectors are.

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import os from 'node:os'
import path from 'node:path'

import { createDb, toolOutputOf, type ClawbooDb } from '@clawboo/db'
import { REDACTION_MASK } from '@clawboo/logger'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { noteFilledValues, resetFilledValuesForTests } from '../../logins/filledValues'
import {
  connectConnector,
  connectorToolsForServer,
  resetConnectorsForTests,
  type ConnectableDefinition,
} from '../supervisor'

const FILLED = 'the-password-that-was-filled-42'

function serverSource(sdk: (s: string) => string): string {
  return `
const { Server } = require(${JSON.stringify(sdk('server/index.js'))})
const { StdioServerTransport } = require(${JSON.stringify(sdk('server/stdio.js'))})
const { ListToolsRequestSchema, CallToolRequestSchema } = require(${JSON.stringify(sdk('types.js'))})
const server = new Server({ name: 'fx', version: '1.0.0' }, { capabilities: { tools: {} } })
server.setRequestHandler(ListToolsRequestSchema, () => ({
  tools: [
    { name: 'read_field', description: 'read a field', inputSchema: { type: 'object' }, annotations: { readOnlyHint: true } },
    { name: 'fail_field', description: 'fail quoting a field', inputSchema: { type: 'object' }, annotations: { readOnlyHint: true } },
  ],
}))
server.setRequestHandler(CallToolRequestSchema, (req) => ({
  content: [{
    type: 'text',
    text: req.params.name === 'fail_field'
      ? JSON.stringify({ error: 'could not submit, the field holds ${FILLED}' })
      : 'the field holds ${FILLED}',
  }],
}))
server.connect(new StdioServerTransport())
`
}

describe('browser tool results after a login fill', () => {
  let dir: string
  let db: ClawbooDb
  let file: string
  let prevHome: string | undefined

  beforeAll(() => {
    dir = mkdtempSync(path.join(os.tmpdir(), 'clawboo-login-mask-'))
    prevHome = process.env['CLAWBOO_HOME']
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
    resetFilledValuesForTests()
    await resetConnectorsForTests()
    db.$client.close()
    if (prevHome === undefined) delete process.env['CLAWBOO_HOME']
    else process.env['CLAWBOO_HOME'] = prevHome
    rmSync(dir, { recursive: true, force: true })
  })

  it('masks the filled password for that agent, and only that agent', async () => {
    const def: ConnectableDefinition = {
      slug: 'fixture-browser',
      displayName: 'Fixture browser',
      provenance: 'curated',
      launch: {
        transport: 'stdio',
        command: process.execPath,
        args: [file],
        pinnedVersion: '1.0.0',
        perAgentProfileFlag: '--user-data-dir',
      },
      egressAllow: [],
      trifecta: { readsPrivateData: true, ingestsUntrustedContent: true, canEgress: true },
    } as ConnectableDefinition
    await connectConnector(db, def)
    const tool = connectorToolsForServer().find((t) => t.descriptor.name.endsWith('__read_field'))
    expect(tool).toBeDefined()

    noteFilledValues('filled-agent', [FILLED])
    const ctx = (agentId: string) => ({ agentId, availability: {} as never })
    const masked = toolOutputOf(await tool!.descriptor.executor({}, ctx('filled-agent'))).text
    expect(masked).not.toContain(FILLED)
    expect(masked).toContain(REDACTION_MASK)

    const other = toolOutputOf(await tool!.descriptor.executor({}, ctx('another-agent'))).text
    expect(other).toContain(FILLED)

    // A failed call's message reaches the model and the audit too: masked the same.
    const failing = connectorToolsForServer().find((t) =>
      t.descriptor.name.endsWith('__fail_field'),
    )
    const thrown = await Promise.resolve(
      failing!.descriptor.executor({}, ctx('filled-agent')),
    ).then(
      () => null,
      (err: unknown) => (err instanceof Error ? err.message : String(err)),
    )
    expect(thrown).toBeTruthy()
    expect(thrown).not.toContain(FILLED)
  })
})
