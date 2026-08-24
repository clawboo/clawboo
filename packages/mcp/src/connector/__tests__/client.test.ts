// End-to-end against a REAL spawned MCP server. The pure parts are unit-tested
// below, but the whole point of this module is the process boundary: spawn,
// handshake, page, call, and shut down without leaking a child.

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import os from 'node:os'
import path from 'node:path'

import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { connectorChildEnv } from '../env'
import { connectStdioConnector, flattenContent, type ConnectorSession } from '../client'

/**
 * A minimal stdio MCP server, written to disk and spawned for real.
 *
 * Requires the SDK by ABSOLUTE path: the fixture lives in a temp directory with
 * no node_modules of its own, so bare-specifier resolution would fail. Injecting
 * NODE_PATH instead would mean adding it to the connector env allowlist, and
 * that variable is a code-injection vector -- not a thing to open up for a test.
 */
function serverSource(sdk: (s: string) => string): string {
  return `
const { Server } = require(${JSON.stringify(sdk('server/index.js'))})
const { StdioServerTransport } = require(${JSON.stringify(sdk('server/stdio.js'))})
const { ListToolsRequestSchema, CallToolRequestSchema } = require(${JSON.stringify(sdk('types.js'))})

const server = new Server({ name: 'fixture', version: '1.0.0' }, { capabilities: { tools: {} } })

const SCHEMA = {
  type: 'object',
  properties: { mode: { type: 'string', enum: ['a', 'b'] } },
  required: ['mode'],
  additionalProperties: false,
}

server.setRequestHandler(ListToolsRequestSchema, (req) => {
  // Two pages, so the cursor loop is genuinely exercised.
  if (!req.params || !req.params.cursor) {
    return { tools: [{ name: 'first', description: 'page one', inputSchema: SCHEMA }], nextCursor: 'p2' }
  }
  return {
    tools: [
      { name: 'second', description: 'page two', inputSchema: SCHEMA, annotations: { readOnlyHint: true } },
      { name: 'shot', description: 'returns an image', inputSchema: SCHEMA },
      { name: 'boom', description: 'always errors', inputSchema: SCHEMA },
      { name: 'leak', description: 'echoes its env', inputSchema: SCHEMA },
    ],
  }
})

server.setRequestHandler(CallToolRequestSchema, (req) => {
  const n = req.params.name
  if (n === 'shot') return { content: [{ type: 'image', data: 'AAAA', mimeType: 'image/png' }] }
  if (n === 'boom') return { content: [{ type: 'text', text: 'it broke' }], isError: true }
  if (n === 'leak') {
    return { content: [{ type: 'text', text: JSON.stringify(Object.keys(process.env).sort()) }] }
  }
  if (n === 'first' || n === 'second') return { content: [{ type: 'text', text: 'ok:' + n }] }
  // A real server THROWS for an unknown tool, and callTool turns that into a
  // rejected promise rather than an isError result. That is the mapping the
  // client has to absorb.
  throw new Error('unknown tool: ' + n)
})

server.connect(new StdioServerTransport())
`
}

describe('flattenContent', () => {
  it('DESCRIBES a non-text block instead of dropping it', () => {
    // Mapping anything without a `text` field to '' made a screenshot tool look
    // like a success with no output, which the model then acts on.
    expect(flattenContent([{ type: 'image', mimeType: 'image/png', data: 'x' }])).toContain(
      '[image',
    )
    expect(flattenContent([{ type: 'audio', mimeType: 'audio/wav' }])).toContain('[audio')
    expect(flattenContent([{ type: 'resource_link', uri: 'file:///x' }])).toContain('file:///x')
    expect(flattenContent([{ type: 'nonsense' }])).toContain('[unsupported content')
  })

  it('reads an embedded resource’s text when it has one', () => {
    expect(
      flattenContent([{ type: 'resource', resource: { uri: 'file:///a', text: 'inner' } }]),
    ).toBe('inner')
  })

  it('joins mixed blocks and tolerates junk', () => {
    expect(flattenContent([{ type: 'text', text: 'a' }, null, { type: 'text', text: 'b' }])).toBe(
      'a\nb',
    )
    expect(flattenContent('not an array')).toBe('')
  })
})

describe('connectStdioConnector (real child process)', () => {
  let dir: string
  let session: ConnectorSession

  beforeAll(async () => {
    dir = mkdtempSync(path.join(os.tmpdir(), 'clawboo-connector-'))
    const file = path.join(dir, 'server.cjs')
    // Anchored on the package root rather than `import.meta.url`: this package's
    // tsconfig module setting rejects import.meta, and vitest runs with cwd at
    // the package root, so this resolves the same SDK the source imports.
    const req = createRequire(path.join(process.cwd(), 'package.json'))
    writeFileSync(
      file,
      serverSource((s) => req.resolve(`@modelcontextprotocol/sdk/${s}`)),
    )
    session = await connectStdioConnector({
      command: process.execPath,
      args: [file],
      // The real allowlist, with a secret in the ambient environment to prove
      // it does not travel.
      env: connectorChildEnv({
        source: { ...process.env, ANTHROPIC_API_KEY: 'sk-ant-must-not-travel' },
      }),
      handshakeTimeoutMs: 20_000,
    })
  }, 30_000)

  afterAll(async () => {
    await session?.close()
    rmSync(dir, { recursive: true, force: true })
  })

  it('completes the handshake and exposes the child pid', () => {
    // close() alone does not reap a process TREE, so a supervisor needs this.
    expect(typeof session.pid === 'number').toBe(true)
  })

  it('PAGES tools/list, rather than taking only the first page', async () => {
    // An incomplete inventory produces a wrong tools digest, which then reads as
    // drift on the very next comparison.
    const tools = await session.listTools()
    expect(tools.map((t) => t.name)).toEqual(['first', 'second', 'shot', 'boom', 'leak'])
  })

  it('carries the server’s own JSON Schema and annotations verbatim', async () => {
    const tools = await session.listTools()
    const second = tools.find((t) => t.name === 'second')
    expect(second?.inputSchema).toMatchObject({ required: ['mode'] })
    expect(second?.annotations).toEqual({ readOnlyHint: true })
  })

  it('calls a tool and returns its text', async () => {
    expect(await session.callTool('first', { mode: 'a' })).toEqual({
      text: 'ok:first',
      isError: false,
    })
  })

  it('surfaces a tool-reported error as isError, not a throw', async () => {
    const res = await session.callTool('boom', { mode: 'a' })
    expect(res.isError).toBe(true)
    expect(res.text).toBe('it broke')
  })

  it('describes an image result instead of returning empty text', async () => {
    const res = await session.callTool('shot', { mode: 'a' })
    expect(res.isError).toBe(false)
    expect(res.text).toContain('[image: image/png')
  })

  it('never throws for an unknown tool', async () => {
    // A hostile or confused server must not be able to produce an unhandled
    // rejection inside the broker.
    const res = await session.callTool('does-not-exist', {})
    expect(res.isError).toBe(true)
  })

  it('the CHILD does not receive the ambient provider key', async () => {
    // The end-to-end proof of the allowlist: this reads the real spawned
    // process's environment, not a unit-test stand-in.
    const res = await session.callTool('leak', { mode: 'a' })
    const keys = JSON.parse(res.text) as string[]
    expect(keys).not.toContain('ANTHROPIC_API_KEY')
    expect(keys).toContain('PATH')
  })
})
