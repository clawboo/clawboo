// The stop of every agent-user process at boot runs before the startup check,
// so it must never run for a user the check would refuse: root, or the user
// the server runs as. That would stop the server's own processes.

import { afterEach, describe, expect, it, vi } from 'vitest'

const system = vi.hoisted(() => ({
  uid: 0,
  kills: [] as string[],
}))

vi.mock('../system', async (orig) => ({
  ...(await orig<typeof import('../system')>()),
  lookupUser: () => ({ uid: system.uid, gid: system.uid }),
  killAllAgentProcesses: (config: { user: string }) => {
    system.kills.push(config.user)
    return true
  },
}))

import { mayReapAsAgent, startAgentUser } from '../boot'

const posix = process.platform !== 'win32'
const me = process.getuid?.() ?? 1000
const log = { info: () => undefined, warn: () => undefined, error: () => undefined }

describe.runIf(posix)('the boot stop of agent-user processes', () => {
  afterEach(() => {
    system.kills = []
  })

  it.each([
    ['the user the server runs as', () => me],
    ['root', () => 0],
  ])('does not run when the setting names %s', async (_name, uid) => {
    system.uid = uid()
    const report = await startAgentUser({
      env: { CLAWBOO_AGENT_USER: 'someone' },
      log,
      accessToken: 'token-1234567890',
      secretValues: [],
      runtimeBinaries: [],
    })
    expect(report.ok).toBe(false)
    expect(report.steps.find((s) => s.level === 'fail')?.step).toBe(2)
    expect(system.kills).toEqual([])
  })

  it('runs only for a user that exists and is neither root nor the server user', () => {
    expect(mayReapAsAgent('a', () => ({ uid: 10002 }), 10001)).toBe(true)
    expect(mayReapAsAgent('a', () => ({ uid: 10001 }), 10001)).toBe(false)
    expect(mayReapAsAgent('a', () => ({ uid: 0 }), 10001)).toBe(false)
    expect(mayReapAsAgent('a', () => null, 10001)).toBe(false)
  })
})
