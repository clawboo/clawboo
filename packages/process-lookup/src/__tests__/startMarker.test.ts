// The start marker beside api-port.txt: its fields are a contract an app that
// runs Clawboo reads, and a reader must never trust a recorded port by the
// file's existence. A marker whose pid is free, or held by a process that
// started at another time, is stale; one this machine cannot check falls back
// to the bare port file.

import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import {
  BOOT_AT_SLACK_MS,
  checkStartMarker,
  currentEngineIdentity,
  parseStartMarker,
  readPortRecord,
  readStartMarker,
  type MarkerCheck,
  type StartMarker,
  type StartTimes,
} from '../index'

const BOOT = 1_700_000_000_000
const STARTED = BOOT + 3_600_000

const marker = (over: Partial<StartMarker> = {}): StartMarker => ({
  port: 18790,
  pid: 4242,
  startedAt: STARTED,
  bootAt: BOOT,
  pidNamespace: null,
  initStart: null,
  version: '0.9.0',
  ...over,
})

const probe = (times: Record<number, number>): StartTimes => ({
  ok: true,
  times: new Map(Object.entries(times).map(([k, v]) => [Number(k), v])),
})

/** A system where pid 4242 started at `started`, on the marker's boot. */
const darwin = (started: number | null, exists = true) => ({
  platform: 'darwin' as const,
  pidNamespace: null,
  initStart: null,
  bootAt: BOOT,
  exists: () => exists,
  startTimes: (): StartTimes =>
    started === null ? { ok: false, times: new Map(), error: 'no ps' } : probe({ 4242: started }),
})

describe('parseStartMarker', () => {
  it('reads every field of the contract', () => {
    const m = marker({ pidNamespace: 'pid:[4026531836]', initStart: 12 })
    expect(parseStartMarker(JSON.parse(JSON.stringify(m)))).toEqual(m)
  })

  it('ignores fields it does not know, so a later version may add some', () => {
    expect(parseStartMarker({ ...marker(), extra: true })).toEqual(marker())
  })

  it.each([
    ['a missing port', { port: undefined }],
    ['a fractional port', { port: 18790.5 }],
    ['a port above 65535', { port: 70000 }],
    ['pid 0', { pid: 0 }],
    ['a string pid', { pid: '4242' }],
    ['a missing startedAt', { startedAt: undefined }],
    ['a NaN bootAt', { bootAt: Number.NaN }],
    ['a missing pidNamespace', { pidNamespace: undefined }],
    ['a numeric pidNamespace', { pidNamespace: 4 }],
    ['a string initStart', { initStart: '12' }],
    ['a missing version', { version: undefined }],
  ])('refuses %s', (_name, over) => {
    expect(parseStartMarker({ ...marker(), ...over })).toBeNull()
  })

  it('refuses what is not an object', () => {
    expect(parseStartMarker(null)).toBeNull()
    expect(parseStartMarker([marker()])).toBeNull()
    expect(parseStartMarker('18790')).toBeNull()
  })
})

describe('checkStartMarker', () => {
  it('accepts a live pid that started when the marker says', () => {
    expect(checkStartMarker(marker(), darwin(STARTED + 800)).verdict).toBe('running')
  })

  it('refuses a dead pid', () => {
    const check = checkStartMarker(marker(), darwin(STARTED, false))
    expect(check).toEqual({ verdict: 'gone', reason: 'no process has pid 4242' })
  })

  it('refuses a reused pid: alive, but started at another time', () => {
    expect(checkStartMarker(marker(), darwin(STARTED + 10 * 60_000)).verdict).toBe('gone')
    expect(checkStartMarker(marker(), darwin(STARTED - 10 * 60_000)).verdict).toBe('gone')
  })

  it('refuses a pid the probe has no answer for (it died after the liveness check)', () => {
    const deps = { ...darwin(STARTED), startTimes: () => probe({}) }
    expect(checkStartMarker(marker(), deps).verdict).toBe('gone')
  })

  it('refuses a marker from before the last boot whose pid is now another process', () => {
    const DAY = 86_400_000
    // Rebooted a day later; the pid belongs to a process of the new boot.
    const deps = { ...darwin(STARTED + DAY + 3_600_000), bootAt: BOOT + DAY }
    expect(checkStartMarker(marker(), deps).verdict).toBe('gone')
    // Or nothing holds it at all.
    expect(
      checkStartMarker(marker(), { ...darwin(STARTED, false), bootAt: BOOT + DAY }).verdict,
    ).toBe('gone')
  })

  it('never reads a live server as gone because the wall clock was stepped', () => {
    const STEP = 3 * 3_600_000
    // macOS and Windows: a process's recorded start time stays put; the boot
    // reading (now minus uptime) moves with the step.
    const mac = { ...darwin(STARTED + 800), bootAt: BOOT + STEP }
    expect(checkStartMarker(marker(), mac).verdict).toBe('unknown')
    const back = { ...darwin(STARTED + 800), bootAt: BOOT - STEP }
    expect(checkStartMarker(marker(), back).verdict).toBe('unknown')
    // Linux: `ps` reckons start times from the boot time, so both moved.
    const linux = { ...darwin(STARTED + STEP + 800), bootAt: BOOT + STEP }
    expect(checkStartMarker(marker(), linux).verdict).toBe('unknown')
  })

  it('allows the marker 15 s of start-time slack, not the pid records minute', () => {
    expect(checkStartMarker(marker(), darwin(STARTED + 14_000)).verdict).toBe('running')
    expect(checkStartMarker(marker(), darwin(STARTED + 20_000)).verdict).toBe('gone')
  })

  it('takes two readings of one boot a rounding step apart as the same boot', () => {
    const deps = { ...darwin(STARTED), bootAt: BOOT + BOOT_AT_SLACK_MS }
    expect(checkStartMarker(marker(), deps).verdict).toBe('running')
  })

  it('cannot tell when start times cannot be read here', () => {
    expect(checkStartMarker(marker(), darwin(null)).verdict).toBe('unknown')
  })

  it('cannot tell from another PID namespace, and refuses an earlier run of this one', () => {
    const here = {
      ...darwin(STARTED),
      platform: 'linux' as const,
      pidNamespace: 'pid:[1]',
      initStart: 50,
    }
    const linux = (over: Partial<StartMarker>) => marker({ pidNamespace: 'pid:[1]', ...over })
    expect(checkStartMarker(linux({ initStart: 50 }), here).verdict).toBe('running')
    expect(checkStartMarker(linux({ pidNamespace: 'pid:[2]' }), here).verdict).toBe('unknown')
    expect(checkStartMarker(linux({ initStart: 49 }), here).verdict).toBe('gone')
    // This host cannot read its own namespace: nothing it can prove.
    const blind = { ...here, initStart: null }
    expect(checkStartMarker(linux({ initStart: 50 }), blind).verdict).toBe('unknown')
  })

  it('reads this very process as running, and a process that has exited as gone', () => {
    // Real processes: the identity this process would write, and a child's pid
    // once the child is gone.
    expect(checkStartMarker(marker(currentEngineIdentity())).verdict).toBe('running')
    const child = spawnSync(process.execPath, ['-e', ''])
    expect(child.pid).toBeGreaterThan(0)
    expect(checkStartMarker(marker({ ...currentEngineIdentity(), pid: child.pid! })).verdict).toBe(
      'gone',
    )
  })
})

