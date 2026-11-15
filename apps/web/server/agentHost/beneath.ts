// File operations that stay beneath a share's root, on Linux.
//
// A share (a team's folder, with a user per agent) is written by every member,
// so a teammate can swap one of its folders for a link at any moment, also
// between a check and the operation that follows. Node has no openat, but
// Linux's `/proc/self/fd/<fd>/<name>` gives the same: the kernel takes the
// folder `<fd>` was opened on, not a path, and looks `<name>` up inside it.
// So each folder is opened from the one before with O_DIRECTORY | O_NOFOLLOW
// (a link there fails the open), and every operation acts on its last part
// through the descriptor of its folder. Nothing is looked up by path below
// the root, so no swap can carry an operation elsewhere.
//
// Used by the agent host when a request carries `within`; elsewhere it is not
// available (`beneathAvailable`), and the host refuses such a request on Linux.

import crypto from 'node:crypto'
import fs from 'node:fs'

import { MAX_READ_BYTES, type FsEntry, type FsStat } from '../lib/agentUser/protocol'
import { O_NONBLOCK, O_NOFOLLOW, chmodBestEffort, statType, toStat } from './fsOps'

const DIR = fs.constants.O_RDONLY | (fs.constants.O_DIRECTORY ?? 0) | O_NOFOLLOW

/** Whether descriptor-relative lookups work here (Linux with /proc). */
export function beneathAvailable(): boolean {
  return process.platform === 'linux' && fs.existsSync('/proc/self/fd')
}

/** The path the kernel resolves through descriptor `fd` (then `name` inside it). */
function at(fd: number, name?: string): string {
  return name === undefined ? `/proc/self/fd/${fd}` : `/proc/self/fd/${fd}/${name}`
}

function code(err: unknown): string | undefined {
  return (err as { code?: string } | null)?.code
}

function refused(what: string): Error {
  return Object.assign(
    new Error(`${what} is a link or not a folder, so it leads outside its share`),
    {
      code: 'EACCES',
    },
  )
}

/** One plain name: never `.`, `..`, empty, or with a separator in it. */
function checkName(name: string): void {
  if (!name || name === '.' || name === '..' || name.includes('/') || name.includes('\0')) {
    throw Object.assign(new Error(`${JSON.stringify(name)} is not a plain name`), {
      code: 'EACCES',
    })
  }
}

/**
 * Open the folder `parts` below `realRoot`, one folder at a time, each from
 * the one before and never through a link. `create`: make a missing folder
 * with that mode on the way. The caller closes the descriptor.
 */
export function openDirBeneath(
  realRoot: string,
  parts: readonly string[],
  create: number | null,
): number {
  let fd = fs.openSync(realRoot, DIR)
  try {
    for (const part of parts) {
      checkName(part)
      let next: number
      try {
        next = fs.openSync(at(fd, part), DIR)
      } catch (err) {
        if (create === null || code(err) !== 'ENOENT') {
          throw code(err) === 'ELOOP' || code(err) === 'ENOTDIR' ? refused(part) : err
        }
        try {
          fs.mkdirSync(at(fd, part), { mode: create })
        } catch (e) {
          if (code(e) !== 'EEXIST') throw e
        }
        try {
          next = fs.openSync(at(fd, part), DIR)
        } catch (e) {
          throw code(e) === 'ELOOP' || code(e) === 'ENOTDIR' ? refused(part) : e
        }
      }
      fs.closeSync(fd)
      fd = next
    }
    return fd
  } catch (err) {
    fs.closeSync(fd)
    throw err
  }
}

/** Run `fn` with the descriptor of the folder holding the last part, and that part. */
function withParent<T>(
  realRoot: string,
  parts: readonly string[],
  fn: (dirFd: number, name: string) => T,
): T {
  if (parts.length === 0) {
    throw Object.assign(new Error("the share's root itself is not touched this way"), {
      code: 'EPERM',
    })
  }
  const name = parts[parts.length - 1]!
  checkName(name)
  const dirFd = openDirBeneath(realRoot, parts.slice(0, -1), null)
  try {
    return fn(dirFd, name)
  } finally {
    fs.closeSync(dirFd)
  }
}

