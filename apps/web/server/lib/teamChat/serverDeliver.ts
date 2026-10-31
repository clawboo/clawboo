// serverDeliver — the engine's `deliver` dep, server-side.
//
// The faithful port of the browser binding's deliver + observe pair: the browser
// does `nudge.deliver(sk, () => adapter.start(...))` to FIRE a message, and a
// SEPARATE always-on `consume` loop drains every session's events into
// `orchestrator.onEvent`. Server-side there is no continuous multiplexed stream —
// each `adapter.start` yields its OWN one-shot `events(run)` iterator — so the
// drain is spawned PER delivered run, here, right after start.
//
// CRUCIALLY this is NOT `runTaskOnRuntime`. The engine OWNS the board lifecycle
// (its `spawn` already createTask→claim→createExecution; its `completeForSession`
// does updateStatus(done)). `runTaskOnRuntime` would re-claim (→409) and
// re-complete (double-complete) against the engine. `deliver` must ONLY run the
// agent and pipe its lifecycle events back; the engine reacts. The board task is
// the engine's bookkeeping.
//
// INVARIANT: every run on a server-orchestrated team starts through `serverDeliver`,
// so it has exactly ONE drain. There is no catch-all consume loop — a run started
// out-of-band would be invisible to the engine.

import { mkdir } from 'node:fs/promises'

import {
  agents,
  getAncestors,
  getSetting,
  listUndeliveredInbox,
  markInboxDelivered,
  recordExecutionUsage,
  recordSpend,
  INBOX_BUDGET_CHARS,
  packInboxRows,
  splitInboxByAddressing,
  setSetting,
  startTaskHeartbeat,
  updateTaskFields,
  type ClawbooDb,
  resolveRoomForTeam,
} from '@clawboo/db'
import { createLogger } from '@clawboo/logger'
import {
  DEFAULT_RUN_SILENT_TIMEOUT_MS,
  IDLE_ABORT_GRACE_MS,
  resolveRuntimeIntegration,
  withIdleTimeout,
  type RunHandle,
  type RuntimeAdapter,
  type RuntimeEvent,
} from '@clawboo/executor'
import { usdToFractionalCents } from '@clawboo/governance'
import { classifyError, isHarnessBug } from '@clawboo/obs'
import {
  buildTurnEnvelope,
  classifyTurn,
  isChatVisible,
  isTeamSessionKey,
  type NudgeQueue,
  type RunStamp,
  type TurnOrigin,
} from '@clawboo/team-orchestration'
import { eq } from 'drizzle-orm'

import { getRegistry } from '../agentSource/registry'
import { HOME_MUTEX_ACQUIRE_MS, homeDispatchMutex } from '../executorRunner'
import { RUN_ENDED_WITHOUT_RESULT, runFailureText } from '../runFailureText'
import { registerRunSteer } from '../runSteers'
import { emitEvent } from '../obs'
import { openclawAgentModel } from '../openclawAgentModel'
import { connectedAgentKey, connectedAgentMutex } from '../routines/openclawDispatch'
import { adapterFactoryFor } from '../runtimes'
import { getDescriptor, isOrchestratableRuntimeId, isRuntimeId } from '../runtimes/descriptor'
import { runtimeIdentityHomePath } from '../runtimes/identityHome'
import { loadAgentConfig } from '../runtimes/native/agentConfigStore'
import { estimateTokensFromChars } from '../runtimes/estimateCost'
import { createRunCostTally } from '../runtimes/runCostTally'
import { recordRunTokens } from '../runTokenLog'
import { buildOpenClawServerAdapter } from '../runtimes/serverAdapter'
import { ensureTeamWorkdir, teamWorkdirFor } from '../runtimes/teamWorkdir'
import type { RuntimeRunContext } from '../runtimes/types'
import { resolveRuntimeKeyForRuntime } from '../secretsVault'
import { buildServerTeamContext } from './contextPreamble'
import { nativeTeamSessionSettingKey, teamResumeEligible } from './nativeTeamSession'
import { getMcpAttachSecret } from '../mcpAttachSecret'
import { inboxRowBelongsToRoom } from './roomRoster'
import { buildPeerCatchup } from './peerCatchup'
import { advanceChatLeaderSeq, loadChatLeaderState } from './leaderState'

const log = createLogger('server-deliver')

/** clawboo's own in-process runtime. Its agents read their own config, so the
 *  coding-runtime model override below skips them. */
const NATIVE_RUNTIME = 'clawboo-native'

/** A live run tracked for Stop / wedge — keyed by sessionKey in the abort map. */
export interface RunEntry {
  adapter: RuntimeAdapter
  run: RunHandle
  /**
   * Why the SERVER aborted this run, when it did. Every runtime reports an abort
   * as a clean `done: 'aborted'`, which makes a deliberate user Stop and a
   * server-initiated kill (the idle guard, the budget cap, the wedge) look
   * identical at the terminal. A user Stop should be silent; the others are
   * unexplained non-answers that must be reported. Set by whoever asks for the
   * abort, before asking; left null for a user Stop.
   */
  serverAbortReason?: string | null
}

