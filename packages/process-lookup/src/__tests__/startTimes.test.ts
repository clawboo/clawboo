// When a process started, from `ps` on macOS and Linux. `ps` prints `lstart`
// in local time with no offset, so in the hour a DST change repeats two start
// times an hour apart print the same, and a live server would read as a reused
// pid. It runs in UTC and its output is read as UTC.
//
// `ps` is stood in for here, so the repeated hour can be shown on any machine.

import { afterEach, describe, expect, it, vi } from 'vitest'

const ps = vi.hoisted(() => ({
  out: '',
  envs: [] as (NodeJS.ProcessEnv | undefined)[],
}))
vi.mock('node:child_process', async (orig) => ({
  ...(await orig<typeof import('node:child_process')>()),
  execFileSync: (_file: string, _args: readonly string[], opts?: { env?: NodeJS.ProcessEnv }) => {
    ps.envs.push(opts?.env)
    return ps.out
  },
}))

const { processStartTimes } = await import('../identity')

const savedTz = process.env['TZ']
afterEach(() => {
  if (savedTz === undefined) delete process.env['TZ']
  else process.env['TZ'] = savedTz
})

describe.runIf(process.platform !== 'win32')('processStartTimes on macOS and Linux', () => {
  it('reads ps in UTC, so the hour a DST change repeats reads right', () => {
    process.env['TZ'] = 'America/New_York'
    // 1 November 2026, 06:30 UTC: 01:30 EST, the second 01:30 in New York that
    // night. In local time `ps` would print the same as at 05:30 UTC.
    ps.out = ' 4242 Sun Nov  1 06:30:00 2026\n 4243 Sun Nov  1 05:30:00 2026\n'
    const got = processStartTimes([4242, 4243])
    expect(ps.envs.at(-1)).toMatchObject({ TZ: 'UTC0', LC_ALL: 'C' })
    expect(got.ok).toBe(true)
    expect(got.times.get(4242)).toBe(Date.UTC(2026, 10, 1, 6, 30))
    expect(got.times.get(4243)).toBe(Date.UTC(2026, 10, 1, 5, 30))
  })

  it('leaves out a line it cannot read', () => {
    ps.out = ' 4242 yesterday\n 4243 Sun Nov  1 05:30:00 2026\n'
    const got = processStartTimes([4242, 4243])
    expect([...got.times.keys()]).toEqual([4243])
  })
})
