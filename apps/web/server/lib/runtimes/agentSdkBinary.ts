// Where the Claude Agent SDK's own `claude` binary is, found the way a run
// finds it, without loading the SDK.
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

import { accessSync, constants, existsSync, realpathSync } from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'

export const AGENT_SDK_PACKAGE = '@anthropic-ai/claude-agent-sdk'

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
  /** Where the SDK is looked up from. Default: this module's directory. */
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
  const fromDir = opts.fromDir === undefined ? selfDir() : opts.fromDir
  if (!fromDir) return null
  const sdkDir = findAgentSdkDir(fromDir)
  if (!sdkDir) return null
  const resolve = createRequire(path.join(sdkDir, 'package.json')).resolve
  const candidates = agentSdkBinaryCandidates({
    platform: opts.platform ?? process.platform,
    arch: opts.arch ?? process.arch,
    preferMusl: opts.preferMusl ?? isMuslLinux(),
  })
  for (const specifier of candidates) {
    try {
      const found = resolve(specifier)
      if (existsSync(found) && isExecutable(found)) return found
    } catch {
      // Not installed for this platform; the SDK moves on to the next one too.
    }
  }
  return null
}
