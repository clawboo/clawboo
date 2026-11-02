// Is the process holding a recorded pid still the one we recorded?
//
// Shared by the durable pid records (`connectors/pidFile.ts` for connector
// children, `runtimes/runtimePidFile.ts` for agent runs). Both write a pid down
// so a LATER process can kill it after a hard stop, and a bare pid is not enough
// for that: the kernel hands the same numbers out again. These are the checks
// that tell "still ours" from "somebody else's process wearing our number".

import { execFileSync } from 'node:child_process'
import os from 'node:os'

/**
 * A pid is only meaningful for as long as the OS has not recycled it.
 *
 * Beyond this, an entry is dropped WITHOUT signalling: killing a pid the kernel
 * has since handed to something else is far worse than leaving one child
 * running. Twelve hours rather than days, because pid space is small (Linux
 * `pid_max` defaults to 32768) and recycles in hours on a busy machine.
 */
export const MAX_TRUSTED_AGE_MS = 12 * 60 * 60_000

/**
 * Approximate epoch ms of the current system boot.
 *
 * Rounded to ten seconds because `os.uptime()` has sub-second drift between
 * calls, and an exact comparison would then never match its own recorded value.
 */
export function currentBootAt(): number {
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
export interface StartTimes {
  /** Whether the probe RAN. False means this host has no working mechanism, which
   *  is a different fact from "that pid is not ours". */
  ok: boolean
  /** Epoch ms per pid, for the pids the probe could answer for. */
  times: Map<number, number>
}

/** No answer at all. */
const NO_START_TIMES: StartTimes = { ok: false, times: new Map() }

/**
 * When the processes currently holding these pids started.
 *
 * ONE CALL FOR THE WHOLE REAP, not one per pid. This runs during boot, and on
 * Windows each probe is a PowerShell start: per-pid that was both slow enough to
 * delay startup and slow enough to hit its own timeout on a loaded CI runner,
 * which is how it came back empty and quietly disabled the reaper there.
 *
 * Pass LIVE pids only. An out-of-range pid poisons the whole batch: `ps -p`
 * exits non-zero and prints NOTHING when any id is invalid. A pid that merely
 * died in the meantime is left out of the answer.
 *
 * On POSIX, `lstart` rather than `etimes`: the latter is Linux-only and macOS
 * rejects it. `ps` formats `lstart` in the user's locale, and `Date.parse` cannot
 * read most month names outside English (a German "Okt." or "Dez."), so it runs
 * under the C locale. On Windows there is no `ps`, so PowerShell reports the
 * same fact, emitted as a round-trip ISO string so parsing does not depend on
 * the machine's locale.
 */
export function processStartTimes(pids: readonly number[]): StartTimes {
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
        env: { ...process.env, LC_ALL: 'C' },
        // Captured, not inherited: telling "none exist" from an error reads it.
        stdio: ['ignore', 'pipe', 'pipe'],
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
  } catch (err) {
    // `ps -p` exits 1 and prints nothing at all when NONE of the pids exist,
    // which is an answer rather than a broken probe. Anything else (no such
    // binary, a timeout, an error message) means this host cannot answer.
    const { status, stderr } = err as { status?: unknown; stderr?: unknown }
    const noneExist =
      process.platform !== 'win32' &&
      status === 1 &&
      (typeof stderr !== 'string' || stderr.trim() === '')
    return noneExist ? { ok: true, times } : NO_START_TIMES
  }
  return { ok: true, times }
}

/** Generous, because this is one call at boot on a possibly loaded machine, and
 *  a probe that times out is worse than a probe that takes a moment. */
const WINDOWS_PROBE_TIMEOUT_MS = 30_000

/** Whether ANY process holds this pid. Signal 0 checks existence without sending. */
export function isAlive(pid: number): boolean {
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
export const START_TIME_SLACK_MS = 60_000
