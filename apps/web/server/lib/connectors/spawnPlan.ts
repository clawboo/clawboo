// The ONE place a connector's spawn is decided.
//
// The consent dialog and the actual spawn read the SAME plan, and that is the
// entire reason this is a function rather than two similar code paths. A dialog
// that shows `npx -y some-server@1.2.3` while the process that runs is
// `C:\Windows\System32\cmd.exe /d /s /c "..."` is asking for consent to
// something other than what happens.
//
// NEVER shell: true. The catalog supplies `args` as an array, and handing that
// array to a shell as a string turns a registry snapshot into arbitrary command
// execution -- an arg containing `& calc.exe` would run. On Windows a `.cmd`
// shim genuinely cannot be spawned directly, so it is routed through cmd.exe by
// `resolveWindowsSpawn`, which escapes each token individually and sets
// windowsVerbatimArguments. That is a different thing from a shell.
//
// A PINNED BROWSER STARTS FROM ITS OWN BIN when that exact version is already
// installed. Through `npx -y`, an `npm exec` process stays resident beside each
// server, costing about as much memory as the server itself, and asks the
// registry for the package manifest on every launch even with a warm cache. The
// copy used is either one installed beside Clawboo or npx's own finished install
// of that exact spec, so the code that runs is what npx would have run. Anything
// else, including any other version, still goes through npx.

