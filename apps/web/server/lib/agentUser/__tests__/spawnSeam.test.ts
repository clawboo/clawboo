// The spawn seam and the agent-space file verbs, in both modes.

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { buildChildEnv } from '../../runtimes/childEnv'
import { runtimeIdentityHomePath } from '../../runtimes/identityHome'
import { killProcessTree } from '../../runtimes/killTree'
import {
  isHostedAgentProcess,
  setUnavailableAgentBinaries,
  spawnAgentProcess,
} from '../../runtimes/spawner'
import {
  agentList,
  agentMkdir,
  agentReadFile,
  agentRemove,
  agentRename,
  agentStat,
  agentWriteFile,
} from '../agentFs'
import { AgentHostUnavailableError, setActiveAgentHost } from '../state'
import { closed, collect, startInProcessHost, type InProcessHost } from './inProcessHost'

const posix = process.platform !== 'win32'

afterEach(() => {
  vi.unstubAllEnvs()
})

describe.runIf(posix)('spawnAgentProcess with agent isolation off', () => {
  it('is child_process.spawn: a real local child with the env it was given', async () => {
    vi.stubEnv('CLAWBOO_AGENT_USER', '')
    const p = spawnAgentProcess({
      kind: 'probe',
      command: '/bin/sh',
      args: ['-c', 'printf "%s" "$FOO"'],
      env: { PATH: '/usr/bin:/bin', FOO: 'local' },
    })
    expect(isHostedAgentProcess(p)).toBe(false)
    expect(typeof p.pid).toBe('number')
    const out = collect(p.stdout)
    await closed(p)
    expect(await out).toBe('local')
  })
})

describe.runIf(posix)('spawnAgentProcess with agent isolation on', () => {
  let h: InProcessHost | null = null

  beforeEach(() => {
    vi.stubEnv('CLAWBOO_AGENT_USER', 'clawboo-agent')
  })

  afterEach(() => {
    setActiveAgentHost(null)
    h?.client.close()
    h = null
  })

  it('never falls back to a local spawn when the host is not running', () => {
    expect(() =>
      spawnAgentProcess({ kind: 'runtime', command: '/bin/echo', args: ['x'], env: {} }),
    ).toThrow(AgentHostUnavailableError)
  })

  it('starts the process through the host and stops its tree through the host', async () => {
    h = startInProcessHost()
    const hello = await h.client.waitForHello()
    setActiveAgentHost({
      client: h.client,
      hello,
      config: { user: 'clawboo-agent', switch: 'sudo', socket: null },
    })
    const requests: string[] = []
    const orig = h.client.request.bind(h.client)
    vi.spyOn(h.client, 'request').mockImplementation((req) => {
      requests.push(req.op)
      return orig(req)
    })

    const p = spawnAgentProcess({
      kind: 'runtime',
      command: '/bin/sh',
      args: ['-c', 'printf "%s|%s" "$FOO" "$HOME"; sleep 30'],
      env: { PATH: '/usr/bin:/bin', FOO: 'hosted' },
    })
    expect(isHostedAgentProcess(p)).toBe(true)
    let out = ''
    p.stdout?.on('data', (d: Buffer) => {
      out += d.toString()
    })
    for (let i = 0; i < 100 && !out.includes('|'); i++) await new Promise((r) => setTimeout(r, 20))
    // The host filled HOME with its own user's home.
    expect(out).toBe(`hosted|${os.userInfo().homedir}`)

    killProcessTree(p, { graceMs: 100 })
    const done = await closed(p)
    expect(done.signal).toBe('SIGTERM')
    expect(requests).toContain('killTree')
  })

  it('fails a run of a binary the agent user cannot execute, with the reason, without asking the host', async () => {
    h = startInProcessHost()
    const hello = await h.client.waitForHello()
    setActiveAgentHost({
      client: h.client,
      hello,
      config: { user: 'clawboo-agent', switch: 'sudo', socket: null },
    })
    const spawnSpy = vi.spyOn(h.client, 'spawn')
    setUnavailableAgentBinaries([
      { path: '/home/op/.nvm/bin/codex', reason: '/home/op/.nvm/bin/codex is inside /home/op' },
    ])
    try {
      const p = spawnAgentProcess({
        kind: 'runtime',
        command: '/home/op/.nvm/bin/codex',
        args: [],
        env: {},
      })
      const err = new Promise<Error>((r) => p.once('error', r))
      const done = closed(p)
      expect((await err).message).toBe(
        'not available to the agent user: /home/op/.nvm/bin/codex is inside /home/op',
      )
      expect((await done).code).toBe(-13)
      expect(spawnSpy).not.toHaveBeenCalled()
    } finally {
      setUnavailableAgentBinaries([])
    }
  })

  it('puts runtime homes under the agent user home, and refuses without a host', async () => {
    expect(() => runtimeIdentityHomePath('codex', 'a1')).toThrow(AgentHostUnavailableError)
    h = startInProcessHost()
    const hello = await h.client.waitForHello()
    setActiveAgentHost({
      client: h.client,
      hello: { ...hello, home: '/var/lib/clawboo-agent' },
      config: { user: 'clawboo-agent', switch: 'sudo', socket: null },
    })
    expect(runtimeIdentityHomePath('codex', 'a1')).toBe('/var/lib/clawboo-agent/runtimes/codex/a1')
  })

  it("leaves the server user's identity and private locations out of a child's environment", () => {
    vi.stubEnv('HOME', '/Users/operator')
    vi.stubEnv('TMPDIR', '/var/folders/xx/T/')
    vi.stubEnv('SSH_AUTH_SOCK', '/private/tmp/ssh.sock')
    vi.stubEnv('CLAWBOO_HOME', '/Users/operator/.clawboo')
    vi.stubEnv('CLAWBOO_SECRETS_MASTER_KEY', 'k')
    vi.stubEnv('OPENAI_API_KEY', 'sk-ambient')
    const env = buildChildEnv({ CODEX_HOME: '/var/lib/clawboo-agent/runtimes/codex/a1' })
    expect(env['HOME']).toBeUndefined()
    expect(env['TMPDIR']).toBeUndefined()
    expect(env['SSH_AUTH_SOCK']).toBeUndefined()
    expect(env['CLAWBOO_HOME']).toBeUndefined()
    expect(env['CLAWBOO_SECRETS_MASTER_KEY']).toBeUndefined()
    // Ambient provider auth and the caller's grant still pass, as without isolation.
    expect(env['OPENAI_API_KEY']).toBe('sk-ambient')
    expect(env['CODEX_HOME']).toBe('/var/lib/clawboo-agent/runtimes/codex/a1')
  })
})

