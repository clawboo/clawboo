// Server-side worktree orchestrator. Ties the runtime-
// agnostic @clawboo/worktrees git/SoR mechanism to the durable board: provision
// records a `workspaces` row + the task's worktree/branch refs; complete drives
// the task's status (empty diff → done + cleanup; non-empty → in_review +
// retain); GC marks reaped workspaces stale.
//
// Worktrees live OUTSIDE the user's repo (under the work folder, namespaced by a
// repo-path hash) so they never pollute the repo's own `git status`, and outside
// the clawboo state dir, so `../..` from one is not the database. A checkout
// recorded under the state dir, where older versions made them, or kept at its
// old place by the work folder move, is acted on where it is recorded.
//
// With agents on their own OS user (CLAWBOO_AGENT_USER), a checkout is a
// worktree of the agent's own bare mirror of the repository, not of the user's
// repository, and every git call and file operation in the mirror or the
// checkout runs as the agent user (design 4.9; see `agentUser/mirror.ts` and
// `agentUser/worktreeIo.ts`). The workspace row still records the USER's
// repository: it is what the board shows and where finished work is brought
// back to. The mirror is always derived from it.

import { existsSync, readdirSync } from 'node:fs'
import { mkdir } from 'node:fs/promises'
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
  assertSafeTaskId,
  branchNameForTask,
  commitWorktreeWork,
  completeWorktree,
  diffStat,
  execGit,
  gcWorktrees,
  getWorktreeIo,
  GitError,
  isCommitId,
  isGitRepo,
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
  worktreeRegistration,
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
  type WorktreeRegistration,
} from '@clawboo/worktrees'

import {
  agentList,
  agentMkdir,
  agentReadFile,
  agentRemove,
  agentStat,
  agentWriteFile,
} from './agentUser/agentFs'
import { isAgentUserMode } from './agentUser/config'
import { exportTaskBranch, mirrorPathFor, syncMirror } from './agentUser/mirror'
import { installAgentWorktreeIo, isInAgentSpace } from './agentUser/worktreeIo'
import { getDb } from './db'
import { emitEvent } from './obs'
import type { RuntimeRunContext } from './runtimes'
import {
  verifyMaxAttempts,
  verifyTask,
  type ReviewerGate,
  type ReviewerSpend,
} from './verification'
import { readTeamVerifyCommand } from './verification/teamVerifyCommand'
import { notifyVerificationParked } from './teamChat/inboxNotices'
import {
  installId,
  ownerMarkerPath,
  readOwnerMarker,
  realPathOf,
  removeOwnerMarker,
  repoHash,
  reviewsRoot,
  workDirSpellings,
  workRoot,
  writeOwnerMarker,
} from './workDir'
import { stayingWorktreeRoots } from './workDirJournal'
import { readFileAt } from './workspaceFs'

/**
 * Worktree root for a repo, under the work folder, namespaced by a hash of the
 * repo path so multiple repos never collide and (critically) so worktrees are
 * NOT created inside the user's repo tree. Every new checkout goes here.
 */
function worktreeRootForRepo(repoPath: string): string {
  return path.join(workRoot('worktrees'), repoHash(repoPath))
}

/** The state dir's worktree root for a repo, where older versions made them. */
function stateWorktreeRootForRepo(repoPath: string): string {
  return path.join(resolveClawbooDir(), 'worktrees', repoHash(repoPath))
}

/** True for a root other than the state dir's: one a work folder can share with
 *  another install, so this install marks what it makes there. */
function isSharedRoot(repoPath: string, root: string): boolean {
  return path.resolve(root) !== path.resolve(stateWorktreeRootForRepo(repoPath))
}

// ── Agents on their own OS user ─────────────────────────────────────────────

/** True when agents run as their own OS user. The worktree io is then the one
 *  that sends work in agent space to the agent host (installed at boot; made
 *  sure of here, since nothing here may run in agent space as the server). */
function agentMode(): boolean {
  if (!isAgentUserMode()) return false
  installAgentWorktreeIo()
  return true
}

/** The repository a task's checkouts are worktrees of: the user's, or with
 *  agents on their own OS user, the agent's mirror of it. */
