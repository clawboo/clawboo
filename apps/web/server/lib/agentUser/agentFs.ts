// Files in agent space: runtime homes, work folders, anything an agent can write.
//
// With agent isolation on, the server never touches these as itself. It asks the
// agent host, which runs as the agent user, so a link an agent planted reaches
// only what the agent could reach already. (Written by the server, a config file
// in an agent-owned home that an agent had replaced with a link to the database
// would overwrite the database.)
//
// With it off these are local calls with the same flags: reads never follow a
// link at the path's end and are bounded, writes go to a fresh name renamed into
// place. So callers use them unconditionally.

import fs from 'node:fs'
import path from 'node:path'

import { appendNoFollow, readBounded, statType, toStat, writeAtomic } from '../../agentHost/fsOps'
import { isAgentPoolMode, isAgentUserMode } from './config'
import { AgentHostError } from './client'
import {
  MAX_READ_BYTES,
  MAX_WRITE_BYTES,
  type FsEntry,
  type FsStat,
  type HostOp,
  type HostReplies,
  type HostRequest,
} from './protocol'
import type { AgentHostClient } from './client'
import { hostForPath, ownerOfPathNow } from './poolRoute'
import {
  emptyFolderVia,
  ensurePoolFolder,
  listStructural,
  poolSpot,
  removeEmptiedRoot,
  removeEmptyStructural,
} from './poolShares'
import { activeAgentHost } from './state'

/** The host that may touch `p`: the one agent host, or with a user per agent
 *  the host of whoever owns `p`. */
async function hostFor(p: string): Promise<AgentHostClient> {
  if (isAgentPoolMode()) return hostForPath(p)
  return activeAgentHost().client
}

/** Send `req` to the host that may touch `p`. Inside a share, the host checks
 *  that `p` resolves inside the share's root. */
async function ask<R extends HostRequest>(
  p: string,
  req: R,
  opts: { timeoutMs?: number } = {},
): Promise<HostReplies[R['op'] & HostOp]> {
  const client = await hostFor(p)
  const spot = isAgentPoolMode() ? poolSpot(p) : null
  return client.request(req, spot?.kind === 'share' ? { ...opts, within: spot.root } : opts)
}

async function askRename(from: string, to: string): Promise<void> {
  const client = await hostForRename(from, to)
  const spot = isAgentPoolMode() ? poolSpot(from) : null
  await client.request(
    { op: 'fs.rename', from, to },
    spot?.kind === 'share' ? { within: spot.root } : {},
  )
}

/** A rename stays with one owner: across two it would hand one agent's file to
 *  another, so it is refused as a move across devices. */
async function hostForRename(from: string, to: string): Promise<AgentHostClient> {
  if (isAgentPoolMode()) {
    const a = ownerOfPathNow(from)
    const b = ownerOfPathNow(to)
    if (!a || !b || JSON.stringify(a) !== JSON.stringify(b)) {
      throw Object.assign(new Error(`${from} and ${to} belong to different agents`), {
        code: 'EXDEV',
      })
    }
  }
  return hostFor(from)
}

/**
 * The mode a file or folder in agent space is made with. Inside a share (a
 * team's folders, with a user per agent) the owner's bits are given to the
 * group too: the share's group is the team, and its root keeps everyone else
 * out. Elsewhere `mode` as asked.
 */
function shareMode(p: string, mode: number): number {
  if (!isAgentPoolMode() || poolSpot(p)?.kind !== 'share') return mode
  return mode | ((mode & 0o700) >> 3)
}

/** Whether a share root is there (the server may look: its parent is the server's). */
function poolSpotExists(root: string): boolean {
  try {
    fs.lstatSync(root)
    return true
  } catch {
    return false
  }
}

function code(err: unknown): string | undefined {
  return (err as { code?: string } | null)?.code
}

/** Make a folder and its parents; the last one gets `mode` (default 0700). */
export async function agentMkdir(dir: string, opts: { mode?: number } = {}): Promise<void> {
  const mode = (opts.mode ?? 0o700) & 0o777
  if (!isAgentUserMode()) {
    await fs.promises.mkdir(dir, { recursive: true, mode })
    const st = await fs.promises.lstat(dir)
    if (!st.isDirectory()) {
      throw Object.assign(new Error(`${dir} is not a folder`), { code: 'ENOTDIR' })
    }
    if ((st.mode & 0o777) !== mode) {
      try {
        await fs.promises.chmod(dir, mode)
      } catch (err) {
        // A filesystem without POSIX modes, or a folder of another user's: it
        // is still there to use, as `mkdir` alone left it before.
        if (!['EPERM', 'ENOTSUP', 'EOPNOTSUPP', 'EINVAL', 'ENOSYS'].includes(code(err) ?? ''))
          throw err
      }
    }
    return
  }
  // With a user per agent the server makes the work folder's own folders and
  // each share's root; a host of the share makes what is inside.
  if (isAgentPoolMode() && (await ensurePoolFolder(dir)) === 'made') return
  await ask(dir, { op: 'fs.mkdir', path: dir, mode: shareMode(dir, mode) })
}

