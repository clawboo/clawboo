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

import { randomUUID } from 'node:crypto'
import { mkdir } from 'node:fs/promises'

import { agedTaskPriority } from '@clawboo/board-core'
import {
  agents,
  getAncestors,
  getSetting,
  getTask,
  giveBackJobRun,
  noteJobRun,
  listUndeliveredInbox,
  markInboxDelivered,
  recordExecutionUsage,
  recordSpend,
  INBOX_BUDGET_CHARS,
  packInboxRows,
  setSetting,
  adoptTaskWakes,
  startTaskHeartbeat,
  updateTaskFields,
  startRefusedBy,
  type BudgetRefusalReason,
  type BudgetScope,
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
  BUDGET_HELD_CODE,
  BUDGET_REFUSED_CODE,
  DeliveryRefusedError,
  isChatVisible,
  isTeamSessionKey,
  OPEN_TOOL_CALL_TIMEOUT_MS,
  type NudgeQueue,
  type RunStamp,
  type TurnOrigin,
} from '@clawboo/team-orchestration'
import { eq } from 'drizzle-orm'

import { getRegistry } from '../agentSource/registry'
import {
  NO_BUDGET_HOLD,
  reserveRunBudget,
  type RunBudgetGate,
  type RunBudgetHold,
} from '../budgetHold'
import { auditBudgetCrossing } from '../budgetAudit'
import { budgetRefusalText } from '../budgetPreflight'
import { HOME_MUTEX_ACQUIRE_MS, homeDispatchMutex } from '../executorRunner'
import {
  isPassingCause,
  RUN_ENDED_WITHOUT_RESULT,
  runFailureText,
  teamOverflowNotClearedText,
  teamOverflowText,
} from '../runFailureText'
import { PausedDeliveryError, pauseRefusalText, pauseStopNote } from '../pauseBus'
import { runSlots, PERSON_TURN, type RunSlot, type RunRank } from '../runSlots'
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
import { startFolderRun, type FolderRun } from '../runtimes/teamFolderActivity'
import { ensureTeamWorkdir, teamWorkdirFor } from '../runtimes/teamWorkdir'
import type { RuntimeRunContext } from '../runtimes/types'
import { resolveRuntimeKeyForRuntime } from '../secretsVault'
import { buildServerTeamContext, buildTicketBlock } from './contextPreamble'
import {
  encodeTaskSessionPointer,
  nativeTeamSessionSettingKey,
  taskResumeEligible,
  taskSessionSettingKey,
  teamResumeEligible,
  type TaskSessionPointer,
} from './nativeTeamSession'
import { readTaskSessionPointer, taskPointerWantedFor, ticketHashOf } from './taskSessionPointers'
import { getMcpAttachSecret } from '../mcpAttachSecret'
import { inboxRowBelongsToRoom } from './roomRoster'
import { buildPeerCatchup } from './peerCatchup'
import { advanceChatLeaderSeq, loadChatLeaderState } from './leaderState'

const log = createLogger('server-deliver')

/** clawboo's own in-process runtime. Its agents read their own config, so the
 *  coding-runtime model override below skips them. */
const NATIVE_RUNTIME = 'clawboo-native'

/**
 * The session's wedge while its run sits inside one tool call (call seen, no
 * result yet). The runtime is silent then by design, sometimes for many minutes:
 * a long build, a command that prints nothing, an approval the person has not
 * answered. The nudge queue's usual 10 minutes would abort such a run before the
 * engine's own allowance for an open tool call runs out. A minute past that
 * allowance, so the engine's sweep fails a stuck delegate first, with its clearer
 * reason; the 30-minute drain guard stays the outer bound.
 */
export const TOOL_CALL_WEDGE_MS = OPEN_TOOL_CALL_TIMEOUT_MS + 60_000

/** Where a run records the session it ended with, so the next run resumes it. */
interface ResumePointerWrite {
  /** The settings key. */
  key: string
  /** The value to store for the session id the run ended with. */
  encode: (sessionId: string) => string
  /** A failed run that tried to resume most likely holds a dead handle, so it
   *  clears the pointer. A task run that was stopped part way or ran out of
   *  turns keeps it: its session is sound, the run was only cut short. A run
   *  that outgrew the model's context window always clears it (see
   *  settleResumePointer). */
  keepUnlessError: boolean
  /** Asked before writing. A task finished or cancelled while its run went on
   *  has had its pointers cleared, and the stopped run must not write one back. */
  wanted?: () => boolean
}

type DoneReason = Extract<RuntimeEvent, { kind: 'done' }>['reason']

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
  /** The delivery's stamp, which reaches the engine with each of the run's events. */
  stamp?: RunStamp
  /** A pause stopped this run: what the chat says. Not a failure, so not one of the
   *  reasons above, which read as a run that failed. */
  pauseNote?: string | null
  /** The board task this run works on, when it is a task's run. */
  taskId?: string | null
}

/** Give back what a refused run took from its job's count. Best-effort: it is a count, and
 *  the refusal still has to reach the engine. */
function noteRunNeverStarted(db: ClawbooDb, execId: string): void {
  try {
    giveBackJobRun(db, execId)
  } catch (err) {
    log.error({ err, execId }, 'giving a refused run back to its job failed')
  }
}

/** Stop this run for a pause. The engine reads it as a stop from the stamp, and the
 *  chat gets the note as it stands. */
export function stopRunForPause(entry: RunEntry, note: string): void {
  entry.pauseNote = note
  if (entry.stamp) entry.stamp.stoppedByPause = true
  void entry.adapter.abort(entry.run).catch(() => undefined)
}

/** A delivery waiting in the process's run queue (see runSlots), keyed by sessionKey
 *  in the host's queued map from the moment it queues until its run starts. */
export interface QueuedRun {
  /** Take it out of the queue (Stop, teardown). It never starts. */
  cancel(): void
  /** The board task this delivery runs, when it is a task's run. */
  taskId?: string | null
  /** It is a task update or a follow-up, about this task when it names one. A pause
   *  takes it out of the queue, since it would hold its agent's session for the whole
   *  pause. Its report-ups go back to the outbox and wait there. */
  report?: { taskId: string | null; stamp: RunStamp }
}

