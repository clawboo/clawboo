// The verify gate with agents on their own OS user (CLAWBOO_AGENT_USER): the
// command runs through the agent host as `/bin/sh -c <command>`, and the reads
// of init.sh and VERIFICATION.md and the evidence append go through the host
// too. The host here is served in-process and runs as the test's own user, so
// the files are real; what each test proves is that the work went through it.

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { startInProcessHost, type InProcessHost } from '../../agentUser/__tests__/inProcessHost'
import { setActiveAgentHost } from '../../agentUser/state'
import { resolveVerifyCommand, runDeterministicGate, verifyShellArgv } from '../deterministicGate'

const posix = process.platform !== 'win32'

let base: string
let wt: string
let h: InProcessHost | null = null
let ops: string[]
let spawned: { command: string; args: readonly string[]; cwd?: string; group: boolean }[]

beforeEach(async () => {
  base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'clawboo-gate-agent-')))
  const dataDir = path.join(base, 'data')
  wt = path.join(dataDir, 'worktrees', 'abc', 't1')
  fs.mkdirSync(wt, { recursive: true })
  vi.stubEnv('HOME', base)
  vi.stubEnv('CLAWBOO_HOME', dataDir)
  vi.stubEnv('CLAWBOO_WORK_DIR', path.join(base, 'work'))
  vi.stubEnv('CLAWBOO_AGENT_USER', 'clawboo-agent')

  h = startInProcessHost()
  const hello = await h.client.waitForHello()
  setActiveAgentHost({
    client: h.client,
    hello: { ...hello, home: path.join(base, 'agent-home') },
    config: { user: 'clawboo-agent', switch: 'sudo', socket: null },
  })
  ops = []
  spawned = []
  const request = h.client.request.bind(h.client)
  vi.spyOn(h.client, 'request').mockImplementation((req) => {
    ops.push(req.op)
    return request(req)
  })
  const spawn = h.client.spawn.bind(h.client)
  vi.spyOn(h.client, 'spawn').mockImplementation((opts) => {
    spawned.push({ command: opts.command, args: opts.args, cwd: opts.cwd, group: opts.group })
    return spawn(opts)
  })
})

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
  setActiveAgentHost(null)
  h?.client.close()
  h = null
  fs.rmSync(base, { recursive: true, force: true })
})

describe.runIf(posix)('the verify gate with agents on their own user', () => {
  it('reads init.sh, runs the command and appends evidence, all through the host', async () => {
    const command = 'printf "%s" verified'
    fs.writeFileSync(path.join(wt, 'init.sh'), `VERIFY_CMD='${command}'\n`)
    fs.writeFileSync(path.join(wt, 'VERIFICATION.md'), '# Verification\n')

    const det = await runDeterministicGate({ worktreePath: wt, env: { PATH: '/usr/bin:/bin' } })

    expect(det).toMatchObject({ command, passed: true, exitCode: 0, stdoutTail: 'verified' })
    expect(spawned).toEqual([{ command: '/bin/sh', args: ['-c', command], cwd: wt, group: true }])
    expect(ops).toContain('fs.read')
    expect(ops).toContain('fs.append')
    const evidence = fs.readFileSync(path.join(wt, 'VERIFICATION.md'), 'utf8')
    expect(evidence.startsWith('# Verification\n')).toBe(true)
    expect(evidence).toMatch(/### Gate run/)
  })

  it('a timeout stops the command tree through the host', async () => {
    const det = await runDeterministicGate({
      worktreePath: wt,
      verifyCommand: 'sleep 30',
      timeoutMs: 100,
      evidence: false,
      env: { PATH: '/usr/bin:/bin' },
    })
    expect(det).toMatchObject({ passed: false, timedOut: true })
    expect(ops).toContain('killTree')
  })

  it('a link at init.sh reads as no command', async () => {
    const outside = path.join(base, 'secret.txt')
    fs.writeFileSync(outside, "VERIFY_CMD='cat secret'\n")
    fs.symlinkSync(outside, path.join(wt, 'init.sh'))
    expect(await resolveVerifyCommand(wt)).toEqual({ command: null, source: 'none' })
    expect(ops).toContain('fs.read')
  })

  it('makes VERIFICATION.md when there is none', async () => {
    await runDeterministicGate({
      worktreePath: wt,
      verifyCommand: 'true',
      env: { PATH: '/usr/bin:/bin' },
    })
    expect(fs.readFileSync(path.join(wt, 'VERIFICATION.md'), 'utf8')).toMatch(/### Gate run/)
    expect(ops).toContain('fs.append')
  })
})

describe('the verify command line', () => {
  it.runIf(posix)('is /bin/sh -c on POSIX, as with shell: true', () => {
    expect(verifyShellArgv('npm test && echo ok')).toEqual({
      command: '/bin/sh',
      args: ['-c', 'npm test && echo ok'],
    })
  })
})
