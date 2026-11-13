// Read-only filesystem view over a task's worktree: directory listing, bounded
// file reads, git status, and a per-file diff against the task's baseline.
// This powers the agent-detail Computer tab, which also lists each task's own
// folder (where a task run starts when there is no worktree) and the agent's team
// folder (where its other runs start; see teamWorkdir.ts).
// Every root is resolved server-side, from the stored `workspaces` row or the
// agent's own row, never from the request, and every relative path is confined
// to that root before any filesystem call.
//
// Confinement is three layers, in order (the third is the one people miss):
//   1. Absolute paths and `..` segments are refused outright, with an error
//      message that says what to do instead of a generic denial.
//   2. The resolved path must sit inside the root lexically, checked with
//      `path.relative` rather than a `startsWith` prefix test, so a sibling
//      like `<root>-evil` can never pass as `<root>`.
//   3. Symlinks are refused: the target itself may not be a symlink (lstat),
//      and after following any symlinked ancestors (realpath) the result must
//      still be inside the resolved root. A link planted inside the workspace
//      passes the lexical check and then points anywhere on disk; this layer
//      is what stops it. Because the agent can change the tree between that
//      check and the open, every file is opened through `openConfinedFile`,
//      which re-checks the open from the handle's side.
//
// With agents on their own OS user (CLAWBOO_AGENT_USER), the checkout and the
// team folder are that user's. The server cannot see into them, and must not
// open a file there as itself anyway: a link the agent planted would choose
// what the server reads. So every stat, listing and read goes to the agent
// host, and git runs there as the agent user. The rules above still hold,
// computed here from the path's text, since the server cannot resolve links in
// folders it cannot see: the path is confined to the stored root lexically,
// and the host is asked about the root and each component below it, so a link
// anywhere on the way is refused as it is with the setting off. The host is on
// the agent's side, so its replies are data: bounded in size, and an error
// when they have the wrong shape. The boundary itself is the agent user's
// permissions: whatever the host reads, it reads as that user.

import { constants as fsConstants, existsSync, opendirSync } from 'node:fs'
import { lstat, open, readdir, readlink, realpath, type FileHandle } from 'node:fs/promises'
import path from 'node:path'
import { StringDecoder } from 'node:string_decoder'

import { agents, getTask, getWorkspaceForTask, type DbWorkspace } from '@clawboo/db'
import { branchNameForTask, execGit, GitError, loadWorktree } from '@clawboo/worktrees'
import { eq } from 'drizzle-orm'

import { agentList, agentReadFile, agentRealpath, agentStat } from './agentUser/agentFs'
import { AgentHostError } from './agentUser/client'
import { isAgentUserMode } from './agentUser/config'
import { AGENT_GIT_OUTPUT_CHARS, MirrorError, runAgentGit } from './agentUser/mirror'
import { MAX_READ_BYTES, type FsEntry, type FsStat } from './agentUser/protocol'
import { getDb } from './db'
import { taskFolderPath, taskRunWorkdirFor } from './runtimes/teamWorkdir'

/** A refused path. The message is safe to surface to the caller verbatim. */
export class WorkspacePathError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'WorkspacePathError'
  }
}

const MAX_REL_PATH = 1024
/** One directory level per request; a deeper tree is fetched lazily. */
export const MAX_DIR_ENTRIES = 500
/** Bytes returned per file read. Sized for a viewer, not a download. */
export const MAX_FILE_BYTES = 256 * 1024
/** Bytes sniffed for a NUL byte to classify a file as binary. */
const BINARY_SNIFF_BYTES = 8192
/** Per-file diffs are capped so one giant lockfile change cannot flood the UI. */
export const MAX_DIFF_BYTES = 1024 * 1024
/** Status entries are capped; a worktree with more changes reports truncation. */
export const MAX_STATUS_ENTRIES = 2000

/**
 * The root, terminated so a prefix test cannot match a SIBLING: `/w/root-evil`
 * does not start with `/w/root/`.
 *
 * The containment COMPARISON is deliberately written out at each filesystem
 * call rather than wrapped in a helper that throws. This repo already states the
 * rule (`verification/deterministicGate.ts`): a helper that validates and then
 * returns hands the caller a value that reads as unchecked, "both to a reviewer
 * skimming the call site and to static analysis". Taint tracking agrees --
 * `js/path-injection` matches guard shapes at the sink, so a call to a
 * throwing helper barriers nothing and every `lstat`/`readdir`/`open` below was
 * reported as reached by user input. Each site therefore proves its own
 * containment immediately before it acts.
 */
function rootPrefixOf(realRoot: string): string {
  return realRoot.endsWith(path.sep) ? realRoot : `${realRoot}${path.sep}`
}

/**
 * Resolve `rel` inside `root`, or throw `WorkspacePathError`. Returns the
 * absolute, symlink-free path. `rel` uses forward slashes; `''` means the root
 * itself. When `mustExist` is false a missing leaf resolves to its would-be
 * absolute path (still confined), which lets the diff endpoint name a deleted
 * file.
 */
/** A confined path plus the root it was confined to, so a caller can re-assert
 *  containment immediately before it touches the filesystem. */
export interface ResolvedWorkspacePath {
  abs: string
  realRoot: string
}

