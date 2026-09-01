// A NATIVE run must see connector tools too. The tools server here is built
// in-memory rather than over HTTP, so it does not pick them up from the HTTP
// mount: without an explicit hand-off, connectors work for every attached
// runtime and silently do nothing for clawboo's own.

import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import os from 'node:os'
import path from 'node:path'

import { createDb, ensureOwnerGrant, type ClawbooDb } from '@clawboo/db'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import {
  connectConnector,
  disconnectConnector,
  resetConnectorsForTests,
  type ConnectableDefinition,
} from '../../../connectors/supervisor'
import { connectMcpBridge } from '../mcpBridge'

const FIXTURE = (sdk: (s: string) => string): string => `
const { Server } = require(${JSON.stringify(sdk('server/index.js'))})
const { StdioServerTransport } = require(${JSON.stringify(sdk('server/stdio.js'))})
const { ListToolsRequestSchema, CallToolRequestSchema } = require(${JSON.stringify(sdk('types.js'))})
const s = new Server({ name: 'fx', version: '1.0.0' }, { capabilities: { tools: {} } })
s.setRequestHandler(ListToolsRequestSchema, () => ({
  tools: [{ name: 'ping', description: 'p', inputSchema: { type: 'object' } }],
}))
s.setRequestHandler(CallToolRequestSchema, () => ({ content: [{ type: 'text', text: 'pong' }] }))
s.connect(new StdioServerTransport())
`

function definition(command: string, args: string[]): ConnectableDefinition {
  return {
    slug: 'memory',
    displayName: 'Fixture',
    provenance: 'curated',
    launch: { transport: 'stdio', command, args, pinnedVersion: '1.0.0' },
    egressAllow: [],
    trifecta: { readsPrivateData: false, ingestsUntrustedContent: false, canEgress: false },
  }
}

