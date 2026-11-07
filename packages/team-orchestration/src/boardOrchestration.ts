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

import {
  autoFireRefusal,
  BUDGET_HELD_RECHECK_MS,
  BUDGET_REFUSED_CLASS,
  budgetRefusalOf,
  carriesOnEarlierRun,
  decideDone,
  delegationTargetOf,
  extraTurnUsed,
  findHandOffCycle,
  HAND_OFF_TITLE_CHARS,
  isHumanAssignment,
  ledgerAllowsAutoFire,
  ledgerWillAutoFire,
  MAX_AUTO_FIRES,
  MAX_PROVIDER_RETRIES,
  parseWaitingOn,
  delegationFailureKey,
  isEngineRun,
  normalizeTaskTitle,
  PAUSED_RUN_CLASS,
  PROVIDER_RETRY_WAITS_MS,
  providerFailureOf,
  providerRetriesUsed,
  replyIsEmpty,
  stoppedByPause,
  stretchStartedAt,
  strongerWakeReason,
  subtaskNames,
  subtaskStanding,
  subtasksStillOut,
  tallySubtasks,
  unfinishedNeed,
  unfinishedSubtasks,
  waitsOnOtherWork,
  waitsToStartByItself,
  type HandOffLink,
  type ProviderFailure,
  type ResultClaim,
  type SubtaskView,
  type TaskAttention,
  type TaskRunReason,
  type TaskWakeSettlement,
  type WaitingOn,
  type WakeSkipReason,
} from '@clawboo/board-core'
import { createSuspendDetector, setAwakeTimeout, type RuntimeEvent } from '@clawboo/executor'
import {
  checkDepthCap,
  checkFanoutCap,
  DEFAULT_MAX_DEPTH,
  DEFAULT_MAX_PLAN_STEPS,
  isVerdictPromotable,
} from '@clawboo/governance'
import { classifyError, isAccountError, isTransientError } from '@clawboo/obs'

import type {
  BoardTask,
  ClaimedWake,
  ClaimResult,
  CompleteExecutionOutcome,
  EngineBoardClient,
  ExecutionRef,
  ExecutionSummary,
  HandOffInput,
  HandOffResult,
} from './boardClient'
import { isClawbooControlToken, isOpenclawControlToken } from './controlTokens'
import { BUDGET_HELD_CODE, BUDGET_REFUSED_CODE, DeliveryRefusedError } from './deliveryRefused'
import {
  buildTaskUpdateMessage,
  type OutstandingDelegation,
  type TaskUpdateOptions,
  type TaskUpdateOutcome,
} from './taskUpdate'

import {
  parseStructuredDelegations,
  findPlanBlocks,
  resolveSessionsSendTarget,
  detectDelegationIntent,
  type SessionsSendParams,
} from './delegationTags'
import { ASSIGNMENT_TURN, SYSTEM_TURN, type RunStamp, type TurnOrigin } from './turnOrigin'

/**
 * A source task at this ancestor-depth (or deeper) may not spawn children —
 * bounds recursion at a finite, small fan-out tree. Leader/user-initiated turns
 * have no source task (depth 0) and may always delegate.
 */
export const MAX_SPAWN_DEPTH = DEFAULT_MAX_DEPTH

/** The most steps a plan may have. Longer is refused whole. */
export const MAX_PLAN_STEPS = DEFAULT_MAX_PLAN_STEPS

/** What the run id reads as when an event carries none. */
const NO_RUN_ID = 'norun'

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

// The durable auto-refire cap and the ready-pump's fire policy over a task's
// execution ledger (a user Stop is never auto-refired; a task that keeps failing
// is parked at MAX_AUTO_FIRES). Both live in @clawboo/board-core, where the
// server's pump scan and the board's needs-you column read the same rule; they
// are re-exported here because this engine's pump is their primary consumer.
export { ledgerAllowsAutoFire, MAX_AUTO_FIRES }

/**
 * What `dispatchTask` did with a task a person asked to run.
 *  • `started`   claimed and delivered to its agent;
 *  • `queued`    its agent is busy with another task, so it waits in `todo` and
 *                runs the moment that agent frees up (even if its ledger would
 *                otherwise park it: the person asked for this run);
 *  • `not_found` no such task;
 *  • `not_ready` not `todo` (already running, finished, cancelled) or waiting on
 *                an unfinished dependency;
 *  • `no_agent`  no agent is bound to it, so there is no one to run it.
 */
export type DispatchOutcome = 'started' | 'queued' | 'not_found' | 'not_ready' | 'no_agent'

/** The idle allowance while a delegate sits INSIDE one tool call (call seen, no
 *  result yet). A build/test/install can legitimately run silent far past the
 *  8-min window — the runtime emits `tool-call`, then nothing until the result —
 *  and failing it there kills exactly the long-running work teams exist for.
 *  Still bounded: a tool call that outlives even this ceiling is failed. */
export const OPEN_TOOL_CALL_TIMEOUT_MS = 3 * DELEGATION_IDLE_TIMEOUT_MS

/** The idle allowance while a delegation's run has not started yet. It is not
 *  silent: it is waiting behind another run on the agent's home or connection
 *  lock. The host bounds that wait with `HOME_MUTEX_ACQUIRE_MS` (10 minutes by
 *  default), after which deliver rejects, so this is only the ceiling for a
 *  start that never settles. */
export const PENDING_START_TIMEOUT_MS = OPEN_TOOL_CALL_TIMEOUT_MS

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

/**
 * Times a durable report-up is sent again because the run that carried it never
 * finished: the process died or shut down, or the run ended on an error. Past
 * this it is given up and the recipient's chat is told the results are on the
 * board, so an update whose run keeps failing cannot be sent forever.
 */
export const MAX_REPORT_UP_REPLAYS = 3

/**
 * Turns a task's agent gets for hand-offs the board refused, with nothing else new to
 * hear. Enough to be told and to try someone else. Each such run ends well with text, so
 * the no-progress brake does not count it, and a model that keeps asking would otherwise
 * never stop. Past this the task goes on to its ending, and the card says what the agent
 * was not told. Kept in memory: a restart allows these again.
 */
export const MAX_REFUSAL_TURNS = 2

/**
 * How much of a run's context the results a Stop held may take (a result can run
 * to 20,000 characters). What does not fit waits for the run after.
 */
export const HELD_REPORT_UPS_BUDGET_CHARS = 12_000

/**
 * How long a work check (see WorkCheck) may take, in time the machine is awake,
 * before the engine gives up on it and leaves the task to a person. The verify
 * command has its own 10-minute limit; the reviewer has none, and a check that
 * never answers would keep the agent's session bound for good.
 */
export const WORK_CHECK_TIMEOUT_MS = 30 * 60_000
/**
 * How long a finished task's check waits for other runs of the team to leave the
 * folder it looks at (see {@link PreparedWorkCheck}), in awake time. Past it the
 * check runs anyway and says so: that is the check as it would have been without
 * the wait, while parking the task would hand a person work that may well be fine
 * every time a teammate has a long run. Separate from the check's own limit above,
 * which starts when the check does.
 */
export const WORK_CHECK_HOLD_LIMIT_MS = 15 * 60_000

/** Age after which a dedupe / recently-terminated entry is reaped (bounds memory
 *  on a long-lived team-chat orchestrator; comfortably past any run window). */
const PROCESSED_TTL_MS = 2 * DELEGATION_IDLE_TIMEOUT_MS

/** Why a delegated child failed — the comment + reflection prefix. */
/** How a wait the agent chose for its own task is reported, or null for any other
 *  reason: a person's wait (a hand-back, or what it said they must do) is a block, and
 *  the board itself ends a wait on a question or on other work. */
function chosenWaitOutcome(raw: unknown): 'asked' | 'waiting' | 'blocked' | null {
  const wait = parseWaitingOn(raw)
  if (wait?.kind === 'question') return 'asked'
  if (wait?.kind === 'task' || wait?.kind === 'subtasks') return 'waiting'
  return wait?.kind === 'person' ? 'blocked' : null
}

type FailReason = Extract<TaskUpdateOutcome, 'error' | 'aborted' | 'max_turns' | 'timeout'>

/** What a rejected delivery tells `failForSession`: a budget refusal is filed as one. */
const refusedErrorOpts = (err: unknown): { budgetRefused?: 'paused' | 'held' } =>
  err instanceof DeliveryRefusedError && err.budget ? { budgetRefused: err.budgetReason } : {}

const FAIL_REASON_LABEL: Record<FailReason, string> = {
  error: 'Run failed',
  aborted: 'Run stopped before finishing',
  max_turns: 'Ran out of room before finishing',
  timeout: 'Went silent (timed out with no response)',
}

// `cancelled` is RESERVED for user intent: the fire policy reads a cancelled
// last run as "the user stopped this — never auto-refire". A done:aborted that
// reaches failForSession is by definition NOT a clean user Stop (stopChangedFor
// routes those to releaseClaimed) — it's a wedge abort, an idle-guard kill, a
// session teardown: infrastructure death, which must stay refireable → 'failed'.
const FAIL_EXEC_STATUS: Record<FailReason, CompleteExecutionOutcome['status']> = {
  error: 'failed',
  aborted: 'failed',
  max_turns: 'failed',
  timeout: 'timed_out',
}

/** A run the provider refused for the account: what the board note and the
 *  failure report say instead of the generic label. Re-delegating cannot help,
 *  since every agent on the same runtime and key fails the same way, so the
 *  report tells the delegator to stop and hand it to a person. */
const ACCOUNT_FAILURE: Record<'Auth' | 'Billing', { note: string; report: string }> = {
  Auth: {
    note: "Run failed because the runtime's sign-in was refused. Fix the sign-in in Settings, Runtimes, then retry",
    report:
      "This is a sign-in failure: the runtime's key or login was refused, so it fails the same way until a person fixes it. Do not re-delegate or retry it. Tell the user it needs them to fix the sign-in in Settings.",
  },
  Billing: {
    note: 'Run failed because the provider refused the account (billing or credit). Fix the billing, then retry',
    report:
      'This is a billing failure: the provider refused the account (billing or credit), so it fails the same way until a person fixes it. Do not re-delegate or retry it. Tell the user it needs them to fix the billing.',
  },
}

/** A provider failure in words: how a retry's wait reads, and what the board note and
 *  the failure report say once the retries are used up. */
const PROVIDER_FAILURE: Record<
  ProviderFailure,
  {
    waiting: string
    /** What happened, for the note once it stops trying. */
    what: string
    /** What to wait for, for the report once it stops trying. */
    report: string
    outcome: 'rate_limited' | 'provider_down'
  }
> = {
  rate_limited: {
    waiting: 'Rate limited by the provider',
    what: 'Rate limited by the provider',
    report: 'The limit may need time to pass: do not hand it out again right away. Tell the user.',
    outcome: 'rate_limited',
  },
  unavailable: {
    waiting: 'The provider was overloaded or out of reach',
    what: 'The provider stayed overloaded or out of reach',
    report:
      'The provider may need time to recover: do not hand it out again right away. Tell the user.',
    outcome: 'provider_down',
  },
}

/** Why a provider failure stopped being tried: both retries went, or the task has failed
 *  too many times in a row for the pump to start it, which a person's Retry can reach
 *  with no retry having gone at all. */
type NoMoreTries = 'retried_twice' | 'too_many_failures'
const NO_MORE_TRIES_NOTE: Record<NoMoreTries, string> = {
  retried_twice: 'Clawboo tried again twice, so it waits for a person',
  too_many_failures:
    'This task has failed too many times in a row to try again by itself, so it waits for a person',
}
const NO_MORE_TRIES_REPORT: Record<NoMoreTries, string> = {
  retried_twice: 'Clawboo already tried it again twice.',
  too_many_failures: 'It has failed too many times in a row to try again by itself.',
}

/** Why a finished run has a result with no text in it: what it showed instead. */
type NoTextWhy = 'handed_on' | 'commented' | 'check_passed'
const NO_TEXT_NOTE: Record<NoTextWhy, string> = {
  handed_on: '(no text: it handed the work on to other tasks)',
  commented: '(no text: its comment on this task is its report)',
  check_passed: "(no text: the team's check passed its changes)",
}
const noTextReport = (why: NoTextWhy, by: string, title: string | undefined): string => {
  const what = `${by} finished “${title ?? 'the task'}”`
  if (why === 'handed_on') return `${what}: it handed the work on and wrote no summary.`
  if (why === 'commented')
    return `${what}: it wrote no summary, and its comment on the card has its report.`
  return `${what}: its changes passed the team's check, and it wrote no summary.`
}

/** Why the engine closed a run `cancelled` when a person finished or cancelled
 *  its task while it ran. Read back by the ticket block's "last attempt". */
export const RUN_CLOSED_FINISHED_BY_PERSON =
  'The task was finished by a person before this run ended.'

/** Why the engine closed a run `cancelled` whose result came back after its task
 *  had been released. The run itself finished; its result is kept as a comment. */
export const RUN_CLOSED_RESULT_AFTER_RELEASE =
  'result arrived after the task was released/reassigned'

/** A status as a person reads it on the board, for the notes the engine writes. */
const STATUS_WORD: Record<string, string> = {
  backlog: 'Backlog',
  todo: 'To do',
  in_progress: 'In progress',
  in_review: 'In review',
  blocked: 'Blocked',
  done: 'Done',
  cancelled: 'Cancelled',
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

/** A hand-off tool call that names no one the engine can give the work to. */
export interface UnroutedHandOff {
  /** The name (or id, or session key) the call gave, as written. */
  name: string
  task: string
  /** `unknown`: no teammate in the room matches it. `self`: it is the sender. */
  reason: 'unknown' | 'self'
  /** Which tool: a Clawboo delegate tool, which only signals the engine, or
   *  OpenClaw's own `sessions_send`, which may have delivered the message to a
   *  session outside the room itself. */
  via: 'delegate' | 'sessions_send'
}

export interface ExtractedSignals {
  /** Independent delegations — fire all immediately (fan-out = length ≥ 2). */
  parallel: DelegationSignal[]
  /** Ordered plan steps — durable dep chain; the ready-pump fires the next. */
  plan: DelegationSignal[]
  /** Hand-off tool calls the engine cannot route. The tools answer before the
   *  engine acts, so the sender is told here or it waits forever. */
  unrouted: UnroutedHandOff[]
}

/**
 * A board mutation the orchestrator made, fed to the projection store + (for
 * `done`) the reflection batcher. Carries whatever fields the orchestrator knows
 * at the call-site; the store merges by id (last-write-wins on `updatedAt`).
 */
/** What a host says of the pause covering a task (see BoardChange). */
export interface BoardChangePause {
  kind: string
  id: string
  name: string
  reason: string | null
  pausedBy: { id: string; name: string | null; role: string | null } | null
  pausedAt: number
}

/** A hand-off a cap refused. `max` is the ceiling, when it is not the fan-out cap. */
export interface CapHit {
  kind: 'fanout' | 'plan_length' | 'child_cap' | 'root_rate_cap'
  sourceTaskId: string | null
  max?: number
}

export interface BoardChange {
  id: string
  /** The readable id, like `CLB-12`, on a change that announces a new task. */
  identifier?: string | null
  title?: string
  status?: string
  assigneeAgentId?: string | null
  parentTaskId?: string | null
  createdAt?: number
  updatedAt?: number
  /** Report-up summary recorded on done (shown on the projection card). */
  summary?: string
  /** Why the task now needs a person (null: it does not). Never set by this
   *  engine, which cannot see the execution ledger's verdicts; a host that can
   *  read the board attaches it when a change moves a task's status. */
  attention?: TaskAttention | null
  /** The pause covering the task (null: none). A host attaches it the same way. */
  pause?: BoardChangePause | null
  /** When its check began waiting for the team folder (null: it no longer is). Set
   *  by the host, which knows (see {@link PreparedWorkCheck}). */
  checkHeldSince?: number | null
}

/**
 * How a narration line should be surfaced. `reflect` is routine orchestration
 * narration (the per-task "✓ completed" marker, the batched `[Task Update]`
 * envelope) — the board card is already its user-facing surface, so a host may
 * legitimately send it to a tracelog. `alert` is a coordination FAILURE the
 * user or leader would otherwise never learn about (delivery exhausted after
 * `MAX_REFLECT_ATTEMPTS`); a host must surface it somewhere a person will see.
 * Typed so the host routes on a discriminator, never by matching prose.
 */
export type NarrationKind = 'reflect' | 'alert'

const EMPTY: ExtractedSignals = { parallel: [], plan: [], unrouted: [] }
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

/** One hand-off tool call, resolved against the roster: a delegation to spawn,
 *  or the reason it cannot be routed. */
function handOffSignals(
  params: SessionsSendParams,
  sourceAgentId: string,
  known: KnownAgent[],
  via: UnroutedHandOff['via'],
): ExtractedSignals {
  const target = resolveSessionsSendTarget(params, known)
  if (!target || target.id === sourceAgentId) {
    const name = (params.label ?? params.agentId ?? params.sessionKey ?? '').trim()
    // A call that names no one: the tool itself refuses it, so the sender
    // already knows.
    if (!target && !name) return EMPTY
    return {
      parallel: [],
      plan: [],
      unrouted: [{ name, task: params.message, reason: target ? 'self' : 'unknown', via }],
    }
  }
  return {
    parallel: [{ targetAgentId: target.id, targetAgentName: target.name, task: params.message }],
    plan: [],
    unrouted: [],
  }
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
    return handOffSignals(params, sourceAgentId, known, 'sessions_send')
  }

  // A native `delegate` tool-call — the trusted, engine-observed delegation signal
  // for native (and any future MCP-`delegate`) runtimes. Same contract as the
  // sessions_send branch: resolve the target against the roster and turn it into
  // one parallel delegation the engine spawns; an unknown or self target is
  // reported back to the sender instead.
  if (event.kind === 'tool-call' && DELEGATE_TOOL_NAME_RE.test(event.name)) {
    const params = paramsFromDelegateInput(event.input)
    if (!params) return EMPTY
    return handOffSignals(params, sourceAgentId, known, 'delegate')
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
      return { parallel: [], plan: steps, unrouted: [] }
    }
    const intents = parseStructuredDelegations(event.summary, sourceAgentId, known)
    return {
      parallel: intents.map((d) => ({
        targetAgentId: d.targetAgentId,
        targetAgentName: d.targetAgentName,
        task: d.taskDescription,
      })),
      plan: [],
      unrouted: [],
    }
  }

  return EMPTY
}

/**
 * One result waiting to reach whoever handed the work off: an item of a batched
 * `[Task Update]`. It is everything the batcher needs to rebuild the message, so
 * an item read back after a restart renders exactly as it would have before.
 */
export interface ReportUp {
  /** The recipient; null resolves to the room's lead when it is sent. */
  toAgentId: string | null
  by: string
  title?: string
  summary: string
  outcome?: TaskUpdateOutcome
  /** The task this item reports on. */
  taskId?: string
  /** The closed task the recipient was running when it delegated this work:
   *  marks a follow-up. */
  forTaskId?: string
}

/**
 * How a durable report-up was closed:
 *  • `delivered` a run that carried it finished;
 *  • `stopped`   its room was archived, so no run of the recipient's will come;
 *  • `gave_up`   it could not be delivered, and the recipient's chat was told.
 * A person's Stop closes nothing: see `holdWorkForNextRun`.
 */
export type ReportUpSettlement = 'delivered' | 'stopped' | 'gave_up'

/**
 * The durable outbox behind the `[Task Update]` round-trip. Every report-up is
 * written here when it is queued and stays pending until it is settled, so a
 * restart that loses the in-memory batch or a delivery still queued behind the
 * recipient's run loses nothing: the next engine for the room reads the pending
 * ones back in `resume()` and sends them again. Synchronous, like the host's
 * SQLite; each call is best-effort and must not throw.
 */
export interface ReportUpOutbox {
  /** Store a report-up as it is queued, or, with `held`, one that came back after
   *  a person's Stop (see `hold`). Null when it could not be written. */
  record(item: ReportUp, opts?: { held?: boolean }): string | null
  /** Unsettled report-ups for this engine's room to send, oldest first, each with
   *  how many times it was already sent again. Not the held ones. */
  pending(): Array<{ id: string; item: ReportUp; replays: number }>
  /** Count one more replay of each. False when the write failed. */
  markReplayed(ids: string[]): boolean
  /** Close each that is still pending (the first settlement wins). False when
   *  the write failed. */
  settle(ids: string[], how: ReportUpSettlement): boolean
  /** A person's Stop: these start no run from now on, and ride the recipient's next
   *  one. False when the write failed. */
  hold(ids: string[]): boolean
  /** Report-ups for this engine's room that a Stop held, oldest first. */
  held(): Array<{ id: string; item: ReportUp }>
}

/**
 * The engine's view of the saved wakes of this room's tasks (`task_wakes`). A claim
 * hands a run the rows waiting on its task, and every run's close settles what it
 * carried in the same write, so what is left to the engine is small. Each call is
 * best-effort and must not throw.
 */
export interface TaskWakeOutbox {
  /** Wakes a person is behind that wait on this task: what a run ending well has
   *  not heard. A row a Stop held is not among them. */
  fromPersonWaiting(taskId: string): Array<{ id: string; commentIds: string[] }>
  /** Close each that is still open. False when the write failed. */
  settle(ids: string[], how: TaskWakeSettlement): boolean
  /** The run with this execution ended well: everything it carries was heard, the
   *  comments steered into it included. False when the write failed. */
  settleCarriedBy?(execId: string): boolean
  /** A person's Stop: every open row of this room starts no run from now on, and
   *  rides its task's next one. False when the write failed. */
  holdAll(): boolean
  /** The engine left this task's wakes waiting, and why. */
  noteSkip?(taskId: string, reason: WakeSkipReason): void
}

/**
 * What checking a task's work found (see {@link WorkCheck}):
 *  • `pass`    the check passed; the task may be marked done;
 *  • `retry`   it failed with an attempt left, and the host sent the task back to
 *              `in_progress`; the agent gets `fixNote` and tries again;
 *  • `failed`  it failed on the last attempt, and the host moved the task to
 *              `blocked`; `reason` says what failed;
 *  • `decided` a person moved the task while it was checked, so the check does
 *              not speak for it;
 *  • `unchecked` it turned out there was nothing the check could look at, the same
 *              as `prepare` answering null.
 */
export type WorkCheckResult =
  | { verdict: 'pass' }
  | { verdict: 'retry'; fixNote: string }
  | { verdict: 'failed'; reason: string }
  | { verdict: 'decided' }
  | { verdict: 'unchecked' }

/**
 * A check `prepare` handed back. Calling it runs the check. `hold`, when the host
 * has one, comes first: it resolves once the check may run, because nothing else
 * of the team is working in what the check looks at. It holds no run slot and no
 * budget, and nothing a run waits on, so no run's start is delayed by it.
 *
 * The engine bounds the wait. `signal` aborts when the wait is over regardless (its
 * limit ran out, a person moved the card, a Stop, a teardown), and `hold` then
 * resolves at once. What it resolves with gives the check's place back; the engine
 * calls it once the check's outcome has been acted on, so a fix round or a next
 * step that outcome started is already going when the next check looks.
 */
export interface PreparedWorkCheck {
  (): Promise<WorkCheckResult>
  hold?(signal: AbortSignal): Promise<() => void>
  /** A teammate worked in what the check looks at during this run, so what changed there
   *  may not be this run's. A check passing it says nothing about a run that said nothing. */
  sharedFolder?: boolean
}

/**
 * The host's check of a task's work, the same one the task runner applies.
 * `begin` runs right before a fresh run of the task is delivered, so the host
 * can note what the work starts from; a fix round is not a fresh run. `prepare`
 * runs when the run ended well, and answers null when there is nothing to check
 * (the team has no check, the run changed nothing, the runtime has no folder to
 * check). Otherwise it hands back the check, which the engine runs detached: it
 * can take minutes, and the run's drain must not wait on it.
 */
export interface WorkCheck {
  begin(taskId: string, agentId: string): Promise<void>
  prepare(taskId: string, agentId: string): Promise<PreparedWorkCheck | null>
}