export async function resolveWorkspaceRelPath(
  root: string,
  rel: string,
  opts: {
    mustExist?: boolean
    /** `root` is a real path already checked to hold no link, and must still
     *  resolve to itself: a part of it swapped for a link since the check is
     *  refused instead of followed. */
    exactRoot?: boolean
  } = {},
): Promise<ResolvedWorkspacePath> {
  const mustExist = opts.mustExist ?? true
  if (typeof rel !== 'string') throw new WorkspacePathError('A file path is required.')
  const wanted = rel.trim()
  if (wanted.length > MAX_REL_PATH) throw new WorkspacePathError('The path is too long.')
  if (wanted.includes('\0')) throw new WorkspacePathError('The path contains a NUL byte.')
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f]/.test(wanted)) {
    throw new WorkspacePathError('The path contains control characters.')
  }
  if (wanted.includes('\\')) {
    throw new WorkspacePathError('Use forward slashes; backslashes are not accepted.')
  }
  if (path.isAbsolute(wanted)) {
    throw new WorkspacePathError('Use a path relative to the workspace, not an absolute one.')
  }
  if (wanted.split('/').some((seg) => seg === '..')) {
    throw new WorkspacePathError(
      "A path may not contain '..'. Only files inside the workspace are reachable.",
    )
  }
  if (isAgentUserMode()) {
    return resolveInAgentSpace(root, wanted, mustExist, opts.exactRoot ?? false)
  }

  // The root must exist and resolve; a reaped worktree surfaces here.
  const realRoot = await realpath(root)
  if (opts.exactRoot && realRoot !== root) {
    throw new WorkspacePathError('The folder is reached through a link, so it is not served.')
  }
  const abs = path.resolve(realRoot, wanted)
  const rootPrefix = rootPrefixOf(realRoot)
  // Nested, not `&&`: a guard's outcome propagates through `&&` only when it is
  // TRUE, and the branch that reaches the filesystem here is the FALSE one.
  if (abs !== realRoot) {
    if (!abs.startsWith(rootPrefix)) {
      throw new WorkspacePathError('The path escapes the workspace.')
    }
  }

  let st
  try {
    st = await lstat(abs)
  } catch {
    if (mustExist) throw new WorkspacePathError('No such file in the workspace.')
    return { abs, realRoot }
  }
  if (st.isSymbolicLink()) {
    throw new WorkspacePathError('Symbolic links are not served.')
  }
  // Follow any symlinked ancestor directories and re-check containment.
  const real = await realpath(abs)
  if (real !== realRoot) {
    if (!real.startsWith(rootPrefix)) {
      throw new WorkspacePathError('The path resolves outside the workspace.')
    }
  }
  return { abs: real, realRoot }
}

// ─── Agent space: the same rules, through the agent host ─────────────────────

const STAT_TYPES: ReadonlySet<unknown> = new Set<FsStat['type']>(['file', 'dir', 'link', 'other'])

function isCount(n: unknown): n is number {
  return typeof n === 'number' && Number.isSafeInteger(n) && n >= 0
}

function isFsStat(v: unknown): v is FsStat {
  if (typeof v !== 'object' || v === null) return false
  const s = v as Record<string, unknown>
  return STAT_TYPES.has(s['type']) && isCount(s['size']) && isCount(s['nlink'])
}

function isListEntry(v: unknown): v is FsEntry {
  if (typeof v !== 'object' || v === null) return false
  const e = v as Record<string, unknown>
  const name = e['name']
  return (
    typeof name === 'string' &&
    name.length > 0 &&
    name.length <= MAX_REL_PATH &&
    name !== '.' &&
    name !== '..' &&
    !name.includes('/') &&
    !name.includes('\0') &&
    STAT_TYPES.has(e['type']) &&
    isCount(e['size'])
  )
}

/**
 * What is at `p` in agent space, asked of the host without following a link
 * there. Null when nothing is, or when something on the way is not a folder.
 * A reply of the wrong shape is an error, never a guess.
 */
export async function statInAgentSpace(p: string): Promise<FsStat | null> {
  let st: unknown
  try {
    st = await agentStat(p)
  } catch (err) {
    if (err instanceof AgentHostError && err.code === 'ENOTDIR') return null
    throw err
  }
  if (st === null) return null
  if (!isFsStat(st)) throw new AgentHostError('the agent host sent a malformed stat')
  return st
}

/**
 * Whether a checkout or team folder is on disk. With agent isolation on it is
 * the agent user's, which the server cannot see into (`existsSync` answers
 * false for every one), so the host is asked. A link where the folder should
 * be does not count.
 */
export async function folderOnDiskInAgentSpace(dir: string): Promise<boolean> {
  return (await statInAgentSpace(dir))?.type === 'dir'
}

/** A missing root fails the way `realpath` fails on one with the setting off. */
function missingError(p: string): NodeJS.ErrnoException {
  return Object.assign(new Error(`ENOENT: no such file or directory, '${p}'`), { code: 'ENOENT' })
}

/**
 * `resolveWorkspaceRelPath` with agent isolation on, for a `wanted` that has
 * passed the lexical checks. Containment is by the path's text, against the
 * root as stored. The host is then asked about the root and each component
 * below it, in order, which is how a link anywhere on the way is refused here:
 * `realpath`, which refuses one with the setting off, would run as the server.
 * With `exactRoot` (a task folder's real path, see `realTaskFolder`) the host
 * also resolves the root, which must still be itself, so a folder above it
 * swapped for a link since that check is refused as it is with the setting off.
 */
async function resolveInAgentSpace(
  root: string,
  wanted: string,
  mustExist: boolean,
  exactRoot: boolean,
): Promise<ResolvedWorkspacePath> {
  const lexRoot = path.resolve(root)
  const abs = path.resolve(lexRoot, wanted)
  const rootPrefix = rootPrefixOf(lexRoot)
  if (abs !== lexRoot) {
    if (!abs.startsWith(rootPrefix)) {
      throw new WorkspacePathError('The path escapes the workspace.')
    }
  }
  // The host makes these folders as real folders. A link at the root is the
  // agent's doing, and following it would serve some other folder as this one.
  const rootStat = await statInAgentSpace(lexRoot)
  if (rootStat === null) throw missingError(lexRoot)
  if (rootStat.type === 'link') throw new WorkspacePathError('Symbolic links are not served.')
  if (rootStat.type !== 'dir') throw new WorkspacePathError('Not a directory.')
  if (exactRoot && (await agentRealpath(lexRoot)) !== root) {
    throw new WorkspacePathError('The folder is reached through a link, so it is not served.')
  }

  let at = lexRoot
  const segments = abs === lexRoot ? [] : abs.slice(rootPrefix.length).split(path.sep)
  for (const segment of segments) {
    at = path.join(at, segment)
    const st = await statInAgentSpace(at)
    if (st === null) {
      if (mustExist) throw new WorkspacePathError('No such file in the workspace.')
      return { abs, realRoot: lexRoot }
    }
    if (st.type === 'link') throw new WorkspacePathError('Symbolic links are not served.')
  }
  return { abs, realRoot: lexRoot }
}

