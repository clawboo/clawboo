// The native turn loop against a SCRIPTED provider client — text-only turns,
// tool rounds against the real cwd-jailed file tools, the turn ceiling, abort,
// per-turn cost deltas, the final-turn usage signal, blocklist enforcement,
// and KV-cache discipline (sorted, stable tool ordering).

import { mkdtemp, readFile, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { DEFAULT_AGENT_CONFIG, type AgentConfig, type NativeEvent } from '@clawboo/adapter-native'
import { createDb, type ClawbooDb } from '@clawboo/db'
import type { StartOpts } from '@clawboo/executor'

import type { RuntimeRunContext } from '../../types'
import { Conversation } from '../conversation'
import { buildFileTools } from '../fileTools'
import type { McpBridge } from '../mcpBridge'
import type { ProviderStreamEvent, ProviderTurnParams } from '../providers/types'
import type { RoutedProviderClient } from '../routeCall'
import { loadSessionTranscript } from '../sessionStore'

const OPTS: StartOpts = {
  agentId: 'native-conv-1',
  sessionKey: 'runtime:clawboo-native:task:t1',
  message: 'Add GREETING.md',
  context: 'Task brief: write GREETING.md with a greeting.',
}

interface Scripted {
  client: RoutedProviderClient
  seenParams: Array<Omit<ProviderTurnParams, 'model'>>
  setModelCalls: string[]
}

/** Each script entry is one turn's stream. A 'HANG_UNTIL_ABORT' entry waits for
 *  the signal then throws (the abort-mid-stream shape). */
function scriptedClient(
  script: Array<ProviderStreamEvent[] | 'HANG_UNTIL_ABORT'>,
  model = 'claude-haiku-4-5',
): Scripted {
  const seenParams: Array<Omit<ProviderTurnParams, 'model'>> = []
  const setModelCalls: string[] = []
  let turn = 0
  return {
    seenParams,
    setModelCalls,
    client: {
      activeModel: () => model,
      activeProvider: () => 'anthropic',
      setModel: (m: string) => {
        setModelCalls.push(m)
      },
      async *streamTurn(p) {
        // Snapshot — the conversation mutates its live messages array after
        // the call, so a reference capture would alias later turns.
        seenParams.push({ ...p, messages: structuredClone(p.messages) })
        const entry = script[Math.min(turn, script.length - 1)]
        turn += 1
        if (entry === 'HANG_UNTIL_ABORT') {
          await new Promise<void>((resolve) => {
            if (p.signal.aborted) resolve()
            else p.signal.addEventListener('abort', () => resolve(), { once: true })
          })
          throw new Error('aborted by signal')
        }
        for (const ev of entry ?? []) yield ev
      },
    },
  }
}

const usage = (input: number, output: number): ProviderStreamEvent => ({
  type: 'usage',
  inputTokens: input,
  outputTokens: output,
})

describe('Conversation turn loop', () => {
  let sandbox: string
  let cwd: string
  let db: ClawbooDb
  let events: NativeEvent[]

  beforeEach(async () => {
    sandbox = await mkdtemp(path.join(os.tmpdir(), 'clawboo-native-conv-'))
    cwd = path.join(sandbox, 'work')
    await rm(cwd, { recursive: true, force: true })
    await import('node:fs/promises').then((fs) => fs.mkdir(cwd, { recursive: true }))
    db = createDb(path.join(sandbox, 'test.db'))
    events = []
  })
  afterEach(async () => {
    await rm(sandbox, { recursive: true, force: true })
  })

  function makeConversation(
    scripted: Scripted,
    overrides: { config?: Partial<AgentConfig>; ctx?: RuntimeRunContext; opts?: StartOpts } = {},
  ): Conversation {
    const config: AgentConfig = { ...DEFAULT_AGENT_CONFIG, id: OPTS.agentId, ...overrides.config }
    const ctx: RuntimeRunContext = overrides.ctx ?? { cwd, homeDir: path.join(sandbox, 'home') }
    return new Conversation({
      config,
      client: scripted.client,
      mcp: null,
      localTools: buildFileTools(ctx.cwd ?? null),
      opts: overrides.opts ?? OPTS,
      ctx,
      db,
      emit: (ev) => events.push(ev),
    })
  }

  it('text-only turn: init → text deltas → turn cost → done ok', async () => {
    const scripted = scriptedClient([
      [{ type: 'text', delta: 'All ' }, { type: 'text', delta: 'done.' }, usage(120, 8)],
    ])
    await makeConversation(scripted).run()

    expect(events[0]).toMatchObject({ type: 'init' })
    expect(
      events.filter((e) => e.type === 'text').map((e) => (e as { text: string }).text),
    ).toEqual(['All ', 'done.'])
    const turn = events.find((e) => e.type === 'turn')
    expect(turn).toMatchObject({
      usage: { inputTokens: 120, outputTokens: 8 },
      model: 'claude-haiku-4-5',
    })
    expect((turn as { costUsd: number | null }).costUsd).toBeGreaterThan(0)
    expect(events[events.length - 1]).toMatchObject({
      type: 'result',
      ok: true,
      summary: 'All done.',
    })
  })

  it('tool round: executes write_file in the real cwd, feeds the result back, then finishes', async () => {
    const scripted = scriptedClient([
      [
        {
          type: 'tool-call',
          id: 'tc1',
          name: 'write_file',
          input: { path: 'GREETING.md', content: 'hello team' },
        },
        usage(150, 20),
      ],
      [{ type: 'text', delta: 'Wrote the greeting.' }, usage(200, 10)],
    ])
    await makeConversation(scripted).run()

    expect(await readFile(path.join(cwd, 'GREETING.md'), 'utf8')).toBe('hello team')
    expect(events.find((e) => e.type === 'tool-call')).toMatchObject({
      name: 'write_file',
      id: 'tc1',
    })
    expect(events.find((e) => e.type === 'tool-result')).toMatchObject({
      id: 'tc1',
      isError: false,
    })
    expect(events[events.length - 1]).toMatchObject({
      type: 'result',
      ok: true,
      summary: 'Wrote the greeting.',
    })

    // Turn 2 received the tool result in the transcript.
    const second = scripted.seenParams[1]
    const lastMsg = second?.messages[second.messages.length - 1]
    expect(lastMsg).toMatchObject({ role: 'user' })
    expect(lastMsg?.content[0]).toMatchObject({ type: 'tool-result', id: 'tc1' })
  })

  it('a DENIED broker tool emits a non-fatal policy_denied event; the run continues', async () => {
    // Turn 1 calls a denied MCP tool; turn 2 finishes normally — the denial is a
    // typed, non-terminal signal (for the host's circuit breaker), not a crash.
    const scripted = scriptedClient([
      [
        { type: 'tool-call', id: 'tc1', name: 'delete_path', input: { path: '/etc' } },
        usage(50, 5),
      ],
      [{ type: 'text', delta: 'understood, will not delete' }, usage(60, 5)],
    ])
    const deniedMcp: McpBridge = {
      async listTools() {
        return [{ name: 'delete_path', description: 'd', inputSchema: { type: 'object' } }]
      },
      owns: (name) => name === 'delete_path',
      async callTool() {
        return { output: 'denied: security:rm-rf', isError: true, denied: 'security:rm-rf' }
      },
      async close() {},
    }
    const conversation = new Conversation({
      config: { ...DEFAULT_AGENT_CONFIG, id: OPTS.agentId },
      client: scripted.client,
      mcp: deniedMcp,
      localTools: buildFileTools(cwd),
      opts: OPTS,
      ctx: { cwd, homeDir: path.join(sandbox, 'home') },
      db,
      emit: (ev) => events.push(ev),
    })
    await conversation.run()

    const denied = events.find((e) => e.type === 'error') as
      | { type: 'error'; code: string; fatal: boolean }
      | undefined
    expect(denied?.code).toBe('policy_denied')
    expect(denied?.fatal).toBe(false)
    // The denied tool-result still went back to the model, and the run finished ok.
    expect(events.find((e) => e.type === 'tool-result')).toMatchObject({ id: 'tc1', isError: true })
    expect(events[events.length - 1]).toMatchObject({ type: 'result', ok: true })
  })

  it('LISTENs: a peer post arriving mid-conversation is pulled into the next turn as evidence', async () => {
    // Turn 1 calls a local tool (forces a 2nd turn); the inbound LISTEN pull
    // baselines the cursor on turn 1 and delivers the peer post on turn 2.
    let subCalls = 0
    const peerMcp: McpBridge = {
      async listTools() {
        return [
          {
            name: 'team_chat_subscribe',
            description: 'read the room',
            inputSchema: { type: 'object' },
          },
        ]
      },
      owns: (name) => name === 'team_chat_subscribe',
      async callTool(name) {
        if (name !== 'team_chat_subscribe') return { output: 'no', isError: true }
        subCalls += 1
        return subCalls === 1
          ? { output: JSON.stringify({ posts: [], nextSeq: 5 }), isError: false } // baseline
          : {
              output: JSON.stringify({
                posts: [
                  {
                    wrapped:
                      '[Inter-session message · from=peer · isUser=false]\n| hi from a teammate',
                  },
                ],
                nextSeq: 6,
              }),
              isError: false,
            }
      },
      async close() {},
    }
    const scripted = scriptedClient([
      [{ type: 'tool-call', id: 'tc1', name: 'list_files', input: {} }, usage(10, 5)],
      [{ type: 'text', delta: 'acknowledged the teammate' }, usage(20, 5)],
    ])
    const conversation = new Conversation({
      config: { ...DEFAULT_AGENT_CONFIG, id: OPTS.agentId },
      client: scripted.client,
      mcp: peerMcp,
      localTools: buildFileTools(cwd),
      opts: OPTS,
      ctx: { cwd, homeDir: path.join(sandbox, 'home') },
      db,
      emit: (ev) => events.push(ev),
    })
    await conversation.run()

    // The run completed AND turn 2's transcript carries the peer post as a
    // user-role message (the wrapped isUser=false evidence).
    expect(events[events.length - 1]).toMatchObject({ type: 'result', ok: true })
    const turn2 = scripted.seenParams[1]
    const texts = (turn2?.messages ?? []).flatMap((m) =>
      m.content.filter((c) => c.type === 'text').map((c) => (c as { text: string }).text),
    )
    expect(texts.some((t) => t.includes('hi from a teammate'))).toBe(true)
  })

  it('persists the transcript to the per-identity home on every terminal', async () => {
    const scripted = scriptedClient([[{ type: 'text', delta: 'ok' }, usage(10, 2)]])
    await makeConversation(scripted).run()
    const result = events[events.length - 1] as { sessionId: string }
    const messages = await loadSessionTranscript(path.join(sandbox, 'home'), result.sessionId)
    expect(messages).not.toBeNull()
    expect(messages?.[0]).toMatchObject({ role: 'user' })
    expect(messages?.[1]).toMatchObject({ role: 'assistant' })
  })

  it('a transcript persist FAILURE is logged (not silently swallowed) and the run still completes', async () => {
    // Force saveSessionTranscript to reject by pointing homeDir under an existing
    // FILE (mkdir of a path beneath a file is ENOTDIR).
    const blocker = path.join(sandbox, 'blocker')
    await import('node:fs/promises').then((fs) => fs.writeFile(blocker, 'x'))
    const warns: Array<{ obj: Record<string, unknown>; msg: string }> = []
    const scripted = scriptedClient([[{ type: 'text', delta: 'done' }, usage(5, 1)]])
    const conversation = new Conversation({
      config: { ...DEFAULT_AGENT_CONFIG, id: OPTS.agentId },
      client: scripted.client,
      mcp: null,
      localTools: buildFileTools(cwd),
      opts: OPTS,
      ctx: { cwd, homeDir: path.join(blocker, 'home') },
      db,
      emit: (ev) => events.push(ev),
      log: { warn: (obj, msg) => warns.push({ obj, msg }) },
    })
    await conversation.run()

    // The run completed despite the persist failure (it's non-fatal)…
    expect(events[events.length - 1]).toMatchObject({ type: 'result', ok: true })
    // …and the loss was surfaced via a warn rather than silently dropped.
    expect(warns).toHaveLength(1)
    expect(warns[0]?.msg).toContain('transcript persist failed')
  })

  it('resumes a prior session transcript (same-runtime continuation)', async () => {
    const first = scriptedClient([[{ type: 'text', delta: 'remember 42' }, usage(10, 2)]])
    await makeConversation(first).run()
    const priorId = (events[events.length - 1] as { sessionId: string }).sessionId

    events = []
    const second = scriptedClient([[{ type: 'text', delta: 'still 42' }, usage(10, 2)]])
    await makeConversation(second, {
      ctx: { cwd, homeDir: path.join(sandbox, 'home'), resume: priorId },
    }).run()

    // The resumed conversation's first provider call already carries the
    // prior transcript ahead of the new task message.
    const params = second.seenParams[0]
    expect(params?.messages.length).toBeGreaterThan(2)
    expect(params?.messages[0]?.content[0]).toMatchObject({ type: 'text' })
  })

  it('stops at the turn ceiling with a clean max_turns terminal', async () => {
    const scripted = scriptedClient([
      [{ type: 'tool-call', id: 'tc1', name: 'list_files', input: {} }, usage(50, 5)],
    ])
    await makeConversation(scripted, { config: { maxTurns: 2 } }).run()
    expect(events[events.length - 1]).toMatchObject({ type: 'result', ok: false, maxTurns: true })
    expect(scripted.seenParams).toHaveLength(2)
  })

  it('abort mid-stream lands an aborted terminal and still persists the session', async () => {
    const scripted = scriptedClient(['HANG_UNTIL_ABORT'])
    const conversation = makeConversation(scripted)
    const running = conversation.run()
    await new Promise((r) => setTimeout(r, 10))
    conversation.abort()
    await running
    const result = events[events.length - 1] as {
      type: string
      aborted?: boolean
      sessionId: string
    }
    expect(result).toMatchObject({ type: 'result', aborted: true })
    expect(await loadSessionTranscript(path.join(sandbox, 'home'), result.sessionId)).not.toBeNull()
  })

  it('reports per-turn cost deltas and the final-turn input tokens on the terminal', async () => {
    const scripted = scriptedClient([
      [{ type: 'tool-call', id: 'tc1', name: 'list_files', input: {} }, usage(100, 30)],
      [{ type: 'text', delta: 'done' }, usage(180, 12)],
    ])
    await makeConversation(scripted).run()
    const turns = events.filter((e) => e.type === 'turn') as Array<{
      usage: { inputTokens: number; outputTokens: number }
    }>
    expect(turns.map((t) => t.usage)).toEqual([
      { inputTokens: 100, outputTokens: 30 },
      { inputTokens: 180, outputTokens: 12 },
    ])
    const result = events[events.length - 1] as {
      usage: { inputTokens: number; outputTokens: number }
      costUsd: number
    }
    // inputTokens = the FINAL turn's input (≈ live context size); output = run total.
    expect(result.usage).toEqual({ inputTokens: 180, outputTokens: 42 })
    expect(result.costUsd).toBeGreaterThan(0)
  })

  it('setModel applies at the next provider call', async () => {
    const scripted = scriptedClient([[{ type: 'text', delta: 'x' }, usage(5, 1)]])
    const conversation = makeConversation(scripted)
    conversation.setModel('claude-sonnet-4-6')
    await conversation.run()
    expect(scripted.setModelCalls).toEqual(['claude-sonnet-4-6'])
  })

  it('enforces childToolBlocklist and keeps the tool universe name-sorted (cache discipline)', async () => {
    const scripted = scriptedClient([[{ type: 'text', delta: 'no tools used' }, usage(5, 1)]])
    await makeConversation(scripted, {
      opts: { ...OPTS, childToolBlocklist: ['write_file', 'sessions_send'] },
    }).run()
    const names = scripted.seenParams[0]?.tools.map((t) => t.name) ?? []
    expect(names).not.toContain('write_file')
    expect(names).toEqual([...names].sort())
    expect(names).toContain('read_file')
  })

  it('an unknown tool call returns a tool error result and the loop continues', async () => {
    const scripted = scriptedClient([
      [{ type: 'tool-call', id: 'tc1', name: 'not_a_tool', input: {} }, usage(10, 5)],
      [{ type: 'text', delta: 'recovered' }, usage(20, 5)],
    ])
    await makeConversation(scripted).run()
    expect(events.find((e) => e.type === 'tool-result')).toMatchObject({ isError: true })
    expect(events[events.length - 1]).toMatchObject({
      type: 'result',
      ok: true,
      summary: 'recovered',
    })
  })

  it('a provider error surfaces as a typed error terminal', async () => {
    const scripted: Scripted = {
      seenParams: [],
      setModelCalls: [],
      client: {
        activeModel: () => 'claude-haiku-4-5',
        activeProvider: () => 'anthropic',
        setModel: () => {},
        // eslint-disable-next-line require-yield
        async *streamTurn() {
          const { ProviderError } = await import('../providers/types')
          throw new ProviderError('invalid x-api-key', 'auth', 401)
        },
      },
    }
    await makeConversation(scripted).run()
    expect(events[events.length - 1]).toMatchObject({
      type: 'result',
      ok: false,
      errorCode: 'auth',
    })
  })
})