export interface ServerDeliverDeps {
  db: ClawbooDb
  teamId: string
  /** The team chat room this orchestrator drives (null/absent = the team's own
   *  group chat, the default room). It scopes the roster the agent is told about,
   *  the leader's resume pointer and which mailbox rows a run reads. Not the
   *  peer-chat `team_chat` room, which stays team-wide. */
  chatRoomId?: string | null
  mcpBaseUrl: string | null
  nudge: NudgeQueue
  /** sessionKey → live run, so `stop()` / the wedge can abort it. Populated here
   *  (in the send closure) and evicted in `drainRun` on the run's terminal. */
  abortMap: Map<string, RunEntry>
  /** The engine's event sink: the orchestrator's `onEvent`. `run` is the stamp
   *  fixed when this run was delivered. */
  onEvent: (sessionKey: string, event: RuntimeEvent, run: RunStamp) => Promise<void>
  /** The engine's `onSessionClosed` — called when a drain ends without a terminal. */
  onSessionClosed: (sessionKey: string, run: RunStamp) => Promise<void>
  /** The engine's `taskForSession`, used to attribute a delegated run's mission
   *  spend, as framing's second witness, and by the start gate to check that a
   *  task run's session still holds its task. */
  taskForSession: (sessionKey: string) => string | null
  /** The engine's `execForSession`: the execution row of the run a session is doing
   *  for its task. Read at deliver time, next to the run's task, so the drain records
   *  the run's cost on its own row even after a Stop or the watchdog closed it. */
  execForSession: (sessionKey: string) => string | null
  /** The host's Stop generation, bumped by stop() and dispose(). A delivery made
   *  before a bump never starts after it, because stop() only aborts runs already
   *  in the abort map. Required so the production wiring cannot omit it. */
  stopGen: () => number
  /** The team's reduce point. Read fresh (membership changes), and the ONLY thing
   *  that decides whether a turn is framed as the lead's — being the leader is a
   *  property of the agent, not of whether a task happens to still be tracked. */
  leaderAgentId: () => string | null
  /** Persist a run's terminal turn text for chat-history observability (a seed for
   *  the unified writer). Optional — omitted in tests that only assert the wiring.
   *  May return whether the entry actually reached the transcript: an explicit
   *  `false` (empty / control-token drop / insert error) makes the drain publish a
   *  CLEARING delta so a streamed turn without a commit never leaves a lingering
   *  StreamingCard. A `void` return (legacy stubs) counts as persisted. */
  persistTurn?: (sessionKey: string, text: string) => boolean | void
  /** Persist a SYSTEM notice into the team transcript (role `system`, kind `meta`),
   *  for something the user must be told that is not the agent speaking. Used for a
   *  run that failed before its first token, which is otherwise indistinguishable
   *  from an agent that chose to stay silent. Optional; omitted in tests that only
   *  assert the wiring. */
  persistMeta?: (sessionKey: string, text: string) => boolean | void
  /** Tier-2 live-token hook: publish a run's FULL running assistant text on each
   *  streamed delta (the team-chat SSE's ephemeral channel). `text` is the running
   *  accumulation, NOT the chunk — it matches the client store's REPLACE semantics.
   *  Optional + fire-and-forget; the committed turn (`persistTurn` on `done`) is the
   *  durable source of truth, so a missing/throwing hook never affects the drain. */
  publishDelta?: (sessionKey: string, runId: string | null, text: string) => void
  /** Live working/idle signal: publish the target agent's run-state at the run's
   *  boundaries (`running` once the run starts; `idle` / `error` on its terminal or
   *  a dead stream). The team-chat SSE forwards it as an ephemeral `status` event so
   *  the thin client can patch the fleet store's left-pane badges. For native /
   *  coding runtimes this is the ONLY status writer; for an OpenClaw team in gateway
   *  mode the browser's Gateway lifecycle patches coexist — both converge on the
   *  same terminal state, and duplicate patches are harmless (idempotent client
   *  patch). Optional + fire-and-forget. */
  publishStatus?: (agentId: string, status: 'running' | 'idle' | 'error') => void
  /** TEST-ONLY seam: build the adapter for an agent directly, bypassing the DB
   *  runtime lookup + the real driver factory. An injected adapter whose caps
   *  declare a persistent home still takes the home mutex. Production OMITS
   *  it → the real runtime-resolution path below runs byte-identically. Mirrors the
   *  `makeAdapter` injection in dispatchChatTurn / runTaskOnRuntime. */
  makeAdapterForAgent?: (agentId: string) => RuntimeAdapter | null
}

/** Vault → spawned-run env (mirrors runTeamExchange / the runtimes REST run handler).
 *  An unknown / connected-substrate runtime contributes no vault key. */
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

/** Parse a coding-runtime agent's execConfig for an optional per-agent model +
 *  provider (the Hermes model picker stores `{ model, provider }`). Never throws;
 *  returns null when absent so the driver keeps its key-derived default. */
export function parseCodingModelConfig(
  raw: string | null,
): { model?: string; provider?: string } | null {
  if (!raw) return null
  try {
    const o = JSON.parse(raw) as Record<string, unknown>
    const model = typeof o['model'] === 'string' && o['model'] ? o['model'] : undefined
    const provider = typeof o['provider'] === 'string' && o['provider'] ? o['provider'] : undefined
    if (!model && !provider) return null
    return { ...(model ? { model } : {}), ...(provider ? { provider } : {}) }
  } catch {
    return null
  }
}

/** The "mission" budget scope = the root of the delegation tree (a top-level task
 *  is its own mission). Mirrors executorRunner's private helper. */
/** The model a Native turn is priced at when it reported no cost: its configured
 *  model, written `ollama/<model>` for the Ollama provider so a local run stays
 *  free (`isLocalModel`). Null when the agent has no stored config. */
export function nativeCostModel(
  cfg: { primaryProvider: string; primaryModel: string } | null,
): string | null {
  if (!cfg?.primaryModel) return null
  return cfg.primaryProvider.trim().toLowerCase() === 'ollama'
    ? `ollama/${cfg.primaryModel}`
    : cfg.primaryModel
}

function missionRootId(db: ClawbooDb, taskId: string): string {
  const ancestors = getAncestors(db, taskId)
  if (ancestors.length === 0) return taskId
  return ancestors.find((a) => a.parent_task_id == null)?.id ?? taskId
}

