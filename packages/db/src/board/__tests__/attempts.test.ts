// Reading the execution ledger back as a story.
//
// The distinction that matters: a task whose PROCESS keeps dying and a task that
// runs fine and keeps FAILING look identical to the fire policy, but they need
// different treatment and different messages. Nothing stored says which is which;
// it is derived from columns the recovery writers already set.

import { describe, expect, it } from 'vitest'

import { classifyAttempts, type AttemptRow } from '../attempts'

/** The row `reconcileOrphans` writes when a process died with the server. */
const orphaned = (): AttemptRow => ({
  status: 'failed',
  error: 'orphaned: process not alive on restart',
  recoveryTombstone: 1,
})
/** The row the stale sweep writes when a drain stopped beating. */
const swept = (): AttemptRow => ({
  status: 'timed_out',
  error: 'stale: no heartbeat within the watchdog window',
})
const failed = (msg = 'tests failed'): AttemptRow => ({ status: 'failed', error: msg })
const ok = (): AttemptRow => ({ status: 'succeeded' })
const stopped = (): AttemptRow => ({ status: 'cancelled' })

describe('classifyAttempts', () => {
  it('a task that has never run has nothing to say', () => {
    expect(classifyAttempts([])).toEqual({
      crashAttempts: 0,
      errorAttempts: 0,
      lastKind: null,
      lastCrashLeftWork: false,
      lastCrashReason: null,
      lastReason: null,
    })
  })

  it('separates a dying PROCESS from a failing RUN', () => {
    // Both writers of a crash row are recognised, and neither is counted as an
    // error: an orphan reap and a stale sweep mean nobody reported, not that the
    // work was wrong.
    expect(classifyAttempts([orphaned()])).toMatchObject({
      crashAttempts: 1,
      errorAttempts: 0,
      lastKind: 'crash',
    })
    expect(classifyAttempts([swept()])).toMatchObject({
      crashAttempts: 1,
      errorAttempts: 0,
      lastKind: 'crash',
    })
    expect(classifyAttempts([failed()])).toMatchObject({
      crashAttempts: 0,
      errorAttempts: 1,
      lastKind: 'error',
    })
  })

  it('counts the two kinds independently in one streak', () => {
    expect(classifyAttempts([failed(), orphaned(), failed()])).toMatchObject({
      crashAttempts: 1,
      errorAttempts: 2,
      lastKind: 'error',
    })
  })

  it('a SUCCESS resets both streaks — history is not the current problem', () => {
    expect(classifyAttempts([orphaned(), failed(), ok(), swept()])).toMatchObject({
      crashAttempts: 1,
      errorAttempts: 0,
      lastKind: 'crash',
    })
  })

  it('a user STOP breaks the streak too: intent is not a symptom', () => {
    expect(classifyAttempts([failed(), failed(), stopped()])).toMatchObject({
      crashAttempts: 0,
      errorAttempts: 0,
      lastKind: 'cancelled',
    })
  })

  it('reports work-left ONLY on evidence, never on inference', () => {
    // No evidence: the next attempt must be told there is nothing to pick up,
    // because sending it hunting for phantom work is its own failure mode.
    expect(classifyAttempts([swept()]).lastCrashLeftWork).toBe(false)
    // A moved commit is evidence.
    expect(classifyAttempts([{ ...swept(), afterCommit: 'abc123' }]).lastCrashLeftWork).toBe(true)
    // So is a recorded partial summary.
    expect(classifyAttempts([{ ...swept(), summary: 'wrote the parser' }]).lastCrashLeftWork).toBe(
      true,
    )
    // But not on a run that merely FAILED: that path reports its own outcome.
    expect(classifyAttempts([{ ...failed(), afterCommit: 'abc123' }]).lastCrashLeftWork).toBe(false)
  })

  it('a still-RUNNING row is not an attempt at all', () => {
    // The caller filters its own open row; a concurrent dispatch's (or a leaked)
    // running row used to classify as an error, inflate the streak, and even
    // become lastKind: turning "someone else is mid-run" into "this task keeps
    // failing".
    const running = (): AttemptRow => ({ status: 'running' })
    expect(classifyAttempts([running()])).toMatchObject({ lastKind: null, errorAttempts: 0 })
    expect(classifyAttempts([swept(), running()])).toMatchObject({
      lastKind: 'crash',
      crashAttempts: 1,
      errorAttempts: 0,
    })
    expect(classifyAttempts([failed(), running(), failed()])).toMatchObject({
      errorAttempts: 2,
      lastKind: 'error',
    })
  })

  it('carries the tombstone reason forward, so the next attempt can be told why', () => {
    expect(classifyAttempts([orphaned()]).lastCrashReason).toMatch(/process not alive/)
    expect(classifyAttempts([swept()]).lastCrashReason).toMatch(/no heartbeat/)
    expect(classifyAttempts([failed()]).lastCrashReason).toBeNull()
  })
})

// K17: the team engine writes `timed_out` too, for a run that went silent while
// its process lived (its idle watchdog), and so does the OpenClaw routine
// watchdog. Neither is a crash: the process was alive, and the engine stopped
// the run itself. Only the stale sweep's `timed_out` means nobody was there.
describe('classifyAttempts on the team engine ledger (K17)', () => {
  const watchdog = (): AttemptRow => ({
    status: 'timed_out',
    error: 'No response from the delegate for 8 minutes.',
  })
  const routineWatchdog = (): AttemptRow => ({
    status: 'timed_out',
    error: 'Routine run timed out after 10 minutes.',
  })

  it('does not call a watchdog timeout a crash', () => {
    expect(classifyAttempts([watchdog()])).toMatchObject({
      lastKind: 'timeout',
      crashAttempts: 0,
      errorAttempts: 1,
      lastCrashLeftWork: false,
      lastCrashReason: null,
      lastReason: 'No response from the delegate for 8 minutes.',
    })
    expect(classifyAttempts([routineWatchdog()]).lastKind).toBe('timeout')
  })

  it('still calls the stale sweep a crash, with or without a summary', () => {
    expect(classifyAttempts([swept()]).lastKind).toBe('crash')
    expect(classifyAttempts([{ ...swept(), summary: 'half way' }]).lastKind).toBe('crash')
  })

  it('counts a timeout with the failures in one streak', () => {
    expect(classifyAttempts([swept(), failed(), watchdog()])).toMatchObject({
      lastKind: 'timeout',
      crashAttempts: 1,
      errorAttempts: 2,
    })
  })

  it('says why the newest attempt ended, whatever its kind', () => {
    expect(classifyAttempts([failed('the API said 529')]).lastReason).toBe('the API said 529')
    expect(classifyAttempts([orphaned()]).lastReason).toMatch(/process not alive/)
    expect(
      classifyAttempts([
        { status: 'cancelled', error: 'Stopped: a person moved the card to To do.' },
      ]),
    ).toMatchObject({
      lastKind: 'cancelled',
      lastReason: 'Stopped: a person moved the card to To do.',
    })
    expect(classifyAttempts([ok()]).lastReason).toBeNull()
    expect(classifyAttempts([{ status: 'failed', error: '   ' }]).lastReason).toBeNull()
  })
})
