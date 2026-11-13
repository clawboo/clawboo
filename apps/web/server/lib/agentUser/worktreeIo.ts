// Where @clawboo/worktrees runs its git calls and file operations when agents
// run as their own OS user (design 4.9).
//
// Task checkouts, review checkouts and the agent's mirrors of repositories live
// in the work folder, which belongs to the agent user. The server must not run
// git there as itself (a hook or config the agent planted would run as the
// server) and cannot open the agent's files anyway. So an operation on a path in
// the work folder, or a git call whose folder or any path it names is there,
// goes to the agent host: git as an agent process, files through the agent-space
// file verbs. Everything else, such as git in the user's own repository, runs
// here as before.
//
// With isolation off every operation runs here, exactly as the package's own
// default does.

import path from 'node:path'

import {
  getWorktreeIo,
  GIT_MAX_BUFFER,
  GIT_TIMEOUT_MS,
  GitError,
  localWorktreeIo,
  setWorktreeIo,
  UnsafeTaskFileError,
  type WorktreeIo,
} from '@clawboo/worktrees'

import { buildChildEnv } from '../runtimes/childEnv'
import { killProcessTree } from '../runtimes/killTree'
import { spawnAgentProcess } from '../runtimes/spawner'
import { realPathOrSpelling, workDirSpellings } from '../workDir'
import {
  agentAppendFile,
  agentList,
  agentMkdir,
  agentReadFile,
  agentRealpath,
  agentRemove,
  agentRename,
  agentStat,
  agentWriteFile,
} from './agentFs'
import { isAgentUserMode } from './config'
import { MAX_READ_BYTES } from './protocol'

/** The mode a task file the host writes gets: what a 0666 create gives under the
 *  usual 022 umask, as the server's own write would. */
const TASK_FILE_MODE = 0o644

/** Windows and macOS file systems ignore case by default, so a path spelled in
 *  another case can name the work folder; it is compared without case there.
 *  At worst that sends a path of the server's to the host, which then fails. */
const foldCase = (p: string): string =>
  process.platform === 'win32' || process.platform === 'darwin' ? p.toLowerCase() : p

const isWithin = (child: string, parent: string): boolean =>
  child === parent || child.startsWith(parent.endsWith(path.sep) ? parent : parent + path.sep)

/**
 * True when `p` is in the work folder: by its spelling, or by its real path, so
 * a link elsewhere that leads into the work folder counts too. Compared with
 * the work folder's real path and its configured spelling.
 */
export function isInAgentSpace(p: string): boolean {
  const roots = workDirSpellings().map((d) => foldCase(path.resolve(d)))
  const spellings = new Set([foldCase(path.resolve(p)), foldCase(realPathOrSpelling(p))])
  for (const s of spellings) for (const r of roots) if (isWithin(s, r)) return true
  return false
}

/** True when this operation on `p` must run as the agent user. */
const viaHost = (...paths: string[]): boolean =>
  isAgentUserMode() && paths.some((p) => isInAgentSpace(p))

/**
 * Every folder a git call reaches: the one it runs in, the folders `-C`,
 * `--git-dir` and `--work-tree` name (read from that folder), and any absolute
 * path among its arguments (the target of `worktree add`, say).
 */
function gitPaths(cwd: string, args: readonly string[]): string[] {
  const out = [cwd]
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!
    if ((a === '-C' || a === '--git-dir' || a === '--work-tree') && i + 1 < args.length) {
      out.push(path.resolve(cwd, args[++i]!))
      continue
    }
    const eq = /^--(?:git-dir|work-tree)=(.+)$/.exec(a)
    if (eq) out.push(path.resolve(cwd, eq[1]!))
    else if (path.isAbsolute(a)) out.push(a)
  }
  return out
}

/** Variables that point git at a repository, index or object store other than
 *  the one `cwd` finds. Inherited from the server (one started from a git hook
 *  has GIT_DIR set), they would send the agent's git somewhere else. */