/** Write a whole file by a fresh name renamed into place (default mode 0600). */
export async function agentWriteFile(
  file: string,
  data: string | Buffer,
  opts: { mode?: number } = {},
): Promise<void> {
  const buf = typeof data === 'string' ? Buffer.from(data, 'utf8') : data
  if (buf.length > MAX_WRITE_BYTES) {
    throw Object.assign(
      new Error(`${file}: ${buf.length} bytes is more than one write may carry`),
      { code: 'EFBIG' },
    )
  }
  const mode = (opts.mode ?? 0o600) & 0o777
  if (!isAgentUserMode()) return writeAtomic(file, buf, mode)
  await ask(file, {
    op: 'fs.write',
    path: file,
    data: buf.toString('base64'),
    mode: shareMode(file, mode),
  })
}

/** Append to a file, made with `mode` (default 0600) when missing. Never
 *  through a link at the path's end. At most 8 MB per call. */
export async function agentAppendFile(
  file: string,
  data: string | Buffer,
  opts: { mode?: number } = {},
): Promise<void> {
  const buf = typeof data === 'string' ? Buffer.from(data, 'utf8') : data
  if (buf.length > MAX_WRITE_BYTES) {
    throw Object.assign(
      new Error(`${file}: ${buf.length} bytes is more than one write may carry`),
      {
        code: 'EFBIG',
      },
    )
  }
  const mode = (opts.mode ?? 0o600) & 0o777
  if (!isAgentUserMode()) return appendNoFollow(file, buf, mode)
  await ask(file, {
    op: 'fs.append',
    path: file,
    data: buf.toString('base64'),
    mode: shareMode(file, mode),
  })
}

/**
 * Read a regular file, at most `maxBytes` (default and cap 8 MB). Null when it
 * does not exist. A link at the path's end, or anything but a regular file, is
 * refused.
 */
export async function agentReadFile(
  file: string,
  opts: { maxBytes?: number; offset?: number } = {},
): Promise<Buffer | null> {
  const max = Math.max(0, Math.min(opts.maxBytes ?? MAX_READ_BYTES, MAX_READ_BYTES))
  const offset = Math.max(0, Math.floor(opts.offset ?? 0))
  if (!isAgentUserMode()) {
    try {
      return readBounded(file, max, offset).data
    } catch (err) {
      if (code(err) === 'ENOENT') return null
      throw err
    }
  }
  const res = await ask(file, {
    op: 'fs.read',
    path: file,
    maxBytes: max,
    ...(offset > 0 ? { offset } : {}),
  })
  if (res.missing) return null
  if (typeof res.data !== 'string') throw new AgentHostError('the agent host sent a malformed read')
  const buf = Buffer.from(res.data, 'base64')
  // The host is on the agents' side: never take more than was asked for.
  return buf.length > max ? buf.subarray(0, max) : buf
}

/** Remove a file or a folder tree; a link is removed, never followed. Missing is fine. */
export async function agentRemove(target: string): Promise<void> {
  if (!isAgentUserMode()) {
    await fs.promises.rm(target, { recursive: true, force: true })
    return
  }
  if (isAgentPoolMode()) {
    const spot = poolSpot(target)
    if (spot?.kind === 'structural') {
      throw Object.assign(new Error(`${target} is one of the work folder's own folders`), {
        code: 'EPERM',
      })
    }
    if (spot?.kind === 'share' && path.resolve(target) === spot.root) {
      // The host empties the root; its folder sits in one of the server's, so
      // the root itself goes last, by the server, once empty.
      if (!poolSpotExists(target)) return
      await emptyFolderVia(await hostFor(target), target, target)
      removeEmptiedRoot(target)
      return
    }
  }
  // A whole checkout can take a while to remove on a busy machine.
  await ask(target, { op: 'fs.rm', path: target }, { timeoutMs: 10 * 60_000 })
}

/**
 * Remove a folder only when it is empty: anything in it, or a link at the path,
 * fails and removes nothing. For folders that may hold a person's documents,
 * where `agentRemove` would take everything.
 */
