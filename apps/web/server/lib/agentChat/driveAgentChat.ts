// driveAgentChat: the 1:1 conversational runner for every agent the SERVER runs:
// Clawboo Native (including the Boo-Zero personal chat), Claude Code, Codex and
// Hermes.
//
// Why this exists: the ChatPanel 1:1 send path historically routed through the
// OpenClaw Gateway (`client.chat.send`), which only knows OpenClaw agents. Any
// other agent is NOT a Gateway agent, so that path errored ("Agent <id> no longer
// exists in configuration") or, with no Gateway connected, offered no box at all.
// This is the server equivalent: a stripped-down sibling of teamChat/serverDeliver
// that runs ONE conversational turn (no board, no orchestrator), streams the reply's
// tokens to the per-session chatDeltaBus, and commits the reply under the agent's 1:1
// key (see directChatSessionKey). The native driver commits its own reply
// (persistNativeChatEntry); for the other runtimes this drain commits it. OpenClaw
// agents keep the Gateway 1:1 path. Hand-offs from Boo Zero's chat are not this file's
// business: chatHandOffs wraps a turn and reads what it replied.

import { mkdir } from 'node:fs/promises'

import {
  agents,
  getSetting,
  noteJobRun,
  recordSpend,
  setSetting,
  pauseFor,
  type BudgetRefusalReason,
  type BudgetScope,
  type ClawbooDb,
} from '@clawboo/db'
import {
  DEFAULT_RUN_SILENT_TIMEOUT_MS,
  resolveRuntimeIntegration,
  withIdleTimeout,
  type RunHandle,
  type RuntimeAdapter,
  type RuntimeEvent,
} from '@clawboo/executor'
import { usdToFractionalCents } from '@clawboo/governance'
import { createLogger } from '@clawboo/logger'
import { nativeChatSessionKey } from '@clawboo/team-orchestration'
import { MutexAcquireTimeoutError } from '@clawboo/worktrees'
import { eq } from 'drizzle-orm'

import { auditBudgetCrossing } from '../budgetAudit'
import { reserveRunBudget, type RunBudgetGate, type RunBudgetHold } from '../budgetHold'
import { budgetRefusalText } from '../budgetPreflight'
import { HOME_MUTEX_ACQUIRE_MS, homeDispatchMutex } from '../executorRunner'
import { getMcpAttachSecret } from '../mcpAttachSecret'
import {
  CONVERSATION_TRIMMED_TEXT,
  isPassingCause,
  isRefusedRequest,
  refusedSessionDroppedText,
  RUN_ENDED_WITHOUT_RESULT,
  runFailureText,
  SESSION_DROPPED_TEXT,
  SESSION_NOT_DROPPED_TEXT,
  TURN_TOO_LARGE_TEXT,
} from '../runFailureText'
import { pauseRefusalText, pauseStopNote } from '../pauseBus'
import { RunQueueAbortedError, withRunSlot, PERSON_TURN } from '../runSlots'
import { adapterFactoryFor, type RuntimeAdapterFactory } from '../runtimes'
import { getDescriptor, isOrchestratableRuntimeId, isRuntimeId } from '../runtimes/descriptor'
import { runtimeIdentityHomePath } from '../runtimes/identityHome'
import { loadAgentConfig } from '../runtimes/native/agentConfigStore'
import { boundResumedTranscript } from '../runtimes/native/conversation'
import type { NeutralMessage } from '../runtimes/native/providers/types'
import { persistNativeChatEntry } from '../runtimes/native/nativeDriver'
import { loadSessionTranscript } from '../runtimes/native/sessionStore'
import { buildPersonaBlock } from '../runtimes/personaBlock'
import { estimateTokensFromChars } from '../runtimes/estimateCost'
import { createRunCostTally } from '../runtimes/runCostTally'
import { startFolderRun } from '../runtimes/teamFolderActivity'
import { ensureTeamWorkdir, taskRunWorkdirFor } from '../runtimes/teamWorkdir'
import type { RuntimeRunContext } from '../runtimes/types'
import { recordRunTokens } from '../runTokenLog'
import { resolveRuntimeKeyForRuntime } from '../secretsVault'
import { publishAgentStatus } from '../teamChat/agentStatusBus'
import { publishChatDelta } from '../teamChat/chatDeltaBus'
import { parseCodingModelConfig } from '../teamChat/serverDeliver'
import { directChatSessionKey } from './directChatSessionKey'
import { buildMemoryRecall } from './memoryRecall'