/** Build the engine's `deliver(targetSessionKey, targetAgentId, message)`. */
export function createServerDeliver(deps: ServerDeliverDeps) {
  const { db, teamId, mcpBaseUrl, nudge, abortMap, onEvent, onSessionClosed, taskForSession } = deps
  const execForSession = deps.execForSession
  const chatRoomId = deps.chatRoomId ?? null
  const stopGen = deps.stopGen
  const leaderAgentId = deps.leaderAgentId
  const persistTurn = deps.persistTurn
  const publishDelta = deps.publishDelta
  const publishStatus = deps.publishStatus
  const makeAdapterForAgent = deps.makeAdapterForAgent

  /** Record this run's spend; return true if a CAP budget crossed 100% (kill-switch).
   *  A budget-ledger failure must NEVER propagate: it would be caught by the drain's
   *  outer try/catch and END the run WITHOUT its terminal — swallowing the agent's
   *  reply (no chat commit) + any delegate signal (no board task). The budget is a
   *  guardrail, not the payload, so a ledger error degrades to "not paused" and the
   *  run's output still reaches the chat. (This is how a stale-DB `recordSpend` schema
   *  error silently broke every native team turn — native emits `cost` events, OpenClaw
   *  doesn't.) */
  function recordSpendForRun(sessionKey: string, agentId: string, usd: number): boolean {
    try {
      const cents = usdToFractionalCents(usd)
      const a = recordSpend(db, 'agent', agentId, cents)
      const t = recordSpend(db, 'team', teamId, cents)
      const taskId = taskForSession(sessionKey)
      const m = taskId ? recordSpend(db, 'mission', missionRootId(db, taskId), cents) : null
      if (a?.status === 'paused' && a.mode === 'cap') return true
      if (m?.status === 'paused' && m.mode === 'cap') return true
      if (t?.status === 'paused' && t.mode === 'cap') return true
      return false
    } catch {
      return false
    }
  }

  /** Mirror a run's per-tool lifecycle detail (tool calls / results / errors) into
   *  the durable obs event log so the activity terminal shows the server-orchestrated
   *  path — the server-side replacement for the deleted browser obs mirror. Board
   *  lifecycle is already emitted by `serverBoardClient`; this covers the per-run
   *  runtime detail. Best-effort (`emitEvent` never throws). Benefits every runtime,
   *  incl. native (which previously emitted nothing from this drain). */
  function emitRunObs(
    sessionKey: string,
    agentId: string,
    runtime: string | null,
    ev: RuntimeEvent,
  ): void {
    if (ev.kind !== 'tool-call' && ev.kind !== 'tool-result' && ev.kind !== 'error') return
    const taskId = taskForSession(sessionKey)
    const envelope = {
      taskId,
      teamId,
      agentId,
      ...(runtime ? { runtime } : {}),
    }
    if (ev.kind === 'tool-call') {
      if (ev.partial) return // only the completed call is worth logging
      emitEvent(db, {
        kind: 'tool_call',
        ...envelope,
        data: { toolCallId: ev.toolCallId, name: ev.name, input: ev.input },
      })
    } else if (ev.kind === 'tool-result') {
      emitEvent(db, {
        kind: 'tool_result',
        ...envelope,
        data: { toolCallId: ev.toolCallId, name: ev.name, isError: ev.isError, output: ev.output },
      })
    } else {
      const cls = classifyError(ev.code, ev.message)
      emitEvent(db, {
        kind: 'error',
        ...envelope,
        data: {
          code: ev.code,
          message: ev.message,
          errorClass: cls,
          harnessBug: isHarnessBug(cls),
          fatal: ev.fatal,
        },
      })
    }
  }

  /**
   * Wind down a run the start gate refused after it began. It runs while this
   * job still holds the agent's lock, and none of its events reach the engine,
   * the chat or the abort map. The stream is taken BEFORE the abort so an adapter
   * that subscribes on call does not miss the aborted frame.
   */
  async function discardRun(adapter: RuntimeAdapter, run: RunHandle): Promise<void> {
    try {
      const stream = adapter.events(run) as AsyncIterable<RuntimeEvent>
      await adapter.abort(run).catch(() => undefined)
      for await (const ev of withIdleTimeout(stream, {
        idleMs: IDLE_ABORT_GRACE_MS,
        onIdle: () => undefined,
      })) {
        if (ev.kind === 'done' || (ev.kind === 'error' && ev.fatal)) break
      }
    } catch {
      // Best-effort: the run was never handed to anyone, so there is nothing to fail.
    }
  }

  /**
   * Drain ONE run's event stream into the engine. Reuses the browser `consume`
   * loop's contract with two deliberate per-run adaptations:
   *  • It MUST `break` on the run's terminal — the native adapter's `events()`
   *    queue is never closed on completion, so a bare `for await` hangs forever.
   *  • `markIdle` runs BEFORE `onEvent` (load-bearing): `onEvent(done)` may
   *    re-deliver to the SAME session; if it were still nudge-busy that re-delivery
   *    would FIFO-enqueue and never flush (the `done` that flushes it already passed).
   *  • The run terminal is `done` OR a FATAL `error` only. Unlike the browser's
   *    continuous stream where an `error` frame == run-end, a native non-fatal
   *    error does NOT end the run, so it stays nudge-busy (markBusy) and the loop
   *    continues — the home mutex is the cross-subsystem backstop regardless.
   */
  async function drainRun(
    adapter: RuntimeAdapter,
    run: RunHandle,
    sessionKey: string,
    agentId: string,
    obs: {
      runtime: string | null
      message: string
      /** Char length of the injected team context (roster / rules / user intro) — folded
       *  into the input-token ESTIMATE so an OpenClaw / no-USD run's cost reflects its
       *  real prompt size, not just the short task text. */
      contextChars: number
      /** The leader session-resume pointer key to update on the terminal, or
       *  null when this run is not an eligible leader/user-facing team turn. */
      resumePointerKey: string | null
      /** True when THIS run was started with a resume handle (ctx.resume) — drives
       *  the stale-pointer self-heal: a FAILED resumed run clears the pointer so the
       *  next turn starts fresh instead of looping through identical failures
       *  (codex `exec resume <unknown-id>` is a hard exit-1). */
      resumeAttempted?: boolean
      /** May this run's reply reach the team chat? Fixed at deliver time. */
      chatVisible: boolean
      /** What the run was delivered as, handed back to the engine with each event. */
      stamp: RunStamp
      /** The execution row this run records its cost on, read at deliver time; null
       *  for a turn that runs no task. */
      execId: string | null
      /** The agent's configured model, used to price an estimate when the run's cost
       *  events name none. */
      model: string | null
    },
  ): Promise<void> {
    let sawTerminal = false
    // Tier-2 live tokens: accumulate the run's user-visible assistant text and
    // publish the RUNNING total on each delta (matches the client store's REPLACE
    // semantics). The committed turn (persistTurn on `done`) stays the source of
    // truth; this is the ephemeral "type it out live" channel.
    let acc = ''
    // Visibility is decided from why the run was delivered, fixed at deliver time,
    // never from the session map at drain start. That map was stale in both
    // directions: a task run whose mapping was dropped before it started streamed
    // into chat, and a person's reply on a session holding an adopted task was
    // hidden. A delegated child or a follow-up neither STREAMS nor COMMITS into the
    // chat timeline; its output lives on its BoardTaskCard.
    //
    // NOTE the retired second gate: a leader DELEGATION turn (one that calls the
    // `delegate` tool) used to be suppressed from chat too. That made streamed
    // replies VANISH — the prose the user watched streaming was never committed, so
    // the next commit / a reload wiped it with nothing in its place. The prose now
    // streams AND commits like any leader turn (the delegation itself still renders
    // as durable BoardTaskCards; a pure-delegation turn with no prose strips to
    // nothing client-side and is dropped there, exactly like the OpenClaw leader's
    // `<delegate>` XML turn always was).
    //
    // The session's task, read once, is runtime attribution only (the terminal's
    // updateTaskFields below). The engine forgets it in completeForSession, which
    // runs on the terminal AFTER that write.
    const runTaskId = taskForSession(sessionKey)
    const chatVisible = obs.chatVisible
    // What the run cost, priced once when it ends (done, a fatal error, or a stream
    // that died with no terminal): reported USD first, then usage tokens, then a
    // character estimate for a run that reported neither (OpenClaw's Gateway, a
    // failed CLI run), so the budgets are never stuck at $0. The cost lands on the
    // run's own execution row, `obs.execId`, which is fixed at deliver time because
    // a Stop or the watchdog can close that row before this drain ends.
    const costTally = createRunCostTally()
    let costSettled = false
    const settleRunCost = (outputText: string): void => {
      if (costSettled) return
      costSettled = true
      try {
        const inputChars = obs.contextChars + obs.message.length
        const cost = costTally.settle({
          model: obs.model,
          inputChars,
          outputChars: outputText.length,
        })
        // Only the part no cost event already charged. The run is at its end, so a
        // cap this crosses has no run left to stop.
        if (cost.unbilledUsd > 0) recordSpendForRun(sessionKey, agentId, cost.unbilledUsd)
        // Listed in Tokens Used (an OpenClaw run is listed from its own transcript
        // instead), with tokens guessed from the text when the run reported none.
        recordRunTokens(db, {
          agentId,
          runtime: obs.runtime,
          model: costTally.model() ?? obs.model,
          inputTokens: cost.inputTokens ?? estimateTokensFromChars(inputChars),
          outputTokens: cost.outputTokens ?? estimateTokensFromChars(outputText.length),
          costUsd: cost.costUsd,
          runId: obs.execId,
          sessionKey,
        })
        if (obs.execId) {
          recordExecutionUsage(db, obs.execId, {
            costUsd: cost.costUsd,
            costSource: cost.costSource,
            inputTokens: cost.inputTokens,
            outputTokens: cost.outputTokens,
            runtime: obs.runtime,
          })
        }
      } catch {
        /* best-effort: a ledger write never breaks the drain */
      }
    }
    // Did this run publish any live delta / commit its turn? Drives the
    // stream-without-commit belt at the terminal: a turn that STREAMED but persisted
    // nothing publishes one CLEARING delta (empty text) so the client's lingering
    // StreamingCard is dropped instead of sticking around and later "vanishing".
    let publishedDelta = false
    let persistedTurn = false
    /** Persist via the injected writer; a `void` return (legacy stubs) counts as
     *  persisted — only an explicit `false` (write-time drop / insert error) doesn't. */
    const tryPersist = (text: string): boolean => {
      if (!persistTurn) return false
      return persistTurn(sessionKey, text) !== false
    }
    /**
     * Record that the SERVER killed this run, and why.
     *
     * Every runtime reports an abort as a clean `done: 'aborted'`, so the terminal
     * alone cannot tell a deliberate user Stop from a kill the server decided on.
     * A Stop should be silent; a kill is an unexplained non-answer and has to be
     * reported. The reason is kept on the shared abort-map entry so the wedge
     * abort in `teamOrchestrator` can set it too.
     */
    const markServerAbort = (reason: string): void => {
      const entry = abortMap.get(sessionKey)
      if (entry) entry.serverAbortReason = reason
      else serverAbortReason = reason
    }
    let serverAbortReason: string | null = null
    /** The recorded reason, from wherever it was set. */
    const takeServerAbortReason = (): string | null =>
      abortMap.get(sessionKey)?.serverAbortReason ?? serverAbortReason
    /**
     * Does this run still own the session's queue slot? A Stop resets the queue,
     * and from then on the slot belongs to whatever was delivered after it, so a
     * run delivered before the Stop marks the session neither busy nor idle.
     */
    const ownsSlot = (): boolean => obs.stamp.stopGen === stopGen()
    /**
     * Evict this run's own abort-map entry, never one that replaced it: a run
     * started after a Stop or a wedge abort can register under the same session
     * key while this one is still winding down.
     */
    const evictOwnEntry = (): void => {
      if (abortMap.get(sessionKey)?.run === run) abortMap.delete(sessionKey)
    }

    // Drain idle guard: a wedged adapter iterator must not hang this drain (and
    // with it the agent's home mutex + the engine's view of the session) forever.
    // Silence past the ceiling aborts the run; the abort surfaces `done:aborted`,
    // which `markServerAbort` marks so the terminal below reports it rather than
    // reading it as a deliberate stop, and a stream silent through the grace ends
    // → `onSessionClosed` fails it with "ended before reporting".
    const silentMs =
      Number(process.env['CLAWBOO_RUN_SILENT_TIMEOUT_MS']) || DEFAULT_RUN_SILENT_TIMEOUT_MS
    try {
      for await (const ev of withIdleTimeout(adapter.events(run) as AsyncIterable<RuntimeEvent>, {
        idleMs: silentMs,
        onIdle: async () => {
          // Mark BEFORE aborting: the terminal this produces is a clean
          // `done: aborted`, indistinguishable from a user Stop without it.
          markServerAbort('the run went quiet for too long and was ended')
          try {
            await adapter.abort(run)
          } catch {
            /* the guard's grace window ends the stream regardless */
          }
        },
      })) {
        costTally.observe(ev)
        if (ev.kind === 'text-delta' && ev.channel !== 'reasoning') {
          // Tolerate BOTH delta conventions so the running text is never garbled:
          // native emits INCREMENTAL chunks, but the OpenClaw adapter emits CUMULATIVE
          // deltas (each frame carries the full text so far). If the new text extends
          // the running text, REPLACE (cumulative); otherwise APPEND (incremental).
          // Without this, a cumulative delta was `+=`-accumulated into garbled repeated
          // text ("We plantWe plantWe plant data seeds…").
          acc = acc && ev.text.startsWith(acc) ? ev.text : acc + ev.text
          // Stream live tokens to the group chat for a chat-visible turn (a leader /
          // user-facing turn — a delegated child's surface is its BoardTaskCard). The
          // non-empty guard keeps a blank chunk from reading as the CLEAR sentinel.
          if (chatVisible && acc) {
            publishDelta?.(sessionKey, ev.runId, acc)
            publishedDelta = true
          }
        }
        if (ev.kind === 'cost' && ev.costUsd != null && ev.costUsd > 0) {
          // Real per-turn USD (native): charge it live, then run the budget
          // kill-switch — a paused CAP budget aborts the run; the resulting `done:aborted`
          // flows through this same loop (the engine fails the task).
          if (recordSpendForRun(sessionKey, agentId, ev.costUsd)) {
            markServerAbort('the run was stopped by a budget cap')
            await adapter.abort(run).catch(() => undefined)
          }
        }
        if (ev.kind === 'done') {
          // Commit a chat-visible (leader / user-facing) turn — a DELEGATED-CHILD task
          // turn stays off the timeline (its report-up lives on the BoardTaskCard).
          // The ACCUMULATED stream text is committed FIRST — it is exactly what the
          // user watched streaming, so the committed card replaces the StreamingCard
          // with identical content. `summary` is only the fallback for a run that
          // streamed nothing: native's summary is the LAST turn's text only (earlier
          // turns' streamed prose would vanish on commit), and an aborted OpenClaw
          // run's summary is the adapter's naïvely-concatenated (garbled-for-
          // cumulative) accumulation — `acc` is the correctly-merged text for both.
          const doneText = acc.trim() ? acc : (ev.summary ?? '')
          if (chatVisible && doneText.trim()) persistedTurn = tryPersist(doneText)
          // A clean terminal that produced NOTHING. Most of the time that is
          // legitimate (a leader that delegated and had nothing to add speaks
          // through the board, and a user Stop is a silence the user chose), so
          // the only case reported is the one nobody chose: the server killed the
          // run. Without this those kills are indistinguishable from a Stop, since
          // every runtime reports both as `done: 'aborted'`.
          if (chatVisible && !doneText.trim()) {
            const killed = takeServerAbortReason()
            if (killed) deps.persistMeta?.(sessionKey, runFailureText(killed, obs.runtime))
          }
          // Leader continuity: persist THIS turn's harness session id so the NEXT team
          // turn resumes it. Done HERE (on the terminal, BEFORE markIdle) so the next
          // queued delivery — which the nudge flushes on markIdle and which reads the
          // pointer to build ctx.resume — sees the FRESH id. Doing it after the drain
          // would race: a rapidly-sent message 2 would read the stale pointer and resume
          // message 0's transcript, dropping this turn. The harness already awaited
          // saveSessionTranscript before emitting `done`, so the session file exists.
          // Non-null resumePointerKey ⇒ an eligible leader / user-facing team turn.
          if (obs.resumePointerKey && adapter.sessionCodec) {
            if (ev.reason !== 'success' && obs.resumeAttempted) {
              // Stale-pointer self-heal (structural, mirrors executorRunner's
              // clear-on-failed-resume): a FAILED turn that TRIED to resume most
              // likely holds a dead handle — codex `exec resume <unknown-id>` is a
              // hard exit-1 — so writing it back would loop every subsequent turn
              // through the same failure. Clear it; the next turn starts fresh.
              try {
                setSetting(db, obs.resumePointerKey, '')
              } catch {
                /* best-effort */
              }
            } else {
              try {
                const blob = await adapter.sessionCodec.serialize(run)
                const sid = (JSON.parse(blob) as { sessionId?: string | null }).sessionId
                if (sid) setSetting(db, obs.resumePointerKey, sid)
              } catch {
                // A missing/unparseable id just means the next turn starts fresh.
              }
            }
          }
        }
        // Per-tool runtime detail → the obs activity terminal (all runtimes).
        emitRunObs(sessionKey, agentId, obs.runtime, ev)
        const terminal = ev.kind === 'done' || (ev.kind === 'error' && ev.fatal)
        if (terminal) {
          // A fatal-error terminal never reaches the `done` persist above — commit the
          // partial streamed text (what the user already watched) so it survives the
          // failure instead of vanishing with the stream.
          if (ev.kind === 'error' && chatVisible) {
            if (acc.trim()) persistedTurn = tryPersist(acc)
            // Nothing streamed at all: without a notice this is a silent
            // non-response, which reads exactly like an agent that decided not to
            // answer. Persist the REASON instead (the 1:1 chat drain does the same,
            // through the same wording). Deliberately NOT `persistedTurn`: a system
            // notice is not the agent's turn, and nothing streamed, so the clearing
            // delta below is not in play either.
            else {
              const provider = loadAgentConfig(db, agentId)?.primaryProvider
              deps.persistMeta?.(sessionKey, runFailureText(ev.message, obs.runtime, provider))
            }
          }
          // Stream-without-commit belt: a turn that streamed live tokens but persisted
          // nothing (pure silent delegation, a write-time drop, an insert error) gets
          // one CLEARING delta — empty text tells the client to drop its StreamingCard
          // (nothing will ever replace it, so leaving it lingers-then-vanishes).
          if (publishedDelta && !persistedTurn) publishDelta?.(sessionKey, null, '')
          // Evict THIS run's abort entry BEFORE markIdle — this run is terminal, so
          // its handle is dead weight, and markIdle synchronously flushes the
          // session's next QUEUED delivery: for a mutex-less runtime (ephemeral
          // home, e.g. claude-code) the successor's runJob can `abortMap.set` its
          // own entry while we're still awaiting `onEvent(done)` below. A delete
          // left until after that await would evict the SUCCESSOR's entry, making
          // the in-flight run invisible to `stop()` and the wedge abort.
          evictOwnEntry()
          if (ownsSlot()) nudge.markIdle(sessionKey)
          // Left-pane liveness: the run is over. `error` only on a fatal error — a
          // clean `done` (success OR aborted) reads as back-to-idle.
          publishStatus?.(agentId, ev.kind === 'error' ? 'error' : 'idle')
          // Price the run now, before the engine's close (onEvent below), on the text
          // it produced: the committed reply on a `done`, the partial on a fatal error.
          settleRunCost(ev.kind === 'done' ? (acc.trim() ? acc : (ev.summary ?? '')) : acc)
          // Persist the run's REAL runtime onto its task so the board card + drawer
          // show it: the engine creates the task with a hardcoded
          // `assigneeRuntime: 'openclaw'`, and nothing else writes it. The run's cost
          // is not the task's to hold; the run ledger records it. Delegated-child task
          // runs only; best-effort, because a ledger write must never break the drain.
          if (runTaskId) {
            try {
              updateTaskFields(db, runTaskId, {
                ...(obs.runtime ? { assigneeRuntime: obs.runtime } : {}),
              })
            } catch {
              /* non-fatal */
            }
          }
        } else if (ownsSlot()) nudge.markBusy(sessionKey)
        try {
          await onEvent(sessionKey, ev, obs.stamp)
        } catch (err) {
          // A single bad event must not kill the observer — but it must not be
          // invisible either: this is the engine refusing an event, which is how
          // a cascade stops advancing for no apparent reason.
          log.error({ err, sessionKey, kind: ev.kind }, 'engine rejected a run event')
        }
        if (terminal) {
          sawTerminal = true
          // NO abortMap.delete here: this run's entry was evicted BEFORE markIdle
          // above, and by now the map slot may hold the flushed SUCCESSOR run's
          // entry — deleting it would hide that in-flight run from stop()/onWedge.
          break
        }
      }
    } catch {
      // Stream / observer error — fall through to the no-terminal cleanup.
    }
    if (!sawTerminal) {
      // The stream ended WITHOUT a terminal (connection drop / error): free the
      // session and tell the engine its observer ended, so it fails the in-flight
      // delegation instead of leaving the leader waiting on a dead observer. The
      // dead stream never commits, so drop any lingering StreamingCard + flip the
      // left-pane badge back.
      // Commit whatever the user already watched streaming, exactly as the
      // fatal-error terminal does. A dead stream is not a reason to throw away
      // real content: without this the reply visibly vanishes and is replaced by
      // a notice saying nothing came back, when something did.
      if (chatVisible && !persistedTurn && acc.trim()) persistedTurn = tryPersist(acc)
      // Only a run that produced NOTHING needs its silence explained. No terminal
      // ever said why, and the user simply never heard back. A deliberate stop
      // does not land here, because every runtime reports an abort as a clean
      // `done` terminal.
      if (chatVisible && !persistedTurn) deps.persistMeta?.(sessionKey, RUN_ENDED_WITHOUT_RESULT)
      // Ordered last: a partial committed just above replaces the StreamingCard on
      // its own, so only a turn that truly committed nothing needs clearing.
      if (publishedDelta && !persistedTurn) publishDelta?.(sessionKey, null, '')
      evictOwnEntry()
      if (ownsSlot()) nudge.markIdle(sessionKey)
      publishStatus?.(agentId, 'idle')
      // A dead stream still cost something. Priced before the engine fails the task,
      // whose cost-less close leaves this recorded cost in place.
      settleRunCost(acc)
      try {
        await onSessionClosed(sessionKey, obs.stamp)
      } catch (err) {
        // Best-effort, but logged: this is the path that fails an in-flight
        // delegation when its observer dies, so a throw here leaves the leader
        // waiting on a delegate that will never report.
        log.error({ err, sessionKey }, 'onSessionClosed failed after a dead stream')
      }
    }
  }

  return function deliver(
    targetSessionKey: string,
    targetAgentId: string,
    message: string,
    origin: TurnOrigin,
  ): Promise<void> {
    // Live-roster context for a team run so the agent knows its teammates by name
    // (the `delegate` tool resolves the assignee against this same roster). Built
    // once per delivery; rides opts.context (verified to reach turn 1). Every team
    // run gets it — the leader's user turn AND delegated children (serverDeliver
    // can't tell them apart, and a teammate knowing the roster is harmless; the
    // engine's depth cap bounds any child delegation). A 1:1 run gets none.
    // Capture whether this is a delegated CHILD task run NOW, at deliver time: the
    // engine set `sessionToTask` BEFORE calling deliver and forgets it in
    // `completeForSession` DURING the terminal's onEvent (inside drainRun) — so a
    // read after the drain would be null. Used to gate the native leader session
    // resume (only the leader / user-facing turn resumes; a child keeps its own
    // executor-handoff continuity) AND the native-leader coordination block below.
    const isTaskRun = taskForSession(targetSessionKey) != null
    // What this turn IS — three answers, from the caller's stated `origin` plus the
    // two durable facts (who leads, does this session hold a task). It used to be
    // `!isTaskRun` for all three, which is why a turn arriving after a worker's
    // task was forgotten was framed as the team lead's.
    const framing = classifyTurn({
      origin,
      targetAgentId,
      leaderAgentId: leaderAgentId(),
      hasBoardTask: isTaskRun,
    })
    // The stamp: what this delivery IS, fixed now. The stop generation it was made
    // under, the task a delegation or assignment runs (the engine maps the session
    // immediately before it calls deliver, with no await between), and whether the
    // turn is a follow-up report. Chat visibility follows from the origin alone.
    const deliveredGen = stopGen()
    const runTaskId =
      origin.kind === 'delegation' || origin.kind === 'assignment'
        ? taskForSession(targetSessionKey)
        : null
    // The run's own execution row, read with its task: the engine opens it right
    // before it calls deliver, and forgets it when the run ends.
    const runExecId = runTaskId !== null ? execForSession(targetSessionKey) : null
    const reportForTaskId = framing.reportsForTask ?? null
    const chatVisible = isChatVisible(origin, framing)
    const stamp: RunStamp = { reportForTaskId, stopGen: deliveredGen }
    // A follow-up holds work too: it neither resumes the agent's user-facing
    // session nor overwrites its pointer.
    const holdsWork = isTaskRun || reportForTaskId !== null
    // The start gate. A delivery may start only while the stop generation has not
    // moved and, for a task run, the engine still maps the session to that task.
    // A refused start settles as delivered to nobody, never as a failure, because
    // the engine's catch would fail whatever task holds the session now. After a
    // Stop the queue is already reset and must not be marked idle. After a
    // release the slot is this delivery's own, so queued successors must flush.
    const refusal = (): 'stopped' | 'released' | null => {
      if (stopGen() !== deliveredGen) return 'stopped'
      if (runTaskId !== null && taskForSession(targetSessionKey) !== runTaskId) return 'released'
      return null
    }
    // Volatile-tier team context: rules + the user's self-intro + the live roster
    // (the single choke point covers the user's leader turn AND every delegated
    // child turn). See `contextPreamble.ts`.
    const baseTeamContext = isTeamSessionKey(targetSessionKey)
      ? buildServerTeamContext(db, teamId, targetAgentId, framing, chatRoomId)
      : null
    // WHAT IS WAITING is read when the run actually STARTS, never at `deliver`
    // time. `nudge.deliver` FIFO-queues behind a busy session, so reading here in
    // the outer scope meant two stacked deliveries both read the same undelivered
    // rows and the same cursor — neither had begun — and both carried the same
    // digest and the same peer posts. `markInboxDelivered` stops the double
    // bookkeeping; it cannot un-bake duplicated context. It also meant anything
    // arriving while the delivery sat in the queue was missed, which is the exact
    // opposite of "currency is a property of the runner".
    const renderWaiting = (): {
      teamContext: string | null
      digestIds: string[]
      roomId: string | null
      throughSeq: number | null
    } => {
      // Read past the page size, then keep this room's rows: a row about a task
      // delegated in another chat room waits for that room's run.
      const inboxRows = isTeamSessionKey(targetSessionKey)
        ? listUndeliveredInbox(db, targetAgentId, { teamId, limit: 50 })
            .filter((row) => inboxRowBelongsToRoom(db, row, chatRoomId))
            .slice(0, 20)
        : []
      // Routed by `kind`, which the mailbox has carried since it shipped and
      // nothing read: a `task_update` is a result to synthesize and an `alert` is
      // a failure to act on. A `signal` is a peer speaking in passing.
      const split = splitInboxByAddressing(inboxRows)
      // ONE budget across both sections, spent on the addressed half first.
      const packedAddressed = packInboxRows(split.addressed, INBOX_BUDGET_CHARS)
      const packedAmbient = packInboxRows(
        split.ambient,
        INBOX_BUDGET_CHARS - packedAddressed.usedChars,
      )
      const roomId = isTeamSessionKey(targetSessionKey) ? resolveRoomForTeam(teamId) : null
      const catchup = roomId
        ? buildPeerCatchup(db, {
            roomId,
            agentId: targetAgentId,
            sinceSeq: loadChatLeaderState(db, roomId, targetAgentId).lastSeenSeq,
          })
        : { text: null, throughSeq: null }
      // Section membership comes from provenance (`kind`, and which reader produced
      // the item), NEVER from the text.
      const envelope = buildTurnEnvelope({
        addressed: packedAddressed.bodies.length
          ? [{ text: packedAddressed.bodies.join('\n') }]
          : [],
        ambient: [
          ...(catchup.text ? [{ text: catchup.text }] : []),
          ...(packedAmbient.bodies.length ? [{ text: packedAmbient.bodies.join('\n') }] : []),
        ],
      })
      return {
        teamContext: [baseTeamContext, envelope].filter(Boolean).join('\n\n') || null,
        // Only rows that actually FIT get marked — a row truncated out of the
        // budget was not delivered and rides the next digest.
        digestIds: [...packedAddressed.includedIds, ...packedAmbient.includedIds],
        roomId,
        throughSeq: catchup.throughSeq,
      }
    }

    // Route through the nudge queue: idle session → send now; busy session →
    // FIFO-enqueue for the next turn boundary (never interrupts an in-flight run).
    return nudge.deliver(
      targetSessionKey,
      () =>
        new Promise<void>((started, failStart) => {
          const settleRefused = (why: 'stopped' | 'released'): void => {
            if (why === 'released') nudge.markIdle(targetSessionKey)
            started()
          }
          // Rendered HERE: this runs when the queue releases the delivery, so the
          // context reflects state at start time rather than at enqueue time.
          const { teamContext, digestIds, roomId, throughSeq } = renderWaiting()
          // Resolve the agent's registry row up front — the runtime tags obs, and (for
          // a connected substrate) the row's gateway id keys the cross-subsystem mutex.
          // NEVER read the task's `assigneeRuntime` (the engine hardcodes 'openclaw'
          // there; the row carries the agent's REAL runtime). A test (makeAdapterForAgent)
          // may target an unseeded agent → row undefined → a plain ephemeral run.
          const row = db.select().from(agents).where(eq(agents.id, targetAgentId)).get() as
            | {
                id: string
                runtime?: string | null
                sourceAgentId?: string | null
                gatewayId?: string | null
                execConfig?: string | null
              }
            | undefined
          const resolvedRuntime = row?.runtime ?? null
          // The model a cost estimate is priced at when the run's cost events name
          // none. Native names its real model on every cost event, but a turn that
          // fails before one is priced at its configured model (an Ollama one as
          // `ollama/…`, so it stays free); an OpenClaw agent's model is read from
          // openclaw.json (its Gateway reports no usage, and an `ollama/…` model must
          // price at $0); a coding runtime's comes from its own config. Computed here
          // so the test seam gets it too.
          const configuredModel =
            resolvedRuntime === 'openclaw'
              ? openclawAgentModel(row?.gatewayId ?? row?.sourceAgentId ?? null)
              : resolvedRuntime === NATIVE_RUNTIME
                ? nativeCostModel(loadAgentConfig(db, targetAgentId))
                : resolvedRuntime
                  ? (parseCodingModelConfig(row?.execConfig ?? null)?.model ?? null)
                  : null

          let adapter: RuntimeAdapter
          let homeKind = 'ephemeral'
          let homeDir: string | null = null
          // The team's shared working folder (coding runtimes only; null otherwise).
          let workdir: string | null = null
          // The resume handle THIS run was started with (ctx.resume) — drives the
          // drain's stale-pointer self-heal on a failed resumed run.
          let resumeHandle: string | null = null
          if (makeAdapterForAgent) {
            // Test path: the adapter is injected. Its caps still pick the mutex: a
            // persistent home takes the home mutex, and the connected mutex engages
            // when a seeded row + a connected-caps adapter opt in (so the connected
            // serialize/cost/obs path is unit-testable).
            const injected = makeAdapterForAgent(targetAgentId)
            if (!injected) {
              failStart(new Error(`no adapter for agent ${targetAgentId}`))
              return
            }
            adapter = injected
            try {
              homeKind = resolveRuntimeIntegration(adapter.capabilities()).home.kind
            } catch {
              // best-effort — treat as ephemeral
            }
            // Mirror production's home resolution + pointer READ so the leader-
            // continuity plumbing (pointer write, stale-pointer self-heal) is
            // exercisable through the seam — the injected adapter itself never
            // touches the path or consumes a ctx.
            homeDir =
              homeKind === 'persistent'
                ? runtimeIdentityHomePath(resolvedRuntime ?? adapter.id, targetAgentId)
                : null
            resumeHandle = teamResumeEligible({
              runtime: resolvedRuntime,
              homeDir,
              isTeamSession: isTeamSessionKey(targetSessionKey),
              isTaskRun: holdsWork,
            })
              ? getSetting(db, nativeTeamSessionSettingKey(targetAgentId, teamId, chatRoomId)) ||
                null
              : null
          } else {
            const runtime = resolvedRuntime
            // native + the coding runtimes (claude-code / codex / hermes), PLUS
            // OpenClaw (the connected substrate, converged here) and the mock
            // harness when its env flag is set. A truly-unknown runtime fails
            // cleanly so the engine reflects it.
            if (!runtime || (!isOrchestratableRuntimeId(runtime) && runtime !== 'openclaw')) {
              failStart(
                new Error(`runtime '${runtime ?? 'unknown'}' is not server-orchestrated yet`),
              )
              return
            }
            if (runtime === 'openclaw') {
              // Connected substrate: run over the server-held paired operator client. A
              // null client → the server's operator connection is down. That can happen
              // even while the Gateway PROCESS is up (a post-restart backoff window, a
              // dropped socket) — so PROACTIVELY kick a reconnect here, closing the
              // window so the user's retry succeeds instead of waiting out the backoff.
              // failStart → the engine reflects "could not deliver" to the delegator.
              const built = buildOpenClawServerAdapter()
              if (!built) {
                void getRegistry()
                  .reconnect()
                  .catch(() => undefined)
                failStart(new Error('OpenClaw operator client unavailable'))
                return
              }
              adapter = built
              homeKind = 'connected'
            } else {
              const factory = adapterFactoryFor(runtime)
              try {
                homeKind = resolveRuntimeIntegration(factory({}).capabilities()).home.kind
              } catch {
                // Can't read caps → treat as a one-shot (the conservative default).
              }
              homeDir =
                homeKind === 'persistent' ? runtimeIdentityHomePath(runtime, targetAgentId) : null
              const apiKeyEnv = buildApiKeyEnv(runtime)
              // Leader continuity (the amnesia fix): resume this (agent, team) leader
              // session so the conversation CONTINUES instead of starting fresh every
              // turn. The native harness reloads the persisted transcript from the
              // per-identity home when ctx.resume is set. Empty pointer (first turn /
              // after a reset) → a fresh session. Gated to the native leader / user-facing
              // team session; a delegated child or a follow-up (holdsWork) is excluded.
              // Mirrors driveAgentChat, but keyed per-(agent, team) to avoid Boo-Zero
              // cross-team / 1:1 collision (see nativeTeamSession.ts).
              const teamResumeId = teamResumeEligible({
                runtime,
                homeDir,
                isTeamSession: isTeamSessionKey(targetSessionKey),
                isTaskRun: holdsWork,
              })
                ? getSetting(db, nativeTeamSessionSettingKey(targetAgentId, teamId, chatRoomId)) ||
                  null
                : null
              // A coding runtime (hermes/codex/claude-code) may carry a per-agent
              // model + provider chosen at team creation, stored on the row's
              // execConfig (`{ model, provider }` — the Hermes model picker). Thread
              // it in so the driver runs that exact model on that provider. Native
              // reads its OWN config (no top-level `model`), so scope to non-native.
              const codingModel =
                runtime !== NATIVE_RUNTIME ? parseCodingModelConfig(row?.execConfig ?? null) : null
              resumeHandle = teamResumeId
              // Claude Code / Codex / Hermes / Native start in the team's own
              // folder, not the server's working directory (clawboo's state dir).
              // For Native the folder is also what turns on its file tools.
              workdir = teamWorkdirFor(runtime, teamId)
              const ctx: RuntimeRunContext = {
                ...(workdir ? { cwd: workdir } : {}),
                model: codingModel?.model ?? null,
                ...(codingModel?.provider ? { providerHint: codingModel.provider } : {}),
                resume: teamResumeId,
                mcpBaseUrl,
                // `delegate: true` = THIS run is orchestrator-driven, so the engine IS
                // observing its tool-calls — it rides the TeamChat attach URL and
                // exposes the `team_delegate` signal tool (how a coding-runtime LEADER
                // delegates; the engine's DELEGATE_TOOL_NAME_RE branch turns the call
                // into a board task). executorRunner runs never set it.
                memoryScope: {
                  teamId,
                  agentId: targetAgentId,
                  delegate: true,
                  attachSecret: getMcpAttachSecret(db),
                },
                ...(homeDir ? { homeDir } : {}),
                ...(Object.keys(apiKeyEnv).length ? { apiKeyEnv } : {}),
              }
              adapter = factory(ctx)
            }
          }
          // const so TS narrows them cleanly inside the closures below.
          const capturedHomeDir = homeDir
          const capturedWorkdir = workdir
          // The native leader session-resume pointer to update on the terminal (the
          // amnesia fix) — non-null ONLY for an eligible native leader / user-facing team
          // turn (a delegated child keeps its own executor-handoff continuity). Threaded
          // into the drain so the write lands BEFORE markIdle, closing the rapid-message
          // race (see drainRun's `done` handler). Read side is ctx.resume above.
          const resumePointerKey = teamResumeEligible({
            runtime: resolvedRuntime,
            homeDir: capturedHomeDir,
            isTeamSession: isTeamSessionKey(targetSessionKey),
            isTaskRun: holdsWork,
          })
            ? nativeTeamSessionSettingKey(targetAgentId, teamId, chatRoomId)
            : null
          // A connected substrate serializes on the SHARED per-gateway-agent mutex —
          // cross-subsystem (routines / runTeamExchange / other teams' orchestrators)
          // AND Boo-Zero-in-N-teams (the one OpenClaw agent that spans teams).
          const connectedKey = homeKind === 'connected' && row ? connectedAgentKey(row) : null

          // Set once the agent's lock is held: from then on runJob settles the
          // delivery itself.
          let jobRan = false
          const runJob = async (): Promise<void> => {
            jobRan = true
            if (capturedHomeDir)
              await mkdir(capturedHomeDir, { recursive: true, mode: 0o700 }).catch(() => undefined)
            // Gate 1: a Stop or a release may have landed while this waited on the
            // agent's lock.
            const before = refusal()
            if (before) {
              settleRefused(before)
              return
            }
            if (capturedWorkdir) {
              try {
                await ensureTeamWorkdir(capturedWorkdir)
              } catch (e) {
                // Never fall back to the server's working directory.
                failStart(
                  new Error(
                    `could not create the team's working folder ${capturedWorkdir}: ${e instanceof Error ? e.message : String(e)}`,
                  ),
                )
                return
              }
            }
            let run: RunHandle
            try {
              run = await adapter.start(
                { taskId: null, teamId },
                {
                  agentId: targetAgentId,
                  sessionKey: targetSessionKey,
                  message,
                  // `sessions_send` — children never fan out further (report-up).
                  // `sessions_spawn`/`sessions_yield` — NO agent may spawn its own
                  // throwaway sub-agents; the team already exists and Clawboo's board
                  // drives delegation (the anti-sub-agent invariant). The native +
                  // claude-code drivers enforce this list; the OpenClaw adapter does
                  // not yet apply it (the prompt-level guard in the team context is the
                  // OpenClaw stopgap — see contextPreamble.ts).
                  childToolBlocklist: ['sessions_send', 'sessions_spawn', 'sessions_yield'],
                  ...(teamContext ? { context: teamContext } : {}),
                },
              )
            } catch (e) {
              // Gate 2: a start that threw after a Stop or a release is not a
              // failure of whatever task holds the session now.
              const why = refusal()
              if (why) {
                settleRefused(why)
                return
              }
              // Immediate-send failure → the engine fails the task now rather than
              // waiting out the 8-minute watchdog (the nudge un-busies the session).
              failStart(e instanceof Error ? e : new Error(String(e)))
              return
            }
            // Gate 3, with no await before abortMap.set: a run refused after it
            // began is aborted and drained silently. Nothing below runs for it, so
            // a refused delivery consumes no inbox rows or cursor.
            const after = refusal()
            if (after) {
              started()
              await discardRun(adapter, run)
              // A Stop during the discard reset the queue, so the slot is no
              // longer this delivery's to free.
              if (after === 'released' && stopGen() === deliveredGen) {
                nudge.markIdle(targetSessionKey)
              }
              return
            }
            abortMap.set(targetSessionKey, { adapter, run })
            // The run STARTED with the catch-up in its context, so the cursor may
            // advance — and only now. Advancing at render time would let a failed
            // start eat the posts, which is the same rule the digest follows one
            // block below. Only through the last post that actually fit.
            if (roomId && throughSeq !== null) {
              try {
                advanceChatLeaderSeq(db, roomId, targetAgentId, throughSeq)
              } catch (err) {
                log.error(
                  { err, roomId, agentId: targetAgentId },
                  'peer catch-up cursor advance failed',
                )
              }
            }
            // The run started with the digest in its context — mark the rows
            // that were RENDERED delivered (first-winner guard handles a racing
            // channel; truncated-out rows stay undelivered by design).
            if (digestIds.length > 0) {
              try {
                markInboxDelivered(db, digestIds, 'digest')
              } catch {
                /* best-effort; undelivered rows simply ride the next digest */
              }
            }
            // Left-pane liveness: the run is in flight — flip the agent's badge to
            // Working the moment its run starts (the drain flips it back on the
            // terminal). Delegated children get this too, so a cascade shows every
            // busy teammate, not just the leader.
            publishStatus?.(targetAgentId, 'running')
            // `deliver` resolves HERE — after start, BEFORE the drain — so the
            // engine's `await deps.deliver` doesn't serialize the cascade. The home /
            // connected mutex (when held) stays held for the WHOLE drain below.
            started()
            // A task run can be steered while it works: a person commenting on
            // the task reaches it through the per-task registry (see runSteers).
            const steerHandle =
              runTaskId !== null ? registerRunSteer(runTaskId, adapter, run) : null
            try {
              await drainRun(adapter, run, targetSessionKey, targetAgentId, {
                runtime: resolvedRuntime,
                message,
                contextChars: teamContext ? teamContext.length : 0,
                resumePointerKey,
                resumeAttempted: resumeHandle != null,
                chatVisible,
                stamp,
                execId: runExecId,
                model: configuredModel,
              })
            } finally {
              steerHandle?.release()
            }
          }

          // A connected substrate (OpenClaw) serializes on the connected mutex; a
          // persistent-home runtime (native) on the home mutex — held across the whole
          // drain so a concurrent executor run / routine / heartbeat for the same
          // (runtime, agent) can't overlap its session / native state.db. The nudge
          // alone only knows THIS orchestrator's sessions. The two are mutually
          // exclusive (connected has no homeDir; persistent is not connected).
          const job = connectedKey
            ? () =>
                connectedAgentMutex.run(connectedKey, runJob, {
                  acquireTimeoutMs: HOME_MUTEX_ACQUIRE_MS,
                })
            : capturedHomeDir
              ? () =>
                  homeDispatchMutex.run(capturedHomeDir, runJob, {
                    acquireTimeoutMs: HOME_MUTEX_ACQUIRE_MS,
                  })
              : runJob
          // TIMER-DRIVEN liveness beat spanning the run's whole ownership window:
          // the mutex WAIT (legitimately up to HOME_MUTEX_ACQUIRE_MS behind a
          // sibling run), adapter start, and every silent stretch of the drain.
          // Beat = this process owns the delivery; the interval dies with the
          // process, which is exactly what the minutes-scale stale sweep reads.
          // Delegated task runs only (a leader/user turn has no task row).
          const beatTaskId = taskForSession(targetSessionKey)
          const stopBeat = beatTaskId
            ? startTaskHeartbeat(db, beatTaskId, { assigneeAgentId: targetAgentId })
            : (): void => undefined
          void job()
            .catch((e: unknown) => {
              // A lock wait that timed out never reached runJob's gates. After a
              // Stop or a release that is a refused start too, not a failure of
              // whatever task holds the session now.
              if (!jobRan) {
                const why = refusal()
                if (why) {
                  settleRefused(why)
                  return
                }
              }
              // runJob settles `started`/`failStart` itself; this catch only guards an
              // unexpected throw before/around that so it isn't an unhandled rejection.
              failStart(e instanceof Error ? e : new Error(String(e)))
            })
            .finally(() => stopBeat())
        }),
    )
  }
}
