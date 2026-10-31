import fs from 'node:fs'

// Owner-only writes for files that hold credentials (provider keys, gateway
// tokens, the dashboard access token). POSIX modes are advisory on Windows: there
// `chmod` only toggles the read-only bit, and 0600 keeps the owner's write bit, so
// these calls are harmless no-ops rather than errors.

/** Owner read/write only. */
export const PRIVATE_FILE_MODE = 0o600
/** Owner only. */
export const PRIVATE_DIR_MODE = 0o700

/**
 * `mkdir -p` where every directory this call creates is 0700. Directories that
 * already exist keep their mode: they may belong to another tool (OpenClaw owns
 * `~/.openclaw`), so they are not ours to change.
 */
export function mkdirPrivateSync(dir: string): void {
  fs.mkdirSync(dir, { recursive: true, mode: PRIVATE_DIR_MODE })
}

/**
 * Write `data` to a file only its owner can read. A new file is created 0600. An
 * existing file is narrowed to 0600 BEFORE the new contents land, since
 * `writeFileSync`'s `mode` applies only on create, so a secret is never written
 * into a file other users can read. A chmod that fails on an existing file (one
 * owned by another user, an unusual filesystem) is reported and the write still
 * goes ahead, as it did before this helper existed.
 */
export function writePrivateFileSync(file: string, data: string): void {
  try {
    fs.chmodSync(file, PRIVATE_FILE_MODE)
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      console.warn(`clawboo: could not restrict permissions on ${file}:`, err)
    }
  }
  fs.writeFileSync(file, data, { encoding: 'utf8', mode: PRIVATE_FILE_MODE })
}
