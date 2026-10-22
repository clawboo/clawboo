// Where the launcher starts the bundled server. It used to be the package's own
// dist folder, which `npm install -g clawboo@latest` replaces: the running
// server, and everything it started afterwards, was left in a directory that no
// longer existed. The in-app update then failed with npm exit code 7 and the
// OpenClaw CLI refused to start.

import fs from 'fs'
import os from 'os'
import path from 'path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const forkState = vi.hoisted(() => ({
  calls: [] as { modulePath: string; opts: Record<string, unknown> }[],
}))
vi.mock('child_process', async (orig) => {
  const real = await orig<typeof import('child_process')>()
  return {
    ...real,
    fork: (modulePath: string, _args: string[], opts: Record<string, unknown>) => {
      forkState.calls.push({ modulePath, opts })
      return { unref() {}, channel: { unref() {} }, on() {} }
    },
  }
})

import { launchDirEnv, serverWorkingDir, startDashboard } from '../lifecycle'

describe('the bundled server launch', () => {
  let home: string
  let savedHome: string | undefined

  beforeEach(() => {
    forkState.calls = []
    home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'clawboo-cli-cwd-')))
    savedHome = process.env['CLAWBOO_HOME']
    process.env['CLAWBOO_HOME'] = path.join(home, '.clawboo')
  })
  afterEach(() => {
    vi.restoreAllMocks()
    if (savedHome === undefined) delete process.env['CLAWBOO_HOME']
    else process.env['CLAWBOO_HOME'] = savedHome
    fs.rmSync(home, { recursive: true, force: true })
  })

  it("starts the server in clawboo's own directory, not the package folder", async () => {
    const realExists = fs.existsSync
    // Pretend the bundled server.js sits next to the launcher, as it does in a
    // published install.
    vi.spyOn(fs, 'existsSync').mockImplementation((p) =>
      String(p).endsWith(`${path.sep}server.js`) ? true : realExists(p),
    )

    // Port 1 refuses at once, so the single readiness probe is quick.
    await startDashboard({ port: 1, maxAttempts: 1 })

    expect(forkState.calls).toHaveLength(1)
    const { modulePath, opts } = forkState.calls[0]!
    const packageDir = path.dirname(modulePath)
    expect(opts['cwd']).toBe(path.join(home, '.clawboo'))
    expect(path.relative(packageDir, String(opts['cwd'])).startsWith('..')).toBe(true)
    // Created, since a first run has no clawboo directory yet.
    expect(fs.statSync(String(opts['cwd'])).isDirectory()).toBe(true)

    const env = opts['env'] as NodeJS.ProcessEnv
    expect(env['CLAWBOO_LAUNCH_DIR']).toBe(process.cwd())
  })

  it('falls back to the home directory when clawboo cannot create its own', () => {
    process.env['CLAWBOO_HOME'] = path.join(home, 'file-not-dir', 'sub')
    fs.writeFileSync(path.join(home, 'file-not-dir'), '')
    expect(serverWorkingDir()).toBe(os.homedir())
  })

  it('omits the launch directory when the shell sits in a deleted one', () => {
    vi.spyOn(process, 'cwd').mockImplementation(() => {
      throw Object.assign(new Error('uv_cwd'), { code: 'ENOENT' })
    })
    expect(launchDirEnv()).toEqual({})
  })
})
