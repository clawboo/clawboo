// The work folder move. Once at boot, before anything can run in them, team
// folders and task checkouts that older versions made under the data folder (or
// that sit in a previous CLAWBOO_WORK_DIR) move into the work folder.
//
// Renames only, so each item takes milliseconds and nothing is ever copied. An
// item on another volume (`EXDEV`), a checkout git does not list, or one with a
// run still going in it is LEFT where it is and keeps working there: readers
// accept every place the journal names (`workDirJournal.ts`). The next boot
// tries again.
//
// Safe to kill at any step, for this version and the one before it, which reads
// both layouts. Every journal write comes before the step it describes, a link
// at the old path is in place before a record names the new one, and nothing is
// ever deleted that holds a file:
// - a team folder: a link to the new path is made under a temporary name, the
//   folder is renamed, and the link is renamed onto the old path;
// - a task checkout: uncommitted work is saved on the task's branch first (the
//   commit a pause makes), the folder moves with `git worktree move` (or a
//   rename and `git worktree repair`), the link is put at the old path, git must
//   list the checkout at its new path, and only then do the board's records
//   (`workspaces.worktree_path`, `tasks.worktree_ref`) and the journal change,
//   in one transaction. A checkout git does not list at the new path is moved
//   back.
// A boot that finds an item `moving` looks at where the folder is and where git
// lists it, and finishes or undoes it.

import { randomUUID } from 'node:crypto'
import { existsSync, lstatSync, readdirSync, statSync, type Stats } from 'node:fs'
import { mkdir, readlink, rename, rm, rmdir, symlink } from 'node:fs/promises'
import path from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'

import { resolveClawbooDir } from '@clawboo/config'
import {
  agents,
  getSetting,
  immediateWrite,
  listExecutions,
  setSetting,
  settings,
  tasks,
  teams,
  workspaces,
  type ClawbooDb,
} from '@clawboo/db'
import { createLogger } from '@clawboo/logger'
import {
  branchNameForTask,
  commitWorktreeWork,
  execGit,
  isCheckoutAt,
  isDetached,
  isGitRepo,
  readHandoff,
  relocateWorktree,
  worktreePathFor,
  worktreeRegistration,
  writeHandoff,
} from '@clawboo/worktrees'
import { and, eq } from 'drizzle-orm'

import { isWindows } from './platform'
import { sanitizeAgentId } from './runtimes/identityHome'
import { NO_TEAM_SEGMENT } from './runtimes/teamWorkdir'
import {
  installId,
  realPathOf,
  realPathOrSpelling,
  repoHash,
  workDirInUse,
  workDirSpellings,
  workLayout,
  writeOwnerMarker,
} from './workDir'
import {
  WORK_DIR_JOURNAL_KEY,
  loadWorkDirJournal,
  workDirJournal,
  serializeWorkDirJournal,
  setWorkDirJournal,
  type TeamFolderItem,
  type WorkDirItem,
  type WorkDirItemState,
  type WorkDirJournal,
  type WorktreeItem,
} from './workDirJournal'

const log = createLogger('work-dir-move')

/** The work folder the last boot used, so a changed CLAWBOO_WORK_DIR reads as a move. */
export const WORK_DIR_IN_USE_KEY = 'work-dir'
const LOCK_KEY = 'work-dir-migration-lock'
/** A lock not refreshed for this long was left by a server that died mid-move.
 *  The mover refreshes it with every journal write. */
const LOCK_STALE_MS = 5 * 60_000

// ── Progress, for /api/health ───────────────────────────────────────────────

export interface WorkDirMoveProgress {
  total: number
  done: number
}

let progress: WorkDirMoveProgress | null = null

/** The move's progress while it runs, else null. */
export function workDirMoveProgress(): WorkDirMoveProgress | null {
  return progress ? { ...progress } : null
}

/**
 * Say the move is running before it starts, so a server that listens first
 * (to answer /api/health meanwhile) serves nothing else until it ends.
 * {@link runWorkDirMove} clears it when it returns, whatever happened.
 */
export function holdForWorkDirMove(): void {
  progress ??= { total: 0, done: 0 }
}

/** End a hold that no move will end, such as one whose early listen failed. */
export function releaseWorkDirMoveHold(): void {
  progress = null
}

// ── Test seam ───────────────────────────────────────────────────────────────

/** The steps of one item, in order. A test that throws from `afterStep` stops the
 *  move there, as a kill would: nothing after it runs, the journal included. */
export type WorkDirMoveStep =
  'saved' | 'marked' | 'moving' | 'linkReady' | 'renamed' | 'linked' | 'checked' | 'recorded'

/** Thrown through the move when a test's `afterStep` stops it. */
export class WorkDirMoveInterrupted extends Error {
  constructor(readonly step: WorkDirMoveStep) {
    super(`work folder move stopped after ${step}`)
    this.name = 'WorkDirMoveInterrupted'
  }
}