export interface BoardOrchestratorDeps {
  /**
   * What holds a run of this agent on this task back right now, in words for the
   * task's trail, or null when it may start: a pause, which only the host can read.
   * Absent: nothing does.
   */
  runHeldBy?: (run: { agentId: string; taskId: string | null }) => string | null
  teamId: string
  board: EngineBoardClient
  /** Current participant roster (read fresh each event so adds/removes flow through). */
  known: () => KnownAgent[]
  /** The team's reduce point — reflections are delivered here for synthesis. */
  leaderAgentId: () => string | null
  /** Resolve a participant's team-scoped sessionKey. */
  sessionKeyForAgent: (agentId: string) => string | null
  /** Recover the agentId that owns a sessionKey. */
  agentIdForSession: (sessionKey: string) => string | null
  /**
   * Deliver a message to a session (nudge-queued adapter.start under the hood).
   *
   * `origin` is REQUIRED, not inferred: the host used to work out whether a turn
   * was a delegated worker's or the user-facing leader's by asking this engine
   * whether the session still had a task, and that answer goes stale the instant
   * `completeForSession` forgets the session. See {@link TurnOrigin}.
   */
  deliver: (
    targetSessionKey: string,
    targetAgentId: string,
    task: string,
    origin: TurnOrigin,
  ) => Promise<void>
  /** Monotonic stop generation; in-flight work bails when it changes. */
  stopGen: () => number
  /**
   * Is THIS process actively driving a run on `sessionKey` right now? Consulted
   * only by {@link BoardOrchestrator.detachTask}, which must never free a session
   * that still has a live run: freeing it would let the ready-pump start a SECOND
   * concurrent run on it, breaking the one-run-per-session invariant.
   *
   * The host answers from the same map it already uses for liveness (the server's
   * `abortMap`), rather than a marker maintained for this question alone — that
   * map is populated only after `adapter.start` resolves and cleared on BOTH the
   * terminal and no-terminal paths, so it cannot leak a permanent "busy" that
   * would make detach refuse forever. Omitted ⇒ never busy.
   */
  isSessionBusy?: (sessionKey: string) => boolean
  /**
   * Is ANY run (a user turn, a reflection, a task) in flight or queued on this
   * session? A task must not be bound to a session in that state. The engine maps
   * a session to at most one task and completes that task on the session's next
   * successful terminal, so binding a task behind someone else's turn makes THAT
   * turn's reply the task's output, and the task's own run then executes unmapped,
   * where its reply lands in the team chat as if the agent had spoken unprompted.
   * An occupied session's work is deferred instead and fired when the session's
   * current turn ends. Omitted ⇒ only a session running a task counts as occupied.
   */
  isSessionOccupied?: (sessionKey: string) => boolean
  /** Would a hard budget cap refuse a run of this task now, and why? Asked of a task whose
   *  last run found no room in a budget, before anything on its card moves, so a long wait
   *  for the room writes no rows. `paused` means the room is not coming back by itself. A
   *  host without it finds out by trying. */
  budgetRefusal?: (taskId: string, agentId: string) => 'paused' | 'held' | null
  /** Is the engine held (a stop or an update under way)? A retry's wait that ends then
   *  leaves the task for the pass the host runs when the hold lifts. */
  held?: () => boolean
  /**
   * Is the host holding this session's delivery in its run queue: accepted, but
   * waiting for one of the process's run slots before it starts? The host settles
   * such a delivery as delivered when it queues it, so the engine never waits on a
   * slot (a lead's run waiting on its delegate's start while holding a slot would
   * deadlock the cap). Queued is waiting, not silence, so the idle watchdog keeps
   * the session's clock current instead of failing it. Omitted ⇒ nothing queues.
   */
  isRunQueued?: (sessionKey: string) => boolean
  /** A board mutation the orchestrator made (projection-store feed). Optional. */
  onBoardChange?: (change: BoardChange) => void
  /** Append a visible narration entry to a session's transcript. Optional.
   *  Returns false when an `alert` could not be written anywhere, so the engine
   *  does not give up a report-up nobody was told about. */
  narrate?: (sessionKey: string, text: string, kind?: NarrationKind) => boolean | void
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
  onCapHit?: (info: CapHit) => void
  /** Heuristic: is this delegation risky enough to need leader approval? Optional. */
  isRiskyDelegation?: (signal: DelegationSignal) => boolean
  /**
   * Surface a risky delegation on the LEADER's approval queue and await the
   * resolution (the server reuses the DB-mediated `tool_call_approvals` handshake;
   * its TTL + poll-deadline give the timeout-not-deadlock guarantee; nothing is
   * remembered, so every risky delegation asks). Optional; omitted ⇒ delegations
   * are never gated.
   */
  requestDelegationApproval?: (input: {
    leaderAgentId: string
    targetAgentId: string
    targetAgentName: string
    task: string
    /** The task the delegating run works on, when it works on one. A lead's own
     *  turn has none, and the hand-off's task does not exist until it is allowed. */
    taskId?: string | null
  }) => Promise<'allow_once' | 'allow_always' | 'deny' | 'expired' | 'timeout'>
  /**
   * Abort a session's LIVE run (the host wires it to its abort map). Called when
   * the engine fails a delegation whose run may still be executing — the idle
   * watchdog and a session-close — so a failed task never leaves a zombie run
   * burning tokens behind it. Optional + best-effort: the drain idle guard is
   * the outer backstop for a run that ignores the abort.
   */
  abortSession?: (sessionKey: string) => void
  /** Injectable clock for the idle watchdog (tests). Defaults to `Date.now`. */
  now?: () => number
  /**
   * How often the host calls `sweepStaleSessions`. Given it, the watchdog can tell
   * a suspended process from a silent delegate: a gap between two sweeps far
   * longer than this means the machine slept, and that time is left off every
   * idle clock, so closing a laptop's lid does not fail every in-flight
   * delegation on wake. Omitted (a caller that sweeps irregularly, like the
   * contract suite), every gap counts as awake time.
   */
  sweepIntervalMs?: number
  /**
   * The durable store for `[Task Update]` items (see {@link ReportUpOutbox}).
   * The host must hand `origin.reportUpIds` back on the stamp of the run it
   * delivers, so the engine can settle them when that run ends, and call
   * `onRunNotStarted` when a delivery it accepted never started. Omitted ⇒
   * report-ups live in memory only and a restart can lose them.
   */
  reportUps?: ReportUpOutbox
  /**
   * Check a task's work before it counts as done (see {@link WorkCheck}). While
   * the check runs the agent's session stays bound to the task, so no other task
   * is given to it, its other replies are not the task's result, and the idle
   * watchdog leaves it alone. Omitted ⇒ a run that ends well is done at once.
   */
  workCheck?: WorkCheck
  /**
   * The saved wakes of this room's tasks (see {@link TaskWakeOutbox}). Given it, a
   * person's comment a run did not hear gets a turn of its own before Done. The host
   * must hand `origin.wakeIds` back on the stamp of the run it delivers. Omitted ⇒
   * no wakes.
   */
  taskWakes?: TaskWakeOutbox
}

export interface BoardOrchestrator {
  /**
   * Feed one normalized event observed on `sessionKey`. `run` is the host's stamp
   * for the run that produced it: a follow-up's terminal is recorded on its task
   * and never treated as the session's task run, and a run delivered before a
   * Stop starts no new work. Omitted means neither (a direct call).
   */
  onEvent(sessionKey: string, event: RuntimeEvent, run?: RunStamp): Promise<void>
  /** The board task a session is currently executing, if any (for obs correlation). */
  taskForSession(sessionKey: string): string | null
  /**
   * The execution row of the run a session is doing for its task. The host's drain
   * records the run's cost on it, because the engine closes its rows without a cost
   * and a Stop or the idle watchdog closes a row before the run's own terminal
   * arrives. Null for a turn that runs no task (a leader or user turn) and for a task
   * re-attached by resume(), whose run belonged to a process that is gone.
   */
  execForSession(sessionKey: string): string | null
  /**
   * Fail any delegated child that has emitted no lifecycle event for longer than
   * `DELEGATION_IDLE_TIMEOUT_MS` — reflects the timeout to the leader so it is
   * never left standing. Driven by an interval in the server orchestrator
   * (`teamOrchestrator`); the contract suite drives it directly. Time the process
   * spent suspended (see `sweepIntervalMs`) does not count as silence.
   */
  sweepStaleSessions(): Promise<void>
  /**
   * A session's observer ended (connection drop / teardown of one session) while
   * a delegation was still in flight: fail it so the leader learns. `run` is the
   * same stamp `onEvent` takes: a follow-up that ended is recorded on its task.
   */
  onSessionClosed(sessionKey: string, run?: RunStamp): Promise<void>
  /**
   * Re-attach to durable in-flight work on (re)mount: track `in_progress` tasks
   * so their completions/timeouts are still handled, and fire any plan step left
   * ready (so a refresh / team re-open resumes a stalled plan).
   */
  resume(): Promise<void>
  /**
   * Make a user Stop DURABLE, synchronously with the Stop itself — never
   * contingent on the aborts' `done:aborted` round-trip (a restart or a lost
   * terminal would otherwise reclassify stopped work as infra death, and the
   * dispatch pump would refire the very cascade the user halted). Cancels the
   * open execution of every tracked run and tombstones every not-yet-fired
   * ready delegation with a created-and-cancelled execution row — the durable
   * "user stopped this" marker the fire policy reads. The host calls this from
   * its Stop handler, alongside (not instead of) the aborts. NOT called on
   * dispose/shutdown — parked work is promised to resume.
   */
  markStopped(): Promise<void>
  /**
   * Forget the session currently tracking `taskId`, because the task was
   * released OUT OF BAND — by the stale sweep, an orphan reap, or a human moving
   * the card. Without this the engine keeps a session mapped to work nobody is
   * running: `fireTask` refuses every re-fire on `sessionToTask.has(...)`, and
   * the idle watchdog eventually fails a task no process owns, cancelling its
   * dependents. Both are permanent, and both read to the user as the delegate
   * going silent.
   *
   * REFUSES (returns false) while the host reports a live run on that session —
   * see `isSessionBusy`. Returns false too when no session is tracking the task,
   * which is the common case and not an error.
   *
   * Deliberately NOT the same thing as gating `resume()`'s attach: `markStopped`
   * iterates `sessionToTask` to tombstone tracked work, so refusing to attach
   * after a restart would make a user Stop a silent no-op for the whole sweep
   * window. Detaching on the release keeps that arm populated until the board
   * itself says the work is no longer owned.
   */
  detachTask(taskId: string): boolean
  /**
   * Run one specific `todo` task now, because a PERSON asked for it: a task they
   * created for an agent from the board, a retry of one that failed, a card they
   * just assigned. Resolves the agent from the task's durable binding and fires it
   * through the same claim → execution → deliver path the ready-pump uses, with
   * one difference: the execution-ledger fire policy is waived for this run. That
   * policy stops the AUTOMATIC pump from re-firing work the user stopped or that
   * keeps failing; it is not meant to overrule the user asking again.
   *
   * A person-assigned task (see `isHumanAssignment`) reports to that person on its
   * card: its result is recorded on the board and is not delivered to the team
   * lead as a `[Task Update]`.
   */
  dispatchTask(taskId: string): Promise<DispatchOutcome>
  /**
   * A PERSON moved this task's card on the board, already written. Their move
   * is the final word on the run that was working on it:
   *   · a run in flight is aborted and its execution closed as cancelled, so it
   *     stops spending and its late result can never override the move;
   *   · to Done or Cancelled, whoever delegated the task is told a person
   *     decided it (never asked to retry a task a person cancelled); a task a
   *     person assigned reports to nobody, as always;
   *   · back to To do while it was running, it starts again from the beginning
   *     with the same agent, which is what the board's confirm promised.
   * `cancelledDependents` are the plan steps the caller cancelled with it, so
   * the delegator hears the chain ended too.
   */
  personMovedTask(
    taskId: string,
    to: string,
    opts?: { cancelledDependents?: Array<{ id: string; title?: string | null }> },
  ): Promise<void>
  /**
   * A pause covers these runs, so they stop within seconds. Not a person's Stop,
   * which is a decision about the task: each run covered is aborted, closed as
   * stopped by a pause (`PAUSED_RUN_CLASS`), and its task goes back to To do with
   * its binding, to fire again when nothing refuses its claim. Nobody is told but
   * the task's own trail. A task whose run is over and whose work check is under
   * way is left to its check. Resolves with the tasks it stopped.
   */
  pauseRuns(
    covers: (run: { agentId: string; taskId: string }) => boolean,
    note: string,
  ): Promise<string[]>
  /**
   * A delivery the host had accepted (its `deliver` resolved, with the message
   * queued behind the recipient's run) never started a run. The report-ups it
   * carried (`run.reportUpIds`) go back to pending, and the next sweep sends them
   * again. A start that fails while `deliver` is still pending is the engine's
   * own retry path; the host does not report it here.
   */
  onRunNotStarted(run: RunStamp): void
  /**
   * A run of `sessionKey`'s agent is about to start: hand it the report-ups a Stop
   * held for it and, for a run of a task (`taskId`), what came back from the work that
   * task handed out, as text for its context, with the ids to carry on its stamp. Null
   * when there are none. Their outcome follows that run: settled on a successful
   * end, and waiting again after any other.
   */
  takeHeldReportUps(sessionKey: string, taskId?: string): { ids: string[]; text: string } | null
  /**
   * How many work checks (see WorkCheck) this engine is running or waiting to
   * follow with a fix round. No run is open meanwhile, so a host that unloads
   * idle engines must count these as work in flight.
   */
  checksInFlight(): number
  /** Drop all in-memory tracking + timers (team switch / teardown). */
  reset(): void
}

/** A round on a task that opens a new execution with no claim: the same agent goes
 *  again, told why. */
interface PendingRound {
  taskId: string
  summary: string
  /** What it opens with, before the brief. */
  lead: string
  reason: TaskRunReason
  /** The saved wakes it answers. */
  wakeIds?: string[]
  /** How the run before it closes, when that is not the success a run that ended well
   *  was. Its result is kept either way. */
  closeAs?: Pick<CompleteExecutionOutcome, 'status' | 'error'>
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
  const openToolCall = new Set<string>() // sessions currently inside a tool call (longer idle allowance)
  const recentlyTerminated = new Map<string, number>() // child session → terminal ts (late-replay guard)
  const handOffsByTurn = new Map<string, { count: number; at: number; foundOpen?: boolean }>() // `${session}:${run}` → hand-offs this turn, across its events, and whether one found its work already open (age-reaped)
  const humanTasks = new Set<string>() // task ids a PERSON assigned: they report to the card, not an agent
  const waitingOnTurn = new Set<string>() // sessions with work deferred behind a non-task turn (pump on its terminal)
  const takingSession = new Set<string>() // sessions a start has taken while its claim is out (see sessionTakesTask)
  const forceFire = new Set<string>() // task ids a person asked to run: waive the auto-fire ledger policy once
  const pendingStart = new Map<string, string>() // session -> task whose delivery has not started yet (watchdog allowance)
  const handingOut = new Set<string>() // sessions whose task run ended well and whose last hand-offs are still going out (no run to go silent)
  const unheardAtLastEnd = new Map<string, string>() // task id -> the report-ups its last run ended without hearing (see parkForHandedOutWork)
  const refusalTurns = new Map<string, number>() // task id -> turns its agent got for refused hand-offs alone (see MAX_REFUSAL_TURNS)
  const unsavedReports: ReportUp[] = [] // reports whose outbox write failed, on a task still open: only memory holds them, until its next run
  const retryWaits = new Map<string, ReturnType<typeof setAwakeTimeout>>() // task id → the awake-time wait before the pump may try it again
  const roundLeads = new Map<string, string>() // task id → what its current round was told, for a retry of that round

  // Reflection batch state — closure-owned so reset() collects it (no leak).
  // `toAgentId` is the recipient: a sub-task reports to its IMMEDIATE delegator
  // (so a mid-chain delegator isn't left standing); a top-level task reports to
  // the leader. `null` ⇒ resolve to the leader at flush time.
  const reflectQueue: Array<
    ReportUp & {
      /** Delivery-retry counter (bounded by MAX_REFLECT_ATTEMPTS). */
      attempts?: number
      /** Its row in the durable outbox, when the host keeps one. */
      outboxId?: string
    }
  > = []
  let reflectTimer: ReturnType<typeof setTimeout> | null = null
  // Outbox ids THIS engine holds: queued, being flushed, or handed to a run that
  // has not ended. `resume()` replays only the pending rows outside it, so a row
  // is sent again only by the next engine for the room, never twice by this one.
  const reportUpsInHand = new Set<string>()
  // Outbox ids a pause stopped on their way: their next send is not counted as a try.
  const returnedByPause = new Set<string>()
  // Session -> the task whose finished work is being checked (see WorkCheck),
  // and which check: a person's move ends the check's say over the task, and a
  // later check of the same task (after a Retry) is another one. The session
  // stays bound to the task meanwhile; keyed by task too, so a session a
  // person's move freed and the pump rebound is not mistaken for one under check.
  const checking = new Map<string, { taskId: string; check: number }>()
  let nextCheck = 0
  const isChecking = (sessionKey: string): boolean => {
    const c = checking.get(sessionKey)
    return c !== undefined && sessionToTask.get(sessionKey) === c.taskId
  }
  // Session -> a check still waiting for its turn to run (see holdThenCheck): it
  // is under check too. Whoever takes an entry out ended the wait and owns what
  // happens next; one still here when the wait ends goes on to its check.
  const heldChecks = new Map<
    string,
    { taskId: string; check: number; summary: string; cancel: AbortController }
  >()
  /** End a wait that something else now decides (a person's move, a teardown). */
  const endHold = (sessionKey: string): void => {
    const held = heldChecks.get(sessionKey)
    if (!held) return
    heldChecks.delete(sessionKey)
    held.cancel.abort()
  }
  // Session -> a fix round, or the turn a person's comment gets before Done (see
  // offerCommentTurn), waiting for another turn on the session to end. The session
  // stays under check until it goes out (see runWorkCheck).
  const pendingFix = new Map<string, PendingRound>()
  // Session -> a check that could not run whose task the board would not move to
  // Blocked. It stays under check, short of Done, and the sweep tries the move
  // again (see retryPark).
  const pendingPark = new Map<
    string,
    {
      taskId: string
      summary: string
      reason: string
      checkId: number
      /** The reason is not on the task yet: comment it once the move lands. */
      comment?: boolean
    }
  >()
  // Held outbox ids whose settlement could not be written yet, with what they
  // were settled as. The sweep writes them (see retrySettlements).
  const settleLater = new Map<string, ReportUpSettlement>()
  // Outbox ids a Stop let go of while a run may still be carrying them: that run
  // finishing is still the first settlement, even though nothing holds them now.
  const heldByStop = new Set<string>()

  /** Let go of a wait on this task: its next start is decided without it. */
  const endRetryWait = (taskId: string): void => {
    retryWaits.get(taskId)?.clear()
    retryWaits.delete(taskId)
  }
  /** Wait out `ms` of awake time, then pump. While it runs the pump leaves the task
   *  alone, on top of what the ledger says, which is all a restart keeps. It holds no
   *  run slot and no budget hold: the run gave both back before its ending got here. */
  const beginRetryWait = (taskId: string, ms: number): void => {
    endRetryWait(taskId)
    retryWaits.set(
      taskId,
      setAwakeTimeout(() => {
        retryWaits.delete(taskId)
        if (deps.held?.()) return
        void pumpReady().catch(() => undefined)
      }, ms),
    )
  }

  const now = deps.now ?? (() => Date.now())
  // Baselined at creation, so a sleep before the first sweep is caught too.
  const suspendedFor =
    deps.sweepIntervalMs != null ? createSuspendDetector(deps.sweepIntervalMs, now()) : null
  const emit = (change: BoardChange): void => deps.onBoardChange?.(change)

  /** Who a task's result reports back to: its delegator (reduce-point), else the leader. */
  const reflectTargetFor = (taskId: string | null): string | null =>
    (taskId ? taskReflectTo.get(taskId) : null) ?? deps.leaderAgentId()

  /** Name of an agent (for the reflection header), or a neutral fallback. */
  const nameOf = (agentId: string | null): string =>
    (agentId && deps.known().find((a) => a.id === agentId)?.name) || 'A teammate'

  /**
   * The delegation depth gate: may `sourceTaskId` still spawn children? Shared by
   * immediate delegation AND plan creation — `startPlan` bypasses `spawn` entirely,
   * so without this the two paths would enforce different ceilings.
   */
  async function maySpawnFrom(sourceTaskId: string | null): Promise<boolean> {
    return checkDepthCap({ depth: await depthOf(sourceTaskId), max: MAX_SPAWN_DEPTH }).ok
  }

  async function depthOf(taskId: string | null): Promise<number> {
    if (!taskId) return 0
    const detail = await deps.board.getTask(taskId)
    return detail ? detail.ancestors.length : 0
  }

  // ── sourceDelegationId codec ────────────────────────────────────────────────
  // The durable task carries its target agent (for pump-firing after a release /
  // restart) and its delegator (the reduce-point recipient, recovered by `resume`
  // so a mid-chain delegator isn't re-routed to the leader). Segments use
  // `:agent:`/`:reflectTo:` markers; agent ids + run ids never contain a colon,
  // so `[^:]+` decodes each unambiguously (and an OLD `:agent:`-only sdid still
  // decodes its agent). EVERY delegation now carries `:agent:` — plain ones
  // included — so a sweep/orphan release is re-fireable instead of stranding the
  // work forever ("delegated, waiting" with nothing coming). What used to make
  // omission necessary — "a stop/server release must never re-fire it" — is now
  // enforced where the distinction actually lives: the ready-pump's fire policy
  // reads the task's execution ledger, and a `cancelled` last run (the user-Stop
  // outcome `releaseClaimed` records) is never auto-refired.
  //
  // A task a PERSON assigned carries `:agent:` but no `:reflectTo:` and an
  // `:origin:human` marker (`encodeHumanAssignment` in @clawboo/board-core): its
  // result is for that person, read on the card, so no agent is resolved to
  // report it to. `humanTasks` mirrors the marker for the tasks this engine fires.
  const sdidAgent = (sdid: string): string | null => delegationTargetOf(sdid)
  const sdidReflectTo = (sdid: string): string | null =>
    sdid.match(/:reflectTo:([^:]+)/)?.[1] ?? null
  const sdidOf = (task: BoardTask): string =>
    typeof task['sourceDelegationId'] === 'string' ? (task['sourceDelegationId'] as string) : ''

  /** The task `recipient` was running when it delegated `task`: the parent, when the
   *  durable row says the result reports to `recipient`. A mismatch means the
   *  recipient is only the leader fallback. While that task is open the result waits
   *  for its next run, the team lead's too (see flushReflection). */
  const followUpScope = (task: BoardTask, recipient: string | null): string | undefined => {
    if (!recipient) return undefined
    const parent = typeof task.parentTaskId === 'string' ? task.parentTaskId : ''
    return parent && sdidReflectTo(sdidOf(task)) === recipient ? parent : undefined
  }

  /** {@link followUpScope} by task id. */
  async function followUpScopeOf(
    taskId: string,
    recipient: string | null,
  ): Promise<string | undefined> {
    if (!recipient) return undefined
    const d = await deps.board.getTask(taskId)
    return d ? followUpScope(d.task, recipient) : undefined
  }

  /** The brief an agent receives for a task. An engine delegation stores the whole
   *  ask as its description (its title is a prefix of it); a task a person wrote
   *  has a short title plus optional details, and the agent needs both. */
  const briefFor = (task: BoardTask): string => {
    const title = (task.title ?? '').trim()
    const description = typeof task.description === 'string' ? task.description.trim() : ''
    if (!description) return title
    if (!title || description.startsWith(title)) return description
    return `${title}\n\n${description}`
  }
  const encodeSdid = (
    runId: string,
    opts: { agentId?: string; reflectTo: string | null },
  ): string =>
    `${runId}:deleg` +
    (opts.agentId ? `:agent:${opts.agentId}` : '') +
    `:reflectTo:${opts.reflectTo ?? ''}`

  /** Which turn an event belongs to: its delivery, which the host stamps once per
   *  delivery. An event's own run id is only the fallback for a caller with no stamp:
   *  a runtime that resumes a native thread repeats it on every turn. */
  const turnIdOf = (event: RuntimeEvent, run?: RunStamp): string =>
    run?.deliveryId ?? (event.runId || NO_RUN_ID)

  /** What ties a hand-off to its turn: the key that makes a replay return its task
   *  (the team, the turn, the rest of `scope`, and the words), and the turn itself,
   *  whose own tasks do not count as repeats of each other. An event with no turn has
   *  neither, since nothing then says two hand-offs are the same one. */
  const handOffIdentity = (
    scope: readonly string[],
    text: string,
  ): Pick<HandOffInput, 'handOffKey' | 'turnId'> => {
    const turnId = scope[1]
    return !turnId || turnId === NO_RUN_ID
      ? {}
      : { handOffKey: { scope: [deps.teamId, ...scope], text }, turnId }
  }

  // ── failure loop breaker ────────────────────────────────────────────────────
  const failKey = delegationFailureKey
  const noteFailure = (targetAgentId: string, task: string): Promise<void> =>
    deps.board.noteDelegationFailure(deps.teamId, targetAgentId, failKey(targetAgentId, task))
  const clearFailure = (targetAgentId: string, task: string): Promise<void> =>
    deps.board.clearDelegationFailure(deps.teamId, targetAgentId, failKey(targetAgentId, task))

  // ── the hand-off cycle guard ────────────────────────────────────────────────
  /** The open task `targetAgentId` delegated on the sender's chain, or null. The
   *  lead is exempt: every agent is told to take a blocker there, and it delegated
   *  most top-level tasks. A chain that cannot be read lets the hand-off through;
   *  the depth cap still bounds it. `ownTask` is the task the sender's run is on. */
  async function cycleFor(
    targetAgentId: string,
    sourceTaskId: string | null,
    ownTask: boolean,
  ): Promise<HandOffLink | null> {
    if (!sourceTaskId || targetAgentId === deps.leaderAgentId()) return null
    const chain = await deps.board.handOffChain(sourceTaskId)
    return chain
      ? findHandOffCycle(chain, targetAgentId, { ownTaskId: ownTask ? sourceTaskId : null })
      : null
  }

  /**
   * Is this the first refusal of this hand-off from this sender? The note arrives as
   * a new turn, and a sender that repeats the hand-off in it has a new run id, so
   * without this each refusal starts the next. Once per sender, target and words while
   * the entry lives, as for a hand-off no teammate can take.
   */
  const firstRefusal = (
    kind: string,
    sender: string | null,
    target: string,
    words: string,
  ): boolean => {
    const key = `refused:${kind}:${sender}:${target}:${normalizeTaskTitle(words)}`
    if (processed.has(key)) return false
    processed.set(key, now())
    return true
  }

  /** Is this the first note to this sender that a hand-off found this task? */
  const firstDuplicateNote = (sender: string | null, taskId: string): boolean =>
    firstRefusal('duplicate', sender, taskId, '')

  /** How a refusal names a task: its readable id, else its title. */
  const nameOfLink = (link: HandOffLink): string =>
    link.identifier ?? `"${link.title.slice(0, 60)}"`

  /** The words for a hand-off going back up its own chain. */
  const cycleRefusal = (targetName: string, link: HandOffLink): string =>
    `${targetName} handed out ${nameOfLink(link)}, which is still open and waiting on this work, so the board did not hand it back to them. Each would wait on the other. Finish your part and your result reports back on its own. For a blocker, go to the team lead.`

  /** The words for a hand-off a cap refused. */
  function capRefusal(refused: Extract<HandOffResult, { ok: false }>, targetName: string): string {
    const count = refused.count ?? refused.max ?? 0
    if (refused.reason === 'child_cap')
      return `This task already has ${count} sub-tasks, the most one task can have (${refused.max}), so the hand-off to ${targetName} did not start. Finished and cancelled sub-tasks still count. Do the work yourself, or tell the person.`
    if (refused.reason === 'root_rate_cap') {
      const mins = Math.round((refused.windowMs ?? 0) / 60_000)
      return `${count} top-level tasks were made in the last ${mins} minutes, the most allowed (${refused.max}), so the hand-off to ${targetName} did not start. Hand out less at once, or tell the person.`
    }
    return `The hand-off to ${targetName} was refused (max delegation depth ${MAX_SPAWN_DEPTH} reached, or its parent task is gone). Handle it directly or report it back.`
  }

  /** The words for a hand-off that found its task already on the board. */
  function duplicateNote(task: BoardTask, delegatorAgentId: string | null): string {
    const name = task.identifier ?? `"${(task.title ?? '').slice(0, 60)}"`
    const owner = targetForTask(task) ?? (task.assigneeAgentId as string | null | undefined) ?? null
    const reportsTo = sdidReflectTo(sdidOf(task))
    const result = isHumanAssignment(sdidOf(task))
      ? 'Its result goes to the person, on its card.'
      : reportsTo === delegatorAgentId
        ? 'Its result will reach you when it ends.'
        : `Its result goes to ${nameOf(reportsTo ?? deps.leaderAgentId())}.`
    return `An open task with these words is already on the board: ${name}${owner ? `, with ${nameOf(owner)}` : ''}. The board did not make a second one. ${result}`
  }

  /** Did the user press Stop since this delegation was dispatched? (Stop = clean
   *  pause, never a chain-destroying failure.) */
  const stopChangedFor = (sessionKey: string): boolean =>
    sessionStartGen.has(sessionKey) && sessionStartGen.get(sessionKey) !== deps.stopGen()

  /** May a task be bound to this session right now? Not while it runs a task (one
   *  task per session), not while another start has it (`takingSession`: the session
   *  is mapped only after the claim's await, and a second start landing inside that
   *  wait would overwrite the first and finish the wrong task), and not while ANY
   *  other turn is in flight or queued on it (see `isSessionOccupied`). A session
   *  that is busy with a non-task turn is remembered, so its terminal fires the work
   *  that had to wait. */
  const sessionTakesTask = (sessionKey: string): boolean => {
    if (sessionToTask.has(sessionKey) || takingSession.has(sessionKey)) return false
    if (deps.isSessionOccupied?.(sessionKey)) {
      waitingOnTurn.add(sessionKey)
      return false
    }
    return true
  }

