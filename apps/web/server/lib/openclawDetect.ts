/**
 * apps/web/server/lib/openclawDetect.ts
 *
 * Async, per-session-cached OpenClaw binary detection.
 *
 * WHY ASYNC: the previous synchronous `execFileSync('openclaw --version')`
 * blocked the single-threaded server. On a fresh install — especially after
 * a user has cleared node-compile-cache / npx caches — the first
 * `openclaw --version` is unusually slow (cold V8 JIT + module
 * re-resolution), and that one-time slowness froze EVERY concurrent request,
 * including the install / gateway-start SSE `complete` event. The onboarding
 * wizard then sat stuck on "Installing OpenClaw" / "Starting Gateway" until a
 * manual refresh. Async detection + a hard timeout means a slow version probe
 * can never block the event loop.
 *
 * WHY CACHED: detection runs on every `/api/system/status` poll. The version
 * string can't change within a single server session unless openclaw is
 * reinstalled, so we cache the first successful read (keyed by resolved
 * binary path) and serve later calls instantly without spawning a process.
 */
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

import { findExecutable, isWindows } from './platform'

const execFileAsync = promisify(execFile)

export interface OpenClawInfo {
  installed: boolean
  version: string | null
  path: string | null
}

// Bound on the version probe. The version string is non-critical — every
// caller falls back to 'unknown' — so timing out and proceeding beats
// hanging. Generous enough to cover a genuinely-cold first invocation.
const VERSION_TIMEOUT_MS = 6_000

// Cache SUCCESSFUL reads only, keyed by resolved binary path. A reinstall to
// a different path is a natural cache miss; a same-path upgrade is handled by
// `invalidateOpenClawCache()` (called from the install handler). We never
// cache a failure/timeout, so a later call (once caches are warm) can still
// read the real version.
let versionCache: { path: string; version: string } | null = null

/**
 * Cheap synchronous PATH lookup — answers "is it installed, and where".
 * This is a fast `which` / `where` resolution, NOT a process spawn of
 * openclaw itself, so it's safe to call synchronously.
 */
export function findOpenClawPath(): string | null {
  return findExecutable('openclaw')
}

/**
 * Async, cached, bounded OpenClaw detection. Never blocks the event loop.
 */
export async function detectOpenClaw(): Promise<OpenClawInfo> {
  const binPath = findOpenClawPath()
  if (!binPath) {
    versionCache = null // uninstalled — drop any stale cache
    return { installed: false, version: null, path: null }
  }

  if (versionCache && versionCache.path === binPath) {
    return { installed: true, version: versionCache.version, path: binPath }
  }

  try {
    // `shell: isWindows` — Node 18.20.2+ / 20.12.2+ / 22+ refuse to spawn
    // .cmd / .bat files without it (CVE-2024-27980 fix); binPath is the
    // absolute path to openclaw.cmd on Windows. No-op on Unix.
    // `windowsHide: isWindows` — suppress the cmd.exe console window.
    const { stdout } = await execFileAsync(binPath, ['--version'], {
      encoding: 'utf8',
      shell: isWindows,
      windowsHide: isWindows,
      timeout: VERSION_TIMEOUT_MS,
    })
    const raw = stdout.trim()
    const version = raw.replace(/^openclaw\s+v?/i, '').trim() || raw
    versionCache = { path: binPath, version } // cache success only
    return { installed: true, version, path: binPath }
  } catch {
    // ETIMEDOUT or a read failure — the binary IS present (findExecutable
    // found it), we just couldn't read its version this time. Don't cache
    // the miss; return installed:true so the install / gateway / status
    // flows keep moving instead of freezing.
    return { installed: true, version: null, path: binPath }
  }
}

/** Drop the version cache — call after a fresh (re)install so the next
 * detection re-reads the version instead of serving a stale cache. */
export function invalidateOpenClawCache(): void {
  versionCache = null
}
