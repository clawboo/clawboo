// A one-to-one chat turn with agents on their own OS user (CLAWBOO_AGENT_USER):
// the runtime's per-agent home is agent space, owned by the agent user, so the
// agent host makes it before the run starts. The home is only resolved on the
// production path (an injected adapter skips it), so the runtime's adapter
// factory is replaced here by a scripted one; nothing real runs. In its own file
// because `vi.mock` is file-global.

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { agents } from '@clawboo/db'
import type {
  Capabilities,
  RunHandle,
  RuntimeAdapter,
  RuntimeEvent,
  StartOpts,
  TaskHandle,
} from '@clawboo/executor'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

/** A persistent per-identity home, as Hermes has. */
const PERSISTENT_CAPS: Capabilities = {
  streaming: true,
  mcp: false,
  worktrees: false,
  resume: false,
  toolApproval: false,
  models: [],
  nativeHome: { scope: 'per-identity', persist: true },
}

const runs = vi.hoisted(() => ({ starts: 0 }))

vi.mock('../../runtimes', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../runtimes')>()
  const adapter = (): RuntimeAdapter => ({
    id: 'hermes',
    participantKind: 'agent',
    capabilities: () => PERSISTENT_CAPS,
    async health() {
      return { ok: true }
    },
    async start(_t: TaskHandle, opts: StartOpts): Promise<RunHandle> {
      runs.starts += 1
      return { adapterId: 'hermes', sessionKey: opts.sessionKey, runId: null }
    },
    events(run: RunHandle): AsyncIterable<RuntimeEvent> {
      const b = { runId: run.sessionKey, sessionId: run.sessionKey, ts: 1, seq: 1 }
      return (async function* () {
        yield { ...b, kind: 'done', reason: 'success', summary: 'ok' } as RuntimeEvent
      })()
    },
    async abort() {},
    async setModel() {},
    async writeContext() {},
  })
  return { ...real, adapterFactoryFor: () => adapter }
})

const { setActiveAgentHost } = await import('../../agentUser/state')
const { startInProcessHost } = await import('../../agentUser/__tests__/inProcessHost')
const { getDb, resetDb } = await import('../../db')
const { runtimeIdentityHomePath } = await import('../../runtimes/identityHome')
const { driveAgentChat } = await import('../driveAgentChat')

type InProcessHost = ReturnType<typeof startInProcessHost>

const posix = process.platform !== 'win32'

let home: string
let active: InProcessHost | null = null

beforeEach(() => {
  home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'chat-agent-user-')))
  vi.stubEnv('HOME', home)
  vi.stubEnv('CLAWBOO_HOME', path.join(home, '.clawboo'))
  runs.starts = 0
})

afterEach(() => {
  resetDb()
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
  setActiveAgentHost(null)
  active?.client.close()
  active = null
  fs.rmSync(home, { recursive: true, force: true })
})

describe.runIf(posix)('driveAgentChat with agents on their own OS user', () => {
  it("makes the runtime's per-agent home through the agent host before the run", async () => {
    const db = getDb()
    const now = Date.now()
    db.insert(agents)
      .values({
        id: 'h1',
        name: 'h1',
        gatewayId: 'h1',
        sourceId: 'hermes',
        sourceAgentId: 'h1',
        runtime: 'hermes',
        status: 'idle',
        teamId: null,
        createdAt: now,
        updatedAt: now,
      })
      .run()
    vi.stubEnv('CLAWBOO_AGENT_USER', 'clawboo-agent')
    const h = startInProcessHost()
    active = h
    const hello = await h.client.waitForHello()
    const agentHome = path.join(home, 'agent-home')
    setActiveAgentHost({
      client: h.client,
      hello: { ...hello, home: agentHome },
      config: { user: 'clawboo-agent', switch: 'sudo', socket: null },
    })
    const made: string[] = []
    const request = h.client.request.bind(h.client)
    vi.spyOn(h.client, 'request').mockImplementation((r, opts) => {
      if (r.op === 'fs.mkdir') made.push(r.path)
      return request(r, opts)
    })

    await driveAgentChat({ db, agentId: 'h1', message: 'hello', mcpBaseUrl: null })

    expect(runs.starts).toBe(1)
    const homeDir = runtimeIdentityHomePath('hermes', 'h1')
    expect(homeDir.startsWith(path.join(agentHome, 'runtimes', ''))).toBe(true)
    expect(made).toContain(homeDir)
    expect(fs.statSync(homeDir).mode & 0o777).toBe(0o700)
  })
})
