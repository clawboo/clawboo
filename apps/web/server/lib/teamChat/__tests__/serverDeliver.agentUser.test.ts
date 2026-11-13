// A team delivery with agents on their own OS user (CLAWBOO_AGENT_USER): the
// runtime's per-agent home is agent space, owned by the agent user, so the agent
// host makes it before the run starts.

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import type {
  Capabilities,
  RunHandle,
  RuntimeAdapter,
  RuntimeEvent,
  StartOpts,
  TaskHandle,
} from '@clawboo/executor'
import { createNudgeQueue, HUMAN_TURN } from '@clawboo/team-orchestration'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { setActiveAgentHost } from '../../agentUser/state'
import { startInProcessHost, type InProcessHost } from '../../agentUser/__tests__/inProcessHost'
import { getDb, resetDb } from '../../db'
import { runtimeIdentityHomePath } from '../../runtimes/identityHome'
import { createServerDeliver, type RunEntry } from '../serverDeliver'

const posix = process.platform !== 'win32'

/** A persistent per-identity home, as a native or Hermes agent has. */
const PERSISTENT_CAPS: Capabilities = {
  streaming: true,
  mcp: false,
  worktrees: false,
  resume: false,
  toolApproval: false,
  models: [],
  nativeHome: { scope: 'per-identity', persist: true },
}

function persistentAdapter(started: () => void): RuntimeAdapter {
  return {
    id: 'fake-native',
    participantKind: 'agent',
    capabilities: () => PERSISTENT_CAPS,
    async health() {
      return { ok: true }
    },
    async start(_t: TaskHandle, opts: StartOpts): Promise<RunHandle> {
      started()
      return { adapterId: 'fake-native', sessionKey: opts.sessionKey, runId: null }
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
  home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'deliver-agent-user-')))
  vi.stubEnv('HOME', home)
  vi.stubEnv('CLAWBOO_HOME', path.join(home, '.clawboo'))
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

describe.runIf(posix)('serverDeliver with agents on their own OS user', () => {
  it("makes the runtime's per-agent home through the agent host before the run", async () => {
    const db = getDb()
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

    let startCalls = 0
    const closed: string[] = []
    const deliver = createServerDeliver({
      db,
      teamId: 'T',
      mcpBaseUrl: null,
      nudge: createNudgeQueue(),
      abortMap: new Map<string, RunEntry>(),
      onEvent: async () => {},
      onSessionClosed: async (sk) => {
        closed.push(sk)
      },
      taskForSession: () => null,
      execForSession: () => null,
      stopGen: () => 0,
      leaderAgentId: () => 'leader',
      persistTurn: () => true,
      persistMeta: () => true,
      publishDelta: () => undefined,
      publishStatus: () => undefined,
      makeAdapterForAgent: () => persistentAdapter(() => (startCalls += 1)),
    })

    await deliver('agent:a1:team:T', 'a1', 'hello', HUMAN_TURN)
    await vi.waitFor(() => expect(startCalls).toBe(1))

    const homeDir = runtimeIdentityHomePath('fake-native', 'a1')
    expect(homeDir.startsWith(path.join(agentHome, 'runtimes', ''))).toBe(true)
    expect(made).toContain(homeDir)
    expect(fs.statSync(homeDir).mode & 0o777).toBe(0o700)
  })
})
