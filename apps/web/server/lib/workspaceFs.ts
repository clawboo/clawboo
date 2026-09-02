// Read-only filesystem view over a task's worktree: directory listing, bounded
// file reads, git status, and a per-file diff against the task's baseline.
// This powers the agent-detail Workspace tab. Every path is resolved from the
// stored `workspaces` row, never from the request, and every relative path is
// confined to the worktree root before any filesystem call.
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
//      is what stops it.

import { lstat, open, readdir, realpath } from 'node:fs/promises'
import path from 'node:path'
import { StringDecoder } from 'node:string_decoder'

import { getWorkspaceForTask, type DbWorkspace } from '@clawboo/db'
import { execGit, GitError, loadWorktree } from '@clawboo/worktrees'

import { getDb } from './db'

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
 * True when a `path.relative` result leaves the root. Tested per SEGMENT, not
 * by prefix: a legitimate root-level entry named `..foo` yields the relative
 * path `..foo`, which a bare `startsWith('..')` would refuse.
 */
function escapes(rel: string): boolean {
  if (path.isAbsolute(rel)) return true
  return rel === '..' || rel.startsWith(`..${path.sep}`)
}

/**
 * Resolve `rel` inside `root`, or throw `WorkspacePathError`. Returns the
 * absolute, symlink-free path. `rel` uses forward slashes; `''` means the root
 * itself. When `mustExist` is false a missing leaf resolves to its would-be
 * absolute path (still confined), which lets the diff endpoint name a deleted
 * file.
 */
export async function resolveWorkspaceRelPath(
  root: string,
  rel: string,
  opts: { mustExist?: boolean } = {},
): Promise<string> {
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

  // The root must exist and resolve; a reaped worktree surfaces here.
  const realRoot = await realpath(root)
  const abs = path.resolve(realRoot, wanted)
  if (escapes(path.relative(realRoot, abs))) {
    throw new WorkspacePathError('The path escapes the workspace.')
  }

  let st
  try {
    st = await lstat(abs)
  } catch {
    if (mustExist) throw new WorkspacePathError('No such file in the workspace.')
    return abs
  }
  if (st.isSymbolicLink()) {
    throw new WorkspacePathError('Symbolic links are not served.')
  }
  // Follow any symlinked ancestor directories and re-check containment.
  const real = await realpath(abs)
  if (escapes(path.relative(realRoot, real))) {
    throw new WorkspacePathError('The path resolves outside the workspace.')
  }
  return real
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
  opts: { maxEntries?: number } = {},
): Promise<WorkspaceDirListing> {
  const maxEntries = opts.maxEntries ?? MAX_DIR_ENTRIES
  const abs = await resolveWorkspaceRelPath(root, relDir)
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
  const byName = (a: WorkspaceDirEntry, b: WorkspaceDirEntry) =>
    a.name.localeCompare(b.name, undefined, { sensitivity: 'base' })
  dirs.sort(byName)
  files.sort(byName)
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
  opts: { maxBytes?: number } = {},
): Promise<WorkspaceFileRead> {
  const maxBytes = opts.maxBytes ?? MAX_FILE_BYTES
  const abs = await resolveWorkspaceRelPath(root, relPath)
  const st = await lstat(abs)
  if (!st.isFile()) throw new WorkspacePathError('Not a file.')

  const handle = await open(abs, 'r')
  try {
    // The agent is writing this worktree concurrently, so the file can shrink
    // between lstat and read. Every buffer is sliced to the bytes ACTUALLY
    // read: a short read left the tail of a zero-filled Buffer in place, and
    // those NUL bytes made a shrinking text file report as binary.
    const sniffLen = Math.min(BINARY_SNIFF_BYTES, st.size)
    const sniff = Buffer.alloc(sniffLen)
    let sniffRead = 0
    if (sniffLen > 0) ({ bytesRead: sniffRead } = await handle.read(sniff, 0, sniffLen, 0))
    if (sniff.subarray(0, sniffRead).includes(0)) return { binary: true, size: st.size }

    const readLen = Math.min(maxBytes, st.size)
    const buf = Buffer.alloc(readLen)
    let bytesRead = 0
    if (readLen > 0) ({ bytesRead } = await handle.read(buf, 0, readLen, 0))
    return {
      binary: false,
      size: st.size,
      // Decoded through a StringDecoder so a cut landing mid-codepoint holds
      // the partial sequence back instead of emitting a replacement char.
      content: decodeUtf8(buf.subarray(0, bytesRead)),
      truncated: st.size > maxBytes,
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
    raw = await execGit(rootRes.root, ['status', '--porcelain', '-z', '--untracked-files=all'])
  } catch (err) {
    if (err instanceof GitError) return { ok: false, reason: 'unreadable' }
    throw err
  }
  const status = parsePorcelainStatus(raw)
  return { ok: true, branch: rootRes.workspace.branch ?? null, ...status }
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
  const abs = await resolveWorkspaceRelPath(rootRes.root, wanted, { mustExist: false })
  // A DIRECTORY must be refused. git's pathspec matches by prefix, so `.` or
  // `src` would return a whole-subtree diff from a route that promises one
  // file, under a response that echoes the requested path. The sibling readers
  // (listDirAt / readFileAt) both assert their target type; this one must too.
  try {
    if ((await lstat(abs)).isDirectory()) {
      throw new WorkspacePathError('Not a file.')
    }
  } catch (err) {
    // A missing path is the legitimate deleted-file case; anything else rethrows.
    if (err instanceof WorkspacePathError) throw err
  }
  // Only the baseline commit is taken from loadWorktree; reads use the stored
  // worktree path. findScaffoldCommit does not depend on the worktree root.
  const wt = await loadWorktree({
    repoPath: rootRes.workspace.repoPath,
    taskId,
  })
  // :(literal) keeps a filename carrying glob characters from acting as a
  // pathspec pattern. The TRIMMED path is what was validated, so it is what git
  // gets.
  let diff: string
  try {
    diff = await execGit(rootRes.root, ['diff', wt.baseCommit, '--', `:(literal)${wanted}`])
  } catch (err) {
    if (err instanceof GitError) return { ok: false, reason: 'unreadable' }
    throw err
  }
  // Cap on BYTES, cut on a codepoint boundary: slicing the string by
  // MAX_DIFF_BYTES cuts UTF-16 code units, which overshoots the byte budget on
  // non-ASCII diffs and can split a surrogate pair.
  const bytes = Buffer.from(diff, 'utf8')
  const truncated = bytes.byteLength > MAX_DIFF_BYTES
  return {
    ok: true,
    path: wanted,
    diff: truncated ? decodeUtf8(bytes.subarray(0, MAX_DIFF_BYTES)) : diff,
    truncated,
  }
}
