// The restart into the freshly installed version. The successor used to
// inherit the old server's working directory, which `npm install -g` had just
// deleted, so it died while loading and the update looked like it never
// happened.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../cwdGuard', () => ({ liveCwd: () => '/live/dir' }))

const spawnState = vi.hoisted(() => ({
  calls: [] as { cmd: string; args: string[]; opts: Record<string, unknown> }[],
}))
vi.mock('node:child_process', () => ({
  spawn: (cmd: string, args: string[], opts: Record<string, unknown>) => {
    spawnState.calls.push({ cmd, args, opts })
    return { pid: 4321, unref() {} }
  },
}))

import { restartIntoLatest } from '../selfRestart'

describe('restartIntoLatest', () => {
  beforeEach(() => {
    spawnState.calls = []
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllEnvs()
  })

  it('starts the successor in a directory that exists, on the same port, then exits', () => {
    vi.stubEnv('CLAWBOO_VERSION', '0.4.0')
    const exit = vi.fn()
    restartIntoLatest(18790, { exit })

    expect(spawnState.calls).toHaveLength(1)
    const { cmd, args, opts } = spawnState.calls[0]!
    expect(cmd).toBe(process.execPath)
    expect(args).toEqual([process.argv[1]])
    expect(opts['cwd']).toBe('/live/dir')
    expect(opts['detached']).toBe(true)
    const env = opts['env'] as NodeJS.ProcessEnv
    expect(env['CLAWBOO_API_PORT']).toBe('18790')
    expect(env['CLAWBOO_AWAIT_PORT']).toBe('18790')
    // Dropped so the successor reads the new version from disk.
    expect(env['CLAWBOO_VERSION']).toBeUndefined()

    expect(exit).not.toHaveBeenCalled()
    vi.advanceTimersByTime(400)
    expect(exit).toHaveBeenCalledWith(0)
  })
})
