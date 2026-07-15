// Event-driven board orchestration core (pure, testable — no React).
//
// The chat-fused board engine. Structured delegation signals are read from TYPED
// lifecycle events (a `sessions_send` tool-call, or `<delegate>` / `<plan>`
// directives parsed once from a terminal `done` summary) and turned into durable
// board mutations. The board is CANONICAL; the three fusion mechanisms:
//   • DERIVE   chat → board: a delegation creates + claims a task.
//   • ROUND-TRIP result → board: a child `done` writes the report-up summary +
//     status to the board (never the transcript).
//   • REFLECT  board → chat: completed tasks are batched into one `[Task Update]`
//     delivered to the LEADER (single reduce point) so it synthesizes.
// Plans are durable `task_deps` chains; the ready-pump fires the next task when
// its blocker completes (= auto-unblock). Enforced in code, not prompts: bounded
// spawn depth (board ancestor chain), report-up summaries, a child tool blocklist,
// and a single reduce point. The NL-fallback / fan-out prose patterns are NOT
// used (fan-out = ≥2 structured delegations → N parallel tasks).

import type { RuntimeEvent } from '@clawboo/executor'
import { checkFanoutCap } from '@clawboo/governance'

import type { BoardClient, BoardTask, CompleteExecutionOutcome } from './boardClient'
import { buildTaskUpdateMessage, type TaskUpdateOutcome } from './taskUpdate'

import {
  parseStructuredDelegations,
  findPlanBlocks,
  resolveSessionsSendTarget,
  detectDelegationIntent,
  type SessionsSendParams,
} from './delegationTags'

/**
 * A source task at this ancestor-depth (or deeper) may not spawn children —
 * bounds recursion at a finite, small fan-out tree. Leader/user-initiated turns
 * have no source task (depth 0) and may always delegate.
 */
export const MAX_SPAWN_DEPTH = 2

/** Debounce window for batching board→chat reflections (avoids message storms). */
export const REFLECT_WINDOW_MS = 3000

/**
 * A delegated child that emits NO lifecycle event for this long is treated as
 * hung — its task is failed and the leader is told (so it is never "left
 * standing"). Refreshed on every observed event, so a slow-but-working agent
 * (which keeps streaming deltas / tool calls) never trips it. Generous on
 * purpose; the in-chat analog of the routine dispatcher's
 * `CLAWBOO_ROUTINE_OPENCLAW_TIMEOUT_MS` watchdog.
 */
export const DELEGATION_IDLE_TIMEOUT_MS = 8 * 60_000

/**
 * Consecutive failures of the SAME (target, task) after which re-delegation is
 * refused in CODE — a loop breaker independent of the model's own judgement, so a
 * failure→reflect→re-delegate cycle to a persistently-failing target can't drip
 * forever (the in-browser team-chat path has no executor circuit-breaker).
 */
export const MAX_DELEGATION_FAILURES = 3

/** A child terminated this recently — a late replay on its (now-unmapped) session
 *  must NOT be treated as a fresh depth-0 delegation (orphan-spawn guard). Covers
 *  the window between a premature watchdog/close and the delegate's real terminal. */
const RECENTLY_TERMINATED_TTL_MS = 60_000

/** Max times a reflection's delivery is retried (a transient chat.send rejection)
 *  before the recipient is told via a terminal narration. Bounded → loop-safe. */
const MAX_REFLECT_ATTEMPTS = 3

/** Age after which a dedupe / recently-terminated entry is reaped (bounds memory
 *  on a long-lived team-chat orchestrator; comfortably past any run window). */
const PROCESSED_TTL_MS = 2 * DELEGATION_IDLE_TIMEOUT_MS

/** Why a delegated child failed — the comment + reflection prefix. */
type FailReason = Extract<TaskUpdateOutcome, 'error' | 'aborted' | 'max_turns' | 'timeout'>

const FAIL_REASON_LABEL: Record<FailReason, string> = {
  error: 'Run failed',
  aborted: 'Run stopped before finishing',
  max_turns: 'Ran out of room before finishing',
  timeout: 'Went silent (timed out with no response)',
}

const FAIL_EXEC_STATUS: Record<FailReason, CompleteExecutionOutcome['status']> = {
  error: 'failed',
  aborted: 'cancelled',
  max_turns: 'failed',
  timeout: 'timed_out',
}

export interface KnownAgent {
  id: string
  name: string
}

export interface DelegationSignal {
  targetAgentId: string
  targetAgentName: string
  task: string
}

export interface ExtractedSignals {
  /** Independent delegations — fire all immediately (fan-out = length ≥ 2). */
  parallel: DelegationSignal[]
  /** Ordered plan steps — durable dep chain; the ready-pump fires the next. */
  plan: DelegationSignal[]
}

/**
 * A board mutation the orchestrator made, fed to the projection store + (for
 * `done`) the reflection batcher. Carries whatever fields the orchestrator knows
 * at the call-site; the store merges by id (last-write-wins on `updatedAt`).
 */
export interface BoardChange {
  id: string
  title?: string
  status?: string
  assigneeAgentId?: string | null
  parentTaskId?: string | null
  createdAt?: number
  updatedAt?: number
  /** Report-up summary recorded on done (shown on the projection card). */
  summary?: string
}

const EMPTY: ExtractedSignals = { parallel: [], plan: [] }
const SESSIONS_SEND_NAME_RE = /sessions[._]send/i
// A structured `delegate` tool-call — the native runtime's team-delegation signal
// (its analog of `sessions_send`, which is OpenClaw-specific). The engine observes
// it exactly like `sessions_send`; the tool itself writes nothing. `[._]` (not `\b`,
// which treats `_` as a word char) anchors it so a namespaced `team_delegate` /
// `delegate_task` also matches while prose / unrelated tools do not. Disjoint from
// `SESSIONS_SEND_NAME_RE`, so the two tool-call branches never double-fire.
const DELEGATE_TOOL_NAME_RE = /(?:^|[._])delegate(?:[._]|$)/i

/** Build SessionsSendParams from a structured tool-call input object. */
function paramsFromToolInput(input: unknown): SessionsSendParams | null {
  if (!input || typeof input !== 'object') return null
  const o = input as Record<string, unknown>
  const message = typeof o['message'] === 'string' ? o['message'].trim() : ''
  if (!message) return null
  const params: SessionsSendParams = { message }
  if (typeof o['sessionKey'] === 'string') params.sessionKey = o['sessionKey']
  if (typeof o['label'] === 'string') params.label = o['label']
  if (typeof o['agentId'] === 'string') params.agentId = o['agentId']
  // tolerate a `targetAgentId` alias for the direct id
  if (!params.agentId && typeof o['targetAgentId'] === 'string') params.agentId = o['targetAgentId']
  return params
}

