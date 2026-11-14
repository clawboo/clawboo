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
  unrefs: { child: 0, channel: 0 },
}))
vi.mock('child_process', async (orig) => {
  const real = await orig<typeof import('child_process')>()
  return {
    ...real,
    fork: (modulePath: string, _args: string[], opts: Record<string, unknown>) => {
      forkState.calls.push({ modulePath, opts })
      return {
        unref() {
          forkState.unrefs.child += 1
        },
        channel: {
          unref() {
            forkState.unrefs.channel += 1
          },
        },
        on() {},
      }
    },
  }
})

import { compileCacheEnv, launchDirEnv, serverWorkingDir, startDashboard } from '../lifecycle'

describe('the bundled server launch', () => {
  let home: string
  let savedHome: string | undefined
  let savedCompileCache: string | undefined

  beforeEach(() => {
    forkState.calls = []
    forkState.unrefs = { child: 0, channel: 0 }
    home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'clawboo-cli-cwd-')))
    savedHome = process.env['CLAWBOO_HOME']
    process.env['CLAWBOO_HOME'] = path.join(home, '.clawboo')
    savedCompileCache = process.env['NODE_COMPILE_CACHE']
    delete process.env['NODE_COMPILE_CACHE']
  })
  afterEach(() => {
    vi.restoreAllMocks()
    if (savedHome === undefined) delete process.env['CLAWBOO_HOME']
    else process.env['CLAWBOO_HOME'] = savedHome
    if (savedCompileCache === undefined) delete process.env['NODE_COMPILE_CACHE']
    else process.env['NODE_COMPILE_CACHE'] = savedCompileCache
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
    // Node keeps the compiled bundle between starts, in the data folder.
    expect(env['NODE_COMPILE_CACHE']).toBe(path.join(home, '.clawboo', 'cache', 'compile'))
  })

  // fork() always gives the server an IPC channel, and the launcher lets go of
  // it and exits. A server told to stop when its channel closes would stop the
  // moment `clawboo` returned, so the launcher never passes that on, even from a
  // shell that has it. (The server side is in apps/web serverStop.test.ts.)
  it('lets go of the server and its channel, and never has it stop with the launcher', async () => {
    const realExists = fs.existsSync
    vi.spyOn(fs, 'existsSync').mockImplementation((p) =>
      String(p).endsWith(`${path.sep}server.js`) ? true : realExists(p),
    )
    vi.stubEnv('CLAWBOO_STOP_ON_DISCONNECT', '1')
    try {
      await startDashboard({ port: 1, maxAttempts: 1 })
    } finally {
      vi.unstubAllEnvs()
    }

    expect(forkState.calls).toHaveLength(1)
    const { opts } = forkState.calls[0]!
    expect(opts['detached']).toBe(true)
    expect(forkState.unrefs).toEqual({ child: 1, channel: 1 })
    // Node leaves a variable whose value is undefined out of the child's env.
    const env = opts['env'] as NodeJS.ProcessEnv
    expect(env['CLAWBOO_STOP_ON_DISCONNECT']).toBeUndefined()
  })

  it('keeps a compile cache the environment already names', () => {
    expect(compileCacheEnv({ ...process.env, NODE_COMPILE_CACHE: '/somewhere/else' })).toEqual({})
    expect(compileCacheEnv({ ...process.env, NODE_COMPILE_CACHE: '' })).toEqual({
      NODE_COMPILE_CACHE: path.join(home, '.clawboo', 'cache', 'compile'),
    })
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
