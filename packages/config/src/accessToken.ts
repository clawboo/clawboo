import { randomBytes } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

import { resolveClawbooDir, resolveOwnClawbooDir } from './paths'
import { PRIVATE_FILE_MODE, mkdirPrivateSync } from './privateFiles'

// The dashboard access token. `STUDIO_ACCESS_TOKEN` in the environment comes
// first, as it always has; a blank value means "no gate". With the variable
// unset, the token is the per-install one in `<CLAWBOO_HOME>/access-token`, one
// per OS user, shared with the Clawboo desktop app: whichever starts first
// writes it, and both read it. The server locks itself with it, and the CLI
// reads it to reach that server.
//
// The file holds the raw token with no newline. Keep the format, the charset and
// the checks below in step with the desktop app's `loadOrCreateAccessToken`.

/** File name of the shared per-install token, inside the Clawboo home. */
export const ACCESS_TOKEN_FILENAME = 'access-token'

/** Header-safe token charset: cookie-value safe, and identical between the cookie
 *  read and the percent-decoded query-param read (no '%'/'+'/';'/',' / whitespace). */
export const ACCESS_TOKEN_CHARSET = 'A-Za-z0-9._~-'
const SAFE_TOKEN_RE = /^[A-Za-z0-9._~-]+$/

/**
 * The first character of `token` the access gate cannot use, or null when the
 * token is usable. A blank or unset token is null too: no token means no gate,
 * which is a choice, not an error. Trims first, exactly as the gate does.
 */
export function findUnsupportedTokenChar(token: string | undefined): string | null {
  const trimmed = String(token ?? '').trim()
  if (!trimmed || SAFE_TOKEN_RE.test(trimmed)) return null
  return [...trimmed].find((c) => !SAFE_TOKEN_RE.test(c)) ?? null
}

export type ResolvedAccessToken =
  /** `STUDIO_ACCESS_TOKEN` is set. Not charset-checked here: the caller refuses it. */
  | { source: 'env'; token: string }
  /** `STUDIO_ACCESS_TOKEN` is set but blank: run with no gate. */
  | { source: 'off' }
  /** The shared per-install token. */
  | { source: 'file'; token: string; file: string; created: boolean }

export interface AccessTokenOptions {
  env?: NodeJS.ProcessEnv
  /** The Clawboo home. Defaults to the one `env` names (`CLAWBOO_HOME`, else `~/.clawboo`). */
  clawbooHome?: string
  platform?: NodeJS.Platform
  /**
   * How long to keep re-reading an EMPTY file before calling it unusable. The
   * desktop app creates the file and writes the token in two steps, so a reader
   * that starts at the same instant can see it empty for a moment.
   */
  retryEmptyMs?: number
}

/** The token file cannot be used or made. An existing one is never overwritten: the other app may hold it. */
export class AccessTokenFileError extends Error {
  readonly file: string
  /** `problem` reads after the file name: "is empty", "could not be created (...)". */
  constructor(
    file: string,
    problem: string,
    remedy = 'Delete it to make a new one on the next start, or set STUDIO_ACCESS_TOKEN ' +
      'to choose the token yourself.',
  ) {
    super(`The access token file ${file} ${problem}. ${remedy}`)
    this.name = 'AccessTokenFileError'
    this.file = file
  }
}

/** `<CLAWBOO_HOME>/access-token`. */
export function resolveAccessTokenPath(
  env: NodeJS.ProcessEnv = process.env,
  clawbooHome?: string,
): string {
  return path.join(clawbooHome ?? resolveClawbooDir(env), ACCESS_TOKEN_FILENAME)
}

type FileRead =
  | { kind: 'ok'; token: string }
  | { kind: 'absent' }
  | { kind: 'unusable'; problem: string; empty?: true }

/** Refuses a symbolic link at open time; 0 on Windows, which has no such flag. */
const noFollow = (): number => fs.constants?.O_NOFOLLOW ?? 0

/**
 * Judge the file and read it through one descriptor, so the permission check and
 * the read are of the same file even if its name is pointed elsewhere between
 * the two. The open refuses a symbolic link (ELOOP).
 */
function readTokenFile(file: string, platform: NodeJS.Platform): FileRead {
  let fd: number
  try {
    // Windows has no O_NOFOLLOW; check for a link by name there instead.
    if (platform === 'win32' && !fs.lstatSync(file).isFile()) {
      return { kind: 'unusable', problem: 'is not a regular file' }
    }
    fd = fs.openSync(file, fs.constants.O_RDONLY | noFollow())
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code
    if (code === 'ENOENT') return { kind: 'absent' }
    if (code === 'ELOOP' || code === 'EISDIR') {
      return { kind: 'unusable', problem: 'is not a regular file' }
    }
    return { kind: 'unusable', problem: `could not be read (${(err as Error).message})` }
  }
  try {
    if (!fs.fstatSync(fd).isFile()) return { kind: 'unusable', problem: 'is not a regular file' }
    // Narrow before reading, as settings.json is. Windows has no mode bits to
    // check; there the file inherits the user profile's permissions.
    if (platform !== 'win32' && !narrowedToOwner(fd)) {
      return {
        kind: 'unusable',
        problem: 'is readable by other users and its permissions could not be narrowed',
      }
    }
    const token = fs.readFileSync(fd, 'utf8').trim()
    if (!token)
      return { kind: 'unusable', problem: 'is empty, so it is not a usable token', empty: true }
    return SAFE_TOKEN_RE.test(token)
      ? { kind: 'ok', token }
      : {
          kind: 'unusable',
          problem: `is not a usable token (only [${ACCESS_TOKEN_CHARSET}] is allowed)`,
        }
  } catch (err) {
    return { kind: 'unusable', problem: `could not be read (${(err as Error).message})` }
  } finally {
    fs.closeSync(fd)
  }
}

