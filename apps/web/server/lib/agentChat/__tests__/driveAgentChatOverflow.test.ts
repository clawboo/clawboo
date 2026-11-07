// A 1:1 chat whose session outgrew the model's context window. The next message must
// not resume a session that can only overflow again, and the person is told when the
// agent loses its memory of the conversation.
//
// Clawboo Native runs for real here: the real adapter, driver, Conversation and saved
// transcripts, through the production path of driveAgentChat. Only the model is
// scripted: it refuses any request larger than `provider.windowChars`, as a provider
// refuses a prompt over its context window. The other runtimes use the event pair
// their own mappers send, on a scripted adapter.

import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { mapClaudeEvent } from '@clawboo/adapter-claude-code'
import { mapHermesEvent } from '@clawboo/adapter-hermes'
import { agents, chatMessages, getSetting, setSetting, type ClawbooDb } from '@clawboo/db'
import type {
  Capabilities,
  RunHandle,
  RuntimeAdapter,
  RuntimeEvent,
  StartOpts,
  TaskHandle,
} from '@clawboo/executor'
import { eq } from 'drizzle-orm'

const dbFault = vi.hoisted(() => ({ failClear: false }))

const provider = vi.hoisted(() => ({
  /** The largest request the scripted model accepts, in characters of message content. */
  windowChars: Number.POSITIVE_INFINITY,
  /** Thrown on every request instead, when set. */
  failure: null as Error | null,
  /** The user text of every request, oldest message first. */
  requests: [] as string[][],
}))

vi.mock('@clawboo/db', async (importActual) => {
  const actual = await importActual<typeof import('@clawboo/db')>()
  return {
    ...actual,
    setSetting: (...args: Parameters<typeof actual.setSetting>) => {
      if (dbFault.failClear && args[2] === '') throw new Error('disk full')
      return actual.setSetting(...args)
    },
  }
})

vi.mock('../../runtimes', async (importActual) => {
  const actual = await importActual<typeof import('../../runtimes')>()
  const { NativeAdapter } = await import('@clawboo/adapter-native')
  const { createNativeDriver } = await import('../../runtimes/native/nativeDriver')
  const { ProviderError } = await import('../../runtimes/native/providers/types')
  const client: import('../../runtimes/native/routeCall').RoutedProviderClient = {
    activeModel: () => 'claude-haiku-4-5',
    activeProvider: () => 'anthropic',
    setModel: () => {},
    async *streamTurn({ messages }) {
      provider.requests.push(
        messages
          .filter((m) => m.role === 'user')
          .flatMap((m) => m.content)
          .flatMap((part) => (part.type === 'text' ? [part.text] : [])),
      )
      if (provider.failure) throw provider.failure
      const size = messages.reduce((n, m) => n + JSON.stringify(m.content).length, 0)
      if (size > provider.windowChars) {
        throw new ProviderError(
          `prompt is too long: ${size} tokens > ${provider.windowChars} maximum`,
          'bad_request',
          400,
        )
      }
      yield { type: 'text', delta: 'ok' }
      yield { type: 'usage', inputTokens: 10, outputTokens: 2 }
    },
  }
  return {
    ...actual,
    adapterFactoryFor: (id: Parameters<typeof actual.adapterFactoryFor>[0]) =>
      id === 'clawboo-native'
        ? (ctx: import('../../runtimes/types').RuntimeRunContext) =>
            new NativeAdapter(
              (opts) => createNativeDriver(opts, ctx, { client, mcp: null }),
              async () => ({ ok: true }),
            )
        : actual.adapterFactoryFor(id),
  }
})

const { getDb, getDbPath, resetDb } = await import('../../db')
const { ProviderError, normalizeProviderError } =
  await import('../../runtimes/native/providers/types')
const { directChatSessionKey, driveAgentChat, nativeChatSessionSettingKey } =
  await import('../driveAgentChat')

