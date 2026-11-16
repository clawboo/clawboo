// A runtime Clawboo installed runs on the Node.js that installed it, by path.
// When that Node is gone, such as when an app that runs Clawboo on a Node of
// its own is moved, the runtime moves to the Node this server runs on, but only
// when that Node can run it, and never by half: a failure puts every launcher
// back, and a process that dies part way leaves the old pointer for the next
// start to finish from.
//
// `node:fs` is wrapped so a rename can fail, or the process can "die" (every
// write after that point fails, the rollback's included), at a chosen step.

import { execFileSync } from 'node:child_process'
import { chmodSync, mkdirSync, readdirSync, realpathSync, writeFileSync } from 'node:fs'
import { mkdtemp, readFile, rm, symlink, unlink } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  INSTALL_RECORD_FILE,
  commitRuntimeInstall,
  launcherFileName,
  newInstallFolder,
  nodeVersionCovers,
  ownedRuntimeLaunch,
  ownedRuntimeProblem,
  readRuntimeInstall,
  repointRuntimeNode,
  repointRuntimesToServerNode,
  stableNodePath,
} from '../runtimeFolder'

const disk = vi.hoisted(() => ({
  /** Set once the process "died": every write fails from then on. */
  dead: false,
  /** Decides what a rename onto `dest` does. */
  onRename: null as null | ((dest: string) => 'crash' | 'fail' | undefined),
}))

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>()
  const gone = (): never => {
    throw Object.assign(new Error('the process is gone'), { code: 'ECRASHED' })
  }
  const renameSync = (...args: Parameters<typeof actual.renameSync>): void => {
    if (disk.dead) gone()
    const what = disk.onRename?.(String(args[1]))
    if (what === 'crash') {
      disk.dead = true
      gone()
    }
    if (what === 'fail') throw Object.assign(new Error('rename failed'), { code: 'EIO' })
    actual.renameSync(...args)
  }
  const writeFileSync = (...args: Parameters<typeof actual.writeFileSync>): void => {
    if (disk.dead) gone()
    actual.writeFileSync(...args)
  }
  const unlinkSync = (...args: Parameters<typeof actual.unlinkSync>): void => {
    if (disk.dead) gone()
    actual.unlinkSync(...args)
  }
  const chmodSync = (...args: Parameters<typeof actual.chmodSync>): void => {
    if (disk.dead) gone()
    actual.chmodSync(...args)
  }
  const fs = { ...actual, renameSync, writeFileSync, unlinkSync, chmodSync }
  return { ...fs, default: fs }
})

const logs = vi.hoisted(() => ({
  info: [] as [Record<string, unknown>, string][],
  warn: [] as [Record<string, unknown>, string][],
}))
vi.mock('@clawboo/logger', () => ({
  createLogger: () => ({
    info: (meta: Record<string, unknown>, msg: string) => logs.info.push([meta, msg]),
    warn: (meta: Record<string, unknown>, msg: string) => logs.warn.push([meta, msg]),
    error: () => {},
    debug: () => {},
  }),
}))

const isWindows = process.platform === 'win32'
const isRoot = process.getuid?.() === 0

let base: string
let env: NodeJS.ProcessEnv

beforeEach(async () => {
  disk.dead = false
  disk.onRename = null
  logs.info.length = 0
  logs.warn.length = 0
  base = realpathSync.native(await mkdtemp(path.join(os.tmpdir(), 'clawboo-repoint-')))
  env = {
    HOME: base,
    CLAWBOO_HOME: path.join(base, 'data'),
    CLAWBOO_WORK_DIR: path.join(base, 'work'),
    CLAWBOO_RUNTIMES_DIR: path.join(base, 'runtimes'),
  }
})

afterEach(async () => {
  disk.dead = false
  disk.onRename = null
  await rm(base, { recursive: true, force: true })
})

/** A file standing in for a Node at `rel` under the test folder. */
function fakeNode(rel: string): string {
  const node = path.join(base, rel)
  mkdirSync(path.dirname(node), { recursive: true })
  writeFileSync(node, '#!/bin/sh\n', { mode: 0o755 })
  chmodSync(node, 0o755)
  return node
}