/** Another process took the lock over: this one must not write the journal or
 *  touch another folder. */
class WorkDirLockLost extends Error {
  constructor() {
    super('another process took over the work folder move')
    this.name = 'WorkDirLockLost'
  }
}

/** Errors that end the whole move, not just one item. */
const endsTheMove = (err: unknown): boolean =>
  err instanceof WorkDirMoveInterrupted || err instanceof WorkDirLockLost

export interface WorkDirMoveOptions {
  env?: NodeJS.ProcessEnv
  afterStep?: (item: WorkDirItem, step: WorkDirMoveStep) => void
  /** Whether a folder at `a` can be renamed into the folder `b` (same volume). */
  sameVolume?: (a: string, b: string) => boolean
  /** How long to wait for another process's move to end (default: twice the
   *  lock's stale time), and how often to look. */
  lockWaitMs?: number
  lockPollMs?: number
}

export interface WorkDirMoveReport {
  ran: boolean
  moved: number
  left: number
  conflicts: number
  /** Claude Code session pointers cleared because their folder moved. */
  sessionsCleared: number
}

// ── Small file helpers ──────────────────────────────────────────────────────

function lstatOrNull(p: string): Stats | null {
  try {
    return lstatSync(p)
  } catch {
    return null
  }
}

const isRealDir = (st: Stats | null): boolean =>
  st !== null && st.isDirectory() && !st.isSymbolicLink()

function isEmptyDir(p: string): boolean {
  try {
    return readdirSync(p).length === 0
  } catch {
    return false
  }
}

/** Folders directly in `dir` (not links, not dot-names). */
function realFolderNames(dir: string): string[] {
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isDirectory() && !e.name.startsWith('.'))
      .map((e) => e.name)
  } catch {
    return []
  }
}

function defaultSameVolume(a: string, b: string): boolean {
  try {
    return statSync(a).dev === statSync(b).dev
  } catch {
    return false
  }
}

const tempLinkFor = (oldPath: string, name: string): string =>
  path.join(path.dirname(oldPath), `.${name}.link`)

/** Remove `p` when it is a link (the move's own temporary one); anything else
 *  at the name, a file someone put there, is left alone. */
async function removeLinkAt(p: string): Promise<void> {
  if (lstatOrNull(p)?.isSymbolicLink()) await rm(p, { force: true })
}

/** A link at `linkPath` to the folder `target` (a junction on Windows, which
 *  needs no admin rights). Replaces a link already there, never a folder. */
async function makeLink(linkPath: string, target: string): Promise<void> {
  const st = lstatOrNull(linkPath)
  if (st) {
    if (!st.isSymbolicLink()) throw new Error(`${linkPath} is in the way of a link`)
    await rm(linkPath, { force: true })
  }
  await symlink(target, linkPath, isWindows ? 'junction' : 'dir')
}

/** True when `linkPath` is a link that leads to `target`. */
async function linksTo(linkPath: string, target: string): Promise<boolean> {
  const st = lstatOrNull(linkPath)
  if (!st?.isSymbolicLink()) return false
  try {
    const dest = path.resolve(path.dirname(linkPath), await readlink(linkPath))
    if (dest === path.resolve(target)) return true
    // Two spellings of one folder: only when both are there to compare.
    const real = realPathOf(linkPath)
    return real !== null && real === realPathOf(target)
  } catch {
    return false
  }
}

/** Put a link to `target` at `oldPath`, which must be free or a link: made under
 *  a temporary name and renamed into place, so a reader never sees a gap. */
async function linkAtOldPath(oldPath: string, name: string, target: string): Promise<void> {
  const temp = tempLinkFor(oldPath, name)
  await makeLink(temp, target)
  await rename(temp, oldPath)
}

/**
 * {@link linkAtOldPath} once the files are at `target`, when no link to it is
 * there yet. A failure is a note, not a reason to keep the item at the old
 * place: this version looks at the new path, and the link only serves older
 * versions and tools that saved the old one. Keeping it would send runs to an
 * old path that is now empty.
 */
async function tryLinkAtOldPath(
  oldPath: string,
  name: string,
  target: string,
): Promise<string | undefined> {
  try {
    if (!(await linksTo(oldPath, target))) await linkAtOldPath(oldPath, name, target)
    return undefined
  } catch (err) {
    await removeLinkAt(tempLinkFor(oldPath, name)).catch(() => undefined)
    log.warn(
      { err, from: oldPath, to: target },
      'Work folder: moved, but no link could be put at the old path',
    )
    return `moved, but no link could be put at ${oldPath}: ${String(err)}`
  }
}

/** True when `p` is the link an earlier move left there to `target`: the work
 *  folder changed back, and the folder is going home. */
