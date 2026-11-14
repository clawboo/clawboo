// A desktop driver acts for one agent, on that agent's own screen, and nowhere
// else: no agent named, refused; no display of the agent's own, refused (never
// run against whatever screen the server can see); with one, it runs with that
// display and nothing else, in a home of its own. Its one shared child, which
// only lists the tools, gets no display, no reachable bus and a home of its
// own. Arguments that would write a file are refused before any call. Against
// a REAL spawned MCP server that reports what it was given; the display
// manager is faked.

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import os from 'node:os'
import path from 'node:path'

import { createDb, type ClawbooDb } from '@clawboo/db'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

const displays = vi.hoisted(() => ({
  byAgent: new Map<string, { env: Record<string, string> }>(),
}))
vi.mock('../../desktop/displays', () => ({
  acquireDisplay: async (agentId: string) => displays.byAgent.get(agentId) ?? null,
  releaseDisplay: () => {},
  displayFor: (agentId: string) => displays.byAgent.get(agentId) ?? null,
  displayProblem: () => null,
  onDisplayChange: () => () => {},
  NO_SESSION_BUS: 'unix:path=/dev/null/clawboo-no-session-bus',
}))

// Agents run as their own OS user here as far as the driver rule goes: the
// rest of the spawn path runs as the test's own user. The refusal itself is
// checked at the end.
const policy = vi.hoisted(() => ({ refusal: null as string | null }))
vi.mock('../../desktop/driverPolicy', () => ({ desktopDriverRefusal: () => policy.refusal }))

const { connectConnector, resetConnectorsForTests } = await import('../supervisor')
type Def = Parameters<typeof connectConnector>[1]

function serverSource(sdk: (s: string) => string): string {
  return `
const { Server } = require(${JSON.stringify(sdk('server/index.js'))})
const { StdioServerTransport } = require(${JSON.stringify(sdk('server/stdio.js'))})
const { ListToolsRequestSchema, CallToolRequestSchema } = require(${JSON.stringify(sdk('types.js'))})
const server = new Server({ name: 'fx', version: '1.0.0' }, { capabilities: { tools: {} } })
server.setRequestHandler(ListToolsRequestSchema, () => ({
  tools: [
    { name: 'list_windows', description: 'windows', inputSchema: { type: 'object', properties: {} } },
    { name: 'whereami', description: 'env', inputSchema: { type: 'object', properties: {} } },
  ],
}))
server.setRequestHandler(CallToolRequestSchema, (req) => ({
  content: [{ type: 'text', text: req.params.name === 'whereami'
    ? JSON.stringify({ home: process.env.HOME, bus: process.env.DBUS_SESSION_BUS_ADDRESS || null, noAtBridge: process.env.NO_AT_BRIDGE || null })
    : 'display=' + (process.env.DISPLAY || 'none') + ' xauth=' + (process.env.XAUTHORITY || 'none') }],
}))
server.connect(new StdioServerTransport())
`
}

