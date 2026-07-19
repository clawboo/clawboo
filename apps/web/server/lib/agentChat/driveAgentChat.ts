// driveAgentChat — the 1:1 conversational runner for a clawboo-native agent's
// PERSONAL chat (the Boo-Zero personal chat + any native agent's 1:1 chat).
//
// Why this exists: the ChatPanel 1:1 send path historically routed through the
// OpenClaw Gateway (`client.chat.send`), which only knows OpenClaw agents. A native
// Boo Zero is NOT a Gateway agent, so that path errored ("Agent <id> no longer
// exists in configuration"). This is the native equivalent: a stripped-down sibling
// of teamChat/serverDeliver that runs ONE conversational turn (no board, no
// orchestrator, no delegation), streams the reply's tokens to the per-session
// chatDeltaBus, and lets the native driver persist the committed reply
// (persistNativeChatEntry, under `agent:<id>:native`). OpenClaw agents keep the
// Gateway 1:1 path; this is only for clawboo-native agents.

import { mkdir } from 'node:fs/promises'

import { agents, getSetting, recordSpend, setSetting, type ClawbooDb } from '@clawboo/db'
import {
  resolveRuntimeIntegration,
  type RunHandle,
  type RuntimeAdapter,
  type RuntimeEvent,
} from '@clawboo/executor'
import { usdToFractionalCents } from '@clawboo/governance'
import { eq } from 'drizzle-orm'

import { homeDispatchMutex } from '../executorRunner'
import { adapterFactoryFor } from '../runtimes'
import { getDescriptor, isRuntimeId } from '../runtimes/descriptor'
import { runtimeIdentityHomePath } from '../runtimes/identityHome'
import { persistNativeChatEntry } from '../runtimes/native/nativeDriver'
import type { RuntimeRunContext } from '../runtimes/types'
import { resolveRuntimeKeyForRuntime } from '../secretsVault'
import { publishAgentStatus } from '../teamChat/agentStatusBus'
import { publishChatDelta } from '../teamChat/chatDeltaBus'

const NATIVE_RUNTIME = 'clawboo-native'

/** The 1:1 chat session key for an agent (the session ChatPanel reads/writes). */
export function nativeChatSessionKey(agentId: string): string {
  return `agent:${agentId}:native`
}

/** Settings-KV key holding the LATEST native harness session id for an agent's 1:1
 *  chat — the resumable handle so each turn CONTINUES the conversation instead of
 *  starting fresh. Cleared on `/reset` (see `chatHistoryDELETE`) + swept on agent
 *  delete (see `perAgentSettingKeys`). */
export function nativeChatSessionSettingKey(agentId: string): string {
  return `native-chat-session:${agentId}`
}

/** sessionKey → the live conversational run, so a Stop can abort it. Module-level:
 *  a native agent has exactly one 1:1 session, and the composer disables while busy,
 *  so at most one run per agent is in flight. */
const abortMap = new Map<string, { adapter: RuntimeAdapter; run: RunHandle }>()

/** Vault → spawned-run env (mirrors serverDeliver.buildApiKeyEnv). */
function buildApiKeyEnv(runtime: string): Record<string, string> {
  const env: Record<string, string> = {}
  if (!isRuntimeId(runtime)) return env
  const d = getDescriptor(runtime)
  for (const v of [d.envVar, ...(d.altEnvVars ?? [])]) {
    if (!v) continue
    const key = resolveRuntimeKeyForRuntime(runtime, v)
    if (key) env[v] = key
  }
  return env
}

/** Whether this agent's 1:1 chat runs through the native path (vs the OpenClaw
 *  Gateway path). Only clawboo-native agents are conversational here. */
export function isNativeChatAgent(db: ClawbooDb, agentId: string): boolean {
  const row = db
    .select({ runtime: agents.runtime })
    .from(agents)
    .where(eq(agents.id, agentId))
    .get() as { runtime?: string | null } | undefined
  return row?.runtime === NATIVE_RUNTIME
}

/** Abort the in-flight conversational turn for a native agent (the Stop button). */
export async function stopAgentChat(agentId: string): Promise<void> {
  const sk = nativeChatSessionKey(agentId)
  const entry = abortMap.get(sk)
  if (!entry) return
  abortMap.delete(sk)
  await entry.adapter.abort(entry.run).catch(() => undefined)
}