function checkoutRepoFor(repoPath: string): string {
  return isAgentUserMode() ? mirrorPathFor(repoPath) : repoPath
}

/** True when `p` is the agent user's to touch: agent isolation is on and `p`
 *  is in the work folder. */
function asAgent(p: string): boolean {
  return isAgentUserMode() && isInAgentSpace(p)
}

/** Whether something is at a recorded checkout path. In agent space the server
 *  cannot look, so the agent host does. */
async function checkoutOnDisk(p: string): Promise<boolean> {
  return agentMode() ? getWorktreeIo().exists(p) : existsSync(p)
}

/** A commit id for `ref` in `repoPath` (a tag or branch resolved to its commit).
 *  What git prints is checked: it goes back to git as an argument, and the
 *  agent's mirror can make git print anything. */
async function commitIn(repoPath: string, ref: string): Promise<string> {
  if (!ref || ref.startsWith('-')) throw new Error(`not a commit: ${JSON.stringify(ref)}`)
  const sha = (await execGit(repoPath, ['rev-parse', '--verify', `${ref}^{commit}`])).trim()
  if (!isCommitId(sha)) throw new Error(`${ref} in ${repoPath} did not resolve to a commit id`)
  return sha
}

/**
 * The commit `branch` is at in `repoPath`, or null when git says there is no
 * such branch. Anything else (a repository git cannot read, a host that did not
 * answer, an answer that is not a commit id) throws: "no branch" lets a task
 * start over, so it is said only when git said it.
 */
async function branchTip(repoPath: string, branch: string): Promise<string | null> {
  let out: string
  try {
    out = await execGit(repoPath, [
      'rev-parse',
      '--verify',
      '--quiet',
      `refs/heads/${branch}^{commit}`,
    ])
  } catch (err) {
    // `--verify --quiet` exits 1, saying nothing, when the ref is not there.
    if (err instanceof GitError && err.exitCode === 1 && !err.stderr.trim()) return null
    throw err
  }
  const sha = out.trim()
  if (!isCommitId(sha)) throw new Error(`${branch} in ${repoPath} did not resolve to a commit id`)
  return sha
}

/** Whether the agent's mirror of `repoPath` is there. A host that does not
 *  answer throws rather than reading as "no". */
async function mirrorExists(repoPath: string): Promise<boolean> {
  return (await agentStat(mirrorPathFor(repoPath))) !== null
}

const NOT_CARRIED = 'so code tasks on it are not available while agents run as a separate user.'

/**
 * Why the agent's copy cannot hold `repoPath` at `commit`, or null when it can.
 * A bundle carries commits only: not the Git LFS objects a checkout fetches,
 * nor the repositories submodules point to (design 4.9, "Costs").
 */
async function mirrorCannotCarry(repoPath: string, commit: string): Promise<string | null> {
  try {
    await execGit(repoPath, ['cat-file', '-e', `${commit}:.gitmodules`])
    return `This repository has submodules, which cannot be copied to the agent user, ${NOT_CARRIED}`
  } catch {
    /* no .gitmodules */
  }
  try {
    const hits = await execGit(repoPath, [
      'grep',
      '-l',
      '-F',
      'filter=lfs',
      commit,
      '--',
      '.gitattributes',
      ':(glob)**/.gitattributes',
    ])
    if (hits.trim()) {
      return `This repository uses Git LFS, whose files cannot be copied to the agent user, ${NOT_CARRIED}`
    }
  } catch {
    /* git grep exits 1 when nothing matches */
  }
  return null
}

type MirrorReady = { ok: true; base: string } | { ok: false; why: string }

/** Bring the commit a new task starts from into the agent's mirror of
 *  `repoPath`. The commit is resolved in the user's repository, by the server. */
async function prepareMirror(repoPath: string, ref: string): Promise<MirrorReady> {
  if (!(await isGitRepo(repoPath))) throw new Error(`not a git repository: ${repoPath}`)
  const base = await commitIn(repoPath, ref)
  const why = await mirrorCannotCarry(repoPath, base)
  if (why) return { ok: false, why }
  await syncMirror(repoPath, base)
  return { ok: true, base }
}

/**
 * Before a task's checkout is rebuilt from its branch: a branch only the user's
 * repository has (the task last ran before agents had their own user, or the
 * mirror was removed) is copied into the mirror. A branch the mirror has holds
 * the agent's work and is left as it is.
 */
