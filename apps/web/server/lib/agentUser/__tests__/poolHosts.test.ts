// The pool's hosts: one per agent user, started on first need, checked at
// every start, watched on their own, and stopped without touching anyone
// else's processes.

import { afterEach, describe, expect, it, vi } from 'vitest'

import { createLineSplitter, encodeFrame, parseFrame, type HelloFrame } from '../protocol'
import { AgentHostClient } from '../client'
import { AgentPool, PoolHostError, poolHelloProblem } from '../poolHosts'
import type { PoolGroup, PoolUser } from '../pool'
import { PassThrough } from 'node:stream'

const a1: PoolUser = { name: 'clawboo-a1', uid: 20001, gid: 20001, home: '/var/lib/a1', order: 0 }
const a2: PoolUser = { name: 'clawboo-a2', uid: 20002, gid: 20002, home: '/var/lib/a2', order: 1 }
const t1: PoolGroup = { name: 'clawboo-t1', gid: 21001, order: 0 }
const t2: PoolGroup = { name: 'clawboo-t2', gid: 21002, order: 1 }
const SERVER_GID = 10001

function helloFor(u: PoolUser, g: PoolGroup | null, over: Partial<HelloFrame> = {}): HelloFrame {
  return {
    t: 'hello',
    v: 2,
    uid: u.uid,
    gid: g ? g.gid : u.gid,
    user: u.name,
    home: u.home,
    pid: 1000 + u.uid,
    platform: 'linux',
    groups: g ? [g.gid, u.gid] : [u.gid],
    ...over,
  }
}

/** A host that says `hello` and answers pings until told to stop. */
function fakeHost(hello: HelloFrame): { client: AgentHostClient; silence: () => void } {
  const toHost = new PassThrough()
  const toServer = new PassThrough()
  let answering = true
  toHost.setEncoding('utf8')
  const split = createLineSplitter(
    (line) => {
      const f = parseFrame(line)
      if (!f || f['t'] !== 'req' || !answering) return
      toServer.write(encodeFrame({ t: 'res', id: f['id'] as number, ok: true }))
    },
    () => undefined,
  )
  toHost.on('data', (c: string) => split(c))
  const client = new AgentHostClient({ input: toServer, output: toHost, close: () => toHost.end() })
  toServer.write(encodeFrame(hello))
  return { client, silence: () => (answering = false) }
}

function makePool(over: Partial<ConstructorParameters<typeof AgentPool>[0]> = {}) {
  const opened: { user: string; group: string | null }[] = []
  const reaped: string[] = []
  const hosts = new Map<string, ReturnType<typeof fakeHost>>()
  const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() }
  const pool = new AgentPool({
    users: [a1, a2],
    groups: [t1, t2],
    serverGid: SERVER_GID,
    open: async (u, g) => {
      opened.push({ user: u.name, group: g?.name ?? null })
      const h = fakeHost(helloFor(u, g))
      hosts.set(u.name, h)
      await h.client.waitForHello()
      return h.client
    },
    reap: async (u) => {
      reaped.push(u.name)
    },
    reapSync: (u) => {
      reaped.push(`${u.name}!`)
    },
    log,
    watch: { everyMs: 20, deadMs: 60 },
    ...over,
  })
  return { pool, opened, reaped, hosts, log }
}

let pools: AgentPool[] = []
afterEach(() => {
  for (const p of pools) p.closeAll('test over')
  pools = []
})

