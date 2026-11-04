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
import { blockDashboardArgs, setDashboardPort } from '../dashboardGuard'
import { connectConnector, disconnectConnector, resetConnectorsForTests } from '../supervisor'

const PLAYWRIGHT = { flag: '--blocked-origins', style: 'origins' } as const
const DEVTOOLS = { flag: '--blockedUrlPattern', style: 'urlPatterns' } as const

const escapeRegExp = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

// Whether the launch arguments stop this URL, read the way each server reads
// them. Playwright makes a glob of each origin, where `*` is any run without a
// `/`; a URL pattern is read here as one match over the URL, where `\x` is the
// character x and `*` is anything. Chrome rewrites the URL first, as `new URL`
// does. Checked by hand against playwright-mcp 0.0.79 and chrome-devtools-mcp
// 1.7.0 driving Chrome 156.
function blocks(
  spec: typeof PLAYWRIGHT | typeof DEVTOOLS,
  url: string,
  bindHost: string | null = null,
): boolean {
  const args = blockDashboardArgs(spec, 18790, bindHost)
  const href = new URL(url).href
  if (spec.style === 'origins') {
    return args[1]!.split(';').some((origin) => {
      const glob = escapeRegExp(new URL(origin).origin).replace(/\\\*/g, '[^/]*')
      return new RegExp(`^${glob}/`).test(href)
    })
  }
  return args
    .filter((_, i) => i % 2 === 1)
    .some((pattern) => {
      const source = pattern.replace(/\\(.)|(\*)|(.)/g, (_, escaped, star, plain) =>
        star ? '.*' : escapeRegExp(escaped ?? plain),
      )
      return new RegExp(`^${source}$`).test(href)
    })
}

describe('blockDashboardArgs', () => {
  it.each([
    // Chrome sends every name under .localhost to loopback without DNS.
    'http://dash.localhost:18790/',
    'http://a.b.LOCALHOST:18790/',
    'http://dash.localhost.:18790/',
    // IPv4-mapped IPv6 connects to the IPv4 listener.
    'http://[::ffff:127.0.0.1]:18790/',
    'http://[::ffff:0.0.0.0]:18790/',
    // Connects when the server listens on IPv6 (HOST=::).
    'http://[::]:18790/',
  ])('blocks %s in both browsers', (url) => {
    expect(blocks(PLAYWRIGHT, url)).toBe(true)
    expect(blocks(DEVTOOLS, url)).toBe(true)
  })

  it.each([
    'http://127.0.0.1:18790/',
    'http://localhost:18790/#/approvals',
    'http://localhost.:18790/',
    'http://[::1]:18790/',
    'http://0.0.0.0:18790/',
    // Chrome rewrites these to one of the spellings above before matching.
    'http://127.1:18790/',
    'http://2130706433:18790/',
    'http://0x7f000001:18790/',
    'http://0177.0.0.1:18790/',
    'http://127.0.0.1.:18790/',
    'http://[0:0:0:0:0:0:0:1]:18790/',
    'http://LocalHost:18790/',
    'http://%6c%6fcalhost:18790/',
    'http://localhost:018790/',
  ])('still blocks %s in both browsers', (url) => {
    expect(blocks(PLAYWRIGHT, url)).toBe(true)
    expect(blocks(DEVTOOLS, url)).toBe(true)
  })

  it('blocks a loopback alias the server is bound to', () => {
    // Playwright's glob covers all of 127/8; a URL pattern cannot, so Chrome
    // DevTools is given the address the server listens on.
    expect(blocks(PLAYWRIGHT, 'http://127.0.0.2:18790/')).toBe(true)
    expect(blocks(PLAYWRIGHT, 'http://127.255.0.9:18790/')).toBe(true)
    expect(blocks(DEVTOOLS, 'http://127.0.0.2:18790/', '127.0.0.2')).toBe(true)
    expect(blocks(DEVTOOLS, 'http://[::ffff:127.0.0.2]:18790/', '127.0.0.2')).toBe(true)
  })

  it.each([
    // HOST=192.168.1.5 (needs an access token or CLAWBOO_ALLOW_INSECURE=1):
    // the origin guard trusts the bind address, so it is the dashboard too.
    ['192.168.1.5', 'http://192.168.1.5:18790/'],
    ['192.168.1.5', 'http://3232235781:18790/'],
    ['192.168.1.5', 'http://[::ffff:192.168.1.5]:18790/'],
    ['fe80::1', 'http://[fe80::1]:18790/'],
    ['clawboo.lan', 'http://Clawboo.lan.:18790/'],
  ])('blocks the bind address %s as %s in both browsers', (bindHost, url) => {
    expect(blocks(PLAYWRIGHT, url, bindHost)).toBe(true)
    expect(blocks(DEVTOOLS, url, bindHost)).toBe(true)
  })

  it.each([
    'http://127.0.0.1:3000/',
    'http://localhost:3000/',
    'http://dash.localhost:3000/',
    'http://example.com:18790/',
    'http://192.168.1.5:18790/',
  ])('leaves %s reachable', (url) => {
    expect(blocks(PLAYWRIGHT, url)).toBe(false)
    expect(blocks(DEVTOOLS, url)).toBe(false)
  })

  it("takes Playwright's semicolon list", () => {
    expect(blockDashboardArgs(PLAYWRIGHT, 18790)).toEqual([
      '--blocked-origins',
      'http://127.*:18790;http://0.0.0.0:18790;http://[::ffff:7f00:1]:18790;http://[::ffff:0:0]:18790;' +
        'http://[::1]:18790;http://[::]:18790;http://localhost:18790;http://localhost.:18790;' +
        'http://*.localhost:18790;http://*.localhost.:18790',
    ])
  })

  it("takes Chrome DevTools' URL patterns, with the IPv6 hosts escaped", () => {
    // An unescaped `[::1]` is an invalid URLPattern; chrome-devtools-mcp 1.7.0
    // would throw on it at every navigation. The `*` in a name is a wildcard.
    expect(blockDashboardArgs(DEVTOOLS, 18790).filter((_, i) => i % 2 === 1)).toEqual([
      'http://127.0.0.1:18790/*',
      'http://0.0.0.0:18790/*',
      'http://\\[\\:\\:ffff\\:7f00\\:1\\]:18790/*',
      'http://\\[\\:\\:ffff\\:0\\:0\\]:18790/*',
      'http://\\[\\:\\:1\\]:18790/*',
      'http://\\[\\:\\:\\]:18790/*',
      'http://localhost:18790/*',
      'http://localhost.:18790/*',
      'http://*.localhost:18790/*',
      'http://*.localhost.:18790/*',
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
    // Bound to a loopback alias, as with HOST=127.0.0.2.
    setDashboardPort(18790, '127.0.0.2')
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
    expect(argv[at + 1]).toContain('http://127.*:18790')
    expect(argv[at + 1]).toContain('http://*.localhost:18790')
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
      expect(argv).toContain('http://*.localhost:18790/*')
      expect(argv).toContain('http://127.0.0.2:18790/*')
    } finally {
      await disconnectConnector(connector.connectorId)
    }
  }, 30_000)
})
