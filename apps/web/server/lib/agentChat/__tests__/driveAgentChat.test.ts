// driveAgentChat test: the 1:1 conversational runner for server-run agents. Uses
// the `makeAdapter` seam (a scripted fake adapter; the real driver factory is
// bypassed). Asserts: a native agent streams its text deltas to the per-session
// chatDeltaBus and terminates on `done`; `isServerChatAgent` gates by runtime;
// `stopAgentChat` aborts the in-flight run; an OpenClaw agent (no injected adapter)
// never runs; and a Claude Code / Codex / Hermes agent chats under its own 1:1 key,
// gets its reply committed, keeps its session across turns and carries its persona.

import { mkdir, mkdtemp, rm, stat, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  agents,
  chatMessages,
  teams,
  getSetting,
  setSetting,
  SqliteMemoryStore,
  type ClawbooDb,
} from '@clawboo/db'
import { DEFAULT_AGENT_CONFIG } from '@clawboo/adapter-native'
import { eq } from 'drizzle-orm'
import type {
  Capabilities,
  RunHandle,
  RuntimeAdapter,
  RuntimeEvent,
  StartOpts,
  TaskHandle,
} from '@clawboo/executor'

import { writeRuntimeAgentFile } from '../../agentSource/runtimeAgentFileStore'
import { getDb, resetDb } from '../../db'
import { saveAgentConfig } from '../../runtimes/native/agentConfigStore'
import { teamWorkdirPath } from '../../runtimes/teamWorkdir'
import type { RuntimeRunContext } from '../../runtimes/types'
import { subscribeAgentStatus } from '../../teamChat/agentStatusBus'
import { subscribeChatDelta } from '../../teamChat/chatDeltaBus'
import { chatHistoryDELETE, chatHistoryRESETCONTEXT } from '../../../api/chatHistory'
import {
  directChatSessionKey,
  driveAgentChat,
  isServerChatAgent,
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
  /** Every StartOpts this adapter was handed, so a test can read what was injected. */
  starts: StartOpts[] = []
  /** Fired on abort, so a scripted stream can end the way a real one does. */
  onAbort: (() => void) | null = null
  constructor(private readonly gen: (run: RunHandle) => AsyncIterable<RuntimeEvent>) {}
  capabilities(): Capabilities {
    return CAPS
  }
  async health(): Promise<{ ok: boolean }> {
    return { ok: true }
  }
  async start(_t: TaskHandle, opts: StartOpts): Promise<RunHandle> {
    this.startCalls += 1
    this.starts.push(opts)
    return { adapterId: this.id, sessionKey: opts.sessionKey, runId: null }
  }
  events(run: RunHandle): AsyncIterable<RuntimeEvent> {
    return this.gen(run)
  }
  async abort(): Promise<void> {
    this.aborted += 1
    this.onAbort?.()
  }
  async setModel(): Promise<void> {}
  async writeContext(): Promise<void> {}
}

/** A fake that resumes, like Claude Code, Codex, Hermes and native: its codec hands
 *  back the session id the run "saved". */
class ResumableFakeAdapter extends FakeAdapter {
  constructor(
    gen: (run: RunHandle) => AsyncIterable<RuntimeEvent>,
    private readonly savedSessionId: string,
  ) {
    super(gen)
  }
  override capabilities(): Capabilities {
    return { ...CAPS, resume: true }
  }
  readonly sessionCodec = {
    serialize: async (run: RunHandle): Promise<string> =>
      JSON.stringify({ sessionKey: run.sessionKey, sessionId: this.savedSessionId }),
    restore: async (): Promise<RunHandle> => ({ adapterId: 'fake', sessionKey: '', runId: null }),
  }
}

/** Wait until the drain has started the run and registered it for Stop. A turn
 *  creates its working folder first, so a single tick is not enough under load. */
async function untilRunning(adapter: FakeAdapter): Promise<void> {
  await vi.waitFor(() => expect(adapter.startCalls).toBe(1))
  await tick()
}