  /** Drop all in-memory tracking for a session's current task. */
  /** See {@link BoardOrchestrator.detachTask}. */
  const detachTask = (taskId: string): boolean => {
    let found: string | null = null
    for (const [sessionKey, tid] of sessionToTask) {
      if (tid === taskId) {
        found = sessionKey
        break
      }
    }
    if (!found) return false
    // A live run still owns this session; freeing it would let the pump start a
    // second one beside it. The run's own terminal will release it shortly, and
    // a task released underneath a live run already degrades to the documented
    // late-result comment path.
    if (deps.isSessionBusy?.(found)) {
      // Another turn is on the session, so it cannot be freed. A check still waiting
      // need not keep its place meanwhile: it goes on, and finds the task moved on.
      heldChecks.get(found)?.cancel.abort()
      return false
    }
    // A check still waiting ends with the task: nothing will run it now.
    const held = heldChecks.get(found)
    if (held) {
      endHold(found)
      checking.delete(found)
      const report = reportOf(held.summary)
      if (report)
        void deps.board
          .addComment(taskId, report, 'agent', deps.agentIdForSession(found) ?? undefined)
          .catch(() => undefined)
    }
    // Drop the tracking WITHOUT arming the late-replay guard. A detach is an
    // out-of-band release (stale sweep, orphan reap, a human moving the card),
    // the agent's session is usually still alive, and `recentlyTerminated` would
    // silently drop every <delegate>/<plan> it emits for the next 60s: the exact
    // silent-loss failure detach exists to prevent. The guard is for RUN
    // terminals, where a stale summary really can replay.
    dropSessionTracking(found)
    // Usually the exec this task was tracking is already closed by whatever
    // released it (the sweep's `timed_out`). When the run had not started yet
    // (its delivery was waiting for the agent), nothing closed it, and a row
    // left `running` reads as "someone owns this" forever: the pump never
    // re-fires it and it never surfaces as needing a person. Close it as an
    // infrastructure release, which the fire policy may re-fire. A row that is
    // already terminal is left as it is.
    const execId = taskToExec.get(taskId)
    taskToExec.delete(taskId)
    if (execId) {
      void deps.board
        .completeExecution(
          execId,
          held
            ? { status: 'cancelled', summary: reportOf(held.summary) }
            : { status: 'failed', error: 'Released before its run started.' },
        )
        .catch(() => undefined)
    }
    return true
  }

  /** Tracking teardown alone, no replay guard. Callers that observed a RUN
   *  terminal want `forgetSession`, which also arms `recentlyTerminated`. */
  const dropSessionTracking = (sessionKey: string): void => {
    sessionToTask.delete(sessionKey)
    sessionStartGen.delete(sessionKey)
    lastActivityAt.delete(sessionKey)
    openToolCall.delete(sessionKey)
  }
  const forgetSession = (sessionKey: string): void => {
    dropSessionTracking(sessionKey)
    recentlyTerminated.set(sessionKey, now())
  }

  /** A run's report as the board keeps it: compacted (pass-through-safe) and capped. */
  const reportOf = (summary: string): string =>
    (deps.compact ? deps.compact(summary) : summary).slice(0, 20_000)

  /** Release a claimed task back to `todo` and detach its session — the clean
   *  "Stop / re-queue" path: no `blocked`, no cancelDependents, no failure
   *  reflection (those are for a genuine failure, not a user pause). `finished` is
   *  the report of a run that ended well before its work could be checked: this is
   *  the only copy, so it goes on the task and on the closed run, and it waits for
   *  whoever handed the task off (a Stop starts nothing; see holdWorkForNextRun).
   *  `byPerson`: a person's Stop is why, which is what holds the run's wakes.
   *  `pausedBy`: a pause is why, in these words. The run comes back by itself, so its
   *  report stays on the task and nobody is told: the delegator hears when it ends. */
  async function releaseClaimed(
    taskId: string,
    sessionKey: string,
    finished?: string,
    byPerson = true,
    pausedBy?: string,
  ): Promise<void> {
    const report = finished ? reportOf(finished) : ''
    const agentId = report ? deps.agentIdForSession(sessionKey) : null
    const title = taskTitle.get(taskId)
    const human = humanTasks.has(taskId)
    forgetSession(sessionKey)
    humanTasks.delete(taskId)
    const execId = taskToExec.get(taskId)
    if (execId) {
      taskToExec.delete(taskId)
      await deps.board.completeExecution(execId, {
        status: 'cancelled',
        byPerson,
        ...(report ? { summary: report } : {}),
        ...(pausedBy ? { error: pausedBy, errorClass: PAUSED_RUN_CLASS } : {}),
      })
    }
    if (report) await deps.board.addComment(taskId, report, 'agent', agentId ?? undefined)
    if (report && !human && !pausedBy) {
      const to = reflectTargetFor(taskId)
      const scope = await followUpScopeOf(taskId, to)
      holdReflection({
        toAgentId: to,
        by: nameOf(agentId),
        title,
        summary: report,
        outcome: 'aborted',
        taskId,
        ...(scope ? { forTaskId: scope } : {}),
      })
    }
    taskReflectTo.delete(taskId)
    taskTitle.delete(taskId)
    if (pausedBy) {
      // Its agent blocked it, asked a question, or moved it In review for a person:
      // that waits on someone, pause or no pause, so the card and its reason stay. Any
      // other In review takes two moves to To do.
      const task = (await deps.board.getTask(taskId))?.task
      if (task?.status === 'blocked' || (task?.status === 'in_review' && task['waitingOn'] != null))
        return
      if (task?.status === 'in_review') await deps.board.updateStatus(taskId, 'in_progress')
    }
    await deps.board.updateStatus(taskId, 'todo')
    emit({ id: taskId, status: 'todo', assigneeAgentId: null, updatedAt: now() })
    if (pausedBy) await deps.board.addComment(taskId, pausedBy, 'system')
  }

  /** Release whatever task a session is running (no-op if untracked). */
  async function releaseForSession(sessionKey: string): Promise<void> {
    const taskId = sessionToTask.get(sessionKey)
    if (taskId) await releaseClaimed(taskId, sessionKey)
  }

  /** A task's delivery settled (its run started, or the host refused the start).
   *  The idle window counts from the run's start. A Stop that landed while the
   *  delivery waited made the host refuse the start, so no terminal will ever
   *  release the task: release it here. */
  async function settleDelivery(
    taskId: string,
    sessionKey: string,
    startGen: number,
  ): Promise<void> {
    if (sessionToTask.get(sessionKey) !== taskId) return
    if (deps.stopGen() !== startGen) await releaseClaimed(taskId, sessionKey)
    else lastActivityAt.set(sessionKey, now())
  }

  /** Tell the sender of a hand-off nobody can take that it did not start, and
   *  who it can hand work to instead. */
  function reflectUnrouted(
    handOff: UnroutedHandOff,
    sourceAgentId: string,
    delegatorAgentId: string | null,
    sourceTaskId: string | null,
  ): void {
    const mates = deps
      .known()
      .filter((a) => a.id !== sourceAgentId)
      .map((a) => a.name)
    const instead =
      mates.length > 0
        ? `You can hand work to: ${mates.join(', ')}.`
        : 'There is no one else in this room to hand work to.'
    // OpenClaw's `sessions_send` answers for itself, and may have delivered the
    // message to a session outside the room, so its note claims only the board.
    const summary =
      handOff.via === 'sessions_send'
        ? `${handOff.reason === 'self' ? 'You sent this to yourself' : `No teammate in this room is called "${handOff.name}"`}, so no board task was made for it. If OpenClaw delivered it to another session, any answer comes back through OpenClaw, not the board. ${instead}`
        : handOff.reason === 'self'
          ? `You handed this to yourself, so the board did not start it. Do it yourself, or hand it to a teammate. ${instead}`
          : `No teammate here is called "${handOff.name}", so the board did not start this hand-off and nothing will report back to you. ${instead}`
    enqueueReflection({
      toAgentId: delegatorAgentId ?? deps.leaderAgentId(),
      by: handOff.reason === 'self' ? nameOf(sourceAgentId || null) : handOff.name || 'No one',
      title: handOff.task.slice(0, 80),
      summary,
      outcome: 'error',
      ...(sourceTaskId ? { forTaskId: sourceTaskId } : {}),
    })
  }

