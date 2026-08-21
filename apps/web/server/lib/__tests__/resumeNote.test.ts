// The resume note. Its whole value is truthfulness, so most of these tests are
// about what it must NOT say.

import { describe, expect, it } from 'vitest'

import { classifyAttempts, type AttemptRow } from '@clawboo/db'

import { buildResumeNote } from '../resumeNote'

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
