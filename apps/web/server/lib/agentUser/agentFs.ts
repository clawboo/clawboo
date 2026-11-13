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
import { isAgentUserMode } from './config'
import { AgentHostError } from './client'
import { MAX_READ_BYTES, MAX_WRITE_BYTES, type FsEntry, type FsStat } from './protocol'
import { activeAgentHost } from './state'

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
  await activeAgentHost().client.request({ op: 'fs.mkdir', path: dir, mode })
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
  await activeAgentHost().client.request({
    op: 'fs.write',
    path: file,
    data: buf.toString('base64'),
    mode,
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
  await activeAgentHost().client.request({
    op: 'fs.append',
    path: file,
    data: buf.toString('base64'),
    mode,
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
  const res = await activeAgentHost().client.request({
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
  // A whole checkout can take a while to remove on a busy machine.
  await activeAgentHost().client.request({ op: 'fs.rm', path: target }, { timeoutMs: 10 * 60_000 })
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
  await activeAgentHost().client.request({ op: 'fs.rmdir', path: dir })
}

/** Rename within agent space. */
export async function agentRename(from: string, to: string): Promise<void> {
  if (!isAgentUserMode()) {
    await fs.promises.rename(from, to)
    return
  }
  await activeAgentHost().client.request({ op: 'fs.rename', from, to })
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
  const res = await activeAgentHost().client.request({ op: 'fs.stat', path: p })
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
  const res = await activeAgentHost().client.request({ op: 'fs.realpath', path: p })
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
  const res = await activeAgentHost().client.request({ op: 'fs.list', path: dir, max })
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
