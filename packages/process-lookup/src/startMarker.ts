// The start marker: `<Clawboo data folder>/api-port.json`, written by the
// server beside `api-port.txt`, so a reader can tell whether the server that
// recorded the port is still the process running.
//
// `api-port.txt` holds a bare port number. A server that dies hard (a crash, a
// force quit, any stop on Windows) leaves it behind, and its port can then be
// taken by another program, which a reader would trust by the file's mere
// existence: the `clawboo` command sends its access token only to that port.
// The marker names the process as well (pid, when it started, which boot and
// which PID namespace), and a reader checks that process before it trusts the
// port.
//
// THE FIELD NAMES ARE A CONTRACT. An app that runs Clawboo reads this file, and
// the docs (docs/reference/configuration.md, "Start marker") describe each
// field. Add fields; never rename or retype one.

import { readFileSync, statSync } from 'node:fs'
import path from 'node:path'

import {
  currentBootAt,
  currentInitStart,
  currentPidNamespace,
  engineStanding,
  pidExists,
  processStartTimes,
  startTimeMatch,
  type StartTimes,
} from './identity'

/** The bare port file, unchanged for older readers. */
export const API_PORT_FILE = 'api-port.txt'
/** The start marker, beside it. */
export const START_MARKER_FILE = 'api-port.json'

/** What `api-port.json` holds. Every field is always written. */
export interface StartMarker {
  /** The TCP port the server listens on: the number in `api-port.txt`. */
  port: number
  /** The server's process id. */
  pid: number
  /** Epoch ms the server process started. */
  startedAt: number
  /** Epoch ms the system last started, rounded to 10 seconds. */
  bootAt: number
  /** Linux: the server's PID namespace (`pid:[4026531836]`). Null on macOS and
   *  Windows, and where it cannot be read. */
  pidNamespace: string | null
  /** Linux: when pid 1 of that namespace started, in clock ticks after boot.
   *  Null on macOS and Windows, and where it cannot be read. */
  initStart: number | null
  /** The Clawboo version the server runs. */
  version: string
}

const isFiniteNumber = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v)

/** A marker from parsed JSON, or null when any field is missing or of the
 *  wrong type. Fields it does not know are ignored, so a later version may add
 *  some. */
export function parseStartMarker(raw: unknown): StartMarker | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const m = raw as Record<string, unknown>
  const { port, pid, startedAt, bootAt, pidNamespace, initStart, version } = m
  if (!Number.isInteger(port) || (port as number) <= 0 || (port as number) > 65535) return null
  if (!Number.isInteger(pid) || (pid as number) <= 0) return null
  if (!isFiniteNumber(startedAt) || !isFiniteNumber(bootAt)) return null
  if (pidNamespace !== null && typeof pidNamespace !== 'string') return null
  if (initStart !== null && !isFiniteNumber(initStart)) return null
  if (typeof version !== 'string') return null
  return {
    port: port as number,
    pid: pid as number,
    startedAt,
    bootAt,
    pidNamespace,
    initStart,
    version,
  }
}

/**
 * How far apart two readings of the boot time may be and still name one boot.
 *
 * `currentBootAt` rounds to 10 seconds, so two readings of one boot can land a
 * step apart. A reboot moves it by far more: the whole time the system was up
 * before it. So does a wall clock stepped since the server started (a VM that
 * resyncs after the host slept, a machine with no clock battery that syncs
 * late, a person setting the time): the reading is now minus the uptime, and
 * only now moves. `checkStartMarker` tells the two apart where it can, and
 * says it cannot tell where it cannot.
 */
export const BOOT_AT_SLACK_MS = 10_000

/**
 * How far from the marker's `startedAt` the process holding its pid may have
 * started and still be the server. The marker's own time comes from inside the
 * process (`Date.now() - process.uptime()`), so this only absorbs `ps`
 * reporting start times to the second, the moment between the process's
 * creation and Node's start, and a loaded machine stretching that moment. Much
 * tighter than the minute the runtime pid records allow: a pid handed to
 * another process this soon after the server started would need the server to
 * have died within those seconds.
 */
export const MARKER_START_SLACK_MS = 15_000

/**
 * - `running`: the process that wrote the marker is the one holding its pid.
 * - `gone`: it is shown not to be (its pid is free; or held by a process that
 *   started at another time, on this boot or after a reboot; or the marker is
 *   from an earlier run of this PID namespace). The marker is stale.
 * - `unknown`: this reader cannot tell (no way to read process start times
 *   here, the marker is from another PID namespace, or the boot reading has
 *   moved in a way a stepped clock explains as well as a reboot). A reader
 *   then goes by `api-port.txt` alone, as before the marker: never worse than
 *   that, so a wrong `unknown` costs nothing a wrong `gone` would.
 */
export type MarkerVerdict = 'running' | 'gone' | 'unknown'

export interface MarkerCheck {
  verdict: MarkerVerdict
  /** Why, in words, for a log. */
  reason: string
}

/** Test seams: everything `checkStartMarker` reads from the system. */
export interface MarkerCheckDeps {
  platform?: NodeJS.Platform
  pidNamespace?: string | null
  initStart?: number | null
  bootAt?: number
  exists?: (pid: number) => boolean
  startTimes?: (pids: readonly number[]) => StartTimes
}

