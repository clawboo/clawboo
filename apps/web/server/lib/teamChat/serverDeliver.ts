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
  recordSpend,
  setSetting,
  updateTaskFields,
  type ClawbooDb,
} from '@clawboo/db'
import {
  resolveRuntimeIntegration,
  type RunHandle,
  type RuntimeAdapter,
  type RuntimeEvent,
} from '@clawboo/executor'
import { usdToFractionalCents } from '@clawboo/governance'
import { classifyError, isHarnessBug } from '@clawboo/obs'
import { isTeamSessionKey, type NudgeQueue } from '@clawboo/team-orchestration'
import { eq } from 'drizzle-orm'

import { getRegistry } from '../agentSource/registry'
import { homeDispatchMutex } from '../executorRunner'
import { emitEvent } from '../obs'
import { connectedAgentKey, connectedAgentMutex } from '../routines/openclawDispatch'
import { adapterFactoryFor } from '../runtimes'
import { getDescriptor, isRuntimeId } from '../runtimes/descriptor'
import { estimateRunCostUsd } from '../runtimes/estimateCost'
import { runtimeIdentityHomePath } from '../runtimes/identityHome'
import { buildOpenClawServerAdapter } from '../runtimes/serverAdapter'
import type { RuntimeRunContext } from '../runtimes/types'
import { resolveRuntimeKey } from '../secretsVault'
import { buildServerTeamContext } from './contextPreamble'
import { nativeTeamSessionSettingKey, teamResumeEligible } from './nativeTeamSession'

/** The native `delegate` tool name (mirrors the engine's `DELEGATE_TOOL_NAME_RE`;
 *  disjoint from `sessions_send`). A leader turn that calls it is a delegation turn
 *  whose text is a premature "handed off, they're working on it" ack — the delegation
 *  itself IS the board cards, so that turn is suppressed from chat (like the OpenClaw
 *  leader's `<delegate>` XML turn, which is filtered client-side). */
const DELEGATE_TOOL_RE = /(?:^|[._])delegate(?:[._]|$)/i

/** clawboo's own in-process runtime — the only one that uses the native leader
 *  session-resume pointer (mirrors driveAgentChat's native-only 1:1 continuity). */
const NATIVE_RUNTIME = 'clawboo-native'

/** A live run tracked for Stop / wedge — keyed by sessionKey in the abort map. */
export interface RunEntry {
  adapter: RuntimeAdapter
  run: RunHandle
}

