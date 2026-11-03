// The verify command's timeout, across a machine sleep.
//
// A real child runs here: what is under test is whether the gate kills it, and a
// mocked spawn would leave nothing to kill.

import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { runDeterministicGate } from '../deterministicGate'

// Counts the timeout's kills without changing them: the real kill still runs.
const kills = vi.hoisted(() => ({ count: 0 }))
vi.mock('../../runtimes/killTree', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../runtimes/killTree')>()
  return {
    ...actual,
    killProcessTree: (...args: Parameters<typeof actual.killProcessTree>) => {
      kills.count += 1
      actual.killProcessTree(...args)
    },
  }
})

const MIN = 60_000
/** The gate's own default, which is what a verify gets when no timeout is set. */
const GATE_TIMEOUT_MS = 10 * MIN

/** What a sleep does to the process on macOS: the wall clock jumps, and every
 *  timer whose delay passed fires once on wake. `vi.setSystemTime` alone moves
 *  pending timers along with the clock, so a plain timer would never notice. */
function sleepMachine(ms: number): void {
  ;(globalThis.setTimeout as unknown as { clock: { jump(ms: number): void } }).clock.jump(ms)
}

/** Let the gate get as far as its spawn (it reads the command first). */
async function untilSpawned(): Promise<void> {
  for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r))
}

let stateDir: string
let worktreePath: string
let prevHome: string | undefined

beforeEach(async () => {
  stateDir = await mkdtemp(path.join(os.tmpdir(), 'clawboo-gate-'))
  worktreePath = path.join(stateDir, 'worktrees', 'repo', 'task-1')
  await mkdir(worktreePath, { recursive: true })
  prevHome = process.env['CLAWBOO_HOME']
  process.env['CLAWBOO_HOME'] = stateDir
  kills.count = 0
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
})

afterEach(async () => {
  vi.useRealTimers()
  if (prevHome === undefined) delete process.env['CLAWBOO_HOME']
  else process.env['CLAWBOO_HOME'] = prevHome
  await rm(stateDir, { recursive: true, force: true })
})

// `sleep` is POSIX; the timer under test is the same on every platform.
describe.skipIf(process.platform === 'win32')('the verify timeout counts awake time', () => {
  it('a sleep longer than the timeout does not fail a verify still running on wake', async () => {
    // Runs for a real second, long past the fake sleep below.
    const gate = runDeterministicGate({ worktreePath, verifyCommand: 'sleep 1' })
    await untilSpawned()
    await vi.advanceTimersByTimeAsync(4 * MIN)

    // An hour asleep, then one tick on wake.
    sleepMachine(60 * MIN)
    await vi.advanceTimersByTimeAsync(30_000)

    const det = await gate
    expect(kills.count).toBe(0)
    expect(det).toMatchObject({ passed: true, timedOut: false, exitCode: 0 })
  })

  it('a verify that really runs too long is still killed at the limit', async () => {
    const gate = runDeterministicGate({ worktreePath, verifyCommand: 'sleep 30' })
    await untilSpawned()
    await vi.advanceTimersByTimeAsync(GATE_TIMEOUT_MS - 1)
    expect(kills.count).toBe(0)
    await vi.advanceTimersByTimeAsync(1)
    expect(kills.count).toBe(1)
    expect(await gate).toMatchObject({ passed: false, timedOut: true })
  })
})
