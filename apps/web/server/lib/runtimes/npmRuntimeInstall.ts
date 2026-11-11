// Installing an npm runtime (OpenClaw, the Claude Agent SDK, Codex) into
// Clawboo's own runtimes folder, instead of `npm install -g`.
//
// A global install writes to npm's global prefix, which fails with EACCES when
// that prefix is root-owned (the old remedy was `sudo`), lands under one nvm
// Node and is stranded when nvm switches to another, and runs the runtime on
// whatever `node` comes first on PATH. Here each install goes into a fresh
// folder of its own (`newInstallFolder`), npm runs on the Node this server runs
// on, and the launchers written on success (`commitRuntimeInstall`) start the
// runtime on that same Node. A failed or stopped install is removed and the
// current one stays as it was, so an update can no longer leave a runtime half
// replaced.

import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync, readFileSync, realpathSync } from 'node:fs'
import path from 'node:path'

import { summarizeNpmFailure } from '../npmFailure'
import { findExecutable } from '../platform'
import { resolveWindowsSpawn } from './winSpawn'
import {
  commitRuntimeInstall,
  discardInstallFolder,
  newInstallFolder,
  runtimesDirRefusal,
  withInstallUmask,
  type RuntimeInstallRecord,
  type RuntimeLauncher,
} from '../runtimeFolder'

/** One npm runtime: where it goes, what to install, and the commands it offers. */
export interface NpmRuntime {
  /** The runtime's folder id under the runtimes folder. */
  id: string
  /** The npm spec to install, such as `openclaw@~2026.9`. */
  spec: string
  /** Commands of the package to put in `bin/`. Empty for a library (the SDK). */
  bins: readonly string[]
}

/** The package name of an npm spec: `@scope/name@range` -> `@scope/name`. */
export function npmPackageName(spec: string): string {
  const at = spec.indexOf('@', spec.startsWith('@') ? 1 : 0)
  return at === -1 ? spec : spec.slice(0, at)
}

export interface NpmInvocation {
  command: string
  /** Arguments before npm's own (npm's CLI script, when run through Node). */
  prefixArgs: string[]
  /** A Windows `npm.cmd` to start through cmd.exe with every argument quoted
   *  (`resolveWindowsSpawn`), since Node will not start a .cmd directly. */
  cmdShim: boolean
}

/** Injectable file-system lookups for {@link npmInvocation}. */
export interface NpmLookup {
  exists?: (p: string) => boolean
  findOnPath?: (name: string) => string | null
  realpath?: (p: string) => string | null
}

const realpathOrNull = (p: string): string | null => {
  try {
    return realpathSync.native(p)
  } catch {
    return null
  }
}

/** A Homebrew keg's Node (`<prefix>/Cellar/<formula>/<version>/bin/node`). */
const HOMEBREW_KEG_NODE = /^(.*)[/\\]Cellar[/\\]([^/\\]+)[/\\][^/\\]+[/\\]bin[/\\]node(\.exe)?$/

/**
 * How to run npm on the Node this server runs on (`execPath`), so npm reads that
 * Node's version when it picks a release whose `engines` admit it, and builds
 * any native part for that Node. In order:
 * - the npm that ships beside that Node (`lib/node_modules/npm` above its
 *   `bin/`, or `node_modules\npm` beside `node.exe`), or Homebrew's, which sits
 *   under the Homebrew prefix rather than the Node's own folder;
 * - the npm on PATH, run by this Node from its own `npm-cli.js`;
 * - failing that, the npm on PATH as it is (on Windows its `npm.cmd`), with this
 *   Node's folder first on PATH (`npmChildEnv`).
 * Null when there is no npm at all.
 */
