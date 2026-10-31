// driveAgentChat: the 1:1 conversational runner for every agent the SERVER runs:
// Clawboo Native (including the Boo-Zero personal chat), Claude Code, Codex and
// Hermes.
//
// Why this exists: the ChatPanel 1:1 send path historically routed through the
// OpenClaw Gateway (`client.chat.send`), which only knows OpenClaw agents. Any
// other agent is NOT a Gateway agent, so that path errored ("Agent <id> no longer
// exists in configuration") or, with no Gateway connected, offered no box at all.
// This is the server equivalent: a stripped-down sibling of teamChat/serverDeliver
// that runs ONE conversational turn (no board, no orchestrator, no delegation),
// streams the reply's tokens to the per-session chatDeltaBus, and commits the
// reply under the agent's 1:1 key (see directChatSessionKey). The native driver
// commits its own reply (persistNativeChatEntry); for the other runtimes this
// drain commits it. OpenClaw agents keep the Gateway 1:1 path.

import { mkdir } from 'node:fs/promises'

import { agents, getSetting, recordSpend, setSetting, type ClawbooDb } from '@clawboo/db'
import {
  DEFAULT_RUN_SILENT_TIMEOUT_MS,
  resolveRuntimeIntegration,
  withIdleTimeout,
  type RunHandle,
  type RuntimeAdapter,
  type RuntimeEvent,
} from '@clawboo/executor'
import { usdToFractionalCents } from '@clawboo/governance'
import { nativeChatSessionKey } from '@clawboo/team-orchestration'
import { MutexAcquireTimeoutError } from '@clawboo/worktrees'
import { eq } from 'drizzle-orm'

import { HOME_MUTEX_ACQUIRE_MS, homeDispatchMutex } from '../executorRunner'
import { getMcpAttachSecret } from '../mcpAttachSecret'
import { RUN_ENDED_WITHOUT_RESULT, runFailureText } from '../runFailureText'
import { adapterFactoryFor, type RuntimeAdapterFactory } from '../runtimes'
import { getDescriptor, isOrchestratableRuntimeId, isRuntimeId } from '../runtimes/descriptor'
import { runtimeIdentityHomePath } from '../runtimes/identityHome'
import { loadAgentConfig } from '../runtimes/native/agentConfigStore'
import { persistNativeChatEntry } from '../runtimes/native/nativeDriver'
import { buildPersonaBlock } from '../runtimes/personaBlock'
import { createRunCostTally } from '../runtimes/runCostTally'
import { ensureTeamWorkdir, taskRunWorkdirFor } from '../runtimes/teamWorkdir'
import type { RuntimeRunContext } from '../runtimes/types'
import { resolveRuntimeKeyForRuntime } from '../secretsVault'
import { publishAgentStatus } from '../teamChat/agentStatusBus'
import { publishChatDelta } from '../teamChat/chatDeltaBus'
import { parseCodingModelConfig } from '../teamChat/serverDeliver'
import { directChatSessionKey } from './directChatSessionKey'
import { buildMemoryRecall } from './memoryRecall'

const NATIVE_RUNTIME = 'clawboo-native'

// The 1:1 chat key lives with the other session-key shapes so every writer agrees
// on what a person's chat is. Re-exported here because this module is where the
// 1:1 chat path is read from.
export { directChatSessionKey, nativeChatSessionKey }

/** Settings-KV key holding the LATEST harness session id for an agent's 1:1 chat:
 *  the resumable handle so each turn CONTINUES the conversation instead of starting
 *  fresh. One per agent whatever its runtime (an agent has one runtime and one 1:1
 *  chat); the `native-` prefix is historical. Cleared on `/reset` (see
 *  `chatHistoryRESETCONTEXT`) + swept on agent delete (see `perAgentSettingKeys`). */
export function nativeChatSessionSettingKey(agentId: string): string {
  return `native-chat-session:${agentId}`
}