/** The notices' own words, so this reads the chat as a person does. */
const DROPPED = /no longer carrying the conversation/
const TRIMMED = /carries only the most recent part/
const REFUSED = /Resuming this conversation would send the same request again/
const TOO_LARGE = /did not fit in the model's context window, .*your next message starts fresh/
/** The advice for an OpenClaw Gateway run, which is untrue on these runtimes. */
const GATEWAY_ADVICE = /out of context room|context-window setting|not the cause/

const CAPS: Capabilities = {
  streaming: true,
  mcp: false,
  worktrees: false,
  resume: true,
  toolApproval: false,
  models: [],
}

const OVERFLOW_ERROR_MESSAGE = "The conversation outgrew the model's context window."

/** A resuming adapter whose run sends `script`, then reports `savedSessionId`. */
class ScriptedAdapter implements RuntimeAdapter {
  readonly participantKind = 'agent' as const
  readonly id = 'scripted'
  constructor(
    private readonly script: RuntimeEvent[],
    private readonly savedSessionId: string,
  ) {}
  capabilities(): Capabilities {
    return CAPS
  }
  async health(): Promise<{ ok: boolean }> {
    return { ok: true }
  }
  async start(_t: TaskHandle, opts: StartOpts): Promise<RunHandle> {
    return { adapterId: this.id, sessionKey: opts.sessionKey, runId: null }
  }
  events(run: RunHandle): AsyncIterable<RuntimeEvent> {
    const script = this.script
    const sk = run.sessionKey
    return (async function* () {
      let seq = 0
      for (const ev of script) {
        seq += 1
        yield { ...ev, runId: sk, sessionId: sk, ts: seq, seq } as RuntimeEvent
      }
    })()
  }
  readonly sessionCodec = {
    serialize: async (run: RunHandle): Promise<string> =>
      JSON.stringify({ sessionKey: run.sessionKey, sessionId: this.savedSessionId }),
    restore: async (): Promise<RunHandle> => ({
      adapterId: 'scripted',
      sessionKey: '',
      runId: null,
    }),
  }
  async abort(): Promise<void> {}
  async setModel(): Promise<void> {}
  async writeContext(): Promise<void> {}
}

const asMapped = (events: RuntimeEvent[]): RuntimeEvent[] => events
const noSeq = (): number => 0

/** What Claude Code's own mapper sends for a run that ended on a full context. */
const claudeOverflow = (accumulated = ''): RuntimeEvent[] =>
  asMapped(
    mapClaudeEvent(
      {
        type: 'result',
        ok: false,
        contextFull: true,
        summary: 'Prompt is too long',
        errorMessage: 'Prompt is too long',
      },
      { runId: null, sessionId: null },
      noSeq,
      noSeq,
      accumulated,
    ),
  )

/** What Hermes's own mapper sends for a failed run the driver typed as an overflow. */
const hermesOverflow = (): RuntimeEvent[] =>
  asMapped(
    mapHermesEvent(
      {
        type: 'result',
        ok: false,
        summary: 'Context length exceeded (15 tokens). Cannot compress further.',
        errorMessage: 'Context length exceeded (15 tokens). Cannot compress further.',
        errorCode: 'context_overflow',
      },
      { runId: null, sessionId: null },
      noSeq,
      noSeq,
    ),
  )

/** Codex on `codex app-server`, and on `codex exec` now: a fatal typed error. */
const CODEX_OVERFLOW: RuntimeEvent[] = [
  {
    kind: 'error',
    code: 'context_overflow',
    message: OVERFLOW_ERROR_MESSAGE,
    fatal: true,
  } as RuntimeEvent,
  { kind: 'done', reason: 'error', summary: '' } as RuntimeEvent,
]

