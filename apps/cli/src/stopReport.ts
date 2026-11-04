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

import type { StopAfterRunsResult, StopOutcome } from './lifecycle'

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
  exitCode: number
}

/**
 * The report for a wait that ended without a stop, or null when the stop ran.
 * `cancelled` exits 130; a server that would not be held (`unreachable`) or
 * went silent with runs going (`lost`) exits 1 and names `--force`.
 */
export function reportUnstopped(
  result: StopAfterRunsResult,
  command: 'stop' | 'restart',
): UnstoppedReport | null {
  if (result.stop !== null) return null
  const lapse = result.released === false ? [HOLD_LAPSES] : []
  const force = `To stop it anyway: clawboo ${command} --force`
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
        exitCode: 130,
      }
    case 'unreachable':
      return {
        tone: 'fail',
        text: 'The server did not answer the request to hold its agent runs, so it was not stopped.',
        notes: [force, ...lapse],
        exitCode: 1,
      }
    case 'lost':
      return {
        tone: 'fail',
        text:
          `The server stopped answering while ${agentRuns(drain.running)} ` +
          `${drain.running === 1 ? 'was' : 'were'} going, so it was not stopped.`,
        notes: [force, ...lapse],
        exitCode: 1,
      }
    default:
      return { tone: 'fail', text: 'Clawboo was not stopped.', notes: lapse, exitCode: 1 }
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
