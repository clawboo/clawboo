// File operations shared by the agent host and the server's local branch of the
// agent-space file verbs (`lib/agentUser/agentFs.ts`), so a read or write in
// agent space behaves the same whichever side performs it. Node built-ins only.

import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

import { MAX_READ_BYTES, type FsEntry, type FsStat } from '../lib/agentUser/protocol'

export function statType(st: fs.Stats | fs.BigIntStats): FsStat['type'] {
  if (st.isSymbolicLink()) return 'link'
  if (st.isFile()) return 'file'
  if (st.isDirectory()) return 'dir'
  return 'other'
}

export function toStat(st: fs.Stats): FsStat {
  return {
    type: statType(st),
    size: st.size,
    mtimeMs: st.mtimeMs,
    mode: st.mode & 0o7777,
    uid: st.uid,
    nlink: st.nlink,
  }
}

export const O_NOFOLLOW = fs.constants.O_NOFOLLOW ?? 0
export const O_NONBLOCK = fs.constants.O_NONBLOCK ?? 0

/** Read at most `maxBytes` of a regular file, never through a link at the path's end. */
export function readBounded(
  p: string,
  maxBytes: number,
): { data: Buffer; size: number; truncated: boolean } {
  const fd = fs.openSync(p, fs.constants.O_RDONLY | O_NOFOLLOW | O_NONBLOCK)
  try {
    const st = fs.fstatSync(fd)
    if (!st.isFile()) {
      throw Object.assign(new Error(`${p} is not a regular file`), { code: 'ENOTFILE' })
    }
    const want = Math.max(0, Math.min(maxBytes, MAX_READ_BYTES, st.size))
    const buf = Buffer.alloc(want)
    let got = 0
    while (got < want) {
      const n = fs.readSync(fd, buf, got, want - got, got)
      if (n === 0) break
      got += n
    }
    return { data: buf.subarray(0, got), size: st.size, truncated: st.size > got }
  } finally {
    fs.closeSync(fd)
  }
}

/** Write a file by a fresh name in the same folder, renamed over the target: a
 *  link already at the target is replaced, never followed. */
export function writeAtomic(p: string, data: Buffer, mode: number): void {
  const dir = path.dirname(p)
  const tmp = path.join(dir, `.${path.basename(p)}.${crypto.randomBytes(6).toString('hex')}.tmp`)
  const fd = fs.openSync(
    tmp,
    fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | O_NOFOLLOW,
    mode,
  )
  try {
    let off = 0
    while (off < data.length) off += fs.writeSync(fd, data, off, data.length - off)
    fs.fchmodSync(fd, mode)
  } catch (err) {
    fs.closeSync(fd)
    fs.rmSync(tmp, { force: true })
    throw err
  }
  fs.closeSync(fd)
  try {
    fs.renameSync(tmp, p)
  } catch (err) {
    fs.rmSync(tmp, { force: true })
    throw err
  }
}

/** Make a folder (and its parents) and give the last one exactly `mode`. */
export function mkdirMode(p: string, mode: number): void {
  fs.mkdirSync(p, { recursive: true, mode })
  const st = fs.lstatSync(p)
  if (!st.isDirectory()) throw Object.assign(new Error(`${p} is not a folder`), { code: 'ENOTDIR' })
  if ((st.mode & 0o777) !== mode) fs.chmodSync(p, mode)
}

/** A folder's entries, sorted by name, without following links. */
export function listDir(dir: string, max: number): { entries: FsEntry[]; truncated: boolean } {
  const names = fs.readdirSync(dir).sort()
  const entries: FsEntry[] = []
  for (const name of names.slice(0, max)) {
    try {
      const st = fs.lstatSync(path.join(dir, name))
      entries.push({ name, type: statType(st), size: st.size, mtimeMs: st.mtimeMs })
    } catch {
      /* gone between the listing and the stat */
    }
  }
  return { entries, truncated: names.length > max }
}
