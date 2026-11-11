// Where the Claude Agent SDK's own `claude` binary is, found the way a run
// finds it, without loading the SDK.
//
// The SDK a run loads is the one Clawboo installed into its runtimes folder
// (`ownAgentSdkDir`) when there is one, else the one beside the server module
// (a source checkout, or a Clawboo installed with the SDK next to it).
//
// A Claude Code run goes through the Agent SDK, and the SDK starts the native
// binary from its per-platform optional dependency rather than a `claude` CLI on
// PATH. So an install with the SDK and no CLI can run Claude Code, and the
// install probe has to say so. Two steps, each matching the code a run executes:
//
//  1. The SDK itself: the driver loads it with a bare `import()` from the server
//     module, which walks the `node_modules` folders above that module (an ESM
//     import does not read NODE_PATH or the global folders a `require` does).
//  2. The binary: the SDK resolves `<sdk>-<platform>-<arch>[-musl]/claude[.exe]`
//     with `createRequire(<its own module>).resolve()`, takes the first that
//     exists, and on Linux tries the musl build first when Node runs without
//     glibc. Mirrored here as of @anthropic-ai/claude-agent-sdk 0.3.268, with one
//     check more: the file must be executable, because a run spawns it directly.
//     Like the SDK's, this lookup is Node's own, so after the node_modules
//     folders above the SDK it also searches NODE_PATH and the global folders.

import { accessSync, constants, existsSync, readFileSync, realpathSync } from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'

import { currentInstallFolder } from '../runtimeFolder'

export const AGENT_SDK_PACKAGE = '@anthropic-ai/claude-agent-sdk'

/** The runtime id the SDK installs under in Clawboo's runtimes folder. */
export const AGENT_SDK_RUNTIME_ID = 'claude-code'

/**
 * The SDK's package directory in the current install of Claude Code in
 * Clawboo's runtimes folder (its real path), or null when there is none, or the
 * folder is not one Clawboo may run code from (`currentInstallFolder`). Only
 * that install's own `node_modules` is looked in, never the folders above it.
 */
export function ownAgentSdkDir(env: NodeJS.ProcessEnv = process.env): string | null {
  const folder = currentInstallFolder(AGENT_SDK_RUNTIME_ID, env)
  if (!folder) return null
  const dir = path.join(folder, 'node_modules', ...AGENT_SDK_PACKAGE.split('/'))
  if (!existsSync(path.join(dir, 'package.json'))) return null
  try {
    return realpathSync(dir)
  } catch {
    return null
  }
}

/** The target an `exports` entry names for an ESM import from Node: the first
 *  of the `node`, `import` and `default` conditions that leads to a file,
 *  following nested condition objects. */
function exportTarget(entry: unknown): string | null {
  if (typeof entry === 'string') return entry
  if (Array.isArray(entry)) {
    for (const e of entry) {
      const t = exportTarget(e)
      if (t) return t
    }
    return null
  }
  if (!entry || typeof entry !== 'object') return null
  const conditions = entry as Record<string, unknown>
  for (const key of ['node', 'import', 'default']) {
    if (key in conditions) {
      const t = exportTarget(conditions[key])
      if (t) return t
    }
  }
  return null
}

/** The file a bare `import()` of the SDK package in `sdkDir` loads: its
 *  `exports['.']` as Node resolves it for an import, else `main`. */
export function agentSdkEntryFile(sdkDir: string): string {
  let entry = 'sdk.mjs'
  try {
    const pkg = JSON.parse(readFileSync(path.join(sdkDir, 'package.json'), 'utf8')) as {
      main?: unknown
      exports?: unknown
    }
    const exp = pkg.exports
    const dot =
      exp && typeof exp === 'object' && !Array.isArray(exp) && '.' in (exp as object)
        ? (exp as Record<string, unknown>)['.']
        : exp
    const fromExports = exportTarget(dot)
    if (fromExports) entry = fromExports
    else if (typeof pkg.main === 'string') entry = pkg.main
  } catch {
    // The SDK's own default.
  }
  return path.resolve(sdkDir, entry)
}

/** This module's own directory, where the driver's `import()` resolves from.
 *  `__dirname` for the reason `catalogIndex.ts` gives: the server is bundled to
 *  CJS, tsx loads it as CJS, and Vite's SSR transform defines it for vitest. */
function selfDir(): string | null {
  return typeof __dirname === 'string' && __dirname.length > 0 ? __dirname : null
}

