import { describe, expect, it } from 'vitest'

import { completeExecutionBody } from '../schemas'

describe('completeExecutionBody', () => {
  it("accepts a 'local' run only at a cost of 0", () => {
    expect(
      completeExecutionBody.safeParse({ status: 'succeeded', costUsd: 0, costSource: 'local' })
        .success,
    ).toBe(true)
    expect(
      completeExecutionBody.safeParse({ status: 'succeeded', costSource: 'local' }).success,
    ).toBe(true)
    const nonzero = completeExecutionBody.safeParse({
      status: 'succeeded',
      costUsd: 1,
      costSource: 'local',
    })
    expect(nonzero.success).toBe(false)
    expect(nonzero.error?.issues[0]?.path).toEqual(['costSource'])
  })

  it('leaves every other source unrestricted', () => {
    expect(
      completeExecutionBody.safeParse({ status: 'succeeded', costUsd: 1, costSource: 'reported' })
        .success,
    ).toBe(true)
  })
})
