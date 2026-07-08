// driveAgentChat test — the 1:1 native conversational runner. Uses the `makeAdapter`
// seam (a scripted fake adapter; the real driver factory + home mutex are bypassed).
// Asserts: a native agent streams its text deltas to the per-session chatDeltaBus and
// terminates on `done`; `isNativeChatAgent` gates by runtime; `stopAgentChat` aborts
// the in-flight run; and a non-native agent (no injected adapter) never runs.

import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { agents, createDb, getSetting, setSetting, type ClawbooDb } from '@clawboo/db'
import type {
  Capabilities,
  RunHandle,
  RuntimeAdapter,
  RuntimeEvent,
  StartOpts,
  TaskHandle,
} from '@clawboo/executor'

import { getDbPath } from '../../db'
import { subscribeChatDelta } from '../../teamChat/chatDeltaBus'
import { chatHistoryDELETE } from '../../../api/chatHistory'
import {
  driveAgentChat,
  isNativeChatAgent,
  nativeChatSessionKey,
  nativeChatSessionSettingKey,
  stopAgentChat,
} from '../driveAgentChat'

const CAPS: Capabilities = {
  streaming: true,
  mcp: false,
  worktrees: false,
  resume: false,
  toolApproval: false,
  models: [],
}

const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 0))
function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void
  const promise = new Promise<void>((r) => (resolve = r))
  return { promise, resolve }
}
const base = (sk: string, seq: number) => ({ runId: sk, sessionId: sk, ts: seq, seq })

class FakeAdapter implements RuntimeAdapter {
  readonly participantKind = 'agent' as const
  readonly id = 'fake-native'
  startCalls = 0
  aborted = 0
  constructor(private readonly gen: (run: RunHandle) => AsyncIterable<RuntimeEvent>) {}
  capabilities(): Capabilities {
    return CAPS
  }
  async health(): Promise<{ ok: boolean }> {
    return { ok: true }
  }
  async start(_t: TaskHandle, opts: StartOpts): Promise<RunHandle> {
    this.startCalls += 1
    return { adapterId: this.id, sessionKey: opts.sessionKey, runId: null }
  }
  events(run: RunHandle): AsyncIterable<RuntimeEvent> {
    return this.gen(run)
  }
  async abort(): Promise<void> {
    this.aborted += 1
  }
  async setModel(): Promise<void> {}
  async writeContext(): Promise<void> {}
}

