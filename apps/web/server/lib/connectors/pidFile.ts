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
 * The dispositive identity check: WHEN did the process holding this pid start.
 *
 * Comparing the COMMAND does not work. `ps` reports `node`, not the absolute
 * path we spawned, and an `npx` launch re-execs into something else entirely. A
 * start time cannot be confused that way: a recycled pid necessarily started
 * AFTER we recorded the original.
 */
interface StartTimes {
  /** Whether the probe RAN. False means this host has no working mechanism, which
   *  is a different fact from "that pid is not ours". */
  ok: boolean
  /** Epoch ms per pid, for the pids the probe could answer for. */
  times: Map<number, number>
}

/** No answer at all. Callers fall back to boot time, age and liveness. */
const NO_START_TIMES: StartTimes = { ok: false, times: new Map() }

/**
 * When the processes currently holding these pids started.
 *
 * ONE CALL FOR THE WHOLE REAP, not one per pid. This runs during boot, and on
 * Windows each probe is a PowerShell start: per-pid that was both slow enough to
 * delay startup and slow enough to hit its own timeout on a loaded CI runner,
 * which is how it came back empty and quietly disabled the reaper there.
 *
 * On POSIX, `lstart` rather than `etimes`: the latter is Linux-only and macOS
 * rejects it. On Windows there is no `ps`, so PowerShell reports the same fact,
 * emitted as a round-trip ISO string so parsing does not depend on the machine's
 * locale.
 */
function processStartTimes(pids: readonly number[]): StartTimes {
  // The pids reach a command line below, and the only validation a record
  // carries is `typeof pid === 'number'`. A float, or a value large enough to
  // format as `1e+21`, would arrive as a malformed argument.
  const safe = pids.filter((p) => Number.isInteger(p) && p > 0)
  if (safe.length === 0) return { ok: true, times: new Map() }

  const times = new Map<number, number>()
  try {
    if (process.platform === 'win32') {
      // `Get-CimInstance` rather than `Get-Process`: it reports CreationDate for
      // every id in one query and does not need rights on each process object.
      const filter = safe.map((p) => `ProcessId=${p}`).join(' or ')
      const raw = execFileSync(
        'powershell.exe',
        [
          '-NoProfile',
          '-NonInteractive',
          '-Command',
          `Get-CimInstance Win32_Process -Filter "${filter}" | ` +
            `ForEach-Object { "$($_.ProcessId) $($_.CreationDate.ToUniversalTime().ToString('o'))" }`,
        ],
        { encoding: 'utf8', timeout: WINDOWS_PROBE_TIMEOUT_MS, windowsHide: true },
      )
      for (const line of raw.split(/\r?\n/)) {
        const [id, stamp] = line.trim().split(/\s+/, 2)
        const parsed = stamp ? Date.parse(stamp) : NaN
        if (id && Number.isFinite(parsed)) times.set(Number(id), parsed)
      }
    } else {
      const raw = execFileSync('ps', ['-o', 'pid=,lstart=', '-p', safe.join(',')], {
        encoding: 'utf8',
        timeout: 10_000,
        windowsHide: true,
      })
      for (const line of raw.split('\n')) {
        const trimmed = line.trim()
        if (!trimmed) continue
        const space = trimmed.indexOf(' ')
        if (space === -1) continue
        const id = Number(trimmed.slice(0, space))
        const parsed = Date.parse(trimmed.slice(space + 1).trim())
        if (Number.isInteger(id) && Number.isFinite(parsed)) times.set(id, parsed)
      }
    }
  } catch {
    // `ps -p` exits non-zero when NONE of the pids exist, which is a legitimate
    // answer rather than a broken probe. Anything else (no such binary, a
    // timeout) means this host cannot answer at all.
    return times.size > 0 ? { ok: true, times } : NO_START_TIMES
  }
  return { ok: true, times }
}

/** Generous, because this is one call at boot on a possibly loaded machine, and
 *  a probe that times out is worse than a probe that takes a moment. */
const WINDOWS_PROBE_TIMEOUT_MS = 30_000

/** Whether ANY process holds this pid. Signal 0 checks existence without sending. */
function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
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
  /** Signalled on boot time, age and liveness ALONE, because this host could not
   *  report process start times. Not an error, but strictly weaker evidence, so
   *  it is counted rather than hidden. */
  unverified: number
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
  let unverified = 0
  let expired = 0

  const bootAt = currentBootAt()
  // ONE probe for the whole reap, over the pids still worth asking about, and
  // ONLY the live ones. A dead or out-of-range pid poisons the whole batch:
  // `ps -p` exits non-zero and prints NOTHING when any id is invalid, so one
  // stale record would cost every other entry its corroboration and quietly
  // downgrade the reap to boot-and-liveness. Liveness is a cheap in-process
  // check, and an entry that fails it is skipped below anyway.
  const probe = processStartTimes(
    entries
      .filter(
        (e) => e.bootAt === bootAt && now - e.startedAt <= MAX_TRUSTED_AGE_MS && isAlive(e.pid),
      )
      .map((e) => e.pid),
  )

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
    // Liveness only. This proves a process EXISTS, not that it is ours: a
    // recycled pid is alive by definition, so it is a cheap early exit, not a
    // safety check. The identity checks are above and below.
    if (!isAlive(entry.pid)) continue
    // Within one boot a pid can still be recycled, so corroborate WHEN the
    // process holding it started. A recycled pid started after we recorded the
    // original; ours started just before.
    //
    // THE PROBE RUNNING AND THE PROBE ANSWERING ARE DIFFERENT FACTS, and
    // conflating them is what broke this. When the probe ran, an id it has no
    // entry for is not ours and a start time meaningfully later than our record
    // is somebody else's, so both skip. When the probe could not run AT ALL,
    // there is nothing to fail closed on: refusing to signal would not be
    // caution, it would be disabling orphan reaping on that whole platform while
    // still claiming to do it. Boot time, the age window and liveness still
    // apply, and the count is reported so an operator can see the difference.
    if (probe.ok) {
      const startedAt = probe.times.get(entry.pid)
      if (startedAt === undefined || startedAt > entry.startedAt + START_TIME_SLACK_MS) {
        expired += 1
        continue
      }
    } else {
      unverified += 1
    }
    kill(entry.pid)
    killed += 1
  }

  writeAll([])
  return { killed, expired, unverified }
}