describe('a desktop driver connector', () => {
  let dir: string
  let db: ClawbooDb
  let file: string
  let prevHome: string | undefined
  let prevDisplay: string | undefined

  beforeAll(() => {
    dir = mkdtempSync(path.join(os.tmpdir(), 'clawboo-desktop-driver-'))
    prevHome = process.env['CLAWBOO_HOME']
    process.env['CLAWBOO_HOME'] = dir
    // The server's own screen, which the driver must never be pointed at.
    prevDisplay = process.env['DISPLAY']
    process.env['DISPLAY'] = ':0'
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
    if (prevHome === undefined) delete process.env['CLAWBOO_HOME']
    else process.env['CLAWBOO_HOME'] = prevHome
    if (prevDisplay === undefined) delete process.env['DISPLAY']
    else process.env['DISPLAY'] = prevDisplay
    rmSync(dir, { recursive: true, force: true })
  })

  it('acts only for a named agent, only on its own display, with that display alone', async () => {
    const def: Def = {
      slug: 'fixturedriver',
      displayName: 'Fixture Driver',
      provenance: 'curated',
      launch: {
        transport: 'stdio',
        command: process.execPath,
        args: [file],
        pinnedVersion: '1.0.0',
        perAgentDisplay: true,
      },
      egressAllow: ['*'],
      trifecta: { readsPrivateData: true, ingestsUntrustedContent: true, canEgress: true },
      fileWritingArgs: ['screenshot_out_file', 'output_dir'],
    }
    const { connector } = await connectConnector(db, def)
    const tool = connector.descriptors.find((d) => d.name.endsWith('list_windows'))!
    const where = connector.descriptors.find((d) => d.name.endsWith('whereami'))!

    // The shared session it lists its tools through was given no display, a
    // bus that cannot exist, and a home of its own: it finds nobody's desktop.
    expect(await connector.session.callTool('list_windows', {})).toMatchObject({
      text: 'display=none xauth=none',
    })
    const shared = JSON.parse(
      ((await connector.session.callTool('whereami', {})) as { text: string }).text,
    ) as { home: string; bus: string | null; noAtBridge: string | null }
    expect(shared.home).toBe(path.join(dir, 'browser-profiles', 'fixturedriver', 'listing'))
    expect(shared.bus).toBe('unix:path=/dev/null/clawboo-no-session-bus')
    expect(shared.noAtBridge).toBe('1')

    await expect(tool.executor({}, {} as never)).rejects.toThrow(/named no agent/)
    await expect(tool.executor({}, { agentId: 'no-display' } as never)).rejects.toThrow(
      /own screen/,
    )

    displays.byAgent.set('a1', {
      env: { DISPLAY: ':41', XAUTHORITY: '/agent/desktops/a1/Xauthority' },
    })
    expect(await tool.executor({}, { agentId: 'a1' } as never)).toBe(
      'display=:41 xauth=/agent/desktops/a1/Xauthority',
    )
    // Its own home, inside this agent's own folder, not the person's.
    const own = JSON.parse(String(await where.executor({}, { agentId: 'a1' } as never))) as {
      home: string
    }
    expect(
      own.home.startsWith(path.join(dir, 'browser-profiles', 'fixturedriver') + path.sep),
    ).toBe(true)
    expect(own.home).not.toBe(shared.home)
    expect(own.home).not.toBe(os.homedir())
  }, 60_000)

  it('refuses an argument that would write a file, however it is nested', async () => {
    const def: Def = {
      slug: 'fixturedriver2',
      displayName: 'Fixture Driver',
      provenance: 'curated',
      launch: {
        transport: 'stdio',
        command: process.execPath,
        args: [file],
        pinnedVersion: '1.0.0',
        perAgentDisplay: true,
      },
      egressAllow: ['*'],
      trifecta: { readsPrivateData: true, ingestsUntrustedContent: true, canEgress: true },
      fileWritingArgs: ['screenshot_out_file', 'output_dir'],
    }
    displays.byAgent.set('a2', { env: { DISPLAY: ':42', XAUTHORITY: '/x' } })
    const { connector } = await connectConnector(db, def)
    const tool = connector.descriptors.find((d) => d.name.endsWith('list_windows'))!
    const ctx = { agentId: 'a2' } as never
    await expect(tool.executor({ screenshot_out_file: '/data/clawboo.db' }, ctx)).rejects.toThrow(
      /may not write files.*screenshot_out_file/,
    )
    await expect(
      tool.executor({ steps: [{ tool: 'start_recording', args: { output_dir: '/' } }] }, ctx),
    ).rejects.toThrow(/output_dir/)
    // A step list sent as a JSON string, which the server parses itself.
    await expect(
      tool.executor({ steps: JSON.stringify([{ args: { screenshot_out_file: '/x' } }]) }, ctx),
    ).rejects.toThrow(/screenshot_out_file/)
    // The same with the key's underscore escaped, which only a JSON parse undoes.
    await expect(
      tool.executor({ steps: '[{"args":{"screenshot\\u005fout_file":"/x"}}]' }, ctx),
    ).rejects.toThrow(/screenshot_out_file/)
    // Nested deeper than any real call: refused rather than read.
    let deep: Record<string, unknown> = { leaf: 1 }
    for (let i = 0; i < 40; i++) deep = { next: deep }
    await expect(tool.executor(deep, ctx)).rejects.toThrow(/may not write files/)
    // Text that only mentions one is not a refusal.
    expect(await tool.executor({ text: 'set screenshot_out_file later' }, ctx)).toBe(
      'display=:42 xauth=/x',
    )
  }, 60_000)

  it('starts no driver where agents do not run as their own OS user', async () => {
    const def: Def = {
      slug: 'fixturedriver3',
      displayName: 'Fixture Driver',
      provenance: 'curated',
      launch: {
        transport: 'stdio',
        command: process.execPath,
        args: [file],
        pinnedVersion: '1.0.0',
        perAgentDisplay: true,
      },
      egressAllow: ['*'],
      trifecta: { readsPrivateData: true, ingestsUntrustedContent: true, canEgress: true },
    }
    displays.byAgent.set('a3', { env: { DISPLAY: ':43', XAUTHORITY: '/x' } })
    const { connector } = await connectConnector(db, def)
    const tool = connector.descriptors.find((d) => d.name.endsWith('list_windows'))!
    policy.refusal = 'needs agents to run as their own OS user (CLAWBOO_AGENT_USER)'
    try {
      await expect(tool.executor({}, { agentId: 'a3' } as never)).rejects.toThrow(
        /CLAWBOO_AGENT_USER/,
      )
    } finally {
      policy.refusal = null
    }
  }, 60_000)
})