/** What `readConfinedInAgentSpace` read. */
export interface AgentSpaceRead {
  data: Buffer
  /** The file held more than was asked for. */
  more: boolean
  /** The file's size, as the host reported it just before the read. */
  size: number
}

/** A host refusal, in the words the server uses for the same refusal. */
function refusalOf(err: unknown): unknown {
  if (!(err instanceof AgentHostError)) return err
  // ELOOP on Linux and macOS, EMLINK on FreeBSD: the host's O_NOFOLLOW open
  // met a link as the last component.
  if (err.code === 'ELOOP' || err.code === 'EMLINK') {
    return new WorkspacePathError('Symbolic links are not served.')
  }
  if (err.code === 'ENOTFILE' || err.code === 'EISDIR') return new WorkspacePathError('Not a file.')
  return err
}

/**
 * Read a file that `resolveWorkspaceRelPath` confined, at most `maxBytes` (and
 * never more than one host read carries), with agent isolation on. The
 * counterpart of `openConfinedFile`, which opens as the server: here the host
 * opens the file as the agent user with O_NOFOLLOW, so a link swapped in after
 * the checks is refused there, and could only ever reach what the agent can
 * read already. Throws `WorkspacePathError` for a link, anything but a regular
 * file, or a hard-linked file, and an error with code ENOENT for a file that
 * went away, as an open by the server would.
 */
export async function readConfinedInAgentSpace(
  realRoot: string,
  abs: string,
  maxBytes: number,
): Promise<AgentSpaceRead> {
  const sinkPrefix = rootPrefixOf(realRoot)
  if (!abs.startsWith(sinkPrefix)) {
    throw new WorkspacePathError('The path escapes the workspace.')
  }
  const st = await statInAgentSpace(abs)
  if (st === null) throw missingError(abs)
  if (st.type === 'link') throw new WorkspacePathError('Symbolic links are not served.')
  if (st.type !== 'file') throw new WorkspacePathError('Not a file.')
  // As with the setting off: a checkout never makes a hard link, and one would
  // name a file from elsewhere under a path inside the tree.
  if (st.nlink > 1) throw new WorkspacePathError('Hard-linked files are not served.')

  const cap = Math.max(0, Math.min(maxBytes, MAX_READ_BYTES))
  try {
    // One byte past the cap says whether more was there, where a read can carry it.
    const first = await agentReadFile(abs, { maxBytes: cap + 1 })
    if (first === null) throw missingError(abs)
    if (first.length > cap) return { data: first.subarray(0, cap), more: true, size: st.size }
    if (first.length < cap || cap + 1 <= MAX_READ_BYTES) {
      return { data: first, more: false, size: st.size }
    }
    // The cap is all one read carries: ask for the byte after it on its own.
    const next = await agentReadFile(abs, { maxBytes: 1, offset: cap })
    return { data: first, more: next !== null && next.length > 0, size: st.size }
  } catch (err) {
    throw refusalOf(err)
  }
}

/**
 * The most names one listing asks the host for. With the setting off every
 * name is read; through the host a listing is one bounded reply, so past this
 * many names the page is drawn from the first ones by name and says it is cut.
 */
const AGENT_LIST_MAX = 10_000

const byEntryName = (a: WorkspaceDirEntry, b: WorkspaceDirEntry): number =>
  a.name.localeCompare(b.name, undefined, { sensitivity: 'base' })

/** `listDirAt` past the resolve, with agent isolation on. */
async function listInAgentSpace(
  abs: string,
  relDir: string,
  maxEntries: number,
): Promise<WorkspaceDirListing> {
  const st = await statInAgentSpace(abs)
  if (st === null) throw missingError(abs)
  if (st.type !== 'dir') throw new WorkspacePathError('Not a directory.')

  const listed = await agentList(abs, { max: AGENT_LIST_MAX })
  const dirs: WorkspaceDirEntry[] = []
  const files: WorkspaceDirEntry[] = []
  for (const entry of listed.entries as unknown[]) {
    if (!isListEntry(entry)) throw new AgentHostError('the agent host sent a malformed listing')
    if (entry.name === '.git') continue
    // The host lists without following links, so a link is typed `link` and,
    // like sockets and FIFOs, is not listed.
    if (entry.type === 'dir') dirs.push({ name: entry.name, kind: 'dir' })
    else if (entry.type === 'file') files.push({ name: entry.name, kind: 'file', size: entry.size })
  }
  dirs.sort(byEntryName)
  files.sort(byEntryName)
  const all = [...dirs, ...files]
  return {
    dir: relDir,
    entries: all.slice(0, maxEntries),
    truncated: listed.truncated || all.length > maxEntries,
  }
}

/** `execGit`'s own limit, kept for git run as the agent user. */
const AGENT_GIT_TIMEOUT_MS = 60_000

const SHA_RE = /^[0-9a-f]{40}([0-9a-f]{24})?$/

/**
 * git in a task checkout. With agent isolation on the checkout is the agent
 * user's, and git there (its hooks, its config) runs as that user, through the
 * host. Rejects with `GitError` or `MirrorError`.
 */
