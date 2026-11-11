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

import { listDir, mkdirMode, readBounded, toStat, writeAtomic } from '../../agentHost/fsOps'
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
  if (!isAgentUserMode()) return mkdirMode(dir, mode)
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

/**
 * Read a regular file, at most `maxBytes` (default and cap 8 MB). Null when it
 * does not exist. A link at the path's end, or anything but a regular file, is
 * refused.
 */
export async function agentReadFile(
  file: string,
  opts: { maxBytes?: number } = {},
): Promise<Buffer | null> {
  const max = Math.max(0, Math.min(opts.maxBytes ?? MAX_READ_BYTES, MAX_READ_BYTES))
  if (!isAgentUserMode()) {
    try {
      return readBounded(file, max).data
    } catch (err) {
      if (code(err) === 'ENOENT') return null
      throw err
    }
  }
  const res = await activeAgentHost().client.request({ op: 'fs.read', path: file, maxBytes: max })
  if (res.missing) return null
  if (typeof res.data !== 'string') throw new AgentHostError('the agent host sent a malformed read')
  const buf = Buffer.from(res.data, 'base64')
  // The host is on the agents' side: never take more than was asked for.
  return buf.length > max ? buf.subarray(0, max) : buf
}

/** Remove a file or a folder tree; a link is removed, never followed. Missing is fine. */
export async function agentRemove(target: string): Promise<void> {
  if (!isAgentUserMode()) {
    fs.rmSync(target, { recursive: true, force: true })
    return
  }
  await activeAgentHost().client.request({ op: 'fs.rm', path: target })
}

/** Rename within agent space. */
export async function agentRename(from: string, to: string): Promise<void> {
  if (!isAgentUserMode()) {
    fs.renameSync(from, to)
    return
  }
  await activeAgentHost().client.request({ op: 'fs.rename', from, to })
}

/** What is at a path, without following a link there. Null when nothing is. */
export async function agentStat(p: string): Promise<FsStat | null> {
  if (!isAgentUserMode()) {
    try {
      return toStat(fs.lstatSync(p))
    } catch (err) {
      if (code(err) === 'ENOENT') return null
      throw err
    }
  }
  const res = await activeAgentHost().client.request({ op: 'fs.stat', path: p })
  return res.stat ?? null
}

/** A folder's entries, sorted by name, at most `max` (default 10,000). */
export async function agentList(
  dir: string,
  opts: { max?: number } = {},
): Promise<{ entries: FsEntry[]; truncated: boolean }> {
  const max = Math.max(0, Math.min(opts.max ?? 10_000, 100_000))
  if (!isAgentUserMode()) return listDir(dir, max)
  const res = await activeAgentHost().client.request({ op: 'fs.list', path: dir, max })
  const entries = Array.isArray(res.entries) ? res.entries.slice(0, max) : []
  return {
    entries,
    truncated: res.truncated === true || entries.length < (res.entries?.length ?? 0),
  }
}