  /** Create + claim + open-execution + deliver a single immediate delegation.
   *  `delegatorAgentId` is who tried to delegate (the reduce-point recipient for
   *  this child's result, and the one told if the delegation can't be started). */
  async function spawn(
    signal: DelegationSignal,
    sourceTaskId: string | null,
    delegatorAgentId: string | null,
    runId: string,
    /** `sourceTaskId` is the task the sender's run is on, not one it follows up on. */
    ownTask: boolean,
    /** The board found this work already open, so no task is made and the id is null. */
    onFoundOpen?: () => void,
  ): Promise<string | null> {
    const startGen = deps.stopGen()
    // Tell the delegator (not silently drop) whenever a delegation can't start —
    // otherwise it waits forever for an answer that will never come.
    const dropReflect = (summary: string, outcome: TaskUpdateOutcome = 'error'): void =>
      enqueueReflection({
        toAgentId: delegatorAgentId ?? deps.leaderAgentId(),
        by: signal.targetAgentName,
        title: signal.task.slice(0, 80),
        summary,
        outcome,
        ...(sourceTaskId ? { forTaskId: sourceTaskId } : {}),
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
    const breakerKey = failKey(signal.targetAgentId, signal.task)
    const breaker = await deps.board.delegationFailure(
      deps.teamId,
      signal.targetAgentId,
      breakerKey,
    )
    if (breaker.failures >= MAX_DELEGATION_FAILURES) {
      if (!breaker.notified) {
        await deps.board.markDelegationFailureNotified(
          deps.teamId,
          signal.targetAgentId,
          breakerKey,
        )
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

    // Going back up its own chain. Checked before the depth cap, so an agent stopped
    // by both hears the one that says what to do.
    const cycle = await cycleFor(signal.targetAgentId, sourceTaskId, ownTask)
    if (cycle) {
      if (firstRefusal('cycle', delegatorAgentId, signal.targetAgentId, signal.task)) {
        if (sourceTaskId)
          await deps.board.addComment(
            sourceTaskId,
            `Not handed to ${signal.targetAgentName}: they handed out ${nameOfLink(cycle)}, which is still open.`,
            'system',
          )
        dropReflect(cycleRefusal(signal.targetAgentName, cycle), 'not_started')
      }
      return null
    }

    // Bounded depth — enforced via the board ancestor chain, not a prompt.
    if (!(await maySpawnFrom(sourceTaskId))) {
      if (firstRefusal('depth', delegatorAgentId, signal.targetAgentId, signal.task)) {
        if (sourceTaskId)
          await deps.board.addComment(
            sourceTaskId,
            `Spawn depth limit (${MAX_SPAWN_DEPTH}) reached — not delegating "${signal.task.slice(0, 80)}".`,
            'system',
          )
        dropReflect(
          `Delegation to ${signal.targetAgentName} refused — max delegation depth (${MAX_SPAWN_DEPTH}) reached. Handle it directly or report it back.`,
        )
      }
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
          taskId: sourceTaskId,
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
    const deferred = !sessionTakesTask(targetSk)
    // Taken now, because the session is mapped only after the awaits below.
    if (!deferred) takingSession.add(targetSk)
    let task: BoardTask
    try {
      const title = signal.task.slice(0, HAND_OFF_TITLE_CHARS)
      const created = await deps.board.createHandOff({
        title,
        description: signal.task,
        teamId: deps.teamId,
        assigneeRuntime: 'openclaw',
        ...(sourceTaskId ? { parentTaskId: sourceTaskId } : {}),
        // `:agent:` on EVERY delegation (deferred or not) — the target must be
        // recoverable from the durable row so a sweep/orphan release is
        // re-fireable. Stop-vs-refire is the pump policy's job (exec ledger).
        sourceDelegationId: encodeSdid(runId, {
          agentId: signal.targetAgentId,
          reflectTo: delegatorAgentId,
        }),
        ...handOffIdentity(['deleg', runId, signal.targetAgentId], signal.task),
      })
      if (!created.ok) {
        if (created.reason === 'error') {
          dropReflect(
            `Could not create the board task for ${signal.targetAgentName} (server error). The delegation did not start.`,
          )
          return null
        }
        if (created.reason === 'child_cap' || created.reason === 'root_rate_cap')
          deps.onCapHit?.({
            kind: created.reason,
            sourceTaskId,
            ...(created.max != null ? { max: created.max } : {}),
          })
        if (firstRefusal('cap', delegatorAgentId, signal.targetAgentId, signal.task)) {
          const summary = capRefusal(created, signal.targetAgentName)
          if (sourceTaskId) await deps.board.addComment(sourceTaskId, summary, 'system')
          dropReflect(summary, 'not_started')
        }
        return null
      }
      // The task was there already, so nothing starts. A replay of this same hand-off
      // is silent: it was dealt with the first time. A hand-off that found someone
      // else's open task says so, once, or the sender waits on a report it may never
      // get. Once per sender and task, not per run: the note arrives as a new turn, and
      // a sender that repeats the hand-off in it gets no second one.
      if (created.deduplicated) {
        onFoundOpen?.()
        if (
          created.deduplicated === 'title' &&
          firstDuplicateNote(delegatorAgentId, created.task.id)
        )
          dropReflect(duplicateNote(created.task, delegatorAgentId), 'already_open')
        return null
      }
      task = created.task
      taskTitle.set(task.id, title)
      if (delegatorAgentId) taskReflectTo.set(task.id, delegatorAgentId)
      emit({
        id: task.id,
        identifier: task.identifier ?? null,
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

      const claim = await deps.board.claim(task.id, signal.targetAgentId, 'openclaw', {
        executorType: 'openclaw',
        runReason: 'delegation',
      })
      if (!claim.ok) {
        // 409 — someone else owns it; not a loss to the delegator. Drop our residue.
        taskTitle.delete(task.id)
        taskReflectTo.delete(task.id)
        return null
      }

      const exec =
        claim.execution ??
        (await deps.board.createExecution(task.id, 'openclaw', { runReason: 'delegation' }))
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
    } finally {
      if (!deferred) takingSession.delete(targetSk)
    }
    emit({
      id: task.id,
      status: 'in_progress',
      assigneeAgentId: signal.targetAgentId,
      updatedAt: Date.now(),
    })
    await beginWork(task.id, signal.targetAgentId)

    // Stop pressed after the claim but before delivery — release the task so it
    // isn't a permanently in_progress ghost with no run behind it.
    if (deps.stopGen() !== startGen) {
      await releaseClaimed(task.id, targetSk)
      return task.id
    }
    // While the delivery waits to start (behind another run on the agent's lock)
    // the watchdog grants the pending-start allowance instead of the idle one.
    pendingStart.set(targetSk, task.id)
    let delivered = false
    try {
      await deps.deliver(targetSk, signal.targetAgentId, signal.task, {
        kind: 'delegation',
        fromAgentId: reflectTargetFor(task.id),
      })
      delivered = true
    } catch (err) {
      // Delivery rejected (the agent never received the task) — fail it now rather
      // than waiting out the 8-minute watchdog. A refusal says why in its own words.
      await failForSession(
        targetSk,
        'error',
        err instanceof DeliveryRefusedError
          ? err.message
          : `Could not deliver the task to ${signal.targetAgentName} (the message was rejected).`,
        refusedErrorOpts(err),
      )
    } finally {
      if (pendingStart.get(targetSk) === task.id) pendingStart.delete(targetSk)
    }
    if (delivered) await settleDelivery(task.id, targetSk, startGen)
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
    ownTask: boolean,
  ): Promise<void> {
    /** Refuse the whole plan, before any step exists: a plan cut short is worse than
     *  none, since its later steps may rely on the ones left out. */
    const refusePlan = async (summary: string): Promise<void> => {
      if (!firstRefusal('plan', delegatorAgentId, steps[0]?.targetAgentId ?? '', summary)) return
      if (sourceTaskId) await deps.board.addComment(sourceTaskId, summary, 'system')
      enqueueReflection({
        toAgentId: delegatorAgentId ?? deps.leaderAgentId(),
        by: steps[0]?.targetAgentName ?? 'plan',
        summary,
        outcome: 'not_started',
        ...(sourceTaskId ? { forTaskId: sourceTaskId } : {}),
      })
    }
    if (steps.length > MAX_PLAN_STEPS) {
      deps.onCapHit?.({ kind: 'plan_length', sourceTaskId, max: MAX_PLAN_STEPS })
      await refusePlan(
        `Plan not started: it has ${steps.length} steps, and a plan can have ${MAX_PLAN_STEPS}. Plan less at once and hand out the rest when these are done.`,
      )
      return
    }
    for (const step of steps) {
      const cycle = await cycleFor(step.targetAgentId, sourceTaskId, ownTask)
      if (cycle) {
        await refusePlan(`Plan not started. ${cycleRefusal(step.targetAgentName, cycle)}`)
        return
      }
    }
    const capacity = await deps.board.handOffRoom(deps.teamId, sourceTaskId)
    if (capacity && steps.length > capacity.room) {
      deps.onCapHit?.({ kind: capacity.reason, sourceTaskId, max: capacity.max })
      await refusePlan(
        `Plan not started: it has ${steps.length} steps and only ${capacity.room} more tasks fit right now (the limit is ${capacity.max}). Plan less at once, or tell the person.`,
      )
      return
    }

    // Depth preflight for the WHOLE plan. `spawn` gates each immediate delegation,
    // but a plan does not go through `spawn`, so without this every step would be
    // created as a child of a source task already AT the ceiling — through the
    // UNCAPPED repository create the server board client uses, so nothing
    // downstream stops them. They would land one level too deep and the executor
    // runner would then refuse each one forever as `too_deep`: silent dead cards.
    // One refusal for the plan, and no steps created.
    if (!(await maySpawnFrom(sourceTaskId))) {
      const words = steps.map((step) => step.task).join('\n')
      if (firstRefusal('plan-depth', delegatorAgentId, steps[0]?.targetAgentId ?? '', words)) {
        if (sourceTaskId)
          await deps.board.addComment(
            sourceTaskId,
            `Spawn depth limit (${MAX_SPAWN_DEPTH}) reached — not starting a ${steps.length}-step plan.`,
            'system',
          )
        enqueueReflection({
          toAgentId: delegatorAgentId ?? deps.leaderAgentId(),
          by: steps[0]?.targetAgentName ?? 'plan',
          summary: `Plan not started — max delegation depth (${MAX_SPAWN_DEPTH}) reached. Handle the work directly or report it back.`,
          outcome: 'error',
          ...(sourceTaskId ? { forTaskId: sourceTaskId } : {}),
        })
      }
      return
    }

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
          ...(sourceTaskId ? { forTaskId: sourceTaskId } : {}),
        })
        continue
      }
      const title = step.task.slice(0, HAND_OFF_TITLE_CHARS)
      const created = await deps.board.createHandOff({
        title,
        description: step.task,
        teamId: deps.teamId,
        assigneeRuntime: 'openclaw',
        ...(sourceTaskId ? { parentTaskId: sourceTaskId } : {}),
        // Encode the intended target AND the delegator so a ready step survives a
        // refresh (the durable ready-pump decodes the target; `resume` decodes the
        // delegator so a mid-chain reduce-point isn't lost).
        sourceDelegationId: `${runId}:plan:${stepIndex}:agent:${step.targetAgentId}:reflectTo:${delegatorAgentId ?? ''}`,
        ...handOffIdentity(['plan', runId, String(stepIndex), step.targetAgentId], step.task),
      })
      if (!created.ok) {
        enqueueReflection({
          toAgentId: delegatorAgentId ?? deps.leaderAgentId(),
          by: step.targetAgentName,
          summary:
            created.reason === 'error'
              ? `Could not create the board task for plan step "${title.slice(0, 60)}" (server error).`
              : `Plan step "${title.slice(0, 60)}" did not start. ${capRefusal(created, step.targetAgentName)}`,
          outcome: created.reason === 'error' ? 'error' : 'not_started',
          ...(sourceTaskId ? { forTaskId: sourceTaskId } : {}),
        })
        continue
      }
      const task = created.task
      // A step that found its task already there keeps that task's own target and
      // delegator, and only holds its place in the chain.
      if (created.deduplicated) {
        if (created.deduplicated === 'title' && firstDuplicateNote(delegatorAgentId, task.id))
          enqueueReflection({
            toAgentId: delegatorAgentId ?? deps.leaderAgentId(),
            by: step.targetAgentName,
            title: title.slice(0, 80),
            summary: duplicateNote(task, delegatorAgentId),
            outcome: 'already_open',
            ...(sourceTaskId ? { forTaskId: sourceTaskId } : {}),
          })
      } else {
        taskTitle.set(task.id, title)
        pendingTargets.set(task.id, step.targetAgentId)
        if (delegatorAgentId) taskReflectTo.set(task.id, delegatorAgentId)
        emit({
          id: task.id,
          identifier: task.identifier ?? null,
          title,
          status: task.status ?? 'todo',
          parentTaskId: sourceTaskId,
          createdAt: task.createdAt,
          updatedAt: task.updatedAt,
        })
      }
      if (prevTaskId && prevTaskId !== task.id) await deps.board.linkDep(task.id, prevTaskId)
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

  /** Claim + open-execution + deliver a dep-ready task to its target agent.
   *  `human`: a person assigned it, so it is delivered as their assignment and its
   *  result reports to them (on the card), never to an agent. */
  async function fireTask(
    taskId: string,
    agentId: string,
    description: string,
    human = false,
    /** Why this run starts, when the automatic pump knows better than the task. */
    reason?: TaskRunReason,
  ): Promise<void> {
    if (taskToExec.has(taskId)) return
    if (human) humanTasks.add(taskId)
    const targetSk = deps.sessionKeyForAgent(agentId)
    if (!targetSk) {
      pendingTargets.delete(taskId)
      if (!human) {
        const to = reflectTargetFor(taskId)
        const scope = await followUpScopeOf(taskId, to)
        enqueueReflection({
          toAgentId: to,
          by: nameOf(agentId),
          title: taskTitle.get(taskId),
          summary: `A plan step could not be delivered — ${nameOf(agentId)} has no active session.`,
          outcome: 'error',
          ...(scope ? { forTaskId: scope } : {}),
        })
      }
      return
    }
    // The agent's single session is busy (another task, or any other turn). Leave
    // this task `todo` + its pendingTargets entry intact so the ready-pump re-fires
    // it once the session frees: two tasks for one agent run serially, never
    // orphaning one, and never completing with someone else's reply.
    if (!sessionTakesTask(targetSk)) {
      deps.taskWakes?.noteSkip?.(taskId, 'agent_busy')
      return
    }
    const startGen = deps.stopGen()
    // Taken now, because the session is mapped only after the awaits below.
    takingSession.add(targetSk)
    let claim: ClaimResult
    try {
      // A person asking for a task that already ran starts its retry count again.
      const askedAgain =
        forceFire.has(taskId) && ((await deps.board.listExecutions(taskId))?.length ?? 0) > 0
      const runReason: TaskRunReason =
        reason ??
        (askedAgain ? 'person_retry' : humanTasks.has(taskId) ? 'assignment' : 'delegation')
      claim = await deps.board.claim(taskId, agentId, 'openclaw', {
        executorType: 'openclaw',
        runReason,
      })
      pendingTargets.delete(taskId)
      if (!claim.ok) return // 409 — someone else won; never retry
      const exec =
        claim.execution ?? (await deps.board.createExecution(taskId, 'openclaw', { runReason }))
      if (!exec) {
        // Transient ledger error — release to `todo` so the ready-pump retries it (its
        // sdid still carries the target + delegator). No reflection: it self-heals.
        await deps.board.updateStatus(taskId, 'todo')
        emit({ id: taskId, status: 'todo', assigneeAgentId: null, updatedAt: now() })
        return
      }
      taskToExec.set(taskId, exec.id)
      endRetryWait(taskId)
      // The person's "run it now" is spent on this run: a later failure goes back
      // under the automatic pump's policy like any other.
      forceFire.delete(taskId)
      sessionToTask.set(targetSk, taskId)
      sessionStartGen.set(targetSk, startGen) // capture for the Stop-vs-abort distinction
      lastActivityAt.set(targetSk, now()) // start the idle watchdog clock for this delegate
    } finally {
      takingSession.delete(targetSk)
    }
    emit({ id: taskId, status: 'in_progress', assigneeAgentId: agentId, updatedAt: Date.now() })
    await beginWork(taskId, agentId)
    // Stop pressed after the claim but before delivery — release the task so it
    // isn't a permanently in_progress ghost (and the watchdog can't false-time-out
    // a step that was never delivered). Mirrors spawn's stop-release.
    if (deps.stopGen() !== startGen) {
      await releaseClaimed(taskId, targetSk)
      return
    }
    pendingStart.set(targetSk, taskId)
    let delivered = false
    try {
      const brief = claim.wakes?.some((w) => w.reason === 'subtasks_closed')
        ? await followUpBrief(taskId, description, agentId)
        : description
      await deps.deliver(targetSk, agentId, brief, taskRunOrigin(taskId, claim.wakes, agentId))
      delivered = true
    } catch (err) {
      await failForSession(
        targetSk,
        'error',
        err instanceof DeliveryRefusedError
          ? err.message
          : `Could not deliver the step to ${nameOf(agentId)} (the message was rejected).`,
        refusedErrorOpts(err),
      )
    } finally {
      if (pendingStart.get(targetSk) === taskId) pendingStart.delete(targetSk)
    }
    if (delivered) await settleDelivery(taskId, targetSk, startGen)
  }

  /** What a task's agent is told when all the work it handed out has closed. Only what
   *  a sub-task reported comes with the message: one a person holds, or that the task
   *  runner ran, reports on its card. */
  async function followUpBrief(taskId: string, brief: string, agentId: string): Promise<string> {
    const views = (await deps.board.subtasksOf(taskId)) ?? []
    const done = views.filter((v) => subtaskStanding(v) === 'done').length
    const failed = subtaskNames(views, 'not_coming', 'stopped')
    const cancelled = subtaskNames(views, 'cancelled')
    return (
      `[Sub-tasks in] The work you handed out on this task has closed: ${done} done.` +
      (failed ? ` Did not finish: ${failed}.` : '') +
      (cancelled ? ` Cancelled: ${cancelled}.` : '') +
      ' What they reported is in your context; one that has no report here keeps its result on its own card, which get_task reads. Finish the task now: your reply becomes its result, replacing what you reported before, so say everything that still matters. If you hand out more, the task waits again.' +
      (agentId === deps.leaderAgentId() ? ' Your reply also goes to the team chat.' : '') +
      (failed
        ? ' Work that did not finish keeps this task from Done unless you made up for it: if you did, say so with report_result, where you have it. If you did not, say what is missing.'
        : '') +
      ` The task:\n\n${brief}`
    )
  }

  /** Why a run of this task is delivered: for the saved wakes it took when there are
   *  any, else as the delegation or assignment it is. `agentId` is who runs it, when
   *  it is that agent's follow-up: the team lead's still reaches the chat. */
  function taskRunOrigin(
    taskId: string,
    wakes: readonly ClaimedWake[] = [],
    agentId?: string,
  ): TurnOrigin {
    const assigned = humanTasks.has(taskId)
    if (wakes.length === 0)
      return assigned
        ? ASSIGNMENT_TURN
        : { kind: 'delegation', fromAgentId: reflectTargetFor(taskId) }
    return {
      kind: 'wake',
      reason: wakes.map((w) => w.reason).reduce((a, b) => strongerWakeReason(a, b)),
      wakeIds: wakes.map((w) => w.id),
      fromAgentId: assigned ? null : reflectTargetFor(taskId),
      ...(assigned ? { assigned: true as const } : {}),
      ...(agentId === deps.leaderAgentId() && wakes.some((w) => w.reason === 'subtasks_closed')
        ? { inChat: true as const }
        : {}),
    }
  }

  /** A fresh run of `taskId` is about to be delivered: the host notes where its
   *  work starts (see WorkCheck). A host that cannot only leaves the run unchecked. */
  async function beginWork(taskId: string, agentId: string): Promise<void> {
    await deps.workCheck?.begin(taskId, agentId).catch(() => undefined)
  }

  /** Tasks already alerted as parked (cap-hit) — one alert per engine lifetime. */
  const parkAlerted = new Set<string>()
  /**
   * A task waiting in To do for room in a budget, whose cap has filled instead: its spend
   * crossed the cap, or a person paused it. Nothing will clear that by itself, so it goes
   * to a person, and whoever handed it out hears, as for a cap that refused it outright.
   * Its plan stays queued.
   */
  async function parkForFilledCap(task: BoardTask, agentId: string): Promise<void> {
    const moved = await deps.board
      .updateStatus(task.id, 'blocked', { waitingOn: { kind: 'budget' } })
      .catch(() => false)
    if (!moved) return
    const why = 'The budget it was waiting on is now paused at its hard cap.'
    await deps.board.addComment(
      task.id,
      `${why} It waits for a person: raise the cap, then retry it.`,
      'system',
    )
    emit({ id: task.id, status: 'blocked', updatedAt: now() })
    const sdid = sdidOf(task)
    if (!isHumanAssignment(sdid)) {
      const to = sdidReflectTo(sdid) ?? deps.leaderAgentId()
      const scope = await followUpScopeOf(task.id, to)
      enqueueReflection({
        toAgentId: to,
        by: nameOf(agentId),
        ...(typeof task.title === 'string' ? { title: task.title } : {}),
        summary: why,
        outcome: 'budget',
        taskId: task.id,
        ...(scope ? { forTaskId: scope } : {}),
      })
    }
    taskReflectTo.delete(task.id)
    taskTitle.delete(task.id)
    roundLeads.delete(task.id)
    endRetryWait(task.id)
  }

  /** Same-session fires deferred out of a mid-terminal drain (see pumpReady). */
  const deferredFires = new Set<ReturnType<typeof setTimeout>>()

  /**
   * Fire every now-ready delegation (a fresh/deferred one, a plan step whose
   * blocker completed, or a sweep/orphan-released one). `getReadyTasks` returns
   * only `status='todo'` + deps-satisfied; the target is resolved from the
   * durable task (so a refresh/restart resumes it) and the atomic claim-409 is
   * the final double-fire arbiter.
   *
   * `completingSessionKey`: the session whose terminal we are INSIDE, when the
   * pump runs from completeForSession/failForSession. A fire for that SAME
   * session must not be delivered inline — the delivery would queue on the home
   * mutex the completing drain still holds until it returns, a circular wait
   * that only the acquire timeout breaks (10 minutes, then a wrongful failure).
   * Those fires are deferred one macrotask, by which point the drain has
   * returned and the mutex is free.
   */
  async function pumpReady(completingSessionKey?: string | null): Promise<void> {
    const ready = await deps.board.getReadyTasks(deps.teamId)
    for (const task of ready) {
      const agentId = targetForTask(task)
      if (!agentId) continue // not a delegation we can fire
      const execs = await deps.board.listExecutions(task.id)
      // An UNREADABLE ledger is not an empty one. `[]` is the strongest signal a
      // task may fire, so collapsing a read failure into it would auto-fire work
      // the user Stopped. Skip the task this pass; the pump runs again.
      if (execs === null) continue
      // A person asked for this run (`dispatchTask` found its agent busy): the
      // policy below guards the AUTOMATIC re-fire, not the person asking again.
      const refusal = autoFireRefusal(execs, now())
      const forced = forceFire.has(task.id)
      if (!forced && refusal !== null) {
        // The no-progress brake lets go by itself when its wait ends: nobody is told
        // it was parked, and whatever wake waits on it says why. So do a retry's wait
        // and the wait for a budget's room.
        if (refusal === 'braked' || refusal === 'retry_wait' || refusal === 'budget_held') {
          deps.taskWakes?.noteSkip?.(task.id, refusal === 'budget_held' ? 'budget' : refusal)
          continue
        }
        // Tell the leader ONCE when the cap parks a task — a silently-parked
        // delegation is precisely the "sits forever, nobody told" failure mode.
        // A task a person assigned is theirs to decide on, not the leader's: it
        // surfaces on the board's needs-you column instead. Every other refusal
        // reported up when its run ended.
        if (
          refusal === 'failed_too_often' &&
          !parkAlerted.has(task.id) &&
          !isHumanAssignment(sdidOf(task))
        ) {
          parkAlerted.add(task.id)
          const leaderSk = deps.leaderAgentId()
            ? deps.sessionKeyForAgent(deps.leaderAgentId()!)
            : null
          if (leaderSk)
            deps.narrate?.(
              leaderSk,
              `“${task.title ?? task.id}” failed ${MAX_AUTO_FIRES} times in a row and was parked — it will not be retried automatically. Review it on the board.`,
              'alert',
            )
        }
        continue
      }
      const lastRun = execs[execs.length - 1]
      if (!forced) {
        // Its wait has awake time left, which the wall clock above cannot see.
        if (retryWaits.has(task.id)) continue
        // Its last run found no room in a budget. Asked first, so waiting for the room
        // writes no row and moves nothing on the card. A cap that has filled meanwhile
        // will not clear by itself, so the task stops promising that it will.
        if (budgetRefusalOf(lastRun)) {
          const refusal = deps.budgetRefusal?.(task.id, agentId) ?? null
          if (refusal === 'paused') {
            await parkForFilledCap(task, agentId)
            continue
          }
          if (refusal === 'held') {
            deps.taskWakes?.noteSkip?.(task.id, 'budget')
            continue
          }
        }
      }
      if (!taskTitle.has(task.id) && task.title) taskTitle.set(task.id, task.title)
      // A retry of a run is told what that run was told, and is the same kind of run, or
      // what it was allowed would start over. So is a run a pause stopped, back on resume:
      // waiting out a pause hands out no second extra turn.
      const provider = !forced && providerFailureOf(lastRun) !== null
      const comingBack = !forced && (lastRun?.status === 'budget_held' || stoppedByPause(lastRun))
      const lead = provider || comingBack ? roundLeads.get(task.id) : undefined
      const description = lead ? `${lead} The task:\n\n${briefFor(task)}` : briefFor(task)
      const reason: TaskRunReason | undefined = provider
        ? 'provider_retry'
        : comingBack && carriesOnEarlierRun(lastRun?.runReason)
          ? (lastRun?.runReason as TaskRunReason)
          : undefined
      const human = isHumanAssignment(sdidOf(task))
      // After an engine rebuild a pump-fired sub-task must still report to its
      // mid-chain delegator, not the leader fallback (as resume and dispatchTask
      // already recover it).
      if (!human && !taskReflectTo.has(task.id)) {
        const r = sdidReflectTo(sdidOf(task))
        if (r) taskReflectTo.set(task.id, r)
      }
      const targetSk = deps.sessionKeyForAgent(agentId)
      if (completingSessionKey && targetSk === completingSessionKey) {
        const t = setTimeout(() => {
          deferredFires.delete(t)
          // Deferred out of a mid-terminal drain, so nothing is awaiting this:
          // a rejection here would be an unhandled one, and the delegation it
          // was meant to start would simply never happen, silently.
          void fireTask(task.id, agentId, description, human, reason).catch((err: unknown) => {
            const leaderId = deps.leaderAgentId()
            const leaderSk = leaderId ? deps.sessionKeyForAgent(leaderId) : null
            if (leaderSk)
              deps.narrate?.(
                leaderSk,
                `A queued delegation to ${nameOf(agentId)} could not be started: ${
                  err instanceof Error ? err.message : String(err)
                }`,
                'alert',
              )
          })
        }, 0)
        ;(t as { unref?: () => void }).unref?.()
        deferredFires.add(t)
        continue
      }
      await fireTask(task.id, agentId, description, human, reason)
    }
  }

  function enqueueReflection(item: ReportUp): void {
    // Failures must reach the recipient even with an empty summary; successes
    // need substance (the empty-success placeholder is applied by the caller).
    if (!item.summary.trim() && (item.outcome == null || item.outcome === 'done')) return
    // Written BEFORE it waits on the batch window, so from here on a restart
    // cannot lose it: the next engine for the room reads it back in `resume()`.
    const outboxId = deps.reportUps?.record(item) ?? null
    if (outboxId) reportUpsInHand.add(outboxId)
    reflectQueue.push(outboxId ? { ...item, outboxId } : item)
    if (!reflectTimer) reflectTimer = setTimeout(() => void flushReflection(), REFLECT_WINDOW_MS)
  }

  /** A result that came back after a person's Stop. A Stop starts nothing, so it is
   *  not queued: it is kept for the recipient's next run (see holdWorkForNextRun). */
  function holdReflection(item: ReportUp): void {
    if (!item.summary.trim() && (item.outcome == null || item.outcome === 'done')) return
    deps.reportUps?.record(item, { held: true })
  }

  /** Report a result to whoever handed the work off: at once, or, after a person's
   *  Stop, on their next run. */
  const reportUp = (item: ReportUp, stopped: boolean): void => {
    if (stopped) holdReflection(item)
    else enqueueReflection(item)
  }

  /**
   * THE STOP RULE, in one place (the owner's decision `stop-reports`: later). A
   * person's Stop drops nothing and wakes no one: every report-up and saved wake this
   * room holds stays pending, starts no run, and is settled with the next run that
   * comes anyway (the recipient's for a report-up, the task's for a wake). Whatever
   * is still in the batch window goes the same way, because sending it would start a
   * run after the Stop. What never gets a next run is reaped at the pending age limit
   * (30 days), and archiving the room or deleting the team closes it sooner; the
   * result stays on the card either way.
   */
  function holdWorkForNextRun(): void {
    const queued = reflectQueue.splice(0)
    if (reflectTimer) {
      clearTimeout(reflectTimer)
      reflectTimer = null
    }
    if (!deps.reportUps) {
      // No durable store to keep them in: they go out as they always did.
      reflectQueue.push(...queued)
      if (queued.length > 0) armReflectTimer()
    } else {
      for (const item of queued) if (!item.outboxId) holdReflection(item)
      // What a pause kept back has not gone out either, and it must not go out on resume
      // as if nobody had pressed Stop since.
      for (const r of deps.reportUps.pending()) {
        if (reportUpHeld(r.item)) reportUpsInHand.add(r.id)
      }
      holdReportUpRows([...reportUpsInHand])
      // What waits for a task's own next run is held the same way: it starts nothing.
      const waiting = deps.reportUps
        .pending()
        .filter((r) => r.item.forTaskId && !reportUpsInHand.has(r.id))
        .map((r) => r.id)
      if (waiting.length > 0) deps.reportUps.hold(waiting)
      for (const item of unsavedReports.splice(0)) holdReflection(item)
    }
    deps.taskWakes?.holdAll()
  }

  /** Hold these rows (see holdWorkForNextRun). A run may still be carrying them, and
   *  its finishing would still be their first settlement, so they stay settleable.
   *  An id it no longer has in hand is left alone, as in settleReportUps: a teardown
   *  bumps the stop generation too, and the runs it cancelled still report their
   *  ending here. Those rows stay pending for the next engine. */
  function holdReportUpRows(ids: readonly string[]): void {
    const inHand = ids.filter((id) => reportUpsInHand.has(id))
    if (inHand.length === 0) return
    // A failed write leaves them in hand, so this engine does not send them twice.
    if (!deps.reportUps?.hold(inHand)) return
    for (const id of inHand) {
      reportUpsInHand.delete(id)
      heldByStop.add(id)
    }
  }

  /** Close durable report-ups this engine holds (see {@link ReportUpSettlement}).
   *  An id it no longer holds is left alone: after a `reset()`, a run the host
   *  cancelled at teardown still reports its ending here, and settling its rows
   *  would lose an update that never ran. They stay pending for the next engine.
   *  An id is let go only once its settlement is written, so a failed write never
   *  lets this engine send the row a second time. */
  function settleReportUps(ids: readonly string[], how: ReportUpSettlement): void {
    const held = ids.filter((id) => reportUpsInHand.has(id) || heldByStop.has(id))
    if (held.length === 0) return
    if (!deps.reportUps?.settle(held, how)) {
      // Still held, so this engine never resends it; the sweep writes it later.
      for (const id of held) settleLater.set(id, how)
      return
    }
    for (const id of held) {
      reportUpsInHand.delete(id)
      heldByStop.delete(id)
      settleLater.delete(id)
    }
  }

  /** Write the settlements whose write failed (see settleReportUps). Run by the
   *  sweep, so a later engine does not resend an update that was delivered. */
  function retrySettlements(): void {
    if (!deps.reportUps || settleLater.size === 0) return
    const byHow = new Map<ReportUpSettlement, string[]>()
    for (const [id, how] of settleLater) byHow.set(how, [...(byHow.get(how) ?? []), id])
    for (const [how, ids] of byHow) {
      if (!deps.reportUps.settle(ids, how)) continue
      for (const id of ids) {
        settleLater.delete(id)
        reportUpsInHand.delete(id)
      }
    }
  }

  /** The session a report-up goes to now, or null when it cannot reach its
   *  recipient yet. A null recipient is the room's lead, and a room may have
   *  none for a while. */
  const sessionOfRecipient = (item: ReportUp): string | null => {
    const toId = item.toAgentId ?? deps.leaderAgentId()
    return toId ? deps.sessionKeyForAgent(toId) : null
  }
  const routable = (item: ReportUp): boolean => sessionOfRecipient(item) !== null

  /**
   * A pause covers this report-up: its recipient, or the tree of the task it is about.
   * It stays pending in the outbox and uncounted, the way one with no route does, and
   * goes out after the resume. Nothing waits on it: delivered now, it would hold its
   * recipient's session for the whole pause, and the batch behind it too.
   */
  const reportUpHeld = (item: ReportUp): boolean => {
    const agentId = item.toAgentId ?? deps.leaderAgentId()
    if (!agentId || !deps.runHeldBy) return false
    return deps.runHeldBy({ agentId, taskId: item.taskId ?? item.forTaskId ?? null }) !== null
  }

  /**
   * The run that carried these report-ups is over. Only a run that finished
   * heard them. One that a Stop cut short holds them for the recipient's next run.
   * Any other ending (a crash, a kill at shutdown, a provider error, a run that
   * never started) lets them go back to pending, so the next sweep, or the next
   * engine after a restart, sends them again, counted against
   * {@link MAX_REPORT_UP_REPLAYS}. One a Stop already held stays held: it starts
   * nothing, and waits for the run after.
   */
  function closeReportUpRun(run: RunStamp | undefined, finished: boolean): void {
    if (!run?.reportUpIds?.length) return
    if (finished) settleReportUps(run.reportUpIds, 'delivered')
    else if (run.stopGen !== deps.stopGen()) holdReportUpRows(run.reportUpIds)
    else {
      for (const id of run.reportUpIds) {
        reportUpsInHand.delete(id)
        if (run.stoppedByPause) returnedByPause.add(id)
      }
    }
  }

  /** What came back from the work this task handed out and no run has heard: written,
   *  and maybe still in the batch window, whoever it names as recipient. One a run still
   *  carries is that run's. */
  function unheardReportUps<R extends { id: string; item: ReportUp }>(
    rows: readonly R[],
    taskId: string,
  ): R[] {
    const queuedIds = new Set(reflectQueue.flatMap((i) => (i.outboxId ? [i.outboxId] : [])))
    return rows.filter(
      (r) => r.item.forTaskId === taskId && (!reportUpsInHand.has(r.id) || queuedIds.has(r.id)),
    )
  }

  /** Reports on this task that only memory holds: their outbox write failed, and they
   *  are in the batch window, or past it and waiting for this task's next run. A host
   *  with no outbox hands no run its reports at all, so none of this applies to it. */
  const reportsOnlyInMemory = (taskId: string): ReportUp[] =>
    deps.reportUps
      ? [...reflectQueue.filter((i) => !i.outboxId), ...unsavedReports].filter(
          (i) => i.forTaskId === taskId,
        )
      : []

  /** Let go of these, wherever memory holds them. */
  function dropFromMemory(items: readonly ReportUp[]): void {
    for (const list of [reflectQueue, unsavedReports] as ReportUp[][])
      for (let i = list.length - 1; i >= 0; i--) if (items.includes(list[i]!)) list.splice(i, 1)
  }

  /** May a refused hand-off on this task still start a turn? See MAX_REFUSAL_TURNS. */
  function spendRefusalTurn(taskId: string): boolean {
    const spent = refusalTurns.get(taskId) ?? 0
    if (spent >= MAX_REFUSAL_TURNS) return false
    refusalTurns.set(taskId, spent + 1)
    return true
  }

  /** Refused hand-offs its agent will not be told about: the card says so, and they are
   *  closed, so they start nothing later. */
  async function giveUpRefusals(
    taskId: string,
    rows: ReadonlyArray<{ id: string; item: ReportUp }>,
    inMemory: readonly ReportUp[],
  ): Promise<void> {
    const ids = rows.map((r) => r.id)
    if (ids.length > 0) deps.reportUps?.settle(ids, 'gave_up')
    for (const id of ids) reportUpsInHand.delete(id)
    for (let i = reflectQueue.length - 1; i >= 0; i--) {
      const id = reflectQueue[i]!.outboxId
      if (id && ids.includes(id)) reflectQueue.splice(i, 1)
    }
    dropFromMemory(inMemory)
    const first = rows[0]?.item.summary ?? inMemory[0]?.summary ?? ''
    await deps.board
      .addComment(
        taskId,
        `A hand-off from this task did not start, and its agent was not told again: ${first.slice(0, 300)}`,
        'system',
      )
      .catch(() => undefined)
  }

  /** See the interface. */
  function takeHeldReportUps(
    sessionKey: string,
    taskId?: string,
  ): { ids: string[]; text: string } | null {
    const agentId = deps.agentIdForSession(sessionKey)
    if (!deps.reportUps || !agentId) return null
    const leaderId = deps.leaderAgentId()
    const held = deps.reportUps.held()
    const own = taskId ? unheardReportUps([...deps.reportUps.pending(), ...held], taskId) : []
    // No id to carry, so nothing settles these: if this run fails they are gone, and the
    // sub-task's own card still has the result. The same database that refused the write
    // would be what remembered them.
    const inMemory = taskId ? reportsOnlyInMemory(taskId) : []
    const ownIds = new Set(own.map((r) => r.id))
    const others = held.filter(
      (r) =>
        (r.item.toAgentId ?? leaderId) === agentId &&
        !reportUpsInHand.has(r.id) &&
        !ownIds.has(r.id),
    )
    const taken: typeof held = []
    let used = 0
    for (const row of [...own, ...others]) {
      const room = HELD_REPORT_UPS_BUDGET_CHARS - used
      if (room <= 0) break
      // A result larger than what is left waits, unless it is first in line: then it
      // goes cut, so one long result cannot hold back everything behind it.
      if (row.item.summary.length > room && taken.length > 0) break
      taken.push(row)
      used += Math.min(row.item.summary.length, room) + 200
    }
    if (taken.length === 0 && inMemory.length === 0) return null
    dropFromMemory(inMemory)
    for (const r of taken) {
      reportUpsInHand.add(r.id)
      heldByStop.delete(r.id)
      returnedByPause.delete(r.id)
    }
    const takenIds = new Set(taken.map((r) => r.id))
    // Taken from the batch window too, so the flush does not also look at them.
    for (let i = reflectQueue.length - 1; i >= 0; i--) {
      const id = reflectQueue[i]!.outboxId
      if (id && takenIds.has(id)) reflectQueue.splice(i, 1)
    }
    const render = (items: readonly ReportUp[], opts: TaskUpdateOptions): string | null =>
      items.length > 0
        ? buildTaskUpdateMessage(
            items.map((item) =>
              item.summary.length > HELD_REPORT_UPS_BUDGET_CHARS
                ? {
                    ...item,
                    summary: `${item.summary.slice(0, HELD_REPORT_UPS_BUDGET_CHARS)}\n… (cut: the whole result is on the task's card)`,
                  }
                : item,
            ),
            [],
            opts,
          )
        : null
    const itemsOf = (rows: typeof held): ReportUp[] =>
      rows.filter((r) => takenIds.has(r.id)).map((r) => r.item)
    const text = [
      render([...itemsOf(own), ...inMemory], { ownTask: true }),
      render(itemsOf(others), { heldByStop: true }),
    ]
      .filter((t): t is string => t !== null)
      .join('\n\n')
    return { ids: taken.map((r) => r.id), text }
  }

  /** The outbox ids a batch of reflections carries. */
  const outboxIdsOf = (items: ReadonlyArray<{ outboxId?: string }>): string[] =>
    items.flatMap((i) => (i.outboxId ? [i.outboxId] : []))

  /**
   * Queue again every report-up the outbox still holds that this engine does
   * not: the ones a previous process (or an evicted engine for this room) took
   * with it, and the ones whose run here ended without finishing (see
   * {@link closeReportUpRun}). Each is counted, and one already sent again
   * {@link MAX_REPORT_UP_REPLAYS} times is given up instead, with an alert in the
   * recipient's chat. No await between reading the outbox and claiming the rows,
   * so two concurrent `resume()` calls never both send one. Run by `resume()` and
   * by every sweep. A row on a task still open waits, uncounted, for that task's next
   * run, which takes it (see flushReflection).
   */
  async function replayReportUps(): Promise<void> {
    if (!deps.reportUps) return
    const openTask = await openTasksAmong([
      ...deps.reportUps.pending().map((r) => r.item),
      ...unsavedReports,
    ])
    // Only memory holds these, and their task has closed: they go out as any late one.
    for (const item of unsavedReports.splice(0)) {
      if (item.forTaskId && openTask(item.forTaskId)) unsavedReports.push(item)
      else {
        reflectQueue.push(item)
        armReflectTimer()
      }
    }
    // One that cannot reach its recipient now (a room with no lead yet) stays
    // pending and uncounted: a later sweep sends it once it can.
    const rows = deps.reportUps
      .pending()
      .filter(
        (r) =>
          !reportUpsInHand.has(r.id) &&
          routable(r.item) &&
          !reportUpHeld(r.item) &&
          !(r.item.forTaskId && openTask(r.item.forTaskId)),
      )
    if (rows.length === 0) return
    // A pause stopped these on their way, so this send is not a try they failed.
    for (const r of rows.filter((row) => returnedByPause.delete(row.id))) {
      reportUpsInHand.add(r.id)
      reflectQueue.push({ ...r.item, outboxId: r.id })
      armReflectTimer()
    }
    const counted = rows.filter((r) => !reportUpsInHand.has(r.id))
    const replay = counted.filter((r) => r.replays < MAX_REPORT_UP_REPLAYS)
    const exhausted = counted.filter((r) => r.replays >= MAX_REPORT_UP_REPLAYS)
    // A count that could not be written is not spent: the next sweep tries again.
    if (replay.length > 0 && deps.reportUps.markReplayed(replay.map((r) => r.id))) {
      for (const r of replay) {
        reportUpsInHand.add(r.id)
        reflectQueue.push({ ...r.item, outboxId: r.id })
      }
      armReflectTimer()
    }
    // Given up only once the recipient's chat says so: a row whose alert could
    // not be written stays pending, and the next sweep tries the alert again.
    const perSession = new Map<string, string[]>()
    for (const r of exhausted) {
      const toSk = sessionOfRecipient(r.item)
      if (toSk) perSession.set(toSk, [...(perSession.get(toSk) ?? []), r.id])
    }
    for (const [toSk, ids] of perSession) {
      const told = deps.narrate?.(
        toSk,
        `${ids.length} task update(s) could not be delivered to this session after ${MAX_REPORT_UP_REPLAYS} more tries. The results are on the board.`,
        'alert',
      )
      if (told !== false) deps.reportUps.settle(ids, 'gave_up')
    }
  }

  /** Which of these items' tasks (`forTaskId`) are still open, so the item waits for
   *  that task's next run. A task it could not read, or did not ask about, counts as
   *  open: nothing may start a follow-up early, and the next pass reads it again. */
  async function openTasksAmong(
    items: ReadonlyArray<{ forTaskId?: string }>,
  ): Promise<(taskId: string) => boolean> {
    const closed = new Set<string>()
    const ids = new Set(items.flatMap((i) => (i.forTaskId ? [i.forTaskId] : [])))
    for (const id of ids) {
      const task = (await deps.board.getTask(id).catch(() => null))?.task
      if (task && (task.status === 'done' || task.status === 'cancelled' || task['dropped']))
        closed.add(id)
    }
    return (taskId) => !closed.has(taskId)
  }

  function armReflectTimer(): void {
    if (!reflectTimer) reflectTimer = setTimeout(() => void flushReflection(), REFLECT_WINDOW_MS)
  }

  async function flushReflection(): Promise<void> {
    reflectTimer = null
    if (reflectQueue.length === 0) return
    // A result on a task still open starts nothing: that task's next run takes it from
    // the outbox, whenever that comes (see takeHeldReportUps). That is what makes one
    // follow-up of many results, and what makes a restart between two of them harmless.
    const openTask = await openTasksAmong(reflectQueue)
    const items: typeof reflectQueue = []
    // A refused hand-off on a task that has closed cannot change that task. It may be told
    // to its agent, in a turn that may hand out more, so it is bounded like the rest.
    const refusedOnClosed = new Map<string, typeof items>()
    for (const item of reflectQueue.splice(0)) {
      if (item.forTaskId && openTask(item.forTaskId)) {
        if (item.outboxId) reportUpsInHand.delete(item.outboxId)
        // Its write failed. Try again, and memory holds it if that fails too. With no
        // outbox at all there is no run to take it: its card has the result.
        else if (deps.reportUps && !deps.reportUps.record(item)) unsavedReports.push(item)
      } else if (item.forTaskId && !item.taskId) {
        // Nobody can be told under a pause, so that is not a turn spent. The sweep sends
        // it after the resume, as below.
        if (item.outboxId && reportUpHeld(item)) reportUpsInHand.delete(item.outboxId)
        else
          refusedOnClosed.set(item.forTaskId, [
            ...(refusedOnClosed.get(item.forTaskId) ?? []),
            item,
          ])
      } else items.push(item)
    }
    for (const [taskId, refused] of refusedOnClosed) {
      if (spendRefusalTurn(taskId)) items.push(...refused)
      else
        await giveUpRefusals(
          taskId,
          refused.flatMap((item) => (item.outboxId ? [{ id: item.outboxId, item }] : [])),
          refused.filter((item) => !item.outboxId),
        )
    }
    // Group by recipient session and follow-up scope: a sub-task reports to its
    // delegator, a top-level task to the leader, and results a recipient gets
    // back on a task it already closed form their own follow-up batch. The lead
    // is never handed a follow-up. A recipient that can't be resolved yet
    // (leader not identified / no session) is re-queued + re-armed, never lost.
    const leaderId = deps.leaderAgentId()
    const groups = new Map<string, { toSk: string; forTaskId?: string; items: typeof items }>()
    const unresolved: typeof items = []
    for (const item of items) {
      const toId = item.toAgentId ?? leaderId
      const toSk = toId ? deps.sessionKeyForAgent(toId) : null
      if (!toId || !toSk) {
        unresolved.push(item)
        continue
      }
      // Only one the outbox holds can wait: the sweep sends it after the resume.
      if (item.outboxId && reportUpHeld(item)) {
        reportUpsInHand.delete(item.outboxId)
        continue
      }
      const forTaskId = item.forTaskId && toId !== leaderId ? item.forTaskId : undefined
      const key = `${toSk}\u0000${forTaskId ?? ''}`
      const g = groups.get(key) ?? { toSk, ...(forTaskId ? { forTaskId } : {}), items: [] }
      g.items.push(item)
      groups.set(key, g)
    }
    if (unresolved.length > 0) {
      reflectQueue.unshift(...unresolved)
      armReflectTimer()
    }
    const startGen = deps.stopGen()
    for (const g of groups.values()) {
      const { toSk, items: group } = g
      // A Stop mid-flush suppresses the remaining groups' narration AND delivery —
      // the user halted; don't append stale [Task Update]s or re-amplify after Stop.
      if (deps.stopGen() !== startGen) return
      // What is this recipient STILL waiting on? Read off the board rather than
      // tracked in memory, so it survives a restart and counts work fired by any
      // path. Not-yet-terminal means `todo`, `in_progress` or `in_review` (a check
      // under way, which reports when it answers): a `blocked` task is not going to
      // report on its own, and counting it would tell the delegator to keep waiting
      // on something that needs a human. Those are named when the rest is in.
      const outstanding: OutstandingDelegation[] = []
      const needPerson: OutstandingDelegation[] = []
      // Handed off but not coming by itself: stopped, parked, or moved to Backlog. It
      // is not outstanding, because nothing will report, and it is not in either.
      const notStarted: OutstandingDelegation[] = []
      const toAgentId = deps.agentIdForSession(toSk)
      // A read that failed answers with an empty list, which must not read as nothing
      // being outstanding. A read that worked lists the tasks reporting in this batch.
      let boardAnswered = false
      if (toAgentId) {
        // Only a finished task is settled. A hand-off that was refused or found its task
        // open says nothing about that task, whose title it may share.
        const settled = new Set(
          group
            .filter((i) => i.outcome !== 'already_open' && i.outcome !== 'not_started')
            .map((i) => i.title ?? ''),
        )
        const batchIds = new Set(group.flatMap((i) => (i.taskId ? [i.taskId] : [])))
        const listed = await deps.board.listTasks(deps.teamId).catch(() => [])
        boardAnswered = [...batchIds].every((id) => listed.some((t) => t.id === id))
        for (const t of listed) {
          const sdid = typeof t.sourceDelegationId === 'string' ? t.sourceDelegationId : ''
          const parent =
            typeof t.parentTaskId === 'string' && t.parentTaskId ? t.parentTaskId : null
          const reportsHere =
            sdidReflectTo(sdid) === toAgentId && (!g.forTaskId || parent === g.forTaskId)
          // Work still running under a task this batch reports as finished: the
          // recipient is hearing a partial result, and the rest arrives later as
          // a follow-up.
          const underBatch = parent !== null && batchIds.has(parent)
          if (!reportsHere && !underBatch) continue
          const named = (): OutstandingDelegation => ({
            by: nameOf(sdidAgent(sdid)),
            ...(typeof t.title === 'string' ? { title: t.title } : {}),
          })
          // Waiting on other work, the board moves it on: it reports by itself.
          const onOtherWork =
            t.status === 'blocked' && waitsOnOtherWork(parseWaitingOn(t['waitingOn']))
          if (t.status === 'blocked' && !onOtherWork && reportsHere) needPerson.push(named())
          if (t.status === 'backlog' && reportsHere) notStarted.push(named())
          if (
            t.status !== 'todo' &&
            t.status !== 'in_progress' &&
            t.status !== 'in_review' &&
            !onOtherWork
          )
            continue
          // A `todo` the pump will never fire again (the user stopped it, or it
          // was parked after failing repeatedly) is not coming back on its own.
          // Listing it would tell the delegator to keep waiting on work that now
          // needs a person, which is how one dead task stalls a whole synthesis.
          // One the no-progress brake holds back is coming back.
          if (t.status === 'todo' && !forceFire.has(t.id)) {
            const execs = await deps.board.listExecutions(t.id)
            if (execs !== null && execs.length > 0 && !ledgerWillAutoFire(execs)) {
              if (reportsHere) notStarted.push(named())
              continue
            }
          }
          const title = typeof t.title === 'string' ? t.title : undefined
          // A task in this very batch is reporting now, not outstanding.
          if (title && settled.has(title)) continue
          outstanding.push({
            by: nameOf(sdidAgent(sdid)),
            ...(title ? { title: title.length > 60 ? title.slice(0, 60) + '…' : title } : {}),
          })
        }
      }
      // A hand-off the board refused has no task on the list, and nothing will start it.
      for (const item of group)
        if (item.outcome === 'not_started')
          notStarted.push({ by: item.by, ...(item.title ? { title: item.title } : {}) })
      const followUpTask = g.forTaskId ? (await deps.board.getTask(g.forTaskId))?.task : undefined
      const handedOff = group.some((i) => i.taskId)
      // A hand-off that found its work open is not in, whoever that task reports to.
      const foundOpen = group.some((i) => i.outcome === 'already_open')
      const message = buildTaskUpdateMessage(group, outstanding, {
        ...(g.forTaskId
          ? {
              followUp: {
                title: typeof followUpTask?.title === 'string' ? followUpTask.title : undefined,
              },
            }
          : {}),
        // This report is the delegator's wake: it has no second row of its own.
        ...(handedOff && toAgentId && boardAnswered && !foundOpen
          ? { allIn: { needPerson, notStarted } }
          : {}),
      })
      // Visible narration (board→chat) + context delivery to the recipient. The
      // narration is the user-facing signal even if the delivery itself fails.
      deps.narrate?.(toSk, message)
      const toId = deps.agentIdForSession(toSk)
      if (toId) {
        // The run that carries the update settles its outbox rows when it ends.
        const reportUpIds = outboxIdsOf(group)
        const origin: TurnOrigin =
          g.forTaskId || reportUpIds.length > 0
            ? {
                kind: 'system',
                ...(g.forTaskId ? { forTaskId: g.forTaskId } : {}),
                ...(reportUpIds.length > 0 ? { reportUpIds } : {}),
              }
            : SYSTEM_TURN
        try {
          await deps.deliver(toSk, toId, message, origin)
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
            // Retries exhausted: the recipient will NEVER get these updates. That
            // is a real coordination failure, not routine narration — mark it
            // `alert` so the host surfaces it to the user instead of filing it in
            // a tracelog nobody reads.
            const told = deps.narrate?.(
              toSk,
              `${group.length} task update(s) could not be delivered to this session — the results are on the board.`,
              'alert',
            )
            // Given up only once someone was told. Otherwise the rows go back
            // to pending and a later sweep sends them again.
            if (told !== false) settleReportUps(outboxIdsOf(group), 'gave_up')
            else for (const id of outboxIdsOf(group)) reportUpsInHand.delete(id)
          }
        }
      }
    }
  }

  async function completeForSession(
    sessionKey: string,
    reply: string,
    /** The run's turn, where its hand-offs are counted. Read now: the count goes when
     *  the turn does, and a check can outlast it. */
    turn: string,
  ): Promise<void> {
    const taskId = sessionToTask.get(sessionKey)
    if (!taskId) return // echo-loop guard: the leader's reduce turn is never here
    // Its finished work is being checked, so this terminal is another turn's.
    if (isChecking(sessionKey)) return
    // A control token is what an agent emits to say nothing: no reply, and no result.
    const summary = isOpenclawControlToken(reply) || isClawbooControlToken(reply) ? '' : reply
    const seenTurn = handOffsByTurn.get(turn)
    const handOffs = (seenTurn?.count ?? 0) + (seenTurn?.foundOpen ? 1 : 0)
    // After a Stop a run is closed below as it always was: nothing waits and nothing
    // is checked. The agent saying it did not get there has the same effect: a person
    // decides, and a check on work nobody claims is done could only cost a reviewer.
    if (stopChangedFor(sessionKey) || (await claimOfRun(taskId))?.outcome === 'not_done') {
      if (sessionToTask.get(sessionKey) === taskId)
        await finishCompletion(sessionKey, taskId, summary, undefined, false, handOffs)
      return
    }
    // A person's move that landed while that was read already freed the session.
    if (sessionToTask.get(sessionKey) !== taskId) return
    if (await parkForHandedOutWork(sessionKey, taskId, summary)) return
    if (sessionToTask.get(sessionKey) !== taskId) return
    // Its agent chose to wait on its sub-tasks. Its work is checked with theirs, when
    // that wait is over and its follow-up has ended, like a task the engine parked.
    const chosen = parseWaitingOn((await deps.board.getTask(taskId))?.task['waitingOn'])
    if (chosen?.kind === 'subtasks') {
      if (sessionToTask.get(sessionKey) === taskId)
        await finishCompletion(sessionKey, taskId, summary, undefined, false, handOffs)
      return
    }
    // Check the work before it counts as done (see WorkCheck).
    if (deps.workCheck) {
      const agentId = deps.agentIdForSession(sessionKey)
      const mark = { taskId, check: ++nextCheck }
      checking.set(sessionKey, mark)
      // A prepare that fails is a check that could not run, never "nothing to
      // check": the work would otherwise reach Done unchecked.
      const check: PreparedWorkCheck | null = agentId
        ? await deps.workCheck
            .prepare(taskId, agentId)
            .catch((err: unknown) => () => Promise.reject(err))
        : null
      // A run that said nothing, in a folder a teammate was changing too: what the check
      // would pass may be the teammate's, so it says first. Its reply goes to the check.
      const speaksFirst =
        check?.sharedFolder === true &&
        !summary.trim() &&
        (await emptyReplyOf(sessionKey, taskId, summary, handOffs))?.empty !== false
      if (check && !speaksFirst) {
        // Detached, so nothing awaits it: it settles every path itself.
        void holdThenCheck(sessionKey, taskId, summary, check, mark.check, handOffs).catch(
          () => undefined,
        )
        return
      }
      if (checking.get(sessionKey) === mark) checking.delete(sessionKey)
      // A person's move that landed meanwhile already freed the session.
      if (sessionToTask.get(sessionKey) !== taskId) return
    }
    // No check applies. A run that changed the folder under a check never gets here,
    // unless it may not have been its change: the check decides what its silence means.
    await finishCompletion(sessionKey, taskId, summary, undefined, false, handOffs)
  }

  /** What this run's agent said about its task, or null: none, or no run tracked. */
  async function claimOfRun(taskId: string): Promise<ResultClaim | null> {
    const execId = taskToExec.get(taskId)
    return execId ? deps.board.resultClaim(execId).catch(() => null) : null
  }

  /**
   * A run ended well with work it handed out still out, or with results it has not
   * heard. It does not close its task: the run closes as the success it was, its report
   * goes on the card, and the task waits on its sub-tasks. The board releases it, in the
   * write that closes the last of them or on the pump's next pass, and it runs again
   * then: the one follow-up turn, which ends this same way, so it is checked and marked
   * done through the same path as any run.
   *
   * Its work is not checked here. A check now would measure a folder its own sub-tasks
   * are still writing, and it would hold for them to leave it. The follow-up's end
   * measures from where the task first began, with them done.
   *
   * Whoever handed out this task is not told: it is still outstanding on their list,
   * and its result comes when it is done. An unread board counts as work still out, and
   * the pump's pass reads it again. False when this run has nothing to wait for, or the
   * task is not this run's to park (a person moved it, or its agent blocked it).
   */
  async function parkForHandedOutWork(
    sessionKey: string,
    taskId: string,
    summary: string,
  ): Promise<boolean> {
    const views = await deps.board.subtasksOf(taskId)
    const out = views === null || subtasksStillOut(tallySubtasks(views))
    const rows = unheardReportUps(deps.reportUps?.pending() ?? [], taskId)
    const inMemory = reportsOnlyInMemory(taskId)
    // Results it has not heard earn it another turn, but only if that can change
    // anything. A turn takes some of them or new ones come. The same ones again means
    // this run could not take them, and another would not either: a paid loop the
    // no-progress brake would not catch, since each run ends well. They go out as a
    // follow-up on the closed task instead.
    const key = [...rows.map((r) => r.id), ...inMemory.map((i) => i.taskId ?? i.summary)].join(',')
    let unheard = key !== '' && unheardAtLastEnd.get(taskId) !== key
    // Only refused hand-offs, and no work out: that is a turn it may ask again in.
    const onlyRefusals = ![...rows.map((r) => r.item), ...inMemory].some((i) => i.taskId)
    if (unheard && !out && onlyRefusals && !spendRefusalTurn(taskId)) {
      await giveUpRefusals(taskId, rows, inMemory)
      unheard = false
    }
    if (unheard) unheardAtLastEnd.set(taskId, key)
    else unheardAtLastEnd.delete(taskId)
    if (!out && !unheard) return false
    const status = (await deps.board.getTask(taskId))?.task.status
    if (status !== 'in_progress' && status !== 'in_review') return false
    if (sessionToTask.get(sessionKey) !== taskId) return true
    const gen = deps.stopGen()
    const agentId = deps.agentIdForSession(sessionKey)
    const report = reportOf(summary)
    // Moved first, and the run closes only once the move landed: a run left closed on a
    // task In progress is one nothing can ever see again. A sub-task closing in between
    // finds the run open and leaves the wait as it is, for the release below.
    const moved = await deps.board.updateStatus(taskId, 'blocked', {
      waitingOn: { kind: 'subtasks', handedOut: true },
    })
    if (!moved) {
      const nowAt = (await deps.board.getTask(taskId))?.task.status
      // A person moved it meanwhile, or it was released: the ending handles that.
      if (nowAt !== 'in_progress' && nowAt !== 'in_review') return false
      // The write failed. Never Done over work still out. The run stays open, which is
      // what the board's stale sweep and `resume()` look for: the task goes back and runs
      // again, and that run parks. The report is not lost meanwhile.
      if (report)
        await deps.board
          .addComment(taskId, report, 'agent', agentId ?? undefined)
          .catch(() => undefined)
      unheardAtLastEnd.delete(taskId)
      dropSessionTracking(sessionKey)
      taskToExec.delete(taskId)
      taskReflectTo.delete(taskId)
      taskTitle.delete(taskId)
      humanTasks.delete(taskId)
      return true
    }
    const execId = taskToExec.get(taskId)
    if (execId) {
      taskToExec.delete(taskId)
      await deps.board.completeExecution(execId, { status: 'succeeded', summary: report })
    }
    forgetSession(sessionKey)
    // All read back from the durable row when it runs again.
    humanTasks.delete(taskId)
    taskReflectTo.delete(taskId)
    taskTitle.delete(taskId)
    if (report) await deps.board.addComment(taskId, report, 'agent', agentId ?? undefined)
    emit({ id: taskId, status: 'blocked', summary: report, updatedAt: now() })
    // A Stop that landed during those writes found no run here.
    if (deps.stopGen() !== gen) {
      await stopWaitingParent(taskId)
      return true
    }
    // All of it may already be in, while this run was ending.
    await deps.board.releaseSubtaskWait(taskId)
    await pumpReady(sessionKey)
    return true
  }

  /** A task's run ended well: wait for the host's say-so (see PreparedWorkCheck),
   *  bounded here so nothing can park the task for good, then check its work. The
   *  session stays under check throughout. */
  async function holdThenCheck(
    sessionKey: string,
    taskId: string,
    summary: string,
    check: PreparedWorkCheck,
    checkId: number,
    handOffs: number,
  ): Promise<void> {
    // A person's move while the check was being prepared ended its say: the session
    // may already be running the task again, so nothing here may touch the card.
    if (checking.get(sessionKey)?.check !== checkId || sessionToTask.get(sessionKey) !== taskId) {
      if (checking.get(sessionKey)?.check === checkId) checking.delete(sessionKey)
      return
    }
    if (!check.hold) return runWorkCheck(sessionKey, taskId, summary, check, checkId, handOffs)
    const held = { taskId, check: checkId, summary, cancel: new AbortController() }
    heldChecks.set(sessionKey, held)
    const limit = setAwakeTimeout(() => held.cancel.abort(), WORK_CHECK_HOLD_LIMIT_MS)
    let giveBack: () => void = () => undefined
    try {
      giveBack = await check.hold(held.cancel.signal)
    } catch {
      // A wait that broke says nothing about the work, which still gets checked.
    } finally {
      limit.clear()
    }
    try {
      // Whoever ended the wait owns what happens next (a person's move, a Stop).
      if (heldChecks.get(sessionKey) !== held) return
      heldChecks.delete(sessionKey)
      // The session was freed under it. Their move is the outcome.
      if (checking.get(sessionKey)?.check !== checkId || sessionToTask.get(sessionKey) !== taskId) {
        if (checking.get(sessionKey)?.check === checkId) checking.delete(sessionKey)
        return
      }
      // A Stop that has not reached `markStopped` yet: it starts nothing either.
      if (stopChangedFor(sessionKey)) {
        await releaseHeldCheck(sessionKey, held)
        return
      }
      // A pause that came after the run ended, so nothing reached this wait.
      const agentId = deps.agentIdForSession(sessionKey)
      const pausedBy = agentId ? deps.runHeldBy?.({ agentId, taskId }) : null
      if (pausedBy) {
        await releaseHeldCheck(sessionKey, held, pausedBy)
        return
      }
      await runWorkCheck(sessionKey, taskId, summary, check, checkId, handOffs)
    } finally {
      giveBack()
    }
  }

  /** A Stop reached a check still waiting: it never starts, because it could start a
   *  paid reviewer after the person halted the team. The work does not reach Done
   *  unchecked either. The task goes back to To do as stopped, with its report kept,
   *  and a Retry checks it from where it first began. From In review that takes two
   *  moves. If the first fails the task stays short of Done and under check, and the
   *  sweep hands it to a person (see retryPark). A pause (`pausedBy`, its words) ends
   *  the wait the same way, except that the task then starts again by itself on resume. */
  async function releaseHeldCheck(
    sessionKey: string,
    held: { taskId: string; check: number; summary: string },
    pausedBy?: string,
  ): Promise<void> {
    const { taskId, check, summary } = held
    const stillOurs = (): boolean =>
      checking.get(sessionKey)?.check === check && sessionToTask.get(sessionKey) === taskId
    if (!stillOurs()) {
      if (checking.get(sessionKey)?.check === check) checking.delete(sessionKey)
      return
    }
    if (!(await deps.board.updateStatus(taskId, 'in_progress').catch(() => false))) {
      const status = (await deps.board.getTask(taskId).catch(() => null))?.task.status
      if (!status || status === 'in_review') {
        pendingPark.set(sessionKey, {
          taskId,
          summary,
          reason: `A ${pausedBy ? 'pause' : 'Stop'} ended the wait for this check, so its work was not checked.`,
          checkId: check,
          comment: true,
        })
        return
      }
      // A person moved it meanwhile. Their move stands, and the report is kept the
      // way any late result is.
      try {
        if (stillOurs()) await finishCompletion(sessionKey, taskId, summary)
      } finally {
        if (checking.get(sessionKey)?.check === check) checking.delete(sessionKey)
      }
      return
    }
    if (checking.get(sessionKey)?.check === check) checking.delete(sessionKey)
    await releaseClaimed(taskId, sessionKey, summary, !pausedBy, pausedBy)
  }

  /** A task's work is being checked (see WorkCheck): act on what the check found. */
  async function runWorkCheck(
    sessionKey: string,
    taskId: string,
    summary: string,
    check: () => Promise<WorkCheckResult>,
    checkId: number,
    handOffs: number,
  ): Promise<void> {
    // A check that cannot run, or never answers, cannot pass the work, and the
    // board would refuse `done` over an earlier failed attempt anyway: the task
    // waits for a person. Moved here, since the host's check did not move it.
    let parkedByEngine = false
    let giveUp: (r: WorkCheckResult) => void = () => undefined
    const timedOut = new Promise<WorkCheckResult>((resolve) => {
      giveUp = resolve
    })
    const deadline = setAwakeTimeout(() => {
      parkedByEngine = true
      giveUp({
        verdict: 'failed',
        reason: `The work check did not answer within ${Math.round(WORK_CHECK_TIMEOUT_MS / 60_000)} minutes.`,
      })
    }, WORK_CHECK_TIMEOUT_MS)
    let result: WorkCheckResult
    try {
      result = await Promise.race([check(), timedOut])
    } catch (err) {
      const why = err instanceof Error ? err.message : String(err)
      result = { verdict: 'failed', reason: `The work check could not run: ${why}` }
      parkedByEngine = true
    } finally {
      deadline.clear()
    }
    const endCheck = (): void => {
      if (checking.get(sessionKey)?.check === checkId) checking.delete(sessionKey)
    }
    // Superseded: a person's move ended this check's say over the task (it may
    // even be running again, with a check of its own to come), or the session was
    // freed. Their move is the outcome, and this answer is not the task's.
    if (checking.get(sessionKey)?.check !== checkId || sessionToTask.get(sessionKey) !== taskId) {
      endCheck()
      return
    }
    // Nobody finished the task and the check did not speak for it: the card was put
    // back to In progress through the API, which tells the engine nothing. It must
    // not reach Done unchecked. The report stays, the session is freed, and the open
    // run is left for the board's stale sweep, which releases the task.
    if (result.verdict === 'decided') {
      const status = (await deps.board.getTask(taskId).catch(() => null))?.task.status
      if (!status || status === 'in_progress' || status === 'in_review') {
        const report = reportOf(summary)
        if (report)
          await deps.board
            .addComment(
              taskId,
              `[late result: this card was moved back before its check] ${report}`,
              'agent',
              deps.agentIdForSession(sessionKey) ?? undefined,
            )
            .catch(() => undefined)
        dropSessionTracking(sessionKey)
        humanTasks.delete(taskId)
        taskToExec.delete(taskId)
        taskReflectTo.delete(taskId)
        taskTitle.delete(taskId)
        endCheck()
        return
      }
    }
    if (result.verdict === 'retry') {
      // Another turn is running or queued on the agent's session (a person's
      // @mention, say). The fix round goes out once it ends, and until then the
      // session stays under check, so that turn's reply is not taken for the fix.
      const round = fixRound(taskId, summary, result.fixNote)
      if (!stopChangedFor(sessionKey) && deps.isSessionOccupied?.(sessionKey)) {
        pendingFix.set(sessionKey, round)
        return
      }
      // The fix round's own terminal must reach the task, so the check ends first.
      endCheck()
      // After a Stop no fix round starts: the task goes back to To do as stopped.
      if (stopChangedFor(sessionKey)) await releaseClaimed(taskId, sessionKey, summary)
      else await startRound(sessionKey, round)
      return
    }
    // Still marked as checked until the result is written: the card is In review
    // until then, and `resume()` must not take it for a check a restart cut short.
    // Ended whatever happens, so a failed board write cannot leave the session
    // under check for good. The one exception waits on purpose: a check that
    // could not run whose task the board will not move to Blocked. Finishing it
    // then would write Done over work nobody checked, so it stays under check
    // and the sweep tries the move again (retryPark).
    let waiting = false
    try {
      if (parkedByEngine && result.verdict === 'failed') {
        await deps.board.addComment(taskId, result.reason, 'system').catch(() => undefined)
        if (!(await parkFailedCheck(taskId))) {
          pendingPark.set(sessionKey, { taskId, summary, reason: result.reason, checkId })
          // Its reason, so it reaches Needs you even while the move keeps failing.
          await deps.board
            .setWaitingOn?.(taskId, { kind: 'verification', state: 'park_pending' })
            ?.catch(() => undefined)
          waiting = true
          return
        }
      }
      await finishCompletion(
        sessionKey,
        taskId,
        summary,
        result.verdict === 'failed' ? result.reason : undefined,
        result.verdict === 'pass',
        // A check that could not look spoke for nothing, so a silent run is still silent.
        result.verdict === 'unchecked' ? handOffs : undefined,
      )
    } finally {
      if (!waiting) endCheck()
    }
  }

  /** Move a task whose check could not run to Blocked. False while the move fails
   *  and the task is still the check's (In progress or In review) or cannot be
   *  read; a task a person moved meanwhile needs no move. */
  async function parkFailedCheck(taskId: string): Promise<boolean> {
    if (
      await deps.board
        .updateStatus(taskId, 'blocked', {
          waitingOn: { kind: 'verification', state: 'could_not_run' },
        })
        .catch(() => false)
    )
      return true
    // Unread: try again. The server's client answers a failed read with null, and
    // a task row is never deleted (only marked dropped), so null is never "gone".
    const detail = await deps.board.getTask(taskId).catch(() => null)
    if (!detail) return false
    const status = detail.task.status
    return status !== 'in_progress' && status !== 'in_review'
  }

  /** Try the move to Blocked again for a check waiting on it (see runWorkCheck),
   *  and finish the task once it lands. Run by the sweep. */
  async function retryPark(sessionKey: string): Promise<void> {
    const p = pendingPark.get(sessionKey)
    if (!p) return
    if (
      checking.get(sessionKey)?.check !== p.checkId ||
      sessionToTask.get(sessionKey) !== p.taskId
    ) {
      // A person's move ended the check; their move is the outcome.
      pendingPark.delete(sessionKey)
      return
    }
    if (!(await parkFailedCheck(p.taskId))) return
    pendingPark.delete(sessionKey)
    try {
      if (p.comment)
        await deps.board.addComment(p.taskId, p.reason, 'system').catch(() => undefined)
      await finishCompletion(sessionKey, p.taskId, p.summary, p.reason)
    } finally {
      if (checking.get(sessionKey)?.check === p.checkId) checking.delete(sessionKey)
    }
  }

  /** Try a waiting fix round once the session's current turn has ended: deferred
   *  one macrotask, out of that turn's drain, which still holds the agent's lock
   *  (see pumpReady). */
  const deferPendingFix = (sessionKey: string): void => {
    if (!pendingFix.has(sessionKey)) return
    const t = setTimeout(() => {
      deferredFires.delete(t)
      void sendPendingFix(sessionKey).catch(() => undefined)
    }, 0)
    ;(t as { unref?: () => void }).unref?.()
    deferredFires.add(t)
  }

  /** Send a fix round that waited for the session's other turn, once the session
   *  is free. Tried after each terminal and close of the session, and by the sweep. */
  async function sendPendingFix(sessionKey: string): Promise<void> {
    const p = pendingFix.get(sessionKey)
    if (!p) return
    if (sessionToTask.get(sessionKey) !== p.taskId) {
      // A person's move freed the session; their move is the outcome.
      pendingFix.delete(sessionKey)
      if (checking.get(sessionKey)?.taskId === p.taskId) checking.delete(sessionKey)
      return
    }
    if (deps.isSessionOccupied?.(sessionKey)) return
    pendingFix.delete(sessionKey)
    checking.delete(sessionKey)
    if (stopChangedFor(sessionKey)) await releaseClaimed(p.taskId, sessionKey, p.summary)
    else await startRound(sessionKey, p)
  }

  const fixRound = (taskId: string, summary: string, fixNote: string): PendingRound => ({
    taskId,
    summary,
    lead:
      `[Check failed] The team's check did not pass your work on this task yet.\n\n${fixNote}\n\n` +
      'Fix it, then reply with what you changed.',
    reason: 'fix_round',
  })

  /**
   * A run ended well, and a person's comment on its task is still waiting: it came
   * too late for the run to take it live, or while the work was being checked. The
   * comment gets the next turn, before the task counts as Done, because Done cannot
   * be undone and it would never reach the agent after that. The run's result goes on
   * the card now, so a fresh session sees it too, and the agent's reply becomes the
   * task's result. It goes out like a fix round: after this terminal's drain, and
   * after any other turn on the session. False when there is nothing to answer, or
   * the task is not this run's to go on with (a person moved it, or its agent blocked
   * it, which the pump restarts for the comment).
   */
  async function offerCommentTurn(
    sessionKey: string,
    taskId: string,
    summary: string,
  ): Promise<boolean> {
    if (!deps.taskWakes || stopChangedFor(sessionKey)) return false
    let waiting: Array<{ id: string; commentIds: string[] }> = []
    try {
      waiting = deps.taskWakes.fromPersonWaiting(taskId)
    } catch {
      return false
    }
    if (waiting.length === 0) return false
    const status = (await deps.board.getTask(taskId))?.task.status
    if (status === 'in_review') {
      if (!(await deps.board.updateStatus(taskId, 'in_progress'))) return false
      emit({ id: taskId, status: 'in_progress', updatedAt: now() })
    } else if (status !== 'in_progress') return false
    const compacted = deps.compact ? deps.compact(summary) : summary
    const trimmed = compacted.slice(0, 20_000)
    const agentId = deps.agentIdForSession(sessionKey)
    if (trimmed) await deps.board.addComment(taskId, trimmed, 'agent', agentId ?? undefined)
    // A check that passed let go of where the task began, or a run that changed nothing
    // never needed it. The reply is work too, so the next check needs a starting point.
    // One still held stays as it is, and the next check covers everything since.
    if (agentId) await beginWork(taskId, agentId)
    pendingFix.set(sessionKey, {
      taskId,
      summary,
      lead:
        '[New comment] A person commented on this task after your last turn, and you have not read it: it is in your task block above. ' +
        "Answer it and do what it asks. Your reply becomes this task's result, replacing what you reported before, so say everything that still matters.",
      reason: 'person_comment',
      wakeIds: waiting.map((w) => w.id),
    })
    checking.set(sessionKey, { taskId, check: ++nextCheck })
    deferPendingFix(sessionKey)
    return true
  }

  /** Where a task's current run sits in its ledger. */
  const currentRunIndex = (execs: readonly ExecutionSummary[], taskId: string): number => {
    const execId = taskToExec.get(taskId)
    const at = execs.findIndex((e) => e.id === execId)
    return at >= 0 ? at : execs.length - 1
  }

  /**
   * What a run with no text showed for itself, counting the whole stretch of work it
   * belongs to: a retry that repeats nothing still has what its first try did. Null when
   * it cannot be told, which is read as nothing shown. `again`: this stretch has already
   * had the turn an empty reply gets.
   */
  async function emptyReplyOf(
    sessionKey: string,
    taskId: string,
    summary: string,
    handOffs: number,
  ): Promise<{ empty: boolean; again: boolean; why: NoTextWhy | null } | null> {
    const detail = await deps.board.getTask(taskId)
    const execs = await deps.board.listExecutions(taskId).catch(() => null)
    if (!detail || !execs) return null
    const at = currentRunIndex(execs, taskId)
    const since = stretchStartedAt(execs, at)
    const inThisWork = (createdAt: unknown): boolean =>
      typeof createdAt === 'number' && since !== null && createdAt >= since
    const agentId = deps.agentIdForSession(sessionKey)
    const agentComments = detail.comments.filter((c) => {
      const row = c as { kind?: unknown; authorAgentId?: unknown; createdAt?: unknown }
      return (
        row.kind === 'agent' &&
        (row.authorAgentId == null || row.authorAgentId === agentId) &&
        inThisWork(row.createdAt)
      )
    }).length
    const tasks = await deps.board.listTasks(deps.teamId).catch(() => [] as BoardTask[])
    const subTasks = tasks.filter(
      (t) =>
        t.parentTaskId === taskId &&
        (typeof t['createdAt'] !== 'number' || since === null || inThisWork(t['createdAt'])),
    ).length
    return {
      empty: replyIsEmpty({
        summary,
        handOffs,
        subTasks,
        agentComments,
        reported: (await claimOfRun(taskId)) !== null,
      }),
      again: extraTurnUsed(execs, 'empty_reply', at),
      why: handOffs + subTasks > 0 ? 'handed_on' : agentComments > 0 ? 'commented' : null,
    }
  }

  /** Queue the turn a round is: after this terminal's drain, and after any other turn
   *  on the session, with the session under check until it goes out so that other
   *  turn's reply is not taken for it. Its work needs a starting point for the next
   *  check, and one still held stays as it is. */
  async function queueRound(sessionKey: string, round: PendingRound): Promise<void> {
    const agentId = deps.agentIdForSession(sessionKey)
    if (agentId) await beginWork(round.taskId, agentId)
    pendingFix.set(sessionKey, round)
    checking.set(sessionKey, { taskId: round.taskId, check: ++nextCheck })
    deferPendingFix(sessionKey)
  }

  /**
   * A run ran out of room before finishing: one continuation, as the task runner gives
   * one. What it wrote so far goes on the card, since a continuation may start a fresh
   * session. A second ending goes to Blocked and says so. Read from the ledger, so a
   * restart hands out no second one. False when it is not this path's to decide: after a
   * Stop, or on a task its agent parked or a person moved.
   */
  async function endOutOfRoom(sessionKey: string, summary: string): Promise<boolean> {
    const taskId = sessionToTask.get(sessionKey)
    if (!taskId || stopChangedFor(sessionKey)) return false
    const status = (await deps.board.getTask(taskId))?.task.status
    if (status !== 'in_progress') return false
    const execs = await deps.board.listExecutions(taskId).catch(() => null)
    if (!execs || extraTurnUsed(execs, 'max_turns', currentRunIndex(execs, taskId))) {
      await failForSession(sessionKey, 'max_turns', summary, {
        keepPlan: true,
        waitingOn: { kind: 'out_of_room' },
        note: 'Ran out of room before finishing, twice, so it waits for a person',
      })
      return true
    }
    const report = reportOf(summary)
    const agentId = deps.agentIdForSession(sessionKey)
    if (report) await deps.board.addComment(taskId, report, 'agent', agentId ?? undefined)
    await deps.board.addComment(
      taskId,
      'Ran out of room before finishing, so it gets one more run to continue.',
      'system',
    )
    await queueRound(sessionKey, {
      taskId,
      summary,
      lead:
        '[Ran out of room] Your last run on this task stopped before it finished, because it ran out of room. ' +
        'What it wrote so far is on the task. Continue from where it stopped: check what is already done first, and finish the rest.',
      reason: 'max_turns',
      closeAs: { status: 'failed', error: FAIL_REASON_LABEL.max_turns },
    })
    return true
  }

  /**
   * A task's run failed on the provider (a rate limit, an overload, a dropped network):
   * nothing is wrong with the work, and trying again later can get past it. The task goes
   * back to To do saying so, and the pump starts it again after the wait, MAX_PROVIDER_RETRIES
   * times at most. It is off the session and the run slot by then, and the ledger is the
   * count and the clock, so a restart picks up from there: the pump's next pass after the
   * wait starts it, and a Stop's tombstone or a person's move ends it. Only the runtime's
   * own error is read, never a run's summary. `exhausted`: its retries are used up.
   */
  async function retryProviderFailure(
    sessionKey: string,
    event: { code: string | null; message: string },
  ): Promise<'waiting' | NoMoreTries | 'no'> {
    const taskId = sessionToTask.get(sessionKey)
    if (!taskId || stopChangedFor(sessionKey)) return 'no'
    if (event.code === BUDGET_REFUSED_CODE || event.code === BUDGET_HELD_CODE) return 'no'
    const detail = (event.message ?? '').slice(0, 4000).trim()
    const errorClass = classifyError(event.code, detail)
    if (!isTransientError(errorClass)) return 'no'
    const cause = providerFailureOf({ status: 'failed', errorClass })
    const task = (await deps.board.getTask(taskId))?.task
    const execs = await deps.board.listExecutions(taskId).catch(() => null)
    // Its agent parked it, a person moved it, or nothing can start it again.
    if (!cause || task?.status !== 'in_progress' || !execs || !targetForTask(task)) return 'no'
    const execId = taskToExec.get(taskId) ?? execs[execs.length - 1]?.id
    const closed = execs.map((e) => (e.id === execId ? { ...e, status: 'failed', errorClass } : e))
    const used = providerRetriesUsed(closed)
    if (used >= MAX_PROVIDER_RETRIES) return 'retried_twice'
    // The pump's own limit stands whatever this count says, so no retry is promised that
    // it would refuse. A person's Retry of a task that keeps failing lands here.
    if (!ledgerWillAutoFire(closed)) return 'too_many_failures'
    const startGen = sessionStartGen.get(sessionKey)
    // Off the session first: the move to To do reaches `detachTask` at once, and a task
    // still mapped there would have its run closed as one that never started.
    deps.abortSession?.(sessionKey)
    forgetSession(sessionKey)
    taskToExec.delete(taskId)
    const attempt = used + 1
    const moved = await deps.board
      .updateStatus(taskId, 'todo', {
        waitingOn: { kind: 'retry', cause, attempt },
        // The same work is coming back: a check it failed still counts, and so do the
        // attempts that bound its fix rounds.
        keepVerdict: true,
      })
      .catch(() => false)
    if (!moved) {
      // Still the run's, and it failed: a person hears, the way any failure goes.
      sessionToTask.set(sessionKey, taskId)
      if (startGen !== undefined) sessionStartGen.set(sessionKey, startGen)
      if (execId) taskToExec.set(taskId, execId)
      return 'no'
    }
    humanTasks.delete(taskId)
    // Moved first: a restart in between finds a released task with an open run, which
    // the boot reap closes. The other way round it would find a claimed task with none.
    if (execId)
      await deps.board.completeExecution(execId, {
        status: 'failed',
        error: detail || FAIL_REASON_LABEL.error,
        errorClass,
      })
    const waitMs = PROVIDER_RETRY_WAITS_MS[used]!
    await deps.board.addComment(
      taskId,
      `${PROVIDER_FAILURE[cause].waiting}: ${detail.replace(/[.\s]+$/, '') || '(no details)'}. Trying again in about ${waitMs / 1000} seconds (${attempt} of ${MAX_PROVIDER_RETRIES}). A comment from you starts it now.`,
      'system',
    )
    emit({ id: taskId, status: 'todo', assigneeAgentId: null, updatedAt: now() })
    // Jitter, so a limit that hit several tasks at once does not bring them back at once.
    // Never shorter than the wait: the point of the wait is to outlast the trouble.
    beginRetryWait(taskId, waitMs + Math.floor(Math.random() * (waitMs / 4)))
    // The agent is free for other work meanwhile.
    await pumpReady(sessionKey)
    return 'waiting'
  }

  /**
   * A failed check with an attempt left, a person's comment before Done, an empty reply
   * or a run out of room: the same agent takes the task again, told why and given the
   * task again (a team run starts a fresh session). A run of its own, so the first run's execution closes as the
   * success it was, and the task's stamp moves to this one. The task's starting point
   * stays where its first run began, so the next check covers all of the task's work.
   */
  async function startRound(sessionKey: string, round: PendingRound): Promise<void> {
    const { taskId, summary, lead, reason, wakeIds = [], closeAs } = round
    const agentId = deps.agentIdForSession(sessionKey)
    // A pause covers it: no round starts. The task waits in To do with what the check
    // found, and fires again on resume like any run a pause stopped, rather than
    // holding its agent's session for the whole pause. A person's comment keeps its
    // saved wake, and its report is on the card already (see offerCommentTurn).
    const heldBy = agentId ? (deps.runHeldBy?.({ agentId, taskId }) ?? null) : null
    if (heldBy) {
      const fix = reason === 'fix_round'
      if (fix) await deps.board.addComment(taskId, lead, 'system')
      // What the round was to be told is what the run on resume is told.
      roundLeads.set(taskId, lead)
      await releaseClaimed(taskId, sessionKey, fix ? summary : undefined, false, heldBy)
      return
    }
    let detail: Awaited<ReturnType<EngineBoardClient['getTask']>>
    let exec: ExecutionRef | null
    const prevExec = taskToExec.get(taskId)
    let prevClosed = false
    try {
      detail = await deps.board.getTask(taskId)
      if (prevExec) {
        taskToExec.delete(taskId)
        const compacted = deps.compact ? deps.compact(summary) : summary
        await deps.board.completeExecution(prevExec, {
          status: 'succeeded',
          ...closeAs,
          summary: compacted.slice(0, 20_000),
        })
        prevClosed = true
      }
      exec =
        agentId && detail
          ? await deps.board.createExecution(taskId, 'openclaw', { runReason: reason })
          : null
    } catch (err) {
      // A fix round that cannot be set up is a failed run, not one still going:
      // the task goes to a person with the reason. A first run that could not be
      // closed is the task's again, so the failure closes it.
      if (prevExec && !prevClosed && !taskToExec.has(taskId)) taskToExec.set(taskId, prevExec)
      const why = err instanceof Error ? err.message : String(err)
      await failForSession(sessionKey, 'error', `Could not start the fix round: ${why}`, {
        keepPlan: true,
      })
      return
    }
    if (!agentId || !detail) {
      await releaseClaimed(taskId, sessionKey, undefined, false)
      return
    }
    if (!exec) {
      // Released, its fix note would be lost and the pump could run it again as
      // new work; the task goes to a person instead, as for a write that threw.
      await failForSession(
        sessionKey,
        'error',
        'Could not start the fix round: the board did not record its run.',
        { keepPlan: true },
      )
      return
    }
    taskToExec.set(taskId, exec.id)
    roundLeads.set(taskId, lead)
    const startGen = deps.stopGen()
    sessionStartGen.set(sessionKey, startGen)
    lastActivityAt.set(sessionKey, now())
    const message = `${lead} The task:\n\n${briefFor(detail.task)}`
    pendingStart.set(sessionKey, taskId)
    let delivered = false
    try {
      await deps.deliver(
        sessionKey,
        agentId,
        message,
        taskRunOrigin(
          taskId,
          wakeIds.map((id) => ({ id, reason: 'person_comment' as const, commentIds: [] })),
        ),
      )
      delivered = true
    } catch (err) {
      await failForSession(
        sessionKey,
        'error',
        err instanceof DeliveryRefusedError
          ? err.message
          : `Could not send the fix to ${nameOf(agentId)} (the message was rejected).`,
        { keepPlan: true, ...refusedErrorOpts(err) },
      )
    } finally {
      if (pendingStart.get(sessionKey) === taskId) pendingStart.delete(sessionKey)
    }
    if (delivered) await settleDelivery(taskId, sessionKey, startGen)
  }

  /** A task's run ended well (and its work passed or needed no check, or failed
   *  it for good: `checkFailure`): record the result and report it up. */
  async function finishCompletion(
    sessionKey: string,
    taskId: string,
    summary: string,
    checkFailure?: string,
    /** This attempt's work passed the team's check. */
    checkPassed = false,
    /** The hand-offs its turn made, on a run no check spoke for: what it shows for itself
     *  is all there is. */
    handOffs?: number,
  ): Promise<void> {
    // A person's comment this run did not hear goes before Done.
    if (!checkFailure && (await offerCommentTurn(sessionKey, taskId, summary))) return
    const claim = await claimOfRun(taskId)
    // An empty reply never lands in Done (see `emptyReplyOf`): it gets one more turn, then
    // goes to Blocked. A task a person moved or its agent blocked is not this run's
    // to go on with, and is handled below.
    let noText: NoTextWhy | null = checkPassed && !summary.trim() ? 'check_passed' : null
    let nothingToShow: 'once' | 'twice' | null = null
    if (handOffs !== undefined && !summary.trim()) {
      const detail = await deps.board.getTask(taskId)
      const status = detail?.task.status
      if (!detail || status === 'in_progress' || status === 'in_review') {
        const seen = await emptyReplyOf(sessionKey, taskId, summary, handOffs)
        if (seen && !seen.empty) noText = seen.why
        else if (stopChangedFor(sessionKey)) {
          await releaseClaimed(taskId, sessionKey)
          return
        } else if (seen && !seen.again) {
          const back =
            status === 'in_progress' || (await deps.board.updateStatus(taskId, 'in_progress'))
          if (back) {
            if (status !== 'in_progress')
              emit({ id: taskId, status: 'in_progress', updatedAt: now() })
            await queueRound(sessionKey, {
              taskId,
              summary,
              lead:
                '[No reply] Your last turn on this task ended without a reply. ' +
                'If the work is finished, say what you did and where the result is. If it is not, carry on and finish it, then reply with what you did.',
              reason: 'empty_reply',
            })
            return
          }
          nothingToShow = 'once'
        } else nothingToShow = seen?.again ? 'twice' : 'once'
      }
    }
    roundLeads.delete(taskId)
    // Capture the Stop verdict BEFORE forgetSession clears the generation. A Stop
    // since this delegation was dispatched suppresses the amplifying tail
    // (narration + reflection + ready-pump) — the board write below is truth and
    // always runs, but no new turn is started after the user halted.
    const stopped = stopChangedFor(sessionKey)
    forgetSession(sessionKey)
    // A person assigned this task: its result is theirs, read on the card. It is
    // recorded on the board exactly like a delegation's, but no agent is told:
    // handing it to the team lead would make the lead act on work nobody asked it
    // to coordinate.
    const human = humanTasks.delete(taskId)
    // Compact verbose tool output in the report-up BEFORE it's recorded/relayed
    // (flag-on). Pass-through-safe + failure-preserving — never drops an error.
    const compacted = deps.compact ? deps.compact(summary) : summary
    // The reply is the report. An agent that reported and then ended with no words has
    // said what it did; what it made is listed either way.
    const said = compacted.trim() ? compacted : (claim?.summary ?? compacted)
    const trimmed = (
      claim?.deliverables?.length
        ? `${said}\n\nDeliverables: ${claim.deliverables.join(', ')}`
        : said
    ).slice(0, 20_000)
    const agentId = deps.agentIdForSession(sessionKey)
    const by = nameOf(agentId)
    const title = taskTitle.get(taskId)
    // A person finished or cancelled the task while this run was going. Their
    // move stands: the result is kept on the task, nothing is re-stamped, and the
    // delegator, already told what the person decided, is not told again.
    if (await decidedByPerson(taskId)) {
      const execId = taskToExec.get(taskId)
      if (execId) {
        taskToExec.delete(taskId)
        await deps.board.completeExecution(execId, {
          status: 'cancelled',
          error: RUN_CLOSED_FINISHED_BY_PERSON,
          byPerson: true,
        })
      }
      if (trimmed)
        await deps.board.addComment(
          taskId,
          `[late result: a person had already finished this task] ${trimmed}`,
          'agent',
          agentId ?? undefined,
        )
      taskReflectTo.delete(taskId)
      taskTitle.delete(taskId)
      return
    }
    // The agent blocked its own task during this run (its `block_task`): it
    // cannot go on without a person. A person's block reaches the engine first
    // (`personMovedTask` stops the run and forgets its session), so a task still
    // mapped here was blocked from inside the run. The run itself ended normally,
    // so its execution succeeded; the card stays blocked, the result is kept, and
    // the delegator hears that the task waits on a person. The steps waiting on
    // it stay queued, so a person's Retry carries the plan on. A check that failed
    // on its last attempt parks the task the same way (`checkFailure`).
    const closeBlocked = async (
      failure: string | undefined,
      outcome:
        'check_failed' | 'blocked' | 'done_refused' | 'asked' | 'waiting' | 'no_result' = failure
        ? 'check_failed'
        : 'blocked',
    ): Promise<void> => {
      const execId = taskToExec.get(taskId)
      if (execId) {
        taskToExec.delete(taskId)
        await deps.board.completeExecution(execId, { status: 'succeeded', summary: trimmed })
      }
      if (trimmed) await deps.board.addComment(taskId, trimmed, 'agent', agentId ?? undefined)
      emit({ id: taskId, status: 'blocked', summary: trimmed, updatedAt: now() })
      if (!human) {
        const to = reflectTargetFor(taskId)
        const scope = await followUpScopeOf(taskId, to)
        reportUp(
          {
            toAgentId: to,
            by,
            title,
            summary:
              failure ??
              (trimmed ||
                (outcome === 'blocked'
                  ? `${by} did not say why.`
                  : outcome === 'asked'
                    ? `${by} asked a person a question.`
                    : outcome === 'waiting'
                      ? `${by} is waiting on other work.`
                      : outcome === 'no_result'
                        ? `${by} finished “${title ?? 'the task'}” with no reply and nothing else to show for it.`
                        : '')),
            outcome,
            taskId,
            ...(scope ? { forTaskId: scope } : {}),
          },
          stopped,
        )
      }
      taskReflectTo.delete(taskId)
      taskTitle.delete(taskId)
      if (!stopped) await pumpReady(sessionKey)
    }
    const atEnd = (await deps.board.getTask(taskId))?.task
    if (atEnd?.status === 'blocked') {
      // A question open, or a wait on other work: its own report, because the delegator
      // must not redo or reassign it. The answer, or that work ending, starts it again.
      // No reason left, and a person's wake waiting: they answered while this run was
      // still ending, so the task starts again by itself as soon as it closes.
      const answered =
        !atEnd['waitingOn'] && (deps.taskWakes?.fromPersonWaiting(taskId).length ?? 0) > 0
      const wait = checkFailure
        ? null
        : answered
          ? ('asked' as const)
          : chosenWaitOutcome(atEnd['waitingOn'])
      await closeBlocked(checkFailure, ...(wait ? ([wait] as const) : []))
      return
    }
    // The server decides, in one place: see `decideDone`.
    const views = await deps.board.subtasksOf(taskId)
    const decision = decideDone({
      claim,
      check: checkFailure ? 'failed' : checkPassed ? 'pass' : deps.workCheck ? 'unchecked' : 'none',
      storedVerdictPasses: storedVerdictPasses(atEnd),
      // A run that ended on an error does not come here: see failForSession.
      errorClass: null,
      unfinishedSubtasks: unfinishedSubtasks(tallySubtasks(views ?? [])),
    })
    // The agent says it did not get there, or work it handed out did not finish and it
    // has not said that is fine. Not Done: a person reads why and decides. The run itself
    // ended normally, and the steps waiting on the task stay queued, as for a self-block.
    const notDoneByWord =
      !decision.done && (decision.because === 'claim' || decision.because === 'subtasks')
    // Still this run's to end. A Stop does not change that: its check answered, and a
    // person reads the answer. After a Stop already released the task, it stays released.
    if (
      notDoneByWord &&
      (!atEnd || atEnd.status === 'in_progress' || atEnd.status === 'in_review')
    ) {
      const need =
        decision.because === 'claim'
          ? `Its agent reported it did not finish: ${claim?.summary ?? ''}`.slice(0, 1_000)
          : unfinishedNeed(views ?? [])
      if (
        await deps.board
          .updateStatus(taskId, 'blocked', {
            waitingOn: {
              kind: 'person',
              need,
              by: 'agent',
              // Those sub-tasks closing is what the card tells a person to bring about.
              ...(decision.because === 'subtasks' ? { untilSubtasks: true as const } : {}),
            },
          })
          .catch(() => false)
      ) {
        await deps.board.addComment(taskId, need, 'system').catch(() => undefined)
        await closeBlocked(trimmed ? `${need}\n\n${trimmed}` : need, 'blocked')
        return
      }
      // Not moved. If it is still this run's, nothing is written over it and its run stays
      // open, as for a check that failed: `resume()` hands an In review task to a person,
      // and the stale sweep releases an In progress one.
      const held = (await deps.board.getTask(taskId).catch(() => null))?.task.status
      if (!held || held === 'in_progress' || held === 'in_review') {
        taskToExec.delete(taskId)
        taskReflectTo.delete(taskId)
        taskTitle.delete(taskId)
        return
      }
    }
    // Work that failed its check never ends in Done, even when the move to
    // Blocked before this (the host's, or the engine's) did not hold: the task
    // is parked here instead. Not parked and still the check's, nothing is
    // written over it and its run stays open: the next `resume()` hands an In
    // review task to a person, and the board's stale sweep releases an In
    // progress one. A task released meanwhile is handled as below.
    let ok = false
    if (nothingToShow) {
      if (
        await deps.board
          .updateStatus(taskId, 'blocked', { waitingOn: { kind: 'no_result' } })
          .catch(() => false)
      ) {
        await deps.board
          .addComment(
            taskId,
            `${by} finished${nothingToShow === 'twice' ? ' twice' : ''} with no reply and nothing else to show for it, so the task waits for a person. Retry it, or give it to someone else.`,
            'system',
          )
          .catch(() => undefined)
        await closeBlocked(undefined, 'no_result')
        return
      }
      // Never Done. Still the run's, nothing is written over it and its run stays open,
      // so the board's stale sweep releases it. Released meanwhile, it goes as below.
      const held = (await deps.board.getTask(taskId).catch(() => null))?.task.status
      if (!held || held === 'in_progress' || held === 'in_review') {
        taskToExec.delete(taskId)
        taskReflectTo.delete(taskId)
        taskTitle.delete(taskId)
        return
      }
    } else if (checkFailure) {
      if (
        await deps.board
          .updateStatus(taskId, 'blocked', { waitingOn: { kind: 'verification', state: 'failed' } })
          .catch(() => false)
      ) {
        await closeBlocked(checkFailure)
        return
      }
      const held = (await deps.board.getTask(taskId).catch(() => null))?.task.status
      if (!held || held === 'in_progress' || held === 'in_review') {
        taskToExec.delete(taskId)
        taskReflectTo.delete(taskId)
        taskTitle.delete(taskId)
        return
      }
    } else if (decision.done || decision.because === 'stored_verdict')
      // A stored verdict that fails is the board's own gate too: it answers the write.
      ok = await deps.board.updateStatus(taskId, 'done')
    if (!ok && deps.workCheck && !checkFailure && !notDoneByWord && !nothingToShow) {
      // Not released but held. Unchecked, the board refuses `done` over a check
      // that failed on an earlier attempt (this one's change could not be
      // measured). Checked and passed, no verdict stands in the way, so the write
      // itself failed. Either way a person decides, told which it was.
      const held = (await deps.board.getTask(taskId))?.task.status
      if (
        (held === 'in_progress' || held === 'in_review') &&
        (await deps.board.updateStatus(taskId, 'blocked', {
          waitingOn: { kind: 'verification', state: checkPassed ? 'done_refused' : 'failed' },
        }))
      ) {
        const why = checkPassed
          ? "The team's check passed, but the board did not mark the task done, so it waits for a person."
          : "An earlier attempt failed the team's check and this one could not be checked, so the task was kept from Done."
        await deps.board.addComment(taskId, why, 'system').catch(() => undefined)
        // After a pass the update carries the agent's result, and its outcome says
        // what happened: the work passed, and the board did not take it to Done.
        if (checkPassed) await closeBlocked(undefined, 'done_refused')
        else await closeBlocked(why, 'check_failed')
        return
      }
    }
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
          error: RUN_CLOSED_RESULT_AFTER_RELEASE,
        })
      }
      // The work itself must survive the refusal: the child DID produce a result,
      // and discarding it means a re-delegation redoes finished work. Preserve it
      // as a comment on the task (comments aren't status-gated), clearly marked as
      // late, so the next claimant — or the leader — starts from it.
      if (trimmed) {
        await deps.board.addComment(
          taskId,
          `[late result — the task had been released before this arrived] ${trimmed}`,
          'agent',
          agentId ?? undefined,
        )
      }
      if (!human) {
        const to = reflectTargetFor(taskId)
        const scope = await followUpScopeOf(taskId, to)
        reportUp(
          {
            toAgentId: to,
            by,
            title,
            summary: trimmed
              ? `${by}'s result for “${title ?? 'the task'}” arrived after the task was released/reassigned. The result was preserved as a comment on the task — review it before re-delegating; the work may already be done.`
              : `${by}'s result for “${title ?? 'the task'}” arrived after the task was released/reassigned — it was not recorded. Re-check the board or re-delegate if it's still needed.`,
            outcome: 'error',
            taskId,
            ...(scope ? { forTaskId: scope } : {}),
          },
          stopped,
        )
      }
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
      trimmed || (noText ? NO_TEXT_NOTE[noText] : '(no output produced)'),
      'agent',
      agentId ?? undefined,
    )
    // It closed over work that did not get done, on its agent's word or a person's
    // cancel. The card and whoever handed it out are told.
    const closedOver = closedOverNote(views ?? [])
    if (closedOver) await deps.board.addComment(taskId, closedOver, 'system')
    emit({ id: taskId, status: 'done', summary: trimmed, updatedAt: Date.now() })
    // A success resets the loop breaker for this (agent, task).
    if (agentId && title) await clearFailure(agentId, title)
    // Visible "done ≠ stuck" marker so the user always sees a completion, even
    // when the recipient legitimately stays silent (UI-only; no agent round-trip).
    if (!stopped) deps.narrate?.(sessionKey, `✓ ${by} completed${title ? `: ${title}` : ''}.`)
    // Reflect the result to whoever DELEGATED this task (the reduce-point: a
    // sub-task reports to its parent, a top-level task to the leader). An EMPTY result
    // still reflects, but HONESTLY — the leader is told the agent returned no output so
    // it can re-delegate / note the gap instead of synthesizing a false success. After
    // a Stop it starts nothing, and waits for the recipient's next run.
    if (!human) {
      // A sub-task reporting to a delegator that has since closed the task it
      // delegated from is a follow-up on that task (see followUpScope).
      const to = reflectTargetFor(taskId)
      const scope = await followUpScopeOf(taskId, to)
      reportUp(
        {
          toAgentId: to,
          by,
          title,
          summary:
            (trimmed ||
              (noText
                ? noTextReport(noText, by, title)
                : `${by} finished “${title ?? 'the task'}” but returned no output.`)) +
            (closedOver ? `\n\n${closedOver}` : ''),
          taskId,
          ...(scope ? { forTaskId: scope } : {}),
        },
        stopped,
      )
    }
    taskReflectTo.delete(taskId)
    taskTitle.delete(taskId)
    // Auto-unblock: fire any plan step whose blocker just completed (not after Stop).
    // Same-session follow-ups defer one macrotask (see pumpReady) — this call
    // runs inside the completing drain, which still holds the home mutex.
    if (!stopped) await pumpReady(sessionKey)
    else {
      await stopStepsUnblockedBy(taskId)
      await stopParentReleasedBy(taskId)
    }
  }

