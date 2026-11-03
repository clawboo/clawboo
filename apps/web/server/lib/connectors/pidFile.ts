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
//
// Whether a recorded pid is still ours is decided by `../processIdentity`, which
// the runtime record (`runtimes/runtimePidFile.ts`) shares.

import { readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'

import { resolveClawbooDir } from '@clawboo/config'

import {
  currentBootIdentity,
  isAlive,
  MAX_TRUSTED_AGE_MS,
  processStartTimes,
  START_TIME_SLACK_MS,
  type BootIdentity,
} from '../processIdentity'

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
  /**
   * The rest of the boot identity (see `BootIdentity`): inside a container,
   * `bootAt` is the host's and survives a container restart, and these do not.
   * Both are absent in a record written before they were, which `sameBoot`
   * reads as null.
   */
  pidNamespace?: string | null
  initStart?: number | null
  /** The resolved binary, for the log. Identity is decided by boot and start
   *  time, not by this: `ps` reports `node` rather than an absolute path, and an
   *  `npx` launch re-execs into something else entirely. */
  command?: string
}

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

export type RecordPidInput = Omit<ConnectorPidEntry, keyof BootIdentity>

export function recordConnectorPid(input: RecordPidInput): void {
  const entry: ConnectorPidEntry = { ...input, ...currentBootIdentity() }
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
   *  ours: recorded under a different boot (or one the record cannot name), too
   *  old, or now running something else. Reported separately so a surprising
   *  count is visible in the log. */
  expired: number
  /** Alive but NOT signalled, because this host could not report when the
   *  process holding the pid started. Counted so the log shows the gap. */
  unverified: number
  /** Why the start times could not be read, when `unverified` is not zero. */
  unverifiedReason?: string
}

export interface ConnectorReapDeps {
  /** Test seam for this process's boot identity (see `currentBootIdentity`). */
  boot?: BootIdentity
}

/**
 * Whether an entry was recorded under this boot identity.
 *
 * A record written before the namespace fields existed has them absent, read
 * as null. On macOS and Windows, which have no PID namespaces, that matches,
 * so an older record is judged as it always was. On Linux it does not, and the
 * older record is dropped unsignalled: nothing in it says which run of the
 * namespace wrote it.
 */
function sameBoot(entry: ConnectorPidEntry, here: BootIdentity): boolean {
  return (
    entry.bootAt === here.bootAt &&
    (entry.pidNamespace ?? null) === here.pidNamespace &&
    (entry.initStart ?? null) === here.initStart
  )
}

/**
 * Kill any connector child left behind by a previous run, then clear the file.
 *
 * Called once at boot, BEFORE anything can connect, so the file it clears is
 * always the previous process's and never this one's.
 */
export function reapOrphanedConnectors(
  kill: (pid: number) => void,
  deps: ConnectorReapDeps = {},
): ReapReport {
  const entries = readAll()
  const now = Date.now()
  let killed = 0
  let unverified = 0
  let expired = 0

  const here = deps.boot ?? currentBootIdentity()
  // ONE probe for the whole reap, over the pids still worth asking about, and
  // ONLY the live ones. A dead or out-of-range pid poisons the whole batch:
  // `ps -p` exits non-zero and prints NOTHING when any id is invalid, so one
  // stale record would cost every other entry its start time, and with it the
  // signal. Liveness is a cheap in-process check, and an entry that fails it is
  // skipped below anyway.
  const probe = processStartTimes(
    entries
      .filter((e) => sameBoot(e, here) && now - e.startedAt <= MAX_TRUSTED_AGE_MS && isAlive(e.pid))
      .map((e) => e.pid),
  )

  for (const entry of entries) {
    // A DIFFERENT BOOT makes the pid meaningless: the kernel has handed those
    // numbers out again, so the process holding it now is somebody else's. This
    // is the check that stops a reboot, or a container's restart, turning the
    // reaper into a hazard.
    if (!sameBoot(entry, here)) {
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
    // FAIL CLOSED. Without a start time, boot, age and liveness cannot tell our
    // connector from a process that was handed its number later, so a host
    // that cannot report start times (no `ps`, or a probe that timed out)
    // signals nothing. Leaving one connector running is the lesser harm, and
    // the count and the reason are reported so the log shows it.
    if (!probe.ok) {
      unverified += 1
      continue
    }
    // The probe ran: an id it has no entry for is not ours any more, and a
    // start time meaningfully later than our record is somebody else's.
    const startedAt = probe.times.get(entry.pid)
    if (startedAt === undefined || startedAt > entry.startedAt + START_TIME_SLACK_MS) {
      expired += 1
      continue
    }
    kill(entry.pid)
    killed += 1
  }

  writeAll([])
  return {
    killed,
    expired,
    unverified,
    ...(unverified > 0 && probe.error ? { unverifiedReason: probe.error } : {}),
  }
}