export function beneathRead(
  realRoot: string,
  parts: readonly string[],
  maxBytes: number,
  offset: number,
): { data: Buffer; size: number; truncated: boolean } {
  return withParent(realRoot, parts, (dirFd, name) => {
    const fd = fs.openSync(at(dirFd, name), fs.constants.O_RDONLY | O_NOFOLLOW | O_NONBLOCK)
    try {
      const st = fs.fstatSync(fd)
      if (!st.isFile())
        throw Object.assign(new Error(`${name} is not a regular file`), { code: 'ENOTFILE' })
      const start = Math.max(0, Math.min(offset, st.size))
      const want = Math.max(0, Math.min(maxBytes, MAX_READ_BYTES, st.size - start))
      const buf = Buffer.alloc(want)
      let got = 0
      while (got < want) {
        const n = fs.readSync(fd, buf, got, want - got, start + got)
        if (n === 0) break
        got += n
      }
      return { data: buf.subarray(0, got), size: st.size, truncated: st.size > start + got }
    } finally {
      fs.closeSync(fd)
    }
  })
}

/** Write a whole file by a fresh name renamed over it, both in its folder's descriptor. */
export function beneathWrite(
  realRoot: string,
  parts: readonly string[],
  data: Buffer,
  mode: number,
  strictOwnerOnly: boolean,
): void {
  withParent(realRoot, parts, (dirFd, name) => {
    const tmp = `.${name}.${crypto.randomBytes(6).toString('hex')}.tmp`
    const fd = fs.openSync(
      at(dirFd, tmp),
      fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | O_NOFOLLOW,
      mode,
    )
    try {
      let off = 0
      while (off < data.length) off += fs.writeSync(fd, data, off, data.length - off)
      if (strictOwnerOnly && (mode & 0o077) === 0) fs.fchmodSync(fd, mode)
      else chmodBestEffort(() => fs.fchmodSync(fd, mode))
    } catch (err) {
      fs.closeSync(fd)
      fs.rmSync(at(dirFd, tmp), { force: true })
      throw err
    }
    fs.closeSync(fd)
    try {
      fs.renameSync(at(dirFd, tmp), at(dirFd, name))
    } catch (err) {
      fs.rmSync(at(dirFd, tmp), { force: true })
      throw err
    }
  })
}

export function beneathAppend(
  realRoot: string,
  parts: readonly string[],
  data: Buffer,
  mode: number,
): void {
  withParent(realRoot, parts, (dirFd, name) => {
    const fd = fs.openSync(
      at(dirFd, name),
      fs.constants.O_WRONLY |
        fs.constants.O_APPEND |
        fs.constants.O_CREAT |
        O_NOFOLLOW |
        O_NONBLOCK,
      mode,
    )
    try {
      if (!fs.fstatSync(fd).isFile()) {
        throw Object.assign(new Error(`${name} is not a regular file`), { code: 'ENOTFILE' })
      }
      let off = 0
      while (off < data.length) off += fs.writeSync(fd, data, off, data.length - off)
    } finally {
      fs.closeSync(fd)
    }
  })
}

/** Make the folder and the ones above it, part by part, and give the last `mode`. */
export function beneathMkdir(realRoot: string, parts: readonly string[], mode: number): void {
  const fd = openDirBeneath(realRoot, parts, mode)
  try {
    chmodBestEffort(() => fs.fchmodSync(fd, mode))
  } finally {
    fs.closeSync(fd)
  }
}