async function bringBranchIntoMirror(
  repoPath: string,
  branch: string,
): Promise<{ ok: true } | { ok: false; why: string }> {
  const mirror = mirrorPathFor(repoPath)
  if ((await mirrorExists(repoPath)) && (await branchTip(mirror, branch)) !== null) {
    return { ok: true }
  }
  const tip = await branchTip(repoPath, branch)
  // Nowhere: the resume reports the missing branch.
  if (tip === null) return { ok: true }
  const why = await mirrorCannotCarry(repoPath, tip)
  if (why) return { ok: false, why }
  await syncMirror(repoPath, tip)
  await execGit(mirror, ['branch', branch, tip])
  return { ok: true }
}

/** True when `commit` is a commit `repoPath` has. */
async function hasCommit(repoPath: string, commit: string): Promise<boolean> {
  try {
    await execGit(repoPath, ['cat-file', '-e', `${commit}^{commit}`])
    return true
  } catch {
    return false
  }
}

/**
 * Bring a task branch out of the agent's mirror into the user's repository
 * under the same name, so committed work is never only in agent space and the
 * board's diff and merge read the user's repository as they always have.
 * Nothing moves when the user's branch is already there. The user's branch is
 * replaced, as the one shared branch is without isolation, unless it is at a
 * commit the mirror has never had: someone committed to it in their own
 * repository, and that is never overwritten (this throws instead).
 */
async function exportFromMirror(repoPath: string, worktree: Worktree): Promise<void> {
  const mirror = mirrorPathFor(repoPath)
  const tip = await branchTip(mirror, worktree.branch)
  if (tip === null) return
  const theirs = await branchTip(repoPath, worktree.branch)
  if (theirs === tip) return
  if (theirs !== null && !(await hasCommit(mirror, theirs))) {
    throw new Error(
      `${worktree.branch} in ${repoPath} has commits the agent's copy does not, so it was left as it is`,
    )
  }
  // The scaffold commit's parent is the commit the task started from, which the
  // user's repository has: only what came after it travels.
  const base = await commitIn(mirror, `${worktree.baseCommit}^`)
  // `theirs` is what was checked above: the branch moves only from it.
  await exportTaskBranch(repoPath, worktree.branch, base, theirs)
}

/** {@link exportFromMirror}, after committing what is in the checkout when
 *  `commitFirst`, with a failure told on the task rather than thrown: the work
 *  is safe in the agent's copy, and the next pause or completion tries again. */
async function exportOrNote(
  db: ClawbooDb,
  taskId: string,
  repoPath: string,
  worktree: Worktree,
  opts: { commitFirst?: boolean } = {},
): Promise<void> {
  try {
    if (opts.commitFirst) await commitWorktreeWork(mirrorPathFor(repoPath), worktree)
    await exportFromMirror(repoPath, worktree)
  } catch (err) {
    addComment(
      db,
      taskId,
      `The task's work could not be brought into ${repoPath}: ${err instanceof Error ? err.message : String(err)}. It is kept in the agent's copy of the repository and is brought over when the task is next paused or completed.`,
      'system',
    )
  }
}

/**
 * {@link exportFromMirror} on completion, after committing what is in the
 * checkout when `commitFirst`. A completed task must not land with the user's
 * repository missing its work, so a failure blocks the task with the reason
 * (the work stays in the agent's copy). Returns null when the work was brought
 * over, else the task's status now.
 */
async function exportOrBlock(
  db: ClawbooDb,
  taskId: string,
  repoPath: string,
  worktree: Worktree,
  opts: { commitFirst?: boolean } = {},
): Promise<string | null> {
  try {
    if (opts.commitFirst) await commitWorktreeWork(mirrorPathFor(repoPath), worktree)
    await exportFromMirror(repoPath, worktree)
    return null
  } catch (err) {
    const why = err instanceof Error ? err.message : String(err)
    const r = updateStatus(db, taskId, 'blocked', { waitingOn: { kind: 'failure' } })
    if (r.ok) {
      emitEvent(db, {
        kind: 'status_changed',
        taskId,
        teamId: r.task?.teamId ?? null,
        data: { to: 'blocked', reason: 'export_failed' },
      })
    }
    addComment(
      db,
      taskId,
      `The task's work could not be brought into ${repoPath}: ${why}. It is kept in the agent's copy of the repository, and the task is blocked until a person sorts this out, so it cannot land without its work.`,
      'system',
    )
    return r.ok ? 'blocked' : (getTask(db, taskId)?.status ?? 'unknown')
  }
}

