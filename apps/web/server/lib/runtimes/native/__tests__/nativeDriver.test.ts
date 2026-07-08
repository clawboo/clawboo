// Native driver de-double: the driver's `agent:<id>:native` chat write is gated OFF
// for a team-chat run (sessionKey `agent:<id>:team:<teamId>`), because the server
// orchestrator already persists that turn under the team key. Without the gate a
// team turn would leak into the agent's 1:1 ChatPanel history (a live surface).
// Drives a real Conversation with a SCRIPTED provider client + null MCP.

import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import type { NativeEvent } from '@clawboo/adapter-native'
import { chatMessages, createDb, type ClawbooDb } from '@clawboo/db'
import type { StartOpts } from '@clawboo/executor'
import { eq } from 'drizzle-orm'

import type { RuntimeRunContext } from '../../types'
import { createNativeDriver } from '../nativeDriver'
import type { ProviderStreamEvent } from '../providers/types'
import type { RoutedProviderClient } from '../routeCall'

/** A scripted text-only provider client: one turn that emits `text` then usage. */
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

describe('native driver — :native chat write de-double for team runs', () => {
  let sandbox: string
  let cwd: string
  let db: ClawbooDb

  beforeEach(async () => {
    sandbox = await mkdtemp(path.join(os.tmpdir(), 'clawboo-native-dedupe-'))
    cwd = path.join(sandbox, 'work')
    await mkdir(cwd, { recursive: true })
    db = createDb(path.join(sandbox, 'test.db'))
  })
  afterEach(async () => {
    await rm(sandbox, { recursive: true, force: true })
  })

  function nativeRows(agentId: string): unknown[] {
    return db
      .select()
      .from(chatMessages)
      .where(eq(chatMessages.sessionKey, `agent:${agentId}:native`))
      .all()
  }

  async function runToResult(opts: StartOpts): Promise<void> {
    const ctx: RuntimeRunContext = { cwd, homeDir: path.join(sandbox, 'home') }
    const driver = createNativeDriver(opts, ctx, { client: textClient('All done.'), mcp: null, db })
    await new Promise<void>((resolve) => {
      driver.onEvent((ev: NativeEvent) => {
        if (ev.type === 'result') resolve()
      })
      void driver.start()
    })
  }

  it('SKIPS the :native write for a team-scoped sessionKey', async () => {
    await runToResult({
      agentId: 'nat-team',
      sessionKey: 'agent:nat-team:team:T',
      message: 'do the thing',
    })
    expect(nativeRows('nat-team')).toHaveLength(0)
  })

  it('KEEPS the :native write for a non-team sessionKey (1:1 / board task)', async () => {
    await runToResult({
      agentId: 'nat-solo',
      sessionKey: 'runtime:clawboo-native:task:t1',
      message: 'do the thing',
    })
    expect(nativeRows('nat-solo')).toHaveLength(1)
  })
})