/** Remove `name` in `dirFd` and, if it is a folder, everything in it, never through a link. */
async function removeAt(dirFd: number, name: string): Promise<void> {
  let st: fs.Stats
  try {
    st = await fs.promises.lstat(at(dirFd, name))
  } catch (err) {
    if (code(err) === 'ENOENT') return
    throw err
  }
  if (!st.isDirectory()) {
    // A file or a link: the name goes, a link's target is never touched.
    await fs.promises.unlink(at(dirFd, name)).catch((err: unknown) => {
      if (code(err) !== 'ENOENT') throw err
    })
    return
  }
  let childFd: number
  try {
    childFd = fs.openSync(at(dirFd, name), DIR)
  } catch (err) {
    // Swapped for a link since the look: remove the link, never its target.
    if (code(err) === 'ELOOP' || code(err) === 'ENOTDIR') {
      await fs.promises.unlink(at(dirFd, name))
      return
    }
    throw err
  }
  try {
    for (const entry of await fs.promises.readdir(at(childFd))) await removeAt(childFd, entry)
  } finally {
    fs.closeSync(childFd)
  }
  await fs.promises.rmdir(at(dirFd, name))
}

export async function beneathRm(realRoot: string, parts: readonly string[]): Promise<void> {
  if (parts.length === 0) {
    throw Object.assign(new Error("the share's root itself is not removed this way"), {
      code: 'EPERM',
    })
  }
  let dirFd: number
  try {
    dirFd = openDirBeneath(realRoot, parts.slice(0, -1), null)
  } catch (err) {
    if (code(err) === 'ENOENT') return
    throw err
  }
  try {
    const name = parts[parts.length - 1]!
    checkName(name)
    await removeAt(dirFd, name)
  } finally {
    fs.closeSync(dirFd)
  }
}

export function beneathRmdir(realRoot: string, parts: readonly string[]): void {
  withParent(realRoot, parts, (dirFd, name) => {
    if (!fs.lstatSync(at(dirFd, name)).isDirectory()) {
      throw Object.assign(new Error(`${name} is not a folder`), { code: 'ENOTDIR' })
    }
    fs.rmdirSync(at(dirFd, name))
  })
}

export function beneathRename(
  realRoot: string,
  from: readonly string[],
  to: readonly string[],
): void {
  withParent(realRoot, from, (fromFd, fromName) => {
    withParent(realRoot, to, (toFd, toName) => {
      fs.renameSync(at(fromFd, fromName), at(toFd, toName))
    })
  })
}

export function beneathStat(realRoot: string, parts: readonly string[]): FsStat | null {
  try {
    if (parts.length === 0) return toStat(fs.lstatSync(realRoot))
    return withParent(realRoot, parts, (dirFd, name) => toStat(fs.lstatSync(at(dirFd, name))))
  } catch (err) {
    if (code(err) === 'ENOENT') return null
    throw err
  }
}

export function beneathList(
  realRoot: string,
  parts: readonly string[],
  max: number,
): { entries: FsEntry[]; truncated: boolean } {
  const fd = openDirBeneath(realRoot, parts, null)
  try {
    const names = fs.readdirSync(at(fd)).sort()
    const entries: FsEntry[] = []
    for (const name of names.slice(0, max)) {
      try {
        const st = fs.lstatSync(at(fd, name))
        entries.push({ name, type: statType(st), size: st.size, mtimeMs: st.mtimeMs })
      } catch {
        /* gone between the listing and the look */
      }
    }
    return { entries, truncated: names.length > max }
  } finally {
    fs.closeSync(fd)
  }
}

/** The real path of `parts`, found through descriptors; a link at its end is refused. */
export function beneathRealpath(realRoot: string, parts: readonly string[]): string {
  if (parts.length === 0) return realRoot
  return withParent(realRoot, parts, (dirFd, name) => {
    if (fs.lstatSync(at(dirFd, name)).isSymbolicLink()) throw refused(name)
    return `${fs.readlinkSync(at(dirFd))}/${name}`
  })
}
