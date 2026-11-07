import { describe, expect, it } from 'vitest'

import {
  decideDone,
  parseResultClaim,
  type DoneDecisionInput,
  type ResultClaim,
} from '../doneDecision'

const claim = (outcome: ResultClaim['outcome']): ResultClaim => ({ outcome, summary: 'said so' })

const base: DoneDecisionInput = {
  claim: null,
  check: 'none',
  storedVerdictPasses: true,
  errorClass: null,
  unfinishedSubtasks: 0,
}

describe('decideDone', () => {
  it('an agent that never reports is decided as before: a run that ended well is done', () => {
    expect(decideDone(base)).toEqual({ done: true, overUnfinished: false })
    expect(decideDone({ ...base, check: 'pass' })).toEqual({ done: true, overUnfinished: false })
    expect(decideDone({ ...base, check: 'unchecked' })).toEqual({
      done: true,
      overUnfinished: false,
    })
  })

  it('a claim of success never overrides a failing check', () => {
    for (const check of ['failed', 'retry', 'decided'] as const)
      expect(decideDone({ ...base, claim: claim('done'), check })).toEqual({
        done: false,
        because: 'check',
      })
  })

  it('a claim of success never overrides the verdict the board stores', () => {
    expect(decideDone({ ...base, claim: claim('done'), storedVerdictPasses: false })).toEqual({
      done: false,
      because: 'stored_verdict',
    })
  })

  it('a claim of success never overrides a run that ended on an error', () => {
    expect(decideDone({ ...base, claim: claim('done'), errorClass: 'RateLimit' })).toEqual({
      done: false,
      because: 'run_error',
    })
  })

  it('a claim of failure stops a run that would otherwise be done', () => {
    expect(decideDone({ ...base, claim: claim('not_done') })).toEqual({
      done: false,
      because: 'claim',
    })
    expect(decideDone({ ...base, claim: claim('not_done'), check: 'pass' })).toEqual({
      done: false,
      because: 'claim',
    })
  })

  it('work that did not finish stops a parent nobody spoke for', () => {
    expect(decideDone({ ...base, unfinishedSubtasks: 2 })).toEqual({
      done: false,
      because: 'subtasks',
    })
  })

  it('an agent that says it made up for that work closes the parent, and it is marked so', () => {
    expect(decideDone({ ...base, claim: claim('done'), unfinishedSubtasks: 1 })).toEqual({
      done: true,
      overUnfinished: true,
    })
  })

  it('a failing check outranks everything the agent says about its sub-tasks', () => {
    expect(
      decideDone({ ...base, claim: claim('done'), unfinishedSubtasks: 1, check: 'failed' }),
    ).toEqual({ done: false, because: 'check' })
  })
})

describe('parseResultClaim', () => {
  it('reads what the tool stored, as JSON or parsed', () => {
    const stored = { outcome: 'not_done', summary: 'no key', deliverables: ['a.md'] }
    expect(parseResultClaim(JSON.stringify(stored))).toEqual(stored)
    expect(parseResultClaim(stored)).toEqual(stored)
  })

  it('reads anything else as no claim, so a bad row behaves as if the tool was never called', () => {
    for (const raw of [null, undefined, '', 'nope', '{}', { outcome: 'maybe', summary: 'x' }])
      expect(parseResultClaim(raw)).toBeNull()
    expect(parseResultClaim({ outcome: 'done' })).toBeNull()
  })

  it('drops deliverables that are not a list of strings', () => {
    expect(parseResultClaim({ outcome: 'done', summary: 'x', deliverables: [1, 'b'] })).toEqual({
      outcome: 'done',
      summary: 'x',
      deliverables: ['b'],
    })
  })
})
