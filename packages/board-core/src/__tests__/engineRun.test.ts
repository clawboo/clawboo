import { describe, expect, it } from 'vitest'

import { isEngineRun } from '../dispatch'

describe('isEngineRun', () => {
  it('follows the marker, whatever the row is labelled', () => {
    expect(isEngineRun({ engineRun: 1, executorType: 'openclaw' })).toBe(true)
    expect(isEngineRun({ engineRun: 1, executorType: 'hermes' })).toBe(true)
    expect(isEngineRun({ engineRun: true, executorType: 'hermes' })).toBe(true)
    // The executions route takes any name, so the label alone proves nothing.
    expect(isEngineRun({ engineRun: 0, executorType: 'openclaw' })).toBe(false)
    expect(isEngineRun({ engineRun: false, executorType: 'openclaw' })).toBe(false)
  })

  it('reads a row from before the marker by its label', () => {
    expect(isEngineRun({ engineRun: null, executorType: 'openclaw' })).toBe(true)
    expect(isEngineRun({ executorType: 'openclaw' })).toBe(true)
    expect(isEngineRun({ engineRun: null, executorType: 'codex' })).toBe(false)
    expect(isEngineRun({ executorType: 'openclaw-routine' })).toBe(false)
    expect(isEngineRun({})).toBe(false)
  })
})
