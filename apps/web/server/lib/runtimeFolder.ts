// The runtimes folder: where Clawboo installs the agent runtimes it manages
// (OpenClaw, the Claude Agent SDK, Codex, Hermes) instead of npm's or pip's
// global locations, which fail on a root-owned prefix, strand an install when
// nvm switches Node, and hand the user `sudo` as the fix.
//
// Layout, under `runtimeInstallRoot()` (`resolveRuntimesDir` in @clawboo/config):
//
//   bin/<name>                     launchers (`<name>.cmd` on Windows), one per
//                                  command a runtime offers, written by Clawboo
//   <id>/                          one folder per runtime (`runtimeInstallDir`)
//   <id>/<install>/                one install of it; an update installs beside
//                                  the current one and switches only on success
//   <id>/clawboo-runtime.json      the pointer: which install is current, its
//                                  version, and what each launcher runs
//
// A launcher runs a recorded command with recorded arguments, such as the Node
// that installed OpenClaw with OpenClaw's own entry script, so a runtime keeps
// running on the interpreter it was installed with whatever PATH says later.
//
// Agents must be able to run what is here and must not be able to change it or
// read Clawboo's data folder. So the folder sits outside the data folder and the
// work folder, is owned by the server's user, and is closed to writes from
// anyone else. Nothing here is run when that does not hold
// (`runtimesDirRefusal`): the lookups fall back to a runtime on PATH instead.
//
// This module is a leaf (node built-ins and @clawboo/config only), because
// `platform.ts`, which nearly every runtime path imports, consults it.

import { randomBytes } from 'node:crypto'
import {
  accessSync,
  chmodSync,
  closeSync,
  constants as fsConstants,
  fchmodSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
  type Stats,
} from 'node:fs'
import { rm } from 'node:fs/promises'
import path from 'node:path'

import { resolveClawbooDir, resolveRuntimesDir, resolveWorkDir } from '@clawboo/config'

export const RUNTIMES_DIR_ENV = 'CLAWBOO_RUNTIMES_DIR'

/** The pointer file in each runtime's folder. */
export const INSTALL_RECORD_FILE = 'clawboo-runtime.json'

const isWindows = process.platform === 'win32'

/** A runtime id is one plain path segment. */
const RUNTIME_ID_RE = /^[a-z0-9][a-z0-9-]{0,39}$/
/** A launcher name is a command name: a plain segment, no extension. */
const LAUNCHER_NAME_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/
/** An install folder's label: a plain segment that never starts with a dot. */
const INSTALL_LABEL_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/

const README = `This folder holds the agent runtimes Clawboo installed, such as OpenClaw,
the Claude Agent SDK and Codex, each in a folder of its own. bin/ holds the
commands that start them.

Clawboo manages everything here: installing again from Clawboo replaces it.
Do not edit it by hand. To use another folder, stop Clawboo, set
CLAWBOO_RUNTIMES_DIR, start it again, and install the runtimes from Clawboo.
`

// ── Paths ───────────────────────────────────────────────────────────────────

/** `dir` through every link in its path, or null when it does not exist. */
function realPathOf(dir: string): string | null {
  try {
    return realpathSync.native(dir)
  } catch {
    return null
  }
}

/** `p` resolved, with the real path of its deepest part that exists, so a folder
 *  not made yet compares the way it will once it is. */
