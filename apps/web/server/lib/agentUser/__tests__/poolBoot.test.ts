// The startup check for a user per agent (CLAWBOO_AGENT_USERS): each refusal,
// with real hosts served in this process. They run as this test's own user, so
// what depends on who runs them (another user's home, another user's process,
// the server's environment, sudo) is answered per test; the container proof
// runs the same check against real users.

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { AgentPoolConfig } from '../config'
import type { AccountRecord, GroupRecord, PoolUser } from '../pool'
import { poolSudoersLines, runAgentPoolCheck, type PoolCheckDeps } from '../poolBoot'
import type { HelloFrame } from '../protocol'
import { startInProcessHost, type InProcessHost } from './inProcessHost'

const posix = process.platform !== 'win32'
const me = process.getuid?.() ?? 0

const config: AgentPoolConfig = {
  users: { kind: 'names', names: ['clawboo-a1', 'clawboo-a2', 'clawboo-a3'] },
  groups: { kind: 'names', names: ['clawboo-t1'] },
  switch: 'sudo',
}

describe.runIf(posix && me !== 0)('a user per agent: the startup check', () => {
  let dir: string
  let hosts: InProcessHost[]
  let reaped: string[]
  let deps: PoolCheckDeps
  /** Per user name: answers that replace the host's, by op. */
  let answers: Map<
    string,
    Record<string, (res: Record<string, unknown>, req: Record<string, unknown>) => unknown>
  >
  let users: AccountRecord[]
  let groups: GroupRecord[]

  const home = (n: string): string => path.join(dir, 'homes', n)

  beforeEach(() => {
    dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pool-check-')))
    for (const n of ['a1', 'a2', 'a3']) fs.mkdirSync(home(`clawboo-${n}`), { recursive: true })
    fs.mkdirSync(path.join(dir, 'data'))
    fs.mkdirSync(path.join(dir, 'work'))
    hosts = []
    reaped = []
    answers = new Map()
    users = ['a1', 'a2', 'a3'].map((n, i) => ({
      name: `clawboo-${n}`,
      uid: 20001 + i,
      gid: 20001 + i,
      home: home(`clawboo-${n}`),
    }))
    groups = [
      ...users.map((u) => ({ name: u.name, gid: u.gid, members: ['clawboo'] })),
      { name: 'clawboo-t1', gid: 21001, members: ['clawboo'] },
    ]
    deps = {
      platform: 'linux',
      serverUid: 10001,
      serverGid: 10001,
      serverUser: 'clawboo',
      serverHome: path.join(dir, 'server-home-missing'),
      serverPid: process.pid,
      serverGroups: [10001, 20001, 20002, 20003, 21001],
      accountDb: {
        userByName: (n) => users.find((u) => u.name === n) ?? null,
        userByUid: (id) => users.find((u) => u.uid === id) ?? null,
        groupByName: (n) => groups.find((g) => g.name === n) ?? null,
        groupByGid: (id) => groups.find((g) => g.gid === id) ?? null,
      },
      accessToken: 'token-1234567890',
      dataDir: path.join(dir, 'data'),
      workDir: path.join(dir, 'work'),
      protectedFiles: [path.join(dir, 'data', 'clawboo.db')],
      operatorFiles: [],
      secretValues: ['sk-the-saved-provider-key'],
      runtimeBinaries: [],
      narrowDataDir: () => [],
      unsafeParents: () => [],
      dataDirProblem: () => null,
      workDirProblem: () => null,
      hasSetfacl: () => true,
      openHost: async (u: PoolUser) => {
        const h = startInProcessHost()
        hosts.push(h)
        await h.client.waitForHello()
        // The kernel's answer for that user, as a separate user's host gives it.
        const hello: HelloFrame = {
          ...h.client.hello!,
          uid: u.uid,
          gid: u.gid,
          user: u.name,
          home: u.home,
          groups: [u.gid],
        }
        h.client.hello = hello
        const orig = h.client.request.bind(h.client)
        vi.spyOn(h.client, 'request').mockImplementation((async (
          req: Record<string, unknown> & { op: string },
          o?: { timeoutMs?: number },
        ) => {
          const own = answers.get(u.name)?.[req.op]
          // As a separate, unprivileged user would answer.
          if (req.op === 'procView' && !own) {
            return {
              environ: { ok: false, code: 'EACCES' },
              cmdline: { ok: true, text: 'node' },
              psEnv: { ok: false },
            }
          }
          if (req.op === 'privCheck' && !own) {
            return {
              attempts: [{ what: 'sudo -l', ran: true, succeeded: false }],
              crontab: 'denied',
            }
          }
          const res = (await orig(req as never, o)) as Record<string, unknown>
          if (req.op === 'probe') {
            // Another agent user's home is closed to this one.
            const results = (res['results'] as { path: string; mode: string; ok: boolean }[]).map(
              (r) =>
                r.mode === 'list' && r.path !== u.home && users.some((x) => x.home === r.path)
                  ? { ...r, ok: false, code: 'EACCES' }
                  : r,
            )
            const out = { ...res, results }
            return own ? own(out, req) : out
          }
          if (req.op === 'canSignal') {
            const out = {
              results: (req['pids'] as number[]).map((pid) => ({ pid, ok: false, code: 'EPERM' })),
            }
            return own ? own(out, req) : out
          }
          return own ? own(res, req) : res
        }) as never)
        return h.client
      },
      reapSync: (u) => {
        reaped.push(u.name)
      },
    }
    fs.chmodSync(path.join(dir, 'data'), 0o000)
  })

  afterEach(() => {
    vi.restoreAllMocks()
    for (const h of hosts) h.client.close()
    fs.chmodSync(path.join(dir, 'data'), 0o700)
    fs.rmSync(dir, { recursive: true, force: true })
  })

  const failed = (r: { steps: { level: string; step: number; message: string }[] }) =>
    r.steps.find((s) => s.level === 'fail')

  it('passes for a clean pool, checks every user in its own host, and leaves none running', async () => {
    const r = await runAgentPoolCheck(config, deps)
    expect(failed(r)).toBeUndefined()
    expect(r.ok).toBe(true)
    expect(r.users.map((u) => u.name)).toEqual(['clawboo-a1', 'clawboo-a2', 'clawboo-a3'])
    expect(hosts).toHaveLength(3)
    expect(hosts.every((h) => h.client.closed !== null)).toBe(true)
    // Each user is stopped at boot, before any host, and again once checked.
    expect(reaped.slice(0, 3)).toEqual(['clawboo-a1', 'clawboo-a2', 'clawboo-a3'])
    expect(reaped).toHaveLength(6)
  })

  it('every user is shown another agent user it cannot signal', async () => {
    const asked: Record<string, number[]> = {}
    for (const u of users) {
      answers.set(u.name, {
        canSignal: (res, req) => {
          asked[u.name] = req['pids'] as number[]
          return res
        },
      })
    }
    expect((await runAgentPoolCheck(config, deps)).ok).toBe(true)
    expect(Object.keys(asked).sort()).toEqual(['clawboo-a1', 'clawboo-a2', 'clawboo-a3'])
    for (const pids of Object.values(asked)) expect(pids).toHaveLength(1)
  })

  it('refuses outside Linux', async () => {
    expect(failed(await runAgentPoolCheck(config, { ...deps, platform: 'darwin' }))).toMatchObject({
      step: 1,
      message: expect.stringMatching(/CLAWBOO_AGENT_USER \(one agent user/),
    })
    expect(failed(await runAgentPoolCheck(config, { ...deps, platform: 'win32' }))).toMatchObject({
      step: 1,
    })
  })

  it('refuses without a work folder of its own', async () => {
    expect(failed(await runAgentPoolCheck(config, { ...deps, workDir: null }))).toMatchObject({
      step: 2,
      message: expect.stringMatching(/needs CLAWBOO_WORK_DIR/),
    })
  })

  it('refuses a pool the account database does not back', async () => {
    users = users.slice(0, 2)
    expect(failed(await runAgentPoolCheck(config, deps))).toMatchObject({
      step: 2,
      message: expect.stringMatching(/clawboo-a3: no such user/),
    })
  })

  it('refuses without an access token, and without setfacl', async () => {
    expect(failed(await runAgentPoolCheck(config, { ...deps, accessToken: null }))).toMatchObject({
      step: 3,
    })
    expect(
      failed(await runAgentPoolCheck(config, { ...deps, hasSetfacl: () => false })),
    ).toMatchObject({
      step: 5,
      message: expect.stringMatching(/install the acl package/),
    })
  })

  it("refuses when one agent user can list another's home", async () => {
    answers.set('clawboo-a2', {
      probe: (res) => ({
        ...res,
        results: (res['results'] as { path: string; ok: boolean }[]).map((r) =>
          r.path === home('clawboo-a1') ? { ...r, ok: true } : r,
        ),
      }),
    })
    const r = await runAgentPoolCheck(config, deps)
    expect(r.ok).toBe(false)
    expect(failed(r)?.message).toMatch(
      /clawboo-a2 can list .*clawboo-a1, another agent user's home/,
    )
    expect(hosts.every((h) => h.client.closed !== null)).toBe(true)
  })

  it("refuses when one agent user can signal another's process", async () => {
    answers.set('clawboo-a3', {
      canSignal: (_res, req) => ({
        results: (req['pids'] as number[]).map((pid) => ({ pid, ok: true })),
      }),
    })
    const r = await runAgentPoolCheck(config, deps)
    expect(failed(r)?.message).toMatch(/clawboo-a3 can signal process/)
  })

  it('refuses the first user too, once a second host is up to signal', async () => {
    answers.set('clawboo-a1', {
      canSignal: (_res, req) => ({
        results: (req['pids'] as number[]).map((pid) => ({ pid, ok: true })),
      }),
    })
    const r = await runAgentPoolCheck(config, deps)
    expect(failed(r)?.message).toMatch(/clawboo-a1 can signal a process of clawboo-a2/)
  })

  it('refuses a host that is not who it should be', async () => {
    const open = deps.openHost
    deps.openHost = async (u, g) => {
      const c = await open(u, g)
      if (u.name === 'clawboo-a2') c.hello = { ...c.hello!, groups: [u.gid, 10001] }
      return c
    }
    expect(failed(await runAgentPoolCheck(config, deps))).toMatchObject({
      step: 6,
      message: expect.stringMatching(/also holds the group 10001 \(the server's group\)/),
    })
  })

  it('says which one sudo rule the pool needs when a host cannot be started', async () => {
    deps.openHost = async () => {
      throw new Error('sudo: a password is required')
    }
    const r = await runAgentPoolCheck(config, deps)
    expect(failed(r)?.message).toContain(
      'clawboo ALL=(clawboo-a1, clawboo-a2, clawboo-a3 : clawboo-t1) NOPASSWD: ALL',
    )
  })

  it('writes the users inline in the sudoers line, and leaves out an empty group list', () => {
    expect(poolSudoersLines('clawboo', ['a1', 'a2'], [])).toContain(
      'clawboo ALL=(a1, a2) NOPASSWD: ALL',
    )
  })
})
