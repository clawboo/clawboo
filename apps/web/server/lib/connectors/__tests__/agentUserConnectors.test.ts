// Connectors with agent isolation on (CLAWBOO_AGENT_USER).
//
// A connector with local reach and no credential runs as the agent user, so it
// reaches what the agents reach and no more; a per-agent browser's profile is
// that user's own state, in its home. A connector holding a credential from the
// vault stays with the server, because the agent user can read the environment
// of its own processes. The host here runs in this process as the test's own
// user, so what these prove is which side started each process and made each
// folder, not the uid switch.

import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { createRequire } from 'node:module'
import os from 'node:os'
import path from 'node:path'

import { createDb, type ClawbooDb } from '@clawboo/db'
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
  type MockInstance,
} from 'vitest'

import type { AgentHostClient } from '../../agentUser/client'
import { setActiveAgentHost } from '../../agentUser/state'
import { startInProcessHost, type InProcessHost } from '../../agentUser/__tests__/inProcessHost'
import { killProcessTree, killProcessTreeByPid } from '../../runtimes/killTree'
import { isHostedAgentProcess } from '../../runtimes/spawner'
import { agentBrowserSession, closeAllAgentBrowsers, profileDirFor } from '../agentBrowsers'
import { setConnectorCredential, type DeclaredInput } from '../credentials'
import { connectorPidFilePath } from '../pidFile'
import { connectConnector, disconnectConnector, resetConnectorsForTests } from '../supervisor'

// Watched, not replaced: which stop is used, and on what, is the point.
vi.mock('../../runtimes/killTree', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../runtimes/killTree')>()
  return {
    ...real,
    killProcessTree: vi.fn(real.killProcessTree),
    killProcessTreeByPid: vi.fn(real.killProcessTreeByPid),
  }
})

const posix = process.platform !== 'win32'

function closed(p: NodeJS.EventEmitter & { exitCode: number | null }): Promise<void> {
  if (p.exitCode !== null) return Promise.resolve()
  return new Promise((resolve) => p.once('close', () => resolve()))
}

function serverSource(sdk: (s: string) => string): string {
  return `
const { Server } = require(${JSON.stringify(sdk('server/index.js'))})
const { StdioServerTransport } = require(${JSON.stringify(sdk('server/stdio.js'))})
const { ListToolsRequestSchema, CallToolRequestSchema } = require(${JSON.stringify(sdk('types.js'))})
const server = new Server({ name: 'fx', version: '1.0.0' }, { capabilities: { tools: {} } })
const SCHEMA = { type: 'object', properties: {} }
server.setRequestHandler(ListToolsRequestSchema, () => ({
  tools: [{ name: 'whoami', description: 'its cwd and token', inputSchema: SCHEMA }],
}))
server.setRequestHandler(CallToolRequestSchema, () => ({
  content: [{ type: 'text', text: JSON.stringify({ cwd: process.cwd(), token: process.env.FIXTURE_TOKEN ?? null }) }],
}))
server.connect(new StdioServerTransport())
`
}

const TOKEN_INPUT: DeclaredInput = {
  key: 'FIXTURE_TOKEN',
  description: 'a token',
  required: true,
  secret: true,
}

function recordedPids(): number[] {
  try {
    return (JSON.parse(readFileSync(connectorPidFilePath(), 'utf8')) as { pid: number }[]).map(
      (e) => e.pid,
    )
  } catch {
    return []
  }
}