import { createHash } from 'node:crypto'
import { closeSync, existsSync, openSync, readFileSync, readSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { findExecutable, isWindows } from '../platform'
import { ownedRuntimeBin } from '../runtimeFolder'
import { resolveWindowsSpawn } from '../runtimes/winSpawn'

export interface ConnectorSpawnPlan {
  /** What is actually handed to the process spawner. */
  command: string
  args: string[]
  /**
   * Variables the child gets on top of the connector allowlist: the opt-outs a
   * known server honours for its own usage statistics and update checks.
   * Never a credential.
   */
  env: Record<string, string>
  /**
   * What the operator is shown, and it is the RESOLVED form.
   *
   * Deliberately not the catalog's `npx`: an absolute path is the difference
   * between "some npx" and "this npx", and on Windows it is the difference
   * between a shim and the cmd.exe line that will really execute.
   */
  display: string
  /** True when the binary could not be found on PATH. */
  unresolved: boolean
}

/** Quote a token for DISPLAY only. Never fed to a shell. Exported for tests. */
export function displayToken(token: string): string {
  return /[\s"'`$&|;<>(){}[\]*?!\\]/.test(token) ? JSON.stringify(token) : token
}

function displayOf(command: string, args: string[]): string {
  const shown = isWindows ? resolveWindowsSpawn({ command, args }) : { command, args }
  return [shown.command, ...shown.args].map(displayToken).join(' ')
}

// ─── Known packages ──────────────────────────────────────────────────────────

interface KnownPackage {
  /** Verified to run the same started from its own bin as through npx. */
  direct: boolean
  /** The opt-outs it honours for its own usage statistics and update checks. */
  quietEnv?: Readonly<Record<string, string>>
  /** Opt-outs of the person's that are passed on only when they set them. */
  passEnv?: readonly string[]
}

const KNOWN_PACKAGES: ReadonlyMap<string, KnownPackage> = new Map<string, KnownPackage>([
  ['@playwright/mcp', { direct: true }],
  [
    'chrome-devtools-mcp',
    {
      direct: true,
      // 1.7.0 reads both as "any non-empty value". Without them it runs a
      // usage-statistics watchdog and checks the registry for a newer version
      // of itself once a day.
      quietEnv: {
        CHROME_DEVTOOLS_MCP_NO_USAGE_STATISTICS: '1',
        CHROME_DEVTOOLS_MCP_NO_UPDATE_CHECKS: '1',
      },
    },
  ],
])

/**
 * Programs Clawboo installs itself (`ownedBinary`), by launcher name, with the
 * same kind of opt-outs.
 */
const KNOWN_PROGRAMS: ReadonlyMap<string, KnownPackage> = new Map<string, KnownPackage>([
  [
    'cua-driver',
    {
      direct: false,
      // 0.38.0 sends usage telemetry by default and asks GitHub for a newer
      // release every time `mcp` starts. Both read "0" as off.
      quietEnv: {
        CUA_DRIVER_RS_TELEMETRY_ENABLED: '0',
        CUA_DRIVER_RS_UPDATE_CHECK: '0',
        // Advertise accessibility on the bus it is given, which is only ever
        // the agent display's own, whatever desktop it takes itself to be on.
        CUA_DRIVER_RS_A11Y_ADVERTISE_MODE: 'all',
      },
      // The cross-tool opt-out, which it honours above everything else.
      passEnv: ['DO_NOT_TRACK'],
    },
  ],
])

/**
 * The opt-outs for this package, except where the server's own environment
 * already names the variable: the person decided, and their value is passed on.
 */
function quietEnvFor(known: KnownPackage | undefined): Record<string, string> {
  const env: Record<string, string> = {}
  for (const [name, value] of Object.entries(known?.quietEnv ?? {})) {
    env[name] = process.env[name] ?? value
  }
  for (const name of known?.passEnv ?? []) {
    const value = process.env[name]
    if (value !== undefined) env[name] = value
  }
  return env
}

interface NpxPackage {
  name: string
  version: string
  /** Exactly as written, which is what npx keys its install folder on. */
  spec: string
  rest: string[]
}

/** `npx -y <name>@<exact version> ...`, the shape every curated stdio entry uses. */
function pinnedNpxPackage(launch: { command: string; args: readonly string[] }): NpxPackage | null {
  const base = path
    .basename(launch.command)
    .toLowerCase()
    .replace(/\.(cmd|exe)$/, '')
  if (base !== 'npx') return null
  const [flag, spec, ...rest] = launch.args
  if ((flag !== '-y' && flag !== '--yes') || !spec) return null
  const m = /^((?:@[^/@\s]+\/)?[^/@\s]+)@(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)$/.exec(spec)
  if (!m) return null
  return { name: m[1]!, version: m[2]!, spec, rest }
}

// ─── Finding an installed copy ───────────────────────────────────────────────

export interface SpawnPlanOptions {
  /** The `node_modules` folders beside the server, nearest first. Tests. */
  besideServer?: readonly string[]
  /** The agent host starts it, as the agent user (see `agentUserConnectorStart`). */
  asAgentUser?: boolean
}

/**
 * The `node_modules` folders to look in from `fromDir`, nearest first: those
 * inside Clawboo's own package, then the `node_modules` folder Clawboo was
 * installed into, so a package installed globally next to a global Clawboo is
 * found, as is one a container image installed beside it.
 *
 * Nothing above that folder. Node's own lookup goes on to the filesystem root,
 * but a folder up there (`/tmp/node_modules`, `/node_modules`) can be one
 * another user writes, and what is found here runs as the person. A server
 * that was not installed into any `node_modules` (a source checkout) gets none,
 * and its browsers go through npx.
 */
export function nodeModulesBeside(fromDir: string): string[] {
  const out: string[] = []
  let dir = fromDir
  for (let i = 0; i < 16; i++) {
    if (path.basename(dir) === 'node_modules') {
      out.push(dir)
      return out
    }
    out.push(path.join(dir, 'node_modules'))
    const parent = path.dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  return []
}

function besideServerDirs(): string[] {
  return typeof __dirname === 'string' && __dirname.length > 0 ? nodeModulesBeside(__dirname) : []
}

/** npm's cache folder, whose `_npx` holds what `npx` installed. */
function npmCacheDir(): string | null {
  const configured = (process.env['npm_config_cache'] ?? process.env['NPM_CONFIG_CACHE'])?.trim()
  if (configured) return path.resolve(configured)
  const home = os.homedir()
  if (!home) return null
  if (process.platform === 'win32') {
    return path.join(
      process.env['LOCALAPPDATA'] || path.join(home, 'AppData', 'Local'),
      'npm-cache',
    )
  }
  return path.join(home, '.npm')
}

/** The folder `npx` installs one spec into: the first 16 hex of its sha512. */
function npxInstallDir(cache: string, spec: string): string {
  return path.join(cache, '_npx', createHash('sha512').update(spec).digest('hex').slice(0, 16))
}

function isNodeScript(file: string): boolean {
  if (!existsSync(file)) return false
  if (/\.[cm]?js$/i.test(file)) return true
  let fd: number | null = null
  try {
    fd = openSync(file, 'r')
    const head = Buffer.alloc(128)
    const read = readSync(fd, head, 0, head.length, 0)
    const firstLine = head.subarray(0, read).toString('utf8').split('\n')[0] ?? ''
    return /^#!.*\bnode\b/.test(firstLine)
  } catch {
    return false
  } finally {
    if (fd !== null) closeSync(fd)
  }
}

/**
 * The bin npx would run from the package in `nodeModules`, or null when that
 * folder does not hold exactly this version. npx runs a package's only bin, or
 * the one named after the package.
 */
function binIn(nodeModules: string, pkg: NpxPackage): string | null {
  const pkgDir = path.join(nodeModules, ...pkg.name.split('/'))
  let manifest: { name?: unknown; version?: unknown; bin?: unknown }
  try {
    manifest = JSON.parse(readFileSync(path.join(pkgDir, 'package.json'), 'utf8')) as {
      name?: unknown
      version?: unknown
      bin?: unknown
    }
  } catch {
    return null
  }
  if (manifest.name !== pkg.name || manifest.version !== pkg.version) return null

  let rel: string | undefined
  if (typeof manifest.bin === 'string') rel = manifest.bin
  else if (manifest.bin && typeof manifest.bin === 'object') {
    const bins = Object.entries(manifest.bin as Record<string, unknown>).filter(
      (e): e is [string, string] => typeof e[1] === 'string',
    )
    const unscoped = pkg.name.split('/').pop()
    rel = bins.length === 1 ? bins[0]![1] : bins.find(([binName]) => binName === unscoped)?.[1]
  }
  if (!rel) return null
  const file = path.resolve(pkgDir, rel)
  // A bin that points outside its own package is not what npx would run.
  if (!file.startsWith(pkgDir + path.sep)) return null
  return isNodeScript(file) ? file : null
}

function installedBin(pkg: NpxPackage, opts: SpawnPlanOptions): string | null {
  for (const dir of opts.besideServer ?? besideServerDirs()) {
    const bin = binIn(dir, pkg)
    if (bin) return bin
  }
  // npx's install folder is in this user's npm cache, under its home. A
  // connector the agent host starts runs as the agent user, who cannot read it:
  // npx, run as that user, then uses a cache of its own. One the server starts
  // keeps the fast path.
  if (opts.asAgentUser) return null
  const cache = npmCacheDir()
  if (!cache) return null
  const nodeModules = path.join(npxInstallDir(cache, pkg.spec), 'node_modules')
  // npm writes this last, so without it the install did not finish and may be
  // missing dependencies.
  if (!existsSync(path.join(nodeModules, '.package-lock.json'))) return null
  return binIn(nodeModules, pkg)
}

// ─── The plan ────────────────────────────────────────────────────────────────

/**
 * Resolve a catalog launch into an exact, inspectable spawn.
 *
 * `unresolved` rather than a throw: a missing binary is an ordinary,
 * user-fixable condition ("install Node"), and the caller can render that far
 * better than an exception can. The plan still carries the original command so
 * the message can name what was looked for.
 */
export function planConnectorSpawn(
  launch: { command: string; args: readonly string[]; ownedBinary?: boolean },
  opts: SpawnPlanOptions = {},
): ConnectorSpawnPlan {
  const pkg = pinnedNpxPackage(launch)
  const known = pkg
    ? KNOWN_PACKAGES.get(pkg.name)
    : launch.ownedBinary
      ? KNOWN_PROGRAMS.get(launch.command)
      : undefined
  const env = quietEnvFor(known)

  // A program Clawboo installs itself runs from that install and nowhere else:
  // the catalog's tool lists and refusals are checked against that release, so
  // a copy of another version found on PATH is not a stand-in for it.
  if (launch.ownedBinary) {
    const owned = ownedRuntimeBin(launch.command)
    const command = owned ?? launch.command
    const args = [...launch.args]
    return { command, args, env, display: displayOf(command, args), unresolved: owned === null }
  }

  // Started with the Node that runs this server rather than through the bin's
  // shebang, which would pick whichever `node` is first on PATH.
  const bin = pkg && known?.direct ? installedBin(pkg, opts) : null
  if (pkg && bin) {
    const args = [bin, ...pkg.rest]
    return {
      command: process.execPath,
      args,
      env,
      display: displayOf(process.execPath, args),
      unresolved: false,
    }
  }

  // An ABSOLUTE command needs no lookup, and looking it up anyway is wrong on
  // Windows: `where` searches PATH for a NAME and fails outright on a full path,
  // so an absolute command would report itself as missing. POSIX `which` happens
  // to accept one, which is exactly why this only ever broke on Windows.
  const preResolved =
    path.isAbsolute(launch.command) && existsSync(launch.command) ? launch.command : null
  const resolved = preResolved ?? findExecutable(launch.command)
  const command = resolved ?? launch.command
  const args = [...launch.args]

  // WE DO NOT PRE-ROUTE ON WINDOWS, and that is a correction rather than an
  // omission. The MCP SDK spawns through cross-spawn, which performs the whole
  // cmd.exe routing itself -- escaping each token and setting
  // windowsVerbatimArguments, which is the half that makes the escaping correct.
  // Rewriting the command to cmd.exe here would DEFEAT that: cross-spawn skips
  // its routing when the command is already an .exe, so nothing would set
  // verbatim and Node would re-quote an already-caret-escaped line. The
  // connector then fails to start. Handing cross-spawn the plain `npx.cmd` is
  // what makes it work.
  //
  // `resolveWindowsSpawn` is still used, for DISPLAY only: it produces the
  // cmd.exe line the operator will actually get, which is the thing consent is
  // being asked for.
  return {
    command,
    args,
    env,
    display: displayOf(command, args),
    unresolved: resolved === null,
  }
}