describe('driveAgentChat: a session that outgrew the context window', () => {
  let home: string
  let prevHome: string | undefined
  let prevClawbooHome: string | undefined
  let db: ClawbooDb

  beforeEach(async () => {
    home = await mkdtemp(path.join(os.tmpdir(), 'clawboo-chat-overflow-'))
    await mkdir(path.join(home, '.clawboo'), { recursive: true })
    prevHome = process.env['HOME']
    prevClawbooHome = process.env['CLAWBOO_HOME']
    process.env['HOME'] = home
    // `getDb()` follows CLAWBOO_HOME before $HOME: sandbox both.
    process.env['CLAWBOO_HOME'] = path.join(home, '.clawboo')
    expect(getDbPath().startsWith(home)).toBe(true)
    db = getDb()
    provider.windowChars = Number.POSITIVE_INFINITY
    provider.failure = null
    provider.requests = []
    dbFault.failClear = false
  })
  afterEach(async () => {
    // Close BEFORE removing the dir: Windows refuses to remove a directory that
    // still holds an open file.
    resetDb()
    if (prevHome === undefined) delete process.env['HOME']
    else process.env['HOME'] = prevHome
    if (prevClawbooHome === undefined) delete process.env['CLAWBOO_HOME']
    else process.env['CLAWBOO_HOME'] = prevClawbooHome
    await rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
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

  function chatTexts(agentId: string, runtime: string): string[] {
    return db
      .select()
      .from(chatMessages)
      .where(eq(chatMessages.sessionKey, directChatSessionKey(agentId, runtime)))
      .all()
      .map((r) => (JSON.parse(r.data as string) as { text: string }).text)
  }

  const pointer = (agentId: string): string | null =>
    getSetting(db, nativeChatSessionSettingKey(agentId)) || null

  /** One message to a real Native agent. */
  const send = (agentId: string, message: string): Promise<void> =>
    driveAgentChat({ db, agentId, message, mcpBaseUrl: null })

  /** One turn of a runtime on a scripted adapter. */
  const sendScripted = (agentId: string, script: RuntimeEvent[], sid: string): Promise<void> =>
    driveAgentChat({
      db,
      agentId,
      message: 'q',
      mcpBaseUrl: null,
      makeAdapter: () => new ScriptedAdapter(script, sid),
    })

  const lastRequest = (): string[] => provider.requests[provider.requests.length - 1]!

  /** How many of the chat's rows match: a notice is written once per turn, no more. */
  const count = (texts: string[], re: RegExp): number => texts.filter((t) => re.test(t)).length

  describe('Clawboo Native', () => {
    it('one turn that alone overflowed clears the session, says so, and the next message works', async () => {
      seedAgent('n1', 'clawboo-native')
      provider.windowChars = 1_000
      await send('n1', `huge ${'x'.repeat(5_000)}`)

      // Resuming it would send the same request plus one more message.
      expect(pointer('n1')).toBeNull()
      // One notice for the turn, and it says what is true.
      // It was carrying nothing, so it does not say it stopped carrying a conversation.
      const texts = chatTexts('n1', 'clawboo-native')
      expect(texts).toHaveLength(1)
      expect(count(texts, TOO_LARGE)).toBe(1)
      expect(count(texts, DROPPED)).toBe(0)
      expect(count(texts, GATEWAY_ADVICE)).toBe(0)

      await send('n1', 'small')
      expect(lastRequest()).toEqual(['small'])
      expect(chatTexts('n1', 'clawboo-native').at(-1)).toBe('ok')
      expect(pointer('n1')).not.toBeNull()
    })

    it('instructions and tools that alone fill the window: every message says what is true', async () => {
      seedAgent('n0', 'clawboo-native')
      provider.windowChars = 1
      await send('n0', 'hello')
      await send('n0', 'hello again')
      const texts = chatTexts('n0', 'clawboo-native')
      expect(count(texts, TOO_LARGE)).toBe(2)
      expect(count(texts, DROPPED)).toBe(0)
      expect(pointer('n0')).toBeNull()
    })

    it('a chat under the trim bound on a small window clears: nothing could be trimmed', async () => {
      seedAgent('n2', 'clawboo-native')
      provider.windowChars = 1_000
      await send('n2', `one ${'a'.repeat(400)}`)
      await send('n2', `two ${'b'.repeat(400)}`)
      expect(pointer('n2')).not.toBeNull()
      await send('n2', `three ${'c'.repeat(400)}`)

      expect(pointer('n2')).toBeNull()
      expect(count(chatTexts('n2', 'clawboo-native'), DROPPED)).toBe(1)

      await send('n2', 'small')
      expect(lastRequest()).toEqual(['small'])
    })

    it('a long chat that trimming can rescue keeps its session and says nothing of a drop', async () => {
      seedAgent('n3', 'clawboo-native')
      provider.windowChars = 280_000
      const big = (label: string): string => `${label} ${'y'.repeat(100_000)}`
      await send('n3', big('first'))
      await send('n3', big('second'))
      await send('n3', big('third'))

      // The third request (about 300,000 characters) was refused. The trim keeps the
      // last two turns (about 200,000), so the next message can fit.
      const kept = pointer('n3')
      expect(kept).not.toBeNull()
      const after = chatTexts('n3', 'clawboo-native')
      expect(count(after, TRIMMED)).toBe(1)
      expect(count(after, DROPPED)).toBe(0)
      expect(count(after, GATEWAY_ADVICE)).toBe(0)

      await send('n3', 'small')
      const request = lastRequest()
      expect(request.at(-1)).toBe('small')
      expect(request.some((t) => t.startsWith('first'))).toBe(false)
      expect(request.some((t) => t.startsWith('third'))).toBe(true)
      expect(chatTexts('n3', 'clawboo-native').at(-1)).toBe('ok')
    })

    it('a resumed turn too big for the window by itself clears at once: trimming barely helps', async () => {
      seedAgent('n4', 'clawboo-native')
      provider.windowChars = 280_000
      await send('n4', 'hello')
      await send('n4', `huge ${'z'.repeat(300_000)}`)

      // The trim would drop only "hello": a resume sends about what was refused.
      expect(pointer('n4')).toBeNull()
      const texts = chatTexts('n4', 'clawboo-native')
      expect(count(texts, DROPPED)).toBe(1)
      expect(count(texts, TRIMMED)).toBe(0)

      await send('n4', 'second try')
      expect(lastRequest()).toEqual(['second try'])
      expect(chatTexts('n4', 'clawboo-native').at(-1)).toBe('ok')
    })

    it('a long chat hovering at the trim bound does not fail on every retry', async () => {
      seedAgent('n9', 'clawboo-native')
      // About 240,000 characters, in 40 turns.
      for (let i = 0; i < 40; i++) await send('n9', `turn ${i} ${'h'.repeat(6_000)}`)
      expect(chatTexts('n9', 'clawboo-native').every((t) => t === 'ok')).toBe(true)

      // The person switches to a model with a window under the bound. The trim only just
      // brings the transcript under it, so a resume would send about the same again.
      provider.windowChars = 100_000
      await send('n9', `retry ${'r'.repeat(6_000)}`)
      expect(pointer('n9')).toBeNull()
      expect(count(chatTexts('n9', 'clawboo-native'), DROPPED)).toBe(1)

      await send('n9', 'small')
      expect(lastRequest()).toEqual(['small'])
      expect(chatTexts('n9', 'clawboo-native').at(-1)).toBe('ok')
    })

    it.each([
      [
        'Gemini',
        'The input token count (40000) exceeds the maximum number of tokens allowed (32768).',
      ],
      [
        'Moonshot',
        'Invalid request: Your request exceeded model token limit: 262144 (requested: 269030)',
      ],
    ])('reads %s wording as the overflow it is', async (_provider, message) => {
      const id = `w-${_provider}`
      seedAgent(id, 'clawboo-native')
      await send(id, 'hello')
      provider.failure = new ProviderError(`400 ${message}`, 'bad_request', 400)
      await send(id, 'more')
      expect(pointer(id)).toBeNull()
      const texts = chatTexts(id, 'clawboo-native')
      expect(count(texts, DROPPED)).toBe(1)
      expect(count(texts, REFUSED)).toBe(0)
    })

    describe('a request the provider refused, in words nothing recognizes', () => {
      const UNSEEN = '400 Range of input length should be [1, 30720]'

      it('a resumed turn clears, says why, and the next message works', async () => {
        seedAgent('r1', 'clawboo-native')
        await send('r1', 'hello')
        provider.failure = new ProviderError(UNSEEN, 'bad_request', 400)
        await send('r1', 'more')

        // Before, the session was written back, and every later message sent the same
        // transcript plus more and failed, for ever.
        expect(pointer('r1')).toBeNull()
        const texts = chatTexts('r1', 'clawboo-native')
        expect(count(texts, REFUSED)).toBe(1)
        expect(texts.at(-1)).toContain('Range of input length')
        expect(count(texts, /^The run failed/)).toBe(1)

        provider.failure = null
        await send('r1', 'again')
        expect(lastRequest()).toEqual(['again'])
        expect(chatTexts('r1', 'clawboo-native').at(-1)).toBe('ok')
      })

      it('a first turn leaves no session behind, and needs no word about losing one', async () => {
        seedAgent('r2', 'clawboo-native')
        provider.failure = new ProviderError(UNSEEN, 'bad_request', 400)
        await send('r2', 'hello')
        expect(pointer('r2')).toBeNull()
        expect(chatTexts('r2', 'clawboo-native')).toEqual([`The run failed: ${UNSEEN}`])
      })

      it('a token count with a comma in it is not read as a status', async () => {
        seedAgent('r3', 'clawboo-native')
        await send('r3', 'hello')
        provider.failure = new ProviderError(
          '400 Request has 201,402 units, and the limit is 32,768',
          'bad_request',
          400,
        )
        await send('r3', 'more')
        expect(pointer('r3')).toBeNull()
        expect(count(chatTexts('r3', 'clawboo-native'), REFUSED)).toBe(1)
      })

      it.each([
        ['a model that is gone', "404 model 'llama3.2' not found"],
        ['a model that cannot use tools', '400 "gemma2" does not support tools'],
        ['a refused account', '400 Your credit balance is too low to access the Anthropic API'],
      ])('%s is not about the conversation, so it stays', async (label, message) => {
        const id = `k-${label.replace(/\W/g, '')}`
        seedAgent(id, 'clawboo-native')
        await send(id, 'hello')
        const kept = pointer(id)
        expect(kept).not.toBeNull()
        provider.failure = new ProviderError(message, 'bad_request', 400)
        await send(id, 'more')
        expect(pointer(id)).not.toBeNull()
        expect(count(chatTexts(id, 'clawboo-native'), REFUSED)).toBe(0)
        provider.failure = null
        await send(id, 'again')
        expect(lastRequest()).toContain('hello')
      })

      it('it stays when trimming can make room', async () => {
        seedAgent('r4', 'clawboo-native')
        const big = (label: string): string => `${label} ${'y'.repeat(100_000)}`
        await send('r4', big('first'))
        await send('r4', big('second'))
        provider.failure = new ProviderError(UNSEEN, 'bad_request', 400)
        await send('r4', big('third'))
        expect(pointer('r4')).not.toBeNull()
        const texts = chatTexts('r4', 'clawboo-native')
        expect(texts.at(-1)).toBe(`The run failed: ${UNSEEN}`)
        expect(count(texts, REFUSED)).toBe(0)
      })
    })

    it('a tokens-per-minute rate limit is no overflow: the session stays, and the notice names the limit', async () => {
      seedAgent('n5', 'clawboo-native')
      await send('n5', 'hello')
      const kept = pointer('n5')
      expect(kept).not.toBeNull()

      provider.failure = normalizeProviderError(
        Object.assign(
          new Error('429 Tokens per minute limit exceeded - too many tokens processed.'),
          {
            status: 429,
          },
        ),
      )
      await send('n5', 'more')

      const texts = chatTexts('n5', 'clawboo-native')
      expect(texts.at(-1)).toMatch(/^The run failed: 429 Tokens per minute/)
      expect(count(texts, GATEWAY_ADVICE)).toBe(0)
      expect(count(texts, DROPPED)).toBe(0)
      expect(pointer('n5')).not.toBeNull()

      provider.failure = null
      await send('n5', 'again')
      expect(lastRequest()).toContain('hello')
    })

    it('a rate limit with no telling words, typed by the provider, is no overflow either', async () => {
      seedAgent('n6', 'clawboo-native')
      await send('n6', 'hello')
      // An error frame in the stream: no HTTP status, the cause only in `code`.
      provider.failure = normalizeProviderError(
        Object.assign(new Error('too many tokens'), {
          code: 'rate_limit_exceeded',
          type: 'tokens',
        }),
      )
      await send('n6', 'more')
      const texts = chatTexts('n6', 'clawboo-native')
      expect(count(texts, GATEWAY_ADVICE)).toBe(0)
      expect(texts.at(-1)).toMatch(/rate limit/i)
      expect(pointer('n6')).not.toBeNull()
    })

    it('a real overflow in other words still counts', async () => {
      seedAgent('n7', 'clawboo-native')
      provider.failure = new ProviderError('too many tokens in the request', 'bad_request', 400)
      await send('n7', 'hello')
      expect(pointer('n7')).toBeNull()
      expect(count(chatTexts('n7', 'clawboo-native'), TOO_LARGE)).toBe(1)
    })

    it('a saved transcript that cannot be read clears and says so', async () => {
      seedAgent('n8', 'clawboo-native')
      setSetting(db, nativeChatSessionSettingKey('n8'), 'native-earlier')
      // On this path no home was given, so nothing could be reloaded on a resume.
      await sendScripted('n8', CODEX_OVERFLOW, 'native-unreadable')
      expect(pointer('n8')).toBeNull()
      expect(count(chatTexts('n8', 'clawboo-native'), DROPPED)).toBe(1)
    })
  })

  describe('the runtimes that manage their own sessions', () => {
    it('a fresh Claude Code turn that overflows leaves no session to resume, and says so', async () => {
      seedAgent('cc1', 'claude-code')
      expect(claudeOverflow().map((e) => e.kind)).toEqual(['error', 'done'])
      await sendScripted('cc1', claudeOverflow(), 'cc-sid-1')

      // Before, this wrote cc-sid-1, and the next message failed once more resuming it.
      expect(pointer('cc1')).toBeNull()
      const texts = chatTexts('cc1', 'claude-code')
      expect(texts).toHaveLength(1)
      expect(count(texts, TOO_LARGE)).toBe(1)
    })

    it('a resumed Claude Code turn that overflows drops its session too', async () => {
      seedAgent('cc2', 'claude-code')
      setSetting(db, nativeChatSessionSettingKey('cc2'), 'cc-sid-1')
      await sendScripted('cc2', claudeOverflow(), 'cc-sid-1')
      expect(pointer('cc2')).toBeNull()
      expect(count(chatTexts('cc2', 'claude-code'), DROPPED)).toBe(1)
    })

    it('the reply so far stays, and the notice follows it', async () => {
      seedAgent('cc3', 'claude-code')
      const text = {
        kind: 'text-delta',
        text: 'Reading the files first.',
        channel: 'assistant',
      } as RuntimeEvent
      await sendScripted('cc3', [text, ...claudeOverflow('Reading the files first.')], 'cc-sid-1')
      const texts = chatTexts('cc3', 'claude-code')
      expect(texts).toHaveLength(2)
      expect(texts[0]).toBe('Reading the files first.')
      expect(texts[1]).toMatch(TOO_LARGE)
      expect(pointer('cc3')).toBeNull()
    })

    it('a Claude Code turn that only reached its turn limit keeps its session', async () => {
      seedAgent('cc4', 'claude-code')
      await sendScripted(
        'cc4',
        [{ kind: 'done', reason: 'max_turns', summary: 'so far' } as RuntimeEvent],
        'cc-sid-1',
      )
      expect(pointer('cc4')).toBe('cc-sid-1')
      expect(count(chatTexts('cc4', 'claude-code'), DROPPED)).toBe(0)
    })

    it('a fresh Codex turn that overflows leaves no session to resume', async () => {
      seedAgent('cx1', 'codex')
      await sendScripted('cx1', CODEX_OVERFLOW, 'thread-1')
      expect(pointer('cx1')).toBeNull()
      const texts = chatTexts('cx1', 'codex')
      expect(texts).toHaveLength(1)
      expect(count(texts, TOO_LARGE)).toBe(1)
    })

    it('a fresh Hermes turn that overflows leaves no session to resume', async () => {
      seedAgent('hm1', 'hermes')
      await sendScripted('hm1', hermesOverflow(), 'hermes-sid-1')
      expect(pointer('hm1')).toBeNull()
      expect(count(chatTexts('hm1', 'hermes'), TOO_LARGE)).toBe(1)
    })

    it('another failure on a fresh turn still keeps its session, as before', async () => {
      seedAgent('cc5', 'claude-code')
      await sendScripted(
        'cc5',
        [
          {
            kind: 'error',
            code: 'rate_limit',
            message: 'rate limited',
            fatal: true,
          } as RuntimeEvent,
          { kind: 'done', reason: 'error', summary: '' } as RuntimeEvent,
        ],
        'cc-sid-1',
      )
      expect(pointer('cc5')).toBe('cc-sid-1')
      expect(count(chatTexts('cc5', 'claude-code'), DROPPED)).toBe(0)
    })

    it.each([
      ['rate_limit', 'Rate limit: too many tokens'],
      ['overloaded', 'the model is overloaded'],
      ['server_error', 'internal server error'],
    ])(
      'a resumed turn that hit %s keeps its session: it passes by itself',
      async (code, message) => {
        const id = `pass-${code}`
        seedAgent(id, 'codex')
        setSetting(db, nativeChatSessionSettingKey(id), 'thread-1')
        await sendScripted(
          id,
          [
            { kind: 'error', code, message, fatal: true } as RuntimeEvent,
            { kind: 'done', reason: 'error', summary: '' } as RuntimeEvent,
          ],
          'thread-1',
        )
        expect(pointer(id)).toBe('thread-1')
        expect(chatTexts(id, 'codex')).toEqual([`The run failed: ${message}`])
      },
    )

    it('a turn stopped by the person keeps its session, and stays silent', async () => {
      seedAgent('cc6', 'claude-code')
      setSetting(db, nativeChatSessionSettingKey('cc6'), 'cc-sid-1')
      await sendScripted(
        'cc6',
        [{ kind: 'done', reason: 'aborted', summary: '' } as RuntimeEvent],
        'cc-sid-2',
      )
      expect(pointer('cc6')).toBe('cc-sid-2')
      expect(chatTexts('cc6', 'claude-code')).toEqual([])
    })

    it('a run that reported an overflow and then finished got past it: its session stays', async () => {
      seedAgent('cc7', 'claude-code')
      await sendScripted(
        'cc7',
        [
          {
            kind: 'error',
            code: 'context_overflow',
            message: OVERFLOW_ERROR_MESSAGE,
            fatal: false,
          } as RuntimeEvent,
          { kind: 'done', reason: 'success', summary: 'all done' } as RuntimeEvent,
        ],
        'cc-sid-1',
      )
      expect(pointer('cc7')).toBe('cc-sid-1')
      expect(chatTexts('cc7', 'claude-code')).toEqual(['all done'])
    })

    it('when the clear cannot be written, the person is told what is true', async () => {
      seedAgent('cc8', 'claude-code')
      setSetting(db, nativeChatSessionSettingKey('cc8'), 'cc-sid-1')
      dbFault.failClear = true
      await sendScripted('cc8', claudeOverflow(), 'cc-sid-1')
      dbFault.failClear = false
      const texts = chatTexts('cc8', 'claude-code')
      expect(texts).toHaveLength(1)
      expect(texts[0]).toMatch(/could not clear its session/)
      expect(count(texts, DROPPED)).toBe(0)
      // The one write that failed is the only write it attempted.
      expect(pointer('cc8')).toBe('cc-sid-1')
    })
  })
})