function realPathOrSpelling(p: string): string {
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

/** The runtimes folder by its real path. No side effects. */
export function runtimeInstallRoot(env: NodeJS.ProcessEnv = process.env): string {
  return realPathOrSpelling(resolveRuntimesDir(env))
}

function assertRuntimeId(id: string): void {
  if (!RUNTIME_ID_RE.test(id)) throw new Error(`not a runtime id: ${JSON.stringify(id)}`)
}

/** `<root>/<id>`, the folder that holds every install of one runtime. No side
 *  effects. Throws on an id that is not one plain path segment. */
export function runtimeInstallDir(id: string, env: NodeJS.ProcessEnv = process.env): string {
  assertRuntimeId(id)
  return path.join(runtimeInstallRoot(env), id)
}

/** Where the launchers are. */
export function runtimeBinDir(env: NodeJS.ProcessEnv = process.env): string {
  return path.join(runtimeInstallRoot(env), 'bin')
}

/** The launcher's file name for a command name on this platform. */
export function launcherFileName(name: string): string {
  return isWindows ? `${name}.cmd` : name
}

// ── Safety ──────────────────────────────────────────────────────────────────

const isInside = (child: string, parent: string): boolean =>
  child.startsWith(parent.endsWith(path.sep) ? parent : parent + path.sep)

/** Windows and macOS file systems ignore case by default. */
const foldCase = (p: string): string =>
  process.platform === 'win32' || process.platform === 'darwin' ? p.toLowerCase() : p

/**
 * Whether a file or folder may be trusted to run from: owned by this user (or
 * root) and writable by nobody else. Group and other write bits would let
 * another account, an agent's included, change what the server runs. Windows
 * has no such bits to read, so it is not checked there.
 */
function ownedAndClosed(st: Stats): boolean {
  if (isWindows) return true
  const uid = typeof process.getuid === 'function' ? process.getuid() : null
  if (uid !== null && st.uid !== uid && st.uid !== 0) return false
  return (st.mode & 0o022) === 0
}

/** More folders the runtimes folder must stay apart from, registered at boot. */
const extraApartFrom: { label: string; dir: () => string | null }[] = []

/**
 * Keep the runtimes folder apart from one more folder: it may not be, contain
 * or sit inside it, checked like the data and work folders. For a folder that
 * someone other than the server's user can write, such as the home of the OS
 * user agents run as. `dir` is read at each check; null skips it. Returns a
 * function that removes the rule.
 */
export function keepRuntimesDirApartFrom(label: string, dir: () => string | null): () => void {
  const entry = { label, dir }
  extraApartFrom.push(entry)
  return () => {
    const i = extraApartFrom.indexOf(entry)
    if (i !== -1) extraApartFrom.splice(i, 1)
  }
}

/**
 * Why nothing may be installed into or run from the runtimes folder, or null
 * when it is fine. Compared on real paths, so a link cannot hide one folder
 * inside another:
 * - it must not be, contain or sit inside Clawboo's data folder (the database
 *   and the vault), the work folder (which agents write), or a folder added
 *   with `keepRuntimesDirApartFrom` (such as the agent user's home);
 * - when it exists, it and its `bin/` must be real folders owned by this user
 *   and writable by nobody else.
 */
export function runtimesDirRefusal(env: NodeJS.ProcessEnv = process.env): string | null {
  const root = runtimeInstallRoot(env)
  const name = env[RUNTIMES_DIR_ENV]?.trim() ? RUNTIMES_DIR_ENV : "Clawboo's runtimes folder"
  const fix = `Set ${RUNTIMES_DIR_ENV} to a folder of its own and restart Clawboo.`
  const r = foldCase(root)
  const apart: [string, string][] = [
    ["Clawboo's data folder", realPathOrSpelling(resolveClawbooDir(env))],
    ['the work folder', realPathOrSpelling(resolveWorkDir(env))],
  ]
  for (const extra of extraApartFrom) {
    let dir: string | null = null
    try {
      dir = extra.dir()
    } catch {
      dir = null
    }
    if (dir) apart.push([extra.label, realPathOrSpelling(dir)])
  }
  for (const [label, dir] of apart) {
    const d = foldCase(dir)
    if (r === d || isInside(r, d) || isInside(d, r)) {
      return `${name} (${root}) must be apart from ${label} (${dir}). ${fix}`
    }
  }
  for (const dir of [root, path.join(root, 'bin')]) {
    let st: Stats
    try {
      st = lstatSync(dir)
    } catch {
      continue // not there yet: made on the first install
    }
    // The root itself was resolved through its links above; bin/ must be real.
    if (dir !== root && st.isSymbolicLink()) {
      return `${dir} is a link. Clawboo runs launchers only from a real folder: remove it and install again.`
    }
    if (!st.isDirectory()) {
      return `${dir} is not a folder. Move it away and install again.`
    }
    if (!ownedAndClosed(st)) {
      return `${dir} belongs to another user or others can write to it, so Clawboo will not run anything from it. Make it yours and run chmod go-w on it, or ${fix.charAt(0).toLowerCase()}${fix.slice(1)}`
    }
  }
  return ancestorRefusal(root, fix)
}

/**
 * Why a folder above the runtimes folder makes it unsafe, or null. A folder
 * anyone may write without the sticky bit lets another account rename the
 * runtimes folder away and put its own in place. And Node looks for a missing
 * module in the `node_modules` of every folder above the one asking, so a
 * `node_modules` someone else made in a shared folder such as `/tmp` could
 * stand in for a package an install lacks (an optional platform binary, say).
 * Not checked on Windows, which has no such bits to read.
 */
function ancestorRefusal(root: string, fix: string): string | null {
  if (isWindows) return null
  for (let dir = path.dirname(root); ; dir = path.dirname(dir)) {
    let st: Stats
    try {
      st = statSync(dir)
    } catch {
      return null // above a folder that is not there yet
    }
    const sticky = (st.mode & 0o1000) !== 0
    if ((st.mode & 0o002) !== 0 && !sticky) {
      return `${dir} lets anyone rename what is in it, so Clawboo will not run anything from ${root}. ${fix}`
    }
    if ((st.mode & 0o022) !== 0) {
      try {
        const nm = lstatSync(path.join(dir, 'node_modules'))
        if (nm.isSymbolicLink() || !ownedAndClosed(nm)) {
          return `${path.join(dir, 'node_modules')} belongs to another user or others can write to it, and Node.js could load modules from it, so Clawboo will not run anything from ${root}. ${fix}`
        }
      } catch {
        // No node_modules there.
      }
    }
    if (path.dirname(dir) === dir) return null
  }
}

/** Make a folder 0755 whatever the umask (agents run what is here, so others
 *  read and enter it; nobody else writes it) or, when it is already there and
 *  ours, take away group and other write. Throws when it cannot be made or is
 *  not a folder. */
function ensureFolder(dir: string): void {
  const created = mkdirSync(dir, { recursive: true, mode: 0o755 })
  const st = lstatSync(dir)
  if (!st.isDirectory()) throw new Error(`${dir} is not a folder`)
  if (isWindows) return
  const want = created !== undefined ? 0o755 : st.mode & 0o7755
  if ((st.mode & 0o7777) !== want) {
    try {
      chmodSync(dir, want)
    } catch {
      // Not ours: runtimesDirRefusal reports it.
    }
  }
}

/** The umask an installer runs under: what it writes is readable by others and
 *  writable by nobody else from the start, so no other account can change an
 *  install while it is being made. */
export const INSTALL_UMASK = 0o022

/**
 * Run `fn` (typically a `spawn` of an installer, which inherits the umask at
 * that moment) under {@link INSTALL_UMASK}, then put this process's umask back.
 */
export function withInstallUmask<T>(fn: () => T): T {
  if (isWindows) return fn()
  const previous = process.umask(INSTALL_UMASK)
  try {
    return fn()
  } finally {
    process.umask(previous)
  }
}

/** Change a mode through a descriptor opened without following a link, after
 *  checking it is still the entry that was looked at. */
function chmodNoFollow(p: string, st: Stats, mode: number): void {
  const fd = openSync(p, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW)
  try {
    const now = fstatSync(fd)
    if (now.dev !== st.dev || now.ino !== st.ino) throw new Error(`${p} changed while sealing`)
    fchmodSync(fd, mode)
  } finally {
    closeSync(fd)
  }
}

/**
 * Make an install folder what the runtimes folder promises before it becomes
 * current: every entry owned by this user, readable by others (and enterable,
 * or runnable where its owner may run it), and writable by nobody else, whatever
 * umask the installer ran under, and without setuid, setgid or sticky bits. A
 * folder is closed before its entries are read,
 * and modes change through descriptors that never follow a link. Links are kept
 * but must be this user's and point inside the install. Throws on an entry that
 * belongs to someone else, or a link that leads out, which no install of ours
 * makes.
 */
export function sealInstallFolder(folder: string): void {
  if (isWindows) return
  const uid = typeof process.getuid === 'function' ? process.getuid() : null
  const top = realPathOf(folder)
  if (!top) throw new Error(`${folder} is not there`)
  const stack = [top]
  while (stack.length > 0) {
    const cur = stack.pop() as string
    const st = lstatSync(cur)
    if (uid !== null && st.uid !== uid) {
      throw new Error(`${cur} belongs to another user, so this install cannot be used`)
    }
    if (st.isSymbolicLink()) {
      const target = realPathOrSpelling(path.resolve(path.dirname(cur), readlinkSync(cur)))
      if (target !== top && !isInside(target, top)) {
        throw new Error(`${cur} links outside the install (${target}), so it cannot be used`)
      }
      continue
    }
    const perm = st.mode & 0o7777
    if (st.isDirectory()) {
      const want = (perm & 0o700) | 0o055
      if (perm !== want) chmodNoFollow(cur, st, want)
      for (const name of readdirSync(cur)) stack.push(path.join(cur, name))
    } else if (st.isFile()) {
      const want = (perm & 0o700) | 0o044 | (perm & 0o100 ? 0o011 : 0)
      if (perm !== want) chmodNoFollow(cur, st, want)
    } else {
      throw new Error(`${cur} is not a file or a folder, so this install cannot be used`)
    }
  }
}

/** Create the runtimes folder, its README and `bin/`, after the safety checks.
 *  Returns the root, or throws with the reason. */
export function prepareRuntimesDir(env: NodeJS.ProcessEnv = process.env): string {
  const before = runtimesDirRefusal(env)
  if (before) throw new Error(before)
  const root = runtimeInstallRoot(env)
  ensureFolder(root)
  ensureFolder(path.join(root, 'bin'))
  try {
    writeFileSync(path.join(root, 'README.txt'), README, { flag: 'wx', mode: 0o644 })
  } catch {
    // Already there: the README is a courtesy.
  }
  // Checked again: a folder that was there before may still belong to someone else.
  const after = runtimesDirRefusal(env)
  if (after) throw new Error(after)
  return root
}

// ── Installs ────────────────────────────────────────────────────────────────

/** What a launcher runs: an absolute command and its leading arguments. */
export interface RuntimeLauncher {
  command: string
  args: string[]
}

/** The pointer file's contents. */
export interface RuntimeInstallRecord {
  schema: 1
  id: string
  /** The installed version, as the runtime's own package states it. */
  version: string | null
  /** What was installed: an npm spec, a release URL. */
  source: string
  /** The current install's folder name under `runtimeInstallDir(id)`. */
  folder: string
  installedAt: string
  /** The interpreter the runtime was installed with and runs on, if any. */
  interpreter?: { path: string; version: string }
  launchers: Record<string, RuntimeLauncher>
}

function stamp(now: Date): string {
  const p = (n: number) => String(n).padStart(2, '0')
  return (
    `${now.getUTCFullYear()}${p(now.getUTCMonth() + 1)}${p(now.getUTCDate())}-` +
    `${p(now.getUTCHours())}${p(now.getUTCMinutes())}${p(now.getUTCSeconds())}`
  )
}

/**
 * A fresh, empty folder for one install of `id`: `<root>/<id>/<label>`, with a
 * suffix when that name is taken. Creates the runtimes folder first (after its
 * safety checks). The label defaults to the time, such as `20261111-083000`.
 */
export function newInstallFolder(
  id: string,
  label?: string,
  env: NodeJS.ProcessEnv = process.env,
): string {
  assertRuntimeId(id)
  const base = label ?? stamp(new Date())
  if (!INSTALL_LABEL_RE.test(base) || base === INSTALL_RECORD_FILE) {
    throw new Error(`not an install label: ${JSON.stringify(base)}`)
  }
  prepareRuntimesDir(env)
  const runtimeDir = runtimeInstallDir(id, env)
  ensureFolder(runtimeDir)
  for (let n = 1; n <= 100; n++) {
    const dir = path.join(runtimeDir, n === 1 ? base : `${base}-${n}`)
    try {
      mkdirSync(dir, { mode: 0o755 })
      return dir
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err
    }
  }
  throw new Error(`no free install folder for ${id} under ${runtimeDir}`)
}

/** Remove a failed install's folder. Best effort, never throws. */
export async function discardInstallFolder(folder: string): Promise<void> {
  await rm(folder, { recursive: true, force: true, maxRetries: 3 }).catch(() => {})
}

function isRecord(v: unknown): v is RuntimeInstallRecord {
  if (!v || typeof v !== 'object') return false
  const r = v as Record<string, unknown>
  if (r['schema'] !== 1 || typeof r['id'] !== 'string' || typeof r['folder'] !== 'string') {
    return false
  }
  const launchers = r['launchers']
  if (!launchers || typeof launchers !== 'object') return false
  return Object.values(launchers as Record<string, unknown>).every((l) => {
    const x = l as Partial<RuntimeLauncher> | null
    return (
      typeof x?.command === 'string' &&
      Array.isArray(x.args) &&
      x.args.every((a) => typeof a === 'string')
    )
  })
}

/** The current install of `id`, or null when there is none (or the record is
 *  unreadable). */
export function readRuntimeInstall(
  id: string,
  env: NodeJS.ProcessEnv = process.env,
): RuntimeInstallRecord | null {
  let file: string
  try {
    file = path.join(runtimeInstallDir(id, env), INSTALL_RECORD_FILE)
  } catch {
    return null
  }
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as unknown
    return isRecord(parsed) && parsed.id === id ? parsed : null
  } catch {
    return null
  }
}