/** After a task with nothing to land is cleaned up: delete the copy of its
 *  branch an earlier pause brought into the user's repository. Only one the
 *  mirror also holds, so a branch with commits made in the user's repository is
 *  kept; `branch -D` keeps one that is checked out there. Best-effort. */
async function dropExportedBranch(repoPath: string, branch: string): Promise<void> {
  try {
    const theirs = await branchTip(repoPath, branch)
    if (theirs === null || !(await hasCommit(mirrorPathFor(repoPath), theirs))) return
    await execGit(repoPath, ['branch', '-D', branch])
  } catch {
    /* best-effort */
  }
}

/**
 * A checkout recorded outside the work folder while agents run as their own OS
 * user is the server's own, made from the user's repository before isolation
 * was turned on. Its uncommitted work is committed to the task branch, as a
 * pause commits it, and the checkout is removed, so its branch is no longer
 * checked out there and can be copied to the agent and brought back. Done as
 * the server, in its own folder and repository, and never with a prune of the
 * whole repository. What cannot be done safely is refused with
 * {@link UnsafeWorktreeError} and nothing removed; a registration git could not
 * check is {@link RegistrationUnknownError}.
 */
async function releaseServerCheckout(
  repoPath: string,
  taskId: string,
  wtPath: string,
): Promise<void> {
  const recorded = path.resolve(wtPath)
  const branch = branchNameForTask(taskId)
  const registration = await worktreeRegistration(repoPath, recorded)
  if (registration === 'unknown') throw new RegistrationUnknownError(recorded)
  if (!existsSync(recorded)) {
    // Gone, but a registration left behind still holds the branch: that one
    // registration is removed.
    if (registration === 'registered') {
      await execGit(repoPath, ['worktree', 'remove', '--force', recorded])
    }
    return
  }
  if (registration === 'unregistered') {
    // Not a checkout git knows: it holds no branch, and what is in it is not
    // the server's to remove.
    if (readdirSync(recorded).length === 0) return
    throw new UnsafeWorktreeError(
      recorded,
      `git does not list it as a checkout of ${repoPath}, so its work cannot be saved on ${branch}`,
    )
  }
  const main = /^worktree (.+)$/m.exec(await execGit(repoPath, ['worktree', 'list', '--porcelain']))
  if (main && path.resolve(main[1]!) === recorded) {
    throw new UnsafeWorktreeError(recorded, `it is the main checkout of ${repoPath}`)
  }
  let head = ''
  try {
    head = (await execGit(recorded, ['symbolic-ref', '-q', 'HEAD'])).trim()
  } catch {
    /* detached */
  }
  if (head !== `refs/heads/${branch}`) {
    throw new UnsafeWorktreeError(
      recorded,
      `it has ${head || 'no branch'} checked out, not ${branch}, so its work cannot be saved on the task branch`,
    )
  }
  const worktree: Worktree = {
    taskId,
    worktreePath: recorded,
    branch,
    baseCommit: '',
    detached: false,
  }
  try {
    await pauseWorktree(repoPath, worktree, path.dirname(recorded), { prune: false })
  } catch (err) {
    if (err instanceof UnsafeWorktreeError || err instanceof RegistrationUnknownError) throw err
    throw new UnsafeWorktreeError(
      recorded,
      `it was made before agents ran as a separate user, and saving and releasing it failed: ${err instanceof Error ? err.message : String(err)}`,
    )
  }
}

/** The owner markers in an agent-space root, read through the agent host:
 *  task id to install id, for the ones that are small plain files. */