function gitInCheckout(root: string, args: string[]): Promise<string> {
  if (!isAgentUserMode()) return execGit(root, args)
  return runAgentGit(args, { cwd: root, timeoutMs: AGENT_GIT_TIMEOUT_MS })
}

/**
 * The task's scaffold commit, with agent isolation on: the question
 * `loadWorktree` asks the user's repository, asked of the checkout as the agent
 * user instead, because the task branch lives in the agent's own copy of the
 * repository until it is brought out. Null when git cannot answer.
 */
async function scaffoldCommitInAgentSpace(root: string, taskId: string): Promise<string | null> {
  let out: string
  try {
    out = await runAgentGit(
      [
        'log',
        '--format=%H',
        '--grep',
        `clawboo: scaffold task ${taskId}`,
        '-n',
        '1',
        branchNameForTask(taskId),
      ],
      { cwd: root, timeoutMs: AGENT_GIT_TIMEOUT_MS },
    )
  } catch (err) {
    if (err instanceof MirrorError) return null
    throw err
  }
  const sha = out.trim().split('\n')[0] ?? ''
  return SHA_RE.test(sha) ? sha : null
}

/** An open, confined regular file. The caller owns `handle` and closes it. */
export interface ConfinedFile {
  handle: FileHandle
  /** Size of the file the handle holds, read from the handle itself. */
  size: number
}

/**
 * Open a file that `resolveWorkspaceRelPath` confined, for reading, or throw
 * `WorkspacePathError`.
 *
 * The resolve proved the path safe at the moment it ran. The agent writes this
 * tree concurrently, so between that proof and the open it can swap the file,
 * or any folder above it, for a link to anywhere on disk. The open is therefore
 * checked from the handle's side:
 *   1. `O_NOFOLLOW` refuses a link as the last component, where the flag exists
 *      (it does not on Windows), and `O_NONBLOCK` keeps a named pipe swapped in
 *      from blocking the open until something writes to it.
 *   2. The handle must hold a regular file with one name: a hard link is the
 *      same file as its target, so no later check can tell it apart.
 *   3. On Linux, the kernel's own name for the open file
 *      (`/proc/self/fd/<fd>`) must be `abs`. It describes the handle, not a
 *      fresh lookup, so no swap during the checks can change it.
 *   4. Everywhere, AFTER the open, `abs` must still resolve to itself, with no
 *      link anywhere on the way, and name the very file the handle holds (same
 *      device and inode, still one name). This catches a folder or file swapped
 *      for a link, and one swapped and swapped back. Off Linux it is a second
 *      lookup by path, so an agent that keeps swapping a folder above the file
 *      can still race it.
 */
export async function openConfinedFile(realRoot: string, abs: string): Promise<ConfinedFile> {
  // This opens as the server. With agent isolation on, a caller reads through
  // `readConfinedInAgentSpace`; one that forgets fails here instead of quietly
  // opening a file in the agent user's folders as the server.
  if (isAgentUserMode()) {
    throw new Error(
      'openConfinedFile opens files as the server; with agent isolation on, use readConfinedInAgentSpace',
    )
  }
  const sinkPrefix = rootPrefixOf(realRoot)
  if (!abs.startsWith(sinkPrefix)) {
    throw new WorkspacePathError('The path escapes the workspace.')
  }
  let handle: FileHandle
  try {
    handle = await open(
      abs,
      fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0) | (fsConstants.O_NONBLOCK ?? 0),
    )
  } catch (err) {
    // ELOOP on Linux and macOS, EMLINK on FreeBSD: the last component is a link.
    const code = (err as NodeJS.ErrnoException).code
    if (code === 'ELOOP' || code === 'EMLINK') {
      throw new WorkspacePathError('Symbolic links are not served.')
    }
    throw err
  }
  try {
    const held = await handle.stat()
    if (!held.isFile()) throw new WorkspacePathError('Not a file.')
    // A hard link is the same file under a second name, so the device and inode
    // check below cannot tell one that leads outside the tree. A checkout never
    // makes them; refuse every file with more than one name.
    if (held.nlink > 1) throw new WorkspacePathError('Hard-linked files are not served.')
    if (process.platform === 'linux') {
      const opened = await kernelPathOf(handle)
      if (opened !== null && opened !== abs) {
        throw new WorkspacePathError('The file changed while it was being opened.')
      }
    }
    const real = await realpath(abs)
    if (real !== abs) {
      throw new WorkspacePathError('The file changed while it was being opened.')
    }
    const named = await lstat(abs)
    if (named.isSymbolicLink() || named.dev !== held.dev || named.ino !== held.ino) {
      throw new WorkspacePathError('The file changed while it was being opened.')
    }
    // Read again here: a second name made after the first check would let the
    // name check above match a file that lives outside the tree.
    if (named.nlink > 1) throw new WorkspacePathError('Hard-linked files are not served.')
    return { handle, size: held.size }
  } catch (err) {
    await handle.close()
    throw err
  }
}

/** Where the kernel says an open file is (Linux), or null when it cannot say. */
async function kernelPathOf(handle: FileHandle): Promise<string | null> {
  try {
    return await readlink(`/proc/self/fd/${handle.fd}`)
  } catch {
    return null
  }
}

export interface WorkspaceDirEntry {
  name: string
  kind: 'file' | 'dir'
  /** Present for files only. */
  size?: number
}

export interface WorkspaceDirListing {
  dir: string
  entries: WorkspaceDirEntry[]
  truncated: boolean
}

/**
 * List ONE directory level. `.git` is skipped (in a worktree checkout it is a
 * gitdir pointer file, but it is bookkeeping either way), as are symlinks and
 * special files. Directories sort before files, then case-insensitive by name.
 */
