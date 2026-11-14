// Reads and writes of the task files clawboo keeps at the top of a checkout or
// team folder (AGENT_HANDOFF.json, init.sh, task-progress.md, VERIFICATION.md).
//
// The agent owns the folder these files sit in and writes it while clawboo
// reads it, so any of them can be swapped for a link, or a hard link, to a file
// the server can open: its database, its vault key. A plain `readFile` or
// `appendFile` would follow the link and read or write that file instead.
// These helpers open the file itself and refuse it unless it is a regular file
// with no other name:
// - before the open, `lstat` on the name must show a regular file, not a link;
// - the open adds `O_NOFOLLOW` where the platform has it, so a link put at the
//   name after that check fails the open (Windows has no such flag, and the
//   check after the open covers it there);
// - `O_NONBLOCK` keeps a named pipe swapped in from hanging the open;
// - after the open, `fstat` on the handle must show a regular file with one
//   link and the same file `lstat` saw (device and file id), so a hard link to
//   another file, or anything swapped in between the two, is refused too. The
//   handle is then the file that was checked, whatever happens to the name.
// A missing file is created with `O_CREAT | O_EXCL | O_NOFOLLOW`, which fails on
// anything already at the name, a link that points nowhere included. Windows
// has no `O_NOFOLLOW`, and there an exclusive create follows such a link and
// creates its target, so there the file is made empty under a new random name
// and hard-linked to the name, which fails on anything already there.
// A write goes to a new file of a random name that is then renamed over the
// old one, so whatever was at the name is replaced, never written through.
//
// That is what runs here (`localWorktreeIo`). An installed `WorktreeIo` may do
// these operations somewhere else instead, such as through a process running as
// the OS user that owns the folder (see `io.ts`).

import { randomBytes } from 'node:crypto'
import { constants, type BigIntStats } from 'node:fs'
import { link, lstat, open, rename, rm, type FileHandle } from 'node:fs/promises'
import path from 'node:path'

import { getWorktreeIo } from './io'

const NOFOLLOW = constants.O_NOFOLLOW ?? 0
const NONBLOCK = constants.O_NONBLOCK ?? 0

/** The most a task file read takes in: these are small text files. */
export const TASK_FILE_MAX_BYTES = 1024 * 1024

/** Thrown for a task file that is a link, not a regular file, linked to another
 *  name, or too large. Nothing was read or written. */
export class UnsafeTaskFileError extends Error {
  readonly filePath: string
  constructor(filePath: string, why: string) {
    super(`refused ${filePath}: ${why}`)
    this.name = 'UnsafeTaskFileError'
    this.filePath = filePath
  }
}

/** `name` under `dir`, refusing anything but one plain path segment. */
function fileIn(dir: string, name: string): string {
  if (!name || name === '.' || name === '..' || /[\\/]/.test(name)) {
    throw new Error(`not a file name: ${JSON.stringify(name)}`)
  }
  return path.join(dir, name)
}

/** What is at `filePath` itself, not following a link there. Throws `lstat`'s
 *  error (`ENOENT` when nothing is), or {@link UnsafeTaskFileError} unless it
 *  is a regular file. */
async function plainFileAt(filePath: string): Promise<BigIntStats> {
  const st = await lstat(filePath, { bigint: true })
  if (st.isSymbolicLink()) throw new UnsafeTaskFileError(filePath, 'it is a link')
  if (!st.isFile()) throw new UnsafeTaskFileError(filePath, 'it is not a regular file')
  return st
}

function isMissing(err: unknown): boolean {
  return (err as NodeJS.ErrnoException).code === 'ENOENT'
}

/** The open file must be a regular file with one name and, when `seen` is
 *  given, the file `lstat` found at the name before the open. Returns its size. */
async function assertPlainFile(
  handle: FileHandle,
  filePath: string,
  seen: BigIntStats | null,
): Promise<bigint> {
  const st = await handle.stat({ bigint: true })
  if (!st.isFile()) throw new UnsafeTaskFileError(filePath, 'it is not a regular file')
  if (st.nlink > 1n) {
    throw new UnsafeTaskFileError(filePath, 'it has another name (a hard link)')
  }
  if (seen && (st.dev !== seen.dev || st.ino !== seen.ino)) {
    throw new UnsafeTaskFileError(filePath, 'it was replaced while it was being opened')
  }
  return st.size
}

/**
 * The UTF-8 text of `name` directly under `dir`. Throws `ENOENT` when it is
 * missing, {@link UnsafeTaskFileError} for a link or anything else refused, or
 * the open's own error (`ELOOP` for a link put at the name meanwhile).
 */
export async function readTaskFile(
  dir: string,
  name: string,
  maxBytes: number = TASK_FILE_MAX_BYTES,
): Promise<string> {
  fileIn(dir, name)
  return getWorktreeIo().readTaskFile(dir, name, maxBytes)
}