const GIT_LOCATION_ENV = [
  'GIT_DIR',
  'GIT_WORK_TREE',
  'GIT_INDEX_FILE',
  'GIT_OBJECT_DIRECTORY',
  'GIT_ALTERNATE_OBJECT_DIRECTORIES',
  'GIT_COMMON_DIR',
  'GIT_NAMESPACE',
  'GIT_PREFIX',
]

/** The environment of git run through the host: every agent process's, without
 *  the repository-location variables, and never asking for a password. */
function hostGitEnv(): Record<string, string> {
  const env = buildChildEnv({ GIT_TERMINAL_PROMPT: '0' })
  for (const name of GIT_LOCATION_ENV) delete env[name]
  return env as Record<string, string>
}

/**
 * `git <args>` in `cwd`, as the agent user. The same limits as the local call
 * (timeout, output cap) and the same failure: any error is a `GitError` with
 * git's stderr. The environment is the one every agent process gets, scrubbed
 * of the server's secrets and identity, with git kept from asking for a
 * password on a terminal no one is watching.
 */
function hostGit(cwd: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    // As the local call: `stderr` is git's own (empty when it said nothing), the
    // message falls back to why it failed, and the exit code is kept.
    const fail = (stderr: string, exitCode: number | null, why = ''): void =>
      reject(
        new GitError(
          `git ${args.join(' ')} failed: ${(stderr || why).trim()}`,
          args,
          stderr,
          exitCode,
        ),
      )
    let child: ReturnType<typeof spawnAgentProcess>
    try {
      child = spawnAgentProcess({
        kind: 'git',
        command: 'git',
        args,
        cwd,
        env: hostGitEnv(),
        stdio: ['ignore', 'pipe', 'pipe'],
        detached: false,
        windowsHide: true,
      })
    } catch (err) {
      fail('', null, err instanceof Error ? err.message : String(err))
      return
    }
    const out: Buffer[] = []
    const err: Buffer[] = []
    let outBytes = 0
    let errBytes = 0
    let done = false
    // Past the time or output limit the call fails at once, as the local one
    // does, and git stops with everything it started: a hook still holding
    // git's output open would otherwise keep 'close' from ever coming.
    const stop = (why: string): void => {
      if (done) return
      done = true
      clearTimeout(timer)
      killProcessTree(child, { graceMs: 2_000 })
      fail(Buffer.concat(err).toString('utf8'), null, why)
    }
    child.stdout?.on('data', (d: Buffer) => {
      outBytes += d.length
      if (outBytes > GIT_MAX_BUFFER) stop('stdout maxBuffer length exceeded')
      else out.push(d)
    })
    child.stderr?.on('data', (d: Buffer) => {
      errBytes += d.length
      if (errBytes > GIT_MAX_BUFFER) stop('stderr maxBuffer length exceeded')
      else err.push(d)
    })
    const timer = setTimeout(() => stop(`timed out after ${GIT_TIMEOUT_MS}ms`), GIT_TIMEOUT_MS)
    timer.unref?.()
    child.on('error', (e: Error) => {
      if (done) return
      done = true
      clearTimeout(timer)
      fail(Buffer.concat(err).toString('utf8'), null, e.message)
    })
    child.on('close', (code: number | null) => {
      if (done) return
      done = true
      clearTimeout(timer)
      const stderr = Buffer.concat(err).toString('utf8')
      if (code === 0) resolve(Buffer.concat(out).toString('utf8'))
      else fail(stderr, code, `exited ${code ?? 'on a signal'}`)
    })
  })
}

function missing(p: string, syscall: string): NodeJS.ErrnoException {
  return Object.assign(new Error(`ENOENT: no such file or directory, ${syscall} '${p}'`), {
    code: 'ENOENT',
    syscall,
    path: p,
  })
}

/** The host refuses a link at the name (`ELOOP`) and anything but a regular
 *  file (`ENOTFILE`); here those read as the refusals the local helpers give. */
function taskFileRefusal(file: string, err: unknown): unknown {
  const code = (err as { code?: string } | null)?.code
  if (code === 'ELOOP') return new UnsafeTaskFileError(file, 'it is a link')
  if (code === 'ENOTFILE') return new UnsafeTaskFileError(file, 'it is not a regular file')
  return err
}

