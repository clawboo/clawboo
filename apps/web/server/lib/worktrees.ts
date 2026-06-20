// Server-side worktree orchestrator. Ties the runtime-
// agnostic @clawboo/worktrees git/SoR mechanism to the durable board: provision
// records a `workspaces` row + the task's worktree/branch refs; complete drives
// the task's status (empty diff → done + cleanup; non-empty → in_review +
// retain); GC marks reaped workspaces stale.
//
// Worktrees live OUTSIDE the user's repo (under the clawboo state dir, namespaced
// by a repo-path hash) so they never pollute the repo's own `git status`.

import crypto from 'node:crypto'
import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import path from 'node:path'

import { resolveClawbooDir } from '@clawboo/config'
import {
  addComment,
  createDb,
  createWorkspace,
  getTask,
  getWorkspaceForTask,
  listActiveWorkspaces,
  setTaskWorkspaceRefs,
  updateStatus,
  updateWorkspaceStatus,
  type DbTask,
  type DbWorkspace,
} from '@clawboo/db'
import type { RuntimeAdapter } from '@clawboo/executor'
import { isVerdictPromotable } from '@clawboo/governance'
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
  worktreeDiff,
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

import { getDbPath } from './db'
import type { RuntimeRunContext } from './runtimes'
import { verifyTask } from './verification'

/**
 * Worktree root for a repo — under the clawboo state dir, namespaced by a hash
 * of the repo path so multiple repos never collide and (critically) so worktrees
 * are NOT created inside the user's repo tree.
 */
function worktreeRootForRepo(repoPath: string): string {
  const hash = crypto.createHash('sha1').update(path.resolve(repoPath)).digest('hex').slice(0, 12)
  return path.join(resolveClawbooDir(), 'worktrees', hash)
}

/** Detached review checkouts live OUTSIDE the user repo too (the critic gate). */
function reviewRootForRepo(repoPath: string): string {
  const hash = crypto.createHash('sha1').update(path.resolve(repoPath)).digest('hex').slice(0, 12)
  return path.join(resolveClawbooDir(), 'reviews', hash)
}

function scaffoldFromTask(task: DbTask): TaskScaffoldInput {
  return {
    taskId: task.id,
    title: task.title,
    description: task.description,
    teamName: task.teamId,
  }
}