  /** May the board's Done gate pass this task's stored verdict? As it reads it: no
   *  verdict is not a failing one. */
  const storedVerdictPasses = (task: BoardTask | undefined): boolean => {
    const cell = task?.['verification']
    if (!cell) return true
    try {
      return isVerdictPromotable(typeof cell === 'string' ? JSON.parse(cell) : cell)
    } catch {
      return true
    }
  }

  /** What a task closing as Done says about work under it that did not get done. */
  const closedOverNote = (views: readonly SubtaskView[]): string => {
    const failed = subtaskNames(views, 'not_coming', 'stopped')
    const cancelled = subtaskNames(views, 'cancelled')
    if (!failed && !cancelled) return ''
    return (
      'This closed over sub-tasks that did not get done.' +
      (failed ? ` ${failed} did not finish.` : '') +
      (cancelled ? ` ${cancelled} cancelled.` : '')
    )
  }

  /** A person's Stop reached a task waiting on its sub-tasks. Nothing starts now, so a
   *  wait would never end by itself, and saying it waits would be false. It goes back to
   *  To do as stopped, as any run a Stop ended: the card reads Stopped and offers Retry,
   *  and what came back rides that run. One no agent is bound to stays: only a person
   *  ever acts on it, and what it waits on still reads true. */
  async function stopWaitingParent(taskId: string): Promise<void> {
    const task = (await deps.board.getTask(taskId))?.task
    if (!task || !targetForTask(task)) return
    // The task runner runs it, not this room: a Stop here is not about it.
    if (await deps.board.runsOnTaskRunner(taskId)) return
    if (!(await deps.board.updateStatus(taskId, 'todo'))) return
    emit({ id: taskId, status: 'todo', assigneeAgentId: null, updatedAt: now() })
    await tombstoneStopped(task)
  }

