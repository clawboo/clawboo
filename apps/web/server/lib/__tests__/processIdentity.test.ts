// The start-time probe is what lets a boot reap tell a process it recorded from
// a later one that was handed the same pid. When the probe cannot read an
// answer, the reap leaves the process alone, so a probe that quietly fails in
// some locales turns the reap off for everyone using them.

import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  currentBootAt,
  currentBootIdentity,
  currentInitStart,
  currentPidNamespace,
  parseStatStartTime,
  processStartTimes,
} from '../processIdentity'

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

// A real probe on Windows is a PowerShell start, tried twice, each up to 30 s when busy.
vi.setConfig({ testTimeout: 120_000 })

describe('processStartTimes', () => {
  it('tries once more when it could not answer, and takes the second answer', () => {
    const answers = [
      { ok: false, times: new Map<number, number>(), error: 'timed out' },
      { ok: true, times: new Map([[7, 1_000]]) },
    ]
    let asked = 0
    const probe = processStartTimes([7], () => answers[asked++]!)
    expect(asked).toBe(2)
    expect(probe).toEqual(answers[1])
  })

  it('asks once when the first answer stands', () => {
    let asked = 0
    const probe = processStartTimes([7], () => {
      asked += 1
      return { ok: true, times: new Map() }
    })
    expect(asked).toBe(1)
    expect(probe.ok).toBe(true)
  })

  it('says the probe failed when both tries did', () => {
    const probe = processStartTimes([7], () => ({ ok: false, times: new Map(), error: 'nope' }))
    expect(probe).toMatchObject({ ok: false, error: 'nope' })
  })

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

  it('says why when this host has no tool to ask', () => {
    // A minimal image can ship without `ps`. The probe then cannot answer, and
    // the reap that refuses to signal needs the reason for its log.
    const empty = mkdtempSync(path.join(os.tmpdir(), 'clawboo-no-ps-'))
    const savedPath = process.env['PATH']
    process.env['PATH'] = empty
    try {
      const probe = processStartTimes([process.pid])
      expect(probe.ok).toBe(false)
      expect(probe.error).toMatch(/ENOENT/)
    } finally {
      process.env['PATH'] = savedPath
      rmSync(empty, { recursive: true, force: true })
    }
  })
})

describe('boot identity', () => {
  it("reads the start time from a stat line whose command name holds spaces and ')'", () => {
    // Field 2 is the command name in parentheses, and it can contain both, so
    // the fields have to be counted from the LAST ')'.
    const fields = ['S', '0', '1', '1', '0', '-1', '4194560', '85322', '6052620', '120', '1757']
    const rest = ['410', '349', '13780', '5390', '20', '0', '1', '0', '987654', '170356736', '3239']
    const stat = `1 (a) S 9 (b c) ${[...fields, ...rest].join(' ')}\n`
    expect(parseStatStartTime(stat)).toBe(987654)
  })

  it('returns null for a stat line it cannot read', () => {
    expect(parseStatStartTime('')).toBeNull()
    expect(parseStatStartTime('1 (init) S 0 1')).toBeNull()
    expect(parseStatStartTime('1 init S 0 1 1 0 -1 4 8 6 1 1 4 3 1 5 2 0 1 0 6 1 3')).toBeNull()
  })

  it("reads when this namespace's pid 1 started on Linux, and nothing elsewhere", () => {
    const initStart = currentInitStart()
    if (process.platform === 'linux') {
      expect(Number.isSafeInteger(initStart)).toBe(true)
      // Stable for as long as that pid 1 runs.
      expect(currentInitStart()).toBe(initStart)
    } else {
      // macOS and Windows have no PID namespaces: today's identity stays as it is.
      expect(initStart).toBeNull()
    }
  })

  it("reads pid 1's start only from a /proc that belongs to this PID namespace", () => {
    // A container given the host's `/proc` would read the HOST's init there,
    // which outlives every restart of the container. `/proc/self` names the
    // reader by its pid in the namespace that `/proc` belongs to.
    const stat = `1 (init) S 0 1 1 0 -1 4 8 6 1 1 4 3 1 5 20 0 1 0 4242 1 3\n`
    const proc = (self: string) => ({
      platform: 'linux' as const,
      pid: 7,
      readlink: (p: string) => (p === '/proc/self' ? self : 'pid:[4026531836]'),
      readFile: () => stat,
    })
    expect(currentInitStart(proc('7'))).toBe(4242)
    expect(currentInitStart(proc('31337'))).toBeNull()
  })

  it('names the boot, the PID namespace and its pid 1 together', () => {
    expect(currentBootIdentity()).toEqual({
      bootAt: currentBootAt(),
      pidNamespace: currentPidNamespace(),
      initStart: currentInitStart(),
    })
  })
})