export async function listDirAt(
  root: string,
  relDir: string,
  opts: { maxEntries?: number; exactRoot?: boolean } = {},
): Promise<WorkspaceDirListing> {
  const maxEntries = opts.maxEntries ?? MAX_DIR_ENTRIES
  const { abs, realRoot } = await resolveWorkspaceRelPath(root, relDir, {
    exactRoot: opts.exactRoot ?? false,
  })
  const sinkPrefix = rootPrefixOf(realRoot)
  if (abs !== realRoot) {
    if (!abs.startsWith(sinkPrefix)) {
      throw new WorkspacePathError('The path escapes the workspace.')
    }
  }
  if (isAgentUserMode()) return listInAgentSpace(abs, relDir, maxEntries)
  const st = await lstat(abs)
  if (!st.isDirectory()) throw new WorkspacePathError('Not a directory.')

  const dirents = await readdir(abs, { withFileTypes: true })
  const dirs: WorkspaceDirEntry[] = []
  const files: WorkspaceDirEntry[] = []
  for (const d of dirents) {
    if (d.name === '.git') continue
    if (d.isSymbolicLink()) continue
    if (d.isDirectory()) dirs.push({ name: d.name, kind: 'dir' })
    else if (d.isFile()) files.push({ name: d.name, kind: 'file' })
    // Sockets, FIFOs and the like are not listed.
  }
  dirs.sort(byEntryName)
  files.sort(byEntryName)
  const all = [...dirs, ...files]
  const page = all.slice(0, maxEntries)
  // Size the SURVIVORS only, concurrently. Statting every entry first meant a
  // node_modules directory paid thousands of sequential syscalls to render 500
  // rows. A file that raced away between readdir and lstat is listed sizeless.
  await Promise.all(
    page.map(async (entry) => {
      if (entry.kind !== 'file') return
      try {
        entry.size = (await lstat(path.join(abs, entry.name))).size
      } catch {
        /* raced away; leave the size off */
      }
    }),
  )
  return { dir: relDir, entries: page, truncated: all.length > maxEntries }
}

/** Decode UTF-8 bytes, dropping a trailing incomplete multi-byte sequence
 *  rather than emitting a replacement character for it. */
function decodeUtf8(buf: Buffer): string {
  return new StringDecoder('utf8').write(buf)
}

export type WorkspaceFileRead =
  | { binary: true; size: number }
  | { binary: false; size: number; content: string; truncated: boolean }

/** Read a file, capped. A NUL byte in the first 8 KB classifies it as binary. */
export async function readFileAt(
  root: string,
  relPath: string,
  opts: { maxBytes?: number; exactRoot?: boolean } = {},
): Promise<WorkspaceFileRead> {
  const maxBytes = opts.maxBytes ?? MAX_FILE_BYTES
  const { abs, realRoot } = await resolveWorkspaceRelPath(root, relPath, {
    exactRoot: opts.exactRoot ?? false,
  })
  const sinkPrefix = rootPrefixOf(realRoot)
  if (abs !== realRoot) {
    if (!abs.startsWith(sinkPrefix)) {
      throw new WorkspacePathError('The path escapes the workspace.')
    }
  }
  if (isAgentUserMode()) {
    // Enough for the binary sniff and for what is shown; `more` says whether
    // the file went on past it.
    const read = await readConfinedInAgentSpace(
      realRoot,
      abs,
      Math.max(maxBytes, BINARY_SNIFF_BYTES),
    )
    if (read.data.subarray(0, BINARY_SNIFF_BYTES).includes(0)) {
      return { binary: true, size: read.size }
    }
    return {
      binary: false,
      size: read.size,
      content: decodeUtf8(read.data.subarray(0, maxBytes)),
      truncated: read.more || read.data.length > maxBytes,
    }
  }
  const st = await lstat(abs)
  if (!st.isFile()) throw new WorkspacePathError('Not a file.')

  // The checks above are all `lstat`s, which do not follow links, so the leaf
  // was proven a regular file at check time and could still be swapped for a
  // link before the open. The agent owns this worktree and writes it
  // concurrently, so that window is real; `openConfinedFile` closes it.
  const { handle, size } = await openConfinedFile(realRoot, abs)
  try {
    // The agent is writing this worktree concurrently, so the file can shrink
    // between the open and the read. Every buffer is sliced to the bytes
    // ACTUALLY read: a short read left the tail of a zero-filled Buffer in
    // place, and those NUL bytes made a shrinking text file report as binary.
    const sniffLen = Math.min(BINARY_SNIFF_BYTES, size)
    const sniff = Buffer.alloc(sniffLen)
    let sniffRead = 0
    if (sniffLen > 0) ({ bytesRead: sniffRead } = await handle.read(sniff, 0, sniffLen, 0))
    if (sniff.subarray(0, sniffRead).includes(0)) return { binary: true, size }

    // One byte past what is shown, so `truncated` says whether more was there
    // when it was read, not when it was opened: a file that shrank in between
    // and was read whole is not cut.
    const shownLen = Math.min(maxBytes, size)
    const buf = Buffer.alloc(shownLen + 1)
    const { bytesRead } = await handle.read(buf, 0, shownLen + 1, 0)
    return {
      binary: false,
      size,
      // Decoded through a StringDecoder so a cut landing mid-codepoint holds
      // the partial sequence back instead of emitting a replacement char.
      content: decodeUtf8(buf.subarray(0, Math.min(bytesRead, shownLen))),
      truncated: bytesRead > shownLen,
    }
  } finally {
    await handle.close()
  }
}

export interface WorkspaceStatusEntry {
  path: string
  /** Index (staged) status letter from `git status --porcelain`. */
  x: string
  /** Worktree status letter. `??` reports as x='?' y='?'. */
  y: string
  /** Rename/copy source, when git reports one. */
  origPath?: string
}

export interface WorkspaceStatus {
  entries: WorkspaceStatusEntry[]
  truncated: boolean
}

