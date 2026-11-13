// The startup check (design 4.6): each refusal, with a real host served in this
// process and the machine-touching parts faked. The container test runs the
// same check against real users.

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { AgentHostClient } from '../client'
import {
  dataDirProblem,
  narrowDataDir,
  runAgentUserCheck,
  unsafeParents,
  type CheckDeps,
} from '../check'
import type { AgentUserConfig } from '../config'
import { killAllAgentProcesses, socketProblem } from '../system'
import { startInProcessHost, type InProcessHost } from './inProcessHost'

const posix = process.platform !== 'win32'
const me = { uid: process.getuid?.() ?? 0, gid: process.getgid?.() ?? 0 }
const config: AgentUserConfig = { user: 'clawboo-agent', switch: 'sudo', socket: null }

// What a separate, unprivileged agent user gets back from the two ops whose
// answers depend on who runs the host rather than on the files under test. The
// host here runs as this test's own user, so left to the machine these would
// describe that user: on Linux it can read its own /proc/<pid>/environ, and a CI
// runner's user has passwordless sudo. Each refusal below replaces one of them,
// and the step 8 tests near the end run the real host against a stand-in sudo.
const SEPARATE_USER_ANSWERS: Record<string, Record<string, unknown>> = {
  procView: {
    environ: { ok: false, code: 'EACCES' },
    cmdline: { ok: true, text: 'node server.js' },
    psEnv: { ok: false, code: 'ENOTSUP' },
  },
  privCheck: {
    attempts: [
      { what: 'sudo', ran: true, succeeded: false },
      { what: 'sudo -l', ran: true, succeeded: false },
    ],
    crontab: 'denied',
  },
}

