// Durable record of connector child PIDs, so a HARD stop does not orphan them.
//
// The in-memory registry only helps a GRACEFUL shutdown. A crash, a SIGKILL, a
// laptop lid closing: none of those run a shutdown hook, and the connector child
// is not `unref`'d away either -- it is a real process that keeps running with
// nobody left who knows about it. On the next boot clawboo would spawn a second
// one and never learn about the first.
//
// The idiom is the one `api-port.txt` already uses: a small file beside the rest
// of clawboo's state, written on connect and pruned on disconnect.
//
// BEST EFFORT BY DESIGN. Every operation swallows its errors: a read-only state
// directory or a corrupt file must degrade to "we cannot reap old children",
// never to "the server will not start".

import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { resolveClawbooDir } from '@clawboo/config'

export interface ConnectorPidEntry {
  pid: number
  slug: string
  /** Epoch ms. Used to ignore records too old to trust a pid from. */
  startedAt: number
  /**
   * Approximate epoch ms of the SYSTEM boot this pid was recorded under.
   *
   * The single most important field here. A pid is only meaningful within one
   * boot: after a restart the kernel hands the same low numbers out again, so an
   * entry from before the reboot names whatever process happens to hold that
   * number now. Without this the reap would signal it.
   */
  bootAt: number
  /** The resolved binary, for the log. Identity is decided by boot and start
   *  time, not by this: `ps` reports `node` rather than an absolute path, and an
   *  `npx` launch re-execs into something else entirely. */
  command?: string
}

/**
 * A pid is only meaningful for as long as the OS has not recycled it.
 *
 * Beyond this, an entry is dropped WITHOUT signalling: killing a pid the kernel
 * has since handed to something else is far worse than leaving one connector
 * running. Twelve hours rather than days, because pid space is small (Linux
 * `pid_max` defaults to 32768) and recycles in hours on a busy machine.
 */
const MAX_TRUSTED_AGE_MS = 12 * 60 * 60_000

/**
 * Approximate epoch ms of the current system boot.
 *
 * Rounded to ten seconds because `os.uptime()` has sub-second drift between
 * calls, and an exact comparison would then never match its own recorded value.
 */
function currentBootAt(): number {
  return Math.round((Date.now() - os.uptime() * 1000) / 10_000) * 10_000
}

/**
 * When the process currently holding `pid` actually started, or null.
 *
 * The dispositive identity check. Comparing the COMMAND does not work: `ps`
 * reports `node`, not the absolute path we spawned, and an `npx` launch re-execs
 * into something else entirely. A start time cannot be confused that way -- a
 * recycled pid necessarily started AFTER we recorded the original.
 *
 * `lstart` rather than `etimes`: the latter is Linux-only and macOS rejects it.
 */
function processStartedAt(pid: number): number | null {
  try {
    const raw = execFileSync('ps', ['-o', 'lstart=', '-p', String(pid)], {
      encoding: 'utf8',
      timeout: 5_000,
      windowsHide: true,
    }).trim()
    const parsed = Date.parse(raw)
    return Number.isFinite(parsed) ? parsed : null
  } catch {
    return null
  }
}

/**
 * How far AFTER our record a process may have started and still be ours.
 *
 * We record immediately after the spawn resolves, so the child's real start time
 * is slightly BEFORE `startedAt`. The slack only absorbs clock granularity;
 * anything meaningfully later is a different process wearing the same number.
 */
const START_TIME_SLACK_MS = 60_000

export function connectorPidFilePath(): string {
  return path.join(resolveClawbooDir(process.env), 'connector-pids.json')
}

function readAll(): ConnectorPidEntry[] {
  try {
    const raw: unknown = JSON.parse(readFileSync(connectorPidFilePath(), 'utf8'))
    if (!Array.isArray(raw)) return []
    return raw.filter(
      (e): e is ConnectorPidEntry =>
        !!e &&
        typeof e === 'object' &&
        typeof (e as ConnectorPidEntry).pid === 'number' &&
        typeof (e as ConnectorPidEntry).slug === 'string' &&
        typeof (e as ConnectorPidEntry).startedAt === 'number',
    )
  } catch {
    return []
  }
}

function writeAll(entries: ConnectorPidEntry[]): void {
  try {
    writeFileSync(connectorPidFilePath(), JSON.stringify(entries), 'utf8')
  } catch {
    /* best effort */
  }
}

export type RecordPidInput = Omit<ConnectorPidEntry, 'bootAt'>

export function recordConnectorPid(input: RecordPidInput): void {
  const entry: ConnectorPidEntry = { ...input, bootAt: currentBootAt() }
  // Replace any entry for the same pid: a recycled pid must not accumulate two
  // records that disagree about which connector it belongs to.
  writeAll([...readAll().filter((e) => e.pid !== entry.pid), entry])
}

export function forgetConnectorPid(pid: number): void {
  writeAll(readAll().filter((e) => e.pid !== pid))
}

export interface ReapReport {
  killed: number
  /** Entries dropped UNSIGNALLED because they could not be trusted to still be
   *  ours: recorded under a different boot, too old, or now running something
   *  else. Reported separately so a surprising count is visible in the log. */
  expired: number
}

/**
 * Kill any connector child left behind by a previous run, then clear the file.
 *
 * Called once at boot, BEFORE anything can connect, so the file it clears is
 * always the previous process's and never this one's.
 */
export function reapOrphanedConnectors(kill: (pid: number) => void): ReapReport {
  const entries = readAll()
  const now = Date.now()
  let killed = 0
  let expired = 0

  const bootAt = currentBootAt()
  for (const entry of entries) {
    // A DIFFERENT BOOT makes the pid meaningless: the kernel has handed those
    // numbers out again, so the process holding it now is somebody else's. This
    // is the check that stops a reboot turning the reaper into a hazard.
    if (entry.bootAt !== bootAt) {
      expired += 1
      continue
    }
    if (now - entry.startedAt > MAX_TRUSTED_AGE_MS) {
      expired += 1
      continue
    }
    try {
      // Liveness only. This proves a process EXISTS, not that it is ours -- a
      // recycled pid is alive by definition -- so it is a cheap early exit, not
      // a safety check. The identity checks are above and below.
      process.kill(entry.pid, 0)
    } catch {
      continue
    }
    // Within one boot a pid can still be recycled, so corroborate WHEN the
    // process holding it started. A recycled pid started after we recorded the
    // original; ours started just before.
    const startedAt = processStartedAt(entry.pid)
    if (startedAt !== null && startedAt > entry.startedAt + START_TIME_SLACK_MS) {
      expired += 1
      continue
    }
    kill(entry.pid)
    killed += 1
  }

  writeAll([])
  return { killed, expired }
}