/** Parse `git status --porcelain -z` records. Exported for tests. */
export function parsePorcelainStatus(
  raw: string,
  opts: { maxEntries?: number } = {},
): WorkspaceStatus {
  const maxEntries = opts.maxEntries ?? MAX_STATUS_ENTRIES
  const records = raw.split('\0').filter((r) => r.length > 0)
  const entries: WorkspaceStatusEntry[] = []
  let truncated = false
  for (let i = 0; i < records.length; i++) {
    const rec = records[i]
    if (rec === undefined || rec.length < 4) continue
    const x = rec[0] ?? ' '
    const y = rec[1] ?? ' '
    const p = rec.slice(3)
    const entry: WorkspaceStatusEntry = { path: p, x, y }
    // Renames and copies carry the source path as the NEXT NUL record.
    if (x === 'R' || x === 'C' || y === 'R' || y === 'C') {
      const orig = records[i + 1]
      if (orig !== undefined) {
        entry.origPath = orig
        i++
      }
    }
    if (entries.length >= maxEntries) {
      truncated = true
      break
    }
    entries.push(entry)
  }
  return { entries, truncated }
}

// ─── Task-level wrappers (DB lookup + worktree-on-disk guard) ────────────────

export type WorkspaceMissReason =
  /** No workspace row, or the row carries no worktree path. */
  | 'not_found'
  /** The row exists but the checkout is not on disk (paused or reaped). */
  | 'gone'
  /** The checkout is on disk but git cannot read it: the worktree was orphaned
   *  by a repo move, the index is corrupt, or ownership is refused. */
  | 'unreadable'

export type WorkspaceRootResult =
  { ok: true; root: string; workspace: DbWorkspace } | { ok: false; reason: WorkspaceMissReason }

/** Resolve a task's worktree root from the stored workspaces row. `gone` means
 *  the row exists but the checkout was paused or reaped (the branch survives). */
export async function resolveWorkspaceRoot(taskId: string): Promise<WorkspaceRootResult> {
  const ws = getWorkspaceForTask(getDb(), taskId)
  if (!ws || !ws.worktreePath) return { ok: false, reason: 'not_found' }
  if (isAgentUserMode()) {
    if (!(await folderOnDiskInAgentSpace(ws.worktreePath))) return { ok: false, reason: 'gone' }
    return { ok: true, root: ws.worktreePath, workspace: ws }
  }
  try {
    await realpath(ws.worktreePath)
  } catch {
    return { ok: false, reason: 'gone' }
  }
  return { ok: true, root: ws.worktreePath, workspace: ws }
}

export async function listWorkspaceDir(
  taskId: string,
  relDir: string,
): Promise<WorkspaceRootResult | (WorkspaceDirListing & { ok: true })> {
  const rootRes = await resolveWorkspaceRoot(taskId)
  if (!rootRes.ok) return rootRes
  const listing = await listDirAt(rootRes.root, relDir)
  return { ok: true, ...listing }
}

export async function readWorkspaceFile(
  taskId: string,
  relPath: string,
): Promise<WorkspaceRootResult | ({ ok: true; path: string } & WorkspaceFileRead)> {
  const rootRes = await resolveWorkspaceRoot(taskId)
  if (!rootRes.ok) return rootRes
  const read = await readFileAt(rootRes.root, relPath)
  return { ok: true, path: relPath, ...read }
}

export async function workspaceGitStatus(
  taskId: string,
): Promise<WorkspaceRootResult | ({ ok: true; branch: string | null } & WorkspaceStatus)> {
  const rootRes = await resolveWorkspaceRoot(taskId)
  if (!rootRes.ok) return rootRes
  // A git failure here must NOT read as "no changes". The directory can exist
  // while git refuses it: worktree roots are namespaced by a hash of the repo
  // path, so moving or re-cloning the repo orphans every existing checkout
  // while its workspaces row stays active. Reporting that as an empty entry
  // list would paint a dirty worktree as clean.
  let raw: string
  try {
    raw = await gitInCheckout(rootRes.root, [
      'status',
      '--porcelain',
      '-z',
      '--untracked-files=all',
    ])
  } catch (err) {
    if (err instanceof GitError || err instanceof MirrorError) {
      return { ok: false, reason: 'unreadable' }
    }
    throw err
  }
  // `runAgentGit` may have cut its output mid-record: keep whole records only,
  // and say the list is cut.
  const cut = isAgentUserMode() && raw.length >= AGENT_GIT_OUTPUT_CHARS
  const status = parsePorcelainStatus(cut ? raw.slice(0, raw.lastIndexOf('\0') + 1) : raw)
  return {
    ok: true,
    branch: rootRes.workspace.branch ?? null,
    ...status,
    truncated: status.truncated || cut,
  }
}