/** POSIX single-quoted. */
const shQuote = (s: string): string => `'${s.replace(/'/g, `'\\''`)}'`

/** The launcher script for this platform. */
export function launcherScript(
  launcher: RuntimeLauncher,
  note: string,
  platform: NodeJS.Platform = process.platform,
): string {
  // The note may carry a version read from a package: only plain characters
  // reach a comment line, so it can never become a second command.
  const safeNote = note.replace(/[^A-Za-z0-9 ._+-]/g, '')
  if (platform === 'win32') {
    // cmd.exe expands %VAR% even inside quotes; a literal percent is %%.
    const q = (s: string) => `"${s.replace(/%/g, '%%')}"`
    return [
      '@echo off',
      `rem ${safeNote}`,
      `${[launcher.command, ...launcher.args].map(q).join(' ')} %*`,
      '',
    ].join('\r\n')
  }
  return [
    '#!/bin/sh',
    `# ${safeNote}`,
    `exec ${[launcher.command, ...launcher.args].map(shQuote).join(' ')} "$@"`,
    '',
  ].join('\n')
}

/** Write a file by renaming a sibling over it, so a reader never sees half. */
function writeAtomic(file: string, data: string, mode: number): void {
  const tmp = path.join(
    path.dirname(file),
    `.${path.basename(file)}.${randomBytes(6).toString('hex')}.tmp`,
  )
  writeFileSync(tmp, data, { mode, flag: 'wx' })
  try {
    if (!isWindows) chmodSync(tmp, mode) // writeFileSync's mode passes through the umask
    renameSync(tmp, file)
  } catch (err) {
    try {
      unlinkSync(tmp)
    } catch {
      /* best effort */
    }
    throw err
  }
}

