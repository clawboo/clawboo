// Server-side executor runner — the integration glue that drives a non-OpenClaw
// runtime through a single board task. It is the un-flagged graduation of the
// "a teammate is a RuntimeAdapter" idea: claim the task atomically (a lost claim
// is a 409 and is NEVER retried), open an execution row, acquire an isolated
// worktree (reusing an existing one for a cross-runtime continuation), assemble
// the prompt via @clawboo/executor/tiers (injecting the worktree handoff as the
// cold-resume context), drive the adapter's normalized event stream, then write
// the report-up summary + drive task status + clock-out an AGENT_HANDOFF.json.
//
// The runner talks ONLY through the RuntimeAdapter trait + an injected
// driver-backed adapter factory — it never assumes "a runtime == a spawned
// process", so a future non-subprocess participant (a human, UI-driven) slots in
// behind the same seam.

import {
  addComment,
  appendAudit,
  claimTask,
  completeExecutionProcess,
  createExecutionProcess,
  getAncestors,
  getTask,
  getTaskVerification,
  classifyAttempts,
  getWorkspaceForTask,
  listExecutions,
  listUndeliveredInbox,
  INBOX_BUDGET_CHARS,
  packInboxRows,
  splitInboxByAddressing,
  markInboxDelivered,
  recordRotation,
  recordSpend,
  releaseTask,
  scrubResultSummary,
  startTaskHeartbeat,
  updateStatus,
  type ClawbooDb,
} from '@clawboo/db'
import { existsSync } from 'node:fs'
import { mkdir } from 'node:fs/promises'

import { compactToolResultMarkdown } from '@clawboo/compaction'
import {
  DEFAULT_ROTATION,
  DEFAULT_RUN_SILENT_TIMEOUT_MS,
  resolveRuntimeIntegration,
  rotateSession,
  shouldRotate,
  withIdleTimeout,
  type Capabilities,
  type RunHandle,
  type RuntimeAdapter,
} from '@clawboo/executor'
import { assembleTiers } from '@clawboo/executor/tiers'
import {
  checkCostCap,
  createBreakerState,
  DEFAULT_MAX_DEPTH,
  isPolicyDenialCode,
  stepBreaker,
  toolSignature,
  usdToCents,
  usdToFractionalCents,
  type BreakerConfig,
  type BreakerTrip,
} from '@clawboo/governance'
import { classifyError, isHarnessBug } from '@clawboo/obs'
import { buildTurnEnvelope } from '@clawboo/team-orchestration'
import {
  isolationForTask,
  isWorktreeRegistered,
  KeyedMutex,
  reconstructState,
  type AgentHandoffInput,
  type ResumeState,
} from '@clawboo/worktrees'

import { budgetPreflight } from './budgetPreflight'
import { getMcpAttachSecret } from './mcpAttachSecret'
import { buildResumeNote } from './resumeNote'
import { verifyMaxAttempts } from './verification'
import { DEFAULTS } from './defaults'
import { describeDegradations, planDegradations } from './degradation'
import { buildMemoryGuidance } from './memoryGuidance'
import { buildMemoryInjection } from './memoryInjection'
import {
  alertHarnessBug,
  emitEvent,
  logStructured,
  recordToolSpan,
  spanIdFor,
  withTaskSpan,
  type SpanCtx,
} from './obs'
import type { RuntimeRunContext } from './runtimes'
import { estimateRunCostUsdFromUsage } from './runtimes/estimateCost'
import { runtimeIdentityHomePath } from './runtimes/identityHome'
import { buildPersonaBlock } from './runtimes/personaBlock'
import {
  actOnTaskWorkspace,
  getTaskWorkspace,
  provisionTaskWorkspace,
  resumeTaskWorkspace,
  writeTaskHandoff,
} from './worktrees'

/**
 * The DEEPEST legal task depth (a root is depth 0), shared with the creation-side
 * caps via `@clawboo/governance` so the two can never drift to different numbers.
 *
 * Creation and dispatch read the same constant but compare it differently, and the
 * difference is deliberate: a create is refused when the PARENT is already at the
 * max (`parentDepth >= max`, so the child would be `max + 1`), while a dispatch is
 * refused only when the task ITSELF is past it (`depth > max`). They used to both
 * use `>=`, which meant the orchestrator happily created depth-2 tasks that this
 * runner then refused forever as `too_deep` — a card that looked workable and could
 * never run. The invariant now is: anything that can be created can be dispatched.
 */
export const MAX_SPAWN_DEPTH = DEFAULT_MAX_DEPTH

// Serializes dispatch per PERSISTENT identity home (keyed on the home path). Two
// concurrent runs of the same (runtime, agent) would otherwise spawn two
// processes against one native state.db — the board's atomic claim only dedupes
// a single TASK, not the per-home writer. The second concurrent run WAITS its
// turn; it is never dropped (no work lost). Ephemeral/connected runtimes don't
// share a state.db, so they're never keyed (run unserialized). Exported so the
// team-chat exchange serializes a persistent-home chat turn against an executor
// run for the SAME (runtime, agent) through this ONE shared instance, not a fork.
export const homeDispatchMutex = new KeyedMutex()

/** Bound on WAITING for an agent's home-dispatch mutex. The holder is bounded by
 *  the drain idle guard, so a healthy queue always advances; a waiter that still
 *  can't acquire within this window is stuck behind a wedged holder — reject with
 *  a typed error (surfaced as a run-start failure → the delegator is told)
 *  instead of freezing this agent's chat/1:1/routines forever. */
export const HOME_MUTEX_ACQUIRE_MS =
  Number(process.env['CLAWBOO_HOME_MUTEX_ACQUIRE_MS']) || 10 * 60_000

export interface RunTaskInput {
  db: ClawbooDb
  /** Build the adapter for this run, given the resolved run context. */
  makeAdapter: (ctx: RuntimeRunContext) => RuntimeAdapter
  taskId: string
  assigneeAgentId: string
  /** Git repo to branch the worktree from (file-mutating tasks). */
  repoPath?: string | null
  /** Task kind → isolation (research/review = none, code = worktree). */
  kind?: string
  /** Base URL of the running clawboo server (for the runtime's MCP attach). */
  mcpBaseUrl?: string | null
  model?: string | null
  apiKeyEnv?: Record<string, string>
  /** Pause-for-handoff: keep the worktree + release the task (another runtime resumes). */
  keepForResume?: boolean
  /** Compact the report-up summary (defaults to flag-gated compaction). */
  compact?: (text: string) => string
  maxSpawnDepth?: number
  /** Per-node (this run's) cost ceiling in cents — a hard cap independent of any
   *  budget row. Enforced inside the cost loop. */
  maxNodeCents?: number
  /** Tool-loop circuit-breaker overrides. Falls back to
   *  BREAKER_DEFAULTS. The cross-runtime backstop that halts a no-progress /
   *  thrashing loop, composing with — never double-aborting — the budget
   *  kill-switch. */
  breakerConfig?: Partial<BreakerConfig>
  /** A parent run's W3C traceparent — nests this run under it in the
   *  trace. Omit for a board-rooted run: the parent span is derived from the task's
   *  parentTaskId automatically (the ancestor chain IS the trace hierarchy). */
  parentTraceparent?: string | null
  /** Disable run-start memory auto-injection. Default off (inject on). Eval runs
   *  set this so seeded facts don't perturb deterministic baselines. */
  disableMemoryAutoInject?: boolean
  /** INTERNAL (the verification fix loop): >0 marks a re-dispatch of a task this
   *  runner already owns after a verify FAIL — the claim is skipped (the fix
   *  loop keeps the task `in_progress` by design, so a fresh claim would 409)
   *  and the verdict's structured {what, why, howToFix} rides the prompt. */
  fixCycle?: number
  /** Max successor sessions per task before rotation gives up (bounds the chain).
   *  Falls back to DEFAULT_ROTATION.maxRotations. */
  maxRotations?: number
  /** External cancellation. When it aborts (e.g. the dispatch client
   *  disconnected), the live run is aborted and the task released to `todo` —
   *  the run (and its subprocess) does not keep going after the caller is gone. */
  abortSignal?: AbortSignal
}

