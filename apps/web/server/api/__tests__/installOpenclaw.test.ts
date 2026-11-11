// POST /api/system/install-openclaw: OpenClaw goes into Clawboo's own runtimes
// folder after a Node check, never into npm's global prefix.
//
// The old route ran `npm install -g openclaw@~2026.9` on any Node: on a Node
// outside OpenClaw's range npm quietly installed an older release, a root-owned
// prefix failed with EACCES and the advice was `sudo`, and the install landed
// under whichever nvm Node was current. npm itself is faked here (spawn is
// recorded and the package it would write is written by the test); every
// folder is a temp dir, so nothing touches a real install.

import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import type { Request, Response } from 'express'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { OPENCLAW_INSTALL_SPEC, OPENCLAW_NODE_REQUIREMENT } from '@clawboo/protocol'

interface FakeChild {
  killed: boolean
  exitCode: number | null
  signalCode: string | null
  kill: () => boolean
  stdout: { on: (e: string, h: (c: Buffer) => void) => void }
  stderr: { on: (e: string, h: (c: Buffer) => void) => void }
  on: (e: string, h: (...a: unknown[]) => void) => FakeChild
  emitClose: (code: number) => void
  emitStderr: (text: string) => void
}
const spawnState = vi.hoisted(() => ({
  calls: [] as { cmd: string; args: string[]; opts: Record<string, unknown> }[],
  children: [] as FakeChild[],
}))
vi.mock('node:child_process', async (orig) => {
  const real = await orig<typeof import('node:child_process')>()
  const makeChild = (): FakeChild => {
    const onClose: ((code: number, signal: null) => void)[] = []
    const onErr: ((c: Buffer) => void)[] = []
    const child: FakeChild = {
      killed: false,
      exitCode: null,
      signalCode: null,
      kill() {
        this.killed = true
        return true
      },
      stdout: { on: () => {} },
      stderr: {
        on: (e, h) => {
          if (e === 'data') onErr.push(h)
        },
      },
      on(e, h) {
        if (e === 'close') onClose.push(h as (code: number, signal: null) => void)
        return this
      },
      emitClose(code) {
        this.exitCode = code
        for (const h of onClose) h(code, null)
      },
      emitStderr(text) {
        for (const h of onErr) h(Buffer.from(text))
      },
    }
    return child
  }
  return {
    ...real,
    spawn: (cmd: string, args: string[], opts: Record<string, unknown>) => {
      spawnState.calls.push({ cmd, args, opts })
      const child = makeChild()
      spawnState.children.push(child)
      return child
    },
  }
})

import { installOpenclawPOST } from '../system'

function mockRes(): {
  res: Response
  events: () => Record<string, unknown>[]
  ended: Promise<void>
} {
  const events: Record<string, unknown>[] = []
  let resolveEnd!: () => void
  const ended = new Promise<void>((r) => (resolveEnd = r))
  const res = {
    setHeader() {
      return this
    },
    flushHeaders() {},
    write(s: string) {
      const m = s.match(/^data: (.*)\n\n$/s)
      if (m) events.push(JSON.parse(m[1]!) as Record<string, unknown>)
      return true
    },
    end() {
      resolveEnd()
    },
    on() {
      return this
    },
  } as unknown as Response
  return { res, events: () => events, ended }
}

/** The `--prefix` folder of the recorded npm call. */
function prefixOf(args: string[]): string {
  return args[args.indexOf('--prefix') + 1]!
}

/** What npm would leave: the openclaw package with its `openclaw` command. */
function npmPutsOpenclaw(prefix: string, version = '2026.9.37'): string {
  const dir = path.join(prefix, 'node_modules', 'openclaw')
  mkdirSync(dir, { recursive: true })
  writeFileSync(
    path.join(dir, 'package.json'),
    JSON.stringify({ name: 'openclaw', version, bin: { openclaw: 'openclaw.mjs' } }),
  )
  writeFileSync(path.join(dir, 'openclaw.mjs'), '// gateway\n')
  return path.join(dir, 'openclaw.mjs')
}