/** agentId → the live conversational run, so a Stop can abort it. Module-level: an
 *  agent has exactly one 1:1 chat, and its turns run one at a time (see the lock in
 *  `driveAgentChat`), so at most one run per agent is in flight. */
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

function agentRuntime(db: ClawbooDb, agentId: string): string | null {
  const row = db
    .select({ runtime: agents.runtime })
    .from(agents)
    .where(eq(agents.id, agentId))
    .get() as { runtime?: string | null } | undefined
  return row?.runtime ?? null
}

/** Whether this agent's 1:1 chat runs on the server (vs the OpenClaw Gateway path):
 *  every runtime the server drives itself. */
export function isServerChatAgent(db: ClawbooDb, agentId: string): boolean {
  const runtime = agentRuntime(db, agentId)
  return !!runtime && isOrchestratableRuntimeId(runtime)
}

/** The 1:1 chat key of a stored agent (the native key for an unknown agent). */
export function agentChatSessionKey(db: ClawbooDb, agentId: string): string {
  return directChatSessionKey(agentId, agentRuntime(db, agentId))
}

/** Abort the in-flight conversational turn for an agent (the Stop button). */
export async function stopAgentChat(agentId: string): Promise<void> {
  const entry = abortMap.get(agentId)
  if (!entry) return
  abortMap.delete(agentId)
  await entry.adapter.abort(entry.run).catch(() => undefined)
}

export interface DriveAgentChatParams {
  db: ClawbooDb
  agentId: string
  /** The context-injected message delivered to the model (rules block + any @team
   *  brief/history are prepended client-side, exactly as the Gateway path did). */
  message: string
  mcpBaseUrl: string | null
  /** TEST seam: inject the adapter, bypassing the runtime guard + the real driver
   *  factory. It is handed the run context the real factory would get. Production
   *  omits it → the real path runs. */
  makeAdapter?: (agentId: string, ctx: RuntimeRunContext) => RuntimeAdapter | null
}

/**
 * Run ONE conversational turn for an agent's 1:1 chat. The caller does NOT await
 * this (it's detached: the reply streams via the SSE). Streams the running
 * assistant text to the per-session `chatDeltaBus` (the SSE's ephemeral delta
 * channel), commits the reply, and records the run's spend (agent scope; a paused
 * CAP budget aborts). Turns for one agent run one at a time: a persistent-home
 * runtime on its home mutex (shared with team runs and routines for the same
 * agent), any other on a per-agent chat lock. Best-effort: never throws.
 */