// The fixture serves the agent user from this process, so the agent user here
// has this test's uid. As root that is uid 0, which the check refuses at step 2
// before any later step can be reached; a faked non-root uid would then not
// match the host's own. The check as root is the container proof's, with real
// users.
describe.runIf(posix && me.uid !== 0)('agent isolation startup check', () => {
  let dir: string
  let hosts: InProcessHost[]
  let deps: CheckDeps
  let stopped: AgentHostClient[]
  /** Ops answered here instead of by the host, by op name. */
  let answers: Map<string, Record<string, unknown>>

  beforeEach(() => {
    dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'agent-check-')))
    fs.mkdirSync(path.join(dir, 'data'))
    fs.mkdirSync(path.join(dir, 'work'))
    hosts = []
    stopped = []
    answers = new Map(Object.entries(SEPARATE_USER_ANSWERS))
    deps = {
      platform: 'linux',
      // The host below runs as this test's user, so "the server" is someone else.
      serverUid: me.uid + 100_000,
      serverPid: process.pid,
      serverHome: path.join(dir, 'server-home-missing'),
      lookupUser: () => ({ uid: me.uid, gid: me.gid }),
      accessToken: 'token-1234567890',
      dataDir: path.join(dir, 'data'),
      // Missing files read as unreadable, which is what the check wants.
      protectedFiles: [path.join(dir, 'data', 'clawboo.db'), path.join(dir, 'data', 'master.key')],
      operatorFiles: [path.join(dir, 'no-such-home', '.codex', 'auth.json')],
      workDirFor: () => ({ dir: path.join(dir, 'work'), create: false }),
      secretValues: ['sk-the-saved-provider-key'],
      runtimeBinaries: [],
      narrowDataDir: () => [],
      unsafeParents: () => [],
      dataDirProblem: () => null,
      startHost: async () => {
        const h = startInProcessHost()
        hosts.push(h)
        const orig = h.client.request.bind(h.client)
        vi.spyOn(h.client, 'request').mockImplementation(((
          req: { op: string },
          o?: { timeoutMs?: number },
        ) => {
          const answer = answers.get(req.op)
          return answer ? Promise.resolve(answer) : orig(req as never, o)
        }) as never)
        return h.client
      },
      socketProblem: () => null,
      stopHost: (c) => {
        stopped.push(c)
        c.close()
      },
    }
    // The data folder listing must fail for the agent; this user owns it, so
    // close it to everyone (root aside).
    fs.chmodSync(path.join(dir, 'data'), 0o000)
  })

  afterEach(() => {
    vi.unstubAllEnvs()
    for (const h of hosts) h.client.close()
    fs.chmodSync(path.join(dir, 'data'), 0o700)
    fs.rmSync(dir, { recursive: true, force: true })
  })

  /** The host's answer to one op, replaced; every other op goes to the real host. */
  function override(op: string, answer: Record<string, unknown>): void {
    answers.set(op, answer)
  }

  const failed = (r: { steps: { level: string; step: number; message: string }[] }) =>
    r.steps.find((s) => s.level === 'fail')

  it('passes when the agent user can reach nothing private, and keeps the host', async () => {
    const r = await runAgentUserCheck(config, deps)
    expect(failed(r)).toBeUndefined()
    expect(r.ok).toBe(true)
    expect(r.client).not.toBeNull()
    expect(r.workDir).toBe(path.join(dir, 'work'))
    expect([...new Set(r.steps.map((s) => s.step))]).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9])
    expect(r.steps.find((s) => s.step === 8)).toMatchObject({
      level: 'ok',
      name: 'agent privileges',
    })
  })

  it('refuses on Windows', async () => {
    const r = await runAgentUserCheck(config, { ...deps, platform: 'win32' })
    expect(failed(r)).toMatchObject({ step: 1 })
    expect(failed(r)?.message).toMatch(/not supported on Windows.*WSL 2/)
  })

  it('refuses a user that does not exist, is the server user, or is root', async () => {
    let r = await runAgentUserCheck(config, { ...deps, lookupUser: () => null })
    expect(failed(r)?.message).toMatch(/no such user.*clawboo agent-user plan/)
    r = await runAgentUserCheck(config, {
      ...deps,
      lookupUser: () => ({ uid: deps.serverUid, gid: 1 }),
    })
    expect(failed(r)?.message).toMatch(/is the user Clawboo runs as/)
    r = await runAgentUserCheck(config, { ...deps, lookupUser: () => ({ uid: 0, gid: 0 }) })
    expect(failed(r)?.message).toMatch(/is root/)
  })

  it('refuses without an access token', async () => {
    const r = await runAgentUserCheck(config, { ...deps, accessToken: null })
    expect(failed(r)).toMatchObject({ step: 3 })
    expect(failed(r)?.message).toMatch(/needs an access token.*STUDIO_ACCESS_TOKEN/)
  })

  it('refuses a data folder under a folder others can change', async () => {
    const r = await runAgentUserCheck(config, { ...deps, unsafeParents: () => ['/srv/shared'] })
    expect(failed(r)).toMatchObject({ step: 4 })
    expect(failed(r)?.message).toMatch(/\/srv\/shared can be changed/)
  })

  it('refuses when the switch fails, printing the sudoers lines filled in', async () => {
    const r = await runAgentUserCheck(
      config,
      {
        ...deps,
        startHost: async () => {
          throw new Error('sudo: a password is required')
        },
      },
      { serverUser: 'alice' },
    )
    expect(failed(r)).toMatchObject({ step: 5 })
    expect(failed(r)?.message).toContain('sudo: a password is required')
    expect(failed(r)?.message).toContain('alice ALL=(clawboo-agent) NOPASSWD: ALL')
    expect(failed(r)?.message).toContain('Defaults:alice !requiretty')
  })

  it('prints the sudoers lines when sudo starts but exits before the host says hello', async () => {
    const { startFakeHost } = await import('./inProcessHost')
    const r = await runAgentUserCheck(
      config,
      {
        ...deps,
        startHost: async () => {
          const fake = startFakeHost()
          // sudo -n with no rule: it prints its complaint and exits.
          setImmediate(() => fake.toServer.end())
          return fake.client
        },
      },
      { serverUser: 'alice' },
    )
    expect(failed(r)).toMatchObject({ step: 5 })
    expect(failed(r)?.message).toContain('alice ALL=(clawboo-agent) NOPASSWD: ALL')
  })

  it('refuses a launcher socket with the wrong owner or mode before connecting', async () => {
    const start = vi.fn(deps.startHost)
    const r = await runAgentUserCheck(
      { ...config, socket: '/run/clawboo/agent.sock' },
      { ...deps, startHost: start, socketProblem: () => '/run/clawboo is owned by uid 0' },
    )
    expect(failed(r)).toMatchObject({ step: 5, name: 'host socket' })
    expect(start).not.toHaveBeenCalled()
  })

  it('refuses a host that is not the named user', async () => {
    const r = await runAgentUserCheck(config, {
      ...deps,
      lookupUser: () => ({ uid: me.uid + 1, gid: me.gid }),
    })
    expect(failed(r)).toMatchObject({ step: 6 })
    expect(stopped).toHaveLength(1)
  })

  it('refuses when the agent user can read a protected file, and says how to fix it', async () => {
    const db = path.join(dir, 'readable.db')
    fs.writeFileSync(db, 'x')
    const r = await runAgentUserCheck(config, { ...deps, protectedFiles: [db] })
    expect(failed(r)).toMatchObject({ step: 7 })
    expect(failed(r)?.message).toBe(
      `The agent user can read ${db}. Run \`chmod 600 ${db}\` (or \`chmod 700\` on its folder) and start Clawboo again.`,
    )
    expect(stopped).toHaveLength(1)
  })

  it('refuses when the operator login files are readable', async () => {
    const auth = path.join(dir, 'auth.json')
    fs.writeFileSync(auth, '{}')
    const r = await runAgentUserCheck(config, { ...deps, operatorFiles: [auth] })
    expect(failed(r)?.message).toContain(`can read ${auth}`)
  })

  it('warns, and does not refuse, when the server home can be listed', async () => {
    const r = await runAgentUserCheck(config, { ...deps, serverHome: dir })
    expect(r.ok).toBe(true)
    expect(r.steps.find((s) => s.level === 'warn')?.message).toMatch(/chmod 750/)
  })

  it('refuses a work folder the agent user cannot write', async () => {
    const r = await runAgentUserCheck(config, {
      ...deps,
      workDirFor: () => ({ dir: path.join(dir, 'no-such-work'), create: false }),
    })
    expect(failed(r)).toMatchObject({ step: 7, name: 'work folder' })
    expect(failed(r)?.message).toMatch(/install -d -o clawboo-agent -m 700/)
  })

  it('creates the default work folder through the host', async () => {
    const work = path.join(dir, 'agent-home', 'work')
    fs.mkdirSync(path.dirname(work))
    const r = await runAgentUserCheck(config, {
      ...deps,
      workDirFor: () => ({ dir: work, create: true }),
    })
    expect(r.ok).toBe(true)
    expect(fs.statSync(work).mode & 0o777).toBe(0o700)
  })

  it("refuses on Linux when the agent user can read the server's environment", async () => {
    override('procView', {
      environ: { ok: true, text: 'PATH=/usr/bin' },
      cmdline: { ok: true, text: 'node server.js' },
      psEnv: { ok: false },
    })
    const r = await runAgentUserCheck(config, deps)
    expect(failed(r)?.message).toMatch(/can read this server's environment/)
  })

  it('refuses when a secret shows in what the agent user can see of the process', async () => {
    override('procView', {
      environ: { ok: false, code: 'EACCES' },
      cmdline: { ok: true, text: 'node server.js --key sk-the-saved-provider-key' },
      psEnv: { ok: false },
    })
    const r = await runAgentUserCheck(config, deps)
    expect(failed(r)?.message).toMatch(/can see a secret in this server's command line/)
    // The message never repeats the secret.
    expect(failed(r)?.message).not.toContain('sk-the-saved')
  })

  it('refuses a hard link to a protected file inside the work folder', async () => {
    // The server must be able to stat its own file; the host here runs as the
    // same user, so the read canaries are answered as a separate user would.
    const db = path.join(dir, 'private', 'clawboo.db')
    fs.mkdirSync(path.dirname(db))
    fs.writeFileSync(db, 'db', { mode: 0o600 })
    fs.mkdirSync(path.join(dir, 'work', 'teams'))
    fs.linkSync(db, path.join(dir, 'work', 'teams', 'notes.txt'))
    const work = path.join(dir, 'work')
    override('probe', {
      results: [
        { path: db, mode: 'read', ok: false, code: 'EACCES' },
        { path: deps.dataDir, mode: 'list', ok: false, code: 'EACCES' },
        ...deps.operatorFiles.map((p) => ({ path: p, mode: 'read', ok: false, code: 'EACCES' })),
        { path: deps.serverHome, mode: 'list', ok: false, code: 'EACCES' },
        { path: work, mode: 'write', ok: true },
      ],
    })
    const r = await runAgentUserCheck(config, { ...deps, protectedFiles: [db] })
    expect(failed(r)?.message).toBe(
      `${path.join(work, 'teams', 'notes.txt')} is a hard link to one of Clawboo's private files. Remove it (as an administrator) and start Clawboo again.`,
    )
  })

  it('refuses an agent user that can become another user', async () => {
    override('privCheck', {
      attempts: [
        { what: 'sudo', ran: true, succeeded: false },
        { what: 'sudo -u alice', ran: true, succeeded: true },
      ],
      crontab: 'denied',
    })
    const r = await runAgentUserCheck(config, deps, { serverUser: 'alice' })
    expect(failed(r)).toMatchObject({ step: 8 })
    expect(failed(r)?.message).toContain('can run `sudo -u alice`')
  })

  it('warns when the agent user may schedule its own jobs', async () => {
    override('privCheck', {
      attempts: [{ what: 'sudo', ran: true, succeeded: false }],
      crontab: 'allowed',
    })
    const r = await runAgentUserCheck(config, deps)
    expect(r.ok).toBe(true)
    expect(r.steps.find((s) => s.name === 'scheduled jobs')?.message).toMatch(/cron\.deny/)
  })

  it('refuses a setuid file in the work folder that the agent user does not own', async () => {
    override('inodes', { matches: [], privileged: ['/work/teams/t/cat'], truncated: false })
    const r = await runAgentUserCheck(config, deps)
    expect(failed(r)).toMatchObject({ step: 7, name: 'setuid files' })
    expect(failed(r)?.message).toMatch(/chmod ug-s/)
  })

  it('refuses a work folder too large to search for setuid files, without no_new_privs', async () => {
    override('inodes', { matches: [], privileged: [], truncated: true })
    const r = await runAgentUserCheck(config, deps)
    expect(failed(r)).toMatchObject({ step: 7, name: 'setuid files' })
    expect(failed(r)?.message).toMatch(/too large to search completely/)
    expect(failed(r)?.message).toMatch(/setpriv/)
  })

  it('only warns about a work folder too large to search when the host has no_new_privs', async () => {
    override('inodes', { matches: [], privileged: [], truncated: true, noNewPrivs: true })
    const r = await runAgentUserCheck(config, deps)
    expect(r.ok).toBe(true)
    expect(r.steps.find((s) => s.name === 'hard links')?.level).toBe('warn')
  })

  it('refuses a work folder with a folder the search could not enter, no_new_privs or not', async () => {
    override('inodes', {
      matches: [],
      privileged: [],
      truncated: false,
      noNewPrivs: true,
      unreadable: ['/work/teams/t/private'],
    })
    const r = await runAgentUserCheck(config, deps)
    expect(failed(r)).toMatchObject({ step: 7, name: 'hard links' })
    expect(failed(r)?.message).toContain('/work/teams/t/private')
    expect(failed(r)?.message).toMatch(/chmod u\+rx/)
  })

  it('refuses an agent user with a sudo rule it can use', async () => {
    override('privCheck', {
      attempts: [
        { what: 'sudo', ran: true, succeeded: false },
        { what: 'sudo -l', ran: true, succeeded: true },
      ],
      crontab: 'denied',
    })
    const r = await runAgentUserCheck(config, deps)
    expect(failed(r)).toMatchObject({ step: 8 })
    expect(failed(r)?.message).toContain('has sudo rules it can use without a password')
  })

  it('refuses a data folder that is not the server user alone', async () => {
    const r = await runAgentUserCheck(config, {
      ...deps,
      dataDirProblem: () => 'The data folder /data has mode 755. Run `chmod 700 /data`.',
    })
    expect(failed(r)).toMatchObject({ step: 4 })
  })

  // Step 8 through the real host, with the host's sudo tries and listing
  // answered by a stand-in on PATH rather than by whatever rights this
  // machine's user has.
  function sudoOnPath(script: string | null): void {
    const bin = path.join(dir, 'bin')
    fs.mkdirSync(bin, { recursive: true })
    if (script !== null) fs.writeFileSync(path.join(bin, 'sudo'), script, { mode: 0o755 })
    vi.stubEnv(
      'PATH',
      script === null ? bin : `${bin}${path.delimiter}${process.env['PATH'] ?? ''}`,
    )
    answers.delete('privCheck')
  }

  it('refuses at step 8 when the host finds sudo rights for the agent user', async () => {
    sudoOnPath('#!/bin/sh\nexit 0\n')
    const r = await runAgentUserCheck(config, deps)
    expect(failed(r)).toMatchObject({ step: 8, name: 'agent privileges' })
    expect(failed(r)?.message).toContain('can run `sudo`')
    expect(stopped).toHaveLength(1)
  })

  it('refuses at step 8 a sudo rule that only the listing shows', async () => {
    sudoOnPath(
      '#!/bin/sh\nif [ "$1 $2" = "-n -l" ]; then\n  echo "(root) /bin/sh"\n  exit 0\nfi\nexit 1\n',
    )
    const r = await runAgentUserCheck(config, deps)
    expect(failed(r)).toMatchObject({ step: 8, name: 'agent privileges' })
    expect(failed(r)?.message).toContain('has sudo rules it can use without a password')
  })

  it('passes step 8 when sudo refuses the agent user, or is not installed', async () => {
    sudoOnPath('#!/bin/sh\necho "Sorry, user clawboo-agent may not run sudo." >&2\nexit 1\n')
    let r = await runAgentUserCheck(config, deps)
    expect(r.ok).toBe(true)
    expect(r.steps.find((s) => s.step === 8 && s.level !== 'warn')).toMatchObject({ level: 'ok' })

    sudoOnPath(null)
    fs.rmSync(path.join(dir, 'bin', 'sudo'))
    r = await runAgentUserCheck(config, deps)
    expect(r.ok).toBe(true)
    expect(r.steps.find((s) => s.step === 8 && s.level !== 'warn')).toMatchObject({ level: 'ok' })
  })

  it('shows a runtime the agent user cannot run, without refusing', async () => {
    const r = await runAgentUserCheck(config, {
      ...deps,
      runtimeBinaries: [{ runtime: 'codex', path: path.join(dir, 'no-such-codex') }],
    })
    expect(r.ok).toBe(true)
    expect(r.unavailableRuntimes).toEqual([
      expect.objectContaining({
        runtime: 'codex',
        reason: expect.stringMatching(/not available to clawboo-agent/),
      }),
    ])
  })
})

