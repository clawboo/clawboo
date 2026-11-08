// Reads and writes of the task files clawboo keeps at the top of a checkout or
// team folder (AGENT_HANDOFF.json, init.sh, task-progress.md, VERIFICATION.md).
//
// The agent owns the folder these files sit in and writes it while clawboo
// reads it, so any of them can be swapped for a link, or a hard link, to a file
// the server can open: its database, its vault key. A plain `readFile` or
// `appendFile` would follow the link and read or write that file instead.
// These helpers open the file itself and refuse it unless it is a regular file
// with no other name:
// - `O_NOFOLLOW` refuses a link as the file (Windows has no such flag; there a
//   link needs rights an agent does not normally have);
// - `O_NONBLOCK` keeps a named pipe swapped in from hanging the open;
// - after the open, `fstat` on the handle must show a regular file with one
//   link, so a hard link to another file is refused too. The handle is then the
//   file that was checked, whatever happens to the name.
// A write goes to a new file of a random name that is then renamed over the
// old one, so whatever was at the name is replaced, never written through.

import { randomBytes } from 'node:crypto'
import { constants } from 'node:fs'
import { open, rename, rm, type FileHandle } from 'node:fs/promises'
import path from 'node:path'

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

async function assertPlainFile(handle: FileHandle, filePath: string): Promise<number> {
  const st = await handle.stat()
  if (!st.isFile()) throw new UnsafeTaskFileError(filePath, 'it is not a regular file')
  if (st.nlink > 1) {
    throw new UnsafeTaskFileError(filePath, 'it has another name (a hard link)')
  }
  return st.size
}

/**
 * The UTF-8 text of `name` directly under `dir`. Throws the open's own error
 * (`ENOENT` when it is missing, `ELOOP` for a link) or {@link UnsafeTaskFileError}.
 */
export async function readTaskFile(
  dir: string,
  name: string,
  maxBytes: number = TASK_FILE_MAX_BYTES,
): Promise<string> {
  const filePath = fileIn(dir, name)
  const handle = await open(filePath, constants.O_RDONLY | NOFOLLOW | NONBLOCK)
  try {
    const size = await assertPlainFile(handle, filePath)
    if (size > maxBytes) {
      throw new UnsafeTaskFileError(filePath, `it is larger than ${maxBytes} bytes`)
    }
    const buf = Buffer.alloc(size)
    const { bytesRead } = size > 0 ? await handle.read(buf, 0, size, 0) : { bytesRead: 0 }
    return buf.subarray(0, bytesRead).toString('utf8')
  } finally {
    await handle.close()
  }
}

/**
 * Replace `name` directly under `dir` with `content`. Written to a new file
 * first and renamed into place, so a link or hard link at the name is
 * replaced rather than written through.
 */
export async function replaceTaskFile(dir: string, name: string, content: string): Promise<void> {
  const target = fileIn(dir, name)
  const temp = path.join(dir, `.${name}.${randomBytes(6).toString('hex')}.tmp`)
  const handle = await open(
    temp,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | NOFOLLOW,
    0o666,
  )
  try {
    await handle.writeFile(content, 'utf8')
  } finally {
    await handle.close()
  }
  try {
    await rename(temp, target)
  } catch (err) {
    await rm(temp, { force: true })
    throw err
  }
}

/**
 * Append `content` to `name` directly under `dir`, creating it when missing.
 * Refuses a link (including one that points nowhere yet), anything but a
 * regular file, and a file with another name.
 */
export async function appendTaskFile(dir: string, name: string, content: string): Promise<void> {
  const filePath = fileIn(dir, name)
  const handle = await open(
    filePath,
    constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT | NOFOLLOW | NONBLOCK,
    0o666,
  )
  try {
    await assertPlainFile(handle, filePath)
    await handle.write(content, null, 'utf8')
  } finally {
    await handle.close()
  }
}
