// Server-side worktree orchestrator. Ties the runtime-
// agnostic @clawboo/worktrees git/SoR mechanism to the durable board: provision
// records a `workspaces` row + the task's worktree/branch refs; complete drives
// the task's status (empty diff → done + cleanup; non-empty → in_review +
// retain); GC marks reaped workspaces stale.
//
// Worktrees live OUTSIDE the user's repo (under the clawboo state dir, namespaced
// by a repo-path hash) so they never pollute the repo's own `git status`. A
// checkout recorded under the work folder (`workDir.ts`), where the newer layout
// keeps them, is acted on where it is recorded; new ones still go under the
// state dir.

import crypto from 'node:crypto'
import { existsSync } from 'node:fs'
import path from 'node:path'

import { resolveClawbooDir } from '@clawboo/config'
import { setAwakeTimeout } from '@clawboo/executor'
import { WORK_CHECK_TIMEOUT_MS } from '@clawboo/team-orchestration'
import {
  addComment,
  createWorkspace,
  getTask,
  getWorkspaceForTask,
  listExecutions,
  listActiveWorkspaces,
  setTaskWorkspaceRefs,
  updateStatus,
  updateWorkspaceStatus,
  type ClawbooDb,
  type DbTask,
  type DbWorkspace,
} from '@clawboo/db'
import type { RuntimeAdapter } from '@clawboo/executor'
import {
  completeWorktree,
  diffStat,
  gcWorktrees,
  isWorktreeRegistered,
  isolationForTask,
  loadWorktree,
  pauseWorktree,
  provisionWorktree,
  reconstructState,
  readHandoff,
  resumeWorktree,
  SOR_FILES,
  RegistrationUnknownError,
  UnsafeWorktreeError,
  worktreeDiff,
  worktreePathFor,
  writeHandoff,
  type AgentHandoff,
  type AgentHandoffInput,
  type CompleteResult,
  type DiffStat,
  type IsolationLevel,
  type PauseResult,
  type ResumeState,
  type TaskScaffoldInput,
  type Worktree,
} from '@clawboo/worktrees'

import { getDb } from './db'
import { emitEvent } from './obs'
import type { RuntimeRunContext } from './runtimes'
import { verifyMaxAttempts, verifyTask, type ReviewerSpend } from './verification'
import { readTeamVerifyCommand } from './verification/teamVerifyCommand'
import { notifyVerificationParked } from './teamChat/inboxNotices'
import { realPathOf, workDirSpellings } from './workDir'
import { readFileAt } from './workspaceFs'

function repoHash(repoPath: string): string {
  return crypto.createHash('sha1').update(path.resolve(repoPath)).digest('hex').slice(0, 12)
}

/**
 * Worktree root for a repo — under the clawboo state dir, namespaced by a hash
 * of the repo path so multiple repos never collide and (critically) so worktrees
 * are NOT created inside the user's repo tree. Every new checkout goes here.
 */
function worktreeRootForRepo(repoPath: string): string {
  return path.join(resolveClawbooDir(), 'worktrees', repoHash(repoPath))
}

/** The work folder's worktree roots for `repoPath`, in each of its spellings. */
function workFolderRootsForRepo(repoPath: string): string[] {
  const hash = repoHash(repoPath)
  return workDirSpellings().map((dir) => path.join(dir, 'worktrees', hash))
}

/**
 * Every root a recorded checkout of `repoPath` may be under: the state dir's
 * (first, where new ones go) and the work folder's, in each of its spellings.
 * Pause and complete refuse a record under none of them.
 */
function worktreeRootsForRepo(repoPath: string): string[] {
  return [...new Set([worktreeRootForRepo(repoPath), ...workFolderRootsForRepo(repoPath)])]
}