async function isLinkBackTo(p: string, target: string): Promise<boolean> {
  return Boolean(lstatOrNull(p)?.isSymbolicLink()) && (await linksTo(p, target))
}

// ── Planning ────────────────────────────────────────────────────────────────

/** The work folder the last boot recorded, when it is not this one. */
function recordedWorkDir(db: ClawbooDb, work: string): string | null {
  const prev = getSetting(db, WORK_DIR_IN_USE_KEY)
  if (!prev || path.resolve(prev) === work || realPathOrSpelling(prev) === work) return null
  return prev
}

/** {@link recordedWorkDir} when it can be read now. */
function previousWorkDir(db: ClawbooDb, work: string): string | null {
  const prev = recordedWorkDir(db, work)
  return prev && existsSync(prev) ? prev : null
}

/**
 * What this boot should move: every real team folder under `<data>/workspaces`,
 * this install's team folders under a previous work folder, and every task
 * checkout a row records outside the work folder (by its path's shape,
 * `<root>/worktrees/<repo hash>/<task id>`). A row whose checkout is gone moves
 * on paper only (resume rebuilds it at the new place), except an archived one.
 */
export function planWorkDirMove(
  db: ClawbooDb,
  env: NodeJS.ProcessEnv = process.env,
): WorkDirItem[] {
  const work = workDirInUse(env)
  const data = path.resolve(resolveClawbooDir(env))
  const items: WorkDirItem[] = []
  const teamsTo = path.join(work, 'teams')

  for (const name of realFolderNames(path.join(data, 'workspaces'))) {
    items.push({
      kind: 'team',
      name,
      from: path.join(data, 'workspaces', name),
      to: path.join(teamsTo, name),
      state: 'planned',
    })
  }
  const prev = previousWorkDir(db, work)
  if (prev) {
    // A previous work folder can be shared with another install: only this
    // install's teams move out of it.
    const mine = new Set([
      NO_TEAM_SEGMENT,
      ...db
        .select({ id: teams.id })
        .from(teams)
        .all()
        .map((t) => sanitizeAgentId(t.id)),
    ])
    for (const name of realFolderNames(path.join(prev, 'teams'))) {
      if (!mine.has(name)) continue
      items.push({
        kind: 'team',
        name,
        from: path.join(prev, 'teams', name),
        to: path.join(teamsTo, name),
        state: 'planned',
      })
    }
  }

  // A team folder an earlier boot kept at its old place (another volume, a
  // conflict) is tried again from there: it may sit in a work folder that is
  // no longer the previous one, which the scans above would not look in.
  const planned = new Set(items.map((i) => i.from))
  for (const kept of workDirJournal().items) {
    if (kept.kind !== 'team' || (kept.state !== 'left' && kept.state !== 'conflict')) continue
    if (planned.has(kept.from) || !isRealDir(lstatOrNull(kept.from))) continue
    planned.add(kept.from)
    items.push({ ...kept, to: path.join(teamsTo, kept.name), state: 'planned', note: undefined })
  }

  const here = new Set(workDirSpellings(env).map((p) => path.resolve(p)))
  for (const ws of db.select().from(workspaces).all()) {
    if (!ws.worktreePath || !ws.repoPath) continue
    const recorded = path.resolve(ws.worktreePath)
    const hashDir = path.dirname(recorded)
    const kindDir = path.dirname(hashDir)
    const hash = repoHash(ws.repoPath)
    if (path.basename(recorded) !== ws.taskId || path.basename(hashDir) !== hash) continue
    if (path.basename(kindDir) !== 'worktrees') continue
    const base = path.dirname(kindDir)
    if (here.has(base) || realPathOrSpelling(base) === work) continue
    if (ws.status === 'archived' && !lstatOrNull(recorded)) continue
    let to: string
    try {
      to = worktreePathFor(ws.repoPath, ws.taskId, path.join(work, 'worktrees', hash))
    } catch {
      continue
    }
    items.push({
      kind: 'worktree',
      taskId: ws.taskId,
      workspaceId: ws.id,
      repoPath: ws.repoPath,
      from: recorded,
      to,
      state: 'planned',
    })
  }
  return items
}

/**
 * True when this boot has something to move, so the server should answer
 * `/api/health` with `migrating` while it does. Cheap: a folder listing and one
 * query. Always false in the old layout, which moves nothing.
 */
export function workDirMovePending(db: ClawbooDb, env: NodeJS.ProcessEnv = process.env): boolean {
  if (workLayout() !== 'work') return false
  const journal = loadWorkDirJournal(db)
  if (journal.items.some((i) => i.state === 'moving')) return true
  return planWorkDirMove(db, env).length > 0
}

// ── The lock ────────────────────────────────────────────────────────────────

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM'
  }
}

const lockValue = (token: string): string =>
  JSON.stringify({ pid: process.pid, at: Date.now(), token })

