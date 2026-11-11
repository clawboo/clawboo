// The runtimes folder: where Clawboo installs runtimes instead of npm's or pip's
// global folders. It must stay apart from the data and work folders, must be
// closed to other users' writes before anything in it runs, and switches an
// install only through its pointer file, so a failed update leaves the current
// install as it was.

import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, realpathSync, statSync, writeFileSync } from 'node:fs'
import { chmod, mkdtemp, readFile, rm, symlink, unlink, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import {
  INSTALL_RECORD_FILE,
  INSTALL_UMASK,
  commitRuntimeInstall,
  currentInstallFolder,
  launcherFileName,
  launcherScript,
  markInstallInUse,
  newInstallFolder,
  ownedRuntimeBin,
  ownedRuntimeLaunch,
  ownedRuntimeProblem,
  readRuntimeInstall,
  removeRuntimeInstall,
  runtimeInstallDir,
  runtimeInstallRoot,
  runtimesDirRefusal,
  withInstallUmask,
} from '../runtimeFolder'

const isWindows = process.platform === 'win32'
const isRoot = process.getuid?.() === 0

let base: string
let env: NodeJS.ProcessEnv

beforeEach(async () => {
  base = realpathSync.native(await mkdtemp(path.join(os.tmpdir(), 'clawboo-runtimes-')))
  env = {
    HOME: base,
    CLAWBOO_HOME: path.join(base, 'data'),
    CLAWBOO_WORK_DIR: path.join(base, 'work'),
    CLAWBOO_RUNTIMES_DIR: path.join(base, 'runtimes'),
  }
})

afterEach(async () => {
  await rm(base, { recursive: true, force: true })
})

/** A stand-in "interpreter": a script that prints its arguments, one per line. */
function fakeInterpreter(): { command: string; script: string } {
  const dir = path.join(base, 'interp')
  mkdirSync(dir, { recursive: true })
  const script = path.join(dir, 'entry.js')
  writeFileSync(script, 'console.log(process.argv.slice(2).join("\\n"))\n')
  return { command: process.execPath, script }
}

describe('runtimeInstallRoot / runtimeInstallDir', () => {
  it('resolves CLAWBOO_RUNTIMES_DIR and puts each runtime in a folder of its own', () => {
    expect(runtimeInstallRoot(env)).toBe(path.join(base, 'runtimes'))
    expect(runtimeInstallDir('openclaw', env)).toBe(path.join(base, 'runtimes', 'openclaw'))
  })

  it('refuses an id that is not one plain path segment', () => {
    for (const bad of ['', '..', '../x', 'a/b', 'A', '.hidden', 'x'.repeat(41)]) {
      expect(() => runtimeInstallDir(bad, env)).toThrow(/not a runtime id/)
    }
  })

  it('has no side effects', () => {
    runtimeInstallDir('codex', env)
    expect(existsSync(path.join(base, 'runtimes'))).toBe(false)
  })
})

describe('runtimesDirRefusal', () => {
  it('accepts a folder of its own, made or not', () => {
    expect(runtimesDirRefusal(env)).toBeNull()
    newInstallFolder('codex', 'one', env)
    expect(runtimesDirRefusal(env)).toBeNull()
  })

  it('refuses the data folder, a folder inside it, and one that contains it', () => {
    for (const dir of [env.CLAWBOO_HOME!, path.join(env.CLAWBOO_HOME!, 'runtimes'), base]) {
      expect(runtimesDirRefusal({ ...env, CLAWBOO_RUNTIMES_DIR: dir })).toMatch(/data folder/)
    }
  })

  it('refuses the work folder and a folder inside it, where agents write', () => {
    for (const dir of [env.CLAWBOO_WORK_DIR!, path.join(env.CLAWBOO_WORK_DIR!, 'r')]) {
      expect(runtimesDirRefusal({ ...env, CLAWBOO_RUNTIMES_DIR: dir })).toMatch(/work folder/)
    }
  })

  it('sees through a link that points into the data folder', async () => {
    mkdirSync(path.join(env.CLAWBOO_HOME!, 'inner'), { recursive: true })
    const link = path.join(base, 'innocent')
    await symlink(path.join(env.CLAWBOO_HOME!, 'inner'), link, 'dir')
    expect(runtimesDirRefusal({ ...env, CLAWBOO_RUNTIMES_DIR: link })).toMatch(/data folder/)
  })

  it.skipIf(isWindows || isRoot)('refuses a folder others can write to', async () => {
    newInstallFolder('codex', 'one', env)
    await chmod(path.join(base, 'runtimes'), 0o777)
    expect(runtimesDirRefusal(env)).toMatch(/chmod go-w/)
  })

  it.skipIf(isWindows)('refuses a bin/ that is a link', async () => {
    mkdirSync(path.join(base, 'runtimes'), { recursive: true })
    mkdirSync(path.join(base, 'elsewhere'))
    await symlink(path.join(base, 'elsewhere'), path.join(base, 'runtimes', 'bin'), 'dir')
    expect(runtimesDirRefusal(env)).toMatch(/is a link/)
  })
})

describe('newInstallFolder', () => {
  it.skipIf(isWindows)('makes the folders 0755 and closed to writes from others', () => {
    const umask = process.umask(0o002) // a group-writable default, as on many Linux hosts
    try {
      const dir = newInstallFolder('openclaw', 'first', env)
      for (const d of [path.join(base, 'runtimes'), path.join(base, 'runtimes', 'bin'), dir]) {
        expect(statSync(d).mode & 0o777).toBe(0o755)
      }
    } finally {
      process.umask(umask)
    }
  })

  it('writes the README once and never reuses a folder', () => {
    const a = newInstallFolder('openclaw', 'same', env)
    const b = newInstallFolder('openclaw', 'same', env)
    expect(a).not.toBe(b)
    expect(path.basename(b)).toBe('same-2')
    expect(existsSync(path.join(base, 'runtimes', 'README.txt'))).toBe(true)
  })

  it('refuses a label that is not a plain name', () => {
    for (const bad of ['../x', '.hidden', 'a/b', INSTALL_RECORD_FILE]) {
      expect(() => newInstallFolder('openclaw', bad, env)).toThrow(/install label/)
    }
  })

  it('makes nothing when the folder is refused', () => {
    const inData = { ...env, CLAWBOO_RUNTIMES_DIR: path.join(env.CLAWBOO_HOME!, 'r') }
    expect(() => newInstallFolder('openclaw', 'x', inData)).toThrow(/data folder/)
    expect(existsSync(path.join(env.CLAWBOO_HOME!, 'r'))).toBe(false)
  })
})

describe('commitRuntimeInstall and the lookups', () => {
  it('writes the pointer and a launcher that runs the recorded command', async () => {
    const { command, script } = fakeInterpreter()
    const folder = newInstallFolder('openclaw', 'v1', env)
    const { record, pruned } = commitRuntimeInstall(
      'openclaw',
      {
        folder,
        version: '2026.9.37',
        source: 'openclaw@~2026.9',
        interpreter: { path: command, version: process.version },
        launchers: { openclaw: { command, args: [script] } },
      },
      env,
    )
    await pruned
    expect(record.folder).toBe('v1')
    expect(readRuntimeInstall('openclaw', env)).toEqual(record)

    const launch = ownedRuntimeLaunch('openclaw', env)
    expect(launch).toMatchObject({ id: 'openclaw', command, args: [script] })
    expect(launch?.launcher).toBe(path.join(base, 'runtimes', 'bin', launcherFileName('openclaw')))
    expect(ownedRuntimeBin('openclaw', env)).toBe(launch?.launcher)
    expect(ownedRuntimeBin('codex', env)).toBeNull()

    if (!isWindows) {
      expect(statSync(launch!.launcher).mode & 0o777).toBe(0o755)
      const out = execFileSync(launch!.launcher, ['gateway', "it's here", '$HOME'], {
        encoding: 'utf8',
      })
      expect(out.trim().split('\n')).toEqual(['gateway', "it's here", '$HOME'])
    }
  })

  it('stops offering a launcher whose interpreter or script has gone', async () => {
    const { command, script } = fakeInterpreter()
    const folder = newInstallFolder('codex', 'v1', env)
    const gone = path.join(base, 'gone-node')
    await writeFile(gone, '#!/bin/sh\n', { mode: 0o755 })
    commitRuntimeInstall(
      'codex',
      {
        folder,
        version: '0.1.0',
        source: '@openai/codex@0',
        launchers: { codex: { command: gone, args: [script] } },
      },
      env,
    )
    expect(ownedRuntimeBin('codex', env)).not.toBeNull()
    await unlink(gone)
    expect(ownedRuntimeBin('codex', env)).toBeNull()

    const again = newInstallFolder('codex', 'v2', env)
    commitRuntimeInstall(
      'codex',
      {
        folder: again,
        version: '0.1.1',
        source: '@openai/codex@0',
        launchers: { codex: { command, args: [script] } },
      },
      env,
    )
    expect(ownedRuntimeBin('codex', env)).not.toBeNull()
    await unlink(script)
    expect(ownedRuntimeBin('codex', env)).toBeNull()
  })

  it.skipIf(isWindows || isRoot)('never offers a launcher others can write to', async () => {
    const { command, script } = fakeInterpreter()
    const folder = newInstallFolder('codex', 'v1', env)
    commitRuntimeInstall(
      'codex',
      { folder, version: null, source: 'x', launchers: { codex: { command, args: [script] } } },
      env,
    )
    await chmod(path.join(base, 'runtimes', 'bin', 'codex'), 0o777)
    expect(ownedRuntimeBin('codex', env)).toBeNull()
  })

  it('offers nothing from a folder that is refused', async () => {
    const { command, script } = fakeInterpreter()
    const folder = newInstallFolder('codex', 'v1', env)
    commitRuntimeInstall(
      'codex',
      { folder, version: null, source: 'x', launchers: { codex: { command, args: [script] } } },
      env,
    )
    // The same folder, now named as the work folder: agents could change it.
    expect(
      ownedRuntimeBin('codex', { ...env, CLAWBOO_WORK_DIR: path.join(base, 'runtimes') }),
    ).toBeNull()
  })

  it('switches launchers with the pointer and keeps only the current and previous installs', async () => {
    const { command, script } = fakeInterpreter()
    const commit = (
      label: string,
      launchers: Record<string, { command: string; args: string[] }>,
    ) =>
      commitRuntimeInstall(
        'hermes',
        { folder: newInstallFolder('hermes', label, env), version: label, source: 'x', launchers },
        env,
      ).pruned
    await commit('v1', { hermes: { command, args: [script] }, 'hermes-old': { command, args: [] } })
    await commit('v2', { hermes: { command, args: [script] } })
    await commit('v3', { hermes: { command, args: [script] } })

    const dir = path.join(base, 'runtimes', 'hermes')
    expect(existsSync(path.join(dir, 'v1'))).toBe(false)
    expect(existsSync(path.join(dir, 'v2'))).toBe(true)
    expect(existsSync(path.join(dir, 'v3'))).toBe(true)
    expect(readRuntimeInstall('hermes', env)?.folder).toBe('v3')
    expect(existsSync(path.join(base, 'runtimes', 'bin', launcherFileName('hermes-old')))).toBe(
      false,
    )
  })

  it('refuses to point at a folder that is not one of its installs', () => {
    const outside = path.join(base, 'outside')
    mkdirSync(outside)
    newInstallFolder('codex', 'v1', env)
    expect(() =>
      commitRuntimeInstall(
        'codex',
        { folder: outside, version: null, source: 'x', launchers: {} },
        env,
      ),
    ).toThrow(/not an install folder/)
    const other = newInstallFolder('openclaw', 'v1', env)
    expect(() =>
      commitRuntimeInstall(
        'codex',
        { folder: other, version: null, source: 'x', launchers: {} },
        env,
      ),
    ).toThrow(/not an install folder/)
  })

  it('reads a damaged pointer as no install', async () => {
    newInstallFolder('codex', 'v1', env)
    await writeFile(path.join(base, 'runtimes', 'codex', INSTALL_RECORD_FILE), '{nope')
    expect(readRuntimeInstall('codex', env)).toBeNull()
    expect(ownedRuntimeBin('codex', env)).toBeNull()
  })
})

describe('sealing and trust', () => {
  /** Commit a codex install whose command is a script inside the install. */
  function commitInside(): { folder: string; script: string } {
    const folder = newInstallFolder('codex', 'v1', env)
    const script = path.join(folder, 'node_modules', 'codex', 'bin', 'codex.js')
    mkdirSync(path.dirname(script), { recursive: true })
    writeFileSync(script, 'console.log("hi")\n')
    commitRuntimeInstall(
      'codex',
      {
        folder,
        version: '1',
        source: 'x',
        launchers: { codex: { command: process.execPath, args: [script] } },
      },
      env,
    )
    return { folder, script }
  }

  it.skipIf(isWindows)(
    'seals an install made under any umask: others read, nobody else writes',
    () => {
      for (const mask of [0o000, 0o002, 0o077]) {
        const old = process.umask(mask)
        let folder: string
        let script: string
        try {
          ;({ folder, script } = commitInside())
        } finally {
          process.umask(old)
        }
        expect(statSync(folder).mode & 0o777).toBe(0o755)
        expect(statSync(path.dirname(script)).mode & 0o777).toBe(0o755)
        expect(statSync(script).mode & 0o777).toBe(0o644)
        expect(ownedRuntimeBin('codex', env)).not.toBeNull()
        removeRuntimeInstall('codex', env)
      }
    },
  )

  it.skipIf(isWindows || isRoot)(
    'stops trusting an install once something in its path is opened up',
    async () => {
      const { folder, script } = commitInside()
      const record = path.join(base, 'runtimes', 'codex', INSTALL_RECORD_FILE)
      for (const target of [record, folder, path.dirname(script), script]) {
        const before = statSync(target).mode & 0o777
        await chmod(target, before | 0o022)
        expect(ownedRuntimeBin('codex', env), target).toBeNull()
        expect(currentInstallFolder('codex', env), target).toBe(
          target === script || target === path.dirname(script) ? folder : null,
        )
        await chmod(target, before)
        expect(ownedRuntimeBin('codex', env), target).not.toBeNull()
      }
    },
  )

  it.skipIf(isWindows)('never runs a script reached through a link out of the folder', async () => {
    const { script } = commitInside()
    const outside = path.join(base, 'outside.js')
    await writeFile(outside, '// someone else\n')
    await chmod(outside, 0o666)
    await rm(script)
    await symlink(outside, script)
    expect(ownedRuntimeBin('codex', env)).toBeNull()
  })
})

describe('the install umask', () => {
  it.skipIf(isWindows)('installers start under 022 and the umask comes back after', () => {
    const outer = process.umask(0o077)
    try {
      let inside = -1
      withInstallUmask(() => {
        inside = process.umask(0o022) // reads it (and sets the same value back)
      })
      expect(inside).toBe(INSTALL_UMASK)
      expect(process.umask(0o077)).toBe(0o077)
    } finally {
      process.umask(outer)
    }
  })

  it.skipIf(isWindows)(
    'refuses to make current an install with a link leading out of it',
    async () => {
      const folder = newInstallFolder('codex', 'v1', env)
      await symlink(path.join(base, 'data'), path.join(folder, 'escape'))
      expect(() =>
        commitRuntimeInstall('codex', { folder, version: null, source: 'x', launchers: {} }, env),
      ).toThrow(/links outside the install/)
      expect(readRuntimeInstall('codex', env)).toBeNull()
    },
  )

  it.skipIf(isWindows)('keeps a link that stays inside the install', async () => {
    const folder = newInstallFolder('codex', 'v1', env)
    mkdirSync(path.join(folder, 'lib'))
    await symlink('lib', path.join(folder, 'lib64'))
    commitRuntimeInstall('codex', { folder, version: null, source: 'x', launchers: {} }, env)
    expect(readRuntimeInstall('codex', env)?.folder).toBe('v1')
  })
})

describe('review fixes', () => {
  const commitCodex = (label: string, command: string, args: string[]) =>
    commitRuntimeInstall(
      'codex',
      {
        folder: newInstallFolder('codex', label, env),
        version: label,
        source: 'x',
        launchers: { codex: { command, args } },
      },
      env,
    )

  it('keeps an install a live process was marked as running, through any number of updates', async () => {
    const { command, script } = fakeInterpreter()
    await commitCodex('v1', command, [script]).pruned
    markInstallInUse('codex', process.pid, env) // this test process "runs" v1
    markInstallInUse('codex', 2 ** 22 + 12345, env) // a pid that is not running
    await commitCodex('v2', command, [script]).pruned
    await commitCodex('v3', command, [script]).pruned
    await commitCodex('v4', command, [script]).pruned
    const dir = path.join(base, 'runtimes', 'codex')
    expect(existsSync(path.join(dir, 'v1'))).toBe(true)
    expect(existsSync(path.join(dir, 'v2'))).toBe(false)
    expect(existsSync(path.join(dir, `.in-use-${2 ** 22 + 12345}`))).toBe(false)
  })

  it('switches nothing when a launcher cannot be put in place', async () => {
    const { command, script } = fakeInterpreter()
    await commitCodex('v1', command, [script]).pruned
    const before = await readFile(path.join(base, 'runtimes', 'codex', INSTALL_RECORD_FILE), 'utf8')
    const codexLauncher = path.join(base, 'runtimes', 'bin', launcherFileName('codex'))
    const launcherBefore = await readFile(codexLauncher, 'utf8')
    // A folder where the launcher goes: the rename over it fails.
    const launcher = path.join(base, 'runtimes', 'bin', launcherFileName('other'))
    mkdirSync(path.join(launcher, 'inside'), { recursive: true })
    expect(() =>
      commitRuntimeInstall(
        'codex',
        {
          folder: newInstallFolder('codex', 'v2', env),
          version: 'v2',
          source: 'x',
          launchers: { codex: { command, args: [script] }, other: { command, args: [script] } },
        },
        env,
      ),
    ).toThrow()
    expect(await readFile(path.join(base, 'runtimes', 'codex', INSTALL_RECORD_FILE), 'utf8')).toBe(
      before,
    )
    expect(ownedRuntimeLaunch('codex', env)?.record.folder).toBe('v1')
    // The launcher replaced before the failure is put back too.
    expect(await readFile(codexLauncher, 'utf8')).toBe(launcherBefore)
  })

  it('says why its own copy cannot be used once the Node it runs on is gone', async () => {
    const { script } = fakeInterpreter()
    const node = path.join(base, 'old-node')
    await writeFile(node, '#!/bin/sh\n', { mode: 0o755 })
    await commitCodex('v1', node, [script]).pruned
    expect(ownedRuntimeProblem('codex', env)).toBeNull()
    await unlink(node)
    expect(ownedRuntimeBin('codex', env)).toBeNull()
    expect(ownedRuntimeProblem('codex', env)).toMatch(/runs on .*old-node.*Install codex again/)
    expect(ownedRuntimeProblem('openclaw', env)).toBeNull() // nothing on record
  })

  it.skipIf(isWindows || isRoot)(
    'refuses a runtimes folder under a folder anyone may rename in',
    async () => {
      const open = path.join(base, 'open')
      mkdirSync(open)
      await chmod(open, 0o777)
      expect(runtimesDirRefusal({ ...env, CLAWBOO_RUNTIMES_DIR: path.join(open, 'r') })).toMatch(
        /lets anyone rename/,
      )
      // With the sticky bit (like /tmp) it is fine, until a node_modules there is not ours.
      await chmod(open, 0o1777)
      expect(runtimesDirRefusal({ ...env, CLAWBOO_RUNTIMES_DIR: path.join(open, 'r') })).toBeNull()
      await symlink(path.join(base, 'data'), path.join(open, 'node_modules'))
      expect(runtimesDirRefusal({ ...env, CLAWBOO_RUNTIMES_DIR: path.join(open, 'r') })).toMatch(
        /Node.js could load modules from it/,
      )
    },
  )

  it.skipIf(isWindows)('seals away setuid and setgid bits', async () => {
    const folder = newInstallFolder('codex', 'v1', env)
    const tool = path.join(folder, 'tool')
    await writeFile(tool, '#!/bin/sh\n')
    await chmod(tool, 0o6755)
    commitRuntimeInstall('codex', { folder, version: null, source: 'x', launchers: {} }, env)
    expect(statSync(tool).mode & 0o7777).toBe(0o755)
  })

  it('keeps a version with a line break out of the launcher', () => {
    const s = launcherScript({ command: '/n', args: [] }, 'for x 1.0\nrm -rf ~', 'linux')
    expect(s.split('\n')).toHaveLength(4)
    expect(launcherScript({ command: 'C:\\n.exe', args: [] }, 'a & calc', 'win32')).not.toContain(
      '&',
    )
  })
})

describe('launcherScript', () => {
  it('quotes POSIX paths so spaces, quotes and $ reach the command unchanged', () => {
    const s = launcherScript(
      { command: "/a b/it's/node", args: ['/x/$HOME/e.mjs'] },
      'note',
      'darwin',
    )
    expect(s).toContain(`exec '/a b/it'\\''s/node' '/x/$HOME/e.mjs' "$@"`)
    expect(s.startsWith('#!/bin/sh\n')).toBe(true)
  })

  it('writes a .cmd that doubles a percent sign', () => {
    const s = launcherScript(
      { command: 'C:\\Program Files\\nodejs\\node.exe', args: ['C:\\Users\\a%b\\e.mjs'] },
      'note',
      'win32',
    )
    expect(s).toContain('"C:\\Program Files\\nodejs\\node.exe" "C:\\Users\\a%%b\\e.mjs" %*')
    expect(s.startsWith('@echo off\r\n')).toBe(true)
  })

  it('keeps the README in the root', async () => {
    newInstallFolder('codex', undefined, env)
    expect(await readFile(path.join(base, 'runtimes', 'README.txt'), 'utf8')).toMatch(
      /CLAWBOO_RUNTIMES_DIR/,
    )
  })
})