export type RunTaskResult =
  | {
      ok: false
      reason:
        | 'not_found'
        | 'conflict'
        | 'too_deep'
        | 'connected_substrate'
        | 'budget_paused'
        // Isolation was required for a file-mutating task but could not be
        // provisioned; the run is refused rather than executed un-isolated.
        | 'workspace_unavailable'
    }
  | {
      ok: true
      runtimeId: string
      execId: string
      doneReason: 'success' | 'max_turns' | 'aborted' | 'error'
      status: string
      summary: string
      costUsd: number | null
      usedWorktree: boolean
      degradations: string[]
      /** Verification FAILED and parked the task `in_progress` — the wrapper's
       *  fix loop re-dispatches (outside the home mutex) or, on exhaustion,
       *  writes the parked alert. Inner runs only REPORT; the wrapper decides. */
      needsVerifyFix?: boolean
    }

function defaultCompact(text: string): string {
  return compactToolResultMarkdown(text).text
}

/** The "mission" budget scope = the root of the delegation tree (a top-level task
 *  is its own mission). Spend rolls up here so one tree can't drain the org budget. */
function missionRootId(db: ClawbooDb, taskId: string): string {
  const ancestors = getAncestors(db, taskId)
  if (ancestors.length === 0) return taskId
  return ancestors.find((a) => a.parent_task_id == null)?.id ?? taskId
}

function formatResumeContext(r: ResumeState): string {
  if (!r.hasHandoff && r.done.length === 0 && !r.next) return ''
  const parts: string[] = ['# Resume — prior handoff (the work continues from here)']
  if (r.done.length) parts.push(`## Done so far\n${r.done.map((d) => `- ${d}`).join('\n')}`)
  if (r.broken.length)
    parts.push(`## Broken / unverified\n${r.broken.map((d) => `- ${d}`).join('\n')}`)
  if (r.next) parts.push(`## Next best step\n${r.next}`)
  if (r.whyBlocked) parts.push(`## Why blocked\n${r.whyBlocked}`)
  if (r.warnings.length) parts.push(`## Warnings\n${r.warnings.map((w) => `- ${w}`).join('\n')}`)
  parts.push(
    `## Commands\ninit: ${r.commands.init}\nverify: ${r.commands.verify}\nstart: ${r.commands.start}`,
  )
  return parts.join('\n\n')
}

/**
 * Outcome of acquiring a workspace.
 *
 * `cwd: null` with `ok: true` is a LEGITIMATE no-worktree run (a runtime that
 * doesn't do worktrees, or read-only research/review work that mutates no files).
 * `ok: false` means isolation was REQUIRED for this task but could not be
 * provided — the caller must fail the run rather than fall back to the server's
 * own working directory, which is what the drivers inherit when `cwd` is null.
 */
type WorkspaceOutcome =
  { ok: true; cwd: string | null; resume: ResumeState | null } | { ok: false; reason: string }

/** Acquire a worktree for the run — reuse an existing one (cross-runtime resume) or provision fresh. */
async function acquireWorkspace(
  taskId: string,
  caps: Capabilities,
  repoPath: string | null | undefined,
  kind: string,
): Promise<WorkspaceOutcome> {
  // `worktrees: false` means the runtime MANAGES ITS OWN workspace, not that it
  // has none. The only adapter that declares it is OpenClaw, a connected
  // substrate that runs inside its Gateway-owned workspace and is refused by
  // this runner before the claim (see the `connected_substrate` guard). Every
  // SPAWNED runtime declares `worktrees: true` and is therefore covered by the
  // file-mutating refusal further down, which is the case that matters: those
  // inherit this process's cwd when `cwd` is null. Keep this branch permissive —
  // refusing here guards an unreachable path and breaks the `worktrees: false`
  // fakes that let runner tests skip git setup.
  if (!caps.worktrees) return { ok: true, cwd: null, resume: null }

  const existing = await getTaskWorkspace(taskId)
  if (existing.ok && existing.workspace?.worktreePath) {
    const wtPath = existing.workspace.worktreePath
    // A GC sweep removes the worktree dir (keeping the branch) + marks the row
    // `stale`. Reusing the stored path would run in a missing cwd — detect a
    // reaped checkout (stale row / dir gone / not git-registered) and rebuild it
    // from the retained branch before use; fall through to a fresh provision
    // only if the rebuild can't run (no repoPath / branch gone).
    const reaped =
      existing.workspace.status === 'stale' ||
      !existsSync(wtPath) ||
      (repoPath ? !(await isWorktreeRegistered(repoPath, wtPath)) : false)
    if (!reaped) return { ok: true, cwd: wtPath, resume: existing.resume }
    if (repoPath) {
      const resumed = await resumeTaskWorkspace(taskId, { repoPath })
      if (resumed.ok) {
        let resume: ResumeState | null = null
        try {
          resume = await reconstructState(resumed.worktree.worktreePath)
        } catch {
          resume = null
        }
        return { ok: true, cwd: resumed.worktree.worktreePath, resume }
      }
    }
  }

  // Read-only work (research / review) mutates no files, so it legitimately runs
  // without a worktree.
  if (isolationForTask(kind) !== 'worktree') return { ok: true, cwd: null, resume: null }

  // From here the task DOES mutate files, so isolation is mandatory. Returning a
  // null cwd here would hand the driver the server's own working directory —
  // which the drivers run in with permission gates bypassed. Fail instead.
  if (!repoPath) {
    return {
      ok: false,
      reason:
        'This task changes files, so it needs an isolated git worktree, but no repository path was provided for it.',
    }
  }
  const prov = await provisionTaskWorkspace(taskId, { repoPath, kind })
  if (!prov.ok) {
    return {
      ok: false,
      reason: `Could not provision an isolated git worktree for this task at ${repoPath}.`,
    }
  }
  let resume: ResumeState | null = null
  try {
    resume = await reconstructState(prov.worktree.worktreePath)
  } catch {
    resume = null
  }
  return { ok: true, cwd: prov.worktree.worktreePath, resume }
}

/**
 * Run a single board task on a non-OpenClaw runtime, end to end. Returns a
 * structured result; never throws for the expected board outcomes (404 / 409 /
 * too-deep). The caller (REST handler / live smoke / test) supplies the adapter
 * factory + run context.
 */
