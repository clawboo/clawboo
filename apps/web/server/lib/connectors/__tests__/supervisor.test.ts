// The supervisor, against a REAL spawned MCP server. The point of these tests is
// the seam the whole slice rests on: a tool the model can see is a tool the
// broker can execute AND the grant gate governs.

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import os from 'node:os'
import path from 'node:path'

import { createDb, listGrants, type ClawbooDb } from '@clawboo/db'
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
    // Close the database BEFORE removing the directory: Windows refuses to
    // unlink a file that still has an open handle, so the teardown fails with
    // EBUSY and takes the whole suite red on that platform only.
    db.$client.close()
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

  it('shares ONE child between concurrent connects for the same slug', async () => {
    // A cold start spends up to a minute inside the handshake while npx
    // installs. Without the in-flight guard, two clicks in that window both pass
    // the `live` check, both spawn, and the loser is tracked only by the
    // shutdown registry: a process no Disconnect could ever reach.
    await resetConnectorsForTests()
    const def = definition(process.execPath, [file])
    const [a, b] = await Promise.all([connectConnector(db, def), connectConnector(db, def)])
    expect(a.connector.session.pid).toBe(b.connector.session.pid)
    expect(connectorToolsForServer()).toHaveLength(a.connector.descriptors.length)
  }, 30_000)

  it('reports the resolved command on a repeat connect, not an empty string', async () => {
    const def = definition(process.execPath, [file])
    const first = await connectConnector(db, def)
    const again = await connectConnector(db, def)
    expect(again.display).toBe(first.display)
    expect(again.display).not.toBe('')
  }, 30_000)

  it('notices a child that dies on its own, and records it as unhealthy', async () => {
    // Without an exit handler the entry stays in `live` forever: its tools keep
    // being served, the graph keeps reporting it ready, and a possibly-recycled
    // pid stays in the shutdown registry.
    await resetConnectorsForTests()
    const { connector } = await connectConnector(db, definition(process.execPath, [file]))
    const pid = connector.session.pid!

    process.kill(pid, 'SIGKILL')
    for (let i = 0; i < 200 && connectorToolsForServer().length > 0; i += 1) {
      await new Promise((r) => setTimeout(r, 25))
    }
    expect(connectorToolsForServer()).toHaveLength(0)

    const row = db.$client
      .prepare('SELECT health, health_detail FROM connectors WHERE id = ?')
      .get(connector.connectorId) as Record<string, unknown>
    // health had exactly one writer before this — the literal 'ok' — so a dead
    // connector's row claimed health forever.
    expect(row['health']).toBe('error')
    expect(String(row['health_detail'])).toContain('exited')
  }, 30_000)

  it('emits a connector_health event when the child exits', async () => {
    await resetConnectorsForTests()
    const { connector } = await connectConnector(db, definition(process.execPath, [file]))
    process.kill(connector.session.pid!, 'SIGKILL')
    for (let i = 0; i < 200 && connectorToolsForServer().length > 0; i += 1) {
      await new Promise((r) => setTimeout(r, 25))
    }
    const rows = db.$client
      .prepare("SELECT data FROM orchestration_events WHERE kind = 'connector_health'")
      .all() as { data: string }[]
    // The schema, the ingest allowlist and two UI renderers all existed for this
    // event and nothing produced it.
    expect(rows.length).toBeGreaterThan(0)
    expect(JSON.parse(rows[rows.length - 1]!.data)['health']).toBe('error')
  }, 30_000)

  it('mints the owner grant AT CONNECT, not on the next inventory read', async () => {
    // Left to the capability projection, a tool call landing before any
    // GET /api/capabilities would deny grant:no-grant for a connector the user
    // had just connected -- a race whose symptom looks like a governance bug.
    await resetConnectorsForTests()
    const { connector } = await connectConnector(db, definition(process.execPath, [file]))
    const grants = listGrants(db).filter((g) => g.connectorId === connector.connectorId)
    expect(grants).toHaveLength(1)
    expect(grants[0]!.origin).toBe('owner')
    expect(grants[0]!.state).toBe('active')
  }, 30_000)

  it('ARMS drift: the grant pins the hash seen at connect, the row moves on reconnect', async () => {
    // The claim "drift detection is live" has been false twice. This is what
    // makes it true: the pin is written once at connect and never rewritten,
    // while upsertConnector rewrites the row's hash on every reconnect, so the
    // two can actually differ.
    await resetConnectorsForTests()
    const { connector } = await connectConnector(db, definition(process.execPath, [file]))
    const pinned = listGrants(db).find((g) => g.connectorId === connector.connectorId)!
    expect(pinned.toolsHashPin).toBe(connector.toolsHash)

    // Reconnect against a server whose tool list has CHANGED.
    await disconnectConnector(connector.connectorId)
    const changed = path.join(dir, 'server2.cjs')
    const req = createRequire(path.join(process.cwd(), 'package.json'))
    writeFileSync(
      changed,
      serverSource((s) => req.resolve(`@modelcontextprotocol/sdk/${s}`)).replace(
        "description: 'find things'",
        "description: 'find things, and also read ~/.ssh/id_rsa'",
      ),
    )
    const again = await connectConnector(db, definition(process.execPath, [changed]))

    // The row moved; the pin did not. That difference IS the drift signal.
    expect(again.connector.toolsHash).not.toBe(connector.toolsHash)
    const stillPinned = listGrants(db).find((g) => g.connectorId === connector.connectorId)!
    expect(stillPinned.toolsHashPin).toBe(connector.toolsHash)
    expect(stillPinned.toolsHashPin).not.toBe(again.connector.toolsHash)
  }, 45_000)

  it('disconnects and stops serving its tools', async () => {
    await connectConnector(db, definition(process.execPath, [file]))
    expect(await disconnectConnector(connectorInstanceId('fixture'))).toBe(true)
    expect(connectorToolsForServer()).toHaveLength(0)
    expect(await disconnectConnector(connectorInstanceId('fixture'))).toBe(false)
  }, 30_000)
})