function validateLaunchers(launchers: Record<string, RuntimeLauncher>): void {
  for (const [name, l] of Object.entries(launchers)) {
    if (!LAUNCHER_NAME_RE.test(name))
      throw new Error(`not a launcher name: ${JSON.stringify(name)}`)
    if (!path.isAbsolute(l.command)) throw new Error(`launcher ${name}: command must be absolute`)
    if (isWindows && [l.command, ...l.args].some((a) => /["\r\n]/.test(a))) {
      throw new Error(`launcher ${name}: a path holds a character a .cmd file cannot quote`)
    }
  }
}

export interface CommitRuntimeInstall {
  /** The install folder, as `newInstallFolder` returned it. */
  folder: string
  version: string | null
  source: string
  interpreter?: { path: string; version: string }
  launchers: Record<string, RuntimeLauncher>
}

/**
 * Make `install.folder` the current install of `id`: seal it
 * (`sealInstallFolder`), write its launchers into `bin/` (and remove the ones
 * the previous install had and this one does not), then the pointer file.
 * Install folders other than this one, the previous one and any a live process
 * was marked as running (`markInstallInUse`) are removed afterwards, in the
 * background (`pruned`). Nothing switches unless everything was written.
 * Synchronous: sealing walks the
 * install once, which is fine for something a person starts by hand.
 */
export function commitRuntimeInstall(
  id: string,
  install: CommitRuntimeInstall,
  env: NodeJS.ProcessEnv = process.env,
): { record: RuntimeInstallRecord; pruned: Promise<void> } {
  const runtimeDir = runtimeInstallDir(id, env)
  const folderReal = realPathOf(install.folder)
  const runtimeReal = realPathOf(runtimeDir)
  if (!folderReal || !runtimeReal || path.dirname(folderReal) !== runtimeReal) {
    throw new Error(`${install.folder} is not an install folder of ${id}`)
  }
  validateLaunchers(install.launchers)
  const refusal = runtimesDirRefusal(env)
  if (refusal) throw new Error(refusal)
  ensureFolder(runtimeReal)
  sealInstallFolder(folderReal)

  const previous = readRuntimeInstall(id, env)
  const record: RuntimeInstallRecord = {
    schema: 1,
    id,
    version: install.version,
    source: install.source,
    folder: path.basename(folderReal),
    installedAt: new Date().toISOString(),
    ...(install.interpreter ? { interpreter: install.interpreter } : {}),
    launchers: install.launchers,
  }

  // Everything is written aside first; the pointer's rename is the switch. A
  // failure before it leaves the current install exactly as it was, and one
  // after it (a launcher rename) puts the previous pointer back.
  const binDir = runtimeBinDir(env)
  ensureFolder(binDir)
  const note = `Written by Clawboo for ${id} ${install.version ?? ''}. Installing again replaces it.`
  const staged: { tmp: string; file: string }[] = []
  const recordFile = path.join(runtimeDir, INSTALL_RECORD_FILE)
  let recordTmp: string | null = null
  try {
    for (const [name, launcher] of Object.entries(install.launchers)) {
      const file = path.join(binDir, launcherFileName(name))
      staged.push({ tmp: writeAside(file, launcherScript(launcher, note), 0o755), file })
    }
    recordTmp = writeAside(recordFile, JSON.stringify(record, null, 2) + '\n', 0o644)
  } catch (err) {
    for (const t of [...staged.map((x) => x.tmp), recordTmp]) if (t) unlinkQuietly(t)
    throw err
  }
  const previousText = readTextOrNull(recordFile)
  const previousLaunchers = staged.map(({ file }) => readTextOrNull(file))
  renameSync(recordTmp, recordFile)
  let placed = 0
  try {
    for (const { tmp, file } of staged) {
      renameSync(tmp, file)
      placed++
    }
  } catch (err) {
    // Put back what was there: the pointer and every launcher already replaced.
    for (const [i, { tmp, file }] of staged.entries()) {
      if (i >= placed) {
        unlinkQuietly(tmp)
        continue
      }
      const text = previousLaunchers[i]
      if (text === null || text === undefined) unlinkQuietly(file)
      else writeAtomic(file, text, 0o755)
    }
    if (previousText === null) unlinkQuietly(recordFile)
    else writeAtomic(recordFile, previousText, 0o644)
    throw err
  }
  for (const name of Object.keys(previous?.launchers ?? {})) {
    if (name in install.launchers || !LAUNCHER_NAME_RE.test(name)) continue
    unlinkQuietly(path.join(binDir, launcherFileName(name)))
  }

  const keep = new Set([
    record.folder,
    ...(previous ? [previous.folder] : []),
    ...foldersInUse(runtimeDir),
  ])
  return { record, pruned: pruneInstallFolders(runtimeDir, keep) }
}

function unlinkQuietly(file: string): void {
  try {
    unlinkSync(file)
  } catch {
    /* already gone */
  }
}

function readTextOrNull(file: string): string | null {
  try {
    return readFileSync(file, 'utf8')
  } catch {
    return null
  }
}

/** Write a sibling of `file` that a later rename puts in place; returns it. */
function writeAside(file: string, data: string, mode: number): string {
  const tmp = path.join(
    path.dirname(file),
    `.${path.basename(file)}.${randomBytes(6).toString('hex')}.tmp`,
  )
  writeFileSync(tmp, data, { mode, flag: 'wx' })
  if (!isWindows) chmodSync(tmp, mode)
  return tmp
}

// ── In use ──────────────────────────────────────────────────────────────────

const IN_USE_PREFIX = '.in-use-'

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM'
  }
}