export async function runTaskOnRuntime(input: RunTaskInput): Promise<RunTaskResult> {
  // Trace per MISSION: every run of one delegation tree shares the root task's id
  // as the trace key, so a multi-agent task renders as ONE trace.
  const traceId = missionRootId(input.db, input.taskId)
  // Nest this run under its parent run's span: an explicit parent traceparent
  // (cross-process) wins; otherwise derive the parent span from the board parent
  // task (the ancestor chain IS the trace hierarchy).
  const parentTaskId = !input.parentTraceparent
    ? (getTask(input.db, input.taskId)?.parentTaskId ?? null)
    : null
  // Tracks whether the atomic claim landed, so an UNEXPECTED throw below can put
  // the task back instead of leaving it wedged in `in_progress` until the stale
  // sweep. Every expected outcome already releases on its own path. Shared across
  // fix cycles: a cycle re-dispatches the SAME claim, so the newest cycle's
  // execution row is the one a throw has to close.
  const claimState: ClaimState = { claimed: false }
  const run = (attempt: RunTaskInput): Promise<RunTaskResult> =>
    withTaskSpan(
      {
        db: input.db,
        name: `run:${input.taskId}`,
        traceId,
        taskId: input.taskId,
        agentId: input.assigneeAgentId,
        parentTraceparent: input.parentTraceparent ?? null,
        parentSpanId: parentTaskId ? spanIdFor(parentTaskId) : null,
      },
      (span) => runTaskInner(attempt, span, claimState),
    )

  // Probe capabilities once (constructing the adapter is side-effect-free — no
  // process spawns until start()) to learn the integration class. A
  // persistent-home runtime (native + wrapped-oneshot like Hermes) shares one
  // state.db per (runtime, identity), so its dispatch is serialized on that home
  // path; ephemeral/connected runs are not keyed. The connected refusal still
  // lands inside runTaskInner (homeKey is null for connected).
  const probe = input.makeAdapter({})
  const homeKey =
    resolveRuntimeIntegration(probe.capabilities()).home.kind === 'persistent'
      ? runtimeIdentityHomePath(probe.id, input.assigneeAgentId)
      : null
  const runOnce = (attempt: RunTaskInput): Promise<RunTaskResult> =>
    homeKey
      ? homeDispatchMutex.run(homeKey, () => run(attempt), {
          acquireTimeoutMs: HOME_MUTEX_ACQUIRE_MS,
        })
      : run(attempt)

  // The liveness beat is owned HERE — outside the mutex — so one interval spans
  // the mutex wait, the run, and every fix cycle, and the `finally` guarantees
  // it stops on EVERY exit including a throw. (A leaked beat kept a parked task
  // eternally fresh: the sweep could never reclaim it while the process lived.)
  // Pre-claim beats no-op via the in_progress + assignee guard.
  const stopBeat = startTaskHeartbeat(input.db, input.taskId, {
    assigneeAgentId: input.assigneeAgentId,
  })
  try {
    let result = await runOnce(input)
    // ── The verification fix loop — OUTSIDE the mutex ─────────────────────────
    // Each fix cycle acquires the home mutex FRESH. (The first version recursed
    // from inside the mutex-holding run; KeyedMutex is not reentrant, so cycle 1
    // queued behind its own caller, waited out the acquire timeout, and threw —
    // the quality loop never ran once on a persistent-home runtime.)
    //
    // The bound comes from `verifyMaxAttempts()`, the SAME reader the verdict uses,
    // so the loop and the policy can no longer disagree about when the budget is
    // spent (they did: 1 here against 3 there, which made exhaustion unreachable).
    // It is a belt, not the brake: exhaustion now yields a `blocked` terminal, and
    // `needsVerifyFix` is only set for an `in_progress` one, so the loop ends on
    // its own. Parking is announced where that terminal is decided
    // (`actOnTaskWorkspace`), unconditionally — not here, where it depended on a
    // status write having succeeded.
    const maxFix = Math.max(0, verifyMaxAttempts() - 1)
    let cycle = 0
    while (result.ok && result.needsVerifyFix && cycle < maxFix) {
      cycle++
      result = await runOnce({ ...input, fixCycle: cycle })
    }
    return result
  } catch (err) {
    // Safety net for an UNEXPECTED throw (a driver blowing up, a disk error mid-run):
    // without this the task keeps its claim and sits `in_progress` with no runner
    // behind it until the stale sweep. Release so it is retryable, then rethrow —
    // the failure itself is still the caller's to handle.
    if (claimState.claimed) {
      try {
        // ONLY release a task that is still mid-run. A throw can also happen after
        // the run reached a terminal state (e.g. writing the handoff on the success
        // path); releasing then would resurrect a finished task and clear its
        // verification verdict, which is worse than the stranded claim we're fixing.
        // Close the execution row first: releasing the task without it leaves an
        // orphaned `running` execution that only boot-time reconciliation clears.
        if (claimState.execId) {
          completeExecutionProcess(input.db, claimState.execId, {
            status: 'failed',
            error: err instanceof Error ? err.message : String(err),
          })
        }
        if (input.db && getTask(input.db, input.taskId)?.status === 'in_progress') {
          releaseTask(input.db, input.taskId)
        }
      } catch {
        // Best effort — never mask the original error with a cleanup failure.
      }
    }
    throw err
  } finally {
    stopBeat()
  }
}

/** Mutable run state shared with `runTaskInner` (see the safety net above). */
interface ClaimState {
  claimed: boolean
  /** Set once the execution row exists, so an unexpected throw can close it. */
  execId?: string
}

