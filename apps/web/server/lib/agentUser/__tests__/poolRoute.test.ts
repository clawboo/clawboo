// Routing with a user per agent: a process goes to its agent's host, a file to
// the host of whoever owns its place, and the work folder's own folders and
// share roots are made by the server with the share's group. Real hosts served
// in this process (their identity forged per pool user), a real database in a
// sandboxed CLAWBOO_HOME.

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { agents, teams, type ClawbooDb } from '@clawboo/db'
import { eq } from 'drizzle-orm'

import type { AgentHostClient } from '../client'
import type { PoolGroup, PoolUser } from '../pool'
import { ownerOfPath, shareOfSegment, type PathRouteDeps } from '../poolRoute'
import { shareSpot } from '../poolShares'
import { collect, closed, startInProcessHost, type InProcessHost } from './inProcessHost'

const { getDb, resetDb } = await import('../../db')
const { AgentPool } = await import('../poolHosts')
const { setActiveAgentPool } = await import('../state')
const { setPathRouteDeps } = await import('../poolRoute')
const { setShareContext, ensurePoolFolder } = await import('../poolShares')
const { syncPoolRecords, runAssignmentPass } = await import('../poolAssignments')
const { spawnAgentProcess } = await import('../../runtimes/spawner')
const { agentMkdir, agentWriteFile, agentReadFile } = await import('../agentFs')
const { runtimeIdentityHomePath } = await import('../../runtimes/identityHome')
const { displayDirFor } = await import('../../desktop/displays')
const { profileDirFor } = await import('../../connectors/agentBrowsers')
const { taskRunWorkdirFor } = await import('../../runtimes/teamWorkdir')

describe('ownerOfPath and shareSpot (paths alone)', () => {
  const users: PoolUser[] = [
    { name: 'a1', uid: 1, gid: 1, home: '/homes/a1', order: 0 },
    { name: 'a2', uid: 2, gid: 2, home: '/homes/a2', order: 1 },
  ]
  const deps: PathRouteDeps = {
    users,
    workDir: '/work',
    reviewsSegment: 'abc123',
    agentForSegment: (s) => (s === 'solo' ? 'agent-solo' : null),
    teamForSegment: (s) => (s === 'T1' ? 'T1' : null),
    taskOwners: (id) =>
      id === 'task-1'
        ? { teamId: 'T1', assignee: 'agent-x' }
        : id === 'task-2'
          ? { teamId: null, assignee: 'agent-solo' }
          : null,
  }

  it("a pool user's home is that user's, and only from its own root", () => {
    expect(ownerOfPath('/homes/a1/runtimes/codex', deps)).toEqual({ kind: 'user', user: 'a1' })
    expect(ownerOfPath('/homes/a1', deps)).toEqual({ kind: 'user', user: 'a1' })
    expect(ownerOfPath('/homes/a10/x', deps)).toBeNull()
    expect(ownerOfPath('/homes/a1/../a2/secret', deps)).toEqual({ kind: 'user', user: 'a2' })
  })

  it('the work folder belongs to its shares, never as a whole', () => {
    expect(ownerOfPath('/work/teams/T1/notes.md', deps)).toEqual({ kind: 'team', teamId: 'T1' })
    expect(ownerOfPath('/work/teams/_agent-solo/tasks/x', deps)).toEqual({
      kind: 'agent',
      agentId: 'agent-solo',
    })
    expect(ownerOfPath('/work/mirrors/T1/abc.git', deps)).toEqual({ kind: 'team', teamId: 'T1' })
    expect(ownerOfPath('/work/team-history/T1.git/HEAD', deps)).toEqual({
      kind: 'team',
      teamId: 'T1',
    })
    expect(ownerOfPath('/work/reviews/abc123/team-T1/sha', deps)).toEqual({
      kind: 'team',
      teamId: 'T1',
    })
    expect(ownerOfPath('/work/reviews/other-install/T1', deps)).toBeNull()
    expect(ownerOfPath('/work/worktrees/hash/task-1/src', deps)).toEqual({
      kind: 'team',
      teamId: 'T1',
      prefer: 'agent-x',
    })
    expect(ownerOfPath('/work/worktrees/hash/task-2', deps)).toEqual({
      kind: 'agent',
      agentId: 'agent-solo',
    })
    for (const nobody of [
      '/work',
      '/work/teams',
      '/work/teams/ghost/x',
      '/work/other/x',
      '/etc/passwd',
    ]) {
      expect(ownerOfPath(nobody, deps), nobody).toBeNull()
    }
  })

  it('a segment names a team, or with the agent prefix one agent', () => {
    expect(shareOfSegment('_agent-solo', deps.agentForSegment, deps.teamForSegment)).toEqual({
      kind: 'agent',
      agentId: 'agent-solo',
    })
    expect(shareOfSegment('_agent-T1', deps.agentForSegment, deps.teamForSegment)).toBeNull()
  })

  it('tells structural folders from share roots', () => {
    const layout = { workDir: '/work', reviewsSegment: 'abc123' }
    expect(shareSpot('/work', layout)).toEqual({ kind: 'structural' })
    expect(shareSpot('/work/teams', layout)).toEqual({ kind: 'structural' })
    expect(shareSpot('/work/teams/T1', layout)).toEqual({ kind: 'share', root: '/work/teams/T1' })
    expect(shareSpot('/work/teams/T1/tasks/x', layout)).toEqual({
      kind: 'share',
      root: '/work/teams/T1',
    })
    expect(shareSpot('/work/reviews/abc123', layout)).toEqual({ kind: 'structural' })
    expect(shareSpot('/work/reviews/abc123/T1/sha', layout)).toEqual({
      kind: 'share',
      root: '/work/reviews/abc123/T1',
    })
    expect(shareSpot('/work/reviews/someone-else', layout)).toBeNull()
    expect(shareSpot('/work/worktrees/h', layout)).toEqual({ kind: 'structural' })
    expect(shareSpot('/elsewhere', layout)).toBeNull()
  })
})