export function npmInvocation(
  execPath: string = process.execPath,
  platform: NodeJS.Platform = process.platform,
  lookup: NpmLookup = {},
): NpmInvocation | null {
  const exists = lookup.exists ?? existsSync
  const findOnPath = lookup.findOnPath ?? findExecutable
  const realpath = lookup.realpath ?? realpathOrNull
  const p = platform === 'win32' ? path.win32 : path.posix
  const besideBin = (binDir: string): string =>
    platform === 'win32'
      ? p.join(binDir, 'node_modules', 'npm', 'bin', 'npm-cli.js')
      : p.join(binDir, '..', 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js')
  const viaNode = (cli: string): NpmInvocation => ({
    command: execPath,
    prefixArgs: [cli],
    cmdShim: false,
  })

  const candidates = [besideBin(p.dirname(execPath))]
  const keg = HOMEBREW_KEG_NODE.exec(execPath)
  if (keg)
    candidates.push(p.join(keg[1] as string, 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js'))
  for (const cli of candidates) if (exists(cli)) return viaNode(cli)

  const onPath = findOnPath('npm')
  if (!onPath) return null
  const real = realpath(onPath)
  if (real && /npm-cli\.js$/.test(real)) return viaNode(real)
  const near = besideBin(p.dirname(onPath))
  if (exists(near)) return viaNode(near)
  return { command: onPath, prefixArgs: [], cmdShim: platform === 'win32' }
}

/**
 * The path to record for the Node a runtime runs on: `execPath`, except for a
 * Homebrew keg, whose versioned folder an upgrade deletes. There it is the
 * formula's `opt` link (`<prefix>/opt/<formula>/bin/node`) when that link leads
 * to the same Node today, so the runtime keeps working after `brew upgrade` on
 * the same formula (a `node@24` stays on Node 24).
 */
export function stableNodePath(
  execPath: string = process.execPath,
  lookup: Pick<NpmLookup, 'realpath'> = {},
): string {
  const realpath = lookup.realpath ?? realpathOrNull
  const keg = HOMEBREW_KEG_NODE.exec(execPath)
  if (!keg) return execPath
  const sep = execPath.includes('\\') && !execPath.includes('/') ? '\\' : '/'
  const opt = [keg[1], 'opt', keg[2], 'bin', `node${keg[3] ?? ''}`].join(sep)
  const a = realpath(opt)
  const b = realpath(execPath)
  return a !== null && a === b ? opt : execPath
}

/**
 * The environment npm runs in. Variables that would turn the install global
 * (an npm run of Clawboo itself can leave `npm_config_global` or
 * `npm_config_prefix` behind) are dropped, and this Node's folder goes first on
 * PATH so every script npm starts runs on it.
 */
export function npmChildEnv(
  base: NodeJS.ProcessEnv = process.env,
  execPath: string = process.execPath,
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {}
  for (const [k, v] of Object.entries(base)) {
    if (/^npm_config_(global|location|prefix)$/i.test(k)) continue
    env[k] = v
  }
  const pathKey = Object.keys(env).find((k) => k.toUpperCase() === 'PATH') ?? 'PATH'
  env[pathKey] = [path.dirname(execPath), env[pathKey]].filter(Boolean).join(path.delimiter)
  env['npm_config_update_notifier'] = 'false'
  return env
}

/** npm's arguments for an install of `spec` into `folder`. */
export function npmInstallArgs(folder: string, spec: string): string[] {
  return [
    'install',
    '--prefix',
    folder,
    // A user config with `omit=optional` would leave out the Agent SDK's own
    // binary, which is an optional dependency, and Codex's.
    '--include=optional',
    // A user config with `global=true` (or `location=global`) would otherwise
    // put the package under `<folder>/lib/node_modules`.
    '--no-global',
    '--location=project',
    '--no-fund',
    '--no-audit',
    spec,
  ]
}

interface InstalledPackage {
  version: string | null
  bin: Record<string, string>
  dir: string
}

/** The installed package's version and commands, read from its package.json. */
export function readInstalledPackage(folder: string, name: string): InstalledPackage | null {
  const dir = path.join(folder, 'node_modules', ...name.split('/'))
  try {
    const pkg = JSON.parse(readFileSync(path.join(dir, 'package.json'), 'utf8')) as {
      version?: unknown
      bin?: unknown
    }
    const bin: Record<string, string> = {}
    if (typeof pkg.bin === 'string') bin[name.split('/').pop() as string] = pkg.bin
    else if (pkg.bin && typeof pkg.bin === 'object') {
      for (const [k, v] of Object.entries(pkg.bin as Record<string, unknown>)) {
        if (typeof v === 'string') bin[k] = v
      }
    }
    return { version: typeof pkg.version === 'string' ? pkg.version : null, bin, dir }
  } catch {
    return null
  }
}

export type NpmInstallResult =
  | { ok: true; version: string | null; record: RuntimeInstallRecord }
  | { ok: false; code: string; message: string }

export interface NpmInstallRun {
  /** The npm process, or null when the install stopped before starting one. */
  child: ChildProcess | null
  result: Promise<NpmInstallResult>
}

export interface NpmInstallOptions {
  /** Each line npm prints. */
  onLine?: (line: string) => void
  env?: NodeJS.ProcessEnv
  /** Injectable for tests. */
  spawnFn?: typeof spawn
  invocation?: NpmInvocation | null
  execPath?: string
}

/**
 * Install `rt` into a fresh folder under the runtimes folder and, when npm
 * succeeds, make it the current install with launchers that run it on this
 * server's Node. The folder is removed when anything fails.
 */
export function runNpmRuntimeInstall(rt: NpmRuntime, opts: NpmInstallOptions = {}): NpmInstallRun {
  const env = opts.env ?? process.env
  const execPath = opts.execPath ?? process.execPath
  // What the launchers record: this Node, by a path an upgrade keeps.
  const nodePath = stableNodePath(execPath)
  const fail = (code: string, message: string): NpmInstallRun => ({
    child: null,
    result: Promise.resolve({ ok: false, code, message }),
  })

  const refusal = runtimesDirRefusal(env)
  if (refusal) return fail('RUNTIMES_DIR_REFUSED', refusal)
  const npm = opts.invocation !== undefined ? opts.invocation : npmInvocation(execPath)
  if (!npm) {
    return fail('NPM_MISSING', 'npm not found. Install Node.js (which bundles npm) and retry.')
  }

  let folder: string
  try {
    folder = newInstallFolder(rt.id, undefined, env)
  } catch (err) {
    return fail('RUNTIMES_DIR_FAILED', err instanceof Error ? err.message : String(err))
  }

  let child: ChildProcess
  try {
    // Under the install umask, so nothing npm writes is ever writable by others.
    const args = [...npm.prefixArgs, ...npmInstallArgs(folder, rt.spec)]
    const plan = npm.cmdShim
      ? resolveWindowsSpawn({ command: npm.command, args })
      : { command: npm.command, args }
    child = withInstallUmask(() =>
      (opts.spawnFn ?? spawn)(plan.command, plan.args, {
        cwd: folder,
        env: npmChildEnv(env, execPath),
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
        ...(plan.windowsVerbatimArguments ? { windowsVerbatimArguments: true } : {}),
      }),
    )
  } catch (err) {
    void discardInstallFolder(folder)
    return fail('SPAWN_THROW', err instanceof Error ? err.message : String(err))
  }

  let output = ''
  const onChunk = (chunk: Buffer): void => {
    const text = chunk.toString()
    output = (output + text).slice(-20_000)
    for (const line of text.split(/\r?\n/).filter(Boolean)) opts.onLine?.(line)
  }
  child.stdout?.on('data', onChunk)
  child.stderr?.on('data', onChunk)

  const result = new Promise<NpmInstallResult>((resolve) => {
    let settled = false
    const finish = (r: NpmInstallResult): void => {
      if (settled) return
      settled = true
      resolve(r)
    }
    child.on('error', (err) => {
      void discardInstallFolder(folder)
      finish({ ok: false, code: 'SPAWN_ERROR', message: String(err) })
    })
    child.on('close', (code, signal) => {
      if (code !== 0) {
        void discardInstallFolder(folder)
        if (signal) {
          finish({ ok: false, code: 'STOPPED', message: `The install was stopped (${signal}).` })
          return
        }
        const why = summarizeNpmFailure(output)
        const detail = why.detail ? ` ${why.detail}` : ''
        finish({
          ok: false,
          code: why.code ?? `EXIT_${String(code)}`,
          message: `Installation failed with exit code ${String(code)}.${detail}`,
        })
        return
      }
      const name = npmPackageName(rt.spec)
      const pkg = readInstalledPackage(folder, name)
      if (!pkg) {
        void discardInstallFolder(folder)
        finish({
          ok: false,
          code: 'NOT_INSTALLED',
          message: `npm finished, but ${name} is not in ${folder}.`,
        })
        return
      }
      const launchers: Record<string, RuntimeLauncher> = {}
      for (const bin of rt.bins) {
        const rel = pkg.bin[bin]
        const script = rel ? path.resolve(pkg.dir, rel) : null
        if (!script || !existsSync(script)) {
          void discardInstallFolder(folder)
          finish({
            ok: false,
            code: 'NO_COMMAND',
            message: `${name} ${pkg.version ?? ''} has no ${bin} command.`,
          })
          return
        }
        launchers[bin] = { command: nodePath, args: [script] }
      }
      try {
        const { record } = commitRuntimeInstall(
          rt.id,
          {
            folder,
            version: pkg.version,
            source: rt.spec,
            interpreter: { path: nodePath, version: process.version },
            launchers,
          },
          env,
        )
        finish({ ok: true, version: pkg.version, record })
      } catch (err) {
        void discardInstallFolder(folder)
        finish({
          ok: false,
          code: 'COMMIT_FAILED',
          message: err instanceof Error ? err.message : String(err),
        })
      }
    })
  })

  return { child, result }
}