export async function workspaceFileDiff(
  taskId: string,
  relPath: string,
): Promise<WorkspaceRootResult | { ok: true; path: string; diff: string; truncated: boolean }> {
  const rootRes = await resolveWorkspaceRoot(taskId)
  if (!rootRes.ok) return rootRes
  const wanted = relPath.trim()
  if (!wanted) throw new WorkspacePathError('A file path is required.')
  // The file may have been deleted by the change under review, so existence is
  // not required; the confinement checks still run in full.
  const { abs, realRoot } = await resolveWorkspaceRelPath(rootRes.root, wanted, {
    mustExist: false,
  })
  const sinkPrefix = rootPrefixOf(realRoot)
  if (abs !== realRoot) {
    if (!abs.startsWith(sinkPrefix)) {
      throw new WorkspacePathError('The path escapes the workspace.')
    }
  }
  // A DIRECTORY must be refused. git's pathspec matches by prefix, so `.` or
  // `src` would return a whole-subtree diff from a route that promises one
  // file, under a response that echoes the requested path. The sibling readers
  // (listDirAt / readFileAt) both assert their target type; this one must too.
  try {
    const isDir = isAgentUserMode()
      ? (await statInAgentSpace(abs))?.type === 'dir'
      : (await lstat(abs)).isDirectory()
    if (isDir) {
      throw new WorkspacePathError('Not a file.')
    }
  } catch (err) {
    // A missing path is the legitimate deleted-file case; anything else rethrows.
    if (err instanceof WorkspacePathError) throw err
  }
  let baseCommit: string
  if (isAgentUserMode()) {
    const found = await scaffoldCommitInAgentSpace(rootRes.root, taskId)
    if (found === null) return { ok: false, reason: 'unreadable' }
    baseCommit = found
  } else {
    // Only the baseline commit is taken from loadWorktree; reads use the stored
    // worktree path. findScaffoldCommit does not depend on the worktree root.
    const wt = await loadWorktree({
      repoPath: rootRes.workspace.repoPath,
      taskId,
    })
    baseCommit = wt.baseCommit
  }
  // :(literal) keeps a filename carrying glob characters from acting as a
  // pathspec pattern. The TRIMMED path is what was validated, so it is what git
  // gets.
  let diff: string
  try {
    diff = await gitInCheckout(rootRes.root, ['diff', baseCommit, '--', `:(literal)${wanted}`])
  } catch (err) {
    if (err instanceof GitError || err instanceof MirrorError) {
      return { ok: false, reason: 'unreadable' }
    }
    throw err
  }
  // Cap on BYTES, cut on a codepoint boundary: slicing the string by
  // MAX_DIFF_BYTES cuts UTF-16 code units, which overshoots the byte budget on
  // non-ASCII diffs and can split a surrogate pair. Through the host the diff
  // may also have been cut by `runAgentGit` itself.
  const bytes = Buffer.from(diff, 'utf8')
  const truncated =
    bytes.byteLength > MAX_DIFF_BYTES ||
    (isAgentUserMode() && diff.length >= AGENT_GIT_OUTPUT_CHARS)
  return {
    ok: true,
    path: wanted,
    diff: truncated ? decodeUtf8(bytes.subarray(0, MAX_DIFF_BYTES)) : diff,
    truncated,
  }
}

// ─── Agent-level wrappers: the team folder ───────────────────────────────────

/** The folder an agent's runs start in when they have no worktree: its team's
 *  folder, or the shared `_no-team` one for an agent with no team. */
export interface AgentTeamFolder {
  teamId: string | null
  path: string
  /** False until the first run creates it. */
  onDisk: boolean
}

/** null for an unknown agent or a runtime that gets no folder (OpenClaw). The
 *  path comes from the agent's row, never the request. */
export function agentTeamFolder(agentId: string): AgentTeamFolder | null {
  const row = getDb()
    .select({ runtime: agents.runtime, teamId: agents.teamId })
    .from(agents)
    .where(eq(agents.id, agentId))
    .get()
  if (!row) return null
  const dir = taskRunWorkdirFor(row.runtime, row.teamId)
  if (!dir) return null
  return { teamId: row.teamId ?? null, path: dir, onDisk: existsSync(dir) }
}

async function resolveTeamFolderRoot(
  agentId: string,
): Promise<{ ok: true; root: string } | { ok: false; reason: WorkspaceMissReason }> {
  const folder = agentTeamFolder(agentId)
  if (!folder) return { ok: false, reason: 'not_found' }
  if (isAgentUserMode()) {
    if (!(await folderOnDiskInAgentSpace(folder.path))) return { ok: false, reason: 'gone' }
    return { ok: true, root: folder.path }
  }
  try {
    await realpath(folder.path)
  } catch {
    return { ok: false, reason: 'gone' }
  }
  return { ok: true, root: folder.path }
}

export async function listTeamFolderDir(
  agentId: string,
  relDir: string,
): Promise<{ ok: false; reason: WorkspaceMissReason } | (WorkspaceDirListing & { ok: true })> {
  const rootRes = await resolveTeamFolderRoot(agentId)
  if (!rootRes.ok) return rootRes
  const listing = await listDirAt(rootRes.root, relDir)
  return { ok: true, ...listing }
}

export async function readTeamFolderFile(
  agentId: string,
  relPath: string,
): Promise<
  { ok: false; reason: WorkspaceMissReason } | ({ ok: true; path: string } & WorkspaceFileRead)
> {
  const rootRes = await resolveTeamFolderRoot(agentId)
  if (!rootRes.ok) return rootRes
  const read = await readFileAt(rootRes.root, relPath)
  return { ok: true, path: relPath, ...read }
}

// ─── Task-level wrappers: the task folder ────────────────────────────────────

/** The folder a task run with no worktree starts in (see teamWorkdir.ts). */
export interface TaskFolder {
  path: string
  /** False until the task's first run creates it, and after a cleanup removed it
   *  empty. */
  onDisk: boolean
}

/** A task's own folder, or null for an unknown task. The path comes from the
 *  task's row (its team and id), never the request. */
export function taskFolderOf(taskId: string): TaskFolder | null {
  const task = getTask(getDb(), taskId)
  return task ? taskFolderOfTask(task) : null
}

/**
 * {@link taskFolderOf} for a task row already read. With agent isolation on,
 * `onDisk` here is the server's own look, which cannot see into the agent
 * user's folders and says false for every one: a caller that needs it asks the
 * host with {@link taskFolderInAgentSpace} instead.
 */
export function taskFolderOfTask(task: { id: string; teamId?: string | null }): TaskFolder | null {
  let dir: string
  try {
    dir = taskFolderPath(task.teamId, task.id)
  } catch {
    return null
  }
  return { path: dir, onDisk: existsSync(dir) }
}