/** The root `recorded` is the task's folder under, or null when it is under none. */
function rootOfRecordedCheckout(repoPath: string, taskId: string, recorded: string): string | null {
  const wanted = path.resolve(recorded)
  return (
    worktreeRootsForRepo(repoPath).find(
      (root) => worktreePathFor(repoPath, taskId, root) === wanted,
    ) ?? null
  )
}

/** The roots GC sweeps for `repoPath`: each folder once, however it is spelled,
 *  by the first spelling in {@link worktreeRootsForRepo}. */
function gcRootsForRepo(repoPath: string): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const root of worktreeRootsForRepo(repoPath)) {
    // Not there: GC finds nothing in it, so the spelling is key enough.
    const key = realPathOf(root) ?? root
    if (seen.has(key)) continue
    seen.add(key)
    out.push(root)
  }
  return out
}

/** Detached review checkouts live OUTSIDE the user repo too (the critic gate). */
function reviewRootForRepo(repoPath: string): string {
  return path.join(resolveClawbooDir(), 'reviews', repoHash(repoPath))
}

function scaffoldFromTask(db: ClawbooDb, task: DbTask): TaskScaffoldInput {
  // The team's verify command goes into init.sh, so the builder sees the check
  // the gate will hold it to.
  const verify = readTeamVerifyCommand(db, task.teamId)
  return {
    taskId: task.id,
    title: task.title,
    description: task.description,
    teamName: task.teamId,
    ...(verify ? { commands: { verify } } : {}),
  }
}

export type ProvisionResult =
  | { ok: true; worktree: Worktree; workspaceId: string; isolation: IsolationLevel }
  | { ok: false; reason: 'not_found' | 'no_isolation'; isolation?: IsolationLevel }
  /** A checkout is already at the task's path and replacing it could lose work
   *  (uncommitted changes, or a folder git cannot read). It is left as it was,
   *  and nothing falls back to a fresh provision over it. */
  | { ok: false; reason: 'unsafe_to_rebuild'; worktreePath: string; why: string }

/** A rebuild's outcome: a provision's, or `registration_unknown` when resume
 *  asked git whether the checkout is registered and got no answer, so it
 *  changed nothing. That says nothing about the folder: the task can run again. */
export type ResumeResult =
  ProvisionResult | { ok: false; reason: 'registration_unknown'; worktreePath: string }

function unsafeToRebuild(err: UnsafeWorktreeError): ProvisionResult {
  return { ok: false, reason: 'unsafe_to_rebuild', worktreePath: err.worktreePath, why: err.why }
}

export interface ProvisionInput {
  repoPath: string
  baseSha?: string
  baseRef?: string
  kind?: string
}

/**
 * Provision a worktree for a file-mutating task and record it on the board.
 * Read-only / research tasks (`isolationForTask` → not `worktree`) are refused
 * — they should not pay the worktree cost.
 */