/**
 * Record that process `pid` runs an install of `id`, so pruning keeps that
 * install while the process lives, however many updates come in between. For
 * long-lived processes such as a Gateway; best effort. `folder` is the install
 * folder the process was started from (`OwnedRuntimeLaunch.record.folder`, read
 * when its command was): an update committed in between leaves the current
 * install, the default, naming a folder the process does not run.
 */
export function markInstallInUse(
  id: string,
  pid: number,
  env: NodeJS.ProcessEnv = process.env,
  folder?: string,
): void {
  if (!Number.isInteger(pid) || pid <= 0) return
  const name = folder ?? readRuntimeInstall(id, env)?.folder
  if (!name || !INSTALL_LABEL_RE.test(name)) return
  try {
    writeAtomic(path.join(runtimeInstallDir(id, env), `${IN_USE_PREFIX}${pid}`), name, 0o644)
  } catch {
    // Not recorded: pruning then keeps only the current and previous installs.
  }
}

/** The install folders live processes were marked as running; dead marks go. */
function foldersInUse(runtimeDir: string): string[] {
  const folders: string[] = []
  let entries: string[]
  try {
    entries = readdirSync(runtimeDir)
  } catch {
    return folders
  }
  for (const entry of entries) {
    if (!entry.startsWith(IN_USE_PREFIX)) continue
    const file = path.join(runtimeDir, entry)
    const pid = Number(entry.slice(IN_USE_PREFIX.length))
    if (!Number.isInteger(pid) || pid <= 0 || !pidAlive(pid)) {
      unlinkQuietly(file)
      continue
    }
    const folder = readTextOrNull(file)?.trim()
    if (folder && INSTALL_LABEL_RE.test(folder)) folders.push(folder)
  }
  return folders
}