/**
 * Build SessionsSendParams from a `delegate` tool-call input `{ assignee, task }`
 * (tolerating `target`/`to` for the teammate name and `message` for the body).
 * The name resolves against the roster via `resolveSessionsSendTarget`'s label
 * path. Returns null when the task body is empty (mirrors the non-empty-message
 * guard above) so a malformed call yields no signal.
 */
function paramsFromDelegateInput(input: unknown): SessionsSendParams | null {
  if (!input || typeof input !== 'object') return null
  const o = input as Record<string, unknown>
  const task =
    (typeof o['task'] === 'string' && o['task'].trim()) ||
    (typeof o['message'] === 'string' && o['message'].trim()) ||
    ''
  if (!task) return null
  const label =
    (typeof o['assignee'] === 'string' && o['assignee']) ||
    (typeof o['target'] === 'string' && o['target']) ||
    (typeof o['to'] === 'string' && o['to']) ||
    ''
  const params: SessionsSendParams = { message: task }
  if (label) params.label = label
  // Tolerate a direct agent id if the model passes one instead of a name.
  if (typeof o['agentId'] === 'string') params.agentId = o['agentId']
  return params
}

/**
 * Read structured delegation signals from a single typed event. NO prose
 * scraping: only a `sessions_send` tool-call (primary) or `<delegate>` / `<plan>`
 * directives in a terminal `done` summary (the structured-output contract).
 */
export function extractSignals(
  event: RuntimeEvent,
  sourceAgentId: string,
  known: KnownAgent[],
): ExtractedSignals {
  if (event.kind === 'tool-call' && SESSIONS_SEND_NAME_RE.test(event.name)) {
    const params = paramsFromToolInput(event.input)
    if (!params) return EMPTY
    const target = resolveSessionsSendTarget(params, known)
    if (!target || target.id === sourceAgentId) return EMPTY
    return {
      parallel: [{ targetAgentId: target.id, targetAgentName: target.name, task: params.message }],
      plan: [],
    }
  }

  // A native `delegate` tool-call — the trusted, engine-observed delegation signal
  // for native (and any future MCP-`delegate`) runtimes. Same contract as the
  // sessions_send branch: resolve the target against the roster, skip self /
  // unknown, and turn it into one parallel delegation the engine spawns.
  if (event.kind === 'tool-call' && DELEGATE_TOOL_NAME_RE.test(event.name)) {
    const params = paramsFromDelegateInput(event.input)
    if (!params) return EMPTY
    const target = resolveSessionsSendTarget(params, known)
    if (!target || target.id === sourceAgentId) return EMPTY
    return {
      parallel: [{ targetAgentId: target.id, targetAgentName: target.name, task: params.message }],
      plan: [],
    }
  }

  if (event.kind === 'done' && event.summary) {
    const planBlocks = findPlanBlocks(event.summary)
    if (planBlocks.length > 0) {
      const steps: DelegationSignal[] = []
      for (const block of planBlocks) {
        for (const step of block.steps) {
          const target = resolveSessionsSendTarget(
            { label: step.targetName, message: step.task },
            known,
          )
          if (target && target.id !== sourceAgentId)
            steps.push({ targetAgentId: target.id, targetAgentName: target.name, task: step.task })
        }
      }
      return { parallel: [], plan: steps }
    }
    const intents = parseStructuredDelegations(event.summary, sourceAgentId, known)
    return {
      parallel: intents.map((d) => ({
        targetAgentId: d.targetAgentId,
        targetAgentName: d.targetAgentName,
        task: d.taskDescription,
      })),
      plan: [],
    }
  }

  return EMPTY
}

export interface BoardOrchestratorDeps {
  teamId: string
  board: BoardClient
  /** Current participant roster (read fresh each event so adds/removes flow through). */
  known: () => KnownAgent[]
  /** The team's reduce point — reflections are delivered here for synthesis. */
  leaderAgentId: () => string | null
  /** Resolve a participant's team-scoped sessionKey. */
  sessionKeyForAgent: (agentId: string) => string | null
  /** Recover the agentId that owns a sessionKey. */
  agentIdForSession: (sessionKey: string) => string | null
  /** Deliver a message to a session (nudge-queued adapter.start under the hood). */
  deliver: (targetSessionKey: string, targetAgentId: string, task: string) => Promise<void>
  /** Monotonic stop generation; in-flight work bails when it changes. */
  stopGen: () => number
  /** A board mutation the orchestrator made (projection-store feed). Optional. */
  onBoardChange?: (change: BoardChange) => void
  /** Append a visible narration entry to a session's transcript. Optional. */
  narrate?: (sessionKey: string, text: string) => void
  /**
   * Compact a child's report-up summary before it becomes a board comment /
   * `[Task Update]`. Pass-through-safe + failure-preserving.
   * Optional — when omitted the summary is used verbatim.
   */
  compact?: (text: string) => string
  /**
   * Orchestrator-boundary caps enforced in code below the model.
   * `maxFanout` bounds how many parallel delegations ONE turn may spawn. Optional —
   * omitted ⇒ no cap. Per-node cost + delegation DEPTH are
   * enforced elsewhere (the executor runner's cost loop / `spawn`'s ancestor check).
   */
  caps?: { maxFanout?: number }
  /** Audit hook for a cap hit (the wiring logs a governance_audit row). Optional. */
  onCapHit?: (info: { kind: 'fanout'; sourceTaskId: string | null }) => void
  /** Heuristic: is this delegation risky enough to need leader approval? Optional. */
  isRiskyDelegation?: (signal: DelegationSignal) => boolean
  /**
   * Surface a risky delegation on the LEADER's approval queue and await the
   * resolution (the server reuses the DB-mediated `tool_call_approvals` handshake;
   * its TTL + poll-deadline give the timeout-not-deadlock guarantee, and a sticky
   * `allow_always` for the scope skips the prompt). Optional — omitted ⇒ delegations
   * are never gated.
   */
  requestDelegationApproval?: (input: {
    leaderAgentId: string
    targetAgentId: string
    targetAgentName: string
    task: string
  }) => Promise<'allow_once' | 'allow_always' | 'deny' | 'expired' | 'timeout'>
  /** Injectable clock for the idle watchdog (tests). Defaults to `Date.now`. */
  now?: () => number
}