async function ownerMarkersAsAgent(root: string): Promise<Map<string, string>> {
  const out = new Map<string, string>()
  let entries: { name: string; type: string }[]
  try {
    entries = (await agentList(root, { max: 100_000 })).entries
  } catch {
    return out
  }
  for (const e of entries) {
    const m = /^\.(.+)\.owner$/.exec(e.name)
    if (!m || e.type !== 'file') continue
    let taskId: string
    try {
      taskId = assertSafeTaskId(m[1]!)
    } catch {
      continue
    }
    const buf = await agentReadFile(ownerMarkerPath(root, taskId), { maxBytes: 65 }).catch(
      () => null,
    )
    if (!buf || buf.length > 64) continue
    const id = buf.toString('utf8').trim()
    if (id) out.set(taskId, id)
  }
  return out
}

async function dropOwnerMarker(root: string, taskId: string): Promise<void> {
  if (asAgent(root)) await agentRemove(ownerMarkerPath(root, taskId))
  else await removeOwnerMarker(root, taskId)
}

/** Mark `<root>/<taskId>` as this install's before it is made, so cleanup can
 *  tell it from another install's even if the board never records it. In agent
 *  space the agent host writes it. */
async function markOwned(repoPath: string, root: string, taskId: string): Promise<void> {
  if (!isSharedRoot(repoPath, root)) return
  if (asAgent(root)) {
    await agentMkdir(root, { mode: 0o700 })
    await agentWriteFile(ownerMarkerPath(root, taskId), installId(getDb()), { mode: 0o600 })
    return
  }
  await mkdir(root, { recursive: true, mode: 0o700 })
  await writeOwnerMarker(root, taskId, installId(getDb()))
}

/** The work folder's worktree roots for `repoPath`, in each of its spellings. */
function workFolderRootsForRepo(repoPath: string): string[] {
  const hash = repoHash(repoPath)
  return workDirSpellings().map((dir) => path.join(dir, 'worktrees', hash))
}

/**
 * Every root a recorded checkout of `repoPath` may be under: where new ones go
 * (first), the state dir's, the work folder's in each of its spellings, and any
 * the work folder move kept a checkout at. Pause and complete refuse a record
 * under none of them.
 */
