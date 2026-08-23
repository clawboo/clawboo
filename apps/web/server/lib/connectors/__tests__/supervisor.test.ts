// The supervisor, against a REAL spawned MCP server. The point of these tests is
// the seam the whole slice rests on: a tool the model can see is a tool the
// broker can execute AND the grant gate governs.

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import os from 'node:os'
import path from 'node:path'

import { createDb, type ClawbooDb } from '@clawboo/db'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import {
  connectConnector,
  connectorInstanceId,
  connectorToolsForServer,
  disconnectConnector,
  resetConnectorsForTests,
  type ConnectableDefinition,
} from '../supervisor'

function serverSource(sdk: (s: string) => string): string {
  return `
const { Server } = require(${JSON.stringify(sdk('server/index.js'))})
const { StdioServerTransport } = require(${JSON.stringify(sdk('server/stdio.js'))})
const { ListToolsRequestSchema, CallToolRequestSchema } = require(${JSON.stringify(sdk('types.js'))})
const server = new Server({ name: 'fx', version: '1.0.0' }, { capabilities: { tools: {} } })
const SCHEMA = { type: 'object', properties: { q: { type: 'string' } } }
server.setRequestHandler(ListToolsRequestSchema, () => ({
  tools: [
    { name: 'search', description: 'find things', inputSchema: SCHEMA, annotations: { readOnlyHint: true } },
    { name: 'wipe', description: 'destroys things', inputSchema: SCHEMA, annotations: { destructiveHint: true } },
    // Unrepresentable: a dot cannot survive tool-name normalisation.
    { name: 'bad.name', description: 'skipped', inputSchema: SCHEMA },
  ],
}))
server.setRequestHandler(CallToolRequestSchema, (req) => ({
  content: [{ type: 'text', text: 'called:' + req.params.name }],
}))
server.connect(new StdioServerTransport())
`
}

function definition(command: string, args: string[]): ConnectableDefinition {
  return {
    slug: 'fixture',
    displayName: 'Fixture',
    provenance: 'curated',
    launch: { transport: 'stdio', command, args, pinnedVersion: '1.0.0' },
    egressAllow: ['example.com'],
    trifecta: { readsPrivateData: true, ingestsUntrustedContent: false, canEgress: true },
  }
}

describe('connector supervisor', () => {
  let dir: string
  let db: ClawbooDb
  let file: string

  beforeAll(() => {
    dir = mkdtempSync(path.join(os.tmpdir(), 'clawboo-supervisor-'))
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
    rmSync(dir, { recursive: true, force: true })
  })

  it('connects, namespaces the tools, and skips what it cannot represent', async () => {
    const { connector } = await connectConnector(db, definition(process.execPath, [file]))
    expect(connector.descriptors.map((d) => d.name)).toEqual([
      'mcp__fixture__search',
      'mcp__fixture__wipe',
    ])
    // One unusable tool is dropped WITH a reason, not silently, and not at the
    // cost of the whole connector.
    expect(connector.skipped).toEqual([{ name: 'bad.name', reason: 'unrepresentable-name' }])
  }, 30_000)

  it('believes a CURATED server’s annotations, and carries the catalog’s risk', async () => {
    const { connector } = await connectConnector(db, definition(process.execPath, [file]))
    const search = connector.descriptors.find((d) => d.name === 'mcp__fixture__search')
    const wipe = connector.descriptors.find((d) => d.name === 'mcp__fixture__wipe')
    expect(search?.readOnly).toBe(true)
    expect(wipe?.destructive).toBe(true)
    // Risk comes from what the CATALOG says the connector can do. A server
    // describing its own exfiltration risk is not evidence.
    expect(search?.risk).toBe('external')
    expect(search?.trifecta).toEqual(definition('x', []).trifecta)
  }, 30_000)

  it('advertises the server’s own JSON Schema rather than a re-derived one', async () => {
    const { connector } = await connectConnector(db, definition(process.execPath, [file]))
    const search = connector.descriptors.find((d) => d.name === 'mcp__fixture__search')
    expect(search?.jsonSchema).toMatchObject({ properties: { q: { type: 'string' } } })
  }, 30_000)

  it('pairs every descriptor with its connector id, so the gate can find a grant', async () => {
    // The invariant the slice rests on: a descriptor reaching the registry
    // WITHOUT a connectorId would execute ungoverned.
    await connectConnector(db, definition(process.execPath, [file]))
    const paired = connectorToolsForServer()
    expect(paired.length).toBeGreaterThan(0)
    for (const p of paired) {
      expect(p.connectorId).toBe(connectorInstanceId('fixture'))
    }
  }, 30_000)

  it('writes a connectors row with both digests, arming drift detection', async () => {
    const { connector } = await connectConnector(db, definition(process.execPath, [file]))
    const row = db.$client
      .prepare('SELECT id, slug, health, spec_hash, tools_hash FROM connectors WHERE id = ?')
      .get(connector.connectorId) as Record<string, unknown>
    expect(row['slug']).toBe('fixture')
    expect(row['health']).toBe('ok')
    expect(String(row['spec_hash'])).toHaveLength(64)
    expect(String(row['tools_hash'])).toHaveLength(64)
  }, 30_000)

  it('executes a call through the live session', async () => {
    const { connector } = await connectConnector(db, definition(process.execPath, [file]))
    const search = connector.descriptors.find((d) => d.name === 'mcp__fixture__search')
    const out = await search!.executor({ q: 'x' }, {} as never)
    // The REMOTE name is what goes over the wire, not the namespaced one.
    expect(out).toBe('called:search')
  }, 30_000)

  it('disconnects and stops serving its tools', async () => {
    await connectConnector(db, definition(process.execPath, [file]))
    expect(await disconnectConnector(connectorInstanceId('fixture'))).toBe(true)
    expect(connectorToolsForServer()).toHaveLength(0)
    expect(await disconnectConnector(connectorInstanceId('fixture'))).toBe(false)
  }, 30_000)
})