const NATIVE_RUNTIME = 'clawboo-native'

const log = createLogger('agent-chat')

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

/** A resume has to send at most this share of what was refused to be worth keeping. A
 *  trim that barely dropped anything, with the next message on top, sends about the
 *  same again: a long chat hovering at the bound would fail on every retry. */
const RESUME_MUST_SHRINK_TO = 0.9

const transcriptChars = (messages: NeutralMessage[]): number =>
  messages.reduce((n, m) => n + JSON.stringify(m.content).length, 0)

/**
 * Whether resuming a Native session that overflowed sends the model less than the
 * request it refused. The saved transcript IS that request, and a resume sends what
 * `boundResumedTranscript` keeps of it, plus the next message. So when the bound keeps
 * everything or nearly everything, the resume overflows again: one turn that alone
 * overflowed, or a transcript at or under the bound on a model whose window is smaller
 * still. When it drops a real share of it the resume may fit, and the turns it keeps are
 * worth keeping. If what it keeps still overflows, that failed turn's transcript comes
 * back here, smaller, and a short next message settles it: it fits, or it clears. A run
 * of large messages can keep it trimming for as long as they keep coming. A transcript
 * that cannot be read cannot be resumed either.
 */
async function nativeResumeCanShrink(
  homeDir: string | null,
  sessionId: string | null,
): Promise<boolean> {
  if (!sessionId) return false
  try {
    const transcript = await loadSessionTranscript(homeDir, sessionId)
    if (transcript) {
      const kept = boundResumedTranscript(transcript)
      return (
        kept.length < transcript.length &&
        transcriptChars(kept) <= RESUME_MUST_SHRINK_TO * transcriptChars(transcript)
      )
    }
    log.warn({ sessionId, homeDir }, 'native: overflowed session has no readable transcript')
  } catch (err) {
    log.warn({ err, sessionId }, 'native: could not read an overflowed session transcript')
  }
  return false
}

/** agentId → the live conversational run, so a Stop can abort it. Module-level: an
 *  agent has exactly one 1:1 chat, and its turns run one at a time (see the lock in
 *  `driveAgentChat`), so at most one run per agent is in flight. */
const abortMap = new Map<string, { adapter: RuntimeAdapter; run: RunHandle }>()

/** agentId → its turns waiting for a run slot (see runSlots), so a Stop takes them
 *  out of the queue too. */
const queuedTurns = new Map<string, Set<AbortController>>()

/** agentId → its 1:1 turns from the moment they are asked for until they end. */
const turnsUnderWay = new Map<string, number>()

/** Is a 1:1 turn running or waiting to, for this agent? */
export function chatTurnUnderWay(agentId: string): boolean {
  return turnsUnderWay.has(agentId)
}

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

/** Abort the in-flight conversational turn for an agent (the Stop button), and
 *  cancel any of its turns still waiting for a run slot. */
/**
 * A pause covers these 1:1 chats: stop each turn running or waiting for a slot, as a
 * Stop does, and say why in the chat. A person's turn does not wait unseen for a
 * resume, so nothing of it is kept to start later.
 */
