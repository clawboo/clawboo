// The record of who is working in a team folder: runs report and go; checks take
// turns, each waiting for the runs going and the check running.

import { describe, expect, it } from 'vitest'

import {
  enterFolderCheckLine,
  folderRunners,
  lastRunWasShared,
  startFolderRun,
} from '../teamFolderActivity'

const FOLDER = '/tmp/clawboo-test/workspaces/T'

const never = (): AbortSignal => new AbortController().signal

/** True once `p` has resolved (a few microtasks later). */
async function resolved(p: Promise<void>): Promise<boolean> {
  let done = false
  void p.then(() => {
    done = true
  })
  for (let i = 0; i < 5; i++) await Promise.resolve()
  return done
}

describe('team folder activity', () => {
  it('remembers whether a teammate worked in the folder during an agent’s latest run', () => {
    const folder = '/shared-run-a'
    const alone = startFolderRun(folder, 'ada')
    alone.release()
    expect(lastRunWasShared(folder, 'ada')).toBe(false)

    // Whichever started first, and after both have ended.
    const ada = startFolderRun(folder, 'ada')
    const zed = startFolderRun(folder, 'zed')
    zed.release()
    ada.release()
    expect(lastRunWasShared(folder, 'ada')).toBe(true)
    expect(lastRunWasShared(folder, 'zed')).toBe(true)

    // The next run starts clean.
    startFolderRun(folder, 'ada').release()
    expect(lastRunWasShared(folder, 'ada')).toBe(false)
    expect(lastRunWasShared(folder, 'nobody')).toBe(false)
  })

  it('an agent’s own second run is not company', () => {
    const folder = '/shared-run-b'
    const first = startFolderRun(folder, 'ada')
    const second = startFolderRun(folder, 'ada')
    first.release()
    second.release()
    expect(lastRunWasShared(folder, 'ada')).toBe(false)
  })

  it('a clear folder gives a check its turn at once', () => {
    const turn = enterFolderCheckLine(FOLDER)
    expect(turn.clear).toBe(true)
    turn.leave()
  })

  it('a check waits for every run going, and gets its turn when the last one ends', async () => {
    const a = startFolderRun(FOLDER, 'a')
    const b = startFolderRun(FOLDER, 'b')
    const turn = enterFolderCheckLine(FOLDER)
    expect(turn.clear).toBe(false)
    const waited = turn.wait(never())

    a.release()
    expect(await resolved(waited)).toBe(false)
    b.release()
    expect(await resolved(waited)).toBe(true)
    expect(turn.sawRun()).toBe(false)
    turn.leave()
  })

  it('names the agents going, without repeats, and forgets them as they end', () => {
    const a = startFolderRun(FOLDER, 'a')
    const again = startFolderRun(FOLDER, 'a')
    const b = startFolderRun(FOLDER, 'b')
    expect(folderRunners(FOLDER)).toEqual(['a', 'b'])

    a.release()
    a.release() // a second release of one run does not end another's
    expect(folderRunners(FOLDER)).toEqual(['a', 'b'])
    again.release()
    b.release()
    expect(folderRunners(FOLDER)).toEqual([])
  })

  it('other folders do not count', () => {
    const other = startFolderRun('/tmp/clawboo-test/workspaces/U', 'a')
    const turn = enterFolderCheckLine(FOLDER)
    expect(turn.clear).toBe(true)
    turn.leave()
    other.release()
  })

  it('checks take turns, first come first served, and neither holds the other for good', async () => {
    const first = enterFolderCheckLine(FOLDER)
    const second = enterFolderCheckLine(FOLDER)
    const third = enterFolderCheckLine(FOLDER)
    expect(first.clear).toBe(true)
    const secondWaited = second.wait(never())
    const thirdWaited = third.wait(never())

    expect(await resolved(secondWaited)).toBe(false)
    first.leave()
    expect(await resolved(secondWaited)).toBe(true)
    expect(await resolved(thirdWaited)).toBe(false)
    second.leave()
    expect(await resolved(thirdWaited)).toBe(true)
    third.leave()
  })

  it('a run does not wait for a check, and a check that has its turn sees it arrive', () => {
    const turn = enterFolderCheckLine(FOLDER)
    expect(turn.clear).toBe(true)
    expect(turn.sawRun()).toBe(false)

    const run = startFolderRun(FOLDER, 'a')
    expect(folderRunners(FOLDER)).toEqual(['a'])
    expect(turn.sawRun()).toBe(true)

    run.release()
    turn.leave()
  })

  it('an abort ends the wait at once, and the check runs beside what is going', async () => {
    const run = startFolderRun(FOLDER, 'a')
    const turn = enterFolderCheckLine(FOLDER)
    const stop = new AbortController()
    const waited = turn.wait(stop.signal)
    expect(await resolved(waited)).toBe(false)

    stop.abort()
    expect(await resolved(waited)).toBe(true)
    expect(turn.sawRun()).toBe(true)

    // Still counted as a check: the next one waits for it as well as for the run.
    const next = enterFolderCheckLine(FOLDER)
    const nextWaited = next.wait(never())
    run.release()
    expect(await resolved(nextWaited)).toBe(false)
    turn.leave()
    expect(await resolved(nextWaited)).toBe(true)
    next.leave()
  })

  it('a check that leaves while waiting gives its place to the next', async () => {
    const run = startFolderRun(FOLDER, 'a')
    const gone = enterFolderCheckLine(FOLDER)
    const next = enterFolderCheckLine(FOLDER)
    const waited = next.wait(never())

    gone.leave()
    gone.leave() // leaving twice does not disturb anyone
    expect(await resolved(waited)).toBe(false)
    run.release()
    expect(await resolved(waited)).toBe(true)
    next.leave()
    const after = enterFolderCheckLine(FOLDER)
    expect(after.clear).toBe(true)
    after.leave()
  })

  it('leaving twice cannot make a folder forget a later run', async () => {
    const turn = enterFolderCheckLine(FOLDER)
    turn.leave()
    const run = startFolderRun(FOLDER, 'a')
    turn.leave()

    expect(folderRunners(FOLDER)).toEqual(['a'])
    const next = enterFolderCheckLine(FOLDER)
    expect(next.clear).toBe(false)
    next.leave()
    run.release()
  })
})