export async function provisionTaskWorkspace(
  taskId: string,
  input: ProvisionInput,
): Promise<ProvisionResult> {
  const db = getDb()
  const task = getTask(db, taskId)
  if (!task) return { ok: false, reason: 'not_found' }

  const isolation = isolationForTask(input.kind ?? 'code')
  if (isolation !== 'worktree') return { ok: false, reason: 'no_isolation', isolation }

  // Dedup: a single logical worktree per task maps to a single workspace row.
  // A repeated/concurrent provision must NOT insert a duplicate. If an active
  // row already has its checkout on disk + registered, short-circuit (reuse it,
  // no redundant git work). Otherwise reuse the row id below.
  const existing = getWorkspaceForTask(db, taskId)
  const rootDir = worktreeRootForRepo(input.repoPath)
  if (
    existing &&
    existing.status === 'active' &&
    existing.worktreePath &&
    existsSync(existing.worktreePath) &&
    (await isWorktreeRegistered(input.repoPath, existing.worktreePath))
  ) {
    updateWorkspaceStatus(db, existing.id, 'active', { lastUsedAt: Date.now() })
    // The checkout git just confirmed, at its recorded path (which may be under
    // the work folder), not one rebuilt under the state dir.
    const loaded = await loadWorktree({ repoPath: input.repoPath, taskId, rootDir })
    const worktree = { ...loaded, worktreePath: existing.worktreePath }
    return { ok: true, worktree, workspaceId: existing.id, isolation }
  }

  let worktree: Worktree
  try {
    worktree = await provisionWorktree({
      repoPath: input.repoPath,
      taskId,
      baseSha: input.baseSha,
      baseRef: input.baseRef,
      rootDir,
      scaffold: scaffoldFromTask(db, task),
    })
  } catch (err) {
    if (err instanceof UnsafeWorktreeError) return unsafeToRebuild(err)
    throw err
  }
  let workspaceId: string
  if (existing) {
    // Reuse the prior (stale / reaped) row instead of inserting a duplicate,
    // and record where the checkout is now: the row may have named another
    // place, such as the work folder, and pause and complete act on the row.
    updateWorkspaceStatus(db, existing.id, 'active', {
      lastUsedAt: Date.now(),
      worktreePath: worktree.worktreePath,
    })
    workspaceId = existing.id
  } else {
    const ws = createWorkspace(db, taskId, input.repoPath, {
      branch: worktree.branch,
      worktreePath: worktree.worktreePath,
    })
    workspaceId = ws.id
  }
  setTaskWorkspaceRefs(db, taskId, {
    worktreeRef: worktree.worktreePath,
    branchRef: worktree.branch,
  })
  return { ok: true, worktree, workspaceId, isolation }
}

/**
 * Rebuild a task's worktree from its retained branch after the checkout was
 * reaped (GC removes the worktree dir but keeps the branch + marks the row
 * `stale`). Re-attaches the branch into a fresh checkout via `resumeWorktree`
 * and flips the row back to `active`, so a re-dispatched task never runs in a
 * missing `cwd`. Returns `not_found` when there is no recorded workspace or the
 * branch is gone (a genuinely-fresh provision is the caller's fallback), and
 * `unsafe_to_rebuild` when a folder at the path could hold work that replacing
 * it would lose (no fallback: a provision would replace it the same way), and
 * `registration_unknown` when git could not say whether the checkout is
 * registered (nothing was changed; no fallback either). The checkout is rebuilt
 * where the row records it when that is the task's folder under a known root
 * (the work folder's included); otherwise under the state dir, and the row is
 * updated to name it.
 */
export async function resumeTaskWorkspace(
  taskId: string,
  input: { repoPath: string },
): Promise<ResumeResult> {
  const db = getDb()
  const ws = getWorkspaceForTask(db, taskId)
  if (!ws || !ws.worktreePath) return { ok: false, reason: 'not_found' }
  const repoPath = ws.repoPath || input.repoPath
  try {
    const worktree = await resumeWorktree({
      repoPath,
      taskId,
      rootDir:
        rootOfRecordedCheckout(repoPath, taskId, ws.worktreePath) ?? worktreeRootForRepo(repoPath),
    })
    // The same path when it was rebuilt where recorded; the state dir's when the
    // recorded one is under no known root, which pause and complete would refuse.
    updateWorkspaceStatus(db, ws.id, 'active', {
      lastUsedAt: Date.now(),
      worktreePath: worktree.worktreePath,
    })
    setTaskWorkspaceRefs(db, taskId, {
      worktreeRef: worktree.worktreePath,
      branchRef: worktree.branch,
    })
    return { ok: true, worktree, workspaceId: ws.id, isolation: 'worktree' }
  } catch (err) {
    if (err instanceof UnsafeWorktreeError) return unsafeToRebuild(err)
    if (err instanceof RegistrationUnknownError) {
      return { ok: false, reason: 'registration_unknown', worktreePath: err.worktreePath }
    }
    // Branch gone / git error — the caller falls back to a fresh provision.
    return { ok: false, reason: 'not_found' }
  }
}

