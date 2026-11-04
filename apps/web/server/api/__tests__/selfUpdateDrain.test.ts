// POST /api/system/self-update drains before it restarts: it holds the engine
// from the start, waits for the agent runs already going once the install lands,
// restarts when they finish (or at its bound), and `{ force: true }` restarts
// without waiting. Every end that is not a restart releases the hold.

import { EventEmitter } from 'node:events'

import type { Request, Response } from 'express'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../../lib/platform', () => ({
  isWindows: false,
  resolveShimName: (n: string) => n,
}))
vi.mock('../../lib/cwdGuard', () => ({ liveCwd: () => '/live/dir' }))

const updateState = vi.hoisted(() => ({ versions: [] as (string | null)[] }))
vi.mock('../../lib/updateCheck', () => ({
  selfUpdateRefusal: () => null,
  readVersionFromDisk: () => updateState.versions.shift() ?? null,
  buildUpdateCommand: () => 'npm install -g clawboo@latest',
  computeSelfVersion: async () => ({}),
}))
const restartState = vi.hoisted(() => ({ ports: [] as number[], exits: true }))
vi.mock('../../lib/selfRestart', () => ({
  // True: the process is about to exit, as it is when the relaunch starts.
  restartIntoLatest: (port: number) => (restartState.ports.push(port), restartState.exits),
}))

class FakeChild extends EventEmitter {
  stdout = new EventEmitter()
  stderr = new EventEmitter()
  killed = false
  kill(): boolean {
    this.killed = true
    return true
  }
}
const spawnState = vi.hoisted(() => ({ calls: 0, child: null as unknown }))
vi.mock('node:child_process', () => ({
  spawn: () => {
    spawnState.calls++
    return spawnState.child
  },
}))

import { engineHold } from '../../lib/engineHold'
import { runSlots, setRunSlotsForTests, type RunSlot } from '../../lib/runSlots'
import {
  SELF_UPDATE_HOLD_OWNER,
  SELF_UPDATE_RUN_WAIT_MS,
  UPDATE_INSTALL_HOLD_MS,
  resetSelfUpdateForTests,
  selfUpdatePOST,
} from '../systemUpdate'

interface Started {
  child: FakeChild
  frames: Record<string, unknown>[]
  ends: () => number
}

const open: FakeChild[] = []

function post(body?: Record<string, unknown>): Started {
  const child = new FakeChild()
  spawnState.child = child
  const frames: Record<string, unknown>[] = []
  let ended = 0
  const res = {
    setHeader() {},
    flushHeaders() {},
    write(chunk: string) {
      const m = chunk.match(/^data: (.*)\n\n$/s)
      if (m) frames.push(JSON.parse(m[1]!) as Record<string, unknown>)
      return true
    },
    end() {
      ended++
    },
    on() {},
  } as unknown as Response
  const req = { app: { locals: { apiPort: 18790 } }, body } as unknown as Request
  void selfUpdatePOST(req, res)
  open.push(child)
  return { child, frames, ends: () => ended }
}

const types = (frames: Record<string, unknown>[]): unknown[] => frames.map((f) => f['type'])