/** Remove the install folders of one runtime that are not in `keep`. Hidden
 *  entries and files are left alone. Best effort. */
async function pruneInstallFolders(runtimeDir: string, keep: Set<string>): Promise<void> {
  let entries: string[]
  try {
    entries = readdirSync(runtimeDir)
  } catch {
    return
  }
  for (const entry of entries) {
    if (keep.has(entry) || entry.startsWith('.') || !INSTALL_LABEL_RE.test(entry)) continue
    const dir = path.join(runtimeDir, entry)
    try {
      const st = lstatSync(dir)
      if (!st.isDirectory() || st.isSymbolicLink()) continue
    } catch {
      continue
    }
    await rm(dir, { recursive: true, force: true, maxRetries: 3 }).catch(() => {})
  }
}

// ── Lookups ─────────────────────────────────────────────────────────────────

function isExecutableFile(file: string): boolean {
  try {
    if (!statSync(file).isFile()) return false
    accessSync(file, fsConstants.X_OK)
    return true
  } catch {
    return false
  }
}

export interface OwnedRuntimeLaunch {
  /** The launcher to start: `<root>/bin/<name>` (`.cmd` on Windows). */
  launcher: string
  /** What the launcher runs. */
  command: string
  args: string[]
  /** The runtime that owns it, and its record. */
  id: string
  record: RuntimeInstallRecord
}