/** True when the lock `raw` is held by another process that is alive and has
 *  refreshed it lately. */
function heldByAnother(raw: string, now: number): boolean {
  try {
    const held = JSON.parse(raw) as { pid?: number; at?: number }
    return (
      typeof held?.pid === 'number' &&
      held.pid !== process.pid &&
      pidAlive(held.pid) &&
      typeof held.at === 'number' &&
      now - held.at < LOCK_STALE_MS
    )
  } catch {
    return false // unreadable: taken over
  }
}

/**
 * One process moves at a time: a settings row claimed with insert-or-ignore. A
 * claim held by a process that is gone, or not refreshed for
 * {@link LOCK_STALE_MS}, is taken over, and only the very claim that was read:
 * of two processes that both found it stale, one takes it. Returns the value
 * this process wrote, or null.
 */
function claimLock(db: ClawbooDb, token: string): string | null {
  for (let attempt = 0; attempt < 2; attempt++) {
    const mine = lockValue(token)
    const inserted =
      db
        .insert(settings)
        .values({ key: LOCK_KEY, value: mine, updatedAt: Date.now() })
        .onConflictDoNothing()
        .run().changes > 0
    if (inserted) return mine
    const raw = getSetting(db, LOCK_KEY)
    if (raw === null) continue // released in between: claim it again
    if (heldByAnother(raw, Date.now())) return null
    const taken =
      db
        .update(settings)
        .set({ value: mine, updatedAt: Date.now() })
        .where(and(eq(settings.key, LOCK_KEY), eq(settings.value, raw)))
        .run().changes > 0
    return taken ? mine : null
  }
  return null
}

/** Claim the lock, waiting while another live process holds it (its move may
 *  be moving the very folders this one would hand to runs). Null when it is
 *  still held after the wait. */
async function acquireLock(
  db: ClawbooDb,
  opts: WorkDirMoveOptions,
): Promise<{ lock: string; token: string } | null> {
  const token = randomUUID()
  const until = Date.now() + (opts.lockWaitMs ?? 2 * LOCK_STALE_MS)
  let told = false
  for (;;) {
    const lock = claimLock(db, token)
    if (lock) return { lock, token }
    if (Date.now() >= until) return null
    if (!told) {
      log.warn('Work folder: another Clawboo process is moving folders; waiting for it to finish')
      told = true
    }
    holdForWorkDirMove()
    await sleep(opts.lockPollMs ?? 500)
  }
}

/** Remove the lock when it is still this process's. */
function releaseLock(ctx: MoveContext): void {
  ctx.db
    .delete(settings)
    .where(and(eq(settings.key, LOCK_KEY), eq(settings.value, ctx.lock)))
    .run()
}

// ── The move ────────────────────────────────────────────────────────────────

interface MoveContext {
  db: ClawbooDb
  journal: WorkDirJournal
  installId: string
  opts: WorkDirMoveOptions
  sameVolume: (a: string, b: string) => boolean
  /** The lock as this process last wrote it, and the token that stays in it. */
  lock: string
  token: string
  sessionsCleared: number
}

/**
 * A database write of the move, in one transaction that first checks this
 * process still holds the lock (else {@link WorkDirLockLost}) and then
 * refreshes it, so a process that lost the lock never writes the journal over
 * the new holder's, and a live mover's lock never goes stale.
 */
function underLock(ctx: MoveContext, write: () => void): void {
  const next = lockValue(ctx.token)
  immediateWrite(ctx.db, () => {
    if (getSetting(ctx.db, LOCK_KEY) !== ctx.lock) throw new WorkDirLockLost()
    write()
    setSetting(ctx.db, LOCK_KEY, next)
  })
  ctx.lock = next
}

const writeJournal = (ctx: MoveContext): void =>
  setSetting(ctx.db, WORK_DIR_JOURNAL_KEY, serializeWorkDirJournal(ctx.journal))

function save(ctx: MoveContext): void {
  underLock(ctx, () => writeJournal(ctx))
  setWorkDirJournal(ctx.journal)
}

function step(ctx: MoveContext, item: WorkDirItem, name: WorkDirMoveStep): void {
  if (!ctx.opts.afterStep) return
  try {
    ctx.opts.afterStep(item, name)
  } catch {
    throw new WorkDirMoveInterrupted(name)
  }
}

function setState(
  ctx: MoveContext,
  item: WorkDirItem,
  state: WorkDirItemState,
  note?: string,
): void {
  item.state = state
  if (note === undefined) delete item.note
  else item.note = note
  if (item.kind === 'team' && state === 'moved') {
    // Claude Code files sessions by folder: its pointers go in the same write
    // that says the folder moved, so no crash can keep one that cannot resume.
    underLock(ctx, () => {
      writeJournal(ctx)
      ctx.sessionsCleared += clearClaudeCodeSessions(ctx.db)
    })
    setWorkDirJournal(ctx.journal)
  } else {
    save(ctx)
  }
  if (state === 'left' || state === 'conflict') {
    log.warn(
      { kind: item.kind, from: item.from, to: item.to, state, note },
      'Work folder: kept at its old place',
    )
  } else if (state === 'moved') {
    log.info({ kind: item.kind, from: item.from, to: item.to }, 'Work folder: moved')
  }
}

