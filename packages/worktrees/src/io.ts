// Every process this package starts and every file it touches, behind one
// object. The lifecycle, the scaffold, the handoff and the relocation never call
// `child_process` or `fs` themselves: they ask the installed `WorktreeIo`, so a
// caller can send some of those operations elsewhere. The server does that when
// agents run as their own OS user: git and file access in a folder that user
// owns run through a process running as that user, because the server must not
// run git in a tree an agent can write (a planted hook or config would run as
// the server) and cannot open the agent's files anyway.
//
// With nothing installed, `localWorktreeIo` runs everything here, exactly as
// the package always did: the same git flags, timeout and output limit, the
// same file calls and modes, the same errors (`GitError`, `ENOENT` and the rest
// of Node's codes, `UnsafeTaskFileError`).

import { execFile, type ExecFileOptions } from 'node:child_process'
import { existsSync } from 'node:fs'
import { chmod, mkdir, readdir, realpath, rename, rm, stat, writeFile } from 'node:fs/promises'
import { promisify } from 'node:util'

import { GitError } from './git'
import { localAppendTaskFile, localReadTaskFile, localReplaceTaskFile } from './taskFiles'

/** `execFile` as a promise, made on first use rather than at import: a caller
 *  that mocks `child_process` without it (as some tests do) can still import
 *  this package. */
type ExecFileAsync = (
  file: string,
  args: readonly string[],
  opts: ExecFileOptions,
) => Promise<{ stdout: string; stderr: string }>
let execFileAsync: ExecFileAsync | null = null
function execFileP(): ExecFileAsync {
  execFileAsync ??= promisify(execFile) as unknown as ExecFileAsync
  return execFileAsync
}

/** How long one git call may run before it is stopped. */
export const GIT_TIMEOUT_MS = 60_000
/** The most output one git call may print: large diffs and logs. */
export const GIT_MAX_BUFFER = 32 * 1024 * 1024 // 32 MiB

/** A folder entry. `isDirectory` is false for a link, wherever it points. */
export interface WorktreeDirEntry {
  name: string
  isDirectory: boolean
}

export interface WorktreeStat {
  isDirectory: boolean
  mtimeMs: number
}

export interface WorktreeIo {
  /** `git <args>` in `cwd`; resolves to stdout. Any failure (a non-zero exit, a
   *  timeout, no git at all) rejects with a `GitError` carrying stderr. */
  git(cwd: string, args: string[]): Promise<string>
  /** True when something is at `p` (the answer `existsSync` gives). */
  exists(p: string): Promise<boolean>
  /** Make `dir` and its parents; fine when it is there. */
  mkdir(dir: string): Promise<void>
  /** Remove a file or a folder tree; fine when nothing is there. */
  rm(target: string): Promise<void>
  /** A folder's entries. Rejects with Node's error (`ENOENT`, `ENOTDIR`). */
  readdir(dir: string): Promise<WorktreeDirEntry[]>
  /** What is at `p`. Rejects with Node's error (`ENOENT` when nothing is). */
  stat(p: string): Promise<WorktreeStat>
  /** `p` with its links resolved. Rejects when it does not exist. */
  realpath(p: string): Promise<string>
  /** Rename; rejects with Node's error (`EXDEV` across volumes). */
  rename(from: string, to: string): Promise<void>
  /** Write a whole UTF-8 file, then give it `mode` when one is given. */
  writeFile(file: string, content: string, mode?: number): Promise<void>
  /** The task file helpers' own operations (see `taskFiles.ts`). `name` has
   *  already been checked to be one plain path segment. */
  readTaskFile(dir: string, name: string, maxBytes: number): Promise<string>
  replaceTaskFile(dir: string, name: string, content: string): Promise<void>
  appendTaskFile(dir: string, name: string, content: string): Promise<void>
}

/**
 * Run `git <args>` in `cwd`. `windowsHide` suppresses the console popup on
 * Windows; the timeout bounds a hung invocation so it can't block the event
 * loop forever.
 */
async function localGit(cwd: string, args: string[]): Promise<string> {
  try {
    const { stdout } = await execFileP()('git', args, {
      cwd,
      timeout: GIT_TIMEOUT_MS,
      windowsHide: true,
      maxBuffer: GIT_MAX_BUFFER,
      encoding: 'utf8',
    })
    return stdout
  } catch (err) {
    const e = err as { stderr?: string; stdout?: string; message?: string; code?: unknown }
    const stderr = (e.stderr ?? e.stdout ?? e.message ?? '').toString()
    throw new GitError(
      `git ${args.join(' ')} failed: ${stderr.trim()}`,
      args,
      stderr,
      typeof e.code === 'number' ? e.code : null,
    )
  }
}

/** Everything run here, as the package always has. */
export const localWorktreeIo: WorktreeIo = {
  git: (cwd, args) => localGit(cwd, args),
  exists: async (p) => existsSync(p),
  mkdir: async (dir) => {
    await mkdir(dir, { recursive: true })
  },
  rm: (target) => rm(target, { recursive: true, force: true }),
  readdir: async (dir) =>
    (await readdir(dir, { withFileTypes: true })).map((e) => ({
      name: e.name,
      isDirectory: e.isDirectory(),
    })),
  stat: async (p) => {
    const st = await stat(p)
    return { isDirectory: st.isDirectory(), mtimeMs: st.mtimeMs }
  },
  realpath: (p) => realpath(p),
  rename: (from, to) => rename(from, to),
  writeFile: async (file, content, mode) => {
    await writeFile(file, content, 'utf8')
    if (mode !== undefined) await chmod(file, mode)
  },
  readTaskFile: (dir, name, maxBytes) => localReadTaskFile(dir, name, maxBytes),
  replaceTaskFile: (dir, name, content) => localReplaceTaskFile(dir, name, content),
  appendTaskFile: (dir, name, content) => localAppendTaskFile(dir, name, content),
}

let installed: WorktreeIo | null = null

/** Send this package's process and file operations to `io`; null goes back to
 *  {@link localWorktreeIo}. */
export function setWorktreeIo(io: WorktreeIo | null): void {
  installed = io
}

/** The operations in use: the installed io, else {@link localWorktreeIo}. */
export function getWorktreeIo(): WorktreeIo {
  return installed ?? localWorktreeIo
}
