// POST /api/system/gateway {action:'start'} when the Gateway refuses to start.
// After an OpenClaw upgrade the Gateway can exit at once asking for
// `openclaw doctor --fix`; the reconnect banner's Retry then failed forever
// because nothing ran it. The handler now runs that repair once and launches
// again. Real state dirs in a temp home; the process spawner and the port probe
// are faked, and the fake Gateway writes the line OpenClaw 2026.9.2 writes.

import { EventEmitter } from 'node:events'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import type { Request, Response } from 'express'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const pmState = vi.hoisted(() => ({
  reachable: false,
  pid: null as { pid: number; port: number; startedAt: number } | null,
  /** Spawned processes that have not exited. */
  alive: new Set<number>(),
}))
vi.mock('../../lib/processManager', () => ({
  readGatewayPid: () => pmState.pid,
  writeGatewayPid: (pid: number, port: number) => {
    pmState.pid = { pid, port, startedAt: Date.now() }
  },
  removeGatewayPid: () => {
    pmState.pid = null
  },
  isProcessAlive: (pid: number) => pmState.alive.has(pid),
  probeGatewayPort: async () => pmState.reachable,
}))
vi.mock('../../lib/openclawDetect', () => ({
  detectOpenClaw: async () => ({ installed: true, path: '/bin/openclaw', version: '2026.9.2' }),
  invalidateOpenClawCache: () => {},
}))
vi.mock('../../lib/agentSource', () => ({ getRegistry: () => ({ reconnect: async () => {} }) }))
vi.mock('../../lib/cwdGuard', () => ({ liveCwd: () => '/live/dir' }))
vi.mock('../../lib/runtimes/killTree', () => ({ killProcessTree: () => {} }))

class FakeChild extends EventEmitter {
  stdout = new EventEmitter()
  stderr = new EventEmitter()
  pid: number
  constructor(pid: number) {
    super()
    this.pid = pid
  }
  unref(): void {}
}

/** What each spawned process does, in launch order. */
type Script = (child: FakeChild, logPath: string) => void
const spawnState = vi.hoisted(() => ({
  calls: [] as { cmd: string; args: string[]; opts: Record<string, unknown> }[],
  scripts: [] as unknown[],
  nextPid: 5000,
}))
vi.mock('node:child_process', async (orig) => {
  const real = await orig<typeof import('node:child_process')>()
  return {
    ...real,
    spawn: (cmd: string, args: string[], opts: Record<string, unknown>) => {
      spawnState.calls.push({ cmd, args, opts })
      const child = new FakeChild(spawnState.nextPid++)
      pmState.alive.add(child.pid)
      child.on('exit', () => pmState.alive.delete(child.pid))
      child.on('close', () => pmState.alive.delete(child.pid))
      const script = spawnState.scripts.shift() as Script | undefined
      const logPath = path.join(process.env['CLAWBOO_HOME']!, 'gateway.log')
      if (script) setTimeout(() => script(child, logPath), 5)
      return child
    },
  }
})

import { gatewayControlPOST } from '../system'

const MIGRATION_FAILURE =
  '2026-10-21T23:05:01.011-04:00 Gateway failed to start: Legacy workspace setup state requires migration for /Users/ada/.openclaw/workspace; run openclaw doctor --fix.. Run openclaw gateway status --deep for diagnostics.\n'

/** A Gateway launch that writes `line` to its log and exits with `code`. */
const failingGateway =
  (line: string, code = 1): Script =>
  (child, logPath) => {
    fs.appendFileSync(logPath, line)
    child.emit('exit', code)
  }
/** A Gateway launch that comes up. */
const healthyGateway: Script = () => {
  pmState.reachable = true
}
/** `openclaw doctor --fix` exiting with `code`. */
const doctor =
  (code: number, output = '│  Archived legacy workspace setup state  │\n'): Script =>
  (child) => {
    child.stdout.emit('data', Buffer.from(output))
    child.emit('close', code)
  }

function sseRes() {
  const frames: Record<string, unknown>[] = []
  let ended = false
  let resolveEnd: () => void = () => {}
  const done = new Promise<void>((r) => (resolveEnd = r))
  const res = {
    setHeader() {},
    flushHeaders() {},
    headersSent: true,
    write(chunk: string) {
      const m = chunk.match(/^data: (.*)\n\n$/s)
      if (m) frames.push(JSON.parse(m[1]!) as Record<string, unknown>)
      return true
    },
    end() {
      ended = true
      resolveEnd()
    },
    get writableEnded() {
      return ended
    },
    on() {},
  } as unknown as Response
  return { res, frames, done }
}

async function start(): Promise<Record<string, unknown>[]> {
  const { res, frames, done } = sseRes()
  await gatewayControlPOST({ body: { action: 'start' } } as unknown as Request, res)
  await done
  return frames
}

