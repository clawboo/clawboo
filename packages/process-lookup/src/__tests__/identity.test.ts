// The identity pieces the server's pid records and the start marker share: they
// moved here from the server so the `clawboo` command can use the same ones.
// The server's own suite (processIdentity.test.ts) still covers the start-time
// probe against real processes through its re-export.

import { describe, expect, it } from 'vitest'

import {
  currentEngineIdentity,
  engineStanding,
  pidExists,
  START_TIME_SLACK_MS,
  startTimeMatch,
} from '../index'

describe('engineStanding', () => {
  const mac = { platform: 'darwin' as const, pidNamespace: null, initStart: null }
  const linux = { platform: 'linux' as const, pidNamespace: 'pid:[1]', initStart: 7 }

  it('takes a record with no namespace for ours where there are none', () => {
    expect(engineStanding({ pidNamespace: null, initStart: null }, mac)).toBe('ours')
  })

  it('leaves alone a record that does not say its namespace', () => {
    expect(engineStanding({}, mac)).toBe('foreign')
  })

  it('tells this run of a Linux namespace from an earlier one and from another', () => {
    expect(engineStanding({ pidNamespace: 'pid:[1]', initStart: 7 }, linux)).toBe('ours')
    expect(engineStanding({ pidNamespace: 'pid:[1]', initStart: 3 }, linux)).toBe('earlierRun')
    expect(engineStanding({ pidNamespace: 'pid:[2]', initStart: 7 }, linux)).toBe('foreign')
    expect(engineStanding({ pidNamespace: 'pid:[1]' }, linux)).toBe('foreign')
    expect(
      engineStanding({ pidNamespace: 'pid:[1]', initStart: 7 }, { ...linux, initStart: null }),
    ).toBe('foreign')
  })
})

describe('startTimeMatch', () => {
  const at = (ms: number) => ({ ok: true, times: new Map([[10, ms]]) })

  it('is the same process within the slack, and another outside it', () => {
    expect(startTimeMatch(10, 1_000_000, at(1_000_000 + START_TIME_SLACK_MS))).toBe('same')
    expect(startTimeMatch(10, 1_000_000, at(1_000_000 + START_TIME_SLACK_MS + 1))).toBe('different')
  })

  it('reads no answer as gone, and a probe that could not run as unknown', () => {
    expect(startTimeMatch(11, 1_000_000, at(1_000_000))).toBe('different')
    expect(startTimeMatch(10, 1_000_000, { ok: false, times: new Map() })).toBe('unknown')
  })
})

describe('pidExists', () => {
  it('sees this process, and no process at an id nothing holds', () => {
    expect(pidExists(process.pid)).toBe(true)
    expect(pidExists(99_999_999)).toBe(false)
    expect(pidExists(0)).toBe(false)
    expect(pidExists(-1)).toBe(false)
  })

  it.skipIf(process.platform === 'win32' || process.getuid?.() === 0)(
    "counts a process this user may not signal (pid 1 is root's) as held",
    () => {
      expect(pidExists(1)).toBe(true)
    },
  )
})

describe('currentEngineIdentity', () => {
  it('names this process and when it started', () => {
    const me = currentEngineIdentity()
    expect(me.pid).toBe(process.pid)
    expect(Math.abs(me.startedAt - (Date.now() - process.uptime() * 1000))).toBeLessThan(1_000)
    expect(me.bootAt % 10_000).toBe(0)
  })
})