export interface BoardOrchestrator {
  /** Feed one normalized event observed on `sessionKey`. */
  onEvent(sessionKey: string, event: RuntimeEvent): Promise<void>
  /** The board task a session is currently executing, if any (for obs correlation). */
  taskForSession(sessionKey: string): string | null
  /**
   * Fail any delegated child that has emitted no lifecycle event for longer than
   * `DELEGATION_IDLE_TIMEOUT_MS` — reflects the timeout to the leader so it is
   * never left standing. Driven by an interval in the server orchestrator
   * (`teamOrchestrator`); the contract suite drives it directly.
   */
  sweepStaleSessions(): Promise<void>
  /**
   * A session's observer ended (connection drop / teardown of one session) while
   * a delegation was still in flight — fail it so the leader learns.
   */
  onSessionClosed(sessionKey: string): Promise<void>
  /**
   * Re-attach to durable in-flight work on (re)mount: track `in_progress` tasks
   * so their completions/timeouts are still handled, and fire any plan step left
   * ready (so a refresh / team re-open resumes a stalled plan).
   */
  resume(): Promise<void>
  /** Drop all in-memory tracking + timers (team switch / teardown). */
  reset(): void
}

/**
 * Create a per-team orchestrator. Holds the minimal in-memory maps needed to
 * (a) map a child's completion back to its task, (b) record the execution
 * ledger, (c) fire dep-ready plan steps to their stored target, (d) dedupe
 * re-observed delegations, and (e) batch board→chat reflections.
 */
