// The resume note. Its whole value is truthfulness, so most of these tests are
// about what it must NOT say.

import { describe, expect, it } from 'vitest'

import { classifyAttempts, type AttemptRow } from '@clawboo/db'
import {
  RUN_CLOSED_FINISHED_BY_PERSON,
  RUN_CLOSED_RESULT_AFTER_RELEASE,
} from '@clawboo/team-orchestration'

import { buildLastAttemptNote, buildResumeNote } from '../resumeNote'

const swept = (extra: Partial<AttemptRow> = {}): AttemptRow => ({
  status: 'timed_out',
  error: 'stale: no heartbeat within the watchdog window',
  ...extra,
})
const orphaned = (): AttemptRow => ({
  status: 'failed',
  error: 'orphaned: process not alive on restart',
  recoveryTombstone: 1,
})

const note = (execs: AttemptRow[], opts: { hasWorktree?: boolean; fixCycle?: number } = {}) =>
  buildResumeNote({
    attempts: classifyAttempts(execs),
    hasWorktree: opts.hasWorktree ?? true,
    ...(opts.fixCycle ? { fixCycle: opts.fixCycle } : {}),
  })

describe('buildResumeNote — when it says nothing', () => {
  it('a FIRST attempt gets no note', () => {
    expect(note([])).toBeNull()
  })

  it('a clean prior attempt gets no note', () => {
    expect(note([{ status: 'succeeded' }])).toBeNull()
  })

  it('a prior attempt that merely FAILED gets no note', () => {
    // That path already reports its own outcome; a second story about why the
    // run exists would just contradict it.
    expect(note([{ status: 'failed', error: 'tests failed' }])).toBeNull()
  })

  it('a user-STOPPED task gets no note', () => {
    expect(note([{ status: 'cancelled' }])).toBeNull()
  })

  it('a verification FIX cycle gets no note, whatever the ledger says', () => {
    // The fix re-dispatch already carries the critic's {what, why, howToFix}.
    // Two notes telling the agent different reasons is worse than one.
    expect(note([swept({ afterCommit: 'abc' })], { fixCycle: 1 })).toBeNull()
  })
})

describe('buildResumeNote — the two honest variants', () => {
  it('NO work recorded: say there is nothing to pick up', () => {
    const text = note([swept()])!
    expect(text).toMatch(/interrupted/i)
    expect(text).toMatch(/nothing to pick up/i)
    expect(text).toMatch(/start from the beginning/i)
    // It must NOT tell the agent to go looking for work that is not there.
    expect(text).not.toMatch(/already in your worktree/i)
  })

  it('WORK recorded: say the outcome is unknown and to check before redoing', () => {
    const text = note([swept({ afterCommit: 'abc123' })])!
    expect(text).toMatch(/already in your worktree/i)
    expect(text).toMatch(/outcome of whatever it was doing when it stopped is unknown/i)
    expect(text).toMatch(/side effect/i)
    expect(text).toMatch(/do not start over/i)
  })

  it('names the tombstone reason, which is the whole point of reading it back', () => {
    expect(note([orphaned()])!).toMatch(/process not alive on restart/)
    expect(note([swept()])!).toMatch(/no heartbeat/)
  })

  it('does NOT claim the worktree when the task has none', () => {
    // Evidence of work plus no worktree to look in: the note would be a lie the
    // agent then acts on. Degrade to the honest variant instead.
    const text = note([swept({ afterCommit: 'abc123' })], { hasWorktree: false })!
    expect(text).not.toMatch(/already in your worktree/i)
    expect(text).toMatch(/nothing to pick up/i)
  })

  it('escalates when the SAME interruption keeps happening', () => {
    // Three crashes in a row is not "try again"; it is a signal that something
    // here is repeatably killing the run.
    const text = note([swept(), swept(), swept()])!
    expect(text).toMatch(/attempt 4/)
    expect(text).toMatch(/repeatably killing the run/i)
  })

  it('a crash AFTER a success is attempt 2, not a long streak', () => {
    const text = note([swept(), swept(), { status: 'succeeded' }, swept()])!
    expect(text).not.toMatch(/attempt \d/)
  })
})

