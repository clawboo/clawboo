// POST /api/system/self-update on an install that must not update itself. The
// route used to refuse only npx and source checkouts, so a global install it
// could not write, or one whose administrator turned updates off, still ran
// `npm install -g`.

import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import type { Request, Response } from 'express'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const spawnState = vi.hoisted(() => ({ calls: [] as string[][] }))
vi.mock('node:child_process', async (orig) => ({
  ...(await orig<typeof import('node:child_process')>()),
  spawn: (cmd: string, args: string[]) => {
    spawnState.calls.push([cmd, ...args])
    throw new Error('spawn is not expected in this test')
  },
}))

import { selfUpdatePOST } from '../systemUpdate'

function post(): Record<string, unknown>[] {
  const frames: Record<string, unknown>[] = []
  const res = {
    setHeader() {},
    flushHeaders() {},
    write(chunk: string) {
      const m = chunk.match(/^data: (.*)\n\n$/s)
      if (m) frames.push(JSON.parse(m[1]!) as Record<string, unknown>)
      return true
    },
    end() {},
    on() {},
  } as unknown as Response
  void selfUpdatePOST({ app: { locals: { apiPort: 18790 } } } as unknown as Request, res)
  return frames
}

describe('POST /api/system/self-update on an install that must not update itself', () => {
  let root: string
  const entry = process.argv[1]

  beforeEach(() => {
    spawnState.calls = []
    root = mkdtempSync(path.join(os.tmpdir(), 'clawboo-selfupdate-'))
    vi.stubEnv('CLAWBOO_HOME', root)
    // A global install, laid out the way npm lays one out.
    const dist = path.join(root, 'lib', 'node_modules', 'clawboo', 'dist')
    mkdirSync(dist, { recursive: true })
    writeFileSync(path.join(dist, 'server.js'), '')
    process.argv[1] = path.join(dist, 'server.js')
  })
  afterEach(() => {
    process.argv[1] = entry
    vi.unstubAllEnvs()
    chmodSync(path.join(root, 'lib', 'node_modules'), 0o755)
    rmSync(root, { recursive: true, force: true })
  })

  it('refuses with a clear message when updates are turned off, and runs nothing', () => {
    vi.stubEnv('CLAWBOO_DISABLE_SELF_UPDATE', '1')
    const frames = post()

    expect(spawnState.calls).toEqual([])
    expect(frames).toEqual([
      expect.objectContaining({
        type: 'unsupported',
        reason: 'disabled',
        message: expect.stringContaining('administrator'),
      }),
    ])
  })

  it.skipIf(process.platform === 'win32' || process.getuid?.() === 0)(
    'refuses a global install this user cannot write',
    () => {
      chmodSync(path.join(root, 'lib', 'node_modules'), 0o555)
      const frames = post()

      expect(spawnState.calls).toEqual([])
      expect(frames).toEqual([
        expect.objectContaining({
          type: 'unsupported',
          reason: 'not-writable',
          message: expect.stringContaining('cannot update itself'),
        }),
      ])
    },
  )
})
