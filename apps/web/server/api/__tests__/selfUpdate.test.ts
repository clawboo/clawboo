// POST /api/system/self-update, the "Click to update" chip's request. Covers
// the two things that broke on a real machine: npm must run in a directory
// that exists (it exits 7 in a deleted one), and a failure must reach the chip
// as npm's own reason, once, rather than a bare exit code.

import { EventEmitter } from 'node:events'

import type { Request, Response } from 'express'
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../../lib/platform', () => ({
  isWindows: false,
  resolveShimName: (n: string) => n,
}))
vi.mock('../../lib/cwdGuard', () => ({ liveCwd: () => '/live/dir' }))

const updateState = vi.hoisted(() => ({ versions: [] as (string | null)[] }))
vi.mock('../../lib/updateCheck', () => ({
  detectInstallMethod: () => 'global',
  readVersionFromDisk: () => updateState.versions.shift() ?? null,
  buildUpdateCommand: () => 'npm install -g clawboo@latest',
  computeSelfVersion: async () => ({}),
}))
const restartState = vi.hoisted(() => ({ ports: [] as number[] }))
vi.mock('../../lib/selfRestart', () => ({
  restartIntoLatest: (port: number) => restartState.ports.push(port),
}))

class FakeChild extends EventEmitter {
  stdout = new EventEmitter()
  stderr = new EventEmitter()
  killed = false
  kill(): boolean {
    this.killed = true
    return true
  }
}
const spawnState = vi.hoisted(() => ({
  calls: [] as { cmd: string; args: string[]; opts: Record<string, unknown> }[],
  child: null as unknown,
}))
vi.mock('node:child_process', () => ({
  spawn: (cmd: string, args: string[], opts: Record<string, unknown>) => {
    spawnState.calls.push({ cmd, args, opts })
    return spawnState.child
  },
}))

import { npmFailureEvent, selfUpdatePOST } from '../systemUpdate'

function sseRes() {
  const frames: Record<string, unknown>[] = []
  let ended = 0
  const res = {
    setHeader() {},
    flushHeaders() {},
    write(chunk: string) {
      const m = chunk.match(/^data: (.*)\n\n$/s)
      if (m) frames.push(JSON.parse(m[1]!) as Record<string, unknown>)
      return true
    },
    end() {
      ended++
    },
    on() {},
  } as unknown as Response
  return { res, frames, ends: () => ended }
}
const req = { app: { locals: { apiPort: 18790 } } } as unknown as Request

function start(): { child: FakeChild; frames: Record<string, unknown>[]; ends: () => number } {
  const child = new FakeChild()
  spawnState.child = child
  const { res, frames, ends } = sseRes()
  void selfUpdatePOST(req, res)
  return { child, frames, ends }
}

describe('POST /api/system/self-update', () => {
  beforeEach(() => {
    spawnState.calls = []
    updateState.versions = ['0.4.0', '0.5.0']
    restartState.ports = []
  })

  it('runs npm in a directory that exists, never an inherited one', () => {
    start()
    expect(spawnState.calls).toHaveLength(1)
    expect(spawnState.calls[0]!.cmd).toBe('npm')
    expect(spawnState.calls[0]!.args).toEqual(['install', '-g', 'clawboo@latest'])
    expect(spawnState.calls[0]!.opts['cwd']).toBe('/live/dir')
  })

  it("sends npm's own reason when it fails, as the only error", () => {
    const { child, frames, ends } = start()
    child.stderr.emit(
      'data',
      Buffer.from(
        'npm error code ETARGET\nnpm error notarget No matching version found for clawboo@9.\n',
      ),
    )
    child.emit('close', 1)
    const errors = frames.filter((f) => f['type'] === 'error')
    expect(errors).toEqual([
      {
        type: 'error',
        code: 'ETARGET',
        exitCode: 1,
        detail: 'No matching version found for clawboo@9.',
        message:
          'Update failed: No matching version found for clawboo@9. Copy the command to retry by hand.',
      },
    ])
    expect(ends()).toBe(1)
    expect(restartState.ports).toEqual([])
  })

  it('sends one permission error, not a second generic one after it', () => {
    const { child, frames } = start()
    child.stderr.emit(
      'data',
      Buffer.from(
        "npm error code EACCES\nnpm error Error: EACCES: permission denied, mkdir '/usr/local/lib/node_modules/clawboo'\n",
      ),
    )
    child.emit('close', 243)
    const errors = frames.filter((f) => f['type'] === 'error')
    expect(errors).toHaveLength(1)
    expect(errors[0]!['code']).toBe('EACCES')
  })

  it('restarts into the new version after a successful install', () => {
    const { child, frames, ends } = start()
    child.emit('close', 0)
    expect(frames.map((f) => f['type'])).toEqual(['progress', 'installed', 'restarting'])
    expect(restartState.ports).toEqual([18790])
    expect(ends()).toBe(1)
  })

  it('a spawn error then a close still ends the stream once', () => {
    const { child, frames, ends } = start()
    child.emit('error', new Error('spawn npm ENOENT'))
    child.emit('close', -2)
    expect(frames.filter((f) => f['type'] === 'error')).toHaveLength(1)
    expect(ends()).toBe(1)
  })
})

describe('npmFailureEvent', () => {
  it('falls back to the exit code when npm named no reason', () => {
    expect(npmFailureEvent(7, '')).toEqual({
      type: 'error',
      code: 'EXIT_7',
      exitCode: 7,
      detail: null,
      message:
        'Update failed with exit code 7. Try running it manually: npm install -g clawboo@latest',
    })
  })
})