  /** A sub-task finished after a person's Stop. If that ended its parent's wait, the
   *  board has already put the parent in the queue, and the Stop covers it. */
  async function stopParentReleasedBy(taskId: string): Promise<void> {
    const parentId = (await deps.board.getTask(taskId))?.task.parentTaskId
    if (typeof parentId !== 'string' || !parentId) return
    const parent = (await deps.board.getTask(parentId))?.task
    if (!parent || (await deps.board.runsOnTaskRunner(parentId))) return
    if (parent.status === 'todo') await tombstoneStopped(parent)
    else if (
      parent.status === 'blocked' &&
      parseWaitingOn(parent['waitingOn'])?.kind === 'subtasks'
    )
      await stopWaitingParent(parentId)
  }

  /**
   * A task finished after a person's Stop (its check passed), and the steps waiting
   * on it are ready now. They would have been tombstoned had they been ready when
   * the Stop landed, so they are now: the Stop covers them, on the scan's path and on
   * the saved wake's. A step with another blocker open stays as it is, so a person's
   * Retry of that one carries the plan on, and so does anything else that became
   * ready since: it is not this Stop's.
   */
  async function stopStepsUnblockedBy(taskId: string): Promise<void> {
    const steps = await deps.board.directDependents?.(taskId)
    if (!steps?.length) return
    for (const task of await deps.board.getReadyTasks(deps.teamId))
      if (steps.includes(task.id)) await tombstoneStopped(task)
  }