async function runTaskInner(
  input: RunTaskInput,
  span: SpanCtx,
  claimState: ClaimState = { claimed: false },
): Promise<RunTaskResult> {
  const { db, taskId, assigneeAgentId } = input
  const compact = input.compact ?? defaultCompact
  const maxDepth = input.maxSpawnDepth ?? MAX_SPAWN_DEPTH

  // A run can sit queued behind a same-identity dispatch in the home mutex for the
  // whole duration of the prior run. If the caller disconnected meanwhile (its
  // AbortController fired), bail BEFORE the claim so a dead waiter never mutates the
  // board or spawns a process — it just releases its turn. Lands here, alongside the
  // connected-substrate + budget-paused pre-claim refusals, so the board is untouched.
  if (input.abortSignal?.aborted) return { ok: false, reason: 'conflict' }

  const task = getTask(db, taskId)
  if (!task) return { ok: false, reason: 'not_found' }

  // Bounded recursion via the board ancestor chain (single reduce point). `>` not
  // `>=`: a task sitting exactly AT the ceiling is the deepest legal one, and the
  // creation caps already guarantee nothing deeper exists. See MAX_SPAWN_DEPTH.
  if (getAncestors(db, taskId).length > maxDepth) return { ok: false, reason: 'too_deep' }

  // Probe static capabilities (no driver is created until start()).
  const probe = input.makeAdapter({})
  const caps = probe.capabilities()
  const runtimeId = probe.id
  const degr = planDegradations(caps)

  // Native-preservation routing BY CONSTRUCTION: the integration depth comes
  // from capabilities(), never from a runtime-id switch. A connected-substrate
  // runtime (OpenClaw) executes over its LIVE connection — this one-shot runner
  // must never spawn it — and the refusal lands BEFORE the claim so a misrouted
  // call never mutates the board.
  const integration = resolveRuntimeIntegration(caps)
  if (integration.home.kind === 'connected') return { ok: false, reason: 'connected_substrate' }

  // Pre-flight cap gate: a paused CAP budget blocks the dispatch BEFORE the claim,
  // so an over-budget run never mutates the board or spawns a process. Lands here
  // (like the connected-substrate refusal) so the board is untouched. Only a
  // cap-mode paused scope blocks; warn budgets never pause; uncapped runs proceed.
  if (
    budgetPreflight(db, {
      agentId: assigneeAgentId,
      missionId: missionRootId(db, taskId),
      teamId: task.teamId,
    }).blocked
  ) {
    return { ok: false, reason: 'budget_paused' }
  }

  if (!input.fixCycle) {
    // Atomic claim — a lost claim is a conflict and is NEVER retried.
    const claim = claimTask(db, taskId, assigneeAgentId, runtimeId)
    if (!claim.ok) return { ok: false, reason: 'conflict' }
  } else {
    // Fix re-dispatch of a task this runner already owns (verify FAIL keeps it
    // `in_progress`): verify ownership instead of claiming. Anything else —
    // released, reassigned, human-moved — means the fix loop lost the task.
    const cur = getTask(db, taskId)
    if (!cur || cur.status !== 'in_progress' || cur.assigneeAgentId !== assigneeAgentId)
      return { ok: false, reason: 'conflict' }
  }
  // From here the task is ours (freshly claimed, or re-verified for a fix cycle);
  // an unexpected throw must release it (see the safety net in runTaskOnRuntime).
  claimState.claimed = true

  const exec = createExecutionProcess(db, {
    taskId,
    executorType: runtimeId,
    runReason: input.fixCycle ? 'verify-fix' : degr.resumeViaHandoff ? 'resume-via-handoff' : 'run',
  })
  // Share it with the outer safety net so an unexpected throw can close the row
  // instead of leaving it `running` with no runner behind it. (The liveness beat
  // is owned by the runTaskOnRuntime wrapper — one interval spanning the mutex
  // wait, this run, and any fix cycles, stopped in a finally so no exit path can
  // leak it.)
  claimState.execId = exec.id
  emitEvent(db, {
    kind: 'execution_started',
    traceId: span.traceId,
    spanId: span.spanId,
    taskId,
    teamId: task.teamId,
    agentId: assigneeAgentId,
    runtime: runtimeId,
    data: { execId: exec.id, executorType: runtimeId },
  })

  const kind = input.kind ?? 'code'
  const workspace = await acquireWorkspace(taskId, caps, input.repoPath, kind)

  // Isolation was required but unavailable. Running now would execute the agent
  // in the SERVER's own working directory with permission gates bypassed, so the
  // run is refused and the task released for a human to fix the repo path.
  if (!workspace.ok) {
    addComment(db, taskId, `[blocked: no isolation] ${workspace.reason}`, 'system')
    // BIND the result. `completeExecutionProcess` refuses (returns null) when
    // the row is already terminal — a stale sweep got there first. Emitting
    // regardless told obs 'succeeded' while the ledger said 'timed_out'.
    const ledgerClosed = completeExecutionProcess(db, exec.id, {
      status: 'failed',
      error: `workspace_unavailable: ${workspace.reason}`,
    })
    if (ledgerClosed)
      emitEvent(db, {
        kind: 'execution_completed',
        traceId: span.traceId,
        spanId: span.spanId,
        taskId,
        teamId: task.teamId,
        agentId: assigneeAgentId,
        runtime: runtimeId,
        data: { execId: exec.id, status: 'failed', error: 'workspace_unavailable' },
      })
    releaseTask(db, taskId)
    return { ok: false, reason: 'workspace_unavailable' }
  }
  const { cwd, resume } = workspace

  // Memory auto-injection: seed the most-relevant facts for the task into the
  // VOLATILE tier (cache-safe — never the cached prefix, per the KV-cache
  // discipline). Default-on; a no-op when memory is empty (fresh installs) or the
  // task opts out. Computed once and reused across rotations.
  const memoryBlock = input.disableMemoryAutoInject
    ? ''
    : await buildMemoryInjection({
        db,
        query: `${task.title}\n${task.description ?? ''}`,
        scope: { teamId: task.teamId, agentId: assigneeAgentId },
        maxChars: DEFAULTS.memoryAutoInjectMaxChars,
        topK: DEFAULTS.memoryAutoInjectTopK,
      })

  // Assemble the prompt: stable task brief → context (resume handoff + MCP note +
  // degradation notes [+ a rotation handoff note when resuming a rotated session])
  // → volatile (the auto-injected memory). The handoff is the cross-runtime carrier.
  const resumeCtx = resume ? formatResumeContext(resume) : ''
  // TeamChat is only named when the run is TEAM-SCOPED. The attach URL carries
  // the author binding from `scope.teamId`; with no team there is no binding, so
  // the server falls back to identity-from-tool-args — prompting `team_chat_post`
  // on such a run would be inviting a post whose author is whatever the model
  // says it is. A teamless task simply has no room to post to.
  const mcpNote = input.mcpBaseUrl
    ? [
        'You have clawboo Tasks / Memory / Tools available over MCP — use them to read shared context, claim/update board tasks, and record decisions.',
        'You are one agent working a shared board: check `list_tasks` before starting so you do not duplicate a teammate.',
        task.teamId
          ? 'Use `team_chat_post` to tell your team when you finish something significant or discover something that changes their work (a wrong assumption, a shared file you changed, a blocker), and `team_chat_subscribe` to catch up on what they posted while you were busy.'
          : '',
        'Report a concise summary when done.',
      ]
        .filter(Boolean)
        .join(' ')
    : 'Report a concise summary when done.'
  const degrNotes = describeDegradations(degr)
  const memoryGuidance = buildMemoryGuidance(runtimeId, Boolean(input.mcpBaseUrl))
  const baseContext = [
    resumeCtx,
    mcpNote,
    memoryGuidance,
    degrNotes.length ? `Degradations applied: ${degrNotes.join('; ')}.` : '',
  ]
    .filter(Boolean)
    .join('\n\n')
  // The verification fix note (fix-cycle runs only): the critic's structured
  // {what, why, howToFix} is the whole point of the re-dispatch — the one agent
  // that can fix the failure finally SEES why it failed.
  const fixNote = input.fixCycle
    ? (() => {
        const v = getTaskVerification(db, taskId)
        // The structured error lives on the ATTEMPT (each cycle records one) —
        // the latest attempt is the failure this re-dispatch exists to fix.
        const se = v?.attempts[v.attempts.length - 1]?.structuredError ?? null
        return se
          ? `## Verification failed — fix this before finishing\nWhat: ${se.what}\nWhy: ${se.why}\nHow to fix: ${se.howToFix}`
          : '## Verification failed — read the latest verification comment on this task and fix it before finishing.'
      })()
    : ''

  // Interrupted-work note: the PREVIOUS attempt's tombstone, read back to the one
  // agent that can act on it. A killed run leaves `orphaned:` / `stale:` on its
  // ledger row and nothing ever showed that to anybody, so a re-dispatch started
  // cold and could redo a side effect the dead attempt had already performed.
  // Suppressed on a fix cycle (that re-dispatch carries its own verdict note).
  // EXCLUDE this run's own row. It was opened moments ago and is still
  // `running`, so leaving it in makes the newest attempt look like an ordinary
  // in-flight one and the previous crash is never seen.
  const priorAttempts = classifyAttempts(listExecutions(db, taskId).filter((e) => e.id !== exec.id))
  const resumeNote =
    buildResumeNote({
      attempts: priorAttempts,
      hasWorktree: Boolean(getWorkspaceForTask(db, taskId)),
      ...(input.fixCycle ? { fixCycle: input.fixCycle } : {}),
    }) ?? ''

  // Since-you-were-away digest: undelivered mailbox rows for this assignee ride
  // the run's context; marked delivered only after the run actually starts.
  const inboxRows = listUndeliveredInbox(db, assigneeAgentId, {
    teamId: task.teamId ?? null,
    limit: 20,
  })
  // Split by addressing, exactly as the team-chat path does. The SAME mailbox
  // must not render two different ways depending on which path woke the agent —
  // that is how an agent learns that one framing means something and the other
  // does not. One budget across both sections; only rendered rows get marked
  // (the delivery guarantee lives in packInboxRows).
  const inboxSplit = splitInboxByAddressing(inboxRows)
  const packedAddressed = packInboxRows(inboxSplit.addressed, INBOX_BUDGET_CHARS)
  const packedAmbient = packInboxRows(
    inboxSplit.ambient,
    INBOX_BUDGET_CHARS - packedAddressed.usedChars,
  )
  const renderedDigest = {
    includedIds: [...packedAddressed.includedIds, ...packedAmbient.includedIds],
  }
  const inboxDigest =
    buildTurnEnvelope({
      addressed: packedAddressed.bodies.length ? [{ text: packedAddressed.bodies.join('\n') }] : [],
      ambient: packedAmbient.bodies.length ? [{ text: packedAmbient.bodies.join('\n') }] : [],
    }) ?? ''
  // A board run does NOT go through the team preamble, so the persona has to be
  // injected here too or a codex/claude-code/hermes agent works its tasks with
  // no persona at all while the same agent has one in team chat. It rides the
  // STABLE tier: it does not change between turns of the same task.
  const personaBlock = buildPersonaBlock(db, assigneeAgentId, runtimeId)
  const assemblePrompt = (handoffNote: string): string =>
    assembleTiers({
      stable: [personaBlock, `# Task: ${task.title}\n\n${task.description ?? ''}`]
        .filter(Boolean)
        .join('\n\n'),
      context: [baseContext, resumeNote, fixNote, handoffNote, inboxDigest]
        .filter(Boolean)
        .join('\n\n'),
      volatile: memoryBlock,
    }).prompt

  // A persistent-home runtime gets ONE stable home per (runtime, identity)
  // under clawboo's own state dir — where its native skills/memory accrue
  // across runs. The runner only computes the path (side-effect free); the
  // driver provisions it. NOTE the verification critic builds its own ctx
  // WITHOUT a homeDir on purpose: builder ≠ judge — the reviewer must not
  // share the builder's native memory.
  const homeDir =
    integration.home.kind === 'persistent'
      ? runtimeIdentityHomePath(runtimeId, assigneeAgentId)
      : null
  // Materialize the persistent identity home owner-only (0700) before the driver
  // touches it — it holds the runtime's private memory/transcripts, which must
  // not land world-readable on a multi-user host (matches the Hermes home mode).
  if (homeDir) await mkdir(homeDir, { recursive: true, mode: 0o700 }).catch(() => {})
  const ctx: RuntimeRunContext = {
    cwd,
    model: input.model ?? null,
    // Same-runtime continuation resumes the prior NATIVE session (the id rides
    // the worktree handoff); a cross-runtime pickup gets the prose ResumeState
    // only and starts a fresh native session.
    resume: resume?.lastRuntime === runtimeId ? (resume.nativeSessionId ?? null) : null,
    mcpBaseUrl: input.mcpBaseUrl ?? null,
    // The run's authoritative memory scope — bound onto the shared Memory MCP so
    // saves are team-shared + reads team-limited (matches the injection scope).
    memoryScope: {
      teamId: task.teamId ?? null,
      agentId: assigneeAgentId,
      attachSecret: getMcpAttachSecret(db),
    },
    homeDir,
    ...(input.apiKeyEnv ? { apiKeyEnv: input.apiKeyEnv } : {}),
  }
  const adapter = input.makeAdapter(ctx)
  const baseSessionKey = `runtime:${runtimeId}:task:${taskId}`
  const startRun = (sessionKey: string, context: string): Promise<RunHandle> =>
    adapter.start(
      { taskId, teamId: task.teamId },
      {
        agentId: assigneeAgentId,
        sessionKey,
        message: task.title,
        model: input.model ?? null,
        context,
        childToolBlocklist: ['sessions_send'], // children never fan out further
      },
    )
  let run = await startRun(baseSessionKey, assemblePrompt(''))
  // The run started with the digest in its context — mark the RENDERED rows
  // delivered (truncated-out rows stay undelivered by design).
  if (renderedDigest.includedIds.length > 0) {
    try {
      markInboxDelivered(db, renderedDigest.includedIds, 'digest')
    } catch {
      /* best-effort; undelivered rows simply ride the next digest */
    }
  }

  // External cancellation (the dispatch client disconnected): abort the live run
  // so it (and its subprocess) doesn't keep going. `run` is reassigned on
  // rotation, so the listener reads the CURRENT handle each time it fires. The
  // adapter's abort ends the event stream (the contract surfaces `done:aborted`);
  // `stopForCancel` is the belt-and-suspenders that forces the aborted terminal +
  // blocks rotation even if a runtime mis-maps the kill.
  let stopForCancel = false
  const onExternalAbort = (): void => {
    stopForCancel = true
    void adapter.abort(run)
  }
  if (input.abortSignal) {
    if (input.abortSignal.aborted) onExternalAbort()
    else input.abortSignal.addEventListener('abort', onExternalAbort, { once: true })
  }

  // Drive the normalized event stream to its terminal `done`.
  let lastText = ''
  let summary = ''
  let costUsd: number | null = null
  let inputTokens = 0
  let outputTokens = 0
  let doneReason: 'success' | 'max_turns' | 'aborted' | 'error' = 'error'

  // Budget kill-switch: on every cost event, atomically record spend against the
  // agent + mission(root) + team budgets. The moment a CAP-mode scope (or the
  // per-node ceiling) crosses 100%, abort the live run. Budgets are null/uncapped by
  // default, so this enforces nothing until a user sets a limit. The shipped default
  // posture is TRACK-AND-WARN: a warn-mode budget records spend + emits a warning at
  // its 80% / 100% crossings (below) but never auto-pauses.
  const missionId = missionRootId(db, taskId)
  let nodeSpentCents = 0
  let stopForBudget: 'agent' | 'mission' | 'team' | 'node' | null = null

  // Emit one governance warning the moment a budget crosses a threshold (fires once
  // per crossing — `crossed` is non-'none' only on the tipping delta). Applies to
  // BOTH cap budgets (an 80% heads-up before the 100% auto-pause) and warn budgets
  // (the track-and-warn signal; warn budgets never reach 'paused'). Reuses the
  // governance audit log (the 'budget' event type the GovernancePanel renders).
  const emitBudgetWarning = (
    scope: 'agent' | 'mission' | 'team',
    r: ReturnType<typeof recordSpend>,
  ): void => {
    if (!r || r.crossed === 'none') return
    // For a CAP budget, the 100% (hard) crossing is recorded by the auto-pause path
    // below — don't double-audit it. The 80% (soft) heads-up fires for both modes;
    // a standalone hard warning fires only for WARN budgets (which never pause).
    if (r.crossed === 'hard' && r.mode === 'cap') return
    appendAudit(db, {
      eventType: 'budget',
      agentId: assigneeAgentId,
      taskId,
      teamId: task.teamId,
      summary: {
        reason: 'warn',
        level: r.crossed, // 'soft' (80%) | 'hard' (100%)
        mode: r.mode,
        scope,
        pct: r.crossed === 'hard' ? 100 : DEFAULTS.budgetWarnSoftPct,
        spentUsdCents: r.spentUsdCents,
        limitUsdCents: r.limitUsdCents,
      },
    })
  }

  // Tool-loop circuit breakers: a deterministic backstop that halts a run making
  // no progress / repeating a failing tool / burning tokens, BEFORE the dollar
  // ceiling. Run-local state (one per task dispatch — "reset per task message");
  // fed typed RuntimeEvent signals, never rendered prose. The budget check wins
  // ties (the breaker feed is gated on `!stopForBudget`), so at most one teardown
  // runs per run — no double-abort.
  const breaker = createBreakerState(input.breakerConfig)
  const callSig = new Map<string, string>() // toolCallId → signature (failure correlation)
  let stopForBreaker: BreakerTrip | null = null

  // Drain idle guard: a wedged iterator (hung provider call, dead subprocess with
  // an open pipe) must not hang this drain forever — it holds the claim and the
  // agent's home mutex. Silence past the ceiling aborts the run; the wrapper's
  // grace window lets the abort surface a terminal through the normal paths.
  const silentMs =
    Number(process.env['CLAWBOO_RUN_SILENT_TIMEOUT_MS']) || DEFAULT_RUN_SILENT_TIMEOUT_MS
  let silentTimeout = false

  // Session-rotation loop (BETWEEN runs — the runtime owns its
  // inner turn loop, so clawboo's unit is the run boundary). Drive the run to its
  // terminal `done`; if it ran out of room (an explicit `max_turns`, or a non-
  // success done that crossed the context-window watermark) and the chain cap
  // isn't reached, rotate to a fresh successor session carrying a handoff note and
  // re-drive. Budget + breaker state (declared above) are CUMULATIVE across
  // rotations; only the per-run accumulators reset each pass. A runtime that
  // reports no context window and never emits `max_turns` never rotates (unchanged).
  const contextWindow = caps.contextWindowTokens ?? 0
  const maxRotations = input.maxRotations ?? DEFAULT_ROTATION.maxRotations
  let rotations = 0
  let keepDriving = true
  while (keepDriving) {
    keepDriving = false
    // Per-run accumulators reset each pass (the watermark + report-up describe the
    // CURRENT run); cumulative spend/breaker state above the loop is untouched.
    lastText = ''
    summary = ''
    inputTokens = 0
    outputTokens = 0
    doneReason = 'error'
    // Whether the runtime reported ANY spend for this pass. Codex and Hermes only
    // emit a cost event `if (ev.usage)`, so a CLI output-format drift silently
    // yields zero recorded spend — the budget ledger would then under-count real
    // money with no signal at all. Surfaced after the loop.
    let sawSpend = false
    // Did the adapter surface a real `done` terminal (possibly inside the idle
    // guard's grace window)? Gates the synthetic "runtime silent" diagnosis.
    let sawTerminal = false

    for await (const ev of withIdleTimeout(adapter.events(run), {
      idleMs: silentMs,
      onIdle: async () => {
        silentTimeout = true
        try {
          await adapter.abort(run)
        } catch {
          /* the guard's grace window ends the stream regardless */
        }
      },
    })) {
      if (ev.kind === 'text-delta') {
        if (ev.channel !== 'reasoning') lastText += ev.text
      } else if (ev.kind === 'cost') {
        // A runtime that reports usage but no USD (Codex / Hermes / unpinned-native)
        // emits costUsd:null + estimated. Estimate spend from the EXACT token usage ×
        // the model rate so the budget cap still engages; a real costUsd is used as-is
        // (Claude Code / pinned-native — no regression). No usage at all ⇒ 0.
        const usd =
          ev.costUsd != null
            ? ev.costUsd
            : ev.usage
              ? estimateRunCostUsdFromUsage({
                  model: ev.model,
                  inputTokens: ev.usage.inputTokens,
                  outputTokens: ev.usage.outputTokens,
                })
              : 0
        const costEstimated = ev.costUsd == null
        sawSpend = true
        costUsd = usd
        if (ev.usage) {
          inputTokens = ev.usage.inputTokens
          outputTokens = ev.usage.outputTokens
        }
        emitEvent(db, {
          kind: 'cost',
          traceId: span.traceId,
          parentSpanId: span.spanId,
          taskId,
          teamId: task.teamId,
          agentId: assigneeAgentId,
          runtime: runtimeId,
          data: {
            costUsd: usd,
            inputTokens,
            outputTokens,
            model: ev.model,
            estimated: costEstimated,
          },
        })
        {
          // The per-node cap accumulates integer cents (rounded); the budget
          // ledger takes FRACTIONAL cents so sub-cent events are carried, not lost.
          nodeSpentCents += usdToCents(usd)
          const ledgerCents = usdToFractionalCents(usd)
          const a = recordSpend(db, 'agent', assigneeAgentId, ledgerCents)
          const m = missionId ? recordSpend(db, 'mission', missionId, ledgerCents) : null
          const t = task.teamId ? recordSpend(db, 'team', task.teamId, ledgerCents) : null
          // Track-and-warn: warn on any crossing first (cap + warn budgets alike). A
          // warn budget never reads 'paused', so the kill-switch below skips it.
          emitBudgetWarning('agent', a)
          if (missionId) emitBudgetWarning('mission', m)
          if (task.teamId) emitBudgetWarning('team', t)
          // Only a CAP budget auto-pauses. A warn budget is clamped to never read
          // 'paused' at the DB layer; the explicit `mode === 'cap'` here is belt-and-
          // suspenders so a warn budget can never pause even if that clamp regressed.
          if (a?.status === 'paused' && a.mode === 'cap') stopForBudget = 'agent'
          else if (m?.status === 'paused' && m.mode === 'cap') stopForBudget = 'mission'
          else if (t?.status === 'paused' && t.mode === 'cap') stopForBudget = 'team'
          else if (
            input.maxNodeCents != null &&
            !checkCostCap({ nodeCents: nodeSpentCents, max: input.maxNodeCents }).ok
          )
            stopForBudget = 'node'
          if (stopForBudget) {
            await adapter.abort(run)
            break
          }
        }
        if (breaker && !stopForBudget) {
          const t = stepBreaker(breaker, {
            kind: 'cost',
            ts: ev.ts,
            tokens: ev.usage.inputTokens + ev.usage.outputTokens,
          })
          if (t) {
            stopForBreaker = t
            await adapter.abort(run)
            break
          }
        }
      } else if (ev.kind === 'tool-call') {
        // Emit only the settled call (not each streaming-input delta).
        if (!ev.partial) {
          emitEvent(db, {
            kind: 'tool_call',
            traceId: span.traceId,
            parentSpanId: span.spanId,
            taskId,
            teamId: task.teamId,
            agentId: assigneeAgentId,
            runtime: runtimeId,
            data: { toolCallId: ev.toolCallId, name: ev.name, input: ev.input },
          })
          if (breaker && !stopForBudget) {
            const sig = toolSignature(ev.name, ev.input)
            callSig.set(ev.toolCallId, sig)
            const t = stepBreaker(breaker, { kind: 'tool-call', ts: ev.ts, signature: sig })
            if (t) {
              stopForBreaker = t
              await adapter.abort(run)
              break
            }
          }
        }
      } else if (ev.kind === 'tool-result') {
        emitEvent(db, {
          kind: 'tool_result',
          traceId: span.traceId,
          parentSpanId: span.spanId,
          taskId,
          teamId: task.teamId,
          agentId: assigneeAgentId,
          runtime: runtimeId,
          data: {
            toolCallId: ev.toolCallId,
            name: ev.name,
            isError: ev.isError,
            output: ev.output,
          },
        })
        recordToolSpan(ev.name, !ev.isError) // OTel child span (best-effort)
        if (breaker && !stopForBudget) {
          const sig = callSig.get(ev.toolCallId) ?? ev.name
          const t = stepBreaker(breaker, {
            kind: 'tool-result',
            ts: ev.ts,
            signature: sig,
            ok: !ev.isError,
          })
          if (t) {
            stopForBreaker = t
            await adapter.abort(run)
            break
          }
        }
      } else if (ev.kind === 'error') {
        // A recognized policy denial (a broker Deny surfaced by the runtime) is
        // EXPECTED governance, not a harness bug — classify it as such and skip
        // the alert. Everything else goes through the taxonomy; an unknown class
        // is a HARNESS BUG.
        const denial = isPolicyDenialCode(ev.code)
        const cls = denial ? null : classifyError(ev.code, ev.message)
        emitEvent(db, {
          kind: 'error',
          traceId: span.traceId,
          parentSpanId: span.spanId,
          taskId,
          teamId: task.teamId,
          agentId: assigneeAgentId,
          runtime: runtimeId,
          data: {
            code: ev.code,
            message: ev.message,
            errorClass: cls ?? 'PolicyDenied',
            harnessBug: cls ? isHarnessBug(cls) : false,
            fatal: ev.fatal,
          },
        })
        if (cls && isHarnessBug(cls)) {
          alertHarnessBug({
            component: 'runtime',
            correlationId: exec.id,
            errorClass: cls,
            message: ev.message,
            taskId,
            agentId: assigneeAgentId,
            runtime: runtimeId,
          })
        }
        // Repeat policy-denial — keyed on the TYPED error code only (never the
        // message prose). Reachable when a runtime surfaces a broker denial as a
        // non-fatal `policy_denied` error event (the native harness does).
        if (breaker && !stopForBudget && denial) {
          const t = stepBreaker(breaker, {
            kind: 'policy-denied',
            ts: ev.ts,
            signature: ev.code ?? 'denied',
          })
          if (t) {
            stopForBreaker = t
            await adapter.abort(run)
            break
          }
        }
      } else if (ev.kind === 'done') {
        sawTerminal = true
        doneReason = ev.reason
        summary = ev.summary || lastText
        if (ev.costUsd != null) {
          sawSpend = true
          costUsd = ev.costUsd
        }
        if (ev.usage) {
          inputTokens = ev.usage.inputTokens
          outputTokens = ev.usage.outputTokens
        }
        break
      }
    }

    // A pass that finished its stream without reporting spend means the budget
    // ledger under-counts this run. Codex and Hermes emit a cost event only
    // `if (ev.usage)`, so a change in a CLI's output format stops spend reaching
    // the ledger without failing anything. An aborted pass is excluded: it may
    // legitimately not have billed.
    if (!sawSpend && doneReason !== 'aborted') {
      logStructured({
        level: 'warn',
        component: 'executorRunner',
        action: 'spend_unreported',
        correlationId: span.traceId,
        traceId: span.traceId,
        spanId: span.spanId,
        taskId,
        agentId: assigneeAgentId,
        runtime: runtimeId,
        error:
          'Run finished without reporting any usage or cost, so no spend was recorded. ' +
          'Budgets and caps under-count for this run; suspect a runtime output-format change.',
        output: { doneReason },
      })
    }

    // External cancel forces the aborted terminal regardless of how the runtime
    // mapped the kill — so a disconnected-client run releases cleanly to `todo`.
    if (stopForCancel) doneReason = 'aborted'

    // A silent-timeout abort is a FAILURE with a stated cause, never a clean
    // abort (that would release the task with no trace of why) — and never a
    // rotation candidate (the runtime is wedged, not out of room). But the grace
    // window exists precisely so the adapter can surface its OWN terminal after
    // the abort: when one arrived, it carries the true cause, and overwriting
    // it with "runtime silent" erases the real reason from the ledger and the
    // board comment.
    if (!stopForCancel && silentTimeout && !sawTerminal) {
      doneReason = 'error'
      summary = `runtime silent: no events for ${Math.round(silentMs / 60_000)} minutes — the run was aborted by the drain idle guard`
      break
    }

    // A budget / breaker / cancel trip ends the task here — never rotate over a stop.
    if (stopForBudget || stopForBreaker || stopForCancel) break

    // Did the run exhaust its room before finishing? `max_turns` is the unambiguous
    // signal; otherwise a non-success done that crossed the token watermark. A clean
    // success needs no rotation. Bounded by `maxRotations`.
    const watermark =
      doneReason !== 'success' &&
      shouldRotate({
        tokensUsed: inputTokens + outputTokens,
        contextWindow,
        thresholdPct: DEFAULT_ROTATION.thresholdPct,
      })
    const rotateReason: 'max_turns' | 'context_watermark' | null =
      doneReason === 'max_turns' ? 'max_turns' : watermark ? 'context_watermark' : null

    if (rotateReason && rotations < maxRotations) {
      rotations += 1
      // Rotation successors start FRESH: continuity rides the handoff note,
      // never the exhausted native session (resuming it would re-exhaust
      // instantly). Safe to mutate the shared ctx here — rotation only fires
      // after the predecessor's terminal done, so every driver that could read
      // ctx.resume already has. The codec serialize below captures the
      // predecessor id for lineage only.
      ctx.resume = null
      const predecessorSessionKey = run.sessionKey
      const lastSummary = (compact(summary || lastText) || '').slice(0, 400)
      const tokensUsed = inputTokens + outputTokens
      const successorSessionKey = `${baseSessionKey}:r${rotations}`
      run = await rotateSession({
        adapter,
        current: run,
        handoff: {
          taskId,
          predecessorSessionKey,
          predecessorSessionId: run.runId,
          reason: rotateReason,
          lastSummary,
          tokensUsed,
          rotationIndex: rotations,
        },
        restart: (note) => startRun(successorSessionKey, assemblePrompt(note)),
        recordRotation: ({ handoff, successor }) => {
          recordRotation(db, {
            predecessorSessionKey: handoff.predecessorSessionKey,
            successorSessionKey: successor.sessionKey,
            agentId: assigneeAgentId,
            teamId: task.teamId,
            runtime: runtimeId,
          })
          emitEvent(db, {
            kind: 'session_rotated',
            traceId: span.traceId,
            parentSpanId: span.spanId,
            taskId,
            teamId: task.teamId,
            agentId: assigneeAgentId,
            runtime: runtimeId,
            data: {
              from: handoff.predecessorSessionKey,
              to: successor.sessionKey,
              reason: handoff.reason,
              tokensUsed: handoff.tokensUsed,
              rotationIndex: handoff.rotationIndex,
            },
          })
        },
      })
      keepDriving = true
    }
    // else: a clean done, or rotation chain exhausted → fall through to terminal
    // handling. (A still-incomplete run that hit the cap is treated like its
    // doneReason — `max_turns` falls into the non-success terminal → released.)
  }

  // Auto-pause: a budget (or per-node cap) tripped mid-run. Record the forensic
  // event, complete the execution as cancelled, and release the task to `todo`
  // (retryable once a human raises the cap / resumes the budget).
  if (stopForBudget) {
    appendAudit(db, {
      eventType: 'budget',
      agentId: assigneeAgentId,
      taskId,
      teamId: task.teamId,
      summary: { reason: 'auto_pause', scope: stopForBudget, costUsd, nodeSpentCents },
    })
    addComment(
      db,
      taskId,
      `Auto-paused: ${stopForBudget} budget reached. Raise the cap (or resume) to continue.`,
      'system',
    )
    // BIND the result. `completeExecutionProcess` refuses (returns null) when
    // the row is already terminal — a stale sweep got there first. Emitting
    // regardless told obs 'succeeded' while the ledger said 'timed_out'.
    const ledgerClosed = completeExecutionProcess(db, exec.id, {
      status: 'cancelled',
      error: `budget_paused:${stopForBudget}`,
      costUsd,
      inputTokens,
      outputTokens,
    })
    if (ledgerClosed)
      emitEvent(db, {
        kind: 'execution_completed',
        traceId: span.traceId,
        spanId: span.spanId,
        taskId,
        teamId: task.teamId,
        agentId: assigneeAgentId,
        runtime: runtimeId,
        data: {
          execId: exec.id,
          status: 'cancelled',
          error: `budget_paused:${stopForBudget}`,
          costUsd,
          inputTokens,
          outputTokens,
        },
      })
    releaseTask(db, taskId)
    return {
      ok: true,
      runtimeId,
      execId: exec.id,
      doneReason: 'aborted',
      status: 'todo',
      summary: 'auto-paused (budget)',
      costUsd,
      usedWorktree: cwd != null,
      degradations: degrNotes,
    }
  }

  // Circuit breaker tripped mid-run (and budget did NOT — they're mutually
  // exclusive: the loop breaks on the first trip, and the breaker feed is gated on
  // `!stopForBudget`). Mirror the budget teardown exactly: forensic audit + a typed
  // `[stopped]` comment for the leader to re-plan + complete the execution as
  // cancelled + release the task to `todo`. The worktree is left intact, so the
  // handoff stays writable and a retry resumes from clean state.
  if (stopForBreaker) {
    const reason = stopForBreaker.reason
    appendAudit(db, {
      eventType: 'circuit_break',
      agentId: assigneeAgentId,
      taskId,
      teamId: task.teamId,
      summary: {
        reason,
        detail: stopForBreaker.detail,
        counters: stopForBreaker.counters,
        costUsd,
        nodeSpentCents,
      },
    })
    addComment(
      db,
      taskId,
      `[stopped: ${reason}] ${stopForBreaker.detail} Released to todo for re-planning.`,
      'system',
    )
    // BIND the result. `completeExecutionProcess` refuses (returns null) when
    // the row is already terminal — a stale sweep got there first. Emitting
    // regardless told obs 'succeeded' while the ledger said 'timed_out'.
    const ledgerClosed = completeExecutionProcess(db, exec.id, {
      status: 'cancelled',
      error: `circuit_broken:${reason}`,
      costUsd,
      inputTokens,
      outputTokens,
    })
    if (ledgerClosed)
      emitEvent(db, {
        kind: 'execution_completed',
        traceId: span.traceId,
        spanId: span.spanId,
        taskId,
        teamId: task.teamId,
        agentId: assigneeAgentId,
        runtime: runtimeId,
        data: {
          execId: exec.id,
          status: 'cancelled',
          error: `circuit_broken:${reason}`,
          costUsd,
          inputTokens,
          outputTokens,
        },
      })
    releaseTask(db, taskId)
    return {
      ok: true,
      runtimeId,
      execId: exec.id,
      doneReason: 'aborted',
      status: 'todo',
      summary: `stopped: ${reason}`,
      costUsd,
      usedWorktree: cwd != null,
      degradations: degrNotes,
    }
  }

  // Scrub the model/CLI summary BEFORE it lands in a durable board comment, the
  // execution row, the handoff artifact, or the HTTP response. A failed CLI that
  // dumps its env to stderr (or an SDK that echoes a key in an exception) would
  // otherwise persist the credential verbatim. compact() does not scrub.
  const safeSummary = scrubResultSummary(summary)
  const reported = compact(safeSummary) || '(no summary)'
  const success = doneReason === 'success'
  let status: string
  let needsVerifyFix = false

  if (success) {
    addComment(db, taskId, reported, 'agent', assigneeAgentId)
    // BIND the result. `completeExecutionProcess` refuses (returns null) when
    // the row is already terminal — a stale sweep got there first. Emitting
    // regardless told obs 'succeeded' while the ledger said 'timed_out'.
    const ledgerClosed = completeExecutionProcess(db, exec.id, {
      status: 'succeeded',
      summary: reported,
      costUsd,
      inputTokens,
      outputTokens,
    })
    if (ledgerClosed)
      emitEvent(db, {
        kind: 'execution_completed',
        traceId: span.traceId,
        spanId: span.spanId,
        taskId,
        teamId: task.teamId,
        agentId: assigneeAgentId,
        runtime: runtimeId,
        data: { execId: exec.id, status: 'succeeded', costUsd, inputTokens, outputTokens },
      })
    if (cwd) {
      // Persist the run's native session id (best-effort) so the next SAME-
      // runtime dispatch can resume it natively. The `!== sessionKey` filter
      // drops the adapters' late-bind fallback (events() stamps the sessionKey
      // into runId when no native frame ever carried an id) — persisting that
      // would poison a `--resume`.
      let nativeSessionId: string | null = null
      if (adapter.sessionCodec) {
        try {
          const blob = JSON.parse(await adapter.sessionCodec.serialize(run)) as {
            sessionId?: string | null
          }
          nativeSessionId =
            blob.sessionId && blob.sessionId !== run.sessionKey ? blob.sessionId : null
        } catch {
          // lineage/resume is best-effort — never fail a completed run over it
        }
      }
      const handoff: AgentHandoffInput = {
        handoffFrom: assigneeAgentId,
        runtime: runtimeId,
        completedSubtasks: input.keepForResume ? [] : [reported],
        // An interrupted attempt is recorded as UNKNOWN rather than dropped.
        // Silence reads as "it did not happen", which is how a cross-runtime
        // pickup ends up redoing a side effect the dead attempt already
        // performed. Carry the prior handoff's own list too: this run
        // reconstructed it from the worktree, and rewriting `[]` over it loses
        // everything an earlier runtime flagged.
        brokenOrUnverified: [
          ...(priorAttempts.lastKind === 'crash'
            ? [
                `A previous attempt was interrupted (${priorAttempts.lastCrashReason ?? 'no reason recorded'}) and the outcome of whatever it was doing is UNKNOWN — verify before redoing anything with a side effect.`,
              ]
            : []),
          ...(resume?.broken ?? []),
        ],
        nextBestStep: input.keepForResume ? reported : '',
        commands: { init: './init.sh', verify: '', start: '' },
        evidence: {},
        warnings: [],
        ...(nativeSessionId ? { nativeSessionId } : {}),
      }
      await writeTaskHandoff(taskId, handoff)
      if (input.keepForResume) {
        releaseTask(db, taskId) // pause: another runtime resumes from the handoff
        status = 'todo'
      } else {
        // The complete action runs the verification gate; reuse this
        // run's adapter factory as the independent read-only critic (a fresh review
        // run on a detached, push-less checkout — builder ≠ judge at the run level).
        // builder ≠ judge: the critic reuses this run's adapter factory on a
        // detached, push-less checkout with a fresh session + no builder homeDir
        // (context-level independence). An operator can ALSO make the judge a
        // different MODEL via CLAWBOO_REVIEWER_MODEL (env config, not a flag);
        // the verdict records the reviewer model so a same-model review's bias
        // caveat stays visible.
        const reviewerModel = process.env['CLAWBOO_REVIEWER_MODEL'] || input.model
        const r = await actOnTaskWorkspace(taskId, 'complete', {
          makeReviewerAdapter: input.makeAdapter,
          reviewerModel,
          mcpBaseUrl: input.mcpBaseUrl,
        })
        status =
          r.ok && r.action === 'complete'
            ? r.taskStatus
            : (getTask(db, taskId)?.status ?? 'unknown')
        // A verify FAIL parks the task back `in_progress` with NO run. This
        // inner run only REPORTS it (needsVerifyFix on the result) — the
        // runTaskOnRuntime wrapper re-dispatches OUTSIDE the home mutex (an
        // in-mutex recursion self-deadlocked: KeyedMutex is not reentrant) or,
        // on exhaustion, writes the durable parked alert.
        if (status === 'in_progress' && r.ok && r.action === 'complete') needsVerifyFix = true
      }
    } else {
      const promoted = updateStatus(db, taskId, 'done')
      if (promoted.ok) {
        status = 'done'
      } else {
        // `updateStatus` refuses for THREE different reasons and they are not the
        // same story. `illegal_transition` is the release/requeue case. But
        // `verification_required` means the gate held the promotion — the task was
        // never released, and saying so is simply false. `not_found` means the row
        // is gone. One message for all three misreports two of them, and this
        // comment is the durable record a human reads later.
        const why =
          promoted.reason === 'verification_required'
            ? 'the verification gate has not passed it'
            : promoted.reason === 'not_found'
              ? 'the task no longer exists'
              : 'the task had been released before this run finished'
        addComment(db, taskId, `[late result — ${why}] ${safeSummary || '(no output)'}`, 'system')
        status = getTask(db, taskId)?.status ?? 'todo'
      }
    }
  } else {
    addComment(db, taskId, `Run ${doneReason}: ${safeSummary || '(no output)'}`, 'system')
    // BIND the result. `completeExecutionProcess` refuses (returns null) when
    // the row is already terminal — a stale sweep got there first. Emitting
    // regardless told obs 'succeeded' while the ledger said 'timed_out'.
    const ledgerClosed = completeExecutionProcess(db, exec.id, {
      status: doneReason === 'aborted' ? 'cancelled' : 'failed',
      error: safeSummary || doneReason,
      costUsd,
    })
    if (ledgerClosed)
      emitEvent(db, {
        kind: 'execution_completed',
        traceId: span.traceId,
        spanId: span.spanId,
        taskId,
        teamId: task.teamId,
        agentId: assigneeAgentId,
        runtime: runtimeId,
        data: {
          execId: exec.id,
          status: doneReason === 'aborted' ? 'cancelled' : 'failed',
          error: safeSummary || doneReason,
          costUsd,
        },
      })
    if (doneReason === 'error') {
      // A terminal `done{reason:'error'}` carries no code — classify the message;
      // an unmappable failure is an UNKNOWN class → a harness bug → alert (AC5).
      const cls = classifyError(null, safeSummary)
      emitEvent(db, {
        kind: 'error',
        traceId: span.traceId,
        parentSpanId: span.spanId,
        taskId,
        teamId: task.teamId,
        agentId: assigneeAgentId,
        runtime: runtimeId,
        data: {
          code: null,
          message: safeSummary || 'error',
          errorClass: cls,
          harnessBug: isHarnessBug(cls),
          fatal: true,
        },
      })
      if (isHarnessBug(cls)) {
        alertHarnessBug({
          component: 'runtime',
          correlationId: exec.id,
          errorClass: cls,
          message: safeSummary || 'error',
          taskId,
          agentId: assigneeAgentId,
          runtime: runtimeId,
        })
      }
    }
    // A run that ATTEMPTED a native resume and failed clears the persisted id
    // (structural — keyed on the attempt, never on an error string), so the
    // next dispatch falls back to the prose handoff instead of retrying into
    // the same possibly-stale session id forever (a pruned/unknown id is a
    // hard runtime failure). Losing native resume degrades gracefully — the
    // structured handoff is the designed cross-runtime path anyway.
    if (cwd && ctx.resume) {
      const cleared: AgentHandoffInput = {
        handoffFrom: assigneeAgentId,
        runtime: resume?.lastRuntime ?? runtimeId,
        completedSubtasks: resume?.done ?? [],
        brokenOrUnverified: resume?.broken ?? [],
        nextBestStep: resume?.next ?? '',
        whyBlocked: resume?.whyBlocked ?? null,
        commands: resume?.commands ?? { init: './init.sh', verify: '', start: '' },
        evidence: {},
        warnings: [
          ...(resume?.warnings ?? []),
          'a native session resume failed; the session id was cleared',
        ],
      }
      await writeTaskHandoff(taskId, cleared).catch(() => undefined)
    }
    releaseTask(db, taskId) // back to todo — retryable
    status = 'todo'
  }

  return {
    ok: true,
    runtimeId,
    execId: exec.id,
    doneReason,
    status,
    summary: reported,
    costUsd,
    usedWorktree: cwd != null,
    degradations: degrNotes,
    ...(needsVerifyFix ? { needsVerifyFix: true } : {}),
  }
}