/**
 * Replace `name` directly under `dir` with `content`. Written to a new file
 * first and renamed into place, so a link or hard link at the name is
 * replaced rather than written through.
 */
export async function replaceTaskFile(dir: string, name: string, content: string): Promise<void> {
  fileIn(dir, name)
  return getWorktreeIo().replaceTaskFile(dir, name, content)
}

/**
 * Append `content` to `name` directly under `dir`, creating it when missing.
 * Refuses a link (including one that points nowhere yet), anything but a
 * regular file, and a file with another name.
 */
export async function appendTaskFile(dir: string, name: string, content: string): Promise<void> {
  fileIn(dir, name)
  return getWorktreeIo().appendTaskFile(dir, name, content)
}

/** {@link readTaskFile}, run here. */
export async function localReadTaskFile(
  dir: string,
  name: string,
  maxBytes: number = TASK_FILE_MAX_BYTES,
): Promise<string> {
  const filePath = fileIn(dir, name)
  const seen = await plainFileAt(filePath)
  const handle = await open(filePath, constants.O_RDONLY | NOFOLLOW | NONBLOCK)
  try {
    const big = await assertPlainFile(handle, filePath, seen)
    if (big > BigInt(maxBytes)) {
      throw new UnsafeTaskFileError(filePath, `it is larger than ${maxBytes} bytes`)
    }
    const size = Number(big)
    const buf = Buffer.alloc(size)
    // A read may return fewer bytes than asked before the end: read on.
    let got = 0
    while (got < size) {
      const { bytesRead } = await handle.read(buf, got, size - got, got)
      if (bytesRead === 0) break
      got += bytesRead
    }
    return buf.subarray(0, got).toString('utf8')
  } finally {
    await handle.close()
  }
}

/** {@link replaceTaskFile}, run here. */
export async function localReplaceTaskFile(
  dir: string,
  name: string,
  content: string,
): Promise<void> {
  const target = fileIn(dir, name)
  const temp = path.join(dir, `.${name}.${randomBytes(6).toString('hex')}.tmp`)
  const handle = await open(
    temp,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | NOFOLLOW,
    0o666,
  )
  try {
    try {
      await handle.writeFile(content, 'utf8')
    } finally {
      await handle.close()
    }
    await rename(temp, target)
  } catch (err) {
    // Not left behind in the agent's folder; the first error is the one thrown.
    await rm(temp, { force: true }).catch(() => undefined)
    throw err
  }
}

/** {@link appendTaskFile}, run here. */
export async function localAppendTaskFile(
  dir: string,
  name: string,
  content: string,
): Promise<void> {
  const filePath = fileIn(dir, name)
  let seen: BigIntStats
  try {
    seen = await plainFileAt(filePath)
  } catch (err) {
    if (!isMissing(err)) throw err
    await createEmptyAt(dir, name, filePath)
    // Ours, or whatever got there first: checked the same way.
    seen = await plainFileAt(filePath)
  }
  const handle = await open(filePath, constants.O_WRONLY | constants.O_APPEND | NOFOLLOW | NONBLOCK)
  try {
    await assertPlainFile(handle, filePath, seen)
    // writeFile, not write: it writes on until every byte is out. The handle is
    // open for appending, so it adds to the end.
    await handle.writeFile(content, 'utf8')
  } finally {
    await handle.close()
  }
}

/** An empty file at `filePath`, unless something is there already. Never
 *  through a link at `filePath`; the caller checks whatever is there next. */
async function createEmptyAt(dir: string, name: string, filePath: string): Promise<void> {
  if (NOFOLLOW !== 0) {
    try {
      const handle = await open(
        filePath,
        constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | NOFOLLOW | NONBLOCK,
        0o666,
      )
      await handle.close()
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err
    }
    return
  }
  await createEmptyByLink(dir, name, filePath)
}

/** {@link createEmptyAt} where the platform has no `O_NOFOLLOW`: made under a new
 *  random name and hard-linked to `filePath`. The name must then be the very
 *  file that was made: the agent could swap the temp name for a link in between. */
async function createEmptyByLink(dir: string, name: string, filePath: string): Promise<void> {
  const temp = path.join(dir, `.${name}.${randomBytes(6).toString('hex')}.tmp`)
  const handle = await open(temp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o666)
  let made: BigIntStats
  try {
    try {
      made = await handle.stat({ bigint: true })
    } finally {
      await handle.close()
    }
  } catch (err) {
    // Not left behind in the agent's folder; the first error is the one thrown.
    await rm(temp, { force: true }).catch(() => undefined)
    throw err
  }
  try {
    await link(temp, filePath)
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'EEXIST') return // checked by the caller
    throw err
  } finally {
    await rm(temp, { force: true })
  }
  const named = await lstat(filePath, { bigint: true })
  if (named.dev !== made.dev || named.ino !== made.ino) {
    throw new UnsafeTaskFileError(
      filePath,
      'the file made for it was replaced before it got its name',
    )
  }
}