function drop(ctx: MoveContext, item: WorkDirItem): void {
  ctx.journal.items = ctx.journal.items.filter((i) => i !== item)
  save(ctx)
}

// Team folders.

async function moveTeam(ctx: MoveContext, item: TeamFolderItem): Promise<void> {
  const { from, to, name } = item
  if (!isRealDir(lstatOrNull(from))) return drop(ctx, item)
  if (await isLinkBackTo(to, from)) await rm(to, { force: true })
  const target = lstatOrNull(to)
  if (target) {
    if (isRealDir(target) && isEmptyDir(to)) {
      await rmdir(to)
    } else if (isEmptyDir(from) && isRealDir(target)) {
      // The old place was made again, empty, by a version that found no link
      // there; the files are at the new one.
      await rmdir(from)
      return setState(ctx, item, 'moved', await tryLinkAtOldPath(from, name, to))
    } else {
      return setState(
        ctx,
        item,
        'conflict',
        `${to} already holds files; the team keeps using ${from}`,
      )
    }
  }
  await mkdir(path.dirname(to), { recursive: true, mode: 0o700 })
  if (!ctx.sameVolume(from, path.dirname(to))) {
    return setState(ctx, item, 'left', `${to} is on another volume; renames only at boot`)
  }
  const temp = tempLinkFor(from, name)
  setState(ctx, item, 'moving')
  step(ctx, item, 'moving')
  await makeLink(temp, to)
  step(ctx, item, 'linkReady')
  try {
    await rename(from, to)
  } catch (err) {
    await removeLinkAt(temp)
    const code = (err as NodeJS.ErrnoException).code
    return setState(
      ctx,
      item,
      'left',
      code === 'EXDEV' ? `${to} is on another volume` : String(err),
    )
  }
  step(ctx, item, 'renamed')
  await rename(temp, from)
  step(ctx, item, 'linked')
  setState(ctx, item, 'moved')
}

/** A team folder a crash left `moving`: finish it when the files are at the new
 *  path, else undo the half-made link and keep it where it is (the path code
 *  reads a kept item, so the team never gets a new empty folder meanwhile);
 *  the planner starts it again. */
async function recoverTeam(ctx: MoveContext, item: TeamFolderItem): Promise<void> {
  const { from, to, name } = item
  if (!isRealDir(lstatOrNull(to))) {
    await removeLinkAt(tempLinkFor(from, name))
    if (isRealDir(lstatOrNull(from))) return setState(ctx, item, 'left', 'the move did not finish')
    return drop(ctx, item)
  }
  const src = lstatOrNull(from)
  if (!src || src.isSymbolicLink()) {
    const note = await tryLinkAtOldPath(from, name, to)
    await removeLinkAt(tempLinkFor(from, name)).catch(() => undefined)
    return setState(ctx, item, 'moved', note)
  }
  if (isRealDir(src) && isEmptyDir(from)) {
    // An older version found no link in the gap and made the folder again.
    await rmdir(from)
    return setState(ctx, item, 'moved', await tryLinkAtOldPath(from, name, to))
  }
  await removeLinkAt(tempLinkFor(from, name))
  setState(ctx, item, 'conflict', `${from} and ${to} both hold files; the team keeps using ${from}`)
}

// Task checkouts.

/** The board's records name the new path, and the journal says moved: one
 *  transaction, so a crash leaves both or neither. */
function record(ctx: MoveContext, item: WorktreeItem, note?: string): void {
  item.state = 'moved'
  if (note === undefined) delete item.note
  else item.note = note
  const { db } = ctx
  underLock(ctx, () => {
    const ws = db.select().from(workspaces).where(eq(workspaces.id, item.workspaceId)).get()
    if (ws?.worktreePath && path.resolve(ws.worktreePath) === item.from) {
      db.update(workspaces)
        .set({ worktreePath: item.to })
        .where(eq(workspaces.id, item.workspaceId))
        .run()
    }
    // Not the task's updatedAt: that is its run's heartbeat.
    const task = db
      .select({ ref: tasks.worktreeRef })
      .from(tasks)
      .where(eq(tasks.id, item.taskId))
      .get()
    if (task?.ref && path.resolve(task.ref) === item.from) {
      db.update(tasks).set({ worktreeRef: item.to }).where(eq(tasks.id, item.taskId)).run()
    }
    writeJournal(ctx)
  })
  setWorkDirJournal(ctx.journal)
  log.info({ taskId: item.taskId, from: item.from, to: item.to, note }, 'Work folder: moved')
}