export interface DriveAgentChatParams {
  db: ClawbooDb
  agentId: string
  /** The context-injected message delivered to the model (rules block + any @team
   *  brief/history are prepended client-side, exactly as the Gateway path did). */
  message: string
  mcpBaseUrl: string | null
  /** TEST seam: inject the adapter, bypassing the DB runtime lookup + the home mutex
   *  + the real driver factory. Production omits it → the real path runs. */
  makeAdapter?: (agentId: string) => RuntimeAdapter | null
}

/**
 * Run ONE conversational turn for a native agent's 1:1 chat. The caller does NOT
 * await this (it's detached — the reply streams via the SSE + is persisted by the
 * native driver). Streams the running assistant text to the per-session
 * `chatDeltaBus` (the SSE's ephemeral delta channel) and records the run's spend
 * (agent scope; a paused CAP budget aborts). Serializes on the native home mutex so
 * a concurrent team run / routine for the SAME native agent can't clash its
 * state.db. Best-effort — never throws.
 */
export async function driveAgentChat(params: DriveAgentChatParams): Promise<void> {
  const { db, agentId, message, mcpBaseUrl } = params
  const sessionKey = nativeChatSessionKey(agentId)

  const row = db.select().from(agents).where(eq(agents.id, agentId)).get() as
    | { id: string; runtime?: string | null }
    | undefined
  const runtime = row?.runtime ?? null

  let adapter: RuntimeAdapter
  let homeDir: string | null = null
  if (params.makeAdapter) {
    const injected = params.makeAdapter(agentId)
    if (!injected) return
    adapter = injected
  } else {
    // Only native agents are conversational here (OpenClaw uses the Gateway path).
    if (runtime !== NATIVE_RUNTIME) return
    const factory = adapterFactoryFor(runtime)
    let homeKind = 'ephemeral'
    try {
      homeKind = resolveRuntimeIntegration(factory({}).capabilities()).home.kind
    } catch {
      // Can't read caps → treat as ephemeral (the conservative default).
    }
    homeDir = homeKind === 'persistent' ? runtimeIdentityHomePath(runtime, agentId) : null
    const apiKeyEnv = buildApiKeyEnv(runtime)
    // CONTINUATION: resume the prior turn's session so the conversation is genuine —
    // the harness reloads the persisted transcript from the persistent home
    // (loadSessionTranscript(homeDir, resume)) instead of starting fresh each turn.
    // Empty pointer (first turn / after /reset) → a fresh session.
    const priorSessionId = getSetting(db, nativeChatSessionSettingKey(agentId)) || null
    const ctx: RuntimeRunContext = {
      model: null,
      resume: homeDir ? priorSessionId : null,
      mcpBaseUrl,
      // A 1:1 chat has no team — agent + global memory scope.
      memoryScope: { teamId: null, agentId },
      ...(homeDir ? { homeDir } : {}),
      ...(Object.keys(apiKeyEnv).length ? { apiKeyEnv } : {}),
    }
    adapter = factory(ctx)
  }

  const capturedHomeDir = homeDir

  const runJob = async (): Promise<void> => {
    if (capturedHomeDir)
      await mkdir(capturedHomeDir, { recursive: true, mode: 0o700 }).catch(() => undefined)
    let run: RunHandle
    try {
      // No childToolBlocklist / delegate tool: a 1:1 run is a conversation, not a
      // delegation. The native driver omits the `delegate` tool for a non-team
      // session key by construction (see nativeDriver.ts).
      run = await adapter.start({ taskId: null, teamId: null }, { agentId, sessionKey, message })
    } catch {
      return
    }
    abortMap.set(sessionKey, { adapter, run })
    // Left-pane liveness: flip the agent's badge to Working for the turn (the SSE
    // stream forwards this as an ephemeral `status` event; the thin client patches
    // the fleet store — nothing else reports run-state for a native 1:1 turn).
    publishAgentStatus(sessionKey, { agentId, status: 'running' })
    // Accumulate the run's user-visible assistant text; publish the RUNNING total on
    // each delta (REPLACE semantics matching the client store). Tolerate BOTH delta
    // conventions (native emits incremental chunks; a cumulative delta REPLACES).
    let acc = ''
    // Stream-without-commit belt (mirrors serverDeliver): a turn that streamed live
    // tokens but will never land a committed row must not leave a StreamingCard
    // that lingers-then-vanishes. Two arms below: a turn that DIED mid-reply
    // (fatal error / max-turns / dead stream) commits the watched partial text —
    // the team-path parity, so it survives reload; a user Stop (`done:aborted`)
    // stays discarded (the client cleared optimistically — the Gateway 1:1 Stop
    // convention) and gets one CLEARING delta instead.
    let publishedDelta = false
    let sawCleanCommit = false
    let userAborted = false
    let fatalError = false
    let errorMessage: string | null = null
    try {
      for await (const ev of adapter.events(run) as AsyncIterable<RuntimeEvent>) {
        if (ev.kind === 'text-delta' && ev.channel !== 'reasoning') {
          acc = acc && ev.text.startsWith(acc) ? ev.text : acc + ev.text
          if (acc) {
            publishChatDelta(sessionKey, { sessionKey, runId: ev.runId, text: acc })
            publishedDelta = true
          }
        }
        if (ev.kind === 'cost' && ev.costUsd != null && ev.costUsd > 0) {
          const r = recordSpend(db, 'agent', agentId, usdToFractionalCents(ev.costUsd))
          if (r?.status === 'paused' && r.mode === 'cap')
            await adapter.abort(run).catch(() => undefined)
        }
        const terminal = ev.kind === 'done' || (ev.kind === 'error' && ev.fatal)
        if (terminal) {
          // The native driver's own persist condition (`result && ev.ok` + non-empty
          // text) — only a matching terminal produces the committed row that clears
          // the client's streaming card.
          sawCleanCommit = ev.kind === 'done' && ev.reason === 'success' && !!ev.summary?.trim()
          userAborted = ev.kind === 'done' && ev.reason === 'aborted'
          fatalError = ev.kind === 'error' || (ev.kind === 'done' && ev.reason === 'error')
          if (ev.kind === 'error') errorMessage = ev.message || null
          break
        }
      }
    } catch {
      // Stream / observer error — fall through to cleanup (the driver persisted
      // whatever reply it produced; a partial run just ends).
    }
    abortMap.delete(sessionKey)
    if (!sawCleanCommit && !userAborted && acc.trim()) {
      // Died mid-reply: commit the partial the user watched (the SSE tail replays
      // it as a committed frame, which also clears the client's StreamingCard).
      persistNativeChatEntry(db, agentId, acc)
    } else if (!sawCleanCommit && !userAborted && fatalError) {
      // Failed BEFORE any text streamed (the classic: no provider key). This used
      // to be a completely silent non-response — optimistic bubble, brief Working
      // badge, then nothing, under a green header. Persist a visible meta with the
      // REASON so the user always learns why (and how to fix a keyless runtime).
      const friendly = /no provider key/i.test(errorMessage ?? '')
        ? 'Clawboo Native has no provider key connected. Open Settings → Runtimes → Clawboo Native to connect a provider.'
        : `The run failed: ${errorMessage ?? 'unknown error'}`
      persistNativeChatEntry(db, agentId, friendly, { kind: 'meta', role: 'system' })
      if (publishedDelta) publishChatDelta(sessionKey, { sessionKey, runId: null, text: '' })
    } else if (publishedDelta && !sawCleanCommit) {
      publishChatDelta(sessionKey, { sessionKey, runId: null, text: '' })
    }
    // Turn over — back to Idle (or Error for a failed run) either way.
    publishAgentStatus(sessionKey, { agentId, status: fatalError ? 'error' : 'idle' })
    // CONTINUATION: remember THIS turn's harness session id so the NEXT turn resumes
    // it (the harness saved the cumulative transcript under it at the terminal, before
    // emitting `done`). Best-effort — only when the runtime persists (homeDir) + exposes
    // a session codec (the fake test adapter does not, so this no-ops there).
    if (capturedHomeDir && adapter.sessionCodec) {
      try {
        const blob = await adapter.sessionCodec.serialize(run)
        const sid = (JSON.parse(blob) as { sessionId?: string | null }).sessionId
        if (sid) setSetting(db, nativeChatSessionSettingKey(agentId), sid)
      } catch {
        // A missing/unparseable id just means the next turn starts fresh.
      }
    }
  }

  // A persistent-home runtime (native) serializes on the home mutex — held across
  // the whole drain so a concurrent executor run / routine / team turn for the same
  // (runtime, agent) can't overlap its session / native state.db.
  const job = capturedHomeDir ? () => homeDispatchMutex.run(capturedHomeDir, runJob) : runJob
  await job().catch(() => undefined)
}
