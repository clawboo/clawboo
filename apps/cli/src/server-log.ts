/**
 * Rolling log for the DETACHED dashboard server.
 *
 * The server is forked with `detached: true` and its stdio was previously
 * discarded, so a boot failure left no trace anywhere — the launcher just timed
 * out with a generic hint. Pointing the child's stdout/stderr at this file makes
 * a failed first run diagnosable after the fact.
 *
 * Every function here is best-effort and NEVER throws: a log we cannot open must
 * degrade to the previous behaviour (discarded output), never fail a launch.
 */

import fs from 'fs'
import path from 'path'

import { resolveClawbooDir } from '@clawboo/config'

/** Rotate past this size so the log can't grow without bound. */
export const SERVER_LOG_MAX_BYTES = 5 * 1024 * 1024

export interface ServerLog {
  fd: number
  path: string
}

export function resolveServerLogPath(): string {
  return path.join(resolveClawbooDir(), 'server.log')
}

/**
 * Open (append) the rolling server log, rotating it first if oversized.
 * Returns null when it cannot be opened (read-only home, permissions).
 */
export function openServerLog(header?: string): ServerLog | null {
  const logPath = resolveServerLogPath()
  try {
    fs.mkdirSync(path.dirname(logPath), { recursive: true })
    try {
      if (fs.statSync(logPath).size > SERVER_LOG_MAX_BYTES) {
        fs.renameSync(logPath, `${logPath}.1`)
      }
    } catch {
      // No existing log (or an unstattable one) — nothing to rotate.
    }
    const fd = fs.openSync(logPath, 'a')
    if (header) {
      try {
        fs.writeSync(fd, header)
      } catch {
        // Header is a nicety; an unwritable log is handled by the caller.
      }
    }
    return { fd, path: logPath }
  } catch {
    return null
  }
}

/** The last `maxLines` non-blank lines, reading at most `maxBytes` from the tail. */
export function tailServerLog(logPath: string, maxLines = 12, maxBytes = 8_192): string[] {
  try {
    const size = fs.statSync(logPath).size
    const start = Math.max(0, size - maxBytes)
    const fd = fs.openSync(logPath, 'r')
    try {
      const length = size - start
      const buf = Buffer.alloc(length)
      fs.readSync(fd, buf, 0, length, start)
      return buf
        .toString('utf8')
        .split(/\r?\n/)
        .map((l) => l.trimEnd())
        .filter((l) => l.length > 0)
        .slice(-maxLines)
    } finally {
      fs.closeSync(fd)
    }
  } catch {
    return []
  }
}