describe('driveAgentChat (1:1 native conversational runner)', () => {
  let home: string
  let prevHome: string | undefined
  let db: ClawbooDb

  beforeEach(async () => {
    home = await mkdtemp(path.join(os.tmpdir(), 'clawboo-agentchat-'))
    prevHome = process.env['HOME']
    process.env['HOME'] = home
    db = createDb(getDbPath())
  })
  afterEach(async () => {
    if (prevHome === undefined) delete process.env['HOME']
    else process.env['HOME'] = prevHome
    await rm(home, { recursive: true, force: true })
  })

  function seedAgent(id: string, runtime: string): void {
    const now = Date.now()
    db.insert(agents)
      .values({
        id,
        name: id,
        gatewayId: id,
        sourceId: runtime,
        sourceAgentId: id,
        runtime,
        status: 'idle',
        teamId: null,
        createdAt: now,
        updatedAt: now,
      })
      .run()
  }

  it('isNativeChatAgent gates by runtime', () => {
    seedAgent('native-x', 'clawboo-native')
    seedAgent('oc-x', 'openclaw')
    expect(isNativeChatAgent(db, 'native-x')).toBe(true)
    expect(isNativeChatAgent(db, 'oc-x')).toBe(false)
    expect(isNativeChatAgent(db, 'missing')).toBe(false)
  })

  it('streams text deltas to the per-session bus + terminates on done', async () => {
    seedAgent('native-x', 'clawboo-native')
    const sk = nativeChatSessionKey('native-x')
    const deltas: string[] = []
    const unsub = subscribeChatDelta(sk, (d) => deltas.push(d.text))

    const adapter = new FakeAdapter(
      (run) =>
        (async function* () {
          yield { ...base(run.sessionKey, 1), kind: 'text-delta', text: 'Hi ', channel: 'assistant' }
          yield { ...base(run.sessionKey, 2), kind: 'text-delta', text: 'there', channel: 'assistant' }
          yield { ...base(run.sessionKey, 3), kind: 'done', reason: 'success', summary: 'Hi there' }
        })(),
    )

    await driveAgentChat({
      db,
      agentId: 'native-x',
      message: 'hello',
      mcpBaseUrl: null,
      makeAdapter: () => adapter,
    })

    expect(adapter.startCalls).toBe(1)
    // The bus carries the RUNNING accumulation (REPLACE semantics).
    expect(deltas).toEqual(['Hi ', 'Hi there'])
    unsub()
  })

  it('reasoning-channel deltas are NOT streamed to chat', async () => {
    seedAgent('native-x', 'clawboo-native')
    const sk = nativeChatSessionKey('native-x')
    const deltas: string[] = []
    const unsub = subscribeChatDelta(sk, (d) => deltas.push(d.text))
    const adapter = new FakeAdapter(
      (run) =>
        (async function* () {
          yield { ...base(run.sessionKey, 1), kind: 'text-delta', text: 'thinking…', channel: 'reasoning' }
          yield { ...base(run.sessionKey, 2), kind: 'text-delta', text: 'answer', channel: 'assistant' }
          yield { ...base(run.sessionKey, 3), kind: 'done', reason: 'success', summary: 'answer' }
        })(),
    )
    await driveAgentChat({ db, agentId: 'native-x', message: 'q', mcpBaseUrl: null, makeAdapter: () => adapter })
    expect(deltas).toEqual(['answer'])
    unsub()
  })

  it('stopAgentChat aborts the in-flight run', async () => {
    seedAgent('native-x', 'clawboo-native')
    const gate = deferred()
    const adapter = new FakeAdapter(
      (run) =>
        (async function* () {
          yield { ...base(run.sessionKey, 1), kind: 'text-delta', text: 'x', channel: 'assistant' }
          await gate.promise
          yield { ...base(run.sessionKey, 2), kind: 'done', reason: 'success', summary: 'x' }
        })(),
    )
    const running = driveAgentChat({
      db,
      agentId: 'native-x',
      message: 'hello',
      mcpBaseUrl: null,
      makeAdapter: () => adapter,
    })
    await tick() // let start populate the abort map
    await stopAgentChat('native-x')
    expect(adapter.aborted).toBe(1)
    gate.resolve()
    await running
  })

  it('a non-native agent (no injected adapter) never runs', async () => {
    seedAgent('oc-x', 'openclaw')
    // No makeAdapter → the real path runs the runtime guard: openclaw is not driven
    // here (it uses the Gateway path), so this resolves without starting anything.
    await expect(
      driveAgentChat({ db, agentId: 'oc-x', message: 'hello', mcpBaseUrl: null }),
    ).resolves.toBeUndefined()
  })

  it('deleting a native chat history clears the resume pointer (/reset → fresh conversation)', async () => {
    const key = nativeChatSessionSettingKey('native-x')
    setSetting(db, key, 'native-abc123')
    expect(getSetting(db, key)).toBe('native-abc123')
    // chatHistoryDELETE opens its own createDb(getDbPath()) — the SAME sandbox file.
    const req = { query: { sessionKey: nativeChatSessionKey('native-x') } } as unknown as Parameters<
      typeof chatHistoryDELETE
    >[0]
    const res = {
      json: () => res,
      status: () => res,
    } as unknown as Parameters<typeof chatHistoryDELETE>[1]
    await chatHistoryDELETE(req, res)
    expect(getSetting(db, key)).toBe('') // pointer cleared → next turn starts fresh
  })

  it('a non-native session-key DELETE leaves native pointers untouched', async () => {
    const key = nativeChatSessionSettingKey('native-x')
    setSetting(db, key, 'native-keep')
    const req = { query: { sessionKey: 'agent:native-x:main' } } as unknown as Parameters<
      typeof chatHistoryDELETE
    >[0]
    const res = { json: () => res, status: () => res } as unknown as Parameters<
      typeof chatHistoryDELETE
    >[1]
    await chatHistoryDELETE(req, res)
    expect(getSetting(db, key)).toBe('native-keep')
  })
})
