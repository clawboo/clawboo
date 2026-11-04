/**
 * apps/cli/src/stopReport.ts
 *
 * What `clawboo stop` and `clawboo restart` say when their wait for agent runs
 * ends without a stop, and the note they add when a hold they placed may still
 * be on the server. Words only, so they can be tested: `index.ts` renders them
 * with chalk and the spinner.
 *
 * A hold the command could not release keeps the server from starting new work
 * until it lapses, a minute at most. Every path that may leave one says so.
 */

import type { RecordedPort, StopAfterRunsResult, StopOutcome } from './lifecycle'

/** Said when a hold this command placed could not be released. */
export const HOLD_LAPSES = 'It starts new work again within a minute, when its hold lapses.'

export function agentRuns(n: number): string {
  return n === 1 ? '1 agent run' : `${n} agent runs`
}

export interface UnstoppedReport {
  /** How the spinner ends: a failure, or a plain note for a cancel. */
  tone: 'fail' | 'info'
  /** The spinner's closing line. */
  text: string
  /** Lines printed after it. */
  notes: string[]
  /**
   * Print the command that stops the server's process by hand. Not `--force`:
   * that finds the server through the same requests that went unanswered.
   */
  manualStop: boolean
  exitCode: number
}

/**
 * The report for a wait that ended without a stop, or null when the stop ran.
 * `cancelled` exits 130; a server that would not be held (`unreachable`) or
 * went silent with runs going (`lost`) exits 1, with the manual stop command.
 */
export function reportUnstopped(result: StopAfterRunsResult): UnstoppedReport | null {
  if (result.stop !== null) return null
  const lapse = result.released === false ? [HOLD_LAPSES] : []
  const drain = result.drain
  switch (drain?.status) {
    case 'cancelled':
      return {
        tone: 'info',
        text:
          result.released === false
            ? `Cancelled. Clawboo keeps running. ${HOLD_LAPSES}`
            : 'Cancelled. Clawboo keeps running and starts new work again.',
        notes: [],
        manualStop: false,
        exitCode: 130,
      }
    case 'unreachable':
      return {
        tone: 'fail',
        text: 'The server did not answer the request to hold its agent runs, so it was not stopped.',
        notes: lapse,
        manualStop: true,
        exitCode: 1,
      }
    case 'lost':
      return {
        tone: 'fail',
        text:
          `The server stopped answering while ${agentRuns(drain.running)} ` +
          `${drain.running === 1 ? 'was' : 'were'} going, so it was not stopped.`,
        notes: lapse,
        manualStop: true,
        exitCode: 1,
      }
    default:
      return {
        tone: 'fail',
        text: 'Clawboo was not stopped.',
        notes: lapse,
        manualStop: true,
        exitCode: 1,
      }
  }
}

/**
 * The note after a stop that left a server up, or found none, when the hold
 * this command placed could not be released. Null when there is nothing to say.
 */
export function holdNote(stop: StopOutcome, released: boolean | null): string | null {
  if (released !== false) return null
  return stop.status === 'not-running'
    ? 'If it is still running, it starts new work again within a minute, when its hold lapses.'
    : HOLD_LAPSES
}

export interface NoServerReport {
  /** `info` when there is nothing to do; `fail` when the command refuses. */
  tone: 'info' | 'fail'
  text: string
  /** Remove `api-port.txt`: only ever a stale record. */
  clearRecord: boolean
  /** Print the manual stop command for this port. */
  manualStopPort: number | null
  /** `clawboo restart` only: start a new server. */
  start: boolean
  exitCode: number
}

/**
 * What `clawboo stop` and `clawboo restart` do when discovery found no Clawboo
 * server, by what holds the recorded port (see `inspectRecordedPort`). A record
 * is cleared only when it is stale, and a restart starts a server only when
 * nothing holds the recorded port: never a second dashboard beside one that is
 * busy or answering elsewhere.
 */
export function reportNoServer(
  recorded: RecordedPort,
  command: 'stop' | 'restart',
): NoServerReport {
  const where = `port ${recorded.port}, the port Clawboo recorded`
  if (recorded.state === 'silent') {
    return {
      tone: 'fail',
      text:
        `A server on ${where}, takes connections but does not answer. ` +
        (command === 'stop'
          ? 'It may be busy, so it was not stopped.'
          : 'It may be busy, so it was not restarted, and no second server was started.'),
      clearRecord: false,
      manualStopPort: recorded.port,
      start: false,
      exitCode: 1,
    }
  }
  if (recorded.state === 'live') {
    return command === 'stop'
      ? {
          tone: 'info',
          text:
            `No Clawboo server answered on the port asked. One answers on ${where}: ` +
            `CLAWBOO_API_PORT=${recorded.port} clawboo stop stops it.`,
          clearRecord: false,
          manualStopPort: null,
          start: false,
          exitCode: 0,
        }
      : {
          tone: 'fail',
          text:
            `A Clawboo server answers on ${where}, so no second one was started. ` +
            `CLAWBOO_API_PORT=${recorded.port} clawboo restart restarts it.`,
          clearRecord: false,
          manualStopPort: null,
          start: false,
          exitCode: 1,
        }
  }
  return command === 'stop'
    ? {
        tone: 'info',
        text: 'No Clawboo server is running.',
        clearRecord: recorded.port !== null,
        manualStopPort: null,
        start: false,
        exitCode: 0,
      }
    : {
        tone: 'info',
        text: 'No Clawboo server is running; starting one.',
        clearRecord: false,
        manualStopPort: null,
        start: true,
        exitCode: 0,
      }
}
