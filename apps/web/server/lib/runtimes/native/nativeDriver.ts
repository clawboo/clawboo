// Real native driver — hosts the in-process conversational harness behind the
// same driver seam every other runtime uses (buffer-until-subscribe, one
// driver per run). Unlike the subprocess drivers there is no child process:
// `start()` wires AgentConfig (settings KV) + the routed provider client + the
// in-process MCP bridge + the cwd-jailed file tools into a Conversation and
// lets its turn loop emit native events. The provider SDKs are lazy-imported
// inside the provider clients, so booting the server costs nothing.

import { randomUUID } from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'

import type { NativeDriver, NativeEvent } from '@clawboo/adapter-native'
import { chatMessages, createDb, type ClawbooDb } from '@clawboo/db'
import type { StartOpts } from '@clawboo/executor'

import { getDbPath } from '../../db'
import type { RuntimeRunContext } from '../types'
import { loadAgentConfigOrDefault } from './agentConfigStore'
import { Conversation } from './conversation'
import { buildFileTools } from './fileTools'
import { connectMcpBridge, type McpBridge } from './mcpBridge'
import { createRoutedClient, type RoutedProviderClient } from './routeCall'

export interface NativeDriverDeps {
  /** Test seam: a scripted provider client replaces the routed real one. */
  client?: RoutedProviderClient
  /** Test seam: replace the MCP bridge (null = no MCP). */
  mcp?: McpBridge | null
  db?: ClawbooDb
  uuid?: () => string
}

/** Persist the agent's final reply into its chat history so the conversation
 *  shows in the UI chat panel (sessionKey `agent:<id>:native`). Best-effort —
 *  narrative, never load-bearing. */
export function persistNativeChatEntry(db: ClawbooDb, agentId: string, text: string): void {
  try {
    if (!text.trim()) return
    const now = Date.now()
    db.insert(chatMessages)
      .values({
        sessionKey: `agent:${agentId}:native`,
        gatewayUrl: 'native',
        entryId: `native-${randomUUID()}`,
        timestampMs: now,
        data: JSON.stringify({
          entryId: `native-chat-${now}`,
          role: 'assistant',
          kind: 'assistant',
          text,
          sessionKey: `agent:${agentId}:native`,
          runId: null,
          source: 'runtime-agent',
          timestampMs: now,
          sequenceKey: now,
          confirmed: true,
          fingerprint: `native:${now}`,
        }),
      })
      .run()
  } catch {
    // best-effort
  }
}

export function createNativeDriver(
  opts: StartOpts,
  ctx: RuntimeRunContext,
  deps: NativeDriverDeps = {},
): NativeDriver {
  const handlers = new Set<(ev: NativeEvent) => void>()
  const buffered: NativeEvent[] = []
  let subscribed = false
  let started = false
  let conversation: Conversation | null = null
  let pendingModel: string | null = null

  const db = deps.db ?? createDb(getDbPath())

  const push = (ev: NativeEvent): void => {
    if (ev.type === 'result' && ev.ok) persistNativeChatEntry(db, opts.agentId, ev.summary)
    if (!subscribed) {
      buffered.push(ev)
      return
    }
    for (const h of [...handlers]) h(ev)
  }

  async function run(): Promise<void> {
    try {
      const config = loadAgentConfigOrDefault(db, opts.agentId)
      const client = deps.client ?? createRoutedClient(config, ctx.apiKeyEnv)
      const mcp =
        deps.mcp !== undefined
          ? deps.mcp
          : await connectMcpBridge({
              dbPath: getDbPath(),
              agentId: opts.agentId,
              enable: {
                tasks: config.tools.tasks,
                memory: config.tools.memory,
                tools: config.tools.tools,
                teamchat: config.tools.teamchat,
              },
              ...(ctx.memoryScope ? { memoryScope: ctx.memoryScope } : {}),
            })
      conversation = new Conversation({
        config,
        client,
        mcp,
        localTools: buildFileTools(ctx.cwd ?? null),
        opts,
        ctx,
        db,
        emit: push,
        ...(deps.uuid ? { uuid: deps.uuid } : {}),
      })
      if (pendingModel) {
        conversation.setModel(pendingModel)
        pendingModel = null
      }
      await conversation.run()
    } catch (err) {
      push({
        type: 'result',
        ok: false,
        summary: '',
        errorMessage: err instanceof Error ? err.message : String(err),
      })
    }
  }

  return {
    async start(): Promise<void> {
      if (started) return
      started = true
      void run()
    },
    onEvent(handler: (ev: NativeEvent) => void): () => void {
      handlers.add(handler)
      if (!subscribed) {
        subscribed = true
        const pending = buffered.splice(0)
        for (const ev of pending) handler(ev)
      }
      return () => handlers.delete(handler)
    },
    async abort(): Promise<void> {
      conversation?.abort()
    },
    async setModel(model: string): Promise<void> {
      if (conversation) conversation.setModel(model)
      else pendingModel = model
    },
    async writeContext(key: string, value: string): Promise<void> {
      if (!ctx.cwd) return
      const target = path.join(ctx.cwd, key)
      await mkdir(path.dirname(target), { recursive: true })
      await writeFile(target, value, 'utf8')
    },
  }
}