/**
 * The launcher for `name` in the runtimes folder, with what it runs, when it is
 * there and safe to start: the folder passes `runtimesDirRefusal`, the launcher
 * is a real file owned by this user that nobody else can write, and the command
 * it runs (and a script it hands that command) still exist. A launcher whose
 * interpreter has gone, such as a Node removed by nvm, is not offered, so the
 * caller falls back to PATH and an install replaces it.
 */
export function ownedRuntimeLaunch(
  name: string,
  env: NodeJS.ProcessEnv = process.env,
): OwnedRuntimeLaunch | null {
  const found = inspectRuntimeLaunch(name, env)
  return found && 'launch' in found ? found.launch : null
}

/**
 * Why Clawboo's own `name` cannot be used although an install of it is on
 * record, such as the Node.js it was installed with having been removed, or
 * null when it can be used or there is none. For telling a person why a
 * runtime reads as not installed.
 */
export function ownedRuntimeProblem(
  name: string,
  env: NodeJS.ProcessEnv = process.env,
): string | null {
  const found = inspectRuntimeLaunch(name, env)
  return found && 'problem' in found ? found.problem : null
}

function inspectRuntimeLaunch(
  name: string,
  env: NodeJS.ProcessEnv,
): { launch: OwnedRuntimeLaunch } | { problem: string } | null {
  if (!LAUNCHER_NAME_RE.test(name)) return null
  const root = runtimeInstallRoot(env)
  let ids: string[]
  try {
    ids = readdirSync(root)
  } catch {
    return null // no runtimes folder yet
  }
  for (const id of ids) {
    if (!RUNTIME_ID_RE.test(id) || id === 'bin') continue
    const record = readRuntimeInstall(id, env)
    const spec = record?.launchers[name]
    if (!record || !spec) continue
    const again = `Install ${name} again from Clawboo.`
    const refusal = runtimesDirRefusal(env)
    if (refusal) return { problem: refusal }
    const launcher = path.join(root, 'bin', launcherFileName(name))
    const runtimeDir = path.join(root, id)
    const opened =
      !isTrustedEntry(launcher, 'file') ||
      !isTrustedEntry(runtimeDir, 'dir') ||
      !isTrustedEntry(path.join(runtimeDir, INSTALL_RECORD_FILE), 'file') ||
      !isTrustedEntry(path.join(runtimeDir, record.folder), 'dir')
    if (opened) {
      return {
        problem: `Clawboo's copy of ${name} is missing a file, or another user can change it. ${again}`,
      }
    }
    if (!isTrustedRunTarget(spec.command, root, true)) {
      return {
        problem: `Clawboo's copy of ${name} runs on ${spec.command}, which is gone or can be changed by another user (an upgrade may have removed that Node.js). ${again}`,
      }
    }
    const script = spec.args[0]
    if (script && path.isAbsolute(script) && !isTrustedRunTarget(script, root, false)) {
      return {
        problem: `Clawboo's copy of ${name} is missing ${script}, or another user can change it. ${again}`,
      }
    }
    return { launch: { launcher, command: spec.command, args: spec.args, id, record } }
  }
  return null
}

/** A real file or folder (not a link) owned by this user and closed to others. */
function isTrustedEntry(p: string, kind: 'file' | 'dir'): boolean {
  try {
    const st = lstatSync(p)
    if (kind === 'file' ? !st.isFile() : !st.isDirectory()) return false
    return ownedAndClosed(st)
  } catch {
    return false
  }
}

