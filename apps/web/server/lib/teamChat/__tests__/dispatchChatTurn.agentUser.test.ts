// A team-chat turn with agents on their own OS user (CLAWBOO_AGENT_USER): the
// runtime's per-agent home and the team folder are agent space, owned by the
// agent user, so the agent host makes them before the run starts.

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { createDb, resolveRoomForTeam } from '@clawboo/db'
import type { RunHandle, RuntimeAdapter, RuntimeEvent } from '@clawboo/executor'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { setActiveAgentHost } from '../../agentUser/state'
import { startInProcessHost, type InProcessHost } from '../../agentUser/__tests__/inProcessHost'
import type { RuntimeRunContext } from '../../runtimes/types'
import { dispatchChatTurn } from '../dispatchChatTurn'

const posix = process.platform !== 'win32'

function adapter(seen: RuntimeRunContext[]): (ctx: RuntimeRunContext) => RuntimeAdapter {
  return (ctx): RuntimeAdapter => {
    seen.push(ctx)
    return {
      id: 'hermes',
      participantKind: 'agent',
      capabilities: () => ({
        streaming: true,
        mcp: true,
        worktrees: false,
        resume: true,
        toolApproval: false,
        models: [],
      }),
      health: async () => ({ ok: true }),
      start: async (_t, o): Promise<RunHandle> => ({
        adapterId: 'hermes',
        sessionKey: o.sessionKey,
        runId: null,
      }),
      events: async function* (): AsyncIterable<RuntimeEvent> {
        yield {
          runId: 'run',
          sessionId: 'sess',
          ts: 0,
          seq: 0,
          kind: 'done',
          reason: 'success',
          summary: 'done',
        } as RuntimeEvent
      },
      abort: async () => {},
      setModel: async () => {},
      writeContext: async () => {},
      dispose: async () => {},
    }
  }
}

let tmp: string
let active: InProcessHost | null = null

beforeEach(() => {
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'chat-turn-agent-')))
})

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
  setActiveAgentHost(null)
  active?.client.close()
  active = null
  fs.rmSync(tmp, { recursive: true, force: true })
})

describe.runIf(posix)('dispatchChatTurn with agents on their own OS user', () => {
  it("makes the runtime's home and the team folder through the agent host", async () => {
    vi.stubEnv('CLAWBOO_AGENT_USER', 'clawboo-agent')
    const h = startInProcessHost()
    active = h
    const hello = await h.client.waitForHello()
    setActiveAgentHost({
      client: h.client,
      hello: { ...hello, home: tmp },
      config: { user: 'clawboo-agent', switch: 'sudo', socket: null },
    })
    const made: string[] = []
    const request = h.client.request.bind(h.client)
    vi.spyOn(h.client, 'request').mockImplementation((r, opts) => {
      if (r.op === 'fs.mkdir') made.push(r.path)
      return request(r, opts)
    })

    const homeDir = path.join(tmp, 'runtimes', 'hermes', 'h1')
    const cwd = path.join(tmp, 'work', 'teams', 'T')
    const seen: RuntimeRunContext[] = []
    await dispatchChatTurn(
      {
        db: createDb(':memory:'),
        participant: { agentId: 'h1', runtime: 'hermes', isLeader: true },
        roomId: resolveRoomForTeam('T'),
        teamId: 'T',
        makeAdapter: adapter(seen),
        homeDir,
        cwd,
      },
      1,
    )

    expect(made).toEqual([homeDir, cwd])
    expect(fs.statSync(homeDir).mode & 0o777).toBe(0o700)
    expect(fs.statSync(cwd).mode & 0o777).toBe(0o700)
    expect(seen[0]).toMatchObject({ homeDir, cwd })
  })
})