describe.runIf(posix)('agent isolation system helpers', () => {
  let dir: string
  beforeEach(() => {
    dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'agent-sys-')))
  })
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true })
  })

  it('accepts only the launcher contract for the socket folder and socket', async () => {
    const run = path.join(dir, 'run')
    fs.mkdirSync(run, { mode: 0o710 })
    fs.chmodSync(run, 0o710)
    const sockPath = path.join(run, 'agent.sock')
    const net = await import('node:net')
    const server = net.createServer()
    await new Promise<void>((r) => server.listen(sockPath, () => r()))
    try {
      fs.chmodSync(sockPath, 0o660)
      expect(socketProblem(sockPath, me.uid, me.gid)).toBeNull()
      expect(socketProblem(sockPath, me.uid + 1, me.gid)).toMatch(/owned by uid/)
      fs.chmodSync(sockPath, 0o666)
      expect(socketProblem(sockPath, me.uid, me.gid)).toMatch(/mode 666/)
      fs.chmodSync(sockPath, 0o660)
      fs.chmodSync(run, 0o755)
      expect(socketProblem(sockPath, me.uid, me.gid)).toMatch(/mode 755/)
    } finally {
      server.close()
    }
    fs.writeFileSync(path.join(dir, 'file'), '')
    expect(socketProblem(path.join(dir, 'file', 'agent.sock'), me.uid, me.gid)).toMatch(
      /not a folder/,
    )
  })

  it('narrows the data folder and its private files, and reports what it changed', () => {
    const data = path.join(dir, 'data')
    fs.mkdirSync(path.join(data, 'secrets'), { recursive: true, mode: 0o755 })
    fs.chmodSync(data, 0o755)
    fs.writeFileSync(path.join(data, 'clawboo.db'), '', { mode: 0o644 })
    fs.writeFileSync(path.join(data, 'secrets', 'master.key'), '', { mode: 0o600 })
    const changed = narrowDataDir(data, [
      path.join(data, 'clawboo.db'),
      path.join(data, 'secrets', 'master.key'),
    ])
    expect(changed.sort()).toEqual(
      [data, path.join(data, 'clawboo.db'), path.join(data, 'secrets')].sort(),
    )
    expect(fs.statSync(data).mode & 0o777).toBe(0o700)
    expect(fs.statSync(path.join(data, 'clawboo.db')).mode & 0o777).toBe(0o600)
  })

  it('makes a missing data folder, private, on a first start', () => {
    const data = path.join(dir, 'fresh', '.clawboo')
    narrowDataDir(data, [])
    expect(fs.statSync(data).mode & 0o777).toBe(0o700)
    expect(dataDirProblem(data, [])).toBeNull()
  })

  it('says why a data folder is not the server user alone', () => {
    const data = path.join(dir, 'data')
    fs.mkdirSync(data, { mode: 0o755 })
    fs.chmodSync(data, 0o755)
    expect(dataDirProblem(data, [])).toMatch(/mode 755/)
    fs.chmodSync(data, 0o700)
    expect(dataDirProblem(data, [])).toBeNull()
    const db = path.join(data, 'clawboo.db')
    fs.writeFileSync(db, 'db')
    fs.linkSync(db, path.join(dir, 'elsewhere.db'))
    expect(dataDirProblem(data, [db])).toMatch(/another hard link/)
  })

  it('names a parent folder others can write', () => {
    const shared = path.join(dir, 'shared')
    fs.mkdirSync(path.join(shared, 'data'), { recursive: true })
    fs.chmodSync(shared, 0o777)
    expect(unsafeParents(path.join(shared, 'data'))).toContain(shared)
    fs.chmodSync(shared, 0o755)
    expect(unsafeParents(path.join(shared, 'data'))).not.toContain(shared)
  })

  it('stops every agent process three times through the switch, and does nothing in socket mode', () => {
    const run = vi.fn(() => ({ error: undefined }) as never)
    expect(killAllAgentProcesses(config, run as never)).toBe(true)
    expect(run).toHaveBeenCalledTimes(3)
    expect(run).toHaveBeenCalledWith(
      'sudo',
      ['-n', '-u', 'clawboo-agent', '--', 'kill', '-KILL', '-1'],
      expect.anything(),
    )
    run.mockClear()
    expect(
      killAllAgentProcesses({ ...config, socket: '/run/clawboo/agent.sock' }, run as never),
    ).toBe(false)
    expect(run).not.toHaveBeenCalled()
  })
})
