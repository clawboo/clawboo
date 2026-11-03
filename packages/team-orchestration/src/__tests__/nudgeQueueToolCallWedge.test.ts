// A run inside one tool call is silent by design: a long build, a command that
// prints nothing, a shell approval the person has not answered. The nudge
// queue's wedge aborted any run silent for its 10 minutes, before the engine's
// 24-minute allowance for an open tool call, so the host now passes a longer
// wedge to `markBusy` while a tool call is open.

import { describe, expect, it } from 'vitest'

import { createNudgeQueue } from '../nudgeQueue'

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

/** Wait for `done`, polling, for up to 2 seconds (slack for a loaded machine). */
async function until(done: () => boolean): Promise<void> {
  for (let waited = 0; waited < 2_000 && !done(); waited += 5) await sleep(5)
}

describe('createNudgeQueue: a wedge for one markBusy', () => {
  it('holds the session past the default wedge, and wedges at the longer one', async () => {
    const wedged: string[] = []
    const nq = createNudgeQueue({
      wedgeTimeoutMs: 20,
      onWedge: (sk) => {
        wedged.push(sk)
      },
    })
    nq.markBusy('s1', 300)
    await sleep(100)
    expect(wedged).toEqual([])
    expect(nq.isBusy('s1')).toBe(true)
    await until(() => wedged.length > 0)
    expect(wedged).toEqual(['s1'])
    expect(nq.isBusy('s1')).toBe(false)
  })

  it('goes back to the queue default on a later markBusy without one', async () => {
    const wedged: string[] = []
    const nq = createNudgeQueue({
      wedgeTimeoutMs: 20,
      onWedge: (sk) => {
        wedged.push(sk)
      },
    })
    nq.markBusy('s1', 60_000)
    nq.markBusy('s1')
    await until(() => wedged.length > 0)
    expect(wedged).toEqual(['s1'])
  })
})
