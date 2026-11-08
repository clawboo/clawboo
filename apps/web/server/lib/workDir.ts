// The work folder (`resolveWorkDir`): where team folders, task worktrees and
// review checkouts live, outside Clawboo's data folder, so no relative path from
// where an agent starts (`../..`) leads to the database or the vault.
//
// New work goes here. Work made by an older version under the data folder is
// moved here once at boot (`workDirMigration.ts`). Readers accept both places,
// and anything the move left where it was (`workDirJournal.ts`), so a version
// that kept everything in the data folder can still be rolled back to.
//
// The work folder is used by its real path (every link resolved): checks that
// compare paths and Claude Code's session keys both compare strings.

import crypto from 'node:crypto'
import {
  accessSync,
  constants as fsConstants,
  closeSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readSync,
  realpathSync,
  writeFileSync,
  type BigIntStats,
} from 'node:fs'
import { open, rename, rm } from 'node:fs/promises'
import path from 'node:path'

import { resolveClawbooDir, resolveWorkDir } from '@clawboo/config'
import { getSetting, setSetting, settings, type ClawbooDb } from '@clawboo/db'
import { assertSafeTaskId } from '@clawboo/worktrees'

/**
 * `dir` through every link in its path when it exists, else `null`. The native
 * call, because only it also expands Windows short names (`RUNNER~1`) and
 * junctions the way `fs.promises.realpath` does, so two real paths compare.
 */
export function realPathOf(dir: string): string | null {
  try {
    return realpathSync.native(dir)
  } catch {
    return null
  }
}

/**
 * `p` resolved, with the real path of its deepest part that exists: a folder
 * that is not there yet still gets the spelling it will have once it is made
 * (`/var/...` under `/private/var/...` on macOS, say).
 */
export function realPathOrSpelling(p: string): string {
  const resolved = path.resolve(p)
  const rest: string[] = []
  let cur = resolved
  for (;;) {
    const real = realPathOf(cur)
    if (real !== null) return rest.length === 0 ? real : path.join(real, ...rest.reverse())
    const parent = path.dirname(cur)
    if (parent === cur) return resolved
    rest.push(path.basename(cur))
    cur = parent
  }
}

/** The work folder by its real path (see {@link realPathOrSpelling}). */
export function workDirInUse(env: NodeJS.ProcessEnv = process.env): string {
  return realPathOrSpelling(resolveWorkDir(env))
}

/** The data folder by its real path. */
export function dataDirInUse(env: NodeJS.ProcessEnv = process.env): string {
  return realPathOrSpelling(resolveClawbooDir(env))
}

/**
 * The work folder by its real path, then as configured when that differs. A
 * checkout recorded under it may use either spelling, so a check against the
 * folder accepts both. The real path comes first because that is the one new
 * records use, so a sweep that takes the first spelling names folders the way
 * their records do.
 */
export function workDirSpellings(env: NodeJS.ProcessEnv = process.env): string[] {
  const dir = path.resolve(resolveWorkDir(env))
  const real = realPathOrSpelling(dir)
  return real === dir ? [dir] : [real, dir]
}

// ── Layout ──────────────────────────────────────────────────────────────────

/**
 * Where NEW work goes: `work`, the work folder (the default), or `data`, the old
 * place under the data folder. `data` is chosen at boot only when the work folder
 * was not set and cannot be created, such as a container whose data folder is a
 * volume under a root-owned `/`; that install keeps working as it did.
 */
export type WorkLayout = 'work' | 'data'

let layout: WorkLayout = 'work'

export function workLayout(): WorkLayout {
  return layout
}

/** Set at boot (see {@link prepareWorkDir}); tests set it directly. */
export function setWorkLayout(next: WorkLayout): void {
  layout = next
}

// ── Boot checks ─────────────────────────────────────────────────────────────

const isInside = (child: string, parent: string): boolean =>
  child.startsWith(parent.endsWith(path.sep) ? parent : parent + path.sep)

/** Windows and macOS file systems ignore case by default, so `Data` and `data`
 *  can be one folder there; the real path cannot settle it for a folder that is
 *  not made yet. Compared without case on those, which at worst refuses a pair
 *  a case-sensitive volume would keep apart. */
const foldCase = (p: string): string =>
  process.platform === 'win32' || process.platform === 'darwin' ? p.toLowerCase() : p