/**
 * Install `id` as an npm runtime installed on `node` (Node `version`) would be:
 * each launcher runs that Node with an entry script that prints its arguments.
 */
function installOn(
  id: string,
  node: string,
  version: string,
  names: string[] = [id],
  arch?: string,
): { script: string; recordFile: string; launcher: (name: string) => string } {
  const folder = newInstallFolder(id, 'v1', env)
  const script = path.join(folder, 'entry.js')
  writeFileSync(script, 'console.log(process.argv.slice(2).join("\\n"))\n')
  commitRuntimeInstall(
    id,
    {
      folder,
      version: '2026.11.1',
      source: `${id}@~2026.11`,
      interpreter: { path: node, version, ...(arch ? { arch } : {}) },
      launchers: Object.fromEntries(names.map((n) => [n, { command: node, args: [script] }])),
    },
    env,
  )
  return {
    script,
    recordFile: path.join(base, 'runtimes', id, INSTALL_RECORD_FILE),
    launcher: (name) => path.join(base, 'runtimes', 'bin', launcherFileName(name)),
  }
}

/** Stray files a staged write leaves when it does not clean up after itself. */
function strayTemps(): string[] {
  return ['bin', 'openclaw'].flatMap((d) =>
    readdirSync(path.join(base, 'runtimes', d)).filter((f) => f.endsWith('.tmp')),
  )
}

describe('nodeVersionCovers', () => {
  it('takes the same version or a later release of the same major, nothing else', () => {
    expect(nodeVersionCovers('v24.15.0', 'v24.15.0')).toBe(true)
    expect(nodeVersionCovers('v24.15.0', 'v24.15.3')).toBe(true)
    expect(nodeVersionCovers('v24.15.0', 'v24.16.0')).toBe(true)
    expect(nodeVersionCovers('v24.15.2', 'v24.15.1')).toBe(false) // older
    expect(nodeVersionCovers('v24.15.0', 'v24.9.9')).toBe(false) // older, not by string order
    expect(nodeVersionCovers('v24.15.0', 'v25.0.0')).toBe(false) // another major
    expect(nodeVersionCovers('v24.15.0', 'v22.20.0')).toBe(false)
    // Not a Node: Hermes records its Python's minor version.
    expect(nodeVersionCovers('3.12', 'v24.15.0')).toBe(false)
    expect(nodeVersionCovers('3.12', '3.12')).toBe(false)
    // A build with a suffix moves only to that very build.
    expect(nodeVersionCovers('v24.15.0-rc.1', 'v24.15.0-rc.1')).toBe(true)
    expect(nodeVersionCovers('v24.15.0-rc.1', 'v24.15.0')).toBe(false)
  })
})

