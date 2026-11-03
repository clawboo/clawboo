// The start-time probe is what lets a boot reap tell a process it recorded from
// a later one that was handed the same pid. When the probe cannot read an
// answer, the reap leaves the process alone, so a probe that quietly fails in
// some locales turns the reap off for everyone using them.

import { spawn } from 'node:child_process'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { processStartTimes } from '../processIdentity'

const LOCALE_VARS = ['LC_ALL', 'LC_TIME', 'LANG'] as const
let saved: Partial<Record<(typeof LOCALE_VARS)[number], string>>

beforeEach(() => {
  saved = {}
  for (const name of LOCALE_VARS) {
    const value = process.env[name]
    if (value !== undefined) saved[name] = value
  }
})

afterEach(() => {
  for (const name of LOCALE_VARS) {
    const value = saved[name]
    if (value === undefined) delete process.env[name]
    else process.env[name] = value
  }
})

describe('processStartTimes', () => {
  it("reads this process's start time", () => {
    const probe = processStartTimes([process.pid])
    expect(probe.ok).toBe(true)
    const startedAt = probe.times.get(process.pid)
    expect(startedAt).toBeDefined()
    // `lstart` has one-second granularity.
    expect(startedAt).toBeLessThanOrEqual(Date.now() + 1_000)
    expect(startedAt).toBeGreaterThan(Date.now() - 24 * 60 * 60_000)
  })

  it('reads it when the user runs in a locale whose month names Date.parse cannot read', () => {
    // `ps` prints `lstart` in the user's locale, and V8 does not know Russian
    // month names. A host without this locale falls back to C, where the test
    // passes either way.
    process.env['LC_ALL'] = 'ru_RU.UTF-8'
    process.env['LC_TIME'] = 'ru_RU.UTF-8'
    process.env['LANG'] = 'ru_RU.UTF-8'
    const probe = processStartTimes([process.pid])
    expect(probe.times.get(process.pid)).toBeDefined()
  })

  it('answers, rather than failing, when none of the pids is running any more', async () => {
    // A pid can die between the caller's liveness check and the probe. `ps`
    // then exits 1 with no output: that says the process is gone, which is
    // different from a host that cannot report start times at all.
    const child = spawn(process.execPath, ['-e', ''], { stdio: 'ignore' })
    const pid = child.pid
    await new Promise<void>((resolve) => child.once('exit', () => resolve()))
    if (!pid) throw new Error('no pid')
    const probe = processStartTimes([pid])
    expect(probe.ok).toBe(true)
    expect(probe.times.size).toBe(0)
  })
})