/** Drop the checkout's Claude Code session, then record the move. In that
 *  order, so no crash between the two can keep a session that cannot resume. */
async function finish(ctx: MoveContext, item: WorktreeItem, note?: string): Promise<void> {
  await clearHandoffSession(item.to)
  record(ctx, item, note)
}

/** A Claude Code session is filed under the folder it ran in, so one started in
 *  the old place cannot be resumed from the new one: drop the moved checkout's
 *  pointer, and the next run starts fresh from the handoff. Best-effort. */
async function clearHandoffSession(dir: string): Promise<boolean> {
  try {
    const handoff = await readHandoff(dir)
    if (!handoff || handoff.runtime !== 'claude-code' || !handoff.nativeSessionId) return false
    await writeHandoff(dir, { ...handoff, nativeSessionId: null })
    return true
  } catch {
    return false
  }
}

const runIsGoing = (db: ClawbooDb, taskId: string): boolean =>
  listExecutions(db, taskId).at(-1)?.status === 'running'

async function moveWorktree(ctx: MoveContext, item: WorktreeItem): Promise<void> {
  const { repoPath, from, to, taskId } = item
  const root = path.dirname(to)
  const src = lstatOrNull(from)
  if (!src) {
    // No checkout on disk (paused, or cleaned up): only the record moves, and a
    // resume rebuilds the checkout at the new place. Not when git still lists
    // one there: that folder is out of reach (a drive that is not mounted, say),
    // not gone, and a rebuild elsewhere would leave its uncommitted work behind.
    const registration = await worktreeRegistration(repoPath, from)
    if (registration !== 'unregistered') {
      return setState(
        ctx,
        item,
        'left',
        registration === 'unknown'
          ? 'its folder is missing and git could not say whether it still has it'
          : 'its folder is missing but git still lists it there',
      )
    }
    if (await isLinkBackTo(to, from)) await rm(to, { force: true })
    if (lstatOrNull(to)) return setState(ctx, item, 'conflict', `${to} already exists`)
    await mkdir(root, { recursive: true, mode: 0o700 })
    await writeOwnerMarker(root, taskId, ctx.installId)
    return record(ctx, item)
  }
  if (src.isSymbolicLink()) {
    // An earlier pass moved it and left this link; only the record is behind.
    if ((await linksTo(from, to)) && (await isCheckoutAt(repoPath, to))) return finish(ctx, item)
    return setState(ctx, item, 'left', `${from} is a link to somewhere else`)
  }
  if (!src.isDirectory()) return setState(ctx, item, 'left', `${from} is not a folder`)
  if (runIsGoing(ctx.db, taskId)) {
    return setState(ctx, item, 'left', 'a run of the task was still going in it')
  }
  if (!(await isGitRepo(repoPath))) {
    return setState(ctx, item, 'left', `the repository ${repoPath} is not there`)
  }
  const registration = await worktreeRegistration(repoPath, from)
  if (registration === 'registered' && !(await isCheckoutAt(repoPath, from))) {
    // git still lists the path, but the folder there is not this repository's
    // checkout (another repository's, say): nothing is saved or moved in it.
    return setState(ctx, item, 'left', `${from} is not a checkout of ${repoPath}`)
  }
  if (registration !== 'registered') {
    // Moved under the new root, a folder git does not list would be one cleanup
    // there may remove; where it is, it is left alone.
    return setState(
      ctx,
      item,
      'left',
      registration === 'unknown'
        ? 'git could not list the repository worktrees'
        : 'git does not list it as a worktree',
    )
  }
  if (await isLinkBackTo(to, from)) await rm(to, { force: true })
  if (lstatOrNull(to)) return setState(ctx, item, 'conflict', `${to} already exists`)
  await mkdir(root, { recursive: true, mode: 0o700 })
  if (!ctx.sameVolume(from, root)) {
    return setState(ctx, item, 'left', `${to} is on another volume; renames only at boot`)
  }
  // Everything on the task's branch first, so a version that rebuilds the
  // checkout from the branch after a kill below loses nothing.
  if (!(await isDetached(from))) {
    await commitWorktreeWork(
      repoPath,
      {
        taskId,
        worktreePath: from,
        branch: branchNameForTask(taskId),
        baseCommit: '',
        detached: false,
      },
      `clawboo: save work before moving task ${taskId}`,
    )
  }
  step(ctx, item, 'saved')
  await writeOwnerMarker(root, taskId, ctx.installId)
  step(ctx, item, 'marked')
  setState(ctx, item, 'moving')
  step(ctx, item, 'moving')
  const temp = tempLinkFor(from, taskId)
  await makeLink(temp, to)
  step(ctx, item, 'linkReady')
  const moved = await relocateWorktree(repoPath, from, to)
  if (!moved.ok) {
    await removeLinkAt(temp)
    return setState(
      ctx,
      item,
      'left',
      moved.code === 'EXDEV' ? `${to} is on another volume` : moved.reason,
    )
  }
  step(ctx, item, 'renamed')
  await rename(temp, from)
  step(ctx, item, 'linked')
  if (!(await isCheckoutAt(repoPath, to))) return moveBack(ctx, item)
  step(ctx, item, 'checked')
  await finish(ctx, item)
  step(ctx, item, 'recorded')
}

