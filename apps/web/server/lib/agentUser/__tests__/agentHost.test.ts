// The agent host protocol end to end: a real host (served in this process) and
// the real client. Runs on POSIX only, like the mode it serves.

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { childEnvFor } from '../../../agentHost/host'
import { killProcessTree } from '../../runtimes/killTree'
import { AgentHostError } from '../client'
import { encodeFrame } from '../protocol'
import {
  closed,
  collect,
  startFakeHost,
  startInProcessHost,
  type InProcessHost,
} from './inProcessHost'

const posix = process.platform !== 'win32'

describe.runIf(posix)('agent host protocol', () => {
  let h: InProcessHost
  let dir: string

  beforeEach(() => {
    h = startInProcessHost()
    dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'agent-host-')))
  })

  afterEach(() => {
    h.client.close()
    fs.rmSync(dir, { recursive: true, force: true })
  })

  it('says hello with the identity it runs as', async () => {
    const hello = await h.client.waitForHello()
    expect(hello.uid).toBe(process.getuid?.())
    expect(hello.home).toBe(os.userInfo().homedir)
    expect(hello.v).toBe(1)
  })

  it('starts a process and streams its output, exit code and close in order', async () => {
    const events: string[] = []
    const p = h.client.spawn({
      command: '/bin/sh',
      args: ['-c', 'echo out; echo err 1>&2; exit 3'],
      env: { PATH: '/usr/bin:/bin' },
      stdio: ['ignore', 'pipe', 'pipe'],
      group: true,
    })
    p.on('spawn', () => events.push('spawn'))
    p.on('exit', () => events.push('exit'))
    const out = collect(p.stdout)
    const err = collect(p.stderr)
    const done = await closed(p)
    expect(done).toEqual({ code: 3, signal: null })
    expect(await out).toBe('out\n')
    expect(await err).toBe('err\n')
    expect(events).toEqual(['spawn', 'exit'])
    expect(typeof p.pid).toBe('number')
  })

  it('passes stdin through', async () => {
    const p = h.client.spawn({
      command: '/bin/cat',
      args: [],
      env: {},
      stdio: ['pipe', 'pipe', 'ignore'],
      group: true,
    })
    const out = collect(p.stdout)
    p.stdin?.write('hello ')
    p.stdin?.end('agent\n')
    await closed(p)
    expect(await out).toBe('hello agent\n')
  })

  it('reports a missing program as error then close, like Node', async () => {
    const events: string[] = []
    const p = h.client.spawn({
      command: path.join(dir, 'no-such-program'),
      args: [],
      env: {},
      stdio: ['ignore', 'pipe', 'pipe'],
      group: true,
    })
    p.on('error', (e: Error & { code?: string }) => events.push(`error:${e.code}`))
    p.on('exit', () => events.push('exit'))
    const done = await closed(p)
    expect(events).toEqual(['error:ENOENT'])
    expect(done.code).toBe(-2)
  })

  it('builds the child environment from the request and the agent identity only', async () => {
    const env = childEnvFor({ FOO: 'bar' })
    expect(env['FOO']).toBe('bar')
    expect(env['HOME']).toBe(os.userInfo().homedir)
    expect(env['USER']).toBe(os.userInfo().username)
    // Nothing of the host's own environment passes through.
    expect(env['PATH']).toBeUndefined()
    // A request's own HOME wins.
    expect(childEnvFor({ HOME: '/elsewhere' })['HOME']).toBe('/elsewhere')
  })

  it('stops a whole process group on killTree', async () => {
    const pidFile = path.join(dir, 'grandchild.pid')
    const p = h.client.spawn({
      command: '/bin/sh',
      args: ['-c', `sleep 30 & echo $! > ${pidFile}; wait`],
      env: { PATH: '/usr/bin:/bin' },
      stdio: ['ignore', 'pipe', 'pipe'],
      group: true,
    })
    await new Promise<void>((resolve) => p.once('spawn', () => resolve()))
    for (let i = 0; i < 100 && !fs.existsSync(pidFile); i++)
      await new Promise((r) => setTimeout(r, 20))
    const grandchild = Number(fs.readFileSync(pidFile, 'utf8').trim())
    p.killTree(200)
    await closed(p)
    let alive = true
    for (let i = 0; i < 50 && alive; i++) {
      try {
        process.kill(grandchild, 0)
        await new Promise((r) => setTimeout(r, 20))
      } catch {
        alive = false
      }
    }
    expect(alive).toBe(false)
  })

  /** A group whose leader has closed while a member with output of its own
   *  (none of the leader's pipes) runs on; the member's pid. */
  async function groupWithClosedLeader(command = 'sleep 30'): Promise<{
    p: ReturnType<InProcessHost['client']['spawn']>
    member: number
  }> {
    const p = h.client.spawn({
      command: '/bin/sh',
      args: ['-c', `${command} </dev/null >/dev/null 2>&1 & echo $!`],
      env: { PATH: '/usr/bin:/bin' },
      stdio: ['ignore', 'pipe', 'pipe'],
      group: true,
    })
    const out = collect(p.stdout)
    await closed(p)
    const member = Number((await out).trim())
    expect(isAlive(member)).toBe(true)
    return { p, member }
  }

  function isAlive(pid: number): boolean {
    try {
      process.kill(pid, 0)
      return true
    } catch {
      return false
    }
  }

  async function gone(pid: number, withinMs = 2_000): Promise<boolean> {
    for (let i = 0; i < withinMs / 20; i++) {
      if (!isAlive(pid)) return true
      await new Promise((r) => setTimeout(r, 20))
    }
    return false
  }

  it('stops a group after its leader closed, as a connector teardown asks', async () => {
    // A connector's teardown closes its session first (the leader exits once
    // its input ends), then stops the tree.
    const { p, member } = await groupWithClosedLeader()
    try {
      killProcessTree(p, { graceMs: 200 })
      expect(await gone(member)).toBe(true)
      // The stop is answered under the request's own id.
      await expect(
        h.client.request({ op: 'killTree', proc: p.id, graceMs: 0 }, { timeoutMs: 2_000 }),
      ).resolves.toMatchObject({ ok: true })
    } finally {
      if (isAlive(member)) process.kill(member, 'SIGKILL')
    }
  })

  it('stops such a group again when the server goes away during a long stop', async () => {
    // A member that ignores SIGTERM, asked to stop with a grace longer than
    // the host lives after the server goes: the end of the connection must
    // still reach it.
    const ready = path.join(dir, 'ignoring-term')
    const { p, member } = await groupWithClosedLeader(
      `sh -c 'trap "" TERM; touch ${ready}; exec sleep 30'`,
    )
    try {
      for (let i = 0; i < 100 && !fs.existsSync(ready); i++)
        await new Promise((r) => setTimeout(r, 20))
      killProcessTree(p, { graceMs: 60_000 })
      await new Promise((r) => setTimeout(r, 200))
      expect(isAlive(member)).toBe(true)
      h.client.close()
      expect(await gone(member, 6_000)).toBe(true)
    } finally {
      if (isAlive(member)) process.kill(member, 'SIGKILL')
    }
  }, 15_000)

  it('stops a group whose leader closed when the server goes away', async () => {
    const { member } = await groupWithClosedLeader()
    try {
      h.client.close()
      expect(await gone(member)).toBe(true)
    } finally {
      if (isAlive(member)) process.kill(member, 'SIGKILL')
    }
  })

  it('reads and writes files without following a link at the end of the path', async () => {
    const secret = path.join(dir, 'secret.txt')
    fs.writeFileSync(secret, 'the vault key')
    const link = path.join(dir, 'planted.txt')
    fs.symlinkSync(secret, link)

    await expect(
      h.client.request({ op: 'fs.read', path: link, maxBytes: 100 }),
    ).rejects.toMatchObject({
      code: 'ELOOP',
    })

    // A write to the link's name replaces the link; the target is untouched.
    await h.client.request({
      op: 'fs.write',
      path: link,
      data: Buffer.from('new').toString('base64'),
      mode: 0o600,
    })
    expect(fs.readFileSync(secret, 'utf8')).toBe('the vault key')
    expect(fs.lstatSync(link).isSymbolicLink()).toBe(false)
    expect(fs.readFileSync(link, 'utf8')).toBe('new')
    expect(fs.statSync(link).mode & 0o777).toBe(0o600)

    const r = await h.client.request({ op: 'fs.read', path: link, maxBytes: 2 })
    expect(r.missing).toBe(false)
    if (!r.missing) {
      expect(Buffer.from(r.data, 'base64').toString()).toBe('ne')
      expect(r.truncated).toBe(true)
    }
    expect(
      await h.client.request({ op: 'fs.read', path: path.join(dir, 'nope'), maxBytes: 10 }),
    ).toEqual(expect.objectContaining({ missing: true }))
  })

  it('makes folders with the mode asked for, lists, stats, renames and removes', async () => {
    const sub = path.join(dir, 'a', 'b')
    await h.client.request({ op: 'fs.mkdir', path: sub, mode: 0o700 })
    expect(fs.statSync(sub).mode & 0o777).toBe(0o700)
    fs.writeFileSync(path.join(sub, 'f'), 'x')
    const listed = await h.client.request({ op: 'fs.list', path: sub, max: 10 })
    expect(listed.entries.map((e) => [e.name, e.type])).toEqual([['f', 'file']])
    const st = await h.client.request({ op: 'fs.stat', path: path.join(sub, 'f') })
    expect(st.stat?.type).toBe('file')
    await h.client.request({ op: 'fs.rename', from: path.join(sub, 'f'), to: path.join(sub, 'g') })
    expect(fs.existsSync(path.join(sub, 'g'))).toBe(true)
    await h.client.request({ op: 'fs.rm', path: path.join(dir, 'a') })
    expect(fs.existsSync(path.join(dir, 'a'))).toBe(false)
    expect((await h.client.request({ op: 'fs.stat', path: path.join(dir, 'a') })).stat).toBeNull()
  })

  it('probes paths and reports the error code of each refusal', async () => {
    const closedFile = path.join(dir, 'closed')
    fs.writeFileSync(closedFile, 'x', { mode: 0o000 })
    const res = await h.client.request({
      op: 'probe',
      checks: [
        { path: closedFile, mode: 'read' },
        { path: path.join(dir, 'missing'), mode: 'read' },
        { path: dir, mode: 'list' },
        { path: dir, mode: 'write' },
      ],
    })
    const byKey = Object.fromEntries(
      res.results.map((r) => [`${r.mode}:${path.basename(r.path)}`, r]),
    )
    // Root can read a mode-0 file; everyone else cannot.
    if (process.getuid?.() !== 0)
      expect(byKey['read:closed']).toMatchObject({ ok: false, code: 'EACCES' })
    expect(byKey['read:missing']).toMatchObject({ ok: false, code: 'ENOENT' })
    expect(byKey[`list:${path.basename(dir)}`]).toMatchObject({ ok: true })
    expect(byKey[`write:${path.basename(dir)}`]).toMatchObject({ ok: true })
    // The write probe leaves nothing behind.
    expect(fs.readdirSync(dir)).toEqual(['closed'])
  })

  it('finds a hard link to a protected file anywhere under a folder', async () => {
    const db = path.join(dir, 'clawboo.db')
    fs.writeFileSync(db, 'db')
    const work = path.join(dir, 'work', 'teams', 't1')
    fs.mkdirSync(work, { recursive: true })
    fs.linkSync(db, path.join(work, 'notes.txt'))
    const st = fs.statSync(db, { bigint: true })
    const res = await h.client.request({
      op: 'inodes',
      root: path.join(dir, 'work'),
      targets: [{ dev: String(st.dev), ino: String(st.ino) }],
      maxEntries: 1000,
    })
    expect(res.matches).toEqual([path.join(work, 'notes.txt')])
  })

  it('refuses a signal it does not know', async () => {
    await expect(
      h.client.request({ op: 'signal', proc: 'p0', signal: 'SIGSTOP' }),
    ).rejects.toBeInstanceOf(AgentHostError)
  })
})