describe('poolHelloProblem', () => {
  it('takes the right user, with its own group or its team group', () => {
    expect(poolHelloProblem(a1, null, helloFor(a1, null), SERVER_GID)).toBeNull()
    expect(poolHelloProblem(a1, t1, helloFor(a1, t1), SERVER_GID)).toBeNull()
  })

  it('refuses another uid, another gid, another home', () => {
    expect(poolHelloProblem(a1, null, helloFor(a1, null, { uid: 20002 }), SERVER_GID)).toMatch(
      /uid 20002, not 20001/,
    )
    expect(poolHelloProblem(a1, t1, helloFor(a1, null), SERVER_GID)).toMatch(/gid 20001, not 21001/)
    expect(poolHelloProblem(a1, null, helloFor(a1, null, { home: '/tmp' }), SERVER_GID)).toMatch(
      /home \/tmp/,
    )
  })

  it('refuses any group beyond its own and its team', () => {
    expect(
      poolHelloProblem(a1, null, helloFor(a1, null, { groups: [20001, SERVER_GID] }), SERVER_GID),
    ).toMatch(/also holds the group 10001 \(the server's group\)/)
    expect(
      poolHelloProblem(a1, t1, helloFor(a1, t1, { groups: [21001, 20001, 21002] }), SERVER_GID),
    ).toMatch(/also holds the group 21002/)
    expect(poolHelloProblem(a1, t1, helloFor(a1, t1, { groups: [21001] }), SERVER_GID)).toMatch(
      /does not hold its own group/,
    )
  })
})

describe('AgentPool', () => {
  it('starts a host on first need, once, and reuses it', async () => {
    const { pool, opened } = makePool()
    pools.push(pool)
    const [x, y] = await Promise.all([
      pool.hostFor('clawboo-a1', null),
      pool.hostFor('clawboo-a1', null),
    ])
    expect(x).toBe(y)
    expect(await pool.hostFor('clawboo-a1', null)).toBe(x)
    expect(opened).toEqual([{ user: 'clawboo-a1', group: null }])
    expect(pool.running('clawboo-a1')?.hello.uid).toBe(20001)
  })

  it('refuses a user or a group the pool does not hold', async () => {
    const { pool } = makePool()
    pools.push(pool)
    await expect(pool.hostFor('mallory', null)).rejects.toThrow(/not in CLAWBOO_AGENT_USERS/)
    await expect(pool.hostFor('clawboo-a1', 'nope')).rejects.toThrow(/not in CLAWBOO_AGENT_GROUPS/)
  })

  it('refuses a host whose identity is wrong, stops that user, and waits before trying again', async () => {
    const { pool, reaped } = makePool({
      open: async (u) => {
        const h = fakeHost(helloFor(u, null, { groups: [u.gid, SERVER_GID] }))
        await h.client.waitForHello()
        return h.client
      },
    })
    pools.push(pool)
    await expect(pool.hostFor('clawboo-a1', null)).rejects.toBeInstanceOf(PoolHostError)
    await pool.settled('clawboo-a1')
    expect(reaped).toEqual(['clawboo-a1'])
    await expect(pool.hostFor('clawboo-a1', null)).rejects.toThrow(/trying again shortly/)
  })

  it('restarts the host with the new group when its agent changes team', async () => {
    const { pool, opened, reaped } = makePool()
    pools.push(pool)
    const first = await pool.hostFor('clawboo-a1', 'clawboo-t1')
    const second = await pool.hostFor('clawboo-a1', 'clawboo-t2')
    expect(second).not.toBe(first)
    expect(first.closed).not.toBeNull()
    expect(opened).toEqual([
      { user: 'clawboo-a1', group: 'clawboo-t1' },
      { user: 'clawboo-a1', group: 'clawboo-t2' },
    ])
    // The old team's processes are stopped before the new host starts.
    expect(reaped).toEqual(['clawboo-a1'])
    expect(pool.running('clawboo-a1')?.group?.name).toBe('clawboo-t2')
  })

  it("a host that stops answering costs only its own user's processes", async () => {
    const { pool, reaped, hosts } = makePool()
    pools.push(pool)
    await pool.hostFor('clawboo-a1', null)
    const other = await pool.hostFor('clawboo-a2', null)
    hosts.get('clawboo-a1')!.silence()
    await vi.waitFor(() => expect(pool.running('clawboo-a1')).toBeNull(), { timeout: 2_000 })
    await pool.settled('clawboo-a1')
    expect(reaped).toEqual(['clawboo-a1'])
    expect(other.closed).toBeNull()
    expect(pool.running('clawboo-a2')).not.toBeNull()
  })

  it('starts a new host only after the stop of its user is done', async () => {
    let release: () => void = () => undefined
    const order: string[] = []
    const { pool } = makePool({
      reap: (u) =>
        new Promise<void>((resolve) => {
          order.push(`reap ${u.name}`)
          release = () => {
            order.push(`reaped ${u.name}`)
            resolve()
          }
        }),
      open: async (u, g) => {
        order.push(`open ${u.name}`)
        const h = fakeHost(helloFor(u, g))
        await h.client.waitForHello()
        return h.client
      },
    })
    pools.push(pool)
    await pool.hostFor('clawboo-a1', null)
    pool.close('clawboo-a1', 'test')
    const next = pool.hostFor('clawboo-a1', null)
    await new Promise((r) => setTimeout(r, 20))
    expect(order).toEqual(['open clawboo-a1', 'reap clawboo-a1'])
    release()
    await next
    expect(order).toEqual([
      'open clawboo-a1',
      'reap clawboo-a1',
      'reaped clawboo-a1',
      'open clawboo-a1',
    ])
  })

  it('starts no new host while the stop of its old processes keeps failing', async () => {
    const { pool } = makePool({
      reap: async () => {
        throw new Error('sudo: a password is required')
      },
    })
    pools.push(pool)
    await pool.hostFor('clawboo-a1', 'clawboo-t1')
    // A team change: the old processes (with t1) could not be stopped.
    await expect(pool.hostFor('clawboo-a1', 'clawboo-t2')).rejects.toThrow(
      /could not be stopped \(sudo: a password is required\)/,
    )
    expect(pool.running('clawboo-a1')).toBeNull()
  })

  it('a host still starting when its user is stopped is never used', async () => {
    let release: () => void = () => undefined
    const late: AgentHostClient[] = []
    const { pool } = makePool({
      open: async (u, g) => {
        await new Promise<void>((r) => (release = r))
        const h = fakeHost(helloFor(u, g))
        await h.client.waitForHello()
        late.push(h.client)
        return h.client
      },
    })
    pools.push(pool)
    const starting = pool.hostFor('clawboo-a1', null)
    await new Promise((r) => setTimeout(r, 10))
    pool.close('clawboo-a1', 'its agent was deleted')
    release()
    await expect(starting).rejects.toThrow(/stopped while its host started/)
    expect(late[0]?.closed).not.toBeNull()
    expect(pool.running('clawboo-a1')).toBeNull()
  })

  it("a team's group counts as held while processes that held it could not be stopped", async () => {
    let failing = true
    const { pool } = makePool({
      reap: async () => {
        if (failing) throw new Error('sudo: a password is required')
      },
    })
    pools.push(pool)
    await pool.hostFor('clawboo-a1', 'clawboo-t1')
    pool.close('clawboo-a1', 'its team was deleted')
    await pool.settled('clawboo-a1')
    expect(await pool.groupMayBeHeld('clawboo-t1')).toBe(true)
    expect(await pool.groupMayBeHeld('clawboo-t2')).toBe(false)
    failing = false
    expect(await pool.groupMayBeHeld('clawboo-t1')).toBe(false)
  })

  it('closes a host that has had nothing to do, and keeps a busy one', async () => {
    let now = 1_000
    const { pool, reaped } = makePool({ now: () => now, idleMs: 1_000 })
    pools.push(pool)
    await pool.hostFor('clawboo-a1', null)
    now += 500
    pool.sweepIdle()
    expect(pool.running('clawboo-a1')).not.toBeNull()
    now += 1_000
    pool.sweepIdle()
    expect(pool.running('clawboo-a1')).toBeNull()
    await pool.settled('clawboo-a1')
    expect(reaped).toEqual(['clawboo-a1'])
  })

  it('at shutdown stops every pool user, running or not, and starts nothing more', async () => {
    const { pool, reaped } = makePool()
    await pool.hostFor('clawboo-a1', null)
    pool.closeAll('stopping')
    expect(reaped).toEqual(['clawboo-a1!', 'clawboo-a2!'])
    await expect(pool.hostFor('clawboo-a2', null)).rejects.toThrow(/stopping/)
  })
})
