// Git through the agent host past its output limit: the call fails at once,
// as the local one does, even when something git started still holds git's
// output open (a hook, an alias), and that something is stopped too.

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@clawboo/worktrees', async (orig) => ({
  ...(await orig<typeof import('@clawboo/worktrees')>()),
  GIT_MAX_BUFFER: 64,
}))

import { execGit, GitError, setWorktreeIo } from '@clawboo/worktrees'

import { setActiveAgentHost } from '../state'
import { installAgentWorktreeIo } from '../worktreeIo'
import { startInProcessHost, type InProcessHost } from './inProcessHost'

const posix = process.platform !== 'win32'

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

describe.runIf(posix)('git through the agent host, past its output limit', () => {
  let dir: string
  let work: string
  let h: InProcessHost

  beforeEach(async () => {
    dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'agent-wtio-limit-')))
    work = path.join(dir, 'work')
    fs.mkdirSync(work)
    vi.stubEnv('CLAWBOO_HOME', path.join(dir, 'data'))
    vi.stubEnv('CLAWBOO_WORK_DIR', work)
    vi.stubEnv('CLAWBOO_AGENT_USER', 'clawboo-agent')
    installAgentWorktreeIo()
    h = startInProcessHost()
    const hello = await h.client.waitForHello()
    setActiveAgentHost({
      client: h.client,
      hello,
      config: { user: 'clawboo-agent', switch: 'sudo', socket: null },
    })
  })

  afterEach(() => {
    setActiveAgentHost(null)
    h.client.close()
    setWorktreeIo(null)
    vi.unstubAllEnvs()
    fs.rmSync(dir, { recursive: true, force: true })
  })

  it('fails at once and stops what git started', async () => {
    const pidFile = path.join(dir, 'holder.pid')
    // An alias whose shell leaves a child holding git's output open, then
    // writes past the limit.
    const alias = `!sh -c 'sleep 30 & echo $! > ${pidFile}; printf %0200d 0; wait'`
    const started = Date.now()
    const err = await execGit(work, ['-c', `alias.flood=${alias}`, 'flood']).catch(
      (e: unknown) => e,
    )
    expect(err).toBeInstanceOf(GitError)
    expect((err as GitError).message).toMatch(/maxBuffer length exceeded/)
    expect(Date.now() - started).toBeLessThan(10_000)
    const holder = Number(fs.readFileSync(pidFile, 'utf8').trim())
    let gone = false
    for (let i = 0; i < 250 && !gone; i++) {
      gone = !isAlive(holder)
      if (!gone) await new Promise((r) => setTimeout(r, 20))
    }
    if (!gone) process.kill(holder, 'SIGKILL')
    expect(gone).toBe(true)
  }, 20_000)
})
