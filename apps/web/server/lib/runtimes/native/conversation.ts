// The native turn loop — clawboo's own thin conversational harness. One
// Conversation per adapter start(): a fresh session id, a neutral message
// transcript, a routed provider client, and the tool surface (shared MCP spine
// + the cwd-jailed file tools). The provider SDKs own streaming/retry/schemas;
// this loop owns sequencing: stream a response, surface deltas, execute tool
// calls, feed results back, stop when the model stops calling tools or the
// turn ceiling lands.
//
// KV-cache discipline (the assembly contract): the system prompt is the STABLE
// tier (AgentConfig.systemPrompt + a date-only stamp — never minute precision);
// the tool universe is built once before turn 1 and sorted by name; the
// caller-assembled run context (which already carries the volatile memory
// block in its tail) arrives as the first user message. Nothing volatile ever
// enters the system prompt.
//
// Rotation is HOST-side: each start() is exactly one session. A rotation
// successor arrives as a fresh Conversation with the handoff note inside
// opts.context and ctx.resume cleared. A same-runtime resume (ctx.resume set)
// reloads the persisted transcript from the per-identity home — a genuine
// continuation, the native runtime's private cognitive plane at work.

import { randomUUID } from 'node:crypto'

import type { AgentConfig, NativeEvent } from '@clawboo/adapter-native'
import { DEFAULT_MAX_TURNS } from '@clawboo/adapter-native'
import type { ClawbooDb } from '@clawboo/db'
import type { StartOpts, Usage } from '@clawboo/executor'
import { dateStamp } from '@clawboo/executor/tiers'
import { createLogger } from '@clawboo/logger'

import type { RuntimeRunContext } from '../types'
import type { NativeLocalTool, NativeToolOutcome } from './fileTools'
import type { McpBridge } from './mcpBridge'
import { priceTurn } from './pricing'
import {
  ProviderError,
  type NeutralContentPart,
  type NeutralMessage,
  type NeutralToolDef,
} from './providers/types'
import type { RoutedProviderClient } from './routeCall'
import {
  loadSessionTranscript,
  saveSessionTranscript,
  upsertNativeSessionRow,
} from './sessionStore'

const MAX_OUTPUT_TOKENS = 8192

/** The minimal logging surface the conversation needs (a pino logger satisfies it). */
interface ConversationLogger {
  warn(obj: Record<string, unknown>, msg: string): void
}

const defaultLog: ConversationLogger = createLogger('native-conversation')

export interface ConversationDeps {
  config: AgentConfig
  client: RoutedProviderClient
  mcp: McpBridge | null
  localTools: NativeLocalTool[]
  opts: StartOpts
  ctx: RuntimeRunContext
  db: ClawbooDb
  emit: (ev: NativeEvent) => void
  uuid?: () => string
  /** Best-effort log sink — defaults to the module logger; injected in tests. */
  log?: ConversationLogger
}

interface TerminalInput {
  ok?: boolean
  aborted?: boolean
  maxTurns?: boolean
  summary?: string
  errorMessage?: string
  errorCode?: string
}

export class Conversation {
  private readonly controller = new AbortController()
  private messages: NeutralMessage[] = []
  /** Multi-turn input seam: messages injected while the loop runs are drained
   *  at the top of the next iteration. Fed by the inbound peer-chat LISTEN pull
   *  (`pullPeerInbox`) and by `enqueueUserMessage`. */
  private readonly pendingInputs: string[] = []
  /** team_chat subscribe cursor (null until the first pull baselines it). */
  private peerCursor: number | null = null
  private nextModel: string | null = null
  private sessionId = ''
  private lastInputTokens = 0
  private totalOutputTokens = 0
  private totalCostUsd = 0
  private anyPriced = false
  private finished = false

  constructor(private readonly deps: ConversationDeps) {}

  abort(): void {
    this.controller.abort()
  }

  setModel(model: string): void {
    this.nextModel = model
  }

  enqueueUserMessage(text: string): void {
    if (text) this.pendingInputs.push(text)
  }

  /** Inbound peer-chat LISTEN: pull new team-room posts (since the run cursor)
   *  via the attached TeamChat MCP and enqueue them as user-role evidence — the
   *  wrapped post already carries the isUser=false tag, so a teammate post is
   *  context to synthesize, never an instruction that overrides policy. The FIRST
   *  pull only baselines the cursor (the initial room context already rides turn
   *  1's message, so history isn't re-ingested). Best-effort + a no-op when
   *  teamchat isn't attached — a subscribe failure never breaks the run. */
  private async pullPeerInbox(): Promise<void> {
    const mcp = this.deps.mcp
    if (!mcp || !mcp.owns('team_chat_subscribe')) return
    try {
      const outcome = await mcp.callTool('team_chat_subscribe', { sinceSeq: this.peerCursor ?? 0 })
      if (outcome.isError) return
      const parsed = JSON.parse(outcome.output) as {
        posts?: Array<{ wrapped?: string }>
        nextSeq?: number
      }
      const baseline = this.peerCursor === null
      if (typeof parsed.nextSeq === 'number') this.peerCursor = parsed.nextSeq
      if (baseline) return
      for (const p of parsed.posts ?? []) if (p.wrapped) this.enqueueUserMessage(p.wrapped)
    } catch {
      /* listening is best-effort — never break the run on a subscribe failure */
    }
  }