let muslLinux: boolean | null = null

/** True on a Linux whose Node has no glibc (a musl build such as Alpine's). The
 *  SDK's own test: the process report names no glibc runtime version. Worked
 *  out once, since building a process report is not free and cannot change. */
export function isMuslLinux(): boolean {
  if (process.platform !== 'linux') return false
  if (muslLinux === null) {
    const report =
      typeof process.report?.getReport === 'function' ? process.report.getReport() : null
    const header = (report as { header?: { glibcVersionRuntime?: string } } | null)?.header
    muslLinux = header != null && header.glibcVersionRuntime === undefined
  }
  return muslLinux
}

/** The specifiers the SDK tries for its binary, in its order. */
export function agentSdkBinaryCandidates(opts: {
  platform: string
  arch: string
  preferMusl: boolean
}): string[] {
  const { platform, arch, preferMusl } = opts
  const ext = platform === 'win32' ? '.exe' : ''
  const packages =
    platform === 'android'
      ? [`${AGENT_SDK_PACKAGE}-linux-${arch}-android`]
      : platform === 'linux'
        ? preferMusl
          ? [`${AGENT_SDK_PACKAGE}-linux-${arch}-musl`, `${AGENT_SDK_PACKAGE}-linux-${arch}`]
          : [`${AGENT_SDK_PACKAGE}-linux-${arch}`, `${AGENT_SDK_PACKAGE}-linux-${arch}-musl`]
        : [`${AGENT_SDK_PACKAGE}-${platform}-${arch}`]
  return packages.map((pkg) => `${pkg}/claude${ext}`)
}

/** The SDK's package directory as a bare import from `fromDir` finds it (its
 *  real path, as the ESM loader reports it), or null when it is not installed. */
export function findAgentSdkDir(fromDir: string): string | null {
  let dir = path.resolve(fromDir)
  for (;;) {
    const candidate = path.join(dir, 'node_modules', ...AGENT_SDK_PACKAGE.split('/'))
    if (existsSync(path.join(candidate, 'package.json'))) {
      try {
        return realpathSync(candidate)
      } catch {
        return null
      }
    }
    const parent = path.dirname(dir)
    if (parent === dir) return null
    dir = parent
  }
}

/** Whether the binary could be started. On Windows this checks only that the
 *  file exists, which is all X_OK means there. */
function isExecutable(file: string): boolean {
  try {
    accessSync(file, constants.X_OK)
    return true
  } catch {
    return false
  }
}

export interface ResolveAgentSdkBinaryOptions {
  /** Where the SDK is looked up from. Default: Clawboo's runtimes folder, then
   *  this module's directory. */
  fromDir?: string | null
  platform?: string
  arch?: string
  preferMusl?: boolean
}

/**
 * The absolute path of the binary a Claude Code run would start, or null when
 * the SDK or its platform package is missing. Never loads the SDK.
 */
export function resolveAgentSdkBinary(opts: ResolveAgentSdkBinaryOptions = {}): string | null {
  let sdkDir: string | null
  // For Clawboo's own copy the binary must be inside that install: Node's lookup
  // would otherwise go on to the node_modules folders above it.
  let within: string | null = null
  if (opts.fromDir === undefined) {
    const own = ownAgentSdkDir()
    if (own) within = currentInstallFolder(AGENT_SDK_RUNTIME_ID)
    const self = selfDir()
    sdkDir = own ?? (self ? findAgentSdkDir(self) : null)
  } else {
    sdkDir = opts.fromDir ? findAgentSdkDir(opts.fromDir) : null
  }
  if (!sdkDir) return null
  const resolve = createRequire(path.join(sdkDir, 'package.json')).resolve
  const candidates = agentSdkBinaryCandidates({
    platform: opts.platform ?? process.platform,
    arch: opts.arch ?? process.arch,
    preferMusl: opts.preferMusl ?? isMuslLinux(),
  })
  const inside = (p: string): boolean => {
    if (!within) return true
    const real = realpathSync(p)
    const base = realpathSync(within)
    return real.startsWith(base.endsWith(path.sep) ? base : base + path.sep)
  }
  for (const specifier of candidates) {
    try {
      const found = resolve(specifier)
      if (existsSync(found) && isExecutable(found) && inside(found)) return found
    } catch {
      // Not installed for this platform; the SDK moves on to the next one too.
    }
  }
  return null
}