export async function agentRemoveEmptyDir(dir: string): Promise<void> {
  if (!isAgentUserMode()) {
    if (!(await fs.promises.lstat(dir)).isDirectory()) {
      throw Object.assign(new Error(`${dir} is not a folder`), { code: 'ENOTDIR' })
    }
    await fs.promises.rmdir(dir)
    return
  }
  if (isAgentPoolMode()) {
    const spot = poolSpot(dir)
    if (
      spot?.kind === 'structural' ||
      (spot?.kind === 'share' && path.resolve(dir) === spot.root)
    ) {
      removeEmptyStructural(dir)
      return
    }
  }
  await ask(dir, { op: 'fs.rmdir', path: dir })
}

/** Rename within agent space. */
export async function agentRename(from: string, to: string): Promise<void> {
  if (!isAgentUserMode()) {
    await fs.promises.rename(from, to)
    return
  }
  await askRename(from, to)
}

/** What is at a path, without following a link there. Null when nothing is. */
export async function agentStat(p: string): Promise<FsStat | null> {
  if (!isAgentUserMode()) {
    try {
      return toStat(await fs.promises.lstat(p))
    } catch (err) {
      if (code(err) === 'ENOENT') return null
      throw err
    }
  }
  if (isAgentPoolMode() && poolSpot(p)?.kind === 'structural') {
    try {
      return toStat(await fs.promises.lstat(path.resolve(p)))
    } catch (err) {
      if (code(err) === 'ENOENT') return null
      throw err
    }
  }
  const res = await ask(p, { op: 'fs.stat', path: p })
  // The host is on the agents' side: a reply without the field is not "nothing there".
  if (res.stat === null) return null
  if (!isFsStat(res.stat)) throw new AgentHostError('the agent host sent a malformed stat')
  return res.stat
}

/**
 * `p` with every link in it resolved, as the agent user sees it. Rejects with
 * `ENOENT` when nothing is there. What the host answers is data: an absolute
 * path of bounded length, used for comparing paths, never as a place to write.
 */
export async function agentRealpath(p: string): Promise<string> {
  if (!isAgentUserMode()) return fs.promises.realpath(p)
  if (isAgentPoolMode() && poolSpot(p)?.kind === 'structural')
    return fs.promises.realpath(path.resolve(p))
  const res = await ask(p, { op: 'fs.realpath', path: p })
  if (typeof res.path !== 'string' || !path.isAbsolute(res.path) || res.path.length > 4096) {
    throw new AgentHostError('the agent host sent a malformed path')
  }
  return res.path
}

/** A folder's entries, sorted by name, at most `max` (default 10,000). */
export async function agentList(
  dir: string,
  opts: { max?: number } = {},
): Promise<{ entries: FsEntry[]; truncated: boolean }> {
  const max = Math.max(0, Math.min(opts.max ?? 10_000, 100_000))
  if (!isAgentUserMode()) return listDirLocal(dir, max)
  if (isAgentPoolMode() && poolSpot(dir)?.kind === 'structural') return listStructural(dir, max)
  const res = await ask(dir, { op: 'fs.list', path: dir, max })
  if (!Array.isArray(res.entries) || !res.entries.every(isFsEntry)) {
    throw new AgentHostError('the agent host sent a malformed listing')
  }
  const entries = res.entries.slice(0, max)
  return { entries, truncated: res.truncated === true || entries.length < res.entries.length }
}

const FS_TYPES = new Set(['file', 'dir', 'link', 'other'])

function isFsStat(v: unknown): v is FsStat {
  const o = v as Record<string, unknown> | null
  return (
    !!o &&
    typeof o === 'object' &&
    FS_TYPES.has(o['type'] as string) &&
    typeof o['size'] === 'number' &&
    typeof o['mtimeMs'] === 'number' &&
    typeof o['mode'] === 'number' &&
    typeof o['uid'] === 'number' &&
    typeof o['nlink'] === 'number'
  )
}

function isFsEntry(v: unknown): v is FsEntry {
  const o = v as Record<string, unknown> | null
  return (
    !!o &&
    typeof o === 'object' &&
    typeof o['name'] === 'string' &&
    o['name'] !== '' &&
    o['name'] !== '.' &&
    o['name'] !== '..' &&
    !(o['name'] as string).includes('/') &&
    FS_TYPES.has(o['type'] as string) &&
    typeof o['size'] === 'number' &&
    typeof o['mtimeMs'] === 'number'
  )
}

/** A folder's entries, sorted, without following links or blocking. */
async function listDirLocal(
  dir: string,
  max: number,
): Promise<{ entries: FsEntry[]; truncated: boolean }> {
  const names = (await fs.promises.readdir(dir)).sort()
  const entries: FsEntry[] = []
  for (const name of names.slice(0, max)) {
    try {
      const st = await fs.promises.lstat(path.join(dir, name))
      entries.push({ name, type: statType(st), size: st.size, mtimeMs: st.mtimeMs })
    } catch {
      /* gone between the listing and the stat */
    }
  }
  return { entries, truncated: names.length > max }
}