describe('driveAgentChat (1:1 native conversational runner)', () => {
  let home: string
  let prevHome: string | undefined
  let db: ClawbooDb

  beforeEach(async () => {
    home = await mkdtemp(path.join(os.tmpdir(), 'clawboo-agentchat-'))
    prevHome = process.env['HOME']
    process.env['HOME'] = home
    db = getDb()
  })
  afterEach(async () => {
    // Close BEFORE removing the dir: Windows refuses to remove a directory
    // that still holds an open file. (#140)
    resetDb()
    if (prevHome === undefined) delete process.env['HOME']
    else process.env['HOME'] = prevHome
    await rm(home, { recursive: true, force: true })
  })

  function seedAgent(id: string, runtime: string, teamId: string | null = null): void {
    const now = Date.now()
    if (teamId)
      db.insert(teams)
        .values({ id: teamId, name: teamId, icon: 'T', color: '#fff', createdAt: 0, updatedAt: 0 })
        .onConflictDoNothing()
        .run()
    db.insert(agents)
      .values({
        id,
        name: id,
        gatewayId: id,
        sourceId: runtime,
        sourceAgentId: id,
        runtime,
        status: 'idle',
        teamId,
        createdAt: now,
        updatedAt: now,
      })
      .run()
  }

  it('isServerChatAgent gates by runtime: every server-run runtime, never OpenClaw', () => {
    seedAgent('native-x', 'clawboo-native')
    seedAgent('cc-x', 'claude-code')
    seedAgent('codex-x', 'codex')
    seedAgent('hermes-x', 'hermes')
    seedAgent('oc-x', 'openclaw')
    expect(isServerChatAgent(db, 'native-x')).toBe(true)
    expect(isServerChatAgent(db, 'cc-x')).toBe(true)
    expect(isServerChatAgent(db, 'codex-x')).toBe(true)
    expect(isServerChatAgent(db, 'hermes-x')).toBe(true)
    expect(isServerChatAgent(db, 'oc-x')).toBe(false)
    expect(isServerChatAgent(db, 'missing')).toBe(false)
  })

  it('streams text deltas to the per-session bus + terminates on done', async () => {
    seedAgent('native-x', 'clawboo-native')
    const sk = nativeChatSessionKey('native-x')
    const deltas: string[] = []
    const unsub = subscribeChatDelta(sk, (d) => deltas.push(d.text))

    const adapter = new FakeAdapter((run) =>
      (async function* () {
        yield { ...base(run.sessionKey, 1), kind: 'text-delta', text: 'Hi ', channel: 'assistant' }
        yield {
          ...base(run.sessionKey, 2),
          kind: 'text-delta',
          text: 'there',
          channel: 'assistant',
        }
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
    const adapter = new FakeAdapter((run) =>
      (async function* () {
        yield {
          ...base(run.sessionKey, 1),
          kind: 'text-delta',
          text: 'thinking…',
          channel: 'reasoning',
        }
        yield {
          ...base(run.sessionKey, 2),
          kind: 'text-delta',
          text: 'answer',
          channel: 'assistant',
        }
        yield { ...base(run.sessionKey, 3), kind: 'done', reason: 'success', summary: 'answer' }
      })(),
    )
    await driveAgentChat({
      db,
      agentId: 'native-x',
      message: 'q',
      mcpBaseUrl: null,
      makeAdapter: () => adapter,
    })
    expect(deltas).toEqual(['answer'])
    unsub()
  })

  it('stopAgentChat aborts the in-flight run', async () => {
    seedAgent('native-x', 'clawboo-native')
    const gate = deferred()
    const adapter = new FakeAdapter((run) =>
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
    // The gate opens whatever happens, so a failure here cannot leave the run
    // holding this agent's lock for the tests after it.
    try {
      await untilRunning(adapter)
      await stopAgentChat('native-x')
      expect(adapter.aborted).toBe(1)
    } finally {
      gate.resolve()
      await running
    }
  })

  it('a run that fails BEFORE any text (no provider key) persists a VISIBLE meta with the reason', async () => {
    // The classic silent non-responder: keyless native → the provider router
    // throws before a single token streams. The user must SEE why.
    seedAgent('native-x', 'clawboo-native')
    const sk = nativeChatSessionKey('native-x')
    const rows = (): Array<{ kind: string; text: string }> =>
      db
        .select()
        .from(chatMessages)
        .where(eq(chatMessages.sessionKey, sk))
        .all()
        .map((r) => JSON.parse(r.data as string) as { kind: string; text: string })

    const keyless = new FakeAdapter((run) =>
      (async function* () {
        yield {
          ...base(run.sessionKey, 1),
          kind: 'error',
          code: 'auth',
          message: 'no provider key available (checked ANTHROPIC_API_KEY and fallbacks)',
          fatal: true,
        }
      })(),
    )
    await driveAgentChat({
      db,
      agentId: 'native-x',
      message: 'q',
      mcpBaseUrl: null,
      makeAdapter: () => keyless,
    })
    const meta = rows().find((r) => r.kind === 'meta')
    expect(meta?.text).toMatch(/no provider key/i)
    expect(meta?.text).toMatch(/Settings/)
  })

  it("an Ollama agent's missing-model failure names the pull command", async () => {
    // The provider comes from the agent's own config: a model Ollama never pulled
    // is fixed with `ollama pull`, which is not the fix on any other provider.
    seedAgent('native-ollama', 'clawboo-native')
    saveAgentConfig(db, {
      ...DEFAULT_AGENT_CONFIG,
      id: 'native-ollama',
      name: 'Local',
      primaryProvider: 'ollama',
      primaryModel: 'llama3.2',
      envVar: 'OLLAMA_BASE_URL',
      createdAt: 0,
      updatedAt: 0,
    })
    const sk = nativeChatSessionKey('native-ollama')
    const missing = new FakeAdapter((run) =>
      (async function* () {
        yield {
          ...base(run.sessionKey, 1),
          kind: 'error',
          code: 'bad_request',
          message: "404 model 'llama3.2' not found",
          fatal: true,
        }
      })(),
    )
    await driveAgentChat({
      db,
      agentId: 'native-ollama',
      message: 'q',
      mcpBaseUrl: null,
      makeAdapter: () => missing,
    })
    const meta = db
      .select()
      .from(chatMessages)
      .where(eq(chatMessages.sessionKey, sk))
      .all()
      .map((r) => JSON.parse(r.data as string) as { kind: string; text: string })
      .find((r) => r.kind === 'meta')
    expect(meta?.text).toContain('"ollama pull llama3.2"')
  })

  it('a turn that DIES mid-reply commits the watched partial text (survives reload); a user Stop clears instead', async () => {
    seedAgent('native-x', 'clawboo-native')
    const sk = nativeChatSessionKey('native-x')
    const rows = (): string[] =>
      db
        .select()
        .from(chatMessages)
        .where(eq(chatMessages.sessionKey, sk))
        .all()
        .map((r) => (JSON.parse(r.data as string) as { text: string }).text)

    // Fatal provider error after streaming a partial → the partial is PERSISTED
    // (the SSE tail replays it as a committed frame, which clears the client card).
    const dying = new FakeAdapter((run) =>
      (async function* () {
        yield {
          ...base(run.sessionKey, 1),
          kind: 'text-delta',
          text: 'partial reply',
          channel: 'assistant',
        }
        yield {
          ...base(run.sessionKey, 2),
          kind: 'error',
          code: 'provider_down',
          message: 'boom',
          fatal: true,
        }
      })(),
    )
    await driveAgentChat({
      db,
      agentId: 'native-x',
      message: 'q',
      mcpBaseUrl: null,
      makeAdapter: () => dying,
    })
    expect(rows()).toContain('partial reply')

    // A user Stop (`done:aborted`) stays DISCARDED (the Gateway 1:1 convention; the
    // client cleared optimistically) — a clearing delta rides the bus instead.
    const deltas: string[] = []
    const unsub = subscribeChatDelta(sk, (d) => deltas.push(d.text))
    const stopped = new FakeAdapter((run) =>
      (async function* () {
        yield {
          ...base(run.sessionKey, 1),
          kind: 'text-delta',
          text: 'cut short',
          channel: 'assistant',
        }
        yield { ...base(run.sessionKey, 2), kind: 'done', reason: 'aborted', summary: '' }
      })(),
    )
    await driveAgentChat({
      db,
      agentId: 'native-x',
      message: 'q2',
      mcpBaseUrl: null,
      makeAdapter: () => stopped,
    })
    expect(rows()).not.toContain('cut short')
    expect(deltas).toEqual(['cut short', ''])
    unsub()
  })

  it('a non-native agent (no injected adapter) never runs', async () => {
    seedAgent('oc-x', 'openclaw')
    // No makeAdapter → the real path runs the runtime guard: openclaw is not driven
    // here (it uses the Gateway path), so this resolves without starting anything.
    await expect(
      driveAgentChat({ db, agentId: 'oc-x', message: 'hello', mcpBaseUrl: null }),
    ).resolves.toBeUndefined()
  })

  it('deleting a native chat history clears the resume pointer (a deleted agent remembers nothing)', async () => {
    const key = nativeChatSessionSettingKey('native-x')
    setSetting(db, key, 'native-abc123')
    expect(getSetting(db, key)).toBe('native-abc123')
    // chatHistoryDELETE opens its own getDb() — the SAME sandbox file.
    const req = {
      query: { sessionKey: nativeChatSessionKey('native-x') },
    } as unknown as Parameters<typeof chatHistoryDELETE>[0]
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

  it('hands a boo its own notes on the first turn after a reset, and only then', async () => {
    // The turn right after a reset comes from a boo with its character intact and no
    // idea who it is talking to. `context` rides turn ONE only, which is exactly the
    // lifetime a reminder wants.
    seedAgent('native-x', 'clawboo-native')
    await new SqliteMemoryStore(db).saveFact({
      title: 'The user',
      content: 'Their name is Sanju.',
      scope: { agentId: 'native-x' },
    })

    const fresh = new FakeAdapter((run) =>
      (async function* () {
        yield { ...base(run.sessionKey, 1), kind: 'done', reason: 'success', summary: 'ok' }
      })(),
    )
    await driveAgentChat({
      db,
      agentId: 'native-x',
      message: 'hello',
      mcpBaseUrl: null,
      makeAdapter: () => fresh,
    })
    expect(fresh.starts[0]?.context).toContain('Their name is Sanju')

    // A CONTINUING turn already has the thread, so the reminder must not repeat.
    setSetting(db, nativeChatSessionSettingKey('native-x'), 'native-abc123')
    const continuing = new FakeAdapter((run) =>
      (async function* () {
        yield { ...base(run.sessionKey, 1), kind: 'done', reason: 'success', summary: 'ok' }
      })(),
    )
    await driveAgentChat({
      db,
      agentId: 'native-x',
      message: 'and again',
      mcpBaseUrl: null,
      makeAdapter: () => continuing,
    })
    expect(continuing.starts[0]?.context).toBeUndefined()
  })

  it('starts blank when the boo has saved nothing', async () => {
    seedAgent('native-empty', 'clawboo-native')
    const adapter = new FakeAdapter((run) =>
      (async function* () {
        yield { ...base(run.sessionKey, 1), kind: 'done', reason: 'success', summary: 'ok' }
      })(),
    )
    await driveAgentChat({
      db,
      agentId: 'native-empty',
      message: 'hello',
      mcpBaseUrl: null,
      makeAdapter: () => adapter,
    })
    expect(adapter.starts[0]?.context).toBeUndefined()
  })
  // ── Claude Code, Codex and Hermes: the 1:1 chat that used to need a Gateway ──

  function rowsFor(sk: string): Array<{ kind: string; role: string; text: string }> {
    return db
      .select()
      .from(chatMessages)
      .where(eq(chatMessages.sessionKey, sk))
      .all()
      .map((r) => JSON.parse(r.data as string) as { kind: string; role: string; text: string })
  }

  it('a Claude Code turn streams under its own 1:1 key and the drain commits the reply', async () => {
    seedAgent('cc-x', 'claude-code')
    const sk = directChatSessionKey('cc-x', 'claude-code')
    expect(sk).toBe('agent:cc-x:claude-code')
    const deltas: string[] = []
    const statuses: string[] = []
    const unsubDelta = subscribeChatDelta(sk, (d) => deltas.push(d.text))
    const unsubStatus = subscribeAgentStatus(sk, (u) => statuses.push(u.status))

    // Cumulative deltas, the way a coding runtime reports its running text.
    const adapter = new FakeAdapter((run) =>
      (async function* () {
        yield { ...base(run.sessionKey, 1), kind: 'text-delta', text: 'Hel', channel: 'assistant' }
        yield {
          ...base(run.sessionKey, 2),
          kind: 'text-delta',
          text: 'Hello there',
          channel: 'assistant',
        }
        yield { ...base(run.sessionKey, 3), kind: 'done', reason: 'success', summary: 'there' }
      })(),
    )
    await driveAgentChat({
      db,
      agentId: 'cc-x',
      message: 'hi',
      mcpBaseUrl: null,
      makeAdapter: () => adapter,
    })

    expect(adapter.starts[0]?.sessionKey).toBe(sk)
    expect(deltas).toEqual(['Hel', 'Hello there'])
    // The streamed text is what is committed, not the last turn's summary.
    expect(rowsFor(sk).map((r) => [r.kind, r.text])).toEqual([['assistant', 'Hello there']])
    expect(rowsFor(nativeChatSessionKey('cc-x'))).toEqual([])
    expect(statuses).toEqual(['running', 'idle'])
    unsubDelta()
    unsubStatus()
  })

  it('a Hermes reply that arrives in one piece is committed from its summary', async () => {
    seedAgent('hermes-x', 'hermes')
    const sk = directChatSessionKey('hermes-x', 'hermes')
    const adapter = new FakeAdapter((run) =>
      (async function* () {
        yield { ...base(run.sessionKey, 1), kind: 'done', reason: 'success', summary: 'All done.' }
      })(),
    )
    await driveAgentChat({
      db,
      agentId: 'hermes-x',
      message: 'q',
      mcpBaseUrl: null,
      makeAdapter: () => adapter,
    })
    expect(rowsFor(sk).map((r) => r.text)).toEqual(['All done.'])
  })

  it('a queued turn resumes the session the turn ahead of it just saved', async () => {
    // The pointer is read under the per-agent lock, so the second message does not
    // resume (or re-fetch memory for) the stale session both saw when they were sent.
    seedAgent('codex-x', 'codex')
    await new SqliteMemoryStore(db).saveFact({
      title: 'The user',
      content: 'Their name is Sanju.',
      scope: { agentId: 'codex-x' },
    })
    const order: string[] = []
    const gate = deferred()
    const first = new ResumableFakeAdapter(
      (run) =>
        (async function* () {
          order.push('first:start')
          await gate.promise
          // Before the yield: the drain stops pulling once it sees the terminal.
          order.push('first:done')
          yield { ...base(run.sessionKey, 1), kind: 'done', reason: 'success', summary: 'one' }
        })(),
      'thread-1',
    )
    const second = new ResumableFakeAdapter(
      (run) =>
        (async function* () {
          order.push('second:start')
          yield { ...base(run.sessionKey, 1), kind: 'done', reason: 'success', summary: 'two' }
        })(),
      'thread-2',
    )
    const adapters = [first, second]
    const make = (): RuntimeAdapter => adapters.shift()!
    const one = driveAgentChat({
      db,
      agentId: 'codex-x',
      message: 'a',
      mcpBaseUrl: null,
      makeAdapter: make,
    })
    let two: Promise<void> = Promise.resolve()
    try {
      await vi.waitFor(() => expect(order).toEqual(['first:start']))
      two = driveAgentChat({
        db,
        agentId: 'codex-x',
        message: 'b',
        mcpBaseUrl: null,
        makeAdapter: make,
      })
      await tick()
      expect(order).toEqual(['first:start'])
    } finally {
      gate.resolve()
    }
    await Promise.all([one, two])

    expect(order[0]).toBe('first:start')
    expect(order).toContain('second:start')
    expect(order.indexOf('second:start')).toBeGreaterThan(order.indexOf('first:done'))
    expect(first.starts[0]?.context).toContain('Their name is Sanju')
    expect(second.starts[0]?.context).toBeUndefined()
    expect(getSetting(db, nativeChatSessionSettingKey('codex-x'))).toBe('thread-2')
  })

  it("a coding runtime's persona rides every turn, resumed or not", async () => {
    seedAgent('cc-p', 'claude-code')
    writeRuntimeAgentFile(db, 'cc-p', 'SOUL.md', 'Speak plainly and briefly.')
    const turn = (): FakeAdapter =>
      new ResumableFakeAdapter(
        (run) =>
          (async function* () {
            yield { ...base(run.sessionKey, 1), kind: 'done', reason: 'success', summary: 'ok' }
          })(),
        'session-cc',
      )
    const a = turn()
    await driveAgentChat({
      db,
      agentId: 'cc-p',
      message: 'a',
      mcpBaseUrl: null,
      makeAdapter: () => a,
    })
    const b = turn()
    await driveAgentChat({
      db,
      agentId: 'cc-p',
      message: 'b',
      mcpBaseUrl: null,
      makeAdapter: () => b,
    })
    expect(a.starts[0]?.context).toContain('Speak plainly and briefly.')
    expect(b.starts[0]?.context).toContain('Speak plainly and briefly.')
  })

  it('a failed resumed turn on a coding runtime drops its pointer; native keeps continuity', async () => {
    const failing = (): FakeAdapter =>
      new ResumableFakeAdapter(
        (run) =>
          (async function* () {
            yield {
              ...base(run.sessionKey, 1),
              kind: 'error',
              code: null,
              message: 'No conversation found with session ID: dead-id',
              fatal: true,
            }
          })(),
        'dead-id',
      )
    seedAgent('cc-f', 'claude-code')
    setSetting(db, nativeChatSessionSettingKey('cc-f'), 'dead-id')
    const cc = failing()
    await driveAgentChat({
      db,
      agentId: 'cc-f',
      message: 'q',
      mcpBaseUrl: null,
      makeAdapter: () => cc,
    })
    expect(getSetting(db, nativeChatSessionSettingKey('cc-f'))).toBe('')
    // The user still learns why the turn failed.
    expect(rowsFor(directChatSessionKey('cc-f', 'claude-code'))[0]?.text).toMatch(/No conversation/)

    seedAgent('native-f', 'clawboo-native')
    setSetting(db, nativeChatSessionSettingKey('native-f'), 'dead-id')
    const nat = failing()
    await driveAgentChat({
      db,
      agentId: 'native-f',
      message: 'q',
      mcpBaseUrl: null,
      makeAdapter: () => nat,
    })
    expect(getSetting(db, nativeChatSessionSettingKey('native-f'))).toBe('dead-id')
  })

  it('Stop aborts a coding-runtime turn and stays silent', async () => {
    seedAgent('codex-s', 'codex')
    const gate = deferred()
    const adapter = new FakeAdapter((run) =>
      (async function* () {
        await gate.promise
        yield { ...base(run.sessionKey, 1), kind: 'done', reason: 'aborted', summary: '' }
      })(),
    )
    adapter.onAbort = () => gate.resolve()
    const running = driveAgentChat({
      db,
      agentId: 'codex-s',
      message: 'q',
      mcpBaseUrl: null,
      makeAdapter: () => adapter,
    })
    try {
      await untilRunning(adapter)
      await stopAgentChat('codex-s')
    } finally {
      gate.resolve()
    }
    await running
    expect(adapter.aborted).toBe(1)
    expect(rowsFor(directChatSessionKey('codex-s', 'codex'))).toEqual([])
  })

  it('a run the server ends for going quiet is reported, not mistaken for a Stop', async () => {
    seedAgent('hermes-q', 'hermes')
    const prev = process.env['CLAWBOO_RUN_SILENT_TIMEOUT_MS']
    process.env['CLAWBOO_RUN_SILENT_TIMEOUT_MS'] = '20'
    try {
      const gate = deferred()
      const adapter = new FakeAdapter((run) =>
        (async function* () {
          await gate.promise
          yield { ...base(run.sessionKey, 1), kind: 'done', reason: 'aborted', summary: '' }
        })(),
      )
      adapter.onAbort = () => gate.resolve()
      await driveAgentChat({
        db,
        agentId: 'hermes-q',
        message: 'q',
        mcpBaseUrl: null,
        makeAdapter: () => adapter,
      })
      expect(adapter.aborted).toBe(1)
      const meta = rowsFor(directChatSessionKey('hermes-q', 'hermes'))
      expect(meta.map((r) => r.kind)).toEqual(['meta'])
      expect(meta[0]?.text).toMatch(/went quiet/)
    } finally {
      if (prev === undefined) delete process.env['CLAWBOO_RUN_SILENT_TIMEOUT_MS']
      else process.env['CLAWBOO_RUN_SILENT_TIMEOUT_MS'] = prev
    }
  })

  it("/reset drops a coding-runtime agent's resume pointer", async () => {
    const key = nativeChatSessionSettingKey('cc-r')
    setSetting(db, key, 'session-abc')
    const req = {
      body: { sessionKeys: [directChatSessionKey('cc-r', 'claude-code')] },
    } as unknown as Parameters<typeof chatHistoryRESETCONTEXT>[0]
    const res = { json: () => res, status: () => res } as unknown as Parameters<
      typeof chatHistoryRESETCONTEXT
    >[1]
    await chatHistoryRESETCONTEXT(req, res)
    expect(getSetting(db, key)).toBe('')
  })
  // ── Where a 1:1 turn starts ──

  const quickDone = (): FakeAdapter =>
    new FakeAdapter((run) =>
      (async function* () {
        yield { ...base(run.sessionKey, 1), kind: 'done', reason: 'success', summary: 'ok' }
      })(),
    )

  async function contextFor(agentId: string): Promise<RuntimeRunContext | null> {
    let seen: RuntimeRunContext | null = null
    const adapter = quickDone()
    await driveAgentChat({
      db,
      agentId,
      message: 'q',
      mcpBaseUrl: null,
      makeAdapter: (_id, ctx) => {
        seen = ctx
        return adapter
      },
    })
    return seen
  }

  it("a coding runtime starts in its team's folder, created owner-only", async () => {
    seedAgent('cc-w', 'claude-code', 'team-w')
    const ctx = await contextFor('cc-w')
    const dir = teamWorkdirPath('team-w')
    expect(ctx?.cwd).toBe(dir)
    const info = await stat(dir)
    expect(info.isDirectory()).toBe(true)
    if (process.platform !== 'win32') expect(info.mode & 0o777).toBe(0o700)
  })

  it('a coding-runtime agent on no team starts in the shared no-team folder', async () => {
    seedAgent('hermes-w', 'hermes')
    expect((await contextFor('hermes-w'))?.cwd).toBe(teamWorkdirPath('_no-team'))
  })

  it('a native agent gets its team folder too, and a teamless one (Boo Zero) the no-team folder', async () => {
    seedAgent('native-w', 'clawboo-native', 'team-w')
    expect((await contextFor('native-w'))?.cwd).toBe(teamWorkdirPath('team-w'))
    seedAgent('native-zero', 'clawboo-native')
    expect((await contextFor('native-zero'))?.cwd).toBe(teamWorkdirPath('_no-team'))
  })

  it('refuses to run, rather than fall back to the server folder, when the folder cannot be made', async () => {
    seedAgent('codex-w', 'codex', 'team-blocked')
    // A file where the workspaces root should be makes the folder impossible to create.
    const root = path.dirname(teamWorkdirPath('team-blocked'))
    await mkdir(path.dirname(root), { recursive: true })
    await writeFile(root, 'not a folder')
    const adapter = quickDone()
    await driveAgentChat({
      db,
      agentId: 'codex-w',
      message: 'q',
      mcpBaseUrl: null,
      makeAdapter: () => adapter,
    })
    expect(adapter.startCalls).toBe(0)
    const notice = rowsFor(directChatSessionKey('codex-w', 'codex'))
    expect(notice.map((r) => r.kind)).toEqual(['meta'])
    expect(notice[0]?.text).toMatch(/could not create the working folder/)
  })
})