  /** Mark a not-yet-fired task with a created-and-cancelled exec, so the fire policy
   *  (and the server scan) read it as user-stopped. */
  async function tombstoneStopped(task: BoardTask): Promise<void> {
    if (!targetForTask(task)) return // not auto-firable — no tombstone needed
    // It no longer waits to start by itself, and its card must not say so.
    if (waitsToStartByItself(parseWaitingOn(task['waitingOn']))) {
      await deps.board.setWaitingOn?.(task.id, null)?.catch(() => undefined)
      emit({ id: task.id, status: 'todo', updatedAt: now() })
    }
    const execs = await deps.board.listExecutions(task.id)
    // On an unknown ledger, tombstone anyway. This path errs toward "the user
    // stopped it": a duplicate cancelled row is harmless (the task stays
    // stopped), a missing one lets the pump re-fire it. A run a pause stopped says the
    // opposite, that it comes back on resume, so it takes a row of its own.
    const last = execs?.[execs.length - 1]
    if (last?.status === 'cancelled' && !stoppedByPause(last)) return
    const exec = await deps.board.createExecution(task.id, 'openclaw')
    if (exec) await deps.board.completeExecution(exec.id, { status: 'cancelled', byPerson: true })
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
    opts: {
      /** Set when the run ended on the runtime's own fatal error (`detail` is then
       *  its message): its typed cause, if any. */
      fromError?: { code: string | null } | null
      /** The task's later plan steps stay queued: a fix round that could not
       *  start, which, like a check failing for good, leaves the task to a person
       *  whose Retry carries the plan on. */
      keepPlan?: boolean
      /** The host refused the run because of a hard budget cap: nothing failed. */
      budgetRefused?: 'paused' | 'held'
      /** What the task waits on, when that says more than the run's ending does. */
      waitingOn?: WaitingOn
      /** What the board note opens with, in place of the reason's own label. */
      note?: string
      /** Why a provider failure stopped being tried. */
      noMoreTries?: NoMoreTries
    } = {},
  ): Promise<void> {
    const { fromError = null, keepPlan = false, noMoreTries = null } = opts
    const taskId = sessionToTask.get(sessionKey)
    if (!taskId) return // not a tracked delegation (e.g. the leader's own turn)
    // Failing a task whose RUN may still be live (the idle watchdog, a session
    // close) must also KILL that run: without this, a watchdog-failed delegate
    // kept executing invisibly — a zombie burning tokens whose eventual result
    // could only land as a '[late result]' comment. Best-effort; the drain idle
    // guard remains the backstop for a run that ignores the abort.
    deps.abortSession?.(sessionKey)
    // A Stop since this delegation started suppresses the amplifying tail (the
    // failure reflection + ready-pump). A genuine user-Stop ABORT never reaches
    // here (onEvent routes it to a clean release); this guard only covers an
    // error/max_turns that lands concurrently with a Stop — the board still records
    // the failure (truth), but no post-Stop re-amplification fires.
    const stopped = stopChangedFor(sessionKey)
    forgetSession(sessionKey)
    // A person-assigned task fails back to that person (the board's needs-you
    // column), not to the team lead: see completeForSession.
    const human = humanTasks.delete(taskId)
    const detailTrim = (detail ?? '').slice(0, 4000).trim()
    const reflectTo = reflectTargetFor(taskId)
    const title = taskTitle.get(taskId)
    const agentId = deps.agentIdForSession(sessionKey)
    const by = nameOf(agentId)
    // A person finished or cancelled the task while this run was going: the
    // failure changes nothing. No blocked write, no cancelled plan steps, no
    // failure report to a delegator who already heard what the person decided.
    if (await decidedByPerson(taskId)) {
      const execId = taskToExec.get(taskId)
      if (execId) {
        taskToExec.delete(taskId)
        await deps.board.completeExecution(execId, {
          status: 'cancelled',
          error: RUN_CLOSED_FINISHED_BY_PERSON,
          byPerson: true,
        })
      }
      taskReflectTo.delete(taskId)
      taskTitle.delete(taskId)
      return
    }
    // A runtime error is filed under its class: the ledger row carries it, and an
    // account refusal (sign-in or billing) changes what the delegator is told. Only
    // the runtime's own error is classified (`fromError`), never a run's summary,
    // which can be the agent's prose about anything.
    const refused =
      opts.budgetRefused ??
      (fromError?.code === BUDGET_HELD_CODE
        ? 'held'
        : fromError?.code === BUDGET_REFUSED_CODE
          ? 'paused'
          : null)
    const runtimeClass = fromError && !refused ? classifyError(fromError.code, detailTrim) : null
    const errorClass = refused ? BUDGET_REFUSED_CLASS : runtimeClass
    const account =
      runtimeClass && isAccountError(runtimeClass) ? ACCOUNT_FAILURE[runtimeClass] : null
    const provider = runtimeClass
      ? providerFailureOf({ status: 'failed', errorClass: runtimeClass })
      : null
    const stoppedTrying = provider && noMoreTries ? PROVIDER_FAILURE[provider] : null
    // The agent parked its task before the run ended: it asked a person, handed the
    // task back, or waits on other work. That wait is still the truth about the task.
    // Its reason stays, its plan stays queued, and the delegator hears about the wait,
    // not a failure it might redo. The run's own row still says how it ended.
    const parked = (await deps.board.getTask(taskId).catch(() => null))?.task
    const wait = parked?.status === 'blocked' ? chosenWaitOutcome(parked['waitingOn']) : null
    // Runs already going have set aside the budget's room, which clears when they end,
    // so nothing here waits for a person: back to To do, with its plan and its delegator
    // left as they are, and the pump starts it again when the room is there. Said once.
    // A task the pump would refuse anyway gets no such promise: it goes to a person below.
    const heldLedger =
      refused === 'held' && !stopped && parked?.status === 'in_progress'
        ? await deps.board.listExecutions(taskId).catch(() => null)
        : null
    const heldRun = taskToExec.get(taskId)
    if (
      heldLedger &&
      ledgerWillAutoFire(
        heldLedger.map((e) => (e.id === heldRun ? { ...e, status: 'budget_held' } : e)),
      ) &&
      (await deps.board
        .updateStatus(taskId, 'todo', {
          waitingOn: { kind: 'budget', held: true },
          keepVerdict: true,
        })
        .catch(() => false))
    ) {
      const execId = heldRun
      const before = heldLedger.filter((e) => e.id !== execId).at(-1)
      if (execId) {
        taskToExec.delete(taskId)
        await deps.board.completeExecution(execId, {
          status: 'budget_held',
          error: detailTrim,
          errorClass: BUDGET_REFUSED_CLASS,
        })
      }
      if (before?.status !== 'budget_held')
        await deps.board.addComment(
          taskId,
          `Waiting for room in a budget: ${detailTrim} It starts again by itself once runs already going have ended.`,
          'system',
        )
      emit({ id: taskId, status: 'todo', assigneeAgentId: null, updatedAt: now() })
      beginRetryWait(taskId, BUDGET_HELD_RECHECK_MS)
      await pumpReady(sessionKey)
      return
    }
    roundLeads.delete(taskId)
    // Loop breaker: record this (agent, task) failure so a persistently-failing
    // re-delegation is eventually refused in `spawn`. An account refusal counts the
    // same way: the report tells the delegator not to re-delegate, and a person who
    // fixed the sign-in can still say "try again" in chat. A budget refusal is no
    // failure of the agent's.
    if (!wait) {
      if (agentId && title && !refused) await noteFailure(agentId, title)
      await deps.board.updateStatus(taskId, 'blocked', {
        waitingOn:
          opts.waitingOn ??
          (refused
            ? { kind: 'budget' }
            : provider
              ? { kind: 'provider', cause: provider }
              : { kind: 'failure' }),
      })
    }
    const execId = taskToExec.get(taskId)
    if (execId) {
      taskToExec.delete(taskId)
      await deps.board.completeExecution(execId, {
        status:
          refused === 'held'
            ? 'budget_held'
            : refused === 'paused'
              ? 'budget_paused'
              : FAIL_EXEC_STATUS[reason],
        error: detailTrim || FAIL_REASON_LABEL[reason],
        ...(errorClass ? { errorClass } : {}),
      })
    }
    await deps.board.addComment(
      taskId,
      `${
        opts.note ??
        (stoppedTrying && noMoreTries
          ? `${stoppedTrying.what}. ${NO_MORE_TRIES_NOTE[noMoreTries]}`
          : null) ??
        account?.note ??
        (refused ? 'Stopped by a budget cap' : FAIL_REASON_LABEL[reason])
      }: ${detailTrim || '(no output)'}`,
      'system',
    )
    emit({ id: taskId, status: 'blocked', updatedAt: now() })
    // A blocked blocker can NEVER become `done`, so its downstream plan steps
    // would wait forever — cancel the pending dependents (else they ghost as
    // perpetual `todo` cards) and roll them into the failure so the delegator
    // learns the whole CHAIN stalled, not just this step.
    // What a person's Retry can carry on from keeps its plan queued: nothing is wrong
    // with the later steps when a cap, a provider or a run's room got in the way.
    const cancelled =
      keepPlan || wait || refused || provider ? [] : await deps.board.cancelDependents(taskId)
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
    if (!human) {
      const scope = await followUpScopeOf(taskId, reflectTo)
      reportUp(
        {
          toAgentId: reflectTo,
          by,
          title,
          summary:
            (wait ? 'Its run then ended early: ' : '') +
            (detailTrim || FAIL_REASON_LABEL[reason]) +
            (account ? ` ${account.report}` : '') +
            (stoppedTrying && noMoreTries
              ? ` ${NO_MORE_TRIES_REPORT[noMoreTries]} ${stoppedTrying.report}`
              : '') +
            chainNote,
          outcome: wait ?? (refused ? 'budget' : (stoppedTrying?.outcome ?? reason)),
          taskId,
          ...(scope ? { forTaskId: scope } : {}),
        },
        stopped,
      )
    }
    taskReflectTo.delete(taskId)
    taskTitle.delete(taskId)
    if (!stopped) await pumpReady(sessionKey)
    else await stopParentReleasedBy(taskId)
  }

  /**
   * The end of a follow-up run: the agent's reply to results that came back on a
   * task that had already closed, because a person decided it, or a sub-task a person
   * retried came in late. A task still open waits for them instead, and runs again
   * (see parkForHandedOutWork), so nothing here moves a status. It is recorded as a
   * comment on that task, then
   * passed to whoever gave the agent the task (itself a follow-up when that
   * delegator was on a task too, so the chain climbs until it reaches the lead).
   * A task a person assigned keeps it on its card. Never reads or writes the
   * session's task tracking: a follow-up is not a task run, so the occupancy
   * guard and the one-task-per-session rule are untouched.
   */
  async function recordFollowUp(
    sessionKey: string,
    forTaskId: string,
    result: { summary: string } | { reason: FailReason; detail: string },
    run: RunStamp,
  ): Promise<void> {
    const stopped = run.stopGen !== deps.stopGen()
    // A follow-up cut short by the user's Stop is a pause, not a failure. So is one
    // a pause stopped: nobody is told, and the report-ups it carried come back.
    if ('reason' in result && (stopped || run.stoppedByPause === true)) return
    const d = await deps.board.getTask(forTaskId)
    if (!d) return
    const title = typeof d.task.title === 'string' ? d.task.title : undefined
    const sdid = sdidOf(d.task)
    const human = isHumanAssignment(sdid)
    const to = human ? null : (sdidReflectTo(sdid) ?? deps.leaderAgentId())
    const scope = followUpScope(d.task, to)
    const agentId = deps.agentIdForSession(sessionKey)
    const by = nameOf(agentId)
    if (!('reason' in result)) {
      const compacted = deps.compact ? deps.compact(result.summary) : result.summary
      const trimmed = compacted.slice(0, 20_000).trim()
      if (trimmed)
        await deps.board.addComment(
          forTaskId,
          `[follow-up after its sub-tasks reported] ${trimmed}`,
          'agent',
          agentId ?? undefined,
        )
      // After a Stop nothing new is started: it waits for the recipient's next run.
      if (to)
        reportUp(
          {
            toAgentId: to,
            by,
            title,
            taskId: forTaskId,
            summary: trimmed
              ? `Follow-up after the work ${by} handed off came back: ${trimmed}`
              : `${by} got back the results of work it handed off on “${title ?? 'its task'}” but wrote no follow-up. Those results are on their own cards.`,
            ...(scope ? { forTaskId: scope } : {}),
          },
          stopped,
        )
      return
    }
    const why = result.detail.slice(0, 4000).trim()
    await deps.board.addComment(
      forTaskId,
      `Follow-up did not finish. ${FAIL_REASON_LABEL[result.reason]}: ${why || '(no output)'}`,
      'system',
    )
    if (to)
      enqueueReflection({
        toAgentId: to,
        by,
        title,
        taskId: forTaskId,
        summary: `${by}'s follow-up on the work it handed off did not finish (${why || FAIL_REASON_LABEL[result.reason]}). The results it was reporting on are on their own cards.`,
        outcome: result.reason,
        ...(scope ? { forTaskId: scope } : {}),
      })
  }

  /** Fail any delegated child idle past the watchdog window (never left standing).
   *  Also the heartbeat that reaps the two age-bounded maps so a long-lived team
   *  orchestrator can't grow them without bound. */
  async function sweepStaleSessions(): Promise<void> {
    const tnow = now()
    // The machine slept since the last sweep. That time is no delegate's silence,
    // so every age clock moves past it before anything is judged; one refreshed
    // after the wake is already current and never moves past now.
    const slept = suspendedFor?.(tnow) ?? 0
    if (slept > 0)
      for (const clocks of [lastActivityAt, recentlyTerminated, processed, intentMissed])
        for (const [k, ts] of clocks) clocks.set(k, Math.min(ts + slept, tnow))
    if (slept > 0)
      for (const turn of handOffsByTurn.values()) turn.at = Math.min(turn.at + slept, tnow)
    for (const [k, ts] of processed) if (ts <= tnow - PROCESSED_TTL_MS) processed.delete(k)
    for (const [k, ts] of intentMissed) if (ts <= tnow - PROCESSED_TTL_MS) intentMissed.delete(k)
    for (const [k, turn] of handOffsByTurn)
      if (turn.at <= tnow - PROCESSED_TTL_MS) handOffsByTurn.delete(k)
    for (const [s, ts] of recentlyTerminated)
      if (ts <= tnow - RECENTLY_TERMINATED_TTL_MS) recentlyTerminated.delete(s)
    // Settlements whose write failed are written now; report-ups whose run ended
    // without finishing are sent again.
    retrySettlements()
    await replayReportUps()
    // A fix round whose wait ended without a terminal reaching the engine.
    for (const sk of [...pendingFix.keys()]) await sendPendingFix(sk)
    // A check waiting for the board to take its task out of review.
    for (const sk of [...pendingPark.keys()]) await retryPark(sk)
    const stale: string[] = []
    for (const [sk, ts] of lastActivityAt) {
      // Queued for a run slot: the run has not started, so its idle window starts
      // when it does.
      if (deps.isRunQueued?.(sk)) {
        lastActivityAt.set(sk, tnow)
        continue
      }
      // A session inside a tool call (build/test/install) is legitimately silent,
      // so it gets the longer allowance instead of being failed at 8 minutes. So
      // does a delivery still waiting to start behind another run on the agent.
      const allowance =
        openToolCall.has(sk) || pendingStart.has(sk)
          ? OPEN_TOOL_CALL_TIMEOUT_MS
          : DELEGATION_IDLE_TIMEOUT_MS
      // A session whose finished work is being checked has no run to go silent.
      if (ts <= tnow - allowance && sessionToTask.has(sk) && !isChecking(sk) && !handingOut.has(sk))
        stale.push(sk)
    }
    for (const sk of stale) {
      if (pendingStart.has(sk)) {
        const mins = Math.round(PENDING_START_TIMEOUT_MS / 60_000)
        await failForSession(
          sk,
          'timeout',
          `The delegate's run did not start within ${mins} minutes.`,
        )
        continue
      }
      const wasInToolCall = openToolCall.has(sk)
      const mins = Math.round(
        (wasInToolCall ? OPEN_TOOL_CALL_TIMEOUT_MS : DELEGATION_IDLE_TIMEOUT_MS) / 60_000,
      )
      await failForSession(
        sk,
        'timeout',
        wasInToolCall
          ? `The delegate has been inside one tool call for over ${mins} minutes with no result.`
          : `No response from the delegate for ${mins} minutes.`,
      )
    }
  }

  /** A session's observer ended while a delegation was still in flight. */
  async function onSessionClosed(sessionKey: string, run?: RunStamp): Promise<void> {
    // The run that carried these report-ups ended without finishing.
    closeReportUpRun(run, false)
    if (run?.reportForTaskId) {
      await recordFollowUp(
        sessionKey,
        run.reportForTaskId,
        { reason: 'error', detail: 'The follow-up run ended before reporting.' },
        run,
      )
      return
    }
    // Under check, the task's run already reported; this was another turn's run.
    if (isChecking(sessionKey)) {
      deferPendingFix(sessionKey)
      return
    }
    if (!sessionToTask.has(sessionKey)) return
    await failForSession(
      sessionKey,
      'error',
      'The delegate session ended before reporting a result.',
    )
  }

  /**
   * A task In review whose last execution is this engine's and still running,
   * with no check of this engine's own under way: the server stopped while the
   * task's work was being checked (see WorkCheck). Nothing will finish that
   * check, so a person decides, as when a check fails for good, and whoever
   * handed the task out is told. A task-runner task in review has a runner
   * execution and is left alone.
   */
  async function parkInterruptedCheck(t: BoardTask): Promise<void> {
    const execs = await deps.board.listExecutions(t.id)
    const last = execs?.[execs.length - 1]
    if (!last || last.status !== 'running') return
    if (last.executorType !== undefined && !isEngineRun(last)) return
    // Parked first: until the move lands the run stays open, so the next
    // `resume()` finds the task the same way and tries again.
    if (
      !(await deps.board
        .updateStatus(t.id, 'blocked', { waitingOn: { kind: 'verification', state: 'cut_short' } })
        .catch(() => false))
    )
      return
    await deps.board
      .completeExecution(last.id, {
        status: 'failed',
        error: 'The server stopped while this work was being checked.',
      })
      .catch(() => undefined)
    await deps.board.addComment(
      t.id,
      'The work check was cut short by a restart, so the task waits for a person. Retry it to run the task and its check again.',
      'system',
    )
    emit({ id: t.id, status: 'blocked', updatedAt: now() })
    const sdid = sdidOf(t)
    if (isHumanAssignment(sdid)) return
    const to = sdidReflectTo(sdid) ?? deps.leaderAgentId()
    const scope = followUpScope(t, to)
    enqueueReflection({
      toAgentId: to,
      by: nameOf(sdidAgent(sdid)),
      ...(typeof t.title === 'string' ? { title: t.title } : {}),
      summary: 'Clawboo restarted, or the chat was closed, while this work was being checked.',
      outcome: 'check_interrupted',
      taskId: t.id,
      ...(scope ? { forTaskId: scope } : {}),
    })
  }