/** What the chat says for a person's message that was taken back before its run began. */
const MESSAGE_NOT_STARTED =
  'This message was stopped before it started. Send it again if you still want it.'

/** How often a queued delivery re-marks its session busy, well inside the nudge
 *  queue's 10-minute wedge timer, which would otherwise force-idle the session and
 *  let the next delivery start a second run on it. */
const QUEUED_KEEPALIVE_MS = 60_000

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
  /** sessionKey → a delivery waiting for a run slot, so `stop()` can cancel it and the
   *  engine's watchdog can tell waiting from silence. Populated here when every slot
   *  is taken; evicted when the run starts or the delivery ends. Omitted in tests
   *  that do not look at it. */
  queuedRuns?: Map<string, QueuedRun>
  /** The engine's event sink: the orchestrator's `onEvent`. `run` is the stamp
   *  fixed when this run was delivered. */
  onEvent: (sessionKey: string, event: RuntimeEvent, run: RunStamp) => Promise<void>
  /** The engine's `onSessionClosed` — called when a drain ends without a terminal. */
  onSessionClosed: (sessionKey: string, run: RunStamp) => Promise<void>
  /** The engine's `onRunNotStarted`: a delivery whose `deliver` had already
   *  resolved (it waited in the queue) could not start its run. Called only for
   *  one that carries report-ups. */
  onRunNotStarted?: (run: RunStamp) => void
  /** The engine's `takeHeldReportUps`: what a person's Stop held for this agent's
   *  next run, as text for the context a run starts with. */
  takeHeldReportUps?: (
    sessionKey: string,
    taskId?: string,
  ) => { ids: string[]; text: string } | null
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
  const queuedRuns = deps.queuedRuns ?? new Map<string, QueuedRun>()
  const execForSession = deps.execForSession
  const chatRoomId = deps.chatRoomId ?? null
  const stopGen = deps.stopGen
  const leaderAgentId = deps.leaderAgentId
  const persistTurn = deps.persistTurn
  const publishDelta = deps.publishDelta
  const publishStatus = deps.publishStatus
  const makeAdapterForAgent = deps.makeAdapterForAgent
  /** Agents already told, in the chat, that a paused budget refused their turn. A
   *  task update to a paused lead is retried, and one notice per pause is enough;
   *  a person's or a routine's message always gets its own. Cleared when the
   *  agent's next run starts. */
  const budgetNoticeShown = new Set<string>()

  /** Record this run's spend; return true if a CAP budget crossed 100% (kill-switch).
   *  A budget-ledger failure must NEVER propagate: it would be caught by the drain's
   *  outer try/catch and END the run WITHOUT its terminal — swallowing the agent's
   *  reply (no chat commit) + any delegate signal (no board task). The budget is a
   *  guardrail, not the payload, so a ledger error degrades to "not paused" and the
   *  run's output still reaches the chat. (This is how a stale-DB `recordSpend` schema
   *  error silently broke every native team turn — native emits `cost` events, OpenClaw
   *  doesn't.) */
  function recordSpendForRun(
    sessionKey: string,
    agentId: string,
    usd: number,
    holdId: string | null,
  ): boolean {
    try {
      const cents = usdToFractionalCents(usd)
      // The run's own spend replaces its held estimate as it lands (see budgetHold).
      const spend = { holdId }
      const a = recordSpend(db, 'agent', agentId, cents, spend)
      const t = recordSpend(db, 'team', teamId, cents, spend)
      const taskId = taskForSession(sessionKey)
      const missionId = taskId ? missionRootId(db, taskId) : null
      const m = missionId ? recordSpend(db, 'mission', missionId, cents, spend) : null
      const on = { runKind: 'team-chat', agentId, teamId, taskId } as const
      auditBudgetCrossing(db, { ...on, scope: 'agent', scopeId: agentId, result: a })
      auditBudgetCrossing(db, { ...on, scope: 'team', scopeId: teamId, result: t })
      if (missionId)
        auditBudgetCrossing(db, { ...on, scope: 'mission', scopeId: missionId, result: m })
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
      /** The resume pointer to update on the terminal: the leader's, for an
       *  eligible leader/user-facing team turn, or the run's own task's, for a
       *  task run whose runtime can resume. Null otherwise. */
      resumePointer: ResumePointerWrite | null
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
      /** Give the run's slot back (see runSlots) and end its report that it is
       *  working in the team folder, so its own check does not wait on it. Called
       *  once the run is over, before
       *  the session's next delivery flushes and before the engine reacts to the
       *  terminal, so whatever that starts can take the slot. */
      releaseRunSlot: () => void
      /** The run's budget hold (see budgetHold): its id rides every spend, and it
       *  is released once the run's cost is settled, before the slot, so a run the
       *  terminal starts does not count this one as still going. */
      hold: RunBudgetHold
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
        if (cost.unbilledUsd > 0)
          recordSpendForRun(sessionKey, agentId, cost.unbilledUsd, obs.hold.id)
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
      // Settled: the real spend has replaced the estimate.
      obs.hold.release()
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
    /** The run reported a context overflow (fatal or not), and what it said. */
    let overflowed = false
    let overflowReason = ''
    /** False once a clear of an overflowed session has failed: its next run resumes it. */
    let overflowCleared = true
    /** A hard cap's kill-switch ended this run, which every runtime reports as a plain
     *  `done: aborted`. The engine files it under the budget, not as a failure. */
    let killedByBudget = false
    /** The typed cause of the fatal error that ended the run. */
    let failureCode: string | null = null
    /**
     * Record the session this run ended with, so the next run resumes it, or
     * clear the pointer. Called once, on the run's first terminal and BEFORE
     * markIdle: the next queued delivery, which the nudge flushes on markIdle,
     * reads the pointer to build ctx.resume, so a write after the drain would
     * let a rapidly-sent message 2 resume message 0's transcript and drop this
     * turn. The harness awaited saveSessionTranscript before its terminal, so
     * the session file exists. `null` is a stream that died with no terminal.
     */
    const settleResumePointer = async (reason: DoneReason | null): Promise<void> => {
      const pointer = obs.resumePointer
      if (!pointer || !adapter.sessionCodec) return
      const sound =
        reason === 'success' ||
        (pointer.keepUnlessError && (reason === 'aborted' || reason === 'max_turns'))
      try {
        if (overflowed && reason !== 'success') {
          // The session outgrew the model's context window, so the next run must
          // not resume it, whether or not this run was itself a resume. Claude
          // Code reports an overflow as out of room (`done: max_turns`), which
          // would otherwise keep the pointer, and resuming such a session
          // overflows again (seen with Claude Code 2.1.268 against a stand-in
          // API that enforced a context limit).
          overflowCleared = false
          setSetting(db, pointer.key, '')
          overflowCleared = true
          return
        }
        if (!sound && obs.resumeAttempted && !isPassingCause(failureCode)) {
          // Stale-pointer self-heal (mirrors executorRunner's clear-on-failed-
          // resume): a run that TRIED to resume and failed most likely holds a
          // dead handle (codex `exec resume <unknown-id>` is a hard exit 1), so
          // writing it back would send every later run through the same failure.
          // Clear it; the next run starts fresh. A failure that passes by itself (a
          // rate limit, an overload) says nothing about the session, so it stays.
          setSetting(db, pointer.key, '')
          return
        }
        // A stream that died with no terminal may still have its run going.
        if (reason === null || (pointer.wanted && !pointer.wanted())) return
        const blob = await adapter.sessionCodec.serialize(run)
        const sid = (JSON.parse(blob) as { sessionId?: string | null }).sessionId
        if (sid) setSetting(db, pointer.key, pointer.encode(sid))
      } catch (err) {
        // Best-effort: a missing or unparseable id means the next run starts fresh.
        log.warn({ err, sessionKey }, 'could not settle a run resume pointer')
      }
    }

    // Drain idle guard: a wedged adapter iterator must not hang this drain (and
    // with it the agent's home mutex + the engine's view of the session) forever.
    // Silence past the ceiling aborts the run; the abort surfaces `done:aborted`,
    // which `markServerAbort` marks so the terminal below reports it rather than
    // reading it as a deliberate stop, and a stream silent through the grace ends
    // → `onSessionClosed` fails it with "ended before reporting".
    const silentMs =
      Number(process.env['CLAWBOO_RUN_SILENT_TIMEOUT_MS']) || DEFAULT_RUN_SILENT_TIMEOUT_MS
    /** The tool calls this run is inside: seen, with no result yet. */
    const openToolCalls = new Set<string>()
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
        if (ev.kind === 'error' && ev.code === 'context_overflow') {
          overflowed = true
          overflowReason = ev.message
        }
        if (ev.kind === 'error' && ev.fatal) failureCode = ev.code ?? null
        if (ev.kind === 'tool-call') openToolCalls.add(ev.toolCallId || ev.name)
        else if (ev.kind === 'tool-result') openToolCalls.delete(ev.toolCallId || ev.name)
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
          if (recordSpendForRun(sessionKey, agentId, ev.costUsd, obs.hold.id)) {
            markServerAbort('the run was stopped by a budget cap')
            killedByBudget = true
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
          const pauseNote = abortMap.get(sessionKey)?.pauseNote
          if (pauseNote) {
            if (chatVisible) deps.persistMeta?.(sessionKey, pauseNote)
          } else if (chatVisible && !doneText.trim()) {
            const killed = takeServerAbortReason()
            if (killed) deps.persistMeta?.(sessionKey, runFailureText(killed, obs.runtime))
          }
        }
        // Per-tool runtime detail → the obs activity terminal (all runtimes).
        emitRunObs(sessionKey, agentId, obs.runtime, ev)
        const terminal = ev.kind === 'done' || (ev.kind === 'error' && ev.fatal)
        if (terminal) {
          // On the FIRST terminal: every runtime ends a failed run with a fatal
          // `error` before its `done`, and this loop stops at the first one.
          await settleResumePointer(ev.kind === 'done' ? ev.reason : 'error')
          // An overflow cost this agent its session (settleResumePointer): say that,
          // once, in place of a failure notice.
          const outgrew = overflowed && !(ev.kind === 'done' && ev.reason === 'success')
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
            else if (!outgrew) {
              const provider = loadAgentConfig(db, agentId)?.primaryProvider
              deps.persistMeta?.(sessionKey, runFailureText(ev.message, obs.runtime, provider))
            }
          }
          if (outgrew && chatVisible) {
            const name = db.select().from(agents).where(eq(agents.id, agentId)).get()?.name
            deps.persistMeta?.(
              sessionKey,
              overflowCleared
                ? teamOverflowText(name, !!obs.resumeAttempted)
                : teamOverflowNotClearedText(name),
            )
          }
          // Stream-without-commit belt: a turn that streamed live tokens but persisted
          // nothing (pure silent delegation, a write-time drop, an insert error) gets
          // one CLEARING delta — empty text tells the client to drop its StreamingCard
          // (nothing will ever replace it, so leaving it lingers-then-vanishes).
          if (publishedDelta && !persistedTurn) publishDelta?.(sessionKey, null, '')
          // Price the run now, before the slot goes and the engine's close (onEvent
          // below), on the text it produced: the committed reply on a `done`, the
          // partial on a fatal error. Settling releases its budget hold, so a run
          // that markIdle or the engine starts next does not see this one as going.
          settleRunCost(ev.kind === 'done' ? (acc.trim() ? acc : (ev.summary ?? '')) : acc)
          obs.releaseRunSlot()
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
        } else if (ownsSlot())
          nudge.markBusy(sessionKey, openToolCalls.size > 0 ? TOOL_CALL_WEDGE_MS : undefined)
        try {
          // The engine records a failed `done`'s summary as its detail on the board.
          // An overflow's reason rode a non-fatal error and is no part of the agent's
          // reply, so it joins the detail here, after the chat commit above.
          // A clean end whose text came only as deltas did reply, and the engine reads
          // an empty summary as no reply at all.
          await onEvent(
            sessionKey,
            ev.kind === 'done' && killedByBudget && ev.reason !== 'success'
              ? {
                  ...ev,
                  kind: 'error',
                  code: BUDGET_REFUSED_CODE,
                  message: 'A hard budget cap stopped this run while it was going.',
                  fatal: true,
                }
              : ev.kind === 'done' && overflowed && ev.reason !== 'success'
                ? { ...ev, summary: [overflowReason, ev.summary].filter(Boolean).join(' ') }
                : ev.kind === 'done' && ev.reason === 'success' && !ev.summary?.trim() && acc.trim()
                  ? { ...ev, summary: acc }
                  : ev,
            obs.stamp,
          )
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
      await settleResumePointer(null)
      // A dead stream still cost something. Priced before the slot goes and before
      // the engine fails the task, whose cost-less close leaves this recorded cost
      // in place.
      settleRunCost(acc)
      obs.releaseRunSlot()
      evictOwnEntry()
      if (ownsSlot()) nudge.markIdle(sessionKey)
      publishStatus?.(agentId, 'idle')
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
    const isTaskRunOrigin =
      origin.kind === 'delegation' || origin.kind === 'assignment' || origin.kind === 'wake'
    const runTaskId = isTaskRunOrigin ? taskForSession(targetSessionKey) : null
    // The run's own execution row, read with its task: the engine opens it right
    // before it calls deliver, and forgets it when the run ends.
    const runExecId = runTaskId !== null ? execForSession(targetSessionKey) : null
    // The title and description the brief carries, hashed now, when the brief was
    // written: an edit made while this waits in the queue reaches the ticket block
    // but not the brief, so the session it starts has seen the older text.
    const briefTask = runTaskId !== null ? getTask(db, runTaskId) : null
    const ticketHash = briefTask ? ticketHashOf(briefTask) : null
    const reportForTaskId = framing.reportsForTask ?? null
    const chatVisible = isChatVisible(origin, framing)
    // Who the run is for, as a pause reads it, and its place in the run queue. The
    // task a follow-up reports on counts as its task for both, and so does the request
    // an update is about. A person's message goes first, because they are watching.
    // Everything else ranks by its task's priority, and a routine or a task update with
    // no task reads as Normal.
    const mainTaskId = origin.kind === 'system' ? origin.mainTaskId : undefined
    // An update outside any request: the job it read, whose hand-offs its turn counts toward.
    const jobTaskId = origin.kind === 'system' ? origin.jobTaskId : undefined
    const queueTaskId = runTaskId ?? reportForTaskId ?? mainTaskId ?? jobTaskId ?? null
    const pauseSubject = { agentId: targetAgentId, teamId, taskId: queueTaskId }
    const queueTask =
      queueTaskId === null ? null : queueTaskId === runTaskId ? briefTask : getTask(db, queueTaskId)
    const queueRank: RunRank =
      origin.kind === 'human'
        ? PERSON_TURN
        : { priority: queueTask ? agedTaskPriority(queueTask, Date.now()) : 0 }
    // The durable report-ups a `[Task Update]` carries ride the stamp, so the
    // engine settles them when THIS run ends, not whichever run ends next.
    const reportUpIds = origin.kind === 'system' ? origin.reportUpIds : undefined
    const wakeIds = origin.kind === 'wake' ? origin.wakeIds : undefined
    const request =
      origin.kind === 'human' || origin.kind === 'schedule' ? origin.request : undefined
    const stamp: RunStamp = {
      reportForTaskId,
      stopGen: deliveredGen,
      deliveryId: randomUUID(),
      ...(reportUpIds?.length ? { reportUpIds } : {}),
      // A person's message, or an update about their request: what the turn hands out
      // goes under that request's main task.
      ...(request ? { request } : {}),
      ...(mainTaskId ? { mainTaskId } : {}),
      ...(jobTaskId ? { jobTaskId } : {}),
      // The run stamped on the task's claim, and the saved wakes it carries: both
      // ride every event of this run back to the engine.
      ...(runExecId !== null ? { execId: runExecId } : {}),
      ...(wakeIds?.length ? { wakeIds: [...wakeIds] } : {}),
    }
    // A follow-up holds work too: it neither resumes the agent's user-facing
    // session nor overwrites its pointer.
    const holdsWork = isTaskRun || reportForTaskId !== null
    // A person's message that will never start says so where they wrote it, whatever
    // stopped it, or they would wait for a reply. Only theirs: nothing else is watched.
    const noteMessageNotStarted = (): void => {
      if (origin.kind === 'human' || origin.kind === 'schedule')
        deps.persistMeta?.(targetSessionKey, MESSAGE_NOT_STARTED)
    }
    // The start gate. A delivery may start only while the stop generation has not
    // moved and, for a task run, the engine still maps the session to that task.
    // A refused start settles as delivered to nobody, never as a failure, because
    // the engine's catch would fail whatever task holds the session now. After a
    // Stop the queue is already reset and must not be marked idle. After a
    // release the slot is this delivery's own, so queued successors must flush.
    const refusal = (): 'stopped' | 'released' | null => {
      if (stopGen() !== deliveredGen) return 'stopped'
      if (runTaskId !== null && taskForSession(targetSessionKey) !== runTaskId) return 'released'
      // The same task, but the engine has opened a newer run for it: one live run.
      if (runExecId !== null && execForSession(targetSessionKey) !== runExecId) return 'released'
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
    //
    // A task run's ticket block (see contextPreamble's `buildTicketBlock`) is
    // rendered at the same moment and placed between the stable team preamble and
    // the envelope: the preamble stays a byte-stable prefix for the provider's
    // prompt cache, and everything that changes from run to run comes after it.
    const renderWaiting = (
      ticketBlock: string | null,
      heldUpdate: string | null,
    ): {
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
      // All of it asks something of this agent: a `task_update` is a result to synthesize
      // and an `alert` is a failure to act on. A peer speaking in passing is the catch-up.
      const packedAddressed = packInboxRows(inboxRows, INBOX_BUDGET_CHARS)
      const roomId = isTeamSessionKey(targetSessionKey) ? resolveRoomForTeam(teamId) : null
      const catchup = roomId
        ? buildPeerCatchup(db, {
            roomId,
            agentId: targetAgentId,
            sinceSeq: loadChatLeaderState(db, roomId, targetAgentId).lastSeenSeq,
          })
        : { text: null, throughSeq: null }
      // Section membership comes from provenance (which reader produced the item),
      // NEVER from the text.
      const envelope = buildTurnEnvelope({
        addressed: packedAddressed.bodies.length
          ? [{ text: packedAddressed.bodies.join('\n') }]
          : [],
        ambient: catchup.text ? [{ text: catchup.text }] : [],
      })
      return {
        teamContext:
          [baseTeamContext, ticketBlock, heldUpdate, envelope].filter(Boolean).join('\n\n') || null,
        // Only rows that actually FIT get marked — a row truncated out of the
        // budget was not delivered and rides the next digest.
        digestIds: packedAddressed.includedIds,
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
          // A task run's own session on its task, from its last run there, when
          // its runtime can resume one (see `taskResumeEligible`). A pointer
          // another runtime wrote is never handed to this one.
          let taskPointer: TaskSessionPointer | null = null
          const readTaskPointer = (
            runtime: string | null,
            home: string | null,
          ): TaskSessionPointer | null => {
            if (runTaskId === null || !runtime) return null
            const eligible = taskResumeEligible({
              runtime,
              homeDir: home,
              isTeamSession: isTeamSessionKey(targetSessionKey),
            })
            if (!eligible) return null
            const p = readTaskSessionPointer(db, targetAgentId, teamId, runTaskId)
            return p && p.runtime === runtime ? p : null
          }
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
            taskPointer = readTaskPointer(resolvedRuntime, homeDir)
            resumeHandle =
              taskPointer?.sessionId ??
              (teamResumeEligible({
                runtime: resolvedRuntime,
                homeDir,
                isTeamSession: isTeamSessionKey(targetSessionKey),
                isTaskRun: holdsWork,
              })
                ? getSetting(db, nativeTeamSessionSettingKey(targetAgentId, teamId, chatRoomId)) ||
                  null
                : null)
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
              // A task run resumes its own session on the task instead; a leader
              // turn never runs a task, so at most one of the two is set.
              taskPointer = readTaskPointer(runtime, homeDir)
              resumeHandle = taskPointer?.sessionId ?? teamResumeId
              // Claude Code / Codex / Hermes / Native start in the team's own
              // folder, not the server's working directory (clawboo's state dir).
              // For Native the folder is also what turns on its file tools.
              workdir = teamWorkdirFor(runtime, teamId)
              const ctx: RuntimeRunContext = {
                ...(workdir ? { cwd: workdir } : {}),
                model: codingModel?.model ?? null,
                ...(codingModel?.provider ? { providerHint: codingModel.provider } : {}),
                resume: resumeHandle,
                mcpBaseUrl,
                // `delegate: true` = THIS run is orchestrator-driven, so the engine IS
                // observing its tool-calls — it rides the TeamChat attach URL and
                // exposes the `team_delegate` signal tool (how a coding-runtime LEADER
                // delegates; the engine's DELEGATE_TOOL_NAME_RE branch turns the call
                // into a board task). executorRunner runs never set it.
                //
                // `boundTaskId`: a task run's own task, signed onto its Tasks URL so
                // the Tasks tools use it when a call leaves taskId out. Not the
                // provenance `taskId`, which would change how memories get promoted.
                // `boundExecutionId`: the run's own ledger row, recorded with each
                // write its Tasks tools make. A lead's turn has neither.
                memoryScope: {
                  teamId,
                  agentId: targetAgentId,
                  delegate: true,
                  attachSecret: getMcpAttachSecret(db),
                  ...(runTaskId !== null ? { boundTaskId: runTaskId } : {}),
                  ...(runExecId !== null ? { boundExecutionId: runExecId } : {}),
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

          // When this run's context was built: recorded with the session's
          // pointer on the terminal, with the brief's ticket hash. Set by
          // `renderRunContext`.
          let seenAt = 0
          /** Report-ups a Stop held that this run took at render (see below). */
          let heldReportUpIds: string[] = []
          /** The run will not start after all: what it took at render goes back. Its
           *  wakes go back when the engine closes its execution. */
          const giveBackHeldReportUps = (): void => {
            if (heldReportUpIds.length > 0)
              deps.onRunNotStarted?.({
                reportForTaskId,
                stopGen: deliveredGen,
                reportUpIds: heldReportUpIds,
              })
            heldReportUpIds = []
          }
          /**
           * The context the run starts with: the stable preamble, a task run's
           * ticket block, then what is waiting. Called inside runJob, with the
           * run's slot and the agent's lock held and right before the start, so
           * a run that waited (for a slot, or behind another of its agent's runs:
           * the task runner, a routine) starts from the board as it is then, not
           * as it was when the queue released it. After the resume decision
           * above, because a resumed session is told what changed.
           */
          const renderRunContext = (): ReturnType<typeof renderWaiting> => {
            seenAt = Date.now()
            let ticketBlock: string | null = null
            if (
              runTaskId !== null &&
              isTeamSessionKey(targetSessionKey) &&
              (origin.kind === 'delegation' ||
                origin.kind === 'assignment' ||
                origin.kind === 'wake')
            ) {
              try {
                // Whatever waits on the task rides this run, with no wake of its
                // own: a comment that came while it waited for a slot or the lock, a
                // comment that waited through a check, a wake a Stop held. Taken
                // BEFORE the block is read, so what comes after waits in a new row.
                if (runExecId !== null) {
                  const taken = adoptTaskWakes(db, runTaskId, runExecId).map((w) => w.id)
                  if (taken.length > 0)
                    stamp.wakeIds = [...new Set([...(stamp.wakeIds ?? []), ...taken])]
                }
                ticketBlock = buildTicketBlock(db, targetAgentId, {
                  taskId: runTaskId,
                  execId: runExecId,
                  origin,
                  briefHash: ticketHash,
                  resumed: taskPointer
                    ? {
                        ticketHash: taskPointer.ticketHash,
                        seenAt: taskPointer.seenAt,
                        endedAt: taskPointer.endedAt ?? null,
                      }
                    : null,
                })
              } catch (err) {
                // The brief still goes out: a run without its ticket block is the
                // old behavior, not a failure.
                log.error({ err, taskId: runTaskId }, 'ticket block could not be built')
              }
            }
            // Report-ups a person's Stop held for this agent's next run, which is this
            // one, and what came back from the work this task handed out.
            const held = isTeamSessionKey(targetSessionKey)
              ? (deps.takeHeldReportUps?.(targetSessionKey, runTaskId ?? undefined) ?? null)
              : null
            if (held) {
              heldReportUpIds = held.ids
              stamp.reportUpIds = [...(stamp.reportUpIds ?? []), ...held.ids]
            }
            return renderWaiting(ticketBlock, held?.text ?? null)
          }

          // The resume pointer to update on the terminal. Threaded into the drain
          // so the write lands BEFORE markIdle, closing the rapid-message race (see
          // the drain's `settleResumePointer`). Read side is ctx.resume above.
          //  · A task run whose runtime can resume: its own pointer on the task,
          //    recording what this session saw (the ticket hash and `seenAt`) and
          //    when its run ended.
          //  · An eligible leader / user-facing team turn (the amnesia fix): the
          //    leader's pointer, holding the bare session id.
          const taskPointerRuntime =
            runTaskId !== null &&
            resolvedRuntime &&
            ticketHash !== null &&
            taskResumeEligible({
              runtime: resolvedRuntime,
              homeDir: capturedHomeDir,
              isTeamSession: isTeamSessionKey(targetSessionKey),
            })
              ? resolvedRuntime
              : null
          const resumePointer: ResumePointerWrite | null =
            taskPointerRuntime !== null && runTaskId !== null && ticketHash !== null
              ? {
                  key: taskSessionSettingKey(targetAgentId, teamId, runTaskId),
                  encode: (sessionId) =>
                    encodeTaskSessionPointer({
                      sessionId,
                      runtime: taskPointerRuntime,
                      ticketHash,
                      seenAt,
                      // Encoded as the run ends.
                      endedAt: Date.now(),
                    }),
                  keepUnlessError: true,
                  wanted: () => taskPointerWantedFor(getTask(db, runTaskId), targetAgentId),
                }
              : teamResumeEligible({
                    runtime: resolvedRuntime,
                    homeDir: capturedHomeDir,
                    isTeamSession: isTeamSessionKey(targetSessionKey),
                    isTaskRun: holdsWork,
                  })
                ? {
                    key: nativeTeamSessionSettingKey(targetAgentId, teamId, chatRoomId),
                    encode: (sessionId) => sessionId,
                    keepUnlessError: false,
                  }
                : null
          // A connected substrate serializes on the SHARED per-gateway-agent mutex —
          // cross-subsystem (routines / runTeamExchange / other teams' orchestrators)
          // AND Boo-Zero-in-N-teams (the one OpenClaw agent that spans teams).
          const connectedKey = homeKind === 'connected' && row ? connectedAgentKey(row) : null

          // The process-wide run cap (see runSlots), keyed on the agent lock this run
          // takes. A delegated task's delivery that finds every slot taken is settled
          // as delivered at once: the engine awaits it, often from inside a lead's
          // drain that holds a slot, and waiting there for a slot only that lead can
          // free would stall both. From then on, what happens to it reaches the
          // engine the way a run's own ending would. Any other delivery (a person's
          // or a routine's message, a task update) waits for its slot unsettled:
          // nothing holding a slot awaits it, and its caller keeps its own handling
          // of a failure to start.
          const slotKey = capturedHomeDir ?? connectedKey ?? null
          let settledEarly = false
          let queuedEntry: QueuedRun | null = null
          let keepBusy: ReturnType<typeof setInterval> | null = null
          let runSlot: RunSlot | null = null
          // This run's report that it is working in the team folder, from just
          // before its start to its end (see teamFolderActivity).
          let folderRun: FolderRun | null = null
          const runFolder = teamWorkdirFor(resolvedRuntime, teamId)
          // The run's budget hold, from the budget gate until its cost settles or the
          // run is refused; the job's `finally` releases it too, whatever ended it.
          let runHold: RunBudgetHold | null = null
          let runStarted = false
          /** Out of the run queue: the run started, or the delivery ended without one. */
          const leaveQueue = (): void => {
            if (keepBusy) clearInterval(keepBusy)
            keepBusy = null
            if (queuedEntry && queuedRuns.get(targetSessionKey) === queuedEntry)
              queuedRuns.delete(targetSessionKey)
            queuedEntry = null
          }
          /**
           * A delivery settled early ended without a run. A released task needs
           * nothing from the engine, which already let go of it. A Stop releases the
           * task cleanly and a failure to start fails it, but only while the session
           * still holds that task: a Stop can free the session for a newer task while
           * this delivery waited for its agent's lock, and an ending meant for this
           * one would then fail the newer task.
           */
          const endQueued = async (outcome: 'stopped' | 'released' | Error): Promise<void> => {
            const ownsSession = stopGen() === deliveredGen
            if (outcome === 'released') {
              if (ownsSession) nudge.markIdle(targetSessionKey)
              return
            }
            if (outcome !== 'stopped') {
              // A refusal has already put its reason in the chat.
              if (chatVisible && !(outcome instanceof DeliveryRefusedError)) {
                const provider = loadAgentConfig(db, targetAgentId)?.primaryProvider
                deps.persistMeta?.(
                  targetSessionKey,
                  runFailureText(outcome.message, resolvedRuntime, provider),
                )
              }
              if (ownsSession) nudge.markIdle(targetSessionKey)
            }
            if (runTaskId === null || taskForSession(targetSessionKey) !== runTaskId) return
            const base = { runId: '', sessionId: null, ts: Date.now(), seq: 0 }
            const ending: RuntimeEvent =
              outcome === 'stopped'
                ? { ...base, kind: 'done', reason: 'aborted', summary: '' }
                : {
                    ...base,
                    kind: 'error',
                    code:
                      outcome instanceof DeliveryRefusedError && outcome.budget
                        ? outcome.budgetReason === 'held'
                          ? BUDGET_HELD_CODE
                          : BUDGET_REFUSED_CODE
                        : null,
                    message: outcome.message,
                    fatal: true,
                  }
            try {
              await onEvent(targetSessionKey, ending, stamp)
            } catch (err) {
              log.error(
                { err, sessionKey: targetSessionKey },
                'engine rejected the end of a queued run',
              )
            }
          }
          const settleStarted = (): void => {
            if (!settledEarly) started()
          }
          const settleFailed = (err: Error): void => {
            if (!settledEarly) failStart(err)
            else if (!runStarted) void endQueued(err)
          }
          const settleRefused = (why: 'stopped' | 'released'): void => {
            // It never started, so whatever it carried goes back to the outbox.
            if (stamp.reportUpIds) deps.onRunNotStarted?.(stamp)
            noteMessageNotStarted()
            if (settledEarly) {
              void endQueued(why)
              return
            }
            if (why === 'released') nudge.markIdle(targetSessionKey)
            started()
          }

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
            // A pause placed while this waited for its slot or its agent's lock: no stop
            // could reach it, since it was in neither the queue nor the run map. Nothing
            // has started yet. A task run needs no check here: the engine let go of its
            // task, so the gate above refused it.
            const pausedBefore = runTaskId === null ? startRefusedBy(db, pauseSubject) : null
            if (pausedBefore) {
              if (origin.kind === 'human' || origin.kind === 'schedule') {
                const text = pauseRefusalText(pausedBefore)
                if (chatVisible) deps.persistMeta?.(targetSessionKey, text)
                settleFailed(new PausedDeliveryError(text))
                return
              }
              if (stamp.reportUpIds) {
                settleRefused('released')
                return
              }
            }
            // The budget gate, as in the task runner: a paused hard cap on the agent,
            // the mission its task belongs to or the team refuses the run before it
            // starts, and so does a cap whose remaining room runs already going have
            // set aside. A run let start holds its estimate on each of them until its
            // cost settles (see budgetHold). Taken while holding the agent's lock, so
            // a cap that the run ahead of this one paused is seen. A ledger read that
            // fails lets the run go, as a failed spend write does (see
            // recordSpendForRun).
            let budget: RunBudgetGate = { blocked: false, hold: NO_BUDGET_HOLD }
            try {
              const missionTaskId = taskForSession(targetSessionKey)
              budget = reserveRunBudget(
                db,
                {
                  agentId: targetAgentId,
                  missionId: missionTaskId ? missionRootId(db, missionTaskId) : null,
                  teamId,
                },
                { kind: 'team-chat', ref: targetSessionKey },
              )
            } catch (err) {
              log.error({ err, agentId: targetAgentId }, 'budget gate could not read the budgets')
            }
            const refuseForBudget = (scope: BudgetScope, reason: BudgetRefusalReason): void => {
              // It never started, so its job's count gets back what its claim took.
              if (runExecId !== null) noteRunNeverStarted(db, runExecId)
              // A task update tries again by itself; anything else waits for a person.
              const text = budgetRefusalText(scope, reason, origin.kind === 'system')
              // What it carries waits for the room to come back, having spent no try.
              if (reason === 'held') stamp.budgetHeld = true
              const personAsked = origin.kind === 'human' || origin.kind === 'schedule'
              if (chatVisible && (personAsked || !budgetNoticeShown.has(targetAgentId))) {
                budgetNoticeShown.add(targetAgentId)
                deps.persistMeta?.(targetSessionKey, text)
              }
              settleFailed(new DeliveryRefusedError(text, { budget: true, budgetReason: reason }))
            }
            if (budget.blocked) {
              refuseForBudget(budget.scope, budget.reason)
              return
            }
            const hold = budget.hold
            runHold = hold
            if (capturedWorkdir) {
              try {
                await ensureTeamWorkdir(capturedWorkdir)
              } catch (e) {
                hold.release()
                // Never fall back to the server's working directory.
                settleFailed(
                  new Error(
                    `could not create the team's working folder ${capturedWorkdir}: ${e instanceof Error ? e.message : String(e)}`,
                  ),
                )
                return
              }
            }
            // Rendered HERE, with the run's slot and its agent's lock held and every
            // gate passed, so the context is the state at start time: anything that
            // arrived while the delivery waited (in the nudge queue, for a run slot
            // or for the lock) rides this turn. A task run's ticket block and its
            // `seenAt` are built with it (see renderRunContext).
            const { teamContext, digestIds, roomId, throughSeq } = renderRunContext()
            // The final gate, right before the model call: a cap that paused while
            // the run got ready refuses it now, before anything is spent, and its
            // hold goes before the refusal reaches the engine.
            const finalGate = hold.recheck()
            if (finalGate.blocked) {
              hold.release()
              giveBackHeldReportUps()
              refuseForBudget(finalGate.scope, finalGate.reason)
              return
            }
            if (runFolder) folderRun = startFolderRun(runFolder, targetAgentId)
            let run: RunHandle
            try {
              run = await adapter.start(
                // Every adapter ignores this argument today; the agent learns its
                // task from the ticket block and its Tasks URL. Passed truthfully
                // all the same, as the task runner does.
                { taskId: runTaskId, teamId },
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
              // Nothing ran, so nothing was spent: the hold goes before the engine
              // hears about it.
              hold.release()
              giveBackHeldReportUps()
              // Gate 2: a start that threw after a Stop or a release is not a
              // failure of whatever task holds the session now.
              const why = refusal()
              if (why) {
                settleRefused(why)
                return
              }
              // A start that tried to resume and threw most likely holds a dead
              // handle, as the drain's self-heal assumes of a failed resumed run:
              // clear it, so the next run starts fresh instead of failing the same way.
              if (resumeHandle !== null && resumePointer) {
                try {
                  setSetting(db, resumePointer.key, '')
                } catch {
                  /* best-effort */
                }
              }
              // Immediate-send failure → the engine fails the task now rather than
              // waiting out the 8-minute watchdog (the nudge un-busies the session).
              settleFailed(e instanceof Error ? e : new Error(String(e)))
              return
            }
            // Gate 3, with no await before abortMap.set: a run refused after it
            // began is aborted and drained silently. Nothing below runs for it, so
            // a refused delivery consumes no inbox rows or cursor.
            const after = refusal()
            if (after) {
              hold.release()
              giveBackHeldReportUps()
              noteMessageNotStarted()
              // A delivery settled early has to tell the engine itself that a Stop
              // ended it.
              if (!settledEarly) started()
              else if (after === 'stopped') void endQueued('stopped')
              await discardRun(adapter, run)
              // A Stop during the discard reset the queue, so the slot is no
              // longer this delivery's to free.
              if (after === 'released' && stopGen() === deliveredGen) {
                nudge.markIdle(targetSessionKey)
              }
              return
            }
            const entry: RunEntry = { adapter, run, stamp, taskId: runTaskId }
            abortMap.set(targetSessionKey, entry)
            // A turn with no task reads the pause itself, now that it is in the map. One
            // placed while it was starting saw nothing to stop, and one placed from here
            // on finds it there. A task run is the engine's, which released it above.
            const pausedInStart = runTaskId === null ? startRefusedBy(db, pauseSubject) : null
            if (pausedInStart) stopRunForPause(entry, pauseStopNote(pausedInStart))
            runStarted = true
            leaveQueue()
            budgetNoticeShown.delete(targetAgentId)
            // An update turn counts toward the jobs it read, now that it has started.
            if (origin.kind === 'system')
              for (const job of origin.countJobs ?? []) {
                try {
                  noteJobRun(db, job)
                } catch (err) {
                  log.error({ err, job }, 'counting an update turn toward its job failed')
                }
              }
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
            settleStarted()
            // A task run can be steered while it works: a person commenting on
            // the task reaches it through the per-task registry (see runSteers).
            const steerHandle =
              runTaskId !== null ? registerRunSteer(runTaskId, adapter, run) : null
            try {
              await drainRun(adapter, run, targetSessionKey, targetAgentId, {
                runtime: resolvedRuntime,
                message,
                contextChars: teamContext ? teamContext.length : 0,
                resumePointer,
                resumeAttempted: resumeHandle != null,
                chatVisible,
                stamp,
                execId: runExecId,
                model: configuredModel,
                releaseRunSlot: () => {
                  runSlot?.release()
                  folderRun?.release()
                },
                hold,
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
          // A person's or a routine's message to a paused agent or team is refused
          // here, with the reason in the chat, rather than left waiting unseen for a
          // resume. Everything else (a fix round, a follow-up, a task update) waits
          // in the queue, whose grant reads the pause, and starts on resume.
          if (origin.kind === 'human' || origin.kind === 'schedule') {
            const paused = startRefusedBy(db, pauseSubject)
            if (paused) {
              const text = pauseRefusalText(paused)
              if (chatVisible) deps.persistMeta?.(targetSessionKey, text)
              failStart(new PausedDeliveryError(text))
              return
            }
          }
          // Task runs only (a leader/user turn has no task row), and it matches this
          // run's own execution, so an older run cannot keep a newer one looking alive.
          const stopBeat =
            runTaskId !== null
              ? startTaskHeartbeat(db, runTaskId, {
                  assigneeAgentId: targetAgentId,
                  execId: runExecId,
                })
              : (): void => undefined
          const runWithSlot = (slot: RunSlot): void => {
            runSlot = slot
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
                // runJob settles the delivery itself; this catch only guards an
                // unexpected throw before/around that so it isn't an unhandled rejection.
                settleFailed(e instanceof Error ? e : new Error(String(e)))
              })
              .finally(() => {
                // Every way out of runJob releases its budget hold itself, before the
                // agent's lock goes; this covers a throw that skipped them.
                runHold?.release()
                folderRun?.release()
                slot.release()
                leaveQueue()
                stopBeat()
              })
          }
          // The slot comes BEFORE the agent's lock (see runSlots), so a delivery
          // waiting for one holds nothing a running agent needs.
          const queuePaused = (): boolean => startRefusedBy(db, pauseSubject) !== null
          const slot = runSlots().tryAcquire(slotKey, queuePaused)
          if (slot) {
            runWithSlot(slot)
            return
          }
          // So does anything else a pause holds back: the engine awaits a task update
          // too, and it must not wait out a pause. It starts on resume all the same.
          if (runTaskId !== null || queuePaused()) {
            settledEarly = true
            started()
          }
          const cancel = new AbortController()
          queuedEntry = {
            cancel: () => cancel.abort(),
            taskId: runTaskId,
            ...(origin.kind === 'system' ? { report: { taskId: queueTaskId, stamp } } : {}),
          }
          queuedRuns.set(targetSessionKey, queuedEntry)
          keepBusy = setInterval(() => {
            if (stopGen() === deliveredGen) nudge.markBusy(targetSessionKey)
          }, QUEUED_KEEPALIVE_MS)
          keepBusy.unref?.()
          runSlots()
            .acquire({
              key: slotKey,
              signal: cancel.signal,
              rank: queueRank,
              paused: queuePaused,
            })
            .then(
              (granted) => runWithSlot(granted),
              () => {
                // Taken out of the queue by a Stop, a teardown or the engine letting
                // go of the task: it never starts.
                leaveQueue()
                stopBeat()
                settleRefused(refusal() ?? 'released')
              },
            )
            .catch((err: unknown) => {
              log.error({ err, sessionKey: targetSessionKey }, 'queued delivery failed to settle')
            })
        }),
      // Queued behind the recipient's run, this delivery already resolved for
      // the engine, so a start that fails now (however it fails, a throw while
      // setting the run up included) never reaches the engine's retry. The
      // report-ups it carries are handed back instead (see `onRunNotStarted`).
      {
        // A person's message goes ahead of what the session has queued.
        ...(origin.kind === 'human' ? { ahead: true } : {}),
        onQueuedFailure: (err) => {
          if (stamp.reportUpIds) deps.onRunNotStarted?.(stamp)
          // A refusal has already put its reason in the chat.
          if (!(err instanceof DeliveryRefusedError)) noteMessageNotStarted()
        },
        // A Stop dropped it from the queue behind the session's run.
        onDropped: noteMessageNotStarted,
      },
    )
  }
}
