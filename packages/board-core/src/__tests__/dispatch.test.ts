import { describe, expect, it } from 'vitest'

import {
  MAX_AUTO_FIRES,
  accountFailureOf,
  delegationTargetOf,
  encodeHumanAssignment,
  isFinishedRun,
  isHumanAssignment,
  ledgerAllowsAutoFire,
  trailingFailedRuns,
  PAUSED_RUN_CLASS,
  stoppedByPause,
} from '../dispatch'
import { agedTaskPriority, MAX_TASK_PRIORITY, READY_AGING_STEP_MS } from '../priority'

const runs = (...statuses: string[]) => statuses.map((status) => ({ status }))

describe('ledgerAllowsAutoFire', () => {
  it('fires a task that has never run', () => {
    expect(ledgerAllowsAutoFire([])).toBe(true)
  })

  it('leaves a task alone while a run owns it', () => {
    expect(ledgerAllowsAutoFire(runs('running'))).toBe(false)
  })

  it('never re-fires work the user stopped', () => {
    expect(ledgerAllowsAutoFire(runs('failed', 'cancelled'))).toBe(false)
  })

  it('re-fires infrastructure deaths until the streak reaches the cap', () => {
    expect(ledgerAllowsAutoFire(runs('failed', 'timed_out'))).toBe(true)
    expect(ledgerAllowsAutoFire(runs('failed', 'failed', 'timed_out'))).toBe(false)
  })

  it('a success in between resets the streak', () => {
    expect(ledgerAllowsAutoFire(runs('failed', 'failed', 'succeeded', 'failed'))).toBe(true)
  })

  it('never re-fires a run the provider refused the account for', () => {
    // A second try fails the same way until a person fixes the sign-in or billing.
    expect(ledgerAllowsAutoFire([{ status: 'failed', errorClass: 'Auth' }])).toBe(false)
    expect(ledgerAllowsAutoFire([{ status: 'failed', errorClass: 'Billing' }])).toBe(false)
    // Any other failure stays an infrastructure death, re-fired under the cap.
    expect(ledgerAllowsAutoFire([{ status: 'failed', errorClass: 'RateLimited' }])).toBe(true)
    // An older account failure followed by a success does not hold the task.
    expect(
      ledgerAllowsAutoFire([
        { status: 'failed', errorClass: 'Auth' },
        { status: 'succeeded' },
        { status: 'failed', errorClass: 'Timeout' },
      ]),
    ).toBe(true)
  })
})

describe('accountFailureOf', () => {
  it('names the account problem a failed run ended on', () => {
    expect(accountFailureOf({ status: 'failed', errorClass: 'Auth' })).toBe('sign_in')
    expect(accountFailureOf({ status: 'timed_out', errorClass: 'Billing' })).toBe('billing')
  })

  it('is null for any other class, a run that did not fail, or no run', () => {
    expect(accountFailureOf({ status: 'failed', errorClass: 'ProviderError' })).toBeNull()
    expect(accountFailureOf({ status: 'failed', errorClass: null })).toBeNull()
    expect(accountFailureOf({ status: 'failed' })).toBeNull()
    expect(accountFailureOf({ status: 'succeeded', errorClass: 'Auth' })).toBeNull()
    expect(accountFailureOf({ status: 'cancelled', errorClass: 'Auth' })).toBeNull()
    expect(accountFailureOf(undefined)).toBeNull()
  })
})

describe('trailingFailedRuns', () => {
  it('counts only the unbroken run of unsuccessful runs at the tail', () => {
    expect(trailingFailedRuns([])).toBe(0)
    expect(trailingFailedRuns(runs('succeeded'))).toBe(0)
    expect(trailingFailedRuns(runs('failed', 'succeeded', 'failed', 'timed_out'))).toBe(2)
    expect(trailingFailedRuns(runs('failed', 'cancelled', 'failed'))).toBe(1)
  })

  it('skips a run that never finished, as the attempt reader does', () => {
    // A leaked `running` row behind a newer run is not an outcome anyone saw.
    expect(trailingFailedRuns(runs('failed', 'running', 'failed'))).toBe(2)
    expect(trailingFailedRuns(runs('succeeded', 'running', 'failed'))).toBe(1)
    expect(ledgerAllowsAutoFire(runs('failed', 'running', 'failed'))).toBe(true)
  })

  it('agrees with isFinishedRun on what counts as an outcome', () => {
    expect(['running', 'queued', 'pending'].map(isFinishedRun)).toEqual([false, false, false])
    expect(['succeeded', 'failed', 'timed_out', 'cancelled'].map(isFinishedRun)).toEqual([
      true,
      true,
      true,
      true,
    ])
  })

  it('reaches MAX_AUTO_FIRES exactly when the policy parks the task', () => {
    const parked = runs(...Array.from({ length: MAX_AUTO_FIRES }, () => 'failed'))
    expect(trailingFailedRuns(parked)).toBe(MAX_AUTO_FIRES)
    expect(ledgerAllowsAutoFire(parked)).toBe(false)
  })
})

