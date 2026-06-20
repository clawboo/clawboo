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
  recordRotation,
  recordSpend,
  releaseTask,
  scrubResultSummary,
  updateStatus,
  type ClawbooDb,
} from '@clawboo/db'
import { existsSync } from 'node:fs'
import { mkdir } from 'node:fs/promises'

import { compactToolResultMarkdown } from '@clawboo/compaction'
import {
  DEFAULT_ROTATION,
  resolveRuntimeIntegration,
  rotateSession,
  shouldRotate,
  type Capabilities,
  type RunHandle,
  type RuntimeAdapter,
} from '@clawboo/executor'
import { assembleTiers } from '@clawboo/executor/tiers'
import {
  checkCostCap,
  createBreakerState,
  isPolicyDenialCode,
  stepBreaker,
  toolSignature,
  usdToCents,
  usdToFractionalCents,
  type BreakerConfig,
  type BreakerTrip,
} from '@clawboo/governance'
import { classifyError, isHarnessBug } from '@clawboo/obs'
import {
  isolationForTask,
  isWorktreeRegistered,
  KeyedMutex,
  reconstructState,
  type AgentHandoffInput,
  type ResumeState,
} from '@clawboo/worktrees'

import { budgetPreflight } from './budgetPreflight'
import { DEFAULTS } from './defaults'
import { describeDegradations, planDegradations } from './degradation'
import { buildMemoryGuidance } from './memoryGuidance'
import { buildMemoryInjection } from './memoryInjection'
import {
  alertHarnessBug,
  emitEvent,
  recordToolSpan,
  spanIdFor,
  withTaskSpan,
  type SpanCtx,
} from './obs'
import type { RuntimeRunContext } from './runtimes'
import { estimateRunCostUsdFromUsage } from './runtimes/estimateCost'
import { runtimeIdentityHomePath } from './runtimes/identityHome'
import {
  actOnTaskWorkspace,
  getTaskWorkspace,
  provisionTaskWorkspace,
  resumeTaskWorkspace,
  writeTaskHandoff,
} from './worktrees'

/** Single reduce point + bounded recursion: a task nested this deep is refused. */
export const MAX_SPAWN_DEPTH = 2

// Serializes dispatch per PERSISTENT identity home (keyed on the home path). Two
// concurrent runs of the same (runtime, agent) would otherwise spawn two
// processes against one native state.db — the board's atomic claim only dedupes
// a single TASK, not the per-home writer. The second concurrent run WAITS its
// turn; it is never dropped (no work lost). Ephemeral/connected runtimes don't
// share a state.db, so they're never keyed (run unserialized). Exported so the
// team-chat exchange serializes a persistent-home chat turn against an executor
// run for the SAME (runtime, agent) through this ONE shared instance, not a fork.
export const homeDispatchMutex = new KeyedMutex()

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
      reason: 'not_found' | 'conflict' | 'too_deep' | 'connected_substrate' | 'budget_paused'
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

/** Acquire a worktree for the run — reuse an existing one (cross-runtime resume) or provision fresh. */
async function acquireWorkspace(
  taskId: string,
  caps: Capabilities,
  repoPath: string | null | undefined,
  kind: string,
): Promise<{ cwd: string | null; resume: ResumeState | null }> {
  if (!caps.worktrees) return { cwd: null, resume: null }

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
    if (!reaped) return { cwd: wtPath, resume: existing.resume }
    if (repoPath) {
      const resumed = await resumeTaskWorkspace(taskId, { repoPath })
      if (resumed.ok) {
        let resume: ResumeState | null = null
        try {
          resume = await reconstructState(resumed.worktree.worktreePath)
        } catch {
          resume = null
        }
        return { cwd: resumed.worktree.worktreePath, resume }
      }
    }
  }

  if (!repoPath || isolationForTask(kind) !== 'worktree') return { cwd: null, resume: null }
  const prov = await provisionTaskWorkspace(taskId, { repoPath, kind })
  if (!prov.ok) return { cwd: null, resume: null }
  let resume: ResumeState | null = null
  try {
    resume = await reconstructState(prov.worktree.worktreePath)
  } catch {
    resume = null
  }
  return { cwd: prov.worktree.worktreePath, resume }
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
  const run = (): Promise<RunTaskResult> =>
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
      (span) => runTaskInner(input, span),
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
  return homeKey ? homeDispatchMutex.run(homeKey, run) : run()
}

async function runTaskInner(input: RunTaskInput, span: SpanCtx): Promise<RunTaskResult> {
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

  // Bounded recursion via the board ancestor chain (single reduce point).
  if (getAncestors(db, taskId).length >= maxDepth) return { ok: false, reason: 'too_deep' }

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

  // Atomic claim — a lost claim is a conflict and is NEVER retried.
  const claim = claimTask(db, taskId, assigneeAgentId, runtimeId)
  if (!claim.ok) return { ok: false, reason: 'conflict' }

  const exec = createExecutionProcess(db, {
    taskId,
    executorType: runtimeId,
    runReason: degr.resumeViaHandoff ? 'resume-via-handoff' : 'run',
  })
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
  const { cwd, resume } = await acquireWorkspace(taskId, caps, input.repoPath, kind)

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
  const mcpNote = input.mcpBaseUrl
    ? 'You have clawboo Tasks / Memory / Tools available over MCP — use them to read shared context, claim/update board tasks, and record decisions. Report a concise summary when done.'
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
  const assemblePrompt = (handoffNote: string): string =>
    assembleTiers({
      stable: `# Task: ${task.title}\n\n${task.description ?? ''}`,
      context: [baseContext, handoffNote].filter(Boolean).join('\n\n'),
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
    memoryScope: { teamId: task.teamId ?? null, agentId: assigneeAgentId },
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

    for await (const ev of adapter.events(run)) {
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
        doneReason = ev.reason
        summary = ev.summary || lastText
        if (ev.costUsd != null) costUsd = ev.costUsd
        if (ev.usage) {
          inputTokens = ev.usage.inputTokens
          outputTokens = ev.usage.outputTokens
        }
        break
      }
    }

    // External cancel forces the aborted terminal regardless of how the runtime
    // mapped the kill — so a disconnected-client run releases cleanly to `todo`.
    if (stopForCancel) doneReason = 'aborted'

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
    completeExecutionProcess(db, exec.id, {
      status: 'cancelled',
      error: `budget_paused:${stopForBudget}`,
      costUsd,
      inputTokens,
      outputTokens,
    })
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
    completeExecutionProcess(db, exec.id, {
      status: 'cancelled',
      error: `circuit_broken:${reason}`,
      costUsd,
      inputTokens,
      outputTokens,
    })
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

  if (success) {
    addComment(db, taskId, reported, 'agent', assigneeAgentId)
    completeExecutionProcess(db, exec.id, {
      status: 'succeeded',
      summary: reported,
      costUsd,
      inputTokens,
      outputTokens,
    })
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
        brokenOrUnverified: [],
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
      }
    } else {
      updateStatus(db, taskId, 'done')
      status = 'done'
    }
  } else {
    addComment(db, taskId, `Run ${doneReason}: ${safeSummary || '(no output)'}`, 'system')
    completeExecutionProcess(db, exec.id, {
      status: doneReason === 'aborted' ? 'cancelled' : 'failed',
      error: safeSummary || doneReason,
      costUsd,
    })
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
  }
}