export async function stopPausedAgentChats(
  db: ClawbooDb,
  covers: (run: { agentId: string; teamId: string | null }) => boolean,
  note: string,
): Promise<void> {
  const live = new Set<string>([...abortMap.keys(), ...queuedTurns.keys()])
  await Promise.all(
    [...live].map(async (agentId) => {
      const row = db.select().from(agents).where(eq(agents.id, agentId)).get() as
        { runtime?: string | null; teamId?: string | null } | undefined
      if (!covers({ agentId, teamId: row?.teamId ?? null })) return
      void stopAgentChat(agentId)
      persistNativeChatEntry(db, agentId, note, {
        sessionKey: directChatSessionKey(agentId, row?.runtime ?? null),
        kind: 'meta',
        role: 'system',
      })
    }),
  )
}

export async function stopAgentChat(agentId: string): Promise<void> {
  for (const queued of queuedTurns.get(agentId) ?? []) queued.abort()
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
  /** More context for this turn. Read right before the run starts, with the agent's
   *  lock held, so what arrived while the turn waited is in it. */
  turnExtras?: () => string | null
  /** Told how the turn ended, once it has given back its slot and its lock. */
  onTurnEnded?: (ending: ChatTurnEnding) => void | Promise<void>
  /** This turn will try again by itself while a budget's room is set aside, so the chat
   *  has heard why already. */
  quietWhileBudgetHeld?: boolean
  /** This turn carries results a person has not read and goes out again by itself, so a
   *  held budget's note must not ask them to try again. */
  retriesWhileBudgetHeld?: boolean
  /** This turn reads a team's results: that team and job are asked and charged as well. */
  budgetScopes?: { teamId?: string | null; missionId?: string | null }
  /** Nobody is waiting at the keyboard: it queues like any task, behind a person's turn. */
  background?: boolean
  /** A turn nobody asked for: these jobs count it, once its run has started. */
  countJobs?: string[]
}

/** How a 1:1 turn ended. `reply` is the text it produced, for a turn that ended
 *  before it finished too. */
export interface ChatTurnEnding {
  /** `finished`: a run that ended well. `stopped`: a person's Stop. `refused`: a budget
   *  refused it before it started. `failed`: anything else, a turn that never started
   *  included. */
  how: 'finished' | 'stopped' | 'refused' | 'failed'
  reply: string
  /** It did not finish, and a pause covers the agent: what it carried goes again on the
   *  resume, and this try does not count. */
  paused?: boolean
  /** A budget refused it because runs already going have set aside its room, which comes
   *  back by itself. This try does not count either. */
  budgetHeld?: boolean
}

/**
 * Run ONE conversational turn for an agent's 1:1 chat. The caller does NOT await
 * this (it's detached: the reply streams via the SSE). Streams the running
 * assistant text to the per-session `chatDeltaBus` (the SSE's ephemeral delta
 * channel), commits the reply, and records the run's spend (agent scope; a paused
 * CAP budget refuses the turn, or aborts one already going) and its cost record
 * (Tokens Used). The turn holds its estimated cost on the agent's budget from the
 * moment it is let start until it ends (see budgetHold). Turns for one agent
 * run one at a time: a persistent-home runtime on its home mutex (shared with team
 * runs and routines for the same agent), any other on a per-agent chat lock. Each
 * turn first takes one of the process's run slots, waiting for one when every slot
 * is taken. Best-effort: never throws.
 */
export async function driveAgentChat(params: DriveAgentChatParams): Promise<void> {
  const ending: ChatTurnEnding = { how: 'failed', reply: '' }
  turnsUnderWay.set(params.agentId, (turnsUnderWay.get(params.agentId) ?? 0) + 1)
  try {
    await driveTurn(params, ending)
  } finally {
    const left = (turnsUnderWay.get(params.agentId) ?? 1) - 1
    if (left > 0) turnsUnderWay.set(params.agentId, left)
    else turnsUnderWay.delete(params.agentId)
    // However the turn ended, with its slot and its lock given back.
    try {
      if (ending.how !== 'finished' && pausedNow(params.db, params.agentId)) ending.paused = true
    } catch (err) {
      log.error({ err, agentId: params.agentId }, 'could not read whether a 1:1 turn is paused')
    }
    try {
      await params.onTurnEnded?.(ending)
    } catch (err) {
      log.error({ err, agentId: params.agentId }, 'a 1:1 turn ending could not be handled')
    }
  }
}

