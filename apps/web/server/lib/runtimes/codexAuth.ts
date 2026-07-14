// Codex uses interactive ChatGPT OAuth (`codex login`), which stores its tokens
// in the user's Codex home (`~/.codex/auth.json`). clawboo drives Codex in an
// ISOLATED CODEX_HOME (so its generated config.toml never touches the user's),
// which means the user's login is invisible unless we (a) DETECT it and (b) SEED
// it into the run's home. This module owns both:
//   - `isCodexLoggedIn()` — parses `codex login status` so the UI can show Codex
//     as connected when the user has already run `codex login` in their terminal.
//   - `userCodexHome()` / `userCodexAuthPath()` — where that login lives, so the
//     driver can copy the OAuth token into the isolated run home.
// Never writes to the user's ~/.codex; read/copy only.
//
// The status probe is ASYNC (execFile) + timeout-bounded + cached — a synchronous
// exec in a request path would block the single-threaded event loop (the same
// class of bug the OpenClaw detect had), so this stays off the hot path.

import { execFile } from 'node:child_process'
import os from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'

import { isWindows, resolveRuntimeBin } from '../platform'

const execFileAsync = promisify(execFile)

/** The user's real Codex home (where `codex login` stored auth.json). Honours an
 *  explicit CODEX_HOME, else the conventional `~/.codex`. */
export function userCodexHome(): string {
  const env = process.env['CODEX_HOME']?.trim()
  return env && env.length > 0 ? env : path.join(os.homedir(), '.codex')
}

/** Path to the user's Codex OAuth token file. */
export function userCodexAuthPath(): string {
  return path.join(userCodexHome(), 'auth.json')
}

let cache: { at: number; loggedIn: boolean } | null = null
const TTL_MS = 5_000

/**
 * True when `codex login status` reports a logged-in account. Cached briefly so
 * a burst of /api/runtimes reads doesn't shell out repeatedly. NEVER throws — any
 * failure (codex missing, timeout) reads as "not logged in". Note: `codex login
 * status` exits 0 whether logged in or not, so we must parse the output.
 */
export async function isCodexLoggedIn(): Promise<boolean> {
  const now = Date.now()
  if (cache && now - cache.at < TTL_MS) return cache.loggedIn
  let loggedIn = false
  try {
    const bin = resolveRuntimeBin('codex')
    if (bin) {
      const { stdout, stderr } = await execFileAsync(bin, ['login', 'status'], {
        timeout: 5_000,
        windowsHide: isWindows,
        shell: isWindows,
      })
      const out = `${stdout ?? ''}\n${stderr ?? ''}`
      loggedIn = /logged in/i.test(out) && !/not logged in/i.test(out)
    }
  } catch {
    // execFile rejects on non-zero exit / timeout / missing bin — but it may
    // still carry stdout ("Logged in …" on a 0 exit won't reject; a reject here
    // means a real failure), so treat as not-logged-in.
    loggedIn = false
  }
  cache = { at: now, loggedIn }
  return loggedIn
}

/** Drop the cached login state (e.g. right after a connect/disconnect action). */
export function invalidateCodexAuthCache(): void {
  cache = null
}