describe('readPortRecord', () => {
  let dir: string
  beforeEach(() => {
    dir = mkdtempSync(path.join(os.tmpdir(), 'clawboo-marker-'))
  })
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  const writeTxt = (port: number, mtime?: number) => {
    const file = path.join(dir, 'api-port.txt')
    writeFileSync(file, String(port))
    if (mtime !== undefined) utimesSync(file, mtime / 1000, mtime / 1000)
  }
  const writeMarker = (m: StartMarker | string, mtime?: number) => {
    const file = path.join(dir, 'api-port.json')
    writeFileSync(file, typeof m === 'string' ? m : JSON.stringify(m))
    if (mtime !== undefined) utimesSync(file, mtime / 1000, mtime / 1000)
  }
  const says = (verdict: MarkerCheck['verdict']) => (): MarkerCheck => ({ verdict, reason: 'test' })
  const T = Date.now() - 60_000

  it('goes by the port file alone when there is no marker, as before the marker', () => {
    writeTxt(18791)
    expect(readPortRecord(dir, says('gone'))).toMatchObject({ port: 18791, trust: 'unverified' })
  })

  it('goes by the port file alone when the marker cannot be parsed', () => {
    writeTxt(18791)
    writeMarker('{"port":18791')
    expect(readPortRecord(dir, says('gone'))).toMatchObject({ port: 18791, trust: 'unverified' })
    expect(readStartMarker(dir)).toBeNull()
  })

  it('trusts the port of a marker whose server is running', () => {
    writeTxt(18790, T)
    writeMarker(marker({ port: 18790 }), T)
    expect(readPortRecord(dir, says('running'))).toMatchObject({ port: 18790, trust: 'verified' })
  })

  it('marks the record stale when the server the marker names is gone', () => {
    writeTxt(18790, T)
    writeMarker(marker({ port: 18790 }), T)
    expect(readPortRecord(dir, says('gone'))).toMatchObject({ port: 18790, trust: 'stale' })
  })

  it('goes by the port file alone when the marker cannot be checked here', () => {
    writeTxt(18790, T)
    writeMarker(marker({ port: 18790 }), T)
    expect(readPortRecord(dir, says('unknown'))).toMatchObject({
      port: 18790,
      trust: 'unverified',
    })
  })

  it('goes by a port file written after the marker, by a server that writes none', () => {
    writeMarker(marker({ port: 18790 }), T)
    writeTxt(18790, T + 5_000)
    let checked = false
    const record = readPortRecord(dir, () => {
      checked = true
      return { verdict: 'gone', reason: 'test' }
    })
    expect(record).toMatchObject({ port: 18790, trust: 'unverified' })
    expect(checked).toBe(false)
  })

  it('goes by the port file when a stale marker names another port', () => {
    writeTxt(18795, T)
    writeMarker(marker({ port: 18790 }), T)
    expect(readPortRecord(dir, says('gone'))).toMatchObject({ port: 18795, trust: 'unverified' })
  })

  it("trusts a running marker's port over a port file another server wrote first", () => {
    // Two servers starting together: B wrote the port file, then A's marker
    // landed last. A is shown to be running on its port.
    writeTxt(18795, T)
    writeMarker(marker({ port: 18790 }), T + 1_000)
    expect(readPortRecord(dir, says('running'))).toMatchObject({ port: 18790, trust: 'verified' })
  })

  it('reads nothing at all as an unverified null', () => {
    expect(readPortRecord(dir)).toEqual({
      port: null,
      trust: 'unverified',
      marker: null,
      check: null,
    })
  })
})