export type WorkspaceView =
  | {
      ok: true
      workspace: ReturnType<typeof getWorkspaceForTask>
      resume: ResumeState | null
      handoff: AgentHandoff | null
    }
  | { ok: false; reason: 'not_found' }

/** Read a task's workspace + the cold-resume state reconstructed from its SoR. */
export async function getTaskWorkspace(taskId: string): Promise<WorkspaceView> {
  const db = getDb()
  const ws = getWorkspaceForTask(db, taskId)
  if (!ws || !ws.worktreePath) return { ok: false, reason: 'not_found' }
  let resume: ResumeState | null = null
  let handoff: AgentHandoff | null = null
  try {
    resume = await reconstructState(ws.worktreePath)
  } catch {
    /* worktree dir may be paused-away — resume stays null */
  }
  try {
    handoff = await readHandoff(ws.worktreePath)
  } catch {
    /* no handoff */
  }
  return { ok: true, workspace: ws, resume, handoff }
}

export interface WorktreeDetail {
  ok: boolean
  reason?: string
  workspace?: DbWorkspace
  /** SoR file contents (TASK.md / task-progress.md / DECISIONS.json / VERIFICATION.md / AGENT_HANDOFF.json). */
  sorFiles?: Record<string, string>
  /** Names of the task files cut at the 256 KB read limit; their `sorFiles`
   *  entry holds only the start. */
  sorFilesTruncated?: string[]
  diffStat?: DiffStat | null
  /** Unified diff (baseline vs working tree), SoR bookkeeping files excluded. */
  diff?: string
}

/** Read-only detail for the task-detail drawer: the SoR file contents + the diff
 *  against the branch-point baseline (excluding the SoR bookkeeping files). */
export async function readWorktreeDetail(taskId: string): Promise<WorktreeDetail> {
  const db = getDb()
  const ws = getWorkspaceForTask(db, taskId)
  if (!ws || !ws.worktreePath) return { ok: false, reason: 'not_found' }
  const wtPath = ws.worktreePath
  const sorFiles: Record<string, string> = {}
  const sorFilesTruncated: string[] = []
  for (const name of Object.values(SOR_FILES)) {
    // The agent writes these files, so it can also replace one with a link to
    // any file the server can read. Read through the Workspace tab's confined
    // reader, which refuses links and anything outside the worktree.
    try {
      const file = await readFileAt(wtPath, name)
      if (!file.binary) {
        sorFiles[name] = file.content
        if (file.truncated) sorFilesTruncated.push(name)
      }
    } catch {
      /* missing, a link, or not a regular file: left out */
    }
  }
  let stat: DiffStat | null = null
  let diff = ''
  try {
    const wt = await loadWorktree({ repoPath: ws.repoPath, taskId })
    const exclude = Object.values(SOR_FILES)
    stat = await diffStat(wtPath, wt.baseCommit, { excludePaths: exclude })
    diff = await worktreeDiff(wtPath, wt.baseCommit, { excludePaths: exclude })
  } catch {
    /* worktree paused-away / git unavailable → diff stays empty */
  }
  return { ok: true, workspace: ws, sorFiles, sorFilesTruncated, diffStat: stat, diff }
}

/** Write the clock-out `AGENT_HANDOFF.json` into a task's worktree. */
export async function writeTaskHandoff(
  taskId: string,
  handoff: AgentHandoffInput,
): Promise<{ ok: boolean; reason?: 'not_found' }> {
  const db = getDb()
  const ws = getWorkspaceForTask(db, taskId)
  if (!ws || !ws.worktreePath) return { ok: false, reason: 'not_found' }
  await writeHandoff(ws.worktreePath, handoff)
  updateWorkspaceStatus(db, ws.id, ws.status as 'active' | 'archived' | 'stale', {
    lastUsedAt: Date.now(),
  })
  return { ok: true }
}