describe('POST /api/system/install-openclaw', () => {
  const realVersion = Object.getOwnPropertyDescriptor(process, 'version')!
  const SAVED = [
    'CLAWBOO_HOME',
    'CLAWBOO_RUNTIMES_DIR',
    'CLAWBOO_WORK_DIR',
    'OPENCLAW_STATE_DIR',
  ] as const
  const prev: Record<string, string | undefined> = {}
  let home: string

  const setNode = (version: string): void => {
    Object.defineProperty(process, 'version', { ...realVersion, value: version })
  }

  beforeEach(() => {
    for (const k of SAVED) prev[k] = process.env[k]
    home = realpathSync.native(mkdtempSync(path.join(os.tmpdir(), 'clawboo-oc-install-')))
    process.env['CLAWBOO_HOME'] = path.join(home, 'data')
    process.env['OPENCLAW_STATE_DIR'] = path.join(home, 'openclaw-state')
    delete process.env['CLAWBOO_RUNTIMES_DIR']
    delete process.env['CLAWBOO_WORK_DIR']
    spawnState.calls = []
    spawnState.children = []
  })

  afterEach(async () => {
    // Settle any install still open so the next test starts with none running.
    for (const c of spawnState.children) if (c.exitCode === null) c.emitClose(1)
    await new Promise((r) => setTimeout(r, 0))
    Object.defineProperty(process, 'version', realVersion)
    for (const k of SAVED) {
      if (prev[k] === undefined) delete process.env[k]
      else process.env[k] = prev[k]
    }
    rmSync(home, { recursive: true, force: true })
  })

  it.each(['v22.23.2', 'v24.16.0', 'v25.9.0', 'v24.22.1-nightly'])(
    'on Node %s says so plainly and installs nothing',
    async (version) => {
      setNode(version)
      const m = mockRes()
      await installOpenclawPOST({} as Request, m.res)
      await m.ended
      const err = m.events().find((e) => e['type'] === 'error')
      expect(err?.['code']).toBe('NODE_UNSUPPORTED')
      expect(String(err?.['message'])).toContain(OPENCLAW_NODE_REQUIREMENT)
      expect(String(err?.['message'])).toContain(version)
      expect(spawnState.calls).toEqual([])
    },
  )

  it('on a supported Node, installs the pinned release into the runtimes folder, never globally', async () => {
    setNode('v24.22.1')
    const m = mockRes()
    const done = installOpenclawPOST({} as Request, m.res)
    await vi.waitFor(() => expect(spawnState.calls).toHaveLength(1))

    const { cmd, args, opts } = spawnState.calls[0]!
    expect(args).not.toContain('-g')
    expect(args).not.toContain('--global')
    expect(args[args.length - 1]).toBe(OPENCLAW_INSTALL_SPEC)
    const prefix = prefixOf(args)
    expect(path.dirname(prefix)).toBe(path.join(home, 'data-runtimes', 'openclaw'))
    // npm runs on this server's Node, with that Node first on PATH for scripts.
    expect([cmd, ...args].join(' ')).toContain(process.execPath)
    const env = opts['env'] as Record<string, string>
    const pathKey = Object.keys(env).find((k) => k.toUpperCase() === 'PATH')!
    expect(env[pathKey]!.split(path.delimiter)[0]).toBe(path.dirname(process.execPath))

    const entry = npmPutsOpenclaw(prefix)
    spawnState.children[0]!.emitClose(0)
    await done
    await m.ended

    const complete = m.events().find((e) => e['type'] === 'complete')
    expect(complete).toMatchObject({ success: true, version: '2026.9.37' })
    // The Gateway and every other `openclaw` run start from this launcher, which
    // runs OpenClaw on the Node that installed it, whatever PATH says later.
    const launcher = path.join(home, 'data-runtimes', 'bin', 'openclaw')
    expect(complete?.['path']).toBe(process.platform === 'win32' ? `${launcher}.cmd` : launcher)
    if (process.platform !== 'win32') {
      const script = readFileSync(launcher, 'utf8')
      expect(script).toContain(`'${process.execPath}'`)
      expect(script).toContain(`'${entry}'`)
    }
  })

  it('a failed install says why without suggesting sudo, and leaves nothing behind', async () => {
    setNode('v24.22.1')
    const m = mockRes()
    const done = installOpenclawPOST({} as Request, m.res)
    await vi.waitFor(() => expect(spawnState.calls).toHaveLength(1))
    spawnState.children[0]!.emitStderr(
      'npm error code EACCES\nnpm error syscall mkdir\nnpm error Error: EACCES: permission denied\n',
    )
    spawnState.children[0]!.emitClose(243)
    await done
    const text = m
      .events()
      .map((e) => String(e['message'] ?? ''))
      .join(' ')
    expect(m.events().find((e) => e['type'] === 'error')?.['code']).toBe('EACCES')
    expect(text).not.toMatch(/sudo/i)
    expect(m.events().some((e) => e['type'] === 'complete')).toBe(false)
  })

  it('refuses a second install while one is running', async () => {
    setNode('v24.22.1')
    const first = mockRes()
    const done = installOpenclawPOST({} as Request, first.res)
    await vi.waitFor(() => expect(spawnState.calls).toHaveLength(1))

    const second = mockRes()
    await installOpenclawPOST({} as Request, second.res)
    expect(second.events().find((e) => e['type'] === 'error')?.['code']).toBe('INSTALL_RUNNING')
    expect(spawnState.calls).toHaveLength(1)

    spawnState.children[0]!.emitClose(1)
    await done
  })

  it('refuses a runtimes folder inside the data folder before running npm', async () => {
    setNode('v24.22.1')
    process.env['CLAWBOO_RUNTIMES_DIR'] = path.join(home, 'data', 'runtimes')
    const m = mockRes()
    await installOpenclawPOST({} as Request, m.res)
    await m.ended
    expect(m.events().find((e) => e['type'] === 'error')?.['code']).toBe('RUNTIMES_DIR_REFUSED')
    expect(spawnState.calls).toEqual([])
  })
})
