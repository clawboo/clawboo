// Agents' browsers are launched with the Clawboo dashboard blocked.
//
// The dashboard has no access check on loopback, so a browser an agent drives
// could open it and approve its own requests. Both browser connectors are
// started with the dashboard's loopback origins blocked, on the port this server
// really listens on, and with a network rule in Chrome that refuses the same
// hosts on every hop: a redirect, a script's request and a WebSocket. Chrome
// DevTools is also told to refuse local files. The spawn tests use a real child
// process that records the arguments it was started with: the block has to
// reach the process, not just a helper's return value.

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import os from 'node:os'
import path from 'node:path'

import { CONNECTOR_DEFINITIONS } from '@clawboo/connector-catalog'
import { createDb, type ClawbooDb } from '@clawboo/db'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { agentBrowserSession, closeAllAgentBrowsers } from '../agentBrowsers'
import { blockDashboardArgs, browserGuardArgs, setDashboardPort } from '../dashboardGuard'
import { connectConnector, disconnectConnector, resetConnectorsForTests } from '../supervisor'

const PLAYWRIGHT = { flag: '--blocked-origins', style: 'origins' } as const
const DEVTOOLS = { flag: '--blockedUrlPattern', style: 'urlPatterns' } as const
const PLAYWRIGHT_SWITCH = { flag: '--config', style: 'playwrightConfig' } as const
const DEVTOOLS_SWITCH = { flag: '--chromeArg', style: 'joined' } as const

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

  it('declares how each browser connector takes a Chrome switch', () => {
    const launchOf = (slug: string) => CONNECTOR_DEFINITIONS.find((d) => d.slug === slug)!.launch
    expect(launchOf('playwright')).toMatchObject({ chromeSwitchArg: PLAYWRIGHT_SWITCH })
    expect(launchOf('chrome-devtools')).toMatchObject({ chromeSwitchArg: DEVTOOLS_SWITCH })
  })
})

const RULES_SWITCH = '--host-resolver-rules='

/** The Chrome switch value a launch hands over, from the joined flag or from
 *  the Playwright config file it points at. */
function hostRules(args: string[]): string {
  const joined = args.find((a) => a.startsWith(`--chromeArg=${RULES_SWITCH}`))
  if (joined) return joined.slice(`--chromeArg=${RULES_SWITCH}`.length)
  const config = JSON.parse(readFileSync(args[args.indexOf('--config') + 1]!, 'utf8')) as {
    browser: { launchOptions: { args: string[] } }
  }
  const rule = config.browser.launchOptions.args.find((a) => a.startsWith(RULES_SWITCH))!
  return rule.slice(RULES_SWITCH.length)
}

// Whether Chrome's host rules refuse this URL, read the way Chrome's host
// mapping reads them: each `MAP <pattern> ~NOTFOUND` is matched, with `*` and
// `?` as wildcards, against the host alone and then against host:port, where an
// IPv6 host is bracketed only in the second. Chrome rewrites the URL first, as
// `new URL` does. Checked by hand against both connectors driving Chrome 156.
function ruleRefuses(rules: string, url: string): boolean {
  const patterns = rules
    .split(',')
    .map((rule) => rule.trim().split(/\s+/))
    .filter(([verb, , to]) => verb === 'MAP' && to === '~NOTFOUND')
    .map(([, pattern]) => pattern!)
  const u = new URL(url)
  const port = u.port || (u.protocol === 'https:' || u.protocol === 'wss:' ? '443' : '80')
  const candidates = [u.hostname.replace(/^\[(.*)\]$/, '$1'), `${u.hostname}:${port}`]
  return patterns.some((pattern) => {
    const glob = new RegExp(
      `^${escapeRegExp(pattern).replace(/\\\*/g, '.*').replace(/\\\?/g, '.')}$`,
    )
    return candidates.some((candidate) => glob.test(candidate))
  })
}