describe.runIf(posix)('agent host client, against a hostile host', () => {
  it('ends the connection on a line too long to be a frame', async () => {
    const { client, toServer } = startFakeHost()
    const reasons: string[] = []
    client.onClose((r) => reasons.push(r))
    toServer.write('x'.repeat(17 * 1024 * 1024))
    await new Promise((r) => setImmediate(r))
    expect(client.closed).toMatch(/too long/)
    expect(reasons).toHaveLength(1)
  })

  it('refuses a hello from another protocol version', async () => {
    const { client, toServer } = startFakeHost()
    const hello = client.waitForHello()
    toServer.write(
      encodeFrame({
        t: 'hello',
        v: 99,
        uid: 1,
        gid: 1,
        user: 'x',
        home: '/x',
        pid: 1,
        platform: 'linux',
      }),
    )
    await expect(hello).rejects.toThrow(/protocol 99/)
  })

  it('refuses a malformed hello', async () => {
    const { client, toServer } = startFakeHost()
    const hello = client.waitForHello()
    toServer.write(JSON.stringify({ t: 'hello', v: 1, uid: 'root' }) + '\n')
    await expect(hello).rejects.toThrow(/malformed/)
  })

  it('delivers a spawn reply before output that arrives in the same chunk', async () => {
    const { client, toServer, toHost } = startFakeHost()
    const p = client.spawn({
      command: 'x',
      args: [],
      env: {},
      stdio: ['ignore', 'pipe', 'pipe'],
      group: true,
    })
    const events: string[] = []
    p.on('spawn', () => events.push(`spawn:${p.pid}`))
    p.on('exit', (code: number) => events.push(`exit:${code}`))
    const out = collect(p.stdout)
    // Wait for the spawn request to reach the "host".
    const req = await new Promise<{ id: number; proc: string }>((resolve) =>
      toHost.once('data', (d: Buffer) => resolve(JSON.parse(d.toString()))),
    )
    toServer.write(
      [
        JSON.stringify({ t: 'res', id: req.id, ok: true, pid: 4242 }),
        JSON.stringify({
          t: 'ev',
          proc: req.proc,
          ev: 'out',
          data: Buffer.from('hi').toString('base64'),
        }),
        JSON.stringify({ t: 'ev', proc: req.proc, ev: 'exit', code: 0, signal: null }),
        JSON.stringify({ t: 'ev', proc: req.proc, ev: 'close', code: 0, signal: null }),
      ].join('\n') + '\n',
    )
    await closed(p)
    expect(events).toEqual(['spawn:4242', 'exit:0'])
    expect(await out).toBe('hi')
  })

  it('closes every process it started when the host goes away', async () => {
    const { client, toServer } = startFakeHost()
    const p = client.spawn({
      command: 'x',
      args: [],
      env: {},
      stdio: ['ignore', 'pipe', 'pipe'],
      group: true,
    })
    const errors: string[] = []
    p.on('error', (e: Error & { code?: string }) => errors.push(e.code ?? ''))
    const done = closed(p)
    toServer.end()
    expect(await done).toEqual({ code: -2, signal: null })
    expect(errors).toEqual(['ECLOSED'])
  })

  it('fails a request that is never answered', async () => {
    const { client } = startFakeHost()
    await expect(client.request({ op: 'ping' }, { timeoutMs: 50 })).rejects.toMatchObject({
      code: 'ETIMEDOUT',
    })
  })
})