/** Git does not list the checkout at its new path: put it back where the record
 *  says, with git's links fixed there, and keep it there. */
async function moveBack(ctx: MoveContext, item: WorktreeItem): Promise<void> {
  const { repoPath, from, to, taskId } = item
  if (lstatOrNull(from)?.isSymbolicLink()) await rm(from, { force: true })
  await removeLinkAt(tempLinkFor(from, taskId))
  if (!lstatOrNull(from)) {
    const back = await relocateWorktree(repoPath, to, from)
    if (back.ok && (await isCheckoutAt(repoPath, from))) {
      return setState(
        ctx,
        item,
        'left',
        'git did not list it at the new path, so it was moved back',
      )
    }
  }
  setState(
    ctx,
    item,
    'conflict',
    `git does not list ${to} and it could not be moved back to ${from}; nothing was removed`,
  )
}

/** A checkout a crash left `moving`: finish it when git lists it at the new
 *  path, put it back when it is there and git does not, else undo the half-made
 *  link and let the planner start it again. */
async function recoverWorktree(ctx: MoveContext, item: WorktreeItem): Promise<void> {
  const { repoPath, from, to, taskId } = item
  const target = lstatOrNull(to)
  if (!isRealDir(target)) {
    await removeLinkAt(tempLinkFor(from, taskId))
    if (isRealDir(lstatOrNull(from))) return setState(ctx, item, 'left', 'the move did not finish')
    return drop(ctx, item)
  }
  let listed = await isCheckoutAt(repoPath, to)
  if (!listed && !lstatOrNull(from)) {
    // Renamed, but git's links were not fixed yet.
    await execGit(repoPath, ['worktree', 'repair', to]).catch(() => undefined)
    listed = await isCheckoutAt(repoPath, to)
  }
  if (!listed) return moveBack(ctx, item)
  const src = lstatOrNull(from)
  let note: string | undefined
  if (!src || src.isSymbolicLink()) {
    note = await tryLinkAtOldPath(from, taskId, to)
  } else if (isRealDir(src) && isEmptyDir(from)) {
    await rmdir(from)
    note = await tryLinkAtOldPath(from, taskId, to)
  } else {
    // Something else was made at the old path. The checkout git lists is the
    // task's, so the records follow it; the other folder is left as it is.
    note = `${from} holds files too; it was left as it is, with no link`
    log.warn({ taskId, from, to }, 'Work folder: moved; another folder at the old path was kept')
  }
  await removeLinkAt(tempLinkFor(from, taskId)).catch(() => undefined)
  await finish(ctx, item, note)
}

// ── Claude Code session pointers ────────────────────────────────────────────

/**
 * Claude Code files a session under the folder it ran in, so a team folder that
 * moved takes its agents' sessions out of reach: drop every Claude Code agent's
 * saved session ids (1:1 chat, team chat and task pointers, and the id in each
 * leader's room state) so the next turn starts fresh from the brief and the
 * chat history instead of failing on a resume. Other runtimes keep theirs.
 */
export function clearClaudeCodeSessions(db: ClawbooDb): number {
  const ids = db
    .select({ id: agents.id })
    .from(agents)
    .where(eq(agents.runtime, 'claude-code'))
    .all()
    .map((a) => a.id)
  if (ids.length === 0) return 0
  let cleared = 0
  const rows = db.select({ key: settings.key, value: settings.value }).from(settings).all()
  for (const id of ids) {
    for (const row of rows) {
      const k = row.key
      if (k === `native-chat-session:${id}` || k.startsWith(`native-team-session:${id}:`)) {
        db.delete(settings).where(eq(settings.key, k)).run()
        cleared++
      } else if (k.startsWith('team-chat-leader-state:') && k.endsWith(`:${id}`)) {
        try {
          const state = JSON.parse(row.value) as { nativeSessionId?: string | null }
          if (state && typeof state.nativeSessionId === 'string') {
            setSetting(db, k, JSON.stringify({ ...state, nativeSessionId: null }))
            cleared++
          }
        } catch {
          /* unreadable: the loader treats it as empty already */
        }
      }
    }
  }
  return cleared
}

// ── Entry point ─────────────────────────────────────────────────────────────