/** Is the server a marker names still the process running under its pid? */
export function checkStartMarker(marker: StartMarker, deps: MarkerCheckDeps = {}): MarkerCheck {
  const platform = deps.platform ?? process.platform
  const here = {
    platform,
    pidNamespace: deps.pidNamespace !== undefined ? deps.pidNamespace : currentPidNamespace(),
    initStart: deps.initStart !== undefined ? deps.initStart : currentInitStart(),
  }
  const standing = engineStanding(marker, here)
  if (standing === 'earlierRun') {
    return { verdict: 'gone', reason: 'it was written in an earlier run of this PID namespace' }
  }
  if (standing === 'foreign') {
    return {
      verdict: 'unknown',
      reason: 'it was written in another PID namespace, or this one cannot be read',
    }
  }
  // A free pid is gone whatever any clock says.
  if (!(deps.exists ?? pidExists)(marker.pid)) {
    return { verdict: 'gone', reason: `no process has pid ${marker.pid}` }
  }
  const probe = (deps.startTimes ?? processStartTimes)([marker.pid])
  const match = startTimeMatch(marker.pid, marker.startedAt, probe, MARKER_START_SLACK_MS)
  if (match === 'unknown') {
    return {
      verdict: 'unknown',
      reason: `could not read when pid ${marker.pid} started${probe.error ? `: ${probe.error}` : ''}`,
    }
  }
  const bootShift = (deps.bootAt ?? currentBootAt()) - marker.bootAt
  if (Math.abs(bootShift) <= BOOT_AT_SLACK_MS) {
    // The same boot, and no clock step: the start time decides.
    return match === 'same'
      ? { verdict: 'running', reason: `pid ${marker.pid} is the server that wrote it` }
      : { verdict: 'gone', reason: `pid ${marker.pid} now belongs to a later process` }
  }
  // The boot reading moved: a reboot, or a wall clock stepped since the
  // server started. A step moves every reading taken now by the same amount.
  // On macOS and Windows a process's recorded start time stays put, so the
  // server still matches; on Linux `ps` reckons start times from the boot time
  // too, so the server's moved with the step. Either is what a step looks like,
  // and could also be a process that came up as long after a reboot as the
  // server did after its own: say so rather than guess.
  const started = probe.times.get(marker.pid)
  const shiftedWithClock =
    started !== undefined &&
    Math.abs(started - marker.startedAt - bootShift) <= MARKER_START_SLACK_MS
  if (match === 'same' || shiftedWithClock) {
    return {
      verdict: 'unknown',
      reason: `the clock or the boot moved by ${Math.round(bootShift / 1000)} s since it was written`,
    }
  }
  return {
    verdict: 'gone',
    reason: `it was written before the system last started, and pid ${marker.pid} is another process`,
  }
}

/**
 * The recorded port, and how far a reader may trust it.
 *
 * - `verified`: the start marker names a server that is still running, and
 *   this is its port.
 * - `unverified`: no marker to go by (none, unreadable, written before the port
 *   file by a server that writes none, or one this reader cannot check). The
 *   port file is all there is, as before the marker existed.
 * - `stale`: the marker shows the server that recorded this port is gone.
 */
export type PortTrust = 'verified' | 'unverified' | 'stale'

export interface PortRecord {
  /** The port to go by: the marker's when verified, else the port file's. */
  port: number | null
  trust: PortTrust
  /** The marker read, when there was a readable one. */
  marker: StartMarker | null
  /** The marker check, when one ran. */
  check: MarkerCheck | null
}

interface Stamped<T> {
  value: T
  mtimeMs: number
}

function readStamped(file: string): Stamped<string> | null {
  try {
    const mtimeMs = statSync(file).mtimeMs
    return { value: readFileSync(file, 'utf8'), mtimeMs }
  } catch {
    return null
  }
}

/** The port in `api-port.txt`, or null when it is missing or not a port. */
export function parsePortText(raw: string): number | null {
  const port = Number(raw.trim())
  // isInteger, not isFinite: `18790.5` would reach the socket layer, which
  // throws ERR_SOCKET_BAD_PORT synchronously.
  if (!Number.isInteger(port) || port <= 0 || port > 65535) return null
  return port
}

/** `api-port.json` in `dir`, parsed, or null when missing or unreadable. */
export function readStartMarker(dir: string): StartMarker | null {
  const raw = readStamped(path.join(dir, START_MARKER_FILE))
  if (!raw) return null
  try {
    return parseStartMarker(JSON.parse(raw.value))
  } catch {
    return null
  }
}

/**
 * Read the recorded port in `dir` (the Clawboo data folder), checked through the
 * start marker. Never throws.
 *
 * The port file counts on its own (`unverified`) when there is no marker, when
 * the marker cannot be checked here, and when the port file is newer than the
 * marker: a server that writes no marker (one from before it existed) wrote it
 * after the server that did. A verified marker wins over a port file that names
 * another port: two servers starting together can leave the files naming
 * different ones, and the marker's server is shown to be running.
 */
export function readPortRecord(
  dir: string,
  check: (marker: StartMarker) => MarkerCheck = (m) => checkStartMarker(m),
): PortRecord {
  const txt = readStamped(path.join(dir, API_PORT_FILE))
  const txtPort = txt ? parsePortText(txt.value) : null
  const rawMarker = readStamped(path.join(dir, START_MARKER_FILE))
  let marker: StartMarker | null = null
  if (rawMarker) {
    try {
      marker = parseStartMarker(JSON.parse(rawMarker.value))
    } catch {
      marker = null
    }
  }
  if (!marker || !rawMarker)
    return { port: txtPort, trust: 'unverified', marker: null, check: null }
  if (txt && txt.mtimeMs > rawMarker.mtimeMs) {
    return { port: txtPort, trust: 'unverified', marker, check: null }
  }
  const result = check(marker)
  if (result.verdict === 'running') {
    return { port: marker.port, trust: 'verified', marker, check: result }
  }
  if (result.verdict === 'unknown' || (txtPort !== null && txtPort !== marker.port)) {
    return { port: txtPort, trust: 'unverified', marker, check: result }
  }
  return { port: txtPort, trust: 'stale', marker, check: result }
}
