// Stopping a pool user's processes through the switch: sudo refusing (its own
// "Sorry, user ... is not allowed") must count as a failure, never as "nothing
// left to stop", or boot and team changes would go on with old processes alive.

import { describe, expect, it } from 'vitest'

import { reapPoolUser, reapUserSync } from '../system'

const SORRY =
  "Sorry, user clawboo is not allowed to execute '/usr/bin/kill -KILL -1' as clawboo-a1 on box.\n"

/** A switch that answers `true` and `kill` as told. */
function syncSwitch(answers: { true: [number, string]; kill: [number, string] }) {
  return ((_cmd: string, args: readonly string[]) => {
    const [status, stderr] = args.includes('true') ? answers.true : answers.kill
    return { status, stderr, stdout: '', signal: null, pid: 1, output: [] }
  }) as never
}

function asyncSwitch(answers: { true: [number, string]; kill: [number, string] }) {
  return ((
    _cmd: string,
    args: readonly string[],
    _o: unknown,
    cb: (e: unknown, out: string, err: string) => void,
  ) => {
    const [status, stderr] = args.includes('true') ? answers.true : answers.kill
    setImmediate(() =>
      cb(
        status === 0 ? null : Object.assign(new Error(`exit ${status}`), { code: status }),
        '',
        stderr,
      ),
    )
    return {} as never
  }) as never
}

describe('reapUserSync', () => {
  it('fails when the switch will not run anything as the user', () => {
    expect(
      reapUserSync('sudo', 'clawboo-a1', syncSwitch({ true: [1, SORRY], kill: [1, SORRY] })),
    ).toMatch(/Sorry, user clawboo is not allowed/)
  })

  it('fails when the switch runs true but refuses kill', () => {
    expect(
      reapUserSync('sudo', 'clawboo-a1', syncSwitch({ true: [0, ''], kill: [1, SORRY] })),
    ).toMatch(/Sorry, user/)
  })

  it('takes kill finding nothing to stop as done', () => {
    expect(
      reapUserSync('sudo', 'clawboo-a1', syncSwitch({ true: [0, ''], kill: [1, ''] })),
    ).toBeNull()
  })
})

describe('reapPoolUser', () => {
  it('rejects when sudo refuses, with its own words', async () => {
    await expect(
      reapPoolUser('sudo', 'clawboo-a1', asyncSwitch({ true: [1, SORRY], kill: [1, SORRY] })),
    ).rejects.toThrow(/Sorry, user/)
    await expect(
      reapPoolUser('sudo', 'clawboo-a1', asyncSwitch({ true: [0, ''], kill: [1, SORRY] })),
    ).rejects.toThrow(/Sorry, user/)
  })

  it('resolves when kill finds nothing to stop', async () => {
    await expect(
      reapPoolUser('sudo', 'clawboo-a1', asyncSwitch({ true: [0, ''], kill: [1, ''] })),
    ).resolves.toBeUndefined()
  })
})
