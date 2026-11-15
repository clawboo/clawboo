// The pool settings (CLAWBOO_AGENT_USERS, CLAWBOO_AGENT_GROUPS) and the checks
// on the account database: every way two agent users, or a user and a team
// group, could share something.

import { describe, expect, it } from 'vitest'

import {
  AgentUserConfigError,
  isAgentPoolMode,
  isAgentUserMode,
  parsePoolSpec,
  resolveAgentPoolConfig,
  resolveAgentUserConfig,
} from '../config'
import {
  getentAccountDb,
  parseGroupLine,
  parsePasswdLine,
  resolvePool,
  type AccountRecord,
  type GroupRecord,
  type PoolContext,
} from '../pool'

describe('pool settings', () => {
  it('reads names and ranges', () => {
    expect(parsePoolSpec('clawboo-a1, clawboo-a2', 'X', 'uid')).toEqual({
      kind: 'names',
      names: ['clawboo-a1', 'clawboo-a2'],
    })
    expect(parsePoolSpec('uid:20001-20004', 'X', 'uid')).toEqual({
      kind: 'range',
      lo: 20001,
      hi: 20004,
    })
    expect(parsePoolSpec('gid:21001-21001', 'X', 'gid')).toEqual({
      kind: 'range',
      lo: 21001,
      hi: 21001,
    })
  })

  it('refuses what is not a pool', () => {
    expect(() => parsePoolSpec('uid:9-3', 'X', 'uid')).toThrow(/smaller id to a larger/)
    expect(() => parsePoolSpec('uid:0-3', 'X', 'uid')).toThrow(/above 0/)
    expect(() => parsePoolSpec('uid:1-5000', 'X', 'uid')).toThrow(/at most 1000/)
    expect(() => parsePoolSpec('gid:1-3', 'X', 'uid')).toThrow(/names separated by commas/)
    expect(() => parsePoolSpec('a1,a1', 'X', 'uid')).toThrow(/names a1 twice/)
    expect(() => parsePoolSpec('ok,../root', 'X', 'uid')).toThrow(/is not a name/)
    expect(() => parsePoolSpec(' , ', 'X', 'uid')).toThrow(/names nobody/)
  })

  it('turns agent isolation on, and is the pool mode', () => {
    const env = { CLAWBOO_AGENT_USERS: 'a1,a2' }
    expect(isAgentUserMode(env)).toBe(true)
    expect(isAgentPoolMode(env)).toBe(true)
    expect(isAgentPoolMode({ CLAWBOO_AGENT_USER: 'a' })).toBe(false)
    expect(resolveAgentPoolConfig(env)).toEqual({
      users: { kind: 'names', names: ['a1', 'a2'] },
      groups: null,
      switch: 'sudo',
    })
  })

  it('refuses one agent user and a pool together, and a launcher socket with a pool', () => {
    const both = { CLAWBOO_AGENT_USER: 'a', CLAWBOO_AGENT_USERS: 'b,c' }
    expect(() => resolveAgentPoolConfig(both)).toThrow(AgentUserConfigError)
    expect(() => resolveAgentUserConfig(both)).toThrow(/not both/)
    expect(() =>
      resolveAgentPoolConfig({
        CLAWBOO_AGENT_USERS: 'b',
        CLAWBOO_AGENT_HOST_SOCKET: '/run/x.sock',
      }),
    ).toThrow(/container launcher for a pool is not available yet/)
  })
})

describe('the account database, read through getent', () => {
  it('parses passwd and group lines', () => {
    expect(parsePasswdLine('clawboo-a1:x:20001:20001::/var/lib/a1:/bin/bash')).toEqual({
      name: 'clawboo-a1',
      uid: 20001,
      gid: 20001,
      home: '/var/lib/a1',
    })
    expect(parsePasswdLine('broken')).toBeNull()
    expect(parseGroupLine('clawboo-t1:x:21001:clawboo,other')).toEqual({
      name: 'clawboo-t1',
      gid: 21001,
      members: ['clawboo', 'other'],
    })
    expect(parseGroupLine('g:x:5:')).toEqual({ name: 'g', gid: 5, members: [] })
  })

  it('asks getent by name and by id', () => {
    const asked: string[][] = []
    const db = getentAccountDb((args) => {
      asked.push(args)
      return args[1] === 'clawboo-a1' || args[1] === '20001'
        ? 'clawboo-a1:x:20001:20001::/var/lib/a1:/bin/bash\n'
        : null
    })
    expect(db.userByName('clawboo-a1')?.uid).toBe(20001)
    expect(db.userByUid(20001)?.name).toBe('clawboo-a1')
    expect(db.userByName('nobody-here')).toBeNull()
    expect(asked).toContainEqual(['passwd', '20001'])
  })
})

