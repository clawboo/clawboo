// The agent host protocol end to end: a real host (served in this process) and
// the real client. Runs on POSIX only, like the mode it serves.

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { childEnvFor } from '../../../agentHost/host'
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

  it('stops a listing before its reply could exceed a frame, and says it was cut', async () => {
    const big = path.join(dir, 'big')
    fs.mkdirSync(big)
    const stem = 'x'.repeat(180)
    for (let i = 0; i < 22_000; i++) fs.writeFileSync(path.join(big, `${stem}${i}`), '')
    const raw: string[] = []
    h.toServer.on('data', (d: Buffer) => raw.push(d.toString()))
    const res = await h.client.request(
      { op: 'fs.list', path: big, max: 100_000 },
      { timeoutMs: 120_000 },
    )
    expect(res.truncated).toBe(true)
    expect(res.entries.length).toBeGreaterThan(0)
    expect(res.entries.length).toBeLessThan(22_000)
    expect(h.client.closed).toBeNull()
  }, 120_000)

  it('holds a process whose output the server is not reading, and lets it go when it is', async () => {
    const frames: string[] = []
    h.toHost.on('data', (d: Buffer) => frames.push(d.toString()))
    const p = h.client.spawn({
      command: '/bin/sh',
      args: [
        '-c',
        'while :; do echo xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx; done',
      ],
      env: { PATH: '/usr/bin:/bin' },
      stdio: ['ignore', 'pipe', 'ignore'],
      group: true,
    })
    for (let i = 0; i < 200 && !frames.join('').includes('"t":"pause"'); i++) {
      await new Promise((r) => setTimeout(r, 20))
    }
    expect(frames.join('')).toContain(`"t":"pause","proc":"${p.id}"`)
    p.stdout?.resume()
    for (let i = 0; i < 200 && !frames.join('').includes('"t":"resume"'); i++) {
      await new Promise((r) => setTimeout(r, 20))
    }
    expect(frames.join('')).toContain(`"t":"resume","proc":"${p.id}"`)
    p.killTree(100)
    await closed(p)
  })

  it('tries every way to become another user, as the agent user', async () => {
    const res = await h.client.request(
      { op: 'privCheck', serverUser: 'nobody' },
      { timeoutMs: 60_000 },
    )
    expect(res.attempts.map((a) => a.what)).toEqual([
      'sudo',
      'doas',
      'sudo -u nobody',
      'doas -u nobody',
      'sudo -l',
    ])
    expect(['allowed', 'denied', 'absent']).toContain(res.crontab)
  })

  it('counts a sudo rule for one command, which none of the tries can run', async () => {
    // A sudo that allows one shell as another user: `true` is refused, the
    // listing works.
    const bin = path.join(dir, 'bin')
    fs.mkdirSync(bin)
    fs.writeFileSync(
      path.join(bin, 'sudo'),
      [
        '#!/bin/sh',
        'if [ "$1" = "-n" ] && [ "$2" = "-l" ]; then',
        '  echo "User agent may run the following commands on host:"',
        '  echo "    (alice) NOPASSWD: /bin/sh"',
        '  exit 0',
        'fi',
        'echo "sudo: a password is required" >&2',
        'exit 1',
        '',
      ].join('\n'),
      { mode: 0o755 },
    )
    vi.stubEnv('PATH', `${bin}:/usr/bin:/bin`)
    try {
      const res = await h.client.request(
        { op: 'privCheck', serverUser: 'alice' },
        { timeoutMs: 60_000 },
      )
      expect(res.attempts.filter((a) => a.succeeded).map((a) => a.what)).toEqual(['sudo -l'])
    } finally {
      vi.unstubAllEnvs()
    }
  })

  it('counts a setgid file for a group the agent user is not in, whoever owns it', async () => {
    const tree = path.join(dir, 'tree')
    fs.mkdirSync(tree)
    const file = path.join(tree, 'tool')
    fs.writeFileSync(file, '#!/bin/sh\n')
    fs.chownSync(file, process.getuid?.() ?? 0, process.getgid?.() ?? 0)
    fs.chmodSync(file, 0o2755)
    expect(fs.statSync(file).mode & 0o2000).toBe(0o2000)
    // Its group is this user's: nothing to give.
    const own = await h.client.request({ op: 'inodes', root: tree, targets: [], maxEntries: 100 })
    expect(own.privileged).toEqual([])
    // The same file, for a host whose user is not in that group.
    // Optional on `process` (POSIX only), so typed here as present.
    const ids = process as { getgid: () => number; getgroups: () => number[] }
    const gid = vi.spyOn(ids, 'getgid').mockReturnValue(2_000_000_000)
    const groups = vi.spyOn(ids, 'getgroups').mockReturnValue([])
    try {
      const res = await h.client.request({
        op: 'inodes',
        root: tree,
        targets: [],
        maxEntries: 100,
      })
      expect(res.privileged).toEqual([file])
    } finally {
      gid.mockRestore()
      groups.mockRestore()
    }
  })

  it('refuses a private file whose mode cannot be set, and keeps others', async () => {
    const chmod = vi.spyOn(fs, 'fchmodSync').mockImplementation(() => {
      throw Object.assign(new Error('operation not permitted'), { code: 'EPERM' })
    })
    try {
      await expect(
        h.client.request({
          op: 'fs.write',
          path: path.join(dir, 'secret'),
          data: Buffer.from('s').toString('base64'),
          mode: 0o600,
        }),
      ).rejects.toMatchObject({ code: 'EPERM' })
      expect(fs.readdirSync(dir).filter((n) => n.includes('secret'))).toEqual([])
      await h.client.request({
        op: 'fs.write',
        path: path.join(dir, 'shared'),
        data: Buffer.from('s').toString('base64'),
        mode: 0o644,
      })
      expect(fs.readFileSync(path.join(dir, 'shared'), 'utf8')).toBe('s')
    } finally {
      chmod.mockRestore()
    }
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