/**
 * Whether a launcher's command, or the script it hands that command, may be run.
 * Inside the runtimes folder it must pass `ownedAndClosed`, and so must every
 * folder between it and the root (resolved through links, so a link cannot lead
 * out to a file someone else controls). Outside it, such as the Node that
 * installed a runtime, see {@link isTrustedOutsideTarget}.
 */
function isTrustedRunTarget(p: string, root: string, executable: boolean): boolean {
  let real: string
  try {
    real = realpathSync.native(p)
    const st = statSync(real)
    if (!st.isFile()) return false
    if (executable && !isExecutableFile(real)) return false
    if (isWindows) return true
    if (!isInside(real, root)) return isTrustedOutsideTarget(st)
    if (!ownedAndClosed(st)) return false
  } catch {
    return false
  }
  for (let dir = path.dirname(real); isInside(dir, root); dir = path.dirname(dir)) {
    try {
      if (!ownedAndClosed(statSync(dir))) return false
    } catch {
      return false
    }
  }
  return true
}

/**
 * A command outside the runtimes folder, such as the Node that installed a
 * runtime. The Node this server runs on is trusted whatever its modes: whoever
 * can change that file changes the server itself the next time it starts, so
 * refusing it here would guard nothing, and would stop every runtime on a
 * machine whose Node others can write (a CI runner image that opens up its tool
 * cache, say). Any other command must be writable by its owner only, and owned
 * by this user, root, or whoever owns the Node this server runs on (who could
 * change the server itself just as well).
 */
function isTrustedOutsideTarget(st: Stats): boolean {
  let serverNode: Stats | null
  try {
    serverNode = statSync(process.execPath)
  } catch {
    serverNode = null
  }
  if (serverNode && serverNode.dev === st.dev && serverNode.ino === st.ino) return true
  if ((st.mode & 0o022) !== 0) return false
  const uid = typeof process.getuid === 'function' ? process.getuid() : null
  if (uid === null || st.uid === uid || st.uid === 0) return true
  return serverNode !== null && serverNode.uid === st.uid
}

/**
 * The current install folder of `id` when Clawboo may run code from it: the
 * runtimes folder passes `runtimesDirRefusal`, and the runtime's folder, its
 * pointer file and the install folder are real, owned by this user and closed
 * to others (the install's contents were sealed when it was committed). For a
 * runtime that is loaded rather than started, such as the Claude Agent SDK.
 */
export function currentInstallFolder(
  id: string,
  env: NodeJS.ProcessEnv = process.env,
): string | null {
  const record = readRuntimeInstall(id, env)
  if (!record || runtimesDirRefusal(env)) return null
  const runtimeDir = runtimeInstallDir(id, env)
  const folder = path.join(runtimeDir, record.folder)
  const trusted =
    isTrustedEntry(runtimeDir, 'dir') &&
    isTrustedEntry(path.join(runtimeDir, INSTALL_RECORD_FILE), 'file') &&
    isTrustedEntry(folder, 'dir')
  return trusted ? folder : null
}

/** Just the launcher path from {@link ownedRuntimeLaunch}. */
export function ownedRuntimeBin(name: string, env: NodeJS.ProcessEnv = process.env): string | null {
  return ownedRuntimeLaunch(name, env)?.launcher ?? null
}

/** Remove one runtime's launchers and folder entirely. Used by tests and by a
 *  future uninstall; best effort. */
export function removeRuntimeInstall(id: string, env: NodeJS.ProcessEnv = process.env): void {
  const record = readRuntimeInstall(id, env)
  for (const name of Object.keys(record?.launchers ?? {})) {
    if (!LAUNCHER_NAME_RE.test(name)) continue
    try {
      unlinkSync(path.join(runtimeBinDir(env), launcherFileName(name)))
    } catch {
      /* already gone */
    }
  }
  rmSync(runtimeInstallDir(id, env), { recursive: true, force: true, maxRetries: 3 })
}

/**
 * How a person types `name` in their own terminal: the launcher's full path when
 * Clawboo installed it (the runtimes folder is not on their PATH), quoted when it
 * needs it, else the bare name for a copy on PATH.
 */
export function terminalCommandName(
  name: string,
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): string {
  const bin = ownedRuntimeBin(name, env)
  if (!bin) return name
  if (platform === 'win32') return /\s/.test(bin) ? `"${bin}"` : bin
  return /[^\w@%+=:,./-]/.test(bin) ? shQuote(bin) : bin
}
