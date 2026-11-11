// Installing an npm runtime into Clawboo's runtimes folder: npm runs on this
// server's Node into a fresh folder of its own, never with `-g`; success makes
// that folder current with launchers on the same Node, and anything else
// removes it and leaves the current install as it was. npm itself is a fake
// child here; the folders are temp dirs.

import { EventEmitter } from 'node:events'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { PassThrough } from 'node:stream'

import type { ChildProcess, spawn } from 'node:child_process'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { ownedRuntimeLaunch, readRuntimeInstall } from '../../runtimeFolder'
import {
  npmChildEnv,
  npmInstallArgs,
  npmInvocation,
  npmPackageName,
  readInstalledPackage,
  runNpmRuntimeInstall,
  stableNodePath,
} from '../npmRuntimeInstall'

describe('npmPackageName', () => {
  it('takes the name off a spec, scoped or not', () => {
    expect(npmPackageName('openclaw@~2026.9')).toBe('openclaw')
    expect(npmPackageName('@openai/codex@0')).toBe('@openai/codex')
    expect(npmPackageName('@anthropic-ai/claude-agent-sdk@0.3')).toBe(
      '@anthropic-ai/claude-agent-sdk',
    )
    expect(npmPackageName('plain')).toBe('plain')
  })
})

describe('npmInvocation', () => {
  const none = { exists: () => false, findOnPath: () => null, realpath: () => null }

  it("runs the npm beside this Node with this Node, so npm sees this Node's version", () => {
    const cli = '/opt/node-24/lib/node_modules/npm/bin/npm-cli.js'
    const inv = npmInvocation('/opt/node-24/bin/node', 'linux', {
      ...none,
      exists: (p) => p === cli,
    })
    expect(inv).toEqual({ command: '/opt/node-24/bin/node', prefixArgs: [cli], cmdShim: false })
  })

  it('looks for npm-cli.js beside node.exe on Windows', () => {
    const seen: string[] = []
    npmInvocation('C:\\nodejs\\node.exe', 'win32', {
      ...none,
      exists: (p) => (seen.push(p), false),
    })
    expect(seen[0]).toBe('C:\\nodejs\\node_modules\\npm\\bin\\npm-cli.js')
  })

  it("finds Homebrew's npm under the prefix, not the keg", () => {
    const node = '/opt/homebrew/Cellar/node/24.22.1/bin/node'
    const cli = '/opt/homebrew/lib/node_modules/npm/bin/npm-cli.js'
    expect(npmInvocation(node, 'darwin', { ...none, exists: (p) => p === cli })).toEqual({
      command: node,
      prefixArgs: [cli],
      cmdShim: false,
    })
  })

  it("runs an npm on PATH by this Node, from that npm's own npm-cli.js", () => {
    const cli = '/usr/lib/node_modules/npm/bin/npm-cli.js'
    const inv = npmInvocation('/srv/node/bin/node', 'linux', {
      ...none,
      findOnPath: () => '/usr/bin/npm',
      realpath: (p) => (p === '/usr/bin/npm' ? cli : null),
    })
    expect(inv).toEqual({ command: '/srv/node/bin/node', prefixArgs: [cli], cmdShim: false })
  })

  it("runs a Windows npm.cmd's own npm-cli.js by this Node when it is there", () => {
    const cli = 'C:\\Program Files\\nodejs\\node_modules\\npm\\bin\\npm-cli.js'
    const inv = npmInvocation('C:\\app\\node.exe', 'win32', {
      ...none,
      findOnPath: () => 'C:\\Program Files\\nodejs\\npm.cmd',
      exists: (p) => p === cli,
    })
    expect(inv).toEqual({ command: 'C:\\app\\node.exe', prefixArgs: [cli], cmdShim: false })
  })

  it('falls back to npm on PATH as it is, through cmd.exe quoting on Windows, and is null with none', () => {
    expect(
      npmInvocation('/x/bin/node', 'linux', { ...none, findOnPath: () => '/usr/bin/npm' }),
    ).toEqual({ command: '/usr/bin/npm', prefixArgs: [], cmdShim: false })
    expect(
      npmInvocation('C:\\x\\node.exe', 'win32', { ...none, findOnPath: () => 'C:\\n\\npm.cmd' }),
    ).toEqual({ command: 'C:\\n\\npm.cmd', prefixArgs: [], cmdShim: true })
    expect(npmInvocation('/x/bin/node', 'linux', none)).toBeNull()
  })
})

