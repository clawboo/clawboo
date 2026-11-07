// The resume note — telling a re-dispatched attempt that the last one was killed.
//
// THE GAP. When clawboo re-dispatches a task whose previous attempt died
// mid-flight, the new attempt starts cold. It has no idea an earlier run may have
// half-completed a side effect: a file written, a commit made, a request sent. So
// it redoes it, and "redo" is not safe for everything an agent can do.
//
// The data has existed all along. `reconcileOrphans` writes
// `'orphaned: process not alive on restart'` onto the ledger row and the stale
// sweep writes `'stale: no heartbeat within the watchdog window'`. Nothing ever
// read either string back to anyone, least of all to the one agent that could act
// on it.
//
// TRUTHFULNESS IS THE WHOLE VALUE. The note only claims work exists when the
// ledger shows evidence of it (a moved commit, a recorded summary) AND the task
// actually has a worktree to look in. A note that says "your work is in the
// worktree" when there is no worktree is worse than silence: the agent will go
// looking, find nothing, and conclude the note is noise.

import { oneLine } from '@clawboo/board-core'
import type { AttemptSummary } from '@clawboo/db'
import {
  RUN_CLOSED_FINISHED_BY_PERSON,
  RUN_CLOSED_RESULT_AFTER_RELEASE,
} from '@clawboo/team-orchestration'

export interface ResumeNoteInput {
  /** Derived from the task's execution ledger. */
  attempts: AttemptSummary
  /** True when a worktree actually exists for this task right now. */
  hasWorktree: boolean
  /**
   * The fix-cycle counter. A verification re-dispatch is NOT an interruption: it
   * already carries its own structured {what, why, howToFix}, and two notes
   * telling the agent different stories about why it is running again is worse
   * than one. `> 0` suppresses this note entirely.
   */
  fixCycle?: number
}

/**
 * Build the note, or null when there is nothing honest to say.
 *
 * Returns null for: a first attempt, a clean prior attempt, a user-stopped one, a
 * prior attempt that merely FAILED (that path already gets the failure itself),
 * and any fix-cycle re-dispatch.
 */
export function buildResumeNote(input: ResumeNoteInput): string | null {
  if (input.fixCycle) return null
  const { attempts } = input
  // A watchdog timeout interrupted its run too (the team engine stopped it), so
  // it gets the same note it got before the attempt reader told it apart from a
  // crash (K17). It records no work, so it gets the honest variant.
  if (attempts.lastKind !== 'crash' && attempts.lastKind !== 'timeout') return null

  const reason = (
    attempts.lastKind === 'crash' ? attempts.lastCrashReason : attempts.lastReason
  )?.trim()
  const why = reason ? ` (${reason})` : ''
  const nth =
    attempts.crashAttempts > 1
      ? ` This is attempt ${attempts.crashAttempts + 1}; the previous ${attempts.crashAttempts} were interrupted the same way, so if something here is repeatably killing the run, say so rather than trying again identically.`
      : ''

  if (!attempts.lastCrashLeftWork || !input.hasWorktree) {
    return [
      '## A previous attempt at this task was interrupted',
      `It stopped before recording any work${why}, so there is nothing to pick up. Start from the beginning.${nth}`,
    ].join('\n')
  }

  return [
    '## A previous attempt at this task was interrupted mid-run',
    `It stopped without reporting${why}. Any work it finished is already in your worktree, and **the outcome of whatever it was doing when it stopped is unknown** — it may have half-completed something.`,
    '',
    'Before you redo anything with a side effect (writing files, committing, pushing, network calls), check what actually happened: read the worktree, run `git status` and `git log`, and look at the task comments. Continue from where it left off. Do not start over, and do not repeat steps that are already done.',
    nth.trim(),
  ]
    .filter(Boolean)
    .join('\n')
}

/** The longest reason the last-attempt line quotes. */
const MAX_REASON_CHARS = 400

/**
 * The "last attempt" line of a team engine run's ticket block, or null when
 * there is nothing to say (a first run, or one after a run that finished).
 *
 * The engine's runs have no worktree, but a coding agent works in the team's
 * folder, which outlives the run, so the executor's "nothing to pick up, start
 * from the beginning" would be wrong here: an interrupted or stopped run may
 * have done part of the work. A watchdog timeout is not a crash (K17): the
 * process was alive and the engine stopped it.
 */
export function buildLastAttemptNote(attempts: AttemptSummary): string | null {
  // One line, bounded, without its own closing full stop: the sentence around
  // it supplies the punctuation.
  const reason = attempts.lastReason
    ? oneLine(attempts.lastReason, MAX_REASON_CHARS).replace(/[.\s]+$/, '')
    : null
  const checkFirst =
    'It may have done part of the work: check what is already done (the files it worked on, comments on this task) before you redo anything with a side effect.'
  let line: string
  switch (attempts.lastKind) {
    case null:
    case 'success':
      return null
    case 'crash':
      line = `The last attempt was cut off before it reported: the process running it stopped${reason ? ` (${reason})` : ''}. ${checkFirst}`
      break
    case 'timeout':
      line = `The last attempt went quiet and was stopped${reason ? ` (${reason})` : ''}. ${checkFirst}`
      break
    case 'error':
      line = `The last attempt failed: ${reason || 'no reason was recorded'}.`
      break
    case 'budget':
      return `A budget cap stopped the last attempt, or kept it from starting. ${checkFirst}`
    case 'breaker':
      return `The circuit breaker stopped the last attempt${reason ? ` (${reason})` : ''}: it was going wrong in a way that repeats. Try another approach. ${checkFirst}`
    case 'cancelled':
      if (attempts.lastReason === RUN_CLOSED_RESULT_AFTER_RELEASE)
        return 'The last attempt finished after the task had been taken back from it; its result is kept as a comment on this task.'
      if (attempts.lastReason === RUN_CLOSED_FINISHED_BY_PERSON)
        return 'A person finished this task while the last attempt was running.'
      // No reason: a person's Stop. It may have caught the task queued rather
      // than running (the Stop marks waiting work too), so claim no attempt.
      if (!reason) return 'A person stopped this task earlier; it is running again now.'
      return `The last attempt was stopped: ${uncapitalize(reason.replace(/^Stopped:\s*/, ''))}.`
  }
  const failed = attempts.crashAttempts + attempts.errorAttempts
  if (failed > 1)
    line += ` It has failed ${failed} times in a row: if the same thing is going wrong again, say so in your report instead of repeating it.`
  return line
}

const uncapitalize = (s: string): string => (s ? s[0]!.toLowerCase() + s.slice(1) : s)