export type ActionResult =
  | { ok: true; action: 'pause'; pause: PauseResult }
  | {
      ok: true
      action: 'complete'
      complete: CompleteResult
      taskStatus: string
      verified?: string
      /** The check no longer spoke for the task when it ended (see `runId`), so its
       *  verdict moved nothing and no fix run is due. */
      superseded?: boolean
    }
  /** The run named by `runId` had already lost the task: nothing was touched. */
  | { ok: true; action: 'superseded'; taskStatus: string }
  | { ok: false; reason: 'not_found' }

/** Verification options for a `complete` action. All optional;
 *  the reviewer (critic) runs only when `makeReviewerAdapter` is supplied. */
export interface CompleteWorkspaceOpts {
  makeReviewerAdapter?: (ctx: RuntimeRunContext) => RuntimeAdapter
  reviewerModel?: string | null
  mcpBaseUrl?: string | null
  /** Told what the reviewer's run cost, so the caller can charge it. */
  onReviewerSpend?: (spend: ReviewerSpend) => void
  /** True while a pause covers the task: the reviewer does not start. */
  reviewPaused?: () => boolean
  /**
   * The run this check belongs to, still open: the task runner closes its run only
   * after the verdict, so a crash during the check leaves a `running` row the boot
   * reap and the stale sweep can find. Once that row is closed for it, or a newer
   * run has started, the check no longer speaks for the task: its verdict is not
   * written. A run already in that state when it gets here touches nothing.
   */
  runId?: string
  /** Override how long a run's check may take (tests). */
  checkDeadlineMs?: number
}

/** The check's answer, or null once `ms` of awake time has passed without one. The
 *  work is left to finish on its own, and what it says then is ignored. */
function withinDeadline<T>(work: Promise<T>, ms: number): Promise<T | null> {
  return new Promise((resolve, reject) => {
    const timer = setAwakeTimeout(() => resolve(null), ms)
    work.then(
      (value) => {
        timer.clear()
        resolve(value)
      },
      (err: unknown) => {
        timer.clear()
        reject(err)
      },
    )
  })
}

/**
 * Pause or complete a task's worktree.
 * - **pause** → commit + drop worktree + keep branch (workspace stays active, resumable).
 * - **complete** → empty diff cleans up the worktree + branch and the task goes
 *   `done`. A non-empty diff goes `in_review`; then the verification gate runs (deterministic build/test/lint + an optional read-only
 *   critic) and ONLY a `pass` verdict promotes `in_review → done`. A `fail` with
 *   attempts still left reverts to `in_progress` with a structured fix note; a
 *   spent attempt budget, and `completed_with_debt` in any form, route to
 *   `blocked` for a human. Nothing else reaches `done` on this path: a green gate
 *   with a failing verdict means the critic raised a BLOCKING finding, and
 *   auto-landing those is the outcome this routing exists to prevent.
 *   Task transitions are best-effort (skipped if the state machine disallows them).
 */
