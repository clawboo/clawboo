import { afterAll, describe, expect, it } from 'vitest'

import { cleanupEvalContexts, makeBoardContext } from '../env'
import { runSuite, runTask } from '../runner'
import { SMOKE_TASKS } from '../tasks'
import type { EvalTask } from '../types'

afterAll(() => cleanupEvalContexts())

describe('eval runner — pass@1 / pass^k', () => {
  it('the deterministic smoke suite passes ~100% (the regression guard)', async () => {
    const report = await runSuite(SMOKE_TASKS, () => Promise.resolve(makeBoardContext()), {
      trials: 3,
      k: 3,
    })
    expect(report.tasks).toHaveLength(SMOKE_TASKS.length)
    expect(SMOKE_TASKS.length).toBeGreaterThanOrEqual(5)
    expect(report.passAt1).toBe(1)
    expect(report.passPowK).toBe(1)
  })

  it('computes pass@1 (rises) and pass^k (falls) for a flaky task', async () => {
    let n = 0
    const flaky: EvalTask = {
      id: 'flaky',
      suite: 'capability',
      kind: 'coding',
      description: 'passes on alternating trials → 50% per-trial',
      run: async () => ({ data: { even: n++ % 2 === 0 } }),
      graders: [
        (_c, o) => ({
          name: 'even',
          passed: o.data?.['even'] === true,
          score: o.data?.['even'] === true ? 1 : 0,
        }),
      ],
    }
    const report = await runTask(flaky, () => Promise.resolve(makeBoardContext()), {
      trials: 4,
      k: 3,
    })
    expect(report.passAt1).toBeCloseTo(0.5)
    expect(report.passPowK).toBeCloseTo(0.125) // 0.5^3
  })

  it('weighted scoring gives partial credit (a half-done task scores 0.5)', async () => {
    const partial: EvalTask = {
      id: 'partial',
      suite: 'capability',
      kind: 'coding',
      scoring: 'weighted',
      threshold: 0.4,
      description: 'one of two graders passes',
      run: async () => ({}),
      graders: [
        () => ({ name: 'g1', passed: true, score: 1 }),
        () => ({ name: 'g2', passed: false, score: 0 }),
      ],
    }
    const report = await runTask(partial, () => Promise.resolve(makeBoardContext()), { trials: 1 })
    expect(report.meanScore).toBeCloseTo(0.5)
    expect(report.passAt1).toBe(1) // 0.5 ≥ threshold 0.4
  })

  it('a thrown task body is a failed trial, never an unhandled rejection', async () => {
    const boom: EvalTask = {
      id: 'boom',
      suite: 'regression',
      kind: 'coding',
      description: 'throws',
      run: async () => {
        throw new Error('kaboom')
      },
      graders: [() => ({ name: 'x', passed: true, score: 1 })],
    }
    const report = await runTask(boom, () => Promise.resolve(makeBoardContext()), { trials: 1 })
    expect(report.passAt1).toBe(0)
    expect(report.trials[0]!.graders[0]!.name).toBe('run-error')
  })
})