describe('native bridge serves connector tools', () => {
  let sandbox: string
  let db: ClawbooDb
  let prevClawbooHome: string | undefined

  beforeEach(async () => {
    sandbox = await mkdtemp(path.join(os.tmpdir(), 'clawboo-native-conn-'))
    // SANDBOX THE STATE DIR. Connecting writes the durable pid record through
    // `resolveClawbooDir`, so without this the suite writes into the developer's
    // real ~/.clawboo and its reap can drop the record of a connector they
    // actually have running.
    prevClawbooHome = process.env['CLAWBOO_HOME']
    process.env['CLAWBOO_HOME'] = sandbox
    db = createDb(path.join(sandbox, 'test.db'))
  })
  afterEach(async () => {
    await resetConnectorsForTests()
    if (prevClawbooHome === undefined) delete process.env['CLAWBOO_HOME']
    else process.env['CLAWBOO_HOME'] = prevClawbooHome
    // Windows will not unlink a file with an open handle.
    db.$client.close()
    await rm(sandbox, { recursive: true, force: true })
  })

  /**
   * Give ONE agent this connector.
   *
   * Connecting grants nobody, so a bridge test that wants to reach a connector
   * tool has to say who may. That is the product rule, and stating it here is
   * cheaper than every test wondering why a call was denied.
   */
  function grant(connectorId: string, agentId: string): void {
    ensureOwnerGrant(db, {
      subjectKind: 'agent',
      subjectId: agentId,
      capabilityKind: 'connector',
      connectorId,
      capabilityId: null,
    })
  }

  it('lists a connected connector’s tool, namespaced, alongside the builtins', async () => {
    const file = path.join(sandbox, 'server.cjs')
    const req = createRequire(path.join(process.cwd(), 'package.json'))
    await writeFile(
      file,
      FIXTURE((s) => req.resolve(`@modelcontextprotocol/sdk/${s}`)),
    )
    const { connector: listed } = await connectConnector(db, definition(process.execPath, [file]))
    // The list is grant-filtered now, so a tool this agent has not been given is
    // not merely refused on use, it is never offered.
    grant(listed.connectorId, 'a1')

    const bridge = await connectMcpBridge({
      db,
      agentId: 'a1',
      enable: { tasks: false, memory: false, tools: true },
    })
    expect(bridge).not.toBeNull()
    try {
      const names = (await bridge!.listTools()).map((t) => t.name)
      expect(names).toContain('mcp__memory__ping')
      // The builtins are still there: this is an addition, not a replacement.
      expect(names).toContain('echo')
    } finally {
      await bridge!.close()
    }
  }, 30_000)

  it('sees a connector connected AFTER the bridge was built', async () => {
    // The bridge re-lists rather than snapshotting, so a connector connected
    // after it was built is reachable without reconnecting.
    //
    // BOUNDARY WORTH KNOWING: `buildToolUniverse` in conversation.ts still calls
    // this once per RUN, so a connector connected mid-run is not visible to that
    // run. The next run picks it up. Closing that needs the turn loop to
    // re-derive its universe, which is a change to the run loop rather than to
    // the bridge.
    const bridge = await connectMcpBridge({
      db,
      agentId: 'a1',
      enable: { tasks: false, memory: false, tools: true },
    })
    try {
      expect((await bridge!.listTools()).map((t) => t.name)).not.toContain('mcp__memory__ping')

      const file = path.join(sandbox, 'late.cjs')
      const req = createRequire(path.join(process.cwd(), 'package.json'))
      await writeFile(
        file,
        FIXTURE((s) => req.resolve(`@modelcontextprotocol/sdk/${s}`)),
      )
      const late = await connectConnector(db, definition(process.execPath, [file]))

      // GRANTED TO NOBODY YET, so it is not offered at all. Connecting makes a
      // connector available; it does not give it to an agent, and a tool the
      // agent could never call must not spend its context.
      expect((await bridge!.listTools()).map((t) => t.name)).not.toContain('mcp__memory__ping')

      // Given to this agent, it appears without the session reconnecting, and
      // it is callable: the half a stale dispatcher would miss.
      grant(late.connector.connectorId, 'a1')
      expect((await bridge!.listTools()).map((t) => t.name)).toContain('mcp__memory__ping')
      expect((await bridge!.callTool('mcp__memory__ping', {})).output).toBe('pong')
    } finally {
      await bridge!.close()
    }
  }, 30_000)

  it('stops offering a connector tool after it is disconnected', async () => {
    const file = path.join(sandbox, 'server.cjs')
    const req = createRequire(path.join(process.cwd(), 'package.json'))
    await writeFile(
      file,
      FIXTURE((s) => req.resolve(`@modelcontextprotocol/sdk/${s}`)),
    )
    const { connector } = await connectConnector(db, definition(process.execPath, [file]))
    grant(connector.connectorId, 'a1')

    const bridge = await connectMcpBridge({
      db,
      agentId: 'a1',
      enable: { tasks: false, memory: false, tools: true },
    })
    try {
      expect((await bridge!.listTools()).map((t) => t.name)).toContain('mcp__memory__ping')
      await disconnectConnector(connector.connectorId)
      // A disconnected connector must stop being offered, or the model keeps
      // calling it until it gives up.
      expect((await bridge!.listTools()).map((t) => t.name)).not.toContain('mcp__memory__ping')
    } finally {
      await bridge!.close()
    }
  }, 30_000)

  it('routes a call to the connector and returns its output', async () => {
    const file = path.join(sandbox, 'server.cjs')
    const req = createRequire(path.join(process.cwd(), 'package.json'))
    await writeFile(
      file,
      FIXTURE((s) => req.resolve(`@modelcontextprotocol/sdk/${s}`)),
    )
    const { connector } = await connectConnector(db, definition(process.execPath, [file]))
    grant(connector.connectorId, 'a1')

    const bridge = await connectMcpBridge({
      db,
      agentId: 'a1',
      enable: { tasks: false, memory: false, tools: true },
    })
    try {
      const out = await bridge!.callTool('mcp__memory__ping', {})
      // Proves the whole chain: bridge -> broker -> grant gate -> connector.
      expect(out.isError).toBe(false)
      expect(out.output).toBe('pong')

      // AND THAT THE GRANT IS WHAT DID IT. A second agent, on the same live
      // connector, is refused: the grant names one agent and nobody else.
      const other = await connectMcpBridge({
        db,
        agentId: 'a2',
        enable: { tasks: false, memory: false, tools: true },
      })
      try {
        // Not listed, so not dispatchable: the refusal now happens before the
        // model ever spends a token reading the schema.
        expect((await other!.listTools()).map((t) => t.name)).not.toContain('mcp__memory__ping')
        expect((await other!.callTool('mcp__memory__ping', {})).output).toContain('unknown tool')
      } finally {
        await other!.close()
      }
    } finally {
      await bridge!.close()
    }
  }, 30_000)
})