export async function actOnTaskWorkspace(
  taskId: string,
  action: 'pause' | 'complete',
  opts: CompleteWorkspaceOpts = {},
): Promise<ActionResult> {
  const db = getDb()
  const ws = getWorkspaceForTask(db, taskId)
  if (!ws || !ws.worktreePath || !ws.branch) return { ok: false, reason: 'not_found' }
  // The checkout the row records, under the state dir or the work folder. Pause
  // and complete refuse it unless it is the task's folder under one of those.
  const roots = worktreeRootsForRepo(ws.repoPath)
  const loaded = await loadWorktree({ repoPath: ws.repoPath, taskId, rootDir: roots[0] })
  const worktree: Worktree = { ...loaded, worktreePath: ws.worktreePath }

  if (action === 'pause') {
    const pause = await pauseWorktree(ws.repoPath, worktree, roots)
    updateWorkspaceStatus(db, ws.id, 'active', { lastUsedAt: Date.now() })
    return { ok: true, action: 'pause', pause }
  }

  const runStillOpen = (): boolean => {
    if (!opts.runId) return true
    const last = listExecutions(db, taskId).at(-1)
    return last?.id === opts.runId && last.status === 'running'
  }
  // The stale sweep or a person's Retry took the task from this run while it worked,
  // and a newer run may be in this same checkout. `complete` would clean up an empty
  // diff under it, and the moves below would pull its card into review, or leave a
  // released task In review with no run for anything to find. Nothing here is this
  // run's any more. Its work stays in the checkout for whoever runs the task next.
  if (!runStillOpen()) {
    return {
      ok: true,
      action: 'superseded',
      taskStatus: getTask(db, taskId)?.status ?? 'unknown',
    }
  }

  const complete = await completeWorktree(ws.repoPath, worktree, roots)
  // Comparing the diff waits on git, and the run can lose the task meanwhile.
  if (!runStillOpen()) {
    return {
      ok: true,
      action: 'complete',
      complete,
      taskStatus: getTask(db, taskId)?.status ?? 'unknown',
      superseded: true,
    }
  }

  // `complete` ends a run, so the moves below start from `in_progress`. A task
  // back in `todo` (released by a pause hand-off, or never claimed) has no legal
  // move to `done` or `in_review` and would silently stay in To do, so it takes
  // the step a run would have taken first.
  if (getTask(db, taskId)?.status === 'todo') updateStatus(db, taskId, 'in_progress')

  // Empty diff → land the task without a verification gate. An empty diff has no
  // deliverable to verify, so this is an INTENTIONAL override of the intrinsic
  // gate — without it a stale non-promotable verdict from an earlier dirty attempt
  // (the fix that reduced the diff to empty) would block this legitimate terminal.
  if (!complete.dirty) {
    const desired = 'done'
    const res = updateStatus(db, taskId, desired, { humanOverride: true })
    const taskStatus = res.ok ? desired : (getTask(db, taskId)?.status ?? 'unknown')
    if (complete.cleaned) {
      updateWorkspaceStatus(db, ws.id, 'archived')
      setTaskWorkspaceRefs(db, taskId, { worktreeRef: null, branchRef: null })
    }
    return { ok: true, action: 'complete', complete, taskStatus }
  }

  // Verify ON + dirty diff: land in_review, run the verification gate, then gate `done`.
  // CHECKED: `blocked -> in_review` is not a legal transition, so a repeat complete
  // on a task the exhaustion terminal already blocked would silently stay blocked
  // here and then burn another critic call and grow the attempts array while
  // returning ok. Refuse instead, and say why.
  const enter = updateStatus(db, taskId, 'in_review', {
    waitingOn: { kind: 'verification', state: 'running' },
  })
  if (!enter.ok) {
    const current = getTask(db, taskId)?.status ?? 'unknown'
    return {
      ok: true,
      action: 'complete',
      complete,
      taskStatus: current,
      ...(current === 'blocked' ? { verified: 'fail' as const } : {}),
    }
  }
  const checking = verifyTask({
    db,
    taskId,
    repoPath: ws.repoPath,
    worktree,
    diffStat: complete.diffStat,
    // A check the person set for the team outranks whatever init.sh says now.
    verifyCommand: readTeamVerifyCommand(db, getTask(db, taskId)?.teamId ?? null),
    reviewRootDir: reviewRootForRepo(ws.repoPath),
    makeReviewerAdapter: opts.makeReviewerAdapter,
    reviewerModel: opts.reviewerModel,
    mcpBaseUrl: opts.mcpBaseUrl,
    onReviewerSpend: opts.onReviewerSpend,
    ...(opts.reviewPaused ? { reviewPaused: opts.reviewPaused } : {}),
    shouldRecord: runStillOpen,
  })
  // A run's check has a limit, as the team chat's has: the verify command has its own,
  // but a reviewer has none, and the run stays open and beating until the check ends.
  // Only a run's: nothing else keeps a row open for this to close.
  const deadlineMs = opts.checkDeadlineMs ?? WORK_CHECK_TIMEOUT_MS
  const verdict = opts.runId ? await withinDeadline(checking, deadlineMs) : await checking
  if (!verdict) {
    if (getTask(db, taskId)?.status === 'in_review' && runStillOpen()) {
      // The runner parks a check that throws: see `runTaskOnRuntime`.
      throw new Error(`The check did not answer within ${Math.round(deadlineMs / 60_000)} minutes.`)
    }
    return {
      ok: true,
      action: 'complete',
      complete,
      taskStatus: getTask(db, taskId)?.status ?? 'unknown',
      superseded: true,
    }
  }

  // A person moved the task while its check ran (their move is the outcome: the
  // verdict stays on the task as a record of what the check found), or the check
  // lost its run to a restart's reap or sweep, or to a newer run. Either way the
  // task is no longer this check's to move, and no one is told it was routed for
  // review. A fix run would be run over someone else's decision, so none is asked.
  const decided = getTask(db, taskId)?.status
  if (decided !== 'in_review' || !runStillOpen()) {
    return {
      ok: true,
      action: 'complete',
      complete,
      taskStatus: decided ?? 'unknown',
      verified: verdict.status,
      superseded: true,
    }
  }

  let taskStatus: string
  if (verdict.status === 'pass') {
    // The intrinsic gate sees a promotable (`pass`) verdict and allows it.
    const r = updateStatus(db, taskId, 'done')
    taskStatus = r.ok ? 'done' : (getTask(db, taskId)?.status ?? 'in_review')
  } else if (
    verdict.status === 'completed_with_debt' ||
    verdict.attempts.length >= verifyMaxAttempts()
  ) {
    // EXHAUSTION IS A HUMAN TERMINAL, and it is checked BEFORE any debt branch on
    // purpose. `completed_with_debt` is only ever produced AT exhaustion, and the
    // old "debt over a green gate may land" rule would have auto-promoted it to
    // `done` — but a green deterministic gate with a `fail` verdict means the
    // CRITIC raised a blocking finding (security, crash, data-loss,
    // wrong-algorithm, missing-AC). Auto-landing those is precisely the outcome
    // this ordering exists to prevent. Only a clean `pass` promotes, so DEBT
    // lands here too rather than in its own branch: it is produced only at
    // exhaustion, and the old "debt over a green gate may promote" rule is the
    // hazard above.
    //
    // `in_progress` was the old terminal here, and it is a lie the board believes:
    // it reads as "someone is working on this" while nobody is, so the card sits
    // in a column implying progress with no one told. `blocked` is the needs-human
    // terminal, and `blocked -> todo` is one legal move that clears the verdict
    // when a human re-queues it.
    const r = updateStatus(db, taskId, 'blocked', {
      waitingOn: { kind: 'verification', state: 'failed' },
    })
    taskStatus = r.ok ? 'blocked' : (getTask(db, taskId)?.status ?? 'in_review')
    // On the event log too: it is what live views (the browser alerts among
    // them) follow, and the status write above reaches only the in-process bus.
    if (r.ok) {
      emitEvent(db, {
        kind: 'status_changed',
        taskId,
        teamId: r.task?.teamId ?? null,
        data: { to: 'blocked', reason: 'verification_exhausted' },
      })
    }
    addComment(
      db,
      taskId,
      `Verification failed ${verdict.attempts.length}× and the fix loop is exhausted — routed to blocked for human review. See the verification comments above for what failed.`,
      'system',
    )
    // UNCONDITIONAL: the delegator has to hear this whether or not the status
    // write landed. Tying the notice to a successful transition is how an
    // exhausted task goes silent in exactly the case a human is needed.
    notifyVerificationParked(
      db,
      taskId,
      getTask(db, taskId)?.teamId ?? null,
      `Verification failed ${verdict.attempts.length}× on “${getTask(db, taskId)?.title ?? taskId}” and the fix loop is exhausted. The task is blocked for review.`,
    )
  } else {
    // Retries remain: back to `in_progress` so the fix cycle can re-dispatch it.
    const r = updateStatus(db, taskId, 'in_progress')
    taskStatus = r.ok ? 'in_progress' : (getTask(db, taskId)?.status ?? 'in_review')
  }
  return { ok: true, action: 'complete', complete, taskStatus, verified: verdict.status }
}