describe('stableNodePath', () => {
  it("records Homebrew's opt link instead of a keg an upgrade deletes", () => {
    const keg = '/opt/homebrew/Cellar/node@24/24.22.1/bin/node'
    const opt = '/opt/homebrew/opt/node@24/bin/node'
    const realpath = (p: string) => (p === opt || p === keg ? keg : null)
    expect(stableNodePath(keg, { realpath })).toBe(opt)
  })

  it('keeps the keg when the opt link leads elsewhere, and any other Node as it is', () => {
    const keg = '/opt/homebrew/Cellar/node/24.2.0/bin/node'
    expect(stableNodePath(keg, { realpath: (p) => (p === keg ? keg : '/other') })).toBe(keg)
    expect(stableNodePath('/home/u/.nvm/versions/node/v24.22.1/bin/node')).toBe(
      '/home/u/.nvm/versions/node/v24.22.1/bin/node',
    )
  })
})

describe('npmChildEnv', () => {
  it('drops settings that would make the install global and puts this Node first on PATH', () => {
    const env = npmChildEnv(
      {
        PATH: '/usr/bin',
        npm_config_global: 'true',
        NPM_CONFIG_LOCATION: 'global',
        npm_config_prefix: '/usr/local',
        npm_config_registry: 'https://registry.example',
      },
      '/opt/node-24/bin/node',
    )
    expect(env['npm_config_global']).toBeUndefined()
    expect(env['NPM_CONFIG_LOCATION']).toBeUndefined()
    expect(env['npm_config_prefix']).toBeUndefined()
    expect(env['npm_config_registry']).toBe('https://registry.example')
    expect(env['PATH']).toBe(['/opt/node-24/bin', '/usr/bin'].join(path.delimiter))
  })
})

describe('npmInstallArgs', () => {
  it('installs into the folder, never globally, with optional dependencies', () => {
    const args = npmInstallArgs('/r/codex/x', '@openai/codex@0')
    expect(args).toEqual(
      expect.arrayContaining(['install', '--prefix', '/r/codex/x', '--include=optional']),
    )
    expect(args).not.toContain('-g')
    expect(args).not.toContain('--global')
    // A user config with global=true cannot turn it global either.
    expect(args).toEqual(expect.arrayContaining(['--no-global', '--location=project']))
    expect(args[args.length - 1]).toBe('@openai/codex@0')
  })
})