describe('the network rule in both browsers', () => {
  let home: string
  let prevHome: string | undefined
  beforeAll(() => {
    home = mkdtempSync(path.join(os.tmpdir(), 'clawboo-browser-rule-'))
    prevHome = process.env['CLAWBOO_HOME']
    process.env['CLAWBOO_HOME'] = home
  })
  afterAll(() => {
    if (prevHome === undefined) delete process.env['CLAWBOO_HOME']
    else process.env['CLAWBOO_HOME'] = prevHome
    rmSync(home, { recursive: true, force: true })
  })

  const rulesFor = (bindHost: string | null = null): string[] => [
    hostRules(
      browserGuardArgs(
        'playwright',
        { blockOriginsArg: PLAYWRIGHT, chromeSwitchArg: PLAYWRIGHT_SWITCH },
        18790,
        bindHost,
      ),
    ),
    hostRules(
      browserGuardArgs(
        'chrome-devtools',
        { blockOriginsArg: DEVTOOLS, chromeSwitchArg: DEVTOOLS_SWITCH },
        18790,
        bindHost,
      ),
    ),
  ]

  it.each([
    'http://127.0.0.1:18790/',
    'http://localhost:18790/#/approvals',
    'http://localhost.:18790/',
    'http://dash.localhost:18790/',
    'http://a.b.LOCALHOST:18790/',
    'http://dash.localhost.:18790/',
    'http://[::1]:18790/',
    'http://[::]:18790/',
    'http://0.0.0.0:18790/',
    'http://[::ffff:127.0.0.1]:18790/',
    'http://[::ffff:0.0.0.0]:18790/',
    'http://127.1:18790/',
    'http://2130706433:18790/',
    'http://[0:0:0:0:0:0:0:1]:18790/',
    'http://%6c%6fcalhost:18790/',
    'http://localhost:018790/',
    // The rest of 127/8, which a URL pattern cannot say: a redirect to it on a
    // 0.0.0.0 bind used to reach the dashboard through Chrome DevTools.
    'http://127.0.0.2:18790/',
    'http://127.255.0.9:18790/',
    'http://[::ffff:127.0.0.2]:18790/',
    // A WebSocket opened by a page, which neither origin block stops.
    'ws://127.0.0.1:18790/api/gateway/ws',
    'ws://localhost:18790/api/gateway/ws',
  ])('refuses %s, on a redirect hop as on a first load', (url) => {
    for (const rules of rulesFor()) expect(ruleRefuses(rules, url), rules).toBe(true)
  })

  it.each([
    ['192.168.1.5', 'http://192.168.1.5:18790/'],
    ['192.168.1.5', 'http://3232235781:18790/'],
    ['192.168.1.5', 'http://[::ffff:192.168.1.5]:18790/'],
    ['fe80::1', 'http://[fe80::1]:18790/'],
    ['clawboo.lan', 'http://Clawboo.lan.:18790/'],
    ['127.0.0.2', 'http://127.0.0.2:18790/'],
  ])('refuses the bind address %s as %s', (bindHost, url) => {
    for (const rules of rulesFor(bindHost)) expect(ruleRefuses(rules, url), rules).toBe(true)
  })

  it.each([
    'http://127.0.0.1:3000/',
    'http://localhost:3000/',
    'http://dash.localhost:3000/',
    'ws://127.0.0.1:3000/',
    'http://example.com:18790/',
    'http://192.168.1.5:18790/',
    'https://example.com/',
  ])('leaves %s reachable', (url) => {
    for (const rules of rulesFor()) expect(ruleRefuses(rules, url), rules).toBe(false)
  })

  it('hands the rule to Chrome DevTools joined to its flag, so it is not read as a flag of its own', () => {
    const args = browserGuardArgs('chrome-devtools', { chromeSwitchArg: DEVTOOLS_SWITCH }, 18790)
    expect(args).toHaveLength(1)
    expect(args[0]).toMatch(/^--chromeArg=--host-resolver-rules=MAP 127\.\*:18790 ~NOTFOUND, /)
  })

  it('hands it to Playwright in a config file under the Clawboo folder', () => {
    const args = browserGuardArgs('playwright', { chromeSwitchArg: PLAYWRIGHT_SWITCH }, 18790)
    expect(args).toEqual([
      '--config',
      path.join(home, 'browser-profiles', 'playwright', 'guard.json'),
    ])
    expect(JSON.parse(readFileSync(args[1]!, 'utf8'))).toEqual({
      browser: { launchOptions: { args: [`${RULES_SWITCH}${hostRules(args)}`] } },
    })
  })

  it('writes the config again when it is not what this server would write', () => {
    const [, file] = browserGuardArgs('playwright', { chromeSwitchArg: PLAYWRIGHT_SWITCH }, 18790)
    writeFileSync(file!, JSON.stringify({ browser: { launchOptions: { args: [] } } }))
    browserGuardArgs('playwright', { chromeSwitchArg: PLAYWRIGHT_SWITCH }, 18790)
    expect(ruleRefuses(hostRules(['--config', file!]), 'http://localhost:18790/')).toBe(true)
  })

  it('adds no rule before the port is known', () => {
    expect(browserGuardArgs('playwright', { chromeSwitchArg: PLAYWRIGHT_SWITCH }, null)).toEqual([])
    expect(browserGuardArgs('chrome-devtools', { chromeSwitchArg: DEVTOOLS_SWITCH }, null)).toEqual(
      [],
    )
  })
})