describe.runIf(posix)('connectors with agent isolation on', () => {
  let dir: string
  let agentHome: string
  let server: string
  let db: ClawbooDb
  let h: InProcessHost | null = null
  let ops: string[]
  let spawnSpy: MockInstance<AgentHostClient['spawn']>

  beforeAll(() => {
    dir = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'clawboo-agent-connectors-')))
    agentHome = path.join(dir, 'agent-home')
    mkdirSync(agentHome, { mode: 0o700 })
    mkdirSync(path.join(dir, 'data'))
    server = path.join(dir, 'server.cjs')
    const req = createRequire(path.join(process.cwd(), 'package.json'))
    writeFileSync(
      server,
      serverSource((s) => req.resolve(`@modelcontextprotocol/sdk/${s}`)),
    )
  })

  beforeEach(async () => {
    vi.stubEnv('HOME', dir)
    vi.stubEnv('CLAWBOO_HOME', path.join(dir, 'data'))
    db = createDb(path.join(dir, 'data', 'test.db'))
    vi.stubEnv('CLAWBOO_AGENT_USER', 'clawboo-agent')
    h = startInProcessHost()
    const hello = await h.client.waitForHello()
    setActiveAgentHost({
      client: h.client,
      hello: { ...hello, home: agentHome },
      config: { user: 'clawboo-agent', switch: 'sudo', socket: null },
    })
    ops = []
    const request = h.client.request.bind(h.client)
    vi.spyOn(h.client, 'request').mockImplementation((r) => {
      ops.push(r.op)
      return request(r)
    })
    spawnSpy = vi.spyOn(h.client, 'spawn')
  })

  afterEach(async () => {
    await resetConnectorsForTests()
    await closeAllAgentBrowsers()
    setActiveAgentHost(null)
    h?.client.close()
    h = null
    db.$client.close()
    vi.unstubAllEnvs()
  })

  afterAll(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  const definition = (slug: string, authInputs?: DeclaredInput[]) => ({
    slug,
    displayName: slug,
    provenance: 'curated' as const,
    launch: {
      transport: 'stdio' as const,
      command: process.execPath,
      args: [server],
      pinnedVersion: '1.0.0',
    },
    egressAllow: [],
    trifecta: { readsPrivateData: true, ingestsUntrustedContent: false, canEgress: false },
    ...(authInputs ? { authInputs } : {}),
  })

  it('starts a connector with no credential through the agent host, and stops it there', async () => {
    const { connector } = await connectConnector(db, definition('fixturelocal'))

    expect(spawnSpy).toHaveBeenCalledTimes(1)
    expect(spawnSpy.mock.calls[0]![0]).toMatchObject({ command: process.execPath, group: true })
    expect(isHostedAgentProcess(connector.agentProcess)).toBe(true)
    expect((await connector.session.callTool('whoami', {})).isError).toBe(false)
    // Tracked by handle, never by a pid the server could not signal.
    expect(recordedPids()).not.toContain(connector.session.pid)

    const hosted = connector.agentProcess!
    await disconnectConnector(connector.connectorId)
    await closed(hosted)
    // Stopped by its handle (the host stops the tree), never by a pid this
    // server cannot signal.
    expect(vi.mocked(killProcessTree)).toHaveBeenCalledWith(hosted)
    expect(vi.mocked(killProcessTreeByPid)).not.toHaveBeenCalled()
  }, 30_000)

  it('keeps a connector holding a credential with the server', async () => {
    setConnectorCredential('fixturesecret', 'FIXTURE_TOKEN', 'tok-from-vault')
    const { connector } = await connectConnector(db, definition('fixturesecret', [TOKEN_INPUT]))

    expect(spawnSpy).not.toHaveBeenCalled()
    expect(connector.agentProcess).toBeUndefined()
    const pid = connector.session.pid
    expect(typeof pid).toBe('number')
    // A local child: this process can signal it, and the pid file holds it.
    expect(() => process.kill(pid!, 0)).not.toThrow()
    expect(recordedPids()).toContain(pid)
    const seen = JSON.parse((await connector.session.callTool('whoami', {})).text) as {
      token: string | null
    }
    expect(seen.token).toBe('tok-from-vault')

    await disconnectConnector(connector.connectorId)
    expect(vi.mocked(killProcessTreeByPid)).toHaveBeenCalledWith(pid)
  }, 30_000)

  it("starts an agent's browser through the host, with its profile in the agent user's home", async () => {
    const spec = {
      slug: 'fixturebrowser',
      command: process.execPath,
      args: [server],
      profileFlag: '--profile',
    }
    const profile = profileDirFor('fixturebrowser', 'agent-1')
    expect(
      profile.startsWith(path.join(agentHome, 'browser-profiles', 'fixturebrowser') + path.sep),
    ).toBe(true)

    const session = await agentBrowserSession(
      spec,
      'conn:connector:clawboo:mcp:fixturebrowser',
      'agent-1',
      { create: true },
    )

    expect(spawnSpy).toHaveBeenCalledTimes(1)
    const call = spawnSpy.mock.calls[0]![0]
    expect(call.args.slice(-2)).toEqual(['--profile', profile])
    expect(call.cwd).toBe(path.join(profile, 'scratch'))
    // Made by the host, 0700, and nothing under the server's data folder.
    expect(ops).toContain('fs.mkdir')
    expect(statSync(profile).mode & 0o777).toBe(0o700)
    expect(statSync(path.join(profile, 'scratch')).mode & 0o777).toBe(0o700)
    const seen = JSON.parse((await session!.callTool('whoami', {})).text) as { cwd: string }
    expect(seen.cwd).toBe(path.join(profile, 'scratch'))
    expect(recordedPids()).not.toContain(session!.pid)

    await closeAllAgentBrowsers()
    const stopped = vi.mocked(killProcessTree).mock.calls.map(([p]) => p)
    expect(stopped).toHaveLength(1)
    expect(isHostedAgentProcess(stopped[0])).toBe(true)
    expect(vi.mocked(killProcessTreeByPid)).not.toHaveBeenCalled()
  }, 30_000)

  it("keeps an agent's browser holding a credential with the server, profile in the data folder", async () => {
    setConnectorCredential('fixturekeyedbrowser', 'FIXTURE_TOKEN', 'tok-from-vault')
    const session = await agentBrowserSession(
      {
        slug: 'fixturekeyedbrowser',
        command: process.execPath,
        args: [server],
        profileFlag: '--profile',
        authInputs: [TOKEN_INPUT],
      },
      'conn:connector:clawboo:mcp:fixturekeyedbrowser',
      'agent-1',
      { create: true },
    )

    expect(spawnSpy).not.toHaveBeenCalled()
    const seen = JSON.parse((await session!.callTool('whoami', {})).text) as { cwd: string }
    expect(
      seen.cwd.startsWith(
        path.join(dir, 'data', 'browser-profiles', 'fixturekeyedbrowser') + path.sep,
      ),
    ).toBe(true)
    expect(recordedPids()).toContain(session!.pid)
  }, 30_000)
})