  async run(): Promise<void> {
    const { config, client, opts, ctx, emit } = this.deps
    const uuid = this.deps.uuid ?? randomUUID
    this.sessionId = `native-${uuid()}`
    emit({ type: 'init', sessionId: this.sessionId, model: client.activeModel() })

    // Same-runtime continuation: reload the predecessor transcript. A miss is
    // a fresh start (the prose handoff in opts.context carries continuity).
    if (ctx.resume && ctx.homeDir) {
      const prior = await loadSessionTranscript(ctx.homeDir, ctx.resume)
      if (prior) this.messages = prior
    }

    const system = `${config.systemPrompt}\n\nToday: ${dateStamp(new Date())}`
    const { tools, dispatch } = await this.buildToolUniverse()

    const turn1 = [opts.context, opts.message].filter(Boolean).join('\n\n')
    if (turn1) this.messages.push({ role: 'user', content: [{ type: 'text', text: turn1 }] })

    const maxTurns = config.maxTurns ?? DEFAULT_MAX_TURNS
    let finalText = ''

    for (let turn = 1; turn <= maxTurns; turn++) {
      if (this.controller.signal.aborted)
        return this.terminal({ aborted: true, summary: finalText })
      // LISTEN: pull any peer posts that landed in the team room since this run's
      // cursor and enqueue them as evidence for this turn. A no-op when teamchat
      // isn't attached; never forces continuation (a pending input is consumed
      // only if the model keeps the loop alive by calling tools).
      await this.pullPeerInbox()
      for (const text of this.pendingInputs.splice(0)) {
        this.messages.push({ role: 'user', content: [{ type: 'text', text }] })
      }
      if (this.nextModel) {
        client.setModel(this.nextModel)
        this.nextModel = null
      }

      let turnText = ''
      const calls: Array<{ id: string; name: string; input: unknown }> = []
      let usage: Usage = { inputTokens: 0, outputTokens: 0 }
      try {
        for await (const ev of client.streamTurn({
          system,
          messages: this.messages,
          tools,
          maxOutputTokens: MAX_OUTPUT_TOKENS,
          signal: this.controller.signal,
        })) {
          if (ev.type === 'text') {
            turnText += ev.delta
            emit({ type: 'text', text: ev.delta })
          } else if (ev.type === 'reasoning') {
            emit({ type: 'text', text: ev.delta, channel: 'reasoning' })
          } else if (ev.type === 'tool-call') {
            calls.push({ id: ev.id, name: ev.name, input: ev.input })
          } else {
            usage = {
              inputTokens: ev.inputTokens,
              outputTokens: ev.outputTokens,
              ...(ev.cachedInputTokens != null ? { cachedInputTokens: ev.cachedInputTokens } : {}),
            }
          }
        }
      } catch (err) {
        if (this.controller.signal.aborted) {
          return this.terminal({ aborted: true, summary: finalText || turnText })
        }
        const pe = err instanceof ProviderError ? err : null
        return this.terminal({
          ok: false,
          summary: finalText || turnText,
          errorMessage: err instanceof Error ? err.message : String(err),
          ...(pe ? { errorCode: pe.code } : {}),
        })
      }

      // Account the turn + emit its cost DELTA (live budget signal).
      this.lastInputTokens = usage.inputTokens
      this.totalOutputTokens += usage.outputTokens
      const priced = priceTurn(client.activeModel(), usage)
      if (priced.costUsd != null) {
        this.totalCostUsd += priced.costUsd
        this.anyPriced = true
      }
      emit({
        type: 'turn',
        usage,
        costUsd: priced.costUsd,
        ...(priced.estimated ? { estimated: true } : {}),
        model: client.activeModel(),
      })

      // Commit the assistant turn to the transcript.
      const assistantParts: NeutralContentPart[] = []
      if (turnText) assistantParts.push({ type: 'text', text: turnText })
      for (const c of calls)
        assistantParts.push({ type: 'tool-call', id: c.id, name: c.name, input: c.input })
      this.messages.push({ role: 'assistant', content: assistantParts })

      if (calls.length === 0) {
        finalText = turnText || finalText
        return this.terminal({ ok: true, summary: finalText })
      }

      // Execute the calls; results feed the next turn.
      const results: NeutralContentPart[] = []
      for (const c of calls) {
        emit({ type: 'tool-call', id: c.id, name: c.name, input: c.input })
        if (this.controller.signal.aborted)
          return this.terminal({ aborted: true, summary: turnText || finalText })
        const outcome = await dispatch(c.name, asArgs(c.input))
        emit({
          type: 'tool-result',
          id: c.id,
          name: c.name,
          output: outcome.output,
          isError: outcome.isError,
        })
        if (outcome.denied) {
          // A broker policy denial — a non-fatal, TYPED signal (the run continues:
          // the model sees the denied tool-result and may retry). The host's
          // circuit breaker trips on repeated identical denials.
          emit({ type: 'error', code: 'policy_denied', message: outcome.denied, fatal: false })
        }
        results.push({
          type: 'tool-result',
          id: c.id,
          output: outcome.output,
          isError: outcome.isError,
        })
      }
      this.messages.push({ role: 'user', content: results })
      finalText = turnText || finalText
    }

    return this.terminal({ maxTurns: true, summary: finalText })
  }