function worktreeRootsForRepo(repoPath: string): string[] {
  return [
    ...new Set([
      worktreeRootForRepo(repoPath),
      stateWorktreeRootForRepo(repoPath),
      ...workFolderRootsForRepo(repoPath),
      ...stayingWorktreeRoots(repoPath),
    ]),
  ]
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

/** Detached review checkouts live OUTSIDE the user repo too (the critic gate),
 *  in this install's folder of the work folder's reviews. */
function reviewRootForRepo(repoPath: string): string {
  return path.join(reviewsRoot(getDb()), repoHash(repoPath))
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

/**
 * Whether a task's recorded checkout is on disk, and whether git lists it as a
 * worktree of the repository holding its git data: the user's repository, or
 * with agents on their own OS user, the agent's mirror of it (asked through the
 * agent host). `registration` is null when the folder is not there or there is
 * no repository to ask. For the task runner's "was this checkout reaped?" test.
 * A checkout outside the work folder under agent isolation was made by the
 * server from the user's repository, and reads as gone, so it is rebuilt.
 */
export async function recordedCheckoutState(
  repoPath: string | null | undefined,
  wtPath: string,
): Promise<{ onDisk: boolean; registration: WorktreeRegistration | null }> {
  if (!agentMode()) {
    const onDisk = existsSync(wtPath)
    return {
      onDisk,
      registration: onDisk && repoPath ? await worktreeRegistration(repoPath, wtPath) : null,
    }
  }
  if (!isInAgentSpace(wtPath)) return { onDisk: false, registration: null }
  const onDisk = await getWorktreeIo().exists(wtPath)
  if (!onDisk || !repoPath) return { onDisk, registration: null }
  const mirror = mirrorPathFor(repoPath)
  // No mirror: no checkout of it can be registered, and git would only fail.
  if (!(await getWorktreeIo().exists(mirror))) return { onDisk, registration: 'unregistered' }
  return { onDisk, registration: await worktreeRegistration(mirror, wtPath) }
}

export type ProvisionResult =
  | { ok: true; worktree: Worktree; workspaceId: string; isolation: IsolationLevel }
  | { ok: false; reason: 'not_found' | 'no_isolation'; isolation?: IsolationLevel }
  /** A checkout is already at the task's path and replacing it could lose work
   *  (uncommitted changes, or a folder git cannot read). It is left as it was,
   *  and nothing falls back to a fresh provision over it. */
  | { ok: false; reason: 'unsafe_to_rebuild'; worktreePath: string; why: string }
  /** With agents on their own OS user, the repository cannot be copied to the
   *  agent (it uses Git LFS or submodules). `why` says so in a person's words. */
  | { ok: false; reason: 'not_supported'; why: string; isolation: IsolationLevel }

/** A rebuild's outcome: a provision's, or `registration_unknown` when resume
 *  asked git whether the checkout is registered and got no answer, so it
 *  changed nothing. That says nothing about the folder: the task can run again.
 *  With agents on their own OS user, `rebuild_failed` is any other failure: the
 *  branch is there (or git could not say), so the caller must not start the task
 *  over, which would reset it. Nothing was reset; the task can run again. */
export type ResumeResult =
  | ProvisionResult
  | { ok: false; reason: 'registration_unknown'; worktreePath: string }
  | { ok: false; reason: 'rebuild_failed'; worktreePath: string; why: string }

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
  const agent = agentMode()
  const existing = getWorkspaceForTask(db, taskId)
  const rootDir = worktreeRootForRepo(input.repoPath)
  const checkoutRepo = checkoutRepoFor(input.repoPath)
  if (
    existing &&
    existing.status === 'active' &&
    existing.worktreePath &&
    (await checkoutOnDisk(existing.worktreePath)) &&
    (await isWorktreeRegistered(checkoutRepo, existing.worktreePath))
  ) {
    updateWorkspaceStatus(db, existing.id, 'active', { lastUsedAt: Date.now() })
    // The checkout git just confirmed, at its recorded path (which may be under
    // the work folder), not one rebuilt under the state dir.
    const loaded = await loadWorktree({ repoPath: checkoutRepo, taskId, rootDir })
    const worktree = { ...loaded, worktreePath: existing.worktreePath }
    return { ok: true, worktree, workspaceId: existing.id, isolation }
  }

  // With agents on their own OS user the checkout is made from the agent's
  // mirror, so the commit the task starts from is resolved here, in the user's
  // repository, and copied into the mirror first.
  let baseSha = input.baseSha
  if (agent) {
    const ready = await prepareMirror(
      input.repoPath,
      input.baseSha?.trim() || input.baseRef || 'HEAD',
    )
    if (!ready.ok) return { ok: false, reason: 'not_supported', why: ready.why, isolation }
    baseSha = ready.base
  }

  let worktree: Worktree
  try {
    await markOwned(input.repoPath, rootDir, taskId)
    worktree = await provisionWorktree({
      repoPath: checkoutRepo,
      taskId,
      baseSha,
      baseRef: input.baseRef,
      rootDir,
      scaffold: scaffoldFromTask(db, task),
      // The mirror's task branch holds the agent's work, which may be in no
      // other place yet: it is never reset past a commit of its own.
      ...(agent ? { keepBranchCommits: true } : {}),
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
 * (the state dir's included); otherwise under the work folder, and the row is
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
  const agent = agentMode()
  try {
    // With agents on their own OS user only a root in the work folder will do. A
    // checkout recorded anywhere else was made by the server from the user's
    // repository, and is rebuilt in the work folder from the agent's mirror.
    const recorded = rootOfRecordedCheckout(repoPath, taskId, ws.worktreePath)
    const rootDir =
      recorded !== null && (!agent || isInAgentSpace(recorded))
        ? recorded
        : worktreeRootForRepo(repoPath)
    if (agent) {
      // That server-made checkout keeps its branch checked out in the user's
      // repository, and may hold uncommitted work: saved and released first.
      if (!isInAgentSpace(ws.worktreePath)) {
        await releaseServerCheckout(repoPath, taskId, ws.worktreePath)
      }
      const branch = branchNameForTask(taskId)
      // Only a branch that is in neither repository lets the caller start over.
      const inUser = await branchTip(repoPath, branch)
      const inMirror = (await mirrorExists(repoPath))
        ? await branchTip(mirrorPathFor(repoPath), branch)
        : null
      if (inUser === null && inMirror === null) return { ok: false, reason: 'not_found' }
      const ready = await bringBranchIntoMirror(repoPath, branch)
      if (!ready.ok) {
        return { ok: false, reason: 'not_supported', why: ready.why, isolation: 'worktree' }
      }
    }
    await markOwned(repoPath, rootDir, taskId)
    const worktree = await resumeWorktree({ repoPath: checkoutRepoFor(repoPath), taskId, rootDir })
    // The same path when it was rebuilt where recorded; the work folder's when the
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
    // With agents on their own OS user the branch was found above, so this is a
    // failure to rebuild (a host that did not answer, a copy that failed), not a
    // missing branch: a fresh provision would reset the branch.
    if (agent) {
      return {
        ok: false,
        reason: 'rebuild_failed',
        worktreePath: ws.worktreePath,
        why: err instanceof Error ? err.message : String(err),
      }
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
  // The task files are read through the agent host when they are its user's.
  agentMode()
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
  const agent = agentMode()
  const wtPath = ws.worktreePath
  const sorFiles: Record<string, string> = {}
  const sorFilesTruncated: string[] = []
  for (const name of Object.values(SOR_FILES)) {
    // The agent writes these files, so it can also replace one with a link to
    // any file the server can read. Read through the Computer tab's confined
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
  // With agents on their own OS user the baseline comes from the agent's
  // mirror, so the diff is taken only in a checkout of it, in the work folder,
  // where git runs as the agent. One recorded anywhere else is the server's own,
  // made before isolation, and git there would run as the server.
  if (agent && !isInAgentSpace(wtPath)) {
    return { ok: true, workspace: ws, sorFiles, sorFilesTruncated, diffStat: stat, diff }
  }
  try {
    const wt = await loadWorktree({ repoPath: checkoutRepoFor(ws.repoPath), taskId })
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
  agentMode()
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
  /** What the reviewer asks before it spends. */
  reviewGate?: ReviewerGate
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
  const agent = agentMode()
  const checkoutRepo = checkoutRepoFor(ws.repoPath)
  // The checkout the row records, under the state dir or the work folder. Pause
  // and complete refuse it unless it is the task's folder under one of those.
  // With agents on their own OS user only the work folder's roots count: there
  // the checkout is a worktree of the agent's mirror. One anywhere else was made
  // by the server from the user's repository, and the next run rebuilds it.
  const allRoots = worktreeRootsForRepo(ws.repoPath)
  const roots = agent ? allRoots.filter((root) => isInAgentSpace(root)) : allRoots
  const loaded = await loadWorktree({ repoPath: checkoutRepo, taskId, rootDir: roots[0] })
  const worktree: Worktree = { ...loaded, worktreePath: ws.worktreePath }

  if (action === 'pause') {
    const pause = await pauseWorktree(checkoutRepo, worktree, roots)
    updateWorkspaceStatus(db, ws.id, 'active', { lastUsedAt: Date.now() })
    // Committed in the mirror: brought to the user's repository too, so it is
    // never only in agent space.
    if (agent) await exportOrNote(db, taskId, ws.repoPath, worktree)
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

  const complete = await completeWorktree(checkoutRepo, worktree, roots)
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
      const root = path.dirname(path.resolve(ws.worktreePath))
      if (isSharedRoot(ws.repoPath, root)) await dropOwnerMarker(root, taskId).catch(() => {})
      // The branch is gone from the mirror. A copy an earlier pause brought into
      // the user's repository goes too, as the one shared branch would without
      // isolation.
      if (agent) await dropExportedBranch(ws.repoPath, ws.branch)
    }
    return { ok: true, action: 'complete', complete, taskStatus }
  }

  // With agents on their own OS user the work is committed in the agent's
  // checkout and brought into the user's repository before it is checked: the
  // check reads the scaffold commit there, the board's diff and merge use it,
  // and committed work is never only in agent space.
  if (agent) {
    const blocked = await exportOrBlock(db, taskId, ws.repoPath, worktree, { commitFirst: true })
    if (blocked !== null) return { ok: true, action: 'complete', complete, taskStatus: blocked }
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
    ...(agent ? { checkoutRepoPath: checkoutRepo } : {}),
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
    ...(opts.reviewGate ? { reviewGate: opts.reviewGate } : {}),
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
    // A reviewer commits the work it reviews: that commit is brought over too.
    if (agent) await exportOrNote(db, taskId, ws.repoPath, worktree)
    return {
      ok: true,
      action: 'complete',
      complete,
      taskStatus: decided ?? 'unknown',
      verified: verdict.status,
      superseded: true,
    }
  }
  // A reviewer commits the work it reviews: that commit is brought over too,
  // and the task does not land without it.
  if (agent) {
    const blocked = await exportOrBlock(db, taskId, ws.repoPath, worktree)
    if (blocked !== null) {
      return {
        ok: true,
        action: 'complete',
        complete,
        taskStatus: blocked,
        verified: verdict.status,
      }
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
 * state dir and, for checkouts this install made there, the work folder. Tasks that
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
  const me = installId(db)
  const agent = agentMode()
  for (const [repoPath, list] of byRepo) {
    const sharedRoots = worktreeRootsForRepo(repoPath).filter((r) => isSharedRoot(repoPath, r))
    // The state dir is this install's alone. A work folder can be shared by two
    // installs that set the same CLAWBOO_WORK_DIR, so there a folder is swept
    // only when one of this install's rows records that very checkout, or this
    // install's marker sits beside it (a checkout it made that no row records,
    // after a crash); anything else, another install's included, is left alone
    // and not counted. `taskId` is a folder name from disk, so it is matched
    // against the rows, or checked as a task id, before it builds a path.
    const recordedInSharedRoot = (taskId: string): boolean =>
      list.some((w) => {
        if (w.taskId !== taskId || !w.worktreePath) return false
        const recorded = path.resolve(w.worktreePath)
        return sharedRoots.some((root) => worktreePathFor(repoPath, taskId, root) === recorded)
      })
    const ownedUnder =
      (rootDir: string, markers: Map<string, string> | null) =>
      (taskId: string): boolean => {
        if (recordedInSharedRoot(taskId)) return true
        if (markers) return markers.get(taskId) === me
        try {
          return readOwnerMarker(rootDir, taskId) === me
        } catch {
          return false
        }
      }
    for (const rootDir of gcRootsForRepo(repoPath)) {
      const shared = isSharedRoot(repoPath, rootDir)
      // With agents on their own OS user a root in the work folder holds
      // worktrees of the agent's mirror, which only the agent host may look at.
      // A root anywhere else holds checkouts the server made of the user's
      // repository before, and is swept as it always was.
      const ofMirror = agent && isInAgentSpace(rootDir)
      const sweepRepo = ofMirror ? mirrorPathFor(repoPath) : repoPath
      const markers = ofMirror && shared ? await ownerMarkersAsAgent(rootDir) : null
      const r = await gcWorktrees({
        repoPath: sweepRepo,
        rootDir,
        maxAgeMs: opts.maxAgeMs,
        maxCount: opts.maxCount,
        isActive: isTaskActive,
        ...(shared ? { owns: ownedUnder(rootDir, markers) } : {}),
        // Never a prune of the user's repository while agents run as their own
        // OS user: the server cannot see into the agent's folders, so a checkout
        // there would look gone to it.
        ...(agent && !ofMirror ? { prune: false } : {}),
      })
      for (const taskId of r.reaped) {
        if (shared) await dropOwnerMarker(rootDir, taskId).catch(() => {})
        // A folder named for the task can sit under one root while the row
        // records a checkout under another; only a row whose own checkout is
        // gone goes stale.
        const ws = list.find((w) => w.taskId === taskId)
        if (ws?.worktreePath && !(await checkoutOnDisk(ws.worktreePath))) {
          updateWorkspaceStatus(db, ws.id, 'stale')
        }
        // The sweep's autosave committed in the mirror: brought over as a pause
        // brings it, so it is never only in agent space.
        if (ofMirror && ws) {
          await loadWorktree({ repoPath: sweepRepo, taskId })
            .then((wt) => exportOrNote(db, taskId, repoPath, wt))
            .catch(() => undefined)
        }
      }
      summary.reaped.push(...r.reaped)
      summary.skipped.push(...r.skipped)
      summary.failed.push(...r.failed)
    }
  }
  return summary
}