/** Narrow the open file to 0600; true when it ends up closed to group and others. */
function narrowedToOwner(fd: number): boolean {
  try {
    fs.fchmodSync(fd, PRIVATE_FILE_MODE)
  } catch {
    // Judged by the mode check below.
  }
  return (fs.fstatSync(fd).mode & 0o077) === 0
}

/** Synchronous sleep. Boot is synchronous here, and the wait is a few milliseconds. */
function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
}

/** Read the file, giving an empty one a moment to be filled in by the app that just created it. */
function readSettled(file: string, platform: NodeJS.Platform, retryEmptyMs: number): FileRead {
  const deadline = Date.now() + retryEmptyMs
  for (;;) {
    const read = readTokenFile(file, platform)
    const empty = read.kind === 'unusable' && read.empty === true
    if (!empty || Date.now() >= deadline) return read
    sleepSync(25)
  }
}

/**
 * The token the server locks itself with, first match wins:
 *
 * 1. `STUDIO_ACCESS_TOKEN`, trimmed, when set. Blank means no gate (`off`).
 * 2. The shared file, when it holds a usable token.
 * 3. A new random token (32 bytes, base64url), written to the file with an
 *    exclusive create, mode 0600, in a folder created 0700.
 *
 * Throws `AccessTokenFileError` when the file exists but cannot be used: not a
 * regular file, readable by others and not narrowable, or not a valid token. A
 * server must not start on a token it cannot trust, and must not replace a file
 * the desktop app may be using.
 */
export function resolveAccessToken(opts: AccessTokenOptions = {}): ResolvedAccessToken {
  const env = opts.env ?? process.env
  const fromEnv = env['STUDIO_ACCESS_TOKEN']
  if (fromEnv !== undefined) {
    const token = fromEnv.trim()
    return token ? { source: 'env', token } : { source: 'off' }
  }

  const platform = opts.platform ?? process.platform
  const home = opts.clawbooHome ?? resolveOwnClawbooDir(env)
  if (home === null) {
    throw new AccessTokenFileError(
      path.join(resolveClawbooDir(env), ACCESS_TOKEN_FILENAME),
      'would sit in the shared temp folder, because the home folder does not exist',
      'Set HOME to your home folder, CLAWBOO_HOME to a folder only you can use, or ' +
        'STUDIO_ACCESS_TOKEN to choose the token yourself.',
    )
  }
  const file = path.join(home, ACCESS_TOKEN_FILENAME)
  const retryEmptyMs = opts.retryEmptyMs ?? 500

  // Two passes: the desktop app may create the file between our read and our write.
  for (let attempt = 0; attempt < 2; attempt++) {
    const read = readSettled(file, platform, retryEmptyMs)
    if (read.kind === 'ok') return { source: 'file', token: read.token, file, created: false }
    if (read.kind === 'unusable') throw new AccessTokenFileError(file, read.problem)

    const token = randomBytes(32).toString('base64url')
    let fd: number
    try {
      mkdirPrivateSync(home)
      fd = fs.openSync(file, 'wx', PRIVATE_FILE_MODE)
    } catch (err) {
      // Someone else wrote it first: read theirs on the next pass.
      if ((err as NodeJS.ErrnoException).code === 'EEXIST') continue
      throw new AccessTokenFileError(file, `could not be created (${(err as Error).message})`)
    }
    try {
      // A FAT or SMB mount can ignore the mode asked for at create time. Check
      // before trusting the token, and leave the file: it is never overwritten.
      if (platform !== 'win32' && !narrowedToOwner(fd)) {
        throw new AccessTokenFileError(
          file,
          'was created readable by other users, and its permissions could not be narrowed',
          'Use a CLAWBOO_HOME on a filesystem that keeps file permissions, or set ' +
            'STUDIO_ACCESS_TOKEN to choose the token yourself.',
        )
      }
      fs.writeFileSync(fd, token, 'utf8')
    } finally {
      fs.closeSync(fd)
    }
    return { source: 'file', token, file, created: true }
  }
  throw new AccessTokenFileError(file, 'kept changing while it was read')
}

/**
 * The shared token, read only: never created, and null when absent or unusable.
 * For a client (the CLI) that needs the token a server already chose.
 */
export function readAccessTokenFile(
  opts: Omit<AccessTokenOptions, 'retryEmptyMs'> = {},
): string | null {
  const env = opts.env ?? process.env
  const home = opts.clawbooHome ?? resolveOwnClawbooDir(env)
  if (home === null) return null
  const read = readTokenFile(
    path.join(home, ACCESS_TOKEN_FILENAME),
    opts.platform ?? process.platform,
  )
  return read.kind === 'ok' ? read.token : null
}