export function createBoardOrchestrator(deps: BoardOrchestratorDeps): BoardOrchestrator {
  const sessionToTask = new Map<string, string>() // child session → its task id
  const sessionStartGen = new Map<string, number>() // child session → stopGen at delegation (Stop-vs-abort)
  const taskToExec = new Map<string, string>() // task id → execution id
  const taskTitle = new Map<string, string>() // task id → title (reflection context)
  const taskReflectTo = new Map<string, string>() // task id → the delegator to report back to (reduce-point)
  const pendingTargets = new Map<string, string>() // dep'd / deferred task id → its target agentId (await-ready)
  const processed = new Map<string, number>() // dedupe key → insertion ts (age-reaped; bounds memory)
  const intentMissed = new Map<string, number>() // "didn't parse" nudge key (run:source) → ts (age-reaped)
  const lastActivityAt = new Map<string, number>() // child session → last event ts (watchdog)
  const recentlyTerminated = new Map<string, number>() // child session → terminal ts (late-replay guard)
  const failureCounts = new Map<string, number>() // `${target}:${task}` → consecutive failures (loop breaker)

  // Reflection batch state — closure-owned so reset() collects it (no leak).
  // `toAgentId` is the recipient: a sub-task reports to its IMMEDIATE delegator
  // (so a mid-chain delegator isn't left standing); a top-level task reports to
  // the leader. `null` ⇒ resolve to the leader at flush time.
  const reflectQueue: Array<{
    toAgentId: string | null
    by: string
    title?: string
    summary: string
    outcome?: TaskUpdateOutcome
    /** Delivery-retry counter (bounded by MAX_REFLECT_ATTEMPTS). */
    attempts?: number
  }> = []
  let reflectTimer: ReturnType<typeof setTimeout> | null = null

  const now = deps.now ?? (() => Date.now())
  const emit = (change: BoardChange): void => deps.onBoardChange?.(change)

  /** Who a task's result reports back to: its delegator (reduce-point), else the leader. */
  const reflectTargetFor = (taskId: string | null): string | null =>
    (taskId ? taskReflectTo.get(taskId) : null) ?? deps.leaderAgentId()

  /** Name of an agent (for the reflection header), or a neutral fallback. */
  const nameOf = (agentId: string | null): string =>
    (agentId && deps.known().find((a) => a.id === agentId)?.name) || 'A teammate'

  async function depthOf(taskId: string | null): Promise<number> {
    if (!taskId) return 0
    const detail = await deps.board.getTask(taskId)
    return detail ? detail.ancestors.length : 0
  }

  // ── sourceDelegationId codec ────────────────────────────────────────────────
  // The durable task carries its target agent (for pump-firing a deferred / plan
  // step after a refresh) and its delegator (the reduce-point recipient, recovered
  // by `resume` so a mid-chain delegator isn't re-routed to the leader). Segments
  // use `:agent:`/`:reflectTo:` markers; agent ids + run ids never contain a colon,
  // so `[^:]+` decodes each unambiguously (and an OLD `:agent:`-only sdid still
  // decodes its agent). Only `:agent:`-bearing tasks are pump-fireable — a plain
  // delegation (delivered once at spawn) deliberately omits it so a stop/server
  // release never re-fires it.
  const sdidAgent = (sdid: string): string | null => sdid.match(/:agent:([^:]+)/)?.[1] ?? null
  const sdidReflectTo = (sdid: string): string | null =>
    sdid.match(/:reflectTo:([^:]+)/)?.[1] ?? null
  const encodeSdid = (
    runId: string,
    opts: { agentId?: string; reflectTo: string | null },
  ): string =>
    `${runId}:deleg` +
    (opts.agentId ? `:agent:${opts.agentId}` : '') +
    `:reflectTo:${opts.reflectTo ?? ''}`

  // ── failure loop breaker ────────────────────────────────────────────────────
  const failKey = (targetAgentId: string, task: string): string =>
    `${targetAgentId}:${task.slice(0, 80).toLowerCase().trim()}`
  const noteFailure = (targetAgentId: string, task: string): void => {
    const k = failKey(targetAgentId, task)
    failureCounts.set(k, (failureCounts.get(k) ?? 0) + 1)
  }
  const clearFailure = (targetAgentId: string, task: string): void => {
    failureCounts.delete(failKey(targetAgentId, task))
  }

  /** Did the user press Stop since this delegation was dispatched? (Stop = clean
   *  pause, never a chain-destroying failure.) */
  const stopChangedFor = (sessionKey: string): boolean =>
    sessionStartGen.has(sessionKey) && sessionStartGen.get(sessionKey) !== deps.stopGen()

  /** Drop all in-memory tracking for a session's current task. */
  const forgetSession = (sessionKey: string): void => {
    sessionToTask.delete(sessionKey)
    sessionStartGen.delete(sessionKey)
    lastActivityAt.delete(sessionKey)
    recentlyTerminated.set(sessionKey, now())
  }

  /** Release a claimed task back to `todo` and detach its session — the clean
   *  "Stop / re-queue" path: no `blocked`, no cancelDependents, no failure
   *  reflection (those are for a genuine failure, not a user pause). */
  async function releaseClaimed(taskId: string, sessionKey: string): Promise<void> {
    forgetSession(sessionKey)
    const execId = taskToExec.get(taskId)
    if (execId) {
      taskToExec.delete(taskId)
      await deps.board.completeExecution(execId, { status: 'cancelled' })
    }
    taskReflectTo.delete(taskId)
    taskTitle.delete(taskId)
    await deps.board.updateStatus(taskId, 'todo')
    emit({ id: taskId, status: 'todo', assigneeAgentId: null, updatedAt: now() })
  }

  /** Release whatever task a session is running (no-op if untracked). */
  async function releaseForSession(sessionKey: string): Promise<void> {
    const taskId = sessionToTask.get(sessionKey)
    if (taskId) await releaseClaimed(taskId, sessionKey)
  }

  /** Create + claim + open-execution + deliver a single immediate delegation.
   *  `delegatorAgentId` is who tried to delegate (the reduce-point recipient for
   *  this child's result, and the one told if the delegation can't be started). */
  async function spawn(
    signal: DelegationSignal,
    sourceTaskId: string | null,
    delegatorAgentId: string | null,
    runId: string,
  ): Promise<string | null> {
    const startGen = deps.stopGen()
    // Tell the delegator (not silently drop) whenever a delegation can't start —
    // otherwise it waits forever for an answer that will never come.
    const dropReflect = (summary: string): void =>
      enqueueReflection({
        toAgentId: delegatorAgentId ?? deps.leaderAgentId(),
        by: signal.targetAgentName,
        title: signal.task.slice(0, 80),
        summary,
        outcome: 'error',
      })

    const targetSk = deps.sessionKeyForAgent(signal.targetAgentId)
    if (!targetSk) {
      dropReflect(
        `Could not reach ${signal.targetAgentName} — no active session. Wake them or reassign the task.`,
      )
      return null
    }

    // Loop breaker: refuse a delegation that has already failed the same agent the
    // same task MAX times — a code-level cap on the failure→reflect→re-delegate
    // cycle (the leader is uncapped by depth, so prompts alone can't bound it). We
    // notify the delegator exactly ONCE on crossing the cap, then refuse silently.
    const fc = failureCounts.get(failKey(signal.targetAgentId, signal.task)) ?? 0
    if (fc >= MAX_DELEGATION_FAILURES) {
      if (fc === MAX_DELEGATION_FAILURES) {
        failureCounts.set(failKey(signal.targetAgentId, signal.task), fc + 1) // mark "notified"
        if (sourceTaskId)
          await deps.board.addComment(
            sourceTaskId,
            `Repeated failures delegating "${signal.task.slice(0, 80)}" to ${signal.targetAgentName} (${MAX_DELEGATION_FAILURES}×) — no longer re-delegating.`,
            'system',
          )
        dropReflect(
          `${signal.targetAgentName} has failed "${signal.task.slice(0, 80)}" ${MAX_DELEGATION_FAILURES} times — handle it directly, reassign it, or tell the user it can't be done. Do not keep re-delegating it.`,
        )
      }
      return null
    }

    // Bounded depth — enforced via the board ancestor chain, not a prompt.
    if ((await depthOf(sourceTaskId)) >= MAX_SPAWN_DEPTH) {
      if (sourceTaskId)
        await deps.board.addComment(
          sourceTaskId,
          `Spawn depth limit (${MAX_SPAWN_DEPTH}) reached — not delegating "${signal.task.slice(0, 80)}".`,
          'system',
        )
      dropReflect(
        `Delegation to ${signal.targetAgentName} refused — max delegation depth (${MAX_SPAWN_DEPTH}) reached. Handle it directly or report it back.`,
      )
      return null
    }
    if (deps.stopGen() !== startGen) return null

    // Approval plumbing: a risky delegation surfaces on the
    // LEADER's approval queue; we don't create or deliver the child until it's
    // approved. A forgotten approval resolves to expired/timeout (never a deadlock).
    if (deps.requestDelegationApproval && deps.isRiskyDelegation?.(signal)) {
      const leaderId = deps.leaderAgentId()
      if (leaderId) {
        const resolution = await deps.requestDelegationApproval({
          leaderAgentId: leaderId,
          targetAgentId: signal.targetAgentId,
          targetAgentName: signal.targetAgentName,
          task: signal.task,
        })
        if (resolution !== 'allow_once' && resolution !== 'allow_always') {
          if (sourceTaskId)
            await deps.board.addComment(
              sourceTaskId,
              `Delegation to ${signal.targetAgentName} not approved (${resolution}); skipped.`,
              'system',
            )
          dropReflect(
            `Delegation to ${signal.targetAgentName} was not approved (${resolution}). Revise, reassign, or proceed differently.`,
          )
          return null
        }
      }
      if (deps.stopGen() !== startGen) return null
    }

    // Concurrency: an agent has ONE session, so it works delegations serially. If
    // its session is already running another delegated task, DEFER this one as a
    // durable `todo` (NOT a second overwrite of the session→task mapping, which
    // would orphan the first task and misattribute its completion). It carries an
    // `:agent:` marker so the ready-pump fires it once the session frees (and after
    // a refresh, `resume`'s pump decodes the agent from the persisted id). The
    // delegator is encoded too so a mid-chain reduce-point survives a refresh.
    const deferred = sessionToTask.has(targetSk)
    const title = signal.task.slice(0, 200)
    const task = await deps.board.createTask({
      title,
      description: signal.task,
      teamId: deps.teamId,
      assigneeRuntime: 'openclaw',
      ...(sourceTaskId ? { parentTaskId: sourceTaskId } : {}),
      sourceDelegationId: encodeSdid(runId, {
        ...(deferred ? { agentId: signal.targetAgentId } : {}),
        reflectTo: delegatorAgentId,
      }),
    })
    if (!task) {
      dropReflect(
        `Could not create the board task for ${signal.targetAgentName} (server error). The delegation did not start.`,
      )
      return null
    }
    taskTitle.set(task.id, title)
    if (delegatorAgentId) taskReflectTo.set(task.id, delegatorAgentId)
    emit({
      id: task.id,
      title,
      status: task.status ?? 'todo',
      parentTaskId: sourceTaskId,
      createdAt: task.createdAt,
      updatedAt: task.updatedAt,
    })

    if (deferred) {
      // Leave it `todo`; the ready-pump (run on the busy session's next completion)
      // claims + delivers it via `fireTask`. Track the target so the pump can route it.
      pendingTargets.set(task.id, signal.targetAgentId)
      return task.id
    }

    const claim = await deps.board.claim(task.id, signal.targetAgentId, 'openclaw')
    if (!claim.ok) {
      // 409 — someone else owns it; not a loss to the delegator. Drop our residue.
      taskTitle.delete(task.id)
      taskReflectTo.delete(task.id)
      return null
    }

    const exec = await deps.board.createExecution(task.id, 'openclaw')
    if (!exec) {
      // The run ledger couldn't open — don't deliver into an untracked in_progress
      // task; release it (re-claimable) and tell the delegator, mirroring create-null.
      await releaseClaimed(task.id, targetSk) // forgetSession is harmless (not yet mapped)
      dropReflect(
        `Could not start the run for ${signal.targetAgentName} (server error recording the execution). The delegation did not start.`,
      )
      return null
    }
    taskToExec.set(task.id, exec.id)
    sessionToTask.set(targetSk, task.id)
    sessionStartGen.set(targetSk, startGen) // capture for the Stop-vs-abort distinction
    lastActivityAt.set(targetSk, now()) // start the idle watchdog clock for this delegate
    emit({
      id: task.id,
      status: 'in_progress',
      assigneeAgentId: signal.targetAgentId,
      updatedAt: Date.now(),
    })

    // Stop pressed after the claim but before delivery — release the task so it
    // isn't a permanently in_progress ghost with no run behind it.
    if (deps.stopGen() !== startGen) {
      await releaseClaimed(task.id, targetSk)
      return task.id
    }
    try {
      await deps.deliver(targetSk, signal.targetAgentId, signal.task)
    } catch {
      // Delivery rejected (the agent never received the task) — fail it now rather
      // than waiting out the 8-minute watchdog.
      await failForSession(
        targetSk,
        'error',
        `Could not deliver the task to ${signal.targetAgentName} (the message was rejected).`,
      )
    }
    return task.id
  }

  /**
   * Create a plan as a durable dependency chain: step i depends on step i-1, so
   * only step 0 is ready. The ready-pump fires each subsequent step when its
   * blocker completes. Targets are stored in `pendingTargets` so the pump knows
   * who to deliver an unblocked step to.
   */
  async function startPlan(
    steps: DelegationSignal[],
    sourceTaskId: string | null,
    delegatorAgentId: string | null,
    runId: string,
  ): Promise<void> {
    let prevTaskId: string | null = null
    let index = 0
    for (const step of steps) {
      const stepIndex = index
      index += 1
      const targetSk = deps.sessionKeyForAgent(step.targetAgentId)
      if (!targetSk) {
        enqueueReflection({
          toAgentId: delegatorAgentId ?? deps.leaderAgentId(),
          by: step.targetAgentName,
          title: step.task.slice(0, 80),
          summary: `Plan step skipped — could not reach ${step.targetAgentName} (no active session).`,
          outcome: 'error',
        })
        continue
      }
      const title = step.task.slice(0, 200)
      const task = await deps.board.createTask({
        title,
        description: step.task,
        teamId: deps.teamId,
        assigneeRuntime: 'openclaw',
        ...(sourceTaskId ? { parentTaskId: sourceTaskId } : {}),
        // Encode the intended target AND the delegator so a ready step survives a
        // refresh (the durable ready-pump decodes the target; `resume` decodes the
        // delegator so a mid-chain reduce-point isn't lost).
        sourceDelegationId: `${runId}:plan:${stepIndex}:agent:${step.targetAgentId}:reflectTo:${delegatorAgentId ?? ''}`,
      })
      if (!task) {
        enqueueReflection({
          toAgentId: delegatorAgentId ?? deps.leaderAgentId(),
          by: step.targetAgentName,
          summary: `Could not create the board task for plan step "${title.slice(0, 60)}" (server error).`,
          outcome: 'error',
        })
        continue
      }
      taskTitle.set(task.id, title)
      pendingTargets.set(task.id, step.targetAgentId)
      if (delegatorAgentId) taskReflectTo.set(task.id, delegatorAgentId)
      emit({
        id: task.id,
        title,
        status: task.status ?? 'todo',
        parentTaskId: sourceTaskId,
        createdAt: task.createdAt,
        updatedAt: task.updatedAt,
      })
      if (prevTaskId) await deps.board.linkDep(task.id, prevTaskId)
      prevTaskId = task.id
    }
    // Fire whatever is ready now (step 0 has no dep).
    await pumpReady()
  }

  /** Resolve a ready plan step's intended agent — the in-memory map, else decoded
   *  from the durable task's `sourceDelegationId` (so a refresh can resume it). */
  function targetForTask(task: BoardTask): string | null {
    const inMem = pendingTargets.get(task.id)
    if (inMem) return inMem
    const sdid =
      typeof task['sourceDelegationId'] === 'string' ? (task['sourceDelegationId'] as string) : ''
    return sdidAgent(sdid)
  }

  /** Claim + open-execution + deliver a dep-ready task to its target agent. */
  async function fireTask(taskId: string, agentId: string, description: string): Promise<void> {
    if (taskToExec.has(taskId)) return
    const targetSk = deps.sessionKeyForAgent(agentId)
    if (!targetSk) {
      pendingTargets.delete(taskId)
      enqueueReflection({
        toAgentId: reflectTargetFor(taskId),
        by: nameOf(agentId),
        title: taskTitle.get(taskId),
        summary: `A plan step could not be delivered — ${nameOf(agentId)} has no active session.`,
        outcome: 'error',
      })
      return
    }
    // The agent's single session is busy with another delegation. Leave this task
    // `todo` + its pendingTargets entry intact so the ready-pump re-fires it once
    // the session frees — two tasks for one agent run serially, never orphaning one.
    if (sessionToTask.has(targetSk)) return
    const startGen = deps.stopGen()
    const claim = await deps.board.claim(taskId, agentId, 'openclaw')
    pendingTargets.delete(taskId)
    if (!claim.ok) return // 409 — someone else won; never retry
    const exec = await deps.board.createExecution(taskId, 'openclaw')
    if (!exec) {
      // Transient ledger error — release to `todo` so the ready-pump retries it (its
      // sdid still carries the target + delegator). No reflection: it self-heals.
      await deps.board.updateStatus(taskId, 'todo')
      emit({ id: taskId, status: 'todo', assigneeAgentId: null, updatedAt: now() })
      return
    }
    taskToExec.set(taskId, exec.id)
    sessionToTask.set(targetSk, taskId)
    sessionStartGen.set(targetSk, startGen) // capture for the Stop-vs-abort distinction
    lastActivityAt.set(targetSk, now()) // start the idle watchdog clock for this delegate
    emit({ id: taskId, status: 'in_progress', assigneeAgentId: agentId, updatedAt: Date.now() })
    // Stop pressed after the claim but before delivery — release the task so it
    // isn't a permanently in_progress ghost (and the watchdog can't false-time-out
    // a step that was never delivered). Mirrors spawn's stop-release.
    if (deps.stopGen() !== startGen) {
      await releaseClaimed(taskId, targetSk)
      return
    }
    try {
      await deps.deliver(targetSk, agentId, description)
    } catch {
      await failForSession(
        targetSk,
        'error',
        `Could not deliver the step to ${nameOf(agentId)} (the message was rejected).`,
      )
    }
  }

  /**
   * Fire every now-ready plan step (a step whose blocker just completed =
   * auto-unblock). `getReadyTasks` returns only `status='todo'` + deps-satisfied;
   * the target is resolved from the durable task (so a refresh resumes it) and
   * the atomic claim-409 is the final double-fire arbiter.
   */
  async function pumpReady(): Promise<void> {
    const ready = await deps.board.getReadyTasks(deps.teamId)
    for (const task of ready) {
      const agentId = targetForTask(task)
      if (!agentId) continue // not a plan step we can fire
      if (!taskTitle.has(task.id) && task.title) taskTitle.set(task.id, task.title)
      await fireTask(task.id, agentId, (task.description as string | undefined) ?? task.title ?? '')
    }
  }

  function enqueueReflection(item: {
    toAgentId: string | null
    by: string
    title?: string
    summary: string
    outcome?: TaskUpdateOutcome
  }): void {
    // Failures must reach the recipient even with an empty summary; successes
    // need substance (the empty-success placeholder is applied by the caller).
    if (!item.summary.trim() && (item.outcome == null || item.outcome === 'done')) return
    reflectQueue.push(item)
    if (!reflectTimer) reflectTimer = setTimeout(() => void flushReflection(), REFLECT_WINDOW_MS)
  }

  function armReflectTimer(): void {
    if (!reflectTimer) reflectTimer = setTimeout(() => void flushReflection(), REFLECT_WINDOW_MS)
  }

  async function flushReflection(): Promise<void> {
    reflectTimer = null
    if (reflectQueue.length === 0) return
    const items = reflectQueue.splice(0)
    // Group by recipient session: a sub-task reports to its delegator, a
    // top-level task to the leader. A recipient that can't be resolved yet
    // (leader not identified / no session) is re-queued + re-armed, never lost.
    const byTarget = new Map<string, typeof items>()
    const unresolved: typeof items = []
    for (const item of items) {
      const toId = item.toAgentId ?? deps.leaderAgentId()
      const toSk = toId ? deps.sessionKeyForAgent(toId) : null
      if (!toId || !toSk) {
        unresolved.push(item)
        continue
      }
      const g = byTarget.get(toSk) ?? []
      g.push(item)
      byTarget.set(toSk, g)
    }
    if (unresolved.length > 0) {
      reflectQueue.unshift(...unresolved)
      armReflectTimer()
    }
    const startGen = deps.stopGen()
    for (const [toSk, group] of byTarget) {
      // A Stop mid-flush suppresses the remaining groups' narration AND delivery —
      // the user halted; don't append stale [Task Update]s or re-amplify after Stop.
      if (deps.stopGen() !== startGen) return
      const message = buildTaskUpdateMessage(group)
      // Visible narration (board→chat) + context delivery to the recipient. The
      // narration is the user-facing signal even if the delivery itself fails.
      deps.narrate?.(toSk, message)
      const toId = deps.agentIdForSession(toSk)
      if (toId) {
        try {
          await deps.deliver(toSk, toId, message)
        } catch {
          // Delivery rejected (a transient chat.send failure) — re-queue for a
          // bounded retry rather than silently dropping the recipient's update
          // (the unresolved path already re-queues; a resolved-but-rejected one
          // is functionally the same). On exhaustion, tell them via narration.
          const attempts = group.reduce((m, i) => Math.max(m, i.attempts ?? 0), 0) + 1
          if (attempts <= MAX_REFLECT_ATTEMPTS) {
            for (const item of group) reflectQueue.push({ ...item, attempts })
            armReflectTimer()
          } else {
            deps.narrate?.(
              toSk,
              `${group.length} task update(s) could not be delivered to this session — the results are on the board.`,
            )
          }
        }
      }
    }
  }

  async function completeForSession(sessionKey: string, summary: string): Promise<void> {
    const taskId = sessionToTask.get(sessionKey)
    if (!taskId) return // echo-loop guard: the leader's reduce turn is never here
    // Capture the Stop verdict BEFORE forgetSession clears the generation. A Stop
    // since this delegation was dispatched suppresses the amplifying tail
    // (narration + reflection + ready-pump) — the board write below is truth and
    // always runs, but no new turn is started after the user halted.
    const stopped = stopChangedFor(sessionKey)
    forgetSession(sessionKey)
    // Compact verbose tool output in the report-up BEFORE it's recorded/relayed
    // (flag-on). Pass-through-safe + failure-preserving — never drops an error.
    const compacted = deps.compact ? deps.compact(summary) : summary
    const trimmed = compacted.slice(0, 20_000)
    const agentId = deps.agentIdForSession(sessionKey)
    const by = nameOf(agentId)
    const title = taskTitle.get(taskId)
    const ok = await deps.board.updateStatus(taskId, 'done')
    if (!ok) {
      // The task was released/reassigned out from under us (e.g. the server stale
      // sweep released a long run to `todo`, or another claimant took it). It is no
      // longer ours — do NOT fake-complete it (a `todo → done` is an illegal
      // transition the server 409s, and ghosting a success would diverge the
      // canonical board from the projection + reflect a false success). Close our
      // orphaned exec, tell the delegator the result landed too late (unless stopped).
      const execId = taskToExec.get(taskId)
      if (execId) {
        taskToExec.delete(taskId)
        await deps.board.completeExecution(execId, {
          status: 'cancelled',
          error: 'result arrived after the task was released/reassigned',
        })
      }
      if (!stopped)
        enqueueReflection({
          toAgentId: reflectTargetFor(taskId),
          by,
          title,
          summary: `${by}'s result for “${title ?? 'the task'}” arrived after the task was released/reassigned — it was not recorded. Re-check the board or re-delegate if it's still needed.`,
          outcome: 'error',
        })
      taskReflectTo.delete(taskId)
      taskTitle.delete(taskId)
      return
    }
    const execId = taskToExec.get(taskId)
    if (execId) {
      taskToExec.delete(taskId)
      await deps.board.completeExecution(execId, { status: 'succeeded', summary: trimmed })
    }
    // Report-up: record the SUMMARY (not the transcript) as a comment. A genuinely
    // EMPTY result is surfaced HONESTLY as "(no output produced)" rather than echoing
    // its own task title as if it had done the work (the "DONE card that just repeats
    // the prompt" bug). This orchestration path is chat-only — the delegated run has no
    // worktree, so an empty summary means the agent returned no text, not a file
    // deliverable. (If a future worktree-backed orchestration lands, branch here on the
    // task's `worktreeRef` to point at the deliverable instead.)
    await deps.board.addComment(
      taskId,
      trimmed || '(no output produced)',
      'agent',
      agentId ?? undefined,
    )
    emit({ id: taskId, status: 'done', summary: trimmed, updatedAt: Date.now() })
    // A success resets the loop breaker for this (agent, task).
    if (agentId && title) clearFailure(agentId, title)
    if (!stopped) {
      // Visible "done ≠ stuck" marker so the user always sees a completion, even
      // when the recipient legitimately stays silent (UI-only; no agent round-trip).
      deps.narrate?.(sessionKey, `✓ ${by} completed${title ? `: ${title}` : ''}.`)
      // Reflect the result to whoever DELEGATED this task (the reduce-point: a
      // sub-task reports to its parent, a top-level task to the leader). An EMPTY result
      // still reflects, but HONESTLY — the leader is told the agent returned no output so
      // it can re-delegate / note the gap instead of synthesizing a false success.
      enqueueReflection({
        toAgentId: reflectTargetFor(taskId),
        by,
        title,
        summary: trimmed || `${by} finished “${title ?? 'the task'}” but returned no output.`,
      })
    }
    taskReflectTo.delete(taskId)
    taskTitle.delete(taskId)
    // Auto-unblock: fire any plan step whose blocker just completed (not after Stop).
    if (!stopped) await pumpReady()
  }

  /**
   * Terminal FAILURE of a delegated child (errored / aborted / out-of-room / went
   * silent). The sibling of `completeForSession` and the fix for the "leader left
   * standing" bug: the task is marked `blocked`, the execution is closed with the
   * failure, a board comment records the reason, and — critically — a FAILURE
   * reflection is queued so the leader learns and can retry / reassign / report
   * instead of waiting forever. Deleting the session mapping makes a late
   * completion after a fired timeout a harmless no-op.
   */
  async function failForSession(
    sessionKey: string,
    reason: FailReason,
    detail: string,
  ): Promise<void> {
    const taskId = sessionToTask.get(sessionKey)
    if (!taskId) return // not a tracked delegation (e.g. the leader's own turn)
    // A Stop since this delegation started suppresses the amplifying tail (the
    // failure reflection + ready-pump). A genuine user-Stop ABORT never reaches
    // here (onEvent routes it to a clean release); this guard only covers an
    // error/max_turns that lands concurrently with a Stop — the board still records
    // the failure (truth), but no post-Stop re-amplification fires.
    const stopped = stopChangedFor(sessionKey)
    forgetSession(sessionKey)
    const detailTrim = (detail ?? '').slice(0, 4000).trim()
    const reflectTo = reflectTargetFor(taskId)
    const title = taskTitle.get(taskId)
    const agentId = deps.agentIdForSession(sessionKey)
    const by = nameOf(agentId)
    // Loop breaker: record this (agent, task) failure so a persistently-failing
    // re-delegation is eventually refused in `spawn`.
    if (agentId && title) noteFailure(agentId, title)
    await deps.board.updateStatus(taskId, 'blocked')
    const execId = taskToExec.get(taskId)
    if (execId) {
      taskToExec.delete(taskId)
      await deps.board.completeExecution(execId, {
        status: FAIL_EXEC_STATUS[reason],
        error: detailTrim || FAIL_REASON_LABEL[reason],
      })
    }
    await deps.board.addComment(
      taskId,
      `${FAIL_REASON_LABEL[reason]}: ${detailTrim || '(no output)'}`,
      'system',
    )
    emit({ id: taskId, status: 'blocked', updatedAt: now() })
    // A blocked blocker can NEVER become `done`, so its downstream plan steps
    // would wait forever — cancel the pending dependents (else they ghost as
    // perpetual `todo` cards) and roll them into the failure so the delegator
    // learns the whole CHAIN stalled, not just this step.
    const cancelled = await deps.board.cancelDependents(taskId)
    for (const c of cancelled) {
      pendingTargets.delete(c.id)
      taskReflectTo.delete(c.id)
      taskTitle.delete(c.id)
      emit({ id: c.id, status: 'cancelled', updatedAt: now() })
    }
    const chainNote =
      cancelled.length > 0
        ? ` The dependent step(s) ${cancelled
            .map((c) => `“${(c.title ?? '').slice(0, 40)}”`)
            .join(', ')} were cancelled — retry the plan or re-delegate.`
        : ''
    if (!stopped)
      enqueueReflection({
        toAgentId: reflectTo,
        by,
        title,
        summary: (detailTrim || FAIL_REASON_LABEL[reason]) + chainNote,
        outcome: reason,
      })
    taskReflectTo.delete(taskId)
    taskTitle.delete(taskId)
    if (!stopped) await pumpReady()
  }

  /** Fail any delegated child idle past the watchdog window (never left standing).
   *  Also the heartbeat that reaps the two age-bounded maps so a long-lived team
   *  orchestrator can't grow them without bound. */
  async function sweepStaleSessions(): Promise<void> {
    const tnow = now()
    for (const [k, ts] of processed) if (ts <= tnow - PROCESSED_TTL_MS) processed.delete(k)
    for (const [k, ts] of intentMissed) if (ts <= tnow - PROCESSED_TTL_MS) intentMissed.delete(k)
    for (const [s, ts] of recentlyTerminated)
      if (ts <= tnow - RECENTLY_TERMINATED_TTL_MS) recentlyTerminated.delete(s)
    const cutoff = tnow - DELEGATION_IDLE_TIMEOUT_MS
    const stale: string[] = []
    for (const [sk, ts] of lastActivityAt) {
      if (ts <= cutoff && sessionToTask.has(sk)) stale.push(sk)
    }
    for (const sk of stale) {
      const mins = Math.round(DELEGATION_IDLE_TIMEOUT_MS / 60_000)
      await failForSession(sk, 'timeout', `No response from the delegate for ${mins} minutes.`)
    }
  }

  /** A session's observer ended while a delegation was still in flight. */
  async function onSessionClosed(sessionKey: string): Promise<void> {
    if (!sessionToTask.has(sessionKey)) return
    await failForSession(
      sessionKey,
      'error',
      'The delegate session ended before reporting a result.',
    )
  }

  /** Re-attach to durable in-flight work after a (re)mount — see the interface. */
  async function resume(): Promise<void> {
    const all = await deps.board.listTasks(deps.teamId)
    for (const t of all) {
      const assignee = typeof t.assigneeAgentId === 'string' ? t.assigneeAgentId : null
      if (t.status === 'in_progress' && assignee) {
        const sk = deps.sessionKeyForAgent(assignee)
        if (sk && !sessionToTask.has(sk)) {
          sessionToTask.set(sk, t.id)
          sessionStartGen.set(sk, deps.stopGen()) // capture for the Stop-vs-abort distinction
          lastActivityAt.set(sk, now())
          if (t.title) taskTitle.set(t.id, t.title)
          // Recover the IMMEDIATE delegator (the reduce-point) from the persisted
          // sourceDelegationId so a mid-chain sub-task still reports to its parent,
          // not the leader. Falls back to the leader when the sdid carries none.
          const sdid =
            typeof t['sourceDelegationId'] === 'string' ? (t['sourceDelegationId'] as string) : ''
          const reflectTo = sdidReflectTo(sdid) ?? deps.leaderAgentId()
          if (reflectTo) taskReflectTo.set(t.id, reflectTo)
        }
      }
    }
    await pumpReady()
  }

  async function onEvent(sessionKey: string, event: RuntimeEvent): Promise<void> {
    const sourceAgentId = deps.agentIdForSession(sessionKey) ?? ''
    // Capture BEFORE completion deletes the mapping, so a done that both
    // completes a child AND sub-delegates parents the grandchild correctly.
    const sourceTaskId = sessionToTask.get(sessionKey) ?? null

    // Any observed event = the delegate is alive; refresh the idle watchdog so a
    // slow-but-working agent (streaming deltas / tool calls) is never swept.
    if (sessionToTask.has(sessionKey)) lastActivityAt.set(sessionKey, now())

    if (event.kind === 'done') {
      if (event.reason === 'success') {
        await completeForSession(sessionKey, event.summary ?? '')
        // fall through: a successful done may ALSO carry <delegate>/<plan> to spawn.
      } else if (event.reason === 'aborted' && stopChangedFor(sessionKey)) {
        // The user pressed Stop (its sessions.abort produced this `aborted` frame) —
        // a clean PAUSE, not a real failure. Release the task to `todo` (re-runnable);
        // do NOT block it, cancel its plan chain, or reflect a failure to the leader
        // (which would re-amplify exactly the work the user just halted).
        await releaseForSession(sessionKey)
        return
      } else {
        // error / aborted / max_turns — a failed terminal does not spawn new work.
        await failForSession(sessionKey, event.reason, event.summary ?? '')
        return
      }
    } else if (event.kind === 'error' && event.fatal) {
      // A fatal runtime error ends the delegate; non-fatal errors keep waiting
      // (the run may recover) and surface in the activity terminal, not the chat.
      await failForSession(sessionKey, 'error', event.message)
      return
    }

    // Late-replay guard: a terminal on an already-unmapped session (its delegation
    // was completed / failed / timed-out) must NOT seed new work — a stale
    // <delegate>/<plan> in that summary would spawn an orphan top-level task. A
    // genuine never-tracked leader/user turn (not recently terminated) still
    // delegates normally. Uses the ENTRY mapping, so a success-then-sub-delegate
    // (mapped at entry) is unaffected.
    if (sourceTaskId === null && recentlyTerminated.has(sessionKey)) return

    const signals = extractSignals(event, sourceAgentId, deps.known())
    const runId = event.runId || 'norun'
    // The agent that emitted these delegations is the reduce-point recipient for
    // their results (and the one told if a delegation can't be started).
    const delegatorAgentId = sourceAgentId || deps.leaderAgentId()

    const maxFanout = deps.caps?.maxFanout
    let spawnedThisTurn = 0
    let cappedThisTurn = 0
    for (const sig of signals.parallel) {
      const key = `${runId}:${sig.targetAgentId}:${sig.task.slice(0, 80)}`
      if (processed.has(key)) continue
      // Fan-out cap: bound parallel delegations per turn, independent of how many
      // the model emitted. Overflow is COUNTED + reported (not silently dropped).
      if (
        maxFanout != null &&
        !checkFanoutCap({ siblingCount: spawnedThisTurn, max: maxFanout }).ok
      ) {
        cappedThisTurn += 1
        continue
      }
      processed.set(key, now())
      const id = await spawn(sig, sourceTaskId, delegatorAgentId, runId)
      if (id) spawnedThisTurn += 1
    }
    if (cappedThisTurn > 0) {
      if (sourceTaskId)
        await deps.board.addComment(
          sourceTaskId,
          `Fan-out cap (${maxFanout}) reached — ${cappedThisTurn} delegation(s) this turn were not started.`,
          'system',
        )
      deps.onCapHit?.({ kind: 'fanout', sourceTaskId })
      enqueueReflection({
        toAgentId: delegatorAgentId,
        by: 'System',
        summary: `Fan-out cap (${maxFanout}) reached — ${cappedThisTurn} delegation(s) this turn were not started. Re-issue them in a follow-up if still needed.`,
        outcome: 'error',
      })
    }

    if (signals.plan.length > 0) {
      const planId = `${deps.teamId}:${runId}:plan`
      if (!processed.has(planId)) {
        processed.set(planId, now())
        await startPlan(signals.plan, sourceTaskId, delegatorAgentId, runId)
      }
    }

    // Parse-failed-intent: the turn LOOKS like a delegation attempt (a
    // <delegate>/<plan> shape) but parsed to zero signals (mangled tag / unknown
    // name) — the delegator would otherwise wait forever. Tell the leader to
    // re-issue. ONE nudge per (run, source agent): a re-observation of the SAME
    // run can't re-nudge (loop-safe), but a genuinely-new run later in the session
    // can — so a second distinct parse failure isn't silently swallowed.
    const intentKey = `${runId}:${sourceAgentId}`
    if (
      event.kind === 'done' &&
      signals.parallel.length === 0 &&
      signals.plan.length === 0 &&
      sourceAgentId &&
      !intentMissed.has(intentKey) &&
      detectDelegationIntent(event.summary ?? '')
    ) {
      intentMissed.set(intentKey, now())
      enqueueReflection({
        toAgentId: deps.leaderAgentId(),
        by: 'System',
        summary: `${nameOf(sourceAgentId)} appears to have tried to delegate, but the directive didn't parse — re-issue it as <delegate to="@Name">task</delegate> (or a <plan> of <step> blocks) so it can be routed.`,
        outcome: 'error',
      })
    }
  }

  return {
    onEvent,
    sweepStaleSessions,
    onSessionClosed,
    resume,
    taskForSession: (sessionKey) => sessionToTask.get(sessionKey) ?? null,
    reset() {
      // Best-effort: deliver any pending reflection BEFORE tearing down, so a
      // child result isn't silently lost on a team-switch / reconnect that lands
      // inside the 3 s batch window. `flushReflection` synchronously drains the
      // queue (the delivery is fire-and-forget against the still-alive adapter).
      if (reflectQueue.length > 0) void flushReflection()
      if (reflectTimer) {
        clearTimeout(reflectTimer)
        reflectTimer = null
      }
      reflectQueue.length = 0
      sessionToTask.clear()
      sessionStartGen.clear()
      taskToExec.clear()
      taskTitle.clear()
      taskReflectTo.clear()
      pendingTargets.clear()
      processed.clear()
      intentMissed.clear()
      lastActivityAt.clear()
      recentlyTerminated.clear()
      failureCounts.clear()
    },
  }
}
