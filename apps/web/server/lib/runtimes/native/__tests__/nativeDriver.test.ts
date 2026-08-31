// What is allowed to appear in a person's 1:1 chat with a boo.
//
// One agent runs in several places at once, each with its own session key: the 1:1
// chat, a team room, a board task. Only the first is a conversation someone is
// looking at, and the other two already record their turns where they belong (the
// orchestrator persists a team turn under the team key; `executorRunner` writes a
// board task's report-up as a task comment). So the driver writes to the chat only
// when the run IS the chat. A boo working three board tasks in parallel would
// otherwise drop three replies into the chat, unprompted, with nothing in front of
// them. Drives a real Conversation with a SCRIPTED provider client + null MCP.

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

describe('native driver: what reaches the 1:1 chat', () => {
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
    // This suite OWNS its connection (createDb at a fixture path), so resetDb()
    // cannot reach it: that only evicts the getDb() memo. Windows refuses to
    // remove a directory that still holds an open file, so close it before the
    // rm. Mirrors the ownership rule in lib/db.ts. (#140)
    db.$client.close()
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

  it('writes the reply when the run IS the 1:1 chat', async () => {
    await runToResult({
      agentId: 'nat-solo',
      sessionKey: 'agent:nat-solo:native',
      message: 'do the thing',
    })
    expect(nativeRows('nat-solo')).toHaveLength(1)
  })

  it('stays out of the chat for a team run', async () => {
    // The orchestrator already persisted this turn under the team key.
    await runToResult({
      agentId: 'nat-team',
      sessionKey: 'agent:nat-team:team:T',
      message: 'do the thing',
    })
    expect(nativeRows('nat-team')).toHaveLength(0)
  })

  it('stays out of the chat for a board task', async () => {
    // Board work belongs to the board: the report-up lands as a task comment, and
    // the task drawer is where a person reads it. Landing it here instead puts an
    // unprompted reply in a chat nobody asked a question in, and a boo assigned
    // several tasks lands one per task.
    await runToResult({
      agentId: 'nat-task',
      sessionKey: 'runtime:clawboo-native:task:t1',
      message: 'do the thing',
    })
    expect(nativeRows('nat-task')).toHaveLength(0)
  })

  it('stays out of the chat for any other shape a run may be given', async () => {
    // The rule recognises the chat key rather than ruling out the shapes we happen
    // to know about, so a key invented later cannot leak by default.
    await runToResult({
      agentId: 'nat-x',
      sessionKey: 'teamchat:room:R',
      message: 'do the thing',
    })
    expect(nativeRows('nat-x')).toHaveLength(0)
  })
})