export interface ServerDeliverDeps {
  db: ClawbooDb
  teamId: string
  mcpBaseUrl: string | null
  nudge: NudgeQueue
  /** sessionKey → live run, so `stop()` / the wedge can abort it. Populated here
   *  (in the send closure) and evicted in `drainRun` on the run's terminal. */
  abortMap: Map<string, RunEntry>
  /** The engine's event sink — the orchestrator's `onEvent`. */
  onEvent: (sessionKey: string, event: RuntimeEvent) => Promise<void>
  /** The engine's `onSessionClosed` — called when a drain ends without a terminal. */
  onSessionClosed: (sessionKey: string) => Promise<void>
  /** The engine's `taskForSession` — used to attribute a delegated run's mission spend. */
  taskForSession: (sessionKey: string) => string | null
  /** Persist a run's terminal turn text for chat-history observability (a seed for
   *  the unified writer). Optional — omitted in tests that only assert the wiring. */
  persistTurn?: (sessionKey: string, text: string) => void
  /** Tier-2 live-token hook: publish a run's FULL running assistant text on each
   *  streamed delta (the team-chat SSE's ephemeral channel). `text` is the running
   *  accumulation, NOT the chunk — it matches the client store's REPLACE semantics.
   *  Optional + fire-and-forget; the committed turn (`persistTurn` on `done`) is the
   *  durable source of truth, so a missing/throwing hook never affects the drain. */
  publishDelta?: (sessionKey: string, runId: string | null, text: string) => void
  /** TEST-ONLY seam: build the adapter for an agent directly, bypassing the DB
   *  runtime lookup + the real driver factory + the home mutex. Production OMITS
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
    const key = resolveRuntimeKey(v)
    if (key) env[v] = key
  }
  return env
}

/** Parse a coding-runtime agent's execConfig for an optional per-agent model +
 *  provider (the Hermes model picker stores `{ model, provider }`). Never throws;
 *  returns null when absent so the driver keeps its key-derived default. */
function parseCodingModelConfig(raw: string | null): { model?: string; provider?: string } | null {
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
function missionRootId(db: ClawbooDb, taskId: string): string {
  const ancestors = getAncestors(db, taskId)
  if (ancestors.length === 0) return taskId
  return ancestors.find((a) => a.parent_task_id == null)?.id ?? taskId
}

/** Build the engine's `deliver(targetSessionKey, targetAgentId, message)`. */
export function createServerDeliver(deps: ServerDeliverDeps) {
  const { db, teamId, mcpBaseUrl, nudge, abortMap, onEvent, onSessionClosed, taskForSession } = deps
  const persistTurn = deps.persistTurn
  const publishDelta = deps.publishDelta
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
  function emitRunObs(sessionKey: string, agentId: string, runtime: string | null, ev: RuntimeEvent): void {
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
      /** The native leader session-resume pointer key to update on the terminal, or
       *  null when this run is not an eligible native leader/user-facing team turn. */
      resumePointerKey: string | null
    },
  ): Promise<void> {
    let sawTerminal = false
    // Tier-2 live tokens: accumulate the run's user-visible assistant text and
    // publish the RUNNING total on each delta (matches the client store's REPLACE
    // semantics). The committed turn (persistTurn on `done`) stays the source of
    // truth; this is the ephemeral "type it out live" channel.
    let acc = ''
    // The run's total cost (USD), accumulated for BOTH the budget ledger AND the task
    // (board card / drawer). Native sums its real `cost` events here; a runtime that
    // reports no USD (OpenClaw's Gateway, Codex, Hermes) gets a char-based ESTIMATE on
    // the terminal (only when nothing real was summed) so the card + cap aren't stuck at
    // $0. Written to the task via updateTaskFields on the terminal below.
    let runCostUsd = 0
    // Is this run a DELEGATED-CHILD board task, or a leader / user-facing turn? The
    // engine sets `sessionToTask` BEFORE it calls deliver, so the mapping is present
    // for the whole drain (completeForSession, which forgets it, runs on the terminal
    // AFTER this loop). A delegated child neither STREAMS nor COMMITS into the chat
    // timeline — its progress + output live on its BoardTaskCard. Only a leader /
    // user-facing turn (no task) belongs in chat. Capturing once avoids a per-delta
    // Map.get and keeps the two gates below consistent.
    const runTaskId = taskForSession(sessionKey)
    const isTaskRun = runTaskId != null
    // A LEADER turn that DELEGATES (calls the `delegate` tool) must not surface its
    // text in chat either: the delegation IS the board cards, and the leader's
    // "handed off, they're working on it" narration is premature noise. (The OpenClaw
    // leader's `<delegate>` XML delegation turn is filtered client-side for the same
    // reason; native's is prose, so it's suppressed here.) Flips true on the first
    // `delegate` tool-call; the leader's LATER synthesis turn — the one it runs when it
    // reacts to the `[Task Update]`, which makes NO delegate call — still shows.
    let delegatedThisTurn = false
    const chatVisible = (): boolean => !isTaskRun && !delegatedThisTurn
    try {
      for await (const ev of adapter.events(run) as AsyncIterable<RuntimeEvent>) {
        if (ev.kind === 'tool-call' && !ev.partial && DELEGATE_TOOL_RE.test(ev.name))
          delegatedThisTurn = true
        if (ev.kind === 'text-delta' && ev.channel !== 'reasoning') {
          // Tolerate BOTH delta conventions so the running text is never garbled:
          // native emits INCREMENTAL chunks, but the OpenClaw adapter emits CUMULATIVE
          // deltas (each frame carries the full text so far). If the new text extends
          // the running text, REPLACE (cumulative); otherwise APPEND (incremental).
          // Without this, a cumulative delta was `+=`-accumulated into garbled repeated
          // text ("We plantWe plantWe plant data seeds…").
          acc = acc && ev.text.startsWith(acc) ? ev.text : acc + ev.text
          // Stream live tokens to the group chat ONLY for a chat-visible turn (a leader /
          // user-facing NON-delegation turn). A delegated child or a delegation turn must
          // NOT stream: its committed turn is suppressed (below), so a lingering
          // StreamingCard would never be cleared and would stick on screen.
          if (chatVisible()) publishDelta?.(sessionKey, ev.runId, acc)
        }
        if (ev.kind === 'cost' && ev.costUsd != null && ev.costUsd > 0) {
          // Real per-turn USD (native): sum it for the task ledger, then run the budget
          // kill-switch — a paused CAP budget aborts the run; the resulting `done:aborted`
          // flows through this same loop (the engine fails the task).
          runCostUsd += ev.costUsd
          if (recordSpendForRun(sessionKey, agentId, ev.costUsd))
            await adapter.abort(run).catch(() => undefined)
        }
        if (ev.kind === 'done') {
          // A DELEGATED-CHILD task turn (report-up on its BoardTaskCard) AND a leader
          // DELEGATION turn (the premature "handed off" ack — the delegation shows as
          // the board cards) are both kept OUT of the chat timeline. Only a chat-visible
          // turn — a leader / user-facing NON-delegation turn, e.g. the synthesis it runs
          // after the `[Task Update]` — commits. Same gate as the streaming channel, so a
          // suppressed turn neither streams nor commits.
          if (ev.summary && chatVisible()) persistTurn?.(sessionKey, ev.summary)
          // Cost fallback for a runtime that reports no USD (OpenClaw's Gateway, Codex,
          // Hermes): a char-based ESTIMATE so the task ledger + budget cap aren't stuck
          // at $0. Only when nothing real was summed (native already has runCostUsd > 0).
          if (runCostUsd === 0) {
            const usd = estimateRunCostUsd({
              model: null,
              inputChars: obs.contextChars + obs.message.length,
              outputChars: ev.summary?.length ?? 0,
            })
            if (usd > 0) {
              runCostUsd += usd
              // The run is already at its terminal — no run to abort even if this pauses.
              recordSpendForRun(sessionKey, agentId, usd)
            }
          }
          // Leader continuity: persist THIS turn's harness session id so the NEXT team
          // turn resumes it. Done HERE (on the terminal, BEFORE markIdle) so the next
          // queued delivery — which the nudge flushes on markIdle and which reads the
          // pointer to build ctx.resume — sees the FRESH id. Doing it after the drain
          // would race: a rapidly-sent message 2 would read the stale pointer and resume
          // message 0's transcript, dropping this turn. The harness already awaited
          // saveSessionTranscript before emitting `done`, so the session file exists.
          // Non-null resumePointerKey ⇒ an eligible native leader / user-facing team turn.
          if (obs.resumePointerKey && adapter.sessionCodec) {
            try {
              const blob = await adapter.sessionCodec.serialize(run)
              const sid = (JSON.parse(blob) as { sessionId?: string | null }).sessionId
              if (sid) setSetting(db, obs.resumePointerKey, sid)
            } catch {
              // A missing/unparseable id just means the next turn starts fresh.
            }
          }
        }
        // Per-tool runtime detail → the obs activity terminal (all runtimes).
        emitRunObs(sessionKey, agentId, obs.runtime, ev)
        const terminal = ev.kind === 'done' || (ev.kind === 'error' && ev.fatal)
        if (terminal) {
          nudge.markIdle(sessionKey)
          // Persist the run's cost + REAL runtime onto its task so the board card +
          // drawer show them: the engine creates the task at cost 0 with a hardcoded
          // `assigneeRuntime: 'openclaw'`, and nothing else writes them. Delegated-child
          // task runs only; best-effort — a ledger write must never break the drain.
          if (runTaskId) {
            try {
              updateTaskFields(db, runTaskId, {
                costUsd: runCostUsd,
                ...(obs.runtime ? { assigneeRuntime: obs.runtime } : {}),
              })
            } catch {
              /* non-fatal */
            }
          }
        } else nudge.markBusy(sessionKey)
        try {
          await onEvent(sessionKey, ev)
        } catch {
          // A single bad event must not kill the observer.
        }
        if (terminal) {
          sawTerminal = true
          abortMap.delete(sessionKey)
          break
        }
      }
    } catch {
      // Stream / observer error — fall through to the no-terminal cleanup.
    }
    if (!sawTerminal) {
      // The stream ended WITHOUT a terminal (connection drop / error): free the
      // session and tell the engine its observer ended, so it fails the in-flight
      // delegation instead of leaving the leader waiting on a dead observer.
      abortMap.delete(sessionKey)
      nudge.markIdle(sessionKey)
      try {
        await onSessionClosed(sessionKey)
      } catch {
        // best-effort
      }
    }
  }

  return function deliver(
    targetSessionKey: string,
    targetAgentId: string,
    message: string,
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
    // Volatile-tier team context: rules + the user's self-intro + the live roster
    // (the single choke point covers the user's leader turn AND every delegated
    // child turn). See `contextPreamble.ts`. A leader / user-facing turn (no board
    // task) also gets the native-leader behavioral coordination block; a delegated
    // child (isTaskRun) is a worker turn and does not.
    const teamContext = isTeamSessionKey(targetSessionKey)
      ? buildServerTeamContext(db, teamId, targetAgentId, !isTaskRun)
      : null
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

          let adapter: RuntimeAdapter
          let homeKind = 'ephemeral'
          let homeDir: string | null = null
          if (makeAdapterForAgent) {
            // Test path: the adapter is injected; the home mutex is bypassed. The
            // connected mutex still engages when a seeded row + a connected-caps adapter
            // opt in (so the connected serialize/cost/obs path is unit-testable).
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
          } else {
            const runtime = resolvedRuntime
            // native + the coding runtimes (claude-code / codex / hermes) via
            // `isRuntimeId`, PLUS OpenClaw (the connected substrate, converged here).
            // A truly-unknown runtime fails cleanly so the engine reflects it.
            if (!runtime || (!isRuntimeId(runtime) && runtime !== 'openclaw')) {
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
              // team session — a delegated child (isTaskRun) is excluded. Mirrors
              // driveAgentChat, but keyed per-(agent, team) to avoid Boo-Zero cross-team
              // / 1:1 collision (see nativeTeamSession.ts).
              const teamResumeId = teamResumeEligible({
                runtime,
                homeDir,
                isTeamSession: isTeamSessionKey(targetSessionKey),
                isTaskRun,
              })
                ? getSetting(db, nativeTeamSessionSettingKey(targetAgentId, teamId)) || null
                : null
              // A coding runtime (hermes/codex/claude-code) may carry a per-agent
              // model + provider chosen at team creation, stored on the row's
              // execConfig (`{ model, provider }` — the Hermes model picker). Thread
              // it in so the driver runs that exact model on that provider. Native
              // reads its OWN config (no top-level `model`), so scope to non-native.
              const codingModel =
                runtime !== NATIVE_RUNTIME ? parseCodingModelConfig(row?.execConfig ?? null) : null
              const ctx: RuntimeRunContext = {
                model: codingModel?.model ?? null,
                ...(codingModel?.provider ? { providerHint: codingModel.provider } : {}),
                resume: teamResumeId,
                mcpBaseUrl,
                memoryScope: { teamId, agentId: targetAgentId },
                ...(homeDir ? { homeDir } : {}),
                ...(Object.keys(apiKeyEnv).length ? { apiKeyEnv } : {}),
              }
              adapter = factory(ctx)
            }
          }
          // const so TS narrows them cleanly inside the closures below.
          const capturedHomeDir = homeDir
          // The native leader session-resume pointer to update on the terminal (the
          // amnesia fix) — non-null ONLY for an eligible native leader / user-facing team
          // turn (a delegated child keeps its own executor-handoff continuity). Threaded
          // into the drain so the write lands BEFORE markIdle, closing the rapid-message
          // race (see drainRun's `done` handler). Read side is ctx.resume above.
          const resumePointerKey = teamResumeEligible({
            runtime: resolvedRuntime,
            homeDir: capturedHomeDir,
            isTeamSession: isTeamSessionKey(targetSessionKey),
            isTaskRun,
          })
            ? nativeTeamSessionSettingKey(targetAgentId, teamId)
            : null
          // A connected substrate serializes on the SHARED per-gateway-agent mutex —
          // cross-subsystem (routines / runTeamExchange / other teams' orchestrators)
          // AND Boo-Zero-in-N-teams (the one OpenClaw agent that spans teams).
          const connectedKey = homeKind === 'connected' && row ? connectedAgentKey(row) : null

          const runJob = async (): Promise<void> => {
            if (capturedHomeDir)
              await mkdir(capturedHomeDir, { recursive: true, mode: 0o700 }).catch(() => undefined)
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
              // Immediate-send failure → the engine fails the task now rather than
              // waiting out the 8-minute watchdog (the nudge un-busies the session).
              failStart(e instanceof Error ? e : new Error(String(e)))
              return
            }
            abortMap.set(targetSessionKey, { adapter, run })
            // `deliver` resolves HERE — after start, BEFORE the drain — so the
            // engine's `await deps.deliver` doesn't serialize the cascade. The home /
            // connected mutex (when held) stays held for the WHOLE drain below.
            started()
            await drainRun(adapter, run, targetSessionKey, targetAgentId, {
              runtime: resolvedRuntime,
              message,
              contextChars: teamContext ? teamContext.length : 0,
              resumePointerKey,
            })
          }

          // A connected substrate (OpenClaw) serializes on the connected mutex; a
          // persistent-home runtime (native) on the home mutex — held across the whole
          // drain so a concurrent executor run / routine / heartbeat for the same
          // (runtime, agent) can't overlap its session / native state.db. The nudge
          // alone only knows THIS orchestrator's sessions. The two are mutually
          // exclusive (connected has no homeDir; persistent is not connected).
          const job = connectedKey
            ? () => connectedAgentMutex.run(connectedKey, runJob)
            : capturedHomeDir
              ? () => homeDispatchMutex.run(capturedHomeDir, runJob)
              : runJob
          void job().catch((e: unknown) => {
            // runJob settles `started`/`failStart` itself; this catch only guards an
            // unexpected throw before/around that so it isn't an unhandled rejection.
            failStart(e instanceof Error ? e : new Error(String(e)))
          })
        }),
    )
  }
}