/** Whether a folder has any entry at all. One entry is read, not the listing. */
export function folderHoldsAnything(dir: string): boolean {
  let handle: ReturnType<typeof opendirSync> | null = null
  try {
    handle = opendirSync(dir)
    return handle.readSync() !== null
  } catch {
    return false
  } finally {
    try {
      handle?.closeSync()
    } catch {
      /* already closed */
    }
  }
}

/** {@link folderHoldsAnything} with agent isolation on: the host lists one name. */
export async function folderHoldsAnythingInAgentSpace(dir: string): Promise<boolean> {
  try {
    const listed = await agentList(dir, { max: 1 })
    return listed.entries.length > 0 || listed.truncated
  } catch {
    return false
  }
}

/**
 * A task folder's `onDisk`, and whether it holds anything, with agent isolation
 * on: the folder is the agent user's, so the host is asked. A link where the
 * folder should be does not count as on disk, as for a checkout or a team
 * folder (see {@link folderOnDiskInAgentSpace}).
 */
export async function taskFolderInAgentSpace(
  folder: TaskFolder,
): Promise<TaskFolder & { holdsFiles: boolean }> {
  const onDisk = await folderOnDiskInAgentSpace(folder.path)
  const holdsFiles = onDisk && (await folderHoldsAnythingInAgentSpace(folder.path))
  return { ...folder, onDisk, holdsFiles }
}

/** Windows and macOS file systems ignore case by default, so a `Tasks` folder an
 *  agent made is where `tasks/<id>` lands, and the real path spells it `Tasks`. */
const foldCase = (p: string): string =>
  process.platform === 'win32' || process.platform === 'darwin' ? p.toLowerCase() : p

/**
 * The real path of `dir`, a task folder `<team folder>/tasks/<task id>`, when it
 * is a real folder reached through no link from its team folder's parent down,
 * else null. An agent can write the team folder, so it could swap the task
 * folder, `tasks/` or the team folder itself for a link to anywhere on disk.
 * Every component it owns is checked by name, and the real path must be the path
 * built from the parent's real path. Readers take the real path returned here
 * with `exactRoot`, so a link swapped in after this check is refused when they
 * resolve the folder again; a file read is then checked from its open handle
 * (see openConfinedFile).
 *
 * With agent isolation on, the folders are the agent user's and the server
 * cannot look into them, so the host answers every look and every real path,
 * as the agent user. Its answers are only compared here, never used as a place
 * to read: the reads go through the host too (see resolveInAgentSpace).
 */
export async function realTaskFolder(dir: string): Promise<string | null> {
  const tasksDir = path.dirname(dir)
  const teamFolder = path.dirname(tasksDir)
  const inAgentSpace = isAgentUserMode()
  const realOf = (p: string): Promise<string> => (inAgentSpace ? agentRealpath(p) : realpath(p))
  try {
    for (const p of [teamFolder, tasksDir, dir]) {
      if (inAgentSpace) {
        if ((await statInAgentSpace(p))?.type !== 'dir') return null
        continue
      }
      const st = await lstat(p)
      if (st.isSymbolicLink() || !st.isDirectory()) return null
    }
    const expected = path.join(
      await realOf(path.dirname(teamFolder)),
      path.basename(teamFolder),
      path.basename(tasksDir),
      path.basename(dir),
    )
    const real = await realOf(dir)
    return foldCase(real) === foldCase(expected) ? real : null
  } catch {
    return null
  }
}

/** A task folder's root for a read: its real path, to be read with
 *  `exactRoot` (see {@link realTaskFolder}). */
async function resolveTaskFolderRoot(
  taskId: string,
): Promise<{ ok: true; root: string } | { ok: false; reason: WorkspaceMissReason }> {
  const folder = taskFolderOf(taskId)
  if (!folder) return { ok: false, reason: 'not_found' }
  // With agent isolation on the server cannot see the folder, so the host is
  // asked, as `resolveWorkspaceRoot` does for a checkout.
  const onDisk = isAgentUserMode() ? await folderOnDiskInAgentSpace(folder.path) : folder.onDisk
  if (!onDisk) return { ok: false, reason: 'gone' }
  const real = await realTaskFolder(folder.path)
  if (!real) return { ok: false, reason: 'unreadable' }
  return { ok: true, root: real }
}

export async function listTaskFolderDir(
  taskId: string,
  relDir: string,
): Promise<{ ok: false; reason: WorkspaceMissReason } | (WorkspaceDirListing & { ok: true })> {
  const rootRes = await resolveTaskFolderRoot(taskId)
  if (!rootRes.ok) return rootRes
  const listing = await listDirAt(rootRes.root, relDir, { exactRoot: true })
  return { ok: true, ...listing }
}

export async function readTaskFolderFile(
  taskId: string,
  relPath: string,
): Promise<
  { ok: false; reason: WorkspaceMissReason } | ({ ok: true; path: string } & WorkspaceFileRead)
> {
  const rootRes = await resolveTaskFolderRoot(taskId)
  if (!rootRes.ok) return rootRes
  const read = await readFileAt(rootRes.root, relPath, { exactRoot: true })
  return { ok: true, path: relPath, ...read }
}

/**
 * Where a task's files are: its worktree when it has one (a row with a checkout
 * path, on disk or not), else its own folder, which is read with `exactRoot`.
 * The preview serves from it.
 */
export async function resolveTaskFilesRoot(
  taskId: string,
): Promise<
  { ok: true; root: string; exactRoot: boolean } | { ok: false; reason: WorkspaceMissReason }
> {
  const worktree = await resolveWorkspaceRoot(taskId)
  if (worktree.ok) return { ok: true, root: worktree.root, exactRoot: false }
  if (worktree.reason !== 'not_found') return worktree
  const folder = await resolveTaskFolderRoot(taskId)
  return folder.ok ? { ...folder, exactRoot: true } : folder
}
