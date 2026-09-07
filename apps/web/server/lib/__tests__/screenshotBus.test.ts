// The frame store behind the Browser panel.
//
// Two things are being pinned here. The BOUNDS, because this holds base64 image
// data in the same process that serves every dashboard read and an unbounded
// version would be a memory leak with a UI attached. And the CLAIMS the panel
// makes on top of it: "Nothing captured yet" for a Boo that browsed all
// afternoon is false, and so is showing another agent's frame as though this one
// were browsing.
//
// Every test runs against a throwaway CLAWBOO_HOME. The bus mirrors to disk now,
// so without it these would write frames into the real one.

import { mkdtemp, readdir, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import {
  getScreenshot,
  putScreenshot,
  resetScreenshots,
  restoreScreenshots,
} from '../screenshotBus'
import { flushFrameWrites } from '../screenshotFrames'

let home: string
let prevHome: string | undefined

beforeEach(async () => {
  home = await mkdtemp(path.join(os.tmpdir(), 'clawboo-frames-'))
  prevHome = process.env['CLAWBOO_HOME']
  process.env['CLAWBOO_HOME'] = home
  resetScreenshots()
})

afterEach(async () => {
  await flushFrameWrites()
  resetScreenshots()
  if (prevHome === undefined) delete process.env['CLAWBOO_HOME']
  else process.env['CLAWBOO_HOME'] = prevHome
  await rm(home, { recursive: true, force: true })
})

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

// A real 1x1 PNG, so the bytes that reach the disk are an image rather than a
// string that happens to decode.
const PNG =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='

describe('frames survive a restart', () => {
  it('restores what was captured before the process died', async () => {
    putScreenshot('a1', shot(PNG))
    await flushFrameWrites()

    // The restart: memory is gone, the disk is not.
    resetScreenshots()
    expect(getScreenshot('a1')).toBeNull()

    expect(restoreScreenshots()).toBe(1)
    expect(getScreenshot('a1')?.data).toBe(PNG)
  })

  it('marks a restored frame as restored, so the panel can date it', () => {
    // Without this the view shows an hours-old page identically to a live one,
    // and asserts that an idle Boo is browsing.
    putScreenshot('a1', shot(PNG))
    expect(getScreenshot('a1')?.restored).toBeUndefined()
  })

  it('flags frames that came back from disk', async () => {
    putScreenshot('a1', shot(PNG))
    await flushFrameWrites()
    resetScreenshots()
    restoreScreenshots()

    expect(getScreenshot('a1')?.restored).toBe(true)
  })

  it('a newer capture REPLACES the persisted one rather than accumulating', async () => {
    putScreenshot('a1', shot(PNG, 'first'))
    await flushFrameWrites()
    putScreenshot('a1', shot(PNG, 'second'))
    await flushFrameWrites()

    resetScreenshots()
    restoreScreenshots()
    expect(getScreenshot('a1')?.toolName).toBe('second')
    // One image plus the index: a per-agent store, not a history.
    const files = await readdir(path.join(home, 'frames'))
    expect(files.filter((f) => f.endsWith('.png'))).toHaveLength(1)
  })

  it('keeps every agent, not just the last writer', async () => {
    putScreenshot('a1', shot(PNG))
    putScreenshot('a2', shot(PNG))
    await flushFrameWrites()

    resetScreenshots()
    expect(restoreScreenshots()).toBe(2)
  })

  it('survives an unreadable cache without taking the panel with it', () => {
    // The directory is a cache on someone's disk. A missing or hand-cleared one
    // is a normal state, not an error, and must not throw at boot.
    expect(() => restoreScreenshots()).not.toThrow()
    expect(restoreScreenshots()).toBe(0)
  })

  it('does not let a write failure lose the frame that is already in memory', async () => {
    // The mirror is best-effort by design: reads never touch the disk.
    process.env['CLAWBOO_HOME'] = path.join(home, 'nested', 'deeper')
    putScreenshot('a1', shot(PNG))

    expect(getScreenshot('a1')?.data).toBe(PNG)
    await expect(flushFrameWrites()).resolves.toBeUndefined()
  })
})