describe.runIf(posix)('agent-space file verbs', () => {
  let dir: string
  let h: InProcessHost | null = null

  beforeEach(() => {
    dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'agent-fs-')))
  })

  afterEach(() => {
    setActiveAgentHost(null)
    h?.client.close()
    h = null
    fs.rmSync(dir, { recursive: true, force: true })
  })

  async function exercise(): Promise<void> {
    const secret = path.join(dir, 'clawboo.db')
    fs.writeFileSync(secret, 'database')
    const home = path.join(dir, 'home', 'hermes')
    await agentMkdir(home)
    expect(fs.statSync(home).mode & 0o777).toBe(0o700)

    // An agent replaced the config file with a link to the database.
    const config = path.join(home, 'config.yaml')
    fs.symlinkSync(secret, config)
    await expect(agentReadFile(config)).rejects.toMatchObject({ code: 'ELOOP' })
    await agentWriteFile(config, 'model: x\n')
    expect(fs.readFileSync(secret, 'utf8')).toBe('database')
    expect(fs.readFileSync(config, 'utf8')).toBe('model: x\n')
    expect(fs.statSync(config).mode & 0o777).toBe(0o600)
    expect((await agentReadFile(config))?.toString()).toBe('model: x\n')
    expect(await agentReadFile(path.join(home, 'missing'))).toBeNull()

    expect((await agentStat(config))?.type).toBe('file')
    expect(await agentStat(path.join(home, 'missing'))).toBeNull()
    await agentRename(config, path.join(home, 'c2.yaml'))
    expect((await agentList(home)).entries.map((e) => e.name)).toEqual(['c2.yaml'])
    await agentRemove(path.join(dir, 'home'))
    expect(fs.existsSync(path.join(dir, 'home'))).toBe(false)
    expect(fs.readFileSync(secret, 'utf8')).toBe('database')
  }

  it('work locally with isolation off', async () => {
    vi.stubEnv('CLAWBOO_AGENT_USER', '')
    await exercise()
  })

  it('go through the host with isolation on', async () => {
    vi.stubEnv('CLAWBOO_AGENT_USER', 'clawboo-agent')
    h = startInProcessHost()
    const hello = await h.client.waitForHello()
    setActiveAgentHost({
      client: h.client,
      hello,
      config: { user: 'clawboo-agent', switch: 'sudo', socket: null },
    })
    const ops: string[] = []
    const orig = h.client.request.bind(h.client)
    vi.spyOn(h.client, 'request').mockImplementation((req) => {
      ops.push(req.op)
      return orig(req)
    })
    await exercise()
    expect(new Set(ops)).toEqual(
      new Set(['fs.mkdir', 'fs.read', 'fs.write', 'fs.stat', 'fs.rename', 'fs.list', 'fs.rm']),
    )
  })
})