describe('a runtime whose Node is gone', () => {
  it('moves to the Node this server runs on when that is the same version', async () => {
    const old = fakeNode('Old App.app/Contents/Resources/node/bin/node')
    const { launcher, recordFile } = installOn('openclaw', old, process.version)
    const before = JSON.parse(await readFile(recordFile, 'utf8')) as Record<string, unknown>
    await unlink(old) // the app was moved

    const to = stableNodePath(process.execPath)
    const launch = ownedRuntimeLaunch('openclaw', env)
    expect(launch?.command).toBe(to)
    expect(ownedRuntimeProblem('openclaw', env)).toBeNull()
    const record = readRuntimeInstall('openclaw', env)
    expect(record?.interpreter).toEqual({ path: to, version: process.version, arch: process.arch })
    // The install itself is unchanged: same folder, version and time.
    expect(record?.folder).toBe(before['folder'])
    expect(record?.installedAt).toBe(before['installedAt'])

    const text = await readFile(launcher('openclaw'), 'utf8')
    expect(text).toContain(to)
    expect(text).not.toContain('Old App')
    if (!isWindows) {
      const out = execFileSync(launcher('openclaw'), ['gateway', 'run'], { encoding: 'utf8' })
      expect(out.trim().split('\n')).toEqual(['gateway', 'run'])
    }
    expect(logs.info).toHaveLength(1)
    expect(logs.info[0]?.[0]).toMatchObject({
      id: 'openclaw',
      from: old,
      to,
      launchers: ['openclaw'],
    })
  })

  it('moves to a later release of the same major, rewriting only what ran the old Node', async () => {
    const old = fakeNode('old/bin/node')
    const next = fakeNode('new/bin/node')
    const folder = newInstallFolder('openclaw', 'v1', env)
    const script = path.join(folder, 'entry.js')
    writeFileSync(script, '// openclaw\n')
    const other = fakeNode('tools/helper')
    commitRuntimeInstall(
      'openclaw',
      {
        folder,
        version: '2026.11.1',
        source: 'openclaw@~2026.11',
        interpreter: { path: old, version: 'v24.15.0' },
        launchers: {
          openclaw: { command: old, args: [script] },
          helper: { command: other, args: [] },
        },
      },
      env,
    )
    // `helper.cmd` on Windows.
    const helperFile = path.join(base, 'runtimes', 'bin', launcherFileName('helper'))
    const helperBefore = await readFile(helperFile, 'utf8')
    await unlink(old)

    const moved = repointRuntimeNode('openclaw', env, { execPath: next, version: 'v24.16.2' })
    expect(moved?.interpreter).toEqual({ path: next, version: 'v24.16.2', arch: process.arch })
    expect(moved?.launchers['openclaw']).toEqual({ command: next, args: [script] })
    expect(moved?.launchers['helper']).toEqual({ command: other, args: [] })
    expect(readRuntimeInstall('openclaw', env)).toEqual(moved)
    expect(await readFile(helperFile, 'utf8')).toBe(helperBefore)
    expect(strayTemps()).toEqual([])
  })

  it('stays refused when this server runs another major, or an older release', async () => {
    const old = fakeNode('old/bin/node')
    const next = fakeNode('new/bin/node')
    const { recordFile, launcher } = installOn('openclaw', old, 'v24.15.0')
    const recordBefore = await readFile(recordFile, 'utf8')
    const launcherBefore = await readFile(launcher('openclaw'), 'utf8')
    await unlink(old)

    for (const version of ['v25.0.0', 'v23.11.0', 'v24.14.9', 'v24.15.0-rc.1']) {
      expect(repointRuntimeNode('openclaw', env, { execPath: next, version }), version).toBeNull()
    }
    expect(await readFile(recordFile, 'utf8')).toBe(recordBefore)
    expect(await readFile(launcher('openclaw'), 'utf8')).toBe(launcherBefore)
    expect(logs.info).toEqual([])
  })

  it('keeps the refusal through a lookup when the versions do not match', async () => {
    const old = fakeNode('old/bin/node')
    const major = Number(process.version.slice(1).split('.')[0])
    const { recordFile } = installOn('openclaw', old, `v${major + 1}.0.0`)
    const recordBefore = await readFile(recordFile, 'utf8')
    await unlink(old)
    expect(ownedRuntimeLaunch('openclaw', env)).toBeNull()
    expect(ownedRuntimeProblem('openclaw', env)).toMatch(
      /runs on .*old.*bin.*node.*Install openclaw again/,
    )
    expect(await readFile(recordFile, 'utf8')).toBe(recordBefore)
  })

  it.skipIf(isWindows || isRoot)(
    'leaves a Node that is still there but others can change alone',
    async () => {
      const old = fakeNode('old/bin/node')
      installOn('openclaw', old, process.version)
      chmodSync(old, 0o777)
      expect(ownedRuntimeLaunch('openclaw', env)).toBeNull()
      expect(ownedRuntimeProblem('openclaw', env)).toMatch(/can be changed by another user/)
      expect(readRuntimeInstall('openclaw', env)?.interpreter?.path).toBe(old)
    },
  )

  it('never moves a runtime whose interpreter is not a Node', async () => {
    // Hermes: its launcher runs a script in a venv made with a Python.
    const python = fakeNode('py/bin/python3.12')
    const venvHermes = fakeNode('venv/bin/hermes')
    const folder = newInstallFolder('hermes', 'v1', env)
    commitRuntimeInstall(
      'hermes',
      {
        folder,
        version: '0.4.0',
        source: 'x',
        interpreter: { path: python, version: '3.12' },
        launchers: { hermes: { command: venvHermes, args: [] } },
      },
      env,
    )
    await unlink(python)
    await unlink(venvHermes)
    expect(repointRuntimeNode('hermes', env)).toBeNull()
    expect(ownedRuntimeLaunch('hermes', env)).toBeNull()
    expect(readRuntimeInstall('hermes', env)?.interpreter?.path).toBe(python)
  })

  it('moves nothing while its own Node is still there', async () => {
    const old = fakeNode('old/bin/node')
    const next = fakeNode('new/bin/node')
    installOn('openclaw', old, 'v24.15.0')
    expect(repointRuntimeNode('openclaw', env, { execPath: next, version: 'v24.15.0' })).toBeNull()
    expect(readRuntimeInstall('openclaw', env)?.interpreter?.path).toBe(old)
  })

  it('moves only to a Node on the processor the install was made for', async () => {
    // npm picked the runtime's native parts for that processor.
    const old = fakeNode('old/bin/node')
    const next = fakeNode('new/bin/node')
    installOn('openclaw', old, 'v24.15.0', ['openclaw'], 'x64')
    await unlink(old)
    expect(
      repointRuntimeNode('openclaw', env, { execPath: next, version: 'v24.15.0', arch: 'arm64' }),
    ).toBeNull()
    const moved = repointRuntimeNode('openclaw', env, {
      execPath: next,
      version: 'v24.15.0',
      arch: 'x64',
    })
    expect(moved?.interpreter).toEqual({ path: next, version: 'v24.15.0', arch: 'x64' })
  })

  it('leaves a library alone: nothing starts it on its recorded Node', async () => {
    const old = fakeNode('old/bin/node')
    const next = fakeNode('new/bin/node')
    const folder = newInstallFolder('claude-code', 'v1', env)
    commitRuntimeInstall(
      'claude-code',
      {
        folder,
        version: '0.3.268',
        source: '@anthropic-ai/claude-agent-sdk@0.3',
        interpreter: { path: old, version: 'v24.15.0' },
        launchers: {},
      },
      env,
    )
    await unlink(old)
    expect(
      repointRuntimeNode('claude-code', env, { execPath: next, version: 'v24.15.0' }),
    ).toBeNull()
    expect(readRuntimeInstall('claude-code', env)?.interpreter?.path).toBe(old)
    expect(logs.info).toEqual([])
  })

  it('moves nothing whose script is gone', async () => {
    const old = fakeNode('old/bin/node')
    const next = fakeNode('new/bin/node')
    const { script, recordFile } = installOn('openclaw', old, 'v24.15.0')
    const before = await readFile(recordFile, 'utf8')
    await unlink(old)
    await unlink(script)
    expect(repointRuntimeNode('openclaw', env, { execPath: next, version: 'v24.15.0' })).toBeNull()
    expect(await readFile(recordFile, 'utf8')).toBe(before)
  })

  it.skipIf(isWindows || isRoot)('never moves to a Node others can change', async () => {
    const old = fakeNode('old/bin/node')
    const next = fakeNode('new/bin/node')
    chmodSync(next, 0o777)
    installOn('openclaw', old, 'v24.15.0')
    await unlink(old)
    expect(repointRuntimeNode('openclaw', env, { execPath: next, version: 'v24.15.0' })).toBeNull()
    expect(readRuntimeInstall('openclaw', env)?.interpreter?.path).toBe(old)
  })

  it('writes nothing into a runtimes folder Clawboo refuses', async () => {
    const old = fakeNode('old/bin/node')
    const next = fakeNode('new/bin/node')
    const { recordFile } = installOn('openclaw', old, 'v24.15.0')
    const before = await readFile(recordFile, 'utf8')
    await unlink(old)
    // The same folder, now named as the work folder: agents could change it.
    const refused = { ...env, CLAWBOO_WORK_DIR: path.join(base, 'runtimes') }
    expect(
      repointRuntimeNode('openclaw', refused, { execPath: next, version: 'v24.15.0' }),
    ).toBeNull()
    expect(await readFile(recordFile, 'utf8')).toBe(before)
  })

  it.skipIf(isWindows)(
    "records a Homebrew Node by its formula's link, which an upgrade keeps",
    async () => {
      const keg = fakeNode('homebrew/Cellar/node@24/24.16.0/bin/node')
      mkdirSync(path.join(base, 'homebrew', 'opt'), { recursive: true })
      await symlink(
        path.join(base, 'homebrew', 'Cellar', 'node@24', '24.16.0'),
        path.join(base, 'homebrew', 'opt', 'node@24'),
      )
      const opt = path.join(base, 'homebrew', 'opt', 'node@24', 'bin', 'node')
      const old = fakeNode('old/bin/node')
      const { launcher } = installOn('openclaw', old, 'v24.15.0')
      await unlink(old)
      const moved = repointRuntimeNode('openclaw', env, { execPath: keg, version: 'v24.16.0' })
      expect(moved?.interpreter?.path).toBe(opt)
      expect(await readFile(launcher('openclaw'), 'utf8')).toContain(opt)
    },
  )

  it('moves every runtime on record at boot', async () => {
    const old = fakeNode('old/bin/node')
    installOn('openclaw', old, process.version)
    installOn('codex', old, process.version)
    await unlink(old)
    expect(repointRuntimesToServerNode(env).sort()).toEqual(['codex', 'openclaw'])
    const to = stableNodePath(process.execPath)
    expect(readRuntimeInstall('codex', env)?.launchers['codex']?.command).toBe(to)
    expect(readRuntimeInstall('openclaw', env)?.launchers['openclaw']?.command).toBe(to)
    expect(repointRuntimesToServerNode(env)).toEqual([]) // nothing left to move
  })
})

