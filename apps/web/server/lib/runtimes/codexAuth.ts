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

import { agentReadFile } from '../agentUser/agentFs'
import { isAgentUserMode } from '../agentUser/config'
import { agentHomeDir } from '../agentUser/state'
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

/**
 * With agents on their own OS user: that user's own Codex home, `~/.codex` in
 * its home folder. The in-app sign-in runs as the agent user, so its login lands
 * here, apart from the person's own. Null with the setting off. Throws when the
 * agent host is not running.
 */
export function agentCodexHome(): string | null {
  return isAgentUserMode() ? path.join(agentHomeDir(), '.codex') : null
}

/**
 * Does this auth.json text hold a USABLE credential? Usable means an OAuth
 * `tokens` object carrying a non-empty access or refresh token, or a non-empty
 * `OPENAI_API_KEY` field. Unparseable means unusable. Never throws.
 */
export function usableCodexAuthBody(raw: string): boolean {
  try {
    const parsed = JSON.parse(raw) as {
      tokens?: { access_token?: unknown; refresh_token?: unknown } | null
      OPENAI_API_KEY?: unknown
    }
    const t = parsed.tokens
    if (t && typeof t === 'object') {
      if (typeof t.access_token === 'string' && t.access_token.length > 0) return true
      if (typeof t.refresh_token === 'string' && t.refresh_token.length > 0) return true
    }
    return typeof parsed.OPENAI_API_KEY === 'string' && parsed.OPENAI_API_KEY.length > 0
  } catch {
    return false
  }
}

/**
 * The same check of the `auth.json` in a Codex home in agent space (a run's
 * CODEX_HOME, the agent user's own `~/.codex`): read through the agent-space file
 * verbs, bounded, never through a link, and by the agent host when agents run as
 * their own OS user. Never throws.
 */
export async function hasUsableCodexAuthIn(codexHome: string): Promise<boolean> {
  try {
    const raw = await agentReadFile(path.join(codexHome, 'auth.json'))
    return raw !== null && usableCodexAuthBody(raw.toString('utf8'))
  } catch {
    return false
  }
}

/** With agents on their own OS user: does that user hold a usable Codex login of
 *  its own? False with the setting off, or when the agent host is not running. */
export async function isAgentCodexLoggedIn(): Promise<boolean> {
  try {
    const home = agentCodexHome()
    return home ? await hasUsableCodexAuthIn(home) : false
  } catch {
    return false
  }
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
  // With agents on their own OS user, runs sign in with the agent user's own
  // login only: the person's own is never shared with the agents, so it does
  // not connect Codex for them.
  if (isAgentUserMode()) {
    loggedIn = await isAgentCodexLoggedIn()
    cache = { at: now, loggedIn }
    return loggedIn
  }
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