/** The folders under the work folder that hold work. */
const WORK_KINDS = ['teams', 'worktrees', 'reviews'] as const

/**
 * Why the server must not start with this pair of folders, or null when it may.
 * Compared on real paths, so a link cannot hide one folder inside the other:
 * the work folder must not be the data folder, sit inside it or contain it. Any
 * of those puts the database and the vault a relative path away from where
 * agents work, which is what the work folder exists to prevent. For the same
 * reason `teams/`, `worktrees/` and `reviews/` inside it must not be links.
 */
export function workDirRefusal(env: NodeJS.ProcessEnv = process.env): string | null {
  const data = dataDirInUse(env)
  const work = workDirInUse(env)
  const [d, w] = [foldCase(data), foldCase(work)]
  const name = env['CLAWBOO_WORK_DIR']?.trim() ? 'CLAWBOO_WORK_DIR' : 'The work folder'
  if (w === d || isInside(w, d)) {
    return `${name} (${work}) must be outside Clawboo's data folder (${data}). Set CLAWBOO_WORK_DIR to a folder outside it.`
  }
  if (isInside(d, w)) {
    return `Clawboo's data folder (${data}) must be outside the work folder (${work}). Set CLAWBOO_WORK_DIR to a folder that does not contain it.`
  }
  for (const kind of WORK_KINDS) {
    const child = path.join(work, kind)
    try {
      if (lstatSync(child).isSymbolicLink()) {
        return `${child} is a link. Clawboo puts agents' work only in a real folder there: remove the link and start again.`
      }
    } catch {
      // Not there yet: made when first needed.
    }
  }
  return null
}

const README = `This folder holds the work of Clawboo's agents: team folders (teams/),
task checkouts (worktrees/) and review checkouts (reviews/).

Clawboo keeps its own data, such as its database and saved keys, in another
folder. Do not move or rename this folder, or anything in it, while Clawboo
runs. To use another folder, stop Clawboo, set CLAWBOO_WORK_DIR, and start it
again: it moves the work there.
`

export type PrepareWorkDirResult =
  | { ok: true; dir: string }
  /** `explicit`: CLAWBOO_WORK_DIR names it, so the server must not start without it. */
  | { ok: false; dir: string; explicit: boolean; error: string }

/**
 * Create the work folder (owner-only, 0700, parents included) and its README,
 * and choose the layout: `work` when it is there, `data` when it was not set and
 * could not be made. A folder named by CLAWBOO_WORK_DIR that cannot be made is
 * an error for the caller to refuse on.
 */
export function prepareWorkDir(env: NodeJS.ProcessEnv = process.env): PrepareWorkDirResult {
  const explicit = Boolean(env['CLAWBOO_WORK_DIR']?.trim())
  const dir = workDirInUse(env)
  try {
    mkdirSync(dir, { recursive: true, mode: 0o700 })
    if (!lstatSync(dir).isDirectory()) throw new Error(`${dir} is not a folder`)
    // A folder that is there but not writable would fail later, at the first
    // team folder or checkout.
    accessSync(dir, fsConstants.W_OK | fsConstants.X_OK)
  } catch (err) {
    setWorkLayout('data')
    return { ok: false, dir, explicit, error: err instanceof Error ? err.message : String(err) }
  }
  try {
    // Create only: 'wx' fails on anything already at the name, a link included.
    writeFileSync(path.join(dir, 'README.txt'), README, { flag: 'wx', mode: 0o600 })
  } catch {
    // Already there, or not writable: the README is a courtesy.
  }
  setWorkLayout('work')
  return { ok: true, dir: realPathOf(dir) ?? dir }
}

// ── Roots ───────────────────────────────────────────────────────────────────

/** sha1 of a repository path, cut to 12: names a repository's folder of checkouts. */
export function repoHash(repoPath: string): string {
  return crypto.createHash('sha1').update(path.resolve(repoPath)).digest('hex').slice(0, 12)
}

/** Where new task checkouts (`worktrees`) or review checkouts (`reviews`) go:
 *  the work folder's, by its real path, or the data folder's in the old layout. */
export function workRoot(
  kind: 'worktrees' | 'reviews',
  env: NodeJS.ProcessEnv = process.env,
): string {
  return workLayout() === 'work'
    ? path.join(workDirInUse(env), kind)
    : path.resolve(resolveClawbooDir(env), kind)
}