/**
 * The io the server installs. Task files through the host are read and written
 * as the agent user, never through a link at the name; a hard link there is not
 * refused as it is locally, since through the host it reaches only a file the
 * agent could reach already.
 */
export const agentWorktreeIo: WorktreeIo = {
  git: (cwd, args) =>
    isAgentUserMode() && gitPaths(cwd, args).some((p) => isInAgentSpace(p))
      ? hostGit(cwd, args)
      : localWorktreeIo.git(cwd, args),

  exists: async (p) => {
    if (!viaHost(p)) return localWorktreeIo.exists(p)
    try {
      return (await agentStat(p)) !== null
    } catch {
      return false
    }
  },

  mkdir: async (dir) => {
    if (!viaHost(dir)) return localWorktreeIo.mkdir(dir)
    // Owner-only: the work folder's layout (design 4.7).
    await agentMkdir(dir, { mode: 0o700 })
  },

  rm: async (target) => {
    if (!viaHost(target)) return localWorktreeIo.rm(target)
    await agentRemove(target)
  },

  readdir: async (dir) => {
    if (!viaHost(dir)) return localWorktreeIo.readdir(dir)
    const { entries } = await agentList(dir, { max: 100_000 })
    return entries.map((e) => ({ name: e.name, isDirectory: e.type === 'dir' }))
  },

  stat: async (p) => {
    if (!viaHost(p)) return localWorktreeIo.stat(p)
    const st = await agentStat(p)
    if (!st) throw missing(p, 'stat')
    return { isDirectory: st.type === 'dir', mtimeMs: st.mtimeMs }
  },

  // Resolved by the host: the server cannot resolve links inside a folder it
  // may not enter. The answer is only ever compared with other paths.
  realpath: async (p) => {
    if (!viaHost(p)) return localWorktreeIo.realpath(p)
    return agentRealpath(p)
  },

  rename: async (from, to) => {
    if (!viaHost(from, to)) return localWorktreeIo.rename(from, to)
    await agentRename(from, to)
  },

  writeFile: async (file, content, mode) => {
    if (!viaHost(file)) return localWorktreeIo.writeFile(file, content, mode)
    await agentWriteFile(file, content, { mode: mode ?? TASK_FILE_MODE })
  },

  readTaskFile: async (dir, name, maxBytes) => {
    if (!viaHost(dir)) return localWorktreeIo.readTaskFile(dir, name, maxBytes)
    const file = path.join(dir, name)
    // One byte past the limit says whether the file is larger than it.
    const cap = Math.max(0, Math.min(maxBytes, MAX_READ_BYTES - 1))
    let buf: Buffer | null
    try {
      buf = await agentReadFile(file, { maxBytes: cap + 1 })
    } catch (err) {
      throw taskFileRefusal(file, err)
    }
    if (buf === null) throw missing(file, 'lstat')
    if (buf.length > cap) throw new UnsafeTaskFileError(file, `it is larger than ${cap} bytes`)
    return buf.toString('utf8')
  },

  replaceTaskFile: async (dir, name, content) => {
    if (!viaHost(dir)) return localWorktreeIo.replaceTaskFile(dir, name, content)
    const file = path.join(dir, name)
    await agentWriteFile(file, content, { mode: TASK_FILE_MODE }).catch((err: unknown) => {
      throw taskFileRefusal(file, err)
    })
  },

  appendTaskFile: async (dir, name, content) => {
    if (!viaHost(dir)) return localWorktreeIo.appendTaskFile(dir, name, content)
    const file = path.join(dir, name)
    await agentAppendFile(file, content, { mode: TASK_FILE_MODE }).catch((err: unknown) => {
      throw taskFileRefusal(file, err)
    })
  },
}

/**
 * Send @clawboo/worktrees' operations through {@link agentWorktreeIo}. Called
 * once at boot; safe to call again. With isolation off the io runs everything
 * here, so installing it changes nothing.
 */
export function installAgentWorktreeIo(): void {
  if (getWorktreeIo() !== agentWorktreeIo) setWorktreeIo(agentWorktreeIo)
}