  /** Re-attach to durable in-flight work after a (re)mount — see the interface. */
  async function resume(): Promise<void> {
    await replayReportUps()
    const all = await deps.board.listTasks(deps.teamId)
    const checkingTasks = new Set([...checking.values()].map((c) => c.taskId))
    for (const t of all) {
      const assignee = typeof t.assigneeAgentId === 'string' ? t.assigneeAgentId : null
      if (t.status === 'in_review' && deps.workCheck && !checkingTasks.has(t.id)) {
        await parkInterruptedCheck(t)
        continue
      }
      if (t.status === 'in_progress' && assignee) {
        // Only attach a task that actually HAS a live ENGINE-OWNED run:
        //  • no running exec (claimed-but-runless / mid-handoff) → an 8-min
        //    clock nothing refreshes — a guaranteed false `blocked`;
        //  • a running exec from the EXECUTOR runner (claude-code/codex/native
        //    one-shot: anything not the engine's own fire) → the
        //    engine will never observe its events, so the watchdog would
        //    falsely fail a healthy heartbeat-governed run at 8 minutes.
        const execs = await deps.board.listExecutions(t.id)
        // Unknown ledger ⇒ don't attach a watchdog we cannot justify.
        if (execs === null) continue
        const last = execs[execs.length - 1]
        if (!last || last.status !== 'running') continue
        if (last.executorType !== undefined && !isEngineRun(last)) continue
        const sk = deps.sessionKeyForAgent(assignee)
        if (sk && !sessionToTask.has(sk) && !takingSession.has(sk)) {
          sessionToTask.set(sk, t.id)
          sessionStartGen.set(sk, deps.stopGen()) // capture for the Stop-vs-abort distinction
          lastActivityAt.set(sk, now())
          if (t.title) taskTitle.set(t.id, t.title)
          // Recover the IMMEDIATE delegator (the reduce-point) from the persisted
          // sourceDelegationId so a mid-chain sub-task still reports to its parent,
          // not the leader. Falls back to the leader when the sdid carries none,
          // except for a task a person assigned, which reports to no agent at all.
          const sdid = sdidOf(t)
          if (isHumanAssignment(sdid)) {
            humanTasks.add(t.id)
          } else {
            const reflectTo = sdidReflectTo(sdid) ?? deps.leaderAgentId()
            if (reflectTo) taskReflectTo.set(t.id, reflectTo)
          }
        }
      }
    }
    await pumpReady()
  }

  async function onEvent(sessionKey: string, event: RuntimeEvent, run?: RunStamp): Promise<void> {
    const reportFor = run?.reportForTaskId ?? null
    const wasTaskRun = reportFor === null && sessionToTask.has(sessionKey)
    const terminal = event.kind === 'done' || (event.kind === 'error' && event.fatal)
    // The run that carried these report-ups is over. Settled first, so a throw
    // while handling the event cannot leave them held.
    if (terminal) closeReportUpRun(run, event.kind === 'done' && event.reason === 'success')
    // A run that ended well heard the wakes it carried, even if a work check keeps
    // its execution open. Any other ending is settled when its execution closes.
    if (terminal && event.kind === 'done' && event.reason === 'success') {
      if (run?.wakeIds?.length) deps.taskWakes?.settle(run.wakeIds, 'delivered')
      if (run?.execId) deps.taskWakes?.settleCarriedBy?.(run.execId)
    }
    await handleEvent(sessionKey, event, run)
    // The turn is over, and so is its hand-off count.
    if (terminal) handOffsByTurn.delete(`${sessionKey}:${turnIdOf(event, run)}`)
    // The turn a fix round was waiting on has ended.
    if (terminal) deferPendingFix(sessionKey)
    // A NON-task turn (a user turn, a reflection) just ended on a session that had
    // work waiting behind it: a task that could not be bound while the turn was in
    // flight. Fire it now. (A task run's own terminal already pumps.)
    if (terminal && !wasTaskRun && waitingOnTurn.delete(sessionKey)) await pumpReady(sessionKey)
  }

  async function handleEvent(
    sessionKey: string,
    event: RuntimeEvent,
    run?: RunStamp,
  ): Promise<void> {
    const sourceAgentId = deps.agentIdForSession(sessionKey) ?? ''
    // A follow-up run reports on a task that already closed. It is never the
    // session's task run, even if the session maps one by the time it streams,
    // and whatever it delegates is parented under the task it follows up on.
    const reportFor = run?.reportForTaskId ?? null
    // The session's task already reported and its work is being checked, so this
    // event is another turn's (a person's @mention, say) and is not the task's.
    const underCheck = reportFor === null && isChecking(sessionKey)
    // The run stamped on the task's claim has moved on from the one that produced
    // this event: an earlier run's late event is not the task's, and says nothing
    // about it. Dropped whole, so it cannot end the task's newer run or start work.
    if (reportFor === null && !underCheck && run?.execId) {
      const current = taskToExec.get(sessionToTask.get(sessionKey) ?? '')
      if (current !== undefined && current !== run.execId) return
    }
    // Capture BEFORE completion deletes the mapping, so a done that both
    // completes a child AND sub-delegates parents the grandchild correctly.
    const mapped = reportFor !== null || underCheck ? null : (sessionToTask.get(sessionKey) ?? null)
    const sourceTaskId = mapped ?? reportFor

    // Any observed event = the delegate is alive; refresh the idle watchdog so a
    // slow-but-working agent (streaming deltas / tool calls) is never swept.
    if (mapped !== null) {
      lastActivityAt.set(sessionKey, now())
      // Track whether the session sits inside a tool call: `tool-call` opens the
      // window, `tool-result` closes it, and any terminal clears it (a run can
      // end mid-call on abort/error). The sweep grants an open call the longer
      // OPEN_TOOL_CALL_TIMEOUT_MS allowance.
      if (event.kind === 'tool-call') openToolCall.add(sessionKey)
      else if (event.kind === 'tool-result' || event.kind === 'done' || event.kind === 'error')
        openToolCall.delete(sessionKey)
    }

    if (reportFor !== null) {
      if (event.kind === 'done') {
        if (event.reason === 'success') {
          await recordFollowUp(sessionKey, reportFor, { summary: event.summary ?? '' }, run!)
          // fall through: a follow-up may delegate the work it found missing.
        } else {
          await recordFollowUp(
            sessionKey,
            reportFor,
            { reason: event.reason, detail: event.summary ?? '' },
            run!,
          )
          return
        }
      } else if (event.kind === 'error' && event.fatal) {
        await recordFollowUp(
          sessionKey,
          reportFor,
          { reason: 'error', detail: event.message },
          run!,
        )
        return
      }
    } else if (underCheck) {
      // Like any turn with no task: a failed one starts no new work.
      const failed =
        (event.kind === 'done' && event.reason !== 'success') ||
        (event.kind === 'error' && event.fatal)
      if (failed) return
    } else if (event.kind === 'done') {
      if (event.reason === 'success') {
        // A successful done may ALSO carry <delegate>/<plan> to spawn. They go on the
        // board first, so the task's ending counts them. One a board refused, or a
        // repeat of one it refused already, leaves nothing to wait for, so an agent
        // that keeps asking cannot loop through follow-ups.
        const turn = `${sessionKey}:${turnIdOf(event, run)}`
        const inDone = extractSignals(event, sourceAgentId, deps.known())
        if (inDone.parallel.length + inDone.plan.length + inDone.unrouted.length > 0) {
          handingOut.add(sessionKey)
          try {
            await startHandOffs(sessionKey, event, run, sourceAgentId, sourceTaskId, mapped)
          } finally {
            handingOut.delete(sessionKey)
            await completeForSession(sessionKey, event.summary ?? '', turn)
          }
          return
        }
        await completeForSession(sessionKey, event.summary ?? '', turn)
      } else if (event.reason === 'aborted' && stopChangedFor(sessionKey)) {
        // The user pressed Stop (its sessions.abort produced this `aborted` frame) —
        // a clean PAUSE, not a real failure. Release the task to `todo` (re-runnable);
        // do NOT block it, cancel its plan chain, or reflect a failure to the leader
        // (which would re-amplify exactly the work the user just halted).
        await releaseForSession(sessionKey)
        return
      } else if (
        event.reason === 'max_turns' &&
        (await endOutOfRoom(sessionKey, event.summary ?? ''))
      ) {
        return
      } else {
        // error / aborted / max_turns — a failed terminal does not spawn new work.
        await failForSession(sessionKey, event.reason, event.summary ?? '')
        return
      }
    } else if (event.kind === 'error' && event.fatal) {
      // A fatal runtime error ends the delegate; non-fatal errors keep waiting
      // (the run may recover) and surface in the activity terminal, not the chat.
      const retry = await retryProviderFailure(sessionKey, event)
      if (retry === 'waiting') return
      await failForSession(sessionKey, 'error', event.message, {
        fromError: { code: event.code },
        ...(retry !== 'no' ? { noMoreTries: retry } : {}),
      })
      return
    }

    await startHandOffs(sessionKey, event, run, sourceAgentId, sourceTaskId, mapped)
  }

  /** Put the work this event hands out on the board. */
  async function startHandOffs(
    sessionKey: string,
    event: RuntimeEvent,
    run: RunStamp | undefined,
    sourceAgentId: string,
    sourceTaskId: string | null,
    mapped: string | null,
  ): Promise<void> {
    // A run delivered before the user's Stop starts no new work after it.
    if (run && run.stopGen !== deps.stopGen()) return

    // Late-replay guard: a terminal on an already-unmapped session (its delegation
    // was completed / failed / timed-out) must NOT seed new work — a stale
    // <delegate>/<plan> in that summary would spawn an orphan top-level task. A
    // genuine never-tracked leader/user turn (not recently terminated) still
    // delegates normally. Uses the ENTRY mapping, so a success-then-sub-delegate
    // (mapped at entry) is unaffected.
    if (sourceTaskId === null && recentlyTerminated.has(sessionKey)) return

    const signals = extractSignals(event, sourceAgentId, deps.known())
    const runId = turnIdOf(event, run)
    // The agent that emitted these delegations is the reduce-point recipient for
    // their results (and the one told if a delegation can't be started).
    const delegatorAgentId = sourceAgentId || deps.leaderAgentId()

    const maxFanout = deps.caps?.maxFanout
    // Per TURN, not per event: each hand-off tool call is its own event, so a count
    // kept per event never reached the cap for a runtime that hands off by tool.
    const turnKey = `${sessionKey}:${runId}`
    const handOffsThisTurn = (): number => handOffsByTurn.get(turnKey)?.count ?? 0
    const addHandOff = (by: number): void => {
      const seen = handOffsByTurn.get(turnKey)
      handOffsByTurn.set(turnKey, { ...seen, count: (seen?.count ?? 0) + by, at: now() })
    }
    /** A hand-off the board found already open still handed the work on. */
    const foundItOpen = (): void => {
      const seen = handOffsByTurn.get(turnKey)
      handOffsByTurn.set(turnKey, { count: seen?.count ?? 0, at: now(), foundOpen: true })
    }
    // The run's own task, as opposed to one a follow-up run reports on.
    const ownTask = mapped !== null
    let cappedThisTurn = 0
    for (const sig of signals.parallel) {
      // A latch for what THIS engine has acted on, so a refused hand-off seen again is
      // not refused out loud again, and two overlapping events do not both start it.
      // The task's own idempotency key is what makes a replay safe: it lives on the
      // board, so it holds past this engine and past this entry's age.
      const key = `${runId}:${sig.targetAgentId}:${normalizeTaskTitle(sig.task)}`
      if (processed.has(key)) continue
      // Fan-out cap: bound parallel delegations per turn, independent of how many
      // the model emitted. Overflow is COUNTED + reported (not silently dropped).
      if (
        maxFanout != null &&
        !checkFanoutCap({ siblingCount: handOffsThisTurn(), max: maxFanout }).ok
      ) {
        cappedThisTurn += 1
        continue
      }
      processed.set(key, now())
      // Counted before the wait, so an event that overlaps this one sees it.
      addHandOff(1)
      const id = await spawn(sig, sourceTaskId, delegatorAgentId, runId, ownTask, foundItOpen)
      if (!id) addHandOff(-1)
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
        ...(sourceTaskId ? { forTaskId: sourceTaskId } : {}),
      })
    }

    if (signals.plan.length > 0) {
      const planId = `${deps.teamId}:${runId}:plan`
      if (!processed.has(planId)) {
        processed.set(planId, now())
        await startPlan(signals.plan, sourceTaskId, delegatorAgentId, runId, ownTask)
      }
    }

    // A hand-off tool call the engine cannot route. The tool already answered
    // that the work was queued, so without this the sender waits forever on a
    // task that was never made. Once per sender, name and task while the dedupe
    // entry lives, not once per run: the refusal arrives as a new turn, and a
    // sender that repeats the same bad hand-off in it gets no second one.
    for (const handOff of signals.unrouted) {
      const key = `unrouted:${sourceAgentId}:${handOff.name}:${handOff.task}`
      if (processed.has(key)) continue
      processed.set(key, now())
      reflectUnrouted(handOff, sourceAgentId, delegatorAgentId, sourceTaskId)
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

  /** Is the task already done or cancelled? Only a person's move finishes a task
   *  under a run the engine is still tracking (the engine's own terminals untrack
   *  the session first). An unreadable task counts as undecided. */
  async function decidedByPerson(taskId: string): Promise<boolean> {
    const detail = await deps.board.getTask(taskId)
    const status = detail?.task.status
    return status === 'done' || status === 'cancelled'
  }

  /** See the interface. */
  async function personMovedTask(
    taskId: string,
    to: string,
    opts: { cancelledDependents?: Array<{ id: string; title?: string | null }> } = {},
  ): Promise<void> {
    const detail = await deps.board.getTask(taskId)
    // Which session runs the task is read AFTER the await, and nothing below
    // awaits before the run is stopped and forgotten: while the read was out, that
    // run may have ended and the session taken another task, which must not be
    // the one stopped.
    let sessionKey: string | null = null
    for (const [sk, tid] of sessionToTask) {
      if (tid === taskId) {
        sessionKey = sk
        break
      }
    }
    const task = detail?.task ?? null
    const sdid = task ? sdidOf(task) : ''
    const human = humanTasks.has(taskId) || isHumanAssignment(sdid)
    const title =
      taskTitle.get(taskId) ?? (typeof task?.title === 'string' ? task.title : undefined)
    // Only a task someone delegated is reported; the leader is not told about
    // work it never handed out.
    const delegator = human ? null : (taskReflectTo.get(taskId) ?? sdidReflectTo(sdid))
    const agentId = sessionKey ? deps.agentIdForSession(sessionKey) : sdidAgent(sdid)
    const wasRunning = sessionKey !== null

    if (sessionKey) {
      if (isChecking(sessionKey)) {
        // Under check, the task's run is over: a run live on the session now is
        // another turn's, and the person's move is not about it. The move ends
        // the check's say over the task, so its answer can no longer finish it
        // (see runWorkCheck). No late-replay guard either: nothing was aborted,
        // and that other turn's hand-offs must still go out.
        endHold(sessionKey)
        pendingFix.delete(sessionKey)
        pendingPark.delete(sessionKey)
        checking.delete(sessionKey)
        dropSessionTracking(sessionKey)
      } else {
        deps.abortSession?.(sessionKey)
        // Arms the late-replay guard too: the aborted run's last summary must not
        // seed new delegations.
        forgetSession(sessionKey)
      }
      if (pendingStart.get(sessionKey) === taskId) pendingStart.delete(sessionKey)
    }
    const execId = taskToExec.get(taskId)
    if (execId) {
      taskToExec.delete(taskId)
      await deps.board.completeExecution(execId, {
        status: 'cancelled',
        error: `Stopped: a person moved the card to ${STATUS_WORD[to] ?? to}.`,
        byPerson: true,
      })
    }
    pendingTargets.delete(taskId)
    humanTasks.delete(taskId)
    endRetryWait(taskId)
    roundLeads.delete(taskId)
    for (const dep of opts.cancelledDependents ?? []) {
      pendingTargets.delete(dep.id)
      taskReflectTo.delete(dep.id)
      taskTitle.delete(dep.id)
      emit({ id: dep.id, status: 'cancelled', updatedAt: now() })
    }

    if (to === 'todo') {
      // Back in the queue. A run that was going starts over now; one that never
      // started is left to the pump, like any queued task.
      taskReflectTo.delete(taskId)
      taskTitle.delete(taskId)
      if (wasRunning) await dispatchTask(taskId)
      return
    }

    if ((to === 'done' || to === 'cancelled') && delegator) {
      const steps = (opts.cancelledDependents ?? [])
        .map((d) => `“${(d.title ?? '').slice(0, 40)}”`)
        .join(', ')
      const summary =
        to === 'done'
          ? `A person marked this done on the board.${wasRunning ? ` ${nameOf(agentId)}'s run was stopped before it reported.` : ''}`
          : `A person cancelled this on the board. Do not redo it or hand it to anyone again.${
              steps ? ` The later step(s) waiting on it were cancelled too: ${steps}.` : ''
            }`
      const scope = await followUpScopeOf(taskId, delegator)
      enqueueReflection({
        toAgentId: delegator,
        by: nameOf(agentId),
        title,
        summary,
        outcome: to === 'done' ? 'person_done' : 'person_cancelled',
        taskId,
        ...(scope ? { forTaskId: scope } : {}),
      })
    }
    taskReflectTo.delete(taskId)
    taskTitle.delete(taskId)
    // A person's Done can unblock the steps that waited on it, and either can end the
    // wait of a task waiting on its sub-tasks.
    if (to === 'done' || to === 'cancelled') await pumpReady()
  }

  /** See the interface. A person's explicit "run this now". */
  async function dispatchTask(taskId: string): Promise<DispatchOutcome> {
    const detail = await deps.board.getTask(taskId)
    if (!detail) return 'not_found'
    const task = detail.task
    if (task.status !== 'todo') return 'not_ready'
    const agentId = targetForTask(task)
    if (!agentId) return 'no_agent'
    // Readiness is the pump's own query, so a plan step still waiting on its
    // blocker (or a task from another team) is refused exactly as the pump
    // would skip it.
    const ready = await deps.board.getReadyTasks(deps.teamId)
    if (!ready.some((t) => t.id === taskId)) return 'not_ready'
    const sdid = sdidOf(task)
    const human = isHumanAssignment(sdid)
    // A retried DELEGATION still reports to whoever delegated it; the in-memory
    // record of that was dropped when it failed, the durable one was not.
    if (!human && !taskReflectTo.has(taskId)) {
      const reflectTo = sdidReflectTo(sdid)
      if (reflectTo) taskReflectTo.set(taskId, reflectTo)
    }
    if (!taskTitle.has(taskId) && task.title) taskTitle.set(taskId, task.title)
    // Waive the ledger policy for THIS run. If the agent is busy it stays set, so
    // the pump that runs when the agent frees up fires it too.
    forceFire.add(taskId)
    const targetSk = deps.sessionKeyForAgent(agentId)
    const busy =
      targetSk !== null &&
      (sessionToTask.has(targetSk) ||
        takingSession.has(targetSk) ||
        (deps.isSessionOccupied?.(targetSk) ?? false))
    await fireTask(taskId, agentId, briefFor(task), human)
    if (taskToExec.has(taskId)) return 'started'
    return busy ? 'queued' : 'not_ready'
  }

  /** See the interface. */
  async function pauseRuns(
    covers: (run: { agentId: string; taskId: string }) => boolean,
    note: string,
  ): Promise<string[]> {
    const stopped: string[] = []
    for (const [sessionKey, taskId] of [...sessionToTask]) {
      const agentId = deps.agentIdForSession(sessionKey)
      if (!agentId || !covers({ agentId, taskId })) continue
      // A run attached after a restart has no id in hand: read it, as Stop does.
      const attached = taskToExec.has(taskId)
        ? undefined
        : (await deps.board.listExecutions(taskId))?.at(-1)
      // That read, or an earlier task's writes, may have let this run end and the
      // session take other work. From here to the release nothing awaits.
      if (sessionToTask.get(sessionKey) !== taskId) continue
      if (attached?.status === 'running') taskToExec.set(taskId, attached.id)
      const held = heldChecks.get(sessionKey)
      if (held?.taskId === taskId) {
        // Its check has not started, and does not now. Whoever ends a wait owns what
        // happens next, and a Stop ends it the same way.
        endHold(sessionKey)
        await releaseHeldCheck(sessionKey, held, note)
        stopped.push(taskId)
        continue
      }
      let finished: string | undefined
      if (isChecking(sessionKey)) {
        // The run is over, and its check goes on. A fix round the check already
        // asked for never starts; one it asks for later waits at the run queue.
        const round = pendingFix.get(sessionKey)
        if (!round) continue
        pendingFix.delete(sessionKey)
        checking.delete(sessionKey)
        if (round.reason === 'fix_round') finished = round.summary
      } else {
        deps.abortSession?.(sessionKey)
        if (pendingStart.get(sessionKey) === taskId) pendingStart.delete(sessionKey)
      }
      await releaseClaimed(taskId, sessionKey, finished, false, note)
      stopped.push(taskId)
    }
    return stopped
  }

  /** See the interface. Durable-Stop writer — runs alongside the host's aborts. */
  async function markStopped(): Promise<void> {
    // Pending deferred fires would start NEW runs after the Stop — kill them
    // first (they were scheduled pre-Stop, so their gen check would pass).
    for (const t of deferredFires) clearTimeout(t)
    deferredFires.clear()
    // So would a wait to try again: the tombstone below is what outlasts this engine.
    for (const taskId of [...retryWaits.keys()]) endRetryWait(taskId)
    // The host drops its queued deliveries and aborts the runs. What they carried,
    // and what had not gone out yet, waits for the next run (see the rule there).
    holdWorkForNextRun()
    // A Stop outranks an earlier "run this now": the person halted the team.
    forceFire.clear()
    // Tracked runs: cancel the open execution NOW; the abort's later
    // done:aborted → releaseClaimed completeExecution no-ops (terminals are
    // immutable) and still releases the task row. A RESUME-ATTACHED run has no
    // taskToExec entry (the exec was created before the restart) — resolve its
    // trailing running exec from the board so a post-restart Stop still sticks.
    // And RELEASE the task row here too: if the process dies before the abort
    // terminals land, a cancelled-exec + in_progress-task combination has no
    // running exec for any sweep to reap — it would strand forever. The release
    // is idempotent with the later releaseClaimed.
    //
    // A task whose finished work is being checked is left to its check: it has no
    // run to abort, the check acts on the Stop when it answers (see runWorkCheck),
    // and its execution stays open so that, if this engine goes away first, the
    // next one finds the check cut short and hands the task to a person. A fix
    // round still waiting for its turn never starts: its task is released now. A
    // check still waiting for its turn never starts either.
    for (const [sk, p] of [...pendingFix]) {
      pendingFix.delete(sk)
      checking.delete(sk)
      await releaseClaimed(p.taskId, sk, p.summary)
    }
    for (const [sk, held] of [...heldChecks]) {
      endHold(sk)
      await releaseHeldCheck(sk, held)
    }
    for (const [sk, taskId] of sessionToTask) {
      if (isChecking(sk)) continue
      const execId = taskToExec.get(taskId)
      if (execId) {
        await deps.board.completeExecution(execId, { status: 'cancelled', byPerson: true })
      } else {
        const execs = await deps.board.listExecutions(taskId)
        const last = execs?.[execs.length - 1]
        if (last && last.status === 'running')
          await deps.board.completeExecution(last.id, { status: 'cancelled', byPerson: true })
      }
      await deps.board.updateStatus(taskId, 'todo')
    }
    // A task waiting on its sub-tasks: a Stop ends the wait (see stopWaitingParent).
    for (const task of await deps.board.listTasks(deps.teamId))
      if (task.status === 'blocked' && parseWaitingOn(task['waitingOn'])?.kind === 'subtasks')
        await stopWaitingParent(task.id)
    // Not-yet-fired delegations: tombstone with a created-and-cancelled exec so
    // the fire policy (and the server scan) read them as user-stopped.
    const ready = await deps.board.getReadyTasks(deps.teamId)
    for (const task of ready) await tombstoneStopped(task)
  }

  return {
    onEvent,
    sweepStaleSessions,
    onSessionClosed,
    resume,
    markStopped,
    pauseRuns,
    detachTask,
    dispatchTask,
    personMovedTask,
    onRunNotStarted: (run) => closeReportUpRun(run, false),
    takeHeldReportUps,
    checksInFlight: () => checking.size,
    taskForSession: (sessionKey) => sessionToTask.get(sessionKey) ?? null,
    execForSession: (sessionKey) => {
      const taskId = sessionToTask.get(sessionKey)
      return taskId ? (taskToExec.get(taskId) ?? null) : null
    },
    reset() {
      // Best-effort: deliver any pending reflection BEFORE tearing down, so a
      // child result isn't silently lost on a team-switch / reconnect that lands
      // inside the 3 s batch window. `flushReflection` synchronously drains the
      // queue (the delivery is fire-and-forget against the still-alive adapter).
      // Items the outbox holds are left out: they stay pending and the room's
      // next engine sends them, so flushing them here too would send them twice.
      const unheld = reflectQueue.filter((i) => !i.outboxId)
      reflectQueue.splice(0, reflectQueue.length, ...unheld)
      if (reflectQueue.length > 0) void flushReflection()
      if (reflectTimer) {
        clearTimeout(reflectTimer)
        reflectTimer = null
      }
      reflectQueue.length = 0
      // Unsettled rows stay pending in the outbox: the next engine replays them.
      reportUpsInHand.clear()
      heldByStop.clear()
      settleLater.clear()
      sessionToTask.clear()
      sessionStartGen.clear()
      taskToExec.clear()
      taskTitle.clear()
      taskReflectTo.clear()
      pendingTargets.clear()
      processed.clear()
      intentMissed.clear()
      lastActivityAt.clear()
      openToolCall.clear()
      recentlyTerminated.clear()
      handOffsByTurn.clear()
      humanTasks.clear()
      forceFire.clear()
      pendingStart.clear()
      handingOut.clear()
      unheardAtLastEnd.clear()
      refusalTurns.clear()
      unsavedReports.length = 0
      for (const taskId of [...retryWaits.keys()]) endRetryWait(taskId)
      roundLeads.clear()
      for (const sk of [...heldChecks.keys()]) endHold(sk)
      checking.clear()
      pendingFix.clear()
      pendingPark.clear()
      waitingOnTurn.clear()
      takingSession.clear()
      parkAlerted.clear()
      for (const t of deferredFires) clearTimeout(t)
      deferredFires.clear()
    },
  }
}
