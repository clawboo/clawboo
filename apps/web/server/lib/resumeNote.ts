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

import type { AttemptSummary } from '@clawboo/db'

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
  if (attempts.lastKind !== 'crash') return null

  const reason = attempts.lastCrashReason?.trim()
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