describe('Gateway start that needs `openclaw doctor --fix`', () => {
  let home: string
  const saved: Record<string, string | undefined> = {}

  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'clawboo-gwrepair-'))
    for (const k of ['CLAWBOO_HOME', 'OPENCLAW_STATE_DIR']) saved[k] = process.env[k]
    process.env['CLAWBOO_HOME'] = home
    process.env['OPENCLAW_STATE_DIR'] = path.join(home, '.openclaw')
    fs.mkdirSync(path.join(home, '.openclaw'), { recursive: true })
    pmState.reachable = false
    pmState.pid = null
    pmState.alive.clear()
    spawnState.calls = []
    spawnState.scripts = []
  })
  afterEach(() => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k]
      else process.env[k] = v
    }
    fs.rmSync(home, { recursive: true, force: true })
  })

  it('runs the repair once, launches again, and reports the Gateway up', async () => {
    spawnState.scripts = [failingGateway(MIGRATION_FAILURE), doctor(0), healthyGateway]
    const frames = await start()

    expect(spawnState.calls.map((c) => c.args[0])).toEqual(['gateway', 'doctor', 'gateway'])
    expect(spawnState.calls[1]!.args).toEqual(['doctor', '--fix', '--non-interactive'])
    for (const call of spawnState.calls) expect(call.opts['cwd']).toBe('/live/dir')

    const steps = frames.filter((f) => f['type'] === 'progress').map((f) => f['step'])
    expect(steps).toContain('repairing')
    expect(frames.at(-1)).toMatchObject({ type: 'complete', success: true })
    expect(frames.filter((f) => f['type'] === 'error')).toEqual([])
  })

  it('stops after one repair when OpenClaw still asks for it', async () => {
    spawnState.scripts = [
      failingGateway(MIGRATION_FAILURE),
      doctor(0),
      failingGateway(MIGRATION_FAILURE),
    ]
    const frames = await start()
    expect(spawnState.calls.map((c) => c.args[0])).toEqual(['gateway', 'doctor', 'gateway'])
    expect(frames.at(-1)).toMatchObject({ type: 'error', code: 'DOCTOR_FIX_REQUIRED' })
  })

  it('says what doctor reported when the repair itself fails', async () => {
    spawnState.scripts = [
      failingGateway(MIGRATION_FAILURE),
      doctor(1, '│  Config write blocked: openclaw.json is read-only  │\n'),
    ]
    const frames = await start()
    const last = frames.at(-1)!
    expect(last).toMatchObject({ type: 'error', code: 'DOCTOR_FIX_FAILED' })
    expect(last['message']).toContain('Config write blocked: openclaw.json is read-only')
  })

  it('reports a stated failure at once instead of waiting out the poll', async () => {
    spawnState.scripts = [
      failingGateway(
        'Gateway failed to start: EADDRINUSE: address already in use 127.0.0.1:18789\n',
      ),
    ]
    const frames = await start()
    expect(spawnState.calls.map((c) => c.args[0])).toEqual(['gateway'])
    expect(frames.at(-1)).toEqual({
      type: 'error',
      code: 'GATEWAY_EXITED',
      message: 'Gateway did not start: EADDRINUSE: address already in use 127.0.0.1:18789',
    })
  })

  it('does not run doctor for a failure from an earlier launch left in the log', async () => {
    fs.writeFileSync(path.join(home, 'gateway.log'), MIGRATION_FAILURE)
    spawnState.scripts = [
      failingGateway(
        'Gateway failed to start: EADDRINUSE: address already in use 127.0.0.1:18789\n',
      ),
    ]
    const frames = await start()
    expect(spawnState.calls.map((c) => c.args[0])).toEqual(['gateway'])
    expect(frames.at(-1)).toMatchObject({ type: 'error', code: 'GATEWAY_EXITED' })
  })

  it('a second start during the repair waits for it and joins the relaunch', async () => {
    let finishDoctor: () => void = () => {}
    spawnState.scripts = [
      failingGateway(MIGRATION_FAILURE),
      (child: FakeChild) => {
        finishDoctor = () => child.emit('close', 0)
      },
      // The relaunch binds a moment later, so the second start joins it in flight.
      () => setTimeout(() => (pmState.reachable = true), 50),
    ]
    const first = sseRes()
    await gatewayControlPOST({ body: { action: 'start' } } as unknown as Request, first.res)
    // Wait until the repair is running.
    for (let i = 0; i < 50 && spawnState.calls.length < 2; i++) {
      await new Promise((r) => setTimeout(r, 10))
    }
    expect(spawnState.calls.map((c) => c.args[0])).toEqual(['gateway', 'doctor'])

    const second = sseRes()
    const secondDone = gatewayControlPOST(
      { body: { action: 'start' } } as unknown as Request,
      second.res,
    )
    await new Promise((r) => setTimeout(r, 30))
    expect(second.frames).toEqual([
      {
        type: 'progress',
        step: 'repairing',
        message: 'Waiting for the OpenClaw update to finish…',
      },
    ])

    finishDoctor()
    await secondDone
    await Promise.all([first.done, second.done])
    // One relaunch, shared: the second start never spawned a Gateway of its own.
    expect(spawnState.calls.map((c) => c.args[0])).toEqual(['gateway', 'doctor', 'gateway'])
    expect(first.frames.at(-1)).toMatchObject({ type: 'complete', success: true })
    expect(second.frames.at(-1)).toMatchObject({ type: 'complete', success: true })
  })
})
