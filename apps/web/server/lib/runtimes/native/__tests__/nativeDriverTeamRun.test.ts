// The native driver tells the MCP bridge whether the run is a team run.
//
// A team run's Tasks server serves no claim, assign, release, status or unblock
// tools, and `block_task` only for the agent's own task: the team engine moves
// those cards itself. The only thing that tells the bridge is the `teamRun` flag
// the driver derives from the session key, so dropping it would hand every native
// team run the full board write surface again, and every other test here passes
// `mcp: null`, which never reaches the bridge.

import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { NativeEvent } from '@clawboo/adapter-native'
import { createDb, type ClawbooDb } from '@clawboo/db'
import type { StartOpts } from '@clawboo/executor'

import type { RuntimeRunContext } from '../../types'
import type { ProviderStreamEvent } from '../providers/types'
import type { RoutedProviderClient } from '../routeCall'

const bridgeCalls: Array<{ teamRun?: boolean }> = []
vi.mock('../mcpBridge', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../mcpBridge')>()),
  connectMcpBridge: async (opts: { teamRun?: boolean }) => {
    bridgeCalls.push(opts)
    return null
  },
}))

const { createNativeDriver } = await import('../nativeDriver')

function textClient(text: string): RoutedProviderClient {
  return {
    activeModel: () => 'claude-haiku-4-5',
    activeProvider: () => 'anthropic',
    setModel: () => {},
    async *streamTurn() {
      const evs: ProviderStreamEvent[] = [
        { type: 'text', delta: text },
        { type: 'usage', inputTokens: 10, outputTokens: 5 },
      ]
      for (const ev of evs) yield ev
    },
  }
}

describe('native driver: the team-run flag the MCP bridge gets', () => {
  let sandbox: string
  let cwd: string
  let db: ClawbooDb

  beforeEach(async () => {
    bridgeCalls.length = 0
    sandbox = await mkdtemp(path.join(os.tmpdir(), 'clawboo-native-teamrun-'))
    cwd = path.join(sandbox, 'work')
    await mkdir(cwd, { recursive: true })
    db = createDb(path.join(sandbox, 'test.db'))
  })
  afterEach(async () => {
    // This suite owns its connection: close it before removing the folder.
    db.$client.close()
    await rm(sandbox, { recursive: true, force: true })
  })

  async function run(opts: StartOpts): Promise<void> {
    const ctx: RuntimeRunContext = { cwd, homeDir: path.join(sandbox, 'home') }
    const driver = createNativeDriver(opts, ctx, { client: textClient('Done.'), db })
    await new Promise<void>((resolve) => {
      driver.onEvent((ev: NativeEvent) => {
        if (ev.type === 'result') resolve()
      })
      void driver.start()
    })
  }

  it('marks a team run', async () => {
    await run({ agentId: 'nat', sessionKey: 'agent:nat:team:T', message: 'do it' })
    expect(bridgeCalls).toHaveLength(1)
    expect(bridgeCalls[0]!.teamRun).toBe(true)
  })

  it('does not mark the 1:1 chat', async () => {
    await run({ agentId: 'nat', sessionKey: 'agent:nat:native', message: 'do it' })
    expect(bridgeCalls).toHaveLength(1)
    expect(bridgeCalls[0]!.teamRun).toBe(false)
  })
})