describe('a move that does not finish', () => {
  it('puts every launcher back and keeps the old record when a rename fails part way', async () => {
    const old = fakeNode('old/bin/node')
    const next = fakeNode('new/bin/node')
    const { recordFile, launcher } = installOn('openclaw', old, 'v24.15.0', [
      'openclaw',
      'openclaw-cli',
    ])
    const recordBefore = await readFile(recordFile, 'utf8')
    const launchersBefore = await Promise.all(
      ['openclaw', 'openclaw-cli'].map((n) => readFile(launcher(n), 'utf8')),
    )
    await unlink(old)
    // The first launcher is replaced, then the second one's rename fails.
    disk.onRename = (dest) => (dest === launcher('openclaw-cli') ? 'fail' : undefined)

    expect(repointRuntimeNode('openclaw', env, { execPath: next, version: 'v24.15.0' })).toBeNull()
    expect(await readFile(recordFile, 'utf8')).toBe(recordBefore)
    expect(
      await Promise.all(['openclaw', 'openclaw-cli'].map((n) => readFile(launcher(n), 'utf8'))),
    ).toEqual(launchersBefore)
    expect(strayTemps()).toEqual([])
    expect(logs.warn).toHaveLength(1)
    expect(logs.info).toEqual([])
  })

  it('leaves the old record when the process dies part way, and the next start finishes', async () => {
    const old = fakeNode('old/bin/node')
    const { recordFile, launcher } = installOn('openclaw', old, process.version)
    const recordBefore = await readFile(recordFile, 'utf8')
    await unlink(old)
    // The launcher is in place; the process dies on the pointer's rename, and
    // nothing after that point reaches the disk, the rollback included.
    disk.onRename = (dest) => (dest === recordFile ? 'crash' : undefined)

    expect(ownedRuntimeLaunch('openclaw', env)).toBeNull()
    disk.dead = false
    disk.onRename = null
    expect(await readFile(recordFile, 'utf8')).toBe(recordBefore)
    const to = stableNodePath(process.execPath)
    // What a crash leaves: a launcher that already runs a Node that is there.
    expect(await readFile(launcher('openclaw'), 'utf8')).toContain(to)

    // A new process: no memory of the failed attempt.
    vi.resetModules()
    const fresh = await import('../runtimeFolder')
    expect(fresh.ownedRuntimeLaunch('openclaw', env)?.command).toBe(to)
    expect(fresh.readRuntimeInstall('openclaw', env)?.interpreter?.path).toBe(to)
  })

  it('calls the move off when another process changes the record meanwhile', async () => {
    const old = fakeNode('old/bin/node')
    const next = fakeNode('new/bin/node')
    const { recordFile, launcher } = installOn('openclaw', old, 'v24.15.0')
    const launcherBefore = await readFile(launcher('openclaw'), 'utf8')
    await unlink(old)
    // While the launcher is being renamed, an install commits elsewhere.
    const theirs = (await readFile(recordFile, 'utf8')).replace('"v1"', '"v2"')
    let landed = false
    disk.onRename = (dest) => {
      if (dest === launcher('openclaw') && !landed) {
        landed = true
        writeFileSync(recordFile, theirs)
      }
      return undefined
    }

    expect(repointRuntimeNode('openclaw', env, { execPath: next, version: 'v24.15.0' })).toBeNull()
    expect(await readFile(recordFile, 'utf8')).toBe(theirs)
    expect(await readFile(launcher('openclaw'), 'utf8')).toBe(launcherBefore)
    expect(logs.warn[0]?.[0]).toMatchObject({ error: expect.stringMatching(/changed/) })
  })

  it('keeps a launcher another process put in place while it puts its own back', async () => {
    const old = fakeNode('old/bin/node')
    const next = fakeNode('new/bin/node')
    const { recordFile, launcher } = installOn('openclaw', old, 'v24.15.0', [
      'openclaw',
      'openclaw-cli',
    ])
    const cliBefore = await readFile(launcher('openclaw-cli'), 'utf8')
    await unlink(old)
    // After the first launcher is moved, an install elsewhere replaces it and
    // the record, before the second launcher's rename.
    const theirsRecord = (await readFile(recordFile, 'utf8')).replace('"v1"', '"v2"')
    const theirsLauncher = '#!/bin/sh\n# theirs\n'
    let landed = false
    disk.onRename = (dest) => {
      // Once: the rollback's own renames must not plant theirs again.
      if (dest === launcher('openclaw-cli') && !landed) {
        landed = true
        writeFileSync(launcher('openclaw'), theirsLauncher)
        writeFileSync(recordFile, theirsRecord)
      }
      return undefined
    }

    expect(repointRuntimeNode('openclaw', env, { execPath: next, version: 'v24.15.0' })).toBeNull()
    expect(await readFile(recordFile, 'utf8')).toBe(theirsRecord)
    expect(await readFile(launcher('openclaw'), 'utf8')).toBe(theirsLauncher)
    expect(await readFile(launcher('openclaw-cli'), 'utf8')).toBe(cliBefore)
  })

  it('does not try again on every lookup after a failure', async () => {
    const old = fakeNode('old/bin/node')
    const next = fakeNode('new/bin/node')
    const { launcher } = installOn('openclaw', old, 'v24.15.0')
    await unlink(old)
    let renames = 0
    disk.onRename = (dest) => {
      renames++
      return dest === launcher('openclaw') ? 'fail' : undefined
    }
    const opts = { execPath: next, version: 'v24.15.0' }
    expect(repointRuntimeNode('openclaw', env, opts)).toBeNull()
    const after = renames
    expect(repointRuntimeNode('openclaw', env, opts)).toBeNull()
    expect(renames).toBe(after)
    expect(logs.warn).toHaveLength(1)
  })
})