export type ProvisionResult =
  | { ok: true; worktree: Worktree; workspaceId: string; isolation: IsolationLevel }
  | { ok: false; reason: 'not_found' | 'no_isolation'; isolation?: IsolationLevel }

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
  const db = createDb(getDbPath())
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
    const worktree = await loadWorktree({ repoPath: input.repoPath, taskId, rootDir })
    return { ok: true, worktree, workspaceId: existing.id, isolation }
  }

  const worktree = await provisionWorktree({
    repoPath: input.repoPath,
    taskId,
    baseSha: input.baseSha,
    baseRef: input.baseRef,
    rootDir,
    scaffold: scaffoldFromTask(task),
  })
  let workspaceId: string
  if (existing) {
    // Reuse the prior (stale / reaped) row instead of inserting a duplicate —
    // the worktree path + branch are deterministic per (repo, task).
    updateWorkspaceStatus(db, existing.id, 'active', { lastUsedAt: Date.now() })
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
 * branch is gone (a genuinely-fresh provision is the caller's fallback).
 */
export async function resumeTaskWorkspace(
  taskId: string,
  input: { repoPath: string },
): Promise<ProvisionResult> {
  const db = createDb(getDbPath())
  const ws = getWorkspaceForTask(db, taskId)
  if (!ws || !ws.worktreePath) return { ok: false, reason: 'not_found' }
  const repoPath = ws.repoPath || input.repoPath
  try {
    const worktree = await resumeWorktree({
      repoPath,
      taskId,
      rootDir: worktreeRootForRepo(repoPath),
    })
    updateWorkspaceStatus(db, ws.id, 'active', { lastUsedAt: Date.now() })
    setTaskWorkspaceRefs(db, taskId, {
      worktreeRef: worktree.worktreePath,
      branchRef: worktree.branch,
    })
    return { ok: true, worktree, workspaceId: ws.id, isolation: 'worktree' }
  } catch {
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
  const db = createDb(getDbPath())
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
  diffStat?: DiffStat | null
  /** Unified diff (baseline vs working tree), SoR bookkeeping files excluded. */
  diff?: string
}

/** Read-only detail for the task-detail drawer: the SoR file contents + the diff
 *  against the branch-point baseline (excluding the SoR bookkeeping files). */
export async function readWorktreeDetail(taskId: string): Promise<WorktreeDetail> {
  const db = createDb(getDbPath())
  const ws = getWorkspaceForTask(db, taskId)
  if (!ws || !ws.worktreePath) return { ok: false, reason: 'not_found' }
  const wtPath = ws.worktreePath
  const sorFiles: Record<string, string> = {}
  for (const name of Object.values(SOR_FILES)) {
    try {
      sorFiles[name] = await readFile(path.join(wtPath, name), 'utf8')
    } catch {
      /* file may not exist in this worktree */
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
  return { ok: true, workspace: ws, sorFiles, diffStat: stat, diff }
}

/** Write the clock-out `AGENT_HANDOFF.json` into a task's worktree. */
export async function writeTaskHandoff(
  taskId: string,
  handoff: AgentHandoffInput,
): Promise<{ ok: boolean; reason?: 'not_found' }> {
  const db = createDb(getDbPath())
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
    }
  | { ok: false; reason: 'not_found' }

/** Verification options for a `complete` action. All optional;
 *  the reviewer (critic) runs only when `makeReviewerAdapter` is supplied. */
export interface CompleteWorkspaceOpts {
  makeReviewerAdapter?: (ctx: RuntimeRunContext) => RuntimeAdapter
  reviewerModel?: string | null
  mcpBaseUrl?: string | null
}

/**
 * Pause or complete a task's worktree.
 * - **pause** → commit + drop worktree + keep branch (workspace stays active, resumable).
 * - **complete** → empty diff cleans up the worktree + branch and the task goes
 *   `done`. A non-empty diff goes `in_review`; then the verification gate runs (deterministic build/test/lint + an optional read-only
 *   critic) and only a `pass` verdict promotes `in_review → done` (a `fail` reverts
 *   to `in_progress` with a structured fix note; `completed_with_debt` proceeds to
 *   `done` so the loop never deadlocks). Flag-off, the original behavior is verbatim.
 *   Task transitions are best-effort (skipped if the state machine disallows them).
 */
export async function actOnTaskWorkspace(
  taskId: string,
  action: 'pause' | 'complete',
  opts: CompleteWorkspaceOpts = {},
): Promise<ActionResult> {
  const db = createDb(getDbPath())
  const ws = getWorkspaceForTask(db, taskId)
  if (!ws || !ws.worktreePath || !ws.branch) return { ok: false, reason: 'not_found' }
  const rootDir = worktreeRootForRepo(ws.repoPath)
  const worktree = await loadWorktree({ repoPath: ws.repoPath, taskId, rootDir })

  if (action === 'pause') {
    const pause = await pauseWorktree(ws.repoPath, worktree)
    updateWorkspaceStatus(db, ws.id, 'active', { lastUsedAt: Date.now() })
    return { ok: true, action: 'pause', pause }
  }

  const complete = await completeWorktree(ws.repoPath, worktree)

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
  updateStatus(db, taskId, 'in_review')
  const verdict = await verifyTask({
    db,
    taskId,
    repoPath: ws.repoPath,
    worktree,
    diffStat: complete.diffStat,
    reviewRootDir: reviewRootForRepo(ws.repoPath),
    makeReviewerAdapter: opts.makeReviewerAdapter,
    reviewerModel: opts.reviewerModel,
    mcpBaseUrl: opts.mcpBaseUrl,
  })

  let taskStatus: string
  if (verdict.status === 'pass') {
    // The intrinsic gate sees a promotable (`pass`) verdict and allows it.
    const r = updateStatus(db, taskId, 'done')
    taskStatus = r.ok ? 'done' : (getTask(db, taskId)?.status ?? 'in_review')
  } else if (verdict.status === 'completed_with_debt' && isVerdictPromotable(verdict)) {
    // Debt over a GREEN deterministic gate (unresolved critic findings only) may
    // land — the intrinsic gate treats it as promotable.
    const r = updateStatus(db, taskId, 'done')
    taskStatus = r.ok ? 'done' : (getTask(db, taskId)?.status ?? 'in_review')
  } else if (verdict.status === 'completed_with_debt') {
    // Debt over a RED deterministic gate (a failing build/test gate exhausted the
    // fix loop) is NOT auto-promotable — route to a human instead of silently
    // shipping. The intrinsic gate would also block `done` here; making it
    // `blocked` is the explicit needs-human terminal.
    const r = updateStatus(db, taskId, 'blocked')
    addComment(
      db,
      taskId,
      'Verification debt with a failing deterministic gate — routed to blocked for human review (a red build/test gate is not auto-promotable).',
      'system',
    )
    taskStatus = r.ok ? 'blocked' : (getTask(db, taskId)?.status ?? 'in_review')
  } else {
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
 * Sweep stale worktrees across every repo with active workspaces. Tasks that are
 * locked (`in_progress` / `in_review`) are skipped; reaped workspaces are marked
 * `stale`. Reaping commits-before-drop, so no uncommitted work is lost.
 */
export async function gcTaskWorkspaces(
  opts: { maxAgeMs?: number; maxCount?: number } = {},
): Promise<GcSummary> {
  const db = createDb(getDbPath())
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
    const rootDir = worktreeRootForRepo(repoPath)
    const r = await gcWorktrees({
      repoPath,
      rootDir,
      maxAgeMs: opts.maxAgeMs,
      maxCount: opts.maxCount,
      isActive: isTaskActive,
    })
    for (const taskId of r.reaped) {
      const ws = list.find((w) => w.taskId === taskId)
      if (ws) updateWorkspaceStatus(db, ws.id, 'stale')
    }
    summary.reaped.push(...r.reaped)
    summary.skipped.push(...r.skipped)
    summary.failed.push(...r.failed)
  }
  return summary
}
