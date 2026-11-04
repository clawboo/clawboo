// How the run working on a task takes a comment right now, for the task card's
// hint: the run's own way when its adapter can tell, else its runtime's.

import { afterEach, describe, expect, it } from 'vitest'

import type { Capabilities } from '@clawboo/executor'

import { registerRunSteer, resetRunSteers, taskRunSteering } from '../runSteers'

const RUN = { adapterId: 'x', sessionKey: 'agent:a1:team:t1', runId: 'r1' }
const caps = (steering?: Capabilities['steering']) => () => ({ steering }) as Capabilities
const steer = async () => ({ delivered: true as const, mode: 'live' as const })

afterEach(() => resetRunSteers())

describe('taskRunSteering', () => {
  it('is null with no run on the task', () => {
    expect(taskRunSteering('t1')).toBeNull()
  })

  it("reads the run's own way when its adapter reports one", () => {
    registerRunSteer(
      't1',
      { capabilities: caps('live'), steer, runSteering: () => 'interrupt-resume' },
      RUN,
    )
    expect(taskRunSteering('t1')).toBe('interrupt-resume')
  })

  it("falls back to the runtime's declared way", () => {
    registerRunSteer('t1', { capabilities: caps('live'), steer }, RUN)
    expect(taskRunSteering('t1')).toBe('live')
  })

  it('a run that takes no steer reads none, and is passed over for one that does', () => {
    const quiet = registerRunSteer('t1', { capabilities: caps(undefined) }, RUN)
    expect(taskRunSteering('t1')).toBe('none')
    registerRunSteer('t1', { capabilities: caps('interrupt-resume'), steer }, RUN)
    expect(taskRunSteering('t1')).toBe('interrupt-resume')
    quiet.release()
  })
})