/**
 * Run the move: finish or undo what a crash left in flight, then move what
 * {@link planWorkDirMove} finds. Never throws for a single item: one that fails
 * is left where it is. Moves nothing in the old layout, or while another
 * process holds the lock.
 */
export async function runWorkDirMove(
  db: ClawbooDb,
  opts: WorkDirMoveOptions = {},
): Promise<WorkDirMoveReport> {
  try {
    return await moveAll(db, opts)
  } finally {
    progress = null
  }
}

async function moveAll(db: ClawbooDb, opts: WorkDirMoveOptions): Promise<WorkDirMoveReport> {
  const env = opts.env ?? process.env
  const report: WorkDirMoveReport = {
    ran: false,
    moved: 0,
    left: 0,
    conflicts: 0,
    sessionsCleared: 0,
  }
  loadWorkDirJournal(db)
  if (workLayout() !== 'work') return report
  // A process that loses the lock mid-move waits for the new holder and starts
  // over from what that one wrote, a few times at most.
  for (let attempt = 0; attempt < 3; attempt++) {
    const held = await acquireLock(db, opts)
    if (!held) {
      log.warn(
        'Work folder: another Clawboo process is still moving folders; this one moves nothing',
      )
      loadWorkDirJournal(db)
      return report
    }
    const ctx: MoveContext = {
      db,
      journal: loadWorkDirJournal(db),
      installId: installId(db),
      opts,
      sameVolume: opts.sameVolume ?? defaultSameVolume,
      lock: held.lock,
      token: held.token,
      sessionsCleared: 0,
    }
    report.ran = true
    holdForWorkDirMove()
    try {
      await movePass(ctx, env, report)
      return report
    } catch (err) {
      if (!(err instanceof WorkDirLockLost)) throw err
      log.warn('Work folder: another Clawboo process took over the move; waiting for it')
    } finally {
      report.sessionsCleared += ctx.sessionsCleared
      releaseLock(ctx)
    }
  }
  loadWorkDirJournal(db)
  return report
}

async function movePass(
  ctx: MoveContext,
  env: NodeJS.ProcessEnv,
  report: WorkDirMoveReport,
): Promise<void> {
  const { db, journal } = ctx
  const work = workDirInUse(env)
  for (const item of journal.items.filter((i) => i.state === 'moving')) {
    try {
      if (item.kind === 'team') await recoverTeam(ctx, item)
      else await recoverWorktree(ctx, item)
    } catch (err) {
      if (endsTheMove(err)) throw err
      log.error(
        { err, from: item.from, to: item.to },
        'Work folder: could not finish a move a crash left; trying again next boot',
      )
    }
  }
  // Everything not finished is planned again from what is on disk now; what
  // moved stays as the record, unless the same folder is back to move again.
  // An item still `moving` (its recovery failed) is not started a second time.
  const inFlight = new Set(
    ctx.journal.items.filter((i) => i.state === 'moving').map((i) => `${i.kind}:${i.from}`),
  )
  const planned = planWorkDirMove(db, env).filter((i) => !inFlight.has(`${i.kind}:${i.from}`))
  const again = new Set(planned.map((i) => `${i.kind}:${i.from}`))
  ctx.journal.items = [
    ...ctx.journal.items.filter(
      (i) => i.state === 'moving' || (i.state === 'moved' && !again.has(`${i.kind}:${i.from}`)),
    ),
    ...planned,
  ]
  save(ctx)
  const counts = { total: planned.length, done: 0 }
  progress = counts
  for (const item of planned) {
    try {
      if (item.kind === 'team') await moveTeam(ctx, item)
      else await moveWorktree(ctx, item)
    } catch (err) {
      if (endsTheMove(err)) throw err
      log.error({ err, from: item.from, to: item.to }, 'Work folder: moving failed')
      try {
        if (item.state === 'moving') {
          if (item.kind === 'team') await recoverTeam(ctx, item)
          else await recoverWorktree(ctx, item)
        } else if (item.state === 'planned') {
          setState(ctx, item, 'left', String(err))
        }
      } catch (again) {
        if (endsTheMove(again)) throw again
        log.error(
          { err: again, from: item.from },
          'Work folder: left mid-move; the next boot finishes it',
        )
      }
    }
    counts.done++
  }
  for (const item of planned) {
    if (item.state === 'moved') report.moved++
    else if (item.state === 'conflict') report.conflicts++
    else if (item.state === 'left') report.left++
  }
  // A previous work folder that cannot be read now (a drive that is not
  // mounted) stays on record, so a later boot still moves its team folders.
  const unread = recordedWorkDir(db, work)
  if (unread && !existsSync(unread)) {
    log.warn(
      { previous: unread, work },
      'Work folder: the previous work folder is not there; it stays on record, and its ' +
        'team folders move once it is back',
    )
  } else {
    underLock(ctx, () => setSetting(db, WORK_DIR_IN_USE_KEY, work))
  }
}
