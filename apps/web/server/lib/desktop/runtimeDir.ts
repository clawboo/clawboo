// The runtime folder an agent's display keeps its files in, where there is one.
//
// A display's folder holds its X cookie, its VNC socket, its session bus socket
// and its window manager's settings. A runtime folder suits them better than
// the data folder or a home folder:
//
// - it is in memory (tmpfs), so the cookie is not written to the data folder or
//   a home folder (a tmpfs can still be swapped out), and nothing of a display
//   outlives a reboot;
// - it belongs to one user and nobody else may enter it (0700), made for that
//   user by the system at login, or at boot by a tmpfiles.d line. Not by
//   lingering, which would give an agent user a service manager of its own;
// - its path is short, and a Unix socket's path may not be longer than about
//   100 bytes, which a deep home or data folder can exceed;
// - a home on a network filesystem may not hold a Unix socket at all.
//
// Which one: the folder in `XDG_RUNTIME_DIR` when Clawboo's own user runs the
// displays, then `/run/user/<uid>` (where systemd-logind makes them) for the
// user who runs them, Clawboo's or an agent's. It counts only when it is a real
// folder (not a link) owned by that user, closed to everyone else, and on tmpfs
// or ramfs. Where there is none, a display's folder stays where it was before
// this existed: under the data folder, or in the agent user's home.
//
// Linux only: POSIX paths and Linux filesystem types.

import fs from 'node:fs'
import path from 'node:path'

const posix = path.posix

/** Where systemd-logind makes each user's runtime folder. */
export const USER_RUNTIME_ROOT = '/run/user'

/** The runtime folder logind makes for the user `uid`. */
export function userRuntimeDir(uid: number): string {
  return posix.join(USER_RUNTIME_ROOT, String(uid))
}

/** Filesystem types (statfs `f_type`) that live in memory. */
const TMPFS_MAGIC = 0x01021994
const RAMFS_MAGIC = 0x858458f6

export interface RuntimeDirDeps {
  lstat: (p: string) => fs.Stats
  /** The filesystem type of `p`, as statfs reports it. */
  fsType: (p: string) => number
}

const realDeps: RuntimeDirDeps = {
  lstat: (p) => fs.lstatSync(p),
  fsType: (p) => fs.statfsSync(p).type,
}

/**
 * Whether `dir` is a runtime folder of `uid`: an absolute path to a real folder
 * (not a link), owned by `uid`, that nobody else may enter, read or write, on a
 * filesystem in memory.
 */
export function isRuntimeDirFor(
  dir: string,
  uid: number,
  deps: RuntimeDirDeps = realDeps,
): boolean {
  if (!posix.isAbsolute(dir) || posix.normalize(dir) !== dir) return false
  try {
    const st = deps.lstat(dir)
    if (!st.isDirectory() || st.uid !== uid || (st.mode & 0o077) !== 0) return false
    const type = deps.fsType(dir)
    return type === TMPFS_MAGIC || type === RAMFS_MAGIC
  } catch {
    return false
  }
}

/**
 * The runtime folder a display run by `uid` keeps its files in, or null when
 * that user has none. `serverUser` says Clawboo's own user runs the display,
 * so its own `XDG_RUNTIME_DIR` is looked at first; an agent user's environment
 * is not Clawboo's, so for one only `/run/user/<uid>` is.
 */
export function displayRuntimeRoot(
  uid: number | null,
  opts: { serverUser: boolean; env?: NodeJS.ProcessEnv },
  deps: RuntimeDirDeps = realDeps,
): string | null {
  if (uid === null || !Number.isInteger(uid) || uid < 0) return null
  const env = opts.env ?? process.env
  const candidates = [
    ...(opts.serverUser ? [(env['XDG_RUNTIME_DIR'] ?? '').trim()] : []),
    userRuntimeDir(uid),
  ].filter((d) => d.length > 0)
  for (const dir of candidates) if (isRuntimeDirFor(dir, uid, deps)) return dir
  return null
}
