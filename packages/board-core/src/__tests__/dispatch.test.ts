import { describe, expect, it } from 'vitest'

import {
  MAX_AUTO_FIRES,
  delegationTargetOf,
  encodeHumanAssignment,
  isHumanAssignment,
  ledgerAllowsAutoFire,
  trailingFailedRuns,
} from '../dispatch'

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
})

describe('trailingFailedRuns', () => {
  it('counts only the unbroken run of unsuccessful runs at the tail', () => {
    expect(trailingFailedRuns([])).toBe(0)
    expect(trailingFailedRuns(runs('succeeded'))).toBe(0)
    expect(trailingFailedRuns(runs('failed', 'succeeded', 'failed', 'timed_out'))).toBe(2)
    expect(trailingFailedRuns(runs('failed', 'cancelled', 'failed'))).toBe(1)
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