  /** Tool universe: local (private-plane) tools + the shared MCP spine,
   *  blocklist-filtered, sorted by name (deterministic order is a cache key),
   *  built ONCE before turn 1. The native runtime can genuinely ENFORCE the
   *  blocklist — a stripped tool is invisible to the model. */
  private async buildToolUniverse(): Promise<{
    tools: NeutralToolDef[]
    dispatch: (name: string, args: Record<string, unknown>) => Promise<NativeToolOutcome>
  }> {
    const { mcp, localTools, opts } = this.deps
    const blocked = new Set(opts.childToolBlocklist ?? [])
    const defs: NeutralToolDef[] = []
    const local = new Map<string, NativeLocalTool>()

    for (const tool of localTools) {
      if (blocked.has(tool.name)) continue
      local.set(tool.name, tool)
      defs.push({ name: tool.name, description: tool.description, inputSchema: tool.inputSchema })
    }
    if (mcp) {
      for (const tool of await mcp.listTools()) {
        if (blocked.has(tool.name) || local.has(tool.name)) continue
        defs.push({
          name: tool.name,
          description: tool.description ?? '',
          inputSchema: tool.inputSchema ?? { type: 'object' },
        })
      }
    }
    defs.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))

    const dispatch = async (
      name: string,
      args: Record<string, unknown>,
    ): Promise<NativeToolOutcome> => {
      const localTool = local.get(name)
      if (localTool) return localTool.run(args)
      if (mcp?.owns(name)) return mcp.callTool(name, args)
      return { output: `unknown tool: ${name}`, isError: true }
    }
    return { tools: defs, dispatch }
  }

  private async terminal(t: TerminalInput): Promise<void> {
    if (this.finished) return
    this.finished = true
    const { ctx, db, emit, opts, mcp } = this.deps

    // ALL terminals persist the transcript (the private plane survives aborts
    // and errors too) + the registry-visible session row. Best-effort — but a
    // persist FAILURE is the loss of the stated "private plane survives" guarantee,
    // so warn (don't silently swallow) the way the MCP supervisor logs-then-degrades.
    await saveSessionTranscript(ctx.homeDir ?? null, this.sessionId, this.messages).catch(
      (err: unknown) =>
        (this.deps.log ?? defaultLog).warn(
          { err, sessionId: this.sessionId },
          'native: transcript persist failed (non-fatal)',
        ),
    )
    upsertNativeSessionRow(db, {
      sessionId: this.sessionId,
      agentId: opts.agentId,
      status: t.ok ? 'closed' : 'active',
    })
    await mcp?.close().catch(() => {})

    emit({
      type: 'result',
      ok: t.ok ?? false,
      summary: t.summary ?? '',
      sessionId: this.sessionId,
      usage: { inputTokens: this.lastInputTokens, outputTokens: this.totalOutputTokens },
      costUsd: this.anyPriced ? Math.round(this.totalCostUsd * 1e6) / 1e6 : null,
      ...(t.aborted ? { aborted: true } : {}),
      ...(t.maxTurns ? { maxTurns: true } : {}),
      ...(t.errorMessage ? { errorMessage: t.errorMessage } : {}),
      ...(t.errorCode ? { errorCode: t.errorCode } : {}),
    })
  }
}

function asArgs(input: unknown): Record<string, unknown> {
  return input && typeof input === 'object' && !Array.isArray(input)
    ? (input as Record<string, unknown>)
    : {}
}