describe('the assignment marker', () => {
  it('decodes the bound agent from an engine delegation and from a person’s assignment', () => {
    expect(delegationTargetOf('run-1:deleg:agent:bug-boo:reflectTo:leader')).toBe('bug-boo')
    expect(delegationTargetOf(encodeHumanAssignment('bug-boo', 'n1'))).toBe('bug-boo')
  })

  it('finds no agent on a task that was never bound to one', () => {
    expect(delegationTargetOf(null)).toBeNull()
    expect(delegationTargetOf(undefined)).toBeNull()
    expect(delegationTargetOf('')).toBeNull()
    expect(delegationTargetOf('run-1:deleg:reflectTo:leader')).toBeNull()
  })

  it('tells a person’s assignment apart from an agent’s delegation', () => {
    expect(isHumanAssignment(encodeHumanAssignment('a2', 'n1'))).toBe(true)
    expect(isHumanAssignment('run-1:deleg:agent:a2:reflectTo:leader')).toBe(false)
    expect(isHumanAssignment('run-1:plan:0:agent:a2:reflectTo:')).toBe(false)
    expect(isHumanAssignment(null)).toBe(false)
  })

  it('carries no reflect-to segment, so no agent can be resolved to report the result to', () => {
    expect(encodeHumanAssignment('a2', 'n1')).not.toContain(':reflectTo:')
  })

  it('an agent named like the marker is not mistaken for one', () => {
    expect(isHumanAssignment('run-1:deleg:agent:origin-human:reflectTo:leader')).toBe(false)
  })
})

describe('a run a pause stopped', () => {
  const paused = { status: 'cancelled', errorClass: PAUSED_RUN_CLASS }

  it('is told apart from a person stopping the run', () => {
    expect(stoppedByPause(paused)).toBe(true)
    expect(stoppedByPause({ status: 'cancelled' })).toBe(false)
    expect(stoppedByPause({ status: 'failed', errorClass: PAUSED_RUN_CLASS })).toBe(false)
  })

  it("leaves the task free to fire again on resume, where a person's Stop does not", () => {
    expect(ledgerAllowsAutoFire([paused])).toBe(true)
    expect(ledgerAllowsAutoFire([{ status: 'cancelled' }])).toBe(false)
  })

  it('restores a run a person asked for, even after they had stopped or parked the task', () => {
    expect(ledgerAllowsAutoFire([{ status: 'cancelled' }, paused])).toBe(true)
    const parked = Array.from({ length: MAX_AUTO_FIRES }, () => ({ status: 'failed' }))
    expect(ledgerAllowsAutoFire([...parked, paused])).toBe(true)
  })

  it('is no outcome: it neither counts in a failure streak nor resets one', () => {
    const failed = { status: 'failed' }
    expect(trailingFailedRuns([failed, paused, failed])).toBe(2)
    expect(trailingFailedRuns([failed, paused])).toBe(1)
    expect(ledgerAllowsAutoFire([failed, failed, paused, failed])).toBe(false)
  })
})

describe('agedTaskPriority', () => {
  const NOW = 1_800_000_000_000

  it('adds a level for each step waited, up to High: only a stored Urgent reads as Urgent', () => {
    expect(agedTaskPriority({ priority: -1, createdAt: NOW }, NOW)).toBe(-1)
    expect(agedTaskPriority({ priority: -1, createdAt: NOW - READY_AGING_STEP_MS }, NOW)).toBe(0)
    const old = NOW - 100 * READY_AGING_STEP_MS
    expect(agedTaskPriority({ priority: -1, createdAt: old }, NOW)).toBe(1)
    expect(agedTaskPriority({ priority: 0, createdAt: old }, NOW)).toBe(1)
    expect(agedTaskPriority({ priority: 1, createdAt: old }, NOW)).toBe(1)
    expect(agedTaskPriority({ priority: 2, createdAt: old }, NOW)).toBe(MAX_TASK_PRIORITY)
  })

  it('reads a stored value outside the levels, and a future time, safely', () => {
    expect(agedTaskPriority({ priority: 100, createdAt: NOW }, NOW)).toBe(MAX_TASK_PRIORITY)
    expect(agedTaskPriority({ priority: 0, createdAt: NOW + READY_AGING_STEP_MS }, NOW)).toBe(0)
  })
})
