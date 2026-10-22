/**
 * apps/web/server/lib/cwdGuard.ts
 *
 * Keeps the server in a working directory that exists.
 *
 * `npm install -g clawboo@latest` replaces the package folder. A server whose
 * working directory sat inside that folder is left in a directory that no
 * longer exists, and so is every process it starts: npm exits with code 7,
 * the OpenClaw CLI refuses to run, and the successor an in-app update launches
 * dies while loading (depd, pulled in by express, calls `process.cwd()` at
 * require time). Nothing reaches the log, because the logger loads after it.
 *
 * Two layers:
 *   - This module is imported FIRST in server/index.ts, so on load it moves a
 *     server that starts in a deleted directory into one that exists, before
 *     express is required.
 *   - `liveCwd()` is passed as the explicit `cwd` of the processes the update
 *     and the Gateway depend on, so they never inherit a dead directory even if
 *     the server's own one disappears while it runs.
 *
 * The CLI also no longer starts the server inside the package folder (see
 * apps/cli/src/lifecycle.ts). It passes the directory the user ran `clawboo`
 * from as CLAWBOO_LAUNCH_DIR, read here by `launchDir()`.
 *
 * Node built-ins only, plus the pure clawboo-dir resolver: nothing here may
 * call `process.cwd()` unguarded.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { resolveClawbooDir } from '@clawboo/config'

export interface CwdGuardDeps {
  cwd: () => string
  chdir: (dir: string) => void
  isDir: (dir: string) => boolean
  mkdir: (dir: string) => void
  env: NodeJS.ProcessEnv
  homedir: () => string
  tmpdir: () => string
}

const realDeps: CwdGuardDeps = {
  cwd: () => process.cwd(),
  chdir: (dir) => process.chdir(dir),
  isDir: (dir) => {
    try {
      return fs.statSync(dir).isDirectory()
    } catch {
      return false
    }
  },
  mkdir: (dir) => {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
  },
  env: process.env,
  homedir: () => os.homedir(),
  tmpdir: () => os.tmpdir(),
}

/** The working directory, or null when it has been deleted. */
export function currentDir(deps: Pick<CwdGuardDeps, 'cwd'> = realDeps): string | null {
  try {
    return deps.cwd()
  } catch {
    return null
  }
}

/**
 * Where to move to, in order: clawboo's own directory (created if missing),
 * the home directory, the temp directory, then the filesystem root. Each is
 * absolute, so building the list never consults the working directory.
 */
function fallbackDirs(deps: CwdGuardDeps): { dir: string; create: boolean }[] {
  const out: { dir: string; create: boolean }[] = []
  // A relative CLAWBOO_HOME resolves against the working directory, the thing
  // that is gone; skip it rather than guess. The home directory is next anyway.
  const override = deps.env['CLAWBOO_HOME']?.trim()
  const relative = !!override && !override.startsWith('~') && !path.isAbsolute(override)
  if (!relative) {
    try {
      const clawbooDir = resolveClawbooDir(deps.env)
      if (path.isAbsolute(clawbooDir)) out.push({ dir: clawbooDir, create: true })
    } catch {
      /* resolver failed: skip */
    }
  }
  for (const read of [deps.homedir, deps.tmpdir]) {
    try {
      const dir = read()
      if (dir && path.isAbsolute(dir)) out.push({ dir, create: false })
    } catch {
      /* unavailable: skip */
    }
  }
  // The root of the drive Node runs from: always exists, always absolute.
  out.push({ dir: path.parse(process.execPath).root, create: false })
  return out
}

export interface CwdGuardResult {
  /** True when the working directory had been deleted and was replaced. */
  moved: boolean
  /** The working directory afterwards, or null when no candidate worked. */
  dir: string | null
}

/**
 * If the working directory has been deleted, move to the first fallback that
 * exists. A no-op otherwise, so dev and test runs keep the directory they
 * were started in.
 */
export function ensureLiveCwd(deps: CwdGuardDeps = realDeps): CwdGuardResult {
  const now = currentDir(deps)
  if (now !== null) return { moved: false, dir: now }
  for (const { dir, create } of fallbackDirs(deps)) {
    try {
      if (create && !deps.isDir(dir)) deps.mkdir(dir)
      if (!deps.isDir(dir)) continue
      deps.chdir(dir)
      const after = currentDir(deps)
      if (after !== null) return { moved: true, dir: after }
    } catch {
      /* try the next one */
    }
  }
  return { moved: false, dir: null }
}

/**
 * A working directory that exists, for a child process's `cwd` option. Moves
 * the server first if its own directory has gone.
 */
export function liveCwd(deps: CwdGuardDeps = realDeps): string {
  return ensureLiveCwd(deps).dir ?? deps.homedir()
}

/**
 * The directory the user ran `clawboo` from, for suggestions such as "a
 * database near where you started clawboo". The CLI passes it as
 * CLAWBOO_LAUNCH_DIR; a dev run without it uses its own working directory.
 */
export function launchDir(deps: CwdGuardDeps = realDeps): string {
  const fromEnv = deps.env['CLAWBOO_LAUNCH_DIR']?.trim()
  if (fromEnv && path.isAbsolute(fromEnv) && deps.isDir(fromEnv)) return fromEnv
  return liveCwd(deps)
}

// Runs on import. server/index.ts imports this module before anything else.
const boot = ensureLiveCwd()
if (boot.moved) {
  process.stderr.write(
    `[clawboo] the server's working directory no longer exists; continuing from ${boot.dir}\n`,
  )
}