describe('resolvePool', () => {
  const ctx: PoolContext = {
    serverUid: 10001,
    serverGid: 10001,
    serverUser: 'clawboo',
    serverHome: '/home/clawboo',
    dataDir: '/home/clawboo/.clawboo',
    workDir: '/var/lib/clawboo-work',
    serverGroups: [10001, 20001, 20002, 21001],
  }
  function db(users: AccountRecord[], groups: GroupRecord[]) {
    return {
      userByName: (n: string) => users.find((u) => u.name === n) ?? null,
      userByUid: (id: number) => users.find((u) => u.uid === id) ?? null,
      groupByName: (n: string) => groups.find((g) => g.name === n) ?? null,
      groupByGid: (id: number) => groups.find((g) => g.gid === id) ?? null,
    }
  }
  const a1 = { name: 'clawboo-a1', uid: 20001, gid: 20001, home: '/var/lib/clawboo-agents/a1' }
  const a2 = { name: 'clawboo-a2', uid: 20002, gid: 20002, home: '/var/lib/clawboo-agents/a2' }
  const own = (u: AccountRecord, members: string[] = ['clawboo']): GroupRecord => ({
    name: u.name,
    gid: u.gid,
    members,
  })
  const t1: GroupRecord = { name: 'clawboo-t1', gid: 21001, members: ['clawboo'] }
  const spec = {
    users: { kind: 'names' as const, names: ['clawboo-a1', 'clawboo-a2'] },
    groups: { kind: 'names' as const, names: ['clawboo-t1'] },
  }

  it('takes a clean pool, in order', () => {
    const r = resolvePool(spec, db([a1, a2], [own(a1), own(a2), t1]), ctx)
    expect(r.problems).toEqual([])
    expect(r.users.map((u) => [u.name, u.order])).toEqual([
      ['clawboo-a1', 0],
      ['clawboo-a2', 1],
    ])
    expect(r.groups).toEqual([{ name: 'clawboo-t1', gid: 21001, order: 0 }])
  })

  it('takes a uid range, and refuses a missing id in it', () => {
    const range = { users: { kind: 'range' as const, lo: 20001, hi: 20003 }, groups: null }
    const r = resolvePool(range, db([a1, a2], [own(a1), own(a2)]), ctx)
    expect(r.problems).toEqual([expect.stringMatching(/uid 20003: no user has it/)])
  })

  it('refuses every way users could share something', () => {
    const twin = { ...a2, name: 'twin', uid: 20001 }
    const sameGroup = { ...a2, gid: 20001 }
    const inHome = { ...a2, home: '/var/lib/clawboo-agents/a1/sub' }
    const root = { ...a2, uid: 0 }
    const server = { ...a2, uid: 10001 }
    const cases: [AccountRecord, RegExp][] = [
      [twin, /same uid 20001/],
      [sameGroup, /share the primary group gid 20001/],
      [inHome, /home .* overlap/],
      [root, /is root/],
      [server, /is the user Clawboo runs as/],
      [{ ...a2, gid: 10001 }, /primary group \(gid 10001\) is the server's/],
      [{ ...a2, home: '/home/clawboo/.clawboo/a2' }, /data folder .* overlap/],
      [{ ...a2, home: '/var/lib/clawboo-work/a2' }, /work folder .* overlap/],
      [{ ...a2, home: '/' }, /not a folder of its own/],
    ]
    for (const [u, re] of cases) {
      const names = u.name === 'twin' ? ['clawboo-a1', 'twin'] : ['clawboo-a1', 'clawboo-a2']
      const r = resolvePool(
        { users: { kind: 'names', names }, groups: null },
        db([a1, u], [own(a1), own(u)]),
        ctx,
      )
      expect(r.problems.join('\n'), re.source).toMatch(re)
    }
  })

  it("refuses a stranger in an agent user's own group, or one agent in another's", () => {
    const r = resolvePool(
      spec,
      db([a1, a2], [own(a1, ['clawboo', 'clawboo-a2']), own(a2), t1]),
      ctx,
    )
    expect(r.problems.join('\n')).toMatch(/clawboo-a1's own group clawboo-a1 also holds clawboo-a2/)
    expect(r.problems.join('\n')).toMatch(/clawboo-a2 is in clawboo-a1's own group/)
  })

  it('refuses an agent user standing in a team group, and a stranger in one', () => {
    const r1 = resolvePool(
      spec,
      db([a1, a2], [own(a1), own(a2), { ...t1, members: ['clawboo', 'clawboo-a1'] }]),
      ctx,
    )
    expect(r1.problems.join('\n')).toMatch(/clawboo-a1 is a member of the team group clawboo-t1/)
    const r2 = resolvePool(
      spec,
      db([a1, a2], [own(a1), own(a2), { ...t1, members: ['clawboo', 'mallory'] }]),
      ctx,
    )
    expect(r2.problems.join('\n')).toMatch(/also holds mallory/)
  })

  it("refuses a team group that is the server's or an agent's own", () => {
    const r = resolvePool(
      { ...spec, groups: { kind: 'names', names: ['clawboo-t1', 'clawboo-a1'] } },
      db([a1, a2], [own(a1), own(a2), { ...t1, gid: 10001 }]),
      { ...ctx, serverGroups: [10001, 20001, 20002] },
    )
    expect(r.problems.join('\n')).toMatch(/team group clawboo-t1 is the server's group/)
    expect(r.problems.join('\n')).toMatch(/team group clawboo-a1 is clawboo-a1's own group/)
  })

  it('says how to put the server in the groups it must hold', () => {
    const r = resolvePool(spec, db([a1, a2], [own(a1), own(a2), t1]), {
      ...ctx,
      serverGroups: [10001, 20001],
    })
    expect(r.problems.join('\n')).toMatch(/usermod -aG clawboo-a2,clawboo-t1 clawboo/)
  })

  it('names every missing user and group in one pass', () => {
    const r = resolvePool(
      {
        users: { kind: 'names', names: ['ghost1', 'ghost2'] },
        groups: { kind: 'names', names: ['gone'] },
      },
      db([], []),
      ctx,
    )
    expect(r.problems).toEqual([
      expect.stringMatching(/ghost1: no such user/),
      expect.stringMatching(/ghost2: no such user/),
      expect.stringMatching(/gone: no such group/),
    ])
  })
})