describe('buildResumeNote: a watchdog timeout on the executor path', () => {
  it('still reads as an interrupted attempt with nothing recorded, as before', () => {
    // The team engine stopped the run, so whatever it was doing is unfinished.
    const text = note([
      { status: 'timed_out', error: 'No response from the delegate for 8 minutes.' },
    ])!
    expect(text).toMatch(/interrupted/i)
    expect(text).toMatch(/No response from the delegate for 8 minutes/)
    expect(text).toMatch(/nothing to pick up/i)
  })
})

// The team engine's "last attempt" line in the ticket block. The engine's runs
// have no worktree, but coding agents work in the team folder, which outlives
// the run, so "start from the beginning" would be bad advice there.
describe('buildLastAttemptNote (the team engine)', () => {
  const last = (execs: AttemptRow[]) => buildLastAttemptNote(classifyAttempts(execs))

  it('says nothing for a first run or after a run that finished', () => {
    expect(last([])).toBeNull()
    expect(last([{ status: 'succeeded' }])).toBeNull()
  })

  it('does not call a watchdog timeout a crash', () => {
    const text = last([
      { status: 'timed_out', error: 'No response from the delegate for 8 minutes.' },
    ])!
    expect(text).toMatch(/went quiet and was stopped/i)
    expect(text).toContain('(No response from the delegate for 8 minutes).')
    expect(text).not.toMatch(/crash|process running it stopped/i)
  })

  it('names a crash for what it is, and says to check before redoing a side effect', () => {
    const text = last([swept()])!
    expect(text).toMatch(/process running it stopped/i)
    expect(text).toMatch(/no heartbeat/)
    expect(text).toMatch(/side effect/i)
    expect(text).not.toMatch(/start from the beginning/i)
  })

  it('quotes the error of a run that failed', () => {
    expect(last([{ status: 'failed', error: 'The API answered 529.' }])).toContain(
      'The last attempt failed: The API answered 529.',
    )
  })

  it('tells a person’s stop, a person’s finish and a late result apart', () => {
    expect(last([{ status: 'budget_paused', error: 'budget_paused:team' }])).toMatch(
      /budget cap stopped the last attempt/i,
    )
    expect(last([{ status: 'breaker_tripped', error: 'circuit_broken:no-progress' }])).toMatch(
      /circuit breaker stopped the last attempt \(circuit_broken:no-progress\)/i,
    )
    expect(last([{ status: 'cancelled' }])).toBe(
      'A person stopped this task earlier; it is running again now.',
    )
    expect(
      last([{ status: 'cancelled', error: 'Stopped: a person moved the card to To do.' }]),
    ).toBe('The last attempt was stopped: a person moved the card to To do.')
    expect(last([{ status: 'cancelled', error: RUN_CLOSED_FINISHED_BY_PERSON }])).toMatch(
      /a person finished this task while the last attempt was running/i,
    )
    expect(last([{ status: 'cancelled', error: RUN_CLOSED_RESULT_AFTER_RELEASE }])).toMatch(
      /finished after the task had been taken back.*kept as a comment/i,
    )
  })

  it('says when the task keeps failing', () => {
    const text = last([
      { status: 'failed', error: 'x' },
      swept(),
      { status: 'failed', error: 'y' },
    ])!
    expect(text).toMatch(/failed 3 times in a row/)
    expect(last([{ status: 'failed', error: 'x' }])!).not.toMatch(/in a row/)
  })

  it('keeps a long or multi-line reason to one bounded line', () => {
    const text = last([{ status: 'failed', error: `line one\nline two ${'z'.repeat(2000)}` }])!
    expect(text).not.toContain('\n')
    expect(text.length).toBeLessThan(700)
  })
})
