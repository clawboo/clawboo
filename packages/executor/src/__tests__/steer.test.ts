import { describe, expect, it } from 'vitest'

import { steerThroughDriver } from '../steer'
import { steeringOf, type Capabilities } from '../types'

const CAPS: Capabilities = {
  streaming: true,
  mcp: false,
  worktrees: false,
  resume: false,
  toolApproval: false,
  models: [],
}

describe('steeringOf', () => {
  it('reads an absent claim as none', () => {
    expect(steeringOf(CAPS)).toBe('none')
    expect(steeringOf({ ...CAPS, steering: 'live' })).toBe('live')
    expect(steeringOf({ ...CAPS, steering: 'interrupt-resume' })).toBe('interrupt-resume')
  })
})

describe('steerThroughDriver', () => {
  it('maps the driver’s answer onto a SteerResult and never throws', async () => {
    await expect(steerThroughDriver(undefined, 'x', 'live')).resolves.toEqual({
      delivered: false,
      reason: 'no-run',
    })
    await expect(steerThroughDriver({}, 'x', 'live')).resolves.toEqual({
      delivered: false,
      reason: 'unsupported',
    })
    await expect(
      steerThroughDriver({ steer: async () => true }, 'x', 'interrupt-resume'),
    ).resolves.toEqual({ delivered: true, mode: 'interrupt-resume' })
    await expect(steerThroughDriver({ steer: async () => false }, 'x', 'live')).resolves.toEqual({
      delivered: false,
      reason: 'run-ended',
    })
    await expect(
      steerThroughDriver(
        {
          steer: async () => {
            throw new Error('nope')
          },
        },
        'x',
        'live',
      ),
    ).resolves.toEqual({ delivered: false, reason: 'rejected', detail: 'nope' })
  })
})