/**
 * Where this install's review checkouts go: a folder of its own under the work
 * folder's `reviews/`, since two installs that share a work folder can review
 * the same commit of the same repository, and a review checkout is named by its
 * commit. The data folder's `reviews/` in the old layout, which no other install
 * uses.
 */
export function reviewsRoot(db: ClawbooDb, env: NodeJS.ProcessEnv = process.env): string {
  const root = workRoot('reviews', env)
  if (workLayout() !== 'work') return root
  return path.join(root, installId(db).replace(/-/g, '').slice(0, 12))
}

// ── Ownership marker ────────────────────────────────────────────────────────
//
// A work folder can be shared by two installs that set the same
// CLAWBOO_WORK_DIR, so cleanup there removes only checkouts this install made.
// Each checkout this install puts in the work folder gets a marker beside it,
// `.<task id>.owner` holding this install's id. A file, not a folder, so an older
// version's cleanup, which collects only folders, never touches one.

const INSTALL_ID_KEY = 'install-id'

const isInstallId = (v: string | null): v is string => v !== null && /^[0-9a-f-]{36}$/.test(v)

/** This install's id, made on first use and kept in its database. Made with an
 *  insert that keeps a row already there, so two processes that start at once
 *  both use the one that was written first. */
export function installId(db: ClawbooDb): string {
  const known = getSetting(db, INSTALL_ID_KEY)
  if (isInstallId(known)) return known
  if (known === null) {
    db.insert(settings)
      .values({ key: INSTALL_ID_KEY, value: crypto.randomUUID(), updatedAt: Date.now() })
      .onConflictDoNothing()
      .run()
    const kept = getSetting(db, INSTALL_ID_KEY)
    if (isInstallId(kept)) return kept
  }
  // Damaged: replaced.
  const id = crypto.randomUUID()
  setSetting(db, INSTALL_ID_KEY, id)
  return id
}

/** `<root>/.<taskId>.owner`, pinned under `root` with a single startsWith test. */
export function ownerMarkerPath(root: string, taskId: string): string {
  const base = path.resolve(root)
  const prefix = base.endsWith(path.sep) ? base : base + path.sep
  const marker = path.resolve(base, `.${assertSafeTaskId(taskId)}.owner`)
  if (!marker.startsWith(prefix)) {
    throw new Error(`owner marker escapes ${base}: ${marker}`)
  }
  return marker
}

/**
 * Record that this install made the checkout `<root>/<taskId>`. Written to a new
 * file and renamed into place, so a link an agent put at the name is replaced,
 * never written through.
 */
export async function writeOwnerMarker(root: string, taskId: string, id: string): Promise<void> {
  const target = ownerMarkerPath(root, taskId)
  const temp = `${target}.${crypto.randomBytes(6).toString('hex')}.tmp`
  const handle = await open(
    temp,
    fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | (fsConstants.O_NOFOLLOW ?? 0),
    0o600,
  )
  try {
    await handle.writeFile(id, 'utf8')
  } finally {
    await handle.close()
  }
  try {
    await rename(temp, target)
  } catch (err) {
    await rm(temp, { force: true })
    throw err
  }
}

/** The install id the marker beside `<root>/<taskId>` holds, or null (none, a
 *  link, or not a small plain file). */
export function readOwnerMarker(root: string, taskId: string): string | null {
  const marker = ownerMarkerPath(root, taskId)
  let fd: number
  let named: BigIntStats
  try {
    // Windows has no O_NOFOLLOW: the name is checked first, and the file opened
    // must be the one checked.
    named = lstatSync(marker, { bigint: true })
    if (!named.isFile()) return null
    fd = openSync(
      marker,
      fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0) | (fsConstants.O_NONBLOCK ?? 0),
    )
  } catch {
    return null
  }
  try {
    const st = fstatSync(fd, { bigint: true })
    if (st.dev !== named.dev || st.ino !== named.ino) return null
    if (!st.isFile() || st.size > 64n) return null
    const size = Number(st.size)
    const buf = Buffer.alloc(size)
    const n = readSync(fd, buf, 0, size, 0)
    return buf.subarray(0, n).toString('utf8').trim() || null
  } catch {
    return null
  } finally {
    closeSync(fd)
  }
}

export async function removeOwnerMarker(root: string, taskId: string): Promise<void> {
  await rm(ownerMarkerPath(root, taskId), { force: true })
}
