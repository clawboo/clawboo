// The ephemeral frame store behind the Browser panel. The bounds are the point:
// this holds base64 image data in the same process that serves every dashboard
// read, so an unbounded version would be a memory leak with a UI attached.

import { afterEach, describe, expect, it } from 'vitest'

import { getScreenshot, putScreenshot, resetScreenshots } from '../screenshotBus'

afterEach(() => resetScreenshots())

const shot = (data: string, toolName = 'browser_take_screenshot') => ({
  data,
  mimeType: 'image/png',
  toolName,
})

describe('screenshotBus', () => {
  it('returns null for an agent that has captured nothing', () => {
    expect(getScreenshot('nobody')).toBeNull()
  })

  it('keeps the newest frame and replaces the previous one', () => {
    putScreenshot('a1', shot('first'))
    putScreenshot('a1', shot('second'))
    expect(getScreenshot('a1')?.data).toBe('second')
  })

  it('keeps agents separate', () => {
    putScreenshot('a1', shot('one'))
    putScreenshot('a2', shot('two'))
    expect(getScreenshot('a1')?.data).toBe('one')
    expect(getScreenshot('a2')?.data).toBe('two')
  })

  it('records the tool and a timestamp so the panel can attribute the frame', () => {
    putScreenshot('a1', { ...shot('x', 'browser_take_screenshot'), ts: 1_700_000_000_000 })
    expect(getScreenshot('a1')).toMatchObject({
      toolName: 'browser_take_screenshot',
      ts: 1_700_000_000_000,
      mimeType: 'image/png',
    })
  })

  it('ignores an empty frame or a missing agent id rather than storing junk', () => {
    putScreenshot('', shot('x'))
    putScreenshot('a1', shot(''))
    expect(getScreenshot('a1')).toBeNull()
  })

  it('evicts the OLDEST agent when the total grows past the cap', () => {
    // Whoever is working now is what the panel is for, so the eviction has to
    // drop stale agents rather than the newest arrival.
    const big = 'x'.repeat(9 * 1024 * 1024)
    putScreenshot('old', { ...shot(big), ts: 1 })
    putScreenshot('mid', { ...shot(big), ts: 2 })
    putScreenshot('new', { ...shot(big), ts: 3 })
    expect(getScreenshot('old')).toBeNull()
    expect(getScreenshot('new')?.data.length).toBe(big.length)
  })
})
