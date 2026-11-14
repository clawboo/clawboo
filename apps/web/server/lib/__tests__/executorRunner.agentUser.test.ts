// A board task run with agents on their own OS user (CLAWBOO_AGENT_USER): the
// runtime's per-agent home is agent space, owned by the agent user, so the agent
// host makes it before the run starts. The server could not, and must not try
// to as itself.

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { createTask } from '@clawboo/db'
import type {
  Capabilities,
  RunHandle,
  RuntimeAdapter,
  RuntimeEvent,
  StartOpts,
  TaskHandle,
} from '@clawboo/executor'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { setActiveAgentHost } from '../agentUser/state'
import { startInProcessHost, type InProcessHost } from '../agentUser/__tests__/inProcessHost'
import { getDb, resetDb } from '../db'
import { runTaskOnRuntime } from '../executorRunner'
import { runtimeIdentityHomePath } from '../runtimes/identityHome'
import { seedSandboxTeam } from './seedTeam'

const posix = process.platform !== 'win32'

// No worktree: the run starts in its team folder.
const PERSISTENT_CAPS: Capabilities = {
  streaming: true,
  mcp: true,
  worktrees: false,
  resume: true,
  toolApproval: true,
  models: [],
  nativeHome: { scope: 'per-identity', persist: true },
}

function persistentAdapter(): RuntimeAdapter {
  return {
    id: 'clawboo-native',
    participantKind: 'agent',
    capabilities: () => PERSISTENT_CAPS,
    async health() {
      return { ok: true }
    },
    async start(_t: TaskHandle, opts: StartOpts): Promise<RunHandle> {
      return { adapterId: 'clawboo-native', sessionKey: opts.sessionKey, runId: null }
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
  }
}

let home: string
let active: InProcessHost | null = null

beforeEach(() => {
  home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'exec-agent-user-')))
  fs.mkdirSync(path.join(home, '.openclaw', 'clawboo'), { recursive: true })
  vi.stubEnv('HOME', home)
  vi.stubEnv('CLAWBOO_HOME', path.join(home, '.clawboo'))
  seedSandboxTeam(home)
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

describe.runIf(posix)('runTaskOnRuntime with agents on their own OS user', () => {
  it("makes the runtime's per-agent home through the agent host, owner-only", async () => {
    const taskId = createTask(getDb(), {
      title: 'persistent task',
      description: 'do it',
      status: 'todo',
      teamId: 'team-1',
    }).id
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

    const result = await runTaskOnRuntime({
      db: getDb(),
      makeAdapter: () => persistentAdapter(),
      taskId,
      assigneeAgentId: 'agent-perms',
    })

    expect(result).toMatchObject({ ok: true, usedWorktree: false })
    const homeDir = runtimeIdentityHomePath('clawboo-native', 'agent-perms')
    expect(homeDir.startsWith(path.join(agentHome, 'runtimes', ''))).toBe(true)
    expect(made).toContain(homeDir)
    expect(fs.statSync(homeDir).mode & 0o777).toBe(0o700)
  })
})