describe('local files in Chrome DevTools', () => {
  it('is told to refuse file: and view-source: as well as the dashboard', () => {
    const args = browserGuardArgs('chrome-devtools', { blockOriginsArg: DEVTOOLS }, 18790)
    expect(args.slice(0, -4)).toEqual(blockDashboardArgs(DEVTOOLS, 18790))
    // Checked against 1.7.0: these refuse every spelling of a file URL the
    // browser would open, before the navigation starts.
    expect(args.slice(-4)).toEqual([
      '--blockedUrlPattern',
      'file:*',
      '--blockedUrlPattern',
      'view-source:*',
    ])
  })

  it('refuses them even before the port is known', () => {
    expect(browserGuardArgs('chrome-devtools', { blockOriginsArg: DEVTOOLS }, null)).toEqual([
      '--blockedUrlPattern',
      'file:*',
      '--blockedUrlPattern',
      'view-source:*',
    ])
  })

  it('leaves Playwright to its own refusal of file:, and the broker to view-source:', () => {
    expect(browserGuardArgs('playwright', { blockOriginsArg: PLAYWRIGHT }, 18790)).toEqual(
      blockDashboardArgs(PLAYWRIGHT, 18790),
    )
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

  it("with the network rule and the local-file block on an agent's own browser", async () => {
    const out = path.join(dir, 'agent-rule-argv.json')
    await agentBrowserSession(
      {
        slug: 'fixturedevtools',
        command: process.execPath,
        args: [server, out],
        profileFlag: '--userDataDir',
        blockOriginsArg: { flag: '--blockedUrlPattern', style: 'urlPatterns' },
        chromeSwitchArg: { flag: '--chromeArg', style: 'joined' },
      },
      'conn:connector:clawboo:mcp:fixturedevtools',
      'agent-1',
      { create: true },
    )
    const argv = argvOf(out)
    expect(ruleRefuses(hostRules(argv), 'http://127.0.0.2:18790/')).toBe(true)
    expect(ruleRefuses(hostRules(argv), 'http://127.0.0.1:3000/')).toBe(false)
    expect(argv).toContain('file:*')
    expect(argv).toContain('view-source:*')
  }, 30_000)

  it('with the network rule in a Playwright config on the shared session', async () => {
    const out = path.join(dir, 'shared-rule-argv.json')
    const { connector } = await connectConnector(db, {
      slug: 'fixtureplaywright',
      displayName: 'Fixture Playwright',
      provenance: 'curated',
      launch: {
        transport: 'stdio',
        command: process.execPath,
        args: [server, out],
        pinnedVersion: '1.0.0',
        blockOriginsArg: { flag: '--blocked-origins', style: 'origins' },
        chromeSwitchArg: { flag: '--config', style: 'playwrightConfig' },
      },
      egressAllow: ['*'],
      trifecta: { readsPrivateData: false, ingestsUntrustedContent: true, canEgress: true },
    })
    try {
      const argv = argvOf(out)
      expect(argv[argv.indexOf('--config') + 1]).toBe(
        path.join(dir, 'browser-profiles', 'fixtureplaywright', 'guard.json'),
      )
      expect(ruleRefuses(hostRules(argv), 'ws://localhost:18790/api/gateway/ws')).toBe(true)
      expect(ruleRefuses(hostRules(argv), 'http://127.0.0.2:18790/')).toBe(true)
    } finally {
      await disconnectConnector(connector.connectorId)
    }
  }, 30_000)
})