export interface GcSummary {
  reaped: string[]
  skipped: { taskId: string; reason: string }[]
  failed: { taskId: string; error: string }[]
}

/**
 * Sweep stale worktrees across every repo with active workspaces, under the
 * state dir and, for checkouts a row records there, the work folder. Tasks that
 * are locked (`in_progress` / `in_review`) are skipped; a workspace whose
 * recorded checkout a sweep removed is marked `stale`. Reaping
 * commits-before-drop, so no uncommitted work is lost.
 */
export async function gcTaskWorkspaces(
  opts: { maxAgeMs?: number; maxCount?: number } = {},
): Promise<GcSummary> {
  const db = getDb()
  const active = listActiveWorkspaces(db).filter((w) => w.worktreePath)
  const byRepo = new Map<string, typeof active>()
  for (const ws of active) {
    const list = byRepo.get(ws.repoPath) ?? []
    list.push(ws)
    byRepo.set(ws.repoPath, list)
  }
  // Liveness is read LIVE per task, not from a frozen snapshot. `gcWorktrees`
  // re-invokes this callback inside the per-path mutex immediately before the
  // destructive step, so a task that transitioned todo→in_progress mid-sweep is
  // genuinely skipped. A pre-built `locked` Set would re-open the TOCTOU (the
  // executor holds `in_progress` for minutes without holding the worktree mutex).
  // getTask is a cheap indexed PK read.
  const isTaskActive = (taskId: string): boolean => {
    const t = getTask(db, taskId)
    return t?.status === 'in_progress' || t?.status === 'in_review'
  }

  const summary: GcSummary = { reaped: [], skipped: [], failed: [] }
  for (const [repoPath, list] of byRepo) {
    const stateRoot = worktreeRootForRepo(repoPath)
    const workRoots = workFolderRootsForRepo(repoPath)
    // The state dir is this install's alone. A work folder can be shared by two
    // installs that set the same CLAWBOO_WORK_DIR, so there a folder is swept
    // only when one of this install's rows records that very checkout; anything
    // else, another install's included, is left alone and not counted.
    // `taskId` is a folder name from disk, so it is matched against the rows
    // before it is ever used to build a path.
    const recordedInWorkFolder = (taskId: string): boolean =>
      list.some((w) => {
        if (w.taskId !== taskId || !w.worktreePath) return false
        const recorded = path.resolve(w.worktreePath)
        return workRoots.some((root) => worktreePathFor(repoPath, taskId, root) === recorded)
      })
    for (const rootDir of gcRootsForRepo(repoPath)) {
      const r = await gcWorktrees({
        repoPath,
        rootDir,
        maxAgeMs: opts.maxAgeMs,
        maxCount: opts.maxCount,
        isActive: isTaskActive,
        ...(rootDir === stateRoot ? {} : { owns: recordedInWorkFolder }),
      })
      for (const taskId of r.reaped) {
        // A folder named for the task can sit under one root while the row
        // records a checkout under another; only a row whose own checkout is
        // gone goes stale.
        const ws = list.find((w) => w.taskId === taskId)
        if (ws?.worktreePath && !existsSync(ws.worktreePath)) {
          updateWorkspaceStatus(db, ws.id, 'stale')
        }
      }
      summary.reaped.push(...r.reaped)
      summary.skipped.push(...r.skipped)
      summary.failed.push(...r.failed)
    }
  }
  return summary
}