export async function driveAgentChat(params: DriveAgentChatParams): Promise<void> {
  const { db, agentId, message, mcpBaseUrl } = params

  const row = db.select().from(agents).where(eq(agents.id, agentId)).get() as
    | { id: string; runtime?: string | null; execConfig?: string | null; teamId?: string | null }
    | undefined
  const runtime = row?.runtime ?? null
  const sessionKey = directChatSessionKey(agentId, runtime)
  const pointerKey = nativeChatSessionSettingKey(agentId)
  // The native driver writes its own reply into the 1:1 chat (see nativeDriver);
  // every other runtime's reply is committed by this drain.
  const driverCommitsReply = runtime === NATIVE_RUNTIME
  const persist = (text: string, meta = false): void =>
    persistNativeChatEntry(db, agentId, text, {
      sessionKey,
      ...(meta ? { kind: 'meta' as const, role: 'system' as const } : {}),
    })

  let factory: RuntimeAdapterFactory | null = null
  let homeDir: string | null = null
  let resumable = false
  if (!params.makeAdapter) {
    // OpenClaw (and any unknown runtime) is not driven here: it uses the Gateway path.
    if (!runtime || !isOrchestratableRuntimeId(runtime)) return
    factory = adapterFactoryFor(runtime)
    let homeKind = 'ephemeral'
    try {
      const caps = factory({}).capabilities()
      homeKind = resolveRuntimeIntegration(caps).home.kind
      resumable = caps.resume === true
    } catch {
      // Can't read caps → treat as ephemeral (the conservative default).
    }
    homeDir = homeKind === 'persistent' ? runtimeIdentityHomePath(runtime, agentId) : null
  }
  // A coding runtime may carry a per-agent model + provider on its row (the Hermes
  // model picker), exactly as its team runs do. Native reads its own config.
  const codingModel =
    runtime !== NATIVE_RUNTIME ? parseCodingModelConfig(row?.execConfig ?? null) : null
  // Every server-run agent starts in its team folder (`_no-team` for an agent on no
  // team), the same folder its team chat uses, never in the server's working
  // directory, which for an installed clawboo is its state dir (the database and the
  // secrets vault). For Claude Code, Codex and Hermes it only sets where the run
  // starts. Native's file tools are confined to it, and its shell, when switched on
  // for that Boo, starts there and asks a person before every command.
  const workdir = taskRunWorkdirFor(runtime, row?.teamId)

  const runJob = async (): Promise<void> => {
    if (homeDir) await mkdir(homeDir, { recursive: true, mode: 0o700 }).catch(() => undefined)
    // CONTINUATION, read while holding the lock: a message queued behind a running
    // turn must resume the session that turn just saved, not the one both turns saw
    // when they were sent. Empty pointer (first turn / after /reset) → a fresh session.
    const priorSessionId = getSetting(db, pointerKey) || null

    if (workdir) {
      try {
        await ensureTeamWorkdir(workdir)
      } catch (err) {
        // Never fall back to the server's working directory.
        persist(
          runFailureText(
            `could not create the working folder ${workdir}: ${err instanceof Error ? err.message : String(err)}`,
            runtime,
          ),
          true,
        )
        return
      }
    }

    const apiKeyEnv = runtime ? buildApiKeyEnv(runtime) : {}
    const ctx: RuntimeRunContext = {
      ...(workdir ? { cwd: workdir } : {}),
      model: codingModel?.model ?? null,
      ...(codingModel?.provider ? { providerHint: codingModel.provider } : {}),
      // Native reloads the transcript from its home, Codex and Hermes resume their
      // own session in theirs, and Claude Code resumes the SDK session by id.
      resume: resumable ? priorSessionId : null,
      mcpBaseUrl,
      // A 1:1 chat has no team: agent + global memory scope.
      memoryScope: { teamId: null, agentId, attachSecret: getMcpAttachSecret(db) },
      ...(homeDir ? { homeDir } : {}),
      ...(Object.keys(apiKeyEnv).length ? { apiKeyEnv } : {}),
    }
    let adapter: RuntimeAdapter
    if (params.makeAdapter) {
      const injected = params.makeAdapter(agentId, ctx)
      if (!injected) return
      adapter = injected
    } else if (factory) {
      adapter = factory(ctx)
    } else {
      return
    }

    // A run with no session to resume is the first turn of a conversation or the
    // first turn after a reset: the boo has its character but none of the facts, so
    // it gets its own notes handed back (see memoryRecall). Claude Code, Codex and
    // Hermes read no agent file, so their persona rides every turn, as it does in
    // team chat (see personaBlock); native and OpenClaw carry their own.
    const recall = priorSessionId ? null : await buildMemoryRecall(db, agentId)
    const context = [buildPersonaBlock(db, agentId, runtime), recall].filter(Boolean).join('\n\n')

    let run: RunHandle
    try {
      // No childToolBlocklist / delegate tool: a 1:1 run is a conversation, not a
      // delegation. The native driver omits the `delegate` tool for a non-team
      // session key by construction (see nativeDriver.ts).
      run = await adapter.start(
        { taskId: null, teamId: null },
        { agentId, sessionKey, message, ...(context ? { context } : {}) },
      )
    } catch (err) {
      // A run that never started would otherwise be a silent non-response.
      persist(runFailureText(err instanceof Error ? err.message : String(err), runtime), true)
      return
    }
    abortMap.set(agentId, { adapter, run })
    // Left-pane liveness + the composer's busy state: the SSE stream forwards this
    // as an ephemeral `status` event (nothing else reports run-state for a 1:1 turn).
    publishAgentStatus(sessionKey, { agentId, status: 'running' })

    // Accumulate the run's user-visible assistant text; publish the RUNNING total on
    // each delta (REPLACE semantics matching the client store). Tolerate BOTH delta
    // conventions (native emits incremental chunks; a cumulative delta REPLACES).
    let acc = ''
    let publishedDelta = false
    let sawTerminal = false
    let committed = false
    let succeeded = false
    let userStopped = false
    let failure: string | null = null
    let lastError: string | null = null
    // Why the SERVER ended the run, when it did. Every runtime reports an abort as
    // a clean `done: 'aborted'`, so without this a kill reads like the user's Stop.
    let serverAbort: string | null = null
    const costTally = createRunCostTally()
    const silentMs =
      Number(process.env['CLAWBOO_RUN_SILENT_TIMEOUT_MS']) || DEFAULT_RUN_SILENT_TIMEOUT_MS
    try {
      for await (const ev of withIdleTimeout(adapter.events(run) as AsyncIterable<RuntimeEvent>, {
        // A wedged subprocess must not hold this agent's lock (and with it its team
        // runs and routines) forever. The abort surfaces `done: aborted`.
        idleMs: silentMs,
        onIdle: async () => {
          serverAbort = 'the run went quiet for too long and was ended'
          await adapter.abort(run).catch(() => undefined)
        },
      })) {
        costTally.observe(ev)
        if (ev.kind === 'text-delta' && ev.channel !== 'reasoning') {
          acc = acc && ev.text.startsWith(acc) ? ev.text : acc + ev.text
          if (acc) {
            publishChatDelta(sessionKey, { sessionKey, runId: ev.runId, text: acc })
            publishedDelta = true
          }
        }
        if (ev.kind === 'cost' && ev.costUsd != null && ev.costUsd > 0) {
          let paused = false
          try {
            const r = recordSpend(db, 'agent', agentId, usdToFractionalCents(ev.costUsd))
            paused = r?.status === 'paused' && r.mode === 'cap'
          } catch {
            // A ledger failure must never end the run without its reply.
          }
          if (paused) {
            serverAbort = 'the run was stopped by a budget cap'
            await adapter.abort(run).catch(() => undefined)
          }
        }
        if (ev.kind === 'error') lastError = ev.message || lastError
        const terminal = ev.kind === 'done' || (ev.kind === 'error' && ev.fatal)
        if (!terminal) continue
        sawTerminal = true
        if (ev.kind === 'done' && ev.reason === 'success') {
          succeeded = true
          if (driverCommitsReply) {
            // The driver's own persist condition (`result && ev.ok` + non-empty text).
            committed = !!ev.summary?.trim()
          } else {
            // What the user watched streaming, or the summary for a runtime that
            // streams nothing (Hermes answers in one piece).
            const text = acc.trim() ? acc : ev.summary
            if (text?.trim()) {
              persist(text)
              committed = true
            }
          }
        } else if (ev.kind === 'done' && ev.reason === 'aborted') {
          userStopped = !serverAbort
          failure = serverAbort
        } else if (ev.kind === 'done' && ev.reason === 'max_turns') {
          failure = lastError ?? 'the run reached its turn limit before it finished'
        } else {
          failure = lastError
        }
        break
      }
    } catch {
      // Stream / observer error: fall through to the cleanup below.
    }
    if (abortMap.get(agentId)?.run === run) abortMap.delete(agentId)

    // A user Stop stays discarded (the client cleared optimistically, the Gateway
    // 1:1 Stop convention). Anything else that did not commit is reported: a turn
    // that DIED mid-reply commits the partial the user watched (it survives reload,
    // and the committed frame clears the client's StreamingCard), and a turn that
    // failed BEFORE any text persists a visible notice with the REASON (the classic:
    // no provider key). The wording is shared with the team-chat drain.
    if (!committed && !userStopped && acc.trim()) {
      persist(acc)
      committed = true
    } else if (!committed && !userStopped && !succeeded) {
      const provider =
        runtime === NATIVE_RUNTIME ? loadAgentConfig(db, agentId)?.primaryProvider : null
      // A stream that died without a terminal never said why, so say exactly that,
      // unless the server ended it (gone quiet, budget cap) and knows the reason.
      persist(
        sawTerminal || serverAbort
          ? runFailureText(sawTerminal ? failure : serverAbort, runtime, provider)
          : RUN_ENDED_WITHOUT_RESULT,
        true,
      )
    }
    if (publishedDelta && !committed)
      publishChatDelta(sessionKey, { sessionKey, runId: null, text: '' })
    // Turn over — back to Idle (or Error for a failed run) either way.
    const failed = !succeeded && !userStopped
    publishAgentStatus(sessionKey, { agentId, status: failed ? 'error' : 'idle' })

    // Price what the cost events did not already charge (Codex and Claude Code
    // report tokens or nothing, never a per-event USD).
    try {
      const cost = costTally.settle({
        model: codingModel?.model ?? null,
        inputChars: context.length + message.length,
        outputChars: acc.length,
      })
      if (cost.unbilledUsd > 0)
        recordSpend(db, 'agent', agentId, usdToFractionalCents(cost.unbilledUsd))
    } catch {
      // Best-effort: a ledger write never breaks the turn.
    }

    // CONTINUATION: remember THIS turn's session id so the NEXT turn resumes it (the
    // harness saved the session before emitting its terminal). Only for a runtime
    // that resumes and exposes a session codec (the fake test adapter does not).
    if (adapter.sessionCodec && adapter.capabilities().resume) {
      if (failed && !serverAbort && priorSessionId && runtime !== NATIVE_RUNTIME) {
        // A failed turn that tried to resume most likely holds a dead handle (codex
        // `exec resume <unknown-id>` exits 1; the Claude SDK cannot find a session
        // from another working folder). Clear it so the next turn starts fresh
        // instead of failing the same way forever. Native reloads a missing
        // transcript as an empty one, so its pointer is kept. A run the server
        // ended (gone quiet, budget cap) had a live session, so it keeps it.
        setSetting(db, pointerKey, '')
      } else {
        try {
          const blob = await adapter.sessionCodec.serialize(run)
          const sid = (JSON.parse(blob) as { sessionId?: string | null }).sessionId
          // Claude Code falls back to the session key when no native id arrived.
          if (sid && sid !== sessionKey) setSetting(db, pointerKey, sid)
        } catch {
          // A missing/unparseable id just means the next turn starts fresh.
        }
      }
    }
  }

  // One turn at a time per agent. A persistent-home runtime takes the home mutex,
  // held across the whole drain so a concurrent executor run / routine / team turn
  // for the same (runtime, agent) can't overlap its session state; any other
  // runtime takes a per-agent chat lock, which keeps the resume pointer honest.
  const lockKey = homeDir ?? `direct-chat:${agentId}`
  await homeDispatchMutex
    .run(lockKey, runJob, { acquireTimeoutMs: HOME_MUTEX_ACQUIRE_MS })
    .catch((err: unknown) => {
      // An ACQUIRE timeout means `runJob` never ran at all: no 'running' status, no
      // delta, no persisted row. Swallowing it would be a silent non-response with
      // nothing on screen to explain it. Every other rejection stays swallowed:
      // `runJob` owns its own reporting and has already surfaced the reason.
      if (err instanceof MutexAcquireTimeoutError) {
        persist(
          'This agent was busy with another run and did not pick the message up in time. Send it again.',
          true,
        )
        publishAgentStatus(sessionKey, { agentId, status: 'idle' })
      }
    })
}