/** Does a pause cover this agent's chat right now? */
function pausedNow(db: ClawbooDb, agentId: string): boolean {
  const row = db.select({ teamId: agents.teamId }).from(agents).where(eq(agents.id, agentId)).get()
  return pauseFor(db, { agentId, teamId: row?.teamId ?? null }) !== null
}

async function driveTurn(params: DriveAgentChatParams, ending: ChatTurnEnding): Promise<void> {
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

  // The turn's hold on the agent's budget, released however the turn ends (see
  // `runHeld` below).
  let hold: RunBudgetHold | null = null
  const runJob = async (): Promise<void> => {
    // A pause placed while this waited for its slot or the agent's lock: no stop could
    // reach it, since it had left the queue and was not in the run map yet.
    const pausedWaiting = pauseFor(db, pauseSubject)
    if (pausedWaiting) {
      persist(pauseRefusalText(pausedWaiting), true)
      ending.how = 'refused'
      return
    }
    // The budget gate, as in team chat and the task runner: a paused hard cap on
    // the agent refuses the turn before it starts, and so does one whose remaining
    // room runs already going have set aside. Otherwise the turn holds its estimate
    // on the budget until it ends. The agent's budget, and the team and job whose
    // results this turn reads, when it reads some: those are what it is charged to.
    // Taken holding the lock, so a cap the turn ahead of this one paused is seen. A
    // ledger read that fails lets the turn go, as a failed spend write does below.
    const gate: RunBudgetGate = reserveRunBudget(
      db,
      { agentId, ...params.budgetScopes },
      { kind: 'chat', ref: sessionKey },
    )
    const refuseForBudget = (scope: BudgetScope, reason: BudgetRefusalReason): void => {
      if (reason === 'held') ending.budgetHeld = true
      if (!(reason === 'held' && params.quietWhileBudgetHeld))
        persist(budgetRefusalText(scope, reason, params.retriesWhileBudgetHeld), true)
      ending.how = 'refused'
    }
    if (gate.blocked) {
      refuseForBudget(gate.scope, gate.reason)
      return
    }
    const turnHold = gate.hold
    hold = turnHold
    const holdId = turnHold.id
    /** Charge what this turn cost. True when a hard cap has now paused it. */
    const charge = (usd: number): boolean => {
      const cents = usdToFractionalCents(usd)
      const teamId = params.budgetScopes?.teamId ?? null
      const missionId = params.budgetScopes?.missionId ?? null
      const on = { runKind: 'chat', agentId, ...(teamId ? { teamId } : {}) } as const
      let paused = false
      for (const [scope, scopeId] of [
        ['agent', agentId],
        ['mission', missionId],
        ['team', teamId],
      ] as const) {
        if (!scopeId) continue
        const result = recordSpend(db, scope, scopeId, cents, { holdId })
        auditBudgetCrossing(db, { ...on, scope, scopeId, result })
        if (result?.status === 'paused' && result.mode === 'cap') paused = true
      }
      return paused
    }
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
      // A 1:1 chat has no team: agent + global memory scope. Its Tasks tools are the
      // chat's own, held to the agent's team when it has one.
      memoryScope: {
        teamId: null,
        agentId,
        chatRun: true,
        chatRunTeamId: row?.teamId ?? null,
        attachSecret: getMcpAttachSecret(db),
      },
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
    const context = [buildPersonaBlock(db, agentId, runtime), recall, params.turnExtras?.()]
      .filter(Boolean)
      .join('\n\n')

    // The final gate, right before the model call: a cap that paused while the turn
    // got ready (its folder, its memory) refuses it now, before anything is spent.
    const finalGate = turnHold.recheck()
    if (finalGate.blocked) {
      refuseForBudget(finalGate.scope, finalGate.reason)
      return
    }

    let run: RunHandle
    try {
      // No childToolBlocklist / delegate tool: a 1:1 run is a conversation, not a
      // delegation. The native driver omits the `delegate` tool for a non-team
      // session key by construction (see nativeDriver.ts). A hand-off from Boo Zero's
      // chat is a tag in its reply, the same on every runtime (see chatHandOffs).
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
    for (const job of params.countJobs ?? []) {
      try {
        noteJobRun(db, job)
      } catch (err) {
        log.error({ err, job }, 'counting a chat update toward its job failed')
      }
    }
    // It reads the pause itself, now that it is in the map: one placed while it was
    // starting saw nothing to stop, and one placed from here on finds it there.
    const pausedInStart = pauseFor(db, pauseSubject)
    if (pausedInStart) {
      persist(pauseStopNote(pausedInStart), true)
      void stopAgentChat(agentId)
    }
    // Left-pane liveness + the composer's busy state: the SSE stream forwards this
    // as an ephemeral `status` event (nothing else reports run-state for a 1:1 turn).
    publishAgentStatus(sessionKey, { agentId, status: 'running' })

    // Accumulate the run's user-visible assistant text; publish the RUNNING total on
    // each delta (REPLACE semantics matching the client store). Tolerate BOTH delta
    // conventions (native emits incremental chunks; a cumulative delta REPLACES).
    let acc = ''
    let replyText = ''
    let publishedDelta = false
    let sawTerminal = false
    let committed = false
    let succeeded = false
    let userStopped = false
    let failure: string | null = null
    let lastError: string | null = null
    /** The run reported a context overflow (fatal or not). */
    let overflowed = false
    /** The typed cause of the fatal error that ended the run. */
    let failureCode: string | null = null
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
            paused = charge(ev.costUsd)
          } catch {
            // A ledger failure must never end the run without its reply.
          }
          if (paused) {
            serverAbort = 'the run was stopped by a budget cap'
            await adapter.abort(run).catch(() => undefined)
          }
        }
        if (ev.kind === 'error') lastError = ev.message || lastError
        if (ev.kind === 'error' && ev.code === 'context_overflow') overflowed = true
        if (ev.kind === 'error' && ev.fatal) failureCode = ev.code ?? null
        const terminal = ev.kind === 'done' || (ev.kind === 'error' && ev.fatal)
        if (!terminal) continue
        sawTerminal = true
        // The reply the turn produced, priced below: what streamed, or the summary
        // of a runtime that streams nothing (Hermes answers in one piece). Team chat
        // prices its runs on the same text.
        if (ev.kind === 'done') replyText = acc.trim() ? acc : (ev.summary ?? '')
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
    ending.how = succeeded ? 'finished' : userStopped ? 'stopped' : 'failed'
    ending.reply = replyText || acc

    // A context overflow first settles what happens to the session, since the turn's
    // one notice says so. Any ending but success: a run that reported an overflow and
    // then finished got past it, and its session is sound. Claude Code, Codex and Hermes
    // report one only once their session cannot go on, so it is dropped, whether or not
    // this turn was itself a resume. Native trims what it resumes, so it drops only when
    // trimming cannot help. A failure writing the clear must not cost the person the
    // truth about what comes next.
    const canResume = !!adapter.sessionCodec && adapter.capabilities().resume
    let savedSessionId: string | null = null
    if (canResume) {
      try {
        const blob = await adapter.sessionCodec!.serialize(run)
        const sid = (JSON.parse(blob) as { sessionId?: string | null }).sessionId
        // Claude Code falls back to the session key when no native id arrived.
        if (sid && sid !== sessionKey) savedSessionId = sid
      } catch {
        // A missing/unparseable id just means the next turn starts fresh.
      }
    }
    const failed = !succeeded && !userStopped
    let overflowNotice: string | null = null
    let pointerSettled = false
    const clearPointer = (): boolean => {
      try {
        setSetting(db, pointerKey, '')
        return true
      } catch (err) {
        log.error({ err, agentId }, 'could not clear a session pointer')
        return false
      }
    }
    if (overflowed && !succeeded && canResume) {
      if (runtime === NATIVE_RUNTIME && (await nativeResumeCanShrink(homeDir, savedSessionId))) {
        overflowNotice = CONVERSATION_TRIMMED_TEXT
      } else {
        pointerSettled = true
        // With nothing being carried, the pointer is already empty.
        if (!priorSessionId) overflowNotice = TURN_TOO_LARGE_TEXT
        else overflowNotice = clearPointer() ? SESSION_DROPPED_TEXT : SESSION_NOT_DROPPED_TEXT
      }
    } else if (
      runtime === NATIVE_RUNTIME &&
      canResume &&
      failed &&
      !serverAbort &&
      !acc.trim() &&
      isRefusedRequest(failureCode, failure) &&
      !(await nativeResumeCanShrink(homeDir, savedSessionId))
    ) {
      // The provider refused the request outright, in words that may not say why (no
      // pattern knows every provider's way of saying a prompt is too long). The saved
      // transcript is that request, and a resume sends it again plus more, so keeping
      // the pointer means every later message fails the same way. A first turn's pointer
      // is simply not written, and the failure notice below stands.
      pointerSettled = true
      if (priorSessionId && clearPointer()) overflowNotice = refusedSessionDroppedText(failure!)
    }

    // A user Stop stays discarded (the client cleared optimistically, the Gateway
    // 1:1 Stop convention). Anything else that did not commit is reported: a turn
    // that DIED mid-reply commits the partial the user watched (it survives reload,
    // and the committed frame clears the client's StreamingCard), and a turn that
    // failed BEFORE any text persists a visible notice with the REASON (the classic:
    // no provider key). The wording is shared with the team-chat drain.
    if (!committed && !userStopped && acc.trim()) {
      persist(acc)
      committed = true
    } else if (!committed && !userStopped && !succeeded && !overflowNotice) {
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
    if (overflowNotice) persist(overflowNotice, true)
    if (publishedDelta && !committed)
      publishChatDelta(sessionKey, { sessionKey, runId: null, text: '' })
    // Turn over — back to Idle (or Error for a failed run) either way.
    publishAgentStatus(sessionKey, { agentId, status: failed ? 'error' : 'idle' })

    // Price what the cost events did not already charge (Codex and Claude Code
    // report tokens or nothing, never a per-event USD), and list the turn in Tokens
    // Used the way a team-chat run is listed: the runtime's own figures where it
    // gave them, tokens guessed from the text where it did not.
    try {
      const inputChars = context.length + message.length
      const cost = costTally.settle({
        model: codingModel?.model ?? null,
        inputChars,
        outputChars: (replyText || acc).length,
      })
      if (cost.unbilledUsd > 0) charge(cost.unbilledUsd)
      recordRunTokens(db, {
        agentId,
        runtime,
        model: costTally.model() ?? codingModel?.model ?? null,
        inputTokens: cost.inputTokens ?? estimateTokensFromChars(inputChars),
        outputTokens: cost.outputTokens ?? estimateTokensFromChars((replyText || acc).length),
        costUsd: cost.costUsd,
        sessionKey,
      })
    } catch {
      // Best-effort: a ledger write never breaks the turn.
    }
    // Settled: the real spend has replaced the estimate.
    turnHold.release()

    // CONTINUATION: remember THIS turn's session id so the NEXT turn resumes it (the
    // harness saved the session before emitting its terminal). Only for a runtime
    // that resumes and exposes a session codec (the fake test adapter does not).
    if (canResume && !pointerSettled) {
      if (
        failed &&
        !serverAbort &&
        priorSessionId &&
        runtime !== NATIVE_RUNTIME &&
        !isPassingCause(failureCode)
      ) {
        // A failed turn that tried to resume most likely holds a dead handle (codex
        // `exec resume <unknown-id>` exits 1; the Claude SDK cannot find a session
        // from another working folder). Clear it so the next turn starts fresh
        // instead of failing the same way forever. Native reloads a missing
        // transcript as an empty one, so its pointer is kept. A run the server
        // ended (gone quiet, budget cap) had a live session, so it keeps it, and so
        // does one that hit something that passes by itself (a rate limit, an overload).
        setSetting(db, pointerKey, '')
      } else if (savedSessionId) {
        setSetting(db, pointerKey, savedSessionId)
      }
    }
  }

  // One turn at a time per agent. A persistent-home runtime takes the home mutex,
  // held across the whole drain so a concurrent executor run / routine / team turn
  // for the same (runtime, agent) can't overlap its session state; any other
  // runtime takes a per-agent chat lock, which keeps the resume pointer honest.
  const lockKey = homeDir ?? `direct-chat:${agentId}`
  // A paused agent, or an agent on a paused team, takes no turn. Refused here with
  // the reason in the chat, rather than left waiting unseen for a resume. An agent
  // whose team was only archived stays reachable: that is `pauseFor`, not the
  // wider `startRefusedBy` a background start reads.
  const pauseSubject = { agentId, teamId: row?.teamId ?? null }
  const paused = pauseFor(db, pauseSubject)
  if (paused) {
    persist(pauseRefusalText(paused), true)
    ending.how = 'refused'
    return
  }
  // A run slot first (see runSlots), then the agent's lock. A Stop while the turn
  // waits for its slot takes it out of the queue, and it never starts.
  const queue = new AbortController()
  const waiting = queuedTurns.get(agentId) ?? new Set<AbortController>()
  waiting.add(queue)
  queuedTurns.set(agentId, waiting)
  const leaveQueue = (): void => {
    waiting.delete(queue)
    if (waiting.size === 0 && queuedTurns.get(agentId) === waiting) queuedTurns.delete(agentId)
  }
  // However the turn ends (refused, failed, stopped, gone quiet, or its own code
  // throwing), its hold goes before the agent's lock does.
  const runHeld = async (): Promise<void> => {
    // The team folder is shared with the team chat, so this turn reports that it is
    // working there, and a team-chat work check waits for it (see teamFolderActivity).
    const folderRun = workdir ? startFolderRun(workdir, agentId) : null
    try {
      await runJob()
    } finally {
      hold?.release()
      folderRun?.release()
    }
  }
  await withRunSlot(
    () => {
      leaveQueue()
      return homeDispatchMutex.run(lockKey, runHeld, { acquireTimeoutMs: HOME_MUTEX_ACQUIRE_MS })
    },
    {
      key: lockKey,
      signal: queue.signal,
      rank: params.background ? { priority: 0 } : PERSON_TURN,
      paused: () => pauseFor(db, pauseSubject) !== null,
    },
  )
    .catch((err: unknown) => {
      if (err instanceof RunQueueAbortedError) ending.how = 'stopped'
      // An ACQUIRE timeout means `runJob` never ran at all: no 'running' status, no
      // delta, no persisted row. Swallowing it would be a silent non-response with
      // nothing on screen to explain it. Every other rejection stays swallowed:
      // `runJob` owns its own reporting and has already surfaced the reason, and a
      // turn stopped while it waited for a slot is as silent as any user Stop.
      if (err instanceof MutexAcquireTimeoutError) {
        persist(
          'This agent was busy with another run and did not pick the message up in time. Send it again.',
          true,
        )
        publishAgentStatus(sessionKey, { agentId, status: 'idle' })
      }
    })
    .finally(leaveQueue)
}