describe('readInstalledPackage', () => {
  it('reads a single-command package whose bin is a string', () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'clawboo-npm-pkg-'))
    try {
      const pkg = path.join(dir, 'node_modules', 'tool')
      mkdirSync(pkg, { recursive: true })
      writeFileSync(
        path.join(pkg, 'package.json'),
        JSON.stringify({ version: '2.0.0', bin: 'cli.js' }),
      )
      expect(readInstalledPackage(dir, 'tool')).toEqual({
        version: '2.0.0',
        bin: { tool: 'cli.js' },
        dir: pkg,
      })
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('runNpmRuntimeInstall', () => {
  let base: string
  let env: NodeJS.ProcessEnv
  let calls: { command: string; args: string[] }[]
  let children: (ChildProcess & { finish: (code: number | null, signal?: string) => void })[]

  const fakeSpawn = ((command: string, args: string[]) => {
    calls.push({ command, args })
    const child = new EventEmitter() as ChildProcess & {
      finish: (code: number | null, signal?: string) => void
    }
    Object.assign(child, { stdout: new PassThrough(), stderr: new PassThrough() })
    child.finish = (code, signal) => child.emit('close', code, signal ?? null)
    children.push(child)
    return child
  }) as unknown as typeof spawn

  const prefixOf = (args: string[]): string => args[args.indexOf('--prefix') + 1]!
  const putPackage = (prefix: string, version: string): string => {
    const dir = path.join(prefix, 'node_modules', '@openai', 'codex')
    mkdirSync(path.join(dir, 'bin'), { recursive: true })
    writeFileSync(
      path.join(dir, 'package.json'),
      JSON.stringify({ version, bin: { codex: 'bin/codex.js' } }),
    )
    writeFileSync(path.join(dir, 'bin', 'codex.js'), '// codex\n')
    return path.join(dir, 'bin', 'codex.js')
  }
  const RT = { id: 'codex', spec: '@openai/codex@0', bins: ['codex'] }
  const INV = { command: process.execPath, prefixArgs: ['/npm-cli.js'], cmdShim: false }

  beforeEach(() => {
    base = realpathSync.native(mkdtempSync(path.join(os.tmpdir(), 'clawboo-npm-run-')))
    env = {
      PATH: process.env['PATH'],
      HOME: base,
      CLAWBOO_HOME: path.join(base, 'data'),
      CLAWBOO_RUNTIMES_DIR: path.join(base, 'runtimes'),
    }
    calls = []
    children = []
  })
  afterEach(() => {
    rmSync(base, { recursive: true, force: true })
  })

  it('installs into a fresh folder and makes it current, with a launcher on this Node', async () => {
    const run = runNpmRuntimeInstall(RT, { env, spawnFn: fakeSpawn, invocation: INV })
    const prefix = prefixOf(calls[0]!.args)
    expect(path.dirname(prefix)).toBe(path.join(base, 'runtimes', 'codex'))
    const script = putPackage(prefix, '0.167.1')
    children[0]!.finish(0)
    const result = await run.result
    expect(result).toMatchObject({ ok: true, version: '0.167.1' })
    expect(readRuntimeInstall('codex', env)).toMatchObject({
      version: '0.167.1',
      source: '@openai/codex@0',
      folder: path.basename(prefix),
      interpreter: { path: stableNodePath(process.execPath) },
      launchers: { codex: { command: stableNodePath(process.execPath), args: [script] } },
    })
    expect(ownedRuntimeLaunch('codex', env)?.command).toBe(stableNodePath(process.execPath))
  })

  it('an update that fails leaves the current install as it was, and removes its own folder', async () => {
    const first = runNpmRuntimeInstall(RT, { env, spawnFn: fakeSpawn, invocation: INV })
    const firstPrefix = prefixOf(calls[0]!.args)
    putPackage(firstPrefix, '1.0.0')
    children[0]!.finish(0)
    await first.result

    const second = runNpmRuntimeInstall(RT, { env, spawnFn: fakeSpawn, invocation: INV })
    const secondPrefix = prefixOf(calls[1]!.args)
    expect(secondPrefix).not.toBe(firstPrefix)
    ;(children[1]!.stderr as PassThrough).write(
      'npm error code ETARGET\nnpm error notarget No matching version\n',
    )
    children[1]!.finish(1)
    const result = await second.result
    expect(result).toMatchObject({ ok: false, code: 'ETARGET' })
    expect(readRuntimeInstall('codex', env)?.version).toBe('1.0.0')
    expect(ownedRuntimeLaunch('codex', env)).not.toBeNull()
    await expect.poll(() => existsSync(secondPrefix)).toBe(false)
  })

  it('a stopped install says so and removes its folder', async () => {
    const run = runNpmRuntimeInstall(RT, { env, spawnFn: fakeSpawn, invocation: INV })
    const prefix = prefixOf(calls[0]!.args)
    children[0]!.finish(null, 'SIGTERM')
    expect(await run.result).toMatchObject({ ok: false, code: 'STOPPED' })
    await expect.poll(() => existsSync(prefix)).toBe(false)
  })

  it('refuses a package without the command it should offer', async () => {
    const run = runNpmRuntimeInstall(RT, { env, spawnFn: fakeSpawn, invocation: INV })
    const prefix = prefixOf(calls[0]!.args)
    const dir = path.join(prefix, 'node_modules', '@openai', 'codex')
    mkdirSync(dir, { recursive: true })
    writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ version: '1.0.0' }))
    children[0]!.finish(0)
    expect(await run.result).toMatchObject({ ok: false, code: 'NO_COMMAND' })
    expect(readRuntimeInstall('codex', env)).toBeNull()
  })

  it('runs nothing with no npm, or a refused folder', async () => {
    const none = runNpmRuntimeInstall(RT, { env, spawnFn: fakeSpawn, invocation: null })
    expect(await none.result).toMatchObject({ ok: false, code: 'NPM_MISSING' })
    const inData = { ...env, CLAWBOO_RUNTIMES_DIR: path.join(base, 'data', 'r') }
    const refused = runNpmRuntimeInstall(RT, { env: inData, spawnFn: fakeSpawn, invocation: INV })
    expect(await refused.result).toMatchObject({ ok: false, code: 'RUNTIMES_DIR_REFUSED' })
    expect(calls).toEqual([])
  })

  it('writes a launcher a shell can run', async () => {
    const run = runNpmRuntimeInstall(RT, { env, spawnFn: fakeSpawn, invocation: INV })
    putPackage(prefixOf(calls[0]!.args), '1.0.0')
    children[0]!.finish(0)
    await run.result
    const launcher = ownedRuntimeLaunch('codex', env)!.launcher
    if (process.platform !== 'win32') {
      expect(readFileSync(launcher, 'utf8')).toMatch(/^#!\/bin\/sh\n/)
    }
  })
})