describe('POST /api/system/self-update drains first', () => {
  let going: RunSlot[] = []

  beforeEach(() => {
    vi.useFakeTimers()
    spawnState.calls = 0
    updateState.versions = ['0.5.0', '0.6.0']
    restartState.ports = []
    restartState.exits = true
    // The process's own slots, which follow the process's hold.
    setRunSlotsForTests(null)
    going = []
  })
  afterEach(async () => {
    // End any install a test left running, so the next one is not "in progress".
    for (const child of open.splice(0)) child.emit('close', 1)
    for (const slot of going) slot.release()
    await vi.advanceTimersByTimeAsync(1_000)
    resetSelfUpdateForTests()
    engineHold().release(SELF_UPDATE_HOLD_OWNER)
    setRunSlotsForTests(null)
    vi.useRealTimers()
  })

  it('holds the engine while npm installs, so no new run starts', () => {
    post()
    expect(
      engineHold()
        .list()
        .map((h) => h.owner),
    ).toEqual([SELF_UPDATE_HOLD_OWNER])
    expect(runSlots().tryAcquire()).toBeNull()
  })

  it('releases the hold when the install fails', async () => {
    const { child } = post()
    child.emit('close', 1)
    expect(engineHold().isHeld()).toBe(false)
    expect(runSlots().tryAcquire()).not.toBeNull()
  })

  it('waits for the runs going, then restarts once they finish', async () => {
    going = [runSlots().tryAcquire()!, runSlots().tryAcquire()!]
    const { child, frames, ends } = post()
    child.emit('close', 0)

    expect(types(frames)).toEqual(['progress', 'installed', 'progress'])
    expect(frames[2]).toMatchObject({ step: 'waiting', running: 2 })
    expect(restartState.ports).toEqual([])
    expect(engineHold().isHeld()).toBe(true)

    going[0]!.release()
    await vi.advanceTimersByTimeAsync(500)
    expect(frames.at(-1)).toMatchObject({ step: 'waiting', running: 1 })
    expect(restartState.ports).toEqual([])

    going[1]!.release()
    going = []
    await vi.advanceTimersByTimeAsync(500)
    expect(frames.at(-1)).toMatchObject({ type: 'restarting', port: 18790, interruptedRuns: 0 })
    expect(restartState.ports).toEqual([18790])
    expect(ends()).toBe(1)
    // The hold stays for the few hundred ms until this process exits.
    expect(engineHold().isHeld()).toBe(true)
  })

  it('keeps its hold alive through a wait longer than the hold lives', async () => {
    going = [runSlots().tryAcquire()!]
    const { child } = post()
    child.emit('close', 0)
    await vi.advanceTimersByTimeAsync(5 * 60_000)
    expect(engineHold().isHeld()).toBe(true)
    expect(restartState.ports).toEqual([])
  })

  it('restarts at its bound with the runs still going, and says how many', async () => {
    going = [runSlots().tryAcquire()!]
    const { child, frames } = post()
    child.emit('close', 0)
    await vi.advanceTimersByTimeAsync(SELF_UPDATE_RUN_WAIT_MS - 1_000)
    expect(restartState.ports).toEqual([])
    await vi.advanceTimersByTimeAsync(1_000)
    expect(frames.at(-1)).toMatchObject({ type: 'restarting', interruptedRuns: 1 })
    expect(restartState.ports).toEqual([18790])
  })

  it('restarts as soon as the install lands when asked with force', () => {
    going = [runSlots().tryAcquire()!]
    const { child, frames } = post({ force: true })
    child.emit('close', 0)
    expect(types(frames)).toEqual(['progress', 'installed', 'restarting'])
    expect(frames.at(-1)).toMatchObject({ interruptedRuns: 1 })
    expect(restartState.ports).toEqual([18790])
  })

  it('a forced request makes a waiting update restart now, without a second install', async () => {
    going = [runSlots().tryAcquire()!]
    const first = post()
    first.child.emit('close', 0)
    expect(restartState.ports).toEqual([])

    const second = post({ force: true })
    expect(spawnState.calls).toBe(1)
    expect(types(second.frames)).toEqual(['forced'])
    expect(second.ends()).toBe(1)

    await vi.advanceTimersByTimeAsync(0)
    expect(first.frames.at(-1)).toMatchObject({ type: 'restarting', interruptedRuns: 1 })
    expect(restartState.ports).toEqual([18790])
  })

  it('starts no second install while the server exits after its restart', () => {
    const first = post()
    first.child.emit('close', 0)
    expect(restartState.ports).toEqual([18790])

    expect(types(post({ force: true }).frames)).toEqual(['forced'])
    expect(types(post().frames)).toEqual(['error'])
    expect(spawnState.calls).toBe(1)
  })

  it('lets work start again when the server cannot relaunch and keeps running', () => {
    restartState.exits = false
    const { child } = post()
    child.emit('close', 0)
    expect(restartState.ports).toEqual([18790])
    expect(engineHold().isHeld()).toBe(false)
    // And a later update may run.
    post()
    expect(spawnState.calls).toBe(2)
  })

  it('stops holding agent work back when the install stalls past its bound', async () => {
    const { child, frames } = post()
    await vi.advanceTimersByTimeAsync(UPDATE_INSTALL_HOLD_MS)
    expect(engineHold().isHeld()).toBe(true)
    // The renewals stop, so the hold lapses within its time to live.
    await vi.advanceTimersByTimeAsync(60_000)
    expect(engineHold().isHeld()).toBe(false)

    // Once the install lands, the update holds again before it waits.
    going = [runSlots().tryAcquire()!]
    child.emit('close', 0)
    expect(engineHold().isHeld()).toBe(true)
    expect(frames.at(-1)).toMatchObject({ step: 'waiting', running: 1 })
  })

  it('refuses a second update while one is in progress', () => {
    post()
    const second = post()
    expect(spawnState.calls).toBe(1)
    expect(second.frames).toEqual([
      { type: 'error', code: 'IN_PROGRESS', message: 'An update is already in progress.' },
    ])
  })
})