const posix = process.platform !== 'win32'
const me = { uid: process.getuid?.() ?? 0, gid: process.getgid?.() ?? 0 }

describe.runIf(posix && me.uid !== 0)('a user per agent: routing for real', () => {
  let root: string
  let db: ClawbooDb
  let pool: InstanceType<typeof AgentPool>
  let hosts: Map<string, InProcessHost[]>
  let acl: { dir: string; gid: number }[]
  const saved: Record<string, string | undefined> = {}
  let users: PoolUser[]
  const t1: PoolGroup = { name: 'clawboo-t1', gid: me.gid, order: 0 }

  beforeEach(() => {
    root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pool-route-')))
    for (const k of ['HOME', 'CLAWBOO_HOME', 'CLAWBOO_WORK_DIR', 'CLAWBOO_AGENT_USERS'])
      saved[k] = process.env[k]
    process.env['HOME'] = path.join(root, 'server-home')
    process.env['CLAWBOO_HOME'] = path.join(root, 'data')
    process.env['CLAWBOO_WORK_DIR'] = path.join(root, 'work')
    process.env['CLAWBOO_AGENT_USERS'] = 'clawboo-a1,clawboo-a2'
    fs.mkdirSync(process.env['CLAWBOO_HOME'], { recursive: true })
    fs.mkdirSync(process.env['CLAWBOO_WORK_DIR'], { recursive: true, mode: 0o711 })
    // Two pool users. They are this test's own user underneath, so their
    // private gids are this user's own group too, which `chown` can give.
    users = ['clawboo-a1', 'clawboo-a2'].map((name, i) => {
      const home = path.join(root, 'homes', name)
      fs.mkdirSync(home, { recursive: true, mode: 0o700 })
      return { name, uid: 30001 + i, gid: me.gid, home, order: i }
    })
    hosts = new Map()
    acl = []
    pool = new AgentPool({
      users,
      groups: [t1],
      serverGid: 99_999,
      open: async (u, g) => {
        const h = startInProcessHost()
        hosts.set(u.name, [...(hosts.get(u.name) ?? []), h])
        await h.client.waitForHello()
        h.client.hello = {
          ...h.client.hello!,
          uid: u.uid,
          gid: g ? g.gid : u.gid,
          user: u.name,
          home: u.home,
          groups: [u.gid],
        }
        return h.client
      },
      reap: async () => undefined,
      reapSync: () => undefined,
      log: { info: () => undefined, warn: () => undefined, error: () => undefined },
    })
    setActiveAgentPool(pool)
    db = getDb()
    const now = Date.now()
    db.insert(teams)
      .values({ id: 'T1', name: 'T1', icon: 'x', color: '#000', createdAt: now, updatedAt: now })
      .run()
    for (const [id, teamId, at] of [
      ['agent-a', null, 1],
      ['agent-b', 'T1', 2],
      ['agent-c', null, 3],
    ] as const) {
      db.insert(agents)
        .values({
          id,
          name: id,
          gatewayId: id,
          runtime: 'codex',
          teamId,
          createdAt: at,
          updatedAt: at,
        })
        .run()
    }
    syncPoolRecords(users, [t1])
    runAssignmentPass()
    const workDir = process.env['CLAWBOO_WORK_DIR']!
    setPathRouteDeps(() => ({
      users,
      workDir,
      reviewsSegment: 'install1',
      agentForSegment: (s) => (['agent-a', 'agent-b', 'agent-c'].includes(s) ? s : null),
      teamForSegment: (s) => (s === 'T1' ? 'T1' : null),
      taskOwners: () => null,
    }))
    setShareContext({
      layout: () => ({ workDir, reviewsSegment: 'install1' }),
      deps: {
        serverUid: me.uid,
        setAcl: async (dir, gid) => {
          acl.push({ dir, gid })
        },
      },
    })
  })

  afterEach(() => {
    pool.closeAll('test over')
    setActiveAgentPool(null)
    setPathRouteDeps(null)
    setShareContext(null)
    resetDb()
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k]
      else process.env[k] = v
    }
    fs.rmSync(root, { recursive: true, force: true })
  })

  const hostsOf = (name: string): AgentHostClient[] => (hosts.get(name) ?? []).map((h) => h.client)

  it("each agent's homes, profile and display are under its own user's home", () => {
    const a1 = users[0]!.home
    const a2 = users[1]!.home
    expect(runtimeIdentityHomePath('codex', 'agent-a')).toBe(
      path.join(a1, 'runtimes', 'codex', 'agent-a'),
    )
    expect(runtimeIdentityHomePath('codex', 'agent-b')).toBe(
      path.join(a2, 'runtimes', 'codex', 'agent-b'),
    )
    expect(displayDirFor('agent-b', true).startsWith(a2 + path.sep)).toBe(true)
    expect(profileDirFor('playwright', 'agent-a', true).startsWith(a1 + path.sep)).toBe(true)
  })

  it('a process runs on the host of the agent it names, with its team group', async () => {
    const child = spawnAgentProcess({
      kind: 'runtime',
      agentId: 'agent-b',
      command: process.execPath,
      args: ['-e', 'process.stdin.pipe(process.stdout)'],
      env: { PATH: process.env['PATH'] ?? '' },
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    // Written before the host is even up: held, then sent.
    child.stdin!.end('hello from b')
    const out = collect(child.stdout)
    await closed(child)
    expect(await out).toBe('hello from b')
    expect(pool.running('clawboo-a2')?.group?.name).toBe('clawboo-t1')
    expect(pool.running('clawboo-a1')).toBeNull()
  })

  it('a process that names no agent and no folder does not start', async () => {
    const child = spawnAgentProcess({
      kind: 'tool',
      command: process.execPath,
      args: ['-e', ''],
      env: {},
    })
    const err = await new Promise<Error>((resolve) => child.once('error', resolve))
    expect(err.message).toMatch(/names no agent, so it has no agent user/)
  })

  it('work that names no agent runs as the agent whose work is under way, never another teammate', async () => {
    const { runAsAgent } = await import('../poolRoute')
    // `critic` is no agent: inside agent-b's check it runs as agent-b.
    const child = runAsAgent('agent-b', () =>
      spawnAgentProcess({
        kind: 'runtime',
        agentId: 'critic',
        command: process.execPath,
        args: ['-e', 'process.stdout.write("x")'],
        env: { PATH: process.env['PATH'] ?? '' },
      }),
    )
    await closed(child)
    expect(hostsOf('clawboo-a2')).toHaveLength(1)
    expect(hostsOf('clawboo-a1')).toHaveLength(0)
  })

  it("a teammate's link cannot carry a share's file into a home", async () => {
    const teamDir = taskRunWorkdirFor('codex', 'T1', process.env, 'agent-b')!
    await agentMkdir(teamDir)
    // What a teammate could plant: a folder in the team folder that is a link
    // to the acting agent's own home.
    fs.symlinkSync(users[1]!.home, path.join(teamDir, 'tasks'))
    await expect(agentWriteFile(path.join(teamDir, 'tasks', 'init.sh'), 'x')).rejects.toThrow(
      /outside its share/,
    )
    expect(fs.existsSync(path.join(users[1]!.home, 'init.sh'))).toBe(false)
  })

  it('a team member whose user left the pool does not hold up the team', async () => {
    const { shareActor } = await import('../poolRoute')
    // agent-b's user stays in the records but the running pool no longer holds it.
    const smaller = new AgentPool({
      users: [users[0]!],
      groups: [t1],
      serverGid: 99_999,
      open: async () => {
        throw new Error('not used')
      },
      reap: async () => undefined,
      reapSync: () => undefined,
      log: { info: () => undefined, warn: () => undefined, error: () => undefined },
    })
    setActiveAgentPool(smaller)
    expect(() => shareActor({ kind: 'team', teamId: 'T1' })).toThrow(/No agent of this team/)
    setActiveAgentPool(pool)
    expect(shareActor({ kind: 'team', teamId: 'T1' })).toBe('agent-b')
  })

  it("an agent moved to another team gets its host stopped, and then the new team's group", async () => {
    const { reconcilePoolHosts } = await import('../poolBoot')
    const log = { info: () => undefined, warn: () => undefined, error: () => undefined }
    await spawnAndWait('agent-b')
    expect(pool.running('clawboo-a2')?.group?.name).toBe('clawboo-t1')
    // Moved out of its team (no team: its own group).
    db.update(agents).set({ teamId: null }).where(eq(agents.id, 'agent-b')).run()
    await reconcilePoolHosts(log)
    expect(pool.running('clawboo-a2')).toBeNull()
    await spawnAndWait('agent-b')
    expect(pool.running('clawboo-a2')?.group).toBeNull()
  })

  async function spawnAndWait(agentId: string): Promise<void> {
    const child = spawnAgentProcess({
      kind: 'runtime',
      agentId,
      command: process.execPath,
      args: ['-e', ''],
      env: { PATH: process.env['PATH'] ?? '' },
    })
    await closed(child)
  }

  it('an agent with no free user does not run, and says why', async () => {
    const child = spawnAgentProcess({
      kind: 'runtime',
      agentId: 'agent-c',
      command: process.execPath,
      args: ['-e', ''],
      env: {},
    })
    const err = await new Promise<Error>((resolve) => child.once('error', resolve))
    expect(err.message).toMatch(/agent-c has no agent user/)
  })

  it("a file in an agent's home goes to that agent's host only", async () => {
    const file = path.join(users[0]!.home, 'runtimes', 'note.txt')
    await agentMkdir(path.dirname(file))
    await agentWriteFile(file, 'mine')
    expect((await agentReadFile(file))?.toString()).toBe('mine')
    expect(hostsOf('clawboo-a1')).toHaveLength(1)
    expect(hostsOf('clawboo-a2')).toHaveLength(0)
  })

  it("the server makes the work folder's own folders and each share root, with the share's group", async () => {
    const teamDir = taskRunWorkdirFor('codex', 'T1', process.env, 'agent-b')!
    const soloDir = taskRunWorkdirFor('codex', null, process.env, 'agent-a')!
    expect(soloDir).toBe(path.join(root, 'work', 'teams', '_agent-agent-a'))
    expect(await ensurePoolFolder(teamDir)).toBe('made')
    expect(await ensurePoolFolder(soloDir)).toBe('made')
    for (const d of [teamDir, soloDir]) {
      const st = fs.lstatSync(d)
      expect(st.uid).toBe(me.uid)
      expect(st.gid).toBe(me.gid)
      expect(st.mode & 0o7777).toBe(0o2770)
    }
    expect(fs.lstatSync(path.join(root, 'work', 'teams')).mode & 0o7777).toBe(0o711)
    expect(acl).toEqual([
      { dir: teamDir, gid: me.gid },
      { dir: soloDir, gid: me.gid },
    ])
    // Inside a share: a host of the team makes it, the group gets the owner's bits.
    await agentMkdir(path.join(teamDir, 'tasks', 't1'), { mode: 0o700 })
    expect(fs.lstatSync(path.join(teamDir, 'tasks', 't1')).mode & 0o070).toBe(0o070)
    expect(hostsOf('clawboo-a2')).toHaveLength(1)
  })

  it('a share root already there with another group is never handed over', async () => {
    const teamDir = path.join(root, 'work', 'teams', 'T1')
    fs.mkdirSync(path.join(root, 'work', 'teams'), { recursive: true, mode: 0o711 })
    fs.mkdirSync(teamDir)
    const other = (process.getgroups?.() ?? []).find((g) => g !== me.gid)
    if (other === undefined) return
    fs.chownSync(teamDir, -1, other)
    await expect(ensurePoolFolder(teamDir)).rejects.toThrow(/belongs to another group/)
  })

  it('a link in place of a structural folder is refused', async () => {
    fs.symlinkSync(os.tmpdir(), path.join(root, 'work', 'teams'))
    await expect(ensurePoolFolder(path.join(root, 'work', 'teams', 'T1'))).rejects.toThrow(
      /not a folder/,
    )
  })
})
