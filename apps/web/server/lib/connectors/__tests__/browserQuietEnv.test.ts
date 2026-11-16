// Chrome DevTools' usage-statistics and update-check opt-outs reach the process
// that really runs, on both paths that start one: the shared session a connect
// starts, and an agent's own browser.
//
// The package is a stand-in installed in a throwaway npx cache, so the real
// direct-launch path runs it. Its bin is a minimal MCP server that writes down
// the environment it was started with.
//
// Python's bytecode is off for both, which start through npm (the direct launch
// runs node), and left to the server's setting for a connector any other
// program starts.

import { createHash } from 'node:crypto'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import os from 'node:os'
import path from 'node:path'

import { createDb, type ClawbooDb } from '@clawboo/db'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

import { agentBrowserSession, closeAllAgentBrowsers } from '../agentBrowsers'
import { connectConnector, disconnectConnector, resetConnectorsForTests } from '../supervisor'

const SPEC = 'chrome-devtools-mcp@1.7.0'

describe("Chrome DevTools' opt-outs reach the browser server", () => {
  let dir: string
  let db: ClawbooDb

  beforeAll(() => {
    dir = mkdtempSync(path.join(os.tmpdir(), 'clawboo-quiet-env-'))
    vi.stubEnv('CLAWBOO_HOME', dir)
    vi.stubEnv('npm_config_cache', path.join(dir, 'npm-cache'))
    vi.stubEnv('CHROME_DEVTOOLS_MCP_NO_USAGE_STATISTICS', undefined)
    vi.stubEnv('CHROME_DEVTOOLS_MCP_NO_UPDATE_CHECKS', undefined)
    vi.stubEnv('PYTHONDONTWRITEBYTECODE', undefined)
    vi.stubEnv('PYTHONPYCACHEPREFIX', undefined)
    db = createDb(path.join(dir, 'test.db'))

    // Where `npx -y chrome-devtools-mcp@1.7.0` keeps its finished install.
    const hash = createHash('sha512').update(SPEC).digest('hex').slice(0, 16)
    const nodeModules = path.join(dir, 'npm-cache', '_npx', hash, 'node_modules')
    const pkgDir = path.join(nodeModules, 'chrome-devtools-mcp')
    mkdirSync(pkgDir, { recursive: true })
    writeFileSync(path.join(nodeModules, '.package-lock.json'), '{}')
    writeFileSync(
      path.join(pkgDir, 'package.json'),
      JSON.stringify({
        name: 'chrome-devtools-mcp',
        version: '1.7.0',
        bin: { 'chrome-devtools-mcp': 'server.cjs' },
      }),
    )
    const req = createRequire(path.join(process.cwd(), 'package.json'))
    const sdk = (s: string) => JSON.stringify(req.resolve(`@modelcontextprotocol/sdk/${s}`))
    writeFileSync(
      path.join(pkgDir, 'server.cjs'),
      `
const env = {}
for (const k of ['CHROME_DEVTOOLS_MCP_NO_USAGE_STATISTICS', 'CHROME_DEVTOOLS_MCP_NO_UPDATE_CHECKS', 'PYTHONDONTWRITEBYTECODE']) env[k] = process.env[k] ?? null
require('node:fs').writeFileSync(process.argv[2], JSON.stringify(env))
const { Server } = require(${sdk('server/index.js')})
const { StdioServerTransport } = require(${sdk('server/stdio.js')})
const { ListToolsRequestSchema } = require(${sdk('types.js')})
const s = new Server({ name: 'fx', version: '1.0.0' }, { capabilities: { tools: {} } })
s.setRequestHandler(ListToolsRequestSchema, () => ({ tools: [] }))
s.connect(new StdioServerTransport())
`,
    )
    // A connector started by a program of its own, not through npm.
    serverScript = path.join(pkgDir, 'server.cjs')
    ownLauncher = path.join(dir, 'fixture-server')
    writeFileSync(
      ownLauncher,
      `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(serverScript)} "$@"\n`,
    )
    chmodSync(ownLauncher, 0o755)
  })

  let serverScript = ''
  let ownLauncher = ''

  afterAll(async () => {
    await closeAllAgentBrowsers()
    await resetConnectorsForTests()
    db.$client.close()
    vi.unstubAllEnvs()
    rmSync(dir, { recursive: true, force: true })
  })

  const envOf = (file: string): Record<string, string | null> =>
    JSON.parse(readFileSync(file, 'utf8')) as Record<string, string | null>

  const OFF = {
    CHROME_DEVTOOLS_MCP_NO_USAGE_STATISTICS: '1',
    CHROME_DEVTOOLS_MCP_NO_UPDATE_CHECKS: '1',
    PYTHONDONTWRITEBYTECODE: '1',
  }

  it('on the shared session a connect starts', async () => {
    const out = path.join(dir, 'shared-env.json')
    const { connector } = await connectConnector(db, {
      slug: 'fixturequiet',
      displayName: 'Fixture Quiet',
      provenance: 'curated',
      launch: {
        transport: 'stdio',
        command: 'npx',
        args: ['-y', SPEC, out],
        pinnedVersion: '1.7.0',
      },
      egressAllow: ['*'],
      trifecta: { readsPrivateData: false, ingestsUntrustedContent: true, canEgress: true },
    })
    try {
      expect(envOf(out)).toEqual(OFF)
    } finally {
      await disconnectConnector(connector.connectorId)
    }
  }, 30_000)

  it("on an agent's own browser", async () => {
    const out = path.join(dir, 'agent-env.json')
    await agentBrowserSession(
      {
        slug: 'fixturequietbrowser',
        command: 'npx',
        args: ['-y', SPEC, out],
        profileFlag: '--userDataDir',
      },
      'conn:connector:clawboo:mcp:fixturequietbrowser',
      'agent-1',
      { create: true },
    )
    expect(envOf(out)).toEqual(OFF)
  }, 30_000)

  it.skipIf(process.platform === 'win32')(
    'leaves Python’s bytecode to the server for a connector npm does not start',
    async () => {
      const out = path.join(dir, 'own-env.json')
      const { connector } = await connectConnector(db, {
        slug: 'fixtureownlauncher',
        displayName: 'Fixture Own Launcher',
        provenance: 'curated',
        launch: { transport: 'stdio', command: ownLauncher, args: [out], pinnedVersion: '1.0.0' },
        egressAllow: ['*'],
        trifecta: { readsPrivateData: false, ingestsUntrustedContent: true, canEgress: true },
      })
      try {
        expect(envOf(out)['PYTHONDONTWRITEBYTECODE']).toBeNull()
      } finally {
        await disconnectConnector(connector.connectorId)
      }
    },
    30_000,
  )
})
