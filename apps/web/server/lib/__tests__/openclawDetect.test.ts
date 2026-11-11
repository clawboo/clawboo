// OpenClaw detection prefers the copy Clawboo installed into its runtimes folder
// (read from its record, nothing spawned) and falls back to one on PATH, so an
// existing global install keeps working. PATH lookups are stubbed; the runtimes
// folder is a temp dir.

import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const pathState = vi.hoisted(() => ({ openclaw: null as string | null }))
vi.mock('../platform', async (orig) => ({
  ...(await orig<typeof import('../platform')>()),
  findExecutable: (name: string) => (name === 'openclaw' ? pathState.openclaw : null),
}))
const execState = vi.hoisted(() => ({ calls: [] as string[] }))
vi.mock('node:child_process', async (orig) => {
  const real = await orig<typeof import('node:child_process')>()
  return {
    ...real,
    execFile: (file: string, _args: string[], _opts: unknown, cb: (...a: unknown[]) => void) => {
      execState.calls.push(file)
      cb(null, { stdout: 'OpenClaw 2026.9.2\n', stderr: '' })
    },
  }
})

import { commitRuntimeInstall, newInstallFolder } from '../runtimeFolder'
import { detectOpenClaw, findOpenClawPath, invalidateOpenClawCache } from '../openclawDetect'

describe('detectOpenClaw', () => {
  const KEYS = ['CLAWBOO_HOME', 'CLAWBOO_RUNTIMES_DIR', 'CLAWBOO_WORK_DIR'] as const
  const saved: Record<string, string | undefined> = {}
  let base: string

  beforeEach(() => {
    for (const k of KEYS) saved[k] = process.env[k]
    base = realpathSync.native(mkdtempSync(path.join(os.tmpdir(), 'clawboo-oc-detect-')))
    process.env['CLAWBOO_HOME'] = path.join(base, 'data')
    process.env['CLAWBOO_WORK_DIR'] = path.join(base, 'work')
    process.env['CLAWBOO_RUNTIMES_DIR'] = path.join(base, 'runtimes')
    pathState.openclaw = null
    execState.calls = []
    invalidateOpenClawCache()
  })
  afterEach(() => {
    for (const k of KEYS) {
      if (saved[k] === undefined) delete process.env[k]
      else process.env[k] = saved[k]
    }
    rmSync(base, { recursive: true, force: true })
  })

  function installOwn(): string {
    const folder = newInstallFolder('openclaw', 'v1')
    const entry = path.join(folder, 'node_modules', 'openclaw', 'openclaw.mjs')
    mkdirSync(path.dirname(entry), { recursive: true })
    writeFileSync(entry, '// gateway\n')
    commitRuntimeInstall('openclaw', {
      folder,
      version: '2026.9.37',
      source: 'openclaw@~2026.9',
      interpreter: { path: process.execPath, version: 'v24.22.1' },
      launchers: { openclaw: { command: process.execPath, args: [entry] } },
    })
    const bin = path.join(base, 'runtimes', 'bin', 'openclaw')
    return process.platform === 'win32' ? `${bin}.cmd` : bin
  }

  it("prefers Clawboo's own copy over a global one, without spawning it", async () => {
    pathState.openclaw = '/usr/local/bin/openclaw'
    const launcher = installOwn()
    expect(findOpenClawPath()).toBe(launcher)
    expect(await detectOpenClaw()).toEqual({
      installed: true,
      version: '2026.9.37',
      path: launcher,
      source: 'clawboo',
      node: { path: process.execPath, version: 'v24.22.1' },
    })
    expect(execState.calls).toEqual([])
  })

  it('falls back to a global install on PATH', async () => {
    pathState.openclaw = '/usr/local/bin/openclaw'
    expect(await detectOpenClaw()).toEqual({
      installed: true,
      version: '2026.9.2',
      path: '/usr/local/bin/openclaw',
      source: 'path',
      node: null,
    })
  })

  it('reads not installed with neither', async () => {
    expect(await detectOpenClaw()).toMatchObject({ installed: false, source: null })
  })
})
